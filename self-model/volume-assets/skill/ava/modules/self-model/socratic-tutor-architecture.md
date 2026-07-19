# Socratic Tutor Architecture

Standard tutoring transfers knowledge: present a concept, check comprehension.
Socratic tutoring transforms it: surface the productive tension already latent in
what the recipient knows, and ask the question that makes the edge of their
understanding visible to them. The aim is not to fill a gap but to create the
conditions under which they notice the gap exists. This is the maieutic method:
midwifing understanding rather than delivering it.

## The pieces

- **Student model** (`student_model` table + `student_model.py`): a cross-session
  map of what the recipient understands, partially understands, and hasn't
  engaged. Each concept carries a confidence estimate with an uncertainty
  interval and an evidence count. Confidence updates are Bayesian: an explicit
  confirmation weighs more than an inferred read, and stale low-confidence
  estimates decay toward a neutral prior faster than well-established ones.
- **Seam detection** (`seam_detection.py`): finds seams, not gaps. A gap is a
  missing concept. A seam is a place where known sits against unknown so a
  question can make the boundary felt. Five detectors, each mapping to one
  question type.
- **Question generation** (`question_generation.py`): renders a seam into a
  question that targets it, then applies a naturalness filter. If nothing passes,
  no question is produced.

## The five seams and their questions

1. **Activation** - a near-unknown concept with a strong adjacent one. Surface
   the adjacent knowledge first.
2. **Boundary** - partial understanding. Push on the edge case.
3. **Contradiction** - two confident beliefs that can't both hold. Name the
   tension.
4. **Transfer** - strong grasp of A that should extend to adjacent B but hasn't.
   Ask them to carry it over.
5. **Reflective** - a concept revisited many times without resolving. Turn the
   question on the pattern itself.

## Confidence, honestly

The student model is an estimate built from limited evidence, not a measurement.
It carries an uncertainty interval for a reason. Calibrate it with explicit
checks ("did that land, or is it still fuzzy?") rather than trusting inferred
reads too far, and let low-confidence estimates decay. When the model is thin,
detection stays quiet rather than inventing a seam.

## How to drive it

- Record observations with `student_model_observe` as understanding is
  demonstrated or confirmed. Use `student_model_relate` to mark adjacency and
  conflicts.
- Ask `socratic_seam_question` for the next question. If it returns none, that is
  a valid answer: teach normally or stay with the current thread.
- The delivery discipline - especially silence - lives in the companion module
  `socratic-question-dispatch`. Read them together.
