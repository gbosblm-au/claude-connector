# CHANGELOG - claude-connector

## 12.16.0 - Phase 4: Socratic Tutor Mode

Adds a Socratic tutor: a cross-session student model, a seam-detection engine, a
seam-targeting question generator, and the maieutic/silence discipline. Builds on
the Phase 1 self-model database and the Phase 2 state vector. Spans all three
services; gateway-service >= 2.13.0 and ts-client-gateway >= 5.18.0 provide the
mode hint and the UI.

### New

- **Schema** (`schema.sql`): `student_model` table (concept, confidence with a
  lower/upper uncertainty interval, observations, source, domain, seam_scores
  JSON, first_seen, last_updated), created idempotently at boot.

- **Python pipeline** (`self-model/volume-assets/skill/ava/scripts/`, stdlib only):
  - `student_model.py` - build/update/decay. Confidence updates are Bayesian
    (explicit confirmations weigh more than inferred reads); uncertainty shrinks
    with evidence; stale low-confidence estimates decay toward a neutral prior
    faster than established ones. Records symmetric adjacency/conflict relations.
  - `seam_detection.py` - five seam detectors (activation, boundary,
    contradiction, transfer, reflective), each mapping to one question type.
    Adjacency from explicit hints and topic co-occurrence. A naturalness floor
    excludes concepts with too little evidence.
  - `question_generation.py` - renders a seam into a question of the correct
    type, applies a naturalness filter, and via `--next` runs the whole pipeline
    to emit one question (or none).

- **Tools** (`src/tools/socraticTools.js`), registered in both entrypoints:
  `student_model_observe`, `student_model_relate`, `socratic_seam_question`,
  `student_model_read`.

- **Modules**: `socratic-tutor-architecture.md`, `socratic-question-dispatch.md`.
  `MANIFEST_APPEND.json` now nine self-model modules with a `socratic-tutor` tag
  web.

### Changed

- No changes to Phase 1/2/3 behaviour. The new table and tools are additive.

### Compatibility

- No breaking changes. No new npm dependencies. Python scripts are stdlib only.

### Verification performed

- `node --check` on all new/modified JS across the three services; Python
  `py_compile`; schema applies with the new table.
- Regression: Phase 1 + 2 unit suites still 14/14.
- Seam -> question integration test (the spec's Phase 4 test): a seeded student
  model produced all five seam types, each mapped to and rendered its correct
  question type; the naturalness floor excluded a single-observation concept; the
  pipeline returned the highest-scoring question.
- Connector tool test (JS spawning Python against a real database):
  observe/relate/seam-question/read round-trip; an activation seam was generated
  from a strong adjacent plus a weak target.
- `MANIFEST_APPEND.json` merges cleanly; Phase 4 module triggers fire.
