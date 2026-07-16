# Claude Connector 12.10.0 - Neural Core scanner support

Adds the connector half of the Neural Core: it keeps `ava_brain_data.json`
current and records what each compile loaded.

Implements "Ava Brain Visualisation v2 - Jarvis-Inspired Living Architecture"
(2026-07-15), section 8.2 (scanner trigger protocol).

## Added

1. `src/tools/brain-scan-trigger.js`
   - `onToolCompleted(name, args, result)` runs after every dispatched tool.
     - `module_write`, `skill_write`, `skill_write_addition`,
       `skill_merge_additions`, `skill_recompile`, `skill_rollback`,
       `dispatch_rule_add`, `reference_write`, `script_write`, `archive_write`
       and `personality_write` schedule a rescan 20 seconds out. A burst of
       writes collapses into one scan. An errored tool result schedules nothing.
     - `skill_compile` writes `downloads/last_compile.json` (atomically, via
       temp + rename, because the scanner may read it at any moment) with the
       loaded module ids, session id and detected conditions. This is what
       lights modules up as live in the visualiser.
   - `runBrainScan()` spawns `brain_scan.py` detached, one at a time, with a
     120s ceiling. Overlapping requests coalesce into a single queued rerun.
   - `getBrainScanPaths()` for diagnostics.

2. `GET /brain-data` (auth: `X-Railway-Restore-Token`, header or `?token=`)
   Serves the scan. `?rescan=1` runs the scanner first and waits. When no scan
   exists, it runs the scanner once rather than returning an empty view. Sets
   `application/json` and `Cache-Control: private, max-age=3600`.

3. `GET /brain-data/status`
   Reports whether the scanner is deployed, whether a scan exists, whether one
   is running, the scan timestamp and the node count.

## Changed

4. `src/server-http.js`
   - `dispatchToolCall` is now a thin wrapper that calls the former body,
     renamed `dispatchToolCallCore`, and then fires the trigger hook. The hook
     is wrapped in `try/catch` at the call site and again inside itself: the
     Neural Core is an observability surface and must never be able to fail a
     tool call. Both existing callers (the MCP `CallToolRequestSchema` handler
     and `POST /tool-call`) are unchanged and pick the hook up for free.
   - Startup wires the connector logger into the scanner, logs its state, runs
     a catch-up scan 15s after boot and schedules a rescan every 6 hours. Both
     timers are `unref`'d so a cosmetic rescan cannot hold the process open. The
     scanner exits in milliseconds when nothing changed, so the periodic pass is
     nearly free.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `BRAIN_SCAN_ENABLED` | `true` | `false` disables the hook, the interval and the boot pass. `GET /brain-data` still serves an existing scan. |
| `BRAIN_SCAN_INTERVAL_HOURS` | `6` | `0` disables the periodic rescan. |

No new dependencies. No changes to any existing tool, route or handler.

## Requires

`brain_scan.py` and `brain_tools_catalog.json` in `/data/skill/ava/scripts/`
(see `ava-brain-scanner.zip`). Without them the endpoints return a 404 that
names the expected path, and the hook logs a single warning and stands down.
