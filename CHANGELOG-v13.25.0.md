# claude-connector v13.25.0

**SPEC-FIX-MODULE-WRITE-001 — `module_write` path resolution.**

## The defect

`module_write` resolves its base to `/data/skill/ava/modules/` and then
`join()`ed the caller's path onto it unchanged. Two reasonable spellings of the
same intent therefore resolved to two different physical files:

| Caller passed | File written |
| --- | --- |
| `meta/x.md` | `/data/skill/ava/modules/meta/x.md` (correct) |
| `modules/meta/x.md` | `/data/skill/ava/modules/modules/meta/x.md` (wrong) |

Both returned `success: true`. That is what made it dangerous rather than
merely wrong — nothing errored, a file was written, and the only signal was the
resolved-path field on a response that said the write had worked. Observed on
2026-08-31 while updating `meta-deflection-watch.md`.

## A second consequence, found while fixing it

The original spec described the misplaced file. It did not identify that the
same unnormalised path also **poisoned the manifest entry**.

`deriveModuleEntry()` takes the module category from the first path segment
(`manifest-fragments.js:511`) and sets `path` to `` `modules/${cleanPath}` ``
(`:552`). With the `modules/` prefix left on, a prefixed write registered:

- `category: "modules"` — a category that does not exist, and
- `path: "modules/modules/meta/x.md"` — the manifest pointing at the
  double-nested copy.

So the registration did not merely fail to describe the canonical file; it
actively described the wrong one. Normalising before `deriveModuleEntry()` is
what repairs this, and is why the normalisation lives at the top of the handler
rather than only at the `join()`.

## A third: the overwrite guardrail was being bypassed

The existing-file check ran against the unnormalised path. A prefixed write
therefore tested a path that did not exist, concluded the file was new, and
sailed past the `force: true` guardrail entirely. The safety control was being
defeated by the same bug it would have caught.

## Changes

### `src/tools/skill-content.js`

- **New exported `normaliseModulePath(rawPath)`.** Collapses duplicate
  separators, then strips leading `./`, `/` and `modules/` repeatedly until
  stable. Idempotent.

  Repeated stripping rather than a single pass is deliberate: one pass leaves
  `modules/modules/meta/x.md` as `modules/meta/x.md`, which joins straight back
  to the double-nested path — i.e. it would fail the exact acceptance criterion
  the fix exists to satisfy. The trade-off is that a module category literally
  named `modules` becomes unaddressable. No such category exists (the shipped
  tree has `self-model/`, and `MANIFEST_APPEND.json` contains no `modules`
  category), and one would be ambiguous with the base directory by
  construction.

  Duplicate-separator collapse happens *before* the prefix strip so that
  `modules//meta/x.md` — one of the two stray copies recorded on the volume —
  normalises like every other spelling instead of being rejected by
  `validateContentPath`'s double-slash rule. Collapsing empty segments cannot
  introduce traversal; `..` is still rejected by the validator.

- **`handleModuleWrite` normalises before validating** (spec §4.1). Everything
  downstream — the join, the overwrite guard, the manifest entry, the WP backup
  and the log lines — reads `cleanPath`, so normalising once is what makes them
  all agree.

- **`resolveContained()` replaces the bare `join()`** (spec §4.1, containment
  half). This handler was the one write path in the file still doing a lexical
  join, so it was also the only one without the symlink guard its siblings got
  in v12.28.0 (TNX-C-005). `join()` will happily place a file through a
  symlinked intermediate directory.

- **A hard double-nest refusal** (spec §7). The normalisation means this cannot
  fire; asserting it at the write boundary means a future edit that
  reintroduces the bug fails loudly instead of silently writing to the wrong
  place and reporting success — which is precisely how the original survived.

- **Resolved-path reporting** (spec §4.2) on the success branch
  (`requested_file`, `normalised_file`, `resolved_path`) and on the
  blocked-overwrite branch (`existing_file.resolved_path`,
  `diagnostics.normalised_file`). `path` already carried the resolved location
  and is unchanged, for compatibility. The new fields make the normalisation
  legible rather than implicit: what was asked for, and what it became.

- **Tool schema states the convention** (spec §4.3): pass paths *without* the
  `modules/` prefix. Both spellings now work; the unprefixed form is documented
  as the convention, which is the belt-and-braces second layer.

### `src/tests/module-write-path.test.js` (new)

17 checks against a real temporary volume rather than against source text. The
defect was never visible in the shape of the code — every line of the old
handler looked correct in isolation, and the only signal was which physical file
existed afterwards. A grep-style test would have passed against the broken
version.

Mutation-verified: reverting the normalisation call turns 5 of the 17 red.

## Not done here — operator action required

Spec §6 lists two stray double-nested copies on the live Railway volume:

- `/data/skill/ava/modules/modules/meta/meta-deflection-watch.md`
- `/data/skill/ava/modules//meta/meta-deflection-watch.md`

Both are v1.1.0 content that also lives at the canonical path, and no dispatcher
reference points at them. They are on the deployed volume, not in this
repository, so they cannot be removed by a code change. Delete them during
deployment and confirm with `skill_audit` that only the canonical file remains.

## Regression risk

`normaliseModulePath` is called only from `handleModuleWrite`. `archive_write`,
`reference_write` and `script_write` are untouched and keep
`validateContentPath`'s strict double-slash rejection. Full connector suite run:
no new failures (7 pre-existing failing files verified identical against an
unmodified extraction of 13.24.0).
