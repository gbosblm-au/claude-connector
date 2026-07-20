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

---

# Tutor (Phase 5) - Understanding Check + Assessed Homework

Phase 5a is client-only (ts-client-gateway v5.19.0); Phase 5b is connector-only
(claude-connector v12.17.0). The gateway is unchanged.

## Phase 5a (client)

New `src/js/09b-understanding-check.js` and `src/css/19-understanding-check.css`
are picked up automatically by serve-time concatenation; no build step. The
overlay sends bracketed directives ([STUDENT_UNDERSTANDS], [STUDENT_EXPLAIN_MORE],
[STUDENT_IDLE]) as chat messages, handled like the existing homework directives.

## Phase 5b (connector)

1. Deploy v12.17.0 (adds the `homework_assess_render` tool).
2. Add the script to the volume:
   `/data/skill/ava/scripts/homework_assessment.py`
3. Install reportlab on the volume's Python (see
   `/data/skill/ava/scripts/requirements.txt`): `pip install "reportlab>=4,<5"`.
4. Deploy the updated `MANIFEST_APPEND.json` (now ten modules) and the new module
   `modules/self-model/understanding-check-homework.md`.

### Smoke test

```
homework_assess_render {
  "homework_slug": "week-3", "student_name": "Mila", "student_age": 12,
  "questions": [
    {"number":1,"concept":"Author's tone","question":"Why the scare quotes?","correct_answer":"sarcasm","student_answer":"sarcasm"},
    {"number":2,"concept":"Border geometry","question":"inner area?","correct_answer":"176","student_answer":"300","assessment":"incorrect","comment":"Subtract 2w per side first."}
  ]
}
```

Returns a score summary and a base64 PDF. Deliver the PDF as the permanent record.

---

# Self-Model (Phase 6) - SQLite to Postgres Migration

Moves the self-model store from the connector's ephemeral SQLite volume to Postgres
on the gateway, under a `self_model` schema. Gateway >= 2.14.0, connector >= 12.18.0.
The migration is staged (dual-write) and non-breaking; SQLite stays the source of
truth until cutover.

## Gateway (v2.14.0)

- The `self_model` schema (12 tables) is created automatically at boot by initDb.
- The Self-Model API mounts at `/ti-self-model` (8 endpoints, rate limited 60/min).
- No new configuration. For local/CI without SSL, set `PGSSL=disable`.

## Connector (v12.18.0)

Set these on the connector to enable dual-write (leave unset to stay SQLite-only):

```
GATEWAY_URL=https://<gateway-host>
GATEWAY_API_KEY=<service token accepted by the JWT routes>
SELF_MODEL_DUAL_WRITE=1
SELF_MODEL_QUEUE_PATH=/data/self-model-queue.jsonl   # optional
```

- With dual-write on, state writes mirror to `/ti-self-model/state` best-effort;
  SQLite remains authoritative.
- `self_model_gateway.py` is the client for the Python paths (student model,
  nudges, insights) and provides queue + flush_queue for batch resilience.

## Rollout (dual-write, each stage >= 7 days)

1. Schema + dual-write: Postgres writes run in parallel; reads stay on SQLite.
2. Read switch: reads prefer Postgres, fall back to SQLite; writes still dual.
3. Remove SQLite writes: Postgres only for writes; SQLite read fallback retained.
4. Cutover: reads fully on Postgres; drop SQLite. Verify row counts via
   `GET /ti-self-model/admin/stats` before each transition.

Rollback at any stage: re-enable the SQLite read path, verify with a row-count
check, switch reads back. Dual-write means both stores stay complete.

## Admin dashboard (Self-Model tab)

The five views are downstream consumers of the delivered API:
- System Health -> `GET /admin/stats` (row counts, last-write, migration status).
- Module Activation -> `POST /query {intent: module_activation_summary}`.
- Session Patterns -> `POST /query {intent: session_overview}`.
- Tool Usage -> `POST /query {intent: tool_usage_summary}`.
- Nudges -> `GET /nudge` + `POST /nudge {action: dismiss|snooze}`.

---

# Self-Model (Phase 6 cont.) - Script wiring and the dual-write rollout runbook

Gateway >= 2.15.0, connector >= 12.19.0. All connector self-model scripts now honour
the rollout flags; with no flags set they behave exactly as before (Stage 0, SQLite
only).

## Rollout flags (connector env)

| Flag                             | Default | Meaning                                   |
|----------------------------------|---------|-------------------------------------------|
| SELF_MODEL_DUAL_WRITE            | off     | also write the gateway (Postgres)         |
| SELF_MODEL_READ_POSTGRES         | off     | read Postgres first (SQLite fallback)     |
| SELF_MODEL_SQLITE_WRITE          | 1       | write SQLite (set 0 to stop at Stage 3)   |
| SELF_MODEL_SQLITE_READ_FALLBACK  | 1       | allow SQLite read fallback (0 at Stage 4) |

Also required when dual-write is on: GATEWAY_URL and GATEWAY_API_KEY.

## Stages (each held >= 7 days; verify with GET /ti-self-model/admin/stats)

Stage 1 - Schema + dual-write
  SELF_MODEL_DUAL_WRITE=1
  Postgres writes run in parallel; reads stay on SQLite. Confirm row counts grow
  in Postgres and match SQLite.

Stage 2 - Read switch
  SELF_MODEL_DUAL_WRITE=1, SELF_MODEL_READ_POSTGRES=1
  Reads prefer Postgres and fall back to SQLite. The seam pipeline hydrates the
  model and topic rows from Postgres. Watch for read errors; the fallback masks
  them but they should be zero before proceeding.

Stage 3 - Remove SQLite writes
  SELF_MODEL_DUAL_WRITE=1, SELF_MODEL_READ_POSTGRES=1, SELF_MODEL_SQLITE_WRITE=0
  Postgres is authoritative. Mutations hydrate from Postgres, compute with the
  same logic, and persist back to Postgres. SQLite is frozen but still readable
  as a safety net.

Stage 4 - Cutover
  add SELF_MODEL_SQLITE_READ_FALLBACK=0
  Reads come only from Postgres. Once stable, the SQLite volume can be retired.

Rollback: at any stage, set SELF_MODEL_READ_POSTGRES=0 and SELF_MODEL_SQLITE_WRITE=1
to return to SQLite authority. Because dual-write keeps both stores current through
Stage 2, rollback to Stage 1/2 is lossless. After Stage 3 (SQLite frozen), roll back
by replaying from Postgres or accepting the gap since freeze.

## What each script does under the flags

- student_model.py - observe/relate/decay mirror changed concepts to the gateway
  (Stages 1-2) or compute against a Postgres-hydrated in-memory DB and push back
  (Stages 3-4). dump reads the preferred source.
- seam_detection.py - reads the model and topics from the preferred source; writes
  detected seams to the gateway when dual-write is on.
- question_generation.py - reads the preferred source for the --next pipeline.
- nudge_prioritizer.py - mirrors newly inserted nudges to the gateway.
- recorder.js (closeSession) - mirrors the session's log, module activations, tool
  usage, and topic clusters to /ti-self-model/ingest.

## Note on the queue

Batch/CLI writes that fail while the gateway is briefly unreachable are appended to
SELF_MODEL_QUEUE_PATH by the Python client and replayed by flush_queue(). Schedule a
periodic flush (or call it at connector start) so transient gateway outages during
the rollout do not drop Postgres writes.
