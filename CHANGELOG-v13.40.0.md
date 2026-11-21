# claude-connector v13.40.0

TENAX-2026-10-17-03, the connector half: the memory ceiling as a runtime
value. Built on 13.39.0. Ships with Gateway Service 2.266.0. Either order.

## Why the connector matters here

The connector checks every `memory_write` with its own copy of the shared
guard **before** the request reaches the gateway. A ceiling raised on the
gateway alone changes nothing for the assistant's own writes. Set
`MEMORY_CAPACITY_PER_SCOPE` on **both** services, to the same value, and
restart both (Gateway Service `RUNBOOK-TENAX-2026-10-17-03.md`).

With the variable unset, nothing changes: the ceiling is 1000, as in 13.39.0.

## Changes

- **`src/tools-memory/memoryWriteGuard.js`**, the shared file, is replaced by
  the 2.266.0 version, byte for byte. It adds:
  - the `MEMORY_CAPACITY_PER_SCOPE` resolver: strict decimal parse, clamped to
    100 to 100000, default 1000;
  - the refusal's naming of the variable, its source and the effective limit
    (`limit_source` and `limit_variable` in the error details);
  - `describeMemoryCapacity()`, the boot-line text both services print;
  - two optional guard inputs, `keyExists` and `oldestRows`, which the
    gateway's bounded write path uses. This connector's two write paths do not
    pass them and decide exactly as before.
- **Boot line** (`src/server-http.js`), after "Memory MCP":
  `Memory ceiling: 1000 entries/scope (default; MEMORY_CAPACITY_PER_SCOPE not set)`.
  It is logged at `warn` when the value was rejected or clamped.
- **Authenticated `GET /health`** gains
  `memory_store: { capacity_per_scope, source, variable }`.
- **`src/tests/fixtures/memory-guard-fixture.json`**, the shared fixture, gains
  19 resolver cases and 2 bounded-listing guard cases.

## Tests

- **`src/tests/memory-capacity.test.js` (new, 5 tests).** At an explicit
  ceiling of 120 it covers:
  - the default;
  - the resolver cases;
  - the boot line and `/health`;
  - the SQLite path: refuses a new key, names the variable, removes nothing,
    and still updates an existing key;
  - the tenant path: refuses before anything is sent to the gateway's upsert.
- **`src/tests/memory-write-guard.test.js`:** only its two pinned digests
  changed. No assertion changed.
- **Mutations:** `npm run tenax-2026-10-17-03:mutations` runs 12 named
  mutations over 8 claims, each demonstrated red.

## Not changed, recorded

- **The tenant path's key check.** `wp-memory.js` decides whether a key is new
  from the gateway's `/list`, which returns at most 500 entries, ordered by
  category and then most recent first. At the ceiling, an update to a key
  outside those 500 is refused here as a new key, before the gateway, whose
  own check is now exact, is called. Fixing it
  needs one more read per write (`/read` by category and key). That changes
  what the existing tests' stub gateway must answer, so it is left for its own
  change.
- **`package-lock.json` still names 13.25.0.** It did in 13.39.0 too.
  `package.json` is the version the service reports.
