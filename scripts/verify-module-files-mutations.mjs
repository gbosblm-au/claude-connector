#!/usr/bin/env node
/**
 * scripts/verify-module-files-mutations.mjs   (connector v13.39.0: WO-2026-11-20-03 rev 2, WO-2026-11-21-01)
 *
 * The mutation lifecycle for the resolver, the audits and the quarantine.
 * For each mutation: the claim's tests pass on this tree (control, at least
 * one executed), the mutation is applied to a scratch copy of src/ (each find
 * text must occur exactly once), and the same tests must then FAIL.
 *
 *   node scripts/verify-module-files-mutations.mjs            all
 *   node scripts/verify-module-files-mutations.mjs C-D4.5     one claim
 *
 * Exit 0 when every mutation reddened its tests and every control was green.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "src/tests/module-files.test.js";
const MF = "src/tools/module-files.js";
const MC = "src/tools/module-consistency.js";
const SK = "src/tools/skill.js";
const SM = "src/tools/skill-modular.js";
const MT = "src/tools/module-file-tools.js";
// v13.39.0 (WO-2026-11-21-01): the order's own pins live in their own test file.
const TEST_WO = "src/tests/module-integrity-wo-2026-11-21-01.test.js";
const SC = "src/tools/skill-content.js";
const m = (claim, name, pattern, file, find, replace) => ({ claim, name, pattern, edits: [{ file, find, replace }] });
const w = (claim, name, pattern, file, find, replace) => ({ claim, name, pattern, test: TEST_WO, edits: [{ file, find, replace }] });

const MUTATIONS = [
  // D3 / R4
  m("C-D3", "the resolver takes the FIRST entry (skill_load_specialist's rule), not the compile's", "D3: the resolver names", MF,
    "      if (m && m.id !== undefined) idx.set(m.id, [i, m]);", "      if (m && m.id !== undefined && !idx.has(m.id)) idx.set(m.id, [i, m]);"),
  m("C-D3", "the compile looks up its own path again", "D3 \\(structural\\)", SM,
    "    const modulePath = resolveModulePath(id, { paths, manifest }).resolved_path_absolute;", "    const modulePath = module.path ? paths.avaDir + module.path : null;"),
  m("C-R4", "an inferred fragment path is reported as declared", "inferred fragment path", MF,
    "(inferred ? 'inferred_fallback' : 'declared')", "('declared')"),
  m("C-R4", "an unregistered file is reported as resolved by nothing", "directory walk only", MF,
    "(existing.length ? 'directory_walk' : 'none')", "('none')"),
  // R5 / D10
  m("C-R5", "distinct files counted as paths", "R4/R5", SK, "    distinct_files: distinctContents.size,", "    distinct_files: scan.files.length,"),
  m("C-D10", "skill_audit of an empty tree reports verified", "D10: skill_audit over an empty", SK,
    "    status: mdFiles.length === 0 || scan.truncated ? 'unverified' : 'verified',", "    status: 'verified',"),
  m("C-D10", "the consistency audit of an empty set lets its checks pass", "8.18", MC,
    "    for (const c of Object.values(deterministic)) { c.pass = null; c.status = 'unverified'; }", ""),
  // 5.1
  m("C-A", "manifest entries with no file are not reported", "C-A \\(8.19, one side\\)", SK,
    "      entriesWithoutFile.push({ id: r.id, path: p, source: r.source,", "      if (false) entriesWithoutFile.push({ id: r.id, path: p, source: r.source,"),
  m("C-A", "files with no entry are not reported", "C-A \\(8.19, the other side\\)", SK,
    "  const filesWithoutEntry = mdFiles.filter((f) => !registeredPaths.has(f.path))", "  const filesWithoutEntry = mdFiles.filter((f) => false)"),
  m("C-B", "classification by size, not hash", "C-B:", MC,
    "    const hashes = new Set(files.map((f) => f.sha256));", "    const hashes = new Set(files.map((f) => f.size_bytes));"),
  m("C-C", "ambiguity resolved silently", "C-C:", MC,
    "    if (r.ambiguous) problems.push('ambiguous: more than one existing file or registered path for this id');\n", ""),
  m("C-D", "shadow copies are not looked for", "C-D:", MC,
    "    if (!PROTECTED_BASENAMES.includes(base) && !underManifest) continue;", "    continue;"),
  m("C-F", "an id registered twice is not reported", "C-F:", MC,
    "    if (sources.length < 2 && regs.length < 2) continue;", "    continue;"),
  // 5.2 / 5.3
  m("C-E", "the aggregate leaves the always-load modules out", "C-E:", MC,
    "  const totalBytes = moduleBytes + coreBytes;", "  const totalBytes = coreBytes;"),
  m("C-G", "a small sample is reported anyway", "below a ten-module sample", MC,
    "  if (sample.length < CAL_SAMPLE) {", "  if (false) {"),
  m("C-G", "a noisy check is reported, not dropped", "above twenty per cent", MC,
    "  if (rate > MAX_RATE) {", "  if (false) {"),
  m("C-G", "a missing capability is read as carried", "within twenty per cent", MC,
    "  if (b.includes(phrase)) return true;\n  const toks = significantTokens(phrase);\n  if (!toks.length) return true;\n  return toks.every((t) => b.includes(t));",
    "  return true;"),
  m("C-H", "a collision of two is not reported", "C-H:", MC, "    if (owners.size < 2) continue;", "    if (owners.size < 3) continue;"),
  m("C-I", "line_count_estimate drift is not reported", "C-I:", MC,
    "    if (typeof stated === 'number' && stated !== actual) {", "    if (false) {"),
  m("C-J", "a reciprocal disagreement is reported as one-sided", "C-J:", MC,
    "      if (mentions(textOf.get(b), a)) continue;\n", ""),
  // D4
  m("C-D4.1", "a protected name is accepted", "D4.1", MF,
    "  if (PROTECTED_BASENAMES.includes(parts[parts.length - 1]) || /(^|\\/)references\\/manifest\\//.test(inner)) {", "  if (false) {"),
  m("C-D4.1", "a path without the modules/ prefix is accepted", "D4.1", MF,
    "  if (!p || !p.startsWith(prefix) || p.length === prefix.length) {", "  if (!p) {"),
  m("C-D4.2", "no hash is accepted", "D4.2", MF, "  if (!expected) {\n    refusals.push({ code: REFUSAL.HASH_REQUIRED,", "  if (false) {\n    refusals.push({ code: REFUSAL.HASH_REQUIRED,"),
  m("C-D4.2", "a stale hash is accepted", "D4.2", MF, "  } else if (expected !== target.sha256) {", "  } else if (false) {"),
  m("C-D4.3", "the live copy may go with no replacement", "D4.3", MF, "  if (broken.ids.length) {\n    refusals.push({\n      code: REFUSAL.LIVE_COPY,", "  if (false) {\n    refusals.push({\n      code: REFUSAL.LIVE_COPY,"),
  m("C-D4.4", "the last file may go", "D4.4", MF, "  if (siblings.length === 0) {", "  if (false) {"),
  m("C-D4.5", "divergent copies need no acknowledgement", "D4.5 / 8.15", MF, "  if (divergent.length) {\n    const retained", "  if (false) {\n    const retained"),
  m("C-D4.5", "an acknowledgement needs no reason", "D4.5 / 8.15", MF, "    if (!ack || !retained || !reason) {", "    if (!ack || !retained) {"),
  m("C-D4.5", "the retained copy is the compile's, not the acknowledged one", "D4.5 / 8.15", MF,
    "    retained_path: (divergent.length && siblings.find((s) => s.sha256 === ack) || {}).path || afterResolution.resolved_path || null,",
    "    retained_path: afterResolution.resolved_path || null,"),
  m("C-D4.6", "an always_load module may be dropped", "D4.6", MF, "  if (broken.always_load.length) {", "  if (false) {"),
  m("C-FROZEN", "a MANIFEST.json registration is left pointing at nothing", "fail closed", MF, "  if (plan.frozen.length) {", "  if (false) {"),
  // D6 / R2 / D1 / D5 / R3
  m("C-D6", "the quarantined file's registration is left in place", "D6 / R6", MF,
    "        obj.modules = obj.modules.filter((m) => !(m && removeIds.has(`${m.id}\\u0000${m.path || ''}`)));", "        obj.modules = obj.modules.slice();"),
  m("C-R2", "a restore overwrites an occupied location", "onto an occupied location", MF,
    "  if (existsSync(originalFull)) refusals.push(", "  if (false) refusals.push("),
  m("C-R2", "a restore re-inserts instead of putting the fragment back", "R2 / 8.17", MF,
    "    if (r.fragment_before && r.fragment_after_sha256 && sha256Hex(readFileSync(full)) === r.fragment_after_sha256) {", "    if (false) {"),
  m("C-D1", "a purge reaches into modules/", "D1 / D5", MT,
    "    const out = a.purge === true ? purgeQuarantinedFile(a, context) : quarantineModuleFile(a, context);",
    "    const out = a.purge === true && String(a.file).startsWith('quarantine/') ? purgeQuarantinedFile(a, context) : quarantineModuleFile({ ...a, purge: undefined }, context);"),
  m("C-D5", "a purge record does not keep the content", "D1 / D5", MF,
    "    event_id: randomUUID(), id: ev ? ev.id : fileModuleId(t.rel, bytes.toString('utf8')).id, path: t.rel, action: 'purged',\n    sha256: sha, size_bytes: bytes.length, ...snapshotOf(bytes),",
    "    event_id: randomUUID(), id: ev ? ev.id : fileModuleId(t.rel, bytes.toString('utf8')).id, path: t.rel, action: 'purged',\n    sha256: sha, size_bytes: bytes.length,"),
  m("C-R3", "the event log returns snapshots by default", "R3:", MF, "  if (filter.include_snapshot !== true) {", "  if (false) {"),

  // ── WO-2026-11-21-01 ────────────────────────────────────────────────────
  // Section 11, named by the order: break the resolver call in module_write.
  w("WO-R1", "module_write does not call the resolver", "R2: a second file", SC,
    "    writeGuard = moduleWriteGuard({",
    "    writeGuard = ({ applies: false, verdict: 'skipped', ids: [], redirected: false, resolutions: [], refusals: [] }) || moduleWriteGuard({"),
  w("WO-R1", "the frontmatter id is ignored", "R1: the id comes from the frontmatter", MF,
    "    return fileModuleId(relPath, content).id;", "    return basename(relPath).replace(/\\.(md|json)$/i, '');"),
  w("WO-R2", "an id resolving elsewhere is not a conflict", "R2: a second file", MF,
    "    if (!conflict) continue;", "    continue;"),
  w("WO-R2", "any acknowledgement redirects", "R2 route", MF,
    "    const canRedirect = ack && targets.length === 1 && targets[0] && ack === targets[0] && targets[0].startsWith('modules/');",
    "    const canRedirect = ack && targets.length === 1 && targets[0];"),
  w("WO-R3", "force may turn one id into another", "R3:", MF, "    if (other !== undefined) {", "    if (false) {"),
  w("WO-R4", "the guard always refuses", "R4:", MF,
    "    const conflict = target ? requested !== target : (occupied.length > 0 && !occupied.includes(requested));", "    const conflict = true;"),
  w("WO-R5", "the dry run skips the guard", "R5:", SC, "  if (writeGuard.refusals.length) {", "  if (writeGuard.refusals.length && !dryRun) {"),
  // Section 11, named by the order: return clean unconditionally from the status builder.
  w("WO-R9", "the status builder returns clean unconditionally", "R9 ", MC,
    "  if (floorStatus === 'unverified') return 'unverified';\n  if (!ran.length) return 'not_run';\n  return failed.length ? 'findings' : 'clean';",
    "  return 'clean';"),
  w("WO-R10", "the register is ignored", "R10: the register", MC,
    "      const entry = register.entries.find((e) => e.regexes.some((rx) => rx.test(key)));", "      const entry = null;"),
  w("WO-R10", "C-A is not blocking by default", "R10: the register", MC,
    "      } else if (BLOCKING_BY_DEFAULT.includes(name)) {", "      } else if (false) {"),
  w("WO-R10", "an invalid register entry is applied", "R10: the register", MC,
    "    if (problems.length) { base.invalid_entries.push({ index, id: id || null, problems }); return; }",
    "    if (problems.length) { base.invalid_entries.push({ index, id: id || null, problems }); }"),
  w("WO-R11", "the log lives inside quarantine/", "R11:", MF,
    "export const EVENT_LOG_REL = 'module-history/module_file_events.jsonl';", "export const EVENT_LOG_REL = 'quarantine/module_file_events.jsonl';"),
  w("WO-R11", "the relocation is silent", "R11: a log left", MF,
    "  appendLine(mp.eventsFile, event);\n  log('warn', `[module_file_events] relocated", "  log('warn', `[module_file_events] relocated"),
  w("WO-R12", "an inferred path is presented as a registration", "R12: a path-less", MF,
    "      pathless.push({ source: r.source, id: r.id, path: null, declared_path: false });",
    "      { const ip = inferModulePath(paths.avaDir, r.entry, exists); if (ip) cand(ip).registered_in.push(r.source + ' (path inferred)'); }"),
  w("WO-R13", "a directory-walk resolution leaves resolved_path null", "R13:", MF,
    "  const walkPath = !winner && existing.length === 1 ? existing[0].path : null;", "  const walkPath = null;"),
  w("WO-R14", "a file claimed by two ids is not flagged", "R14:", MF, "    multi_id_file: ids.size > 1,", "    multi_id_file: false,"),
  w("WO-R6", "a frozen registration of a divergent id is not reported", "R6:", MC, "    if (!frozen.length) continue;", "    continue;"),
  w("WO-R7", "resolved_is_registered is asserted, not measured", "R7:", MC,
    "    const resolvedIsRegistered = Boolean(resolved) && registeredPaths.includes(resolved);", "    const resolvedIsRegistered = true;"),
  w("WO-R8", "the frozen refusal does not name the external route", "R8:", MF,
    "      reconciliation: 'external',\n      reconciliation_note: FROZEN_RECONCILIATION_NOTE,\n", ""),
  w("WO-R15", "the mirror restores a quarantined path", "R15: a mirror push skips", SM, "      if (q) {", "      if (false) {"),
  w("WO-R15", "a purged path is a mirror target again", "R15: after a restore", MF,
    "    if (e.action === 'quarantined' || e.action === 'purged') {", "    if (e.action === 'quarantined') {"),
  w("WO-R15", "a push may write the record or the quarantine", "R15 / D15", SM,
    "    if (logForm.startsWith('module-history/') || logForm.startsWith('quarantine/')) {", "    if (false) {"),
  w("WO-R16", "nested trees are not reported", "R16:", MC, "    if (at < 0) continue;", "    continue;"),
  w("WO-R17", "the aggregate is reported only when C-E is requested", "R17:", MC,
    "    always_load_aggregate: alwaysLoadAggregate(e),", "    always_load_aggregate: on('C-E') ? alwaysLoadAggregate(e) : null,"),
  w("WO-R18", "pairs ranked lowest first", "R18:", MC,
    "    .sort((a, b) => b.shared_trigger_count - a.shared_trigger_count", "    .sort((a, b) => a.shared_trigger_count - b.shared_trigger_count"),
  w("WO-R18", "generic triggers are paired, not listed apart", "R18:", MC,
    "    if (owners.size >= GENERIC_AT) { generic.push({ trigger, kind, module_count: owners.size }); continue; }", ""),
  w("WO-R18", "truncation does not count what it hides", "R18:", MC,
    "    rows_not_shown: Math.max(0, ranked.length - TOP),", "    rows_not_shown: 0,"),
  w("WO-R19", "field_unmaintained never fires", "R19: C-I reports", MC,
    "      field_unmaintained: decided ? rate > LINE_FIELD_UNMAINTAINED_RATE : null,", "      field_unmaintained: decided ? false : null,"),
  w("WO-R19", "the worst are the mildest", "R19: C-I reports", MC,
    "  lineDrift.sort((a, b) => b.factor - a.factor", "  lineDrift.sort((a, b) => a.factor - b.factor"),
  w("WO-G2", "orphans are not told apart", "G2:", SK,
    "    const orphans = ids.filter((id) => { const r = resolutionById.get(id); return !r || r.existing_file_count === 0; });", "    const orphans = [];"),
  w("WO-G2", "C-A does not carry the grouping", "G2:", MC,
    "    manifest_entries_without_file_by_source: grouped.registration.manifest_entries_without_file_by_source || [],",
    "    manifest_entries_without_file_by_source: [],"),
];

const only = process.argv[2] || null;
const run = (cwd, pattern, test = TEST) => spawnSync(process.execPath, ["--test", "--test-name-pattern", pattern, test], { cwd, encoding: "utf8" });
const executed = (out) => Number((/^# pass (\d+)/m.exec(out) || [])[1] || 0) + Number((/^# fail (\d+)/m.exec(out) || [])[1] || 0);

let bad = 0;
let count = 0;
for (const mu of MUTATIONS) {
  if (only && mu.claim !== only) continue;
  count++;
  const control = run(ROOT, mu.pattern, mu.test);
  const controlOk = control.status === 0 && executed(control.stdout) > 0;
  const dir = mkdtempSync(join(tmpdir(), "conn-modfiles-mut-"));
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  let applied = true;
  for (const e of mu.edits) {
    const p = join(dir, e.file);
    const text = readFileSync(p, "utf8");
    if (text.split(e.find).length !== 2) { applied = false; break; }
    writeFileSync(p, text.replace(e.find, e.replace));
  }
  const mutated = applied ? run(dir, mu.pattern, mu.test) : null;
  const red = !!mutated && mutated.status !== 0;
  rmSync(dir, { recursive: true, force: true });
  const ok = controlOk && applied && red;
  if (!ok) bad++;
  console.log(`${ok ? "RED " : "FAIL"}  ${mu.claim}  ${mu.name}`
    + (controlOk ? "" : "  (control did not pass)") + (applied ? "" : "  (mutation text not found exactly once)") + (applied && !red ? "  (SURVIVED)" : ""));
}
console.log(`${count - bad} of ${count} red`);
process.exit(bad ? 1 : 0);
