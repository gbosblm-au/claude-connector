# claude-connector v13.43.0

TENAX-2026-10-27-03 rev 2, "the delivery certifies what it did not do", D1
and D4 with decision D-1a, the connector half: `coding_deliverable_publish`
(src/tools/coding-delivery.js, now v1.2.0) can publish an archive that carries
the shipped directories (dist, build, vendor) beside the listed tree. Built on
13.42.0. Ships with tenax-frame 1.11.0 and Gateway Service 2.289.0.

## Why

A delivery archive carried the listing alone, and the listing leaves out
every excluded directory. A product whose installed form is its built bundle
or its Composer `vendor` tree was delivered without them while the manifest
called the tree complete. tenax-frame 1.11.0 records those directories beside
the tree hash with a digest of their own and carries them in the archive when
asked for that digest. This release asks for it, and checks what comes back
as exactly as it checks the listing.

## Changes

- **`src/tools/coding-delivery.js`** (v1.2.0):
  - New optional input `shipped`: the shipped digest the frame answered the
    gateway's upload with (64 lowercase hex characters; anything else is
    refused by `validatePublishInput`).
  - Given `shipped`, the tool reads `listing.shipped` from
    `GET /v1/tree/:hash` and refuses `shipped_unavailable` by name when the
    frame records none (a frame or an install before 1.11.0), when the record
    is refused (over the frame's bound), or when its digest is another one (a
    later upload replaced them). A path both listed and shipped is refused
    `frame_error`.
  - It then asks for the archive with `?shipped=<digest>` and holds it to the
    listed entries and the shipped entries together: every member present,
    none extra, each at its recorded size (`archive_incomplete`) and sha256
    (`archive_content_mismatch`). The manifest must record the digest asked
    for, and must record none when none was asked
    (`archive_manifest_mismatch`).
  - The result's `manifest` adds `shipped` (digest, file count, bytes and
    directories, or null) and `shipped_available` (what the frame could have
    shipped), so a caller that asked for none can see what was left out.
  - Without `shipped` nothing changes: the archive is checked against the
    listing alone, as in 13.42.0, and a shipped member in it is refused as
    extra.
- **`package.json`**: 13.43.0. `package-lock.json` keeps its recorded version,
  as earlier releases did.

## Deploy

1. This connector (either order with tenax-frame 1.11.0: a caller that does
   not send `shipped` is served as before by both).
2. tenax-frame 1.11.0.
3. Gateway Service 2.289.0, which sends `shipped`.

Against tenax-frame 1.10.2 a call with `shipped` is refused
`shipped_unavailable` before any archive is fetched, because that frame
records no shipped directories. Rollback: 13.42.0. That release ignores an
input it does not know, so it would publish the listing alone for a call
carrying `shipped`; its result has no `manifest.shipped`. Gateway 2.289.0
reads `manifest.shipped.hash` from the result and treats an archive without
the digest it asked for as not delivered, so the rollback cannot pass off a
listing-only archive as the product.

## Tests and verification

- `src/tests/coding-delivery-shipped.test.js` (new, 3 tests) drives the real
  handler against a fake frame on a real socket, a real downloads directory
  and the real signed-link builder: C-SHIPPED-ASKED (the archive with every
  shipped file is published, four members checked by content, and the frame
  was asked for that digest), C-SHIPPED-EXACT (a shipped file missing,
  altered at the same size, or extra, a manifest naming another digest, a
  replaced record, no record, and a path both listed and shipped are each
  refused by name, and nothing is published), C-SHIPPED-NOT-ASKED (without
  `shipped`, the 13.42.0 behaviour).
- Five mutations of the new code (checking against the listing alone, no
  manifest digest check, no record digest check, not asking the frame for
  the digest, checking content against the listing alone) each redden the
  new file.
- `npm test`: 30 passed, 0 failed, as on 13.42.0.
- `node --test src/tests/*.test.js`: 13.42.0 1268 tests, 1243 pass, 13 fail,
  1 skipped; 13.43.0 1271 tests, 1246 pass, 13 fail, 1 skipped. The 13
  failures are the same tests by name on both trees (the SQLite store, voice
  and Piper tests that need what this workspace lacks).

No existing test was changed.
