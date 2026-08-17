# v12.49.0 — Fix: the engines were never installed, and a misconfiguration was silent

Reported as: no mic button, no audio, with `VOICE_ENABLED=true` on the connector.

## Two blockers, both mine

### 1. Neither engine was in the image

v12.46.0 shipped `requirements-voice.txt` and `requirements-piper.txt` and
documented the pip commands, and **never touched the Dockerfile**. So
faster-whisper and Piper were not installed. Nothing could transcribe however
the gates were set.

The Dockerfile now installs both, in **two separate Python environments**,
because the separation is the licence boundary and not tidiness:

| | Licence | Where |
|---|---|---|
| faster-whisper | MIT | system site-packages, imported by `voice_stt.py` |
| piper-tts | GPL-3.0 | its own venv at `/opt/piper`, never on our import path |

Installing them together would put GPL code in the interpreter our MIT helper
imports from, which is where the entanglement SPEC §6.2 exists to prevent
begins. Tests assert neither install line mentions the other.

Also adds `ffmpeg` and `espeak-ng`, and defaults `VOICE_PIPER_BIN` and the cache
paths to match the layout, so a deployment only has to set `VOICE_ENABLED` and
the allowlist.

**Build cost is real**: CTranslate2 and onnxruntime are a few hundred MB. That is
the price of local speech, and why the feature is behind a flag.

### 2. A correct refusal was indistinguishable from "off"

The reported configuration was:

```
VOICE_ENABLED=true
VOICE_ALLOWLIST_SOURCE=gateway
VOICE_TEST_USERS=ava:38
```

with no `VOICE_ALLOWLIST_URL`. In gateway mode the env allowlist is **ignored**,
the fetch cannot be attempted, so the allowlist is empty and every user is
denied.

That is correct fail-closed behaviour. It is also invisible: no mic, no error,
and `VOICE_TEST_USERS` sitting in the variable list looking like it should be
doing something. There was no way to tell a misconfiguration from a working
"off" — which makes the safe default a support call.

`allowlistConfigProblems()` now detects and names these, reported in two places:

- **at boot**, at error level, once
- **`GET /voice/health`** under `configuration_problems`

Reported to a *denied* caller too, but only when `VOICE_ENABLED` is true. The
operator who needs the message is by definition the person being denied, so
withholding it means the only way to see the fault is to already be past it. With
the master switch off nothing is said, because the routes must stay
indistinguishable from routes that do not exist.

Against the reported variables it produces:

1. `VOICE_ALLOWLIST_URL is not set, so the allowlist cannot be fetched and every user is denied`
2. `neither VOICE_ALLOWLIST_KEY nor GATEWAY_ADMIN_KEY is set`
3. `VOICE_TEST_USERS is set but IGNORED, because VOICE_ALLOWLIST_SOURCE=gateway`

The third is the one that would have saved the most time.

## Verification

- `src/tests/voice.test.js` — 47 passed (5 new, including the reported
  configuration reproduced exactly and the Dockerfile boundary).
- Full sweep: only the pre-existing `render-tools.test.js` failure.

---

# Claude Connector - Changelog

## v12.36.0 - 2026-08-06

### Neural Core scans are manual trigger only

The boot scan is removed, so a deployment no longer spawns brain_scan.py. The
dormant debounce scheduler (scheduleBrainScan) and its RESCAN_TRIGGERS allowlist
are deleted so automatic scanning cannot return by accident. GET /brain-data no
longer scans implicitly when the data file is absent; only ?rescan=1 does.

Scans now run from POST /brain-scan, GET /brain-data?rescan=1, an operator-run
POST /volume-restore, or script_execute. /brain-data/status reports the policy
and the provenance of the last scan.

Also fixes an authentication bypass in POST /brain-scan: the token guard failed
OPEN when neither DOCUMENT_DOWNLOAD_TOKEN nor RAILWAY_RESTORE_TOKEN was set, so
any unauthenticated caller could spawn Python on the volume. It now fails closed,
compares in constant time, and no longer 500s on a duplicated query parameter.

Pairs with ts-client-gateway v5.81.0, which removes the 15-minute cron. Full
detail: CHANGELOG-v12.36.0.md.

## v12.22.0 - 2026-07-24

### Volume snapshot and restore endpoints

GET /volume-snapshot, POST /volume-restore and GET /volume-snapshot/status
replace the manual pre/post-deployment Railway console tar commands, and are
driven from the WordPress Connector Snapshots screen.

Also fixes three defects found while wiring them in: route modules were
registered after the catch-all 404 so POST /provision and GET /export-all were
unreachable; owner-mode /provision accepted any api_key, which was an
unauthenticated arbitrary file write once the route became reachable; and both
/provision path containment checks used prefix matching rather than a path
boundary. Full detail: CHANGELOG-v12.22.0.md.

## v12.21.0 - 2026-07-21

### Structural manifest fragment registration

module_write now auto-registers every .md module as a manifest fragment in
references/manifest/; skill_compile, skill_recompile, and skill_load_specialist
read the merged MANIFEST + MANIFEST_APPEND + fragment view live; brain_scan.py
v2.1.0 catalogs fragment-registered modules with provenance and inferred paths.
Full detail: CHANGELOG-v12.21.0.md.

## v12.4.0 - 2026-06-09

### Add skill_recompile MCP tool (mid-session delta recompile)

**Problem:** When a conversation's topic shifts significantly mid-session, the initial
`skill_compile` selection becomes stale. `skill_load_specialist` requires knowing the
exact module ID. `skill_compile` cannot safely be re-called mid-session (designed for
session-start only). The context window is append-only so prior skill content cannot
be removed. The result: Claude operates on the wrong module selection for the new topic.

**Solution:** `skill_recompile` — a mid-session delta recompiler.

**Behaviour:**
- Accepts `new_query` (required), `context_hint`, `person_name`, and `current_modules`.
- Runs the full 6-layer dispatcher (person prior, mandatory, lexical, tag-web, adjacency,
  budget) for the new query.
- Computes the delta: modules selected for the new topic that are NOT in `current_modules`.
- Returns ONLY the delta module content (never CORE — already in context) plus metadata.
- When the delta is empty (all selected modules already loaded), returns a no-op with a note.
- The caller appends the returned content to the active session context; it supersedes
  conflicting guidance from earlier-loaded modules for the new topic.

**Design rationale (append-only context window):**
The fundamental constraint is that prior context cannot be purged. `skill_recompile`
works within this constraint: it does not attempt to replace prior skill content but
adds the correct new content for the shifted topic. The response note explicitly states
that returned modules supersede earlier conflicting guidance for the new topic.

**Changes:**

`src/tools/skill-modular.js`
- Added `skillRecompileToolDefinition` and `handleSkillRecompile` (exported).
- Uses the shared `compileSkill()` and `personPriorLayer()` functions — no dispatcher
  duplication.
- Falls back to `ownerAvaDir` for module files in tenant mode when per-client path
  is missing (handles shared module pool architecture).

`src/server-http.js`
- Imports `skillRecompileToolDefinition` and `handleSkillRecompile`.
- Added to static TOOLS array (under `SKILL_MODULAR_ENABLED` guard).
- Added `"skill_recompile"` to `MODULAR_TOOL_NAMES` set in ListToolsRequestSchema handler.
- Added to dynamic modular tools list.
- Added `case "skill_recompile"` to CallToolRequestSchema switch.
- Version comment updated to v12.4.0.

`package.json`
- Version bumped to 12.4.0.

**No new environment variables required.**
**No Railway redeploy changes beyond the version update.**




### Add ts_gateway_session_init MCP tool (tenant mode)

**Problem:** The `ts_gateway_session_init` MCP tool was referenced in system prompts
generated by the TrueSource Client Gateway WP plugin but did not exist in the
connector's tool list. Claude called it at session start, received a tool-not-found
error, and aborted the entire init sequence. The consequence was that `skill_compile`
was never called and client sessions fell back to default Claude behaviour without
any specialist modules loaded.

**Changes:**

`src/tools/gatewaySessionInit.js` (new file)
- Implements `ts_gateway_session_init` MCP tool.
- Advertised only when `TS_CLIENT_MODE=tenant`.
- Calls `POST {gateway_url}/session-init` with `api_key` and `tenant_id`.
- On success: returns `session_authenticated: true`, `tenant_id`, `display_name`,
  `tier`, `session_id`, and a `next_steps` array that explicitly names
  `skill_compile` as required and non-deferrable. Claude receives the correct
  instruction twice: once from the system prompt and once from this tool response.
- On gateway unavailable: returns a degraded result with instructions to continue
  using the connector tools directly. Non-fatal: session proceeds with reduced
  capability rather than hard-failing.

`src/server-http.js`
- Imports `tsGatewaySessionInitToolDefinition` and `handleTsGatewaySessionInit`.
- Tool added to TOOLS array behind `isTenantMode()` guard (owner mode unaffected).
- Switch case added: `case "ts_gateway_session_init"`.
- Version header updated to v12.3.0.

`package.json`
- Version bumped to 12.3.0.

**WP plugin requirement:** Gateway plugin v2.5.0 must be deployed. That version adds
the `/wp-json/ts-gateway/v1/session-init` REST endpoint this tool calls, and fixes
the generated system prompt to include `profile_read` and `skill_compile`.

**Deployment:** Standard Railway redeploy. No new environment variables required.
Existing `TS_CLIENT_MODE`, `TS_TENANT_GATEWAY_URL`, `TS_CLIENT_API_KEY`, and
`TS_TENANT_ID` env vars are all that is needed.


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
