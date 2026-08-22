# claude-connector v13.16.0

Verified against `homework-render.md` and `ref-homework-render-spec.md`. **Two
defects found, one of them capable of dropping half a paper.**

The spec documents turned out to be more useful than the missing JSON would have
been: they are the ground truth for how a key is written and how questions are
numbered, and my logic disagreed with both.

---

## 1. Per-section numbering dropped half the paper

`ref-homework-render-spec` defines a question's `number` as **"Question number
within the section"**. The registry flattens to a running position across the
whole set. On a single-section worksheet the two coincide — which is why this
was invisible: the bundled `homework_test_spec.json` numbers globally 1..25, so
every round-trip test passed while this was broken.

On a multi-section worksheet with per-section numbering, section two's `1`
collided with section one's, was flagged a duplicate and dropped:

```
before:  {"total":4,"matched":2,"missing":2}   duplicates: [1,2]
after:   {"total":4,"matched":4,"missing":0}   duplicates: []
```

**A fully answered paper reported half unanswered.**

### How it is resolved

The document is self-describing enough. Numbering that never decreases is
global and is used directly. Numbering that restarts is per-section, and a
block's position is its number plus the questions in every prior section.

Section headings are now *recorded* rather than merely skipped, so each block
knows which section it belongs to.

The offset uses the **highest number seen** in each prior section, not the count
of blocks found, so a gap in the middle of a section is absorbed — the number
carries it.

### The residual limitation, asserted rather than hoped about

A question skipped at the very **end** of a section is invisible in the
document, and shifts every following section by one.

What matters is that it fails safely: the shifted question's text no longer
agrees with the registry, so the gate reports a mismatch and refuses to mark it.
The answer is never scored against the wrong question; a human is asked instead.
There is a test that pins exactly this.

## 2. A labelled key marked the more complete answer wrong

The reference spec's own example key is `"answer": "Area = 12 cm2"`. Only a
single-letter label was stripped, so `x = 8` worked and `Area = 12 cm2` did not
— the key's unit came out as `areacm2`.

The result was perverse:

| student wrote | before | after |
|---|---|---|
| `12` | correct | correct |
| `12 cm2` | **wrong** | correct |

A student who included the units — the more complete answer — scored worse than
one who omitted them. Labels of any length are now stripped, and the value and
unit are still both checked: `14 cm2` and `12 m2` remain wrong.

---

## Tests

`npm run test:homework` — **100 passed, 0 failed, 0 skipped** (was 95).

Written before the fixes again: three of the new tests failed against the old
code. Mutation-tested four ways — ignoring section restarts fails 2, offsetting
by block count fails 1, reverting the label strip fails 1, and over-eager label
stripping fails 6.

Two existing tests needed correcting rather than the code:

- one asserted whole-object equality on a parsed block, which broke when
  `section` was added; now asserted field by field
- one expected `missing` for an end-of-section skip, where the real behaviour is
  `mismatch` — the safer outcome, and my expectation was wrong rather than the
  code

The real student sample still scores **10/10 aligned, 9/9 keys correct**.

`npm run test:voice-all` — 286 passed, unchanged.

---

## Still open

**The `answer` field is required for every question**, including written ones —
`homework-render.md` §4 states it plainly. So "no answer key" does not identify
a writing question, and the gateway's `needs_tutor_review` branch keys on
exactly that.

For the PEEL question in the real sample, the key would be a model paragraph.
Comparing it to a student's paragraph will almost always fail, which routes the
question to a tutor — the correct destination, reached by the wrong reasoning,
and only because the leniency routing exists.

That is safe but not right, and the fix belongs on the gateway: a writing
question needs to be identified by the shape of its key (prose rather than a
comparable value) rather than by its absence. Flagged rather than patched here,
because it changes what the marking prompt asks for.
