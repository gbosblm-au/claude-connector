# claude-connector v13.15.0

A false match found by pulling on one sentence in the last changelog.

---

## The claim that did not hold

v13.14.0 said `160 dollars` matched `$160` "via the absent-unit rule". But
`160 dollars` is not absent-unit — it carries the word. For that rescue to have
fired, something had to be dropping or flattening a currency.

Running the discriminating test showed the asymmetry was real, and in the
opposite direction from the obvious guess:

| comparison | before |
|---|---|
| `160 dollars` vs `160 pounds` | no match — **words distinguished correctly** |
| `$160` vs `£160` | **MATCH** — symbols all flattened to one marker |
| `160 dollars` vs `£160` | **MATCH** — the word had a unit, the symbol had none |
| `agrees('Pay $5', 'Pay £5')` | **true** — in the QUESTION gate |

Currency words were preserved and compared properly. Currency symbols were all
folded to a single `cur` marker, which was then stripped when deriving the unit
— so any symbol-prefixed amount became unit-less and matched any other currency
through the absent-unit rule.

**The question gate was affected too**, which is the catastrophic direction: two
questions differing only by currency compared equal, so an answer could be
marked against a question the student never answered.

## The fix

Each symbol now maps to its own token (`$` → `curusd`, `£` → `curgbp`, and so
on), and the token is **kept** as the unit rather than stripped. Currency words
map to the same tokens, so `160 dollars` and `$160` still agree — now because
they are the same currency, not because one lost its unit.

### `pounds` is deliberately left out of the lexicon

It is mass as well as currency and nothing in an answer string resolves which.
Mapping it would make `5 pounds` of flour match `£5` — a false match, the silent
direction. Left as its own unit, `£5` against `5 pounds` is a false **miss**,
which the tutor-review routing exists to catch. Erring toward the visible
failure is the discipline of this module, and the choice is pinned by a test so
it is not "fixed" later.

## A test that encoded the defect

`currency symbols fold to one marker rather than vanishing` asserted the broken
behaviour as intended. Its original insight was right — a symbol must become a
marker rather than vanish, or `$5` and `5` become the same question — and only
the collapsing of *different* currencies was wrong. Rewritten rather than
deleted.

## An ordering trap worth recording

The lexicon must run **before** number canonicalisation. `NUMBER`'s character
class includes a space, so `160 dollars` canonicalises to `160dollars`, and the
`\b` before `dollars` then has no boundary to anchor to. Run afterwards, the
lexicon silently never fires — which is exactly what happened on the first
attempt, and the symptom was indistinguishable from not having written it.

---

## Tests

`npm run test:homework` — **95 passed, 0 failed, 0 skipped**.

Written **before** the fix, per the discipline agreed last turn: three of the
four new tests failed against the old code, which is what a tightening test is
for. Mutation-tested four ways — re-flattening the symbols fails 5, re-stripping
the token from the unit fails 2, mapping `pounds` fails 1, and running the
lexicon after the number rule fails 2.

The real student sample still scores **10/10 aligned, 9/9 keys correct**.

`npm run test:voice-all` — 286 passed, unchanged.

## Still provisional

The keys for `homework_sample-1.docx` remain reconstructed rather than read from
the spec JSON that generated it. Unchanged from v13.14.0, and still the one
open closure.
