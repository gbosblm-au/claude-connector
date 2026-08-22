# claude-connector v13.14.0

The question/answer strictness split, written into the source as a named
invariant, plus the three false-match edge cases tested against the real
normaliser.

---

## The invariant

`homework-normalise.js` now opens with it, because a changelog paragraph is not
where this belongs:

> **Two comparisons, opposite strictness. Do not unify them.**
>
> `agrees` compares QUESTIONS at maximum strictness — two questions differing by
> a currency symbol are different questions, and erasing that lets an answer be
> marked against a question the student never answered.
>
> `answersAgree` compares ANSWERS and is deliberately looser — `160` and `$160`
> are the same answer, and strictness here protects no one; it just marks
> correct work wrong.
>
> The failure directions are opposite too. On a question, a false match is the
> catastrophe. On an answer, a false miss is the common harm.

Collapsing the two has already happened once and marked a flawless paper 1 of 9.
A test now asserts they remain distinct functions **and** still disagree on the
case that separates them, so one cannot silently become the other.

`answersAgree` is built on `agrees` and can only ever be more permissive, so
tightening the question rule tightens both. The reverse is not true.

## The three false-match edge cases, tested rather than reasoned about

`5 m` never matching `5 km` is the easy case — the units are different words and
a normaliser has no reason to touch them. The hard cases differ by a
superscript, a sign, or a trailing zero, which are precisely the marks a
formatting normaliser exists to erase.

| case | result |
|---|---|
| `92 m²` vs `92 m` | **no match** — a superscript unit is a different unit |
| `8` vs `-8` | **no match** — the sign is part of the value |
| `2.4` vs `2.40` | **match** — a trailing zero is not |

All three already held; all three are now pinned.

## The known false misses are recorded, not tolerated silently

The numeric fallback shrinks the surface and does not close it. These are
asserted as *current behaviour*, so a future change that fixes one fails here
and gets noticed rather than quietly widening the comparison:

- `thirty-six` vs `36` — reduces to no numbers, so no fallback applies
- `2 hours 24 minutes` vs `2.4` — two numbers against one
- `160 dollars` vs `$160` — **does** rescue, via the absent-unit rule, and is
  pinned so a later tightening does not lose it

The first two are why a key miss now routes to a tutor when the model says the
answer looks right, rather than publishing a zero. See gateway v2.122.0.

---

## Tests

`npm run test:homework` — **91 passed, 0 failed, 0 skipped**.
`npm run test:voice-all` — 286 passed, unchanged.

## Still provisional

The keys that produced the 1-of-9 collapse were reconstructed by solving the
worksheet, not read from the spec JSON that generated it. The unit finding
survives regardless — the student wrote bare numbers and any plausible key
format reproduces it — but **the fix exists so the verdict does not depend on
how a tutor formatted the key, and reconstructed keys only prove it works on
keys I imagined.** This finding is provisional until the real spec JSON for
`homework_sample-1.docx` is checked.
