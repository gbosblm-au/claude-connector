#!/usr/bin/env node
/**
 * scripts/verify-module-files-mutations.mjs   (connector v13.38.0, WO-2026-11-20-03 rev 2)
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
const m = (claim, name, pattern, file, find, replace) => ({ claim, name, pattern, edits: [{ file, find, replace }] });

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
];

const only = process.argv[2] || null;
const run = (cwd, pattern) => spawnSync(process.execPath, ["--test", "--test-name-pattern", pattern, TEST], { cwd, encoding: "utf8" });
const executed = (out) => Number((/^# pass (\d+)/m.exec(out) || [])[1] || 0) + Number((/^# fail (\d+)/m.exec(out) || [])[1] || 0);

let bad = 0;
let count = 0;
for (const mu of MUTATIONS) {
  if (only && mu.claim !== only) continue;
  count++;
  const control = run(ROOT, mu.pattern);
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
  const mutated = applied ? run(dir, mu.pattern) : null;
  const red = !!mutated && mutated.status !== 0;
  rmSync(dir, { recursive: true, force: true });
  const ok = controlOk && applied && red;
  if (!ok) bad++;
  console.log(`${ok ? "RED " : "FAIL"}  ${mu.claim}  ${mu.name}`
    + (controlOk ? "" : "  (control did not pass)") + (applied ? "" : "  (mutation text not found exactly once)") + (applied && !red ? "  (SURVIVED)" : ""));
}
console.log(`${count - bad} of ${count} red`);
process.exit(bad ? 1 : 0);
