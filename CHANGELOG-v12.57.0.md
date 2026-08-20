# v12.57.0 — Kokoro worker supervisor and the two-tier fallback (part 3)

**This release changes no behaviour.** TTS still runs on Piper. The supervisor
lands, wired into nothing.

Last of the additive releases. The next one edits `voice-engines.js`, deletes
Piper, and is the only one that changes what a user hears.

## What is in this release

**`src/voice/kokoro-worker-supervisor.js`** — the Node side. Same public API as
`piper-worker-supervisor.js`, so the swap is a change of engine rather than a
rewrite of the caller.

**`kokoro_worker.py`** — gains `--once`.

## The finding that made `--once` necessary

Under Piper there were always **two** routes to audio: the resident worker, and
a fresh `piper` binary per utterance. `voice-engines.js` is built around that —
a null answer from the worker means "fall back", and the CLI spawn carries the
request. That is why a crashed or backing-off worker cost *latency* rather than
*speech*.

**Retiring Piper deletes that second route.** Left alone, the resident Kokoro
worker would become a single point of failure for all speech: one bad model
load, one OOM kill, and the platform is mute with no path back until a restart.

So the subprocess mode of Section 7.1 is kept as the second tier rather than
discarded after the evaluation phase. `synthesizeOnce()` runs the **same script**
with `--once`: one request in, one response out, then exit. Same code, same
request shape — `synthesisRequest()` is shared by both tiers, because a
divergence there would be the worst kind of bug: audio that changes character
when the worker happens to be unhealthy.

It pays a full model load per utterance, which is precisely the cost the
resident worker exists to avoid. That is the right trade for a degraded path
nobody should normally be on. `VOICE_TTS_SUBPROCESS_FALLBACK` defaults to on,
and switching it off is a deliberate choice to accept total voice loss on worker
failure.

## The refusal list is where the two tiers are reasoned about

Codes that must **not** fall back, because a second process reaches the same
answer more slowly: `empty_text`, `invalid_length_scale`, `invalid_sample_rate`,
`no_voice`, `unknown_voice`, `unknown_op`, `bad_request`.

Note what is deliberately **absent**: `synthesis_failed`,
`kokoro_import_failed`, `no_audio`. Every one of those can be true of a sick
resident worker while a fresh process works perfectly — a worker whose model got
corrupted in memory, or one OOM-killed mid-request, says nothing about whether a
new process can load the same file from disk.

`unknown_voice` *is* a refusal, because the bundle on disk is the same bundle
either way.

## Two lessons carried over from the Piper supervisor rather than relearned

**An interpreter guess that is wrong by construction is worse than no guess.**
`kokoroPython()` returns **empty** rather than `python3` when no venv is found.
The system python is the one interpreter we can be confident does *not* have the
engine installed — the venv exists precisely to keep the dependency out of
everything else. Piper's supervisor fell back to it and reliably produced a
worker that started cleanly, reported ready, then failed every request with
ModuleNotFoundError. Empty makes `startWorker` decline, and synthesis takes the
one-shot path.

**A SIGKILL is named, not reported as `exited null`.** `describeOneShotFailure()`
reports a signal by name and calls SIGKILL what it almost always is on a small
container: the kernel's OOM killer, because onnxruntime holds the model plus its
arenas. "Exited null with no audio" names neither the cause nor where to look,
and this is the exact failure mode the tier exists to survive.

## The GPL boundary moved with the engine

Kokoro-82M is Apache-2.0, so the process boundary looks like ceremony now. It is
not: kokoro-onnx phonemises through `phonemizer`, which drives **espeak-ng, which
is GPL-3.0**. The separation is still a difference in the interpreter each
supervisor supplies — `VOICE_KOKORO_PYTHON` here, `VOICE_PYTHON_BIN` for the MIT
STT worker — and `VOICE_PYTHON_BIN` is never read in this file.

## Smaller decisions worth knowing

**The last stdout line is parsed, not the first.** The child writes only protocol
frames, but a dependency printing an import warning to stdout would otherwise
become the response.

**`bundleVoices()` returns null, never an empty array.** Null means "nothing has
reported yet" (boot, or worker disabled); empty would mean "the bundle holds
nothing". The registry treats them differently, and collapsing the two would
narrow the offered voice set to zero during startup and make the platform look
mute.

**An odd byte count is a fault, not a glitch.** Handing the WAV writer a buffer
that shifts every sample after the first is heard as a burst of noise. Both tiers
check it, so a malformed payload moves to the other tier rather than reaching a
listener.

**The child environment is explicit and minimal.** The default would hand this
process every API key the connector holds. `ESPEAK_DATA_PATH` is passed through
only if set, so an unset value does not become the string "undefined" in the
child.

## Verification performed

- The one-shot path was **executed for real**: invoked with a nonexistent model,
  it returns `{"ok":false,"code":"kokoro_import_failed"}` on stdout and exits 1 —
  a structured code the caller can route on, not an AttributeError from a null
  engine inside `_synthesize`.
- Every declining path exercised with no model present: `kokoroPython()` returns
  empty, `prewarm()` returns false, `synthesizeOnce()` rejects with
  `no_interpreter`, `synthesizeViaWorker()` returns null with the worker
  disabled, `bundleVoices()` returns null.
- `worker.call()` confirmed to accept `startArgs` against `stdio-worker.js`
  rather than assumed.
- Suite: **277 passed, 0 failed**, unchanged — nothing here is wired in yet.
- `kokoro_worker.py` compiles clean.

A defect found and fixed during implementation: the `--once` branch was initially
placed before `state.ensure_imported()`, so a one-shot request would have reached
`_synthesize` with a null engine and crashed with an AttributeError instead of
reporting a dependency failure. The import now happens inside the branch, before
the request is read.

## Not verified, and cannot be here

No Kokoro, no `kokoro-onnx`, no espeak in this environment. What is proven is
that the process spawns, the protocol frames parse, and every failure path
returns a routable code. Whether `Kokoro.create()` behaves as documented against
the pinned wheel is the `--probe` check on your infrastructure.

## Next, and it is the atomic one

`voice-engines.js` rewired to Kokoro, `voice-catalog.js` and `voice-provision.js`
replaced, `piper-worker-supervisor.js`, `piper_worker.py` and
`requirements-piper.txt` deleted, and the existing voice suites updated. That
release changes behaviour and is the one to deploy behind a listening check.

## Rollback

Delete `kokoro-worker-supervisor.js` and revert `--once`. Nothing calls either.
