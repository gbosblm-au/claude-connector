# v12.47.0 — Tenax Voice: per-user feature gate

Implements the Tenax Voice Per-User Feature Gate Spec. `VOICE_ENABLED` becomes a
master kill switch, and a new `VOICE_TEST_USERS` allowlist decides *who* gets
through. Both must hold.

Degrades safely: with the allowlist empty and `VOICE_ENABLED` off, behaviour is
identical to v12.46.0. That is asserted, because it is what makes deploying the
connector ahead of the UI safe (Section 7).

---

## The open item: which identity field

Section 2.2 flags this as decide-before-build, warning that "scoping the gate to
the wrong field locks the operator out of their own testing." Three candidates
exist in this connector. Two are unsafe.

**1. `req.tsTenantId` — rejected.** It is a *tenant* id. In tenant mode every
user of a tenant shares one value, so allowlisting it would admit every user of
that tenant. That is the leak the gate exists to close.

**2. `getCurrentUser()` — rejected, and this is the important one.** It is the
process-level session context seeded by `ts_gateway_session_init`. The
self-model's own comment explains why it prefers per-call context: that context
is "concurrency-safe: the identity travels with the individual call, so
simultaneous sessions from different users never overwrite one another", and the
singleton is only a fallback for direct MCP calls.

As a recorder that is a small attribution inaccuracy. **As a security gate it
fails open.** Whoever ran session-init most recently sets the identity that every
subsequent voice request is judged against, so a non-allowlisted user's request
could be evaluated as the operator's. A gate built on it would pass single-user
testing and fail under exactly the shared conditions it was written for. A test
asserts `voice-gate.js` never references `getCurrentUser`.

**3. The per-call `user_id` — chosen.** This is what Section 2.2 recommends:
"the same identity value the UI/gateway exposes when it records a session".

### The gap this leaves, stated plainly

`/voice/transcribe` and `/voice/synthesize` are **direct HTTP routes, not proxied
tool calls.** The v12.25.0 per-call context arrives in the *body of
`POST /tool-call`* and is not injected into these routes at all.

So the identity is supplied on the voice request itself, as `X-Tenax-User-Id`,
carrying the same `user_id` the gateway already knows. An absent identity fails
closed. If the gateway should be signing or verifying this header rather than
passing it through, that is a follow-up — this is a testing keyhole on a POC, and
it is **not an authentication mechanism**: a test asserts an allowlisted caller
still hits the 401 when unauthenticated, so naming yourself cannot skip auth.

### Tenant-qualified entries

Observed `user_id` values are small integers (`"8"` in the self-model tests). On
a multi-tenant connector, user 8 of tenant A is a different person from user 8 of
tenant B, and a bare `8` would admit both. So an entry may be written either way:

```
8                 user_id 8 in ANY tenant
ts_50f3be57:8     user_id 8 ONLY in tenant ts_50f3be57
```

A qualified entry requires **both** halves to match — matching only the user half
would silently widen a narrower grant back out to every tenant. Half-written
entries (`:8`, `ts_aaa:`) grant nothing rather than degrading into a wildcard.

---

## Every refusal is indistinguishable from the feature not existing

Section 4.1: "never as 'route exists but you are not allowed'." Master switch off,
identity absent, identity unknown, identity not allowlisted — all four produce
the byte-identical `404 {"error":"not_found"}`. There is deliberately no distinct
status or message for "not allowlisted", because that would confirm the feature
exists and that the caller is merely on the wrong side of it.

**`/voice/health` is included in this.** It still always answers (Section 8.1),
but a non-allowlisted caller now receives the *exact same body* as a caller on a
connector where voice is globally off — same keys, same values. Reporting
`enabled: true` to someone who cannot use the feature would tell them it exists,
and would give their UI grounds to render a control that 404s. No engine is
probed on that path either, so a non-allowlisted caller cannot use health to
trigger a model load.

The master switch short-circuits first, so when voice is globally off no identity
is read at all — matching Section 3's "the master switch still gates every route
before identity is even consulted."

---

## `gateState()` is now per user

Section 4.2. It gains `voice_enabled_for_this_user`, and `render_voice_ui` plus
both readiness flags are keyed on the *per-user* answer rather than the global
one. A UI handed a global `enabled` would render a mic button for every user on a
connector where one operator is testing.

`enabled` still reports the global fact, so the two are distinguishable when the
UI needs both.

---

## Two bugs found while writing the tests

**A test helper that made a security test pass for the wrong reason.** `withEnv`
used a plain `try/finally`, which restores the environment when `fn()` *returns* —
and for an `async` function that is immediately, before a single line of its body
runs. The body then executed against the *restored* environment.

The consequence was specific and bad: "a non-allowlisted user gets a 404" was
passing because voice was off entirely, which is a different and much weaker
fact. A false pass on a security gate is worse than no test. `withEnv` now awaits
the promise before restoring.

**Log leakage.** The route registration line read
`routes registered (enabled=${voiceEnabled()})`. It now reports the master switch
and the *count* of allowlisted users — never their values, which are operator
account ids and do not belong in logs. It also warns when the master switch is on
with an empty allowlist, since voice is then unreachable for everyone and the
silence would be confusing. A test asserts the identities are never interpolated
into a log line.

---

## Mutation-tested

Given the false pass above, the gate tests were verified to actually fail when
the gate is broken:

| Mutation | Result |
|---|---|
| Allowlist matches by prefix instead of exactly | 2 tests fail |
| Gate ignores the allowlist (master switch only) | 3 tests fail |

---

## Files

- `src/voice/voice-gate.js` — allowlist parsing, identity resolution,
  `voiceAvailableFor()`, `requireVoiceForUser()`, per-user `gateState()`.
- `src/routes/voice.js` — two-layer route guard; per-user `/voice/health`;
  registration log corrected.
- `src/tests/voice.test.js` — 11 new tests (21 → 32), plus the four acceptance
  tests updated to supply an identity.
- `.env.example`, `package.json` (12.46.0 → 12.47.0).

`src/server-http.js` needed **no change**. The spec's file list anticipated
threading identity through the route guards there, but the guard reads the
request directly inside `src/routes/voice.js`, so the identity never has to cross
a module boundary.

---

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Unreachable unless `VOICE_ENABLED` is literal `'true'` **and** identity is allowlisted | Met |
| 2 | Non-allowlisted user gets the identical 404 before and after | Met — asserted against the reference body |
| 3 | Kill switch overrides the allowlist entirely | Met |
| 4 | Exact match, fails closed on ambiguity | Met — incl. duplicate headers, empty entries, half-written qualified entries |
| 5 | `gateState()` reports per-user availability | Met |
| 6 | Compliance controls untouched | Met — GPL boundary, MODEL_CARD refusal, ephemeral audio all still asserted |

---

## Verification

- `src/tests/voice.test.js` — **32 passed** (was 21).
- All other suites re-run, unchanged: `phase0-security` 61, `edit-tools` 50,
  `tool-call-guard` 43, `validation-tools` 38, `personal-chef` 29,
  `signed-urls` 28, `volume-snapshot` 26, `upload-retention` 21,
  `brain-scan-manual-only` 20, `internal-config-custom-env` 31,
  `script-audit-register` 17, `manifest-fragments` 13,
  `preview-signature-alignment` 10, `retention-calibration` 9,
  `profiles-postgres` 7.
- `render-tools.test.js` — one pre-existing failure, identical on the pristine
  12.45.0 upload.

## The limitation, restated

Section 5, and it belongs in the deployment notes rather than only the spec: **this
gate isolates access, not resource use.** Model load and child-process spawn are
per pod, not per user. A non-allowlisted request is refused before it reaches the
engine, but an allowlisted user's transcription runs on the pod serving everyone.
On the single-user POC that is a non-issue. Do not carry this gate into a
multi-tenant shared deployment expecting it to isolate cost.

## Next

Per Section 7's upgrade order: deploy this connector change first, then wire the
`ts-client-gateway` UI against `voice_enabled_for_this_user` as a separate item.
