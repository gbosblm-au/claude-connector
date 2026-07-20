# CHANGELOG - claude-connector

## 12.19.0 - Phase 6 (cont.): scripts wired to the gateway; staged rollout

Wires the remaining self-model scripts to the gateway client and adds the
flag-driven dual-write rollout. Everything is inert by default (no env flags =
Stage 0 = on-disk SQLite only, exactly as before).

### New

- scripts/store.py: hydrates an in-memory SQLite from the gateway so the tested
  Bayesian student-model and seam logic runs unchanged when Postgres becomes
  authoritative (Stages 3-4), plus mirror_concepts() and load_model() helpers.
- self_model_gateway.py:
  - Rollout class reading SELF_MODEL_DUAL_WRITE, SELF_MODEL_READ_POSTGRES,
    SELF_MODEL_SQLITE_WRITE, SELF_MODEL_SQLITE_READ_FALLBACK, exposing the current
    stage (0-4) and routing questions.
  - Write methods upsert_student_model, insert_seams, create_nudge,
    ingest_session; read methods read_student_model, read_topic_rows, read_seams;
    and lossless mapping helpers between the SQLite model and the gateway
    projection.

### Changed (all env-gated; Stage 0 behaviour identical to before)

- student_model.py: observe/relate/decay mirror changed concepts to the gateway
  when dual-write is on; at Stages 3-4 they hydrate from Postgres, run the same
  pure functions, and push results back. dump reads from the preferred source.
  Output now carries a rollout meta block.
- seam_detection.py / question_generation.py: when the read switch is on they
  hydrate the model and topics from Postgres (SQLite fallback unless disabled);
  seam_detection also mirrors detected seams to the gateway.
- nudge_prioritizer.py: newly inserted nudges are mirrored to the gateway.
- src/tools-self-model/recorder.js: closeSession mirrors the session's rows
  (log, module activations, tool usage, topic clusters) to /ti-self-model/ingest.
  Fire and forget, fully guarded.

### Compatibility

- Additive and inert by default. No new runtime dependencies (stdlib only).
  Requires gateway >= 2.15.0 for the write endpoints.

### Verification performed

- Staged rollout executed against a live gateway + real Postgres:
  - Stage 1 (dual-write): observe writes SQLite and mirrors to Postgres.
  - Stage 2 (read switch): with the SQLite file removed, the seam pipeline reads
    the model + topics from Postgres and still produces the correct question.
  - Stage 3 (remove SQLite write): observe hydrates from Postgres, updates
    Postgres, and leaves a stale SQLite row untouched (0.99 unchanged; Postgres
    rose).
  - Stage 4 (cutover): reads come from Postgres; with the gateway down and
    fallback disabled the pipeline errors rather than silently using SQLite.
  - Nudge dual-write: a qualifying candidate inserts to SQLite and mirrors to
    Postgres (pending nudge visible via GET /nudge).
- Regression: Phase 1 + 2 unit suites 14/14; the Stage-0 seam pipeline is
  unchanged; all scripts py_compile.
