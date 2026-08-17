# v12.46.0 — Tenax Voice, connector half (Phase 1)

Implements the Tenax Voice STT & TTS specification, connector side. Ships
**gated off**. No engine loads and no child process starts until
`VOICE_ENABLED=true`.

---

## The specification assumed a Python connector

Section 3 places the voice engine "inside the connector's Python runtime" and
says faster-whisper is "importable as a library because it is MIT-licensed."

This connector is Node.js. `package.json` declares `"type": "module"`, `main:
src/index.js`, every source file is `.js`, and there is no `requirements.txt`,
`pyproject.toml` or `setup.py`. `pip install faster-whisper` puts nothing in a
Node import graph.

The MIT-vs-GPL distinction in Section 6 was doing real architectural work — MIT
meant "safe to import in-process", GPL meant "must be a subprocess". On Node,
**both engines are subprocesses regardless of licence.**

That is a *stronger* boundary than the one specified, and worth being precise
about why rather than treating it as a lucky escape:

- Nothing GPL is imported by anything of ours, because our code is Node and
  Piper is Python/C++. There is no import graph to contaminate.
- Piper runs from its own directory, via its own interpreter, installed into its
  own venv. It never shares a process with `voice_stt.py` either, so even the
  MIT Python we do control is not linked to it.
- Communication is argv in, WAV bytes out over stdout. No FFI, no shared memory.

Confirmed by you as forced and correct, and it makes Phase 2 extraction cleaner:
a subprocess boundary is already a service boundary.

`src/routes/volume-snapshot.js` set the precedent — it already spawns a Python
helper with an argv array, and states "No npm dependencies are added." Both
disciplines are followed here.

---

## The GPL boundary is verifiable in CI

Compliance obligation 1 asks for the boundary to be "documented, verifiable in
CI". Three tests in `src/tests/voice.test.js` do that:

- **`voice_stt.py` never imports or executes Piper.** Comments and docstrings
  are stripped before the check, so a mention in prose cannot satisfy or trip
  it. It also asserts the file *does* use faster-whisper, or an empty file would
  pass trivially. Collapsing both engines into one helper is the easy refactor
  and would destroy the boundary, so it is asserted rather than trusted.
- **Piper is spawned as its own process, from its own directory,** with an
  explicit minimal environment. `env: process.env` is asserted absent — Node
  hands a child the entire parent environment by default, which here includes
  API keys and the database URL. Section 11 requires least privilege.
- **Nothing matching `/piper/i` is a declared npm dependency.**

`requirements-voice.txt` (MIT, faster-whisper) and `requirements-piper.txt`
(GPL, separate venv) are deliberately two files. Installing Piper alongside
faster-whisper would put GPL code in the interpreter our MIT helper imports
from, which is where the entanglement starts.

**Fallback documented with the consequence stated plainly:** `piper-plus` (MIT,
no espeak-ng) covers JA/EN/ZH/KO/ES/FR/PT/SV and has **no Vietnamese**. Taking
that path drops a locked launch language entirely.

---

## Every voice is refused until its MODEL_CARD is audited

Compliance obligation 2. `voice-catalog.js` ships all five launch voices with
`licence: null` and `audited: false`, and `catalogState()` reports **`usable: 0
of 5`**.

That is not incompleteness. **No MODEL_CARD has been read** — this was written
without network access to HuggingFace, and the specification records default
voice *names*, not their licences. Writing `licence: 'CC BY 4.0'` from inference
would put a fabricated compliance record exactly where a lawyer would later
look.

Design choices that follow from taking the obligation seriously:

- **An allowlist, not a blocklist.** A voice added to `rhasspy/piper-voices`
  tomorrow is refused by default rather than used by default.
- **`audited` is separate from `commercial_ok`.** "Nobody has looked" and
  "audited and found non-commercial" are different facts. In the database,
  unverified is `NULL`, not `0`.
- **Explicit non-commercial is refused even with `VOICE_AUDIT_REQUIRED=false`.**
  A known-bad answer is not a missing one.
- **`attributions()` returns only audited voices.** An attribution page that
  invents credits is worse than a short one.

`POST /voice/synthesize` therefore returns **422 `no_voice_available`** today,
with a message explaining the audit. That is the honest state, and it is
asserted.

---

## The gate inverts the house style, deliberately

Sixteen existing flags (`SNAPSHOT_ENABLED`, `MEMORY_ENABLED`, …) read
`!== 'false'` and default **on**. `VOICE_ENABLED` requires the literal string
`'true'` and defaults **off**.

Voice ships with three open gates: an unrun Phase 0 benchmark (Section 14, hard),
unresolved legal sign-off (Open Item 1), and an incomplete licence audit. A
feature in that state must not enable itself because a variable was left unset —
which is exactly what opt-out would do on every existing deployment.

`VOICE_ENABLED=ture` leaves voice off. Whitespace *is* trimmed, because a
trailing space in a Railway variable is a common accident and `TRUE ` plainly
means true; the strictness that matters is that misspellings fail.

**Open Item 2 resolved by evidence.** All sixteen existing flags are bare
`<FEATURE>_ENABLED` with no prefix. `VOICE_ENABLED` matches the convention; no
Tenax prefix.

### Three layers (Section 7)

1. **Startup** — the route module is imported, but it pulls in only the gate and
   the catalogue: plain data and pure functions. No engine import, no spawn. With
   `VOICE_ENABLED` unset, nothing about voice runs, verifiable from the process
   list.
2. **Route** — 404, *not* 403. A 403 confirms the feature exists and is switched
   off, which is a different statement.
3. **UI** — `gateState()` returns `render_voice_ui: false` and forces
   `stt_ready`/`tts_ready` false when off, so a UI has no grounds to render
   anything. Section 7 wants elements "absent from the DOM, not merely hidden".

`degraded` is distinct from `off`: off emits nothing, degraded emits a disabled
control that explains itself.

---

## Audio is ephemeral, and the schema cannot hold content

- STT writes to a per-request `mkdtemp` directory under the OS temp root, never
  under `/data` (the Railway volume), removed in a `finally` so it goes even when
  the engine throws or times out. That is what makes Section 16's "temporary
  directory is empty after each request" true rather than aspirational.
- TTS never touches disk — Piper writes WAV to stdout.
- The uploaded filename is **never** used to build a path. The engine chooses the
  name, in a directory it owns, so a traversal payload has nowhere to go.
- `voice_usage_log` has exactly seven columns and **no free-text column** for
  someone to put a transcript in later. `logVoiceUsage()` has no `text`
  parameter, so a future caller cannot pass one by accident — the type is the
  control. Asserted, including a check that `text`, `transcript`, `audio`,
  `content`, `filename` and `path` columns are all absent.
- Logging is metadata only: duration, language, byte and character counts.

---

## Details that would have been bugs

- **Piper's `--length_scale` is inverse.** Passing a speed multiplier straight
  through would make "1.5× speed" play half as fast.
- **WAV duration walks the RIFF chunk list** rather than assuming the canonical
  44-byte header. Recorders routinely emit `LIST` or `fact` chunks first, and the
  fixed offset reads the wrong length for those files. Asserted with a
  `LIST`-bearing WAV.
- **Magic bytes, not `Content-Type`.** The declared type is caller-supplied and
  means nothing; a file claiming `audio/wav` can hold anything, and this payload
  goes to a decoder. A mismatch is rejected rather than resolved in favour of the
  bytes — quietly accepting it hides the caller's bug.
- **Duration is bounded, not decoded.** Getting an exact duration means decoding,
  which is the very work being rationed, so the check would cost what it
  protects. WAV is exact; compressed formats are bounded from size using a
  deliberately low floor bitrate, which errs toward rejecting.
- **The STT model tier is an allowlist.** That value reaches a loader that
  fetches by name from a remote registry, and Section 15 pins downloads to
  HuggingFace only — an arbitrary name is an arbitrary fetch.
- **base64 multipart parts are refused**, not passed through undecoded, which
  would hand the decoder something that is not audio.
- **The first benchmark run is discarded.** It pays the model download and load;
  including it would report cold-start as steady-state and make every tier look
  like it misses budget.
- **Auth fails closed.** An unauthenticated deployment must not get free
  transcription because middleware order changed. Opting out is explicit
  (`VOICE_ALLOW_UNAUTHENTICATED`).
- **STT is serialised** (`VOICE_STT_CONCURRENCY=1`). Section 12's budgets assume
  one utterance on a shared CPU; concurrent Whisper runs miss every line.

---

## What is NOT locked, and must not be

Section 14: *"Gate is hard: no defaults ship until the benchmark confirms the
Section 12 budgets."*

`VOICE_STT_TIER=base` and the five catalogue voices are **candidates from Tables
1 and 2, not measurements.** `/voice/health` reports `benchmark_completed: false`
so an operator can see at a glance that voice is answering on provisional
defaults. `VOICE_BENCHMARK_COMPLETED=soon` does not satisfy the gate — a value
that will not parse as a date counts as not completed.

`scripts/voice-benchmark.mjs` is the gate. It measures real-time factor,
first-byte latency and end-to-end time against the Section 12 table, prints the
largest STT tier that fits (accuracy rises with tier, so the right default is the
biggest the CPU sustains, not the fastest), and prints the values to lock. **It
does not write configuration** — a benchmark that silently rewrote the defaults
it was meant to validate would be marking its own homework.

---

## Files

**New**

| Path | Purpose |
|---|---|
| `src/voice/voice-gate.js` | Feature gate, three layers, benchmark state |
| `src/voice/voice-catalog.js` | Commercial-OK allowlist and licence audit |
| `src/voice/audio-validate.js` | Magic bytes, size and duration limits |
| `src/voice/multipart.js` | Minimal multipart reader, no npm dependency |
| `src/voice/voice-engines.js` | STT and TTS process supervisors; GPL boundary |
| `src/voice/voice_stt.py` | faster-whisper helper (MIT) |
| `src/voice/voice-schema.js` | The three Section 9 tables |
| `src/voice/requirements-voice.txt` | MIT dependencies |
| `src/voice/requirements-piper.txt` | GPL, separate venv, with the fallback |
| `src/routes/voice.js` | Section 8 API contract |
| `src/tests/voice.test.js` | 21 tests |
| `scripts/voice-benchmark.mjs` | Phase 0 gate |

**Modified** — `src/server-http.js` (route registration, two lines),
`.env.example`, `package.json` (12.45.0 → 12.46.0, plus `test:voice` and
`voice:benchmark` scripts).

Zero npm dependencies added.

---

## Verification

- `src/tests/voice.test.js` — **21 passed**.
- Every other suite re-run: `phase0-security` 61, `edit-tools` 50,
  `tool-call-guard` 43, `validation-tools` 38, `personal-chef` 29,
  `signed-urls` 28, `volume-snapshot` 26, `upload-retention` 21,
  `brain-scan-manual-only` 20, `script-audit-register` 17,
  `internal-config-custom-env` 31, `manifest-fragments` 13,
  `retention-calibration` 9, `preview-signature-alignment` 10,
  `profiles-postgres` 7.
- `render-tools.test.js` fails one assertion ("download contract"). **Confirmed
  pre-existing** — identical failure on the pristine 12.45.0 upload.

---

## Not done

- **`ts-client-gateway` UI.** Per your scope call: connector gate now, UI wired
  when the engine actually transcribes. `gateState()` is the contract it will
  consume.
- **Phase 3 streaming** (`WebSocket /voice/stream`) — out of scope per Section 8.4.
- **Opus/MP3 transcode.** `format: 'mp3'` returns 422 rather than claiming a
  format we do not produce.
- **No engine has ever run here.** faster-whisper and Piper are not installed in
  this environment and the models are large. Every test above exercises the gate,
  boundary, contract and compliance controls — the parts that must be right
  before an engine is wired, and that stay right when one fails. The first real
  transcription will happen on Railway, and the benchmark is the tool for it.

## Next

1. Build the image with `python3 -m venv /data/voice/piper/venv` and both
   requirements files installed to their separate prefixes.
2. Pre-download models and voices to the volume (Section 11).
3. `VOICE_ENABLED=true`, then `npm run voice:benchmark` with a 10-second sample
   per launch language.
4. Per-voice MODEL_CARD audit; record findings in `voice-catalog.js`; set
   `VOICE_AUDIT_REQUIRED=false`.
5. Set the Vietnamese quality threshold (Open Item 4) from what the benchmark
   actually produces.
6. Legal read on the GPL boundary before commercial release.
