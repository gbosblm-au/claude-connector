# claude-connector v13.11.0

The answer key is now compared, not judged.

---

## What changed

`POST /homework/parse-upload` accepts an optional `answer_key` per question and
returns `key_match` per row:

- `true` — correct, by exact equality after normalisation
- `false` — incorrect, by the same comparison
- `null` — no key, so correctness is a judgement rather than a comparison

## Why this matters more than it looks

The key was in the registry from the first release, written at generation time
from the spec's own `answer` field. It was being handed to the marker as
"MARKING GUIDANCE" — a model was being asked to judge whether 36 equals 36.

For a question with a right answer, a normalised comparison is strictly better
than a model's judgement: it cannot be wrong, it does not vary between runs, and
it removes a model from the critical path on exactly the questions where a wrong
mark is least defensible. A model is now reserved for free-text and working
questions, which is what it is actually for.

The comparison runs through the **same normaliser as the agreement gate**, so a
student writing `36.00`, `$1,234.50` or a curly apostrophe has given the right
answer. A raw string comparison would mark all three wrong and the student would
have no way to tell why.

## The guard that matters

`key_match` is only computed for a question that **passed the agreement gate**.
Comparing an answer to the key of a question the student demonstrably did not
answer would produce a confident mark for the wrong question — the 19 July
failure with a deterministic veneer.

---

## Tests

`npm run test:homework` — **71 passed, 0 failed, 0 skipped**.

Mutation-tested: comparing the key on a failed gate fails 1; using raw string
equality instead of the normaliser fails 1.

`npm run test:voice-all` — 286 passed, unchanged.
