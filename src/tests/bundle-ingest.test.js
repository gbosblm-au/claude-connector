// src/tests/bundle-ingest.test.js  (connector v13.29.0)
//
// SPEC-SOURCE-BUNDLE-001: classifier, archive reader, completeness predicate,
// every s12 refusal code as a pair, and the store's read-back.
//
// The fixture's expected listing is DERIVED from scripts/build-bundle-fixture.mjs
// (FIXTURE_ENTRIES, FIXTURE_NESTED_ENTRIES) and compared with the manifest in
// both directions. The zip writer there is independent of the reader under test.
//
// WRITES: one temporary BUNDLE_DIR and one temporary upload root under
// os.tmpdir(), removed in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { extname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const STORE = mkdtempSync(join(tmpdir(), 'bundle-test-store-'));
const UPLOAD_ROOT = mkdtempSync(join(tmpdir(), 'bundle-test-uploads-'));
process.env.BUNDLE_DIR = STORE;

const { classifyEntry } = await import('../bundles/classify.js');
const { ingestArchive, reconcile, checkEntryPath, treeHash, treeHashV1Legacy, DEFAULT_LIMITS,
  DEFAULT_EXCLUSIONS, EXCLUSION_SET_REVISION } = await import('../bundles/bundle-ingest.js');
const { decodeEntryName } = await import('../bundles/zip-archive.js');
const store = await import('../bundles/bundle-store.js');
const F = await import('../../scripts/build-bundle-fixture.mjs');
const require_codes = await import('../bundles/bundle-ingest.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const FIXTURE = F.buildFixtureGatewayZip();
let fixture;           // ingestArchive result
let stored;            // ingestBundle response

before(() => {
  fixture = ingestArchive(FIXTURE);
  stored = store.ingestBundle(FIXTURE, { name: 'fixture-gateway.zip' });
});
after(() => {
  rmSync(STORE, { recursive: true, force: true });
  rmSync(UPLOAD_ROOT, { recursive: true, force: true });
});

// ── s5: the runtime's extension helper, pinned, not asserted from memory ──

test('s5 pin: path.extname on the named cases, on this runtime', () => {
  const observed = Object.fromEntries(['Dockerfile', '.dockerfile', 'Dockerfile.prod', 'Makefile', '.gitignore',
    '.env.example', 'LICENSE', 'Procfile', 'docker-compose.yml', 'Cargo.lock'].map((n) => [n, extname(n)]));
  assert.deepEqual(observed, {
    Dockerfile: '', '.dockerfile': '', 'Dockerfile.prod': '.prod', Makefile: '', '.gitignore': '',
    '.env.example': '.example', LICENSE: '', Procfile: '', 'docker-compose.yml': '.yml', 'Cargo.lock': '.lock',
  });
});

// ── s5: the classifier ─────────────────────────────────────────────────────

test('classifier: every named extensionless or multi-dot case is text by content', () => {
  for (const n of ['Dockerfile', '.dockerfile', 'Dockerfile.prod', 'Makefile', '.gitignore', '.env.example',
                   'LICENSE', 'Procfile', 'docker-compose.yml', 'Cargo.lock', 'a.mjs', 'b.cjs']) {
    assert.equal(classifyEntry(n, Buffer.from('some text\n')).class, 'text', n);
  }
});

test('classifier: the UTF-16 trap. A BOM file full of NULs is text, not binary', () => {
  const c = classifyEntry('w.txt', F.UTF16LE_BYTES);
  assert.equal(F.UTF16LE_BYTES.includes(0), true, 'the fixture really does contain NUL bytes');
  assert.deepEqual([c.class, c.encoding, c.bom], ['text', 'utf-16le', true]);
});

test('classifier: a UTF-32LE mark is not mistaken for UTF-16LE', () => {
  const b = Buffer.concat([Buffer.from([0xFF, 0xFE, 0, 0]), Buffer.from([0x41, 0, 0, 0])]);
  assert.equal(classifyEntry('x', b).encoding, 'utf-32le');
});

test('classifier: NUL in the window is binary; a zip signature is an archive whatever the name', () => {
  assert.equal(classifyEntry('data', Buffer.from([0x41, 0x00, 0x42])).class, 'binary');
  assert.equal(classifyEntry('notes.txt', F.writeZip([{ name: 'a', data: 'b' }])).class, 'archive');
  assert.equal(classifyEntry('really.zip', Buffer.from('plain text\n')).class, 'text');
});

test('classifier: a known-binary suffix is an optimisation, never the authority', () => {
  const fast = classifyEntry('logo.png', F.PNG_BYTES);
  assert.deepEqual([fast.class, fast.sniffed], ['binary', false]);
  assert.equal(classifyEntry('actually-text.png', Buffer.from('hello\n')).class, 'text');
});

test('classifier: invalid UTF-8 is text-uncertain with the first failing offset', () => {
  const c = classifyEntry('l.txt', Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x0A]));
  assert.deepEqual([c.class, c.first_bad_offset], ['text-uncertain', 3]);
});

// ── s7, s14: the fixture ───────────────────────────────────────────────────

test('s7 floor, BEFORE any class assertion: entries_total > 0 and equals the derived fixture count', () => {
  assert.equal(fixture.ok, true, JSON.stringify(fixture));
  const derived = F.FIXTURE_ENTRIES.length + F.FIXTURE_NESTED_ENTRIES.length;
  assert.ok(fixture.manifest.counts.total > 0);
  assert.equal(fixture.manifest.counts.total, derived);
});

test('s7 identity: total = included + excluded + refused', () => {
  const c = fixture.manifest.counts;
  assert.equal(c.total, c.included + c.excluded + c.refused);
  assert.equal(c.included, fixture.manifest.entries.length);
  assert.equal(c.excluded, fixture.manifest.excluded.length);
  assert.equal(c.refused, fixture.manifest.refusals.length);
});

test('s14 listing compared in BOTH directions: nothing vanishes, nothing appears', () => {
  const expected = new Set([...F.FIXTURE_ENTRIES.map(F.expectedPath), ...F.FIXTURE_NESTED_ENTRIES.map((e) => e.path)]);
  const m = fixture.manifest;
  const actual = new Set([...m.entries, ...m.excluded, ...m.refusals].map((e) => e.path));
  assert.deepEqual([...expected].filter((p) => !actual.has(p)), [], 'in the archive, absent from the manifest');
  assert.deepEqual([...actual].filter((p) => !expected.has(p)), [], 'in the manifest, absent from the archive');
});

test('s14 every fixture entry has the outcome the spec requires', () => {
  const m = fixture.manifest;
  const byPath = new Map([
    ...m.entries.map((e) => [e.path, { class: e.class }]),
    ...m.excluded.map((e) => [e.path, { excluded: e.rule }]),
    ...m.refusals.map((e) => [e.path, { refused: e.code }]),
  ]);
  const all = [...F.FIXTURE_ENTRIES.map((e) => [F.expectedPath(e), e.expect]),
               ...F.FIXTURE_NESTED_ENTRIES.map((e) => [e.path, e.expect])];
  for (const [p, want] of all) assert.deepEqual(byPath.get(p), want, p);
});

test('s18: every .js, .mjs, .cjs and extensionless entry is readable by path', () => {
  const targets = stored.entries.filter((e) => /\.(m|c)?js$/.test(e.path) || !/\.[^/]+$/.test(e.path.split('/').pop().replace(/^\./, '')));
  assert.ok(targets.length >= 10, `expected at least 10 targets, got ${targets.length}`);
  for (const e of targets) {
    if (e.class !== 'text') continue;
    const r = store.readEntry(stored.bundle_id, e.path);
    assert.equal(r.whole_file, true, e.path);
    assert.ok(r.content.length > 0, e.path);
  }
  for (const p of ['Dockerfile', '.dockerfile', 'Makefile', 'LICENSE', 'Procfile', 'src/lib/util.mjs', 'src/cjs/legacy.cjs']) {
    assert.ok(targets.some((t) => t.path === p), `${p} must be among the readable targets`);
  }
});

test('s9 byte round-trip for EVERY included entry, by hash', () => {
  const bytesIn = new Map([...fixture.blobs]);
  for (const e of fixture.manifest.entries) {
    const onDisk = readFileSync(join(STORE, 'blobs', e.sha256));
    assert.equal(sha(onDisk), e.sha256, e.path);
    assert.equal(sha(bytesIn.get(e.sha256)), e.sha256, e.path);
  }
  const cp = fixture.manifest.entries.find((e) => e.path === F.CP437_NAME_DECODED);
  assert.ok(cp, 'the cp437 name decoded to its intended characters');
  assert.equal(fixture.manifest.entries.find((e) => e.path === 'docs/café.md').class, 'text');
});

// ── s12: every refusal code as a pair ──────────────────────────────────────

const ok = (buf, opts) => { const r = ingestArchive(buf, opts); assert.equal(r.ok, true, JSON.stringify(r)); return r.manifest; };
const fatal = (buf, code, opts) => { const r = ingestArchive(buf, opts); assert.equal(r.ok, false); assert.equal(r.code, code); };
const refusedWith = (m, code) => m.refusals.filter((r) => r.code === code);

test('pair archive_too_deep: depth 3 refused, depth 2 accepted', () => {
  const nest = (n) => (n === 0 ? F.writeZip([{ name: 'leaf.txt', data: 'x' }])
    : F.writeZip([{ name: `l${n}.zip`, method: 0, data: nest(n - 1) }]));
  assert.equal(refusedWith(ok(nest(3)), 'archive_too_deep').length, 1);
  assert.equal(refusedWith(ok(nest(2)), 'archive_too_deep').length, 0);
  assert.equal(ok(nest(2)).complete, true);
});

test('pair archive_entry_count_exceeded: 5001 refused, 5000 accepted', () => {
  const many = (n) => F.writeZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: '', method: 0 })));
  fatal(many(DEFAULT_LIMITS.max_entries + 1), 'archive_entry_count_exceeded');
  assert.equal(ok(many(DEFAULT_LIMITS.max_entries)).counts.total, DEFAULT_LIMITS.max_entries);
});

test('pair archive_uncompressed_limit_exceeded: over the total refused, at the total accepted', () => {
  const limits = { max_total_uncompressed: 1000 };
  const two = F.writeZip([{ name: 'a.txt', data: 'a'.repeat(600) }, { name: 'b.txt', data: 'b'.repeat(600) }]);
  const one = F.writeZip([{ name: 'a.txt', data: 'a'.repeat(600) }, { name: 'b.txt', data: 'b'.repeat(400) }]);
  fatal(two, 'archive_uncompressed_limit_exceeded', { limits });
  ok(one, { limits });
});

test('declared sizes are bounded BEFORE extraction: a directory that over-declares is refused without inflating', () => {
  // Two entries whose central directory declares 600 bytes each but which hold
  // 5 bytes. Only the declared-total check can refuse this whole archive; the
  // extracted total is 10 bytes. A bound that only trusted extracted bytes
  // would inflate first and refuse the entries one by one as size mismatches.
  const lying = F.writeZip([{ name: 'a.txt', data: 'aaaaa', declared_size: 600 },
                            { name: 'b.txt', data: 'bbbbb', declared_size: 600 }]);
  fatal(lying, 'archive_uncompressed_limit_exceeded', { limits: { max_total_uncompressed: 1000 } });
  const honest = F.writeZip([{ name: 'a.txt', data: 'aaaaa' }, { name: 'b.txt', data: 'bbbbb' }]);
  ok(honest, { limits: { max_total_uncompressed: 1000 } });
});

test('pair archive_entry_too_large: 20 MiB + 1 refused, 20 MiB accepted (default bound)', () => {
  const at = (n) => F.writeZip([{ name: 'z.bin', data: Buffer.alloc(n) }]);
  assert.equal(refusedWith(ok(at(DEFAULT_LIMITS.max_entry_uncompressed + 1)), 'archive_entry_too_large').length, 1);
  assert.equal(ok(at(DEFAULT_LIMITS.max_entry_uncompressed)).counts.included, 1);
});

test('pair archive_encrypted: encryption flag refused, flag clear accepted', () => {
  fatal(F.writeZip([{ name: 's.txt', data: 'x', encrypted: true }]), 'archive_encrypted');
  ok(F.writeZip([{ name: 's.txt', data: 'x' }]));
});

test('pair archive_corrupt: a truncated archive refused, the intact one accepted', () => {
  const good = F.writeZip([{ name: 'a.txt', data: 'hello' }]);
  fatal(good.subarray(0, good.length - 5), 'archive_corrupt');
  fatal(Buffer.from('not a zip at all'), 'archive_corrupt');
  ok(good);
});

test('pair entry_path_unsafe: escaping paths refused, the repaired path accepted', () => {
  for (const bad of ['../x.txt', 'a/../../x.txt', '/etc/x.txt', 'C:/x.txt', 'C:\\x.txt', `${'a'.repeat(513)}`]) {
    assert.equal(refusedWith(ok(F.writeZip([{ name: bad, data: 'x' }])), 'entry_path_unsafe').length, 1, bad);
  }
  // The first-segment rule is what refuses these; pinned by its own reason so
  // the resolve-inside-root check behind it cannot silently stand in for it.
  assert.equal(checkEntryPath('../x.txt', 512).reason, 'path escapes the bundle root');
  assert.equal(checkEntryPath('a/../../x.txt', 512).reason, 'path escapes the bundle root');
  const m = ok(F.writeZip([{ name: 'x.txt', data: 'x' }]));
  assert.deepEqual([m.refusals.length, m.entries[0].path], [0, 'x.txt']);
  assert.equal(checkEntryPath('a/./b/../c.txt', 512).path, 'a/c.txt');
});

test('pair entry_symlink_refused: symlink mode refused, regular file accepted', () => {
  assert.equal(refusedWith(ok(F.writeZip([{ name: 'l', data: '/etc', mode: 0o120777 }])), 'entry_symlink_refused').length, 1);
  assert.equal(ok(F.writeZip([{ name: 'l', data: '/etc', mode: 0o100644 }])).counts.included, 1);
});

test('pair entry_size_mismatch: a lying size (either direction) refused, the true size accepted', () => {
  assert.equal(refusedWith(ok(F.writeZip([{ name: 'm.txt', data: 'twenty bytes of text', declared_size: 5 }])), 'entry_size_mismatch').length, 1);
  assert.equal(refusedWith(ok(F.writeZip([{ name: 'm.txt', data: 'short', declared_size: 50 }])), 'entry_size_mismatch').length, 1);
  assert.equal(refusedWith(ok(F.writeZip([{ name: 'm.txt', data: 'short', method: 0, declared_size: 9 }])), 'entry_size_mismatch').length, 1);
  assert.equal(ok(F.writeZip([{ name: 'm.txt', data: 'short' }])).counts.included, 1);
});

test('pair manifest_reconciliation_failed: an accounting missing one entry refused, repaired accepted', () => {
  const dirs = [{ walkId: 0, archive: '', count: 3 }];
  const counts = { total: 3, included: 2, excluded: 0, refused: 1 };
  const missing = new Map([['0#0', ['included']], ['0#1', ['included']]]);
  const r = reconcile(dirs, missing, counts);
  assert.equal(r.code, 'manifest_reconciliation_failed');
  assert.deepEqual(r.detail.missing, ['0#2']);
  const twice = new Map([['0#0', ['included', 'refused']], ['0#1', ['included']], ['0#2', ['refused']]]);
  assert.equal(reconcile(dirs, twice, counts).code, 'manifest_reconciliation_failed');
  const repaired = new Map([['0#0', ['included']], ['0#1', ['included']], ['0#2', ['refused']]]);
  assert.equal(reconcile(dirs, repaired, counts).ok, true);
});

test('pair decode_failed: invalid UTF-8 reads back lossily with decode_failed, valid UTF-8 decodes', () => {
  const bad = store.readEntry(stored.bundle_id, 'notes/latin1.txt');
  assert.deepEqual([bad.decode.ok, bad.decode.code, bad.decode.first_bad_offset], [false, 'decode_failed', 3]);
  const good = store.readEntry(stored.bundle_id, 'scripts/lf.txt');
  assert.equal(good.decode.ok, true);
});

test('pair binary_body_not_returned: a binary entry returns no body, a text entry does', () => {
  const bin = store.readEntry(stored.bundle_id, 'assets/logo.png');
  assert.deepEqual([bin.code, bin.body_returned, bin.content], ['binary_body_not_returned', false, undefined]);
  assert.equal(bin.preview, undefined, 'no preview unless asked for (D4)');
  const hex = store.readEntry(stored.bundle_id, 'assets/logo.png', { preview: 'hex', preview_bytes: 8 });
  assert.equal(hex.preview.data, '89504e470d0a1a0a');
  assert.equal(store.readEntry(stored.bundle_id, 'LICENSE').content.includes('MIT License'), true);
});

test('pair bundle_not_found: an unknown or expired id refused, a live one found', () => {
  assert.throws(() => store.getManifest('bnd_00000000000000000000'), (e) => e.code === 'bundle_not_found');
  assert.throws(() => store.getManifest('../../etc/passwd'), (e) => e.code === 'bundle_not_found');
  assert.equal(store.getManifest(stored.bundle_id).tree_hash_v2, stored.tree_hash_v2);
  assert.throws(() => store.loadBundle(stored.bundle_id, Date.parse(stored.expires_at) + 1), (e) => e.code === 'bundle_not_found');
});

// ── s9, s10: store behaviour ───────────────────────────────────────────────

test('s9 re-ingesting the same name updates and reports added, removed and changed', () => {
  const v1 = store.ingestBundle(F.writeZip([{ name: 'a.js', data: '1' }, { name: 'b.js', data: '2' }]), { name: 'proj.zip' });
  assert.equal(v1.update.status, 'created');
  const same = store.ingestBundle(F.writeZip([{ name: 'a.js', data: '1' }, { name: 'b.js', data: '2' }]), { name: 'proj.zip' });
  assert.deepEqual([same.update.status, same.bundle_id], ['unchanged', v1.bundle_id]);
  const v2 = store.ingestBundle(F.writeZip([{ name: 'a.js', data: 'changed' }, { name: 'c.js', data: '3' }]), { name: 'proj.zip' });
  assert.equal(v2.bundle_id, v1.bundle_id, 'one bundle, not two');
  assert.deepEqual([v2.update.status, v2.update.added, v2.update.removed, v2.update.changed],
                   ['updated', ['c.js'], ['b.js'], ['a.js']]);
  assert.notEqual(v2.tree_hash_v2, v1.tree_hash_v2);
});

test('s9 tree hash depends on paths and content, not entry order', () => {
  const a = treeHash([{ path: 'x', sha256: '1' }, { path: 'y', sha256: '2' }]);
  assert.equal(a, treeHash([{ path: 'y', sha256: '2' }, { path: 'x', sha256: '1' }]));
  assert.notEqual(a, treeHash([{ path: 'x', sha256: '2' }, { path: 'y', sha256: '1' }]));
});

test('D1 TTL is clamped to the uploads ceiling, and the sweep removes expired bundles and orphan blobs only', () => {
  assert.equal(store.clampTtlHours(1000), 24);
  assert.equal(store.clampTtlHours(2), 2);
  const shared = 'shared content\n';
  const keep = store.ingestBundle(F.writeZip([{ name: 's.txt', data: shared }]), { name: 'keep.zip', ttl_hours: 24 });
  const gone = store.ingestBundle(F.writeZip([{ name: 's.txt', data: shared }, { name: 'only.txt', data: 'orphan\n' }]),
    { name: 'gone.zip', ttl_hours: 1 });
  const r = store.sweepExpiredBundles(Date.now() + 2 * 3600 * 1000);
  assert.ok(r.bundles_removed >= 1);
  assert.throws(() => store.getManifest(gone.bundle_id), (e) => e.code === 'bundle_not_found');
  assert.equal(store.readEntry(keep.bundle_id, 's.txt').content.includes('shared content'), true,
    'a blob still referenced by a live bundle survives the sweep');
});

test('s10 paging by line range for long files, whole file for source-sized ones', () => {
  const long = Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n');
  const b = store.ingestBundle(F.writeZip([{ name: 'long.txt', data: long }, { name: 'crlf.txt', data: 'a\r\nb\r\n' }]), { name: 'paging.zip' });
  const p1 = store.readEntry(b.bundle_id, 'long.txt');
  assert.deepEqual([p1.whole_file, p1.start_line, p1.end_line, p1.total_lines, p1.next_start_line], [false, 1, 2000, 6000, 2001]);
  const p2 = store.readEntry(b.bundle_id, 'long.txt', { start_line: 5990, max_lines: 50 });
  assert.deepEqual([p2.end_line, p2.next_start_line], [6000, null]);
  assert.match(p2.content.split('\n')[0], /^5990\tline 5990$/);
  const c = store.readEntry(b.bundle_id, 'crlf.txt');
  assert.deepEqual([c.whole_file, c.line_endings, c.bytes_read, c.total_bytes], [true, 'crlf', 6, 6]);
  const u = store.readEntry(stored.bundle_id, 'docs/utf16.txt');
  assert.deepEqual([u.encoding, u.content.split('\n')[0]], ['utf-16le', '1\tWritten on Windows.']);
});

test('s10 search across text entries: path, line and matching line; literal and regex', async () => {
  const lit = await store.searchBundle(stored.bundle_id, { query: 'node:22' });
  assert.ok(lit.matches.some((m) => m.path === 'Dockerfile.prod' && m.line === 1));
  assert.ok(lit.matches.every((m) => typeof m.line === 'number' && m.text.includes('node:22')));
  const re = await store.searchBundle(stored.bundle_id, { query: '^export (function|const)', regex: true });
  assert.ok(re.matches.some((m) => m.path === 'nested/one-level.zip!/inner/a.js'));
  assert.equal((await store.searchBundle(stored.bundle_id, { query: 'line', max_results: 1 })).truncated, true);
  await assert.rejects(() => store.searchBundle(stored.bundle_id, { query: '(', regex: true }), (e) => e.code === 'query_invalid');
});

test('reads are refused for excluded and refused paths, with the reason', () => {
  // v13.31.0: entry_excluded, its own code (see the second review round below).
  assert.throws(() => store.readEntry(stored.bundle_id, 'node_modules/left-pad/index.js'), (e) => e.code === 'entry_excluded' && e.detail.excluded);
  assert.throws(() => store.readEntry(stored.bundle_id, 'link-to-etc'), (e) => e.code === 'entry_symlink_refused');
});

test('byte round-trip is enforced on read: a tampered blob is refused, never returned', () => {
  const b = store.ingestBundle(F.writeZip([{ name: 't.txt', data: 'original\n' }]), { name: 'tamper.zip' });
  const e = store.getManifest(b.bundle_id).entries[0];
  writeFileSync(join(STORE, 'blobs', e.sha256), 'tampered\n');
  assert.throws(() => store.readEntry(b.bundle_id, 't.txt'), (err) => err.code === 'entry_integrity_failed');
});

test('ingest from a file only inside the upload root', () => {
  const inside = join(UPLOAD_ROOT, '1700000000000_proj.zip');
  writeFileSync(inside, F.writeZip([{ name: 'a.js', data: 'x' }]));
  const r = store.ingestBundleFromFile(inside, UPLOAD_ROOT);
  assert.equal(r.name, 'proj.zip');
  const outside = join(STORE, 'outside.zip');
  writeFileSync(outside, F.writeZip([{ name: 'a.js', data: 'x' }]));
  assert.throws(() => store.ingestBundleFromFile(outside, UPLOAD_ROOT), (e) => e.code === 'bundle_source_not_allowed');
  assert.throws(() => store.ingestBundleFromFile(join(UPLOAD_ROOT, '..', 'nope.zip'), UPLOAD_ROOT), (e) => /bundle_source_/.test(e.code));
});

// ===========================================================================
// Review round (v13.30.0). One test per item, each failing before its fix.
// ===========================================================================

test('item 2: an invalid byte BEYOND the sniff window never makes a tool throw', async () => {
  // classifyEntry validates the first 8000 bytes only, so this entry is class
  // `text`; strict-decoding the whole entry used to throw, surfacing as an
  // internal error on read and killing search outright.
  const late = Buffer.concat([Buffer.from('a'.repeat(8300)), Buffer.from([0xE9]), Buffer.from('\nfindme tail\n')]);
  const b = store.ingestBundle(F.writeZip([{ name: 'late.txt', data: late },
    { name: 'clean.txt', data: 'findme clean\n' }, { name: 'other.txt', data: 'findme other\n' }]), { name: 'late.zip' });
  assert.equal(b.entries.find((e) => e.path === 'late.txt').class, 'text', 'classed text from its window');

  const r = store.readEntry(b.bundle_id, 'late.txt');
  assert.equal(r.decode.ok, false);
  assert.equal(r.decode.code, 'decode_failed');
  assert.equal(r.decode.first_bad_offset, 8300, 'the offset is recomputed over the whole entry');
  assert.ok(r.content.includes('tail'), 'the readable text is still returned');

  const s = await store.searchBundle(b.bundle_id, { query: 'findme' });
  assert.equal(s.matches.length, 3, 'one bad byte in one entry must not end the search');
  assert.equal(store.readEntry(b.bundle_id, 'clean.txt').decode.ok, true);
});

test('item 3: duplicate composed paths refuse the later entry instead of colliding', () => {
  const dupFile = ingestArchive(F.writeZip([{ name: 'd.txt', data: 'one\n' }, { name: 'd.txt', data: 'two\n' }]));
  assert.equal(dupFile.ok, true);
  assert.equal(dupFile.manifest.counts.included, 1);
  assert.equal(dupFile.manifest.refusals[0].code, 'entry_path_duplicate');
  assert.equal(dupFile.manifest.complete, false);
  assert.ok(dupFile.manifest.incomplete_reason);

  const inner = F.writeZip([{ name: 'x.js', data: '1\n' }]);
  const dupZip = ingestArchive(F.writeZip([{ name: 'a.zip', method: 0, data: inner },
                                           { name: 'a.zip', method: 0, data: inner }]));
  assert.equal(dupZip.ok, true, 'two same-named sibling archives no longer refuse the whole ingest');
  assert.equal(dupZip.manifest.entries.filter((e) => e.path === 'a.zip').length, 1);
  assert.equal(dupZip.manifest.refusals.filter((r) => r.code === 'entry_path_duplicate').length, 1);
  assert.ok(dupZip.manifest.entries.some((e) => e.path === 'a.zip!/x.js'), 'the first copy is still readable');
});

test('item 3: exclusions use real segments, so a directory named node_modules! is kept', () => {
  const m = ingestArchive(F.writeZip([{ name: 'node_modules!/keep.js', data: '1\n' },
    { name: 'node_modules/skip.js', data: '1\n' }])).manifest;
  assert.deepEqual(m.entries.map((e) => e.path), ['node_modules!/keep.js']);
  assert.deepEqual(m.excluded.map((e) => e.path), ['node_modules/skip.js']);

  const nested = ingestArchive(F.writeZip([{ name: 'inner.zip', method: 0,
    data: F.writeZip([{ name: 'node_modules/dep.js', data: '1\n' }, { name: 'src/a.js', data: '1\n' }]) }])).manifest;
  assert.ok(nested.excluded.some((e) => e.path === 'inner.zip!/node_modules/dep.js'), 'the rule still applies inside a nested archive');
  assert.ok(nested.entries.some((e) => e.path === 'inner.zip!/src/a.js'));
});

test('item 4: a backtracking regex is killed at the budget and the tool still answers', async () => {
  const line = `${'a'.repeat(40)}b`;
  const b = store.ingestBundle(F.writeZip([{ name: 'evil.txt', data: `${line}\n` },
    { name: 'plain.txt', data: 'needle here\n' }]), { name: 'redos.zip' });
  const t0 = Date.now();
  const r = await store.searchBundle(b.bundle_id, { query: '(a+)+$', regex: true });
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, `the scan must end at the budget, took ${ms}ms`);
  if (r.truncated) assert.equal(r.truncated_by, 'time_budget');
  const after = await store.searchBundle(b.bundle_id, { query: 'needle' });
  assert.equal(after.matches.length, 1, 'the connector still serves searches afterwards');
});

test('item 5: bytes_read is measured, not derived', () => {
  const crlf = 'alpha\r\nbeta\r\ngamma\r\n';   // 13 + 7 bytes over two pages
  const lf = 'alpha\nbeta\ngamma\n';           // 11 + 6
  const b = store.ingestBundle(F.writeZip([{ name: 'c.txt', data: crlf }, { name: 'l.txt', data: lf }]), { name: 'bytes.zip' });
  const p1 = store.readEntry(b.bundle_id, 'c.txt', { start_line: 1, max_lines: 2 });
  const p2 = store.readEntry(b.bundle_id, 'c.txt', { start_line: 3, max_lines: 2 });
  assert.equal(p1.bytes_read, Buffer.byteLength('alpha\r\nbeta\r\n'));
  assert.equal(p2.bytes_read, Buffer.byteLength('gamma\r\n'));
  assert.equal(p1.bytes_read + p2.bytes_read, p1.total_bytes, 'the pages account for the whole entry');

  const q1 = store.readEntry(b.bundle_id, 'l.txt', { start_line: 1, max_lines: 2 });
  const q2 = store.readEntry(b.bundle_id, 'l.txt', { start_line: 3, max_lines: 2 });
  assert.equal(q1.bytes_read, Buffer.byteLength('alpha\nbeta\n'));
  assert.equal(q2.bytes_read, Buffer.byteLength('gamma\n'));
  assert.equal(store.readEntry(b.bundle_id, 'l.txt').bytes_read, q1.total_bytes, 'a whole read reports the entry size');
});

test('item 6: the bundle name comes from the sidecar, and from either stored shape without one', () => {
  const zip = F.writeZip([{ name: 'a.js', data: '1\n' }]);
  const cases = [
    ['1700000000000_Gateway-Service.zip', null],                       // connector shape
    ['1700000000000_ab12cd34_Gateway-Service.zip', null],              // gateway shape
    ['1700000000000_ab12cd34_sanitised-name.zip', { original_name: 'Gateway-Service.zip' }],
    ['whatever-stored-name.bin', { original_name: 'Gateway-Service.zip' }],
  ];
  const ids = new Set();
  for (const [stored, meta] of cases) {
    const p = join(UPLOAD_ROOT, stored);
    writeFileSync(p, zip);
    if (meta) writeFileSync(`${p}.meta.json`, JSON.stringify(meta));
    const r = store.ingestBundleFromFile(p, UPLOAD_ROOT);
    assert.equal(r.name, 'Gateway-Service.zip', stored);
    ids.add(r.bundle_id);
  }
  assert.equal(ids.size, 1, 'the same original file is one bundle whichever service stored it');
});

test('item 8: named refusal for a missing name, and the code lists are separate', () => {
  assert.throws(() => store.ingestBundle(F.writeZip([{ name: 'a', data: 'b' }]), { name: '' }),
    (e) => e.code === 'name_required');
  const { REFUSAL_CODES, READ_CODES } = require_codes;
  assert.ok(REFUSAL_CODES.includes('entry_path_duplicate'));
  assert.equal(REFUSAL_CODES.includes('decode_failed'), false, 'read codes are not ingest refusals');
  assert.ok(READ_CODES.includes('decode_failed') && READ_CODES.includes('binary_body_not_returned'));
});

test('item 8: same-length blob corruption is repaired by re-ingest, and stale .tmp files are swept', () => {
  const zip = F.writeZip([{ name: 't.txt', data: 'original\n' }]);
  const b = store.ingestBundle(zip, { name: 'repair.zip' });
  const e = store.getManifest(b.bundle_id).entries[0];
  writeFileSync(join(STORE, 'blobs', e.sha256), 'tampered\n');   // same length
  assert.throws(() => store.readEntry(b.bundle_id, 't.txt'), (err) => err.code === 'entry_integrity_failed');
  store.ingestBundle(zip, { name: 'repair.zip' });
  assert.match(store.readEntry(b.bundle_id, 't.txt').content, /original/);

  const stale = join(STORE, 'blobs', 'abandoned.tmp');
  writeFileSync(stale, 'x');
  utimesSync(stale, new Date(Date.now() - 7200 * 1000), new Date(Date.now() - 7200 * 1000));
  const swept = store.sweepExpiredBundles(Date.now());
  assert.equal(swept.tmp_removed >= 1, true);
  assert.equal(existsSync(stale), false);
});

// ===========================================================================
// Second review round (v13.31.0).
// ===========================================================================

test('W-new: a corrupt blob is never searched, by regex or literally', async () => {
  // The store's guarantee is that a mismatch is reported, never silent bytes.
  // The regex path read blobs straight from disk and hashed nothing, so a
  // tampered blob's lines were returned to the caller for regex queries only.
  const b = store.ingestBundle(F.writeZip([{ name: 'tampered.txt', data: 'ORIGINAL marker here\n' },
    { name: 'intact.txt', data: 'ORIGINAL marker too\n' }]), { name: 'integrity-search.zip' });
  const bad = store.getManifest(b.bundle_id).entries.find((e) => e.path === 'tampered.txt');
  writeFileSync(join(STORE, 'blobs', bad.sha256), 'INJECTED marker here\n');   // same length

  for (const opts of [{ query: 'INJECTED' }, { query: 'INJECTED', regex: true },
                      { query: 'marker' }, { query: 'mark(er)', regex: true }]) {
    const r = await store.searchBundle(b.bundle_id, opts);
    assert.equal(r.matches.some((m) => m.path === 'tampered.txt'), false,
      `unverified bytes must not be searched: ${JSON.stringify(opts)}`);
    assert.deepEqual(r.integrity_failures, ['tampered.txt'], 'and the caller is told which entry failed');
  }

  // One bad blob must not end the search: the intact entry still answers.
  const r = await store.searchBundle(b.bundle_id, { query: 'ORIGINAL' });
  assert.deepEqual(r.matches.map((m) => m.path), ['intact.txt']);
  assert.equal((await store.searchBundle(b.bundle_id, { query: 'ORIGINAL', regex: true })).matches.length, 1);
  // And a direct read of it still refuses outright.
  assert.throws(() => store.readEntry(b.bundle_id, 'tampered.txt'), (e) => e.code === 'entry_integrity_failed');
});

test('W-new: a regex query alone cannot return unverified lines', async () => {
  // Isolated from the literal path, which refused a corrupt blob even before
  // this fix. Only the worker read blobs without hashing them, so this is the
  // test that fails on the pre-fix tree for the reason the review named.
  const b = store.ingestBundle(F.writeZip([{ name: 'swapped.txt', data: 'ORIGINAL line\n' }]), { name: 'regex-integrity.zip' });
  const e = store.getManifest(b.bundle_id).entries[0];
  writeFileSync(join(STORE, 'blobs', e.sha256), 'INJECTED line\n');
  const r = await store.searchBundle(b.bundle_id, { query: 'INJECT(ED)', regex: true });
  assert.deepEqual(r.matches, [], 'unverified bytes must not reach a regex result');
  assert.deepEqual(r.integrity_failures, ['swapped.txt']);
});

test('W-new: an excluded path has its own read code, distinct from not-in-bundle', () => {
  const { READ_CODES } = require_codes;
  assert.ok(READ_CODES.includes('entry_excluded'));
  try {
    store.readEntry(stored.bundle_id, 'node_modules/left-pad/index.js');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.equal(e.code, 'entry_excluded');
    assert.equal(e.detail.rule, 'node_modules/');
  }
  assert.throws(() => store.readEntry(stored.bundle_id, 'no/such/path.js'), (e) => e.code === 'entry_not_found');
});

test('W-new: the tool header describes the ingest surface that actually ships', () => {
  const src = readFileSync(new URL('../tools/bundle-tools.js', import.meta.url), 'utf8');
  assert.equal(/route can also ingest/.test(src), false, 'the route has not ingested since v13.30.0');
  assert.match(src, /does NOT ingest/);
});

// ── tenax work order 1, decisions D2, D3 and D4 ───────────────────────────

test('D4 an unflagged name whose bytes are valid UTF-8 decodes as UTF-8', () => {
  // Info-ZIP never sets the EFS flag, so before D4 the same tree packed by
  // `zip` and by a flag-setting tool produced different names, and therefore
  // different tree hashes for the same bytes.
  const utf8 = Buffer.from('café/naïve.txt', 'utf8');
  const unflagged = decodeEntryName(utf8, false);
  assert.equal(unflagged.name, 'café/naïve.txt');
  assert.equal(unflagged.decoding, 'utf-8-inferred');
  assert.equal(decodeEntryName(utf8, true).name, 'café/naïve.txt');
});

test('D4 an unflagged name that is NOT valid UTF-8 still decodes as CP437', () => {
  // The heuristic is bounded: genuinely CP437 bytes are read the CP437 way.
  // 0xE9 alone is not valid UTF-8. In CP437 it is Θ (U+0398), which is what
  // the published table says and what the decoder must produce.
  const cp437 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  const r = decodeEntryName(cp437, false);
  assert.equal(r.decoding, 'cp437');
  assert.equal(r.name, 'caf\u0398');
  assert.notEqual(r.name, 'café');
});

test('D4 an ASCII name is unaffected, whatever the flag says', () => {
  for (const flag of [true, false]) {
    assert.equal(decodeEntryName(Buffer.from('lib/a.js', 'utf8'), flag).name, 'lib/a.js');
  }
});

test('D2 the tree hash is the frame construction: path NUL size NUL sha256 LF, code-unit sorted', () => {
  const entries = [
    { path: 'b.txt', size: 2, sha256: 'b'.repeat(64) },
    { path: 'a.txt', size: 1, sha256: 'a'.repeat(64) },
  ];
  const expected = createHash('sha256')
    .update(`a.txt\u00001\u0000${'a'.repeat(64)}\n`, 'utf8')
    .update(`b.txt\u00002\u0000${'b'.repeat(64)}\n`, 'utf8')
    .digest('hex');
  assert.equal(treeHash(entries), expected);
  // Size is IN the preimage: the construction before D2 omitted it.
  assert.notEqual(treeHash(entries), treeHash([{ ...entries[0], size: 99 }, entries[1]]));
  assert.notEqual(treeHash(entries), treeHashV1Legacy(entries));
});

test('D2 the legacy construction is kept, unchanged, under its own name', () => {
  const entries = [{ path: 'a.txt', size: 1, sha256: 'a'.repeat(64) }];
  assert.equal(treeHashV1Legacy(entries),
    createHash('sha256').update(JSON.stringify([['a.txt', 'a'.repeat(64)]]), 'utf8').digest('hex'));
});

test('D3 the canonical exclusion set, with its revision recorded beside the hash', () => {
  assert.deepEqual([...DEFAULT_EXCLUSIONS.directories].sort(),
    ['.git', '.hg', '.next', '.svn', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);
  assert.deepEqual([...DEFAULT_EXCLUSIONS.files].sort(), ['.DS_Store', 'Thumbs.db']);
  assert.equal(EXCLUSION_SET_REVISION, 'tenax-exclusions-v1');
});

test('D3 the exclusion set is READ from the canonical file, not restated in code', async () => {
  // One file, one revision, two consumers. If the code carried its own copy,
  // this would pass while the two drifted; reading the file is what makes the
  // single source real.
  const { readFileSync } = await import('node:fs');
  const canonical = JSON.parse(readFileSync(new URL('../bundles/exclusions.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual([...DEFAULT_EXCLUSIONS.directories], canonical.directories.map((x) => x.name));
  assert.deepEqual([...DEFAULT_EXCLUSIONS.files], canonical.files.map((x) => x.name));
  assert.equal(EXCLUSION_SET_REVISION, canonical.revision);
  for (const e of [...canonical.directories, ...canonical.files]) {
    assert.ok(e.reason && e.reason.length > 0, `${e.name} has no reason; the reason column is what keeps the next edit honest`);
  }
});

test('D4 name_decoding reaches the manifest entry, where a consumer can see it', () => {
  // efs omitted: the flag is NOT set, which is what Info-ZIP does and what D4
  // exists for. Before D4 this entry's path was the cp437 mojibake.
  const zip = F.writeZip([
    { name: 'café/naïve.txt', data: 'unicode\n' },
    { name: 'plain.txt', data: 'ascii\n' },
  ]);
  const r = ingestArchive(zip, { exclusions: DEFAULT_EXCLUSIONS });
  assert.equal(r.ok, true);
  const byPath = new Map(r.manifest.entries.map((e) => [e.path, e]));
  assert.ok(byPath.has('café/naïve.txt'), `names: ${[...byPath.keys()].join(', ')}`);
  for (const e of r.manifest.entries) {
    assert.ok(['utf-8', 'utf-8-inferred', 'cp437'].includes(e.name_decoding), `${e.path}: ${e.name_decoding}`);
  }
});
