# claude-connector v13.40.0

**Work order WO-2026-11-21-01 (vault OCR correction, ingest ordering and
pre-approved reading continuation), section B.5: chapter-heading detection
widened, with a rejection rule. The connector half.**

Built on 13.39.0. Companion: Gateway-Service 2.367.0, which holds sections A,
B and D. Deploy in either order. The gateway's sequence check does not depend
on this connector; it gets cleaner boundaries from it.

Only books ingested from now on are affected. No stored book is re-extracted.
A re-ingest still needs Brian's instruction for each title.

## What changed (`scripts/book_extract.py`)

### More heading forms are explicit

The patterns ranked above bare numerals now also take:
- `DIVISION` / `Division` and `SECTION` / `Section` with a number or number
  word;
- a section sign and a number;
- a standalone ALL-CAPS line.

`STRONG_PATTERNS` moves from 4 to 6.

There is also a new weak rule, ranked with the bare numerals: a short
title-case line, followed by a blank line and a body paragraph of at least
300 characters.

### The rejection rule (B.5)

A candidate is refused, with the reason recorded, when it:
- ends in a colon and a numeral or superscript (`colon_then_numeral`; the
  Being and Time "divisions:1" case);
- carries a footnote marker glued to a word (`footnote_marker`);
- continues the previous line's sentence (`sentence_continuation`);
- repeats more than three times (`running_header`);
- is also found in the endnotes (`in_endnotes`).

`heading_report` and `choose_chapters` both read the same `candidate_marks`,
so the report shows exactly the boundaries that the split uses.

## Files

| File | Change |
|---|---|
| `scripts/book_extract.py` | patterns, `heading_rejection`, `title_case_heading`, `candidate_marks`, `is_strong` |
| `src/tests/book-extract-headings.test.js` | new: 5 tests |
| `scripts/verify-module-files-mutations.mjs` | B-6 and B.5 heading mutations; the copy includes `scripts/` |
| `package.json` | 13.40.0; `test:book-extract-headings` (CRLF kept) |
| `CHANGELOG-v13.40.0.md`, `DELIVERY-v13.40.0.json` | new |

## Verification

- Full suite: 63 files and 1,323 executed before; 64 files and 1,328
  executed after. The 5 added cases are the new file. Net-new failures: 0. The
  65 baseline-red failures are carried unchanged.
- Mutations: 75 of 75 red.
