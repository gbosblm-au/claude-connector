# claude-connector v12.29.0

**Phase 1 — Reliability, Cycle 2A** — audit `TNX-AUDIT-2026-08`, Section 8, Phase 1.

Follows v12.28.0 (Phase 0 incident response).

---

## BREAKING CHANGES

### The health check path has moved

`railway.toml` and the `Dockerfile` `HEALTHCHECK` now point at `/health/ready`.
`/health` remains as an alias, so an unchanged platform configuration keeps
working, but it now returns **503** when the instance is not ready. If your
monitoring treats any non-200 as an outage, expect it to start reporting
correctly rather than silently reporting `ok`.

### `web_fetch_page` and image download now refuse private addresses

Any tool call targeting loopback, RFC1918, link-local, CGNAT or the cloud
metadata endpoint now fails with an explicit refusal. If a workflow legitimately
fetched an internal host through the connector, it will break, and that is the
point of the change. Route such calls through a service that is meant to expose
them.

### Ports other than 80, 443, 8080 and 8443 are refused

Override with `SAFE_FETCH_ALLOWED_PORTS` if a provider genuinely uses another.

---

## Findings remediated

### TNX-C-009 — Server-side request forgery (Critical)

`src/tools/webFetch.js` validated only the URL scheme and then fetched with
`redirect: "follow"`. A repository-wide search for `169.254`, `isPrivateIp`,
`blockPrivate` or any allowlist construct returned no SSRF controls in any tool.

Combined with the previously unauthenticated MCP surface (TNX-C-001), an
anonymous caller could use the connector as a proxy into the private network:
cloud instance metadata and short-lived IAM credentials at
`169.254.169.254`, the connector's own routes on localhost from inside the trust
boundary, and the Gateway Service and Postgres on the internal network.

**Added** `src/utils/safeFetch.js`. Three distinct bypasses had to be closed, and
each needed a different control:

| Bypass | Control |
|---|---|
| `redirect: "follow"` lets a public URL 302 to a private one | `redirect: manual`, every hop revalidated, hop cap |
| DNS rebinding: the check resolves public, the connect resolves loopback | Resolve once, validate, then pin the approved IP |
| Decimal, octal and IPv6-mapped encodings | Classification runs on the resolved binary address |

**On the pinning implementation.** Node's built-in `fetch` cannot override DNS
resolution, so this module uses `node:https` with the documented `lookup`
option, which is passed through to `net.createConnection`. No new dependency was
added for it.

The important detail is *how*. Rewriting the URL to an IP literal would pin the
address and break TLS, because both the SNI extension and the certificate
hostname check derive from the URL host. Instead the hostname stays in the URL
and only address resolution is overridden, so certificate validation remains
fully intact. `rejectUnauthorized: true` is set explicitly.

Two hardening details beyond what the audit specifies: `Authorization` and
`Cookie` are stripped on a cross-origin redirect, because otherwise an
attacker-controlled endpoint could redirect to a host of its choosing and
receive the caller's credentials; and URLs containing embedded credentials are
refused outright.

**Scope correction.** The audit lists fifteen URL-taking modules. Auditing them
individually, only **four** accept a URL from tool input: `webFetch`,
`imageDownloader`, `wordpressMedia` and `leadSearch`. The others derive their
URLs from environment configuration or fixed API constants:

| Module | URL source |
|---|---|
| `wordpress.js` | `WP_URL`; its `args.url` is menu-item data that is never fetched |
| `googleDrive.js`, `googleCalendar.js`, `googleSheets.js` | fixed API constants |
| `avaMemorySync.js` | `AVA_MEMORY_WP_URL` |
| `ti-tools-client.js`, `ti-relational-principles-client.js` | `GATEWAY_URL` |
| `imageSearch.js`, `newsSearch.js`, `webSearch.js` | provider API endpoints |
| `linkedinOAuth.js` | OAuth endpoints and the configured redirect URI |
| `messaging.js`, `marketPublisher.js`, `clientCheckin.js` | configured webhook targets |

Routing those through `safeFetch` would add no security and would break
legitimate calls to configured internal endpoints. Reporting fifteen migrated
would have been inaccurate.

**A bug found during verification.** `[::1]` was being refused, but by accident:
WHATWG `URL.hostname` keeps the square brackets, so `isIP('[::1]')` returned 0,
the value fell through to a DNS lookup, and the request failed on `ENOTFOUND`
rather than on policy. The caller received an opaque resolution error, and any
change to resolution behaviour could have turned the accident into a bypass.
Brackets are now stripped so IPv6 literals are classified deliberately.

**Not in this release, and deliberately so.** Application-level SSRF defence is
necessary but it is not what makes the system robust. Two infrastructure
changes are still required and cannot be made in code:

1. Deploy the connector with an **egress network policy** restricting outbound
   traffic to the known provider domains.
2. Disable the cloud metadata endpoint at the platform level, or enforce an
   IMDSv2 equivalent that requires a PUT-obtained token.

### TNX-H-004 — The health check could not report ill health (High)

`status` was the string literal `"ok"`. Nothing was verified: not the `/data`
volume mount, not the SQLite memory database, not disk writability, not
configuration validity. Because `railway.toml` and the `Dockerfile` both polled
it, an instance whose volume had failed to mount — the failure mode that
silently destroys the memory store and the credentials file — kept receiving
traffic, and the restart policy could never fire for anything short of a process
exit.

Three endpoints now, answering three different questions:

- **`/health/live`** — process alive. No I/O, no dependencies. **Stays 200
  during drain and during a storage outage**, deliberately: a liveness probe
  that touches storage will fail during a storage outage and cause the
  orchestrator to restart a healthy process, turning a recoverable dependency
  failure into a crash loop.
- **`/health/ready`** — should traffic be routed here. Probes the volume with an
  actual write, because presence is not enough; a read-only or full volume
  presents as mounted and then fails every write. Checks the memory subsystem
  (non-critical: six of roughly sixty tools depend on it, so its failure should
  not remove the whole instance from rotation) and configuration validity.
  Returns 503 while draining or on any critical failure.
- **`/health`** — alias of `/health/ready`.

### TNX-H-006 — The connector lacked the process guards the gateway has (High)

The complete process handling was two lines:

```js
process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
```

It looks correct and is not. `httpServer.close()` waits **indefinitely** for
open connections to end, and this connector serves SSE, which by definition does
not end. The callback was therefore never invoked, the process never exited,
Railway SIGKILLed it after the grace period, and every in-flight tool call —
including long-running `script_execute` invocations — was severed mid-frame. The
old handler did not merely fail to drain; it guaranteed a hard kill on every
single redeploy.

**Added** `src/utils/serviceRuntime.js`:

- `unhandledRejection` → log with full stack, **keep running**. A rejected
  promise in one tool handler says nothing about the health of the other sixty.
- `uncaughtException` → log, **exit non-zero**. By the time this fires the stack
  has unwound past every catch block; the process is in an indeterminate state
  and any further work it does is unpredictable, which is worse than being down.
- Drain: fail readiness, wait `PRESTOP_DELAY_MS` for the platform to deregister,
  notify SSE sessions, flush the schedule store, **destroy SSE sockets so
  `close()` can actually return**, then exit. An unref'd forced-exit timer
  guarantees termination inside the grace window regardless.
- The four HTTP timeouts. `keepAliveTimeout` was at Node's 5-second default,
  **below the idle timeout of essentially every reverse proxy**, so the proxy
  reused a socket Node had already decided to close and the client saw an
  unexplained `ECONNRESET` — exactly the symptom the gateway's own comments
  describe having diagnosed. `headersTimeout` is enforced as `keepAlive + 5000`;
  if it were lower, Node could time out waiting for headers on a socket it was
  still willing to keep alive. `server.timeout` is left at 0 because a non-zero
  socket inactivity timeout silently kills idle SSE streams.

This module is written as a standalone, dependency-free unit with an injected
configuration surface, so promoting it to the shared `@tenax/service-runtime`
package the audit schedules for Phase 2 is a move rather than a rewrite.

### TNX-M-021 — No security headers on either Node service (Medium)

`helmet` 8.3.0 and `compression` 1.8.1 added, both verified against the official
npm registry before use (MIT; `helmet` has zero dependencies; `npm audit`
reports no vulnerabilities).

`helmet` is configured **explicitly** rather than mounted with its defaults,
because two of them would be wrong here. `contentSecurityPolicy` is disabled
because the connector already sets its own `frame-ancestors` policy derived from
`MCP_ALLOWED_ORIGINS` and a much stricter sandbox policy on `/preview` responses
(TNX-C-010); letting helmet install a second, weaker default would overwrite
both. `crossOriginResourcePolicy` is disabled because the Tenax chat surface
loads `/api/config.js` and the preview iframe cross-origin by design.

**The compression filter is load-bearing, not a tuning detail.** `compression()`
buffers output to build deflate blocks, which is fundamentally incompatible with
SSE: each frame must reach the client the moment it is written. Mounting it with
the default filter would hold MCP frames in the compressor and stall the
transport in a way that presents as a network fault rather than a configuration
one. `/sse`, `/messages` and `/mcp` are excluded by path as well as by content
type, because the content type is not set until the transport writes its first
frame, which is after the filter has already run.

Verified: the tool manifest compresses from 108 KB to 27 KB, while an SSE
response carries no `Content-Encoding` at all.

### TNX-M-023 — Global 50 MB body limit (Medium)

Reduced in v12.28.0; unchanged here. Recorded for completeness.

---

## Verification performed

38 automated tests, all passing:

```
node --test src/tests/phase0-security.test.js
```

New in this release: every reserved IPv4 and IPv6 range refused including both
`/8` edges and all three IPv4-mapped forms; public addresses still permitted;
non-http schemes and credential-bearing URLs refused; a hostname resolving to a
private address refused; the `[::1]` regression guard; a source-level assertion
that the four migrated tools still import `safeFetch`; readiness reporting for
critical, non-critical and false-returning checks; and an assertion that
`headersTimeout > keepAliveTimeout` and that `server.timeout` stays 0.

Live container verification against the audit's acceptance criteria:

| # | Criterion | Result |
|---|---|---|
| 2 | Refuses to boot without `MCP_API_KEY` | exit code 1 |
| 9 | `web_fetch("http://169.254.169.254/")` refused | refused, through the real tool handler |
| 14 | `/data` unmounted → readiness 503 | 503, liveness stayed 200 |
| 16 | SIGTERM exits within the grace window | clean exit, full drain sequence logged |

The SSRF criteria were exercised through the live `web_fetch_page` MCP handler,
not only against the classifier, so the guard is verified on the path a caller
actually reaches.

## Still outstanding in this component

`TNX-H-001` stage 1 (externalising correctness-critical state) is Cycle 2C.
`TNX-H-014` (credential store on the wrong filesystem path, in plaintext) is
Cycle 2B and remains a live data-loss risk until then.
