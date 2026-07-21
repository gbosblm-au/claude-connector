# Claude Connector v12.21.0 - Structural Manifest Fragment Registration

## Problem

Module registration was discretionary. `module_write` wrote the module body
and ended with a note: "Remember to add an entry to MANIFEST.json." The
2026-07-21 travel-module failure is what that produces: a module on disk that
`skill_compile` cannot see, `skill_load_specialist` cannot load, and
`brain_scan` cannot draw, followed by rounds of manual archaeology,
`skill_write(target:"manifest_append")` overwrites (77 orphans in one July
incident), and manual `manifest_rebuild.py` runs.

MANIFEST_DIRECTORY_PROTOCOL.md already defined the fix (fragment files in
`references/manifest/`), but nothing enforced it and nothing consumed it live:
`compileSkill` merged only MANIFEST.json + MANIFEST_APPEND.json, and
`brain_scan.py` did the same.

## Changes

### New: src/tools/manifest-fragments.js

Shared fragment registry with a single merged view:
- `loadManifestFragments()` - reads `references/manifest/*.json` in filename
  order; bad or placeholder fragments degrade only themselves.
- `loadMergedManifest()` - MANIFEST.json -> MANIFEST_APPEND.json (byte-for-byte
  the previous inline compile semantics) -> fragments (new ids only,
  first-definition-wins; mandatory_for_triggers union; tag_web add-new).
- `inferModulePath()` - existence-checked path inference for fragment entries
  that omit `path` (the shipped 70-travel.json does; without this the module
  is registered but unloadable).
- `fragmentDispatchToLinkages()` - converts fragment dispatch_rules (object
  trigger_patterns) to the flat string-array shape `applyLearnedLinkages()`
  actually consumes; unconverted fragment rules silently never fire.
- `deriveModuleEntry()` / `writeModuleFragment()` - registration writer used
  by module_write; one fragment per category, upsert by module id, prefix
  auto-increment per the protocol.

### module_write (src/tools/skill-content.js)

Writing a `.md` module now AUTOMATICALLY creates/updates its manifest fragment
in the same tool call. New optional inputs: `manifest_entry` (override derived
metadata/triggers), `dispatch_rule` (register a routing rule alongside),
`skip_manifest` (body-only edit). The response carries the registration
outcome; a registration failure is loud, never silent, and never loses the
body write. Non-.md files are not registered (data, not dispatchable modules).

### skill_compile / skill_recompile / skill_load_specialist (src/tools/skill-modular.js)

All three now read the merged view, so a module registered by module_write is
selectable and loadable in the same session with NO manifest_rebuild.py run.
Fragment dispatch rules are active in-memory per compile; DISPATCH_RULES.json
on disk is not modified. skill_load_specialist reports a clear error for
registered-but-pathless modules instead of a raw file-not-found.

### brain_scan.py v2.1.0 (deploy/brain_scan.py - deploy to /data/skill/ava/scripts/)

`scan_manifests()` merges `references/manifest/*.json` fragments with the same
first-wins semantics, `_source_fragment` provenance, and existence-checked
path inference. The scan output gains a top-level `manifest_fragments` summary
(files read, modules added, skipped). Verified live against the 2026-07-21
volume backup: an un-rebuilt fragment module is cataloged with its inferred
path.

## Compatibility

- manifest_rebuild.py remains valid (fragments merged into MANIFEST_APPEND are
  simply skipped as already-registered — verified against the backup volume).
- No schema changes to MANIFEST.json / MANIFEST_APPEND.json / DISPATCH_RULES.json.
- No new dependencies. 13 new tests (tests/manifest-fragments.test.js); all 53
  existing + new connector tests pass.
