// src/tests/register-audit.test.js
//
// Work order W7 rev 2.1, diagnostic D6: scripts/register-audit.mjs compares the
// registry with the writer's vocabulary, derived by walking the gateway and
// client trees, in both directions. Connector v13.36.0.
//
// The audit runs as an operator runs it (a child process) against small
// fixture trees built here, each the shape of the real emitters it walks
// (a prompt string with backticked markers, a *MARKER* array, a regex for a
// literal token). The real trees are audited in the delivery evidence, because
// they live in other repositories.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'register-audit.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'tenax-register-audit-'));
after(() => rmSync(WORK, { recursive: true, force: true }));

/** The emitters of every Class A token in the registry, in the walkers' shapes. */
const PROMPT = `export function markerInstruction() {
  return [
    '- \`[OUTPUT]\` the answer.',
    '- \`[TRACE]\` your working.',
    '- \`[RESULT]\` one line.',
  ].join('\\n');
}
`;
const MARKERS = `var OUTPUT_MARKERS = [ '[OUTPUT]', '[TRACE]', '[RESULT]' ];
var OUTPUT_MARKER_OUT_OF_SCOPE = [ '[private-conversation]', '[forget]' ];
var parts = ['[session-complete]'];
`;
const PANELS = `text = text.replace(/\\[\\[TRAVEL_RESEARCH_FORM\\]\\]/g, '');
text = text.replace(/\\[\\[RECREATION_PANEL\\]\\]/g, '');
var m = line.match(/^\\[exam-state\\]\\s*(.+)$/i);
`;

function tree(name, files) {
  const root = join(WORK, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(gateway, client) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--gateway', gateway, '--client', client, '--json']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(out); } catch (err) { /* the caller asserts */ }
      resolve({ code, out, report });
    });
  });
}

test('D6: a complete pair of trees audits clean, with every walker above its floor', async () => {
  const gw = tree('gw-ok', { 'lib/thought-trace.js': PROMPT });
  const cl = tree('cl-ok', { 'src/js/06b-output-marker.js': MARKERS, 'src/js/06-markdown.js': PANELS });
  const r = await run(gw, cl);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.report.walkers.W1 > 0 && r.report.walkers.W2 > 0 && r.report.walkers.W3 > 0, 'floors');
  assert.deepEqual(r.report.emittable_but_unregistered, []);
  assert.deepEqual(r.report.registered_class_a_without_emitter, []);
  assert.ok(!('[session-complete]' in r.report.writer_tokens),
    'a user-turn directive array (not a *MARKER* declaration) is not the reply writer');
  assert.ok(r.report.class_b_documented_no_code_emitter.includes('[warm]'));
});

test('D6: a token the writer can emit that is not registered fails, named', async () => {
  const gw = tree('gw-new', { 'lib/thought-trace.js': PROMPT.replace("'- `[RESULT]` one line.',",
    "'- `[RESULT]` one line.',\n    '- `[SUMMARY]` a new marker.',") });
  const cl = tree('cl-new', { 'src/js/06b-output-marker.js': MARKERS, 'src/js/06-markdown.js': PANELS });
  const r = await run(gw, cl);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.report.emittable_but_unregistered, ['[SUMMARY]']);
});

test('D6: a registered Class A token with no emitter left fails, named (the reverse direction)', async () => {
  const gw = tree('gw-stale', { 'lib/thought-trace.js': PROMPT });
  const cl = tree('cl-stale', { 'src/js/06b-output-marker.js': MARKERS,
    'src/js/06-markdown.js': PANELS.replace(/^var m = .*$/mu, '') });
  const r = await run(gw, cl);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.report.registered_class_a_without_emitter, ['[exam-state]']);
});

test('D6 floor: a walker that finds nothing fails rather than passes', async () => {
  const gw = tree('gw-empty', { 'lib/other.js': 'export const x = 1;\n' });
  const cl = tree('cl-empty', { 'src/js/06b-output-marker.js': MARKERS, 'src/js/06-markdown.js': PANELS });
  const r = await run(gw, cl);
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(r.report.empty_walkers, ['W1']);
});
