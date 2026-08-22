# claude-connector v13.13.0

Verified against a genuinely student-submitted worksheet. **One further defect
found, and it would have marked eight of nine correct answers wrong.**

---

## The extraction was already right

`homework_sample-1.docx` was produced by the generator and filled in by an
actual student in Word — not by a script writing runs into the XML, which was
the one input nothing in the suite could stand in for.

It parsed cleanly on the first attempt: 10 blocks, correct numbering, every
numeric answer as the bare value, and the 700-character PEEL paragraph intact
from first word to last. The v13.12.0 fixes hold on real input.

## The marking key did not

Alignment was 10 of 10. The key comparison was **1 of 9**.

The student wrote `160`. A tutor writing the spec writes `$160`. Likewise
`92 m²` against `92`, and `x = 8` against `8`. Strict comparison called all of
them wrong.

### Why the strict rule was wrong here specifically

`agrees` compares **questions**, where every distinction must survive: two
questions differing by a currency symbol are different questions, so the symbol
is preserved as a marker rather than deleted. That reasoning is still correct
and unchanged.

Answers are the opposite case. `160` and `$160` are the same answer, and a
student who omits a unit has still given the right number. **Reusing the
question rule for answers was the defect** — one rule doing two jobs with
opposite requirements.

### The new rule is still not a threshold

`answersAgree` tries the strict comparison first. Only if that fails does it
fall back to exact **numeric** equality, and only when:

- both sides reduce to exactly **one** number — a range, coordinate or line of
  working is refused, so `between 5 and 10` never matches `5`
- those numbers are equal
- any units present on **both** sides match — `5 m` never matches `5 km`

Nothing is tunable and nothing is scored by degree, so the objection to a
similarity threshold does not apply. A unit absent on one side is a presentation
omission and matches; a unit that contradicts does not.

**After the fix: 9 of 9 correct, under both key styles.** The verdict no longer
depends on how the tutor formatted the key.

### One subtlety worth recording

NFKC folds `m²` to `m2`, so an area answer carried a second "number" that was
part of the unit. `92 m²` looked like two numbers and was refused. A digit
immediately following a letter is an exponent or suffix, never a value, so it is
removed before the count — but taken from the original form when deriving the
unit, so `m²` and `m³` stay different.

---

## Tests

`npm run test:homework` — **88 passed, 0 failed, 0 skipped** (was 79).

The submitted worksheet is committed as a fixture. Both key styles are asserted
to give the same verdict, because the difference between them is the tutor's
formatting and not the student's work.

Mutation-tested. Two mutations initially **survived** — ignoring contradicting
units, and allowing multi-number answers to compare — which is exactly the
false-match direction a looser rule opens up. Tests were added for both; all
three now fail the suite, along with dropping the exponent guard.

`npm run test:voice-all` — 286 passed, unchanged.
