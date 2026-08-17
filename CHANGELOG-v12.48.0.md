# v12.48.0 — Voice allowlist: live gateway read, closing the revoke-drift hole

Addresses the review of v12.47.0 / plugin v5.129.0.

## The defect

With `VOICE_ALLOWLIST_SOURCE=env`, grants live in `ti_users.voice_enabled` and
enforcement lives in `VOICE_TEST_USERS`. Two sources of truth, bridged only by
an operator remembering to copy a string into Railway.

The two drift directions are **not equally bad**, and the asymmetry is the whole
problem:

| Action | Sync forgotten | Result |
|---|---|---|
| Grant | yes | User has no voice. Annoying. **Safe.** |
| Revoke | yes | **User keeps voice.** Console says off, connector says on. |

The second is a security-relevant lie told by an admin screen, and it is exactly
the kind of thing nobody notices until someone who should not have voice is
using it. A standing notice does not fix it: it relies on the operator being
careful every single time, which is the assumption that fails.

## The fix

`VOICE_ALLOWLIST_SOURCE=gateway` makes the connector read the allowlist directly
from `GET /admin/ti-users/voice-access/allowlist` — the same endpoint and the
same `voice_test_users` string the admin screen shows. One source of truth, so
drift becomes structurally impossible rather than merely discouraged. A revoke
takes effect within one TTL (default 30s) with nothing pasted anywhere.

**`env` remains the default.** Switching an existing deployment's security gate
to a network dependency without being asked would be a worse decision than the
drift it fixes.

**`VOICE_ENABLED` stays an environment variable in both modes**, and the master
switch is evaluated *before* any network call. An emergency stop must not depend
on reaching the system it might be stopping. Asserted with a timing test against
a black-holed gateway.

## Failure behaviour: bounded staleness, then closed

A network read on a security path has to answer "what if it fails?".

- *Deny on any error* — a one-second blip cuts voice mid-sentence, and an
  operator whose voice keeps dropping moves back to env mode, which is worse.
- *Serve the last answer forever* — reinvents the unbounded drift this exists to
  remove, now invisibly.

So the last good answer is served for a **bounded** window
(`VOICE_ALLOWLIST_MAX_STALE_MS`, default 5 min), then everyone is denied and the
reason is logged loudly. With no snapshot at all — first request, gateway down —
the answer is deny: a gate that fails open on startup is not a gate.

A **malformed** response (no `voice_test_users` string) is an error, not an empty
allowlist. Reading a missing field as "nobody is granted" would silently revoke
everyone.

Concurrent requests on a cold cache share one in-flight fetch, so a burst
produces one gateway call rather than a stampede. Asserted.

## Also

- `/voice/health` reports `allowlist`: the source, entry count, age, staleness
  and — in env mode — a standing `drift_risk` string naming the revoke hazard.
  The drift is now visible from the system rather than only from documentation.
- Entries are never logged and never returned by the diagnostics; they are
  account identifiers. Counts and errors only.
- The route guard is now async. Refusals are identical whatever the cause: an
  error reaching the allowlist produces the same 404 as not being on it, so a
  caller cannot distinguish "you are not allowed" from "the gate is broken".

## Verification

- `src/tests/voice.test.js` — **42 passed** (was 32). Ten new, including a live
  revoke propagating without a redeploy, the stale cap engaging, and the kill
  switch short-circuiting before any network call.
- Full sweep unchanged; `render-tools.test.js` fails one pre-existing assertion,
  identical on the pristine 12.45.0 upload.

## Format agreement (raised in review)

Verified against the shipped 12.47.0 artefact, not from memory. Feeding it the
exact string the plugin generates:

```
VOICE_TEST_USERS='ts_aaa:8,ts_bbb:12'
  user 8  @ ts_aaa  -> true
  user 12 @ ts_bbb  -> true
  user 8  @ ts_bbb  -> false   (right user, wrong tenant)
  user 9  @ ts_aaa  -> false   (not granted)
```

The tenant-qualified parser shipped in v12.47.0. The review's concern that only
`VOICE_ENABLED` had been built was mistaken; the three packages already agree on
the format.
