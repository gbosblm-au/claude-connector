# claude-connector v12.31.0

**HOTFIX** — restores connector snapshot push, broken by v12.28.0.

Deploy this immediately if you are running 12.28.0 or later.

---

## The symptom

The ts-client-gateway **Connector Snapshots** page failed against every target:

```
Source connector (main tenant): Upload failed (cURL 92):
  HTTP/2 stream 1 was not closed cleanly: CANCEL (err 8)
Ava Core:  Upload failed (cURL 92) ...
Dylan:     Upload failed (cURL 92) ...
Mai - Mia AI: Upload failed (cURL 92) ...
Tenax:     Upload failed (cURL 92) ...
                                        0 succeeded, 5 failed.
```

Connector files could not be recovered after a deployment.

## The cause

A gap in the v12.28.0 authentication gate (TNX-C-001).

That release introduced a deny-by-default gate requiring `MCP_API_KEY` on every
route not explicitly allowlisted. The allowlist named `/tools` and `/tool-call`
as self-authenticated, and **missed the other twenty-one routes that verify
`X-Railway-Restore-Token` internally** — every `/restore-*` target, all three
`/volume-*` endpoints, `/brain-scan`, `/brain-data`, `/skill-export`,
`/set-modular-mode`, `/ti-skill-compile`, `/ti-skill-check-scope`
and `/provision`.

The WordPress plugin authenticates to those routes with the restore token and
has no way to hold the connector key, so every one of them returned 401.

### Why the error message was so unhelpful

The plugin streams an 11 MB `tar.gz` to `POST /volume-restore` with
`Content-Type: application/octet-stream`. The gate rejected the request the
moment the headers arrived, while cURL was still uploading the body. Responding
mid-upload causes the server to reset the stream, and over HTTP/2 the client
then reports a transport error rather than a status code.

So an authentication failure surfaced as `cURL 92 / RST_STREAM CANCEL`, which
points at the network. The plugin's own error handling has specific hints for
401, 403, 413 and 415 — none of them could fire, because no status code ever
reached it.

### Why the existing safeguard did not catch it

v12.28.0 shipped a boot-time route-coverage assertion, on the reasoning that
*"the defect class is not 'someone forgot a check', it is 'nothing verifies that
checks exist'"*. That assertion verified no route was registered **ahead of** the
gate. It did not verify that routes carrying their **own** credential were
exempted from it. The verification was pointed at the wrong failure mode, and
the hand-maintained allowlist beneath it was exactly the fragile thing it was
meant to protect against.

---

## Changes

### 1. All twenty-two self-authenticated routes are allowlisted

`/restore-skill`, `/restore-books`, `/restore-profiles`, `/restore-modules`,
`/restore-personality`, `/restore-dispatch-rules`, `/restore-archive`,
`/restore-references`, `/restore-scripts`, `/volume-snapshot`,
`/volume-restore`, `/volume-snapshot/status`, `/set-modular-mode`,
`/brain-data`, `/brain-data/status`, `/brain-scan`, `/skill-export`,
`/ti-skill-compile`, `/ti-skill-check-scope`, `/provision`, plus the original
`/tools` and `/tool-call`.

`GET /export-all` is deliberately **not** listed: it has no credential of its
own and correctly remains behind the MCP key.

### 2. The gate drains a request body before rejecting

An unauthenticated upload now receives a readable 401 instead of a stream reset.
Draining is capped at 2 MB and 5 seconds, after which the socket is destroyed —
a caller must not be able to make an unauthenticated request cheap for itself
and expensive for us by streaming indefinitely.

This is a general fix. Any future early rejection of a large upload will now
produce a diagnosable status code rather than an opaque transport error.

### 3. The allowlist is now verified from the source

A test scans `server-http.js` and `src/routes/*.js` for handlers reading
`x-railway-restore-token` and asserts each corresponding route is exempt. A
route added in future with its own credential but omitted from the allowlist
fails the test rather than shipping.

A hand-maintained list is what broke; deriving it from the source is the actual
remediation.

### 4. A wrong assertion in the v12.28.0 test suite was corrected

The Phase 0 suite asserted that every `/restore-*` and `/volume-*` route *"has
no independent credential"*. That was false — all of them verify
`RAILWAY_RESTORE_TOKEN` — and the assertion encoded the very mistake that broke
snapshot restore. It now asserts only what is true: the MCP transports,
the removed `/data/upload-binary`, and `/export-all` require the connector key.

---

## Verification performed

47 automated tests passing, and a live container exercised with a real
streaming upload.

**Snapshot restore round-trip**, 206-member archive:

```
POST /volume-restore  ->  curl exit=0, HTTP 200
  success: true | files_written: 201 | rejected: 0
  files landed on the volume: 200
```

**Every plugin-called endpoint reached its handler** (400/404/500 below are
handler responses to deliberately empty test payloads, not gate rejections):

```
/restore-skill 400   /restore-books 400   /restore-profiles 400
/restore-modules 200 /restore-personality 400 /restore-dispatch-rules 400
/restore-archive 500 /restore-references 500  /restore-scripts 500
/volume-snapshot/status 200  /skill-export 200  /provision 400
```

**Error reporting is diagnosable again:**

```
11 MB upload, wrong restore token  ->  curl exit=0, HTTP 401,
  {"error":"Invalid or missing X-Railway-Restore-Token."}
11 MB upload, no credential        ->  curl exit=0, HTTP 401,
  {"error":"Authentication required.","code":"MCP_AUTH_REQUIRED"}
```

**No security regression.** `POST /mcp` presented with only the restore token
still returns 401, so TNX-C-001 remains closed:

```
/mcp with ONLY the restore token: HTTP 401
```
