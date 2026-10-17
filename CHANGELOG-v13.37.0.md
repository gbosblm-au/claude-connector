# claude-connector v13.37.0

Two work orders, the connector half of each. Built on 13.36.0.

- **TENAX-VOICE-2026-10-07-02**, "voice access for all users": the per-user
  allowlist is deleted. Who may use voice is decided on the Gateway Service,
  per request; the connector renders from the gateway's claim and never
  enforces with it.
- **TENAX-2026-10-09-01**, "deliverable return and the zip round trip", Track A
  route A1 (on-demand fetch, chosen 2026-10-10): the new tool
  `coding_deliverable_publish` fetches a delivered tree from tenax-frame as one
  complete archive, places it in `/data/downloads` and returns the connector's
  own signed 3-day link. Also C-CALIBRATION: the downloads reaper can no longer
  delete a file whose link still verifies.

## Deploy order

1. tenax-frame **1.10.0**, then a `reader:<token>` entry in its
   `FRAME_AUTH_TOKENS` (add it only once 1.10.0 is running: 1.9.0 reads an
   unknown `role:token` entry as an operator token).
2. Gateway Service **2.251.0** with its migrations (0057, 0058).
3. **This connector**, with `TENAX_FRAME_URL` and `TENAX_FRAME_READ_TOKEN` (the
   reader token). Then delete the seven variables below.
4. ts-client-gateway **5.233.0**.

A connector of this version behind a gateway older than 2.251.0 shows no voice
surface to anyone (no claim header arrives), and its voice routes still answer
an identified caller; the old gateway's own checks are what stands in front of
them. Deploy the gateway first.

## Voice: the allowlist is retired

Delete these from the connector service. Nothing reads them, and
`src/tests/voice.test.js` (C-10) fails if any connector source does:

```
VOICE_TEST_USERS
VOICE_ALLOWLIST_SOURCE
VOICE_ALLOWLIST_URL
VOICE_ALLOWLIST_KEY
VOICE_ALLOWLIST_TTL_MS
VOICE_ALLOWLIST_MAX_STALE_MS
VOICE_ALLOWLIST_TIMEOUT_MS
```

What the connector still checks on every voice request: `VOICE_ENABLED` (the
kill switch, checked first, with no network or database read: C-08), the
transport credential, and that an identity (`X-Tenax-User-Id`) was sent. A
blank identity is refused.

The voice surface in `/voice/health` (the mic and Speak buttons) renders when
`VOICE_ENABLED` is on, an identity is present, and the gateway sent
`X-Tenax-Voice-Entitlement: entitled`. The header is read exactly (any other
value is "not entitled") and is used for rendering only; the gateway refuses a
non-entitled caller before anything is forwarded here.

`VOICE_PROSODY_ENABLED` is unchanged and still read in one place,
`src/voice/prosody.js` (C-11).

## Coding: `coding_deliverable_publish` (new tool)

Listed in `tools/list` only when `TENAX_FRAME_URL` and
`TENAX_FRAME_READ_TOKEN` are both set; called without them, it refuses
`frame_not_configured` and fetches nothing. No new HTTP route:
it is reached through the existing authenticated tool layer (the Gateway
Service calls it at final approval with `X-Railway-Restore-Token`; an MCP
client can call it with the MCP key). `src/tests/route-inventory.test.js` pins
the connector's mutating routes and the four modules that may write into the
downloads directory (C-NEG-UNAUTH-PUSH).

Input: `tree_hash` (64 hex), `filename`, and optionally `root`,
`predecessor`, `supersedes`, `run`.

- `filename` is one safe segment ending `-<first 12 of tree_hash>.zip` (the
  gateway's names always do). The tool replaces a file of the same name in the
  shared downloads directory, so the name is bound to the tree it carries: it
  can only ever replace an archive named for the same tree, never another
  tool's output, whoever calls it.
- `root` is one path segment: 1 to 200 characters, no `/` or `\`, no control
  character, not `.` or `..`. Spaces and accents are allowed (`My App` is a
  root). The same rule as tenax-frame 1.10.0 and the gateway's intake, so a
  root the gateway accepts is never refused here.

What it does, in order, refusing by name at each step:

1. `GET /v1/tree/:hash` on the frame (the listing it will check against).
   `tree_not_found`, `frame_refused`, `frame_error`, `frame_unreachable`.
2. `GET /v1/artefacts/:hash/archive?root&predecessor&supersedes&run`, bounded
   by `CODING_DELIVERY_MAX_BYTES` (default 209715200, the frame's own upload
   bound) and `CODING_DELIVERY_TIMEOUT_MS` (default 120000).
   `archive_too_large`, `frame_refused_archive`.
3. The archive's sha256 equals the frame's `X-Frame-Archive-Sha256`
   (`archive_mismatch`); its members below the root are exactly the tree's
   listing plus `.tenax/delivery.json`, each at its listed size
   (`archive_incomplete`: a subset is refused, C2); the manifest exists
   (`archive_manifest_missing`) and names the tree, predecessor, superseded
   archive and root that were asked for (`archive_manifest_mismatch`, C1).
4. Written under a temporary name in the downloads directory and renamed, so
   the published name never holds half an archive; then checked present at
   full size (`write_failed`).
5. The link comes from `buildDownloadLinks()`, the same signed-link path every
   other produced file uses (`link_unavailable` if none could be built). This
   module never assembles a URL (C-NO-BUILT-URL).

Result: `download_url`, `expires_at`, `expires_in_seconds`, `size_bytes`,
`archive_sha256`, `tree_hash`, `members`, and the manifest's root, entry
count, total bytes, predecessor, superseded archive and changed-file list.

The frame URL and token never appear in a result, a log line or an error.

## Retention: the reaper is held to the link (C-CALIBRATION)

`src/utils/retentionCalibration.js` (new). The downloads reaper now runs at the
larger of `DOWNLOADS_TTL_HOURS` and the signed-link lifetime
(`LINK_EXPIRY_SECONDS`, default 259200, three days). A configured value below
the link is raised to it and logged as a warning at boot; the boot line shows
both the configured and the effective window. Before this release an operator
who set `DOWNLOADS_TTL_HOURS=24` got links that verified and then 404'd.

## Baseline fault fixed on the way (blocking)

`src/voice/voice-engines.js` called `assertTagless`, which 13.36.0 had removed
from `engine-form.js`: every Kokoro synthesis threw `ReferenceError`. The call
is now `guardRequest`, the 13.36.0 replacement. Out of the declared scope, but
voice definition-of-done item 1 ("a client account hears a reply") cannot pass
without it.

## Changed files

| File | Change |
|---|---|
| `src/voice/voice-allowlist.js` | **deleted.** |
| `src/voice/voice-deployment.js` | **new.** `deploymentConfigProblems`, moved verbatim out of the deleted file (the work order keeps it). |
| `src/voice/voice-gate.js` | `userAllowed` and the list are gone. New `identityPresent`, `entitlementClaimed` (the header read exactly), `voiceAvailableFor` (master switch and identity: the routes) and `voiceRenderableFor` (those and the claim: the surface); `gateState(engine, req)` renders from the latter. |
| `src/voice/voice-stream-auth.js` | `identityPresent` in place of `userAllowed`; no network call on the upgrade path. |
| `src/voice/voice-auth.js`, `src/middleware/mcpAuth.js` | Comments only. |
| `src/routes/voice.js` | The allowlist import, its drift and staleness reporting in `/voice/health`, and its boot line removed; the boot line names the gateway as the entitlement source. |
| `src/voice/voice-engines.js` | `assertTagless` call replaced by `guardRequest` (above). |
| `src/tools/coding-delivery.js` | **new.** The tool. |
| `src/utils/zipCentralDirectory.js` | **new.** Central-directory reader (refuses ZIP64), member inflate with size and CRC checks. |
| `src/utils/retentionCalibration.js` | **new.** |
| `src/server-http.js` | The tool listed and dispatched when configured; the reaper calibrated. |
| `scripts/voice-stream-smoke.mjs` | Step 3 is "blank identity refused 401"; `VOICE_TEST_USERS` removed. |
| `VOICE-DEPLOYMENT-VARIABLES.md`, `.env.example` | The allowlist section replaced by the seven deletions; the coding delivery variables; the reaper note. |
| `src/tests/coding-delivery.test.js` | **new.** 12 tests, against a fake frame runner. |
| `src/tests/route-inventory.test.js` | **new.** 3 tests. |
| `src/tests/retention-calibration.test.js` | 3 tests added (9 to 12). |
| `src/tests/voice.test.js` | The allowlist and gateway-mode tests removed with what they tested; the claim, C-08, C-10, C-11 added (42 to 27). |
| `src/tests/voice-auth.test.js` | Two tests renamed and repointed from "allowlisted" to "identified" (17 to 17). |
| `src/tests/voice-incremental.test.js`, `voice-segmenting.test.js`, `voice-engine-form.test.js`, `voice-elevenlabs-stt.test.js`, `voice-elevenlabs.test.js`, `voice-elevenlabs-race.test.js` | Their requests carry the claim header; `VOICE_TEST_USERS` lines removed. |
| `package.json` | 13.36.0 to 13.37.0. `package-lock.json` is left as uploaded (it reads 13.25.0 there; nothing enforces it). |

## Verified

Per-file runner, each `src/tests`, `tests`, `src/tools`, `src/tools-memory`
and `src/tools-self-model` test file in its own `node --test` process with
`--experimental-test-module-mocks`, plus `npm test`, against a dependency tree
from `npm ci` (the upload's `node_modules` lacks `better-sqlite3`).

| | files | tests | pass | fail | skipped | `npm test` |
|---|---|---|---|---|---|---|
| 13.36.0 as uploaded | 60 | 1295 | 1266 | 28 | 1 | 30/30 |
| 13.37.0 | 62 | 1298 | 1296 | 1 | 1 | 30/30 |

Executed delta +3, every file accounted for: coding-delivery +12 and
route-inventory +3 (new), retention-calibration +3, voice.test.js -15 (24
allowlist and gateway-mode tests removed with the module they tested, 9
added). The 27 failures that cleared (voice-elevenlabs-race 4,
voice-elevenlabs 9, voice-engine-form 6, voice-segmenting 8) are the
`assertTagless` fault above: each failing case logs `assertTagless is not
defined` when re-run on the uploaded tree. Net
new failures: 0. Carried, failing identically before:
`src/tests/voice-gpl-boundary.test.js` "no Piper artifact survives anywhere in
the source tree".

Mutations, `src/tests/coding-delivery.test.js`, `route-inventory.test.js`,
`retention-calibration.test.js`, `voice.test.js`, `voice-auth.test.js`: 16
applied, 16 red (C-DOWNLOADS-CONTENTS, C-NO-BUILT-URL, C-NEG-SUBSET-ZIP,
C-FRAME-PREDECESSOR, the sha256 check, C-CALIBRATION twice, C-NEG-UNAUTH-PUSH,
C-08, C-10, C-11, the render claim, the blank identity, the `assertTagless`
restoration, the narrow root class restored, the filename's tree binding
dropped).

End to end (Gateway Service 2.251.0 against PostgreSQL 16, this connector's
tool, tenax-frame 1.10.0 as a running service): 31 of 31 checks, including a
link verified by this connector's own verifier, a 259200-second expiry, the
complete archive under the seed's root, and a re-uploaded delivery whose next
archive records the sha256 of the one it supersedes. Run twice: with the root
`widget`, and with the root `My Été App` (delivered as `My Été App/` inside
`My-Ete-App-d1-<hash>.zip`).

Independent review (a separate reviewer that had not seen the work): one
blocking finding, fixed here and in the gateway and frame: the root rule
refused any folder name outside `[A-Za-z0-9._-]`, which the gateway accepted at
intake, so a project seeded from a folder such as `My App` could never be
published. One knowing finding acted on: the tool could replace any `.zip` in
the downloads directory; the file name is now bound to the tree.

## Not verified

A real `/data/downloads` volume on Railway, and a link opened from outside the
container. The voice surface in a real browser against a real gateway.
