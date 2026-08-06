# claude-connector v12.36.0

**Neural Core scans are now MANUAL TRIGGER ONLY.**

Nothing scans on deployment. Nothing scans on a schedule. Nothing scans as a
side effect of using the connector. `brain_scan.py` runs when a person asks for
it, and at no other time.

This release pairs with **ts-client-gateway v5.81.0**, which removes the
15-minute WordPress cron that was the other half of the automatic scanning.
Deploy them together: the connector change alone leaves the cron hitting
`POST /brain-scan` every 15 minutes, and the plugin change alone leaves the
connector scanning on every redeploy of a volume with no scan.

---

## The complete set of triggers after this release

| Trigger | Who starts it |
|---|---|
| `POST /brain-scan` | An operator, or the "Run scan now" button on Tenax Gateway > Neural Core Scan |
| `GET /brain-data?rescan=1` | A gateway user pressing Refresh in the Neural Core view |
| `POST /volume-restore` with `scan=1` (default) | An operator running a connector restore |
| `script_execute` on `brain_scan.py` | An operator running the script directly |

There are no others. `GET /brain-data/status` reports this as
`"triggerPolicy": "manual-only"` with `"automaticTriggers": []`.

---

## Removed

### 1. The boot scan (`bootScanIfMissing`)

`src/server-http.js` set a 15-second timer at startup which, if the volume held
no `ava_brain_data.json` or held an empty one, spawned `brain_scan.py`. Railway
builds a fresh container on every redeploy, so this made **deploy** a scan
trigger, which is exactly what this release exists to stop.

The function is deleted from `src/tools/brain-scan-trigger.js`, not merely left
uncalled.

**What replaces it:** `describeScanState()`, a read-only helper that reports
whether a usable scan exists without creating one. Boot now logs the state
instead of acting on it:

```
brain_scan: no scan on this volume. Run one manually (POST /brain-scan, or
Refresh in the Neural Core) - the connector will NOT scan on its own.
```

**Behaviour change you will notice:** a volume with no scan stays with no scan
until somebody asks for one. `GET /brain-data` returns 404 with an explanatory
`hint` and the `trigger_policy`, and `/brain-data/status` returns a
`scanRequiredAction` string. One press of Refresh fixes it. This is deliberate:
an honest empty state is preferable to a silent background process.

### 2. The debounced scheduler (`scheduleBrainScan`) and `RESCAN_TRIGGERS`

A 20-second debounce timer that called `runBrainScan({ force: true })`, plus the
allowlist of tool names it fired for (`module_write`, `skill_write`,
`skill_recompile` and eight others).

Both were **already unreachable in v12.35.0** — `onToolCompleted()` had stopped
calling the scheduler — so deleting them changes no observable behaviour today.
They are removed because a dormant "schedule a scan" function is the easiest
possible way for automatic scanning to return: one well-meaning line in
`onToolCompleted()` and the policy is silently undone.

### 3. The implicit scan on read in `GET /brain-data`

The condition was `if (wantsRescan || !existsSync(paths.dataPath))`, so an
ordinary page load of the Neural Core spawned Python whenever the file was
absent. A visitor asking for a picture is not a person asking for a scan. The
gate is now `if (wantsRescan)` alone.

---

## Security fixes in `POST /brain-scan`

This endpoint is promoted to the primary manual trigger, so it was reviewed
properly. Three defects were found and fixed.

**1. Authentication bypass (the significant one).** The guard was:

```js
if (allowedToken && token !== allowedToken) { return res.status(403)... }
```

With neither `DOCUMENT_DOWNLOAD_TOKEN` nor `RAILWAY_RESTORE_TOKEN` set,
`allowedToken` was `''`, the condition short-circuited to `false`, and **any
unauthenticated caller could spawn Python on the volume, repeatedly**. The
endpoint now fails closed with `503` when no token is configured.

**2. Timing side channel.** `token !== allowedToken` short-circuits on the first
differing byte. Now uses `constantTimeEquals`, matching every other privileged
route in the file.

**3. Type crash.** `req.query.token` is an **array** when a caller sends
`?token=a&token=b`, and `.trim()` on an array throws, turning a malformed
request into a `500`. Now coerced with `String()` first, matching `/brain-data`.

The endpoint also now returns `404` when `brain_scan.py` is not on the volume
and `503` when `BRAIN_SCAN_ENABLED=false`, rather than reporting a generic
failure, and includes `duration_ms` and `trigger_policy` in its response.

---

## Added

### Scan provenance

`runBrainScan()` accepts a `trigger` label, recorded and logged, so every scan
can be attributed after the fact:

```
brain_scan: starting (trigger: POST /brain-scan, forced)
```

`getBrainScanPaths()` and `GET /brain-data/status` now report `triggerPolicy`,
`manualTriggers`, `automaticTriggers`, `bootScanEnabled`, `scheduledScanEnabled`,
`lastScanTrigger`, `lastScanOk`, `lastScanFinished` and `scanCount`. On a healthy
idle instance `scanCount` is `0`, which is the quickest way to confirm the policy
is holding in production.

### `src/tests/brain-scan-manual-only.test.js`

Twenty tests, run with `npm run test:brain-scan`. The property under test is a
negative one — "nothing starts a scan by itself" — which no behavioural test can
prove alone, so the suite has two halves: behavioural tests over the real module
using a temporary AVA directory, and literal source assertions over
`server-http.js`, `brain-scan-trigger.js` and `volume-snapshot.js` that fail if
an automatic call site reappears.

It also asserts the manual paths still work, because a change that removed the
buttons would pass every negative test and be entirely wrong.

Verified by negative control: reintroducing `bootScanIfMissing()` into
`server-http.js` fails test 13.

---

## Unchanged, and why

**`writeToolCatalog()` still runs at boot.** It writes one small JSON file
(`brain_tools_catalog.json`) recording the connector's live tool registry. It
spawns nothing and is not a scan. Keeping it at boot means the catalogue is
correct and in place for whenever a manual scan is next requested.

**`POST /volume-restore` still scans by default.** A restore is an operator
action started by a human pressing Restore, and `scan` defaults to `1` only
within that action. Pass `scan=0` to restore without scanning. `tests/volume-snapshot.test.js`
asserts this behaviour and all 26 of its tests still pass.

**`onToolCompleted()` still writes `last_compile.json`.** The compile record is
what lets the visualiser light up the modules loaded this session. It is
record-only and must stay that way: a tool call is not a manual trigger.

**`BRAIN_SCAN_ENABLED=false` still works** as a hard kill switch that disables
even the manual triggers. It is not the control for automatic scanning, because
there is no longer any automatic scanning to control.

---

## Files changed

| File | Change |
|---|---|
| `src/tools/brain-scan-trigger.js` | Removed `bootScanIfMissing`, `scheduleBrainScan`, `RESCAN_TRIGGERS`, `DEBOUNCE_MS`. Added `describeScanState`, trigger provenance, policy fields. |
| `src/server-http.js` | Removed the boot scan and its import. Removed the implicit scan in `GET /brain-data`. Hardened `POST /brain-scan`. Extended `/brain-data/status`. |
| `src/routes/volume-snapshot.js` | Labelled the restore-path scan for provenance. Comment explaining why it survives the policy. |
| `src/tests/brain-scan-manual-only.test.js` | New. |
| `package.json` | 12.35.0 -> 12.36.0. Added `test:brain-scan`. |
| `package-lock.json` | Version bump only. No dependency changes. |

## Verification performed

- `npm run test:brain-scan` — 20 passed, 0 failed.
- `npm run test:security` — 61 passed, 0 failed (no regression).
- `node --test tests/volume-snapshot.test.js` — 26 passed, 0 failed (no regression).
- `node --check` on both modified source files.
- Negative control confirming the new suite fails when a boot scan is reintroduced.
- Lockfile diffed against v12.35.0: the only change is the version field. No
  dependency drift, so `npm ci` in the Dockerfile stays reproducible.

## Deployment

No new environment variables. No volume migration. No schema change.

After deploying, confirm the policy in the logs:

```
Neural Core scan triggers: MANUAL ONLY (POST /brain-scan, GET /brain-data?rescan=1, POST /volume-restore). No boot scan, no cron, no tool-hook scan.
```

If the volume already holds a scan, nothing else is needed. If it does not, run
one manually once.
