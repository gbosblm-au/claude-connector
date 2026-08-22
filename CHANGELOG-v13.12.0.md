# claude-connector v13.12.0

Verified end to end against the real generator. **Four defects found, each of
which marked a correct paper wrong.**

---

## What the verification did

`homework_docx_build.build_docx()` was run against the generator's own
`homework_test_spec.json` to produce a genuine 25-question worksheet, which was
then filled with the spec's own answer key and put through the full reader →
alignment → key-comparison path.

**Result before the fixes: 23 of 23 keyed answers scored WRONG on a perfect
paper.**

The whole point of a deterministic key comparison is that it cannot be wrong. It
was wrong on every question, because the text being compared was never the
student's answer.

## The four defects

**1. The per-question meta line was read as the answer.** The generator writes
`[2 pts]  ~1m 30s` into its own paragraph after every question. The question
ends in punctuation, so everything after it is answer text — and every answer
arrived as `"[2 pts]  ~1m 30s 1/2"` instead of `"1/2"`.

**2. Section headings were absorbed.** `Number Patterns  [Core]` sits between
the last answer of one section and the first question of the next, unnumbered,
so it became the tail of the previous answer. The last question of every section
scored wrong.

**3. A question ending in data swallowed its answer.** "What is the rule for
this pattern? 2, 6, 18, 54, 162" has no terminal punctuation at the end of the
line, so the wrap heuristic treated the student's answer as a continuation of
the question. Three questions were reported unanswered on a fully answered
paper.

**4. A decimal answer parsed as a question number.** `2.4 hours` became question
2 with the text "4 hours" — a phantom twenty-sixth question, and the real
question 25 reported unanswered.

## The fixes

The meta line is now a **positive signal** rather than only noise: the generator
emits one after every question, so its presence ends the question with certainty
instead of by inference. That is what fixes defect 3, and it is a better rule
than the punctuation heuristic it supersedes.

Section headings are matched two ways — the five difficulties
`homework_common.DIFFICULTY_COLORS` defines, and any short bracketed token
preceded by *two* spaces, because the renderer accepts an arbitrary difficulty
string. The two-space requirement keeps the looser form safe: a student writing
an answer that ends in a bracket writes one space before it, not two.

The question-number separator now requires trailing whitespace, which is exactly
what distinguishes `1. ` from `2.4`. The cost is that `1.Text` with no space is
no longer recognised — an acceptable trade, because a missed question is
reported as unanswered while a phantom one silently consumes a real answer.

**After the fixes: 25 of 25 matched, 25 of 25 keys correct, no extras.**

---

## A test that proved nothing has been replaced

`homework-roundtrip.test.js` rendered a worksheet to a layout convention I had
written down, then proved the reader agreed with it. **Both sides came from me,
so it could only ever pass.** It reported closure while the real generator
produced something quite different.

`homework-real-worksheet.test.js` uses committed fixtures built by the real
builder: a blank worksheet and the same worksheet filled with the spec's answer
key. It asserts a perfect paper scores 25/25, that a blank one marks nothing,
and it pins each of the four defects individually.

It also asserts the generator's layout markers are still present in the
extracted text — so if the generator stops emitting them, this test says so
rather than the reader silently depending on something that has gone.

## Tests

`npm run test:homework` — **79 passed, 0 failed, 0 skipped** (was 71).

Mutation-tested: removing the meta-line skip fails 6, the heading skip fails 3,
the meta-as-boundary rule fails 2, the decimal guard fails 2.

`npm run test:voice-all` — 286 passed, unchanged.
