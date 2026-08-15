# v12.43.0 — Tool-Call Integrity guard (CONN-GUARD-001)

## New files

- `src/tools/render-schemas.js` — the capability schema registry each renderer
  registers into, plus the shared validation contract.
- `src/tools/tool-call-guard.js` — the guard, at the connector boundary.
- `protocol/tool-call-integrity-protocol.md` — the discipline layer (v1.0).

## The failure being prevented

Observed 2026-08-15: `document_render` went out twice with no `spec` payload.
The renderer never received a body, and the model pivoted to a script fallback
instead of retrying the tool. The guard breaks the first link — an empty call
must not be accepted at the boundary — and, through the shape of its rejection,
the third: a model told "invalid spec" pivots, a model told "the spec payload
was missing entirely; re-fire with title and a non-empty sections array"
retries correctly.

## What this adds over the existing pre-check

`render-tools.js` already carried a boundary pre-check applying the same two
shared rules, and it is left in place as the second layer §3.1 describes. The
overlap is real and it would be dishonest to present this as filling an empty
space. What the pre-check cannot do:

- distinguish "no spec was attached" from "the spec is missing a title". Both
  came back as `invalid_spec` with a field message, which is misleading advice
  for the observed failure — the model reads it as a field problem and adds a
  title to a body it never sent, which is the second failed call in the incident;
- return a RETRY directive rather than an error. Nothing in the pre-check told
  the model that re-firing was the expected next move;
- record telemetry. §3.4 wants a measurable rejection rate per model, which is
  the evidence base for the routing lockdown;
- extend to a new renderer automatically. The pre-check's validator is passed
  in by each handler, so a new one inherited nothing.

## A deliberate deviation from §3.2

The spec asks that "section/slide objects must carry a type and required fields
per type". That is NOT implemented, and the reasoning is recorded in
`render-schemas.js`:

The deployed Python renderers accept more than the specification tables
describe — a `subheading` section type, a `success` callout, a text section
with no `text` key, `metadata.title` in place of `title`, `col_widths` as an
object, and pptx slides modelled as `{elements:[…]}` entirely. A guard written
from the tables **rejects specs the renderer would have accepted**, which turns
working documents into validation errors for content that renders correctly
today. That is a worse failure than the one being fixed.

The registry therefore encodes the shared rules the spec names first — title
required and non-empty, collection required and non-empty — plus the structural
checks that cannot produce a false rejection: the spec must be present, must be
an object, and its collection entries must be objects. Depth beyond that stays
with the renderer, which is the source of truth. Tests pin this: a spec using
the section types the tables omit must pass.

## Placement

The guard runs at `handleSpecRender()` — the single line every spec-renderer
call passes through, before any work — and at `handlePdfRender()`, which does
not route through it at its own boundary. A renderer added later inherits the
guard by routing through `handleSpecRender`, which is what §3.1 means by
renderer-class-wide.

`pdf_render` in `from_docx` mode is exempted explicitly: it converts an existing
document and carries no spec by design, and demanding one would block every PDF
made from a file the user already has. The exemption is narrow rather than
leaving the tool unregistered, because `from_spec` mode does carry a spec and
must be guarded.

## Implementation note

The guard is JavaScript, not Python. §3.1 places it at the **connector
boundary**, between the model's tool-call emission and renderer dispatch — which
in this codebase is JS. A Python guard would sit inside the renderer, after the
boundary, so an empty call would still cross it and the placement requirement
would not be met.

## Tests

- `tests/tool-call-guard.test.js`: 34 assertions, including the observed
  failure, the full §2 failure table, the RETRY directive shape, the telemetry
  fields, and interception proven through the real handler.
- Connector suites: 94 assertions green across four files.

---

## Post-review corrections

Three issues were raised in review. One rested on a mistaken premise; two were
real regressions found by a pre-existing suite I had not run.

**1. Handler wrapping — did not ship.** The `withGuard()` wrapper hit a
temporal-dead-zone error (the tool definition table references the handlers
above their definition), so it was reverted before delivery and the guard was
attached at the chokepoint instead: `handleSpecRender()` (all three spec
renderers) and `handlePdfRender()`. The dead `withGuard()` export has now been
deleted — an exported unwrapped handler beside a guarded one is a trap, since
the first thing anyone debugging a rejection reaches for is the version without
the guard. A test asserts no `*Raw` export exists.

There is also no streaming in this path to interfere with: MCP tool handlers
are request/response, the render path spawns a subprocess and returns, and the
gateway's SSE loop is a different process entirely.

**2. Dry runs were broken.** REGRESSION. The guard ran ahead of the `dry_run`
branch, converting a validation VERDICT (`isError: false, valid: false`) into a
hard rejection. A dry run asks "would this be accepted?" and never dispatches
to the renderer, so the failure class the guard prevents cannot occur on it.
Dry runs are now exempt.

**3. `error_kind` changed for incomplete specs.** REGRESSION. A present-but-
incomplete spec was returning `guard_rejected` where the published contract is
`invalid_spec`. Only an ABSENT or empty payload is a genuinely new outcome —
before this guard it did not exist as a distinct class — so only it takes the
new kind. The guard's value (`retry`, `directive`, `faults`) now rides
alongside the preserved contract, and `errors[]` is emitted as well as
`faults[]` so existing readers keep working.

Both regressions are pinned by tests. `src/tests/render-tools.test.js` now runs
as part of verification: 73 pass, 1 fail, and that failure is present on
pristine v12.42.0 (a `CONNECTOR_URL` teardown-ordering issue) and is not
introduced here.
