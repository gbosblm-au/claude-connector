# claude-connector v13.36.0

**Work order W7 rev 2.1 (2026-10-06)**, which supersedes rev 1.1: engine-form
text by a closed vocabulary instead of by bracket shape, divergent engine
profiles, the tag switch, split guards, and the probe. An amendment on top of
13.35.0 (decision 21), which delivered rev 1.1.

Deploy order: this connector FIRST, then ts-gateway-service 2.250.0 (migration
0056, the model selector, the tag switch, the probe route), then
ts-client-gateway 5.232.0 (the controls and the panel container fix). Each step
is safe alone: an older gateway never sends `tags` or `model_id_source`, so
the ElevenLabs path behaves as 13.35.0 minus the over-strip, and the new
connector probe route is simply unused.

Decisions taken as defaults (section 15), stated here so they can be
overridden: the three-class split and divergent profiles (20); an amendment
on 13.35.0 (21); v4 over the dialogue path stays parked (22); floor viewport
1280x720 (23); Option A, the bounded popover (24); the registry is introduced
by this order (25: no register grammar existed in any of the three trees).

## Changed files

| File | Change |
|---|---|
| `src/voice/register-grammar.v1.json` | **new.** The registry (section 3.2): Class A scaffolding, Class B cues (with `[drawn-out]` as a variant of `[drawn out]`), the matching rules, the tag-capability fixture (section 7.1) and the one-word model fixture (section 6.2). |
| `src/voice/engine-form.js` | Rewritten for rev 2.1. `parseRegistry` (refuses a malformed or empty registry), `classifyBrackets` (content spans first, then registry membership; everything else is content), `removeClasses` (A always, B unless kept; one separating space; an emphasis wrapper goes with its token; line scope; repeated to a fixed point), `guardRequest` (G1 to G4), `entryForm`, `toEngineForm` (profiles diverge on Class B only), `prepareForElevenLabs`. The punctuation rule table is unchanged and every rule is still OFF. `ENGINE_FORM_VERSION` is `engine-form/2`. |
| `src/voice/voice-engines.js` | The Kokoro builder runs G1/G2 on the text it is HANDED (so G2 is reachable again), then prepares it and removes any registry token the preparation uncovered from a link label (`[[warm](url)]`), the same as the ElevenLabs path, so such a reply is never refused. The stream entry keeps Class B for a user whose tag switch is on; each Kokoro rendering on that path takes the Kokoro profile of its own phrase, and a cue-only phrase becomes its pause. The ElevenLabs text is prepared BEFORE classification. New export `elevenLabsEngineText` for the probe. |
| `src/voice/elevenlabs.js` | The configuration carries `tags` (true only when the gateway sent `tags: true`) and `modelSource` (`user`, `gateway_default`, `request` or `connector_default`). G1/G3 on `text`, `previous_text` and `next_text`. New export `headersOfInterest`; `synthesizeElevenLabsPcm` accepts an `observe` callback for the probe. |
| `src/voice/elevenlabs-stt.js` | `transcribeElevenLabs` accepts a validated `modelId` override and `observe`, for the probe. Default behaviour unchanged. |
| `src/routes/voice.js` | New `POST /voice/elevenlabs/probe` (section 6); the STT answer reports the audio it sent (`audio_bytes`, `sample_rate`, `audio_is: 'sent'`). The ElevenLabs log lines on the buffered, stream and incremental routes carry `el_model`, `el_model_source` and `el_tags`. |
| `scripts/register-audit.mjs` | **new.** D6: the registry against the writer's vocabulary, derived by walking the gateway and client trees, both ways, with a floor. |
| `scripts/el-punctuation-sweep.mjs` | Per model (`<out>/<model>/`), harness `el-punctuation-sweep/2`, the registry version in the manifest, and a `tags` group (the fixture with the switch on and off). A punctuation rule set in the operator's shell is cleared for the run (named on stderr), so it cannot relabel the WAVs. |
| `docs/W7-ENGINE-FORM.md` | Rewritten for rev 2.1: the section 10 answer, the registry and classes, D5 and D6, the guards, the probe and the 6.4 limitation, the per-model harness and results table, the D7 summary, the mutation table. The rev 1.1 D1 trace is kept. |
| `src/tests/voice-engine-form.test.js` | Rewritten: 36 tests. |
| `src/tests/register-audit.test.js` | **new.** 4 tests (fixture trees). |
| `src/tests/voice-elevenlabs.test.js` | The parsed configuration now includes `modelSource` and `tags`; the expectation says so. Nothing else changed. |
| `src/tests/voice-incremental.test.js` | Its module mock of voice-engines.js gains the three exports routes/voice.js now imports (`elevenLabsEngineText`, `wrapPcmAsWav`, `silencePcm`). Nothing else changed. |
| `package.json` | 13.35.0 to 13.36.0 (CRLF kept); `test:register-audit` and `voice:register-audit`; the new test added to `test:voice-all`. |

No new environment variables. The connector still holds no ElevenLabs key
(non-goal 18).

## Section 10, answered from the code

The ElevenLabs path did not use `KOKORO_SPLIT_CHARS` (`/[.,!?;]/u`,
voice-engines.js:317 at 13.34.0). It rendered the prosody phrases of
`analyse()` (prosody.js:920), which cuts sentences with `splitDwellPoints`
(prosody.js:949), and that splitter breaks after `, ; :` and spaced dashes
(prosody.js:764). The colon was therefore one of our generation boundaries
before 13.35.0. Details: docs/W7-ENGINE-FORM.md section 2.

## The classes, the profiles and the switch

| | Kokoro | ElevenLabs, switch off (default) | ElevenLabs, switch on |
|---|---|---|---|
| Class A (`[OUTPUT]`, panel triggers, `[exam-state]` lines ...) | removed | removed | removed |
| Class B (`[warm] [pause] [slowly] [softly] [drawn out]`) | removed | removed | passed, registered spelling |
| Class C (everything else) | verbatim | verbatim | verbatim |

The switch passes cues whatever the model. On a model without audio tags they
are read aloud; the panel states that hazard beside the switch and offers the
tag test, which is how the operator learns whether the model in force renders
them (section 5.2). There is no tag channel for Kokoro (non-goal 16).

Unknown bracket tokens are logged and left as content. A consequence of the
closed vocabulary: a spelling outside the registry, such as `[Warm]`, is content
and now reaches Kokoro as written, where rev 1.1's shape strip removed it. The
section 2 table's "and the pinned model is tag-capable" is met by the operator's
tag test, not by code: nothing in the connector can know whether a model
renders tags (docs/W7-ENGINE-FORM.md section 4.2). Prose about a marker
survives when it is in a code span or a link (section 3.6); outside one, a
registered token is the marker and is removed.

## The probe

`POST /voice/elevenlabs/probe`, behind the same credential, gate, auth and
rate limit as the other voice routes. It runs the production adapter and the
production engine-text path with the key the gateway forwards in that request
only. TTS: the word fixture, the tag fixture or a supplied text (at most 500
characters), a WAV of the result, the response headers, `model_echo`. STT:
0.5 s of silence through the speech-to-text adapter with the pinned model or a
named one. Verdicts: accepted (2xx), rejected (400, 404, 422), unverified
(401, 402, 429, 5xx, no answer). It records nothing.

Section 6.4 (does the vendor echo the model served) is NOT answered: it needs
a live response. `model_echo` and `response_headers_of_interest` make it
visible on the first real call.

## Verification

| Item | Result |
|---|---|
| Full suite, before (13.35.0) | 55 files, 1260 tests: 1258 pass, 1 fail, 1 skipped; `npm test` 30/30 |
| Full suite, after (13.36.0) | 57 files, 1275 tests: 1273 pass, 1 fail, 1 skipped; `npm test` 30/30 |
| Executed delta | +15: voice-engine-form 25 to 36, register-audit 4 (new); every other file identical |
| Net-new failures | 0. The one failure is carried from 13.35.0: voice-gpl-boundary "no Piper artifact survives anywhere in the source tree" |
| Caught by the full run | a first run after the review fixes showed 2 net-new failures: the Kokoro choke-point call had been rewritten and broke two structural pins (voice-prosody-prep, voice-text-normalize). The call's exact shape was restored, and the guard runs on the same expression before it |
| Mutations | 38 applied, 38 red (docs/W7-ENGINE-FORM.md section 12) |
| D6 audit, real trees | exit 0; W1=8, W2=5, W3=4; nothing emittable unregistered; no registered Class A token without an emitter |
| Independent review | 10 findings: 1 blocking (a link whose label is a registry token made the Kokoro builder refuse the whole reply), 9 non-blocking. 8 fixed with red-without-fix tests or mutations, 2 documented (off-registry spellings such as `[Warm]` are content; section 2's "tag-capable" condition is met by the operator's tag test) |
| Not verified here | D2, D3, D4 and the tag fixture by ear; section 6.4 (model echo); whether the vendor refuses 0.5 s of silence on speech-to-text. All need a key and a live call |
