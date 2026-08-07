# claude-connector v12.39.0

**Calibrate document retention to 3 days across all three lifetime settings.**

Released 8 August 2026. Minor release: changes default behaviour, adds no new
required configuration. Ships together with Gateway Service v2.65.0; see the
deployment note at the end.

---

## Summary

| Setting | Was | Now |
| --- | --- | --- |
| `LINK_EXPIRY_SECONDS` (signed link HMAC validity) | 3600 (1 hour) | **259200 (3 days)** |
| `DOWNLOADS_TTL_HOURS` (artefact deletion from `/data/downloads`) | 336 (14 days) | **72 (3 days)** |

The companion Gateway Service release sets `DOCUMENT_TTL_DAYS` to 3 to match.

---

## Why the link lifetime changed too

The original request covered two settings: the sidebar document lifetime and
artefact deletion. Investigation found a third that had to move with them.

The Gateway Service persists this connector's signed `download_url` and
`preview_url` onto a `ti_documents` row, and the WordPress sidebar serves those
URLs unchanged for the row's entire life. The signature inside them carries its
own expiry, governed by `LINK_EXPIRY_SECONDS`.

At the previous settings that expiry was **one hour** against a **fourteen day**
row lifetime. Measured behaviour before this release:

```
T+30min  -> WORKS             | sidebar countdown: "Expires in 14 days"
T+2h     -> REFUSED (expired) | sidebar countdown: "Expires in 14 days"
T+3d     -> REFUSED (expired) | sidebar countdown: "Expires in 11 days"
T+13d    -> REFUSED (expired) | sidebar countdown: "Expires in 1 days"
```

Every Preview and Download button in the sidebar was dead after an hour and then
sat there for a fortnight beneath a live countdown. Nothing logs an error until
a user clicks, which is why this was not visible in monitoring.

Calibrating only the two originally named settings would have left this intact
and the sidebar would still have broken after an hour. All three now expire
together at 3 days.

---

## Ordering constraint between the two connector settings

`DOWNLOADS_TTL_HOURS` must never be set **below** `LINK_EXPIRY_SECONDS`.

The reaper keys off file mtime, and links are minted at file-creation time, so
equal values mean the file outlives its link by up to one sweep interval
(`UPLOAD_SWEEP_INTERVAL_MS`, default 15 minutes). That is the safe direction: a
late user gets the intended "link expired" message rather than a 404 on a link
that still looks valid. Inverting it produces the 404.

`src/tests/retention-calibration.test.js` asserts this inequality holds, so the
constraint is enforced rather than merely documented.

---

## Changes

### `src/utils/signedUrls.js`

`DEFAULT_EXPIRY_SECONDS` changed from `3600` to `259200`. The constant now
carries a docblock naming all three calibrated settings, where each lives, and
what breaks when one is changed alone.

The 30 day cap and the fallback behaviour for zero, negative and non-numeric
values are unchanged. 259200 sits well under the cap, which is asserted so the
cap cannot silently clamp the new default.

### `src/server-http.js`

`DOWNLOADS_TTL_HOURS` default changed from `14 * 24` to `3 * 24`, with a
docblock covering the calibration and the ordering constraint above. The stale
`/** Sweeps /data/downloads on the 14d artefact policy. */` comment is corrected.

The boot log line already reported the window in days and is unchanged, so a
misconfiguration remains visible at startup.

### `.env.example`

`LINK_EXPIRY_SECONDS` documentation updated to the new default, with a
cross-reference block naming all three settings so an operator changing one is
told about the other two.

Added documentation for three variables that were previously undocumented
despite being live and env-configurable:

- `DOWNLOADS_TTL_HOURS`, including the ordering constraint.
- `DOWNLOADS_PROTECTED`, the reaper's never-delete list.
- `UPLOAD_SWEEP_INTERVAL_MS`, the sweep granularity.

### `src/tests/retention-calibration.test.js` (new)

Nine tests. The substantive ones:

- The reaper window is greater than or equal to the link lifetime.
- A link is valid at 1 hour, 1 day and 2d23h, and refused just past 3 days. The
  1 hour assertion is the specific regression being locked down.
- A link minted at row-creation time is sampled every 6 hours across the full
  3 day row lifetime and must verify at every point.
- `.env.example` advertises the calibrated values, including a pointer to the
  Gateway Service setting.

### `src/tests/signed-urls.test.js`

Three assertions that pinned the old 3600 default are updated. These were
changed deliberately rather than allowed to fail: the old value was the
specification, and the specification has changed.

---

## Verification performed

| Check | Result |
| --- | --- |
| `node --check` on both modified modules | Passes |
| `retention-calibration.test.js` | 9 / 9 pass |
| `signed-urls.test.js` | 28 / 28 pass |
| `preview-signature-alignment.test.js` | 10 / 10 pass |
| `phase0-security.test.js` | 61 / 61 pass |
| All 7 connector suites | **166 / 166 pass** |

---

## Compatibility and deployment

**Links already in circulation are unaffected.** The signing scheme, secret and
payload are unchanged. An outstanding link keeps the expiry it was signed with;
this release changes only what newly issued links get.

**No secret rotation, no migration, no new required configuration.** Both values
remain env-overridable; a deployment that already sets them explicitly is
unaffected by the default change.

**Files currently on the volume.** The reaper keys off mtime and applies the new
72 hour window on the next sweep. Anything in `/data/downloads` older than three
days will be deleted at the first sweep after deploy, where previously it had up
to fourteen days. If that volume holds anything that must survive, add it to
`DOWNLOADS_PROTECTED` before deploying. `ava_brain_data.json` is already
protected by default.

**Ordering against Gateway Service v2.65.0.** Either order is safe. Deploying
this first means new links are valid for 3 days while rows still live 14, so the
mismatch shrinks from 1 hour to 3 days but is not fully closed until the Gateway
Service release lands. Deploying the Gateway Service first means rows live 3 days
while links last 1 hour, which is the pre-existing behaviour. Neither
intermediate state is worse than what is running today.
