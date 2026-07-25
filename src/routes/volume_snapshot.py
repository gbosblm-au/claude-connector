#!/usr/bin/env python3
"""
volume_snapshot.py  (claude-connector v12.22.0)

Creates and extracts connector volume snapshots for the TrueSource Client
Gateway "Connector Snapshots" feature.

This script is invoked by src/routes/volume-snapshot.js with an explicit argv
array. It is never invoked through a shell and never interpolates caller data
into a command string.

--------------------------------------------------------------------------
ARCHIVE LAYOUT (layout version 1)
--------------------------------------------------------------------------

Members are logically namespaced rather than tied to one connector's absolute
paths, so the same archive can be restored onto an owner-mode connector
(ava content at /data/skill/ava) or a tenant-mode connector (ava content at
/data/clients/<tenant_id>) without rewriting it:

    SNAPSHOT_MANIFEST.json      metadata, always first member
    skill/ava/<relative path>   everything under the connector's ava directory
    downloads/<relative path>   everything under the connector's downloads dir

The extractor maps the two namespaces onto the target connector's own
directories, which are passed in as arguments.

Legacy layout support: archives produced by the original manual Railway
command have members named 'ava/...' and 'downloads/...' with no
SNAPSHOT_MANIFEST.json. Those are detected and mapped correctly, which also
repairs the long-standing defect where 'tar czf ... ../downloads/' silently
rewrote the member prefix to 'downloads/' and every subsequent
'cd /data/skill && tar xzf' extracted the artefacts to /data/skill/downloads
instead of /data/downloads.

--------------------------------------------------------------------------
SECURITY MODEL
--------------------------------------------------------------------------

Extraction treats every archive as hostile input:

  * Only regular files and directories are extracted. Symlinks, hard links,
    FIFOs, character devices and block devices are rejected outright, which
    closes the classic symlink-then-overwrite tar escape.
  * Member names are rejected if absolute, if any path component is '..' or
    '.', if they contain a NUL or a backslash, or if they are a Windows drive
    or UNC path.
  * Every resolved destination is re-checked with os.path.realpath against the
    permitted root after joining, so a path that survives name validation but
    resolves outside the root through an existing symlinked parent is still
    rejected.
  * Cumulative uncompressed size is capped, which bounds decompression bombs.
  * Member counts are capped.
  * Permission bits from the archive are discarded. Files are written 0644 and
    directories 0755, so no member can arrive setuid, setgid or world-writable.

--------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------

    volume_snapshot.py create   --out PATH --ava-dir DIR [--downloads-dir DIR]
                                [--include-downloads 0|1]
                                [--max-uncompressed-mb N]
                                [--connector-version V] [--tenant-id ID]
                                [--exclude NAME ...]

    volume_snapshot.py extract  --archive PATH --ava-dir DIR
                                [--downloads-dir DIR]
                                [--include-downloads 0|1]
                                [--exclude-personal 0|1]
                                [--max-uncompressed-mb N]

    volume_snapshot.py inspect  --archive PATH [--max-uncompressed-mb N]

Both subcommands print a single JSON object to stdout and exit 0 on success.
On failure they print a JSON object containing an "error" key and exit 1.
Diagnostics go to stderr so stdout is always machine-parseable.
"""

import argparse
import hashlib
import io
import json
import os
import posixpath
import stat
import sys
import tarfile
import time

LAYOUT_VERSION = 1

# Personal files withheld from client tenants unless the operator opts in.
PERSONAL_BASENAMES = {"PERSONALITY.md", "PROFILES.md"}

# Defaults. The caller normally overrides these from environment variables.
DEFAULT_MAX_UNCOMPRESSED_MB = 1024
DEFAULT_MAX_MEMBERS = 200000

# Names never captured, at any directory depth.
ALWAYS_EXCLUDE_BASENAMES = {
    ".git",
    ".DS_Store",
    "__pycache__",
    "node_modules",
    ".venv",
}


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def emit(payload):
    """Print a JSON result to stdout and exit 0."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(0)


def fail(message, **extra):
    """Print a JSON error to stdout and exit 1."""
    payload = {"error": str(message)}
    payload.update(extra)
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(1)


def warn(message):
    sys.stderr.write("[volume_snapshot] " + str(message) + "\n")


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def norm_dir(path):
    """Absolute directory path with no trailing separator."""
    if not path:
        return ""
    return os.path.abspath(path).rstrip(os.sep) or os.sep


def is_safe_member_name(name):
    """
    Validate an archive member name before it is joined to any real directory.

    Returns (ok: bool, reason: str).
    """
    if not name:
        return False, "empty member name"
    if "\x00" in name:
        return False, "member name contains NUL"
    if "\\" in name:
        return False, "member name contains a backslash"
    if name.startswith("/"):
        return False, "absolute member name"
    # Windows drive letter or UNC path, which ntpath would resolve as absolute.
    if len(name) >= 2 and name[1] == ":":
        return False, "drive-qualified member name"

    parts = name.split("/")
    for part in parts:
        if part in ("..",):
            return False, "member name contains a parent reference"
        if part == "." and len(parts) > 1:
            return False, "member name contains a current-directory reference"
    return True, ""


def resolve_within(root, relative):
    """
    Join `relative` onto `root` and confirm the result stays inside `root`
    even after symlinks in existing parent directories are resolved.

    Returns the destination path, or None if it escapes.
    """
    root_abs = norm_dir(root)
    candidate = os.path.abspath(os.path.join(root_abs, relative))

    # Lexical containment check first.
    if candidate != root_abs and not candidate.startswith(root_abs + os.sep):
        return None

    # Physical containment check: walk up to the nearest existing ancestor and
    # resolve that, so an existing symlinked parent cannot redirect the write.
    probe = candidate
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent

    real_probe = os.path.realpath(probe)
    real_root = os.path.realpath(root_abs) if os.path.exists(root_abs) else root_abs
    if real_probe != real_root and not real_probe.startswith(real_root + os.sep):
        return None

    return candidate


def should_skip_basename(name, extra_excludes):
    base = posixpath.basename(name.rstrip("/"))
    if base in ALWAYS_EXCLUDE_BASENAMES:
        return True
    if base in extra_excludes:
        return True
    return False


def path_has_excluded_component(rel_path, extra_excludes):
    for part in rel_path.split("/"):
        if not part:
            continue
        if part in ALWAYS_EXCLUDE_BASENAMES or part in extra_excludes:
            return True
    return False


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------

def collect_files(root, prefix, extra_excludes, max_bytes, state):
    """
    Walk `root` and yield (absolute_path, member_name, size) tuples.

    `state` accumulates {'bytes': int, 'count': int} across all roots so the
    caps apply to the archive as a whole.
    """
    root_abs = norm_dir(root)
    if not os.path.isdir(root_abs):
        return

    for dirpath, dirnames, filenames in os.walk(root_abs, followlinks=False):
        # Prune excluded directories in place so os.walk does not descend.
        dirnames[:] = [
            d for d in dirnames
            if d not in ALWAYS_EXCLUDE_BASENAMES and d not in extra_excludes
        ]

        for filename in sorted(filenames):
            if filename in ALWAYS_EXCLUDE_BASENAMES or filename in extra_excludes:
                continue

            abs_path = os.path.join(dirpath, filename)

            # Never follow a symlink out of the tree, and never archive a
            # symlink as a symlink.
            try:
                lst = os.lstat(abs_path)
            except OSError as exc:
                warn("cannot stat %s: %s" % (abs_path, exc))
                continue

            if not stat.S_ISREG(lst.st_mode):
                warn("skipping non-regular file %s" % abs_path)
                continue

            rel = os.path.relpath(abs_path, root_abs).replace(os.sep, "/")
            if path_has_excluded_component(rel, extra_excludes):
                continue

            state["count"] += 1
            if state["count"] > DEFAULT_MAX_MEMBERS:
                fail(
                    "snapshot aborted: more than %d files under the capture roots"
                    % DEFAULT_MAX_MEMBERS
                )

            state["bytes"] += lst.st_size
            if state["bytes"] > max_bytes:
                fail(
                    "snapshot aborted: uncompressed size exceeds the %d MB cap. "
                    "Reduce the downloads directory or raise SNAPSHOT_MAX_UNCOMPRESSED_MB."
                    % (max_bytes // (1024 * 1024))
                )

            yield abs_path, prefix + "/" + rel, lst.st_size


def cmd_create(args):
    ava_dir = norm_dir(args.ava_dir)
    downloads_dir = norm_dir(args.downloads_dir) if args.downloads_dir else ""
    max_bytes = max(1, args.max_uncompressed_mb) * 1024 * 1024
    extra_excludes = set(args.exclude or [])

    if not os.path.isdir(ava_dir):
        fail("ava directory not found: %s" % ava_dir, ava_dir=ava_dir)

    out_path = os.path.abspath(args.out)
    out_parent = os.path.dirname(out_path)
    if out_parent and not os.path.isdir(out_parent):
        os.makedirs(out_parent, exist_ok=True)

    state = {"bytes": 0, "count": 0}
    entries = []

    for abs_path, member, size in collect_files(
        ava_dir, "skill/ava", extra_excludes, max_bytes, state
    ):
        entries.append((abs_path, member, size))

    downloads_count = 0
    if args.include_downloads and downloads_dir and os.path.isdir(downloads_dir):
        for abs_path, member, size in collect_files(
            downloads_dir, "downloads", extra_excludes, max_bytes, state
        ):
            entries.append((abs_path, member, size))
            downloads_count += 1

    if not entries:
        fail(
            "nothing to archive: %s is empty and downloads capture produced no files"
            % ava_dir,
            ava_dir=ava_dir,
        )

    manifest = {
        "layout_version": LAYOUT_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "connector_version": args.connector_version or "unknown",
        "tenant_id": args.tenant_id or "",
        "ava_dir": ava_dir,
        "downloads_dir": downloads_dir if args.include_downloads else "",
        "includes_downloads": bool(args.include_downloads and downloads_count > 0),
        "file_count": len(entries),
        "ava_file_count": len(entries) - downloads_count,
        "downloads_file_count": downloads_count,
        "uncompressed_bytes": state["bytes"],
        "excludes": sorted(extra_excludes),
    }
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")

    tmp_path = out_path + ".partial"
    written = 0
    try:
        # Deterministic archive: sorted members, fixed mtime metadata is not
        # forced because file mtimes are genuinely useful for diagnostics.
        # GNU_FORMAT is pinned deliberately. Python's default PAX format encodes
        # long member names in extended headers, which the WordPress-side
        # verifier would have to reconstruct. GNU long-name entries are simpler
        # to parse and are understood by every tar implementation in use here.
        with tarfile.open(
            tmp_path, "w:gz", compresslevel=6, format=tarfile.GNU_FORMAT
        ) as tf:
            info = tarfile.TarInfo("SNAPSHOT_MANIFEST.json")
            info.size = len(manifest_bytes)
            info.mtime = int(time.time())
            info.mode = 0o644
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            tf.addfile(info, io.BytesIO(manifest_bytes))

            for abs_path, member, size in sorted(entries, key=lambda e: e[1]):
                try:
                    info = tf.gettarinfo(abs_path, arcname=member)
                except OSError as exc:
                    warn("cannot add %s: %s" % (abs_path, exc))
                    continue

                if not info.isreg():
                    continue

                # Normalise ownership and permissions inside the archive.
                info.mode = 0o644
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""

                try:
                    with open(abs_path, "rb") as fh:
                        tf.addfile(info, fh)
                except OSError as exc:
                    warn("cannot read %s: %s" % (abs_path, exc))
                    continue

                written += 1

        os.replace(tmp_path, out_path)
    except Exception as exc:  # noqa: BLE001 - reported to the caller as JSON
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass
        fail("failed to build archive: %s" % exc)

    sha256 = hashlib.sha256()
    with open(out_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            sha256.update(chunk)

    emit(
        {
            "ok": True,
            "path": out_path,
            "archive_bytes": os.path.getsize(out_path),
            "sha256": sha256.hexdigest(),
            "file_count": written,
            "ava_file_count": manifest["ava_file_count"],
            "downloads_file_count": downloads_count,
            "uncompressed_bytes": state["bytes"],
            "layout_version": LAYOUT_VERSION,
            "manifest": manifest,
        }
    )


# ---------------------------------------------------------------------------
# EXTRACT
# ---------------------------------------------------------------------------

def classify_member(name):
    """
    Map an archive member name to (namespace, relative_path).

    namespace is 'ava', 'downloads', 'manifest' or None when the member is not
    part of a layout this extractor understands.
    """
    if name == "SNAPSHOT_MANIFEST.json":
        return "manifest", name

    if name.startswith("skill/ava/"):
        return "ava", name[len("skill/ava/"):]
    if name == "skill/ava":
        return "ava", ""

    # Legacy layout produced by the original manual Railway command.
    if name.startswith("ava/"):
        return "ava", name[len("ava/"):]
    if name == "ava":
        return "ava", ""

    if name.startswith("downloads/"):
        return "downloads", name[len("downloads/"):]
    if name == "downloads":
        return "downloads", ""

    return None, name


def cmd_extract(args):
    archive = os.path.abspath(args.archive)
    if not os.path.isfile(archive):
        fail("archive not found: %s" % archive)

    ava_dir = norm_dir(args.ava_dir)
    downloads_dir = norm_dir(args.downloads_dir) if args.downloads_dir else ""
    max_bytes = max(1, args.max_uncompressed_mb) * 1024 * 1024

    os.makedirs(ava_dir, exist_ok=True)
    if args.include_downloads and downloads_dir:
        os.makedirs(downloads_dir, exist_ok=True)
        # Matches the permissions the original manual restore command applied.
        try:
            os.chmod(downloads_dir, 0o777)
        except OSError as exc:
            warn("cannot chmod %s: %s" % (downloads_dir, exc))

    written = 0
    skipped = 0
    rejected = []
    total_bytes = 0
    manifest = None
    ava_written = 0
    downloads_written = 0

    try:
        tf = tarfile.open(archive, "r:gz")
    except tarfile.ReadError as exc:
        fail("archive is not a readable gzip tar: %s" % exc)
    except OSError as exc:
        fail("cannot open archive: %s" % exc)

    try:
        member_count = 0
        for member in tf:
            member_count += 1
            if member_count > DEFAULT_MAX_MEMBERS:
                fail("archive contains more than %d members" % DEFAULT_MAX_MEMBERS)

            name = member.name

            # Reject every member type that is not a plain file or directory.
            if member.issym() or member.islnk():
                rejected.append("%s: link members are not permitted" % name)
                continue
            if member.ischr() or member.isblk() or member.isfifo() or member.isdev():
                rejected.append("%s: device members are not permitted" % name)
                continue
            if not (member.isreg() or member.isdir()):
                rejected.append("%s: unsupported member type" % name)
                continue

            ok, reason = is_safe_member_name(name)
            if not ok:
                rejected.append("%s: %s" % (name, reason))
                continue

            namespace, rel = classify_member(name)
            if namespace is None:
                skipped += 1
                continue

            if namespace == "manifest":
                try:
                    handle = tf.extractfile(member)
                    if handle is not None:
                        manifest = json.loads(handle.read().decode("utf-8"))
                except (ValueError, OSError, UnicodeDecodeError) as exc:
                    warn("cannot read SNAPSHOT_MANIFEST.json: %s" % exc)
                continue

            if namespace == "downloads":
                if not (args.include_downloads and downloads_dir):
                    skipped += 1
                    continue
                root = downloads_dir
            else:
                root = ava_dir

            if rel == "":
                continue

            if args.exclude_personal and posixpath.basename(rel) in PERSONAL_BASENAMES:
                skipped += 1
                continue

            dest = resolve_within(root, rel)
            if dest is None:
                rejected.append("%s: resolves outside the permitted root" % name)
                continue

            if member.isdir():
                try:
                    os.makedirs(dest, mode=0o755, exist_ok=True)
                except OSError as exc:
                    rejected.append("%s: %s" % (name, exc))
                continue

            total_bytes += member.size
            if total_bytes > max_bytes:
                fail(
                    "extraction aborted: uncompressed content exceeds the %d MB cap"
                    % (max_bytes // (1024 * 1024))
                )

            parent = os.path.dirname(dest)
            try:
                if parent:
                    os.makedirs(parent, mode=0o755, exist_ok=True)
            except OSError as exc:
                rejected.append("%s: cannot create parent directory: %s" % (name, exc))
                continue

            handle = tf.extractfile(member)
            if handle is None:
                rejected.append("%s: member has no readable content" % name)
                continue

            tmp_dest = dest + ".part"
            try:
                # Write to a sibling temp file then rename, so a crash mid-write
                # never leaves a half-written module on the volume.
                with open(tmp_dest, "wb") as out:
                    while True:
                        chunk = handle.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                os.chmod(tmp_dest, 0o644)
                os.replace(tmp_dest, dest)
            except OSError as exc:
                try:
                    if os.path.exists(tmp_dest):
                        os.unlink(tmp_dest)
                except OSError:
                    pass
                rejected.append("%s: %s" % (name, exc))
                continue
            finally:
                handle.close()

            written += 1
            if namespace == "downloads":
                downloads_written += 1
            else:
                ava_written += 1
    finally:
        tf.close()

    emit(
        {
            "ok": True,
            "files_written": written,
            "ava_files_written": ava_written,
            "downloads_files_written": downloads_written,
            "skipped": skipped,
            "rejected": rejected[:50],
            "rejected_count": len(rejected),
            "uncompressed_bytes": total_bytes,
            "ava_dir": ava_dir,
            "downloads_dir": downloads_dir if args.include_downloads else "",
            "source_manifest": manifest,
        }
    )


# ---------------------------------------------------------------------------
# INSPECT
# ---------------------------------------------------------------------------

def cmd_inspect(args):
    archive = os.path.abspath(args.archive)
    if not os.path.isfile(archive):
        fail("archive not found: %s" % archive)

    counts = {"ava": 0, "downloads": 0, "other": 0}
    total_bytes = 0
    manifest = None
    problems = []

    try:
        tf = tarfile.open(archive, "r:gz")
    except tarfile.ReadError as exc:
        fail("archive is not a readable gzip tar: %s" % exc)
    except OSError as exc:
        fail("cannot open archive: %s" % exc)

    try:
        for member in tf:
            if member.issym() or member.islnk() or member.isdev():
                problems.append("%s: link or device member" % member.name)
                continue
            if not member.isreg():
                continue

            ok, reason = is_safe_member_name(member.name)
            if not ok:
                problems.append("%s: %s" % (member.name, reason))
                continue

            namespace, _rel = classify_member(member.name)
            if namespace == "manifest":
                try:
                    handle = tf.extractfile(member)
                    if handle is not None:
                        manifest = json.loads(handle.read().decode("utf-8"))
                except (ValueError, OSError, UnicodeDecodeError):
                    pass
                continue

            if namespace in counts:
                counts[namespace] += 1
            else:
                counts["other"] += 1
            total_bytes += member.size
    finally:
        tf.close()

    emit(
        {
            "ok": True,
            "archive_bytes": os.path.getsize(archive),
            "uncompressed_bytes": total_bytes,
            "ava_file_count": counts["ava"],
            "downloads_file_count": counts["downloads"],
            "unrecognised_file_count": counts["other"],
            "problems": problems[:50],
            "problem_count": len(problems),
            "manifest": manifest,
            "layout_version": (manifest or {}).get("layout_version", 0),
        }
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def bool_arg(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def build_parser():
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create", help="Build a snapshot archive")
    create.add_argument("--out", required=True)
    create.add_argument("--ava-dir", required=True)
    create.add_argument("--downloads-dir", default="")
    create.add_argument("--include-downloads", type=bool_arg, default=True)
    create.add_argument(
        "--max-uncompressed-mb", type=int, default=DEFAULT_MAX_UNCOMPRESSED_MB
    )
    create.add_argument("--connector-version", default="")
    create.add_argument("--tenant-id", default="")
    create.add_argument("--exclude", action="append", default=[])
    create.set_defaults(func=cmd_create)

    extract = sub.add_parser("extract", help="Extract a snapshot archive")
    extract.add_argument("--archive", required=True)
    extract.add_argument("--ava-dir", required=True)
    extract.add_argument("--downloads-dir", default="")
    extract.add_argument("--include-downloads", type=bool_arg, default=True)
    extract.add_argument("--exclude-personal", type=bool_arg, default=False)
    extract.add_argument(
        "--max-uncompressed-mb", type=int, default=DEFAULT_MAX_UNCOMPRESSED_MB
    )
    extract.set_defaults(func=cmd_extract)

    inspect = sub.add_parser("inspect", help="Report on a snapshot archive")
    inspect.add_argument("--archive", required=True)
    inspect.add_argument(
        "--max-uncompressed-mb", type=int, default=DEFAULT_MAX_UNCOMPRESSED_MB
    )
    inspect.set_defaults(func=cmd_inspect)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as JSON
        fail("unhandled error: %s" % exc)


if __name__ == "__main__":
    main()
