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
//
// v13.39.0 (WO-2026-11-21-01) adds, all reporting, nothing that writes:
//   R9  deterministic.status has exactly four values (clean, findings, not_run,
//       unverified) and the payload says what was requested, what ran and what
//       was skipped and why. A run that executed nothing cannot read as clean.
//   R10 Deterministic findings are classified into tiers (blocking, accepted,
//       new) against a hand-maintained register of accepted findings, and the
//       report opens with the tier headline. The audit never writes the register.
//   R6/R7 divergent_frozen_registration (the D11 invariant, measured every run)
//       and resolved_is_registered on every duplicate group.
//   R14 multi_id_file findings under C-C.
//   R16 nested module trees reported as one finding per tree.
//   R17 the always-load aggregate on every run, naming its estimator, with the
//       ceiling stated as a policy figure.
//   R18 C-H grouped by module pair, ranked, top 20, generic triggers apart.
//   R19 C-I drift count, the worst 10, and field_unmaintained.
//   G2  C-A manifest entries without a file grouped by source fragment.
//
// v13.39.x (WO-2026-11-21-02), still reporting only:
//   S1  C-L "derived registration quality" (advisory, never blocks): stopword
//       phrases, path-segment keywords, stale version, line count off by more
//       than 20 per cent, provides values with a space, and U+FFFD or a double
//       space in a fragment string.
//   S2  C-F judges each duplicate: a defect when more than one registration was
//       created by module_write (or module_write added one beside a frozen
//       manifest's), told apart from registrations that predate the tool.
//   R1-R4 registration_repair_report (on request): every fragment registration
//       that looks auto-derived, with a proposed corrected entry. It proposes;
//       it never applies. Each repair is Brian's decision, one module at a time.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  buildModuleSnapshot,
  resolveAllModules,
  readModuleFileEvents,
  firstDifferingLine,
  idsByFile,
  PROTECTED_BASENAMES,
} from './module-files.js';
import { groupedModuleAudit } from './skill.js';
import { getModularPaths } from './skill-modular.js';
import {
  inferModulePath,
  pathSegmentsOf,
  keywordLintReason,
  phraseLintReasons,
  phraseEndsWithStopword,
  deriveRegistration,
  readRegistrationFrontmatter,
  REGISTERED_BY_MODULE_WRITE,
} from './manifest-fragments.js';
import { readAllLedgerEntries } from '../utils/moduleLedger.js';

/** The compile inputs whose canonical copy sits at the top of avaDir. */
const COMPILE_INPUTS = Object.freeze(['CORE.md', 'MANIFEST.json', 'DISPATCH_RULES.json']);

/** Check names by section (D9). */
export const DETERMINISTIC_CHECKS = Object.freeze(['C-A', 'C-B', 'C-C', 'C-D', 'C-F']);
export const ADVISORY_CHECKS = Object.freeze(['C-E', 'C-G', 'C-H', 'C-I', 'C-L']);
export const JUDGMENT_CHECKS = Object.freeze(['C-J', 'C-K']);
/** R10: deterministic checks whose unregistered findings are blocking by default. */
export const BLOCKING_BY_DEFAULT = Object.freeze(['C-A', 'C-C', 'C-D']);

/** R9: the only four values deterministic.status may take, with their meanings. */
export const STATUS_MEANINGS = Object.freeze({
  clean: 'every requested check ran and passed',
  findings: 'at least one requested check ran and returned a finding',
  not_run: 'no requested check was executed',
  unverified: 'the floor failed: no modules were read (or the scan was truncated), so no check could have run',
});

/** The always-load token ceiling C-E reports headroom against, and where it came from. */
function alwaysLoadCeiling() {
  const set = process.env.SKILL_ALWAYS_LOAD_TOKEN_CEILING;
  const raw = parseInt(set || '40000', 10);
  const valid = Number.isFinite(raw) && raw > 0;
  return { value: valid ? raw : 40000, source: set && valid ? 'SKILL_ALWAYS_LOAD_TOKEN_CEILING' : 'default (40000)' };
}

/** Rough token estimate: bytes / 4, rounded up. Stated, not hidden: it is not a tokenizer count. */
const TOKEN_METHOD = 'estimated as ceil(bytes / 4); a rule of thumb for English text, not a tokenizer count';
const tokensOf = (bytes) => Math.ceil(bytes / 4);
/** R17: the estimator, by name, exactly as it is computed. No better estimator is invented here. */
const TOKEN_ESTIMATOR = Object.freeze({
  name: 'bytes_div_4_ceil',
  formula: 'ceil(bytes / 4)',
  kind: 'rule of thumb for English text; not a tokenizer count, so the true figure can sit either side of the ceiling',
});
const CEILING_BASIS = 'a policy figure, not a measured context limit: set by SKILL_ALWAYS_LOAD_TOKEN_CEILING (default 40000)';

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
    // G2: one line per source fragment, so one pathless index file reads as
    // one finding group rather than sixty rows. The flat list stays below for
    // any reader of the earlier shape.
    manifest_entries_without_file_by_source: grouped.registration.manifest_entries_without_file_by_source || [],
    manifest_entries_without_file: a,
    files_without_manifest_entry: b,
  };
}

/**
 * Duplicate-id groups (two or more .md files declaring one id), classified by
 * HASH, with R7's resolved_is_registered. Shared by C-B and the D11 report so
 * both read the same groups.
 */
function duplicateGroups(snapshot, resolutions) {
  const byRes = new Map(resolutions.map((r) => [r.id, r]));
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
    const res = byRes.get(id) || { candidates: [] };
    const resolved = res.resolved_path || null;
    const reference = files.find((f) => f.path === resolved) || files[0];
    // R7: is the copy the compile resolves the one a DECLARED registration
    // names? (An inferred path is not a registration, R12.) Where it is not,
    // the registered path is named separately from the resolved path.
    const registeredPaths = res.candidates.filter((c) => c.registered_in.length).map((c) => c.path);
    const resolvedIsRegistered = Boolean(resolved) && registeredPaths.includes(resolved);
    groups.push({
      id,
      classification: divergent ? 'divergent' : 'identical',
      severity: divergent ? 'high' : 'medium',
      distinct_contents: hashes.size,
      resolved_path: resolved,
      resolved_is_registered: resolvedIsRegistered,
      ...(resolvedIsRegistered ? {} : { registered_path: res.path_source === 'declared' ? res.registered_path : null, registered_paths: registeredPaths }),
      files: files.map((f) => ({
        path: f.path, sha256: f.sha256, size_bytes: f.size_bytes, lines: f.lines, is_resolved: f.path === resolved,
        ...(divergent && f !== reference ? { first_differing_line_vs: reference.path, first_differing_line: firstDifferingLine(reference.text, f.text) } : {}),
      })),
      note: divergent
        ? 'Different documents share this id. Removing one is a content decision (module_delete refuses without acknowledge_divergence).'
        : 'Byte-identical copies. One may be quarantined after a dry run; the compile loads resolved_path.',
    });
  }
  return groups;
}

/** C-B: duplicate ids, classified by HASH (never by size). */
function checkB(groups) {
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
function checkC(resolutions, inverse) {
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
      ...(r.pathless_registrations && r.pathless_registrations.length ? { pathless_registrations: r.pathless_registrations } : {}),
    });
  }
  // R14: one file claimed by more than one id. Each id may have exactly one
  // candidate, so per-id resolution cannot see this; the inverse index can.
  const multi = (inverse && inverse.multi_id_files) || [];
  return {
    name: 'Resolution proof',
    severity: 'high',
    pass: findings.length === 0 && multi.length === 0,
    registered_ids_resolved: resolutions.filter((r) => r.registered).length,
    findings,
    multi_id_files: multi.map((m) => ({ ...m, problem: `one file, ${m.ids.length} ids: ${m.ids.join(', ')}` })),
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

/** The key set module_write's derived entry had before WO-2026-11-21-02 (S2 attribution of old registrations). */
const LEGACY_DERIVED_KEYS = Object.freeze(['id', 'title', 'version', 'category', 'path', 'load_priority', 'triggers',
  'depends_on', 'provides', 'load_strategy', 'line_count_estimate', 'always_load']);

/** module_write's fragment registrations, from the H-3 ledger: "<module id>|<fragment file>". */
function ledgerFragmentRegistrations() {
  const out = new Set();
  let entries = [];
  try { entries = readAllLedgerEntries(); } catch { return out; }
  for (const e of entries) {
    if (!e || e.kind !== 'fragment' || e.action !== 'register' || !e.extra || !e.extra.module_id || typeof e.path !== 'string') continue;
    out.add(`${e.extra.module_id}|${e.path.split('/').pop()}`);
  }
  return out;
}

/**
 * S2: who created a registration. MANIFEST.json and MANIFEST_APPEND.json are
 * never written by module_write. A fragment entry is module_write's when it
 * carries the registered_by marker, when the H-3 ledger records module_write
 * registering this id in this fragment, or (for entries older than both) when
 * its key set is exactly the derived entry's. Anything else predates the tool
 * or was written by hand.
 */
function registrationAuthor(reg, ledgerRegs) {
  if (reg.kind !== 'manifest_fragment') {
    return { created_by: 'not_module_write', evidence: `${reg.source} is never written by module_write` };
  }
  const e = reg.entry || {};
  if (e.registered_by === REGISTERED_BY_MODULE_WRITE) return { created_by: 'module_write', evidence: 'registered_by marker', confidence: 'high' };
  const file = reg.source.replace(/^references\/manifest\//, '');
  if (ledgerRegs.has(`${reg.id}|${file}`)) return { created_by: 'module_write', evidence: 'H-3 ledger: module_write registered this id in this fragment', confidence: 'high' };
  const keys = Object.keys(e).filter((k) => !k.startsWith('_'));
  if (LEGACY_DERIVED_KEYS.every((k) => keys.includes(k)) && keys.every((k) => LEGACY_DERIVED_KEYS.includes(k))) {
    return { created_by: 'module_write', evidence: 'exactly the key set of module_write\'s derived entry before WO-2026-11-21-02 (inferred: no marker and no ledger record)', confidence: 'medium' };
  }
  return { created_by: 'predates_tool_or_hand_made', evidence: 'no registered_by marker, no ledger record, and not the derived-entry key set' };
}

/** C-F: one id registered in more than one place, judged (S2). */
function checkF(snapshot, resolutions) {
  const byId = new Map();
  for (const r of snapshot.registrations) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const ledgerRegs = ledgerFragmentRegistrations();
  const findings = [];
  for (const [id, regs] of [...byId.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const sources = [...new Set(regs.map((r) => r.source))];
    if (sources.length < 2 && regs.length < 2) continue;
    const res = resolutions.find((r) => r.id === id) || {};
    const attributed = regs.map((r) => ({ source: r.source, path: r.path, declared_path: r.declared_path, ...registrationAuthor(r, ledgerRegs) }));
    const byTool = attributed.filter((a) => a.created_by === 'module_write').length;
    const frozen = regs.some((r) => r.kind === 'manifest' || r.kind === 'manifest_append');
    const judgement = byTool > 1 ? 'defect_minted_on_write'
      : (byTool === 1 && frozen) ? 'defect_fragment_beside_frozen_manifest'
        : 'predates_tool';
    findings.push({
      id,
      registrations: attributed,
      fragments: regs.filter((r) => r.kind === 'manifest_fragment').map((r) => r.source),
      winning_source: res.resolved_from || null,
      registrations_by_module_write: byTool,
      defect: judgement !== 'predates_tool',
      judgement,
      judgement_reason: judgement === 'defect_minted_on_write'
        ? `${byTool} registrations of this id were created by module_write: a write minted a further registration instead of updating the existing one (WO-2026-11-21-02 D2). module_write now updates in place (Q2) or refuses (Q3).`
        : judgement === 'defect_fragment_beside_frozen_manifest'
          ? 'module_write added a fragment registration for an id a frozen manifest already registers; it now writes none (Q4).'
          : 'at most one registration was created by module_write and none sits beside a frozen manifest: the duplication predates the tool or was made by hand.',
      note: 'Reported, never removed: removing a duplicate registration is a dispatch-layer amendment and a per-id human decision (WO-2026-11-21-02 section 6). The question is why a write created a second registration, not whether removing one is safe.',
    });
  }
  return {
    name: 'Duplicate manifest registration of one id across sources',
    severity: 'medium',
    pass: findings.length === 0,
    defects: findings.filter((f) => f.defect).length,
    findings,
  };
}

/** C-E: aggregate always-load size and headroom. */
export function checkE(snapshot, resolutions) {
  const ceilingInfo = alwaysLoadCeiling();
  const ceiling = ceilingInfo.value;
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
    estimator: TOKEN_ESTIMATOR,
    ceiling_kind: 'policy',
    ceiling_basis: CEILING_BASIS,
    ceiling_source: ceilingInfo.source,
    modules: items,
    unmeasured,
    also_always_injected_not_in_aggregate: also,
  };
}

/** R17: the aggregate in brief, reported on every run whether or not C-E was requested. */
function alwaysLoadAggregate(e) {
  return {
    always_load_modules: e.always_load_modules,
    always_load_module_bytes: e.always_load_module_bytes,
    core_bytes: e.core_bytes,
    aggregate_bytes: e.aggregate_bytes,
    aggregate_estimated_tokens: e.aggregate_estimated_tokens,
    token_ceiling: e.token_ceiling,
    headroom_estimated_tokens: e.headroom_estimated_tokens,
    estimator: e.estimator,
    ceiling_kind: e.ceiling_kind,
    ceiling_basis: e.ceiling_basis,
    ceiling_source: e.ceiling_source,
    unmeasured: e.unmeasured.length,
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
  const TOP = 20;
  const colliding = [];
  const generic = [];
  for (const [key, owners] of claims) {
    if (owners.size < 2) continue;
    const [kind, trigger] = key.split('\u0000');
    if (owners.size >= GENERIC_AT) { generic.push({ trigger, kind, module_count: owners.size }); continue; }
    colliding.push({ trigger, kind, owners });
  }
  // R18: grouped by module PAIR, ranked by how many triggers the pair shares.
  // A census of single-trigger rows is not a report; a ranked list of pairs is.
  const pairs = new Map();
  for (const c of colliding) {
    const ids = [...c.owners.keys()].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}\u0000${ids[j]}`;
        if (!pairs.has(k)) {
          pairs.set(k, { modules: [{ id: ids[i], load_priority: c.owners.get(ids[i]) }, { id: ids[j], load_priority: c.owners.get(ids[j]) }], triggers: [] });
        }
        pairs.get(k).triggers.push({ trigger: c.trigger, kind: c.kind });
      }
    }
  }
  const ranked = [...pairs.values()]
    .map((p) => ({ ...p, shared_trigger_count: p.triggers.length, triggers: p.triggers.sort((a, b) => a.trigger.localeCompare(b.trigger)), confidence: 'low' }))
    .sort((a, b) => b.shared_trigger_count - a.shared_trigger_count
      || a.modules[0].id.localeCompare(b.modules[0].id) || a.modules[1].id.localeCompare(b.modules[1].id));
  generic.sort((a, b) => b.module_count - a.module_count || a.trigger.localeCompare(b.trigger));
  const shown = ranked.slice(0, TOP);
  return {
    name: 'Trigger collision',
    severity: 'low',
    note: 'Reported only. Not a reason to change dispatch (D8).',
    collisions: colliding.length,
    module_pairs: ranked.length,
    ranking: `module pairs ranked by shared trigger count; the top ${TOP} are listed`,
    findings: shown,
    truncated: ranked.length > TOP,
    rows_not_shown: Math.max(0, ranked.length - TOP),
    generic_rule: `a trigger claimed by ${GENERIC_AT} or more modules is generic: listed in generic_triggers with its module count, never with its modules, and not paired`,
    generic_triggers_not_listed: generic.length,
    generic_triggers: generic,
  };
}

/** C-I: line_count_estimate and version drift against the module's own file and record. */
/** R19: field_unmaintained is decided only on at least this many modules stating the field. */
const LINE_FIELD_MIN_SAMPLE = 10;
/** R19: above this share of drifting modules the field is unmaintained, not drifting. */
const LINE_FIELD_UNMAINTAINED_RATE = 0.5;

function checkI(snapshot, resolutions) {
  const lineDrift = [];
  const versionFindings = [];
  let withField = 0;
  // The event log, read once: the last recorded version per path.
  const lastVersion = new Map();
  for (const e of readModuleFileEvents({ include_snapshot: false, limit: 1000000 }, snapshot.paths).events) {
    if (e.version) lastVersion.set(e.path, e);
  }
  for (const r of resolutions) {
    // The compile's modules only (R13 gives unregistered single files a
    // resolved_path too; they are not part of this measurement).
    if (!r.resolved_path || !r.loadable) continue;
    const f = snapshot.scan.files.find((x) => x.path === r.resolved_path);
    if (!f) continue;
    const stated = f.frontmatter.line_count_estimate;
    const actual = compileLines(f.text);
    if (typeof stated === 'number') withField += 1;
    if (typeof stated === 'number' && stated !== actual) {
      lineDrift.push({ id: r.id, path: f.path, kind: 'line_count_estimate', stated, actual,
        factor: Number((Math.max(stated, actual) / Math.max(1, Math.min(stated, actual))).toFixed(2)), confidence: 'high' });
    }
    if (f.frontmatter.version) {
      const ev = lastVersion.get(f.path);
      if (ev && ev.version !== f.frontmatter.version) {
        versionFindings.push({ id: r.id, path: f.path, kind: 'version', stated: f.frontmatter.version, last_event_version: ev.version, last_event_action: ev.action, last_event_at: ev.at, confidence: 'medium' });
      }
    }
  }
  // R19: the worst ten by factor (then by absolute difference), with both numbers.
  lineDrift.sort((a, b) => b.factor - a.factor || Math.abs(b.stated - b.actual) - Math.abs(a.stated - a.actual) || a.id.localeCompare(b.id));
  const WORST = 10;
  const worst = lineDrift.slice(0, WORST);
  const rate = withField ? lineDrift.length / withField : 0;
  const decided = withField >= LINE_FIELD_MIN_SAMPLE;
  return {
    name: 'Version and line_count_estimate drift',
    severity: 'low',
    note: 'The version half compares against module_file_events, which records quarantine, restore and purge only; a module that has never been through one has no recorded version to drift from.',
    line_count_estimate: {
      modules_stating_field: withField,
      drift_count: lineDrift.length,
      drift_rate: Number(rate.toFixed(4)),
      threshold: `field_unmaintained when more than ${LINE_FIELD_UNMAINTAINED_RATE * 100}% of the compile's modules that state line_count_estimate drift from their file, decided on at least ${LINE_FIELD_MIN_SAMPLE} such modules`,
      field_unmaintained: decided ? rate > LINE_FIELD_UNMAINTAINED_RATE : null,
      ...(decided ? {} : { field_unmaintained_reason: `only ${withField} module(s) state the field; the flag is not decided below ${LINE_FIELD_MIN_SAMPLE}` }),
      diagnosis: decided && rate > LINE_FIELD_UNMAINTAINED_RATE
        ? 'a field nobody maintains, not drift in a maintained field: the remedy differs from correcting individual estimates'
        : null,
      worst,
      truncated: lineDrift.length > WORST,
      rows_not_shown: Math.max(0, lineDrift.length - WORST),
    },
    findings: [...worst, ...versionFindings],
    version_drift_count: versionFindings.length,
  };
}

/** C-L: string fields where a name is expected (a double space there is a lost character). */
const NAME_KEYS = new Set(['id', 'title', 'category', 'keywords', 'phrases', 'task_class', 'provides', 'depends_on', 'module_to_add']);

/** A fragment entry's path: declared, else the one the merge infers. */
function entryPathOf(snapshot, entry) {
  return entry.path || inferModulePath(snapshot.paths.avaDir, entry, snapshot.exists || existsSync) || null;
}

/**
 * C-L (S1): derived registration quality, over every module entry in every
 * references/manifest fragment and every string in those fragments. Advisory:
 * it never blocks and is never added to the deterministic results.
 */
export function checkL(snapshot) {
  const findings = [];
  const fragments = snapshot.registrations.fragments || [];
  let entries = 0;
  for (const frag of fragments) {
    const source = `references/manifest/${frag.file}`;
    for (const m of frag.modules) {
      entries += 1;
      const id = String(m.id);
      const path = entryPathOf(snapshot, m);
      const segments = path ? pathSegmentsOf(path) : new Set();
      const t = m.triggers && typeof m.triggers === 'object' ? m.triggers : {};
      for (const p of (Array.isArray(t.phrases) ? t.phrases : [])) {
        if (typeof p === 'string' && phraseEndsWithStopword(p)) findings.push({ kind: 'stopword_phrase', source, id, value: p, detail: 'the phrase ends in a stopword' });
      }
      for (const k of (Array.isArray(t.keywords) ? t.keywords : [])) {
        if (typeof k !== 'string') continue;
        const why = keywordLintReason(k, segments);
        if (why && why !== 'empty') findings.push({ kind: segments.has(k.trim().toLowerCase()) ? 'path_segment_keyword' : 'forbidden_keyword', source, id, value: k, path, detail: why });
      }
      const f = path ? snapshot.scan.files.find((x) => x.path === path) : null;
      if (f) {
        const fmVersion = f.frontmatter && f.frontmatter.version;
        if (m.version !== undefined && m.version !== null && fmVersion && String(m.version) !== String(fmVersion)) {
          findings.push({ kind: 'stale_version', source, id, value: String(m.version), frontmatter_version: String(fmVersion), path, detail: 'the registration\'s version differs from the module\'s frontmatter' });
        }
        if (typeof m.line_count_estimate === 'number' && f.lines > 0 && Math.abs(m.line_count_estimate - f.lines) / f.lines > 0.2) {
          findings.push({ kind: 'line_count_drift', source, id, value: m.line_count_estimate, actual_lines: f.lines, path,
            detail: `line_count_estimate ${m.line_count_estimate} differs from the file's ${f.lines} lines by more than 20 per cent` });
        }
      }
      for (const v of (Array.isArray(m.provides) ? m.provides : [])) {
        if (typeof v === 'string' && /\s/.test(v.trim())) findings.push({ kind: 'provides_not_a_token', source, id, value: v, detail: 'a provides value with a space: a heading or a phrase, not a capability token' });
      }
    }
    // Every string in the fragment: a replacement character anywhere, a double space where a name is expected.
    const walk = (value, where, key) => {
      if (typeof value === 'string') {
        if (value.includes('\uFFFD')) findings.push({ kind: 'replacement_character', source, where, value, detail: 'contains U+FFFD: a character was lost when this was written' });
        else if (NAME_KEYS.has(key) && value.includes('  ')) findings.push({ kind: 'double_space', source, where, value, detail: 'a double space where a name is expected: a character may have been dropped' });
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${where}[${i}]`, key));
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, where ? `${where}.${k}` : k, k);
      }
    };
    walk({ modules: frag.modules, references: frag.references, dispatch_rules: frag.dispatch_rules,
      mandatory_for_triggers: frag.mandatory_for_triggers, tag_web: frag.tag_web }, '', null);
  }
  const byKind = {};
  for (const x of findings) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  return {
    name: 'Derived registration quality',
    severity: 'low',
    advisory: true,
    blocks: false,
    scope: 'every module entry in references/manifest/*.json, and every string in those fragments',
    fragments_read: fragments.length,
    entries_read: entries,
    finding_count: findings.length,
    by_kind: byKind,
    findings,
    note: 'Advisory: C-L never blocks. Phrase and keyword findings use the rules module_write now applies on write (WO-2026-11-21-02 P4, P5); a keyword is a path segment when it equals a directory on the module\'s path or its file name.',
  };
}

/**
 * R1-R4: the registration repair report. Read-only: it proposes and never applies.
 *
 *   R1  selected: every fragment registration with triggers_source absent or
 *       "derived", or with a phrase failing the P5 lint.
 *   R2  proposed: the entry module_write would now derive from the module's own
 *       frontmatter (frontmatter triggers where there are any, otherwise empty
 *       with a warning).
 *   R3  each module needs Brian's approval, put to him once with this evidence.
 *   R4  an entry that already passes every rule (a hand correction) is listed
 *       with no change proposed, so the report never proposes reverting one.
 */
export function registrationRepairReport(snapshot, cl = checkL(snapshot)) {
  const rows = [];
  const regs = snapshot.registrations;
  for (const r of regs) {
    if (r.kind !== 'manifest_fragment') continue;
    const e = r.entry || {};
    const ts = e.triggers_source;
    const t = e.triggers && typeof e.triggers === 'object' ? e.triggers : {};
    const phrases = (Array.isArray(t.phrases) ? t.phrases : []).filter((p) => typeof p === 'string');
    const phraseFailures = phrases.map((p) => ({ phrase: p, reasons: phraseLintReasons(p, phrases) })).filter((x) => x.reasons.length);
    if (!(ts === undefined || ts === null || ts === 'derived' || phraseFailures.length)) continue;

    const path = entryPathOf(snapshot, e);
    const segments = path ? pathSegmentsOf(path) : new Set();
    const keywordFailures = (Array.isArray(t.keywords) ? t.keywords : []).filter((k) => typeof k === 'string')
      .map((k) => ({ keyword: k, reason: keywordLintReason(k, segments) })).filter((x) => x.reason);
    const quality = cl.findings.filter((x) => x.source === r.source && x.id === r.id);
    const defects = phraseFailures.length + keywordFailures.length + quality.length;
    const frozen = regs.filter((x) => x.id === r.id && (x.kind === 'manifest' || x.kind === 'manifest_append')).map((x) => x.source);
    const atPath = regs.filter((x) => x.id === r.id && x.kind === 'manifest_fragment' && entryPathOf(snapshot, x.entry || {}) === path);
    const updatedByModuleWrite = !frozen.length && atPath.length > 0 && atPath[0].source === r.source;
    const f = path ? snapshot.scan.files.find((x) => x.path === path) : null;

    let proposed = null;
    let proposalNote;
    if (!defects) {
      proposalNote = 'No change proposed: the entry passes every P4, P5 and C-L rule (a hand correction, R4, or a clean entry without the marker).';
    } else if (!f) {
      proposalNote = `No proposal: no module file at ${path || '(no path)'}, so there is no frontmatter to derive from.`;
    } else {
      const d = deriveRegistration(path.replace(/^modules\//, ''), f.text, {}, {});
      const fm = readRegistrationFrontmatter(f.text);
      proposed = {
        triggers: d.entry.triggers,
        triggers_source: d.entry.triggers_source,
        provides: d.entry.provides,
        title: d.entry.title,
        ...(d.entry.version !== undefined ? { version: d.entry.version } : {}),
        line_count_estimate: d.entry.line_count_estimate,
        warnings: d.warnings.map((w) => w.message),
        ...(d.refusal ? { refusal: d.refusal.message } : {}),
      };
      proposalNote = fm.has_triggers
        ? 'Proposed from the module\'s frontmatter triggers.'
        : 'The module has no frontmatter triggers: proposed with an empty trigger set (reachable by explicit load only), and a warning.';
    }
    rows.push({
      id: r.id,
      source: r.source,
      path,
      status: defects ? 'auto_derived_defects' : 'passes_lint_without_marker',
      triggers_source: ts === undefined ? null : ts,
      phrase_failures: phraseFailures,
      keyword_failures: keywordFailures,
      quality_findings: quality.map((x) => ({ kind: x.kind, value: x.value, detail: x.detail })),
      current: { triggers: e.triggers || null, provides: e.provides || null, title: e.title || null, version: e.version ?? null, line_count_estimate: e.line_count_estimate ?? null },
      proposed,
      proposal_note: proposalNote,
      ...(frozen.length ? { frozen_manifest: frozen, frozen_note: 'This id is registered in a frozen manifest, which the compile reads first; this fragment entry is shadowed. module_write writes no fragment for it (Q4), so applying a change here is an external edit.' } : {}),
      approval_required: Boolean(defects),
      apply_route: !defects ? null
        : updatedByModuleWrite
          ? 'After Brian approves this module: module_write with force: true on the module\'s current content, passing manifest_entry: { triggers, provides } as proposed (an explicit empty triggers object registers it with none). The registration is updated in place.'
          : (frozen.length ? 'External: see frozen_note.' : 'This is not the registration module_write updates for this id and path (another comes first): a duplicate, whose removal is a per-id dispatch decision outside this order.'),
    });
  }
  return {
    read_only: true,
    approval: 'No repair is applied without Brian\'s approval for that module (R3): triggers are dispatch-layer content, and a dispatch change is put to him once, as a question, with this evidence.',
    selection: 'fragment registrations with triggers_source absent or "derived", or with a phrase failing the P5 lint (R1)',
    selected: rows.length,
    with_defects: rows.filter((x) => x.status === 'auto_derived_defects').length,
    without_defects: rows.filter((x) => x.status === 'passes_lint_without_marker').length,
    modules: rows,
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
// R6 / R7 (D11): divergent ids registered in a frozen manifest
// ---------------------------------------------------------------------------

/**
 * Every divergent module id with a registration in MANIFEST.json or
 * MANIFEST_APPEND.json (declared or path-less). Report only: reconciling a
 * divergent group is external to this tooling (D11), and nothing here edits a
 * registration. An empty list is the invariant holding, measured this run.
 */
function divergentFrozenRegistration(snapshot, groups, floorStatus) {
  const findings = [];
  for (const g of groups) {
    if (g.classification !== 'divergent') continue;
    const frozen = snapshot.registrations.filter((r) => r.id === g.id && (r.kind === 'manifest' || r.kind === 'manifest_append'));
    if (!frozen.length) continue;
    findings.push({
      id: g.id,
      registrations: frozen.map((r) => ({ fragment: r.source, path: r.path, declared_path: r.declared_path })),
      resolved_path: g.resolved_path,
      resolved_is_registered: g.resolved_is_registered,
      ...(g.resolved_is_registered ? {} : { registered_path: g.registered_path ?? null }),
      siblings: g.files.map((f) => ({ path: f.path, sha256: f.sha256, size_bytes: f.size_bytes, lines: f.lines, is_resolved: f.is_resolved })),
    });
  }
  const divergentGroups = groups.filter((g) => g.classification === 'divergent');
  return {
    invariant: 'D11: MANIFEST.json and MANIFEST_APPEND.json carry no divergent module registration',
    status: floorStatus === 'unverified' ? 'unverified' : (findings.length ? 'findings' : 'clean'),
    holds: floorStatus === 'unverified' ? null : findings.length === 0,
    divergent_groups_checked: divergentGroups.length,
    resolved_is_registered_false: divergentGroups.filter((g) => !g.resolved_is_registered).map((g) => ({ id: g.id, resolved_path: g.resolved_path,
      registered_path: g.registered_path ?? null, registered_paths: g.registered_paths || [] })),
    findings,
    report_only: true,
    reconciliation: 'external (D11): a per-group human decision; the registration change is a dispatch-layer amendment made one id at a time outside this tooling',
  };
}

// ---------------------------------------------------------------------------
// R16: nested module trees, one finding per tree, report only
// ---------------------------------------------------------------------------

function nestedModuleTrees(snapshot, grouped, floorStatus) {
  const unregistered = new Set((grouped.registration.files_without_manifest_entry || []).map((f) => f.path));
  const trees = new Map();
  for (const f of snapshot.scan.files) {
    const segs = f.path.split('/');
    // segs[0] is the modules root itself; the OUTERMOST further directory named
    // "modules" is the root of a nested tree.
    const at = segs.findIndex((s, i) => i >= 1 && i < segs.length - 1 && s === 'modules');
    if (at < 0) continue;
    const root = `${segs.slice(0, at + 1).join('/')}/`;
    if (!trees.has(root)) trees.set(root, []);
    trees.get(root).push({ f, sub: segs.length - 1 > at + 1 ? segs[at + 1] : null });
  }
  const findings = [];
  for (const [root, entries] of [...trees.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const inTree = new Set(entries.map((e) => e.f.path));
    const outsideIds = new Set(snapshot.scan.files.filter((x) => x.kind === 'module' && !inTree.has(x.path)).map((x) => x.id));
    const ids = [...new Set(entries.filter((e) => e.f.kind === 'module').map((e) => e.f.id))].sort();
    findings.push({
      tree: root,
      file_count: entries.length,
      module_file_count: entries.filter((e) => e.f.kind === 'module').length,
      subdirectories: [...new Set(entries.map((e) => e.sub).filter(Boolean))].sort(),
      ids_duplicated: ids.filter((id) => outsideIds.has(id)),
      ids_only_in_tree: ids.filter((id) => !outsideIds.has(id)),
      unregistered_files: entries.filter((e) => unregistered.has(e.f.path)).length,
      registered_files: entries.filter((e) => e.f.kind === 'module' && !unregistered.has(e.f.path)).map((e) => e.f.path),
    });
  }
  return {
    status: floorStatus === 'unverified' ? 'unverified' : (findings.length ? 'findings' : 'clean'),
    trees: findings.length,
    findings,
    report_only: true,
    note: 'Reported as one finding per tree. Removal is out of scope here: module_delete operates on files, and a directory-level operation needs a restore route of its own first.',
  };
}

// ---------------------------------------------------------------------------
// R10: tiers and the register of accepted findings
// ---------------------------------------------------------------------------

/** Where the register lives: SKILL_AUDIT_ACCEPTED_REGISTER, else {avaDir}audit/accepted_findings.json. */
export function acceptedRegisterPath(paths) {
  const set = process.env.SKILL_AUDIT_ACCEPTED_REGISTER;
  if (set && set.trim()) return isAbsolute(set.trim()) ? set.trim() : join(paths.avaDir, set.trim());
  return join(paths.avaDir, 'audit', 'accepted_findings.json');
}

/** A register match pattern: literal text, with * matching any run of characters. */
function patternToRegex(p) {
  return new RegExp(`^${String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * Read the register. Hand-edited data; the audit reads it and never writes it.
 * An entry without an id, a match, a reason and an accepted date (YYYY-MM-DD)
 * is reported as invalid and NOT applied, so an unexplained acceptance cannot
 * hide a finding. An unreadable register applies nothing, and says so.
 */
export function loadAcceptedRegister(paths) {
  const path = acceptedRegisterPath(paths);
  const base = { path, present: existsSync(path), entries: [], invalid_entries: [] };
  if (!base.present) return { ...base, status: 'absent' };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    return { ...base, status: 'unreadable', error: err.message };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
  if (!list) return { ...base, status: 'unreadable', error: 'expected an array, or an object with an "entries" array' };
  list.forEach((e, index) => {
    const problems = [];
    const id = e && typeof e.id === 'string' ? e.id.trim() : '';
    const match = e ? (typeof e.match === 'string' ? [e.match] : (Array.isArray(e.match) ? e.match.filter((m) => typeof m === 'string' && m.trim()) : [])) : [];
    if (!id) problems.push('id is required');
    if (!match.length) problems.push('match is required: a finding key, or a list of them, with * as a wildcard');
    if (!e || typeof e.reason !== 'string' || !e.reason.trim()) problems.push('reason is required');
    if (!e || typeof e.accepted !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.accepted)) problems.push('accepted is required, as YYYY-MM-DD');
    if (problems.length) { base.invalid_entries.push({ index, id: id || null, problems }); return; }
    base.entries.push({ id, match, reason: e.reason.trim(), accepted: e.accepted, regexes: match.map(patternToRegex) });
  });
  return { ...base, status: 'read' };
}

/** Stable keys for every finding a deterministic check returned (the register matches these). */
function findingKeys(name, c) {
  switch (name) {
    case 'C-A': return [
      ...c.manifest_entries_without_file.map((e) => `C-A:entry:${e.source}:${e.id}`),
      ...c.files_without_manifest_entry.map((f) => `C-A:file:${f.path}`),
    ];
    case 'C-B': return c.groups.map((g) => `C-B:${g.id}`);
    case 'C-C': return [...c.findings.map((f) => `C-C:${f.id}`), ...(c.multi_id_files || []).map((m) => `C-C:multi_id_file:${m.path}`)];
    case 'C-D': return [
      ...c.canonical_missing.map((n) => `C-D:missing:${n}`),
      ...(c.references_manifest_present ? [] : ['C-D:references_manifest_absent']),
      ...c.shadow_copies.map((s) => `C-D:shadow:${s.path}`),
    ];
    case 'C-F': return c.findings.map((f) => `C-F:${f.id}`);
    default: return [];
  }
}

/**
 * Classify every deterministic finding: accepted when a valid register entry
 * matches its key; otherwise blocking when its check is C-A, C-C or C-D;
 * otherwise new. Returns the headline and the per-check breakdown.
 */
function classifyTiers(deterministic, ran, register, detStatus) {
  const used = new Map();
  const byCheck = {};
  const blocking = [];
  const fresh = [];
  let accepted = 0;
  for (const name of ran) {
    const keys = findingKeys(name, deterministic[name]);
    const row = { findings: keys.length, blocking: 0, accepted: 0, new: 0, accepted_by: {} };
    for (const key of keys) {
      const entry = register.entries.find((e) => e.regexes.some((rx) => rx.test(key)));
      if (entry) {
        row.accepted += 1; accepted += 1;
        row.accepted_by[entry.id] = (row.accepted_by[entry.id] || 0) + 1;
        used.set(entry.id, (used.get(entry.id) || 0) + 1);
      } else if (BLOCKING_BY_DEFAULT.includes(name)) {
        row.blocking += 1; blocking.push(key);
      } else {
        row.new += 1; fresh.push(key);
      }
    }
    const entries = Object.keys(row.accepted_by);
    row.headline = !keys.length ? `${name}: clean`
      : row.accepted === keys.length
        ? `${name}: ${keys.length} finding${keys.length === 1 ? '' : 's'}, all accepted (register entr${entries.length === 1 ? 'y' : 'ies'} ${entries.join(', ')})`
        : `${name}: ${keys.length} finding${keys.length === 1 ? '' : 's'}: ${row.blocking} blocking, ${row.accepted} accepted${entries.length ? ` (${entries.join(', ')})` : ''}, ${row.new} new`;
    byCheck[name] = row;
  }
  const headline = detStatus === 'unverified' ? 'unverified: the floor failed, so no finding was classified'
    : detStatus === 'not_run' ? 'not_run: no deterministic check was executed, so no finding was classified'
      : `${blocking.length} blocking, ${accepted} accepted, ${fresh.length} new`;
  return {
    headline,
    status: detStatus,
    blocking: blocking.length,
    accepted,
    new: fresh.length,
    rule: `accepted: matched by a valid register entry; blocking: otherwise, from ${BLOCKING_BY_DEFAULT.join(', ')}; new: otherwise`,
    by_check: byCheck,
    blocking_findings: blocking,
    new_findings: fresh,
    register: {
      path: register.path,
      present: register.present,
      status: register.status,
      ...(register.error ? { error: register.error } : {}),
      valid_entries: register.entries.length,
      invalid_entries: register.invalid_entries,
      entries_matching_nothing: register.entries.filter((e) => !used.has(e.id)).map((e) => e.id),
      maintained_by: 'hand; the audit reads the register and never adds or removes an entry',
      key_formats: ['C-A:entry:<source>:<id>', 'C-A:file:<path>', 'C-B:<id>', 'C-C:<id>', 'C-C:multi_id_file:<path>',
        'C-D:missing:<name>', 'C-D:references_manifest_absent', 'C-D:shadow:<path>', 'C-F:<id>'],
    },
  };
}

// ---------------------------------------------------------------------------
// R9: the status builder
// ---------------------------------------------------------------------------

/**
 * deterministic.status: exactly one of clean, findings, not_run, unverified.
 * The floor comes first; a run that executed nothing is not_run; only a run in
 * which every requested check ran and passed is clean. No default resolves
 * toward success.
 */
export function deterministicStatus({ floorStatus, ran, failed }) {
  if (floorStatus === 'unverified') return 'unverified';
  if (!ran.length) return 'not_run';
  return failed.length ? 'findings' : 'clean';
}

/** Why a requested check is not among those that ran in the deterministic section. */
function skipReason(check, floorStatus) {
  if (DETERMINISTIC_CHECKS.includes(check)) {
    return floorStatus === 'unverified'
      ? 'the floor failed (no module was read, or the scan was truncated): the check was evaluated over nothing, so its pass is null and it did not run'
      : 'not run';
  }
  if (ADVISORY_CHECKS.includes(check)) return `${check} is advisory, not a deterministic check; its result is under advisory`;
  if (JUDGMENT_CHECKS.includes(check)) return `${check} is a judgment check, not a deterministic check; its result is under judgment`;
  return `unknown check name; the checks are ${[...DETERMINISTIC_CHECKS, ...ADVISORY_CHECKS, ...JUDGMENT_CHECKS].join(', ')}`;
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

  const groups = duplicateGroups(snapshot, resolutions);
  const inverse = idsByFile(resolutions);

  const deterministic = {};
  if (on('C-A')) deterministic['C-A'] = checkA(grouped);
  if (on('C-B')) deterministic['C-B'] = checkB(groups);
  if (on('C-C')) deterministic['C-C'] = checkC(resolutions, inverse);
  if (on('C-D')) deterministic['C-D'] = checkD(snapshot);
  if (on('C-F')) deterministic['C-F'] = checkF(snapshot, resolutions);
  if (floor.status === 'unverified') {
    for (const c of Object.values(deterministic)) { c.pass = null; c.status = 'unverified'; }
  }
  // R9: what was asked for, what ran, what did not and why.
  const requested = want ? [...want] : [...DETERMINISTIC_CHECKS];
  const ran = floor.status === 'unverified' ? [] : Object.keys(deterministic);
  const skipped = requested.filter((c) => !ran.includes(c)).map((check) => ({ check, reason: skipReason(check, floor.status) }));
  const failed = ran.filter((k) => deterministic[k].pass === false);
  const detStatus = deterministicStatus({ floorStatus: floor.status, ran, failed });

  // R10: tiers over the deterministic findings that ran.
  const tiers = classifyTiers(deterministic, ran, loadAcceptedRegister(paths), detStatus);

  // R17: the aggregate on every run.
  const e = checkE(snapshot, resolutions);

  const advisory = {};
  if (on('C-E')) advisory['C-E'] = e;
  if (on('C-G')) advisory['C-G'] = checkG(snapshot, resolutions);
  if (on('C-H')) advisory['C-H'] = checkH(snapshot, resolutions);
  if (on('C-I')) advisory['C-I'] = checkI(snapshot, resolutions);
  const cl = (on('C-L') || args.registration_repair_report === true) ? checkL(snapshot) : null;
  if (on('C-L')) advisory['C-L'] = cl;

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
    // R10: the report opens with the tier headline, not a flat pass/fail.
    headline: tiers.headline,
    audit: 'skill_consistency_audit',
    read_only: true,
    status: floor.status,
    tiers,
    floor,
    deterministic: {
      status: detStatus,
      status_meanings: STATUS_MEANINGS,
      requested,
      ran,
      skipped,
      checks_run: ran,
      checks_with_findings: failed,
      ...deterministic,
    },
    divergent_frozen_registration: divergentFrozenRegistration(snapshot, groups, floor.status),
    nested_module_trees: nestedModuleTrees(snapshot, grouped, floor.status),
    always_load_aggregate: alwaysLoadAggregate(e),
    advisory,
    judgment,
    registered_module_ids: resolutions.filter((r) => r.registered).map((r) => r.id),
    ...(args.registration_repair_report === true ? { registration_repair_report: registrationRepairReport(snapshot, cl) } : {}),
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
    + 'version drift; C-L derived registration quality (stopword phrases, path-segment keywords, stale version, line count off '
    + 'by more than 20%, provides with a space, U+FFFD or a double space in a fragment string). C-F also judges each duplicate: '
    + 'a defect when more than one registration was created by module_write, told apart from registrations that predate the '
    + 'tool. registration_repair_report: true adds a read-only report of auto-derived fragment registrations with a proposed '
    + 'corrected entry for each; nothing is applied without Brian\'s per-module approval. '
    + 'Judgment: C-J one-sided disagreement records; C-K provenance contradictions from '
    + 'vault_provenance_audit. Every run reports what it read; a run that read nothing reports unverified, never clean. '
    + 'deterministic.status is exactly one of clean (every requested check ran and passed), findings, not_run (no '
    + 'requested check executed, e.g. checks: ["C-E"]) or unverified (the floor failed), with requested, ran and '
    + 'skipped [{check, reason}]. The report opens with a tier headline ("3 blocking, 41 accepted, 0 new"): a finding '
    + 'matched by the hand-maintained register of accepted findings (audit/accepted_findings.json, or '
    + 'SKILL_AUDIT_ACCEPTED_REGISTER) is accepted, otherwise C-A, C-C and C-D findings are blocking, otherwise new; the '
    + 'audit never edits the register. Also on every run: divergent_frozen_registration (the D11 invariant that no '
    + 'divergent id is registered in MANIFEST.json or MANIFEST_APPEND.json, with resolved_is_registered per group; '
    + 'report only), nested_module_trees (one finding per nested modules/ tree; report only) and always_load_aggregate '
    + '(bytes, estimated tokens, the estimator by name, and the ceiling stated as a policy figure).',
  inputSchema: {
    type: 'object',
    properties: {
      checks: { type: 'array', items: { type: 'string' }, description: 'Optional subset, e.g. ["C-A","C-B"]. Default: every check.' },
      registration_repair_report: { type: 'boolean', description: 'Add the read-only registration repair report (WO-2026-11-21-02 R1-R4): every fragment registration that looks auto-derived, with a proposed corrected entry. Proposes only; each repair needs Brian\'s approval for that module. Default false.' },
    },
    required: [],
  },
};

export function handleSkillConsistencyAudit(args = {}) {
  const out = runConsistencyAudit(args || {});
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}
