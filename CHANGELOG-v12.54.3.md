# v12.54.3 — Strip typographic artifacts from TTS input

Implements VOICE-TTS-NORMALIZE-v1.0. **Connector only.** No gateway, plugin or
UI change, exactly as Section 8 scopes it. No migration, no config, no new
environment variable.

## The defect

Piper's phonemiser is handed raw text. Typographic quote characters are not
punctuation to it: depending on voice and context they are either voiced as a
glyph or absorbed into the neighbouring word and mis-stressed. A reply
containing `“Hello,” she said` could be read with the quotes audible.

## The change

New file `src/voice/voice-text-normalize.js`, exporting `normalizeForSpeech()`
and `isSpeakable()`. A pure string transform: it spawns nothing, reads nothing
and holds no state, so importing it cannot change the behaviour of any path by
accident, and every rule is testable without Piper installed.

| Class | Code points | Handling |
| --- | --- | --- |
| Smart quotes | U+2018 U+2019 U+201C U+201D | Stripped, **except** intra-word (see below) |
| Guillemets | U+00AB U+00BB U+2039 U+203A | Stripped |
| Low-9 / single-high | U+201A U+201B U+201E U+201F | Stripped |
| Zero-width / format | U+200B U+200C U+200D U+2060 U+FEFF U+00AD | Deleted, no replacement |
| ASCII `"` | — | Stripped |
| ASCII `'` | — | Kept inside a word, stripped as a delimiter |

## Insertion point

`synthesizePcm()` in `voice-engines.js`, which is **the** choke point. The flat
path calls it once for the whole reply, the prosody layer once per phrase, and
both the resident Piper worker and the CLI spawn sit downstream of it.
Normalising there rather than at either engine is what makes the transform
uniform, and is why the worker path cannot quietly keep speaking glyphs after
the CLI path stopped. A test asserts that ordering rather than assuming it.

The empty check now runs on the **normalised** text. Text that is nothing but
typography has no speech in it, and the caller's handling of `empty_text` is
already the right answer for that.

## Deviation from the specification, stated plainly

**Section 3 lists U+2019 as stripped. Section 5 forbids producing misspelled
words. On the most common case in the corpus, those two rules contradict each
other.**

U+2019 is the RIGHT SINGLE QUOTATION MARK, and it is also the character Word,
iOS, macOS and essentially every language model emit for an apostrophe. In this
pipeline `don’t` is far more common than `don't`. Stripping U+2019
unconditionally yields `dont`, `its`, `Brians` — precisely the misspellings
Section 5 exists to prevent, reached by obeying Section 3.

So U+2018 and U+2019 are resolved **by position rather than by identity**:

- Between two letters it is an apostrophe. Converted to ASCII `'`, which
  Section 5 states the phonemiser handles correctly.
- Anywhere else it is a delimiter. Stripped, as Section 3 requires.

`don’t` → `don't`. `‘quoted’` → `quoted`. Both sections are satisfied; neither
is satisfiable alone.

This is a judgement about the specification, not an implementation of it. If
the intent really was to strip U+2019 everywhere, say so and it is a one-line
change — but the acceptance test in Section 7 would then fail on
`everyone’s`.

## Two smaller judgements

**The no-merging invariant beats the letter of Rule 4.** Section 4 says a lone
quote boundary is deleted, and an adjacent closing/opening pair becomes one
space. It also states, as an invariant, that consecutive deletions must not
merge two adjacent words. For `word"word` those disagree: the first rule
produces `wordword`, the second forbids it.

The invariant wins, generalised: a run of delimiter quotes becomes one space
when it is **followed by a word character and preceded by anything that is not
whitespace**. Both halves of that test earn their place. "Followed by a word"
is what makes the space necessary — otherwise `hi".` becomes `hi .`. "Preceded
by non-whitespace" is what makes it safe — otherwise `word" "word` doubles an
existing space.

That formulation also fixes a case a word-character-on-both-sides test gets
silently wrong. The real shape of the dialogue beat is `audit,”“Honestly`,
where the closing quote follows a **comma**, not a letter. Requiring a word
character on both sides deletes both quotes and welds the clauses into
`audit,Honestly`. This rule yields `audit, Honestly`.

**Whitespace collapse is horizontal only.** Section 6 defaults to a global
collapse. Done globally over all whitespace that folds newlines away too, and
`prosody.js` splits paragraphs on blank lines — so on the flat path, where the
whole reply passes through in one piece, a global collapse would silently
change how a multi-paragraph reply is segmented. Runs of spaces and tabs
collapse to one space; line structure is left as it was. This meets Section 6's
stated purpose without reaching outside it.

## One thing the specification did not anticipate

`analyse()` merges fragments shorter than `minPhraseChars` backwards into their
predecessor, and a quote-only fragment has a bare length of zero, so it is
almost always absorbed. Almost: the merge needs a predecessor, so a quote-only
fragment landing **first** in its sentence survives as a phrase of its own.

Before this release that phrase synthesised to a moment of nothing and nobody
noticed. After it, the phrase normalises to an empty string, `synthesizePcm`
raises `empty_text`, and `empty_text` is on the route's not-worth-retrying list
— so it is rethrown rather than falling back to flat. **One stray quote would
have answered the whole request with a 422.**

`speakablePhrases()` removes such phrases before synthesis in both
`synthesizeProsody` and `synthesizeProsodyStream`. The pause the dropped phrase
was carrying is folded into the phrase before it (or into the first phrase kept,
when the drop was leading), so the rhythm the analysis computed survives the
removal rather than shortening. The input array is not mutated, because
`analysis.phrases` is returned to the route and reported in the summary.

Filtering happens **before** the degenerate-case check, so a reply whose every
phrase was typography falls into the same flat path as one the segmenter never
split, and raises `empty_text` once about the whole reply rather than from a
phrase worker mid-render. That distinction matters most on the streaming route,
where the status line has already been sent and the only channel left is an
in-band error line.

## Tests

New file `src/tests/voice-text-normalize.test.js`, 24 tests. Registered as
`npm run test:normalize` and added to `test:voice-all`.

Coverage includes: every listed code point in five positions; zero-width
controls not splitting words; ASCII and typographic apostrophe protection;
delimiter stripping; the pair-becomes-a-space rule; the no-merging invariant
across all three character classes; horizontal-only whitespace collapse;
idempotence; never throwing on non-string input; **ordinary prose returned
untouched** (the most important negative test — a transform that fires on text
it should not touch is a regression on every reply); the Section 7 acceptance
case; the insertion-point assertions; and the phrase-filter pause arithmetic.

**Mutation-tested**, three separate regressions:

| Mutation | Result |
| --- | --- |
| Remove the intra-word apostrophe repair (obey Section 3 literally) | 21 passed, **3 failed** |
| Always delete quote runs, never insert the beat space | 21 passed, **3 failed** |
| Un-wire the normaliser from `synthesizePcm` | 23 passed, **1 failed** |

The suite catches the bug in each case rather than merely agreeing with the
code.

Structural assertions run against a comment-stripped copy of
`voice-engines.js`. That file explains its own rules in prose that names the
functions involved, and a regex over raw text matches the explanation rather
than the code.

## Verification performed

- New suite: **24 passed, 0 failed**.
- Existing voice suites (`voice`, `voice-auth`, `voice-prosody`,
  `voice-gpl-boundary`, `voice-stt-worker`): **195 passed, 0 failed**, identical
  to the pre-change baseline measured by restoring the unmodified
  `voice-engines.js` from the v12.54.2 archive and re-running the same five
  files.
- `npm run test:voice-all`: **219 passed, 0 failed**.
- The GPL boundary suite passes unchanged: the normaliser is imported as an ES
  module into Node, never handed to the Piper process, so the process boundary
  is untouched.
- `package.json` bumped to 12.54.3; `package-lock.json` aligned, no dependency
  resolution changed.

## What is NOT covered

These tests cannot prove the premise — that Piper voices a smart quote rather
than ignoring it. That was established by ear before the specification was
written. What is verifiable here is that no such character reaches the engine
and that the characters which must survive do.

The Section 7 acceptance criterion has two halves. "No quote artifact" is
asserted mechanically. "The dialogue beat is audible" needs an ear against a
real voice, and is a listening check at deploy, not a CI gate.

## Rollback

Revert `src/voice/voice-engines.js`; `voice-text-normalize.js` becomes an
unimported file and can be left in place. Nothing else depends on it, and no
state, schema or config was introduced.
