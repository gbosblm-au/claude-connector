# W7: engine-form text for both synthesis engines

Work order W7 rev 1.1 (2026-10-06), "Punctuation formatting for the ElevenLabs
and Kokoro synthesis paths; tagless renders at the current pin". Delivered in
claude-connector 13.35.0, built on the 13.34.0 baseline.

This file is the repository artefact the work order asks for: the D1 call-path
table, the D5 strip-coverage table, the versioned rule table, the calibration
harness instructions and the results table to be filled in by ear.

Engine form version: `engine-form/1 2026-10-06 (pin eleven_multilingual_v2)`
(`ENGINE_FORM_VERSION` in `src/voice/engine-form.js`).

## 1. What changed, in one paragraph

Every reply is now put into engine form by one module,
`src/voice/engine-form.js`, before either engine sees it. Both profiles strip
the bracketed markers (D5). The ElevenLabs profile runs the same preparation
13.34.0 used on this path (prepareForKokoro in its espeak mode: normalisation,
link flattening, bold removal) with its contour step switched off, so it no
longer adds the comma the Kokoro pipeline appends to a non-final phrase. On the prosody paths, ElevenLabs now renders one generation per SENTENCE
instead of one per prosody phrase, so the commas, colons and semicolons inside a
sentence reach the model as punctuation rather than as the end of a generation.
The incremental route passes the reply text either side of each batch as
`previous_text` / `next_text`. A request builder that is handed a bracketed
token refuses it by name. The punctuation substitutions are built, tested and
shipped OFF, because the work order requires the by-ear diagnostics (D2, D3,
D4) before any rule is fixed, and those need a key and a listener.

## 2. D1: call-path trace

Source-read against the 13.34.0 baseline (the deployed connector), 2026-10-06.
Line numbers are 13.34.0 lines unless marked 13.35.0.

Grep: `synthesizeElevenLabsPcm\|previousText\|nextText\|segmentForSynthesis\|voice-stream-split`
over `src/` (tests excluded).

### 2.1 Every call site of the request builder

| # | Call site (13.34.0) | Reached from | Segments produced by | `previousText` / `nextText` | Engine text finalised at |
|---|---|---|---|---|---|
| 1 | `voice-engines.js:2106`, inside `createElevenLabsPhraseRenderer` (`:2076`) | `synthesizeProsodyStream` (`:1823`, renderer built at `:1881`) | `analyse()` (prosody.js:920) then `speakablePhrases`: one generation per PROSODY PHRASE | neighbouring phrase texts (`:2108`, `:2109`); empty at the first and last phrase of the call | `elevenLabsText` (`:2052`) = `prepareForKokoro` espeak mode with `position: closing ? 'final' : 'continuation'` |
| 2 | `voice-engines.js:2192`, inside `synthesizeElevenLabs` (`:2157`) | `/voice/synthesize` (routes/voice.js:1024) | mode `prosody`: `analyse()` phrases (`:2172`); mode `flat`: `segmentForSynthesis` at 2,500 chars (`:2178`) | neighbouring units (`:2194`, `:2195`) | `elevenLabsText` (`:2173` per phrase, `:2176` whole reply) |

The builder itself reads `o.previousText` / `o.nextText` at `elevenlabs.js:269-270`
and bounds them by `CONTEXT_CHARS` (500) at `:271-272`, as F3 states. F3's open
question ("whether any call site passes them") is closed: both call sites do.

### 2.2 Every route that reaches it

| Route (routes/voice.js) | Text source | Segmenter | ElevenLabs call site | prev/next status at 13.34.0 |
|---|---|---|---|---|
| `POST /voice/synthesize` (`:878`), prosody on | whole reply, `body.text` | prosody phrases | #2 | populated between phrases; none at reply edges (correct, nothing there) |
| `POST /voice/synthesize` (`:878`), prosody off | whole reply | `segmentForSynthesis`, 2,500 chars, sentence-bounded | #2 | populated between segments; a reply under 2,500 chars is one generation |
| `POST /voice/synthesize/stream` (`:1256`) | whole reply | prosody phrases (`synthesizeProsodyStream`, call at `:1372`) | #1 | populated between phrases; none at reply edges |
| `POST /voice/synthesize/incremental` (`:1503`) | a BATCH: `splitStream` (`:1588`, voice-stream-split.js:292, `maxPhraseLength` 300) then joined at `:1675` | prosody phrases of the batch (`synthesizeProsodyStream`, call at `:1688`) | #1 | populated inside a batch; **EMPTY at every batch seam** (each batch is its own request; the renderer had no text outside it) |
| `POST /voice/prosody/analyse` (`:1819`) | n/a | n/a | none | n/a (analysis only, no synthesis) |

There is no ElevenLabs-only route and no text-to-dialogue path (F1 holds).

### 2.3 What the trace shows

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

### 2.4 The same table at 13.35.0

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

## 3. D5: strip-coverage audit

### 3.1 Token classes and where each was stripped before 13.35.0

| Class | Vocabulary (source) | Stripped for DISPLAY today | Reached an engine at 13.34.0? |
|---|---|---|---|
| Channel markers | `[OUTPUT] [TRACE] [RESULT]` (client 06b-output-marker.js:36, SPEC-OUT-MARK-001; also 07c-thought-trace.js) | yes, leading marker per paragraph, by the client renderer | **Yes**, on the incremental route: the client feeds the RAW reply (`pushIncremental(visibleText(textEl, full))`, 38-voice.js:2331; `finishIncremental(String(full))`, 38-voice.js:2368). Nothing in the connector stripped brackets (`stripMarkdown`, voice-stream-split.js:226, removes markdown syntax only). |
| Session directives | `[private-conversation] [forget]` (06b-output-marker.js:43, explicitly out of the channel marker's scope) | handled by their own client logic | **Yes**: on the incremental route (raw text), and in "speak this message" (`speakRow`, 38-voice.js:1848, reads `innerText` at :1850) wherever they remain in the rendered text. |
| Panel triggers | `[[TRAVEL_RESEARCH_FORM]] [[RECREATION_PANEL]]` (06-markdown.js:414, :423) | yes, replaced by a panel at render time | **Yes**, on the incremental route (raw text). Note `stripMarkdown` turns `[[TRAVEL_RESEARCH_FORM]]` into `[[TRAVELRESEARCHFORM]]` (underscores read as emphasis), so a strip by exact name AFTER it would miss it; the class strip catches both. |
| Audio / register tags | `[warm] [pause] [slowly] [softly] [drawn-out]`, live-confirmed SPOKEN on eleven_multilingual_v2 (W7 section 1). Written by the model; defined nowhere in code. | no | **Yes**, on every route. |
| Citation references | `[1]`, `[^2]` | no | Yes, every route. |
| Task-list boxes | `- [ ] item`, `- [x] item` | rendered as boxes | Yes; on the incremental route the bullet is stripped and phrases are joined with spaces, so the box can arrive mid-line. |

Excluded on purpose: `[label](target)` spans. They are markdown links (the
ElevenLabs profile and Kokoro's own pipeline keep the label) and our own misaki
markup (`[word](/ipa/)`, `[word](+2)`), which is how the Kokoro pipeline asks
for a pronunciation and must reach that engine. Also excluded: anything not in
brackets. No content word is changed.

### 3.2 Where each class is stripped at 13.35.0

| Point | What | Code (13.35.0) |
|---|---|---|
| Kokoro entries | `toEngineForm(text, 'kokoro')` = strip pass only, at the top of `synthesize`, `synthesizeProsody`, `synthesizeProsodyStream`, before heteronym marking and analysis | voice-engines.js:1178, :1729, :1845 |
| Kokoro request builder | the strip pass again on the PREPARED text (preparation flattens links and bold, which can uncover a marker: `[**warm**]` -> `[warm]`), then `assertTagless` before the worker | voice-engines.js:1248, :1268 |
| ElevenLabs text | `toEngineForm(text, 'elevenlabs')` for every generation and every context string: strip, prepare without contour, strip again | voice-engines.js:2119 (`elevenLabsText`) |
| ElevenLabs request builder | `assertTagless` on `text`, `previous_text`, `next_text` before the request | elevenlabs.js:308-310 |

The Kokoro assertion follows a strip of the same text, so it cannot fire for
anything the token classes describe. It is kept as the backstop for a future
change to the classes or to the preparation order; it does not fail a reply
today, and the mutation that removes it is not claimed as pinned (section 7).
An assertion that could fire on ordinary text would be worse than none on this
path, because Kokoro has no engine to fall back to.

The strip runs on the engine copy only. The connector never returns text to the
client; the displayed reply is untouched by construction (criterion 7).

### 3.3 The strip pass

`MARKER_REGISTER` names every vocabulary above. `TOKEN_CLASSES` catches the
shapes whether named or not:

| Class id | Shape | Examples |
|---|---|---|
| `double_bracket` | `[[` 1 to 80 characters `]]` | `[[RECREATION_PANEL]]`, `[[TRAVELRESEARCHFORM]]` |
| `upper_marker` | an all-capitals word of 3 to 40 characters (`_` and `-` allowed) | `[OUTPUT]`, `[TRACE]`, `[RESULT]` |
| `single_bracket_tag` | 1 to 4 LOWER-CASE words of letters, digits, `_ ' ’ -` | `[warm]`, `[drawn-out]`, `[private-conversation]`, `[sighs heavily]` |
| `reference` | `[1]`, `[12]`, `[^3]` (not a year) | citations |
| `checkbox` | a box at a line start, with or without a bullet | `- [ ] `, `[x] ` |
| `empty_box` | `[ ]` or `[]` anywhere | a box joined mid-line |

Every class except `double_bracket` refuses a match followed by `(` or `:`
(a link, misaki markup, a reference definition). Every class except
`double_bracket` and `checkbox` also refuses a match glued to a letter, digit,
`_`, `)` or `]` before it, so indexers (`a[i]`, `array[0]`, `m[1][2]`) are never
taken for markers. The pass repeats until nothing changes, so nested and
adjacent markers (`[note [1] here]`, `[warm][pause]`) go too, and the strip is
idempotent.

Kept on purpose, because they are content: mixed-case words (`[Enter]`,
`[Ctrl] + [C]`), years (`[2024]`), indexers, link labels (`[X](url)`).
Known consequence, accepted: an editorial bracket of one to four lower-case
words in prose (`he [the chair] agreed`) is removed from the SPOKEN copy. The
displayed text is unchanged. A model-written tag in capitals other than the
register's (`[Warm]`) is NOT stripped by shape; the live-confirmed tags are all
lower case.

### 3.4 Tests (src/tests/voice-engine-form.test.js)

* Floor first: the register is non-empty and has at least the 12 tokens of the
  source vocabulary before any scan runs.
* Both directions: the register equals the vocabulary read from source (every
  expected token is in the register; every register token is expected); every
  register token is matched by a token CLASS (so it is stripped by shape, not
  only by name); every class is exercised by a register token or an example (a
  class added later without a test fails).
* The scan: every token in six positions (start, middle, end, glued to a full
  stop, its own line, doubled), both profiles: result tagless and the word
  inside the brackets not spoken.
* Builders: a tag in `text`, `previous_text` or `next_text` is refused before
  any ElevenLabs request, and the error never echoes the text; `synthesizePcm`
  called directly, or with markers that only appear after preparation
  (`[**warm**]`, `[[a tag](url)]`, `[note [1] here]`, `[[]]`), renders and
  sends Kokoro no token; misaki emphasis markup survives.
* Content kept: `[Enter]`, `[Ctrl] + [C]`, `a[i]`, `m[1][2]`, `[2024]`, and a
  link labelled `x`; strip and both profiles idempotent on nested markers.
* Paths: the incremental route fed raw stream text with every class reaches
  neither engine with a token.

## 4. Rule table (elevenlabs profile), versioned

Version `engine-form/1 2026-10-06 (pin eleven_multilingual_v2)`. All rules are
candidates awaiting D3 and ship OFF. They are switched on by configuration:
`ELEVENLABS_PUNCTUATION="colon=period,semicolon=period"`.

| Mark | Matches | Candidate replacements | State | Evidence |
|---|---|---|---|---|
| colon | a colon between words; never `10:30`, `3:1`, `https:` | `period`, `comma`, `dash`, `break` | off | pending D3 (live by ear: a colon stops the utterance, F5) |
| semicolon | `;` followed by space or end | `period`, `comma` | off | pending D3 |
| emdash | the em dash U+2014 (any spacing), or a spaced en dash U+2013; never `cost-benefit`, `2019-2024` | `comma`, `space` | off | pending D3 |
| ellipsis | `…`, `...`, `. . .` | `period`, `comma` | off | pending D3 |
| parentheses | `(aside)` up to 200 characters | `comma` (`, aside,`) | off | pending D3 |

Not rules, by the work order: prose comma stripping (prohibited, section 6);
sentence terminators (kept: they coincide with generation boundaries); numbers,
dates, abbreviations (out of scope).

Break tags (`<break time="0.5s" />`, colon only):

| Gate | Value |
|---|---|
| D3 verdict | `ELEVENLABS_BREAK_TAGS_VERIFIED=true` is required. Unset (shipped): a full stop is written instead, never a tag. |
| Model | never on `eleven_v3` or `eleven_v4` (vendor: no SSML break support, F8). A pin move to either retires the mechanism automatically. |
| Count | at most `BREAK_LIMIT` = 2 per generation (vendor instability warning, F8); further colons become full stops. |

The Kokoro profile has no rules: markers only (criterion 10). No Kokoro
artefact has been demonstrated.

## 5. D2, D3, D4: calibration harness and results

### 5.1 Running it

```
ELEVENLABS_API_KEY=<key> ELEVENLABS_VOICE_ID=<voice> \
  node scripts/el-punctuation-sweep.mjs --out ./el-sweep
```

One command renders the whole sweep through the production adapter and writes
one 24 kHz WAV per case, `manifest.json` (the exact text of each request, and
whether neighbours were sent) and `RESULTS-TEMPLATE.md`. `--dry-run` writes the
manifest and template without a key; `--only d2,d3,d4` limits the groups;
`--model` changes the pin. The key is never written or printed (asserted).

| Group | Cases | Decides |
|---|---|---|
| D2 | `d2-i-one-generation` (unsegmented), `d2-ii-live-sentence` (13.35.0 live path), `d2-ii-live-phrase` (phrase units), `d2-ii-pre-w7-replica` (what 13.34.0 sent, contour commas included) | jumps only in the replica: ours, and fixed; jumps in d2-i too: vendor-side; both: stacked. The web-UI twin (paste the same text) needs no code. |
| D3 | 16 minimal pairs (comma, period, colon, semicolon, em dash spaced and closed, ellipsis character, dots and spaced, quotes, parentheses, hyphen, en dash, colon list); every candidate substitution from the rule table; the decisive raw break-tag case | per mark: artefact or clean, and the replacement chosen; break tag: pause (live) or spoken (dead) |
| D4 | three seams (sentence, comma, colon), each rendered cold, with context, and as one generation | whether `previous_text` / `next_text` removes the seam |

### 5.2 Results (to be filled in by ear)

Status at delivery: **not run**. No ElevenLabs key or listener was available
to the build, and the work order forbids fixing rules before these results
exist. The structural fixes in section 2.4 do not depend on them: they remove
generation boundaries at commas and colons inside a sentence, which D1 shows
exist, and they add no substitution.

| Diagnostic | Verdict | Date | Model |
|---|---|---|---|
| D2 comma cause (ours / vendor / stacked) | | | |
| D3 comma | | | |
| D3 colon (and chosen replacement) | | | |
| D3 semicolon | | | |
| D3 em dash | | | |
| D3 ellipsis | | | |
| D3 quotes | | | |
| D3 parentheses | | | |
| D3 hyphen vs en dash | | | |
| D3 break tag (pause / spoken) | | | |
| D4 seam with context (gone / reduced / unchanged) | | | |

After the results: set `ELEVENLABS_PUNCTUATION` (and, only on a "pause"
verdict, `ELEVENLABS_BREAK_TAGS_VERIFIED=true`), change the rows of section 4 to
`on` with the evidence, bump `ENGINE_FORM_VERSION`, and run
`npm run test:engine-form`.

## 6. Acceptance criteria

| # | Criterion | Status at delivery |
|---|---|---|
| 6 | By ear: comma and colon artefacts absent on the live path; joins no longer restart | **Open**: needs the sweep above with a key. The D1 causes (boundaries at commas and colons, the added comma, cold batch seams) are removed and pinned by tests. |
| 7 | Displayed reply unchanged | Met by construction: the formatter runs in the connector on the engine copy; nothing returns text to the client. |
| 8 | No bracketed token reaches either engine | Met: full-vocabulary test with floor and both directions; assertions at both builders; red under mutation (section 7). |
| 9 | Call-path inventory complete | Met: section 2. |
| 10 | Kokoro unchanged except marker stripping | Met: marker-free text returned byte for byte; a reply with markers produces exactly the Kokoro requests of the same reply without them; the fallback for a merged sentence produces exactly the Kokoro-only requests; the full pre-existing voice suites pass unchanged. |
| 11 | Tests non-vacuous; evidence pack | Mutation table below; DELIVERY-v13.35.0.json. |

## 7. Mutation evidence

Each mutation applied alone to the 13.35.0 tree, `node --test
src/tests/voice-engine-form.test.js`, then restored. 23 of the 24 turn the
suite red; the one that does not is named below and is not claimed as pinned.

| Mutation | Red tests |
|---|---|
| Kokoro profile does not strip | D5 scan; misaki untouched; criterion 10 path test; incremental survival path |
| ElevenLabs builder: `text` assertion removed | ElevenLabs builder |
| ElevenLabs builder: `previous_text` assertion removed | ElevenLabs builder |
| Kokoro builder: the strip of the prepared text removed | Kokoro builder (tokens uncovered by preparation) |
| Kokoro builder: assertion removed | **none**: it follows the strip above and cannot fire (section 3.2) |
| `checkbox` guard against links removed | misaki emphasis; content kept |
| indexer guard removed | content kept |
| a single strip pass | D5 scan; Kokoro builder; idempotence |
| no strip after flattening (ElevenLabs) | idempotence |
| ElevenLabs contour shaping restored (`continuation`) | idempotence; ElevenLabs profile; rules |
| tag class accepts capitals | content kept |
| No sentence merge | stream per sentence; buffered per sentence |
| Incremental route passes no context | incremental seam |
| Renderer ignores context | incremental seam |
| Merged fallback renders merged text | Kokoro fallback |
| Contour comma restored on ElevenLabs text | stream; buffered; incremental seam |
| `empty_box` class removed | coverage |
| `single_bracket_tag` class removed | coverage |
| Break tags allowed on v3 and v4 | break tags |
| Break tag not protected from the normaliser | idempotence |
| Break limit ignored | break tags |
| One register entry dropped | floor |
| Token classes off (name pass only) | scan; incremental survival path |
| A rule on by default | rules ship off; stream; buffered |

## 8. Not in this work order

Tag channel (model choice, dialogue endpoint, register-tag port): parked, W7
section 6. The two model defaults (gateway environment and the connector's
`ELEVENLABS_DEFAULT_MODEL`) are unchanged and remain a separate item (W7
section 7).
