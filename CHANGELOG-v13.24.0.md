# v13.24.0 — Upload ceiling raised to 50 MB

## Summary

`POST /data/upload` now accepts files up to 50 MB, raised from 10 MB.

This is one part of a three-service change. Raising this alone would not have
worked: the browser refused files at 10 MB before they were ever sent, and the
JSON body parser in front of this route would have rejected a 50 MB upload
before the handler's own size check could run.

| Service | Change |
| --- | --- |
| claude-connector (this one) | `MAX_UPLOAD_SIZE` 10 MB → 50 MB; `MCP_LARGE_BODY_LIMIT` 50mb → 72mb |
| ts-client-gateway | Client ceiling 10 MB → 50 MB, now emitted from a WP option |
| Gateway Service | `MAX_UPLOAD_SIZE` 10 MB → 50 MB; `/api/upload` and `/ti-chat/stream` body limits corrected |

## Changes

### `src/server-http.js` — `MAX_UPLOAD_SIZE` default

```diff
-const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10485760', 10); // 10MB
+const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '52428800', 10); // 50MB
```

This value and the browser's `window.TI_UPLOAD_MAX_BYTES` are deliberately the
same number. When the client ceiling is the smaller of the pair, the user gets
an immediate rejection naming the limit. When it is the larger, the bytes are
uploaded in full and refused here with a 413 the client can only report
second-hand. Equal values mean the first path is always the one taken.

### `src/server-http.js` — `MCP_LARGE_BODY_LIMIT` default

```diff
-const LARGE_BODY_LIMIT = process.env.MCP_LARGE_BODY_LIMIT || "50mb";
+const LARGE_BODY_LIMIT = process.env.MCP_LARGE_BODY_LIMIT || "72mb";
```

**This is the change that makes the first one work.** `/data/upload` receives
the file as base64 inside a JSON envelope, and base64 inflates by roughly 4/3.
A 50 MB file arrives as about 67 MB of body. At the old 50mb ceiling express
rejected everything over roughly 36 MB *before the route ran*, so the handler's
`MAX_UPLOAD_SIZE` check was unreachable above that point and the caller received
an opaque parser 413 instead of the handler's `error_kind: 'too_large'` response
naming the actual limit.

72mb leaves headroom above the 67 MB worst case, so the ceiling that actually
refuses a file is `MAX_UPLOAD_SIZE`, in one place, with a useful message.

This is verified rather than asserted: the test below includes a regression
proof that reproduces the old 50mb parser and confirms it rejects a 50 MB
upload.

### `.env.example`

`MAX_UPLOAD_SIZE` is now documented. It was supported but absent from the file,
so there was no way to discover it short of reading the source.
`MCP_LARGE_BODY_LIMIT` is updated to 72mb with a note explaining why it must
stay above `MAX_UPLOAD_SIZE` and by how much.

## Not changed

- `MCP_BODY_LIMIT` stays at 2mb. No route outside the large-body allowlist was
  widened.
- The large-body allowlist itself is unchanged; `/data/upload` was already on it.
- The upload extension allowlist, TTL clamping, retention sweeper and category
  routing are untouched.
- The homework upload path in the WordPress plugin keeps its own independent
  10 MB ceiling and is not governed by `MAX_UPLOAD_SIZE`.

## Verification

`verify-connector-upload.mjs` is included at the package root. It re-derives the
constants from `src/server-http.js` by regex rather than restating them, so a
drift between the test and the source fails the test instead of passing quietly.
It then stands up a live express server with the same dispatcher and handler
shape and exercises real payloads.

```
$ node verify-connector-upload.mjs
PASS  MAX_UPLOAD_SIZE default is 52428800 (50 MB)
PASS  MCP_LARGE_BODY_LIMIT default is 72mb
PASS  MCP_BODY_LIMIT default unchanged at 2mb
PASS  /data/upload is still on the large-body allowlist
PASS  50 MB upload passes the parser and is ACCEPTED by the handler
PASS  50 MB upload is not refused by the express parser
PASS  just under the ceiling is accepted
PASS  over the ceiling returns 413 error_kind=too_large from the handler
PASS  regression proof: at the OLD 50mb limit a 50 MB upload is parser-rejected
PASS  MAX_UPLOAD_SIZE honours an env override
PASS  MCP_LARGE_BODY_LIMIT honours an env override

ALL CONNECTOR UPLOAD CHECKS PASSED
```

`node --check src/server-http.js` is clean.

## Deployment

Nothing is required — the new defaults are compiled in. To pin them explicitly
in Railway:

```
MAX_UPLOAD_SIZE=52428800
MCP_LARGE_BODY_LIMIT=72mb
```

If `MCP_LARGE_BODY_LIMIT` is currently set to `50mb` in your environment, that
value **overrides the new default** and uploads above roughly 36 MB will still
be rejected by the parser. Check for it before concluding the change did not
take effect.

## Disk footprint

A 5x larger per-file ceiling means the uploads volume can fill 5x faster. The
24-hour default TTL and the retention sweeper are unchanged and still apply, but
if the volume is close to full at the current limit, review headroom before
deploying.
