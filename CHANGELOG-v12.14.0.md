# CHANGELOG - claude-connector

## 12.14.0 - Phase 2: Sustained Self Across Sessions

Adds a cross-session state vector: a 14-field record of where the thread of work
and attention was left, carried between sessions. Built on the Phase 1 self-model
database. Depends on the gateway (`gateway-service` >= 2.11.0) for the
`[SESSION_STATE]` system-prompt injection.

### New

- **State vector engine** (`src/tools-self-model/stateVector.js`): build, merge,
  serialise/deserialise, curiosity/thread time-decay, 90-day staleness flagging,
  and the capped compact injection form (max 3 curiosities and 3 unresolved
  questions, per the design's context-window mitigation). The vector is stored in
  the existing `self_insights` table with `category='state_vector'` - no schema
  migration required.
  - Qualitative fields are supplied by the assistant; quantitative fields
    (`module_focus_patterns`, `session_count`, `total_interaction_time`,
    `last_session_summary`, `query_shape_observations`) are derived from the
    self-model database. A write carries the previous vector forward, overlays
    what changed, refreshes derived fields, decays idle curiosities/threads, and
    stamps per-field `last_updated`.

- **Tools** (`src/tools/selfState.js`):
  - `self_state_write` - session close: persists the full vector.
  - `self_state_read` - session open / gateway injection: returns the compact
    `[SESSION_STATE]` block and structured vector, with stale entries flagged.
  Both registered in `server-http.js` and `index.js`.

- **Volume assets** (`self-model/volume-assets/skill/ava/`):
  - `modules/self-model/state-vector-schema.md`
  - `modules/self-model/cross-session-curiosity.md`
  - `MANIFEST_APPEND.json` extended with both modules (now four total) and a
    `sustained-self` tag web.

- **Tests**: `src/tools-self-model/state-vector.test.js` (7 pure-function tests).

### Changed

- No changes to Phase 1 behaviour. The `self_insights` category index added in
  Phase 1 already covers `state_vector` lookups.

### Configuration

- No new variables. Uses the Phase 1 `SELF_MODEL_DB_PATH` / `SELF_MODEL_ENABLED`.

### Compatibility

- No breaking changes. No new npm dependencies.
- `ts-client-gateway` is unchanged in this phase.

### Verification performed

- `node --check` on all new and modified JS files (connector and gateway).
- `node --test` state-vector unit suite: 7/7 pass; Phase 1 suite still 7/7.
- End-to-end integration test through the real tool handlers: `self_state_write`
  at close then `self_state_read` at open round-trips the full 14-field vector
  through `self_insights`, derives quantitative fields, and produces a correct
  `[SESSION_STATE]` injection block. Fresh-thread and has-state gateway guards
  both behave correctly.
- `MANIFEST_APPEND.json` merges cleanly; Phase 2 module triggers fire for
  representative continuity questions.
