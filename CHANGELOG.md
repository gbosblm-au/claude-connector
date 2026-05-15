# Claude Connector - Changelog

## v10.0.5 - Three-tier associative conversation retrieval

**Release date**: 15 May 2026

### Added

* **Three-tier associative retrieval in `memory_get_session_context`**. Conversation
  recall now emulates human associative memory rather than a single-mode search. When
  `context_hint` is supplied, retrieval runs three tiers in sequence:

  * **Tier 1 - Exact**: FTS5 AND match. All context_hint tokens must appear in the
    document. Highest confidence. Direct vocabulary overlap with the query.
  * **Tier 2 - Related**: FTS5 OR match. Any context_hint token surfaces a document.
    Semantic proximity. Conversations with partial vocabulary overlap are ranked by BM25.
  * **Tier 3 - Associative**: Tag-web search. Extracts meaningful tags from Tier 1+2
    results (excluding noise tags such as month-year slugs and "ava") and searches for
    OTHER conversations that share any of those tags. Surfaces thematically connected
    conversations that share zero vocabulary with the original context_hint. This is the
    "web of memory" layer: the conversations a person would mentally group with the current
    topic even when the opening question uses completely different wording.

  Results are merged in tier-priority order (Tier 1 first claim, Tier 2 fills remainder,
  Tier 3 fills what remains) up to `conversations_limit`.

* **`retrieval_tier` field on every conversation entry**. Each entry in the
  `context.conversations` array now carries `retrieval_tier`: one of `"exact"`,
  `"related"`, `"associative"`, or `"recency"` (zero-results fallback). Callers weight
  context proportionally: exact = full weight, related = moderate, associative = background
  context with thematic overlap check, recency = general context not topic-specific.

* **`conversations_tiers` summary in response**. A new top-level field
  `conversations_tiers: { exact, related, associative, recency }` provides a count
  breakdown per tier for audit and observability. Present only when `context_hint` was
  supplied; `null` otherwise.

* **`conversations_mode` updated to `"associative"`** when `context_hint` is supplied
  (previously `"relevance"`), reflecting the expanded multi-tier behaviour.

* **`extractTagTerms()` helper**. Extracts meaningful tag terms from DB rows for Tier 3
  seeding. Filters noise tags via `NOISE_TAG_PATTERNS` regex array (month-year slugs,
  "real-mode", "ava") to prevent false-positive flood in Tier 3 results.

* **`runConvFts()` helper**. Shared FTS5 conversation query function used across all
  three tiers. Overfetches to absorb JS-side exclusion filtering; errors are caught and
  empty arrays returned so tiers degrade gracefully rather than throwing.

* **`{ useOr }` option on `safeFtsQuery`** (carried forward from v10.0.4 and formalised
  in the internal API). Tier 1 uses AND mode; Tiers 2 and 3 use OR mode.

### Changed

* `recencySql` extracted to a named constant shared across all fallback paths.
* `runConvFts()` overfetches by `excludeIds.size + 5` and filters in JS; the prepared
  statement has no dynamic NOT IN clause, avoiding statement-reuse issues with
  variable-length exclusion sets.

### Fixed

* Zero-results fallback (from v10.0.4) is now a formally named path within the
  three-tier system rather than an ad-hoc check.

---

## v10.0.4 - FTS5 context_hint OR-mode and zero-results fallback

**Release date**: 15 May 2026

### Bug Fixes

* **FTS5 AND-logic bug in `memory_get_session_context`** (critical). The `safeFtsQuery` helper
  was wrapping each `context_hint` token in double quotes and joining them with a space, which
  produces an implicit AND in SQLite FTS5. This meant ALL tokens in the hint had to appear in
  the same conversation document for it to be returned. For a hint like
  `"consciousness transfer synthetic body robots AI"`, no stored conversation contained all six
  terms simultaneously, so the query returned zero results even when highly relevant conversations
  existed. Fixed by adding a `{ useOr }` option to `safeFtsQuery`: the context_hint path now
  calls `safeFtsQuery(hint, { useOr: true })` which joins tokens with ` OR `, so any matching
  token surfaces a document and BM25 ranks by total relevance. The existing AND behaviour is
  preserved for `memory_search` where precise multi-token matching is correct.

* **Zero-results fallback missing in `memory_get_session_context`** (high). When FTS5 succeeded
  but returned no results (e.g. first conversation on a new topic whose tokens don't yet exist
  in memory), the function returned an empty `conversations` array rather than falling back to
  recency. Added an explicit length check after the FTS5 call: if `convRows.length === 0`, the
  handler re-queries using the recency path before continuing. This ensures the caller always
  receives the most recent conversations as a safety net, regardless of context_hint match quality.

### Changed

* `safeFtsQuery` signature updated from `safeFtsQuery(raw)` to `safeFtsQuery(raw, { useOr = false } = {})`.
  Existing callers with no second argument are unaffected (AND mode is the default).
* `recencyQuery` extracted to a named constant shared by the no-hint path, the exception handler,
  and the zero-results fallback to eliminate query string duplication.

---

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
