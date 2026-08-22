# claude-connector v13.8.0

Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6. The upload
route, wiring the three modules from v13.6.0/v13.7.0 to a real file.

**Still not here:** the gateway's parallel assessment workers (step 4) and
review-document assembly.

---

## New: `POST /homework/parse-upload`

```
{ filepath | content_base64, questions: [ { id, position, question_text } ] }
  -> { ok, rows, extras, duplicates, summary, assessable_positions }
```

### A deliberately narrow contract

The route does not read the registry, does not write anything, and does not call
a model.

- **It is handed the questions.** The registry lives in Postgres on the gateway;
  giving the connector a second route to that data would create a second thing
  to keep in step.
- **The gateway persists.** A two-writer arrangement is how a set ends up half
  updated.
- **No model.** Section 3 assigns this half to the deterministic layer, and that
  is exactly why its verdict can be trusted: the same bytes and the same
  registry always produce the same alignment.

### The authentication trap, which I walked into once already

A new connector route is not reachable by the gateway unless it is added to
`SELF_AUTHENTICATED_ROUTES`. Verified before writing a line of the route:

```
/homework/parse-upload   selfAuth= false     <-- would 401 every upload
```

The gateway holds the per-tenant restore token, not `MCP_API_KEY`, so
`mcpAuthMiddleware` answers 401 before the route runs. **The failure is
silent** — the upload simply never parses and the tutor sees an empty result
rather than an error. That is precisely how `/voice/synthesize/stream` stayed
broken from v12.53.0 to v13.4.0.

Added as an `exact` entry, with no prefix leak (`/homework/anything` and
`/homework/parse-upload/evil` both remain false).

Being on that list decides *which* gate applies, not *whether* one does. The
route runs `voiceCredential`, which verifies the same secret in constant time.
That middleware is reused rather than reimplemented: a second implementation
would be a second thing to get wrong, and the two could drift on which secrets
they accept.

### Refusals that exist to avoid a plausible-looking wrong answer

- **A non-docx is refused, not read as blank.** Parsing a PDF into empty text
  would report the student as having answered nothing — worse than an error,
  because it looks like a verdict.
- **An empty registry is a 422, not "0 of 0 matched".** The latter reads to the
  caller as a successful parse.
- **A question with blank canonical text is refused loudly.** An empty truth
  matches nothing, so every answer under it would be quarantined with no
  explanation a tutor could act on.
- **Size is checked before the file is read**, not after — reading first would
  already have spent the memory the limit protects.

Extraction failures return a message written for a tutor in session, not for a
log: `no_document_part` tells them nothing, "that Word document could not be
opened, ask the student to save it again" tells them what to do.

Path handling uses the existing `resolveContained`, which resolves symlinks
physically, so a staged file cannot be a link pointing at the connector's
configuration.

---

## Tests

`npm run test:homework` — **59 passed, 0 failed, 0 skipped** (19 normalisation,
26 extraction, 14 route).

The route is mounted on a real express app and driven over a live socket with
real `.docx` bytes. Nothing in the parsing path is mocked.

Mutation-tested five ways, all caught: removing the self-auth entry (the silent
401), dropping the credential middleware, skipping path containment, allowing an
empty registry, and reporting every row as assessable.

### A test bug worth recording

The first draft of the route suite failed 12 of 14 and looked like a route
defect. It was not: `MCP_API_KEY` is matched against the Authorization bearer
while `RAILWAY_RESTORE_TOKEN` is matched against `X-Railway-Restore-Token`. The
test set one and sent the other, and the 401 was correct. Production sends the
restore token, so that is now the credential these tests exercise, and the
distinction is documented at the top of the file.

### Regression

`npm run test:voice-all` — 286 passed, 0 failed, unchanged.
