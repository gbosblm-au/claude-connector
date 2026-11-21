// ---------------------------------------------------------------------------
// src/tools/module-file-tools.js   (v13.38.0, WO-2026-11-20-03 rev 2, R1 to R3)
//
// The tool surface for removing a module file: module_delete (quarantine, or
// purge from quarantine), module_restore and module_file_events. The logic is
// in module-files.js; this file is the definitions, argument handling and the
// one-mutation-at-a-time lock.
//
// Same shape as module_write's overwrite guard, made stricter because a delete
// is more destructive than an overwrite: the first call is a dry run that
// returns the whole picture and changes nothing; the mutating call needs
// confirm: true AND the sha256 of the file the caller read.
// ---------------------------------------------------------------------------

import {
  quarantineModuleFile,
  restoreModuleFile,
  purgeQuarantinedFile,
  readModuleFileEvents,
  withModuleVolumeLock,
} from './module-files.js';

const asResult = (obj, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const moduleDeleteToolDefinition = {
  name: 'module_delete',
  description:
    'Remove a duplicate module file from the modules tree, safely. It does NOT unlink: it MOVES the file to '
    + 'quarantine/modules/<same path>, removes that file\'s own manifest fragment registration, records the event '
    + '(with the full content) and checks the compile still loads every registered and always_load module; '
    + 'module_restore reverses it. DRY RUN BY DEFAULT: the first call changes nothing and returns the resolved path '
    + 'for the module id, every sibling copy with its sha256 and first differing line, the registrations, whether the '
    + 'id is always_load, and what the move would do. To act: (1) read the file, (2) tell Brian which file, why, and '
    + 'which copy stays, (3) after his explicit confirmation call again with confirm: true, dry_run: false and '
    + 'expected_sha256 (the hash from the dry run). Refused, with the evidence used, when: the path is outside '
    + 'modules/ or is CORE.md, MANIFEST.json, DISPATCH_RULES.json, PERSONALITY.md or under references/manifest/ '
    + '(protected_path); the hash is missing or does not match the file now (hash_required, hash_mismatch); it is the '
    + 'copy the compile loads and nothing registered would replace it (live_copy_no_replacement); it is the last file '
    + 'for its id (last_file_for_id); other copies have DIFFERENT content and acknowledge_divergence does not name '
    + 'the sha256 of the copy that stays, with a reason (divergent_siblings); it would drop an always_load module '
    + '(always_load_floor); or its registration is in MANIFEST.json or MANIFEST_APPEND.json, which this tool may not '
    + 'edit (registered_in_frozen_manifest; reconciling such an id is an external, per-group decision and a '
    + 'dispatch-layer amendment, not a tooling operation, and the refusal says so). Name the file exactly as skill_audit lists it, starting "modules/" '
    + '(e.g. "modules/modules/philosophy/x.md" for a double-nested copy). PURGE (permanent) is a separate call: '
    + 'purge: true on a "quarantine/modules/..." path, with confirm and expected_sha256.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The file as skill_audit lists it, starting "modules/". For purge, the quarantine path ("quarantine/modules/...").' },
      confirm: { type: 'boolean', description: 'true only after Brian has explicitly confirmed this file. Default false.' },
      dry_run: { type: 'boolean', description: 'Default true unless confirm is true. A dry run never changes anything.' },
      expected_sha256: { type: 'string', description: 'The sha256 of the file you read (the dry run reports it). Refused if the file on disk differs.' },
      acknowledge_divergence: { type: 'string', description: 'When other copies have different content: the sha256 of the copy that STAYS.' },
      reason: { type: 'string', description: 'Why. Required with acknowledge_divergence; recorded on the event.' },
      purge: { type: 'boolean', description: 'Permanently unlink a file already in quarantine. Irreversible; its content stays in the event record.' },
    },
    required: ['file'],
  },
};

export const moduleRestoreToolDefinition = {
  name: 'module_restore',
  description:
    'Move a quarantined module file back to where it came from and re-add the manifest registration module_delete '
    + 'removed (unless that fragment now registers the id elsewhere, which is reported rather than overwritten). '
    + 'Refused if the original location is now occupied. Dry run by default: call again with confirm: true and '
    + 'dry_run: false to restore. Records the event.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The quarantine path, as module_delete reported it: "quarantine/modules/...".' },
      confirm: { type: 'boolean', description: 'true to restore. Default false.' },
      dry_run: { type: 'boolean', description: 'Default true unless confirm is true.' },
      expected_sha256: { type: 'string', description: 'Optional: refuse unless the quarantined file has this hash.' },
      reason: { type: 'string', description: 'Optional; recorded on the event.' },
    },
    required: ['file'],
  },
};

export const moduleFileEventsToolDefinition = {
  name: 'module_file_events',
  description:
    'Read the module file event log: every quarantine, restore and purge, with the module id, path, sha256, size, '
    + 'the copy retained, the reason and the time. Filter by id or path. The full content snapshot each event keeps is '
    + 'omitted unless include_snapshot is true. Read-only. Every call returns log_path, even when no log exists yet: '
    + 'the log lives at module-history/module_file_events.jsonl, outside quarantine/, so a purge of quarantine cannot '
    + 'take it. A log left at the old location (quarantine/module_file_events.jsonl) is read until the next write copies '
    + 'it forward and records a log_relocated event; the old file is kept.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Module id.' },
      path: { type: 'string', description: 'Original path ("modules/...") or quarantine path.' },
      limit: { type: 'integer', description: 'Most recent N events. Default 200.' },
      include_snapshot: { type: 'boolean', description: 'Include each event\'s content_snapshot. Default false.' },
    },
    required: [],
  },
};

/** module_delete: quarantine (default) or purge. */
export async function handleModuleDelete(args = {}, context = null) {
  const a = args || {};
  return withModuleVolumeLock(() => {
    const out = a.purge === true ? purgeQuarantinedFile(a, context) : quarantineModuleFile(a, context);
    const refused = !out.done && Array.isArray(out.refusals) && out.refusals.length > 0 && out.dry_run === false;
    return asResult({ tool: 'module_delete', mode: a.purge === true ? 'purge' : 'quarantine', ...out,
      ...(out.refusals && out.refusals.length ? { code: out.refusals[0].code } : {}) }, refused);
  });
}

/** module_restore. */
export async function handleModuleRestore(args = {}, context = null) {
  const a = args || {};
  return withModuleVolumeLock(() => {
    const out = restoreModuleFile(a, context);
    const refused = !out.done && Array.isArray(out.refusals) && out.refusals.length > 0 && out.dry_run === false;
    return asResult({ tool: 'module_restore', ...out, ...(out.refusals && out.refusals.length ? { code: out.refusals[0].code } : {}) }, refused);
  });
}

/** module_file_events. */
export function handleModuleFileEvents(args = {}) {
  const a = args || {};
  return asResult({ tool: 'module_file_events', ...readModuleFileEvents({
    id: typeof a.id === 'string' && a.id.trim() ? a.id.trim() : undefined,
    path: typeof a.path === 'string' && a.path.trim() ? a.path.trim() : undefined,
    limit: Number.isInteger(a.limit) ? a.limit : undefined,
    include_snapshot: a.include_snapshot === true,
  }) });
}
