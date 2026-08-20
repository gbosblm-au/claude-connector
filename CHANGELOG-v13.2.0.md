# v13.2.0 — The engine artifacts survive a redeploy

The model and the voice bundle are now **baked into the image**. A fresh deploy
speaks immediately: no manual provisioning step, no boot-time download, no
network at start-up.

## The bug underneath the bug

You asked for the model to survive redeploys. Fixing that surfaced something
worse than a missing download.

v13.0.0's Dockerfile ran `mkdir -p /data/voice/kokoro` and pointed the engine
there. **On a platform that mounts a persistent volume at `/data`, the mount
shadows everything the image put at that path.** So baking the model there would
not merely have been redundant — the files would exist in the image layer and be
**unreachable at runtime**, and the failure would have looked exactly like the
one being fixed.

The artifacts therefore go to `/opt/kokoro/models`, which is image filesystem
that nothing mounts over. It is where the venv already lives, for the same
reason.

## Resolution is layered, and the image copy is a floor rather than a ceiling

```
explicit env var  →  the volume, if the file is there  →  the copy in the image
```

- **Fresh deploy:** nothing on the volume, so the image copy runs. Works
  immediately.
- **Model upgrade without a rebuild:** drop a newer file on `VOICE_KOKORO_DIR`;
  it is preferred on the next restart.
- **Pinning:** set `VOICE_KOKORO_MODEL` to force one exact file.

An explicit path is honoured **even when the file is absent**, so the failure
names what the operator configured rather than silently falling back. Silently
substituting different weights for the ones someone deliberately pointed at is
how a deployment ends up running a model nobody chose.

Each artifact resolves independently — the model can come from the volume while
the bundle comes from the image.

**`VOICE_KOKORO_MODEL` and `VOICE_KOKORO_VOICES` are deliberately no longer set
in the image.** Setting them pins the paths and defeats the whole mechanism. The
test that previously asserted they *were* set has been inverted, with the
reasoning recorded.

## The build proves what it ships

Three checks, in order, each catching what the previous one cannot:

| Check | Catches |
| --- | --- |
| `curl -fSL` | an HTTP error status |
| size floors (100 MB / 1 MB) | a truncated transfer or proxy error page that arrived with a 200 |
| a real `Kokoro(...)` load | weights that download cleanly and fail to parse |

The third also asserts that **all five offered voices are in the bundle**. A
bundle version that dropped one would otherwise produce a Speak button that works
for some voices and not others — far harder to diagnose than a red build.

Without the size floors, onnxruntime's message for a short model file is an
opaque protobuf parse failure at **first synthesis**, hours after the build that
caused it. Failing in the build costs a build; failing there costs a debugging
session.

**The verification runs from a file, not an inline `python3 -c`.** A multi-line
`-c` depends on backslash continuations surviving Docker's line joining with the
shell quoting intact. It works — until someone edits it and it silently becomes a
different program.

Likewise, no `#` comments inside the `RUN` chain. Docker does strip them, but a
chained `&&` block that depends on that is a fragile thing to leave for whoever
edits it next.

**The `&&`/`||` chain was executed, not reasoned about.** `exit 1` inside a `(…)`
subshell exits the subshell rather than the build, so the failure only propagates
by precedence accident. It now uses `{ …; exit 1; }`, and I extracted the real
`RUN` body and ran it against a truncated model, a truncated bundle, and valid
files: exit 1, exit 1, exit 0.

## What it costs, stated

Roughly **330 MB** on the image, and a build that now depends on GitHub releases
being reachable. Both are deliberate trades against a deploy that is silently
mute, and against a boot-time fetch racing a health-check deadline.

## Diagnostics

`/voice/health` gains `KOKORO_ARTIFACT_SOURCE`, and `npm run voice:smoke` prints
the layer beside each path:

```
model : /opt/kokoro/models/kokoro-v1.0.onnx  [image]
bundle: /data/voice/kokoro/voices-v1.0.bin   [volume]
```

The paths alone cannot answer *"why does it sound different since the
redeploy"*, because a volume path and an image path look equally plausible in a
log line. This says which layer won.

## Boot provisioning

Still off by default, and now correctly quiet. Absent-from-the-volume is the
**expected** state once the artifacts are baked in, so warning about it on every
boot would train an operator to ignore the line that matters. It now warns only
when **neither** layer has them — which means the image was built without them,
a broken image rather than a missing volume.

`npm run voice:provision` is retained for upgrading the model without a rebuild,
and for running the source outside the container.

## Licensing note

Baking Apache-2.0 weights into an image you distribute is **redistribution**, in
a way that a hosted service fetching them at runtime is not. Apache-2.0's notice
requirement then applies. The licence is already carried per-voice in the
registry and reported by `/voice/health`; if these images ever ship to clients
rather than only running in your own infrastructure, that notice should travel
with them.

## A dead import, found by following the evidence

While verifying the fresh-deploy resolution I noticed the voice bundle resolving
to `volume` when nothing should have been there — and found a real 28 MB
`voices-v1.0.bin` on the volume, downloaded during development by an
intermediate version of the provisioning code.

**The shipped suite does not download it.** Verified rather than assumed: the
artifact was deleted and the full suite re-run, with all 617 tests passing and
nothing reappearing.

What it left behind was a dead import in `voice-auth.test.js` — `VOICE_SOURCES`,
`MISSING_UPSTREAM`, `installVoice` and `voicesDir`, imported for the Piper-era
provisioning tests removed in v13.0.0 and referenced nowhere since. Removed, and
not merely trimmed: **a dead import of a module that performs network downloads
is not inert.** It only takes one future test calling the symbol already
conveniently in scope for the suite to acquire a 28 MB fetch and a network
dependency nobody chose.

## Verification performed

- **Whole connector: 617 passed, 0 failed**, and re-run with the volume artifact
  deleted to prove the suite performs no network download.
- All three resolution layers exercised by execution: no volume file → image;
  volume file present → volume; explicit env → configured, including the case
  where the model resolves to the volume and the bundle to the image.
- The real `RUN` body executed against truncated and valid artifacts.
- **Mutation-tested**, three ways: baking under the volume mount fails;
  re-pinning the paths in the image fails two tests; checking the image before
  the volume fails.

## Deployment

Rebuild the image. That is the whole procedure — no provisioning step, and
nothing to run before TTS works.

`npm run voice:smoke` still matters, and now answers a different question: not
"are the files there" but "does this hardware synthesise fast enough", which is
the number the CPU decision rests on.
