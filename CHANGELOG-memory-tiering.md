# claude-connector -- memory tiering passthrough

SPEC-2026-09-06 Section 3.5.

## Changed

`src/tools-memory/wp-memory.js` -- `handleWpMemoryGetSessionContext`

The return statement is an explicit field whitelist, not a spread. The gateway's
new `tiered` array (per-entry `retrieval_tier` and `matched_terms`) would have
been assembled by the gateway, serialised, sent over the wire, and then dropped
here, one function short of the model. Every gateway log would have reported a
correct tiered retrieval while nothing the model could see had changed.

`tiered` is now forwarded, defaulting to `[]` rather than `undefined` so that a
gateway on a pre-tiering build, or the WordPress memory router which has not been
ported, yields a readable empty result instead of an absent key every caller
would have to guard.

## Not changed

`src/tools-memory/memory-get-session-context.js`, the SQLite fallback handler,
still runs its FTS5 path and returns a different response shape (structured
category buckets, not a flat context string). Porting the three-tier matcher to
it is Phase E of the spec and is deliberately out of scope for this build: the
tenant path is connector to gateway Postgres, which is what was fixed.

## Added

`src/tests/memory-tiered-passthrough.test.js` -- the contract test for this
boundary. Drives the real `handleWpMemoryGetSessionContext` against a local
stand-in gateway and asserts that `tiered`, the per-entry `retrieval_tier` and
`matched_terms`, and the honest tier counters all survive the whitelist.

This is the test neither side's unit suite owned. The gateway's tests asserted
it emitted the field; this connector's tests asserted the fields it forwarded;
nobody asserted the field arrived. That gap is how the drop survived green
suites on both sides.

Run with: `node --test src/tests/memory-tiered-passthrough.test.js`
(5 tests, no database and no network required).
