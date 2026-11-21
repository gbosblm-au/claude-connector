# claude-connector v13.39.0

**Work order WO-2026-11-21-01 rev 1: the duplicate-minting guard, the
frozen-manifest ruling, and the auditor's own reporting.**

Built on 13.38.0, the archive supplied with the order. Companion: ts-client-gateway
5.287.0, which shows the paths a push skipped. Gateway-Service 2.366.0 is
unchanged and needs no redeploy. Deploy order: this connector first, then the
WordPress plugin. Each step is safe alone: a 5.286.0 plugin ignores the new
`skipped` field (the connector still refuses to restore a quarantined file), and
a 5.287.0 plugin against a 13.38.0 connector sees no `skipped` field and reports
none.

The version lineage warning in CHANGELOG-v13.38.0.md still applies. If the
deployed connector is from the October 13.38.0 to 13.43.0 line, apply
`WO-2026-11-21-01-connector.patch` (a unified diff against the 13.38.0 archive,
delivered beside this one) to the live tree instead, and use the next free
version number.

Nothing in this release deletes a file, and nothing touches the dispatch layer:
CORE.md, MANIFEST.json, MANIFEST_APPEND.json, DISPATCH_RULES.json, dispatch
selection, always_load flags and references/manifest/ are not edited by the
build or by any code it adds. The only new mutating behaviour is a refusal.

## R1 to R5: module_write cannot mint a duplicate (G7, D12)

`module_write` now asks the shared resolver (`resolveModulePath`, the one
`skill_compile` uses) about the module id it is about to write, **before any
file operation and before the overwrite guard**. The id is the content's
frontmatter id where present, otherwise the file name exactly as
`deriveModuleEntry` derives it; when the caller passes `manifest_entry.id`, that
id is checked too. The call does not depend on the frontmatter parsing.

| Code | When | Payload |
|---|---|---|
| `duplicate_id_path` | the id already resolves (or is registered, or exists as files with no registration) at a different path | `{ id, resolved_path, resolved_by, requested_path, candidates[] }`, each candidate with sha256, size and line count, and both routes forward |
| `path_holds_other_id` | the path already holds a file of a different id; `force` does not override it | `{ path, existing_id, incoming_id }` |
| `write_guard_unverified` | the resolver could not give a complete answer (the scan hit `MODULE_INDEX_MAX_FILES`, or the tree could not be read); fail closed | a message |

The two routes a `duplicate_id_path` refusal names: pass
`acknowledge_resolved_path` equal to `resolved_path` and the write goes to the
resolved file (the overwrite guard still applies, so an existing file needs
`force: true`), or quarantine the existing file first with `module_delete`.

A genuinely new id is created exactly as before (R4). `dry_run: true` returns
the same verdict, refusal for refusal, and writes nothing (R5); for an allowed
write it says whether the real call would create, overwrite, or be blocked by
the overwrite guard.

Every `module_write` response now carries `write_guard: { verdict, ids,
redirected, resolutions }`, verdict one of `new_id`, `resolved_here`,
`redirected_to_resolved`, `refused` or `not_a_module` (a `.json` data file has
no module id to resolve).

## R9: deterministic.status can say it did nothing (N1, D13)

`skill_consistency_audit` returns `deterministic.status` as exactly one of:

| Value | Meaning |
|---|---|
| `clean` | every requested check ran and passed |
| `findings` | at least one requested check ran and returned a finding |
| `not_run` | no requested check was executed |
| `unverified` | the floor failed: no module read, or the scan truncated |

plus `requested`, `ran` and `skipped: [{ check, reason }]`. `checks: ["C-E"]`
now reports `not_run` with C-E skipped as advisory, never `clean` with an empty
`checks_run`. `checks_run` is kept (equal to `ran`) for older readers.

## R10: tiers, and the register of accepted findings (N2, D14)

Every deterministic finding is classified:

- **accepted**: matched by a valid entry in the register;
- **blocking**: otherwise, if it comes from C-A, C-C or C-D;
- **new**: otherwise.

The report now opens with the headline (`"3 blocking, 41 accepted, 0 new"`),
with a per-check line such as `C-A: 60 findings, all accepted (register entry
2026-11-21-04)`.

The register is a hand-edited JSON file at `{avaDir}audit/accepted_findings.json`
(override: `SKILL_AUDIT_ACCEPTED_REGISTER`, absolute or avaDir-relative). The
audit reads it and never writes it. Shape:

```json
{ "entries": [
  { "id": "2026-11-21-04",
    "match": "C-A:entry:references/manifest/tools-fast-index.json:*",
    "reason": "pathless index fragment; external decision",
    "accepted": "2026-11-21" }
] }
```

`match` is a finding key or a list of them, with `*` as a wildcard. Keys:
`C-A:entry:<source>:<id>`, `C-A:file:<path>`, `C-B:<id>`, `C-C:<id>`,
`C-C:multi_id_file:<path>`, `C-D:missing:<name>`,
`C-D:references_manifest_absent`, `C-D:shadow:<path>`, `C-F:<id>`. An entry
without an id, a match, a reason and an accepted date is listed under
`invalid_entries` and not applied; entries that matched nothing are listed so
the register can be pruned by hand.

## R11: the event log lives outside quarantine/ (N3, D15)

The log moved from `quarantine/module_file_events.jsonl` to
`module-history/module_file_events.jsonl`. A purge of quarantine (even of the
whole directory) cannot take the record of what it purged.

On upgrade nothing moves at install. Until the first write, the old log is read
where it is and `module_file_events` reports `relocation_pending: true`. The
first write copies it forward byte for byte (temp file, fsync, rename) and
appends a `log_relocated` event (from, to, events carried, the old file's sha256
and size) before the event that triggered the write, so the history has no gap.
The old file is kept, read-only from then on.

`module_file_events` returns `log_path` on every call, including when no log
exists, and `log_outside_quarantine` (computed, not asserted).

## R12 to R14: resolution defects (G3, G5, G6)

- **R12.** `registered_in` carries only DECLARED registrations, as
  `{ source, id, path, declared_path: true }`. A registration with no path is
  reported in `pathless_registrations` as `{ source, id, path: null,
  declared_path: false }` and is never attached to the path the merge infers.
  The string `"... (path inferred)"` is gone. `merge_inferred_path` names what
  the compile loads for a path-less winning entry, labelled as the inference it
  is.
- **R13.** An id no manifest registers, found as exactly one file by the
  directory walk, now carries `resolved_path` (with `resolved_by:
  "directory_walk"` kept, and `loadable: false`, because the compile reads the
  manifest). Two or more unregistered files still resolve to nothing.
- **R14.** `ids_by_file`: each file with the ids that claim it (declares it,
  a declared registration names it, or it resolves there). A file claimed by
  more than one id is a `multi_id_file`, listed by `skill_audit` and reported by
  C-C (which now fails on one).

## R6 to R8: the frozen manifest (G9, D11)

- **R6.** `skill_consistency_audit.divergent_frozen_registration`, on every run:
  every divergent id with a registration in MANIFEST.json or
  MANIFEST_APPEND.json, with the registration's source, the resolved path and
  the sibling hashes, a four-valued `status` and `holds`. Report only.
- **R7.** Every duplicate group in C-B carries `resolved_is_registered`, and
  where it is false, `registered_path` and `registered_paths` separately from
  `resolved_path`.
- **R8.** `module_delete`'s `registered_in_frozen_manifest` refusal is unchanged
  in when it fires and now carries `reconciliation: "external"` and a note that
  reconciliation is a per-group human decision and a dispatch-layer amendment,
  not a missing feature.

## R15: a mirror push cannot undo a quarantine (G10)

`POST /restore-modules` (the WordPress "Push All" target) reads the event log
before writing any `modules/` path and skips a path whose most recent event is
`quarantined` with no later `restored`, or `purged`. Skipped paths are returned
as `skipped: [{ path, reason, last_event }]` with `files_skipped`; they are not
counted in `files_restored`. If the log exists but cannot be read, every
`modules/` path is skipped with that reason (fail closed for module files only).
Paths under `module-history/` and `quarantine/` are never written by a push.

## R16: nested module trees (G13)

`skill_consistency_audit.nested_module_trees`: one finding per nested `modules/`
tree (for the live volume, `modules/modules/`), with the file count, the
subdirectories, the ids duplicated outside the tree, the ids only in it, and the
unregistered file count. Report only; removal is out of scope.

## R17 to R19: report shapes

- **R17.** `always_load_aggregate` on every run (not only when C-E is
  requested), naming the estimator (`bytes_div_4_ceil`, `ceil(bytes / 4)`) and
  stating the ceiling as a policy figure (`ceiling_kind: "policy"`, with its
  source: `SKILL_ALWAYS_LOAD_TOKEN_CEILING` or the default 40,000).
- **R18.** C-H groups collisions by module pair, ranks pairs by shared trigger
  count, returns the top 20 with `module_pairs`, `truncated` and
  `rows_not_shown`, and lists generic triggers (four or more modules) in
  `generic_triggers` with a module count, never with their modules.
- **R19.** C-I returns `line_count_estimate: { modules_stating_field,
  drift_count, drift_rate, worst (10, with both numbers and the factor),
  field_unmaintained }`. The flag is true when more than 50% of the compile's
  modules stating the field drift, decided only on at least 10 such modules
  (otherwise `null` with the reason).

## Section 10 (G2): entries without a file, grouped by source

`registration.manifest_entries_without_file_by_source` (skill_audit) and
`C-A.manifest_entries_without_file_by_source`: one row per source fragment with
`count`, `declares_no_path`, `registered_path_missing`,
`ids_resolving_elsewhere` and `orphan_ids` (ids with no file anywhere). The flat
list is kept.

**The choice on tools-fast-index.json.** The order asks for the file to be read
before deciding whether to add paths to it or mark it pathless by declaration.
The file is on the live volume and not in the supplied archive, so it was not
read; and both options edit references/manifest/, which section 12 rules out.
Neither was taken. The grouping makes the 60 entries one line, and a register
entry (R10) can accept them as one group until the decision is made.

## Files

| File | Change |
|---|---|
| `src/tools/module-files.js` | `moduleWriteGuard`, `modularPathsForAvaDir`, `idsByFile`, `quarantinedPathIndex`; log relocation and `log_path`; structured `registered_in`, `pathless_registrations`, `merge_inferred_path`; directory-walk `resolved_path`; R8 note; three refusal codes |
| `src/tools/skill-content.js` | `module_write` calls the guard first; `dry_run`, `acknowledge_resolved_path`; `write_guard` on every response; tool description |
| `src/tools/module-consistency.js` | R9 status builder, R10 tiers and register, R6/R7, R14 in C-C, R16, R17 to R19, G2 in C-A; tool description |
| `src/tools/skill.js` | G2 grouping, `ids_by_file`, `multi_id_files`, directory-walk candidates kept; tool description |
| `src/tools/skill-modular.js` | `handleModulesRestoreFromWp` skips quarantined paths and protected prefixes and reports them |
| `src/tools/module-file-tools.js` | descriptions only (R8, R11) |
| `src/tests/module-integrity-wo-2026-11-21-01.test.js` | new: 37 tests |
| `src/tests/module-files.test.js` | two assertions moved to the new contract (R13 directory-walk `resolved_path`; R11 log location) |
| `src/tests/reachability.test.js` | three AUDITED entries (`moduleWriteGuard`, `quarantinedPathIndex`, `idsByFile`) |
| `scripts/verify-module-files-mutations.mjs` | 31 new mutations; per-mutation test file |
| `package.json` | 13.39.0; `test:module-integrity` (CRLF kept) |

## Verification

- Full suite, per file, `node --test` one file per process, plus `npm test`:
  before (13.38.0 as supplied) 62 files, 1,284 tests, 1,283 executed, 1,218
  pass, 65 fail, 1 skipped; after 63 files, 1,324 tests, 1,323 executed, 1,258
  pass, 65 fail, 1 skipped. Executed +40: the new file (37) and reachability
  (11 to 14). Net-new failures: 0. The 65 baseline failures are the same tests in
  the same files (voice, bundle upload, self-model, memory), environmental in
  the build container, untouched by this change.
- Mutations: 68 of 68 red (`npm run module-files:mutations`), each control green
  first, including the two the order names: the resolver call removed from
  module_write (R2 test fails) and `clean` returned unconditionally from the
  status builder (the R9 tests fail).
- Section 9 rehearsed on fixtures shaped like meta-deflection-watch (three
  byte-identical paths, always_load, 60 lines) and meta-mirror-distance (two
  paths): all six steps pass for both, and a mirror push of the quarantined
  shadow during step 4 is skipped. This is a rehearsal, not the acceptance: the
  order runs section 9 against the live volume after deployment.

## Not built here, and why

- **Section 15 rulings.** The C-E ceiling is already a setting: set
  `SKILL_ALWAYS_LOAD_TOKEN_CEILING` to the measured figure once it is measured;
  the payload now says the ceiling is a policy figure. Dropping
  `line_count_estimate` means editing module frontmatter and manifest entries
  (section 12 rules out both); R19's `field_unmaintained` is the evidence for
  it. The nested tree is to be removed by hand; `module_write` already refuses
  double-nested paths and R16 reports any regrowth.
- **The live aggregate.** There is no live volume here. The order's figure is
  167,024 bytes, 41,756 estimated tokens, headroom -1,756 against 40,000; read
  `always_load_aggregate` after deployment for the measured number.
