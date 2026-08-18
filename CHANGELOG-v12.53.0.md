# CHANGELOG v12.53.0

Voice prosody layer, streamed synthesis, and the resident Piper worker.

Implements:

- **TS-VOICE-PROSODY-v1.0** — voice-agnostic prosody injection with an A/B switch
- **SPEC-VOICE-001-v1.2.0** — Components A, B, C, D, F
- **PIPER-PRELOAD-v1.1** — Changes 1 and 2 (resident worker, concurrency, pre-warm)

---

## Why the synthesis path changed shape

Piper applies `--length_scale` and `--sentence_silence` **globally** to a single
text input: one invocation carries one rate for everything it is given. That is
not a limitation to work around — it is the reason the current output sounds
metronomic. A single call per reply is structurally incapable of varying pace
within that reply.

So the path changes from one Piper call per reply to **one call per prosodic
phrase**, each with its own `length_scale`, joined with explicit silence. Every
feature below falls out of that one change:

| Goal | How the per-phrase split delivers it |
|---|---|
| Register and pacing | Each phrase carries its own `length_scale` |
| Pauses that mean something | Silence is inserted *between* phrases, in tiers |
| Emphasis | The stressed word becomes its own short unit, bracketed |
| Streamed playback | Phrase 1 can play while phrase 2 is still synthesising |

---

## New files

| File | Purpose |
|---|---|
| `src/voice/prosody.js` | The transform. Register detection, segmentation, emphasis, pace and pause assignment. |
| `src/voice/piper_worker.py` | Resident Piper worker. NDJSON over stdio, LRU voice residency. |
| `src/voice/piper-worker-supervisor.js` | Worker lifecycle: spawn, route, health, restart, idle unload, fallback. |
| `src/tests/voice-prosody.test.js` | 61 tests. AC1–AC7, the SPEC-VOICE-001 criteria, A1–A10. |
| `src/tests/voice-gpl-boundary.test.js` | 12 tests. **This file did not previously exist — see below.** |
| `scripts/voice-worker-smoke.mjs` | The Section 8 deployment gate. |

## Modified files

| File | Change |
|---|---|
| `src/voice/voice-engines.js` | `synthesizePcm` / `synthesizeProsody` / `synthesizeProsodyStream`; worker routing with CLI fallback; TTS queue; pre-warm; audio assembly. |
| `src/routes/voice.js` | `prosody` mode on `/voice/synthesize`; new `/voice/synthesize/stream` and `/voice/prosody/analyse`; health surface; boot pre-warm. |
| `src/server-http.js` | Compression filter now honours `X-Accel-Buffering: no`. |
| `package.json` | 12.52.0 → 12.53.0; four new test/smoke scripts. |

---

## The GPL boundary test did not exist

`voice-engines.js`'s own header comment says
`tests/voice-gpl-boundary.test.js` asserts the separate-process boundary "so
the boundary is verifiable in CI as Section 6.3 (compliance obligation 1)
requires". PIPER-PRELOAD-v1.1 §2.5 repeats the claim, written against this
source.

**There was no such file anywhere in the repository.**

The obligation was believed to be enforced in CI, was cited as enforced in a
specification, and was in fact enforced by nothing. That is worse than a
boundary everyone knows is manual, because nobody looks at it. It now exists
and asserts:

- No Node source imports a Python module or bridges a Python runtime.
- `piper_worker.py` is referenced as a path to `spawn`, never as an import.
- The worker runs on `VOICE_PIPER_PYTHON`, **never** `VOICE_PYTHON_BIN` — the
  MIT STT helper and the GPL worker must not share a `site-packages`.
- `voice_stt.py` never imports `piper`; `piper_worker.py` never imports
  `faster_whisper`; `requirements-voice.txt` never lists `piper-tts`.
- The child gets argv and pipes only: no shell, no wholesale env inheritance.
- With the gate off, nothing is spawned or warmed (A7).

---

## Prosody layer (TS-VOICE-PROSODY-v1.0)

### `length_scale` is inverse, and the spec's table reads as length scales

§5 is headed "Rate (relative)" and gives direct `0.94`, wry `1.08`. Read as
*rates* those are backwards — the same document calls a direct statement
"slightly quicker" and a wry one "a beat slower". Read as **length-scale
multipliers** they are exactly right, because `length_scale` scales *duration*:

```
length_scale 1.08  ->   8% LONGER  ->  SLOWER   (wry)
length_scale 0.94  ->   6% SHORTER ->  FASTER   (direct)
```

`PROSODY_RATE_*` is kept as the env var name because §9 fixes it, but the value
is a length-scale multiplier and the code says so everywhere it is touched.
Getting this backwards would invert the entire feature while still producing
audio, so the direction is pinned by assertion.

### Voice-agnostic (N2, AC6)

The layer holds no voice constant. Rates are **relative multipliers** against
whatever `inference.length_scale` the active voice's own `.onnx.json` declares;
pauses are **durations in milliseconds**, converted to samples at the voice's
own rate at concatenation. A test asserts the module contains no sample rate,
voice id or model path, and that changing the base scale changes every phrase's
scale proportionally while leaving segmentation and pauses identical.

### Three defects found and fixed during implementation

**1. The obvious superlative pattern re-paced ordinary prose.**
`/\b\w{4,}est\b/` fires on *request*, *suggest*, *interest*, *protest*,
*harvest*, *contest*. "The client sent a request." would have been paced as a
contrast sentence and given a stress bracket around a word carrying no
contrast. Now requires a determiner *and* passes a closed exception list.

**2. `"no"` in the abbreviation list broke sentence splitting.**
`He said "no". Then he left.` never ended a sentence, because the word before
the stop is `no` once the closing quote is trimmed — so the whole reply
synthesised as one phrase with no sentence pause anywhere in it. Ambiguous
abbreviations (`no`, `p`, `pp`, `fig`, `vol`) now require a following digit.

**3. AC1 was unsatisfiable as written.**
A wry punchline is short ("…, right"), and the general dwell rule refuses to
break off a fragment under three words — correct in general, because breaking
at every "and" turns a reply into confetti. The beat had nowhere to go. Added
an explicit wry-only final-clause split, applied only to sentences already
classified wry.

### Verified behaviour

```
AC1  wry      length_scale 1.08 (slower), 300ms beat before the final clause
AC2  direct   length_scale 0.94 (near baseline), key noun as its own unit,
              bracketed by 80ms each side, with a 1.06 rate dip
```

### Honest about the key-noun heuristic

There is no part-of-speech tagger and there will not be one: §5 specifies a
"deterministic, lexical pass … no ML model", and a tagger would also break N5.
The rule is stated in the source: discard the directness marker, discard
stopwords and anything under four characters, take the longest remaining token
breaking ties later. It is right often enough to be worth having and it is
wrong sometimes. Being wrong costs an 80 ms bracket on a neighbouring word.

---

## Streamed playback (Component D)

`POST /voice/synthesize/stream` returns NDJSON, one line per phrase, flushed as
each is synthesised. Base64 costs a third more bytes and buys framing, per-phrase
metadata, and an error channel that still works after the status line is spent.

Phrases are synthesised with bounded concurrency but **emitted in order** — a
pool that resolved out of order would deliver a fluent, confident, scrambled
sentence.

**Non-negotiable 7, no clicks:** two independently synthesised segments end and
begin at arbitrary sample values, so butting them together puts a vertical step
in the waveform — spectrally a broadband impulse, heard as a tick on *every*
phrase boundary. A 5 ms linear fade at each edge takes both sides of every join
to exactly zero. Capped at a third of the segment so a one-word emphasis unit is
not muted by its own fades.

**Compression would have silently killed this.** `compression()` buffers to
build deflate blocks. The gateway already excluded streams via
`X-Accel-Buffering`; the connector did not. Left alone, streaming would have
appeared to work, been no faster than the single-call route, and left nothing in
any log to explain why.

---

## Compare mode: a stated deviation from §7.2

§7.2 says `"both"` returns two audio **URLs**. URLs would require the connector
to *store* both recordings somewhere a later request could fetch them, and
Section 10 of the voice specification forbids exactly that: *"audio is processed
in memory or in temporary files deleted immediately after the request completes.
No recording is written to persistent storage."*

Inventing an audio store to satisfy a wording choice would trade a real privacy
control for a cosmetic one. Compare therefore returns **two base64 payloads in
one JSON response**, paired by a shared reply hash. AC5 asks that "compare mode
returns two audio outputs for one reply, and the flat output matches the
Off-mode output" — which this satisfies. The pairing the UI needs is the hash,
not the transport.

---

## The flat baseline is genuinely the old path (N4, AC3)

`synthesize()` is unchanged in behaviour. Its body moved to
`synthesizePcmViaCli()` and the argv it builds is byte-for-byte what v12.52.0
built — same flags, same conditional `--length_scale`, same env, same cwd, same
timeout. Piper's output depends on the model and the argv and nothing else,
which is what makes AC3's byte-identity claim checkable rather than hopeful.
`prosody:"off"` and Compare's flat half both call it directly.

An absent `prosody` field defaults to `"off"`, so **an older client that sends
nothing gets exactly what it got before.**

---

## Resident Piper worker (PIPER-PRELOAD-v1.1)

### The API version question, resolved by detection

There are two incompatible generations of the Piper Python API:

| | |
|---|---|
| rhasspy/piper 1.2.x (pinned) | `voice.synthesize_stream_raw(text, length_scale=…)` yields int16 PCM bytes |
| OHF-Voice/piper1-gpl 1.3+ | `voice.synthesize(text, syn_config=SynthesisConfig(length_scale=…))` yields AudioChunks |

The worker probes for each in turn at load, binds to whichever exists, and
reports which in its ready line and in `/voice/health`. §4.1 requires exactly
this: "the version-specific shape is absorbed inside the worker, not in the Node
caller." A third adapter writes a WAV into memory and strips the container, for
builds offering only `synthesize_wav`.

All three generations are covered by stub tests.

### Fallback is the point (A5)

`synthesizeViaWorker()` resolves to **`null`**, not a rejection, when the worker
cannot serve a request — not running, backing off, crashed, or returning
malformed PCM. Null routes to the CLI spawn. A synthesis *refusal* (empty text,
bad `length_scale`) still throws, because retrying it on the CLI path reaches
the same refusal more slowly.

The worst case of shipping this is therefore the status quo.

### Concurrency, and why the queue guards only the CLI path

TTS previously had **no concurrency control at all**: two synthesis requests
arriving together spawned two Piper processes, each loading its own copy of the
model, on an instance sized for one. That is items 3 and 4 of the corrected
diagnosis, and it was reachable from two browser tabs.

`VOICE_TTS_CONCURRENCY` (default 1) wraps the **CLI spawn only**. The resident
worker is serial by construction and holds one model however many requests are
pipelined at it, so queueing it as well would throttle the phrase pipeline for
no benefit. §5 says exactly this. STT and TTS queues are independent — one
blocking the other would mean a transcription silently delaying every reply's
audio.

### Boot pre-warm (A7 preserved)

Inside the `voiceEnabled()` guard, so with the master switch off no Piper
process is created and A7 stays verifiable from the process list. Deliberately
**not awaited**: Railway's health check has a deadline and loading a 61 MB ONNX
model takes seconds. Ordered after `provisionFromEnv()`, so on a first boot it
finds nothing installed and declines — one cold utterance, once, rather than a
failed deploy. `probeEngines()` stays lazy, asserted by test.

---

## New environment variables

All optional, all with safe defaults.

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_PROSODY_ENABLED` | `false` | The prosody layer master switch |
| `PROSODY_RATE_DIRECT` | `0.94` | Length-scale multiplier, direct register |
| `PROSODY_RATE_WRY` | `1.08` | Length-scale multiplier, wry register |
| `PROSODY_RATE_CONTRAST` | `1.02` | Length-scale multiplier, contrast register |
| `PROSODY_RATE_NEUTRAL` | `1.00` | Length-scale multiplier, default |
| `PROSODY_PAUSE_PARAGRAPH_MS` | `450` | Paragraph boundary |
| `PROSODY_PAUSE_SENTENCE_MS` | `250` | Sentence boundary |
| `PROSODY_PAUSE_DWELL_MS` | `120` | Comma / conjunction dwell |
| `PROSODY_PAUSE_EMPHASIS_MS` | `80` | Each side of a stress target |
| `PROSODY_EMPHASIS_DIP` | `1.06` | Rate dip on the stressed phrase |
| `PROSODY_WRY_BEAT_MS` | `180` | Extra beat before a wry final clause |
| `PROSODY_JOIN_FADE_MS` | `5` | Anti-click fade at each join |
| `PROSODY_MAX_PHRASES` | `120` | Ceiling; the tail is merged, never truncated |
| `PROSODY_MIN_PHRASE_CHARS` | `2` | Below this, merge backwards |
| `VOICE_TTS_WORKER_ENABLED` | `true` | Resident worker; false reverts to CLI |
| `VOICE_TTS_PREWARM` | `true` | Warm the default voice at boot |
| `VOICE_TTS_CONCURRENCY` | `1` | CLI synthesis queue width |
| `VOICE_TTS_RESIDENT_VOICES` | `1` | Voices held loaded (LRU beyond) |
| `VOICE_TTS_WORKER_IDLE_MS` | `300000` | Idle before releasing the model |
| `VOICE_TTS_PHRASE_CONCURRENCY` | `2` | Phrases synthesised in parallel |
| `VOICE_PIPER_PYTHON` | *(venv)* | Interpreter for the worker. **Never the STT one.** |

### `VOICE_PROSODY_ENABLED` ships `false`, deliberately

§9 says "default true after ship"; §10 says ship with it present but `false` and
flip after the A/B comparison confirms the tuning. Those describe two moments,
and the **code** default has to be the first: shipping `true` would deploy
untuned prosody to every user before anyone had listened to it.

---

## Test results

```
src/tests/voice-prosody.test.js       61 passed
src/tests/voice-gpl-boundary.test.js  12 passed
src/tests/voice.test.js               47 passed  (pre-existing, no regression)
src/tests/voice-auth.test.js          29 passed  (pre-existing, no regression)
```

---

## Open gates — these have NOT been run

Two gates from PIPER-PRELOAD-v1.1 §8 **cannot be closed from a development
environment** and remain open:

1. **The smoke test (§8 item 1)** is built and ships as `npm run voice:smoke`.
   It has been verified to *fail cleanly and name the fix* when Piper is absent.
   It can only **pass** against the real venv on Railway. Until it does,
   synthesis runs on the CLI fallback — working, just not warm.

2. **The p50/p95 benchmark (§8 item 2)** on the real Railway CPU. §8 is explicit
   that no defaults are locked until it confirms them. `VOICE_TTS_THREADS`,
   `VOICE_TTS_PHRASE_CONCURRENCY` and the A1 latency target are provisional.

3. **The memory budget (§8 item 3)** — combined resident footprint of the Piper
   worker plus the STT worker — is unmeasured. `VOICE_TTS_RESIDENT_VOICES`
   defaults to 1 to keep the footprint at what one CLI spawn already peaked at.

## Not implemented

**Change 3, the resident STT worker (§6).** Explicitly separable —
"this change is separable from Changes 1 and 2 and can land second" — and it
carries its own memory trade-off that the §8 item 3 measurement has to settle
first. Holding Whisper and Piper resident simultaneously may exceed a small
instance. The recommended rollout in §10 says to land Changes 1 and 2 as one
unit, which is what this is.

**Overlap 2, generation-to-synthesis (Component D).** The API supports it: the
stream endpoint takes text and emits phrases, so feeding it partial text as the
model produces it needs no connector change. Wiring it requires the *client* to
push sentences during generation, which touches the chat renderer. Overlap 1 is
implemented and satisfies AC15 as written ("start of playback on phrase 1 while
later phrases are still being generated **or synthesised**").
