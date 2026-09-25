# claude-connector v13.32.0

Tenax work order 1, decisions D2, D3 and D4, delivered as a complete archive
(work order 2, R1). Bundle tree hashes CHANGE VALUE in this release; see the
migration note below before deploying.

## Changed files

| File | Change |
|---|---|
| `src/bundles/exclusions.v1.json` | **new.** The canonical exclusion set, `tenax-exclusions-v1`, with a reason per entry and its semantics stated. |
| `src/bundles/bundle-ingest.js` | D2 tree-hash construction; D3 exclusions read from the canonical file; manifest renamed and marked; `name_decoding` carried onto each entry. |
| `src/bundles/zip-archive.js` | D4 entry-name decoding; `name_decoding` reports what the decoder did, not what the flag implied. |
| `src/bundles/bundle-store.js` | compares on `tree_hash_v2`; new `rehashed` status for the first re-ingest after the rename. |
| `src/tests/bundle-ingest.test.js` | 8 tests added, each failing if its decision is reverted; 2 updated for the renamed field. |
| `package.json` | 13.31.1 → 13.32.0. |

## D2: one tree-hash construction across the three components

`treeHash` is now the frame's construction: sha256 over `path \0 size \0 sha256
\n` per entry, sorted by code unit, with the size in the preimage. The previous
construction is kept as `treeHashV1Legacy`.

The reason is not tidiness. The loop's final act is a finding closed on
deployed-verified evidence, which compares this hash with the frame's hash of
the same tree. Two constructions leave the loop with no shared currency and
unable to state its own conclusion.

**The field is renamed, not repurposed.** A manifest carries `tree_hash_v2`,
`tree_hash_algorithm`, `tree_hash_v1_legacy` and `exclusion_set`, so a reader
can always tell which generation a value belongs to.

## D3: the canonical exclusion set

Read from `src/bundles/exclusions.v1.json`, not restated in code: one file, one
revision, two consumers. A second copy of the list is how this list and the
frame's drifted apart, so there is no second copy, and a test asserts the
derivation and that every entry carries a reason.

Added since 13.31.1: `vendor` (PHP dependencies), `.svn`, `.hg`. Directories
match on any path segment; files match on basename at any depth. The revision
is recorded BESIDE the hash, never inside the preimage: baking it in would
invalidate every historical hash whenever the list is edited.

## D4: what a filename is

An entry name with no EFS flag is decoded as UTF-8 when its bytes are valid
UTF-8, and as CP437 otherwise. Interoperability over spec purity: Info-ZIP, the
most common producer on Linux, never sets the flag, so the same tree packed by
`zip` and by a flag-setting tool previously produced different names and
therefore different tree hashes for the same bytes.

The cost is in the code comment rather than hidden: a genuinely CP437 archive
whose high bytes happen to form valid UTF-8 is read the UTF-8 way.

## Migration: values move, trees do not

Every stored bundle's tree hash changes value. Identity survives because
`bundle_id` comes from the name. A record stored before this release has no
`tree_hash_v2`, so its first re-ingest reports `status: 'rehashed'` with nothing
added, removed or changed. **`rehashed` is new, and exists so the migration is
not read as a content change.** Anything downstream that treats `updated` as a
content change should be checked against it.

## Verification (work order 2, R2)

Run on this delivered tree, at this version, after `npm ci`:

    node --test src/tests/*.test.js src/tools-memory/*.test.js
      13.32.0 delivered : 1046 tests, 1035 pass, 10 fail, 1 skipped
      13.31.1 baseline  : 1038 tests, 1027 pass, 10 fail, 1 skipped
      new failures introduced by this release: NONE (identical failure set)

    npm test                    30 passed, 0 failed
    npm run test:incremental    15 passed, 0 failed

The 10 failures are the voice-incremental suite, which its own script runs with
`--experimental-test-module-mocks`; under that script it is 15 of 15. They fail
identically at 13.31.1 and are not this release's.

Without `npm ci`, the archive's bundled `node_modules` is missing `helmet` and
others, and 29 tests fail on module resolution in both trees. Install first.

## What was not checked

- Whether the deployed connector runs this version. It is delivered, not
  deployed.
- Whether any stored bundle carries non-ASCII names, and how many were packed
  with the flag set. That needs the live store.
- The nested-archive path composition: the join fixture is a single archive.
