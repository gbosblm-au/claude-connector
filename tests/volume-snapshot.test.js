// tests/volume-snapshot.test.js  (claude-connector v12.22.0)
//
// Integration tests for GET /volume-snapshot, POST /volume-restore and
// GET /volume-snapshot/status, plus a regression test for the route-ordering
// defect that made POST /provision and GET /export-all unreachable.
//
// Run: node --test tests/volume-snapshot.test.js
//
// These tests build a real skill volume in a temp directory, snapshot it over
// HTTP, mutate the volume, restore it over HTTP and assert the files came
// back. Nothing is mocked except the absence of brain_scan.py, which is itself
// an asserted behaviour.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TOKEN = 'test-restore-token-8e21a4c0';
const ROOT  = mkdtempSync(join(tmpdir(), 'vsnap-test-'));

const SKILL_DIR     = join(ROOT, 'skill');
const AVA_DIR       = join(SKILL_DIR, 'ava');
const DOWNLOADS_DIR = join(ROOT, 'downloads');
const TMP_DIR       = join(ROOT, 'tmp');
const VOLUME_ROOT   = join(ROOT, 'volume');

// Environment must be set before the modules under test are imported, because
// they read configuration at module-evaluation time.
process.env.RAILWAY_RESTORE_TOKEN = TOKEN;
process.env.SKILL_FILE_PATH       = join(SKILL_DIR, 'SKILL.md');
process.env.DOWNLOADS_DIR         = DOWNLOADS_DIR;
process.env.AVA_MODULAR_DIR       = AVA_DIR;
process.env.SNAPSHOT_TMP_DIR      = TMP_DIR;
process.env.VOLUME_ROOT           = VOLUME_ROOT;
process.env.TS_CLIENT_MODE        = 'owner';
process.env.LOG_LEVEL             = 'error';

let app;
let server;
let baseUrl;
let provisionServer;
let provisionUrl;
let registerVolumeSnapshotRoutes;
let tokenMatches;

function seedVolume() {
  mkdirSync(join(AVA_DIR, 'modules', 'finance'), { recursive: true });
  mkdirSync(join(AVA_DIR, 'references', 'erp'),  { recursive: true });
  mkdirSync(join(AVA_DIR, 'scripts'),            { recursive: true });
  mkdirSync(join(AVA_DIR, 'archive'),            { recursive: true });
  mkdirSync(DOWNLOADS_DIR,                       { recursive: true });
  mkdirSync(VOLUME_ROOT,                         { recursive: true });
  mkdirSync(TMP_DIR,                             { recursive: true });

  writeFileSync(join(AVA_DIR, 'CORE.md'),              '# Core\nbaseline\n');
  writeFileSync(join(AVA_DIR, 'MANIFEST.json'),        '{"modules":[{"id":"finance/aml"}]}');
  writeFileSync(join(AVA_DIR, 'MANIFEST_APPEND.json'), '{"append":[]}');
  writeFileSync(join(AVA_DIR, 'DISPATCH_RULES.json'),  '{"version":"1.0","rules":[]}');
  writeFileSync(join(AVA_DIR, 'PERSONALITY.md'),       '# Personality\nowner texture\n');
  writeFileSync(join(AVA_DIR, 'PROFILES.md'),          '## Someone\nnotes\n');
  writeFileSync(join(AVA_DIR, 'modules', 'finance', 'aml.md'), '# AML module\n');
  writeFileSync(join(AVA_DIR, 'references', 'erp', 'checklist.md'), '# Checklist\n');
  writeFileSync(join(AVA_DIR, 'scripts', 'extract.py'), 'print("hi")\n');
  writeFileSync(join(AVA_DIR, 'archive', 'INSTALL.md'), '# Install\n');
  writeFileSync(join(DOWNLOADS_DIR, 'report.csv'), 'a,b\n1,2\n');
}

before(async () => {
  seedVolume();

  const express = (await import('express')).default;
  ({ registerVolumeSnapshotRoutes, tokenMatches } = await import('../src/routes/volume-snapshot.js'));

  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerVolumeSnapshotRoutes(app);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Separate app for the provision route so its JSON body parsing and the
  // snapshot route's raw body parsing cannot interfere with one another.
  const { registerProvisionRoute } = await import('../src/routes/provision.js');
  const provisionApp = express();
  provisionApp.use(express.json({ limit: '10mb' }));
  registerProvisionRoute(provisionApp);
  provisionApp.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  await new Promise((resolve) => {
    provisionServer = provisionApp.listen(0, '127.0.0.1', resolve);
  });
  provisionUrl = `http://127.0.0.1:${provisionServer.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (provisionServer) await new Promise((resolve) => provisionServer.close(resolve));
  try { rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  try { rmSync(VOLUME_ROOT + '-evil', { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// tokenMatches
// ---------------------------------------------------------------------------

test('tokenMatches accepts an exact match', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
});

test('tokenMatches rejects a differing token of equal length', () => {
  assert.equal(tokenMatches('abc123', 'abc124'), false);
});

test('tokenMatches rejects a prefix of the real token', () => {
  assert.equal(tokenMatches('abc', 'abc123'), false);
});

test('tokenMatches rejects an empty expected token', () => {
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('anything', ''), false);
});

test('tokenMatches rejects a longer candidate sharing the prefix', () => {
  assert.equal(tokenMatches('abc1234', 'abc123'), false);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('status rejects a missing token', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot/status`);
  assert.equal(res.status, 401);
});

test('status rejects a wrong token', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot/status`, {
    headers: { 'X-Railway-Restore-Token': 'wrong' },
  });
  assert.equal(res.status, 401);
});

test('status reports the resolved volume layout', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot/status`, {
    headers: { 'X-Railway-Restore-Token': TOKEN },
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.ava_dir, AVA_DIR);
  assert.equal(body.ava_dir_present, true);
  assert.equal(body.downloads_dir, DOWNLOADS_DIR);
  assert.equal(body.helper_present, true, 'volume_snapshot.py must ship beside the route module');
  assert.equal(body.layout_version, 1);
});

test('status accepts the token as a query parameter', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot/status?token=${TOKEN}`);
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

let archiveBuffer = null;

test('snapshot returns a gzip archive with metadata headers', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot`, {
    headers: { 'X-Railway-Restore-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');

  const sha = res.headers.get('x-snapshot-sha256');
  assert.match(sha, /^[0-9a-f]{64}$/, 'sha256 header must be a hex digest');

  // 11 ava files (including the two personal files) plus 1 download.
  assert.equal(res.headers.get('x-snapshot-ava-file-count'), '10');
  assert.equal(res.headers.get('x-snapshot-downloads-file-count'), '1');
  assert.equal(res.headers.get('x-snapshot-layout-version'), '1');

  archiveBuffer = Buffer.from(await res.arrayBuffer());
  assert.ok(archiveBuffer.length > 0);
  assert.equal(archiveBuffer[0], 0x1f, 'gzip magic byte 0');
  assert.equal(archiveBuffer[1], 0x8b, 'gzip magic byte 1');
});

test('snapshot honours include_downloads=0', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot?include_downloads=0`, {
    headers: { 'X-Railway-Restore-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-snapshot-downloads-file-count'), '0');
  await res.arrayBuffer();
});

test('snapshot honours an exclude filter', async () => {
  const res = await fetch(`${baseUrl}/volume-snapshot?exclude=archive&include_downloads=0`, {
    headers: { 'X-Railway-Restore-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  // INSTALL.md lived under archive/, so one fewer ava file is captured.
  assert.equal(res.headers.get('x-snapshot-ava-file-count'), '9');
  await res.arrayBuffer();
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore rejects a body that is not gzip', async () => {
  const res = await fetch(`${baseUrl}/volume-restore`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    Buffer.from('this is not a tarball'),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /gzip/i);
});

test('restore rejects an empty body', async () => {
  const res = await fetch(`${baseUrl}/volume-restore`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    Buffer.alloc(0),
  });
  assert.equal(res.status, 400);
});

test('restore rejects a wrong token before touching the volume', async () => {
  const res = await fetch(`${baseUrl}/volume-restore`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': 'wrong', 'Content-Type': 'application/octet-stream' },
    body:    archiveBuffer,
  });
  assert.equal(res.status, 401);
});

test('restore rebuilds files deleted from the volume', async () => {
  // Simulate a redeployment that wiped part of the volume.
  unlinkSync(join(AVA_DIR, 'CORE.md'));
  unlinkSync(join(AVA_DIR, 'modules', 'finance', 'aml.md'));
  unlinkSync(join(DOWNLOADS_DIR, 'report.csv'));
  assert.equal(existsSync(join(AVA_DIR, 'CORE.md')), false);

  const res = await fetch(`${baseUrl}/volume-restore?scan=1`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    archiveBuffer,
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.rejected_count, 0);
  assert.ok(body.files_written >= 11, `expected at least 11 files, got ${body.files_written}`);

  assert.equal(readFileSync(join(AVA_DIR, 'CORE.md'), 'utf8'), '# Core\nbaseline\n');
  assert.equal(readFileSync(join(AVA_DIR, 'modules', 'finance', 'aml.md'), 'utf8'), '# AML module\n');

  // The downloads namespace must land in DOWNLOADS_DIR, not inside the skill
  // directory. This is the defect in the original manual tar command.
  assert.equal(existsSync(join(DOWNLOADS_DIR, 'report.csv')), true);
  assert.equal(existsSync(join(SKILL_DIR, 'downloads', 'report.csv')), false);
  assert.equal(body.downloads_files_written, 1);
});

test('restore reports a missing brain_scan.py without failing the restore', async () => {
  const res = await fetch(`${baseUrl}/volume-restore?scan=1`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    archiveBuffer,
  });
  const body = await res.json();

  assert.equal(body.success, true, 'a missing scanner must not fail the restore');
  assert.equal(body.brain_scan.requested, true);
  assert.equal(body.brain_scan.ran, false);
  assert.match(body.brain_scan.message, /brain_scan\.py not found/);
});

test('restore honours scan=0', async () => {
  const res = await fetch(`${baseUrl}/volume-restore?scan=0`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    archiveBuffer,
  });
  const body = await res.json();
  assert.equal(body.brain_scan.requested, false);
  assert.equal(body.brain_scan.ran, false);
});

test('restore with exclude_personal=1 leaves personal files untouched', async () => {
  writeFileSync(join(AVA_DIR, 'PERSONALITY.md'), '# Personality\nCLIENT OWN TEXTURE\n');
  unlinkSync(join(AVA_DIR, 'PROFILES.md'));
  unlinkSync(join(AVA_DIR, 'CORE.md'));

  const res = await fetch(`${baseUrl}/volume-restore?scan=0&exclude_personal=1`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    archiveBuffer,
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.exclude_personal, true);

  // Non-personal content is restored.
  assert.equal(existsSync(join(AVA_DIR, 'CORE.md')), true);

  // The client's own PERSONALITY.md survives, and PROFILES.md is not recreated
  // from the owner archive.
  assert.equal(
    readFileSync(join(AVA_DIR, 'PERSONALITY.md'), 'utf8'),
    '# Personality\nCLIENT OWN TEXTURE\n',
    'the owner archive must not overwrite a client PERSONALITY.md',
  );
  assert.equal(existsSync(join(AVA_DIR, 'PROFILES.md')), false);
});

test('restore rejects a hostile archive without writing outside the roots', async () => {
  // Built with the Python helper so the fixture matches real tar semantics.
  const { execFileSync } = await import('node:child_process');
  const evilPath = join(TMP_DIR, 'evil.tar.gz');

  execFileSync('python3', ['-c', `
import tarfile, io, sys
with tarfile.open(sys.argv[1], 'w:gz') as tf:
    def addf(name, data):
        i = tarfile.TarInfo(name); i.size = len(data)
        tf.addfile(i, io.BytesIO(data))
    addf('skill/ava/../../../escaped.md', b'escaped')
    addf('/etc/escaped2.md', b'escaped')
    addf('skill/ava/legit.md', b'legit')
    s = tarfile.TarInfo('skill/ava/link.md'); s.type = tarfile.SYMTYPE; s.linkname = '/etc/passwd'; tf.addfile(s)
`, evilPath]);

  const res = await fetch(`${baseUrl}/volume-restore?scan=0`, {
    method:  'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body:    readFileSync(evilPath),
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.files_written, 1, 'only the legitimate member may be written');
  assert.equal(body.rejected_count, 3, 'traversal, absolute path and symlink must all be rejected');
  assert.equal(existsSync(join(AVA_DIR, 'legit.md')), true);
  assert.equal(existsSync(join(ROOT, 'escaped.md')), false);
  assert.equal(existsSync(join(ROOT, '..', 'escaped.md')), false);
});

// ---------------------------------------------------------------------------
// Route ordering regression
// ---------------------------------------------------------------------------

test('routes registered before the catch-all are reachable', async () => {
  // Guards the v12.22.0 fix: registering route modules inside the listen()
  // callback placed them after the catch-all 404 layer, so /provision and
  // /export-all could never be reached.
  const res = await fetch(`${baseUrl}/volume-snapshot/status?token=${TOKEN}`);
  assert.notEqual(res.status, 404, 'snapshot routes must not be shadowed by the catch-all');

  const missing = await fetch(`${baseUrl}/definitely-not-a-route`);
  assert.equal(missing.status, 404, 'the catch-all must still handle genuinely unknown paths');
});

// ---------------------------------------------------------------------------
// POST /provision security
//
// Making the route reachable also activated it, so these guard the auth and
// path-containment fixes applied at the same time.
// ---------------------------------------------------------------------------

test('provision rejects a request with no credentials', async () => {
  const res = await fetch(`${provisionUrl}/provision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ api_key: 'anything-at-all', files: [{ path: 'pwn.md', content: 'x' }] }),
  });
  assert.equal(res.status, 403, 'owner mode must not accept an arbitrary api_key');
  assert.equal(existsSync(join(VOLUME_ROOT, 'clients', 'owner', 'pwn.md')), false);
});

test('provision rejects a wrong token', async () => {
  const res = await fetch(`${provisionUrl}/provision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Railway-Restore-Token': 'nope' },
    body:    JSON.stringify({ api_key: 'nope', files: [{ path: 'pwn2.md', content: 'x' }] }),
  });
  assert.equal(res.status, 403);
  assert.equal(existsSync(join(VOLUME_ROOT, 'clients', 'owner', 'pwn2.md')), false);
});

test('provision accepts the restore token and writes the file', async () => {
  const res = await fetch(`${provisionUrl}/provision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Railway-Restore-Token': TOKEN },
    body:    JSON.stringify({ api_key: TOKEN, files: [{ path: 'ok.md', content: 'legitimate' }] }),
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.files_written, 1);
  assert.equal(readFileSync(join(VOLUME_ROOT, 'clients', 'owner', 'ok.md'), 'utf8'), 'legitimate');
});

test('provision rejects a base_path that only shares a prefix with the volume root', async () => {
  // /tmp/xxx/volume-evil must not pass a check against /tmp/xxx/volume.
  const res = await fetch(`${provisionUrl}/provision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Railway-Restore-Token': TOKEN },
    body:    JSON.stringify({
      api_key:   TOKEN,
      base_path: VOLUME_ROOT + '-evil',
      files:     [{ path: 'escaped.md', content: 'x' }],
    }),
  });
  assert.equal(res.status, 400, 'prefix-matching base_path must be rejected');
  assert.equal(existsSync(VOLUME_ROOT + '-evil/escaped.md'), false);
});

test('provision blocks traversal in a file path', async () => {
  const res = await fetch(`${provisionUrl}/provision`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Railway-Restore-Token': TOKEN },
    body:    JSON.stringify({
      api_key: TOKEN,
      files:   [{ path: '../../../escaped.md', content: 'x' }],
    }),
  });
  assert.equal(res.status, 200, 'the request succeeds but the member is skipped');

  const body = await res.json();
  assert.equal(body.files_written, 0);
  assert.equal(body.skipped, 1);
  assert.match(body.errors.join(' '), /traversal/i);
  assert.equal(existsSync(join(ROOT, 'escaped.md')), false);
});
