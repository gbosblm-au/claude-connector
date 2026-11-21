# claude-connector v13.38.0

**Work order WO-2026-11-20-03 rev 2: module file deletion with confirmation
(Project 2), and a cross-module consistency audit (Project 1).**

Built on 13.37.0, the archive supplied with the order. Companion:
ts-gateway-service 2.366.0, which shows the four new tools in chat and
completes the audit's C-K check. Deploy order: this connector FIRST, then the
gateway. Each step is safe alone: a 2.365.0 gateway does not show the new
tools, and a 2.366.0 gateway against a 13.37.0 connector gets "unknown tool"
from the connector and shows the error.

**Version lineage warning.** Gateway runbooks refer to connector releases
13.38.0 to 13.43.0 (October) with features this 13.37.0 archive does not have
(for example a frame /v1/credential fetch and a tenant-mode /skill-export). If
the deployed connector is from that line, do not deploy this archive over it:
apply `WO-2026-11-20-03-connector.patch` (a unified diff against 13.37.0, in
the delivery) to the live tree instead, and give the result the next free
version number. Nothing in this change depends on those later features.

The dispatch layer is untouched: CORE.md, MANIFEST.json, DISPATCH_RULES.json
and references/manifest/ are not edited by the build, and no module content
changed. Nothing on a live volume is deleted by installing this release.

## The shared resolver (D3)

`resolveModulePath(moduleId)` in `src/tools/module-files.js` is the one
function that answers "which file is module X". `skill_compile`,
`skill_audit`, `skill_consistency_audit` and `module_delete` all call it.

- **Compile form** (`{ paths, manifest }`): the rule the compile has always
  used, now in one place. When an id is registered more than once the LAST
  entry in the merged manifest wins; the path is `avaDir + entry.path`. The
  compile output is byte-identical to 13.37.0 (checked with `cmp` over five
  queries on a fixture with duplicate MANIFEST ids and a path-less entry).
- **Evidence form** (`{ snapshot }`): the same answer plus how it was reached:
  `resolved_by` (`manifest`, `manifest_append`, `manifest_fragment`,
  `directory_walk` or `none`), `path_source` (`declared`, `inferred_fallback`
  or `none`), every candidate with its hash, size, line count and whether it
  exists, `ambiguous` when more than one existing file or registered path
  matches, and `loaders`: what `skill_compile` (last wins) and
  `skill_load_specialist` (first wins) would each load, with `disagree`.

`skill_load_specialist` is NOT moved onto the resolver: the order rules out
dispatch changes, and changing which copy a specialist load returns is one.
The disagreement is reported by C-C instead.

## skill_audit (R4, R5, D6, D10)

In modular mode `skill_audit` now also returns:

| Field | Meaning |
|---|---|
| `modules_by_id` | one row per id: `{ id, resolved_path, resolved_by, path_source, registered, loadable, ambiguous }`, with `candidates` for ambiguous or unresolved ids |
| `counts` | path entries, module files, markdown files, distinct contents, distinct ids, registered ids, ambiguous ids, each with its meaning stated |
| `registration` | both orphan lists: manifest entries with no file, and files with no entry |
| `floor` | `verified`, or `unverified` when no module file was read or the scan was truncated |

The flat `files_found` list is unchanged; `summary.files_found_counts` says it
counts path entries, not modules.

## skill_consistency_audit (Project 1, D7 to D10)

A new, read-only tool. Nothing it runs writes anything. It reports two
sections that are never added together (D9):

**Deterministic** (pass or fail): C-A filesystem and manifest bijection both
ways; C-B duplicate ids classified by hash (identical or divergent, with the
first differing line against the resolved copy); C-C resolution proof
(ambiguous, unloadable, or the two loaders disagree); C-D the three compile
inputs and references/manifest/ present exactly once, and any shadow copy;
C-F one id registered in more than one source.

**Advisory** (confidence, never a gate): C-E aggregate always-load size
(CORE.md plus every always_load module, tokens estimated at four bytes each,
against `SKILL_ALWAYS_LOAD_TOKEN_CEILING`, default 40,000, with headroom;
PERSONALITY.md and meta-self-check listed beside it); C-G provides against
body presence, self-calibrating on a ten-module sample each run (`not_run`
below ten modules that declare provides, `dropped` above a 20% fire rate);
C-H trigger collisions, with load_priority (a trigger claimed by four or more
modules is counted as generic, not listed); C-I line_count_estimate and
version drift.

**Judgment**: C-J reciprocal disagreement between two modules; C-K is left
for the gateway, which runs vault_provenance_audit over
`registered_module_ids` (gateway 2.366.0).

The floor comes first (D10): with no module read, or a truncated scan, the
status is `unverified` and every deterministic check's `pass` is `null`, not
`true`.

## module_delete, module_restore, module_file_events (Project 2, D1 to D6, R1 to R3, R6)

**Delete is quarantine (D1).** `module_delete` moves the file to
`<avaDir>/quarantine/modules/<original path>` (on the default volume,
`/data/skill/ava/quarantine/modules/...`). It is a dry run unless
`confirm: true` (R1); the dry run reports the hash to send back, the
siblings, what the compile would load afterwards, and every refusal that
would fire. Permanent removal is a separate call, `purge: true`, accepted only
for a path already under `quarantine/modules/`.

**Arguments**: `file` (as skill_audit lists it, starting `modules/`; a path
without the prefix is refused, not guessed), `confirm`, `dry_run`,
`expected_sha256` (D2, required), `acknowledge_divergence` (the sha256 of the
copy that stays), `reason`, `purge`.

**Refusals (D4), each failing closed with nothing moved:**

| Code | When |
|---|---|
| `outside_modules` | the path is not under `modules/` |
| `protected_path` | CORE.md, MANIFEST.json, DISPATCH_RULES.json or PERSONALITY.md by name anywhere, or anything under references/manifest/ |
| `hash_required`, `hash_mismatch` | no `expected_sha256`, or the file on disk differs |
| `live_copy_no_replacement` | the compile loads this file and nothing registered and loadable would replace it (computed from a simulated compile, so it covers every id the file serves) |
| `last_file_for_id` | no other file declares this id |
| `divergent_siblings` | other copies differ and `acknowledge_divergence` does not name one of them with a `reason`; the refusal lists every sibling with its hash and first differing line |
| `always_load_floor` | an always_load module would stop resolving |
| `registered_in_frozen_manifest` | added by this build: the file is registered in MANIFEST.json or MANIFEST_APPEND.json, so de-registering it would edit a frozen file |
| `quarantine_occupied`, `not_found` | the quarantine location is taken, or the file does not exist |
| `compile_check_failed` | R6: after the move the compile lost an id it had; everything is rolled back |
| `event_not_recorded` | D5: the event could not be written; no record, no move |

**De-registration is atomic with the move (D6).** A references/manifest/
fragment entry that points at the quarantined path is removed in the same
locked operation (temp file and rename). If any step fails, every earlier step
is undone.

**Every change is recorded (D5).** `quarantine/module_file_events.jsonl`, one
JSON line per event, appended with fsync, never rewritten: `event_id, id,
path, action (quarantined, restored, purged), sha256, size_bytes,
content_snapshot, retained_path, reason, at`, plus the fragment text removed
so a restore can put it back exactly. The connector has no database; the
order allows "a table or an append-only store".

**module_restore (R2)** moves a quarantined file back, refusing if the
original location is occupied, and puts its registration back: the exact
earlier fragment text when the fragment is unchanged since, otherwise the
entry spliced in at its old index. A quarantine followed by a restore leaves
the volume byte-identical except for the event log.

**module_file_events (R3)** lists events, filtered by `id` or `path`, most
recent `limit` (default 200). Snapshots are left out unless
`include_snapshot: true`; their size is reported instead.

**R6.** Every quarantine, restore and purge reports the compile before and
after: registered ids, loadable ids, broken ids and each always_load module.

All three tools run under one lock per volume, and `module_delete` and
`module_restore` are added to `SYSTEM_WRITE_TOOLS`, so tenant MCP sessions do
not list them.

## Files

| File | Change |
|---|---|
| `src/tools/module-files.js` | new: the resolver, snapshot, refusals, quarantine, restore, purge, event store |
| `src/tools/module-consistency.js` | new: skill_consistency_audit |
| `src/tools/module-file-tools.js` | new: the three tool definitions and handlers |
| `src/tools/skill-modular.js` | the compile's module and self-check lookups call `resolveModulePath` |
| `src/tools/skill.js` | skill_audit's grouped audit |
| `src/tools/manifest-fragments.js` | `loadMergedManifest` accepts optional `{ fragments, exists, quiet }` for simulation; `parseModuleFrontmatter` is exported and reads `version`. With no options every caller gets the previous behaviour |
| `src/server-http.js` | registration of the four tools at every list site, dispatch, SYSTEM_WRITE_TOOLS |
| `src/tests/module-files.test.js` | new: 38 tests |
| `src/tests/reachability.test.js` | three AUDITED entries |
| `scripts/verify-module-files-mutations.mjs` | new: 37 mutations, every one red |
| `package.json` | 13.38.0; `test:module-files`, `module-files:mutations` (CRLF kept) |

## Measured, and not measured here

- **C-E on the live volume is not measured**: there is no live volume in the
  build environment. Run `skill_consistency_audit` with `checks: ["C-E"]`
  and read `aggregate_estimated_tokens` and `headroom_tokens`. On the ten
  bundled self-model modules (none always_load) the figure is 0.
- **C-G could not be calibrated here**: none of the ten bundled modules
  declares `provides`, so it reports `not_run`. It calibrates itself on the
  live volume each run.
- Calibration fire rates on the bundled sample: C-H 7 of 10 modules (six real
  family overlaps: socratic, maieutic, seam question, nudge, silence,
  curiosities); C-I 0 of 10; C-J 0 of 10.

## Known, queued

- The WordPress module mirror is not told about quarantines; a WP "Push All"
  could re-create a quarantined file.
- `module_write` can still create a second copy of an id at a new path.
- `skill_load_specialist` is first-wins while the compile is last-wins (C-C
  reports it).
- `skill_recompile` reads MANIFEST.json only.
- Tenant-mode volume layout (`/data/clients/{tenant}/`) is supported by the
  path helpers but was tested on the default layout only.
