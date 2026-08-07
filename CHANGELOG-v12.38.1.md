# claude-connector v12.38.1 (CONN-V2-FIX-01)

**Fix duplicate and invalid download signatures in the preview interface.**

Released 8 August 2026. Patch release. No configuration changes, no migration,
no restart ordering requirement against the other two components.

---

## Symptom

A rendered document produced two access paths. The `download_links` array
returned by `script_execute` carried a working URL. The Download button in the
preview interface carried a second URL with the **same expiry** and a
**different signature**, and the connector refused it with:

```
Invalid download link signature.
```

Separately, `GET /preview/:filename` returned HTTP 500 for any `.docx` with no
paired `.html` sidecar, and for every non-previewable file type.

---

## Root cause

There is **one** signing secret and **one** signing function
(`src/utils/signedUrls.js`). The originally reported diagnosis of two
independent HMAC secrets, or of the preview route using a "secondary,
unprivileged signing key", is not what was happening. Nothing in the codebase
mints a second signature.

The signature payload is:

```
`${safeFilename}:${exp}`
```

The filename is inside the payload deliberately, so that a signature harvested
from one link cannot be pasted onto another filename. That is the control which
prevents signature swapping, and it is documented as such in `signedUrls.js`.

The defect was that several layers **rewrote the filename in the URL path while
carrying the original query string, including `exp` and `sig`, through
verbatim**. Because the filename changed and the signature did not, verification
recomputed a different HMAC and refused the link. Two URLs with an identical
expiry and differing signatures is the exact fingerprint of that transformation.

The rewrite was correct under the previous scheme. The legacy global
`DOCUMENT_DOWNLOAD_TOKEN` is filename-agnostic, so swapping `Report.docx` for
`Report.html` still authorised. When signed links landed the rewrite became
silently wrong, and was never revisited.

### Second, independent defect

`GET /preview/:filename` interpolated a bare identifier `token` in three
templates: the extract-failure page, the "Download Original (.docx)" button, and
the non-previewable file page. `token` was **never declared** in that handler or
at module scope. Verified by scope-aware AST analysis: the six declarations of
that name elsewhere in `server-http.js` are all local to other handlers. The
file is an ES module, so those lines threw `ReferenceError` and Express returned
500.

Even had the identifier resolved, a `?token=` link is the wrong credential. It
is refused outright once `ALLOW_LEGACY_DOWNLOAD_TOKEN=false`, and it writes a
long-lived global credential into a page the user can save to disk.

---

## Changes

### `src/server-http.js`

**Added `sameFileAuthQuery( req )`** at module scope, immediately after
`authoriseDocumentRequest()`.

It re-serialises the credential that authorised the current request so it can be
reused on a link to the **same file**. Nothing new is signed and no privilege is
created: the caller receives back exactly what they presented, and only after
`authoriseDocumentRequest()` has already verified it.

- Signed shape: returns `?exp=<exp>&sig=<sig>`. Both values are re-checked
  against strict allowlists (`^\d{1,15}$` and `^[a-f0-9]{64}$`) before being
  echoed. The guards are repeated rather than assumed, because this function is
  one refactor away from being called on an unauthorised path, and echoing an
  unvalidated query parameter into an `href` is a reflected injection primitive.
- Legacy shape: returns `?token=<supplied>`, but only when the token path is
  genuinely the one in force. This prevents a token being written into preview
  HTML that `/download` would then refuse.
- Otherwise returns an empty string.

The function carries an explicit caller contract in its docblock: the returned
query is valid **only** for the filename it was issued against, and must never
be attached to a URL whose last path segment differs.

**Fixed the three undeclared `token` references.** All three now build
`/download/${encodeURIComponent(safeName)}${esc(authQuery)}`, targeting the
validated filename and carrying the caller's own verified credential. `esc()` is
applied to the query so the `&` between `exp` and `sig` becomes `&amp;`, which
is what an HTML attribute requires; browsers tolerate a bare `&` here, but a
validating parser is entitled to read `&sig` as an entity reference.

**Updated the `/` endpoint listing** to describe the signed shape rather than
advertising `?token=` as the only option.

### `src/tests/preview-signature-alignment.test.js` (new)

Ten tests across four groups:

1. **Preview-Signature Alignment.** `download_url` and `preview_url` for one
   file carry identical `exp` and `sig`, and differ only in the route segment.
   This is the regression assertion the specification asked for.
2. **The derivation rule.** A signature issued for `Report.html` is refused for
   `Report.docx`, and swapping only the route segment preserves validity. These
   two tests are what make the rule enforceable in the other components.
3. **Source-level guards** on the preview route: no template references an
   undeclared `token`, every `/download/` link propagates `authQuery` and
   targets `safeName`, and the credential is derived only after authorisation.
4. **Legacy mode.** `ENABLE_SIGNED_LINKS=false` still emits token-bearing links
   with no expiry.

---

## Verification performed

| Check | Result |
| --- | --- |
| `node --check src/server-http.js` | Passes |
| Scope-aware AST re-analysis of the preview handler | `authQuery` resolves; no undeclared identifiers remain |
| `node --test src/tests/preview-signature-alignment.test.js` | 10 / 10 pass |
| `node --test src/tests/signed-urls.test.js` | 28 / 28 pass, unchanged |
| `node --test src/tests/phase0-security.test.js` | 61 / 61 pass, unchanged |

---

## Compatibility

- **No behaviour change when `ENABLE_SIGNED_LINKS=false`.** Covered by test.
- **No change to the signature scheme, the secret, or the payload.** Links
  already in circulation continue to verify. No secret rotation is needed.
- **No new dependencies.**
- Deployable independently of the Gateway Service and WordPress plugin changes,
  in either order. This release repairs a 500 and stops the connector emitting a
  bad link; the other two stop other layers from constructing one.

---

## Note on the original specification

Two items in the source specification were not implemented as written, because
they do not work against this codebase.

**The `X-CANONICAL-LINKS` header (spec §3.2).** The preview page is loaded by
browser navigation into an iframe. A browser will not attach a custom header to
that request, so this cannot address the failing path. It is also unnecessary:
the request reaching the preview route already carries a credential that
verified against that exact filename, so propagating it is both simpler and
strictly safe.

**Stripping all `<a>` tags from the preview template (spec §3.1).** This would
also remove ordinary in-document hyperlinks emitted by the render suite's
`spec_render_common.py`, which are content rather than navigation. The download
button is retained and made to carry the correct credential instead.

The specification's claim that "two independent HMAC secrets/configs exist" is
not accurate. There is one secret, with a documented resolution order in
`src/utils/signedUrls.js`.
