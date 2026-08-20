# v13.0.1 — The sample rate actually reaches the engine

Closes an integration gap in v13.0.0 that no single package's tests could see.

## The defect

v13.0.0 shipped a registry that could express an output rate, v2.111.0 shipped a
gateway that stored a per-tenant rate and injected it into the request body, and
v5.139.0 shipped an admin control to set it.

**The connector's route never read `body.sample_rate`.**

Every piece was correct in isolation. The 16 kHz setting was accepted by the UI,
validated by the gateway, written to the database, sent on every request — and
discarded at the last hop. Audio came back at whatever `VOICE_TTS_SAMPLE_RATE`
said for the whole process, which is precisely the one-rate-per-deployment
limitation the tenant setting exists to remove.

This is the failure mode a per-package test suite is worst at: three green
suites and a feature that does nothing.

## What changed

**`parseSampleRate()`** on both `/voice/synthesize` and
`/voice/synthesize/stream`. It returns three things, deliberately:

| Return | Meaning |
| --- | --- |
| `undefined` | nothing asked for — the deployment default applies |
| a number | a valid rate was requested |
| `false` | refused; the 422 has already been sent |

"Nothing asked for" and "asked for something invalid" are genuinely different
outcomes. Collapsing them would let an unsupported rate silently produce audio at
some other rate — the one failure an admin cannot diagnose by listening.

**Threaded to every engine call, not just the common one.** Compare, the prosody
fallback and the flat path are three separate `synthesize()` calls. A rate
applied to two of them would produce a reply whose halves were at different
rates, which sounds like a fault in the voice rather than in the plumbing.

**Threaded down to each phrase worker.** The prosody layer renders phrase by
phrase and concatenates. A rate applied to the WAV header but not to the phrases
produces a file that declares one rate and contains another — which plays at the
wrong pitch and speed for the entire reply. The `_sampleRates` cache is seeded
from the request *before* the header rate is read from it.

**A per-request rate wins over the deployment default.** The env var remains the
fallback for a single-tenant install, which is the only place it can still be
the right answer.

## Also: labelled voices on `/voice/status`

`voices_installed` is unchanged — clients gate on it. A new `voices` array adds
the label and accent a picker needs, narrowed to what is actually installed
rather than to what the registry offers.

Without it, the gateway's settings screen could only offer raw ids, and an admin
choosing a voice for their whole workspace would be picking between `af_bella`
and `bf_emma` rather than "Bella (US, female)" and "Emma (UK, female)". The
gateway already prefers this field and falls back to the id list, so an
un-upgraded connector still works.

## A test that failed on correct code

`AC5/N4: Compare mode renders flat through the untouched synthesize()` asserted
the exact argument list of one call with a regex. Adding `sampleRate` to **both**
Compare's flat half and the Off-mode call preserved the equivalence AC3 needs
perfectly — and still failed the assertion.

A test that fails on correct code is dangerous, because the usual way out is to
weaken it. It is now asserted as an **equivalence**: the two call sites are
extracted, normalised and compared to each other. That cannot fail when both
change together, and it catches the thing that actually matters — the two
drifting apart.

**Mutation-tested:** reverting Compare's flat half to the old call shape, so it
diverges from Off mode, fails it.

## Tests

`voice-registry.test.js` goes from 24 to 30. The new assertions are structural
against comment-free source, because the whole point is that a value threads
through several call sites and a gap at any one of them is invisible from the
others.

One of them failed on first run for the reason above in miniature: the count of
`parseSampleRate(body, res)` included the function *definition*, making it three
rather than two. Anchored on the assignment.

## Verification performed

- Voice suites: **242 passed, 0 failed** (236 before, +6).
- Whole connector: **598 of 599**, the one failure being the pre-existing
  `render-tools > download contract`.
- The seam was verified in both directions by running the gateway's actual
  reader against the connector's actual `registryState()` output: labels
  present, names correct, and the legacy `voices_installed` fallback still
  resolving for an un-upgraded connector.

## Compatibility

No gateway or client change is required. v2.111.0 already sends `sample_rate` and
already prefers the `voices` field — this release is what makes both do
something. Deploy the connector; the other two are unchanged.

An older gateway that sends no `sample_rate` is unaffected: the field is absent,
`parseSampleRate` returns `undefined`, and the deployment default applies exactly
as in v13.0.0.
