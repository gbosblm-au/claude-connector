# v12.45.0 — CONN-GUARD-001 Amendment 1

Documentation and tests only. **No guard behaviour changes**: the guard already
behaves as the amendment specifies, which is the point of the amendment.

## What changed

`CONN-GUARD-001 §3.2` required that "section/slide objects must carry a type and
required fields per type". That clause is withdrawn as written.

The deployed renderers accept more than it describes, and the guard sits in
front of them, so a guard enforcing it converts working documents into
validation errors — a worse failure than the empty call the guard was written
to prevent.

The governing instance is `spec_render_common.py`:

    stype = sec.get("type", "text")

A section with no type is valid and renders as text.

## Amended rule

- title and non-empty collection: unchanged
- every collection entry must be a JSON object
- an entry is NOT required to carry a type where the renderer defines a default
- where a type IS present, it must be registered, and any fields it declares
  required must be present
- anything beyond that is delegated to the renderer

## Evidence

`protocol/conn-guard-001-amendment-1.docx` carries the full contract for all
four renderers, extracted programmatically from the deployed code rather than
transcribed. Every row of the section-type table was verified against
`spec_render_common.validate_spec` in both directions: types listed as having no
required fields accept the bare form, and types with required fields reject its
absence. 14 rows, no mismatches.

## Tests

Five assertions added to `tests/tool-call-guard.test.js` pinning the amendment's
claims against the guard, so the specification and the guard cannot drift the
way the specification and the renderers did. 43 pass.
