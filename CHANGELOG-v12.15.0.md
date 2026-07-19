# CHANGELOG - claude-connector

## 12.15.0 - Phase 3: Initiative and Background Awareness

Adds proactive nudges: a background analysis detects patterns across the
self-model record at session close, scores them, and surfaces at most one worth
raising at session open. Quiet is the default. Spans all three services;
`gateway-service` >= 2.12.0 and `ts-client-gateway` >= 5.17.0 provide delivery
and UI.

### New

- **Schema** (`src/tools-self-model/schema.sql`): two new tables, applied
  idempotently at boot:
  - `nudges` (pattern_id, pattern_category, message, score + component scores,
    status, first_detected, last_surfaced, dismiss_count, session_id, updated_at).
  - `nudge_optouts` (pattern_category, dismiss_count, opted_out) - two dismissals
    of a category opt it out permanently.

- **Python pipeline** (`self-model/volume-assets/skill/ava/scripts/`, stdlib only):
  - `pattern_analyzer.py` - seven detectors: topic recurrence, topic abandonment,
    session-timing shift, module non-use, query-shape shift, tool-preference
    change, proximity-to-goal. Detection only; emits candidate patterns.
  - `nudge_prioritizer.py` - scores each candidate
    (relevance/urgency/receptivity), applies the thresholds (>= 0.6 / 0.3 / 0.4
    individually, combined >= 2.0), skips opted-out categories, and stores
    survivors as pending. Receptivity decays with dismissals.

- **Tools** (`src/tools/nudgeTools.js`), registered in `server-http.js` and
  `index.js`:
  - `nudge_analyze` - session close: runs the Python pipeline (via the same
    spawn/path pattern as script_execute).
  - `nudge_check` - session open: returns the single highest-priority pending
    nudge and marks it surfaced. At most one; opted-out categories never surface.
  - `nudge_action` - records show_me | snooze | dismiss; dismiss increments the
    category counter and opts out at two.

- **Modules** (`self-model/volume-assets/skill/ava/modules/self-model/`):
  `background-awareness.md`, `nudge-dispatch.md`, `silence-respect.md`.
  `MANIFEST_APPEND.json` extended to seven modules with an `initiative` tag web.

### Changed

- No changes to Phase 1/2 behaviour. New tables are additive.

### Configuration

- Reuses `SELF_MODEL_DB_PATH` / `SELF_MODEL_ENABLED`. `nudge_analyze` uses
  `SCRIPTS_DIR` (default `/data/skill/ava/scripts`), the same as `script_execute`.

### Compatibility

- No breaking changes. No new npm dependencies. Python scripts are stdlib only.

### Verification performed

- `node --check` on all new/modified JS across the three services; Python
  `py_compile`; schema applies with the new tables.
- Regression: Phase 1 + 2 unit suites still 14/14.
- Python pipeline end-to-end against a seeded 16-session history: five patterns
  detected, three cleared the combined >= 2.0 bar and were stored, two correctly
  filtered below threshold (quiet-by-default confirmed).
- Connector tool test: `nudge_check` returns exactly one and marks it surfaced;
  a second check returns the next; `nudge_action` dismiss opts out at exactly two;
  an opted-out category is excluded even at score 9.9; snooze restores
  eligibility. This is the spec's Phase 3 integration test.
- `MANIFEST_APPEND.json` merges cleanly; Phase 3 module triggers fire.
