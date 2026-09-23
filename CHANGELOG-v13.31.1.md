# claude-connector v13.31.1

Documentation and tool-description corrections from the third review pass. No
behaviour changes.

## Corrected

- **CHANGELOG-v13.31.0.md said the worker verifies a blob "against its own name
  (the filename IS the digest)".** The code compares against `entry.sha256`, the
  manifest field. The blob is also named by that digest, so the sentence was not
  false, but it described a WEAKER check than the one that shipped, and a reader
  tidying the code toward the description would have loosened it. Corrected to
  name the manifest digest as the authority.
- **The same changelog counted `bundle-ingest.test.js` as 43 to 46**, and
  described the integrity test in the singular. It is 43 to 47: the isolated
  regex test was added after the changelog was written and the number did not
  move with it. The suite table and the runner's own executed list both said 47.

## Tool descriptions

- `bundle_read` now states that a read of an excluded path answers
  `entry_excluded` with its rule, and a read of a refused path answers with that
  refusal's own code. `READ_CODES` is not the whole read contract, and the
  description now says so rather than leaving the list to imply it.
- `bundle_search` now states that `truncated_by: time_budget` distinguishes an
  abandoned scan from one that finished having found nothing, and that entries
  failing their hash are named in `integrity_failures`.
