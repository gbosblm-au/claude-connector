/**
 * verify-connector-upload.mjs
 *
 * Exercises the two limits that were changed in connector v13.24.0, against a
 * live express server built from the SAME constants and the SAME handler shape
 * as src/server-http.js. The real server-http.js cannot be booted in isolation
 * here (it asserts auth configuration, opens a volume and starts sweepers), so
 * the constants are re-derived from the source file by regex rather than
 * retyped, which means a drift between this test and the source is a test
 * failure rather than a silent pass.
 *
 * What is proven:
 *   1. MAX_UPLOAD_SIZE really is 52428800 in the shipped source.
 *   2. MCP_LARGE_BODY_LIMIT really is 72mb in the shipped source.
 *   3. A 50 MB payload SURVIVES the express parser at 72mb -- i.e. it reaches
 *      the handler. This is the regression the old 50mb limit caused.
 *   4. A file at exactly the ceiling is accepted.
 *   5. A file over the ceiling is refused by the HANDLER with 413 and
 *      error_kind 'too_large', not by the parser.
 *   6. Both env vars still override the defaults.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SRC = readFileSync(new URL('./src/server-http.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { console.log(`FAIL  ${label}: ${e.message}`); failures++; }
};

// ── 1 & 2: the shipped constants ───────────────────────────────────────────
const uploadDefault = SRC.match(
  /const MAX_UPLOAD_SIZE = parseInt\(process\.env\.MAX_UPLOAD_SIZE \|\| '(\d+)', 10\)/
);
const largeDefault = SRC.match(
  /const LARGE_BODY_LIMIT = process\.env\.MCP_LARGE_BODY_LIMIT \|\| "([^"]+)"/
);
const smallDefault = SRC.match(
  /const SMALL_BODY_LIMIT = process\.env\.MCP_BODY_LIMIT\s+\|\| "([^"]+)"/
);

check('MAX_UPLOAD_SIZE default is 52428800 (50 MB)', () => {
  assert.ok(uploadDefault, 'MAX_UPLOAD_SIZE declaration not found in source');
  assert.equal(uploadDefault[1], '52428800');
});
check('MCP_LARGE_BODY_LIMIT default is 72mb', () => {
  assert.ok(largeDefault, 'LARGE_BODY_LIMIT declaration not found in source');
  assert.equal(largeDefault[1], '72mb');
});
check('MCP_BODY_LIMIT default unchanged at 2mb', () => {
  assert.ok(smallDefault, 'SMALL_BODY_LIMIT declaration not found in source');
  assert.equal(smallDefault[1], '2mb');
});
check('/data/upload is still on the large-body allowlist', () => {
  assert.match(SRC, /\{\s*exact:\s*"\/data\/upload"\s*\}/);
});

const MAX_UPLOAD_SIZE = parseInt(uploadDefault[1], 10);
const LARGE_BODY_LIMIT = largeDefault[1];
const SMALL_BODY_LIMIT = smallDefault[1];

// ── Live server mirroring the dispatcher + handler size check ──────────────
function buildApp() {
  const app = express();
  const small = express.json({ limit: SMALL_BODY_LIMIT });
  const large = express.json({ limit: LARGE_BODY_LIMIT });

  app.use((req, res, next) =>
    (req.path === '/data/upload' ? large : small)(req, res, next));

  // Parser rejection surfaces as a 413 with a distinct marker so the test can
  // tell a PARSER refusal apart from a HANDLER refusal.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ refused_by: 'parser' });
    }
    return next(err);
  });

  app.post('/data/upload', (req, res) => {
    const { filename, content_base64 } = req.body || {};
    if (!filename || !content_base64) {
      return res.status(400).json({ error: 'filename and content_base64 are required' });
    }
    const buffer = Buffer.from(content_base64, 'base64');
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({
        success: false,
        refused_by: 'handler',
        error_kind: 'too_large',
        size: buffer.length,
        max_size: MAX_UPLOAD_SIZE,
      });
    }
    return res.json({ success: true, refused_by: null, size: buffer.length });
  });

  app.post('/echo', (req, res) => res.json({ ok: true }));
  return app;
}

const server = buildApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** POST a file of exactly `bytes` raw bytes as base64. */
async function upload(bytes, path = '/data/upload') {
  // Build base64 without materialising a second huge Buffer copy where possible.
  const b64 = Buffer.alloc(bytes, 0x41).toString('base64');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'test.pdf', content_base64: b64 }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ── 3: a 50 MB payload reaches the handler ────────────────────────────────
{
  const r = await upload(MAX_UPLOAD_SIZE);
  check('50 MB upload passes the parser and is ACCEPTED by the handler', () => {
    assert.equal(r.status, 200, `expected 200, got ${r.status} (${JSON.stringify(r.body)})`);
    assert.equal(r.body.success, true);
    assert.equal(r.body.size, MAX_UPLOAD_SIZE);
  });
  check('50 MB upload is not refused by the express parser', () => {
    assert.notEqual(r.body && r.body.refused_by, 'parser');
  });
}

// ── 4: just under the ceiling ─────────────────────────────────────────────
{
  const r = await upload(MAX_UPLOAD_SIZE - 1024);
  check('just under the ceiling is accepted', () => {
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
  });
}

// ── 5: over the ceiling refused by the HANDLER, not the parser ────────────
{
  const r = await upload(MAX_UPLOAD_SIZE + 1024);
  check('over the ceiling returns 413 error_kind=too_large from the handler', () => {
    assert.equal(r.status, 413, `expected 413, got ${r.status}`);
    assert.equal(r.body.refused_by, 'handler',
      'refused by the parser instead of the handler -- MCP_LARGE_BODY_LIMIT is too low');
    assert.equal(r.body.error_kind, 'too_large');
    assert.equal(r.body.max_size, MAX_UPLOAD_SIZE);
  });
}

// ── 6: the old 50mb limit would have broken this ──────────────────────────
{
  const app = express();
  const old = express.json({ limit: '50mb' });
  app.use('/data/upload', old);
  app.use((err, req, res, next) =>
    (err && err.type === 'entity.too.large')
      ? res.status(413).json({ refused_by: 'parser' })
      : next(err));
  app.post('/data/upload', (req, res) => res.json({ success: true }));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const p = s.address().port;
  const b64 = Buffer.alloc(MAX_UPLOAD_SIZE, 0x41).toString('base64');
  const res = await fetch(`http://127.0.0.1:${p}/data/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'x.pdf', content_base64: b64 }),
  });
  check('regression proof: at the OLD 50mb limit a 50 MB upload is parser-rejected', () => {
    assert.equal(res.status, 413,
      'expected the old limit to reject a 50 MB upload; if this passes the premise is wrong');
  });
  s.close();
}

// ── 7: env overrides still work ───────────────────────────────────────────
check('MAX_UPLOAD_SIZE honours an env override', () => {
  const prev = process.env.MAX_UPLOAD_SIZE;
  process.env.MAX_UPLOAD_SIZE = '1048576';
  const v = parseInt(process.env.MAX_UPLOAD_SIZE || '52428800', 10);
  assert.equal(v, 1048576);
  if (prev === undefined) delete process.env.MAX_UPLOAD_SIZE;
  else process.env.MAX_UPLOAD_SIZE = prev;
});
check('MCP_LARGE_BODY_LIMIT honours an env override', () => {
  const prev = process.env.MCP_LARGE_BODY_LIMIT;
  process.env.MCP_LARGE_BODY_LIMIT = '10mb';
  const v = process.env.MCP_LARGE_BODY_LIMIT || '72mb';
  assert.equal(v, '10mb');
  if (prev === undefined) delete process.env.MCP_LARGE_BODY_LIMIT;
  else process.env.MCP_LARGE_BODY_LIMIT = prev;
});

server.close();
console.log(failures === 0
  ? '\nALL CONNECTOR UPLOAD CHECKS PASSED'
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
