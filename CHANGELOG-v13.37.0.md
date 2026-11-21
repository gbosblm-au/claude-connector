# claude-connector v13.37.0

**Work order TENAX-2026-11-10-02** (Deal Scout: category-agnostic sourcing and
identifier-absent matching), sections 3 (R2) and the carried change K of
TENAX-2026-11-10-01.

Deploy order: this connector FIRST, then ts-gateway-service 2.337.0, then
ts-client-gateway 5.273.0. Each step is safe alone. Both changes are opt-in
arguments: a caller that does not send them gets exactly the 13.36.0
behaviour, and gateway 2.337.0 still handles a connector that ignores them.

## What changed

### R2: `web_fetch_page` can return the page's structured data

A product page that carries schema.org JSON-LD states its own identity (gtin,
mpn, brand, model, itemCondition, the variant group). The tool parsed the
HTML, took headings and links from the parse, and then removed every script
element before reading the text, so that declared identity never reached any
caller.

With `include_structured_data: true` the result now carries:

| Field | Meaning |
|---|---|
| `structured_data` | one `{ "@type", data }` element per `application/ld+json` script that parses, as written |
| `structured_data_invalid` | scripts that did not parse; counted, never guessed at |
| `structured_data_dropped` | blocks left out by the bound (20 blocks, 60,000 serialised characters) |

The connector interprets nothing. It does not know what a product is; the
caller reads the vocabulary. An empty list is a statement that the page
carried none that parsed. The page text is unchanged.

### K: a site's refusal can be returned as data

Every non-2xx upstream reply was thrown as an Error. The MCP layer answers a
thrown tool with a 500, so to a caller an anti-bot 403, a merchant's 404, a
429 and a platform outage were one failure.

With `on_http_error: "return"` a non-2xx reply is returned with
`status_code`, `upstream_ok: false`, `fetch_outcome: "upstream_non_2xx"`, the
first 300 characters of the body (tags removed) as `body_excerpt`, and
`blocked_hint`: true for a 401 or 403, for a known challenge header
(`cf-mitigated`, `x-datadome`, `x-px-block`, `x-amzn-waf-action`), or for a
non-2xx body that says it is a bot check.

**The default is unchanged.** Without the argument a non-2xx reply throws with
the same message as before, because the tool's other callers (the chat model,
subject lookup, social compose) were written against the throw.

A request that received no reply still throws, and now names which kind:
`(fetch_outcome: timeout)` or `(fetch_outcome: transport_error <code>)`.

A 2xx result now always carries `upstream_ok: true` and `fetch_outcome`
(`ok`, or `body_too_large` when the stream was cut at its cap).

## Changed files

| File | Change |
|---|---|
| `src/tools/webFetch.js` | `extractStructuredData`, `blockedHint`, the two new inputs, `upstream_ok` and `fetch_outcome`; `handleWebFetchPage( args, deps )` takes an optional `fetchImpl` for tests |
| `src/tests/web-fetch-structured.test.js` | **new.** 13 tests, each driving the real handler |
| `scripts/verify-tenax-2026-11-10-02-mutations.mjs` | **new.** 9 mutations, each shown to turn its test red |
| `package.json` | 13.36.0 to 13.37.0 |

## Consumers of the changed surface

`handleWebFetchPage` is called by the MCP tool registry only. The gateway
consumers of `web_fetch_page` (lib/deal-research.js, lib/subject-lookup.js,
lib/social-compose.js and the chat model's tool belt) send neither new
argument except Deal Scout, so they see the 13.36.0 shape plus two new fields
(`upstream_ok`, `fetch_outcome`) that none of them reads.

## Verification

Run: `node --test --test-reporter=tap src/tests/*.test.js src/tools-memory/*.test.js`,
against 13.36.0 as uploaded and against this tree.

| | tests | pass | fail | skipped |
|---|---|---|---|---|
| 13.36.0 | 1,087 | 1,029 | 57 | 1 |
| 13.37.0 | 1,100 | 1,042 | 57 | 1 |

+13 executed, all 13 accounted for by name (the new file). The 57 failures are
the same 57 names before and after (voice and ElevenLabs suites), carried
from the baseline and not touched by this release.

`node scripts/verify-tenax-2026-11-10-02-mutations.mjs`: 9 of 9 red.

## Known, not done

* `package-lock.json` reads 13.25.0 in the uploaded 13.36.0 and was left as
  found; it is not this release's to correct.
