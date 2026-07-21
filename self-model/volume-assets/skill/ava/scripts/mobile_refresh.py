#!/usr/bin/env python3
"""
mobile_refresh.py  (Phase 10, Workstream 2)

Automates the mobile app refresh cycle. Given the current mobile configuration
(the app spec) it diffs against the last deployed manifest, regenerates only the
source files that changed, runs structural unit tests on the regenerated code,
and produces a per-module build report. On a real (non dry-run) refresh it also
updates the stored "last deployed" manifest.

Refresh cycle (from the Phase 10 specification):
  1. Read current mobile configuration from the memory store.
  2. Compare against the last deployed version (stored manifest).
  3. Identify changed modules requiring rebuild.
  4. Regenerate changed source files.
  5. Run unit tests on regenerated code.
  6. Generate a build report with pass/fail status per module.
  7. Update the last deployed version in the memory store.

Invoked through script_execute:  --input <config.json>  --output <dir>
Additional inputs (resolved in this order):
  * new config:  --input, else $MOBILE_CONFIG_PATH
  * last manifest: --manifest, else $MOBILE_MANIFEST_PATH,
                   else /data/mobile/last_deployed_manifest.json

Reuses mobile_app_gen.py for generation and validation. Standard library only.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

# Import the generator from the same scripts directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mobile_app_gen as gen  # noqa: E402

DEFAULT_MANIFEST_PATH = "/data/mobile/last_deployed_manifest.json"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def die(message, code=2):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def resolve_config_path(args):
    if args.input:
        return args.input
    env = os.environ.get("MOBILE_CONFIG_PATH")
    if env:
        return env
    return None


def resolve_manifest_path(args):
    if args.manifest:
        return args.manifest
    return os.environ.get("MOBILE_MANIFEST_PATH", DEFAULT_MANIFEST_PATH)


def load_last_manifest(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "files" in data:
            return data
    except (OSError, ValueError):
        return None
    return None


# --------------------------------------------------------------------------- #
# Module mapping
# --------------------------------------------------------------------------- #

def module_for_path(path, spec):
    """Map a generated file path to a logical module name."""
    lower = path.lower()
    if lower.endswith("androidmanifest.xml"):
        return "manifest"
    if "/res/values/" in lower:
        return "resources"
    if lower.endswith(".gradle") or lower.endswith("gradle.properties"):
        return "build-config"
    if lower.endswith("authguard.java"):
        return "auth"
    # Feature modules: match by activity class or layout id.
    for feat in spec["features"]:
        act = feat["activity_name"]
        layout_id = "activity_" + gen._to_snake(act)
        if path.endswith(f"/{act}.java") or path.endswith(f"/{layout_id}.xml"):
            return f"feature:{act}"
    return "other"


def diff_files(old_files, new_files):
    """old_files/new_files: list of {path, sha256}. Returns categorized dict."""
    old = {f["path"]: f["sha256"] for f in (old_files or [])}
    new = {f["path"]: f["sha256"] for f in (new_files or [])}
    added = [p for p in new if p not in old]
    removed = [p for p in old if p not in new]
    modified = [p for p in new if p in old and new[p] != old[p]]
    unchanged = [p for p in new if p in old and new[p] == old[p]]
    return {"added": added, "removed": removed, "modified": modified, "unchanged": unchanged}


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the mobile app refresh cycle.")
    parser.add_argument("--input", help="Path to the current mobile configuration (app spec JSON).")
    parser.add_argument("--output", default=".", help="Directory to write regenerated files into.")
    parser.add_argument("--manifest", help="Path to the last deployed manifest.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report the diff and tests without writing files or updating the manifest.")
    args = parser.parse_args(argv)

    # Step 1: read current configuration.
    config_path = resolve_config_path(args)
    spec_raw = gen.load_spec(config_path)
    try:
        spec, warnings = gen.validate_spec(spec_raw)
    except ValueError as err:
        die(f"invalid mobile configuration: {err}")

    # Step 2: load the last deployed manifest.
    manifest_path = resolve_manifest_path(args)
    last = load_last_manifest(manifest_path)
    first_deploy = last is None

    # Step 3+4: regenerate the full project into a temp dir, then diff.
    tmp_dir = tempfile.mkdtemp(prefix="mobile_refresh_")
    try:
        written = gen.build_project(spec, tmp_dir)
        new_manifest = {
            "generator": "mobile_app_gen.py",
            "generated_at": now_iso(),
            "spec": spec,
            "files": written,
            "deploy_count": (last.get("deploy_count", 0) + 1) if last else 1,
        }

        diff = diff_files(last.get("files") if last else [], written)
        changed_paths = diff["added"] + diff["modified"]

        # Step 3: group changes into modules.
        modules = {}
        for path in changed_paths:
            mod = module_for_path(path, spec)
            modules.setdefault(mod, {"status": "rebuilt", "files": []})
            modules[mod]["files"].append(path)
        for path in diff["removed"]:
            mod = module_for_path(path, spec) if last else "other"
            modules.setdefault(mod, {"status": "removed", "files": []})
            if modules[mod]["status"] != "rebuilt":
                modules[mod]["status"] = "removed"
            modules[mod]["files"].append(path)

        # Step 4: write regenerated (changed) files to the output dir.
        output_dir = args.output or "."
        copied = []
        if not args.dry_run:
            os.makedirs(output_dir, exist_ok=True)
            for path in changed_paths:
                src = os.path.join(tmp_dir, path)
                dst = os.path.join(output_dir, path)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
                copied.append(path)
            # Remove files that no longer exist in the new generation.
            for path in diff["removed"]:
                stale = os.path.join(output_dir, path)
                if os.path.exists(stale):
                    try:
                        os.remove(stale)
                    except OSError:
                        pass

        # Step 5: run unit tests (structural validation) on the changed files.
        changed_written = [w for w in written if w["path"] in set(changed_paths)]
        test_report = gen.smoke_test(tmp_dir, changed_written) if changed_written else {
            "passed": True, "xml_wellformed": 0, "java_balanced": 0,
            "xml_failed": [], "java_failed": [], "note": "no changed files to test",
        }

        # Attach per-module test outcome. A module passes unless one of its files
        # appears in the smoke test's failure lists.
        failed_paths = {f["path"] for f in test_report.get("xml_failed", [])}
        failed_paths |= {f["path"] for f in test_report.get("java_failed", [])}
        for mod, info in modules.items():
            info["test"] = "fail" if (set(info["files"]) & failed_paths) else "pass"

        # Step 6: build report.
        report = {
            "ok": test_report.get("passed", True),
            "app_name": spec["app_name"],
            "app_version": spec["app_version"],
            "first_deploy": first_deploy,
            "dry_run": bool(args.dry_run),
            "deploy_count": new_manifest["deploy_count"],
            "summary": {
                "added": len(diff["added"]),
                "modified": len(diff["modified"]),
                "removed": len(diff["removed"]),
                "unchanged": len(diff["unchanged"]),
                "modules_rebuilt": sum(1 for m in modules.values() if m["status"] == "rebuilt"),
            },
            "modules": modules,
            "changed_files": changed_paths,
            "removed_files": diff["removed"],
            "tests": {
                "passed": test_report.get("passed", True),
                "xml_wellformed": test_report.get("xml_wellformed", 0),
                "java_balanced": test_report.get("java_balanced", 0),
                "xml_failed": test_report.get("xml_failed", []),
                "java_failed": test_report.get("java_failed", []),
            },
            "warnings": warnings,
            "manifest_path": manifest_path,
            "generated_at": now_iso(),
        }
        if not args.dry_run:
            report["files_written"] = copied

        # Step 7: update the last deployed manifest (only on a passing real run).
        if not args.dry_run:
            if report["ok"]:
                os.makedirs(os.path.dirname(manifest_path) or ".", exist_ok=True)
                with open(manifest_path, "w", encoding="utf-8") as fh:
                    json.dump(new_manifest, fh, indent=2, ensure_ascii=False)
                report["manifest_updated"] = True
            else:
                report["manifest_updated"] = False
                report["manifest_update_skipped_reason"] = "unit tests failed; manifest left unchanged"

        print(json.dumps(report, ensure_ascii=False))
        return 0 if report["ok"] else 1
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
