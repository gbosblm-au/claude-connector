# Claude Connector 12.11.0 - Neural Core scanner: fewer triggers, no network from the scanner

Applies the Neural Core architecture review. The connector now publishes its own
tool registry to the volume, and the scanner no longer asks anyone anything.

## Removed

1. The 6-hourly rescan interval, and the `BRAIN_SCAN_INTERVAL_HOURS` variable.

   Every path that changes the volume goes through a tool, and every one of
   those tools already schedules a rescan. The timer could only ever confirm
   what the hooks already knew: on a quiet volume the scanner exits early and
   rewrites nothing, so the interval spent a Python spawn to produce a
   byte-identical file.

## Changed

2. The boot pass now runs only when there is no scan to serve
   (`bootScanIfMissing()`). It checks that `ava_brain_data.json` exists and is
   non-empty; if it does, no Python is spawned, which is the common case on
   every restart after the first.

   Consequence worth knowing: a volume changed out of band - a DR restore
   through `POST /restore-modules`, or a direct write to the Railway volume -
   is no longer noticed at the next restart. It is picked up by the next
   tool-triggered scan or by a click of Refresh. If that matters, the fix is one
   line: call `scheduleBrainScan()` from the restore routes. Say the word.

3. `writeToolCatalog()` writes `scripts/brain_tools_catalog.json` to the volume
   at every boot, from this connector's own live tool registry
   (`buildEffectiveToolList()`). This is what removes the scanner's HTTP call:
   the tool list is now volume state like everything else it reads, and the
   running connector is the only thing that ever writes it, so the catalogue
   cannot disagree with the connector that produced it.

   The write is skipped when only the timestamp would change - a pointless write
   is a pointless mtime bump, and the scanner keys its early exit on mtimes.
   Written even when brain_scan.py is absent, so it is already in place the
   moment someone uploads the scanner.

4. New `buildEffectiveToolList()` in server-http.js: every tool this connector
   can expose, deduplicated by name. It deliberately does not apply the
   modular-mode, tenant or SYSTEM_WRITE filters that ListTools and GET /tools
   apply, because the catalogue describes what exists rather than what a given
   session may call. It does inherit the config-conditional shape of the TOOLS
   array itself (`isTenantMode()`, `MEMORY_ENABLED`, `SKILL_ENABLED`), so the
   catalogue describes this deployment: 135 tools with memory off and tenant
   mode off, more with them on.

5. `CONNECTOR_VERSION` in brain-scan-trigger.js is read from package.json rather
   than hardcoded. server-http.js already carries two stale copies of the
   version string (12.8.2, 12.8.1); the catalogue does not need a third.

## Added

6. `scripts/generate-tool-catalog.mjs` and `npm run generate-tool-catalog`.

   Generates the same catalogue without a running connector, by importing the
   tool definition modules directly - no port, no token, no environment. For
   seeding a volume before the connector is deployed, or shipping a catalogue
   with a standalone copy of brain_scan.py.

   Scope: it produces the superset (147 tools) - everything defined anywhere in
   the codebase, regardless of the runtime config that narrows the live
   registry. Two tools (`get_current_datetime`, `stats_help`) are defined inline
   in server-http.js rather than in a module, so only the boot write sees them.
   The boot write is authoritative and overwrites this file within seconds of a
   deployment.

## Requires

`brain_scan.py` in `/data/skill/ava/scripts/`. The catalogue no longer ships
with the scanner: this connector writes it.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `BRAIN_SCAN_ENABLED` | `true` | `false` disables the hook, the boot pass and the catalogue write. `GET /brain-data` still serves an existing scan. |

`BRAIN_SCAN_INTERVAL_HOURS` is gone. It is ignored if still set.
