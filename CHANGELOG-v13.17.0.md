# claude-connector v13.17.0

Writing-Question Assessment Spec v1.0.0 — the connector half: R1, R2, R4.

---

## R1/R2 — writing questions are ineligible by structure

`question_type` (`standard` | `writing`, defaulting to `standard`) now flows
from the spec to the registry to this layer, and a writing question is **never
key-compared**.

The previous arrangement routed writing to review only because comparing a model
paragraph against a student paragraph reliably failed. That is a side effect,
not a design, and it fails in the dangerous direction: a student whose writing
closely resembled the model — or that the normaliser collapsed — would have
received a deterministic binary mark on an essay with no review at all.

There is a test where the student's answer is **byte-identical** to the model
paragraph. Under the old arrangement it would have been marked correct outright;
it now returns `key_match: null`.

`answer` remains required on every question (`homework-render.md` §4). For a
writing question it is reference material, not a match target — which is exactly
why its presence could never have identified one.

## R4 — a blank is a zero only when the blank is verified

"The student answered nothing" is a verdict, and this layer has produced it
wrongly three times: the meta line, the section heading and the decimal
false-positive each caused it on a fully answered paper.

Rows now carry `blank_state`:

- **verified** — the question was located, its text agreed, and the answer
  region under it was empty. The student saw it and left it.
- **ambiguous** — the question was never found, or it sits at a section edge
  where a skipped predecessor shifts what follows invisibly.

The section-edge rule applies only to sections that **have** a following
section. A skip at the end of the last section shifts nothing, so the final
question of a paper is an ordinary verified blank — treating it as ambiguous
would send every unanswered final question to a human for no reason, which is
how a review queue stops being read.

No `PEEL_WRITING` sentinel existed here to retire.

---

## Tests

`npm run test:homework` — **105 passed, 0 failed, 0 skipped** (was 100).
`npm run test:voice-all` — 286 passed, unchanged.

Mutation-tested: allowing a writing question to be key-compared fails the suite.

One expectation of mine was wrong rather than the code: I asserted a
single-section paper's last question was a verified blank, and the first
implementation called it ambiguous. The code was over-broad and was narrowed.

---

## The spec JSON question is closed

Earlier releases marked the `homework_sample-1.docx` finding provisional because
its keys were reconstructed rather than read from the spec that generated it.

`ref-homework-render-spec.md` closes it, and better than a single sample would
have. The concern was never that one file's keys were unknown — it was that the
verdict must not depend on how a tutor formats a key. The reference document
**defines** that format, and its own worked example is `"answer": "Area = 12
cm2"` — which found a real defect: only single-letter labels were stripped, so a
student writing `12 cm2` was marked wrong while one writing `12` was marked
right.

A sample would have given one instance of the format. The reference gives the
format itself, and it is now tested against directly. **No longer provisional.**
