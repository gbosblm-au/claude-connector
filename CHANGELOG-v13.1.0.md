# v13.1.0 — The prosody preprocessor was never wired in

**This is a defect release, and the defect is mine.** v12.55.0 built the Section 6
preprocessor and wired it into nothing, deliberately, because the engine swap was
not ready. The v13.0.0 swap never wired it either. So through v13.0.2 the module
had 34 passing tests and was **dead code**.

## What was actually broken

`voice-prosody-prep.js` was referenced only in comments. `synthesizePcm()` called
`normalizeForSpeech()` directly, which is stage ONE of a five-stage pipeline.
Stages two through five never ran:

| Section 6.1 rule | Status through v13.0.2 |
| --- | --- |
| 1. Normalise typographic artifacts | **worked** (v12.54.3, wired separately) |
| 2. Contour shaping by position | inert |
| 3. Dialogue beats as punctuation | inert |
| 4. Emphasis tagging | inert |
| 5. Pronunciation lexicon | inert |

Plus the markdown-link flattening, which is not a numbered rule but is the one
with teeth: `[the docs](https://tenax.io/a)` reached the engine intact.

**Browser traffic was protected by accident.** The client reads `innerText` from
rendered HTML, so markdown is already resolved to plain text before it is sent.
Direct callers of `POST /voice/synthesize` — the gateway relays whatever it is
given — had no such protection, and would have had URLs read aloud.

Every test in `voice-prosody-prep.test.js` tested the transform. **None of them
could see that nobody called it.** New assertions now can, and reverting to the
exact v13.0.2 wiring fails three of them.

## What now reaches the engine

espeak path, emphasis configured on:

| Input | Before (v13.0.2) | Now |
| --- | --- | --- |
| `See [the docs](https://tenax.io/a) now` | *unchanged, URL spoken* | `See the docs now.` |
| `The **audit** is the real cost` | *asterisks intact* | `The audit is the real cost.` |
| `audit,”“Honestly, no.` | `audit, Honestly, no.` | `audit, Honestly, no.` |
| `The real cost is the audit` | *no terminal contour* | `The real cost is the audit.` |
| mid-sentence phrase | *no contour* | `The real cost,` |

Phrase position is supplied by both prosody paths. Without it every phrase
defaults to `whole` and gets a full stop, so one sentence audibly breaks into
several — worse than the flatness rule 2 exists to fix.

## Your emphasis decision, resolved

The decision was **on by default**. It could not be honoured as written, and the
final state never said what shipped. It now says so explicitly, in three places.

**Configured on. Ineffective on the espeak path. Reported as such.**

`[word](+2)` is a misaki construct. kokoro-onnx's tokenizer is
phonemizer/espeak-ng and has no markdown parsing, so emitting the markup would
have the assistant say *"best plus two"* out loud. The preprocessor therefore
emits nothing on that path and records `emphasis_needs_misaki_g2p`.

`/voice/status` now reports both halves:

```json
"emphasis": { "configured": true, "effective": false, "requires": "misaki" }
```

Reporting only `configured` makes the switch look broken. Reporting only
`effective` hides that an operator asked for something. Same shape for the
lexicon. `VOICE_TTS_EMPHASIS=false` turns it off outright; setting
`VOICE_KOKORO_G2P=misaki` makes it real.

Temper expectations even then: several independent reports describe `(+2)` as
producing no audible change, one describes a slight effect.

## The G2P ceiling, stated where it belongs

**This is the point the specification should have carried and did not.**

The Hugging Face Space that demonstrates Kokoro runs **misaki**. This connector
runs kokoro-onnx, whose front end is **espeak-ng — the same grapheme-to-phoneme
class Piper used.**

The acoustic model is a large step up. **The front end is not.** The difference
is audible on proper nouns, initialisms, brand names and anything out of
dictionary — exactly the words a business assistant says most. So the realism
gain over Piper is real but **narrower than the Space implies**, and an operator
comparing them by ear would otherwise conclude the model underdelivered when what
they are hearing is the phonemiser.

`/voice/status` now names the running front end (`prosody.g2p`) so this is read
off a health endpoint rather than discovered on first listen.

Closing the gap means adopting misaki: a spacy/nltk dependency, and its espeak
fallback reintroduces the GPL-3.0 dependency unless disabled — at which point
out-of-dictionary words have no pronunciation at all. That is a real trade, and
it is now a documented one rather than an implicit default.

## Tests

`voice-prosody-prep.test.js` goes from 34 to 40; suite total **243 → 249**.

The six new ones assert the *wiring*, which is the class of defect that shipped:
that the engine imports and calls the preprocessor, that the bare normaliser is
**not** called at the choke point instead, that both prosody paths supply a
position, that emphasis defaults on and is switchable, that status reports
configured and effective separately, and that a malformed lexicon is ignored
rather than thrown.

**Mutation-tested:** restoring the exact v13.0.2 wiring fails three; dropping the
position hint fails one.

## Verification performed

- Voice suites: **249 passed, 0 failed**.
- Whole connector: **605 of 606**, the one failure being the pre-existing
  `render-tools > download contract`.
- Pipeline output verified by execution on both G2P paths.
- `prosodyState()` verified under three configurations: espeak default, misaki,
  and emphasis disabled.

## New environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `VOICE_TTS_EMPHASIS` | `true` | Tag `**bold**` as stress. Needs misaki. |
| `VOICE_TTS_LEXICON` | `{}` | JSON map of word to phonemes. Needs misaki. |

`VOICE_KOKORO_G2P` (`espeak` \| `misaki`) already existed and now has visible
consequences.

## Compatibility

No gateway or client change. Audio **will** change: replies now get terminal
punctuation where they had none, and phrases are contoured. That is the Section 6
behaviour the release exists to deliver, and it is the reason to listen before
opening it up.
