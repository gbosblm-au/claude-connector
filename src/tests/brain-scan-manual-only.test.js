/**
 * brain-scan-manual-only.test.js  (connector v12.36.0)
 *
 * Locks the Neural Core scanner to MANUAL TRIGGERS ONLY.
 *
 * Run with:  node --test src/tests/brain-scan-manual-only.test.js
 *        or: npm run test:brain-scan
 *
 * Why these tests are written the way they are
 * ---------------------------------------------------------------------------
 * The property under test is a NEGATIVE one: "nothing starts a scan by itself".
 * A behavioural test cannot prove that, because the failure mode is a code path
 * that fires at boot, or on a timer, or from a hook, in a process this test
 * never runs. So the suite has two halves:
 *
 *   1. Behavioural tests over the real module, using a temporary AVA directory,
 *      asserting the surviving API is manual and the removed API is gone.
 *   2. Source assertions over server-http.js and the route modules, asserting
 *      no automatic call site has reappeared. These are deliberately literal.
 *      A source grep is a blunt instrument, but it is the only instrument that
 *      catches "someone added scheduleBrainScan() back into onToolCompleted"
 *      in review, which is exactly how a policy like this gets lost.
 *
 * The suite must be able to run on a workstation with no /data volume, so the
 * AVA directory is pointed at a temp dir BEFORE the module under test is
 * imported: brain-scan-trigger.js resolves its paths once, at module load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));      // src/tests
const SRC = resolve(HERE, '..');                           // src
const ROOT = resolve(SRC, '..');                           // package root

// ---------------------------------------------------------------------------
// Fixture: an isolated AVA directory, set before the module is imported.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'brain-scan-test-'));
process.env.AVA_MODULAR_DIR = FIXTURE_DIR;
delete process.env.SCRIPTS_DIR;
delete process.env.BRAIN_SCAN_ENABLED;

const trigger = await import('../tools/brain-scan-trigger.js');

// ---------------------------------------------------------------------------
// 1. Behavioural: the removed automatic API is actually gone
// ---------------------------------------------------------------------------

test('the module exports no boot scan', () => {
  assert.equal(
    trigger.bootScanIfMissing,
    undefined,
    'bootScanIfMissing() is the deployment-time trigger and must not exist.'
  );
});

test('the module exports no scan scheduler', () => {
  assert.equal(
    trigger.scheduleBrainScan,
    undefined,
    'scheduleBrainScan() is the debounced automatic trigger and must not exist.'
  );
});

test('the module exports exactly the manual-only surface', () => {
  const exported = Object.keys(trigger).sort();
  assert.deepEqual(exported, [
    'describeScanState',
    'getBrainScanPaths',
    'onToolCompleted',
    'runBrainScan',
    'setBrainScanLogger',
    'writeToolCatalog',
  ], 'An unexpected export appeared. If it can start a scan, it breaks the policy.');
});

test('the reported trigger policy is manual-only with no automatic triggers', () => {
  const paths = trigger.getBrainScanPaths();
  assert.equal(paths.triggerPolicy, 'manual-only');
  assert.deepEqual(paths.automaticTriggers, []);
  assert.equal(paths.bootScanEnabled, false);
  assert.equal(paths.scheduledScanEnabled, false);
  assert.ok(Array.isArray(paths.manualTriggers) && paths.manualTriggers.length > 0);
});

test('describeScanState reports a missing scan without creating one', () => {
  const state = trigger.describeScanState();
  assert.equal(state.present, false);
  assert.equal(state.error, null);

  const paths = trigger.getBrainScanPaths();
  assert.equal(existsSync(paths.dataPath), false, 'Reading the state must not write a scan.');
  assert.equal(trigger.getBrainScanPaths().scanCount, 0, 'Reading the state must not start a scan.');
});

test('describeScanState distinguishes an empty scan from a present one', () => {
  const paths = trigger.getBrainScanPaths();
  mkdirSync(dirname(paths.dataPath), { recursive: true });

  writeFileSync(paths.dataPath, '', 'utf8');
  let state = trigger.describeScanState();
  assert.equal(state.present, true);
  assert.equal(state.empty, true);
  assert.equal(state.size, 0);

  writeFileSync(paths.dataPath, JSON.stringify({ nodes: [], links: [] }), 'utf8');
  state = trigger.describeScanState();
  assert.equal(state.present, true);
  assert.equal(state.empty, false);
  assert.ok(state.size > 0);
});

test('runBrainScan is a no-op when the scanner is not on the volume', async () => {
  // The fixture volume has no brain_scan.py, which is also the state of a fresh
  // deploy. The old boot scan treated this as "skip"; runBrainScan must too,
  // and must not throw, because callers treat a false return as informational.
  const before = trigger.getBrainScanPaths().scanCount;
  const ok = await trigger.runBrainScan({ force: true, trigger: 'unit-test' });
  assert.equal(ok, false);
  assert.equal(trigger.getBrainScanPaths().scanCount, before,
    'A skipped scan must not be counted as a started scan.');
});

test('runBrainScan honours the BRAIN_SCAN_ENABLED kill switch', async () => {
  process.env.BRAIN_SCAN_ENABLED = 'false';
  try {
    assert.equal(trigger.getBrainScanPaths().enabled, false);
    const ok = await trigger.runBrainScan({ force: true, trigger: 'unit-test' });
    assert.equal(ok, false);
  } finally {
    delete process.env.BRAIN_SCAN_ENABLED;
  }
  assert.equal(trigger.getBrainScanPaths().enabled, true);
});

test('onToolCompleted never starts a scan for any tool name', () => {
  // The historical RESCAN_TRIGGERS allowlist, plus skill_compile, plus a couple
  // of ordinary tools. None of these may start a scan.
  const names = [
    'module_write', 'skill_write', 'skill_write_addition', 'skill_merge_additions',
    'skill_recompile', 'skill_rollback', 'dispatch_rule_add', 'reference_write',
    'script_write', 'archive_write', 'personality_write', 'skill_compile',
    'web_search', 'memory_store',
  ];
  const before = trigger.getBrainScanPaths().scanCount;

  for (const name of names) {
    trigger.onToolCompleted(name, {}, {
      content: [{ type: 'text', text: JSON.stringify({ modules_loaded: ['a', 'b'] }) }],
    });
  }

  const after = trigger.getBrainScanPaths();
  assert.equal(after.scanCount, before, 'A tool completion must never start a scan.');
  assert.equal(after.scanRunning, false);
});

test('onToolCompleted still records the compile set (behaviour preserved)', () => {
  const paths = trigger.getBrainScanPaths();
  trigger.onToolCompleted('skill_compile', {}, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        modules_loaded: ['core', 'analysis'],
        session_id: 'sess-123',
        specialist_count: 2,
        line_count: 400,
      }),
    }],
  });

  assert.equal(existsSync(paths.lastCompilePath), true,
    'last_compile.json must still be written: removing the scan must not remove the record.');
  const record = JSON.parse(readFileSync(paths.lastCompilePath, 'utf8'));
  assert.deepEqual(record.modules_loaded, ['core', 'analysis']);
  assert.equal(record.session_id, 'sess-123');
});

test('onToolCompleted swallows a malformed result rather than throwing', () => {
  assert.doesNotThrow(() => trigger.onToolCompleted('skill_compile', {}, null));
  assert.doesNotThrow(() => trigger.onToolCompleted('skill_compile', {}, { isError: true }));
  assert.doesNotThrow(() => trigger.onToolCompleted('skill_compile', {}, { content: 'not-an-array' }));
  assert.doesNotThrow(() => trigger.onToolCompleted('skill_compile', {}, {
    content: [{ type: 'text', text: '{not json' }],
  }));
});

test('writeToolCatalog writes a catalogue and starts no scan', () => {
  const before = trigger.getBrainScanPaths().scanCount;
  const wrote = trigger.writeToolCatalog([
    { name: 'b_tool', description: 'Second.' },
    { name: 'a_tool', description: 'First.' },
  ]);
  assert.equal(wrote, true);

  const paths = trigger.getBrainScanPaths();
  const catalogue = JSON.parse(readFileSync(paths.toolCatalogPath, 'utf8'));
  assert.equal(catalogue.tool_count, 2);
  assert.deepEqual(catalogue.tools.map((t) => t.name), ['a_tool', 'b_tool'], 'Catalogue must stay sorted.');
  assert.equal(trigger.getBrainScanPaths().scanCount, before,
    'Writing the catalogue is a file write, not a scan.');
});

// ---------------------------------------------------------------------------
// 2. Source assertions: no automatic call site has reappeared
// ---------------------------------------------------------------------------

/** Strip line and block comments so a mention in prose is not a false positive. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const SERVER_SRC = stripComments(readFileSync(join(SRC, 'server-http.js'), 'utf8'));
const TRIGGER_SRC = stripComments(readFileSync(join(SRC, 'tools', 'brain-scan-trigger.js'), 'utf8'));
const RESTORE_SRC = stripComments(readFileSync(join(SRC, 'routes', 'volume-snapshot.js'), 'utf8'));

test('server-http.js contains no boot scan call', () => {
  assert.equal(/bootScanIfMissing/.test(SERVER_SRC), false,
    'The boot scan was reintroduced into server-http.js.');
});

test('no module schedules a scan', () => {
  for (const [label, source] of [['server-http.js', SERVER_SRC], ['brain-scan-trigger.js', TRIGGER_SRC], ['volume-snapshot.js', RESTORE_SRC]]) {
    assert.equal(/scheduleBrainScan/.test(source), false,
      `${label} references scheduleBrainScan, which must not exist.`);
  }
});

test('brain-scan-trigger.js starts no timer or interval that scans', () => {
  // setTimeout survives in exactly one place: the 500ms queued rerun, and the
  // scanner's own SIGKILL timeout. Neither is a schedule. What must never
  // appear is setInterval, or a cron import.
  assert.equal(/setInterval/.test(TRIGGER_SRC), false,
    'setInterval in the scan module is a periodic trigger by definition.');
  assert.equal(/node-cron|require\(['"]cron|from ['"]cron/.test(TRIGGER_SRC), false,
    'A cron library in the scan module is a scheduled trigger by definition.');
});

test('every runBrainScan call site names its trigger', () => {
  // Provenance is the audit trail for this policy: an unlabelled call site is a
  // scan nobody can attribute later.
  for (const [label, source] of [['server-http.js', SERVER_SRC], ['volume-snapshot.js', RESTORE_SRC]]) {
    const calls = source.match(/runBrainScan\(\{[^}]*\}/g) || [];
    assert.ok(calls.length > 0, `${label} should still contain at least one manual scan call site.`);
    for (const call of calls) {
      assert.ok(/trigger\s*:/.test(call),
        `${label} has a runBrainScan call with no trigger label: ${call}`);
    }
  }
});

test('the manual trigger endpoints are still registered', () => {
  // The other half of the policy: manual MUST still work. A change that removed
  // the buttons would pass every negative test above and be entirely wrong.
  assert.ok(/app\.post\(\s*['"]\/brain-scan['"]/.test(SERVER_SRC), 'POST /brain-scan is missing.');
  assert.ok(/app\.get\(\s*["']\/brain-data["']/.test(SERVER_SRC), 'GET /brain-data is missing.');
  assert.ok(/rescan/.test(SERVER_SRC), 'The ?rescan=1 manual path is missing.');
});

test('POST /brain-scan fails closed when no token is configured', () => {
  // Guards against a regression to `if (allowedToken && token !== allowedToken)`,
  // which let an unauthenticated caller spawn Python whenever both token env
  // vars were unset.
  const handler = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/brain-scan'"));
  const body = handler.slice(0, handler.indexOf('app.get('));
  assert.ok(/if\s*\(\s*!allowedToken\s*\)/.test(body),
    'POST /brain-scan must reject when no token is configured.');
  assert.ok(/constantTimeEquals\(\s*token\s*,\s*allowedToken\s*\)/.test(body),
    'POST /brain-scan must compare tokens in constant time.');
  assert.equal(/allowedToken\s*&&\s*token\s*!==\s*allowedToken/.test(body), false,
    'The fail-open token guard has returned.');
});

test('GET /brain-data does not scan without an explicit rescan request', () => {
  const start = SERVER_SRC.indexOf('app.get("/brain-data"');
  assert.ok(start > -1, 'GET /brain-data handler not found.');
  const body = SERVER_SRC.slice(start, SERVER_SRC.indexOf('app.post(', start));
  assert.equal(/if\s*\(wantsRescan\s*\|\|\s*!existsSync/.test(body), false,
    'A plain read of /brain-data must not start a scan when the file is absent.');
  assert.ok(/if\s*\(wantsRescan\)/.test(body),
    'The scan in /brain-data must be gated on the explicit rescan flag alone.');
});

test('package.json declares the version that carries this policy', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const [major, minor] = String(pkg.version).split('.').map(Number);
  assert.ok(major > 12 || (major === 12 && minor >= 36),
    `Expected >= 12.36.0, found ${pkg.version}.`);
});
