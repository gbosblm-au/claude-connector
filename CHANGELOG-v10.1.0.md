# Claude Connector v10.1.0 Changelog

## Summary

Adds durable MySQL-backed memory backup via the `ts-ava-memory` WordPress plugin.
Three new tools: `ava_memory_backup`, `ava_memory_restore`, `ava_memory_sync_status`.
Completely independent of Railway storage - survives Railway resets, deployments, and
database wipes. Zero new npm dependencies (uses native `fetch`).

---

## New Tools

### `ava_memory_backup`

Push all Railway SQLite memory records to the WordPress MySQL durable backup in a
single bulk-upsert call. Safe to call repeatedly (idempotent). Call at the end of
every substantive session to keep WordPress current.

Optional `include_categories` array to limit the backup to specific categories.
Omit to back up all categories (recommended).

### `ava_memory_restore`

Pull all records from the WordPress MySQL backup into the Railway SQLite store in a
single bulk-upsert call. Call automatically on session open when the Railway store is
detected as empty (0 records). Safe to call repeatedly (idempotent).

### `ava_memory_sync_status`

Compare Railway SQLite and WordPress MySQL record counts and most-recent `updated_at`
timestamps. Returns a plain-English recommendation:
- `RESTORE_NEEDED` - Railway is empty, WordPress has records
- `BACKUP_NEEDED` - WordPress is empty, Railway has records
- `IN_SYNC` - both stores have records (call backup at session close)
- `BOTH_EMPTY` - no records in either store

---

## New Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AVA_MEMORY_WP_URL` | Yes (to enable) | REST base URL from Settings > Ava Memory in WordPress |
| `AVA_MEMORY_WP_KEY` | Yes (to enable) | Secret key matching Settings > Ava Memory in WordPress |

Both variables must be set for the three tools to appear. If either is missing the
tools are silently omitted from the tool list (same behaviour as `MEMORY_AUTH_TOKEN`
for the SQLite memory subsystem).

---

## Files Changed

| File | Change |
|---|---|
| `src/config.js` | Added `avaMemoryWpUrl`, `avaMemoryWpKey` config entries |
| `src/server-http.js` | Import + tool definitions + dispatch cases for three new tools |
| `src/tools/avaMemorySync.js` | New file - all three tool handlers |
| `.env.example` | New section documenting `AVA_MEMORY_WP_URL` and `AVA_MEMORY_WP_KEY` |
| `CHANGELOG-v10.1.0.md` | This file |

---

## Companion WordPress Plugin

Install `ts-ava-memory` (included in this release as a separate ZIP) on
`truesourceconsulting.com.au`. The plugin:

- Creates a `wp_ava_memory` MySQL table on activation
- Registers REST routes at `/wp-json/ava-memory/v1/`
- Authenticates via `X-Ava-Memory-Key` header (set in Settings > Ava Memory)
- Schedules daily purge of expired records via WP-Cron
- Shows record counts and Railway env variable values in the settings page

---

## Deployment Steps

1. Install `ts-ava-memory` plugin on WordPress
2. Go to Settings > Ava Memory, generate and save a secret key
3. Copy the REST base URL shown on the settings page
4. Add `AVA_MEMORY_WP_URL` and `AVA_MEMORY_WP_KEY` to Railway Variables
5. Redeploy Railway service
6. Call `ava_memory_sync_status` to verify connectivity
7. Call `ava_memory_backup` to push existing Railway records to WordPress
