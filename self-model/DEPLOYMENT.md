# Self-Model (Phase 1) - Deployment

Phase 1 has two parts: the connector code (deploys with the normal Railway
service) and the volume assets (skill modules, MANIFEST_APPEND, Python scripts)
that live on the persistent `/data` volume.

## 1. Code (automatic with deploy)

The self-model code ships inside `claude-connector` v12.13.0. On boot the service
creates `/data/self-model.db` and applies the schema. No action needed beyond
deploying the new version.

Optional environment variables (Railway Variables):

| Variable | Default | Purpose |
|---|---|---|
| `SELF_MODEL_DB_PATH` | `/data/self-model.db` | Location of the self-model database. |
| `SELF_MODEL_ENABLED` | `true` | Set to `false` to disable recording and the query tool. |

Confirm success in the boot logs:

```
Self-model: ENABLED (self_model_query, per-turn recording)
[self-model] database ready at /data/self-model.db
```

## 2. Volume assets (one-time copy to /data)

The files under `self-model/volume-assets/skill/ava/` must be placed on the
Railway skill volume so the modules can be compiled and the scripts can run.
Target base directory is derived from `SKILL_FILE_PATH` (owner mode:
`/data/skill/ava/`).

Copy so the final layout is:

```
/data/skill/ava/MANIFEST_APPEND.json
/data/skill/ava/modules/self-model/self-model-architecture.md
/data/skill/ava/modules/self-model/self-model-query-dispatch.md
/data/skill/ava/scripts/self_model_aggregator.py
/data/skill/ava/scripts/self_model_summarizer.py
```

If `MANIFEST_APPEND.json` already exists on the volume (from a prior phase), merge
the `modules` array and `tag_web` entries rather than overwriting - the compiler
already merges append-only, but keep a single file with all appended modules.

Use the operator's normal volume-push mechanism (the same one used to restore
skill modules). The compiler merges `MANIFEST_APPEND.json` into `MANIFEST.json`
at the next `skill_compile`.

## 3. Scheduling the aggregation scripts

Run these periodically on the service host (or via the platform scheduler). They
use the standard library only; no `pip install` required.

```bash
# Nightly: refresh derived tables. Add archival once history is >90 days old.
python3 /data/skill/ava/scripts/self_model_aggregator.py
# python3 /data/skill/ava/scripts/self_model_aggregator.py --archive-days 90 --apply

# Weekly: write a natural-language summary into self_insights.
python3 /data/skill/ava/scripts/self_model_summarizer.py --window-days 7 --dedup
```

Archival is a dry-run unless `--apply` is passed.

## 4. Smoke test

After deploy, in a session, call:

```
self_model_query { "query": "What modules were most active this week?" }
self_model_query { "query": "Which tools have I used most?" }
```

Early on the tables will be sparse; rows accumulate as sessions run. A response of
`not_provisioned` means the volume is not writable - check the mount and
`SELF_MODEL_DB_PATH`.

---

# Self-Model (Phase 2) - Sustained Self Across Sessions

Phase 2 adds the cross-session state vector. It spans two services:
`claude-connector` (>= 12.14.0) stores and serves the vector; `gateway-service`
(>= 2.11.0) injects the `[SESSION_STATE]` block into the system prompt.

## 1. Connector code (automatic with deploy)

Ships in `claude-connector` v12.14.0. No new environment variables (reuses the
Phase 1 `SELF_MODEL_DB_PATH` / `SELF_MODEL_ENABLED`). The state vector is stored
in the existing `self_insights` table with `category='state_vector'`, so there is
no schema migration.

New tools: `self_state_write` (session close) and `self_state_read` (session
open / gateway injection).

## 2. Gateway code

Ships in `gateway-service` v2.11.0. On the first turn of each session the gateway
calls the connector tool `self_state_read` and appends a `## Session State`
block. Requires the tenant to have `connector_url` and `connector_restore_token`
set (already used by the file-module hook). No new configuration.

## 3. Volume assets (add to the two new modules)

Copy the two Phase 2 modules alongside the Phase 1 ones, and use the updated
`MANIFEST_APPEND.json` (four modules total):

```
/data/skill/ava/modules/self-model/state-vector-schema.md
/data/skill/ava/modules/self-model/cross-session-curiosity.md
/data/skill/ava/MANIFEST_APPEND.json   (now registers all four self-model modules)
```

## 4. Session protocol

- At session close, the assistant calls `self_state_write` with the qualitative
  fields that changed (active_curiosities, emotional_register,
  unresolved_questions, open_projects, relationship_position, recent_insights,
  confidence_levels_by_domain, cross_session_threads). Derived fields are filled
  automatically. This behaviour is described in the `state-vector-schema` module;
  ensure the session-close protocol in CORE prompts for it.
- At session open, the `[SESSION_STATE]` block is already present (gateway
  injected). `self_state_read` is available on demand for the full structured
  vector.

## 5. Smoke test

After both services are deployed, run one session and call `self_state_write`
near the end with a small payload, then start a new session: the first assistant
turn should have a `## Session State` block in context. Or verify directly:

```
self_state_write { "active_curiosities": [{"topic":"deploy check","score":0.5}] }
self_state_read  { "format": "block" }
```

`self_state_read` returning `[SESSION_STATE]\nNo prior session state...` means no
vector has been written yet; that is expected before the first `self_state_write`.

---

# Self-Model (Phase 3) - Initiative and Background Awareness

Phase 3 adds proactive nudges. It spans all three services: `claude-connector`
(>= 12.15.0) detects/scores/stores and serves nudges; `gateway-service`
(>= 2.12.0) delivers them; `ts-client-gateway` (>= 5.17.0) renders the panel.

## 1. Connector code (automatic with deploy)

Ships in v12.15.0. The `nudges` and `nudge_optouts` tables are created at boot by
the idempotent schema. New tools: `nudge_analyze`, `nudge_check`, `nudge_action`.
`nudge_analyze` runs the Python pipeline from `SCRIPTS_DIR` (default
`/data/skill/ava/scripts`).

## 2. Volume assets (add the Phase 3 scripts and modules)

```
/data/skill/ava/scripts/pattern_analyzer.py
/data/skill/ava/scripts/nudge_prioritizer.py
/data/skill/ava/modules/self-model/background-awareness.md
/data/skill/ava/modules/self-model/nudge-dispatch.md
/data/skill/ava/modules/self-model/silence-respect.md
/data/skill/ava/MANIFEST_APPEND.json   (now seven self-model modules)
```

## 3. Gateway and client code

- `gateway-service` v2.12.0: emits an SSE `nudge` event at session open and
  exposes `POST /ti-chat/nudge-action`. No new configuration.
- `ts-client-gateway` v5.17.0: renders the nudge panel. New `src/js/20b-nudge.js`
  and `src/css/17-nudge.css` are picked up automatically by the serve-time
  concatenation; no build step.

## 4. Session protocol

- At session close, the assistant calls `nudge_analyze` (described in the
  `background-awareness` module). Ensure the CORE session-close protocol prompts
  for it. Alternatively, schedule it after every session close.
- At session open, delivery is automatic (the gateway calls `nudge_check`).

## 5. Smoke test

Run `nudge_analyze` after some history exists, then open a new session. If a
pattern cleared the bar, a single nudge panel appears. Verify directly:

```
nudge_analyze {}
nudge_check {}
nudge_action { "nudge_id": "<id from nudge_check>", "action": "dismiss" }
```

Two dismissals of the same category permanently opt it out. An empty
`nudge_check` (no nudge) is the expected, common case - quiet is the default.

---

# Self-Model (Phase 4) - Socratic Tutor Mode

Phase 4 adds a Socratic tutor built on the Phase 1 database and Phase 2 state
vector. Connector >= 12.16.0, gateway >= 2.13.0, client >= 5.18.0.

## 1. Connector code (automatic with deploy)

Ships in v12.16.0. The `student_model` table is created at boot. New tools:
`student_model_observe`, `student_model_relate`, `socratic_seam_question`,
`student_model_read`.

## 2. Volume assets (add the Phase 4 scripts and modules)

```
/data/skill/ava/scripts/student_model.py
/data/skill/ava/scripts/seam_detection.py
/data/skill/ava/scripts/question_generation.py
/data/skill/ava/modules/self-model/socratic-tutor-architecture.md
/data/skill/ava/modules/self-model/socratic-question-dispatch.md
/data/skill/ava/MANIFEST_APPEND.json   (now nine self-model modules)
```

## 3. Gateway and client

- gateway-service v2.13.0: injects `[TUTOR_MODE: socratic]` when the client sends
  `X-Tenax-Tutor-Mode: socratic`. No new configuration.
- ts-client-gateway v5.18.0: Settings toggle (Appearance) + silence pipeline. New
  `src/js/20c-socratic.js` and `src/css/18-socratic.css` are picked up
  automatically; no build step.

## 4. Using it

- Turn on Socratic mode in Settings > Appearance. The client sends the header;
  the gateway injects the marker; the assistant uses the Socratic modules.
- Record understanding with `student_model_observe` (signal:
  mastered|confident|partial|unsure|struggled|incorrect or 0..1; source explicit
  when the recipient confirms). Mark relations with `student_model_relate`.
- Ask `socratic_seam_question` for the next question. If it returns none, teach
  normally - do not force a seam question.

## 5. Smoke test

```
student_model_observe { "concept": "functors", "signal": "mastered", "source": "explicit" }
student_model_observe { "concept": "monads", "signal": "struggled" }
student_model_relate  { "concept": "monads", "adjacent_to": "functors" }
socratic_seam_question {}
```

The last call should return an activation question connecting functors to monads.
Confidence estimates carry an uncertainty interval and decay when stale; calibrate
with explicit confirmations rather than trusting inferred reads too far.
