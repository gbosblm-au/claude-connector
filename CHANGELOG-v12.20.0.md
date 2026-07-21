# claude-connector v12.20.0 — Phase 10 (mobile pipeline + Bookworm migration)

## Workstream 1: Mobile application generation (mobile_app_gen.py)

New script at self-model/volume-assets/skill/ava/scripts/mobile_app_gen.py
(deploys to the volume at /data/skill/ava/scripts, run via script_execute).
Standard library only.

Reads a JSON app spec (--input) and writes a complete Android Gradle project to
--output: settings/build gradle files, AndroidManifest (single launcher, INTERNET
permission when any screen has an endpoint or webview), res/values colors,
strings and themes, one layout XML plus one Activity per feature, and an
AuthGuard for auth-gated screens. Five layout types are supported: list, detail,
form, dashboard, webview. Writes build/app_gen_manifest.json (per-file sha256 +
resolved spec) so the refresh cycle can diff against it. Includes a structural
smoke test (XML well-formedness via minidom, Java brace balance); a full
javac/d8 compile is noted as requiring the Android SDK from the Phase 10 image.
CLI: --input, --output, --dry-run, --no-smoke-test.

## Workstream 2: Mobile refresh cycle (mobile_refresh.py)

New script in the same scripts directory. Reads the current config (--input or
$MOBILE_CONFIG_PATH), loads the last deployed manifest (--manifest,
$MOBILE_MANIFEST_PATH, or /data/mobile/last_deployed_manifest.json), regenerates
the full project to a temp dir, diffs by sha256 (added/removed/modified/
unchanged), groups changes into modules (manifest, resources, build-config, auth,
feature:<Activity>), writes only the changed files to --output, runs the
structural smoke test on the changed subset, and emits a per-module build report.
On a passing non-dry-run it writes the updated manifest and bumps deploy_count.
--dry-run reports the diff and tests without writing files or updating the
manifest.

## Workstream 3: Dockerfile base image migration

Migrated from node:20-alpine to Debian Bookworm (musl -> glibc; apk -> apt).
Four stages: base (Debian Bookworm + Node 20 via NodeSource), deps (production
node_modules), android-sdk (ISOLATED: OpenJDK 17 + Android SDK 34 command-line
tools, licenses accepted, platform-tools / platforms;android-34 /
build-tools;34.0.0), and runtime (Python + document libraries, Android SDK copied
from the isolated stage, non-root mcp user, healthcheck). Fixed a pre-existing
duplicated COPY block. reportlab is now installed (Phase 5b needs it; it was
missing before). Honest notes in the file: Bookworm's default Python is 3.11, not
3.12 as the spec states, and no connector script needs 3.12; the previous base
was Alpine, not Debian/Ubuntu as the spec assumed.

Build and deploy are an Engineering step (no Docker in this environment). The
Android SDK stage can be validated on its own with
`docker build --target android-sdk .` before wiring it into runtime.

## Notes

- The two mobile scripts are standard-library only; no new pip dependencies.
- Gateway is unchanged in Phase 10 (stays 2.16.0).
