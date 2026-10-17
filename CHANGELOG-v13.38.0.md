# claude-connector v13.38.0

This is the connector half of TENAX-2026-10-10-02, "What the deployed
environment settles, and the two safeguards that are still missing" (Ava,
2026-10-10). It covers claims C-READER-ORDER (connector half), C-LINK-CONTENT
and C-LINK-APPEARS. It is built on 13.37.0. The other halves are tenax-frame
1.10.2 and Gateway Service 2.253.0. The operator runbook for the reader
credential is `RUNBOOK-TENAX-2026-10-10-02.md` in the Gateway Service.

## Deploy order

1. **tenax-frame 1.10.2.** This connector asks it `GET /v1/credential`, a
   route that 1.10.2 adds.
2. **Gateway Service 2.253.0**, with migration 0060.
3. **This connector.** `TENAX_FRAME_URL` and `TENAX_FRAME_READ_TOKEN` are
   unchanged. The token is the `<token>` of the frame's `reader:<token>`
   entry.

Against frame 1.10.0 or 1.10.1, every fetch is refused as
`frame_credential_unverified`, and the gateway reports the deliverables as
not published. Deploy the frame first.

## C-READER-ORDER: the connector checks what its credential is

On a frame that does not know the `reader` role, a `reader:<token>` entry was
read as a bare operator token. That meant this connector could silently hold
write access it was never meant to have. Up to 13.37.0 the token "should be"
a reader, and nothing checked it.

Now, before every fetch, `coding_deliverable_publish` asks the frame what the
credential is (`verifyReaderCredential`). It fetches nothing unless the
answer is role `reader` with no write action:

- **`frame_credential_overprivileged`** when the frame reads the token as
  any other role, or as a reader that may write. The answer names the role
  and its writes.
- **`frame_credential_unverified`** when the frame cannot say (it has no
  route, because it is older than 1.10.2) or its answer is not one.
- **`frame_refused`** for a token the frame does not accept, as before.

The token never appears in a result, a refusal or a log line. Only the
frame's fingerprint of it (`credential_id`) is reported. A successful
publication reports `frame_credential` (role, fingerprint and frame version).

## C-LINK-CONTENT: every member is checked by content

13.37.0 checked that the archive held exactly the listed paths at the listed
sizes. A member changed but kept at the same length passed.

Now every member is read and checked by content (`checkArchiveContent`): it
is inflated, CRC-checked and hashed, and its sha256 must be the one the
frame's listing gives for that path:

- **`archive_content_mismatch`** when a member's sha256 differs. The answer
  names the paths.
- **`archive_unverifiable`** when the listing gives no sha256 to check
  against.

`content_checked` on a successful publication says how many members were
checked.

The members are read off the event loop, so a 200 MiB archive does not hold
the connector's other requests while it is checked. `src/utils/zipCentralDirectory.js`
gains:

- **`readZipMemberAsync`**, which inflates on the thread pool.
- **An incremental `crc32(buf, previous)`.**
- **`crc32Yielding`**, which works 4 MiB at a time with a turn of the event
  loop between pieces.

The member hash (`sha256Yielding`) yields the same way. The synchronous
`readZipMember` is unchanged.

## C-LINK-APPEARS: pinned through the real server

13.37.0 pinned the advertisement by matching the TOOLS array's source text.
`src/tests/coding-delivery-http.test.js` now runs `src/server-http.js`
twice, the way the gateway reaches it:

- **Without `TENAX_FRAME_READ_TOKEN`:** `GET /tools` does not list the tool,
  and `POST /tool-call` naming it is refused `frame_not_configured` with no
  link.
- **With the token:** the tool is listed, and against a frame that reads the
  token as an operator, the call is refused `frame_credential_overprivileged`.
  The frame is asked for nothing but `/v1/credential`, and nothing is
  written to downloads.

## Changed files

| File | Change |
|---|---|
| `src/tools/coding-delivery.js` | v1.1.0: `verifyReaderCredential`, `checkArchiveContent`, `sha256Yielding`; the result carries `content_checked` and `frame_credential`. |
| `src/utils/zipCentralDirectory.js` | v1.1.0: `readZipMemberAsync`, the incremental `crc32`, `crc32Yielding`, `yieldToLoop`, `YIELD_CHUNK`. |
| `src/tests/coding-delivery.test.js` | The fake frame answers `/v1/credential`, and the test ZIP writer can DEFLATE. 5 new tests. |
| `src/tests/coding-delivery-http.test.js` | **new.** 2 tests, against the real server. |
| `.env.example` | The credential check described. |
| `package.json` | 13.37.0 to 13.38.0. `package-lock.json` is left as uploaded: it reads 13.25.0, and nothing enforces it. |

## Verified

Each test file under `src/tests`, `tests`, `src/tools`, `src/tools-memory`
and `src/tools-self-model` ran in its own
`node --experimental-test-module-mocks --test` process, followed by
`npm test` (`src/test.js`).

| | files | tests | pass | fail | skipped | npm test |
|---|---|---|---|---|---|---|
| Before (13.37.0 as delivered) | 62 | 1298 | 1296 | 1 | 1 | 30/30 |
| After | 63 | 1305 | 1303 | 1 | 1 | 30/30 |

Where the +7 come from:

- `src/tests/coding-delivery.test.js` went from 12 to 17 tests: the two
  C-READER-ORDER tests, the two C-LINK-CONTENT tests, and the asynchronous
  reader.
- `src/tests/coding-delivery-http.test.js` is new, with 2 tests.

Every other file has the same counts. There are no net new failures. The one
failing test is carried from 13.37.0: `voice-gpl-boundary`, "no Piper artifact
survives anywhere in the source tree", which is about a file on the uploaded
volume and not about this change.

**Mutations:** 11 applied, 11 red.

- Any role accepted.
- The role accepted without checking its writes.
- A 404 read as a reader.
- The credential check skipped.
- The content check skipped.
- Entries without a sha256 skipped.
- The CRC never yields.
- The sha256 never yields.
- The asynchronous inflate replaced.
- The tool always advertised.
- The incremental CRC ignoring its seed.

**End to end:** with Gateway Service 2.253.0 and tenax-frame 1.10.2 running,
39 of 39 checks passed with each of the two seed roots. Those runs included
the frame reading this connector's token as a reader with no writes, and a
reviewer token refused `frame_credential_overprivileged` before anything was
fetched. See the gateway's changelog.

**Independent review** (a separate reviewer that had not seen the work). It
found nothing blocking in the connector. It noted that the per-member sha256
ran on the event loop, and it now yields. Carried and dated in the gateway's
runbook: the whole archive's sha256, which 13.37.0 computes on arrival, is
still computed on the request thread.

## Not verified

- A real `/data/downloads` volume on Railway.
- The check against the deployed frame.
