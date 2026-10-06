# claude-connector v13.34.0

SPEC-AUDIO-003 rev 1 (2026-10-05): Kokoro stays the base engine with
segmenting as a base function so no speech is dropped (W1), and ElevenLabs is
added as an optional per-user engine on the user's own account and key (W3).
Built on the 13.32.0 baseline. **13.33.0 is skipped on purpose**: that number
belongs to the parked register-layer build (SPEC-AUDIO-003 Section 10), and
reusing it would give two different archives one version.

Deploy order: this connector FIRST, then ts-gateway-service 2.248.0 (which
forwards the ElevenLabs configuration), then ts-client-gateway 5.230.0 (which
stops trimming long replies). Each step is safe on its own: an older gateway
never sends the new field, and an older client still trims.

## Changed files

| File | Change |
|---|---|
| `src/voice/voice-engines.js` | W1: `segmentForSynthesis`, `assertFullRender`, `speakableCharCount`; `synthesizePcm` cuts over-long stretches and checks every rendering's duration; the engine call moved unchanged into `renderPreparedPcm`. W3: per-phrase ElevenLabs rendering with one-way fallback in `synthesizeProsodyStream`; new `synthesizeElevenLabs` for the buffered route. |
| `src/voice/elevenlabs.js` | **new.** The ElevenLabs adapter: config validation, `POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000|pcm_16000`, `previous_text`/`next_text`, one retry on 5xx, error map 401→invalid_key, 402/429→quota, else→error. |
| `src/routes/voice.js` | W1: the 5,000-character refusal is replaced by a named anti-abuse ceiling of 100,000 (`maxTtsChars`), body limit 2 MB, short renders name their segment. W3: the three synthesis routes accept `elevenlabs` from the gateway and report the engine (`X-Tenax-Voice-Engine`, `X-Tenax-Voice-Fallback`, in-band `engine_fallback` lines, `engine` on end lines). |
| `src/tests/voice-segmenting.test.js` | **new.** S1 to S5, against the real synthesis path and a fake Kokoro interpreter. |
| `src/tests/voice-elevenlabs.test.js` | **new.** E1, E4, E5, E6, E8 and the reply budget, against the real routes, a fake ElevenLabs service and the fake Kokoro. |
| `src/tests/voice-elevenlabs-race.test.js` | **new.** The voice-changes-once rule with four phrase runners (the pool width is read at import, so it needs its own process). |
| `src/tests/fixtures/fake-kokoro-once.mjs` | **new.** Reproduces kokoro-onnx 0.4.9's silent truncation for the tests. |
| `src/tests/voice-incremental.test.js` | The test that pinned the 5,000 refusal is rewritten to the new contract (accepted past 5,000; refused, named, past 100,000). Mock gains `synthesizeElevenLabs`. |
| `package.json` | 13.32.0 → 13.34.0; `test:segmenting`, `test:elevenlabs`; both added to `test:voice-all`. |
| `VOICE-DEPLOYMENT-VARIABLES.md` | New variables documented. |

## W1: no dropped audio

**The drop, verified in the pinned dependency.** kokoro-onnx 0.4.9
(`requirements-kokoro.txt`) splits a phoneme string only at `. , ! ? ;`, then
`Kokoro._create_audio` cuts any batch over `MAX_PHONEME_LENGTH = 510` with only
`log.warning("Phonemes are too long, truncating ...")` and returns success. A
stretch with none of those characters (a markdown bullet list, a long
unpunctuated clause) came back as complete-looking audio with its tail missing.

**The fix, at the choke point every route reaches.** `synthesizePcm` now cuts
the prepared text so no piece holds a stretch over `VOICE_TTS_MAX_RUN_CHARS`
(350) and no piece is over `VOICE_TTS_SEGMENT_CHARS` (5,000), renders the
pieces in order, and joins them with the existing 5 ms edge fades. Every input
within both bounds (every input the baseline rendered correctly) takes the
pre-change path unchanged: one engine call, same arguments, same bytes (S4).
Misaki markup is never cut. A single token over the bound is cut hard rather
than truncated.

**The refusal is gone.** `VOICE_MAX_TTS_CHARS` defaulted to 5,000 and refused
longer replies with 413 on synthesize, stream, incremental and analyse. The
default is now 100,000 (about two hours of speech), still named when it fires,
and an override is accepted only between 5,000 and 500,000 so a carried-over old
value cannot reinstate the drop.

**Short renders raise.** Every rendering is checked against a loose duration
floor (`VOICE_SHORT_RENDER_MAX_CPS` 40 letters a second at length_scale 1,
scaled by speed; skipped under `VOICE_SHORT_RENDER_MIN_CHARS` 60). A rendering
below it raises `tts_short_render` naming its segment, and the prosody paths
name the phrase. The buffered route answers 500 with that message; the stream
routes send it as the in-band error line. Silence is never emitted in its place.

## W3: ElevenLabs per user

Reached only when the gateway forwards `elevenlabs: { api_key, voice_id,
model_id }` for a user whose switch is on. Absent field, nothing new runs (D7):
the requests of every other user are handled exactly as before, with no new
headers and no new fields (E8, asserted).

* **Buffered `/voice/synthesize`**: all or nothing. Any ElevenLabs failure
  renders the WHOLE reply with Kokoro; one voice throughout.
* **Streamed and incremental**: phrase by phrase. The first ElevenLabs failure
  moves that phrase and every later one to Kokoro, including a later phrase
  that already finished on ElevenLabs (re-rendered before it is emitted) and one
  still in flight (discarded on arrival). The voice changes once and never back.
  An `engine_fallback` line precedes the first Kokoro phrase.
* The key is never logged, never in an error message, never in a response
  (E1, asserted by capturing all output across success and every failure path).
* The prosody analysis' pauses are kept between ElevenLabs phrases; Kokoro's
  per-phrase length_scale is not sent, and no `voice_settings` are sent, so the
  user's own voice settings in their ElevenLabs account stay authoritative.
  The panel's speed control therefore applies to Kokoro only.

## Independent review, and what it changed

A separate review of this build (no shared context with the author) found one
blocking and several should-fix defects. All of the following are fixed in
this archive, each with a test that is red without the fix:

* **Blocking: a bullet list was still truncated.** Line breaks end a piece
  without a Kokoro split character, and the packing step joined unpunctuated
  lines back into one long run. Packing now re-checks the run length of the
  joined text. The property test had exempted any piece holding markup, which
  hid this; the exemption is removed.
* **Streamed voice could switch back with four or more runners.** A phrase
  waiting on another phrase's re-render could be parked as ElevenLabs after an
  earlier phrase failed. It now re-checks itself after that wait.
* **ElevenLabs could use up the fallback's time.** The buffered route now gives
  ElevenLabs a budget of 45 s per 5,000 characters (`ELEVENLABS_BUDGET_MS_PER_5000`),
  inside the gateway's deadline, so the Kokoro fallback always has time to run.
* `VOICE_MAX_TTS_CHARS` outside 5,000..500,000 is now named in a warning.

Accepted as stated, not changed: the user's speed preference is not sent to
ElevenLabs; a Compare request from an ElevenLabs user is answered once in
their voice; inputs under 5,000 characters holding an unpunctuated stretch of
351 to roughly 450 characters are now rendered in two calls where the baseline
used one (the bound is set with margin below kokoro-onnx's 510).

## Verification

Full connector suite, every `src/tests/*.test.js` and `tests/*.test.js` file in
its own `node --experimental-test-module-mocks --test` process plus `npm test`,
against the 13.32.0 archive and against this tree, both with `npm ci`
dependencies. Counts are in DELIVERY-v13.34.0.json.

Pins and their mutations, each run separately:

| Pin | Mutation | Result |
|---|---|---|
| streamed: one switch, never back | `demoteParked()` disabled | red |
| four runners: voice changes once | post-demotion re-check removed | red |
| bullet list rendered in full | packing run check removed | red (2 tests, plus the property test) |
| reply budget | `deadlineAt` not passed | red |
| streamed: in-flight phrase not emitted in the old voice | discard-on-arrival line removed | red |
| S1, S2, S3, S5 | `voice-segmenting.test.js` run against the 13.32.0 tree | 15 of 16 red; the engine is handed the whole stretch (S1), a 12,000-character reply is refused 413 (S1), a short render returns 200 with short audio (S2), the long streamed and incremental replies are refused (S3). The S4 equivalence test passes on both trees, as it must. |

## Not done here (queued)

* W5: a real key end to end (Brian's), first listen, Mia's setup (open item 12).
* `el_model_id` default stays `eleven_multilingual_v2`, the documented API
  default, until it is pinned from `GET /v1/models` (open item 13).
* `package-lock.json` root version still reads 13.25.0, as it did in 13.32.0.
