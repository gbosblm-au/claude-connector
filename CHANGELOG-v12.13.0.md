# CHANGELOG - claude-connector

## 12.13.0 - Phase 1: Self-Model Interrogation

Adds the self-model foundation: the assistant can answer questions about its own
operation (which modules ran, which tools it called, when sessions occur, what
topics recur, how behaviour trends) using structured query dispatch against a
dedicated SQLite database, rather than memory search and reconstruction.

### New

- **Self-model database** (`src/tools-self-model/`): a dedicated SQLite file on
  the Railway persistent volume (`SELF_MODEL_DB_PATH`, default
  `/data/self-model.db`), separate from the memory database. Seven tables per the
  Neural Capability Expansion spec: `session_log`, `module_activations`,
  `tool_usage`, `topic_clusters`, `session_timing`, `compile_history`,
  `self_insights`. Schema defined once in `schema.sql` and applied idempotently.
  - `db.js` - init (WAL, busy_timeout), singleton, never-throws, degrades to a
    no-op if the volume is unavailable.
  - `recorder.js` - upsert write path for tool usage, module activations, compile
    history, and session open/close.
  - `sessionContext.js` - resolves a stable per-session id.
  - `hook.js` - fire-and-forget per-turn recorder.
  - `intent.js` - natural-language -> fixed-intent classifier with hard-coded,
    parameterised SQL per intent.

- **`self_model_query` tool** (`src/tools/selfModelQuery.js`): classifies a
  natural-language question into one of six intents (module_activity,
  tool_activity, session_patterns, topic_history, module_gaps, self_trend) and
  runs the intent's parameterised query. User text never becomes SQL.

- **Volume assets** (`self-model/volume-assets/skill/ava/`, deploy to the Railway
  skill volume - see `self-model/DEPLOYMENT.md`):
  - `modules/self-model/self-model-architecture.md`
  - `modules/self-model/self-model-query-dispatch.md`
  - `MANIFEST_APPEND.json` - registers both modules (merged at compile time).
  - `scripts/self_model_aggregator.py` - populates `session_timing` and
    `topic_clusters`; optional retention archival (dry-run by default).
  - `scripts/self_model_summarizer.py` - writes natural-language summaries into
    `self_insights` (`category='summary'`).

- **Tests**: `src/tools-self-model/self-model.test.js` (intent classification and
  query-plan table mapping).

### Changed

- `src/server-http.js`:
  - Registers `self_model_query` in the tool list and dispatch switch.
  - Records `module_activations` and `tool_usage` after every turn via a
    fire-and-forget hook in `dispatchToolCall`. This realises the spec's "session
    close protocol" write incrementally, so an abrupt session end never loses the
    record. The hook is fully guarded and can never cause a tool call to fail.
  - Initialises the self-model database at boot and logs its status.
- `src/index.js` (stdio): exposes `self_model_query` for parity. Per-turn
  recording is intentionally not wired on stdio, because the Claude Desktop stdio
  path does not mount the Railway `/data` volume.

### Configuration

- `SELF_MODEL_DB_PATH` (optional, default `/data/self-model.db`).
- `SELF_MODEL_ENABLED` (optional, default `true`; set `false` to dark-launch off).

### Compatibility

- No breaking changes. No new npm dependencies (`better-sqlite3@^11.3.0` was
  already present). Python scripts use the standard library only.
- `gateway-service` and `ts-client-gateway` are unchanged in this phase.

### Verification performed

- `node --check` on all new and modified JS files.
- `node --test` self-model unit suite: 7/7 pass.
- End-to-end SQL integration test: all six intents execute against a seeded
  database built from `schema.sql` and target the correct tables; `module_gaps`
  window filtering confirmed.
- Python aggregator and summarizer run against the same schema (cross-language
  agreement); archival dry-run and `--apply` verified.
- `MANIFEST_APPEND.json` merges cleanly and module triggers fire for
  representative self-model questions.
