# claude-connector v13.10.0

Round-trip closure between generation and upload parsing. No behaviour change;
this release is the test that proves the two halves agree.

---

## The gap this closes

Every existing test in this area starts from a document and asks whether the
reader copes. None asked the question that matters in production:

> A worksheet this system GENERATED, filled in and handed back unaltered, must
> align perfectly against the registry rows written from the same spec.

If that round trip does not close, nothing else matters. A student who changes
nothing and submits gets mismatches, and the tutor is sent to investigate a
wording discrepancy the system introduced itself.

**It closes: 5 of 5 questions match**, including the awkward ones chosen to
break it — a price with a currency symbol, a thousands separator and a decimal
(`A jacket costs $1,234.50`), a fraction, and a colon-formatted time
(`A train leaves at 09:15`). Both of those carry digits followed by punctuation
that the question-start pattern could have mistaken for numbering; if it had,
the question would split in half and fail the gate.

## The convention is pinned, not inferred

`homework_render.py` resolves from a mounted volume rather than this repository,
so this suite cannot run it. What it can do is pin the layout convention the
reader depends on in one named place and prove the reader honours it:

- the question number leads the line, because that is the key alignment uses —
  a number anywhere else is question *content*
- the question is complete on its line, because a wrapped question is otherwise
  indistinguishable from a question followed by an answer

That makes the coupling explicit rather than accidental. If the generator's
layout ever changes, this test fails and names the mismatch, instead of a
student's homework silently failing to align in production.

## Two layouts, deliberately

Paragraphs and a two-column table (Question | Your answer) both round-trip. The
table is the one structured alternative worth supporting: the reader already
handles cells and it gives a cleaner "type here" affordance — but only while
answers stay short. A question asking for working needs room a cell does not
give, and paragraphs win the moment that happens. Both are pinned so the
generator can use either.

Not text boxes. Alignment keys on the question number in the extracted text, so
a number on its own line binds an answer as firmly as any container could. A box
adds visual bounding and no parseable structure, its content sits outside the
paragraph and table path, it does not auto-expand so working gets clipped, and
Google Docs and mobile Word both handle it poorly. The review document is
assembled from the parsed text anyway, so whatever the box provided dies at
extraction.

---

## Tests

`npm run test:homework` — **68 passed, 0 failed, 0 skipped** (was 62).

`npm run test:voice-all` — 286 passed, unchanged.
