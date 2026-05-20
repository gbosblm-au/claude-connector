# Claude Connector v10.2.0 Changelog

## Summary

MySQL-primary memory store. All six `memory_*` tools now route through the
`ts-ava-memory` WordPress plugin REST API when `AVA_MEMORY_WP_URL` and
`AVA_MEMORY_WP_KEY` are set. Railway requires no persistent volume or
`MEMORY_AUTH_TOKEN`. Memory survives Railway resets, redeploys, and database
wipes permanently.

## Store selection (priority order)

1. **MySQL-primary** (WordPress plugin) - when `AVA_MEMORY_WP_URL` + `AVA_MEMORY_WP_KEY` are set.
2. **SQLite fallback** - when only `MEMORY_AUTH_TOKEN` is set (legacy / local dev).
3. **Disabled** - when neither is configured.

## Files changed

| File | Change |
|---|---|
| `src/tools-memory/wp-memory.js` | New - WordPress-backed handlers for all six tools |
| `src/tools-memory/index.js` | Updated - delegates to wp-memory or SQLite per config |
| `src/server-http.js` | Updated - MEMORY_ENABLED true when WP or SQLite configured; async init |
| `src/config.js` | Unchanged from v10.1.0 (avaMemoryWpUrl, avaMemoryWpKey already present) |
| `CHANGELOG-v10.2.0.md` | This file |

## Railway changes required

Remove (no longer needed when using MySQL-primary):
- `MEMORY_AUTH_TOKEN` - optional; can be left in place but is unused when WP is configured
- Railway persistent volume mount - not required for MySQL-primary mode

Keep / add:
- `AVA_MEMORY_WP_URL` - e.g. `https://truesourceconsulting.com.au/wp-json/ava-memory/v1`
- `AVA_MEMORY_WP_KEY` - secret key from Settings > Ava Memory in WordPress

## Companion plugin

Install `ts-ava-memory` v2.0.0 (separate ZIP). This version adds:
- `/read`, `/list`, `/search`, `/session-context` REST routes
- FULLTEXT index on `value` + `tags` columns
- Server-side context assembly (one HTTP round-trip for session startup)
- FULLTEXT fallback to LIKE search if index not ready
- Settings page shows all Railway variable values ready to copy
