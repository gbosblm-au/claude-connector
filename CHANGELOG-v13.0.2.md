# v13.0.2 — The Compare/Off equivalence made structural, and a deploy audit

**Supersedes v13.0.1.** Same fix, plus the resolution of a test that could not
be made trustworthy by rewriting it, and four findings from a pre-deploy audit.

## The test that kept failing on correct code

`AC5/N4: Compare mode renders flat through the untouched synthesize()` protects
a real property: Compare's flat half must be the same call Off mode makes, so
the comparison always has a genuine reference (AC3).

It was asserted twice, badly:

1. **A regex pinning the exact argument list.** Adding `sampleRate` to *both*
   Compare's flat call and the Off-mode call preserved the equivalence
   perfectly — and still failed. A test that fails on correct code invites
   weakening, which is how a control gets lost.
2. **String comparison of the two extracted call sites.** Better, but it
   depended on the variable names holding and on the argument objects never
   containing a nested brace. It would have broken again on the next benign
   change.

**The problem was in the code, not the test.** Three separate `synthesize()`
call sites — Compare's half, the prosody fallback, the true flat path — each
carrying its own copy of the same argument list. Three copies cannot be kept
equal by review, and a test comparing them can only report drift *after*
someone ships it.

They now share one `renderFlat()` closure. The equivalence is a property of the
code rather than a claim about it: there is nothing left to keep in step, so
nothing can drift. The assertion became simple — one definition, zero direct
calls, three uses.

**Verified three ways:**

| Change | Expected | Result |
| --- | --- | --- |
| Compare reintroduces a direct call | fail | **fails** |
| The fallback stops using the shared rendering | fail | **fails** |
| A field added to the shared rendering | **pass** | **passes** |

That third row is the one the old assertion got wrong, twice.

## Deploy audit findings

**A redundant Docker layer.** v13.0.0 added an `apt-get update && apt-get
install espeak-ng` block — but espeak-ng was *already* installed alongside
ffmpeg and had been since the Piper era. The second install was an extra layer
and an extra network round trip for a package already present. Removed.

The existing install is now annotated instead, because a reviewer pruning
Piper's leftovers would reasonably assume espeak-ng was one. **It is not:**
kokoro-onnx phonemises through `phonemizer`, which *shells out to the espeak-ng
binary* rather than binding a wheel. Removing it produces a worker that imports
cleanly and then fails every synthesis at phonemisation.

**Docker staging confirmed.** Everything Kokoro needs — `/opt/kokoro`,
espeak-ng, the artifact directory, the env defaults — is in the `runtime` stage,
not a build stage discarded before the final image. Checked rather than assumed,
because a venv built in the wrong stage is invisible until first synthesis.

**Three stale environment references.** `VOICE_PIPER_PYTHON` and
`VOICE_PIPER_DIR` still appeared in comments in `stt-worker-supervisor.js`,
`voice_stt_worker.py` and `voice-engines.js`. Comments, not live reads — but
they document variables that no longer exist, and the STT worker's comment
described the GPL boundary in terms of a program that has been deleted.
Retargeted at `VOICE_KOKORO_PYTHON`, with the espeak-ng reasoning stated where
the boundary is explained.

**Cross-package contract verified end to end.** The gateway's `/ti-voice/status`
relays every field the client's `loadStatus()` reads; the gateway's
`connectorVoices()` reader was run against the connector's actual
`registryState()` output, with labels present and the legacy `voices_installed`
fallback still resolving for an un-upgraded connector.

## One behaviour worth knowing before you deploy

`GET`/`PUT /ti-voice/settings` both run `resolveVoiceContext`, which requires the
caller to have voice enabled on their own account. **An admin must grant
themselves voice before they can configure the tenant default.** The refusal is
clear (`voice_not_enabled`, "Voice is not enabled for your account") rather than
a confusing 500, and requiring an operator to have the feature they are
configuring is defensible — but it will look like a permissions bug if you hit
it without expecting it.

## Verification performed

- Voice suites: **242 passed, 0 failed**.
- Whole connector: **598 of 599**, the one failure being the pre-existing
  `render-tools > download contract`, unrelated to voice.
- `renderFlat` mutation-tested in both directions, including the benign case.
- Zero `VOICE_PIPER_*` references outside the test tree.
- Version declarations consistent across all three packages.

## Compatibility

Unchanged from v13.0.1: no gateway or client change required. ts-gateway-service
v2.111.0 and ts-client-gateway v5.139.0 remain current.
