# claude-connector v13.35.0

Two pieces of work on the 13.34.0 baseline:

* **Work order W7 rev 1.1 (2026-10-06)**: engine-form text for both synthesis
  engines, and tagless renders at the current pin (eleven_multilingual_v2).
* **SPEC-AUDIO-004 rev 1 (2026-10-05), build W6 step 7 and step 9**:
  ElevenLabs speech-to-text with the user's own key, beside Whisper, and the
  model pin check.

Deploy order: this connector FIRST, then ts-gateway-service 2.249.0 (which
forwards the key for transcription), then ts-client-gateway 5.231.0 (the
switch). Each step is safe alone: an older gateway never sends the key header,
and the W7 changes need no other component.

## Changed files

| File | Change |
|---|---|
| `src/voice/engine-form.js` | **new.** W7: the one formatter. Marker register and token classes (D5), the strip pass, the request-builder assertion, the punctuation rule table (every rule OFF), break-tag gating, the two profiles. |
| `src/voice/voice-prosody-prep.js` | Additive: `position: 'none'` runs the whole preparation without contour shaping. Every existing position is unchanged. |
| `src/voice/voice-engines.js` | W7: the three Kokoro entries strip markers before anything else; `synthesizePcm` strips the PREPARED text again and asserts it tagless; ElevenLabs text is the elevenlabs engine form (no contour comma); one ElevenLabs generation per SENTENCE on the prosody paths (`sentencesForElevenLabs`); a Kokoro fallback for a merged sentence renders its original phrases; the renderer accepts `contextBefore` / `contextAfter`. |
| `src/voice/elevenlabs.js` | W7: `elevenLabsSegmentUnit()`; `assertTagless` on `text`, `previous_text`, `next_text`. W6: `elError` and `errorCode` exported (additive) for the STT adapter. |
| `src/voice/elevenlabs-stt.js` | **new.** W6: the ElevenLabs speech-to-text adapter. |
| `src/routes/voice.js` | W7: the incremental route passes the reply text either side of the batch as context, for ElevenLabs only. W6: `POST /voice/transcribe` tries ElevenLabs when the gateway forwarded a key, falls back to Whisper once, and reports `X-Tenax-Stt-Engine` / `X-Tenax-Stt-Fallback`. |
| `scripts/el-punctuation-sweep.mjs` | **new.** W7 deliverable 3: the D2, D3, D4 calibration harness. |
| `scripts/elevenlabs-model-pin-check.mjs` | **new.** SPEC-AUDIO-004 Section 5 step 4 and T6. |
| `docs/W7-ENGINE-FORM.md` | **new.** D1 call-path table, D5 coverage table, the versioned rule table, harness instructions, the results table to fill in by ear, acceptance status, mutation evidence. |
| `src/tests/voice-engine-form.test.js` | **new.** 25 tests (W7). |
| `src/tests/voice-elevenlabs-stt.test.js` | **new.** 12 tests (T1 to T5, connector side). |
| `src/tests/elevenlabs-model-pin-check.test.js` | **new.** 8 tests (T6). |
| `src/tests/fixtures/fake-whisper-once.mjs` | **new.** Stands in for the Whisper helper behind the real spawn path. |
| `package.json` | 13.34.0 → 13.35.0; `test:engine-form`, `test:elevenlabs-stt`, `voice:el-sweep`, `voice:el-pin-check`; the new tests added to `test:voice-all`. |
| `VOICE-DEPLOYMENT-VARIABLES.md` | The new variables. |

## W7: engine-form text

**D1 first.** The call-path table (docs/W7-ENGINE-FORM.md section 2) found
three causes on our side of the artefacts heard live:

1. ElevenLabs rendered every prosody PHRASE as its own generation, and the
   prosody analysis cuts after every comma, semicolon, colon and spaced dash.
   Most generations therefore ENDED on one of those marks.
2. The ElevenLabs text went through the Kokoro preparation with
   `position: 'continuation'`, which appends a comma to every non-final phrase.
3. On the incremental route every batch seam was cold: no `previous_text` at a
   batch start, no `next_text` at its end.

**Fixed structurally, with no substitution.** One generation per sentence
(`ELEVENLABS_SEGMENT_UNIT`, default `sentence`; `phrase` for the D4 A/B), no
contour shaping on ElevenLabs text, and the reply text either side of each
incremental batch sent as context (bounded by the same 500 characters).

**The punctuation rules are built, tested and shipped OFF.** W7 section 3
requires the by-ear diagnostics D2, D3 and D4 before any rule is fixed, and
those need a key and a listener, which this build did not have. The harness
renders the whole sweep in one command (`npm run voice:el-sweep -- --out
<dir>`), and turning a rule on is configuration (`ELEVENLABS_PUNCTUATION`).
Break tags are additionally gated on `ELEVENLABS_BREAK_TAGS_VERIFIED=true`,
never used on eleven_v3 or eleven_v4, and limited to two per generation.

**Tagless renders.** Both engines get the strip pass (D5): the channel
markers, session directives, panel triggers, the live-confirmed audio tags, and
the token shapes that catch anything not yet named. Indexers, years, key names
and link labels are kept. Assertions sit at both request builders.

**Kokoro unchanged except marker stripping (criterion 10).** Marker-free text
reaches Kokoro byte for byte; a reply with markers sends Kokoro exactly the
requests of the same reply without them; a Kokoro fallback for a merged
sentence sends exactly the Kokoro-only requests.

**Displayed text unchanged (criterion 7)** by construction: the formatter runs
in the connector on the engine copy; nothing returns text to the client.

## W6: ElevenLabs speech-to-text (SPEC-AUDIO-004)

* The gateway forwards the user's key in `X-Tenax-ElevenLabs-Key` only when
  their speech-to-text switch is on. Without the header the route is exactly
  the baseline: no new header, no new log field, Whisper (T1).
* With it: `POST /v1/speech-to-text`, multipart, `xi-api-key`, `model_id` from
  `ELEVENLABS_STT_MODEL` (default `scribe_v2`), the recording in its own
  container, `tag_audio_events=false`, `timestamps_granularity=none`, and
  `language_code` when the caller named one. Not sent: `enable_logging` (zero
  retention is enterprise-only), `file_format` (the default suits browser
  audio), `keyterms` (an open item with a surcharge). The answer is normalised
  to the route's existing `{ text, language, duration_seconds, segments }`.
* Any ElevenLabs failure falls back to Whisper ONCE, never retried, named in
  the headers and the log (T3). 401 is reported as `invalid_key`, 402 and 429
  as `quota`, anything else (422, 5xx, a time-out, an answer that is not a
  transcript) as `error` (T4). The headers are set before Whisper runs, so a
  Whisper failure after a 401 still reports it.
* Key custody: the key lives for one request, is sent only in `xi-api-key`,
  and appears in no log, response or error (T5, asserted against a planted
  key).

**Model pins (Section 5).** `ELEVENLABS_STT_MODEL=scribe_v2`;
`ELEVENLABS_DEFAULT_MODEL=eleven_multilingual_v2` is unchanged. Both are the
spec's pins of 2026-10-05; neither has been checked against a live account in
this build (no key). `npm run voice:el-pin-check` does that: the TTS id must be
in `GET /v1/models` with `can_do_text_to_speech: true`; the STT id is settled by
the list if the list carries it, otherwise by a 0.5 s probe of
`POST /v1/speech-to-text` (`--no-stt-probe` skips it). Exit 0 verified, 1 a pin
is missing or rejected, 2 could not verify. Run it with the key at W5 and
record the ids and the date it prints.

## Independent review, and what it changed

A separate review of this build found these defects; all are fixed here, each
with a test that is red without the fix:

* **Preparation could uncover a marker after the strip**, and the Kokoro
  builder assertion then failed the whole reply (`[**Note**]` became `[Note]`,
  `[[the docs](url)]` became `[the docs]`). Kokoro has no fallback engine. The
  prepared text is now stripped again, and the assertion only backs that up.
* **Nested markers survived one pass** (`[note [1] here]`, `[[]]`); the strip
  now repeats until nothing changes, and is idempotent.
* **The checkbox shape matched link labels** (`[X](url)` lost its label, and
  misaki emphasis `[X](+2)` was refused); it now refuses a following `(`.
* **The ElevenLabs profile changed words** (`my_var_name` became `myvarname`),
  because it used a general markdown stripper. It now reuses the 13.34.0
  preparation with contour shaping off, between two strip passes, which also
  removes markers that flattening uncovers (`[**warm**]`).
* **Content in brackets was deleted** (`[Enter]`, `a[i]`, `[2024]`); the tag
  shape is now lower case, protocol markers are an all-capitals shape, and
  nothing glued to a word or a closing bracket is taken for a marker.

Accepted as stated, not changed: turning speech-to-text ON requires that the
account has not rejected the stored key (the gateway's reading of "switching on
requires a valid key"; routing itself is independent of TTS status). A merged
sentence that falls back to Kokoro leaves as one phrase line with its pauses in
the audio.

## Verification

Full suite through a per-file runner (each `src/tests/*.test.js` and
`tests/*.test.js` in its own `node --test` process, TAP counts) plus
`npm test`, on 13.34.0 and on this tree. Counts and the per-file diff are in
DELIVERY-v13.35.0.json. Mutation tables: docs/W7-ENGINE-FORM.md section 7 (W7)
and DELIVERY-v13.35.0.json (W6 and the pin check).

## Not done here (queued)

* D2, D3, D4 by ear with a key, then the rule choices and
  `ENGINE_FORM_VERSION` bump (docs/W7-ENGINE-FORM.md section 5).
* Acceptance criterion 6 (by ear on the live path) depends on that run.
* The pin check with the real key (W5), and its ids and date in the next
  changelog.
* Realtime speech-to-text, `keyterms`, residency hosts (SPEC-AUDIO-004
  Section 10). The streaming dictation socket (`/voice/stream`) stays on
  Whisper.
