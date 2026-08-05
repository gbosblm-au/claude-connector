# Tenax Gateway v2.59.0 + claude-connector v12.35.0

**Phase 2 items 9, 10 and 11.** Dead code, duplicated configuration, and
controls that failed open.

---

## The connector's stdio entry point could not start at all

**TNX-M-003.** `src/tools/emailTracking.js` was **0 bytes**, and `src/index.js`
imported six named exports from it. An ES module named import from a module that
exports nothing is a **link-time** error, so:

```
npm run start:stdio
SyntaxError: The requested module './tools/emailTracking.js'
             does not provide an export named 'emailGetTrackingToolDefinition'
```

`server-http.js` never imported the file — it only reads
`config.emailTrackingEnabled` — which is why the HTTP transport kept working and
this went unnoticed.

I searched the whole tree before removing the references: `emailGetTracking`,
`emailTrackingSummary` and `emailReplyCheck` are implemented **nowhere**, and
the HTTP transport does not register them either. The only remaining trace was a
stale comment. This is not a move; the implementation is gone.

**Flagged rather than papered over:** `email_get_tracking`,
`email_tracking_summary` and `email_reply_check` are unavailable on **both**
transports and have been for some time. Open and click *collection* still works
— `/track/open` and `/track/click` are live — so the data is being recorded;
only the tools that query it are missing. Restoring them needs source that is
not in this artifact.

`npm run start:stdio` now starts. It announces `v9.0.0`, which is further
version drift in the connector, noted for a later pass.

---

## Item 11 — dead code

**TNX-M-002, duplicate `GET /tools`.** Registered twice; Express dispatches to
the first, so the second was unreachable. I compared them rather than assuming
the later was intended, because the audit notes *"it is unclear which was
intended"*:

| | live (kept) | second (removed) |
|---|---|---|
| `X-Railway-Restore-Token` | yes | **no auth at all** |
| tenant write-tool filter | yes | yes |
| MCP → Anthropic schema | yes | no |

The dead one added nothing and would have **removed authentication** had the
registration order ever been reversed — which a routine reordering of a
3,500-line file could do silently. A boot assertion now fails the process on any
duplicate method/path pair.

**TNX-M-004, committed SQLite database.** `_memory_`, 53 KB, created by a path
misconfiguration (the intended path is `/data/memory.db`). The audit asked for
the two rows to be reviewed for sensitive content: both are test fixtures
(`count_test_fact`, `count_test_conv`). Deleted, and a `.gitignore` added — the
repository had none, which is why nothing prevented it.

**TNX-M-006, orphaned migration module.** `ti-migration.js` was never imported,
documented a third admin header name, and declared a `TABLE_MANIFEST` with
import/export endpoints that would bulk-write tenant data if mounted. Deleted.

Its third header name had spread: three route files documented
`X-TS-Admin-Key` in comments, which `adminAuth.js` has **never** accepted — it
reads `x-admin-key` or a bearer token. An operator following those comments got
a 401 with no indication why. Corrected to the real names rather than adding a
third live header.

**TNX-M-005, version drift.** `const VERSION = '2.32.0'` against a
`package.json` of 2.58.0 — **twenty-six minor versions stale** — and `/health`
reported it. During an incident the first question is "which build is running",
and the answer was wrong by two years of releases. Now read from the manifest.

---

## Item 9 — one model registry

**TNX-M-013.** The 26-entry registry existed twice: the real one in
`routes/ti-chat.js`, and a second inline in `server.js` for
`POST /admin/test-model`, added as a *"Minimal inline registry for the test
endpoint"*.

Two tables that must agree and nothing making them agree. The failure mode is
specific and unhelpful: **the connectivity test passes for a model chat cannot
use**, or fails for one it can. An operator reaches for that endpoint precisely
when something is already wrong, which is the worst moment for it to be testing
a different configuration from the one in use.

Extracted to `lib/model-registry.js`. The `ti-chat` copy was the richer of the
two (`label`, `supportsTools`, `supportsVision`) and became the source.

All four Qwen entries hardcoded a tenant-specific Alibaba workspace URL. That is
deployment configuration living in source: unchangeable without a release, wrong
for any other tenant, and it identifies the workspace to anyone reading the
repository. Now `QWEN_BASE_URL`, defaulting to the same value so no deployment
changes on upgrade.

`routes/describe-image.js` had the same URL under a **different** variable name
(`QWEN_API_URL`). Two names for one endpoint means setting one and missing the
other, which presents as "vision works but chat does not". It now falls back to
the shared `QWEN_BASE_URL`, with the original name still honoured first.

---

## Item 10 — configuration cannot silently disable security

Audit section 5.3 lists six controls wired to **fail open**: `MCP_API_KEY`,
`WEBHOOK_SECRET`, `WC_WEBHOOK_SECRET`, `TI_FRONTEND_ORIGINS=*`, `AUTH_KEY`,
`WORKFLOW_SECRET_KEY`.

The common shape is what makes this systemic rather than six separate bugs: **a
missing value produced a working service with a control switched off.** Nothing
failed, so nothing was investigated, and a secured deployment was
indistinguishable from an unsecured one from the outside.

Several already printed a warning at boot. That is not enough, and the audit
says so: a startup banner scrolls past once and the service that printed it
keeps serving. **Visibility is not a control.**

`assertConfig()` runs before the listener binds, classifying each variable:

| Class | Missing behaviour |
|---|---|
| `required` | exit non-zero |
| `security` | **exit non-zero in production** — may not default to disabled |
| `feature` | disabled **explicitly and by name**, logged at warn |
| `optional` | documented default, logged at debug |

The `feature`/`security` split is the point. A missing SMTP host should disable
email and let the rest run. A missing webhook secret must **not** disable
signature verification and let the webhook keep accepting calls.

Development remains workable — the same omissions are warnings there, each
stating that it is fatal in production — because a check that makes local work
impossible gets bypassed wholesale.

---

## Verification

```
Gateway    719 passed, 0 failed   (14 new tests for items 9/10/11)
Connector   61 passed, 0 failed   + stdio entry point now starts
Plugin      43 passed, 2 known-failing, 0 NEW
```

**Two of my own test assertions were wrong and I fixed the tests, not the code.**
One matched the workspace URL per line and broke because the declaration wraps.
The other searched for `const VERSION = '...'` and matched **its own
explanatory comment**, which quotes the removed line verbatim. Both now strip
comments first. A test that fails against correct code is worse than no test,
because it trains people to edit assertions until they pass.

## Remaining in Phase 2

Items 6 and 7 — converting source-text tests to real integration tests, and
Playwright coverage for the chat surface (TNX-H-012).
