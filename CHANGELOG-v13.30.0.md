# claude-connector v13.30.0

Review round on v13.29.0 (SPEC-SOURCE-BUNDLE-001). Pairs with Gateway v2.236.0
and ts-client-gateway v5.215.0. Nine items, each verified against the shipped
bytes before it was changed.

## Security

- **The unauthenticated upload route no longer ingests bundles (item 1).**
  `POST /data/upload` is unauthenticated by design, and `ingestBundle` keys a
  bundle on its name and replaces any live manifest at that id. An
  unauthenticated request naming an existing bundle could therefore substitute
  its content, and every MCP-authenticated read afterwards would serve the
  substituted tree into a session with a full tool surface. Reproduced before
  the fix: two posts under one name, and reads served the second. The ingest
  branch is deleted. `bundle: true` is still ACCEPTED and IGNORED, so an older
  plugin build keeps working; no bundle object comes back. Classification stays,
  because the plugin depends on it. Ingest is now only the authenticated
  `bundle_ingest` tool, against the stored file.

## Fixed

- **A bad byte beyond the sniff window no longer breaks a tool (item 2).**
  `classifyEntry` validates the first 8,000 bytes, so an entry can be class
  `text` and still hold an invalid byte later. `decodeForRead` strict-decoded
  the whole entry and threw: an internal error on `bundle_read`, and
  `bundle_search` died outright because it decodes every text entry it scans.
  It now falls back to the same lossy shape the text-uncertain path uses, with
  `first_bad_offset` recomputed over the whole entry.
- **One rule for duplicate composed paths (item 3).** Two entries at one
  composed path (a duplicated name, or two same-named sibling archives) either
  produced two readable entries at one path or collided the reconciliation keys
  and refused the whole ingest as `manifest_reconciliation_failed`, describing a
  counting fault that was not the fault. First wins; later ones are refused with
  the new `entry_path_duplicate`. Reconciliation is keyed on a per-walk instance
  id, not the archive path. Exclusions are computed from real segment arrays, so
  a directory genuinely named `node_modules!` is no longer excluded under the
  `node_modules` rule.
- **A backtracking regex can no longer wedge the connector (item 4).** The
  deadline was checked once per entry, so a single `test()` could not be
  interrupted, and the connector is one thread for everything. Regex search now
  runs in a worker thread killed at the budget, checkpointing after each entry
  so an abort still returns what it found with `truncated_by: 'time_budget'`.
  Literal search stays in-process. `searchBundle` is now async.
- **`bytes_read` is measured, not derived (item 5).** It added a separator per
  line to a joined string that already held its own newlines, so a page of n
  lines was over by n - 1 bytes, and UTF-16 pages mixed byte units. The returned
  segment is now measured exactly in the entry's encoding.
- **The bundle name comes from the sidecar (item 6).** `ingestBundleFromFile`
  stripped only the connector's `<ts>_<name>` shape, so a gateway-stored file
  (`<ts>_<md5:8>_<name>`) derived `ab12cd34_Name.zip` and could never update the
  bundle made from the connector's copy. Both routes write `<file>.meta.json`;
  `original_name` is now the authority, with both stored shapes as fallback.
  Cross-service contract: connector `<ts>_<safe>`, gateway `<ts>_<md5:8>_<safe>`.
- **Smaller items (item 8).** A missing name is `name_required`, not
  `archive_corrupt`. `REFUSAL_CODES` now holds ingest refusals only, with read
  codes in `READ_CODES`. The per-entry encrypted refusal is labelled as
  unreachable defence in depth. Blob writes compare the digest instead of
  trusting a matching size, so same-length corruption is repaired by re-ingest.
  The sweep removes stale `.tmp` artefacts beside blobs and manifests.

## Tests

`src/tests/bundle-ingest.test.js` 35 to 43, `src/tests/bundle-upload-http.test.js`
17 to 17 (the route-ingest tests replaced by a floor that asserts the bundle
store stays EMPTY after two `bundle: true` posts, plus the authenticated ingest
path reporting created, updated and unchanged).

## Departures from SPEC-SOURCE-BUNDLE-001 s12, restated

Beyond the codes the spec lists: `entry_not_found`, `entry_integrity_failed`,
`query_required`, `query_invalid`, `query_too_long`, `bundle_source_not_found`,
`bundle_source_not_allowed`, `name_required`, `search_failed`, and new this
round, `entry_path_duplicate`.
