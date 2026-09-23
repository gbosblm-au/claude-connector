// src/bundles/bundle-ingest.js  v13.29.0
//
// Turn an archive Buffer into a bundle manifest. Pure: no disk, no network, no
// clock. SPEC-SOURCE-BUNDLE-001 s6, s7, s8, s9, s11, s12.
//
// A bundle is a tree, not a book (s2): a manifest, a tree hash and entries
// addressable by path. No chapters, no ordinals, no read_in_full.
//
// ── The completeness predicate (s7) ──────────────────────────────────────────
//
// Every central directory is read IN FULL before any entry is classified, and
// entries_total is the sum of those directory counts. Each directory entry is
// then placed in exactly one of three buckets: included, excluded_by_rule,
// refused. Reconciliation is checked two ways: the counts must satisfy
//   entries_total = included + excluded + refused
// and the (archive, index) key of every directory entry must appear in exactly
// one bucket. The second check is what makes the first one mean something: a
// code path that forgot to record an entry, or recorded one twice, fails it
// even if some other slip made the arithmetic agree. Failure refuses the whole
// ingest with manifest_reconciliation_failed.
//
// ── Nested archives ──────────────────────────────────────────────────────────
//
// The uploaded archive is depth 0. An entry that sniffs as an archive is itself
// included (class archive), and, when its depth is within max_depth, its own
// central directory is read and its entries are added under the path
// "<entry path>!/<inner path>". An archive entry beyond max_depth is refused
// with archive_too_deep and its contents are never read, so they are never
// counted: entries_total counts only directories that were read.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { readCentralDirectory, extractEntry, ZipError } from './zip-archive.js';
import { classifyEntry } from './classify.js';

/** s6 bounds. */
export const DEFAULT_LIMITS = Object.freeze({
  max_depth: 2,
  max_entries: 5000,
  max_total_uncompressed: 200 * 1024 * 1024,
  max_entry_uncompressed: 20 * 1024 * 1024,
  max_path_length: 512,
});

/**
 * s8 default exclusions, declared and returned in every response. A directory
 * rule matches any path SEGMENT; a file rule matches the last segment.
 */
export const DEFAULT_EXCLUSIONS = Object.freeze({
  directories: Object.freeze(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__']),
  files: Object.freeze(['.DS_Store', 'Thumbs.db']),
});

/** s12. */
export const REFUSAL_CODES = Object.freeze([
  'archive_too_deep', 'archive_entry_count_exceeded', 'archive_uncompressed_limit_exceeded',
  'archive_entry_too_large', 'archive_encrypted', 'archive_corrupt', 'entry_path_unsafe',
  'entry_symlink_refused', 'entry_size_mismatch', 'manifest_reconciliation_failed',
  // v13.30.0: a zip may hold two entries with the same name, and two nested
  // archives with the same composed path would each contribute entries at one
  // path. First wins; later ones are refused by name rather than silently
  // shadowing, or colliding the reconciliation keys.
  'entry_path_duplicate',
]);

/** Codes a READ can answer with. Not ingest refusals; kept apart (v13.30.0). */
export const READ_CODES = Object.freeze([
  'decode_failed', 'binary_body_not_returned', 'bundle_not_found', 'entry_not_found',
  // v13.31.0: distinct from entry_not_found. The path IS in the archive; a
  // default exclusion rule kept it out of the readable set.
  'entry_excluded',
  'entry_integrity_failed',
]);

export const NESTED_SEPARATOR = '!/';

/**
 * Check and normalise one entry path. s6 path safety.
 * @param {string} name  Decoded entry name.
 * @param {number} maxLength
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function checkEntryPath(name, maxLength) {
  const raw = String(name);
  if (raw.length === 0) return { ok: false, reason: 'empty path' };
  if (raw.length > maxLength) return { ok: false, reason: `path longer than ${maxLength} characters` };
  if (raw.includes('\0')) return { ok: false, reason: 'path contains a NUL character' };
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (/^[A-Za-z]:/.test(slashed)) return { ok: false, reason: 'path carries a drive letter' };
  const normalised = posix.normalize(slashed);
  const first = normalised.split('/')[0];
  if (first === '..' || normalised === '.') return { ok: false, reason: 'path escapes the bundle root' };
  const root = '/__bundle_root__';
  const resolved = posix.resolve(root, normalised);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return { ok: false, reason: 'path resolves outside the bundle root' };
  return { ok: true, path: normalised.replace(/\/$/, '') };
}

/**
 * The exclusion rule a path matches, or null. s8.
 *
 * v13.30.0: takes the REAL segment array, built as each archive is walked,
 * rather than re-splitting the composed path. Splitting on the nested-archive
 * separator and then on '/' cannot tell a directory literally named
 * "node_modules!" from the separator that follows an archive called
 * "node_modules", so a real directory of that name had its children excluded
 * under the node_modules rule.
 *
 * @param {string[]} segments  Path segments, one per real directory level.
 * @param {{directories: string[], files: string[]}} exclusions
 * @returns {string|null}
 */
export function exclusionFor(segments, exclusions) {
  const segs = Array.isArray(segments) ? segments : String(segments).split('/');
  const last = segs[segs.length - 1];
  if (exclusions.files.includes(last)) return last;
  for (const s of segs.slice(0, -1)) if (exclusions.directories.includes(s)) return `${s}/`;
  return null;
}

/**
 * Tree hash over the sorted list of (path, sha256). s9.
 *
 * Serialised as JSON of [[path, sha256], ...] sorted by path in code-unit
 * order, then SHA-256 of that UTF-8 string. JSON rather than concatenation so
 * no path/hash pair can be confused with another by where a separator falls.
 * Written here because the codebases contain no existing implementation of
 * this construction (see the v13.29.0 changelog); this is its one home.
 *
 * @param {Array<{path: string, sha256: string}>} entries
 * @returns {string}
 */
export function treeHash(entries) {
  const pairs = entries.map((e) => [e.path, e.sha256])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** A fatal refusal of the whole ingest. */
function fatal(code, message, detail) {
  return { ok: false, code, message, detail: detail || null };
}

/**
 * The s7 completeness predicate. Every central directory entry that was read
 * must be placed in exactly one bucket, and the counts must satisfy
 * total = included + excluded + refused. Exported so the refusal can be tested
 * as a pair (s12): no input to a correct engine produces it, so it is exercised
 * by handing this function an accounting with one entry missing, and the same
 * accounting repaired.
 *
 * @param {Array<{walkId: number, archive: string, count: number}>} directories
 * @param {Map<string, string[]>} keysSeen  "<walkId>#<index>" -> buckets it was placed in
 * @param {{total: number, included: number, excluded: number, refused: number}} counts
 * @returns {{ ok: true } | { ok: false, code: string, message: string, detail: object }}
 */
export function reconcile(directories, keysSeen, counts) {
  const expected = [];
  for (const d of directories) for (let i = 0; i < d.count; i += 1) expected.push(`${d.walkId}#${i}`);
  const missing = expected.filter((k) => !keysSeen.has(k));
  const duplicated = [...keysSeen].filter(([, v]) => v.length !== 1).map(([k]) => k);
  const expectedSet = new Set(expected);
  const unexpected = [...keysSeen.keys()].filter((k) => !expectedSet.has(k));
  const countsAgree = counts.total === counts.included + counts.excluded + counts.refused
    && counts.total === expected.length;
  if (!countsAgree || missing.length || duplicated.length || unexpected.length) {
    return fatal('manifest_reconciliation_failed',
      'The manifest does not account for every central directory entry exactly once.',
      { ...counts, expected: expected.length, missing: missing.slice(0, 20),
        duplicated: duplicated.slice(0, 20), unexpected: unexpected.slice(0, 20) });
  }
  return { ok: true };
}

/**
 * Ingest an archive Buffer.
 *
 * @param {Buffer} buffer
 * @param {{ limits?: object, exclusions?: object }} [opts]
 * @returns {{ ok: true, manifest: object, blobs: Map<string, Buffer> }
 *         | { ok: false, code: string, message: string, detail: object|null }}
 */
export function ingestArchive(buffer, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const exclusions = opts.exclusions || DEFAULT_EXCLUSIONS;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return fatal('archive_corrupt', 'Empty input: not a zip archive.');
  }

  const included = [];
  const excluded = [];
  const refused = [];
  const blobs = new Map();
  // v13.30.0: keyed on a per-walk INSTANCE id, not the archive's path. Two
  // nested archives can share a composed path, and a path-keyed map made the
  // second walk overwrite the first's keys, which surfaced as
  // manifest_reconciliation_failed describing a counting fault that was not the
  // fault.
  const keysSeen = new Map();   // "<walkId>#<index>" -> buckets
  const directories = [];       // { walkId, archive, count }
  const includedPaths = new Set();
  let nextWalkId = 0;
  let entriesTotal = 0;
  let totalBytes = 0;

  const place = (bucket, list, walkId, index, record) => {
    const key = `${walkId}#${index}`;
    keysSeen.set(key, (keysSeen.get(key) || []).concat(bucket));
    list.push(record);
  };

  // Walk one archive. Returns a fatal refusal object, or null to continue.
  const walk = (buf, archivePath, depth, parentSegments) => {
    const walkId = nextWalkId;
    nextWalkId += 1;
    let cd;
    try {
      cd = readCentralDirectory(buf);
    } catch (err) {
      return fatal(err instanceof ZipError ? err.code : 'archive_corrupt', err.message);
    }
    if (depth === 0 && cd.some((e) => e.encrypted)) {
      return fatal('archive_encrypted', 'The archive contains encrypted entries.',
        { encrypted_entries: cd.filter((e) => e.encrypted).length });
    }

    entriesTotal += cd.length;
    directories.push({ walkId, archive: archivePath, count: cd.length });
    if (entriesTotal > limits.max_entries) {
      return fatal('archive_entry_count_exceeded',
        `The archive holds ${entriesTotal} entries; the limit is ${limits.max_entries}.`,
        { entries_total: entriesTotal, limit: limits.max_entries });
    }
    const declared = cd.reduce((n, e) => n + (e.is_directory ? 0 : e.uncompressed), 0);
    if (totalBytes + declared > limits.max_total_uncompressed) {
      return fatal('archive_uncompressed_limit_exceeded',
        `Declared uncompressed size exceeds ${limits.max_total_uncompressed} bytes.`,
        { declared_total: totalBytes + declared, limit: limits.max_total_uncompressed });
    }

    const prefix = archivePath ? `${archivePath}${NESTED_SEPARATOR}` : '';
    for (const e of cd) {
      const shown = `${prefix}${e.name}`;
      const base = { size: e.uncompressed, name_decoding: e.name_decoding };
      const refuse = (code, reason, path) =>
        place('refused', refused, walkId, e.index, { path: path || shown, ...base, code, reason });

      const checked = checkEntryPath(e.name, limits.max_path_length);
      if (!checked.ok || !e.name_valid) {
        refuse('entry_path_unsafe', checked.ok ? 'name is not valid UTF-8 despite the EFS flag' : checked.reason);
        continue;
      }
      const path = `${prefix}${checked.path}`;
      const segments = [...parentSegments, ...checked.path.split('/')];

      if (e.is_directory) {
        place('excluded', excluded, walkId, e.index, { path, size: 0, rule: 'directory entry' });
        continue;
      }
      const rule = exclusionFor(segments, exclusions);
      if (rule) {
        place('excluded', excluded, walkId, e.index, { path, size: e.uncompressed, rule });
        continue;
      }
      if (e.is_symlink) { refuse('entry_symlink_refused', 'symlink entry (unix mode bits)', path); continue; }
      // Defence in depth, and unreachable as the code stands: a top-level
      // encrypted entry is fatal above, and a nested archive holding one is
      // refused by the parent before it is walked. Kept so that a future
      // caller of walk() cannot admit an encrypted entry by accident.
      if (e.encrypted) { refuse('archive_encrypted', 'encrypted entry', path); continue; }
      if (e.uncompressed > limits.max_entry_uncompressed) {
        refuse('archive_entry_too_large', `declared ${e.uncompressed} bytes; the limit is ${limits.max_entry_uncompressed}`, path);
        continue;
      }

      let bytes;
      try {
        bytes = extractEntry(buf, e);
      } catch (err) {
        refuse(err instanceof ZipError ? err.code : 'archive_corrupt', err.message, path);
        continue;
      }
      totalBytes += bytes.length;
      if (totalBytes > limits.max_total_uncompressed) {
        return fatal('archive_uncompressed_limit_exceeded',
          `Extracted bytes exceed ${limits.max_total_uncompressed}.`, { extracted_total: totalBytes });
      }

      const cls = classifyEntry(path, bytes);
      if (cls.class === 'archive') {
        if (depth + 1 > limits.max_depth) {
          refuse('archive_too_deep', `nested archive at depth ${depth + 1}; the limit is ${limits.max_depth}`, path);
          continue;
        }
        let innerCd;
        try { innerCd = readCentralDirectory(bytes); } catch (err) {
          refuse(err instanceof ZipError ? err.code : 'archive_corrupt', err.message, path);
          continue;
        }
        if (innerCd.some((x) => x.encrypted)) {
          refuse('archive_encrypted', 'nested archive contains encrypted entries', path);
          continue;
        }
      }

      // v13.30.0: composed-path uniqueness, first wins. A duplicate name would
      // otherwise put two readable entries at one path, where a read can only
      // ever return one of them.
      if (includedPaths.has(path)) {
        refuse('entry_path_duplicate', 'another entry already occupies this path', path);
        continue;
      }
      includedPaths.add(path);

      const digest = sha256(bytes);
      blobs.set(digest, bytes);
      const record = { path, size: bytes.length, sha256: digest, class: cls.class, encoding: cls.encoding,
                       confidence: cls.confidence, sniffed: cls.sniffed };
      if (cls.first_bad_offset !== undefined) record.first_bad_offset = cls.first_bad_offset;
      if (cls.reason) record.reason = cls.reason;
      place('included', included, walkId, e.index, record);

      if (cls.class === 'archive') {
        const stop = walk(bytes, path, depth + 1, segments);
        if (stop) return stop;
      }
    }
    return null;
  };

  const stopped = walk(buffer, '', 0, []);
  if (stopped) return stopped;

  // s7: the identity, by count and by key.
  const verdict = reconcile(directories, keysSeen,
    { total: entriesTotal, included: included.length, excluded: excluded.length, refused: refused.length });
  if (!verdict.ok) return verdict;

  const complete = refused.length === 0;
  const manifest = {
    tree_hash: treeHash(included),
    counts: { total: entriesTotal, included: included.length, excluded: excluded.length, refused: refused.length },
    entries: included,
    excluded,
    exclusions_applied: { directories: [...exclusions.directories], files: [...exclusions.files], also: ['directory entries'] },
    refusals: refused.map((r) => ({ path: r.path, code: r.code, size: r.size, reason: r.reason })),
    complete,
    ...(complete ? {} : { incomplete_reason: `${refused.length} entr${refused.length === 1 ? 'y was' : 'ies were'} refused; see refusals` }),
    limits,
    archives_read: directories.map((d) => ({ path: d.archive || '(root)', entries: d.count })),
  };
  return { ok: true, manifest, blobs };
}
