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
