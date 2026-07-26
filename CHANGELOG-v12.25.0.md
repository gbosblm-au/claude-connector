# Connector v12.25.0 - Per-user-per-tenant self-model identity

Fixes self_model rows being written to Postgres with null user_id/tenant_id, and
removes the two previous defective approaches (async import race and hardcoded
env-var identity). Identity is now carried per tool call and is concurrency-safe.

## Root cause

The connector never actually knew which user a tool call belonged to. The
gateway's `/tool-call` proxy sent only `{tool_name, tool_input}` with a
tenant-scoped restore token; no user identity ever reached the connector. The
self-model recorder therefore had nothing real to send, and the earlier
workarounds made it worse:

- A process-global "current user" in sessionContext.js, which a single connector
  process (serving many users) would overwrite between concurrent sessions,
  causing cross-user contamination.
- An async `import()` of sessionContext inside each recorder function that raced
  the POST and usually resolved after the request had already been sent.
- `process.env.TENANT_ID` / `process.env.USER_ID` fallbacks that hardcoded one
  identity for every user.

## Fix (identity travels with each call)

The gateway now injects the session's `{tenant_id, user_id}` (the same pair the
memory tools use) as a `context` object on every proxied `/tool-call`. The
connector threads that per-call context into the self-model recorder, so every
recorded row is attributed to the correct user, and concurrent users never
overwrite one another.

### Files changed

- `src/server-http.js`
  - `/tool-call` now reads `context` from the request body.
  - `dispatchToolCall(name, args, context)` forwards it to the self-model hook.
    (The direct-MCP dispatch path passes no context and falls back to session
    context, unchanged.)
  - MCP server version string bumped to 12.25.0.
- `src/tools-self-model/hook.js`
  - New exported `resolveRecordingIdentity(context)`: per-call context is
    authoritative; falls back to session context only when none is supplied;
    never falls back to env vars.
  - `selfModelRecordToolCall(name, args, result, startedAt, context)` resolves
    identity once and threads it into every recorder call. On
    `ts_gateway_session_init` it also seeds the session context (from the
    per-call context when present, else the session-init result).
- `src/tools-self-model/recorder.js`
  - Every write function takes an explicit `identity` and passes it straight to
    the gateway POST -- no async import race.
  - Removed the `process.env.TENANT_ID` / `process.env.USER_ID` hardcode.
  - Local SQLite writes are unchanged; identity only scopes the gateway POST.
- `src/tools-self-model/sessionContext.js` - unchanged (still the fallback for
  direct-MCP calls).

## Scope note

Per-user identity for self-model requires the gateway-proxied path, because only
the gateway holds the user's JWT. Tools that the gateway handles locally (e.g.
the Postgres memory tools) do not pass through the connector and are not recorded
by the connector self-model hook -- that is unchanged, pre-existing behaviour.
A pure direct-MCP session with no gateway cannot know the user_id (the tenant API
key is tenant-scoped), so those records remain null-scoped by design.

## Deploy

Deploy alongside gateway v2.24.0. Required env vars on the connector:
- `GATEWAY_URL` (or `TS_TENANT_GATEWAY_URL`) - the gateway base URL.
- `GATEWAY_ADMIN_KEY` - the ingest admin key (owner connector).

The previously suggested `TENANT_ID` / `USER_ID` env vars are no longer used and
can be removed.

## Tests

`src/tools-self-model/identity-scoping.test.js` (7) - real hook + recorder
against a temp SQLite DB with fetch mocked: context is authoritative; session
context fallback; no env-hardcode fallback; tool/session/module/compile events
all carry the context identity; session-init seeding; and two interleaved users
do not contaminate each other. Existing self-model tests (14) still pass.
