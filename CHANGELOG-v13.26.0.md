# Gateway v2.181.0 / Connector v13.26.0 — Full-text storage for passive ingestion

SPEC-SOURCE-TIERING-001 Sections 4 and 5.

Paired release. The gateway change is inert without the connector change, and
the connector change has nowhere to send to without the gateway change. **Deploy
the gateway first**: the new endpoint returning 404 makes the connector's
forward fail harmlessly, whereas the reverse order silently stores nothing.

## The gating question, and its answer

Everything turned on where `web_fetch_page` clips. Traced in `webFetch.js`:

```js
let mainText = extractMainText($);          // 260 — FULL body extracted
if (mainText.length > maxChars) {
  mainText = mainText.slice(0, maxChars);   // 263 — clip by REASSIGNMENT
}
```

The clip is **post-extraction**, but line 263 **reassigns**, so the complete
body existed for exactly one statement and was then unrecoverable. The v2.180.0
hook lived on the gateway and could only ever see what the connector serialised,
which was the clipped value. The store could therefore only ever hold a partial
page wearing the shape of a complete one.

The full text could not simply be added to the tool result: the gateway returns
that result **verbatim to the model**, so the full body would have defeated
`max_chars` and flooded the context window.

So the trigger moved to the connector, which forwards the full text on a
separate path. The model-facing payload is untouched.

## Three defects found during the trace

**1. `safeFetch`'s stream truncation was never read.** `webFetch.js:58` capped
the fetch at `ABSOLUTE_MAX_CHARS * 4` (800 KB) — a derivation from the
*model-facing char limit* applied to *raw HTML*, which is a category error.
`safeFetch` does not throw on that cap; it stops reading and returns the partial
body (`truncated = true; res.destroy()`). It reports this honestly on the
response object. **`webFetch.js` never read the flag.**

Measured live, before and after:

```
OLD cap (200000*4 = 800KB)     html=  793662B  stream_truncated=true
NEW cap (8MB)                  html= 1101697B  stream_truncated=false
```

`nodejs.org/api/fs.html` is ordinary vendor documentation and **was being cut
mid-stream**, parsed by cheerio as though complete, and reported to the model as
complete. This was model-facing before it was storage-facing: the model would
read a prefix as the whole page with nothing saying otherwise.

**2. The 2 MB soft ceiling was unreachable.** Extracted text is always smaller
than the HTML it came from. Under an 800 KB fetch cap, text could not approach
2 MB, so the ceiling would never have fired. A decorative ceiling is worse than
none: it looks like protection while protecting nothing.

**3. Changes 3 and 5 were already shipped.** `migrations/0018_web_source_store.sql:131`
already carries `CREATE UNIQUE INDEX ... ON web_sources ( url_canonical )` with
UUID as the surrogate primary key — the books pattern, already in place. Change 4
was ~80% done: `canonicaliseUrl` already strips the trailing slash, lowercases
and de-`www`s the host, drops default ports and the hash, sorts the remaining
query and removes 26 tracking parameters. **Nothing was rebuilt.** Those changes
became a test-and-report job.

## Files

### Gateway (7)

| File | Change |
|---|---|
| `lib/web-source-fetch-ingest.js` | **Rewritten.** Now the gate for connector-forwarded full text. Char-clip skip retired; stream-cut refusal and oversize flag added. |
| `routes/ti-tools.js` | **New endpoint** `POST /ti-tools/web-source-ingest`, a thin surface over the existing gate. Router factory gains an optional injectable `ingest`. |
| `routes/ti-chat.js` | v2.180.0 hook **removed**; original proxy return restored. A comment points at where the trigger went. |
| `server.js` | One `LARGE_BODY_PATTERNS` entry so the new route parses at 8 MB. |
| `tests/web-source-passive-ingest.test.js` | **Rewritten.** 32 tests. |
| `package.json` | Version, plus `test:web-source-auto`. **No dependency change.** |
| `CHANGELOG-v2.180.0.md` | This file appended. |

### Connector (5)

| File | Change |
|---|---|
| `src/tools/webFetch.js` | Full extraction retained; stream cut surfaced; fetch cap raised; forward wired. |
| `src/tools/webSourceForward.js` | **New.** Fire-and-forget forwarder. Holds no authority vocabulary. |
| `src/tools/ti-tools-client.js` | `webSourceIngestRemote`; `callGateway` gains an optional `timeoutMs`. |
| `src/tests/web-source-forward.test.js` | **New.** 22 tests. |
| `package.json` | Version 13.25.0 → 13.26.0, plus `test:web-source-forward`. **No dependency change.** |

## Change 1 — storage always ingests full text

The store holds the complete page. The model receives a clipped view via
`max_chars`. **The clip governs only what is read, never what is remembered.**

`extractMainText($)` is now bound to a `const fullText` the clip cannot
reassign. `mainText` is derived from it for the model. The tool result carries
`text: mainText`; the forwarder carries `text: fullText`.

Proven live against the page that motivated the change:

```
MODEL-FACING PAYLOAD
  text_length       : 50000    (what the model reads)
  full_text_length  : 243978   (what exists)
  truncated         : true     (char clip)
  stream_truncated  : false    (HTML complete)
  full body in result: no
```

## Change 2 — skip-on-truncated retired, and split in two

The v2.180.0 char-clip skip is **gone**. With full-text storage there is nothing
partial to skip, and keeping it would have declined exactly the long pages most
worth holding.

It is replaced by a distinction the old code did not draw:

- **Char clip (`truncated`)** — the page was fetched whole, the model's view is
  short. **Model-facing signal only. No bearing on storage.**
- **Stream cut (`stream_truncated`)** — the HTML itself is incomplete.
  **Refused.** Storing it would be a record that reads authoritative while being
  an arbitrary prefix, with nothing in the row to say so.

Fixed at both levels, because the bug was model-facing before it was
storage-facing:

- **(a)** `webFetch.js` reports `stream_truncated` truthfully, always present so
  its absence can never be read as "complete", plus a prose `note` beginning
  `INCOMPLETE PAGE` — a boolean in a JSON blob is easy to skim past.
- **(b)** The gateway refuses to ingest any page carrying the flag, **before**
  authority is consulted, so a data-integrity failure is never reported as a
  policy outcome.

## Changes 3, 4, 5 — tested, not rebuilt

Acceptance test 3 runs against the **existing** `canonicaliseUrl`. Nine
equivalent addresses collapse to one identity. A counter-test confirms
meaningful parameters survive: `?id=42` and `?id=99` stay distinct, so the
normaliser is not merely dropping everything.

**One gap reported rather than silently closed:** `canonicaliseUrl` does **not**
unify `http://` and `https://`. Those are two rows today. Left alone
deliberately — collapsing them asserts that a plain HTTP page and its TLS
counterpart are provably the same document, which is not always true, and the
change belongs in the normaliser with its own tests rather than smuggled in
behind this feature. There is a test recording the current behaviour so the
decision is visible.

## Change 6 — the ceiling, reconciled with the fetch cap

The 2 MB figure is **deleted**. The soft ceiling is now `SOFT_MAX_CHARS`
= 200,000, matching `ABSOLUTE_MAX_CHARS`: the largest read the fetch tool will
ever serve, so a body above it exceeds anything the model can consume in one go.

It **flags**. It does not refuse and it does not truncate. An oversize page is
stored **whole** and reported. There is no migration: `char_count` is already on
every row, so the audit is `SELECT ... WHERE char_count > 200000`.

A test asserts the ceiling is *reachable* — `nodejs.org/api/fs.html` extracts to
243,978 characters, above it — because an unreachable ceiling was the original
defect.

### `maxBytes`: 800 KB → 8 MB, derived not guessed

Measured HTML-to-text ratios on real high-authority pages, using the actual
extractor:

| Page | HTML | Text | Ratio |
|---|---|---|---|
| postgresql.org sql-insert | 48,209 B | 21,748 | 2.22 |
| docs.python.org asyncio-task | 177,075 B | 42,744 | 4.14 |
| nodejs.org api/fs | 1,102,999 B | 243,978 | 4.52 |
| developer.mozilla.org Array | 244,502 B | 39,520 | 6.19 |
| en.wikipedia.org TCP | 748,329 B | 91,642 | 8.17 |
| kubernetes.io kube-scheduler | 502,946 B | 4,167 | 120.7 |

The binding case is a **text-rich** page at the worst observed ratio, 8.17.
Fetching whole any page that extracts to 200,000 chars needs 200,000 × 8.17 ≈
1.63 MB; a 4× headroom multiple gives ≈ 6.5 MB, rounded to **8 MB**. That is 40×
the text ceiling in bytes, so for any ratio below 40 the **text ceiling is
reached first** and the page is extracted whole. Above ratio 40 the page is
text-poor (the kubernetes.io row) and nothing meaningful is lost.

8 MB also sits **below** `safeFetch`'s own `DEFAULT_MAX_BYTES` of 10 MB, so it
is not an escalation past what that module already treats as safe to buffer, and
it matches the store's `MAX_BODY_BYTES` and the gateway's existing 8 MB parser.

## One gate, on the gateway

The connector **makes no authority decision**. It holds no authority model and
must not grow one, or there would be two gates to keep in step. It forwards
every fetched page unconditionally; `ingestionDecision` remains sole authority.

A test asserts the forwarder contains none of `high`, `medium`, `unknown`,
`authority`, `news`, `evaluateUrl` or `ingestionDecision`, and that it imports
exactly two modules.

A declined page is answered **200 with `ingested: false`**, not a 4xx —
precisely so the connector is never tempted to infer a filter from status codes.

## Privacy

The forwarded body is `{ url, text, title, stream_truncated }`. No tenant, no
user, no session, no query, no tool arguments. Asserted as a **whitelist** on
both sides, so a field added later fails the suite rather than slipping through.

`confirmedBy` is never passed, so `web_sources.confirmed_by` stays NULL **by
construction** — and that NULL remains the marker distinguishing an
auto-ingested row from a manually confirmed one. Without it, the store's own
§5.1 and §5.2 filters still refuse news and still refuse medium/low/unknown even
if this gate drifted. Four tests run the **real** `ingestWebSource` to prove the
two gates agree.

## Verification

- **32/32** gateway tests, **22/22** connector tests.
- **Zero regression:** 74 gateway suites referencing `ti-chat.js`, `ti-tools`,
  `web-source`, `tvrl.js` or `server.js`, and all 39 connector suites. Before and
  after output byte-identical on both.
- **Live end-to-end** against `nodejs.org/api/fs.html`, and a before/after proof
  that the old cap genuinely cut it.
- ESLint clean on all new gateway files.
- `package-lock.json` **byte-identical** on both packages; no dependency added,
  removed or changed. (v2.180.0 shipped a mutated `pg` range — see below. Both
  packages were installed with `npm ci` this time, which cannot mutate a
  manifest.)

### Corrections made during the build

- **Two prose-sensitive test assertions.** Four tests initially grepped raw
  source and failed on the modules' own explanatory comments. Rewritten to strip
  comments and assert on code, with the primary guarantee made behavioural.
  These failed loudly rather than passing blind.
- **Wrong version number.** Connector changes were first labelled v12.30.0,
  inferred from a stale `v8.0.0` header comment rather than the manifest. The
  connector is at 13.25.0, and **v12.30.0 is a real past release** (TNX-H-014,
  `credentialStore.js`), so the label would have collided with shipped history.
  Corrected to 13.26.0 across ten references.
- **v2.180.0's two test-matcher edits reverted.** They were only needed because
  the proxy line became an assignment. That line is restored, so the
  justification is gone and the files return to pristine.

### Limitation

No Postgres in the build environment. The store write is proven against an
injected stand-in, and the gate-agreement checks reach the real
`ingestWebSource` up to its first `pool.query`. **The end-to-end write is not
covered by an executed test here.** Run `tests/source-tiering-db.test.js` and
`tests/web-source-integrity.test.js` with `DATABASE_URL` set to close it.

## Deployment

1. Gateway v2.181.0 first. No migration.
2. Connector v13.26.0 second.
3. `GATEWAY_URL` and `GATEWAY_ADMIN_KEY` must already be set on the connector —
   the same pair `profile-read`/`profile-write` use. Without them the forwarder
   logs at debug and skips, which is the correct standalone behaviour.

Optional: `WEB_SOURCE_SOFT_MAX_CHARS` (default 200000),
`WEB_SOURCE_INGEST_TIMEOUT_MS` (default 20000).

## Your acceptance run

Fetch a long high-authority page, then confirm:

```sql
SELECT char_count, confirmed_by, fetched_at FROM web_sources
 WHERE url_canonical = 'https://nodejs.org/api/fs.html';
```

Expect `char_count` ≈ 243,978 while your read stays at `max_chars`, and
`confirmed_by` NULL. For the stream-cut refusal, set
`WEB_SOURCE_INGEST_TIMEOUT_MS` aside and instead watch for
`[web-source-auto] REFUSED stream-truncated page` in the gateway log; no row
should appear.

---

## Addendum — pre-ship probes

Four probes were run against the shipped artifacts before release.

### 1. The forward never blocks the turn

Measured, not asserted. Against a gateway deliberately stalling 5000 ms,
`handleWebFetchPage` returned in **1154 ms** with the full clipped payload
intact. The call is not awaited; the promise floats.

Against a gateway on a closed port (ECONNREFUSED), the fetch returned in 838 ms,
the failure was logged at WARN, and **zero unhandled rejections** were raised —
the whole forwarder body is inside one try/catch, so it cannot reject.

This holds for pages that will be refused as much as for pages that will be
stored: the connector does not know which is which, and neither costs the turn
any latency.

### 2. Body limits, proven over real HTTP

The decisive check sends an **identical 3 MB payload** to both routes:

```
ingest        2,000,000 chars  -> 200
profile-write 2,000,000 chars  -> 413 entity.too.large
ingest        9,000,000 chars  -> 413 entity.too.large  (over the 8 MB parser)
```

**Terminology correction:** the route is on `LARGE_BODY_PATTERNS`, **not**
`LARGE_BODY_PREFIXES`. That is deliberate and load-bearing. A `/ti-tools` prefix
would have widened `profile-write` too, and the pair above is the proof that it
did not.

**A defect was found in `verify-gateway-body-limits.mjs` while confirming this,
and fixed.** That script's header promises its lists are "re-derived from the
shipped source... A drift between this test and server.js therefore fails the
test rather than passing silently". True for `LARGE_BODY_PREFIXES`. **Not true
for `LARGE_BODY_PATTERNS`, which was a hardcoded literal copy** holding only the
chef-photo pattern. It disagreed with `server.js` the moment a pattern was
added, and would have reported a correct route as misrouted.

It now derives the list from source, with comments stripped before evaluation.
Twelve new checks were added to that script rather than leaving a throwaway
probe. `CHAT_BODY_PATTERNS` remains partially hardcoded — **reported, not
changed**, as it is outside this release.

**Reuse Audit miss, recorded.** `verify-gateway-body-limits.mjs` already existed
and does exactly this job. It was not found in the original audit, and a
standalone probe was written that duplicated it. The probe was discarded and its
checks folded into the existing script.

### 3. http/https duplication — parked, with a name attached

Not theoretical, but narrower than it looks. Most sites redirect, so `finalUrl`
lands on https and no duplicate occurs:

```
http://kubernetes.io/docs/home/                 -> https://kubernetes.io/docs/home/
http://www.postgresql.org/docs/.../sql-insert   -> https://www.postgresql.org/...
http://nodejs.org/api/fs.html                   -> http://nodejs.org/api/fs.html
```

**`nodejs.org` does not redirect.** It is a live high-authority example that
would store twice, once per scheme. Parked deliberately: collapsing the schemes
asserts a plain HTTP page and its TLS counterpart are provably the same
document, which is not always true. The change belongs in `canonicaliseUrl` with
its own tests. A test pins the current behaviour so the decision stays visible.

### 4. Four-marker version check

| Marker | Gateway | Connector |
|---|---|---|
| Archive | `ts-gateway-v2.181.0-…` ✓ | `claude-connector-v13.26.0-…` ✓ |
| CHANGELOG | `CHANGELOG-v2.181.0.md` ✓ | `CHANGELOG-v13.26.0.md` ✓ |
| Code marker | 8 refs, all v2.181.0 ✓ | 9 refs, all v13.26.0 ✓ |
| package.json | 2.181.0 ✓ | 13.26.0 ✓ |

The check confirmed the collision caught earlier was real: `CHANGELOG-v12.30.0.md`
**already exists** in the connector, so the original v12.30.0 label would have
overwritten shipped history.

`CHANGELOG-v2.180.0.md` gained a **SUPERSEDED** banner: it describes a hook that
no longer exists, and read standalone it would mislead. Kept as history because
the v2.180.1 build-failure post-mortem is still the record of that incident.
