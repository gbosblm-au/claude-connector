# Claude Connector - Changelog

## v10.0.0 - Persistent Memory MCP integration

**Release date**: 15 May 2026

### Added

* **Six new MCP tools** implementing the TrueSource Persistent Memory MCP TDD v1.0:
  * `memory_write` - upsert by `(category, key)` with optional `ttl_days`, `tags`, `confidence`, `source_session`.
  * `memory_read` - filter by category, key, or tags (at least one required).
  * `memory_search` - SQLite FTS5 full-text search ranked by BM25, supports prefix and phrase queries.
  * `memory_delete` - hard delete by `(category, key)`.
  * `memory_list` - metadata summary with `by_category` counts, optional `include_value`.
  * `memory_get_session_context` - curated session bundle with category caps (skills ≤ 20, contacts ≤ 10, session ≤ 5).
* **SQLite storage** with WAL mode, FTS5 virtual table, three sync triggers, and three secondary indexes - all maintained in `/data/memory.db` on the Railway persistent volume.
* **TTL expiry worker** (`setInterval`, default 1-hour cadence, configurable via `TTL_WORKER_INTERVAL_MS`).
* **Bearer-token auth gating** via the new `MEMORY_AUTH_TOKEN` environment variable. When unset, the six memory tools are omitted from the advertised tool list and the rest of the connector functions unchanged.
* **`GET /memory/admin/dump`** endpoint - full corpus JSON export protected by `MEMORY_AUTH_TOKEN`.
* **`memory` block in `/health` response** showing entry count and per-category breakdown.
* **13 new unit tests** (`src/tools-memory/memory.test.js`) covering upsert semantics, validation, FTS, TTL exclusion, and category caps. Run with `npm run test:memory`.

### Changed

* `railway.toml` now declares a persistent volume named `claude-connector-data` mounted at `/data`. Existing deployments need to attach a volume; ephemeral installs are unaffected.
* `/health` payload now reports `version: "10.0.0"` and includes the `memory` snapshot.
* Node engine bumped to `>=20.0.0` to match `better-sqlite3` requirements.

### Dependencies added

* `better-sqlite3 ^11.3.0`
* `express-rate-limit ^7.4.0`
* `uuid ^10.0.0`
* `zod ^3.23.8`

### Migration notes

Set `MEMORY_AUTH_TOKEN` in Railway Variables (`npm run gen-memory-token` produces one). Existing deployments without the variable continue to operate exactly as v9.0.0 with the six memory tools silently disabled. No backward-incompatible API changes.

---

## v9.0.0 - Statistical analysis & ML toolkit (previous release)

(unchanged content)

## v8.0.0 - Google Calendar, Sheets, Slack, Teams, Webhook receiver

(unchanged content)

## v7.0.0 - TrueSource outreach direct send

(unchanged content)
