# Claude Connector - Changelog

## v10.0.3 - Conversations category and context-aware session retrieval

**Release date**: 15 May 2026

### Added

* **`conversations` category** added to the memory schema. Stores per-conversation episodic records as individually addressable entries with unique timestamp-based keys (`conv_{YYYY-MM-DD}_{HH-MM-SS}`). Unlike the `session` category (named slots with upsert semantics), `conversations` entries are append-only by design: each conversation writes a new key.

* **`context_hint` parameter on `memory_get_session_context`**. Optional string (max 512 chars). When supplied, triggers an FTS5 relevance search over the `conversations` category and returns the top-N most topically relevant prior conversations instead of the most-recent-N recency sort. This enables ambient surfacing of prior work without requiring the caller to know which keys exist.

* **`conversations_limit` parameter on `memory_get_session_context`**. Optional integer (1-20, default 5). Controls how many conversation entries are returned in either relevance or recency mode.

* **`conversations_mode` field in `memory_get_session_context` response**. Returns `"relevance"` when `context_hint` was used, `"recency"` otherwise. Allows callers to audit which retrieval path was active.

* **`context_hint` and `conversations_limit` in the session context tool definition** (`definitions.js`). Full input schema and description updated so Claude reliably passes `context_hint` based on the current topic.

* **`conversations` added to all six tool category enums** in `definitions.js` and `schemas/index.js`. All existing tools (write, read, search, delete, list, session context) now accept and validate `conversations` as a valid category value.

* **FTS5 fallback in `memory_get_session_context`**. If the FTS query is rejected by SQLite (e.g. malformed tokens after sanitisation), the handler transparently falls back to recency ordering rather than throwing.

* **6 new unit tests** in `memory.test.js` covering: write/read to conversations category, array shape in session context, context_hint relevance ranking, conversations_limit cap, empty-hint fallback, and entry_count isolation.

### Changed

* `memory_get_session_context` response shape: `context.conversations` is now an **array** of entry objects (not a key-value object). Each entry includes the full row metadata and value.
* `memorySessionContextSchema` now accepts `context_hint` (string, max 512) and `conversations_limit` (integer 1-20, default 5).
* `CATEGORY_CAPS` in `memory-get-session-context.js` no longer lists `conversations`; that category is handled by a dedicated retrieval block with context-hint branching logic.

### No other files modified.

### Migration notes

No schema migration required. The `conversations` category is a new value in an existing TEXT column; existing rows are unaffected. Skills and workflows that do not supply `context_hint` continue to work exactly as before. Skills that wish to surface relevant prior conversations should pass `context_hint` with 3-6 topic keywords extracted from the current user message.

---

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
