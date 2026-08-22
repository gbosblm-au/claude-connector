# claude-connector v13.7.0

Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6 (upload
parsing and the agreement gate), Section 12 (extras, gaps, duplicates).

Built as JavaScript in this repository rather than as a Python script on the
mounted volume. The spec asks for "a deterministic script on the connector";
this is deterministic, on the connector, and uses no model — and unlike a volume
artefact it ships in this zip, runs in CI, and can be tested.

**Still not here:** the upload route, the gateway's parallel assessment workers
(step 4) and review-document assembly.

---

## New: `src/homework/docx-text.js`

A dependency-free `.docx` reader. A docx is a zip containing
`word/document.xml`, and Node ships raw inflate in `zlib`, so the whole reader
is a central-directory walk plus an XML-to-text pass — small enough to audit
when a student's upload misbehaves. Adding `mammoth` for this would pull in an
HTML converter and a style mapper that this path never uses.

### Three decisions that came from how Word actually writes files

**Runs concatenate with no separator.** Word splits a single typed word across
several `<w:t>` elements whenever formatting or spell-check state changes
mid-word, so `18/24` can arrive as three elements. Joining with a space would
produce `18 / 24` and the gate would reject a question the student copied
perfectly. There is a fixture built specifically to split runs mid-token.

**The central directory is authoritative, not the local header.** A local
header's size fields can be zeroed when an entry was written with a streaming
data descriptor, which Word does for some parts. Trusting them yields an empty
document and no error at all. The local header's *own* name and extra lengths
are still read, because zip writers pad the local extra field for alignment and
using the central values reads from the wrong offset.

**`&amp;` is unescaped last.** Reversed, `&amp;lt;` decodes to `&lt;` and then
to `<`, inventing markup that was never in the document.

A non-docx is refused with a reason rather than parsed into empty text. Reading
a PDF as a blank document would report the student as having answered nothing.

## New: `src/homework/homework-extract.js`

Block parsing and registry alignment, both pure.

### Alignment is by question number, never by order

Zipping the registry against the blocks found in the document fails on the most
common thing a student does: skip one.

A student who omits Question 2 shifts every later block up. Zipping then pairs
Q3's answer with Q2's question text — and because the gate compares the uploaded
question against the registry, the mismatch is caught for *every remaining
question in the paper*. The student is told six questions failed when they
skipped one.

Aligning on the number the student wrote confines the damage to the question
actually affected. Verified with a real fixture: a skipped Q2 leaves Q3
`exact_match`.

### The rule this module enforces

Its output is never "here is what the student wrote". It is "here is what the
student wrote, and whether we are permitted to mark it". `assessable()` returns
only `exact_match` rows; a caller that dispatches anything else has defeated the
feature.

An altered question is quarantined with its answer recorded for the tutor — the
19 July failure in miniature, caught.

---

## Tests

`npm run test:homework` — **45 passed, 0 failed, 0 skipped** (19 normalisation
from v13.6.0, 26 new).

Fixtures are built by **python-docx at test time**, not hand-written XML. The
defects this reader must survive are the ones Word actually produces, and
hand-rolled XML reproduces none of them because it is written by someone who
already knows what the parser expects. If python-docx is unavailable the docx
tests **skip rather than pass** — a silent pass on a missing fixture would
report that extraction works when nothing was extracted.

Mutation-tested six ways. Aligning by order fails 2; letting `assessable`
admit mismatches fails 3; joining runs with a space fails 2; unescaping `&amp;`
first fails 1; deleting the table-cell rule fails 1.

### Two mutations survived, and both taught something

**The `<w:delText>` strip is redundant.** The run regex matches `<w:t\b`, which
`<w:delText>` does not satisfy, so deleted text is never captured even without
that line. No test can distinguish the two. It is kept and now labelled as
redundant: one line, guarding a severe failure if the run regex is ever
broadened to tolerate a namespace prefix, at which point tracked deletions would
flow into marked answers with nothing to stop them.

**The table-cell rule looked redundant but is not.** python-docx always wraps
cell text in a `<w:p>`, so the paragraph rule alone separated the cells and the
fixture could not tell the difference — deleting the cell rule left every
generated-fixture test green. Real documents are less tidy: content controls and
some export pipelines emit runs directly inside `<w:tc>`. A test was added
against that XML directly, and deleting the rule now fails it.

The general lesson, which cost two investigations: a fixture generated by a
tidy library exercises the tidy path only, and a rule that only matters on
untidy input needs a test written against that input directly.

### Regression

`npm run test:voice-all` — 286 passed, 0 failed, unchanged.
