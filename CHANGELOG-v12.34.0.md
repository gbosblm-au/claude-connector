# ts-client-gateway v5.72.0 + claude-connector v12.34.0

**Stage 2a — homework submission at session start.** Implements the Stage 2a
prototype, plus findings **R18** and **R19**.

Ships with connector 12.34.0, which adds the upload category. Deploy the
connector first; the plugin degrades safely without it.

---

## Constraint 1 — reused the existing binary route, and a correction

You asked me to route uploads to "the existing gateway binary handler". One
thing to flag: **that handler is on the connector, not the Gateway Service.**
`uploadFileToGateway()` in `05-attachments.js` is named for the gateway but
POSTs to `${connectorUrl}/data/upload`. The Gateway Service has no binary upload
route at all — only `app.use('/uploads', express.static(...))`, which serves
files rather than receiving them.

Worth being explicit about a second point: **`/data/upload-binary` no longer
exists.** I removed it in Phase 0 (TNX-C-003 — unauthenticated arbitrary file
write with no extension policy and no size limit). It returns `410 Gone`. The
surviving route is `POST /data/upload`, which already has the extension
allowlist, the size cap and the TTL clamp.

So: no new endpoint. `uploadFileToGateway()` gained an optional fourth argument,
and the connector gained an optional `category` field.

```js
uploadFileToGateway(name, base64, mime, 'homework')
  -> POST /data/upload { filename, content_base64, mime_type, ttl_hours, category }
  -> /data/uploads/homework/<timestamp>_<name>
```

Existing callers pass no category and are byte-for-byte unaffected; the
connector treats an unknown or absent category as the shared root.

**The category is an allowlist, not a sanitiser.** It reaches a filesystem path,
and `/data/upload` is on the unauthenticated public allowlist (the residual risk
recorded in Phase 0), so a caller-supplied path segment is exactly the input
that must not be merely escaped. `UPLOAD_CATEGORIES` is a `Set`, and the result
is *additionally* passed through `resolveContained()` so a future edit widening
that set still cannot escape the upload root. Two independent controls, because
the second costs one function call.

## Constraint 2 — strings in `00b-i18n.js`

**38 keys × 6 locales**, verified complete: `en-AU`, `es`, `fr`, `de`, `zh`,
`ar`. Nothing touches the WordPress backend.

The four localisation rules are enforced, not just documented:

- **Direction follows language, on the panel root.** Arabic sets `dir="rtl"` on
  `#ti-homework-panel`, not on `<html>`, so the rest of the application is
  unaffected. Applied on open *and* on every language change.
- **Counts are interpolated, never concatenated.** `{count} files attached`
  passes through one placeholder, so plural form and word order stay with the
  translator. Separate singular and plural keys.
- **Vocabularies are localised, wire values are not.** The subject `<option>`
  value is the canonical key (`mathematics`); the label follows the interface
  language. A test asserts the directive carries `subject=mathematics` and never
  `Matemáticas`.
- **No translated string reaches `innerHTML`.** Every label goes through
  `textContent`. A translation catalogue that reaches `innerHTML` is an
  injection surface nobody reviews.

The spec's own strings are marked *"illustrative... should be replaced by
[the reviewed catalogue] rather than lifted from here."* Mine are written for
this application rather than copied, but they still want a native-speaker review
before they reach students — particularly the Arabic.

## Constraint 3 — modal, drop zone, rejection, state machine

Split across two files so the state machine is testable without a DOM:

| File | Owns |
|---|---|
| `09e-homework-submission.js` | State machine, validation, transport, directive, R19 |
| `09f-homework-view.js` | Modal, drag-and-drop, rejection surface, R17 repaint |

**Validation happens in the picker, not at the endpoint** (R18), so the student
is told *which* file was rejected and *why* before spending bandwidth on it.
Rejections are per file, not per batch — someone selecting four photos and one
unsupported document keeps the four. `.heic`/`.heif` are accepted, because that
is what an iPhone produces by default.

`preventDefault` on `dragover` is what makes the zone a valid drop target;
without it the browser navigates to the file instead.

## R18 — a failed upload must not cost the session

The upload is the only step depending on the student's own bandwidth and on
phone-camera files, so it is the most likely failure in the flow. The opener is
therefore **never blocked on it**. If nothing lands, the session opens with
`submission=live` and the student is told why.

**A gap my own test caught:** `submit()` defaulted `notify` to a no-op, so a
caller who forgot to pass one got exactly the silent degradation R18 exists to
prevent. The default is now the visible path. I fixed the code, not the test.

## R19 — one source of truth

`paintSessionControls(profile)` derives both the primary label and the sibling
visibility from `profile.intake_complete` — the same value that gates the intake
overlay. Secondary controls are **removed from the DOM, not disabled**: a
disabled control still asks the student to wonder what it would have done. A
null or malformed profile is treated as *unregistered*, because the alternative
shows an end-session control for a session that cannot exist.

## The directive

Extends the existing opener rather than adding a second, so the model receives
one unambiguous instruction:

```
[session-open-homework-check] student_id=42 mode=returning submission=upload attachments=3 files=… subject=mathematics
[session-open-homework-check] student_id=42 mode=returning submission=live
[session-open-homework-check] student_id=42 mode=returning submission=none
[session-open-homework-check] student_id=42 mode=first_time submission=none
```

The first session **bypasses the modal entirely** — a student with no history
has nothing to submit. `no homework` exists so a student who genuinely has none
does not have to lie to the form to get past it.

## Verification

```
tests/homework-submission.test.js    58 passed, 0 failed   (new)
npm test                             39 passed, 2 known-failing, 0 NEW of 41
npm run test:verify-runner           41 of 41 probed
connector suite                      61 passed, 0 failed
```

Covers: per-file rejection with named reasons; HEIC accepted; the file cap and
duplicate suppression; `category=homework` on every upload call; the four
directive shapes; wire value versus localised label; R18 total failure, partial
failure *and* a transport that is not loaded at all; R19 in both states plus a
malformed profile; the first-session bypass; RTL on the panel root; a real drop
event; refusing an empty submission; and catalogue completeness across all six
locales.

**A finding about my own test design, worth recording.** My first attempt
stubbed `TIHomework.toBase64`. It had no effect: `uploadAll()` calls the
module-internal function, which is closed over, so the real `FileReader` ran
against plain objects and five tests failed for the wrong reason. The tests now
use genuine `File` objects, which exercises the actual read path rather than a
seam that does not exist.

## Not wired yet — you need to decide two things

1. **Where the modal is triggered.** `TIHomeworkView.open()` is exported and
   tested but not yet called from the session-start button, because the three
   controls (`#ti-session-start`, `#ti-session-practice`, `#ti-session-end`) do
   not exist in the current markup. `paintSessionControls()` looks for those ids
   and no-ops safely until they do.
2. **Whether homework uploads should stay unauthenticated.** They inherit
   `/data/upload`'s public status. Chat attachments already did, but homework is
   student work, and this is a good moment to decide whether that route should
   move behind a short-lived per-session token.

Files are stored under the standard TTL clamp and swept by the existing
retention sweeper, so nothing accumulates indefinitely.
