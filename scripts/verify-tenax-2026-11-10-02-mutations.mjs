#!/usr/bin/env node
/**
 * scripts/verify-tenax-2026-11-10-02-mutations.mjs   (connector v13.37.0,
 * TENAX-2026-11-10-02: R2 structured data, K a refusal returned as data)
 *
 * For each claim: the test passes on this tree (the control), the mutation is
 * applied to a scratch copy (its text must occur exactly once), and the same
 * test must then FAIL. A mutation that leaves its test green is reported and
 * the script exits 1.
 *
 *   node scripts/verify-tenax-2026-11-10-02-mutations.mjs
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "src/tools/webFetch.js";
const TEST = "src/tests/web-fetch-structured.test.js";

const MUTATIONS = [
  { claim: "C-SD-01", name: "structured data read after the scripts are removed",
    edits: [
      { find: "  const structured = includeStructured ? extractStructuredData($) : null;\n", replace: "" },
      { find: "  const fullText = extractMainText($);\n", replace: "  const fullText = extractMainText($);\n  const structured = includeStructured ? extractStructuredData($) : null;\n" },
    ] },
  { claim: "C-SD-02", name: "an unparseable block is not counted",
    edits: [ { find: "      invalid++;\n      return;\n    }\n    if (data === null", replace: "      return;\n    }\n    if (data === null" } ] },
  { claim: "C-SD-04", name: "returned when not asked for",
    edits: [ { find: "  const includeStructured = args?.include_structured_data === true;", replace: "  const includeStructured = true;" } ] },
  { claim: "C-SD-06", name: "no bound on the list",
    edits: [ { find: "    if (blocks.length >= STRUCTURED_MAX_BLOCKS || chars + size > STRUCTURED_MAX_CHARS) {", replace: "    if (false) {" } ] },
  { claim: "C-K-01", name: "a non-2xx reply is returned by default",
    edits: [ { find: '  const returnHttpErrors = args?.on_http_error === "return";', replace: '  const returnHttpErrors = args?.on_http_error !== "throw";' } ] },
  { claim: "C-K-02", name: "a 401 or 403 is not a block",
    edits: [ { find: "  if (statusCode === 401 || statusCode === 403) return true;", replace: "" } ] },
  { claim: "C-K-04", name: "a challenge header is missed",
    edits: [ { find: "  if (CHALLENGE_HEADERS.some((h) => get(h))) return true;", replace: "" } ] },
  { claim: "C-K-05", name: "a transport failure is not named",
    edits: [ { find: "(fetch_outcome: transport_error${code})", replace: "" } ] },
  { claim: "C-K-06", name: "a 2xx reply does not say so",
    edits: [ { find: "    upstream_ok: true,\n", replace: "" } ] },
];

const run = (cwd, claim) => spawnSync(process.execPath, ["--test", "--test-name-pattern", claim, TEST], { cwd, encoding: "utf8" });
const executed = (out) => Number((/^# pass (\d+)/m.exec(out) || [])[1] || 0) + Number((/^# fail (\d+)/m.exec(out) || [])[1] || 0);

let bad = 0;
for (const m of MUTATIONS) {
  const control = run(ROOT, m.claim);
  const controlOk = control.status === 0 && executed(control.stdout) > 0;
  const dir = mkdtempSync(join(tmpdir(), "conn-mutation-"));
  const copy = join(dir, "c");
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !src.includes(`${ROOT}/node_modules`) });
  if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
  let applied = true;
  let text = readFileSync(join(copy, FILE), "utf8");
  for (const e of m.edits) {
    if (text.split(e.find).length !== 2) { applied = false; break; }
    text = text.replace(e.find, e.replace);
  }
  writeFileSync(join(copy, FILE), text);
  const mutated = applied ? run(copy, m.claim) : null;
  const red = !!mutated && mutated.status !== 0;
  rmSync(dir, { recursive: true, force: true });
  const ok = controlOk && applied && red;
  if (!ok) bad++;
  console.log(`${ok ? "RED " : "FAIL"}  ${m.claim}  ${m.name}`
    + (controlOk ? "" : "  (control did not pass)") + (applied ? "" : "  (mutation text not found exactly once)"));
}
console.log(`${MUTATIONS.length - bad} of ${MUTATIONS.length} red`);
process.exit(bad ? 1 : 0);
