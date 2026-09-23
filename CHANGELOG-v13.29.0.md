# claude-connector v13.29.0

**SPEC-SOURCE-BUNDLE-001: source bundle ingestion.** A zip of a codebase can be
ingested and every file in it read, including .js, .mjs, .cjs and files with no
extension at all. Pairs with Gateway v2.235.0 and ts-client-gateway v5.214.0.

## Decisions applied (2026-09-22)

- **D1:** bundles persist on the volume with a TTL, like uploads (24 h default,
  clamped to `UPLOAD_MAX_TTL_HOURS`), removed by the existing retention sweep.
- **D2:** a separate store. A bundle never enters the reading vault.
- **D3:** default exclusions (.git/, node_modules/, dist/, build/, .next/,
  coverage/, .venv/, __pycache__/, .DS_Store, Thumbs.db), returned in every
  response and counted in the reconciliation.
- **D4:** binary bodies are never returned; a hex or ASCII preview of the first
  bytes is a separate field returned only when asked for.

## Added

- `src/bundles/zip-archive.js`: the connector's one zip reader. Lifted from
  `src/homework/docx-text.js`, which now calls it, and extended with EFS/cp437
  name decoding, unix mode bits (symlink refusal), the encryption flag, zip64
  refusal, bounded inflate (`maxOutputLength` = declared + 1) and CRC-32
  verification.
- `src/bundles/classify.js`: `classifyEntry(path, bytes)`, the one home of the
  decision about what a file is. Zip signature, then known-binary suffix (cost
  only, never the authority), then byte-order mark (UTF-32 before UTF-16, and
  before the NUL test), then NUL in 8000 bytes, then strict UTF-8.
- `src/bundles/bundle-ingest.js`: bounds (depth 2, 5000 entries, 200 MB total,
  20 MB per entry, 512-character paths), path safety, nested archives addressed
  as `outer.zip!/inner/path`, and the completeness predicate: every central
  directory is read before anything is classified, and each entry is placed in
  exactly one of included, excluded or refused, checked by count and by
  (archive, index) key. `reconcile()` is exported so its refusal is testable.
- `src/bundles/bundle-store.js`: content-addressed blobs, one manifest per
  bundle, list, manifest, read (line-numbered, paged by line range, whole up to
  256 KB) and search (literal by default; regex capped in length, line length
  and time). Every read re-hashes the blob against the manifest.
- Five MCP tools: `bundle_ingest`, `bundle_list`, `bundle_manifest`,
  `bundle_read`, `bundle_search`.
- `scripts/build-bundle-fixture.mjs`: builds fixture-gateway.zip with an
  independent zip writer. Not committed as a binary.

## Changed

- `POST /data/upload` no longer refuses an empty or unfamiliar extension:
  Dockerfile, .dockerfile, Makefile, LICENSE and Procfile have no extension on
  Node's `extname`, and Dockerfile.prod, .env.example and Cargo.lock have ones
  no allowlist anticipated. The executable denylist is unchanged. The response
  now carries `classification`, and with `bundle: true` an archive is ingested
  in the same request (a refusal is reported without failing the upload).
- The retention sweep also removes expired bundles and unreferenced blobs.

## Spec premises that did not hold

- s9 asks to import "the framework's own manifest walk" tree hash and to call
  an existing read primitive with a byte round-trip assertion. Neither exists
  in the connector, the gateway or the plugin (searched by name and by
  behaviour). The tree hash is written once, in `bundle-ingest.js`; the
  round-trip is enforced on every read in `bundle-store.js`.
- s8 and s12 refer to a "research listing filter" and a refusal-pair pattern
  to reuse; neither was found. Their constructions are implemented directly.
- s9 says re-ingest is "keyed on the tree hash". A changed tree cannot share a
  tree hash, so `bundle_id` is keyed on the bundle name and the tree hash
  identifies the content version.

## Codes beyond s12

`entry_not_found`, `entry_integrity_failed`, `query_required`, `query_invalid`,
`query_too_long`, `bundle_source_not_found`, `bundle_source_not_allowed`.

## Known limits

- Upload is still capped at 50 MB compressed (`MAX_UPLOAD_SIZE`), which is the
  real outer bound on a bundle; the 200 MB bound is on uncompressed size.
- `/data/upload` remains unauthenticated (pre-existing residual risk). Listing,
  reading and searching a bundle are available only through MCP tools.

## Tests

New: `src/tests/bundle-ingest.test.js` (34), `src/tests/bundle-upload-http.test.js` (17).
