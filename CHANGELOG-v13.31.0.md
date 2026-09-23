# claude-connector v13.31.0

Second review round on the source-bundle work. Pairs with Gateway v2.236.1 and
ts-client-gateway v5.216.0. Each item was reproduced against the shipped bytes
before it was changed.

## Security

- **The regex search path no longer reads unverified bytes.** `readEntry` and
  literal search both went through `readVerified`, which re-hashes a blob and
  refuses a mismatch with `entry_integrity_failed`. The search WORKER read the
  blob straight from disk and hashed nothing, so for a regex query, and only a
  regex query, a tampered blob was searched and its matching lines returned.
  That was one path around the store's own stated guarantee, "a mismatch is
  entry_integrity_failed, never silent bytes". The worker now verifies each
  blob against the MANIFEST digest (`entry.sha256`) before decoding. The blob
  is also named by that digest, but the manifest field is the authority: a
  check against the filename alone would be the weaker one.

## Changed

- **One shape for an unreadable entry during search.** A corrupt or missing blob
  is skipped and named in `integrity_failures` on the response, by both the
  worker and the literal path. Previously the literal path threw, so one bad
  blob ended the whole search, which contradicts the rule that one bad entry
  must not make a search unusable (v13.30.0 item 2). A direct `bundle_read` of
  such an entry still refuses outright with `entry_integrity_failed`.
- **`entry_excluded` is its own read code** (added to `READ_CODES`), with the
  matched rule in `detail.rule`. "Excluded by a default rule" and "not in this
  bundle" are different answers, and a client keying on the code could not tell
  them apart while both were `entry_not_found`.
- **Corrected the `bundle-tools.js` header.** It still told the reading model
  that the unauthenticated upload route can ingest with `bundle: true`. That
  stopped being true in v13.30.0. The header now states that these tools are the
  only ingest surface and that the route stores and classifies only.

## Tests

`src/tests/bundle-ingest.test.js` 43 to 47, four new tests. The integrity tests
tamper with a blob to the same length: one asserts no match from it across four
option shapes (two literal, two regex), that `integrity_failures` names it, that
the intact entry still answers and that a direct read still refuses; a second
isolates the regex path alone, which is the one that returned unverified lines
before this release and the one that fails on the pre-fix tree for that reason.

## Departures from s12, complete list

`entry_not_found`, `entry_excluded`, `entry_integrity_failed`,
`query_required`, `query_invalid`, `query_too_long`, `bundle_source_not_found`,
`bundle_source_not_allowed`, `name_required`, `search_failed`,
`entry_path_duplicate`.
