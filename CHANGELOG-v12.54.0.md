# CHANGELOG v12.54.0

Resident speech-to-text worker.

Implements **PIPER-PRELOAD-v1.1 §6, Change 3** — the third and last change in
that specification. §6 marks it "separable from Changes 1 and 2 and can land
second", which is what this is.

---

## The cost being removed

Change 1 removed the Piper model load from synthesis. This removes the larger
one: `WhisperModel` is constructed from scratch on **every** transcription —
roughly 2–4 seconds on the base tier before a single sample of audio is looked
at, paid again and again for an identical result.

It also lands where a user feels it most. They have finished speaking and are
watching an empty composer, waiting to see their own words.

---

## New files

| File | Purpose |
|---|---|
| `src/voice/stdio-worker.js` | Shared NDJSON-over-stdio worker lifecycle. |
| `src/voice/voice_stt_worker.py` | Resident Whisper worker. |
| `src/voice/stt-worker-supervisor.js` | STT-specific configuration over the shared lifecycle. |
| `src/tests/voice-stt-worker.test.js` | 34 tests, including live behavioural coverage. |

## Modified files

| File | Change |
|---|---|
| `src/voice/piper-worker-supervisor.js` | Refactored onto `stdio-worker.js`. Behaviour unchanged. |
| `src/voice/voice-engines.js` | `transcribe()` routes to the worker, falls back to the spawn. |
| `src/routes/voice.js` | `stt_worker` block in `/voice/health`; boot pre-warm. |
| `src/tests/voice-gpl-boundary.test.js` | Extended: 12 → 19 tests. |
| `.env.example`, `package.json` | New variables; 12.53.0 → 12.54.0. |

---

## The lifecycle was extracted rather than copied

Change 1 shipped ~400 lines of worker supervision in
`piper-worker-supervisor.js`: spawn with a minimal environment, NDJSON line
framing, id-based response routing, per-request timeouts, exponential restart
backoff, idle unload, health reporting, and the null-means-fall-back contract.

The STT worker needs **all of it**, differing only in interpreter, script,
environment and request shape. Copying would have produced two divergent copies
of the code that owns every child process this connector runs — and the next
person to fix a race in one would have had no reason to know about the other.

So `stdio-worker.js` is a factory taking a spec, and both supervisors are thin
configuration over it. `stt-worker-supervisor.js` is 231 lines and holds no
lifecycle logic at all.

**The Piper refactor is behaviour-preserving**, verified by re-running the
prosody suite (61) and the boundary suite unchanged.

---

## A real defect the refactor exposed: the event loop never released

`voice.test.js` began passing all 47 assertions and then **hanging forever**.

A spawned child and each of its three stdio pipes are referenced libuv handles,
so Node keeps the event loop open while any exist. A worker doing its job
correctly — idle, holding a model, blocked on stdin — was therefore
indistinguishable from unfinished work.

In the server this is invisible, because the HTTP listener holds the loop open
anyway. **Everywhere else it means the process never exits**: tests, scripts,
one-shot CLI invocations, and any future `npm run` that touches voice. It would
have shipped, because the server is the one context where it cannot be seen.

```js
child.unref();
if (child.stdout) child.stdout.unref();
if (child.stderr) child.stderr.unref();
if (child.stdin)  child.stdin.unref();
```

The pipes are unreferenced individually because `unref()` on the child releases
only the process handle; the three stream handles are separate and each holds
the loop on its own. The per-request timeout timer got the same treatment.

### And the corollary

Unreferencing means Node will happily exit while a worker is still running,
**orphaning** a process holding a multi-hundred-megabyte model. On a host where
the connector restarts in a loop, that is an accumulating leak made of abandoned
Python processes.

So `LIVE_WORKERS` tracks every child and a single reaper — installed once,
however many workers exist — kills them on `exit`, `SIGINT` and `SIGTERM`.
`SIGKILL` rather than `SIGTERM`, because `exit` handlers cannot do asynchronous
work and there is no later in which to escalate.

---

## Three residency states, not two

§6: *"because holding Whisper plus Piper resident simultaneously may exceed a
small instance's memory, STT residency is independently configurable."*

That is two switches, and they are not redundant:

| `ENABLED` | `RESIDENT` | Behaviour |
|---|---|---|
| `false` | — | Per-request spawn. The pre-v12.54.0 path exactly. |
| `true` | `false` | Process stays warm; **model released after each request.** |
| `true` | `true` | Model stays loaded. |

The middle state is the one worth having and the easiest to omit. It still saves
the interpreter start and the `faster_whisper` import — over a second, because
CTranslate2 pulls in a large native extension — while holding no model between
requests. On a tight instance running Piper resident too, that is the setting
that fits.

The **import** is held even when residency is off: it costs a second or more and
allocates almost nothing that scales with the model, so releasing it would give
back no meaningful memory while paying the cost every time.

Release happens in a `finally`, so a *failed* transcription does not leave a
model resident that the operator explicitly asked not to hold. A tier change
releases before building, never peaking at two models on the instance that can
least afford it.

---

## Output shape parity

The worker uses identical transcription parameters — `beam_size=5`,
`vad_filter=True`, `language or None`, `device="cpu"`, `compute_type="int8"`,
`download_root` pinned — and the supervisor strips the protocol envelope, so
`transcribe()` returns the same object either way and **cannot tell which path
produced it**.

This is asserted by running the real worker, not by reading it. An early version
of the test stubbed `load`/`unload` and silently tested the stub instead of the
shipped code; the tests now replace only `WhisperModel` and exercise the real
residency logic.

---

## The GPL boundary, extended

`stdio-worker.js` now spawns **both** the GPL Piper worker and the MIT STT
worker, which makes interpreter separation a matter of what is passed in rather
than of which file does the spawning. That is a weaker structural position, so
the boundary test was extended (12 → 19) to assert it directly:

- `stt-worker-supervisor.js` resolves `VOICE_PYTHON_BIN` and **never**
  `VOICE_PIPER_PYTHON`.
- `piper-worker-supervisor.js` resolves `VOICE_PIPER_PYTHON` and **never**
  `VOICE_PYTHON_BIN`.
- The two supervisors pass **different** interpreter resolvers to the factory.
- `voice_stt_worker.py` imports `faster_whisper` and never `piper`, `piper_tts`,
  `piper_phonemize` or `espeak`.
- Neither worker is ever `import`ed by Node; both are spawned as paths.
- Assertions run against **comment-stripped** source, so prose explaining which
  variable must not be used cannot satisfy or break them.

---

## New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_STT_WORKER_ENABLED` | `true` | Resident worker; `false` reverts to the spawn |
| `VOICE_STT_WORKER_RESIDENT` | `true` | Hold the model; `false` for tight memory |

Both default on, because the fallback makes the worst case the previous
behaviour. Unlike `VOICE_PROSODY_ENABLED`, there is nothing to tune by ear here
— the output is byte-identical, only faster.

---

## Test results

```
src/tests/voice-stt-worker.test.js     34 passed   (7 run the real worker)
src/tests/voice-gpl-boundary.test.js   19 passed   (extended from 12)
src/tests/voice-prosody.test.js        61 passed   (no regression after refactor)
src/tests/voice.test.js                47 passed   (was hanging; now exits)
src/tests/voice-auth.test.js           29 passed
```

Every other connector suite was run individually and passes.
`render-tools.test.js` fails one assertion — it fails identically on the
untouched v12.52.0 baseline and is unrelated to voice.

---

## Still open

Unchanged from v12.53.0, and Change 3 adds to the third:

1. **The smoke test (§8 item 1)** — `npm run voice:smoke`, needs the real venv.
2. **The p50/p95 benchmark (§8 item 2)** — no defaults are locked until it runs.
3. **The memory budget (§8 item 3)** — now the *combined* resident footprint of
   Piper plus Whisper, which is exactly the measurement §6 says
   `VOICE_STT_WORKER_RESIDENT` exists for. **Until it is measured, consider
   setting `VOICE_STT_WORKER_RESIDENT=false` on a small instance**: it keeps
   most of the latency win at no continuous memory cost.

All three specifications are now fully implemented apart from these
deployment-only gates.
