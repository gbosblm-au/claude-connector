# claude-connector v12.22.0

Volume snapshot and restore endpoints, plus fixes for three defects found while
wiring them in.

## Added

### `GET /volume-snapshot`

Builds a `tar.gz` of this connector's volume and streams it back. Replaces the
manual pre-deployment Railway console command.

Auth: `X-Railway-Restore-Token` header, or `?token=` for convenience.

Query parameters:

| Parameter | Default | Effect |
|---|---|---|
| `include_downloads` | `1` | Capture `/data/downloads` as well as the ava tree. |
| `exclude` | none | Repeatable basename to skip, e.g. `?exclude=archive`. |

Response headers carry the metadata WordPress records against the stored file,
so the body stays a plain `tar.gz`:

```
X-Snapshot-Sha256                 hex digest of the archive
X-Snapshot-File-Count             total members
X-Snapshot-Ava-File-Count         members under the ava namespace
X-Snapshot-Downloads-File-Count   members under the downloads namespace
X-Snapshot-Uncompressed-Bytes     expanded size
X-Snapshot-Layout-Version         archive layout version (currently 1)
X-Snapshot-Connector-Version      connector that produced it
X-Snapshot-Tenant-Id              tenant id in tenant mode, empty in owner mode
```

### `POST /volume-restore`

Accepts a `tar.gz` as a raw request body, validates and extracts it, recreates
`/data/downloads`, then runs `brain_scan.py`. Replaces the manual
post-deployment command.

Content type must be `application/octet-stream` or `application/gzip`. A body
sent as `application/json` is rejected with 415 rather than silently mangled.

| Parameter | Default | Effect |
|---|---|---|
| `scan` | `1` | Run `brain_scan.py` after extraction. |
| `exclude_personal` | `0` | Skip `PERSONALITY.md` and `PROFILES.md`. |
| `include_downloads` | `1` | Restore the downloads namespace. |

A missing or failing `brain_scan.py` is reported in the response but does not
fail the restore: the files are already on the volume, and the scan is an
observability artefact rather than part of the write.

### `GET /volume-snapshot/status`

Diagnostics for the WordPress admin screen: resolved paths, whether the helper
and scanner are deployed, the configured size ceilings, and the tenant mode. A
failed restore can be diagnosed without shell access.

### `src/routes/volume_snapshot.py`

Archive creation and extraction helper, spawned with an argv array. Extraction
treats every archive as hostile:

- Only regular files and directories are extracted. Symlinks, hard links,
  FIFOs, character devices and block devices are rejected, which closes the
  classic symlink-then-overwrite tar escape.
- Member names are rejected if absolute, if any component is `..`, if they
  contain a NUL or backslash, or if they are drive-qualified.
- Every destination is re-checked with `realpath` after joining, so a name that
  passes validation but resolves outside the root through an existing symlinked
  parent is still rejected.
- Cumulative uncompressed size and member count are capped, bounding
  decompression bombs.
- Archive permission bits are discarded. Files are written `0644` and
  directories `0755`, so no member can arrive setuid, setgid or world-writable.

## Fixed

### Route modules were registered after the catch-all 404, so `/provision` and `/export-all` were dead

`registerProvisionRoute(app)` and `registerExportRoute(app)` were called inside
the `httpServer.listen()` callback, which runs after `server-http.js` has
finished evaluating. Express matches layers in registration order, and the
catch-all `app.use((_req, res) => res.status(404)...)` was already registered at
that point, so **every request to `POST /provision` and `GET /export-all`
returned 404**.

Verified against Express 5.2.1:

```
/early -> 200 {"ok":"early"}     route registered before the catch-all
/late  -> 404 {"error":"Not found"}   route registered after it
```

Both calls have been moved to module scope immediately above the catch-all.

### `POST /provision` accepted any `api_key` in owner mode

With `TS_CLIENT_MODE` unset (the default for the main connector), the owner
branch set `tenantId` and proceeded without validating the caller at all. Any
non-empty `api_key` string was accepted, and the handler then wrote
caller-supplied paths under `VOLUME_ROOT`. That is an unauthenticated arbitrary
file write.

It was never exploitable in practice only because of the route-ordering defect
above. Since this release makes the route reachable, the hole is closed at the
same time: owner mode now requires `RAILWAY_RESTORE_TOKEN`, compared in constant
time, supplied either as `api_key` or in the `X-Railway-Restore-Token` header.
If the variable is unset the endpoint returns 503 rather than running unguarded.

### `POST /provision` used prefix matching for path containment

Both containment checks used `resolved.startsWith(base)` without a trailing
separator, so a sibling directory sharing the base as a string prefix passed.
With `VOLUME_ROOT=/app/data`, a `base_path` of `/app/data-evil` was accepted.
Both checks now compare against `base + path.sep` and allow the root itself.

## Notes

### The manual commands this replaces had two defects of their own

**`../downloads/` never restored to `/data/downloads`.** GNU tar strips the
leading `../` when building the archive:

```
$ cd /data/skill && tar czf x.tar.gz ava/CORE.md ../downloads/
tar: Removing leading `../' from member names
$ tar tzf x.tar.gz
ava/CORE.md
downloads/report.csv
```

So `cd /data/skill && tar xzf` placed the artefacts in `/data/skill/downloads`,
while `DOWNLOADS_DIR`, the reaper and `GET /download/:filename` all read
`/data/downloads`. Every restore silently lost them. Archives here namespace
members explicitly (`skill/ava/...` and `downloads/...`) and the extractor maps
each namespace to the connector's real directory, so this cannot recur.

**`tar xzf /tmp/connector-backup-*.tar.gz` was non-deterministic.** With more
than one backup in `/tmp`, the glob expands to multiple `-f` arguments and only
the last takes effect. Restores here always name exactly one archive.

### Legacy archive compatibility

Archives produced by the old manual command (members named `ava/...` and
`downloads/...`, no `SNAPSHOT_MANIFEST.json`) are detected and restored to the
correct directories, so an existing backup can be uploaded through the plugin.

### Tenant-mode layout

`getModularPaths()` is now exported and used as the single source of truth for
the ava directory. On an owner-mode connector that is `/data/skill/ava`; on a
tenant-mode connector it is `/data/clients/<tenant_id>`. Because archive members
are namespaced logically rather than by absolute path, one archive restores
correctly onto either layout.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `RAILWAY_RESTORE_TOKEN` | none | Required. Authenticates all three endpoints. |
| `SNAPSHOT_ENABLED` | `true` | Set `false` to disable the endpoints. |
| `SNAPSHOT_MAX_MB` | `256` | Upload ceiling for `/volume-restore`. |
| `SNAPSHOT_MAX_UNCOMPRESSED_MB` | `1024` | Expanded-size ceiling. |
| `SNAPSHOT_TIMEOUT_MS` | `300000` | Python helper timeout. |
| `SNAPSHOT_TMP_DIR` | `/tmp` | Scratch directory. |
| `DOWNLOADS_DIR` | `/data/downloads` | Artefact directory. |

No new npm dependencies. Archive work uses Python's `tarfile`, which is already
present for `brain_scan.py`.

## Tests

`tests/volume-snapshot.test.js`, 26 assertions, run with
`node --test tests/volume-snapshot.test.js`. Covers constant-time token
comparison, auth rejection, archive creation and header metadata, restore of
deleted files, the downloads-directory placement fix, `exclude_personal`,
graceful handling of a missing scanner, rejection of a hostile archive
containing traversal, absolute-path and symlink members, the route-ordering
regression, and all three `/provision` security fixes.

## Known issue, not addressed

The startup banner in `server-http.js` still logs a hardcoded
`claude-connector v12.8.2`. It is cosmetic and was left alone to keep this
diff tight.

## Files

```
 src/routes/volume-snapshot.js    new
 src/routes/volume_snapshot.py    new
 tests/volume-snapshot.test.js    new
 src/server-http.js               modified  (import, route registration, 404 list)
 src/routes/provision.js          modified  (auth, path containment)
 src/tools/skill-modular.js       modified  (export getModularPaths)
 package.json                     modified  (version)
```
