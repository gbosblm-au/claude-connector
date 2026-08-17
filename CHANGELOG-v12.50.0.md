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

---

# Addendum -- what the fixed probes then revealed

Deploying the above turned two useless messages into two real ones. Both were
genuine faults, and neither was configuration.

## 5. `faster-whisper` could never import  ->  STT was dead in the image

The probe now reports the real cause:

```
faster-whisper is not available: No module named 'requests'
```

`faster_whisper/utils.py` does `import requests` at module scope, but
faster-whisper 1.1.1 **does not declare `requests` as a dependency**. It
inherited it transitively from `huggingface_hub`. huggingface_hub 1.x replaced
`requests` with `httpx`, so any build that resolves the newer hub installs no
`requests` at all and `import faster_whisper` dies on line 8.

The image built successfully and STT could never have worked in it.

**Fixed in the Dockerfile:** `huggingface_hub<1.0` pinned, `requests` installed
explicitly, and a build-time `RUN python3 -c "import faster_whisper"` so a
broken import fails the **build** rather than the first voice request. Nothing
verified the package could be loaded, which is why this shipped.

Rebuild the image for this one -- it is not a variable.

## 6. No voice models on the volume  ->  TTS had nothing to speak with

`voices_installed: []`. The Dockerfile creates `/data/voice/piper/voices`, and
it cannot fill it: the Railway volume is mounted **over** `/data` at container
start, masking anything the build wrote underneath. A `RUN wget` there would
download hundreds of megabytes into a directory nothing will ever read.

Letting Piper fetch its own voices does not work either. `piper-tts` looks a
missing voice up **by name** in its `voices.json` index, and `voice-engines.js`
passes an absolute **path**, which is not a name in that index.

**Added:** `src/voice/voice-provision.js` and `scripts/voice-provision.mjs`,
downloading from `rhasspy/piper-voices` (HuggingFace, as Section 15 pins).
Config file first so a wrong path costs kilobytes rather than 60 MB; each file
lands as `.partial` and is renamed into place, so an interrupted download leaves
nothing that looks installed.

```
node scripts/voice-provision.mjs --list
node scripts/voice-provision.mjs en_US-lessac-medium
```

or set `VOICE_PROVISION_VOICES=en_US-lessac-medium` and it runs in the
background at boot -- opt-in, gated on `VOICE_ENABLED`, and never blocking the
boot, because Railway's health check has a deadline and a model download must
not fail a deploy.

## 7. A catalogue voice that does not exist  (reported, not fixed)

`VOICE_CATALOG` lists **`ja_JP-ryoko-medium`** as the Japanese default. There is
no such voice in `rhasspy/piper-voices`. The repository publishes exactly one
Japanese voice, `ja_JA-hi_fi_captain-medium`, under the locale directory
`ja_JA` -- upstream's spelling, not a typo. Japanese TTS cannot succeed today no
matter what is downloaded.

I have **not** silently repointed the id. `VOICE_CATALOG` is a licence record:
every entry carries `audited`, `licence` and `model_card` fields that a
compliance review reads, and swapping an id inside it would put an unreviewed
model behind a reviewed name. That is your call, not a bug fix. The provisioner
refuses the id with the reason, and a test asserts every catalogue voice either
has a download source or is explicitly recorded as unavailable.

The other four voices resolve and download correctly; `en_US-lessac-medium` was
downloaded and verified end to end (60 MB, config parsed, picked up by
`installedVoices()` and reported in `voices_installed`).

## Files added in this addendum

| File | Change |
|---|---|
| `src/voice/voice-provision.js` | **New.** Pinned voice downloader, atomic writes, opt-in boot hook. |
| `scripts/voice-provision.mjs` | **New.** CLI: `--list`, `--force`, per-voice or all. |
| `Dockerfile` | `requests` + `huggingface_hub<1.0`, and a build-time import check. |
| `src/routes/voice.js` | Background provisioning hook at boot. |
| `package.json` | `npm run voice:provision`. |
| `src/tests/voice-auth.test.js` | 21 tests now (5 added for provisioning). |

## Verification (final)

| Suite | Result |
|---|---|
| `voice-auth.test.js` | 21 / 21 pass |
| `voice.test.js` | 47 / 47 pass |
| `phase0-security.test.js` | 61 / 61 pass |
| `internal-config-custom-env.test.js` | 31 / 31 pass |
| `edit-tools.test.js` | 50 / 50 pass |
| live download of `en_US-lessac-medium` | 60 MB, verified, idempotent on re-run |

---

# Addendum 2 -- English default changed, and why it had to be

## 8. The shipped English default was licensed for non-commercial use only

`en_US-lessac-medium` was the English default. Its MODEL_CARD gives the dataset
as the CSTR Blizzard 2013 Lessac corpus, whose project page states directly:

> This data is released under a license for non-commercial use only.

(Speaker: Catherine Byers. The MODEL_CARD itself records neither the restriction
nor the speaker; both come from the linked source, which is why the audit has to
follow the link rather than stop at the card.)

TrueSource is a commercial consultancy. That voice was one `provision` command
away from speaking in a client-facing product, and nothing about the name
"lessac" hints at the problem. This is precisely the failure `voice-catalog.js`
was written to catch, and it caught it only because the audit was actually done.

**English now defaults to `en_US-kristin-medium`:** trained on public-domain
LibriVox recordings, `commercial_ok: true`, `attribution_required: false`,
`audited: true`, with the MODEL_CARD URL recorded on the entry.

**`en_US-lessac-medium` is retained but refused.** It is not deleted, because
deletion produces `unknown_voice` for anyone with the id configured, which reads
like a typo. `voicePermitted()` returns `voice_non_commercial` with a message
that says why, and it does so **even when `VOICE_AUDIT_REQUIRED=false`** -- that
switch relaxes licences nobody has read, never one that has been read and
rejected.

You can now set `VOICE_AUDIT_REQUIRED=true` (your connector currently has
`false`) and English still works. That is the correct setting: the remaining
four voices have unread MODEL_CARDs and are refused until someone reads them.

## Stale tests updated rather than deleted

Six assertions in `voice.test.js` encoded the old premise that *nothing* had
been audited, so a real audit broke them. They were rewritten to assert the
invariant they were always protecting -- unchecked voices are refused, and being
checked is not the same as being allowed -- rather than the frozen fact that the
count was zero. The mirrored SQL table test now checks all three states stay
distinguishable: `NULL` for unread, `0` for audited-and-refused, `1` for
audited-and-cleared.

## Verification

| Suite | Result |
|---|---|
| `voice.test.js` | 47 / 47 pass |
| `voice-auth.test.js` | 25 / 25 pass |
| `phase0-security.test.js` | 61 / 61 pass |
| `internal-config-custom-env.test.js` | 31 / 31 pass |
| `edit-tools.test.js` | 50 / 50 pass |
| `signed-urls.test.js` | 28 / 28 pass |
| live download of `en_US-kristin-medium` | 61 MB, config parsed, verified |
