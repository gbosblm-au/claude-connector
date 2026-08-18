# CHANGELOG v12.54.1

Hotfix. **The resident-worker fallback did not fall back.**

Reported in production 2026-08-18:

```
[voice] piper worker ready (pid=123)
[voice] tts_failed: ModuleNotFoundError: No module named 'piper'
[voice] tts_error code=synthesis_failed status=500 elapsed_ms=110
```

Voice synthesis was down. A working CLI fallback sat one branch away and was
never tried.

**Immediate mitigation, no redeploy:** `VOICE_TTS_WORKER_ENABLED=false`.

---

## Root cause: five defects, one of them mine twice over

### 1. The fallback classification was inverted (the one that took voice down)

`stdio-worker.js` had an **allowlist** of three codes that fell back:

```js
const infrastructure = ['worker_unavailable', 'worker_gone', 'worker_timeout'];
if (infrastructure.includes(err.code)) return null;
throw err;                                   // everything else
```

A worker that could not `import piper` returned the generic `synthesis_failed`,
which was not on that list, so it propagated as a 500.

The asymmetry of the two possible mistakes is the whole argument, and I had it
backwards:

| | Cost |
|---|---|
| Fall back when we should have thrown | one wasted retry, then the same clear error |
| Throw when we should have fallen back | **the feature is down** |

Now inverted: fall back by default, and each supervisor **names** the codes that
must not. `synthesis_failed`, `piper_import_failed` and `model_load_failed` are
deliberately absent from Piper's refusal list — all three can be true of the
resident worker while the CLI binary works perfectly. They reach Piper by
different routes; the Python module being missing says nothing about the binary.

A novel failure nobody anticipated now degrades instead of failing the turn.

### 2. The worker announced "ready" before it could do anything

`serve()` wrote the ready line at startup and deferred the import to the first
request — hence a log reading `worker ready (pid=123)` directly above
`ModuleNotFoundError`. The worker advertised a capability it did not have, and
the supervisor had no reason to doubt it.

It now verifies the import first and emits `{"type":"fatal"}` instead, which the
supervisor treats as a failed **start** — a state it already handled correctly.

### 3. The interpreter default guessed, and guessed wrong by construction

```js
return existsSync(venv) ? venv : 'python3';   // before
```

The system python is the one interpreter we can be confident does **not** have
piper, because piper lives in its own directory precisely to keep a GPL
dependency out of everything else. So when `VOICE_PIPER_DIR/venv` was absent,
this reliably spawned a worker that could never work.

Now returns `''`, and an unresolved interpreter makes the supervisor decline to
spawn at all.

### 4. My `unref` fix from v12.54.0 went too far

v12.54.0 unreferenced the child and its pipes to stop an idle worker holding the
process open. With nothing referenced, **nothing held the loop while a request
was in flight** — Node could exit mid-synthesis and the caller's promise would
never settle. No error, no timeout, no log line.

Invisible in the server, because the HTTP listener holds the loop regardless.
The same trap as the original defect wearing the opposite face.

The reference now tracks **busyness** rather than existence (`holdLoop` /
`releaseLoop`), which is what was meant all along.

### 5. Two request outcomes leaked that reference

Four ways a request can end; three were unwinding by hand and two of those never
released. A single timeout would have pinned the process open. All four now route
through one `settle` wrapper, guarded against double-settle — reachable, since a
worker can answer in the same tick its deadline expires.

---

## A test that explained away the bug

The boundary suite contained this, and it **passed**:

> …when it is absent the worker cannot import piper anyway, so it never starts
> and the CLI path serves synthesis.

Both halves were false. The worker did start, and synthesis did not fall back.
The reasoning was doing the work an assertion should have been doing.

That comment is now retained in the test as a marker, because a test that
rationalises the behaviour it is meant to constrain is worse than no test: it
makes the next reader confident.

Two regression tests were added that run the **real** supervisor against a real
interpreter without piper, asserting it falls back, reports `fatal`, and exits
cleanly. Every structural assertion in the suite passed while this was broken;
only running it catches it.

---

## Also new

`/voice/health` → `tts_worker.fatal`. True when the engine is structurally
unavailable to that interpreter. Distinguished from `last_error` because it is
the one state an operator must **act** on — everything else self-heals. A fatal
worker also goes straight to the 120 s backoff ceiling rather than climbing
2s/4s/8s through a failure that cannot resolve itself.

---

## Test results

```
voice-prosody         63 passed  (2 new regression tests)
voice-gpl-boundary    19 passed  (1 rewritten)
voice-stt-worker      34 passed  (1 rewritten)
voice                 47 passed
voice-auth            29 passed
```

---

## Still required

This is the failure `npm run voice:smoke` exists to catch, and it is still the
open gate from §8. **Run it before re-enabling the worker:**

```bash
npm run voice:smoke
```

It reports which interpreter it used, whether `piper` imports there, and which
API adapter bound. With v12.54.1 a failure here is no longer an outage — it
degrades to the CLI path — but it does mean the latency win is not being
delivered.
