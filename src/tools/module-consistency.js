// ---------------------------------------------------------------------------
// src/tools/module-consistency.js   (v13.38.0, WO-2026-11-20-03 rev 2, section 5)
//
// skill_consistency_audit: the checks that read ACROSS modules.
//
// Decisions it implements:
//   D7  A separate tool from skill_audit. It reads every module body, which is
//       far more expensive than skill_audit's structural pass, and an expensive
//       check placed on the cheap, casually called path is the first thing
//       that gets skipped.
//   D8  Read-only. It reports and never changes anything: no archiving,
//       retirement, merging or pruning, whatever the counts say.
//   D9  Deterministic findings (C-A, C-B, C-C, C-D, C-F) and advisory or
//       judgment findings (C-E, C-G, C-H, C-I, C-J, C-K) are reported in
//       separate sections and NEVER summed. Advisory findings carry a
//       confidence and gate nothing.
//   D10 Floor before scan: every run reports what it read. A run that read no
//       module reports 'unverified', never clean.
//
// Every file-to-id question goes through resolveModulePath (module-files.js),
// the resolver skill_compile uses, so the audit reports on the file the compile
// actually loads.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildModuleSnapshot,
  resolveAllModules,
  readModuleFileEvents,
  firstDifferingLine,
  PROTECTED_BASENAMES,
} from './module-files.js';
import { groupedModuleAudit } from './skill.js';
import { getModularPaths } from './skill-modular.js';

/** The compile inputs whose canonical copy sits at the top of avaDir. */
const COMPILE_INPUTS = Object.freeze(['CORE.md', 'MANIFEST.json', 'DISPATCH_RULES.json']);

/** The always-load token ceiling C-E reports headroom against. */
function alwaysLoadCeiling() {
  const raw = parseInt(process.env.SKILL_ALWAYS_LOAD_TOKEN_CEILING || '40000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 40000;
}

/** Rough token estimate: bytes / 4, rounded up. Stated, not hidden: it is not a tokenizer count. */
const TOKEN_METHOD = 'estimated as ceil(bytes / 4); a rule of thumb for English text, not a tokenizer count';
const tokensOf = (bytes) => Math.ceil(bytes / 4);

/** The compile's line counter (skill-modular.js countLines). */
const compileLines = (text) => (text ? String(text).split('\n').length : 0);

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'what', 'your', 'their', 'about', 'over', 'under']);
const significantTokens = (s) => [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t)))];

/** C-G: does a body carry a declared capability? The phrase, or every significant word of it. */
export function bodyCarries(body, capability) {
  const b = String(body || '').toLowerCase();
  const phrase = String(capability || '').toLowerCase().trim();
  if (!phrase) return true;
  if (b.includes(phrase)) return true;
  const toks = significantTokens(phrase);
  if (!toks.length) return true;
  return toks.every((t) => b.includes(t));
}

/** Markers C-J reads as a stated disagreement. */
const DISAGREEMENT = /\b(disagree\w*|in tension with|tension with|in conflict with|conflicts? with|contra|against|rejects?|objects? to|opposes?|differs? from|parts? company with)\b/i;

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** C-A: filesystem and manifest, compared in BOTH directions. */
function checkA(grouped) {
  const a = grouped.registration.manifest_entries_without_file;
  const b = grouped.registration.files_without_manifest_entry;
  return {
    name: 'Filesystem and manifest bijection, both directions',
    severity: 'high',
    pass: a.length === 0 && b.length === 0,
    manifest_entries_without_file: a,
    files_without_manifest_entry: b,
  };
}

/** C-B: duplicate ids, classified by HASH (never by size). */
function checkB(snapshot, resolutions) {
  const byId = new Map();
  for (const f of snapshot.scan.files) {
    if (f.kind !== 'module') continue;
    if (!byId.has(f.id)) byId.set(f.id, []);
    byId.get(f.id).push(f);
  }
  const groups = [];
  for (const [id, files] of [...byId.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (files.length < 2) continue;
    const hashes = new Set(files.map((f) => f.sha256));
    const divergent = hashes.size > 1;
    const resolved = (resolutions.find((r) => r.id === id) || {}).resolved_path || null;
    const reference = files.find((f) => f.path === resolved) || files[0];
    groups.push({
      id,
      classification: divergent ? 'divergent' : 'identical',
      severity: divergent ? 'high' : 'medium',
      distinct_contents: hashes.size,
      resolved_path: resolved,
      files: files.map((f) => ({
        path: f.path, sha256: f.sha256, size_bytes: f.size_bytes, lines: f.lines, is_resolved: f.path === resolved,
        ...(divergent && f !== reference ? { first_differing_line_vs: reference.path, first_differing_line: firstDifferingLine(reference.text, f.text) } : {}),
      })),
      note: divergent
        ? 'Different documents share this id. Removing one is a content decision (module_delete refuses without acknowledge_divergence).'
        : 'Byte-identical copies. One may be quarantined after a dry run; the compile loads resolved_path.',
    });
  }
  return {
    name: 'Duplicate ids with content classification',
    severity: 'high (divergent), medium (identical)',
    pass: groups.length === 0,
    divergent_groups: groups.filter((g) => g.classification === 'divergent').length,
    identical_groups: groups.filter((g) => g.classification === 'identical').length,
    groups,
  };
}

/** C-C: for every registered id, the path the loader returns, and any ambiguity it would otherwise hide. */
function checkC(resolutions) {
  const findings = [];
  for (const r of resolutions) {
    if (!r.registered) continue;
    const problems = [];
    if (r.ambiguous) problems.push('ambiguous: more than one existing file or registered path for this id');
    if (!r.loadable) problems.push('registered but the compile loads no file for it');
    if (r.loaders.disagree) problems.push('skill_compile and skill_load_specialist would load different paths');
    if (!problems.length) continue;
    findings.push({
      id: r.id,
      problems,
      resolved_path: r.resolved_path,
      registered_path: r.registered_path,
      resolved_by: r.resolved_by,
      resolved_from: r.resolved_from,
      path_source: r.path_source,
      loaders: r.loaders,
      candidates: r.candidates.map((c) => ({ path: c.path, exists: c.exists, sha256: c.sha256, registered_in: c.registered_in, is_resolved: c.is_resolved })),
    });
  }
  return {
    name: 'Resolution proof',
    severity: 'high',
    pass: findings.length === 0,
    registered_ids_resolved: resolutions.filter((r) => r.registered).length,
    findings,
  };
}

/** C-D: the protected surface present exactly once, and every shadow copy. */
function checkD(snapshot) {
  const { paths, scan } = snapshot;
  const canonical = COMPILE_INPUTS.map((name) => {
    const full = join(paths.avaDir, name);
    const present = existsSync(full);
    let lines = null;
    let size = null;
    if (present) {
      try { const t = readFileSync(full, 'utf8'); lines = t.split('\n').length; size = statSync(full).size; } catch { /* reported as present, unreadable */ }
    }
    return { name, path: name, present, lines, size_bytes: size };
  });
  const fragDir = join(paths.avaDir, 'references', 'manifest');
  const shadows = [];
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    const underManifest = /(^|\/)references\/manifest\//.test(f.path);
    if (!PROTECTED_BASENAMES.includes(base) && !underManifest) continue;
    const canon = canonical.find((c) => c.name === base);
    shadows.push({
      path: f.path, sha256: f.sha256, lines: f.lines, size_bytes: f.size_bytes,
      shadows: underManifest ? 'references/manifest/' : base,
      ...(canon ? { canonical_lines: canon.lines, canonical_size_bytes: canon.size_bytes } : {}),
    });
  }
  const missing = canonical.filter((c) => !c.present).map((c) => c.name);
  return {
    name: 'Protected-surface inventory',
    severity: 'high',
    pass: missing.length === 0 && existsSync(fragDir) && shadows.length === 0,
    canonical,
    references_manifest_present: existsSync(fragDir),
    canonical_missing: missing,
    shadow_copies: shadows,
    note: 'A shadow copy is reported, never removed: module_delete refuses every protected name wherever it sits.',
  };
}

/** C-F: one id registered in more than one place. */
function checkF(snapshot, resolutions) {
  const byId = new Map();
  for (const r of snapshot.registrations) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const findings = [];
  for (const [id, regs] of [...byId.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const sources = [...new Set(regs.map((r) => r.source))];
    if (sources.length < 2 && regs.length < 2) continue;
    const res = resolutions.find((r) => r.id === id) || {};
    findings.push({
      id,
      registrations: regs.map((r) => ({ source: r.source, path: r.path, declared_path: r.declared_path })),
      fragments: regs.filter((r) => r.kind === 'manifest_fragment').map((r) => r.source),
      winning_source: res.resolved_from || null,
      note: 'Removing one registration leaves the module present through the others.',
    });
  }
  return {
    name: 'Duplicate manifest registration of one id across sources',
    severity: 'medium',
    pass: findings.length === 0,
    findings,
  };
}

/** C-E: aggregate always-load size and headroom. */
export function checkE(snapshot, resolutions) {
  const ceiling = alwaysLoadCeiling();
  const items = [];
  const unmeasured = [];
  const core = join(snapshot.paths.avaDir, 'CORE.md');
  const coreBytes = existsSync(core) ? statSync(core).size : 0;
  for (const r of resolutions) {
    if (!r.always_load) continue;
    if (!r.resolved_path_absolute) { unmeasured.push({ id: r.id, reason: 'always_load but resolves to no file' }); continue; }
    const f = snapshot.scan.files.find((x) => x.path === r.resolved_path);
    const bytes = f ? f.size_bytes : statSync(r.resolved_path_absolute).size;
    items.push({ id: r.id, path: r.resolved_path, bytes, estimated_tokens: tokensOf(bytes) });
  }
  const moduleBytes = items.reduce((s, x) => s + x.bytes, 0);
  const totalBytes = moduleBytes + coreBytes;
  const totalTokens = tokensOf(totalBytes);
  const also = [];
  const personality = join(snapshot.paths.avaDir, 'PERSONALITY.md');
  if (existsSync(personality)) also.push({ name: 'PERSONALITY.md', bytes: statSync(personality).size, why: 'injected after CORE on every compile when present' });
  const selfCheck = resolutions.find((r) => r.id === 'meta-self-check');
  if (selfCheck && selfCheck.resolved_path_absolute && !selfCheck.always_load) {
    also.push({ name: 'meta-self-check', path: selfCheck.resolved_path, bytes: statSync(selfCheck.resolved_path_absolute).size, why: 'appended last on every compile' });
  }
  return {
    name: 'Aggregate always-load size and headroom',
    severity: 'medium',
    confidence: 'high for bytes; tokens are an estimate',
    always_load_modules: items.length,
    always_load_module_bytes: moduleBytes,
    core_bytes: coreBytes,
    aggregate_bytes: totalBytes,
    aggregate_estimated_tokens: totalTokens,
    token_ceiling: ceiling,
    headroom_estimated_tokens: ceiling - totalTokens,
    token_method: TOKEN_METHOD,
    modules: items,
    unmeasured,
    also_always_injected_not_in_aggregate: also,
  };
}

/**
 * C-G: provides against body presence, self-calibrated (section 5.2). The rate
 * is measured on a sample of ten modules that declare provides; above twenty
 * per cent the check is DROPPED for this corpus rather than reported, because a
 * check that fires on most of a healthy corpus is read once and then ignored.
 */
export function checkG(snapshot, resolutions) {
  const CAL_SAMPLE = 10;
  const MAX_RATE = 0.2;
  const modules = [];
  for (const r of resolutions) {
    if (!r.registered || !r.resolved_path) continue;
    const entry = snapshot.merged.manifest.modules.filter((m) => m && m.id === r.id).pop();
    const f = snapshot.scan.files.find((x) => x.path === r.resolved_path);
    if (!f) continue;
    const provides = (entry && Array.isArray(entry.provides) && entry.provides.length) ? entry.provides
      : (Array.isArray(f.frontmatter.provides) ? f.frontmatter.provides : []);
    if (!provides.length) continue;
    const missing = provides.filter((p) => !bodyCarries(f.text, p));
    modules.push({ id: r.id, path: f.path, provides, missing });
  }
  const sample = modules.slice(0, CAL_SAMPLE);
  const base = { name: 'provides against body presence', severity: 'low', calibration_sample_size: sample.length,
    calibration_rule: `sample of ${CAL_SAMPLE} modules that declare provides; dropped if more than ${MAX_RATE * 100}% fire` };
  if (sample.length < CAL_SAMPLE) {
    return { ...base, status: 'not_run', reason: `only ${sample.length} module(s) declare provides; the check is not reported without a ${CAL_SAMPLE}-module calibration sample` };
  }
  const rate = sample.filter((m) => m.missing.length).length / sample.length;
  if (rate > MAX_RATE) {
    return { ...base, status: 'dropped', calibration_fire_rate: rate, reason: 'the calibration sample fired above the threshold; findings are withheld for this corpus' };
  }
  const findings = modules.filter((m) => m.missing.length).map((m) => ({ ...m, confidence: 'medium' }));
  return { ...base, status: 'run', calibration_fire_rate: rate, modules_checked: modules.length, findings };
}

/** C-H: two or more modules claiming the same distinct trigger. */
function checkH(snapshot, resolutions) {
  const GENERIC_AT = 4;
  const claims = new Map();
  for (const r of resolutions) {
    if (!r.registered) continue;
    const entry = snapshot.merged.manifest.modules.filter((m) => m && m.id === r.id).pop();
    const t = (entry && entry.triggers) || {};
    const keys = [
      ...(Array.isArray(t.phrases) ? t.phrases.map((p) => ['phrase', String(p).toLowerCase().trim()]) : []),
      ...(Array.isArray(t.keywords) ? t.keywords.map((k) => ['keyword', String(k).toLowerCase().trim()]) : []),
    ];
    for (const [kind, k] of keys) {
      if (!k || (kind === 'keyword' && k.length < 5)) continue;
      const key = `${kind}\u0000${k}`;
      if (!claims.has(key)) claims.set(key, new Map());
      claims.get(key).set(r.id, entry.load_priority ?? null);
    }
  }
  const findings = [];
  let generic = 0;
  for (const [key, owners] of claims) {
    if (owners.size < 2) continue;
    if (owners.size >= GENERIC_AT) { generic += 1; continue; }
    const [kind, trigger] = key.split('\u0000');
    findings.push({ trigger, kind, modules: [...owners.entries()].map(([id, p]) => ({ id, load_priority: p })), confidence: 'low' });
  }
  findings.sort((a, b) => a.trigger.localeCompare(b.trigger));
  return {
    name: 'Trigger collision',
    severity: 'low',
    note: 'Reported only. Not a reason to change dispatch (D8).',
    collisions: findings.length,
    generic_triggers_not_listed: generic,
    generic_rule: `a trigger claimed by ${GENERIC_AT} or more modules is counted as generic, not listed`,
    findings: findings.slice(0, 100),
    truncated: findings.length > 100,
  };
}

/** C-I: line_count_estimate and version drift against the module's own file and record. */
function checkI(snapshot, resolutions) {
  const findings = [];
  // The event log, read once: the last recorded version per path.
  const lastVersion = new Map();
  for (const e of readModuleFileEvents({ include_snapshot: false, limit: 1000000 }, snapshot.paths).events) {
    if (e.version) lastVersion.set(e.path, e);
  }
  for (const r of resolutions) {
    if (!r.resolved_path) continue;
    const f = snapshot.scan.files.find((x) => x.path === r.resolved_path);
    if (!f) continue;
    const stated = f.frontmatter.line_count_estimate;
    const actual = compileLines(f.text);
    if (typeof stated === 'number' && stated !== actual) {
      findings.push({ id: r.id, path: f.path, kind: 'line_count_estimate', stated, actual, confidence: 'high' });
    }
    if (f.frontmatter.version) {
      const ev = lastVersion.get(f.path);
      if (ev && ev.version !== f.frontmatter.version) {
        findings.push({ id: r.id, path: f.path, kind: 'version', stated: f.frontmatter.version, last_event_version: ev.version, last_event_action: ev.action, last_event_at: ev.at, confidence: 'medium' });
      }
    }
  }
  return {
    name: 'Version and line_count_estimate drift',
    severity: 'low',
    note: 'The version half compares against module_file_events, which records quarantine, restore and purge only; a module that has never been through one has no recorded version to drift from.',
    findings,
  };
}

/** C-J: a disagreement module A states with module B by name, absent from B. */
export function checkJ(snapshot, resolutions) {
  const live = resolutions.filter((r) => r.registered && r.resolved_path);
  const textOf = new Map();
  for (const r of live) {
    const f = snapshot.scan.files.find((x) => x.path === r.resolved_path);
    if (f) textOf.set(r.id, f.text);
  }
  const ids = [...textOf.keys()];
  const mentions = (text, id) => new RegExp(`(^|[^a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`, 'i').test(text);
  const findings = [];
  for (const a of ids) {
    const lines = textOf.get(a).split('\n');
    for (const b of ids) {
      if (a === b) continue;
      const line = lines.find((l) => DISAGREEMENT.test(l) && mentions(l, b));
      if (!line) continue;
      if (mentions(textOf.get(b), a)) continue;
      findings.push({ module: a, names: b, statement: line.trim().slice(0, 240), finding: `${b} does not record this disagreement`, confidence: 'low' });
    }
  }
  return {
    name: 'Reciprocal disagreement record',
    severity: 'low',
    note: 'The finding is that B does not record it, not that B is wrong; the audit does not adjudicate the disagreement. Matching is by module id named in a line carrying a disagreement word.',
    findings,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run the audit against the active volume.
 *
 * @param {object} [args]  { checks?: string[] } to run a subset.
 * @param {object} [paths]
 */
export function runConsistencyAudit(args = {}, paths = getModularPaths()) {
  const want = Array.isArray(args.checks) && args.checks.length ? new Set(args.checks.map((c) => String(c).toUpperCase())) : null;
  const on = (c) => !want || want.has(c);

  const snapshot = buildModuleSnapshot(paths);
  const resolutions = resolveAllModules(snapshot);
  const grouped = groupedModuleAudit(paths, []).result;
  const mdFiles = snapshot.scan.files.filter((f) => f.kind === 'module');

  const floor = {
    modules_read: mdFiles.length,
    files_scanned: snapshot.scan.files.length,
    registered_ids: resolutions.filter((r) => r.registered).length,
    unregistered_files: grouped.registration.files_without_manifest_entry.length,
    scan_truncated: snapshot.scan.truncated,
    status: mdFiles.length === 0 || snapshot.scan.truncated ? 'unverified' : 'verified',
    resolution: resolutions.map((r) => ({ id: r.id, resolved_path: r.resolved_path, resolved_by: r.resolved_by, resolved_from: r.resolved_from,
      path_source: r.path_source, candidates: r.candidate_count, ambiguous: r.ambiguous })),
  };
  if (floor.status === 'unverified') {
    floor.reason = mdFiles.length === 0
      ? 'no module file was read: an audit of an empty set reports nothing, and that is not the same as clean'
      : 'the scan stopped at MODULE_INDEX_MAX_FILES';
  }

  const deterministic = {};
  if (on('C-A')) deterministic['C-A'] = checkA(grouped);
  if (on('C-B')) deterministic['C-B'] = checkB(snapshot, resolutions);
  if (on('C-C')) deterministic['C-C'] = checkC(resolutions);
  if (on('C-D')) deterministic['C-D'] = checkD(snapshot);
  if (on('C-F')) deterministic['C-F'] = checkF(snapshot, resolutions);
  if (floor.status === 'unverified') {
    for (const c of Object.values(deterministic)) { c.pass = null; c.status = 'unverified'; }
  }
  const failed = Object.entries(deterministic).filter(([, c]) => c.pass === false).map(([k]) => k);

  const advisory = {};
  if (on('C-E')) advisory['C-E'] = checkE(snapshot, resolutions);
  if (on('C-G')) advisory['C-G'] = checkG(snapshot, resolutions);
  if (on('C-H')) advisory['C-H'] = checkH(snapshot, resolutions);
  if (on('C-I')) advisory['C-I'] = checkI(snapshot, resolutions);

  const judgment = {};
  if (on('C-J')) judgment['C-J'] = checkJ(snapshot, resolutions);
  if (on('C-K')) {
    judgment['C-K'] = {
      name: 'Stated provenance not reachable from the module',
      status: 'delegated',
      delegated_to: 'vault_provenance_audit',
      note: 'Not re-implemented here: two systems disagreeing about one fact is the defect class this audit exists for. '
        + 'The provenance records live on the gateway, which runs vault_provenance_audit over registered_module_ids and attaches '
        + 'its contradictions here when this tool is called through it.',
    };
  }

  return {
    audit: 'skill_consistency_audit',
    read_only: true,
    status: floor.status,
    floor,
    deterministic: {
      status: floor.status === 'unverified' ? 'unverified' : (failed.length ? 'findings' : 'clean'),
      checks_run: Object.keys(deterministic),
      checks_with_findings: failed,
      ...deterministic,
    },
    advisory,
    judgment,
    registered_module_ids: resolutions.filter((r) => r.registered).map((r) => r.id),
    note: 'Deterministic findings and advisory findings are separate sections and are never added together (D9). '
      + 'This tool changes nothing (D8); quarantining a file is module_delete, a separate and guarded call.',
  };
}

export const skillConsistencyAuditToolDefinition = {
  name: 'skill_consistency_audit',
  description:
    'Cross-module consistency audit of the Ava module tree (read-only, reads every module body, so call it deliberately '
    + 'rather than routinely; skill_audit is the cheap structural pass). Deterministic checks, each pass or fail: '
    + 'C-A filesystem against manifest in both directions; C-B duplicate ids classified identical or divergent by sha256; '
    + 'C-C the file the compile resolves for each registered id, with ambiguity reported rather than picked silently; '
    + 'C-D CORE.md, MANIFEST.json, DISPATCH_RULES.json and references/manifest/ present once, and every shadow copy; '
    + 'C-F one id registered in more than one place. Advisory, never added to the deterministic results: C-E the '
    + 'always-load total in bytes and estimated tokens against the ceiling; C-G provides against body content '
    + '(self-calibrated, dropped above 20% on a 10-module sample); C-H trigger collisions; C-I line_count_estimate and '
    + 'version drift. Judgment: C-J one-sided disagreement records; C-K provenance contradictions from '
    + 'vault_provenance_audit. Every run reports what it read; a run that read nothing reports unverified, never clean.',
  inputSchema: {
    type: 'object',
    properties: {
      checks: { type: 'array', items: { type: 'string' }, description: 'Optional subset, e.g. ["C-A","C-B"]. Default: every check.' },
    },
    required: [],
  },
};

export function handleSkillConsistencyAudit(args = {}) {
  const out = runConsistencyAudit(args || {});
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}
