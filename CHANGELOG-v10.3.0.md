# Claude Connector v10.3.0 - MySQL-Primary Memory Mode

## Release date: 2026-05-20

## Summary

v10.3.0 fully implements MySQL as the primary and only memory store when
`AVA_MEMORY_WP_URL` and `AVA_MEMORY_WP_KEY` are configured. All six
`memory_*` tools (write, read, search, delete, list, get_session_context)
read and write directly to MySQL via the WordPress REST API with no Railway
SQLite layer involved.

The `ava_memory_backup`, `ava_memory_restore`, and `ava_memory_sync_status`
tools are now MySQL-primary aware and return correct mode-specific responses
instead of attempting a broken SQLite-to-MySQL sync operation.

---

## Problem fixed

### Circular sync bug in MySQL-primary mode (v10.2.0 and earlier)

When `AVA_MEMORY_WP_URL` + `AVA_MEMORY_WP_KEY` were set and no
`MEMORY_AUTH_TOKEN` was configured, calling `ava_memory_backup` or
`ava_memory_restore` produced incorrect results:

- `ava_memory_backup` called `readAllRailwayRecords()` which internally
  called `dispatchMemoryTool('memory_list', ...)`. In MySQL-primary mode,
  `dispatchMemoryTool` routes to the WordPress REST API, so this was reading
  records from MySQL and immediately pushing them back to MySQL. The "backup"
  was a no-op loop that returned a misleading success response.

- `ava_memory_restore` called the WordPress `/all` endpoint to fetch records,
  then called `writeRecordsToRailway()` which also routed to MySQL-primary via
  `dispatchMemoryTool`. Records were pulled from MySQL and written back to
  MySQL. Another no-op loop with a misleading success response.

- `ava_memory_sync_status` called `readAllRailwayRecords()` which returned
  all MySQL records (not SQLite records), then compared that count against the
  WordPress MySQL count. The comparison was always equal (comparing MySQL to
  itself) so the recommendation was always "IN_SYNC" regardless of actual state.

---

## Changes

### `src/tools/avaMemorySync.js`

Added `isMysqlPrimaryMode()` helper that returns `true` when
`AVA_MEMORY_WP_URL` and `AVA_MEMORY_WP_KEY` are both set.

**`handleAvaMemoryBackup`**: Checks `isMysqlPrimaryMode()` first. In
MySQL-primary mode, returns a clear informational response:

```json
{
  "success": true,
  "mode": "mysql-primary",
  "message": "Running in MySQL-primary mode. All memory_write calls go directly
    to MySQL via the WordPress REST API. There is no Railway SQLite layer.
    No backup action is required or possible.",
  "backed_up_at": "<ISO timestamp>"
}
```

In SQLite fallback mode, original backup logic is preserved unchanged.

**`handleAvaMemoryRestore`**: Same pattern. In MySQL-primary mode, returns
a clear informational response. In SQLite fallback mode, original restore
logic is preserved unchanged.

**`handleAvaMemorySyncStatus`**: In MySQL-primary mode, calls the WordPress
`/stats` endpoint directly and returns live MySQL health data:

```json
{
  "mode": "mysql-primary",
  "description": "Memory reads and writes go directly to MySQL. No SQLite layer is active.",
  "mysql": {
    "connected": true,
    "total_records": 142,
    "by_category": {
      "conversations": 38,
      "facts": 21,
      "projects": 14,
      ...
    },
    "last_updated": "<ISO timestamp>",
    "error": null,
    "endpoint": "https://truesourceconsulting.com.au/wp-json/ava-memory/v1"
  },
  "checked_at": "<ISO timestamp>"
}
```

In SQLite fallback mode, original comparison logic is preserved unchanged.

Updated tool descriptions to clearly describe MySQL-primary vs SQLite
fallback behaviour.

Updated `User-Agent` string to `claude-connector/10.3.0 (ava-memory-sync)`.

### `src/server-http.js`

Updated header comment to document v10.3.0 changes.

Bumped MCP server version string from `10.0.1` to `10.3.0`.

### `package.json`

Bumped version from `10.0.3` to `10.3.0`.

---

## Deployment

No new environment variables required. The existing `AVA_MEMORY_WP_URL`
and `AVA_MEMORY_WP_KEY` variables already activate MySQL-primary mode.

**To run in MySQL-primary mode (recommended for production):**

- Set `AVA_MEMORY_WP_URL` = `https://yoursite.com/wp-json/ava-memory/v1`
- Set `AVA_MEMORY_WP_KEY` = your secret key from WordPress Settings > Ava Memory
- Do NOT set `MEMORY_AUTH_TOKEN` (leave it unset or empty)

**To run in SQLite fallback mode (local dev / testing only):**

- Set `MEMORY_AUTH_TOKEN` = any secure secret string
- Do NOT set `AVA_MEMORY_WP_URL` and `AVA_MEMORY_WP_KEY`

---

## Backward compatibility

All six `memory_*` tool names, input schemas, and response shapes are
unchanged. Claude sees no difference in either mode.

The `ava_memory_backup` and `ava_memory_restore` tools now return a
`mode` field in their response objects. Existing callers that only check
`success: true` are unaffected.

The `ava_memory_sync_status` tool now returns a `mode` field and a
restructured response in MySQL-primary mode. The top-level `recommendation`
field is no longer present in MySQL-primary responses (it is only relevant
when comparing two stores).
