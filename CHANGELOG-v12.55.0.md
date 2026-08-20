# v12.55.0 — Kokoro prosody preprocessor (SPEC-KOKORO-001 Phase 2, part 1)

**This release changes no behaviour.** It adds two modules the engine swap needs
and wires neither of them into the synthesis path. TTS still runs on Piper,
unchanged, and every existing test still passes untouched.

That is deliberate. The Piper→Kokoro swap is atomic — half a swap is a mute
platform — so the parts that can be built and proven without a model are landed
first, separately, while the system stays working.

## What is in this release

**`src/voice/voice-prosody-prep.js`** — the Section 6 preprocessor. A pure text
transform: normalise, flatten the author's markdown links, convert dialogue
beats to punctuation, optionally tag emphasis and pronunciation, then shape the
contour. Returns a result object rather than a bare string so the decisions it
made are inspectable instead of inferred.

**`src/voice/voice-text-normalize.js`** — gains a `beatMarker` option. Default
unchanged.

## The finding that shapes the whole module

**Section 4's markup is a misaki feature, not a Kokoro one.**
`[Kokoro](/kˈOkəɹO/)` and `[word](+2)` are parsed by the misaki G2P library,
which is what the Hugging Face Space runs. `kokoro-onnx` phonemises with its own
tokenizer built on `phonemizer`/espeak-ng, which has no markdown handling at
all.

Hand espeak `[best](+2)` and it pronounces the brackets and the digits. **The
markup does not degrade to plain — it degrades to worse than plain**, because
the listener hears "plus two" in the middle of a sentence.

So every markup rule is gated on which G2P is actually in use, and the gate
defaults to `espeak`, because that is what a bare `pip install kokoro-onnx`
gives you and because guessing wrong in that direction costs a missing hint
rather than a spoken bracket. `emphasis: true` on the espeak path emits nothing
and records `emphasis_needs_misaki_g2p` so an admin can see why.

Even on the misaki path, treat Section 4.2 as a hint rather than a lever:
several independent reports describe `(+2)` as producing no audible change, one
describes a slight effect on `kokoro >= 0.9.2`.

## Section 6.2 could not be implemented as written

The mandated order is normalise first, preprocessor second. Taken literally that
makes Section 6.1's third rule — inject dialogue beats as commas or ellipses
rather than spaces — **impossible**, because by the time the preprocessor runs,
v12.54.3's normaliser has already replaced the quote pair with a plain space.
`word”“word` and `word word` are then indistinguishable and the beat is gone.

Fixed by making the beat replacement a parameter. The Kokoro path passes a
sentinel (U+0001: cannot occur in prose, is not whitespace so the whitespace
collapse cannot eat it, and is not in Kokoro's phoneme vocabulary so a leak
would be dropped rather than voiced), and the preprocessor rewrites it to
punctuation.

**The default is unchanged** — a single space, exactly as v12.54.3 behaved — so
every existing caller and the Piper path are unaffected. An empty or non-string
marker falls back to the space rather than deleting the beat.

## Three defects found and fixed during implementation

**A doubled comma on the commonest dialogue shape.** The real shape is
`audit,”“Honestly`, where the closing quote follows a comma the author already
wrote. The first draft appended its own beat, giving `audit,, Honestly` — and
Kokoro reads a doubled comma as two beats, so the reply stumbles exactly where
it was supposed to breathe. Where the author's punctuation is already there, it
*is* the beat.

**A markdown-link hazard that would read URLs aloud.** On the misaki path
`[docs](https://x.io/a)` is indistinguishable from a pronunciation override:
misaki reads the parenthesised half as a phoneme string and pronounces the URL
as garbage. Assistant replies contain markdown links routinely. Pre-existing
links are now flattened to their label *before* any override of ours is
injected — the reverse order would strip our own markup. A URL with no label
drops entirely rather than being spelled out.

**A suppression notice that fired on all traffic.** The first draft reported
suppression based on *capability* rather than *occurrence*, so every espeak
utterance carried a notice whether or not it contained any emphasis. A warning
that fires on all traffic is one an admin learns to ignore, which costs the
warning its only purpose. It now fires only when bold is actually present, or a
lexicon term genuinely appears.

## Design decisions worth knowing

**Emphasis is sourced from `**bold**`.** Section 6.1 rule 4 says to tag "where
the assistant intends prominence" without saying how intent is detected. Bold is
the only signal in assistant output that actually means it; inferring prominence
from sentence position or word class would be inventing intent rather than
reading it. Multi-word bold is not tagged, because misaki's stress syntax
attaches to one token and `[three whole words](+2)` parses as a pronunciation
override with `+2` as the phoneme string — the spoken-bracket failure by another
route. Asterisks are stripped on the espeak path unconditionally, emphasis on or
off, because espeak reads them.

**Contour shaping needs a position hint.** Rule 2 asks for terminal punctuation
for declarative contour, commas for continuation rises, and ellipsis for
trailing pauses — different marks for the same chunk depending on where it sits,
which a chunk cannot know about itself. It matters because the prosody layer
synthesises each phrase separately: a mid-sentence phrase with no final
punctuation lands flat, and the same phrase given a full stop makes the sentence
audibly break in the middle. Callers pass `whole`, `final` or `continuation`.
Punctuation the author wrote always wins.

**The pronunciation lexicon is empty by default.** A wrong phoneme string is a
confidently mispronounced brand name, which is worse than the mispronunciation
it was meant to fix, and nothing here can validate an IPA string. Entries
containing `/`, `[`, `]` or `(` are refused, because they would break out of
their own markup and corrupt the rest of the utterance. A term is tagged once
per chunk, not on every mention — repeating it makes the voice sound like it is
spelling the word out.

## Tests

New file `src/tests/voice-prosody-prep.test.js`, 34 tests. Registered as
`npm run test:prosody-prep` and added to `test:voice-all`.

The most important assertions here are **negative**: that no markup escapes onto
the espeak path, across a broad corpus and every option combination. A missing
emphasis hint is an absent improvement; a spoken bracket is a broken voice.

**Mutation-tested**, three failure modes:

| Mutation | Result |
| --- | --- |
| Assume every G2P parses markup (leak to espeak) | 30 passed, **4 failed** |
| Stack the beat on existing punctuation | 33 passed, **1 failed** |
| Leave the author's markdown links in place | 28 passed, **6 failed** |

## Verification performed

- New suite: **34 passed, 0 failed**.
- `npm run test:voice-all`: **253 passed, 0 failed** (219 before, +34).
- The 24 existing normaliser tests pass **untouched**, which is the evidence
  that `beatMarker` is genuinely back-compatible.
- No file in the synthesis path was modified other than the additive
  `beatMarker` parameter, so Piper TTS is bit-for-bit unchanged.

## Not verified, and cannot be here

Nothing in this release has been run against Kokoro. There is no model, no
`kokoro-onnx`, and no espeak in CI. What is verified is that the transform
produces the strings the specification calls for; whether Kokoro *sounds* right
given those strings is a listening check at deploy.

The `(+2)` stress control in particular is unproven — see above.

## Next

Phase 1/3/5 in one release, because the swap is atomic: `kokoro_worker.py`,
`kokoro-worker-supervisor.js`, the voice registry seeded with af_bella (default),
af_nicole, af_heart, bf_emma and af_aoede, the 24/16 kHz switch, per-tenant voice
resolution, Piper deletion, and `TTS_LANGUAGES` dropping to `['en']`.

Then the gateway and client admin surface for tenant voice selection.

## Rollback

Delete the two new files and revert the `beatMarker` parameter. Nothing calls
either one yet.
