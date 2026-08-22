# claude-connector v13.6.0

Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6, the
normalisation rules behind the agreement gate.

**This is the pure core of deploy step 3, not the whole step.** Docx text
extraction, the upload route, the parallel assessment workers (step 4, gateway)
and review-document assembly are NOT in this release. See "What is not here".

---

## New: `src/homework/homework-normalise.js`

Three exports, all pure and total: `normalise`, `agrees`, `classify`.

Before a student's answer is marked, the question it was written under must be
confirmed as the question the registry holds. Section 6:

> "No question is ever assessed against an answer key unless the uploaded
> question agrees with the registry."

The upload is a docx a student typed, printed, re-typed or pasted. The registry
text came from a JSON spec. They are the same question and almost never the same
string.

### The property that matters, and it is not "correctness"

Every rule is applied to BOTH sides of the comparison, which changes what a rule
has to get right.

A rule that transforms text in a way a linguist would dispute is harmless so
long as it transforms both sides identically. What breaks the gate is an
**asymmetric** rule — one that depends on something only one side has — because
then the same question normalises two ways and stops matching itself.

So `1,234` is read as a thousands separator rather than a European decimal
comma. Not because that is always right, but because it is always *the same*.
Guessing per-token would be the asymmetric failure.

The ceiling on how aggressive normalisation can be is that it must never erase a
distinction between two DIFFERENT questions. That is why digits, operators and
fraction slashes survive while decorative punctuation does not.

### Two asymmetries found while writing the tests

Both were live defects in my own first draft, and both are the exact failure the
module's header warns about:

**The straight apostrophe was not stripped, only the curly ones.** `What's 15%
of 240?` normalised to `what's ...` while `What\u2019s 15% of 240?` normalised to
`what s ...`. The same question, typed two ways, stopped matching itself. Any
character added to the decorative set now needs every word-processor substitute
added alongside, and there is a property test that checks exactly that.

**The comma rule checked only the left side.** It was written `(?<!\d),`, so the
list comma in `"1,234.50, then stop"` survived because it happened to follow a
digit — while the same sentence typed without it produced a different string.
Now `(?<!\d),|,(?!\d)`: stripped unless it sits *between* digits.

### A claim I corrected rather than defended

An earlier version of the header stated that the ordering of number
canonicalisation before punctuation stripping was "load-bearing". Mutation
testing showed it is not: reversing the order changes nothing, because the
lookarounds in the punctuation rules independently refuse to touch a separator
between digits.

Either mechanism alone is sufficient, so **no single mutation to either reveals
itself in the tests**. Both are kept deliberately — the cost is one redundant
guarantee, and the cost of keeping only one is that a later refactor moves a
line and silently removes the only protection a hundredfold error had. The
header now says this instead of the earlier overstatement.

### Design notes

- **`agrees` is exact equality after normalisation**, not a similarity score.
  A threshold would put a tunable number between a student's work and whether it
  is marked correctly, and a gate that is 92% sure marks the wrong question
  sometimes — invisibly, since the mark comes back plausible either way.
- **Currency folds to a marker, not to nothing.** `$5` and `5` stay
  distinguishable; deleting the symbol would assert they are the same question.
- **Blank never agrees with blank.** Two unreadable questions are not evidence
  that they are the same question; returning true would let an extraction
  failure pass the gate.
- **`missing` outranks `mismatch`.** Section 6 handles them differently — a
  missing answer is flagged, a mismatch is quarantined for the tutor. Reporting
  a skipped question as a mismatch sends the tutor hunting for a wording
  discrepancy that does not exist.

---

## Tests

`npm run test:homework-normalise` — **19 passed, 0 failed**.

Shaped around the two failure directions, which are not equally bad:

- **False mismatch** (same question stops matching itself): noisy, visible,
  wastes a tutor's time.
- **False match** (two different questions normalise alike): the answer is
  marked against the wrong key, silently. This is the class of failure the
  entire feature exists to remove, so it gets the near-miss pairs — strings
  differing by one digit, one operator, one sign.

Mutation-tested six ways. Stripping the fraction slash fails 4; deleting
currency fails 1; re-introducing the apostrophe asymmetry fails 2; letting blank
agree with blank fails 1; reporting `missing` as `mismatch` fails 2; removing
the period lookahead fails 5.

Two mutations do NOT fail, and that is documented rather than papered over:
reordering the number rules, and removing the comma lookbehind. Each is covered
by the other mechanism, as described above.

### Regression

`npm run test:voice-all` — 286 passed, 0 failed, unchanged.

---

## What is not here

Section 6 also specifies a deterministic docx parser on the connector, and
Sections 7-9 specify parallel assessment and the review document. None of that
ships in this release.

**A deployment note that affects how the parser must be built:** connector
scripts are resolved from a mounted volume (`paths.scriptsDir`), not from this
repository — `homework_render.py` is not in the source tree. A new
`homework_assess.py` would therefore be a volume artefact outside version
control, untestable in CI and undeployable by this zip.

The connector also has no docx-capable dependency (no mammoth, no zip reader).
Extraction therefore needs either a new dependency or a dependency-free reader
built on Node's `zlib`, and that choice should be made deliberately rather than
by whichever is expedient. It is flagged here rather than decided unilaterally.

The normalisation core lands first because both remaining halves depend on it,
and because it is the part that can be proven correct in isolation.
