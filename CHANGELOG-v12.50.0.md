# v12.50.0 -- Tenax Voice: the gateway could not reach it, and health said the wrong thing

## The report

> Voice settings appear hardcoded. `VOICE_ENABLED` is set on Railway and
> `/voice/health` still returns `enabled: false`. Tried `true` and `on`; neither
> resolves it.

`VOICE_ENABLED` was never hardcoded and was never ignored. `voice-gate.js` reads
it correctly and accepts `true`, `1`, `yes` and `on`. The connector was already
logging `[voice] routes registered (master=true, ...)` at boot.

Four separate defects sat behind that single symptom. The first made the feature
unusable in production; the second would have blocked the next step; the third
and fourth made all of it impossible to diagnose from the outside.

---

## 1. The Gateway Service could not reach the voice routes at all  (blocking)

`/voice/health`, `/voice/transcribe` and `/voice/synthesize` were behind
`mcpAuthMiddleware`, so they demanded `MCP_API_KEY`.

The caller in production is the Gateway Service (`routes/ti-voice.js`). It does
not hold `MCP_API_KEY` and has no way to obtain one. It holds the per-tenant
connector restore token, which it already sends as `X-Railway-Restore-Token`
beside the verified identity headers.

Every gateway call was therefore answered `401` before a line of voice code ran:

| Gateway call | Result | What the user saw |
|---|---|---|
| `GET /voice/health` | 401 | `/ti-voice/status` -> `available:false`, `reason: connector_unreachable` |
| `POST /voice/transcribe` | 401 | passed through to the browser |
| `POST /voice/synthesize` | 401 | passed through to the browser |

The mic button could never render, whatever `VOICE_ENABLED` and
`VOICE_TEST_USERS` were set to.

**Fixed.** The three paths are exempt from the MCP key in
`middleware/mcpAuth.js` and verify a credential of their own in the new
`src/voice/voice-auth.js` -- the same pattern `/volume-restore`,
`/restore-skill`, `/tool-call` and the other twenty-odd plugin-facing routes
already follow. Two credentials are accepted, constant-time compared:

- `Authorization: Bearer <MCP_API_KEY>` (or `X-MCP-Api-Key`) -- the **operator**.
- `X-Railway-Restore-Token: <RAILWAY_RESTORE_TOKEN>` -- the **gateway**.

Nothing became public, and no new secret has to be provisioned or rotated. The
entries are `exact`, not a `/voice/` prefix, so a future voice route is not
exempt by default.

**The feature gate is untouched.** Exemption from the MCP key is not exemption
from `voice-gate.js`: the `VOICE_ENABLED` master switch and the per-user
`VOICE_TEST_USERS` allowlist still run on every request, and still answer `404`
rather than `403` to anyone they refuse.

An unauthenticated `POST` has its body drained before the 401, capped at 2 MB
and 5 s. Answering mid-upload resets the stream, and over HTTP/2 the caller then
sees a transport error with no status code -- the v12.31.0 lesson, which cost
far more to diagnose than a plain 401 would have.

## 2. `requireAuth` checked a flag nothing sets  (blocking)

`routes/voice.js::requireAuth` tested `req.authenticated`. Nothing in this
connector sets it. `mcpAuthMiddleware` sets `req.mcpAuthenticated`, and
`tenantAuthMiddleware` -- the only thing that sets `req.tsTenantId` -- is mounted
on `/mcp` alone, so it never runs for a voice request.

A correctly credentialled, correctly allowlisted operator therefore got
`401 unauthenticated` from `POST /voice/transcribe`, and the only documented way
past it was `VOICE_ALLOW_UNAUTHENTICATED=true`: switching authentication off to
make a feature work.

**Fixed.** The check now names the flags that exist, including the
`req.voiceAuthenticated` set by `voiceCredential`. It remains a real check: an
anonymous caller on a connector with no credential configured still gets the 401.

## 3. `/voice/health` reported `enabled: false` to a refused caller

By design, health returns the byte-identical "voice is off" body to anyone it
refuses, so an unauthorised user cannot learn the feature exists. That is right
for an end user and actively misleading for the operator debugging it:
`enabled: false` is returned whether the master switch is off or the caller is
simply not on the allowlist, so `VOICE_ENABLED=on` looks like a variable being
ignored.

In the reported case the allowlist held the tenant-qualified entry `ava:38`,
which matches only when **both** `X-Tenax-User-Id` and `X-Tenax-Tenant-Id` are
sent. A manual `curl` sending only the user header can never match it, and
`req.tsTenantId` does not fill the gap because `tenantAuthMiddleware` does not
run on `/voice/*`.

**Fixed.** A caller presenting `MCP_API_KEY` -- the connector's own key, which
already grants remote code execution here -- now receives an
`operator_diagnostics` block naming `master_switch`, `denied_reason`
(`master_switch_off` | `no_identity_header` | `identity_not_allowlisted`),
`identity_seen` and the allowlist mode and count.

The response shape for everyone else is unchanged, byte for byte. The gateway
holds the restore token rather than this key, so nothing added here can reach a
browser and the `/ti-voice` contract is untouched. Allowlist entries are never
disclosed: a count, never a list.

## 4. Both engine probes were wrong

**TTS.** The probe ran `piper --version`. The pinned engine, `piper-tts==1.2.0`,
is an argparse CLI whose `-m/--model` argument is required, so any invocation
without it exits non-zero with a usage banner:

```
piper: error: the following arguments are required: -m/--model
```

A perfectly healthy installation reported `tts_ready: false` and the connector
called itself degraded forever. The probe now uses `--help`, which argparse
answers with exit 0 *before* required-argument validation, and accepts a usage
banner as proof the binary runs. A missing absolute `VOICE_PIPER_BIN` is named
directly instead of surfacing as `ENOENT`.

It also now reports `tts_ready: false` when Piper runs but **no `.onnx` voice
model is present** in `VOICE_VOICES_DIR`. The `catalogue` block lists five
licence-cleared voices whether or not one byte has been downloaded; reporting
ready on that basis meant a speak button that 500s on first press. Health gains
`voices_installed`, read from the volume, beside `catalogue`, read from the
licence table.

**STT.** `voice_stt.py::fail()` writes `{error, code}` to **stdout** and exits
non-zero. The probe parsed stdout only when the exit code was 0, so on the one
path where the message exists it discarded it and reported the literal string
`"probe failed"` -- stderr is empty, because the helper never writes there.

The probe now parses stdout whatever the exit code. The same deployment that
reported `"probe failed"` will now report the actual cause, e.g.
`faster-whisper is not available: No module named 'faster_whisper'`.

---

## Files

| File | Change |
|---|---|
| `src/voice/voice-auth.js` | **New.** Transport credential: MCP key or gateway restore token, constant-time, with body drain before 401. |
| `src/middleware/mcpAuth.js` | Three exact voice paths added to `SELF_AUTHENTICATED_ROUTES`, with justification. |
| `src/routes/voice.js` | `voiceCredential` mounted first on all three routes; `requireAuth` flag list corrected; operator diagnostics; `voices_installed` in health. |
| `src/voice/voice-engines.js` | TTS probe rewritten; STT probe parses stdout on failure; `installedVoices()` added. |
| `src/tests/voice-auth.test.js` | **New.** 16 tests covering all four defects. |

## Verification

| Suite | Result |
|---|---|
| `src/tests/voice-auth.test.js` (new) | 16 / 16 pass |
| `src/tests/voice.test.js` | 47 / 47 pass |
| `src/tests/phase0-security.test.js` | 61 / 61 pass |
| `src/tests/internal-config-custom-env.test.js` | 31 / 31 pass |
| remaining suites | unchanged from v12.49.0 |

## Operator notes

1. `tenants.connector_restore_token` for the tenant must be populated **and must
   equal** the connector's `RAILWAY_RESTORE_TOKEN`. `ti-voice.js` omits the
   header entirely when the column is empty, and the connector will then refuse
   the gateway.
2. `VOICE_TEST_USERS` entries written `<tenant_id>:<user_id>` require both
   identity headers. The Gateway Service sends both, from the verified JWT
   (`sub` and `tenant_id`). A manual `curl` must send both too.
3. After deploying, re-check health as the operator:

   ```
   curl -s https://<connector>/voice/health \
     -H "Authorization: Bearer $MCP_API_KEY" \
     -H 'X-Tenax-User-Id: 38' -H 'X-Tenax-Tenant-Id: ava' | python3 -m json.tool
   ```

   `errors.stt` and `errors.tts` will now name real causes, and
   `voices_installed` will show whether any voice model is actually on the
   volume.
