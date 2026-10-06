# W7: engine-form text for both synthesis engines

Work order W7 rev 2.1 (2026-10-06), which supersedes rev 1.1. Rev 1.1 was
delivered in claude-connector 13.35.0; rev 2.1 is delivered in 13.36.0 as an
amendment on top of it, with gateway 2.250.0 and client 5.232.0.

This file is the repository artefact the work order asks for: the D1 call-path
table (rev 1.1, still accurate), the answer to section 10, the registry and the
three classes, the D5 and D6 audits, the guards, the probe, the versioned rule
table, the calibration harness and the results table to be filled in by ear.
The D7 panel report is in the client's CHANGELOG-v5.232.0.md and summarised in
section 10 here.

Engine form version: `engine-form/2 2026-10-06 (pin eleven_multilingual_v2; register-grammar/1 2026-10-06)`
(`ENGINE_FORM_VERSION` in `src/voice/engine-form.js`).

## 1. What changed in rev 2.1, in one paragraph

Rev 1.1 stripped every bracket SHAPE, which removed content (`[Enter]` was
kept, but `he [the chair] agreed` was not) and made the Kokoro builder's
assertion unreachable. Rev 2.1 classifies a bracket token by membership of a
closed vocabulary instead. The vocabulary is a file,
`src/voice/register-grammar.v1.json` (section 3.7 of the order: no register
grammar existed anywhere in the three repositories, so this order introduces
it). Class A (channel scaffolding) is removed for every engine; Class B (the
prosody cues) is removed for Kokoro always and, for ElevenLabs, passed through
only when the user's new "Send prosody tags to ElevenLabs" switch is on;
everything else is Class C content and is never transformed. The single
assertion is split into four guards, G1 to G4, so G2 is live and breakable
again. The gateway gains the tag switch (migration 0056), an editable model id
with attribution, and a probe route; the connector gains the probe; the client
gains the controls and the panel container fix.

## 2. Section 10: which splitter the ElevenLabs path used

Answered from the code at 13.34.0 (the connector before W7), not inferred.

The ElevenLabs path did NOT use `KOKORO_SPLIT_CHARS` (`/[.,!?;]/u`,
voice-engines.js:317 at 13.34.0). That set belongs to the Kokoro run-length
splitter, which the ElevenLabs path never called. The ElevenLabs path rendered
the prosody PHRASES that `analyse()` (prosody.js:920) produces, and `analyse()`
cuts each sentence with `splitDwellPoints` (called at prosody.js:949), whose
punctuation test is
`',' === ch || ';' === ch || ':' === ch || '\u2014' === ch || '\u2013' === ch`
(prosody.js:764). A colon IS in that set.

So the description "phrases cut at commas, colons and semicolons" was accurate
for the ElevenLabs path, and the colon was one of OUR generation boundaries
before 13.35.0: a sentence with a colon between two runs of at least two words
was sent as two generations, the first ending on the colon. The colon stop
heard by ear on 13.34.0 therefore had at least one cause of ours. Whether a
colon inside one generation still stops the voice (vendor prosody) is what the
D3 colon pair decides, because since 13.35.0 the colon is no longer a
generation boundary (section 3.4 below).

## 3. D1: call-path trace (rev 1.1, still accurate)

Source-read against the 13.34.0 baseline (the deployed connector), 2026-10-06.
Line numbers are 13.34.0 lines unless marked 13.35.0.

Grep: `synthesizeElevenLabsPcm\|previousText\|nextText\|segmentForSynthesis\|voice-stream-split`
over `src/` (tests excluded).

### 3.1 Every call site of the request builder

| # | Call site (13.34.0) | Reached from | Segments produced by | `previousText` / `nextText` | Engine text finalised at |
|---|---|---|---|---|---|
| 1 | `voice-engines.js:2106`, inside `createElevenLabsPhraseRenderer` (`:2076`) | `synthesizeProsodyStream` (`:1823`, renderer built at `:1881`) | `analyse()` (prosody.js:920) then `speakablePhrases`: one generation per PROSODY PHRASE | neighbouring phrase texts (`:2108`, `:2109`); empty at the first and last phrase of the call | `elevenLabsText` (`:2052`) = `prepareForKokoro` espeak mode with `position: closing ? 'final' : 'continuation'` |
| 2 | `voice-engines.js:2192`, inside `synthesizeElevenLabs` (`:2157`) | `/voice/synthesize` (routes/voice.js:1024) | mode `prosody`: `analyse()` phrases (`:2172`); mode `flat`: `segmentForSynthesis` at 2,500 chars (`:2178`) | neighbouring units (`:2194`, `:2195`) | `elevenLabsText` (`:2173` per phrase, `:2176` whole reply) |

The builder itself reads `o.previousText` / `o.nextText` at `elevenlabs.js:269-270`
and bounds them by `CONTEXT_CHARS` (500) at `:271-272`, as F3 states. F3's open
question ("whether any call site passes them") is closed: both call sites do.

### 3.2 Every route that reaches it

| Route (routes/voice.js) | Text source | Segmenter | ElevenLabs call site | prev/next status at 13.34.0 |
|---|---|---|---|---|
| `POST /voice/synthesize` (`:878`), prosody on | whole reply, `body.text` | prosody phrases | #2 | populated between phrases; none at reply edges (correct, nothing there) |
| `POST /voice/synthesize` (`:878`), prosody off | whole reply | `segmentForSynthesis`, 2,500 chars, sentence-bounded | #2 | populated between segments; a reply under 2,500 chars is one generation |
| `POST /voice/synthesize/stream` (`:1256`) | whole reply | prosody phrases (`synthesizeProsodyStream`, call at `:1372`) | #1 | populated between phrases; none at reply edges |
| `POST /voice/synthesize/incremental` (`:1503`) | a BATCH: `splitStream` (`:1588`, voice-stream-split.js:292, `maxPhraseLength` 300) then joined at `:1675` | prosody phrases of the batch (`synthesizeProsodyStream`, call at `:1688`) | #1 | populated inside a batch; **EMPTY at every batch seam** (each batch is its own request; the renderer had no text outside it) |
| `POST /voice/prosody/analyse` (`:1819`) | n/a | n/a | none | n/a (analysis only, no synthesis) |

There is no ElevenLabs-only route and no text-to-dialogue path (F1 holds).

### 3.3 What the trace shows

1. **Generation boundaries sat on commas, colons and semicolons.** The prosody
   analysis cuts a sentence after `, ; :`, the em dash (U+2014) and the en dash (U+2013) when at least two words lie on
   each side (prosody.js:764, `MIN_WORDS_PUNCTUATION` 2), before weighted
   conjunctions (`but and which because yet so that although though while`,
   three words each side), and around emphasised words. The ElevenLabs path
   rendered each such phrase as its own generation. So most generations ENDED on
   a comma, colon or semicolon, and the next one started cold.
2. **A comma was ADDED to every non-final phrase.** `elevenLabsText` called
   `prepareForKokoro(..., { position: 'continuation' })`, whose `shapeContour`
   (voice-prosody-prep.js:166-181) appends `,` to any phrase not already ending
   in `, ; :`, an em dash (U+2014) or a terminator (`:173`). That is how Kokoro is asked for a
   continuation rise. Sent to ElevenLabs it marks the end of a generation that
   then stops.
3. **Batch seams were cold.** On the incremental route the first generation of
   every batch had no `previous_text` and the last had no `next_text`.
4. F4's open question is closed: the ElevenLabs path does NOT use the Kokoro
   split set (`KOKORO_SPLIT_CHARS`, voice-engines.js:317) or the run cap; it uses
   the prosody phrases (stream, incremental, buffered prosody) or
   `segmentForSynthesis` at 2,500 characters (buffered flat).

Example, from the harness's pre-W7 replica of 13.34.0 (`--dry-run` prints it):
the comma-dense test sentence was sent as eight generations, every one of them
ending on a comma or a full stop:
`When the test finished, / we read the results, / compared them with the baseline, / and, after a short pause, / wrote the report. / The numbers, / as it turned out, / were fine.`

This is consistent with F6 option (i), boundary cold-starts, being at least part
of the comma artefact, and with the colon stop (F5) being made worse by the
colon sitting at the end of a generation. Whether the vendor adds artefacts on
top (option ii) is what D2 decides by ear.

### 3.4 The same table at 13.35.0

| Path | Unit of one ElevenLabs generation | prev/next | Engine text |
|---|---|---|---|
| stream, incremental, buffered prosody | one SENTENCE (`sentencesForElevenLabs`, voice-engines.js:2140 in 13.35.0); a sentence longer than `ELEVENLABS_SEGMENT_CHARS` is split where the analysis split it | neighbours at every seam; incremental batches get the reply text before (`contextBefore`) and after (`contextAfter`) the batch (routes/voice.js:1750-1753, 13.35.0) | `elevenLabsText` (voice-engines.js:2119) -> `toEngineForm(..., 'elevenlabs')`: `prepareForKokoro` with `position: 'none'` (voice-prosody-prep.js:375), no contour comma |
| buffered flat | unchanged: `segmentForSynthesis`, 2,500 chars | unchanged | `toEngineForm(..., 'elevenlabs')` on the whole reply |

`ELEVENLABS_SEGMENT_UNIT=phrase` restores phrase-level generations (still
without the contour comma) for the D4 comparison only.

A Kokoro fallback for a merged sentence renders the phrases it was merged from,
each with its own length scale, contour and pause, so it sends Kokoro exactly
the requests a Kokoro-only reply sends (asserted request for request,
voice-engines.js:1976). One difference remains and is accepted: the merged
sentence leaves as ONE phrase line, with the analysed pauses inside it written
into its audio, instead of one line per phrase each carrying `pause_after_ms`.
The audio is the same; the stream has fewer, longer lines.

## 4. The registry and the three classes (rev 2.1 section 3)

### 4.1 Source

`src/voice/register-grammar.v1.json`, version `register-grammar/1 2026-10-06`.
Read once at start-up by `engine-form.js` (`parseRegistry`), which refuses to
load a file with a missing or empty class, a malformed token or no version, so
a broken deploy fails at start rather than running a formatter with an empty
vocabulary. The formatter names no Class A or Class B token in code; a test
reads the comment-free source of engine-form.js and fails if a registered
token is written there as a string literal.

Searched before introducing it (section 3.7): by file name (`register-grammar`,
`voice-register`) and by content across the connector, gateway and client
trees. The only hits were unrelated (`script_audit_register.py`,
`se-verify-register.mjs`, `register.html`) and rev 1.1's own in-code list
(`MARKER_REGISTER` in engine-form.js), which this file replaces.

### 4.2 Classes

| Class | Tokens | Kokoro | ElevenLabs, switch off | ElevenLabs, switch on |
|---|---|---|---|---|
| A, scaffolding | `[OUTPUT] [TRACE] [RESULT]` (channel markers), `[private-conversation] [forget]` (session directives), `[[TRAVEL_RESEARCH_FORM]] [[RECREATION_PANEL]]` (panel triggers), `[exam-state]` (a control line: scope `line`, case-insensitive, removes the rest of its line) | removed | removed | removed |
| B, cues | `[warm] [pause] [slowly] [softly] [drawn out]` (variant `[drawn-out]`) | removed | removed | passed, in the registered spelling |
| C, content | everything else: `[**Note**]`, `a[i]`, `[Enter]`, `[1]`, `[label](url)`, misaki markup, a cue inside a code span | kept verbatim | kept verbatim | kept verbatim |

Matching is exact after removing `*` and `_` from both sides (so `[**warm**]`
and the incremental route's `[[TRAVELRESEARCHFORM]]` still match), and
case-sensitive unless the entry says otherwise. A kept cue that matched through
emphasis is written in its registered spelling, so what reaches ElevenLabs is
well formed (G3).

Content spans are decided first (the order's section 3.4): a token inside
inline code, a fenced block or a `[label](target)` link is content whatever it
says, which is how prose ABOUT a marker survives (the order's section 3.6). A
removed token takes one separating space with it and no other byte (the
order's section 4.1). Removal repeats until
nothing changes, so a token brought together by a removal (`[pa[pause]use]`)
goes too and the result is a fixed point.

A removed token's emphasis wrapper goes with it (`**[warm]**`, `_[pause]_`),
rather than leaving an empty `****` behind.

One stated exception to "a link is content": a link whose LABEL is itself a
registry token (`[[warm](url)]`). It is content where it is classified, but
both engines' preparation flattens a link to its label and so uncovers the bare
token. The ElevenLabs path classifies after that flattening (so that markers
inside emphasis and links in ordinary text are seen in engine form), and the
Kokoro builder removes such an uncovered token after its own preparation. The
two engines therefore agree (asserted), and the reply is never refused for it,
which matters most on Kokoro, which has no engine to fall back to. The display
text is unaffected.

A consequence of the closed vocabulary, stated rather than hidden: a spelling
outside the registry is content. `[Warm]` (capital W) is not `[warm]`, so it
now reaches Kokoro as written, where rev 1.1's shape strip removed it. If the
writer is seen emitting such spellings (the unknown-token log names them), the
fix is a registry variant or `case_insensitive`, not an open pattern.

Section 2's table of the order says Class B passes on ElevenLabs "when the tag
switch is ON and the pinned model is tag-capable". The code gates on the
switch only, following section 5.2 ("the read-aloud hazard stated in the
panel"): nothing in the connector can know whether a model renders tags (the
probe's 200 proves acceptance, not rendering, section 6.2 item 3), so the
condition is met by the operator running the tag test before switching on,
and the panel says so beside the switch.

Unknown bracket tokens are logged and never transformed (section 3.5): one
line per reply with the count, naming only tag-shaped tokens (one to four
lower-case words), since the words of a reply are not logged.

### 4.3 Where each class is handled at 13.36.0

| Point | What | Code |
|---|---|---|
| Kokoro entries | `toEngineForm(text, 'kokoro')`: A and B removed | voice-engines.js `synthesize`, `synthesizeProsody` |
| Stream entry | `entryForm(text, { keepB: tags })`: A removed; B kept only for a user whose switch is on, so the cues survive analysis | voice-engines.js:1854-1856 |
| Kokoro phrase on a tags-on stream | `kokoroText` = the Kokoro profile of that phrase; a cue-only phrase becomes its pause, or nothing | voice-engines.js:1990 |
| Kokoro request builder | G1 and G2 on the text the builder was HANDED, then preparation, then the removal of any registry token that preparation uncovered from a link label (below), then the worker. The rev 1.1 strip-then-assert is gone, so G2 is reachable | voice-engines.js:1236-1259 |
| ElevenLabs text | `elevenLabsText` = `stripMisakiMarkup`, then `prepareForElevenLabs` (13.34.0 flattening without contour), then `toEngineForm(..., 'elevenlabs', { tags })` | voice-engines.js:2148 |
| ElevenLabs request builder | G1 and G3 on `text`, `previous_text` and `next_text` | elevenlabs.js:352-357 |

The formatter runs on the engine copy only; the connector never returns text
to the client, so the displayed reply is untouched by construction.

## 5. D5 and D6 audits

### 5.1 D5, strip coverage

The rev 1.1 table of where each vocabulary reached an engine before 13.35.0
still holds (channel markers, directives and panel triggers on the incremental
route, which feeds the raw reply; cues on every route). At 13.36.0 every Class
A token is removed on every route and every Class B token on every Kokoro
route, asserted by the incremental "every class, both engines" path test with
raw stream text, and by T2 for each token in each position.

### 5.2 D6, classification audit

`scripts/register-audit.mjs` (`npm run voice:register-audit -- --gateway <dir>
--client <dir>`) derives the writer's vocabulary by walking the two trees that
hold it, and compares it with the registry in both directions:

| Walker | What it reads | Found at delivery |
|---|---|---|
| W1 | gateway `lib/` and `routes/` string literals containing a backticked bracket token (how a prompt tells the model to write one) | 8 |
| W2 | client `src/js` array literals assigned to a name containing `MARKER` | 5 |
| W3 | client `src/js` regular-expression literals matching one literal bracket token | 4 |

Run against gateway 2.250.0 and client 5.232.0 at delivery: exit 0. Writer
tokens: `[TRACE] [OUTPUT] [RESULT] [exam-state] [[TRAVEL_RESEARCH_FORM]]
[[RECREATION_PANEL]] [private-conversation] [forget]`, every one registered;
every registered Class A token has an emitter. Class B has no code emitter (the
cues are written by the model; the register layer that would instruct them is
parked), which the report states and does not fail.

Floor first: a walker that finds nothing fails with exit 2 rather than passing.
Excluded by construction, and stated: the tutoring directives the CLIENT writes
into the USER's turn (`[session-open-homework-check]`, `[session-complete]`,
`[tutor-help-request]`, `[tutor-help-exhausted]`, in `parts = [...]` arrays).
They are not the reply writer's vocabulary and never reach synthesis as reply
text; if one ever appears in a reply it is Class C and is logged as unknown.

## 6. Guards (rev 2.1 section 8)

| Guard | Builder | Rule | Refusal |
|---|---|---|---|
| G1 | both | no Class A token | `tagged_text`, `guard: 'G1'` |
| G2 | Kokoro | no Class B token | `tagged_text`, `guard: 'G2'` |
| G3 | ElevenLabs | switch off: no Class B; switch on: every Class B token in a registered spelling | `tagged_text`, `guard: 'G3'` |
| G4 | both | every token classified; the counts logged (`[voice] engine-form <where>: brackets=.. A=.. B=.. content=.. unknown=..`) | never refuses; T6 asserts the count is non-zero on a bracket fixture |

A refusal never carries the text. G2 is now reachable (T5): a cue that
bypasses the formatter and reaches `synthesizePcm` is refused, and removing G2
turns its test red (section 9).

## 7. The probe (rev 2.1 section 6)

`POST /ti-voice/elevenlabs/probe` on the gateway (user JWT) unseals the stored
key and forwards to the connector's `POST /voice/elevenlabs/probe`, which runs
the PRODUCTION adapter and the production engine-text path
(`elevenLabsEngineText`), not a parallel one. The connector environment holds
no ElevenLabs key (non-goal 18); `voice:el-pin-check` still reports
UNVERIFIED there, by design.

Request (gateway): `{ capability: 'tts'|'stt', model_id?, voice_id?, text?
(at most 500 characters), fixture?: 'word'|'tags', tags? }`.

Response: `{ capability, verdict, http_status, vendor_error, attempts,
audio_bytes, sample_rate, elapsed_ms, response_headers_of_interest,
model_id_in_force, model_id_source, tags, text_sent, model_echo,
audio_wav_base64, local_error }`. The key is never in it.

Verdicts (section 6.2 item 1): `accepted` for a 2xx; `rejected` for 400, 404
and 422 (the endpoint refused the request it was given); `unverified` for 401,
402, 429, 5xx and no answer. An unverified result is never reported as a
missing or rejected model, in the response or in the panel. A refusal is
usually the model id, but a voice id or, for speech-to-text, the probe's 0.5 s
of silence could also be refused, so the panel writes "request refused" with
the vendor's code rather than "model rejected". Whether the vendor refuses
silent audio is not known here (no live call was made); if it does, the STT
pin check needs a spoken fixture, queued rather than guessed.

For speech-to-text, `audio_bytes` and `sample_rate` describe the audio SENT
(`audio_is: 'sent'`), since that endpoint returns text, and
`transcript_chars` is the length of the transcript.

The three uses, as the panel offers them: Check pins (the TTS pin with the
word fixture, and the STT pin); Test model (the typed id with the word
fixture: the only way to learn whether an id is accepted); Play tag test (the
section 7.1 fixture from the registry file, with tags on, played in the
browser). A probe changes no stored state and records no outcome.

### 7.1 Section 6.4: does the vendor echo the model served?

NOT ANSWERED at delivery, and recorded rather than assumed. Answering it needs
a live call with a real key, which the build did not have. The probe makes the
answer visible on the first real call: `model_echo` is the value of any
response header whose name contains `model`, else null, and
`response_headers_of_interest` carries every header (at most 40, set-cookie
excluded). Until a real response shows a model header, a silently substituted
model is indistinguishable from a render of the requested one; the panel says
"The response does not name the model it served" when `model_echo` is null.

## 8. Rule table (elevenlabs profile), versioned

Unchanged from rev 1.1 apart from the version string. All rules are candidates
awaiting D3 and ship OFF; non-goal 14 keeps it that way. Switched on by
configuration: `ELEVENLABS_PUNCTUATION="colon=period,semicolon=period"`.

| Mark | Matches | Candidate replacements | State | Evidence |
|---|---|---|---|---|
| colon | a colon between words; never `10:30`, `3:1`, `https:` | `period`, `comma`, `dash`, `break` | off | pending D3 |
| semicolon | `;` followed by space or end | `period`, `comma` | off | pending D3 |
| emdash | the em dash U+2014 (any spacing), or a spaced en dash U+2013; never `cost-benefit`, `2019-2024` | `comma`, `space` | off | pending D3 |
| ellipsis | `…`, `...`, `. . .` | `period`, `comma` | off | pending D3 |
| parentheses | `(aside)` up to 200 characters | `comma` (`, aside,`) | off | pending D3 |

No prose comma stripping (non-goal 15). Break tags: colon only, only with
`ELEVENLABS_BREAK_TAGS_VERIFIED=true`, never on `eleven_v3` or `eleven_v4`, at
most `BREAK_LIMIT` = 2 per generation. The Kokoro profile has no rules.

## 9. Calibration harness, per model (deliverable 10)

```
ELEVENLABS_API_KEY=<key> ELEVENLABS_VOICE_ID=<voice> \
  node scripts/el-punctuation-sweep.mjs --out ./el-sweep --model eleven_multilingual_v2
```

For a workstation, not the deployed connector (which holds no key). Output
goes to `<out>/<model>/`, so a second model never overwrites the first
(section 7.4: record per model, not per session). Each directory holds one
24 kHz WAV per case, `manifest.json` (harness `el-punctuation-sweep/2`, the
registry version, the exact text of each request) and `RESULTS-TEMPLATE.md`.
`--dry-run` writes the manifest and template without a key (42 cases);
`--only d2,d3,d4,tags` limits the groups.

| Group | Cases | Decides |
|---|---|---|
| D2 | one generation; the live sentence path; phrase units; the 13.34.0 replica | comma cause: ours, vendor-side, or stacked |
| D3 | 16 minimal pairs, every candidate substitution, the decisive raw break-tag case | per mark: artefact or clean; break tag: pause or spoken |
| D4 | three seams, each cold, with context, and as one generation | whether `previous_text` / `next_text` removes the seam |
| tags | the section 7.1 fixture with the switch on, and with it off | per model: three verdicts (warm, pause, quieter), or brackets read aloud |

### 9.1 Results (to be filled in by ear)

Status at delivery: **not run**. No ElevenLabs key or listener was available
to the build. Record model id, date and voice with each row (section 7.2).

| Diagnostic | Verdict | Date | Model | Voice |
|---|---|---|---|---|
| D2 comma cause (ours / vendor / stacked) | | | | |
| D3 comma | | | | |
| D3 colon (and chosen replacement) | | | | |
| D3 semicolon | | | | |
| D3 em dash | | | | |
| D3 ellipsis | | | | |
| D3 quotes | | | | |
| D3 parentheses | | | | |
| D3 hyphen vs en dash | | | | |
| D3 break tag (pause / spoken) | | | | |
| D4 seam with context (gone / reduced / unchanged) | | | | |
| Tags: warm | | | | |
| Tags: pause | | | | |
| Tags: softly (quieter) | | | | |
| 6.4 model echoed in the response (header name, or none) | | | | |

Do not use `wry` as a cue in the fixture (section 7.3).

## 10. D7, panel reachability (client 5.232.0)

Measured in Chromium at the floor viewport 1280x720 by
`tests/voice-panel-reachability.test.mjs` in the client, against the real page
shell (sidebar.html and chat-main.html inside `#app`), the built stylesheet and
the real voice modules. The container's rules were read at source
(28-tools-kg-collab.css), not inferred from the children.

| | client 5.231.0 (before) | client 5.232.0 (after) |
|---|---|---|
| Shell rules at source | `position: absolute; right: 12px; bottom: 62px; z-index: 40; width: 268px`; no max-height, no overflow | width `min(560px, calc(100vw - 32px))`, max-height `min(85vh, calc(100vh - 96px))` tightened on open and resize to the room above the anchor, flex column, body `overflow-y: auto`, title and action row pinned |
| Panel box | top -441.6px, bottom 621px, height 1062.6px | top 16px, bottom 621px, height 605px |
| Scroll region | none (the panel itself: scrollHeight 1061 = clientHeight 1061) | `.ti-voice-panel-body`: scrollHeight 1018 > clientHeight 519 (overflow exercised) |
| Action row | none | 573px to 620px, inside the viewport |
| Controls reachable | 7 of 22 (15 above the window, the Kokoro picker among them) | 31 of 31 |

Stacking unchanged and stated: panel 40, hot-mic indicator 41 above it, no
backdrop, no animation. Two of three explanatory blocks collapsed (the Kokoro
inactive note and the account note); the STT privacy sentence is not.

## 11. Acceptance and tests

`src/tests/voice-engine-form.test.js` (36 tests) and
`src/tests/register-audit.test.js` (4 tests):

| Test | Where |
|---|---|
| T1 Class C forms verbatim, both profiles, both switch states | `T1: ...` |
| T2 A and B per profile and per switch state | `T2: ...` |
| T3 idempotence, both profiles, both states, rules off and on | `T3: ...`, plus the fixed-point cases in `section 4.1` |
| T4 byte equality without A or B | `T4: ...` |
| T5 breaking G2 fails a test | `T5 / G2: ...` (mutation G2 in section 12) |
| T6 G4 count non-zero on a bracket fixture | `T6 floor: ...` |
| D6 registry both ways, floor, refusals | `D6 floor: ...` (two tests) and register-audit.test.js |
| Paths | stream per sentence, the tag switch end to end on the three routes, tags-on fallback to Kokoro, Kokoro equivalence, merged fallback, incremental context and every class, model attribution |
| Probe | tts, the tag fixture on and off, verdicts, stt, input validation |
| Sweep | every case per model, the tag fixture included, the key never written |
| Key custody | the user key appears in no log line |

T7, T7a and T8 are client tests (section 10).

## 12. Mutation evidence

Each mutation applied alone to the 13.36.0 tree, the named suite run, then
restored (`md5sum -c` clean afterwards). 38 applied, 38 red.

| Mutation | Red tests (first named) |
|---|---|
| G1: Class A not refused | G1 |
| G2: Kokoro builder accepts Class B (T5) | T5 / G2 |
| G2: Kokoro builder guard call removed | G1; T5 / G2 |
| G3: switch-off ElevenLabs accepts B | G3 |
| G3: malformed B accepted | G3 |
| G3: adapter guard on `text` removed | G1; G3 |
| G3: adapter guard on `previous_text` removed | G1 |
| G4: classification count not logged | T6 floor |
| keepB ignored (tags never pass) | T2; Unicode; tag switch end to end |
| keepB for Kokoro when tags is true | the Kokoro profile never keeps a cue |
| kept B not written in its registered spelling | T2 |
| removal takes no separating space | T2; section 4.1; Unicode |
| line scope ignored | T2; incremental every class |
| a single removal pass | section 4.1 (fixed point) |
| code spans not content | T1; T4; section 3.4 and 3.6 |
| links not content | T1 |
| code blocks not content | T1 |
| emphasis not ignored in matching | T2; T5; G3 |
| case-insensitive flag ignored | T2 |
| every entry case-insensitive | D6 floor; T1; T2 |
| unknown tokens not logged | section 3.5 |
| unknown prose quoted in the log | section 3.5 |
| a registry with an empty class tolerated | D6 floor (refusals) |
| a registry entry renamed (`[softly]`) | section 4.1 |
| ElevenLabs text not prepared before classification | the ElevenLabs preparation |
| tags not forwarded to the ElevenLabs text | tag switch end to end; incremental |
| stream entry drops cues with tags on | tag switch end to end; incremental |
| Kokoro phrase keeps cues on a tags-on stream | tags-on fallback to Kokoro |
| configuration `tags` truthy instead of strictly true | model attribution |
| model source not attributed | model attribution; probe tts |
| probe: 422 not called rejected | probe verdicts; probe stt |
| probe: 429 called rejected | probe verdicts |
| audit: reverse direction off | D6 reverse direction |
| audit: floor off | D6 floor (empty walker) |
| audit: W2 walker off | D6 (three tests) |
| a registry token uncovered from a link label not removed (Kokoro) | T5 / G2 (the link-label case) |
| an emphasis wrapper left behind | section 4.1 |
| the sweep does not clear a punctuation rule set in the shell | the sweep |

## 13. Deploy, rollback and what is not in this order

Order: connector, then gateway (`migrate:up` for 0056, record it, clear its
PENDING line in tests/applied-migrations-immutable.test.js), then client. The
tag switch defaults off and the punctuation rules stay off, so this is safe to
deploy before any tag-capable model is pinned; with the switch off the
ElevenLabs path behaves as 13.35.0 minus the over-strip. Rollback of the cue
behaviour is the per-user switch. The narrowing of the strip itself (Class C
now kept) has no switch; rolling it back is redeploying 13.35.0, which accepts
rev 2.1 requests (it ignores `tags` and `model_id_source`) but has no probe
route, so the gateway answers the probe with 501 `probe_unavailable`.

Not in this order: a tag channel for Kokoro (non-goal 16); a dialogue path for
v4 (non-goal 17: every model id, v3 and v4 included, is sent to the
text-to-speech endpoint, and the panel says so); an ElevenLabs key in the
connector environment (non-goal 18); a lightbox for the panel (non-goal 19).
