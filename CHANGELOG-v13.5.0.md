# claude-connector v13.5.0

Tenax Voice — Sentence-Boundary Streaming Fix, Section 3.5.1 (Option A),
plus two test repairs that should have shipped with v13.4.0.

---

## NEW: `incremental_available` on `GET /voice/health`

Spec Section 3.5.1 recommends Option A (capability flag) over Option B
(probe and fall back). This is the connector half.

```json
{ "prosody": { "enabled": true }, "incremental_available": true }
```

Two conditions, both required: the route exists in this build, and the prosody
layer is on — per-phrase audio *is* that layer, and the incremental route
answers 409 without it.

Reported as a capability of the **deployment**, not of the caller. The route
still enforces the gate and the credential per request, so a client that sees
`true` and is not entitled still gets a 404.

Option B remains the safety net in the client. This flag only removes the one
failed request and stretch of silence that Option B costs on the first reply of
every session against an older connector — silence that is indistinguishable
from a broken feature.

---

## TEST REPAIR 1: an assertion that passed for the wrong reason and hid the v13.4.0 defect

`src/tests/voice-registry.test.js` asserted that
`= parseSampleRate(body, res)` appeared **exactly twice**, with the message
*"the single-call and stream routes both parse it"*.

That message was wrong. The two matches were `/voice/synthesize` and
`/voice/prosody/analyse`. **The stream route never parsed it** — it referenced a
`streamRate` declared inside the analyse handler, a different function scope,
and threw `ReferenceError` on every streamed request (fixed in v13.4.0).

The test was green throughout. A global count cannot express *"each of these
routes does X"*; it only expresses *"X appears N times somewhere"* — and it
named routes it was not actually checking.

Rewritten to slice each handler and assert per route. A route that skips the
parse now fails whatever the total is, and adding a fifth route that parses
correctly no longer turns a correct extension red.

Verified by mutation: removing the v13.4.0 `streamRate` fix now fails this test.
Before the rewrite it did not.

## TEST REPAIR 2: a pattern pinned too tightly for the `finalPosition` guard

`src/tests/voice-prosody-prep.test.js` pinned the exact expression
`position: (index === X.length - 1) ? 'final' : 'continuation'` and required two
matches.

v13.4.0 correctly added a guard to the streaming worker so a mid-reply
incremental batch does not close on a falling contour. The old regex counted the
guarded line as a *missing* position rather than a *modified* one — the
assertion failed while the property it names was still true.

Widened to allow an optional leading guard, and no further: the ternary, the
last-phrase test and both branch values are still pinned. A second assertion now
requires the guard to appear on **exactly one** path, because the buffered path
handles whole replies where the last phrase always ends the reply.

### Why these were missed in v13.4.0

I ran `test:incremental` and `test:stream-split` but never `test:voice-all`.
Confirmed against a pristine 13.3.0 checkout with the same dependencies
installed: baseline is **286 passed, 0 failed**, and v13.4.0 as shipped scored
284/2. Both failures were mine.

---

## Tests

`npm run test:voice-all` — **286 passed, 0 failed**, matching the pristine
baseline exactly.

`npm run test:incremental` — 15 passed (13 from v13.4.0, plus two for the new
capability flag).

The capability tests are mutation-tested two ways: hard-coding the flag `true`
and omitting the field both fail.

One of those tests initially asserted against its own mock — `prosodyState` was
stubbed to return `{ enabled: true }` unconditionally, so the
"false when the layer is off" case could never have failed whatever the route
did. The mock now reads the same env var the real implementation reads.
