# v13.1.1 — Four review findings, including two more pieces of dead scaffolding

**The whole connector suite is green for the first time: 611 passed, 0 failed.**
The `render-tools > download contract` failure I called "pre-existing" in three
consecutive releases is fixed, not re-categorised.

## 1. The document download bug — diagnosed and fixed

**Symptom:** documents come back that cannot be opened.

**Cause:** with `CONNECTOR_URL` unset, `handleDocumentRender` returned
`ok: true, partial: true` with a message saying the file was on disk "and
available through the downloads directory". Every consumer that checks `ok` and
reads `download_url` saw a **success with no link**, and presented the user with
a document they could not fetch.

The old shape assumed an operator standing next to the box. **On a hosted
connector the user is not** — the downloads directory is unreachable to them, so
a file they cannot fetch is not a partial deliverable, it is no deliverable.
Success is a claim about what the caller can do next, and here they can do
nothing.

It now returns a failure with `error_kind: 'no_output_produced'`, keeping the
diagnostic detail: which renderer ran, `file_written: true` to distinguish
"rendered but unreachable" from "never rendered", and a warning naming
`CONNECTOR_URL` so the operator fix is one line.

**Reproduce it:** unset `CONNECTOR_URL` and render a document.

**An unresolved divergence, flagged rather than silently changed.**
`edit-tools.js` has the *same* condition and returns `ok: true` with
`download_url_unavailable` — and a **passing test asserting that contract**. Two
tools answering the same question with opposite shapes is a defect in its own
right, but changing a contract with a test defending it is a decision, not a
cleanup. **It needs an owner.**

## 2. `VOICE_TTS_TENANT_VOICE` was reported and read by nothing

The same class as the dead preprocessor, and worse in one respect: the variable
appeared in the `/voice/health` config payload, so an operator could set it, see
it **echoed back as confirmation**, and get no change in the voice.

It is now read. Precedence: an explicit per-request voice, then this
deployment-wide default, then the platform default. A stale value falls through
with a log line rather than failing a reply.

Scoped deliberately: the registry default is adopted only when the caller named
neither a voice nor a language. With a language present, `bestVoiceForLanguage`
is more specific because it checks what is actually *installed* — overriding it
would reintroduce the "registered but not in the bundle" 500 it exists to
prevent.

## 3. Per-assistant voice selection did NOT ship, and cannot as specified

I said earlier I had not checked where assistant profiles live. I have now.

**There is no assistant-profile entity in this platform.** "Personality" is
tenant- and user-scoped markdown content, not a roster of named assistants with
individual settings. Section 10's per-assistant voice has nothing to attach to.

What shipped, and is verified: **per-request** and **per-tenant** selection —
which is what you actually asked for ("voice selection options for tenant Id").
The registry's `assistant` precedence level remains as the hook if personas ever
become entities; it is documented as unused rather than left looking live.

## 4. The 16 kHz control is NOT broken

Confirmed end to end. `SAMPLE_RATES` is `[24000, 16000]`, so selecting 16 kHz
passes validation, threads through the gateway and the route, and **resamples in
the worker** — scipy primary, numpy windowed-sinc polyphase fallback, both
verified numerically to suppress a 10 kHz tone to ≈ −50 dB.

The 422 fires only for rates *not* on the list (44100, 8000). An admin picking a
listed option gets audio at that rate.

## The latency question, answered by measurement rather than assertion

`npm run voice:smoke` **did** render a real utterance — but on `"Voice check."`,
two words, which says nothing about whether the CPU budget is viable.

It now renders a **realistic paragraph** and reports:

- audio duration and rate
- cold total (including the model load)
- engine-only time (what a warm worker pays)
- **realtime factor** — audio seconds per wall second

with a verdict: below **1.0x** the audio arrives slower than it plays, so the
streaming path stutters mid-reply; below **2.0x** a long reply on a loaded host
may approach the gateway's 120s ceiling.

The `--once` path is used deliberately, so the figure is a **worst case** that
includes the model load the resident worker pays only at boot. The gap between
the two numbers is the value of the resident worker, in milliseconds.

**I still have no number.** There is no model and no `kokoro-onnx` here. The
smoke test now produces one on your hardware in a single command, and that number
should gate the CPU decision.

## Deployment fact that deserves emphasis

**The model is not in the image.** The Dockerfile creates `/data/voice/kokoro`
and sets the paths; it does not download the 310 MB model or the voice bundle.
`VOICE_PROVISION_ON_BOOT` defaults to **false**, because a boot-time fetch turns
a redeploy into a stall against a health check with a deadline.

So TTS is dead on a fresh volume until you run `npm run voice:provision` or
pre-populate it. It fails **visibly** — `probeEngines` reports `tts_ready: false`
naming the missing path — but it is a required step, not an optional one.

## On retiring Piper

Your reviewer is right and I want to be explicit rather than let it pass in a
table. **I diverged from your instruction.** You said delete Piper entirely; I
argued for keeping a fallback, you ratified that Piper was a POC, and I then
deleted it in v13.0.0.

What replaced the fallback is the `--once` subprocess tier — the same engine in a
fresh process. That covers a sick worker; **it does not cover a broken engine**.
If Kokoro does not work in your environment, there is no path back except a
redeploy of the previous image.

Nothing has been heard through it. Keep the last Piper build
(`claude-connector-12.57.0`) reachable until you have heard a sample.

## Verification performed

- **Whole connector: 611 passed, 0 failed.** Up from 606/1 — the render fix
  closed the last one.
- Voice suites: 254 passed.
- Tenant voice resolution verified by execution under three configurations.
- 16 kHz chain verified through the registry's own validation.
- Stale Piper wording removed from a user-facing 422 message, asserted by test.
