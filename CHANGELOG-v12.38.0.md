# v12.38.0 - Per-file signed download URLs (TNX-FEAT-SIGNEDURLS)

Implements the feature spec dated 6 August 2026.

## Summary

Generated document links no longer carry the global `DOCUMENT_DOWNLOAD_TOKEN`.
Each link now carries an expiry and an HMAC-SHA256 signature scoped to one
filename:

```
https://<connector>/download/<name>?exp=<unix_seconds>&sig=<hex>
```

This closes both problems named in the spec. Links expire (default one hour)
without a token rotation or a restart, and a leaked link opens exactly one file
instead of every document produced since deployment.

## Deviations from the spec, and why

**1. Route path is `/download/`, not `/downloads/`.**
The spec's URL examples use `/downloads/report.docx`. The connector's route has
always been `/download/:filename` (singular); `/data/downloads` is the directory,
not the path. Implementing the spec literally would have created a second route
that 404s or an unnecessary breaking change to every existing link. I kept the
existing path. If `/downloads/` was intended as a rename rather than a
transcription slip, say so and I will add it as an alias.

**2. `/preview/` is covered as well as `/download/`.**
The spec names only the download route. `/preview/:filename` serves the same
bytes from the same directory under the same token, so leaving it on the global
token would have left the bypass wide open. Both routes now share one
authorisation path and one signature. A link signed for a file is valid on both,
which is correct: neither route grants access the other does not.

**3. New setting `ALLOW_LEGACY_DOWNLOAD_TOKEN`, defaulting to true.**
The spec's rollout switch (`ENABLE_SIGNED_LINKS`) is all-or-nothing: flipping it
on would immediately break every link already sitting in chat history, in a
bookmark, or in the WordPress UI. This second flag lets signed links be issued
while previously issued token links keep working, so the migration can be staged.

**Please note:** while `ALLOW_LEGACY_DOWNLOAD_TOKEN` is true, the global blast
radius is only half removed. A leaked token still opens every file. Set it to
`false` once existing links have aged out, otherwise this feature is issuing
better links without retiring the weaker credential.

**4. `403` on signature failure, `401` retained on legacy token failure.**
Per the spec, every signed-link failure returns 403. The legacy token path keeps
its existing 401 so nothing that already handles that response changes
behaviour.

**5. Filename validation moved ahead of authorisation.**
The signature is computed over the normalised filename. Verifying against the
raw `req.params.filename` would let an unnormalised variant satisfy a signature
issued for a different file. Only filename syntax is disclosed before the auth
check; existence is still checked after it, so this is not an enumeration
oracle.

## Changes

### `src/utils/signedUrls.js` (new)

- `resolveSigningSecret()` with the bootstrapping protocol from the spec:
  `SIGNED_URL_SECRET`, then `/data/.url_secret`, then generate 64 hex chars and
  persist at mode `0600` with a loud operator warning. A secret shorter than 32
  characters is refused rather than used. An unwritable volume is reported
  explicitly, because an in-memory-only secret breaks every link at the next
  restart and replicas would not agree on signatures.
- `buildSignedQuery()` and `verifySignedRequest()`. Payload is
  `` `${safeFilename}:${exp}` ``, so both signature swapping and pushing `exp`
  forward fail.
- Constant-time comparison over SHA-256 digests of both operands.
  `crypto.timingSafeEqual` throws on a length mismatch, and that 500 would
  distinguish "wrong length" from "wrong value".
- Signature is verified before expiry, so probing costs the same either way.
- `exp` must match `^\d{1,15}$` and `sig` must be 64 hex characters. `parseInt`
  would accept `1700000000abc` and produce a confusing `bad_signature` where the
  real fault is a mangled URL.
- `exp <= now` is expired. Accepting equality would leave a one-second window.
- `LINK_EXPIRY_SECONDS` falls back to 3600 on zero, negative or non-numeric
  input, and is capped at 30 days so a milliseconds value cannot silently
  restore unlimited lifetime.

### `src/utils/downloadLinks.js`

- Emits signed links by default; the global-token shape only when
  `ENABLE_SIGNED_LINKS=false`.
- `DOCUMENT_DOWNLOAD_TOKEN` is no longer required for link generation.
- Adds `expires_at` and `expires_in_seconds` to each link, plus a warning
  telling the caller the link is time limited, so the user is told up front
  rather than discovering it as an unexplained 403 an hour later.
- A signing failure produces no link and a warning. It never degrades to an
  unsigned or token-bearing link.

### `src/server-http.js`

- `authoriseDocumentRequest()`, shared by `/download` and `/preview`. A request
  carrying `exp` or `sig` is judged only as a signed request and never falls
  through to the token path; otherwise expiry would be unenforceable for anyone
  holding the token.
- `legacyDownloadTokenAllowed()`.
- Boot-time secret resolution and a status line, so a missing secret or an
  unwritable volume is reported while an operator is watching.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Signed request returns the file | Pass |
| Expired `exp` refused | Pass (403, `expired`) |
| `sig` removed refused | Pass (403, `malformed`) |
| Filename changed refused | Pass (403, `bad_signature`) |
| `ENABLE_SIGNED_LINKS=false` restores previous behaviour | Pass, byte-identical URL |
| Secret persists across restarts | Pass |
| Zero script impact | Pass, detection is still by directory diff |

## Verification

- `src/tests/signed-urls.test.js` (new): 28/28 pass.
- `src/tests/internal-config-custom-env.test.js`: 31/31 pass. Four tests were
  updated to assert the legacy shape under `ENABLE_SIGNED_LINKS=false`, since
  signed is now the default.
- `npm run test:security`: 61/61 pass.
- Boot: `Signed download links: ENABLED | expiry 3600s | legacy token accepted:
  true`, secret generated and persisted, `Auth gate: ACTIVE | 43 routes verified`.
- End to end with a real script: two files produced, each with a distinct
  signature. Verification matrix, all as expected: valid ALLOW; swapped
  filename, pushed expiry and flipped bit DENY `bad_signature`; removed `sig`
  DENY `malformed`; time-shifted DENY `expired`. Global token, restore token and
  credential sentinels all absent from the result payload.

## Known limitations

- **Replay is not addressed.** A link stolen inside its window works until it
  expires. Out of scope for v1.0 per the spec.
- **No per-link revocation.** Links are stateless. Rotating `SIGNED_URL_SECRET`
  is the only revoke, and it invalidates all of them.
- **`exp` and `sig` are in the query string,** so they reach access logs, proxy
  logs and browser history exactly as the token did. `Referrer-Policy:
  no-referrer` is set on both routes. The expiry is what limits the damage.
- **The signature does not bind the route.** A link signed for a file works on
  both `/download` and `/preview`. Both serve the same bytes to the same
  audience, so this is not an escalation, but it is a deliberate choice rather
  than an oversight.
- **Volume dependency.** If `SIGNED_URL_SECRET` is unset and `/data` is lost or
  remounted empty, all outstanding links break. Setting the variable explicitly
  avoids this.
