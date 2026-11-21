# claude-connector v13.41.0

WO-ISO-276-001 rev 1 A3, the connector half: every tenant-mode memory call
names the account it acts for. And for TENAX-2026-10-23-01, `/skill-export`
also returns a tenant-mode connector's own directory, the one its compile
reads. Built on 13.40.0 as attached on 2026-10-24.
Ships with Gateway Service 2.277.0. **Deploy this connector first**: 2.276.0
already accepts the field it sends, and 2.277.0 refuses a memory request
without it.

## Why

In tenant mode every `memory_*` tool calls the gateway's `/memory/*` routes.
Until Gateway 2.277.0 those routes accepted a request with no `user_id` and
fell back to tenant-wide and ownerless rows, so every account on a tenant read
the same rows. 2.277.0 refuses a memory request that does not name an account
on the api key's tenant (`memory_scope_refused`, `user_required`). This
release names one.

## Changes

- **`src/utils/callContext.js` (new).** The identity of the caller of one tool
  call, held with `AsyncLocalStorage` for everything that call awaits, so two
  calls in flight at once each see their own account. `resolveMemoryUserId()`
  takes, in order:
  1. a gateway-proxied call (`POST /tool-call` with a `context` naming a
     tenant or a user) acts for the context's `user_id` and nothing else; a
     context with a tenant and no user is refused;
  2. a call with no gateway context (a direct MCP session) acts for
     `TS_CLIENT_USER_ID`, the one account that connector serves (Gateway
     `scripts/provision-tenant.mjs verify` prints it);
  3. otherwise a refusal.
  A value that is present but is not a positive whole number is refused. In
  no case is a call completed under a different identity from the one it
  carries. The process-wide
  `getCurrentUser()` (tools-self-model/sessionContext.js, the last
  `ts_gateway_session_init`) is deliberately not used: with two sessions open
  it holds whichever started last.
- **`src/server-http.js`.** `dispatchToolCall` runs each call inside
  `runWithCallContext( context, ... )`. Nothing else in the dispatcher changed.
- **`src/tools-memory/wp-memory.js`.** In tenant mode, `wpFetch` sets
  `body.user_id` from `resolveMemoryUserId()`, or throws `ToolError`
  `TENANT_USER_REQUIRED` (400) before anything is sent, with the reason and how
  to fix it. Owner mode is unchanged.
- **`.env.example`, `src/config.js`:** `TS_CLIENT_USER_ID` documented.

### `GET /skill-export` carries a tenant-mode connector's own directory

Gateway 2.277.0's random module draw (TENAX-2026-10-23-01) derives its pool
from this export. A tenant-mode connector (`TS_CLIENT_MODE=tenant`,
`TS_TENANT_ID` set) compiles from `/data/clients/{tenant}/`, manifest and
module bodies alike (`getModularPaths().avaDir`, `paths.avaDir +
module.path`), but the export returned only the owner's `ava/` directory, so
the draw registered and budgeted modules against the wrong manifest (found in
the gateway's independent review; the administrator chose to fix it here on
2026-10-24).

- **`src/utils/skillExport.js` (new).** The export walk, moved out of the
  route with its rules unchanged (personal files, dotfiles and other
  extensions excluded), and `buildSkillExport()`, which adds
  `client: { tenant_id, dir, files, file_count }` on a tenant-mode connector
  whose client directory exists.
- **`src/server-http.js` `GET /skill-export`** builds its body with it. The
  response is a superset: `files`, `file_count` and `ava_dir` are as before,
  so the gateway's `/restore-modules` backup and every other reader are
  unaffected. No change to compile, dispatch or any tool.

## Variables

| Variable | Default | Effect |
|----------|---------|--------|
| TS_CLIENT_USER_ID | unset | Tenant mode only. The gateway account (`ti_users.id`) memory calls act for when a call carries no per-call user. Unset, with no per-call user, memory tools refuse with `TENANT_USER_REQUIRED` |

## Tests

- **`src/tests/memory-user-forwarding.test.js` (new, 11 tests):** the per-call
  user is forwarded; `TS_CLIENT_USER_ID` names the account when there is none;
  the per-call user wins; no account is refused before anything is sent; a
  malformed per-call id is refused, never replaced by the configured one; a
  gateway call naming a tenant and no user is refused, never given
  `TS_CLIENT_USER_ID`; a malformed `TS_CLIENT_USER_ID` is refused; two concurrent calls (each yielding
  before it reaches the transport, the first-started finishing last) each name
  their own account; `positiveUserId`; resolution outside any call scope
  refuses; `dispatchToolCall` runs the core inside the scope.
- **`src/tests/memory-capacity.test.js`, `memory-tiered-passthrough.test.js`,
  `memory-write-guard.test.js`:** each tenant-mode case sets
  `TS_CLIENT_USER_ID=7` before its call and deletes it after. No assertion
  changed.
- **`src/tests/skill-export-client.test.js` (new, 5 tests):** owner mode
  exports exactly what it did; tenant mode adds `client` with the tenant's
  directory under the same rules and leaves `files` unchanged; no `client`
  when the directory does not exist; personal files never leave either
  directory; the route builds its body from the connector's own client
  directory.
- **Mutations:** `npm run wo-iso-276-001:mutations` runs 10 named mutations
  over 7 claims, each demonstrated red with a green control.

## Ancillary (found while running the before-suite)

- **The shared guard and its fixture arrived with CRLF line endings** in the
  attached 13.40.0 archive (`src/tools-memory/memoryWriteGuard.js`,
  `src/tests/fixtures/memory-guard-fixture.json`). The content is identical to
  Gateway Service's `lib/memory-write-guard.js` and
  `tests/fixtures/memory-guard-fixture.json` apart from the line endings, but
  the C-TWIN-PARITY test pins the bytes, so it failed on the attached tree.
  Both files are restored to LF, the bytes both services pin (guard
  `a2a6ac99...0639`, fixture `12c9bde4...7a45`) and the bytes the archive's
  own git HEAD holds; the test passes. The attached working tree differs from
  its git HEAD (c1bca6b) only by line endings in eight files (`git diff
  --ignore-space-at-eol` is empty for all eight); the other six
  (src/routes/export.js, src/tests/bundle-ingest.test.js,
  src/tools/ti-relational-principles-client.js and three under src/voice/)
  are left as attached. If a checkout converts line endings, add
  `src/tools-memory/memoryWriteGuard.js -text` and
  `src/tests/fixtures/memory-guard-fixture.json -text` to `.gitattributes`.
- `package-lock.json` still names 13.25.0 at its root, as it has since 13.25.0;
  no dependency changed, so it is left as delivered.

## Not changed

The dispatch layer, skill compilation, the module volume and its manifests,
and every tool other than the tenant-mode memory transport. The random module
draw itself is the gateway's (Gateway 2.277.0 `skill_load_random`); the only
connector change for it is the additive `client` field on `/skill-export`.
