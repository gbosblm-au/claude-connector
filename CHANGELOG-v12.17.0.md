# CHANGELOG - claude-connector

## 12.17.0 - Phase 5b: Assessed Homework PDF Render

Adds formal marked-homework rendering. Given a student's answers and the model
answers, the connector assesses each answer and produces a colour-coded PDF with a
per-page score badge, tone-calibrated comments, and a results summary.

### New

- **Script** (`self-model/volume-assets/skill/ava/scripts/homework_assessment.py`,
  reportlab): answer matching (auto or caller-supplied), tone calibration by age
  (warm / moderate / formal / professional, default 11-13), drawn vector markers
  in the spec colours (correct #2E7D32, partial #E65100, incorrect #C62828) that
  render without an emoji font, a score badge on every page, and a footer summary
  with strong (star) and focus (book) areas. Handles the three triggers (file
  upload, in-session, session reconstruction) via a shared questions array, with a
  text-answer extractor for Trigger A.
- **Tool** (`src/tools/homeworkTools.js`) `homework_assess_render`, registered in
  both entrypoints: assembles the answer set, renders the PDF, returns the score
  summary plus the PDF as base64 for delivery.
- **Module** `understanding-check-homework.md`: how to honour the Phase 5a
  overlay directives ([STUDENT_UNDERSTANDS], [STUDENT_EXPLAIN_MORE],
  [STUDENT_IDLE]) and how to assemble and render assessed homework. Registered in
  `MANIFEST_APPEND.json` (now ten self-model modules, new `tutoring` tag web).
- **Dependency**: `scripts/requirements.txt` documents `reportlab>=4,<5` for the
  volume (Phases 1-4 remain standard-library only).

### Compatibility

- Additive. No breaking changes. Phase 1-4 tools and behaviour unchanged. Only new
  runtime dependency is reportlab, needed by the Phase 5b script.

### Verification performed

- `node --check` on all new/modified JS; Python `py_compile`.
- Sample renders: the 7-question reading/maths set and a 12-question mixed set
  produced valid multi-page PDFs (%PDF header + EOF, badge on every page). Score
  math verified (correct = 1, partial = 0.5; e.g. 4 correct + 4 partial = 6/12,
  50%). Tone bands verified across ages 9/12/15/20 and unknown.
- Connector tool test (JS spawning Python): assessed a mixed answer set and
  returned a valid base64 PDF with the expected score and filename.
- Regression: Phase 1 + 2 unit suites still 14/14; MANIFEST triggers fire for
  Phase 5 phrases.
