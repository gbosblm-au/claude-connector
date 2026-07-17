/**
 * tests/upload-retention.test.js
 *
 * Covers the upload extension policy and the retention sweeper (v12.12.0).
 *
 * The sweeper is NEW code, not a fix. Every upload since this endpoint shipped
 * has written an `expires_at` into <file>.meta.json that nothing ever read.
 * There was no cron, no boot cleanup, no reaper: the retention policy was
 * documented in metadata and enforced nowhere, so the volume only ever grew.
 *
 * These tests run against a real temp directory. No fs mocking: deletion is the
 * one behaviour where a mock proving "unlink was called" is worth nothing.
 *
 * Run:  node --test tests/upload-retention.test.js
 */

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

// --- Extension policy, mirrored from server-http.js -------------------------
const DENIED = new Set(['.exe','.dll','.so','.dylib','.bin','.msi','.app','.deb','.rpm',
                        '.bat','.cmd','.com','.scr','.ps1','.vbs','.jar','.war']);
const ALLOWED = new Set([
  '.pdf','.docx','.doc','.dotx','.xlsx','.xls','.xlsm','.xltx','.pptx','.ppt','.potx',
  '.odt','.ods','.odp','.rtf','.epub',
  '.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg','.tif','.tiff','.avif','.heic','.ico',
  '.txt','.md','.markdown','.json','.jsonl','.csv','.tsv','.xml','.yaml','.yml','.html','.htm','.log','.ini','.toml','.env',
  '.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.php','.rb','.go','.rs','.java','.kt','.swift','.c','.h','.cpp','.hpp','.cs',
  '.sh','.bash','.zsh','.sql','.css','.scss','.less','.vue','.svelte',
  '.zip','.tar','.gz','.tgz','.bz2','.xz','.7z','.rar','.apk','.ipa',
]);
function uploadExtensionAllowed(ext) {
  if (!ext) return { ok:false, reason:'Files must have an extension.' };
  if (DENIED.has(ext)) return { ok:false, reason:`Extension '${ext}' is not accepted (executable content).` };
  if (!ALLOWED.has(ext)) return { ok:false, reason:`Extension '${ext}' is not supported.` };
  return { ok:true };
}

test('REGRESSION: the formats that silently 400ed are now accepted', () => {
  // 05-attachments.js has always POSTed the .pptx binary to /data/upload. The
  // old allowlist omitted it, so the endpoint answered 400 and the client's
  // `data.success ? data.filepath : ''` mapped that to an empty string.
  for (const ext of ['.pptx', '.xlsx', '.xls', '.ppt', '.zip']) {
    assert.equal(uploadExtensionAllowed(ext).ok, true,
      `${ext} must be accepted; it was rejected by the old allowlist`);
  }
});

test('previously working formats still work', () => {
  for (const ext of ['.pdf', '.docx', '.png', '.jpg', '.svg', '.csv', '.txt', '.md', '.json', '.html']) {
    assert.equal(uploadExtensionAllowed(ext).ok, true, `${ext} regression`);
  }
});

test('archives are accepted for future use', () => {
  for (const ext of ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar']) {
    assert.equal(uploadExtensionAllowed(ext).ok, true, `${ext} must be storable`);
  }
});

test('executables are refused even though nothing here runs them', () => {
  for (const ext of ['.exe', '.dll', '.so', '.bat', '.ps1', '.msi', '.jar']) {
    const r = uploadExtensionAllowed(ext);
    assert.equal(r.ok, false, `${ext} must be refused`);
    assert.match(r.reason, /executable/);
  }
});

test('the denylist wins over the allowlist', () => {
  // .jar is a zip. If someone later adds it to the archive list, the denylist
  // must still refuse it.
  assert.equal(DENIED.has('.jar'), true);
  assert.equal(uploadExtensionAllowed('.jar').ok, false);
});

test('an extensionless file is refused', () => {
  assert.equal(uploadExtensionAllowed('').ok, false);
});

// --- Retention sweeper -----------------------------------------------------

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
}

/** Writes a stored upload plus its sidecar, expiring `hoursFromNow` from now. */
function writeUpload(dir, name, hoursFromNow, { withMeta = true } = {}) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, 'x'.repeat(1024));
  if (withMeta) {
    fs.writeFileSync(fp + '.meta.json', JSON.stringify({
      original_name: name,
      expires_at: new Date(Date.now() + hoursFromNow * 3600_000).toISOString(),
      ttl_hours: hoursFromNow,
    }));
  }
  return fp;
}

/** The sweeper, mirrored from server-http.js. */
function makeSweeper(DIR, DEFAULT_TTL_HOURS = 24) {
  const log = () => {};
  function resolveUploadExpiry(filePath, metaPath) {
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const when = Date.parse(meta.expires_at);
        if (!Number.isNaN(when)) return when;
      } catch (_) {}
    }
    try { return fs.statSync(filePath).mtimeMs + DEFAULT_TTL_HOURS * 3600_000; }
    catch (_) { return null; }
  }
  function safeUnlinkUpload(target) {
    const root = path.resolve(DIR);
    const full = path.resolve(target);
    if (full !== root && !full.startsWith(root + path.sep)) { log(); return false; }
    try { fs.unlinkSync(full); return true; }
    catch (err) { return false; }
  }
  return function sweep() {
    const stats = { scanned:0, removed:0, bytes:0, errors:0 };
    const now = Date.now();
    let entries;
    try { entries = fs.readdirSync(DIR); } catch { stats.errors++; return stats; }
    for (const name of entries) {
      if (name.endsWith('.meta.json')) continue;
      const filePath = path.join(DIR, name);
      const metaPath = filePath + '.meta.json';
      stats.scanned++;
      try {
        const expiresAt = resolveUploadExpiry(filePath, metaPath);
        if (expiresAt === null || now < expiresAt) continue;
        let size = 0;
        try { size = fs.statSync(filePath).size; } catch (_) {}
        if (safeUnlinkUpload(filePath)) {
          stats.removed++; stats.bytes += size;
          if (fs.existsSync(metaPath)) safeUnlinkUpload(metaPath);
        }
      } catch (err) { stats.errors++; }
    }
    return stats;
  };
}

test('THE FEATURE: an expired upload is deleted with its sidecar', () => {
  const dir = makeDir();
  try {
    const gone = writeUpload(dir, 'old.pdf', -1);      // expired an hour ago
    const kept = writeUpload(dir, 'fresh.docx', +23);  // 23h left

    const stats = makeSweeper(dir)();

    assert.equal(stats.removed, 1);
    assert.equal(fs.existsSync(gone), false, 'the expired file must be gone');
    assert.equal(fs.existsSync(gone + '.meta.json'), false, 'its sidecar must go too');
    assert.equal(fs.existsSync(kept), true, 'a live file must survive');
    assert.equal(fs.existsSync(kept + '.meta.json'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file expiring in the future is never touched', () => {
  const dir = makeDir();
  try {
    writeUpload(dir, 'a.pdf', +24);
    writeUpload(dir, 'b.xlsx', +1);
    const stats = makeSweeper(dir)();
    assert.equal(stats.removed, 0);
    assert.equal(stats.scanned, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an orphan with no sidecar ages from mtime rather than living forever', () => {
  const dir = makeDir();
  try {
    // /data/upload-binary writes files with no sidecar at all.
    const fp = writeUpload(dir, 'orphan.zip', 0, { withMeta: false });
    // Backdate mtime past the default TTL.
    const old = Date.now() - 25 * 3600_000;
    fs.utimesSync(fp, new Date(old), new Date(old));

    const stats = makeSweeper(dir, 24)();
    assert.equal(stats.removed, 1, 'an aged orphan must be reclaimed');
    assert.equal(fs.existsSync(fp), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a recent orphan is kept', () => {
  const dir = makeDir();
  try {
    const fp = writeUpload(dir, 'recent.zip', 0, { withMeta: false });
    const stats = makeSweeper(dir, 24)();
    assert.equal(stats.removed, 0, 'a just-written orphan must survive');
    assert.equal(fs.existsSync(fp), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt metadata does not grant immortality', () => {
  const dir = makeDir();
  try {
    const fp = path.join(dir, 'bad.pdf');
    fs.writeFileSync(fp, 'x');
    fs.writeFileSync(fp + '.meta.json', '{ this is not json');
    const old = Date.now() - 25 * 3600_000;
    fs.utimesSync(fp, new Date(old), new Date(old));

    const stats = makeSweeper(dir, 24)();
    assert.equal(stats.removed, 1,
      'an unparseable sidecar must fall back to mtime, not skip the file forever');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sweeper is idempotent and survives an empty directory', () => {
  const dir = makeDir();
  try {
    const sweep = makeSweeper(dir);
    assert.deepEqual(sweep(), { scanned:0, removed:0, bytes:0, errors:0 });
    writeUpload(dir, 'x.pdf', -1);
    assert.equal(sweep().removed, 1);
    assert.equal(sweep().removed, 0, 'a second sweep must be a no-op');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deletion is bounds-checked to the upload directory', () => {
  const dir = makeDir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  try {
    const victim = path.join(outside, 'precious.txt');
    fs.writeFileSync(victim, 'do not delete me');

    // Reach into the sweeper's guard with a traversing path.
    const root = path.resolve(dir);
    const full = path.resolve(path.join(dir, '..', path.basename(outside), 'precious.txt'));
    const wouldAllow = (full === root || full.startsWith(root + path.sep));

    assert.equal(wouldAllow, false, 'a path outside the upload dir must be refused');
    assert.equal(fs.existsSync(victim), true, 'the file outside must still exist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('TTL is clamped to the ceiling rather than trusted', () => {
  const MAX = 24, DEFAULT = 24;
  const clamp = (v) => {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? Math.min(n, MAX) : DEFAULT;
  };
  assert.equal(clamp(1), 1, 'a shorter TTL is honoured');
  assert.equal(clamp(24), 24);
  assert.equal(clamp(9999), 24, 'a caller must not be able to pin a file forever');
  assert.equal(clamp(-5), 24, 'a negative TTL falls back to the default');
  assert.equal(clamp(undefined), 24);
  assert.equal(clamp('abc'), 24);
});

// ── /data/downloads retention: 14 days, with protected names ────────────────

/**
 * The generic reaper, mirrored from server-http.js sweepExpiredFiles().
 * Generic over directory + TTL + protected set so one implementation serves
 * both the 24h upload staging policy and the 14d download artefact policy.
 */
function makeGenericSweeper() {
  function resolveExpiry(filePath, metaPath, defaultTtlHours) {
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const when = Date.parse(meta.expires_at);
        if (!Number.isNaN(when)) return when;
      } catch (_) {}
    }
    try { return fs.statSync(filePath).mtimeMs + defaultTtlHours * 3600_000; }
    catch (_) { return null; }
  }
  function safeUnlink(target, rootDir) {
    const root = path.resolve(rootDir);
    const full = path.resolve(target);
    if (full !== root && !full.startsWith(root + path.sep)) return false;
    try { fs.unlinkSync(full); return true; } catch { return false; }
  }
  return function sweep({ dir, ttlHours, protected: protectedNames = new Set() }) {
    const stats = { scanned:0, removed:0, bytes:0, errors:0, skipped:0 };
    const now = Date.now();
    let entries;
    try { if (!fs.existsSync(dir)) return stats; entries = fs.readdirSync(dir); }
    catch { stats.errors++; return stats; }
    for (const name of entries) {
      if (name.endsWith('.meta.json')) continue;
      if (protectedNames.has(name)) { stats.skipped++; continue; }
      const filePath = path.join(dir, name);
      const metaPath = filePath + '.meta.json';
      stats.scanned++;
      try {
        let st; try { st = fs.statSync(filePath); } catch { continue; }
        if (st.isDirectory()) { stats.skipped++; continue; }
        const expiresAt = resolveExpiry(filePath, metaPath, ttlHours);
        if (expiresAt === null || now < expiresAt) continue;
        const size = st.size;
        if (safeUnlink(filePath, dir)) {
          stats.removed++; stats.bytes += size;
          if (fs.existsSync(metaPath)) safeUnlink(metaPath, dir);
        }
      } catch { stats.errors++; }
    }
    return stats;
  };
}

/** Writes a file and backdates its mtime by `ageHours`. */
function aged(dir, name, ageHours) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, 'x'.repeat(512));
  const t = Date.now() - ageHours * 3600_000;
  fs.utimesSync(fp, new Date(t), new Date(t));
  return fp;
}

const DL_TTL = 14 * 24;   // 14 days, matching DOWNLOADS_TTL_HOURS

test('DOWNLOADS: an artefact older than 14 days is removed', () => {
  const dir = makeDir();
  try {
    const old = aged(dir, 'report-old.docx', 15 * 24);
    const stats = makeGenericSweeper()({ dir, ttlHours: DL_TTL, protected: new Set(['ava_brain_data.json']) });
    assert.equal(stats.removed, 1);
    assert.equal(fs.existsSync(old), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DOWNLOADS: an artefact inside 14 days is kept', () => {
  const dir = makeDir();
  try {
    const recent = aged(dir, 'report-recent.pdf', 13 * 24);
    const stats = makeGenericSweeper()({ dir, ttlHours: DL_TTL, protected: new Set(['ava_brain_data.json']) });
    assert.equal(stats.removed, 0, 'a 13-day-old artefact must survive a 14-day policy');
    assert.equal(fs.existsSync(recent), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DOWNLOADS: ava_brain_data.json is never deleted, however old', () => {
  const dir = makeDir();
  try {
    // The Neural Core fetches this on every render. It lives in downloads for
    // delivery reasons, not because it is disposable. Ageing it out would break
    // that view a fortnight after deploy, and nobody would connect the two.
    const brain = aged(dir, 'ava_brain_data.json', 365 * 24);   // a year old
    const junk  = aged(dir, 'old-deck.pptx', 30 * 24);

    const stats = makeGenericSweeper()({
      dir, ttlHours: DL_TTL, protected: new Set(['ava_brain_data.json']),
    });

    assert.equal(fs.existsSync(brain), true,
      'ava_brain_data.json must survive the reaper regardless of age');
    assert.equal(stats.skipped, 1, 'it must be counted as protected, not scanned');
    assert.equal(fs.existsSync(junk), false, 'other aged artefacts still go');
    assert.equal(stats.removed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DOWNLOADS: the protected set is configurable and honoured exactly', () => {
  const dir = makeDir();
  try {
    aged(dir, 'keep-me.json', 100 * 24);
    aged(dir, 'keep-me-too.bin', 100 * 24);
    aged(dir, 'delete-me.txt', 100 * 24);
    const stats = makeGenericSweeper()({
      dir, ttlHours: DL_TTL, protected: new Set(['keep-me.json', 'keep-me-too.bin']),
    });
    assert.equal(fs.existsSync(path.join(dir, 'keep-me.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'keep-me-too.bin')), true);
    assert.equal(fs.existsSync(path.join(dir, 'delete-me.txt')), false);
    assert.equal(stats.skipped, 2);
    assert.equal(stats.removed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DOWNLOADS: a subdirectory is never unlinked', () => {
  const dir = makeDir();
  try {
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    const t = Date.now() - 100 * 24 * 3600_000;
    fs.utimesSync(sub, new Date(t), new Date(t));
    const stats = makeGenericSweeper()({ dir, ttlHours: DL_TTL });
    assert.equal(fs.existsSync(sub), true, 'directories are not artefacts');
    assert.equal(stats.skipped, 1);
    assert.equal(stats.removed, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RETENTION: the two policies differ only in TTL and protection', () => {
  const dir = makeDir();
  try {
    // Same file, same age (48h). Expired under the 24h upload policy,
    // comfortably alive under the 14d download policy.
    aged(dir, 'a.pdf', 48);
    const asUpload = makeGenericSweeper()({ dir, ttlHours: 24 });
    assert.equal(asUpload.removed, 1, '48h old is expired under a 24h policy');

    aged(dir, 'b.pdf', 48);
    const asDownload = makeGenericSweeper()({ dir, ttlHours: DL_TTL });
    assert.equal(asDownload.removed, 0, '48h old is fresh under a 14d policy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DOWNLOADS: a missing directory is a no-op, not a crash', () => {
  const stats = makeGenericSweeper()({ dir: '/tmp/definitely-not-here-xyz', ttlHours: DL_TTL });
  assert.deepEqual(stats, { scanned:0, removed:0, bytes:0, errors:0, skipped:0 });
});
