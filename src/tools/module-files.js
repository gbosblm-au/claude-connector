// ---------------------------------------------------------------------------
// src/tools/module-files.js   (v13.38.0, WO-2026-11-20-03 rev 2)
//
// One answer to "which file IS module X", and the guarded quarantine that is
// the only way this connector removes a module file.
//
// WHY ONE RESOLVER (decision D3)
// ------------------------------
// The modules tree carries several copies of some ids, some of them different
// documents. Before this file nothing could say which copy a module id is:
// skill_compile resolved an id one way (the merged manifest, last entry wins,
// avaDir + path), skill_load_specialist another (first entry wins), and
// skill_audit did not resolve ids at all, it listed paths. A delete tool that
// checked "is this the live copy" with a fourth implementation would be a
// fourth answer to the same question, and disagreeing answers are how the
// duplicates arose.
//
// So resolveModulePath(moduleId) is the single implementation, used by
// skill_compile (for the file it loads), skill_audit, skill_consistency_audit
// and module_delete. It follows the compile EXACTLY, because the compile is
// what decides what Ava reads: the merged manifest (MANIFEST.json, then
// MANIFEST_APPEND.json, then references/manifest/ fragments, through
// manifest-fragments.js loadMergedManifest), the LAST entry carrying the id,
// and avaDir + entry.path. It returns the evidence with the path: which source
// registered the winning entry, whether its path was declared or inferred, and
// every other candidate (registration or file) for the same id.
//
// WHY QUARANTINE (decision D1)
// ----------------------------
// No tool on this surface deleted anything before. A confirmation prompt on an
// irreversible operation converts a mistake into a deliberate mistake, so a
// delete MOVES the file to {avaDir}quarantine/modules/<original path> and
// records it; module_restore moves it back. Purge (unlink) is a second,
// separate call, accepted only for a file already in quarantine.
//
// WHAT THIS FILE NEVER WRITES
// ---------------------------
// CORE.md, MANIFEST.json, MANIFEST_APPEND.json, DISPATCH_RULES.json and
// PERSONALITY.md are never written. A references/manifest/ fragment is
// rewritten only to remove (on quarantine) or re-add (on restore) the
// registration of the one file being moved, which is decision D6; module_write
// already writes the same fragments when it registers a module. A file
// registered in MANIFEST.json or MANIFEST_APPEND.json cannot be de-registered
// without editing a frozen file, so its quarantine is REFUSED
// (registered_in_frozen_manifest) rather than left registered and missing.
//
// v13.39.0 (WO-2026-11-21-01)
// ---------------------------
//   R1-R5  moduleWriteGuard(): module_write asks this resolver for the id it is
//          about to write BEFORE any file operation, and refuses a second path
//          for an id that already resolves (duplicate_id_path) or a path that
//          already holds another id (path_holds_other_id). A genuinely new id
//          passes untouched.
//   R11    The event log lives OUTSIDE quarantine/ (module-history/), so a purge
//          of quarantine cannot take the record of what it purged. A log found
//          at the old location is copied forward on the first write and that
//          relocation is itself the first new event.
//   R12    registered_in carries structured, DECLARED registrations only. A
//          path-less registration is reported as { source, id, path: null,
//          declared_path: false } and never attached to an inferred path.
//   R13    A single-file directory-walk resolution populates resolved_path,
//          with resolved_by 'directory_walk' kept so the weaker evidence shows.
//   R14    idsByFile(): the inverse index, and multi_id_file.
//   R15    quarantinedPathIndex(): what the WordPress mirror must not restore.
//   R8     registered_in_frozen_manifest names reconciliation as external.
// ---------------------------------------------------------------------------

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { log } from '../utils/logger.js';
import { resolveContained } from '../utils/pathContainment.js';
import { getModularPaths } from './skill-modular.js';
import {
  loadMergedManifest,
  loadManifestFragments,
  fragmentsDirFor,
  inferModulePath,
  parseModuleFrontmatter,
} from './manifest-fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File names that are never quarantined, wherever they sit (D4 refusal 1). */
export const PROTECTED_BASENAMES = Object.freeze(['CORE.md', 'MANIFEST.json', 'DISPATCH_RULES.json', 'PERSONALITY.md']);

/** Refusal codes, in the order D4 enumerates them, then the ones this build adds. */
export const REFUSAL = Object.freeze({
  OUTSIDE_MODULES:        'outside_modules',             // D4.1
  PROTECTED_PATH:         'protected_path',              // D4.1
  HASH_REQUIRED:          'hash_required',               // D4.2
  HASH_MISMATCH:          'hash_mismatch',               // D4.2
  LIVE_COPY:              'live_copy_no_replacement',    // D4.3
  LAST_FILE:              'last_file_for_id',            // D4.4
  DIVERGENT:              'divergent_siblings',          // D4.5
  ALWAYS_LOAD:            'always_load_floor',           // D4.6
  FROZEN_REGISTRATION:    'registered_in_frozen_manifest', // fail closed: de-registration would edit a frozen file
  NOT_FOUND:              'not_found',
  QUARANTINE_OCCUPIED:    'quarantine_occupied',
  NOT_IN_QUARANTINE:      'not_in_quarantine',
  RESTORE_OCCUPIED:       'restore_target_occupied',
  COMPILE_CHECK_FAILED:   'compile_check_failed',        // R6, after the move: rolled back
  EVENT_NOT_RECORDED:     'event_not_recorded',          // D5: no record, no move
  // v13.39.0 (WO-2026-11-21-01): module_write refusals.
  DUPLICATE_ID_PATH:      'duplicate_id_path',           // R2: a second file for an id that already resolves
  PATH_HOLDS_OTHER_ID:    'path_holds_other_id',         // R3: force must not turn one id into another
  WRITE_GUARD_UNVERIFIED: 'write_guard_unverified',      // R1: the resolver could not give a complete answer; fail closed
});

/**
 * R8 / D11: what a frozen-manifest refusal says about the route forward. A later
 * session must not read the refusal as an unfinished feature and build around it.
 */
export const FROZEN_RECONCILIATION_NOTE = 'Divergent module reconciliation for this id is an external decision, not a tooling operation (D11). '
  + 'Choosing which text is the module is a per-group human decision, and the registration change that follows it is a '
  + 'dispatch-layer amendment to MANIFEST.json or MANIFEST_APPEND.json made one id at a time outside this tooling. '
  + 'This refusal is the intended, complete behaviour; it is not a missing feature.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** SHA-256 of raw bytes, hex. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Line count with the same rule skill_audit has always used. */
function lineCountOf(text) {
  return String(text).split('\n').length;
}

/**
 * R11: the event log's home, relative to avaDir. It is deliberately NOT under
 * quarantine/: purge removes files from quarantine, and the record of a purge
 * must not be removable by the operation it records. It is not under modules/
 * either (the scan would read it), and skill-export does not export .jsonl.
 */
export const EVENT_LOG_REL = 'module-history/module_file_events.jsonl';
/** Where v13.38.0 wrote the log: inside quarantine/. Read and copied forward, never written. */
export const LEGACY_EVENT_LOG_REL = 'quarantine/module_file_events.jsonl';

/** The modules/, quarantine and event-log locations for the active avaDir. */
export function moduleFilePaths(paths = getModularPaths()) {
  return {
    ...paths,
    modulesRoot:      join(paths.avaDir, 'modules'),
    quarantineRoot:   join(paths.avaDir, 'quarantine', 'modules'),
    eventsFile:       join(paths.avaDir, ...EVENT_LOG_REL.split('/')),
    legacyEventsFile: join(paths.avaDir, ...LEGACY_EVENT_LOG_REL.split('/')),
  };
}

/**
 * The modular path set for a given avaDir. module_write writes under
 * getContentPaths().avaDir, which in tenant mode is the OWNER tree rather than
 * getModularPaths().avaDir; its guard must resolve against the tree it writes to.
 */
export function modularPathsForAvaDir(avaDir, base = getModularPaths()) {
  const dir = avaDir.endsWith('/') ? avaDir : `${avaDir}/`;
  if (dir === base.avaDir) return base;
  return {
    ...base,
    avaDir: dir,
    coreFile: `${dir}CORE.md`,
    personalityFile: `${dir}PERSONALITY.md`,
    manifestFile: `${dir}MANIFEST.json`,
    manifestAppendFile: `${dir}MANIFEST_APPEND.json`,
    dispatchRulesFile: `${dir}DISPATCH_RULES.json`,
    modulesDir: `${dir}modules/`,
    archiveDir: `${dir}archive/`,
  };
}

/** A fresh JSON reader: audits and the delete path must not see a cached view. */
function readJsonFresh(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Maximum files the scan walks (the same variable module_resolve's index honours). */
function scanLimit() {
  const raw = parseInt(process.env.MODULE_INDEX_MAX_FILES || '5000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * The module id a FILE declares: its frontmatter id, else its basename without
 * the extension. This is the rule module_write's deriveModuleEntry uses to
 * register a file, so a file and its own registration agree by construction.
 */
export function fileModuleId(relPath, content) {
  const fm = /\.md$/i.test(relPath) ? parseModuleFrontmatter(content) : {};
  return { id: fm.id || basename(relPath).replace(/\.(md|json)$/i, ''), frontmatter: fm };
}

/** The first line at which two texts differ, 1-based, with both lines. */
export function firstDifferingLine(a, b) {
  const la = String(a).split('\n');
  const lb = String(b).split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, this_copy: la[i] === undefined ? null : la[i].slice(0, 200), other_copy: lb[i] === undefined ? null : lb[i].slice(0, 200) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The snapshot: everything the resolver, the audits and the delete read, once
// ---------------------------------------------------------------------------

/**
 * Walk {avaDir}modules/ (symlinks are not followed) and read every file.
 *
 * @returns {{ files: object[], truncated: boolean, unreadable: string[] }}
 */
export function scanModuleFiles(paths) {
  const mp = moduleFilePaths(paths);
  const files = [];
  const unreadable = [];
  const limit = scanLimit();
  let truncated = false;

  function walk(dir, rel) {
    if (truncated) return;
    let names;
    try { names = readdirSync(dir).sort(); } catch (err) { unreadable.push(`${rel || 'modules'}: ${err.message}`); return; }
    for (const name of names) {
      if (truncated) return;
      const full = join(dir, name);
      const relPath = `${rel}/${name}`;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(full, relPath); continue; }
      if (!st.isFile()) continue;
      if (files.length >= limit) { truncated = true; return; }
      let bytes;
      try { bytes = readFileSync(full); } catch (err) { unreadable.push(`${relPath}: ${err.message}`); continue; }
      const text = bytes.toString('utf8');
      const isMd = /\.md$/i.test(name);
      const { id, frontmatter } = fileModuleId(relPath, text);
      files.push({
        path: relPath,                 // avaDir-relative, as manifest paths and skill_audit labels are
        full,
        kind: isMd ? 'module' : (/\.json$/i.test(name) ? 'data' : 'other'),
        id,
        frontmatter,
        size_bytes: st.size,
        lines: lineCountOf(text),
        sha256: sha256Hex(bytes),
        mtime: st.mtime.toISOString(),
        text,
      });
    }
  }

  if (existsSync(mp.modulesRoot)) walk(mp.modulesRoot, 'modules');
  return { files, truncated, unreadable };
}

/**
 * Every registration of every module, from every source, including the ones
 * the merge shadows (a fragment entry for an id MANIFEST.json already has).
 *
 * @returns {object[]} { id, path, declared_path, source, kind, always_load, load_priority, entry }
 */
export function readRegistrations(paths) {
  const out = [];
  const push = (entry, source, kind) => {
    if (!entry || typeof entry !== 'object' || !entry.id) return;
    out.push({
      id: String(entry.id),
      path: entry.path || null,
      declared_path: Boolean(entry.path),
      source,
      kind,
      always_load: entry.always_load === true,
      load_priority: entry.load_priority,
      entry,
    });
  };
  const manifest = readJsonFresh(paths.manifestFile, { modules: [] });
  for (const m of (manifest && Array.isArray(manifest.modules) ? manifest.modules : [])) push(m, 'MANIFEST.json', 'manifest');
  const append = readJsonFresh(paths.manifestAppendFile, null);
  for (const m of (append && Array.isArray(append.modules) ? append.modules : [])) push(m, 'MANIFEST_APPEND.json', 'manifest_append');
  const { fragments, skipped } = loadManifestFragments(paths.avaDir);
  for (const frag of fragments) {
    for (const m of frag.modules) push(m, `references/manifest/${frag.file}`, 'manifest_fragment');
  }
  out.fragmentsSkipped = skipped;
  out.fragments = fragments;
  return out;
}

/**
 * Read the volume once: files, registrations and the merged manifest the
 * compile would build from them.
 *
 * @param {object} [paths]  getModularPaths() by default.
 * @param {object} [options]  { fragments, exists } to build a SIMULATED snapshot.
 */
export function buildModuleSnapshot(paths = getModularPaths(), options = {}) {
  const scan = options.scan || scanModuleFiles(paths);
  const registrations = options.registrations || readRegistrations(paths);
  const merged = loadMergedManifest(paths, readJsonFresh, {
    quiet: true,
    ...(options.fragments ? { fragments: options.fragments } : {}),
    ...(options.exists ? { exists: options.exists } : {}),
  });
  const manifestCount = (readJsonFresh(paths.manifestFile, { modules: [] }).modules || []).length;
  return { paths, scan, registrations, merged, manifestCount, exists: options.exists || existsSync };
}

// ---------------------------------------------------------------------------
// resolveModulePath: THE resolver (D3, R4)
// ---------------------------------------------------------------------------

/** id -> [index of last entry, entry] for one merged manifest, built once. */
const lastEntryIndex = new WeakMap();
function lastEntryFor(manifest, moduleId) {
  let idx = lastEntryIndex.get(manifest);
  if (!idx) {
    idx = new Map();
    const list = (manifest && manifest.modules) || [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m && m.id !== undefined) idx.set(m.id, [i, m]);
    }
    lastEntryIndex.set(manifest, idx);
  }
  return idx.get(moduleId) || null;
}

/**
 * Which file module `moduleId` is, and how that was decided.
 *
 * Two forms, one rule:
 *
 *   resolveModulePath(id, { paths, manifest })
 *     The compile's form: `manifest` is the merged manifest the compile
 *     already holds. No directory walk, no hashing. Returns
 *     { id, resolved_path, resolved_path_absolute, resolved_by, entry } for
 *     the LAST merged entry carrying the id (the compile's moduleMap rule):
 *     resolved_path is entry.path (avaDir-relative), resolved_path_absolute
 *     is avaDir + entry.path, both null when the entry has no path. Existence
 *     is not checked here: the compile checks it, as it always has.
 *
 *   resolveModulePath(id, { snapshot })   or   resolveModulePath(id)
 *     The evidence form (skill_audit, skill_consistency_audit, module_delete):
 *     adds resolved_by, path_source, every candidate with its registrations
 *     and hash, whether more than one candidate matched, and the path
 *     skill_load_specialist would load (it takes the FIRST entry), so a
 *     disagreement between the two loaders is reported rather than hidden.
 *
 * @param {string} moduleId
 * @param {object} [ctx]
 * @returns {object}
 */
export function resolveModulePath(moduleId, ctx = {}) {
  const id = String(moduleId || '');
  if (ctx.manifest && !ctx.snapshot) {
    const paths = ctx.paths || getModularPaths();
    const hit = lastEntryFor(ctx.manifest, id);
    const entry = hit ? hit[1] : null;
    return {
      id,
      resolved_path: entry && entry.path ? entry.path : null,
      resolved_path_absolute: entry && entry.path ? paths.avaDir + entry.path : null,
      resolved_by: entry ? (entry._source_fragment ? 'manifest_fragment' : 'manifest') : 'unregistered',
      entry,
    };
  }

  const snap = ctx.snapshot || buildModuleSnapshot(ctx.paths || getModularPaths());
  const { paths, merged, registrations, scan, manifestCount } = snap;
  const exists = snap.exists || existsSync;
  const list = merged.manifest.modules || [];
  const hit = lastEntryFor(merged.manifest, id);
  const winner = hit ? hit[1] : null;
  const winnerIndex = hit ? hit[0] : -1;
  const firstIndex = list.findIndex((m) => m && m.id === id);
  const first = firstIndex >= 0 ? list[firstIndex] : null;

  const sourceOf = (entry, index) => {
    if (!entry) return null;
    if (entry._source_fragment) return `references/manifest/${entry._source_fragment}`;
    return index < manifestCount ? 'MANIFEST.json' : 'MANIFEST_APPEND.json';
  };
  const kindOf = (source) => (!source ? null
    : source === 'MANIFEST.json' ? 'manifest'
      : source === 'MANIFEST_APPEND.json' ? 'manifest_append' : 'manifest_fragment');

  const resolvedRel = winner && winner.path ? winner.path : null;
  const resolvedAbs = resolvedRel ? paths.avaDir + resolvedRel : null;
  const winnerSource = sourceOf(winner, winnerIndex);
  const inferred = Boolean(winner && resolvedRel && winner._source_fragment
    && !registrations.some((r) => r.source === winnerSource && r.id === id && r.declared_path));

  // Every candidate path for the id: each registration's path, and each file
  // that declares the id.
  const byPath = new Map();
  const cand = (path) => {
    if (!byPath.has(path)) {
      const f = scan.files.find((x) => x.path === path);
      byPath.set(path, {
        path,
        exists: f ? exists(f.full) : (path ? exists(paths.avaDir + path) : false),
        sha256: f ? f.sha256 : null,
        size_bytes: f ? f.size_bytes : null,
        lines: f ? f.lines : null,
        file_declares_id: f ? f.id === id : false,
        registered_in: [],
        is_resolved: path === resolvedRel,
      });
    }
    return byPath.get(path);
  };
  // R12: only a DECLARED registration is attached to a path. A registration
  // that declares no path is reported as what it is (the source and the id,
  // path null) and is never presented as registering the file the merge would
  // infer: an inference is not a registration, and registered_in is the field
  // a delete call reads.
  const pathless = [];
  for (const r of registrations) {
    if (r.id !== id) continue;
    if (r.declared_path) {
      cand(r.path).registered_in.push({ source: r.source, id: r.id, path: r.path, declared_path: true });
    } else {
      pathless.push({ source: r.source, id: r.id, path: null, declared_path: false });
    }
  }
  for (const f of scan.files) if (f.id === id && f.kind === 'module') cand(f.path);
  if (resolvedRel) cand(resolvedRel);

  const candidates = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const existing = candidates.filter((c) => c.exists);
  const registeredPaths = new Set(candidates.filter((c) => c.registered_in.length).map((c) => c.path));
  const specialistPath = first && first.path ? first.path : null;
  const loadable = Boolean(resolvedRel && exists(resolvedAbs));

  // R13: an id no manifest registers, found as exactly one existing file by the
  // directory walk, resolves to that file. resolved_by stays 'directory_walk'
  // and loadable stays false (the compile reads the manifest, so it cannot load
  // it), which keeps the weaker evidence visible. Two or more files with no
  // registration is ambiguous and resolves to nothing.
  const walkPath = !winner && existing.length === 1 ? existing[0].path : null;
  let resolvedPath = loadable ? resolvedRel : null;
  let resolvedPathAbs = loadable ? resolvedAbs : null;
  if (walkPath) {
    resolvedPath = walkPath;
    resolvedPathAbs = paths.avaDir + walkPath;
    byPath.get(walkPath).is_resolved = true;
  }

  return {
    id,
    resolved_path: resolvedPath,
    resolved_path_absolute: resolvedPathAbs,
    registered_path: resolvedRel,
    resolved_by: winner ? kindOf(winnerSource) : (existing.length ? 'directory_walk' : 'none'),
    resolved_from: winnerSource,
    path_source: !winner ? null : (!resolvedRel ? 'none' : (inferred ? 'inferred_fallback' : 'declared')),
    registered: Boolean(winner),
    loadable,
    always_load: Boolean(winner && winner.always_load === true),
    pathless_registrations: pathless,
    // The path the merge fills in for a path-less winning entry: what the
    // compile loads, labelled as the inference it is (path_source says so too).
    merge_inferred_path: inferred ? resolvedRel : null,
    candidates,
    candidate_count: candidates.length,
    existing_file_count: existing.length,
    ambiguous: existing.length > 1 || registeredPaths.size > 1,
    loaders: {
      skill_compile: resolvedRel,
      skill_load_specialist: specialistPath,
      disagree: Boolean(winner && specialistPath !== resolvedRel),
    },
  };
}

/** Every module id the volume knows: registered, or declared by a .md file. */
export function moduleIdsIn(snapshot) {
  const ids = new Set();
  for (const m of snapshot.merged.manifest.modules || []) if (m && m.id) ids.add(String(m.id));
  for (const f of snapshot.scan.files) if (f.kind === 'module') ids.add(f.id);
  return [...ids].sort();
}

/** Every module id resolved with its evidence (R4). */
export function resolveAllModules(snapshot) {
  return moduleIdsIn(snapshot).map((id) => resolveModulePath(id, { snapshot }));
}

/**
 * R14: the inverse index. For each existing module file, every id that claims
 * it: the id the file declares (frontmatter, else file name), any id whose
 * DECLARED registration names it, and any id that resolves to it (including a
 * merge-inferred path, which is what the compile loads). A file claimed by more
 * than one id is a multi_id_file: each id may have exactly one candidate, so
 * neither reads as ambiguous, and only this direction can see it. It needs R13,
 * because the file-name id of an unregistered file only resolves to the file
 * once a directory-walk resolution carries resolved_path.
 *
 * @param {object[]} resolutions  resolveAllModules(snapshot)
 * @returns {{ ids_by_file: object[], multi_id_files: object[] }}
 */
export function idsByFile(resolutions) {
  const byFile = new Map();
  const claim = (path, id, how) => {
    if (!byFile.has(path)) byFile.set(path, new Map());
    const ids = byFile.get(path);
    if (!ids.has(id)) ids.set(id, new Set());
    ids.get(id).add(how);
  };
  for (const r of resolutions) {
    for (const c of r.candidates) {
      if (!c.exists) continue;
      if (c.file_declares_id) claim(c.path, r.id, 'file_declares_id');
      if (c.registered_in.length) claim(c.path, r.id, 'declared_registration');
      if (c.path === r.resolved_path) claim(c.path, r.id, r.resolved_by === 'directory_walk' ? 'directory_walk' : 'resolves_here');
    }
  }
  const rows = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, ids]) => ({
    path,
    ids: [...ids.keys()].sort(),
    claims: [...ids.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, how]) => ({ id, how: [...how].sort() })),
    multi_id_file: ids.size > 1,
  }));
  return { ids_by_file: rows, multi_id_files: rows.filter((r) => r.multi_id_file) };
}

// ---------------------------------------------------------------------------
// R1-R5 (WO-2026-11-21-01): the write-time guard against minting duplicates
// ---------------------------------------------------------------------------

/** "modules/x/y.md" for either spelling a caller may use ("x/y.md" or "modules/x/y.md"); one prefix only. */
function asModulesRel(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return s.startsWith('modules/') ? s : `modules/${s}`;
}

/** The id a module body declares, else its file name; never throws (R1: not conditional on parsing). */
function incomingFileId(relPath, content) {
  try {
    return fileModuleId(relPath, content).id;
  } catch {
    // The manifest derivation's own filename rule (deriveModuleEntry).
    return basename(relPath).replace(/\.(md|json)$/i, '');
  }
}

/**
 * Decide whether module_write may create or overwrite `requestedRel`, BEFORE
 * any file operation and before the overwrite guard. Pure: reads only.
 *
 *   R1  the shared resolver is asked about every id the write will carry: the
 *       id the content declares (frontmatter, else the file name, exactly as
 *       deriveModuleEntry derives it) and, when the caller supplies one, the
 *       manifest_entry id module_write will register.
 *   R2  an id that already resolves (or is registered, or exists as files) at
 *       another path is refused: duplicate_id_path, naming the resolved path.
 *       acknowledge_resolved_path equal to that path redirects the write to it.
 *   R3  a path that already holds a file of another id is refused:
 *       path_holds_other_id. force cannot change this.
 *   R4  an id that exists nowhere passes with no refusal.
 *
 * @param {object} a
 * @param {string} a.requestedRel   "modules/<...>.md", as module_write normalised it.
 * @param {string} a.content        The body to be written.
 * @param {string} [a.manifestEntryId]   manifest_entry.id, when supplied.
 * @param {string} [a.acknowledgeResolvedPath]
 * @param {object} [a.paths]        The modular paths of the tree being written.
 * @returns {object} { applies, verdict, ids, target_rel, redirected, refusals, resolutions }
 */
export function moduleWriteGuard({ requestedRel, content, manifestEntryId = null, acknowledgeResolvedPath = null, paths = getModularPaths() }) {
  const requested = asModulesRel(requestedRel);
  if (!/\.md$/i.test(requested)) {
    return { applies: false, verdict: 'not_a_module', ids: [], target_rel: requested, redirected: false, refusals: [], resolutions: [],
      note: 'A .json file under modules/ is data: module_write does not register it as a module id, so there is no id to resolve.' };
  }
  const fileId = incomingFileId(requested, content);
  const ids = [...new Set([typeof manifestEntryId === 'string' && manifestEntryId.trim() ? manifestEntryId.trim() : null, fileId].filter(Boolean))];

  let snapshot;
  try {
    snapshot = buildModuleSnapshot(paths);
  } catch (err) {
    return { applies: true, verdict: 'refused', ids, target_rel: requested, redirected: false, resolutions: [],
      refusals: [{ code: REFUSAL.WRITE_GUARD_UNVERIFIED, message: `The resolver could not read the module tree (${err.message}), so a duplicate cannot be ruled out. Nothing was written.` }] };
  }
  if (snapshot.scan.truncated) {
    return { applies: true, verdict: 'refused', ids, target_rel: requested, redirected: false, resolutions: [],
      refusals: [{ code: REFUSAL.WRITE_GUARD_UNVERIFIED, message: 'The module scan stopped at MODULE_INDEX_MAX_FILES, so an existing copy of this id may be unseen. Raise MODULE_INDEX_MAX_FILES; nothing was written.' }] };
  }

  const resolutions = ids.map((id) => resolveModulePath(id, { snapshot }));
  const ack = acknowledgeResolvedPath ? asModulesRel(acknowledgeResolvedPath) : null;
  const duplicate = [];
  for (const r of resolutions) {
    // Where the id lives now: the file the resolver returns, else the path its
    // registration names (registered but missing is still where the compile
    // looks), else, with no registration, the existing files that declare it.
    const target = r.resolved_path || r.registered_path || null;
    const occupied = r.candidates.filter((c) => c.exists).map((c) => c.path);
    const conflict = target ? requested !== target : (occupied.length > 0 && !occupied.includes(requested));
    if (!conflict) continue;
    duplicate.push({
      code: REFUSAL.DUPLICATE_ID_PATH,
      message: target
        ? `Module ${r.id} already resolves to ${target} (resolved_by ${r.resolved_by}). Writing ${requested} would create a second file for it, and a path label does not say which file the compile loads. Nothing was written.`
        : `Module ${r.id} already exists as ${occupied.join(', ')} with no registration choosing between them. Writing ${requested} would add another copy. Nothing was written.`,
      id: r.id,
      resolved_path: target,
      resolved_by: r.resolved_by,
      resolves_to_existing_file: Boolean(r.resolved_path),
      requested_path: requested,
      candidates: r.candidates.map((c) => ({ path: c.path, exists: c.exists, sha256: c.sha256, size_bytes: c.size_bytes, lines: c.lines,
        registered_in: c.registered_in, is_resolved: c.is_resolved })),
      routes: [
        ...(target ? [{ route: 'acknowledge_resolved_path', value: target,
          how: `Call module_write again with acknowledge_resolved_path: "${target}". The write then goes to that file; the overwrite guard still applies, so an existing file needs force: true.` }] : []),
        { route: 'quarantine_existing', tool: 'module_delete', file: target || occupied[0],
          how: 'Quarantine the existing file first (module_delete, dry run first), then write the new path.' },
      ],
    });
  }

  // acknowledge_resolved_path: redirect only when every duplicate refusal names
  // the same resolved path and the acknowledgement is that path exactly.
  let targetRel = requested;
  let redirected = false;
  const refusals = [];
  if (duplicate.length) {
    const targets = [...new Set(duplicate.map((d) => d.resolved_path))];
    const canRedirect = ack && targets.length === 1 && targets[0] && ack === targets[0] && targets[0].startsWith('modules/');
    if (canRedirect) {
      targetRel = targets[0];
      redirected = true;
    } else {
      for (const d of duplicate) {
        refusals.push(ack ? { ...d, acknowledge_resolved_path_rejected: ack,
          acknowledge_rule: 'acknowledge_resolved_path must equal resolved_path exactly, every id must resolve to that one path, and the path must be under modules/.' } : d);
      }
    }
  }

  // R3: the path (after any redirect) holds a file of a different id.
  const existing = snapshot.scan.files.find((f) => f.path === targetRel);
  let existingId = existing ? existing.id : null;
  if (!existing && existsSync(paths.avaDir + targetRel)) {
    try { existingId = incomingFileId(targetRel, readFileSync(paths.avaDir + targetRel, 'utf8')); } catch { existingId = null; }
  }
  if (existingId !== null) {
    const other = ids.find((id) => id !== existingId);
    if (other !== undefined) {
      refusals.push({
        code: REFUSAL.PATH_HOLDS_OTHER_ID,
        message: `${targetRel} already holds module ${existingId}; writing ${other} there would turn one module into another. force does not override this. Nothing was written.`,
        path: targetRel,
        existing_id: existingId,
        incoming_id: other,
      });
    }
  }

  const verdict = refusals.length ? 'refused'
    : redirected ? 'redirected_to_resolved'
      : resolutions.every((r) => !r.registered && !r.candidates.some((c) => c.exists)) ? 'new_id' : 'resolved_here';
  return {
    applies: true,
    verdict,
    ids,
    requested_rel: requested,
    target_rel: targetRel,
    redirected,
    refusals,
    resolutions: resolutions.map((r) => ({ id: r.id, resolved_path: r.resolved_path, registered_path: r.registered_path, resolved_by: r.resolved_by,
      candidate_count: r.candidate_count, ambiguous: r.ambiguous })),
  };
}

// ---------------------------------------------------------------------------
// R6: is the compile intact?
// ---------------------------------------------------------------------------

/**
 * What the compile can load: every registered id, and whether it resolves to
 * an existing file; the always_load ids among them.
 */
export function compileIntegrity(snapshot) {
  const { paths, merged } = snapshot;
  const exists = snapshot.exists || existsSync;
  const ids = [...new Set((merged.manifest.modules || []).filter((m) => m && m.id).map((m) => String(m.id)))];
  const broken = [];
  const loadable = [];
  const alwaysLoad = [];
  for (const id of ids) {
    const r = resolveModulePath(id, { manifest: merged.manifest, paths });
    const ok = Boolean(r.resolved_path_absolute && exists(r.resolved_path_absolute));
    if (ok) loadable.push(id); else broken.push(id);
    if (r.entry && r.entry.always_load === true) alwaysLoad.push({ id, resolves: ok, path: r.entry.path || null });
  }
  return { registered_ids: ids.length, broken_ids: broken, loadable_ids: loadable, always_load: alwaysLoad };
}

/**
 * What a change cost the compile: every id that loaded a file before and does
 * not after (whether it now points at nothing or is no longer registered at
 * all), and the always_load ids among them.
 */
function newlyBroken(before, after) {
  const now = new Set(after.loadable_ids);
  const lost = before.loadable_ids.filter((id) => !now.has(id));
  const wasAlways = new Set(before.always_load.map((a) => a.id));
  return { ids: lost, always_load: lost.filter((id) => wasAlways.has(id)) };
}

// ---------------------------------------------------------------------------
// The event log (D5, R3): append-only JSONL beside the quarantine
// ---------------------------------------------------------------------------

/** Write bytes to `path` durably: temp file in the same directory, fsync, rename. */
function writeDurable(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * R11: the first write after the log moved out of quarantine/. If the old log
 * exists and the new one does not, its bytes are copied to the new location
 * unchanged (temp, fsync, rename) and a 'log_relocated' event is appended
 * BEFORE the event that triggered the write, so the history has no gap at the
 * point it moved. The old file is left where it is: nothing is deleted by this
 * build, and it is a read-only copy from then on (nothing writes it, and
 * readModuleFileEvents ignores it once the new log exists).
 *
 * @returns {object|null} The relocation event, or null when there was nothing to relocate.
 */
function relocateLegacyEventLog(mp) {
  if (existsSync(mp.eventsFile) || !existsSync(mp.legacyEventsFile)) return null;
  const legacy = readFileSync(mp.legacyEventsFile);
  const text = legacy.toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim()).length;
  const body = legacy.length && !text.endsWith('\n') ? Buffer.concat([legacy, Buffer.from('\n')]) : legacy;
  writeDurable(mp.eventsFile, body);
  const event = {
    event_id: randomUUID(),
    id: null,
    path: null,
    action: 'log_relocated',
    from: LEGACY_EVENT_LOG_REL,
    to: EVENT_LOG_REL,
    events_carried: lines,
    legacy_sha256: sha256Hex(legacy),
    legacy_size_bytes: legacy.length,
    legacy_retained: true,
    reason: 'the event log moved outside quarantine/ so a purge of quarantine cannot take the record of what it purged (WO-2026-11-21-01 R11)',
    at: new Date().toISOString(),
  };
  appendLine(mp.eventsFile, event);
  log('warn', `[module_file_events] relocated ${LEGACY_EVENT_LOG_REL} -> ${EVENT_LOG_REL} (${lines} events carried; the old file is retained)`);
  return event;
}

/** Append one JSON line with fsync. */
function appendLine(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Append one event, fsync'd. Throws if it cannot be written (the caller rolls back). */
function appendEvent(mp, event) {
  relocateLegacyEventLog(mp);
  appendLine(mp.eventsFile, event);
}

/**
 * The event log, oldest first, optionally filtered.
 *
 * Always returns log_path (where the log lives, or will live), whether or not
 * it exists yet. Until the first write after an upgrade, a log still at the old
 * location inside quarantine/ is READ from there and reported with
 * relocation_pending: true.
 *
 * @param {object} [filter]  { id, path, limit, include_snapshot }
 */
export function readModuleFileEvents(filter = {}, paths = getModularPaths()) {
  const mp = moduleFilePaths(paths);
  const location = {
    log_path: EVENT_LOG_REL,
    log_path_absolute: mp.eventsFile,
    // Computed, not asserted: a field that can only say true proves nothing.
    log_outside_quarantine: !(`${mp.eventsFile}`.startsWith(`${join(paths.avaDir, 'quarantine')}/`)),
  };
  const newPresent = existsSync(mp.eventsFile);
  const legacyPresent = existsSync(mp.legacyEventsFile);
  if (legacyPresent) {
    location.legacy_log_path = LEGACY_EVENT_LOG_REL;
    location.legacy_log_status = newPresent ? 'superseded: copied forward, no longer read or written' : 'still the live log until the next write relocates it';
  }
  const source = newPresent ? mp.eventsFile : (legacyPresent ? mp.legacyEventsFile : null);
  if (!source) return { ...location, events: [], total: 0, log_present: false, relocation_pending: false, unparseable_lines: 0 };
  const lines = readFileSync(source, 'utf8').split('\n').filter((l) => l.trim());
  const events = [];
  let bad = 0;
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { bad += 1; }
  }
  const norm = (p) => String(p || '').replace(/^\/+/, '');
  let out = events;
  if (filter.id) out = out.filter((e) => e.id === filter.id);
  if (filter.path) {
    const p = norm(filter.path);
    out = out.filter((e) => e.path === p || e.quarantine_path === p || e.retained_path === p);
  }
  const total = out.length;
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
  out = out.slice(-limit);
  if (filter.include_snapshot !== true) {
    out = out.map(({ content_snapshot, ...rest }) => ({ ...rest, content_snapshot_bytes: content_snapshot ? Buffer.byteLength(content_snapshot, rest.snapshot_encoding === 'base64' ? 'base64' : 'utf8') : 0 }));
  }
  return { ...location, events: out, total, log_present: true, read_from: newPresent ? EVENT_LOG_REL : LEGACY_EVENT_LOG_REL,
    relocation_pending: !newPresent, unparseable_lines: bad };
}

/**
 * R15: every module path whose MOST RECENT event leaves it out of modules/:
 * 'quarantined' with no later 'restored', or 'purged' (a purge follows a
 * quarantine and is the permanent form of it). A mirror push must skip these.
 *
 * Throws when the log exists but cannot be read; the caller fails closed.
 *
 * @returns {Map<string, { action: string, event_id: string, at: string, quarantine_path: string|null }>}
 */
export function quarantinedPathIndex(paths = getModularPaths()) {
  const { events } = readModuleFileEvents({ include_snapshot: false, limit: Number.MAX_SAFE_INTEGER }, paths);
  const last = new Map();
  for (const e of events) {
    if (!e || typeof e.path !== 'string' || !['quarantined', 'restored', 'purged'].includes(e.action)) continue;
    last.set(e.path, e);
  }
  const out = new Map();
  for (const [p, e] of last) {
    if (e.action === 'quarantined' || e.action === 'purged') {
      out.set(p, { action: e.action, event_id: e.event_id || null, at: e.at || null, quarantine_path: e.quarantine_path || null });
    }
  }
  return out;
}

/** The snapshot of a file's bytes as a record that can recreate them exactly. */
function snapshotOf(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes)
    ? { content_snapshot: text, snapshot_encoding: 'utf8' }
    : { content_snapshot: bytes.toString('base64'), snapshot_encoding: 'base64' };
}

// ---------------------------------------------------------------------------
// One mutation at a time
// ---------------------------------------------------------------------------

let volumeChain = Promise.resolve();
/** Serialise every quarantine, restore and purge in this process. */
export function withModuleVolumeLock(fn) {
  const run = volumeChain.then(fn, fn);
  volumeChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Path checks (D4 refusal 1)
// ---------------------------------------------------------------------------

/**
 * Check a caller path names a file inside modules/, in the form skill_audit
 * reports it ("modules/<...>"), and is not protected. No prefix is stripped:
 * the double-nested duplicates (modules/modules/...) are exactly the files a
 * caller needs to name, and stripping would silently address another one.
 *
 * @returns {{ ok: true, rel: string, full: string } | { ok: false, code: string, message: string }}
 */
export function checkModuleTarget(rawPath, paths, root = 'modules') {
  const mp = moduleFilePaths(paths);
  const p = typeof rawPath === 'string' ? rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '') : '';
  const baseDir = root === 'modules' ? mp.modulesRoot : mp.quarantineRoot;
  const prefix = root === 'modules' ? 'modules/' : 'quarantine/modules/';
  if (!p || !p.startsWith(prefix) || p.length === prefix.length) {
    return { ok: false, code: REFUSAL.OUTSIDE_MODULES,
      message: root === 'modules'
        ? `The file must be named as skill_audit lists it, starting "modules/" (for example "modules/existential/x.md"). Got "${p || String(rawPath)}".`
        : `The file must be named by its quarantine path, starting "quarantine/modules/". Got "${p || String(rawPath)}".` };
  }
  const inner = p.slice(prefix.length);
  if (inner.includes('..') || inner.includes('//') || inner.includes('\0')) {
    return { ok: false, code: REFUSAL.OUTSIDE_MODULES, message: `Path traversal or an empty component in "${p}".` };
  }
  const parts = inner.split('/');
  if (parts.length > 6 || parts.some((x) => !/^[A-Za-z0-9_.\-]+$/.test(x))) {
    return { ok: false, code: REFUSAL.OUTSIDE_MODULES, message: `Invalid path component in "${p}".` };
  }
  if (PROTECTED_BASENAMES.includes(parts[parts.length - 1]) || /(^|\/)references\/manifest\//.test(inner)) {
    return { ok: false, code: REFUSAL.PROTECTED_PATH,
      message: `${p} is a protected path (${PROTECTED_BASENAMES.join(', ')}, or any file under references/manifest/), wherever it sits. It is reported by skill_consistency_audit C-D; it is not removed by this tool.` };
  }
  const full = resolveContained(baseDir, inner);
  if (!full) return { ok: false, code: REFUSAL.OUTSIDE_MODULES, message: `${p} escapes ${prefix} or resolves through a symbolic link.` };
  return { ok: true, rel: root === 'modules' ? p : `modules/${inner}`, display: p, full };
}

// ---------------------------------------------------------------------------
// The quarantine decision (D4), computed without touching the volume
// ---------------------------------------------------------------------------

/**
 * Fragments as they would be with every registration of `targetRel` removed.
 * Only fragments are touched (MANIFEST.json and MANIFEST_APPEND.json are
 * frozen); returns what would change and what could not be changed.
 */
function deregistrationPlan(snapshot, moduleId, targetRel) {
  const { paths, registrations } = snapshot;
  // Every registration of the FILE, whatever id it uses: a declared path equal
  // to the target, or (for a path-less entry of this id) the path the merge
  // would infer. An entry under another id that names this file is still this
  // file's registration, and removing it is checked by the compile simulation.
  const pointsAtTarget = (r) => (r.path && r.path === targetRel)
    || (!r.path && r.id === moduleId && inferModulePath(paths.avaDir, r.entry) === targetRel);
  const frozen = registrations.filter((r) => r.kind !== 'manifest_fragment' && pointsAtTarget(r)).map((r) => r.source);
  const edits = [];
  const fragments = registrations.fragments.map((frag) => {
    const keep = [];
    const removed = [];
    frag.modules.forEach((m, index) => {
      const r = { id: String(m.id), path: m.path || null, entry: m };
      if (pointsAtTarget(r)) removed.push({ ...m, __index: index }); else keep.push(m);
    });
    if (removed.length) edits.push({ fragment: frag.file, removed_entries: removed.map(({ __index, ...m }) => m), indexes: removed.map((m) => m.__index) });
    return removed.length ? { ...frag, modules: keep } : frag;
  });
  return { frozen, edits, fragments };
}

/**
 * Everything a module_delete call needs to decide, and the refusals that
 * apply, for the file `targetRel` (avaDir-relative). Pure: reads only.
 */
export function planQuarantine(targetRel, args = {}, snapshot = buildModuleSnapshot()) {
  const { paths, scan } = snapshot;
  const target = scan.files.find((f) => f.path === targetRel);
  if (!target) {
    return { refusals: [{ code: REFUSAL.NOT_FOUND, message: `${targetRel} is not a file under modules/ (skill_audit lists every one).` }] };
  }
  const id = target.id;
  const resolution = resolveModulePath(id, { snapshot });
  const refusals = [];

  // D4.2: read before destroy, by hash.
  const expected = typeof args.expected_sha256 === 'string' ? args.expected_sha256.trim().toLowerCase() : '';
  if (!expected) {
    refusals.push({ code: REFUSAL.HASH_REQUIRED, message: 'expected_sha256 is required: the hash of the file you read and intend to quarantine.', actual_sha256: target.sha256 });
  } else if (expected !== target.sha256) {
    refusals.push({ code: REFUSAL.HASH_MISMATCH, message: 'The file on disk is not the file you read: its hash differs from expected_sha256. Read it again.', expected_sha256: expected, actual_sha256: target.sha256 });
  }

  // Siblings: every other file declaring the same id.
  const siblings = scan.files.filter((f) => f.kind === target.kind && f.id === id && f.path !== targetRel).map((f) => ({
    path: f.path, sha256: f.sha256, size_bytes: f.size_bytes, lines: f.lines,
    identical: f.sha256 === target.sha256,
    first_differing_line: f.sha256 === target.sha256 ? null : firstDifferingLine(target.text, f.text),
    is_resolved: f.path === resolution.registered_path,
  }));

  // D4.4: the last file for the id.
  if (siblings.length === 0) {
    refusals.push({ code: REFUSAL.LAST_FILE, message: `${targetRel} is the only file for module ${id}. Quarantining it would remove the module.`, id });
  }

  // D4.5: divergent siblings need an explicit, hash-named decision.
  const divergent = siblings.filter((s) => !s.identical);
  const ack = typeof args.acknowledge_divergence === 'string' ? args.acknowledge_divergence.trim().toLowerCase() : '';
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (divergent.length) {
    const retained = siblings.find((s) => s.sha256 === ack);
    if (!ack || !retained || !reason) {
      refusals.push({
        code: REFUSAL.DIVERGENT,
        message: `Module ${id} has ${divergent.length} other cop${divergent.length === 1 ? 'y' : 'ies'} with DIFFERENT content. `
          + 'Choosing which copy is the module is a content decision: pass acknowledge_divergence with the sha256 of the copy that stays, and a reason.',
        target: { path: targetRel, sha256: target.sha256 },
        siblings: siblings.map((s) => ({ path: s.path, sha256: s.sha256, identical: s.identical, first_differing_line: s.first_differing_line })),
        ...(ack && !retained ? { acknowledge_divergence_matches_no_retained_copy: ack } : {}),
        ...(ack && retained && !reason ? { reason_required: true } : {}),
      });
    }
  }

  // De-registration (D6) and the compile after the move (D4.3, D4.6).
  const plan = deregistrationPlan(snapshot, id, targetRel);
  if (plan.frozen.length) {
    refusals.push({
      code: REFUSAL.FROZEN_REGISTRATION,
      message: `${targetRel} is registered in ${plan.frozen.join(', ')}, which this tool may not edit (meta-dispatch-immutability). `
        + 'Quarantining it would leave an entry pointing at nothing, so the call is refused.',
      registered_in: plan.frozen,
      reconciliation: 'external',
      reconciliation_note: FROZEN_RECONCILIATION_NOTE,
    });
  }
  const targetAbs = paths.avaDir + targetRel;
  const existsAfter = (p) => p !== targetAbs && p !== join(paths.avaDir, targetRel) && existsSync(p);
  const after = buildModuleSnapshot(paths, { scan: { ...scan, files: scan.files.filter((f) => f.path !== targetRel) },
    registrations: snapshot.registrations, fragments: plan.fragments, exists: existsAfter });
  const afterResolution = resolveModulePath(id, { snapshot: after });
  const before = compileIntegrity(snapshot);
  const afterIntegrity = compileIntegrity(after);
  const broken = newlyBroken(before, afterIntegrity);
  // D4.3: a module the compile loads today, and would not after the move: this
  // file's own id when it is the live copy with no replacement, and any other
  // id whose registration names this file.
  if (broken.ids.length) {
    refusals.push({
      code: REFUSAL.LIVE_COPY,
      message: `${targetRel} is the file skill_compile loads for ${broken.ids.join(', ')}, and no other registered, loadable path would take its place.`,
      modules_that_would_stop_loading: broken.ids,
      resolved_by: resolution.resolved_by, resolved_from: resolution.resolved_from,
    });
  }
  // D4.6: the mandatory set.
  if (broken.always_load.length) {
    refusals.push({
      code: REFUSAL.ALWAYS_LOAD,
      message: `${broken.always_load.join(', ')} ${broken.always_load.length === 1 ? 'is' : 'are'} always_load: every compile loads ${broken.always_load.length === 1 ? 'it' : 'them'}. After this move it would not resolve, which drops a mandatory module below the compile's floor.`,
      always_load_ids: broken.always_load,
    });
  }

  return {
    id,
    target: { path: targetRel, sha256: target.sha256, size_bytes: target.size_bytes, lines: target.lines, is_resolved: resolution.registered_path === targetRel },
    resolution,
    siblings,
    divergent_count: divergent.length,
    registration: {
      registered_in: resolution.candidates.find((c) => c.path === targetRel)?.registered_in || [],
      fragment_edits: plan.edits.map((e) => ({ fragment: `references/manifest/${e.fragment}`, removes: e.removed_entries.map((m) => ({ id: m.id, path: m.path || null })) })),
      frozen_registrations: plan.frozen,
    },
    always_load: resolution.always_load,
    after: {
      resolves_to: afterResolution.resolved_path,
      resolved_by: afterResolution.resolved_by,
      newly_broken_ids: broken.ids,
      always_load_unresolved: broken.always_load,
    },
    // The copy the caller chose to keep when the copies differ; otherwise the
    // copy the compile would load after the move.
    retained_path: (divergent.length && siblings.find((s) => s.sha256 === ack) || {}).path || afterResolution.resolved_path || null,
    acknowledged_divergence: divergent.length && ack ? ack : null,
    reason: reason || null,
    plan,
    refusals,
    _target: target,
  };
}

// ---------------------------------------------------------------------------
// The moves (D1, D5, D6, R6)
// ---------------------------------------------------------------------------

/** Write a fragment atomically (temp file in the same directory, then rename). */
function writeFragmentAtomic(avaDir, file, fragmentObject, exactText = null) {
  const dir = fragmentsDirFor(avaDir);
  const finalPath = join(dir, file);
  const tmp = join(dir, `.${file}.tmp-${randomUUID()}`);
  writeFileSync(tmp, exactText !== null ? exactText : `${JSON.stringify(fragmentObject, null, 2)}\n`, 'utf8');
  renameSync(tmp, finalPath);
}

/** The fragment file's own object, re-read, with one id/path's entries removed or added. */
function editFragmentFile(avaDir, file, mutate) {
  const full = join(fragmentsDirFor(avaDir), file);
  const original = readFileSync(full, 'utf8');
  const obj = JSON.parse(original);
  obj.modules = Array.isArray(obj.modules) ? obj.modules : [];
  mutate(obj);
  writeFragmentAtomic(avaDir, file, obj);
  return original;
}

/**
 * Quarantine one module file: the full decision, then the move, the
 * de-registration, the record and the compile check, or nothing at all.
 *
 * @param {object} args  { file, confirm, expected_sha256, acknowledge_divergence, reason, dry_run }
 * @param {object} [context]  The caller identity, recorded on the event.
 */
export function quarantineModuleFile(args, context = null, paths = getModularPaths()) {
  const mp = moduleFilePaths(paths);
  const t = checkModuleTarget(args.file, paths, 'modules');
  if (!t.ok) return { done: false, dry_run: true, refusals: [{ code: t.code, message: t.message }] };

  const snapshot = buildModuleSnapshot(paths);
  const plan = planQuarantine(t.rel, args, snapshot);
  const quarantinePath = `quarantine/${t.rel}`;
  const quarantineFull = join(mp.avaDir, 'quarantine', t.rel);
  if (plan.target && existsSync(quarantineFull)) {
    plan.refusals.push({ code: REFUSAL.QUARANTINE_OCCUPIED, message: `${quarantinePath} already holds a quarantined file. Restore or purge it first.` });
  }
  const dryRun = args.dry_run === undefined ? args.confirm !== true : args.dry_run !== false;
  const report = publicPlan(plan, { quarantine_path: quarantinePath });
  if (dryRun || args.confirm !== true || plan.refusals.length) {
    const isDry = dryRun || args.confirm !== true;
    const blocking = plan.refusals.filter((r) => !(isDry && r.code === REFUSAL.HASH_REQUIRED));
    return { done: false, dry_run: isDry, ...report,
      next_step: blocking.length
        ? (isDry ? 'Nothing was moved. A confirmed call would be refused as listed in refusals, each with the evidence it used.'
          : 'Refused. Each refusal carries the evidence it used; nothing was moved.')
        : `Nothing was moved. To quarantine, call again with confirm: true, dry_run: false and expected_sha256: "${plan.target ? plan.target.sha256 : ''}".` };
  }

  // The move. Order: file into quarantine, then the fragment edits, then the
  // record, then the compile check. Any failure undoes everything before it.
  const before = compileIntegrity(snapshot);
  const undo = [];
  try {
    mkdirSync(dirname(quarantineFull), { recursive: true });
    renameSync(t.full, quarantineFull);
    undo.push(() => renameSync(quarantineFull, t.full));
    const removedRegistrations = [];
    for (const edit of plan.plan.edits) {
      const removeIds = new Set(edit.removed_entries.map((m) => `${m.id}\u0000${m.path || ''}`));
      const original = editFragmentFile(paths.avaDir, edit.fragment, (obj) => {
        obj.modules = obj.modules.filter((m) => !(m && removeIds.has(`${m.id}\u0000${m.path || ''}`)));
      });
      const fragFull = join(fragmentsDirFor(paths.avaDir), edit.fragment);
      undo.push(() => writeFileSync(fragFull, original, 'utf8'));
      // The fragment's exact text before, and the hash of what was written, so a
      // restore with nothing changed since can put the fragment back byte for byte.
      removedRegistrations.push({ fragment: `references/manifest/${edit.fragment}`, entries: edit.removed_entries,
        indexes: edit.indexes, fragment_before: original, fragment_after_sha256: sha256Hex(readFileSync(fragFull)) });
    }

    const bytes = readFileSync(quarantineFull);
    const event = {
      event_id: randomUUID(),
      id: plan.id,
      path: t.rel,
      action: 'quarantined',
      sha256: plan.target.sha256,
      size_bytes: plan.target.size_bytes,
      ...snapshotOf(bytes),
      retained_path: plan.retained_path,
      reason: plan.reason,
      at: new Date().toISOString(),
      quarantine_path: quarantinePath,
      acknowledged_divergence: plan.acknowledged_divergence,
      siblings: plan.siblings.map((s) => ({ path: s.path, sha256: s.sha256 })),
      registrations_removed: removedRegistrations,
      version: plan._target.frontmatter.version || null,
      actor: context && (context.user_id || context.tenant_id) ? { tenant_id: context.tenant_id || null, user_id: context.user_id || null } : null,
    };
    try {
      appendEvent(mp, event);
    } catch (err) {
      throw Object.assign(new Error(`the event could not be recorded: ${err.message}`), { refusal: REFUSAL.EVENT_NOT_RECORDED });
    }

    // R6: prove the compile is intact before returning.
    const afterIntegrity = compileIntegrity(buildModuleSnapshot(paths));
    const broken = newlyBroken(before, afterIntegrity);
    if (broken.ids.length || broken.always_load.length) {
      const err = new Error(`the compile would break: ${[...broken.ids, ...broken.always_load].join(', ')}`);
      err.refusal = REFUSAL.COMPILE_CHECK_FAILED;
      err.recorded = event;
      throw err;
    }
    log('warn', `[module_delete] quarantined ${t.rel} (${plan.id}, sha256 ${plan.target.sha256.slice(0, 12)}) -> ${quarantinePath}`);
    return { done: true, dry_run: false, action: 'quarantined', event_id: event.event_id, ...report,
      compile_check: { registered_ids: afterIntegrity.registered_ids, broken_before: before.broken_ids, broken_after: afterIntegrity.broken_ids,
        always_load: afterIntegrity.always_load },
      restore_with: { tool: 'module_restore', file: quarantinePath } };
  } catch (err) {
    const undone = [];
    for (const u of undo.reverse()) { try { u(); undone.push(true); } catch (e) { undone.push(false); log('error', `[module_delete] ROLLBACK STEP FAILED: ${e.message}`); } }
    if (err.recorded) {
      try {
        appendEvent(mp, { ...err.recorded, event_id: randomUUID(), action: 'restored', reason: `rolled back: ${err.message}`, at: new Date().toISOString(), content_snapshot: undefined, snapshot_encoding: undefined });
      } catch { /* the quarantine row stands; the rollback is in the log line */ }
    }
    log('error', `[module_delete] ${t.rel}: ${err.message}; rolled back (${undone.filter(Boolean).length}/${undone.length} steps)`);
    return { done: false, dry_run: false, ...report,
      refusals: [{ code: err.refusal || 'move_failed', message: `Nothing was left changed: ${err.message}.`, rolled_back: undone.every(Boolean) }] };
  }
}

/** The plan without its internals. */
function publicPlan(plan, extra = {}) {
  if (!plan.target) return { refusals: plan.refusals, ...extra };
  const { plan: _p, _target, ...rest } = plan;
  return { ...rest, ...extra, would: { move_from: plan.target.path, move_to: extra.quarantine_path || null,
    fragment_edits: plan.registration.fragment_edits } };
}

/** The last quarantine event for a path, if any. */
function lastQuarantineEvent(paths, rel) {
  const { events } = readModuleFileEvents({ path: rel, include_snapshot: false, limit: 100000 }, paths);
  for (let i = events.length - 1; i >= 0; i--) if (events[i].action === 'quarantined' && events[i].path === rel) return events[i];
  return null;
}

/**
 * Restore a quarantined file to where it came from (R2).
 *
 * @param {object} args  { file: 'quarantine/modules/...', confirm, dry_run, expected_sha256?, reason? }
 */
export function restoreModuleFile(args, context = null, paths = getModularPaths()) {
  const mp = moduleFilePaths(paths);
  const t = checkModuleTarget(args.file, paths, 'quarantine');
  if (!t.ok) return { done: false, dry_run: true, refusals: [{ code: t.code, message: t.message }] };
  const original = t.rel;
  const originalFull = join(paths.avaDir, original);
  const refusals = [];
  if (!existsSync(t.full)) refusals.push({ code: REFUSAL.NOT_IN_QUARANTINE, message: `${t.display} is not in quarantine.` });
  if (existsSync(originalFull)) refusals.push({ code: REFUSAL.RESTORE_OCCUPIED, message: `${original} is occupied by another file now; restoring would overwrite it.`, occupant_sha256: sha256Hex(readFileSync(originalFull)) });
  const bytes = existsSync(t.full) ? readFileSync(t.full) : null;
  const sha = bytes ? sha256Hex(bytes) : null;
  const expected = typeof args.expected_sha256 === 'string' ? args.expected_sha256.trim().toLowerCase() : '';
  if (expected && sha && expected !== sha) refusals.push({ code: REFUSAL.HASH_MISMATCH, message: 'The quarantined file is not the file you read.', expected_sha256: expected, actual_sha256: sha });
  const ev = lastQuarantineEvent(paths, original);
  const reRegister = [];
  const notReRegistered = [];
  for (const r of (ev && ev.registrations_removed) || []) {
    const file = String(r.fragment).replace(/^references\/manifest\//, '');
    const full = join(fragmentsDirFor(paths.avaDir), file);
    if (!existsSync(full)) {
      for (const entry of r.entries || []) notReRegistered.push({ fragment: r.fragment, id: entry.id, why: 'the fragment no longer exists' });
      continue;
    }
    // Untouched since the quarantine: put the fragment back exactly as it was.
    if (r.fragment_before && r.fragment_after_sha256 && sha256Hex(readFileSync(full)) === r.fragment_after_sha256) {
      reRegister.push({ file, exact: r.fragment_before, entries: r.entries || [] });
      continue;
    }
    // Changed since: re-insert each entry where it was, unless the id is now
    // registered there at another path.
    let obj;
    try { obj = JSON.parse(readFileSync(full, 'utf8')); } catch {
      for (const entry of r.entries || []) notReRegistered.push({ fragment: r.fragment, id: entry.id, why: 'the fragment is not valid JSON' });
      continue;
    }
    (r.entries || []).forEach((entry, k) => {
      const clash = (obj.modules || []).find((m) => m && m.id === entry.id);
      if (clash) notReRegistered.push({ fragment: r.fragment, id: entry.id, why: `the fragment now registers ${entry.id} at ${clash.path || '(no path)'}; restoring the old entry would change what the compile loads` });
      else reRegister.push({ file, entries: [entry], index: Array.isArray(r.indexes) ? r.indexes[k] : undefined });
    });
  }
  const dryRun = args.dry_run === undefined ? args.confirm !== true : args.dry_run !== false;
  const report = { file: t.display, restores_to: original, sha256: sha, quarantined_event: ev ? ev.event_id : null,
    re_registers: reRegister.flatMap((r) => r.entries.map((e) => ({ fragment: `references/manifest/${r.file}`, id: e.id, path: e.path || null,
      how: r.exact ? 'the fragment is put back exactly as it was' : 'the entry is re-inserted' }))),
    not_re_registered: notReRegistered };
  if (dryRun || args.confirm !== true || refusals.length) {
    return { done: false, dry_run: dryRun || args.confirm !== true, ...report, refusals,
      next_step: refusals.length ? 'Refused; nothing was moved.' : 'Nothing was moved. To restore, call again with confirm: true and dry_run: false.' };
  }
  const before = compileIntegrity(buildModuleSnapshot(paths));
  const undo = [];
  try {
    mkdirSync(dirname(originalFull), { recursive: true });
    renameSync(t.full, originalFull);
    undo.push(() => renameSync(originalFull, t.full));
    for (const r of reRegister) {
      const full = join(fragmentsDirFor(paths.avaDir), r.file);
      if (r.exact) {
        const prior = readFileSync(full, 'utf8');
        writeFragmentAtomic(paths.avaDir, r.file, null, r.exact);
        undo.push(() => writeFileSync(full, prior, 'utf8'));
        continue;
      }
      const prior = editFragmentFile(paths.avaDir, r.file, (obj) => {
        const at = Number.isInteger(r.index) && r.index >= 0 && r.index <= obj.modules.length ? r.index : obj.modules.length;
        obj.modules.splice(at, 0, ...r.entries);
      });
      undo.push(() => writeFileSync(full, prior, 'utf8'));
    }
    const event = {
      event_id: randomUUID(), id: ev ? ev.id : fileModuleId(original, bytes.toString('utf8')).id, path: original, action: 'restored',
      sha256: sha, size_bytes: bytes.length, ...snapshotOf(bytes), retained_path: null,
      reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
      at: new Date().toISOString(), quarantine_path: t.display, restored_from_event: ev ? ev.event_id : null,
      registrations_restored: reRegister.map((r) => ({ fragment: `references/manifest/${r.file}`, entries: r.entries, exact: Boolean(r.exact) })),
      registrations_not_restored: notReRegistered,
      version: fileModuleId(original, bytes.toString('utf8')).frontmatter.version || null,
      actor: context && (context.user_id || context.tenant_id) ? { tenant_id: context.tenant_id || null, user_id: context.user_id || null } : null,
    };
    try { appendEvent(mp, event); } catch (err) { throw Object.assign(new Error(`the event could not be recorded: ${err.message}`), { refusal: REFUSAL.EVENT_NOT_RECORDED }); }
    const afterIntegrity = compileIntegrity(buildModuleSnapshot(paths));
    const broken = newlyBroken(before, afterIntegrity);
    if (broken.ids.length || broken.always_load.length) {
      throw Object.assign(new Error(`the compile would break: ${[...broken.ids, ...broken.always_load].join(', ')}`), { refusal: REFUSAL.COMPILE_CHECK_FAILED });
    }
    log('warn', `[module_restore] restored ${original} from ${t.display}`);
    return { done: true, dry_run: false, action: 'restored', event_id: event.event_id, ...report,
      compile_check: { registered_ids: afterIntegrity.registered_ids, broken_before: before.broken_ids, broken_after: afterIntegrity.broken_ids } };
  } catch (err) {
    const undone = [];
    for (const u of undo.reverse()) { try { u(); undone.push(true); } catch { undone.push(false); } }
    return { done: false, dry_run: false, ...report,
      refusals: [{ code: err.refusal || 'move_failed', message: `Nothing was left changed: ${err.message}.`, rolled_back: undone.every(Boolean) }] };
  }
}

/**
 * Purge a quarantined file: the only irreversible call (D1). The record keeps
 * the bytes (content_snapshot), so even a purge leaves the content recoverable
 * from the event log.
 */
export function purgeQuarantinedFile(args, context = null, paths = getModularPaths()) {
  const mp = moduleFilePaths(paths);
  const t = checkModuleTarget(args.file, paths, 'quarantine');
  if (!t.ok) {
    // A purge of a path that is not in quarantine is refused with the
    // quarantine rule, whatever else is wrong with it.
    return { done: false, dry_run: true, refusals: [{ code: REFUSAL.NOT_IN_QUARANTINE, message: `Purge is accepted only for a file already in quarantine (a "quarantine/modules/..." path). ${t.message}` }] };
  }
  const refusals = [];
  if (!existsSync(t.full)) refusals.push({ code: REFUSAL.NOT_IN_QUARANTINE, message: `${t.display} is not in quarantine.` });
  const bytes = existsSync(t.full) ? readFileSync(t.full) : null;
  const sha = bytes ? sha256Hex(bytes) : null;
  const expected = typeof args.expected_sha256 === 'string' ? args.expected_sha256.trim().toLowerCase() : '';
  if (bytes && !expected) refusals.push({ code: REFUSAL.HASH_REQUIRED, message: 'expected_sha256 is required to purge.', actual_sha256: sha });
  else if (bytes && expected !== sha) refusals.push({ code: REFUSAL.HASH_MISMATCH, message: 'The quarantined file is not the file you read.', expected_sha256: expected, actual_sha256: sha });
  const dryRun = args.dry_run === undefined ? args.confirm !== true : args.dry_run !== false;
  const report = { file: t.display, original_path: t.rel, sha256: sha, irreversible: true };
  if (dryRun || args.confirm !== true || refusals.length) {
    return { done: false, dry_run: dryRun || args.confirm !== true, ...report, refusals,
      next_step: refusals.length ? 'Refused; nothing was removed.' : 'Nothing was removed. Purge unlinks the file for good: call again with purge: true, confirm: true, dry_run: false and expected_sha256.' };
  }
  const before = compileIntegrity(buildModuleSnapshot(paths));
  const ev = lastQuarantineEvent(paths, t.rel);
  const event = {
    event_id: randomUUID(), id: ev ? ev.id : fileModuleId(t.rel, bytes.toString('utf8')).id, path: t.rel, action: 'purged',
    sha256: sha, size_bytes: bytes.length, ...snapshotOf(bytes), retained_path: ev ? ev.retained_path : null,
    reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
    at: new Date().toISOString(), quarantine_path: t.display, quarantined_event: ev ? ev.event_id : null,
    actor: context && (context.user_id || context.tenant_id) ? { tenant_id: context.tenant_id || null, user_id: context.user_id || null } : null,
  };
  try { appendEvent(mp, event); } catch (err) {
    return { done: false, dry_run: false, ...report, refusals: [{ code: REFUSAL.EVENT_NOT_RECORDED, message: `Nothing was removed: the event could not be recorded (${err.message}).` }] };
  }
  try {
    unlinkSync(t.full);
  } catch (err) {
    log('error', `[module_delete] purge of ${t.display} recorded but the unlink failed: ${err.message}`);
    return { done: false, dry_run: false, ...report, event_id: event.event_id,
      refusals: [{ code: 'purge_failed', message: `The purge event was recorded but the file could not be removed (${err.message}); it is still in quarantine.` }] };
  }
  const afterIntegrity = compileIntegrity(buildModuleSnapshot(paths));
  const broken = newlyBroken(before, afterIntegrity);
  log('warn', `[module_delete] PURGED ${t.display} (sha256 ${sha.slice(0, 12)})`);
  return { done: true, dry_run: false, action: 'purged', event_id: event.event_id, ...report,
    compile_check: { registered_ids: afterIntegrity.registered_ids, broken_before: before.broken_ids, broken_after: afterIntegrity.broken_ids,
      newly_broken: broken.ids, intact: broken.ids.length === 0 && broken.always_load.length === 0 } };
}
