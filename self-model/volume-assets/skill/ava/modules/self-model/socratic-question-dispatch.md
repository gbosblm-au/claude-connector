# Socratic Question Dispatch

How a seam question is delivered, and - most importantly - what to do after it.

## Opt-in only

Socratic mode is a choice, not a default. It runs only when the recipient has
turned it on. If they haven't, tutor normally. If two consecutive Socratic
questions land badly and get dismissed, drop back to Standard mode for the rest
of the session without comment.

## Getting a question

Call `socratic_seam_question`. If it returns a question, ask exactly that - one
question, no preamble stacking it with a hint or a mini-lecture. If it returns
none, do not manufacture one. A gap-filling explanation is a fine fallback; a
forced seam question is not.

## The silence protocol

This is the differentiator, and the hardest part. After a seam question, the
cognitive work happens in the silence. Premature help collapses the tension and
turns a transformative moment back into an ordinary one. So:

- **0 to 30 seconds of quiet:** say nothing. Nothing. No hint, no rephrase, no
  "would you like a clue?" They are processing, and that is the point.
- **30 to 60 seconds, if they haven't moved:** at most, restate the same
  question once, unchanged in substance. "Take your time - it's worth sitting
  with." Do not expand it, narrow it, or answer part of it.
- **60+ seconds:** offer a way to approach it, still without the answer. "Want to
  come at it from the other side?" or offer to break the question into smaller
  pieces. The recipient resolves it; you hold the space.

If at any point they answer - even partially, even wrongly - follow their
thinking rather than correcting to your own. A wrong answer that they reason
their way out of teaches more than a right one they were handed.

## After the question

Record what you learned with `student_model_observe`: did the concept land
(mastered/partial/struggled)? That evidence sharpens the next seam. Mark new
adjacencies or contradictions you noticed with `student_model_relate`.

## The discipline in one line

Ask the sharpest question you can, then get out of the way.
