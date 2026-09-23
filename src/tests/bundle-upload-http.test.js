// src/tests/bundle-upload-http.test.js  (connector v13.29.0)
//
// SPEC-SOURCE-BUNDLE-001, the connector's upload gate, driven through the REAL
// server: src/server-http.js is spawned on a free port with temporary upload and
// bundle directories, and real requests are posted to POST /data/upload.
//
// Behavioural on purpose (s13): this file needs nothing that did not exist
// before v13.29.0 except the new response fields, so against the pre-fix tree
// the gate tests fail on what the server DOES (it refused Dockerfile with
// "Files must have an extension."), not on a missing export.
//
// WRITES: two temporary directories under os.tmpdir(), removed in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPLOADS = mkdtempSync(join(tmpdir(), 'bundle-uploads-'));
const BUNDLES = mkdtempSync(join(tmpdir(), 'bundle-store-'));
// The bundle tools run in this process; point them at the same volume the
// spawned server writes to, so a file uploaded over HTTP can be ingested here.
process.env.BUNDLE_DIR = BUNDLES;
process.env.USER_DATA_UPLOAD_DIR = UPLOADS;

let proc = null;
let base = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [join(ROOT, 'src', 'server-http.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', USER_DATA_UPLOAD_DIR: UPLOADS,
           BUNDLE_DIR: BUNDLES, SELF_MODEL_ENABLED: 'false', UPLOAD_SWEEP_ENABLED: 'false',
           MCP_API_KEY: 'bundle-upload-test-key-0123456789' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out.slice(-2000)}`)), 30000);
    const onData = (d) => {
      out += d.toString();
      if (/listening on|on http:\/\//.test(out)) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out.slice(-2000)}`)); });
  });
});

after(() => {
  if (proc) { proc.removeAllListeners('exit'); proc.kill('SIGTERM'); }
  rmSync(UPLOADS, { recursive: true, force: true });
  rmSync(BUNDLES, { recursive: true, force: true });
});

async function upload(filename, bytes, extra = {}) {
  const r = await fetch(`${base}/data/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content_base64: Buffer.from(bytes).toString('base64'), ...extra }),
  });
  return { status: r.status, json: await r.json() };
}

// ── The gate: content decides, the name does not ──────────────────────────

for (const name of ['Dockerfile', '.dockerfile', 'Makefile', 'LICENSE', 'Procfile', '.gitignore',
                    'Dockerfile.prod', '.env.example', 'Cargo.lock', 'docker-compose.yml', 'server.mjs', 'lib.cjs']) {
  // Acceptance only: status and stored bytes. Kept separate from the
  // classification assertion below so that, against the pre-fix server, this
  // test fails exactly where the old gate refused, and never merely because a
  // response field added in v13.29.0 is absent.
  test(`upload gate stores ${name}`, async () => {
    const r = await upload(name, 'FROM node:22\n');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.success, true);
    assert.ok(existsSync(r.json.filepath), 'the file is on the volume');
    assert.equal(readFileSync(r.json.filepath, 'utf8'), 'FROM node:22\n');
  });
}

test('upload response classifies an extensionless file as text by content', async () => {
  const r = await upload('Dockerfile', 'FROM node:22\n');
  assert.deepEqual(r.json.classification, { class: 'text', encoding: 'utf-8' });
});

test('upload gate still refuses executable formats (the security control stays)', async () => {
  for (const name of ['tool.exe', 'lib.dll', 'run.bat', 'x.ps1']) {
    const r = await upload(name, 'MZ');
    assert.equal(r.status, 400, name);
    assert.equal(r.json.error_kind, 'extension_not_allowed');
  }
});

test('a zip named .txt is classified as an archive by content', async () => {
  const { writeZip } = await import('../../scripts/build-bundle-fixture.mjs');
  const r = await upload('notes.txt', writeZip([{ name: 'a.js', data: 'x\n' }]));
  assert.equal(r.status, 200);
  assert.equal(r.json.classification.class, 'archive');
});

// ── Opt-in ingest on upload ───────────────────────────────────────────────

test('the route NEVER ingests, even when asked twice: the bundle store stays empty', async () => {
  // v13.30.0, review item 1. This route is unauthenticated, and a bundle is
  // keyed on its name, so a route that ingested could let an unauthenticated
  // request replace the contents of an existing bundle, which every
  // MCP-authenticated read afterwards would serve. The floor is the store
  // itself being empty, not merely a missing response field.
  const { buildFixtureGatewayZip } = await import('../../scripts/build-bundle-fixture.mjs');
  const zip = buildFixtureGatewayZip();
  const first = await upload('fixture-gateway.zip', zip, { bundle: true });
  const second = await upload('fixture-gateway.zip', zip, { bundle: true });
  for (const r of [first, second]) {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.success, true, 'the flag is accepted and ignored, not an error');
    assert.equal(r.json.bundle, undefined, 'no bundle object comes back');
    assert.equal(r.json.classification.class, 'archive', 'classification still answers: the plugin depends on it');
  }
  const manifests = join(BUNDLES, 'manifests');
  const written = existsSync(manifests) ? readdirSync(manifests).filter((f) => f.endsWith('.json')) : [];
  assert.deepEqual(written, [], 'the upload route wrote no bundle at all');
});

test('ingest happens through the authenticated tool, and re-ingest reports updated then unchanged', async () => {
  const { writeZip } = await import('../../scripts/build-bundle-fixture.mjs');
  const { handleBundleIngest } = await import('../tools/bundle-tools.js');
  const read = (res) => JSON.parse(res.content[0].text);

  const v1 = await upload('proj.zip', writeZip([{ name: 'a.js', data: 'const a = 1;\n' }]));
  const created = read(await handleBundleIngest({ filepath: v1.json.filepath }));
  assert.equal(created.update.status, 'created');
  assert.equal(created.name, 'proj.zip', 'the stored timestamp prefix is not part of the name');

  const v2 = await upload('proj.zip', writeZip([{ name: 'a.js', data: 'const a = 2;\n' }]));
  const updated = read(await handleBundleIngest({ filepath: v2.json.filepath }));
  assert.equal(updated.bundle_id, created.bundle_id, 'one bundle, not two');
  assert.deepEqual([updated.update.status, updated.update.changed], ['updated', ['a.js']]);

  const again = read(await handleBundleIngest({ filepath: v2.json.filepath }));
  assert.equal(again.update.status, 'unchanged');

  const outside = read(await handleBundleIngest({ filepath: '/etc/hosts' }));
  assert.equal(outside.code, 'bundle_source_not_allowed');
});
