// src/bundles/bundle-store.js  v13.29.0
//
// Persistence and read-back for source bundles. SPEC-SOURCE-BUNDLE-001 s9, s10,
// s11, and decisions D1 to D4 (2026-09-22):
//
//   D1  Bundles persist on the volume with a TTL, like uploads: 24 hours by
//       default, clamped to UPLOAD_MAX_TTL_HOURS (the uploads ceiling), and
//       removed by the same retention sweep.
//   D2  A separate store. Not the reading vault: a codebase is not a book, so it
//       never gets read_in_full, a reading-list entry or the WordPress tab.
//   D3  Default exclusions, and the applied list is in every response.
//   D4  Binary bodies are never returned. Metadata only; a hex or ASCII preview
//       of the first bytes is a separate field returned only when asked for.
//
// Layout under BUNDLE_DIR (default /data/bundles/):
//   blobs/<sha256>            entry bytes, content-addressed, shared by bundles
//   manifests/<bundle_id>.json the manifest plus identity and expiry
//
// Identity. The tree hash identifies CONTENT. The bundle_id identifies the
// SOURCE: it is derived from the bundle name (the uploaded file name unless a
// name is given), so re-ingesting a changed Gateway-Service.zip updates the
// same bundle and reports added, removed and changed paths against the previous
// ingest instead of creating a second bundle (s9). Re-ingesting identical
// content reports `unchanged`.
//
// Byte round-trip. Every read re-hashes the blob and compares it with the
// manifest's sha256; a mismatch is entry_integrity_failed, never silent bytes.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, realpathSync, statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ingestArchive, DEFAULT_EXCLUSIONS } from './bundle-ingest.js';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { decodeStrict, firstInvalidUtf8 } from './classify.js';
import { decodeEntryForSearch } from './decode-for-search.js';

export const DEFAULT_TTL_HOURS = 24;
/** An entry is returned whole up to this size (s10: sized for source, not prose). */
export const WHOLE_FILE_MAX_BYTES = 256 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const MAX_LINES_CEILING = 5000;
export const PREVIEW_MAX_BYTES = 4096;

const SEARCH_DEFAULT_RESULTS = 200;
const SEARCH_MAX_RESULTS = 1000;
const SEARCH_LINE_CAP = 2000;
const SEARCH_REGEX_MAX_LENGTH = 200;
const SEARCH_TIME_BUDGET_MS = 5000;

/** @returns {string} */
export function bundleRoot() {
  return process.env.BUNDLE_DIR || '/data/bundles/';
}

function dirs() {
  const root = bundleRoot();
  return { root, blobs: join(root, 'blobs'), manifests: join(root, 'manifests') };
}

function ensureDirs() {
  const d = dirs();
  for (const p of [d.root, d.blobs, d.manifests]) if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o755 });
  return d;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * The bundle id for a name.
 * @param {string} name
 * @returns {string}
 */
export function bundleIdFor(name) {
  return `bnd_${sha256(Buffer.from(String(name), 'utf8')).slice(0, 20)}`;
}

/**
 * Clamp a requested TTL the way /data/upload does.
 * @param {*} requested
 * @returns {number}
 */
export function clampTtlHours(requested) {
  const ceiling = parseInt(process.env.UPLOAD_MAX_TTL_HOURS || '24', 10);
  const max = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 24;
  const n = Number(requested);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : Math.min(DEFAULT_TTL_HOURS, max);
}

/** A named failure for the tools and routes to report. */
export class BundleError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

function manifestPath(bundleId) {
  if (!/^bnd_[0-9a-f]{20}$/.test(String(bundleId))) throw new BundleError('bundle_not_found', `No bundle ${bundleId}.`);
  return join(dirs().manifests, `${bundleId}.json`);
}

/**
 * Load a live (unexpired) bundle record.
 * @param {string} bundleId
 * @param {number} [now]
 * @returns {object}
 */
export function loadBundle(bundleId, now = Date.now()) {
  const p = manifestPath(bundleId);
  if (!existsSync(p)) throw new BundleError('bundle_not_found', `No bundle ${bundleId}.`);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  if (Date.parse(rec.expires_at) <= now) throw new BundleError('bundle_not_found', `Bundle ${bundleId} has expired.`);
  return rec;
}

/**
 * Ingest an archive buffer and persist it.
 *
 * @param {Buffer} buffer
 * @param {{ name: string, source_filename?: string, ttl_hours?: number, now?: number }} opts
 * @returns {object} The s11 response: bundle_id, tree_hash, counts, entries,
 *   exclusions_applied, refusals, complete (+ reason), plus update information.
 * @throws {BundleError} with the fatal refusal code when the ingest is refused.
 */
export function ingestBundle(buffer, opts) {
  const name = String(opts?.name || '').trim();
  if (!name) throw new BundleError('name_required', 'A bundle needs a name.');
  const result = ingestArchive(buffer, { exclusions: DEFAULT_EXCLUSIONS });
  if (!result.ok) throw new BundleError(result.code, result.message, result.detail);

  const d = ensureDirs();
  for (const [digest, bytes] of result.blobs) {
    const p = join(d.blobs, digest);
    // v13.30.0: identity is the digest, not the size. Same-length corruption of
    // a stored blob used to be left in place, and every later read of it failed
    // the integrity check with no way to repair it but expiry.
    let intact = false;
    if (existsSync(p)) {
      try { intact = statSync(p).size === bytes.length && sha256(readFileSync(p)) === digest; } catch { intact = false; }
    }
    if (!intact) writeAtomic(p, bytes);
  }

  const now = opts.now ?? Date.now();
  const bundleId = bundleIdFor(name);
  const ttl = clampTtlHours(opts.ttl_hours);
  let previous = null;
  try { previous = loadBundle(bundleId, now); } catch { previous = null; }

  let update = { status: 'created' };
  if (previous) {
    const before = new Map(previous.manifest.entries.map((e) => [e.path, e.sha256]));
    const after = new Map(result.manifest.entries.map((e) => [e.path, e.sha256]));
    const added = [...after.keys()].filter((p) => !before.has(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));
    const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
    // D2: compare on the v2 construction. A record stored before the rename
    // carries only the legacy value, so a first ingest after the change reads
    // as 'updated' with no entries added, removed or changed: the VALUE moved,
    // the tree did not. Said here rather than left for a reader to infer.
    const previousV2 = previous.manifest.tree_hash_v2 || null;
    update = {
      status: previousV2 === result.manifest.tree_hash_v2 ? 'unchanged'
        : previousV2 === null ? 'rehashed' : 'updated',
      previous_tree_hash_v2: previousV2,
      previous_tree_hash_v1_legacy: previous.manifest.tree_hash_v1_legacy || previous.manifest.tree_hash || null,
      added, removed, changed,
    };
  }

  const record = {
    bundle_id: bundleId,
    name,
    source_filename: opts.source_filename || name,
    created_at: previous ? previous.created_at : new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ttl_hours: ttl,
    expires_at: new Date(now + ttl * 3600 * 1000).toISOString(),
    manifest: result.manifest,
  };
  writeAtomic(join(d.manifests, `${bundleId}.json`), JSON.stringify(record));
  return responseFor(record, update);
}

/**
 * The s11 ingest response for a stored record.
 * @param {object} record
 * @param {object} update
 * @returns {object}
 */
function responseFor(record, update) {
  const m = record.manifest;
  return {
    bundle_id: record.bundle_id,
    name: record.name,
    tree_hash_v2: m.tree_hash_v2,
    tree_hash_algorithm: m.tree_hash_algorithm,
    tree_hash_v1_legacy: m.tree_hash_v1_legacy,
    exclusion_set: m.exclusion_set,
    counts: m.counts,
    entries: m.entries.map((e) => ({ path: e.path, size: e.size, class: e.class, sha256: e.sha256 })),
    excluded: m.excluded,
    exclusions_applied: m.exclusions_applied,
    refusals: m.refusals,
    complete: m.complete,
    ...(m.complete ? {} : { reason: m.incomplete_reason }),
    update,
    expires_at: record.expires_at,
  };
}

/**
 * The full manifest. s10 "fetch a manifest".
 * @param {string} bundleId
 * @returns {object}
 */
export function getManifest(bundleId) {
  const rec = loadBundle(bundleId);
  return { bundle_id: rec.bundle_id, name: rec.name, source_filename: rec.source_filename,
           created_at: rec.created_at, updated_at: rec.updated_at, expires_at: rec.expires_at, ...rec.manifest };
}

/**
 * List entries. s10.
 * @param {string} bundleId
 * @param {{ class?: string, path_prefix?: string, offset?: number, limit?: number }} [opts]
 * @returns {object}
 */
export function listEntries(bundleId, opts = {}) {
  const rec = loadBundle(bundleId);
  let rows = rec.manifest.entries;
  if (opts.class) rows = rows.filter((e) => e.class === opts.class);
  if (opts.path_prefix) rows = rows.filter((e) => e.path.startsWith(String(opts.path_prefix)));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 1000);
  return {
    bundle_id: bundleId,
    total: rows.length,
    offset,
    entries: rows.slice(offset, offset + limit).map((e) => ({ path: e.path, size: e.size, class: e.class, sha256: e.sha256 })),
    has_more: offset + limit < rows.length,
  };
}

/**
 * Read an entry's bytes, verifying them against the manifest hash.
 * @param {object} rec
 * @param {object} entry
 * @returns {Buffer}
 */
function readVerified(rec, entry) {
  const p = join(dirs().blobs, entry.sha256);
  if (!existsSync(p)) throw new BundleError('entry_integrity_failed', `The stored bytes for ${entry.path} are missing.`);
  const bytes = readFileSync(p);
  if (sha256(bytes) !== entry.sha256) {
    throw new BundleError('entry_integrity_failed', `The stored bytes for ${entry.path} do not match the manifest hash.`);
  }
  return bytes;
}

function findEntry(rec, path) {
  const entry = rec.manifest.entries.find((e) => e.path === path);
  if (entry) return entry;
  const refused = rec.manifest.refusals.find((r) => r.path === path);
  if (refused) throw new BundleError(refused.code, `${path} was refused at ingest: ${refused.reason}`, { path, refused: true });
  const excluded = rec.manifest.excluded.find((x) => x.path === path);
  // v13.31.0: its own code. "Excluded by rule" and "not in this bundle" are
  // different answers, and a client keying on the code could not tell them
  // apart while they shared entry_not_found.
  if (excluded) throw new BundleError('entry_excluded', `${path} was excluded at ingest by rule ${excluded.rule}.`, { path, excluded: true, rule: excluded.rule });
  throw new BundleError('entry_not_found', `${path} is not in bundle ${rec.bundle_id}.`, { path });
}

/**
 * Decode text bytes for display.
 * @returns {{ text: string, decode: object }}
 */
function decodeForRead(bytes, entry) {
  // v13.30.0: this must never throw. classifyEntry validates only the first
  // SNIFF_WINDOW bytes of a non-BOM entry, so an entry can be class `text` and
  // still hold an invalid byte beyond the window. Strict-decoding the whole
  // entry then threw, which surfaced as an internal error on bundle_read and
  // killed bundle_search outright, since search decodes every text entry it
  // scans. One bad byte in one file must not make a tool unusable.
  if (entry.class === 'text') {
    try {
      return { text: decodeStrict(bytes, entry.encoding || 'utf-8'), decode: { ok: true, encoding: entry.encoding } };
    } catch (err) {
      const encoding = entry.encoding || 'utf-8';
      // Recomputed over the WHOLE entry: the offset recorded at ingest, if any,
      // came from the window and cannot name a byte beyond it.
      const offset = encoding === 'utf-8' ? firstInvalidUtf8(bytes, false) : null;
      return {
        text: new TextDecoder(encoding === 'utf-8' ? 'utf-8' : encoding).decode(bytes),
        decode: { ok: false, code: 'decode_failed', encoding, lossy: true,
                  first_bad_offset: offset === null || offset < 0 ? null : offset,
                  beyond_sniff_window: true, reason: err.message },
      };
    }
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  return { text, decode: { ok: false, code: 'decode_failed', encoding: 'utf-8', lossy: true,
                           first_bad_offset: entry.first_bad_offset ?? null } };
}

/**
 * The byte length of a string in the entry's encoding. v13.30.0: used to
 * measure the segment that is actually returned, including its own line
 * terminators, instead of adding a separator count to a joined string. The old
 * arithmetic counted the join's newlines AND a separator per line, so a page of
 * n lines was over by n - 1 bytes, and mixed byte units for UTF-16.
 * @param {string} str
 * @param {string} encoding
 * @returns {number}
 */
function encodedLength(str, encoding) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return Buffer.byteLength(str, 'utf16le');
  if (encoding === 'utf-32le' || encoding === 'utf-32be') return [...str].length * 4;
  return Buffer.byteLength(str, 'utf8');
}

function lineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return 'none';
  if (crlf && lf) return 'mixed';
  return crlf ? 'crlf' : 'lf';
}

/**
 * Read one entry. s10, s11. Text is returned with line numbers; long files are
 * paged by line range. Binary bodies are never returned (D4).
 *
 * @param {string} bundleId
 * @param {string} path
 * @param {{ start_line?: number, max_lines?: number, preview?: 'hex'|'ascii', preview_bytes?: number }} [opts]
 * @returns {object}
 */
export function readEntry(bundleId, path, opts = {}) {
  const rec = loadBundle(bundleId);
  const entry = findEntry(rec, String(path));
  const bytes = readVerified(rec, entry);

  if (entry.class !== 'text' && entry.class !== 'text-uncertain') {
    const out = {
      bundle_id: bundleId, path: entry.path, class: entry.class, total_bytes: entry.size, sha256: entry.sha256,
      bytes_read: 0, whole_file: false, body_returned: false, code: 'binary_body_not_returned',
    };
    if (opts.preview === 'hex' || opts.preview === 'ascii') {
      const n = Math.min(Math.max(parseInt(opts.preview_bytes, 10) || 256, 1), PREVIEW_MAX_BYTES);
      const head = bytes.subarray(0, n);
      out.preview = {
        format: opts.preview,
        bytes: head.length,
        data: opts.preview === 'hex'
          ? head.toString('hex').replace(/(.{32})/g, '$1\n').trim()
          : Array.from(head, (c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join(''),
      };
    }
    return out;
  }

  const { text, decode } = decodeForRead(bytes, entry);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, parseInt(opts.start_line, 10) || 1);
  const max = Math.min(Math.max(parseInt(opts.max_lines, 10) || DEFAULT_MAX_LINES, 1), MAX_LINES_CEILING);
  const wholeEligible = start === 1 && entry.size <= WHOLE_FILE_MAX_BYTES && total <= MAX_LINES_CEILING;
  const count = wholeEligible && !opts.max_lines ? total : Math.min(max, Math.max(0, total - start + 1));
  const slice = lines.slice(start - 1, start - 1 + count);
  const endLine = slice.length ? start + slice.length - 1 : start - 1;
  const whole = start === 1 && endLine >= total;
  const width = String(Math.max(endLine, 1)).length;
  const content = slice.map((l, i) => `${String(start + i).padStart(width, ' ')}\t${l}`).join('\n');
  const eol = lineEndings(text);
  const endsWithTerminator = /\n$/.test(text);

  return {
    bundle_id: bundleId,
    path: entry.path,
    class: entry.class,
    encoding: entry.encoding,
    sha256: entry.sha256,
    total_bytes: entry.size,
    // Measured, not derived: the exact segment returned, terminators included.
    // A final line with no terminator in the file is not given one here.
    bytes_read: whole ? entry.size
      : encodedLength(slice.join(eol === 'crlf' ? '\r\n' : '\n')
        + (endLine < total || endsWithTerminator ? (eol === 'crlf' ? '\r\n' : '\n') : ''), entry.encoding),
    whole_file: whole,
    start_line: start,
    end_line: endLine,
    total_lines: total,
    line_endings: eol,
    decode,
    content,
    ...(whole ? {} : { next_start_line: endLine < total ? endLine + 1 : null }),
  };
}

/**
 * Search text entries. s10: ingestion without search is storage.
 *
 * Literal by default. A regex is used only when asked for, capped in pattern
 * length and applied to lines truncated to SEARCH_LINE_CAP characters under a
 * time budget, because a user-supplied pattern over a whole codebase is a
 * backtracking cost the connector should bound.
 *
 * @param {string} bundleId
 * @param {{ query: string, regex?: boolean, case_sensitive?: boolean, path_prefix?: string, max_results?: number }} opts
 * @returns {Promise<object>}
 */
export async function searchBundle(bundleId, opts = {}) {
  const rec = loadBundle(bundleId);
  const query = String(opts.query || '');
  if (!query) throw new BundleError('query_required', 'A search needs a query.');
  const max = Math.min(Math.max(parseInt(opts.max_results, 10) || SEARCH_DEFAULT_RESULTS, 1), SEARCH_MAX_RESULTS);
  const targets = rec.manifest.entries.filter((e) => (e.class === 'text' || e.class === 'text-uncertain')
    && (!opts.path_prefix || e.path.startsWith(String(opts.path_prefix))));

  if (opts.regex) {
    if (query.length > SEARCH_REGEX_MAX_LENGTH) {
      throw new BundleError('query_too_long', `A regex may be at most ${ SEARCH_REGEX_MAX_LENGTH } characters.`);
    }
    try { new RegExp(query); } catch (err) {
      throw new BundleError('query_invalid', `Invalid regular expression: ${ err.message }`);
    }
    return searchWithWorker(bundleId, targets, query, Boolean(opts.case_sensitive), max);
  }

  // Literal search stays on this thread: includes() cannot backtrack, so it is
  // bounded by the bytes it reads.
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  const q = opts.case_sensitive ? query : query.toLowerCase();
  const matches = [];
  const integrityFailures = [];
  let searched = 0;
  let stopped = null;
  for (const entry of targets) {
    // v13.31.0: verified like every other read, but one bad blob names itself
    // and the search goes on, the same shape the worker uses. A single corrupt
    // entry used to throw and end the whole search.
    let text;
    try {
      text = decodeEntryForSearch(readVerified(rec, entry), entry);
    } catch (err) {
      integrityFailures.push(entry.path);
      continue;
    }
    searched += 1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if ((opts.case_sensitive ? lines[i] : lines[i].toLowerCase()).includes(q)) {
        matches.push({ path: entry.path, line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= max) { stopped = 'max_results'; break; }
      }
    }
    if (stopped) break;
    if (Date.now() > deadline) { stopped = 'time_budget'; break; }
  }
  return { bundle_id: bundleId, query, regex: false, entries_searched: searched,
           matches, truncated: Boolean(stopped), ...(stopped ? { truncated_by: stopped } : {}),
           ...(integrityFailures.length ? { integrity_failures: integrityFailures } : {}) };
}

/**
 * Run a regex scan in a worker thread, killed at the budget. Review item 4.
 *
 * The worker posts its matches after every entry, so terminating it returns the
 * last checkpoint instead of nothing. Reported as truncated_by 'time_budget'.
 *
 * @param {string} bundleId
 * @param {Array<object>} targets
 * @param {string} pattern
 * @param {boolean} caseSensitive
 * @param {number} max
 * @returns {Promise<object>}
 */
function searchWithWorker(bundleId, targets, pattern, caseSensitive, max) {
  const workerPath = fileURLToPath(new URL('./search-worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    let checkpoint = { matches: [], entries_searched: 0, stopped: null };
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: { blobsDir: dirs().blobs, entries: targets.map((e) => ({ path: e.path, sha256: e.sha256,
        class: e.class, encoding: e.encoding })), pattern, caseSensitive, maxResults: max,
        lineCap: SEARCH_LINE_CAP, matchCap: 400 },
    });
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      const failures = checkpoint.integrity_failures || [];
      resolve({ bundle_id: bundleId, query: pattern, regex: true,
                entries_searched: checkpoint.entries_searched, matches: checkpoint.matches,
                truncated: Boolean(stopped), ...(stopped ? { truncated_by: stopped } : {}),
                ...(failures.length ? { integrity_failures: failures } : {}) });
    };
    const timer = setTimeout(() => finish('time_budget'), SEARCH_TIME_BUDGET_MS);
    worker.on('message', (m) => {
      if (m.type === 'error') {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        reject(new BundleError(m.code, m.message));
        return;
      }
      checkpoint = m;
      if (m.type === 'done') finish(m.stopped);
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BundleError('search_failed', `Search worker failed: ${ err.message }`));
    });
    worker.on('exit', () => finish(checkpoint.stopped));
  });
}

/**
 * Ingest a file that is already on the volume under an allowed root (the
 * upload directory). The path must resolve inside that root after symlinks.
 *
 * @param {string} filepath
 * @param {string} allowedRoot
 * @param {{ name?: string, ttl_hours?: number }} [opts]
 * @returns {object}
 */
export function ingestBundleFromFile(filepath, allowedRoot, opts = {}) {
  let real; let rootReal;
  try { rootReal = realpathSync(allowedRoot); real = realpathSync(resolve(String(filepath))); } catch {
    throw new BundleError('bundle_source_not_found', `No file at ${filepath}.`);
  }
  if (!real.startsWith(rootReal + sep)) {
    throw new BundleError('bundle_source_not_allowed', 'Only files in the upload directory can be ingested as bundles.');
  }
  const base = real.split(sep).pop();
  // v13.30.0: the bundle key is the ORIGINAL file name, and the two services
  // store uploads under different shapes: the connector writes
  // "<timestamp>_<safe name>", the gateway writes
  // "<timestamp>_<md5:8>_<safe name>". Stripping only the connector's shape
  // left a gateway-stored file deriving "ab12cd34_Name.zip", which could never
  // match, or update, a bundle created from the connector's copy. Both routes
  // write a "<file>.meta.json" sidecar carrying the original name, so that is
  // the authority; the two stored shapes are the fallback.
  const derived = originalNameFor(real, base);
  return ingestBundle(readFileSync(real), { name: opts.name || derived, source_filename: derived, ttl_hours: opts.ttl_hours });
}

/**
 * The original file name for a stored upload: the sidecar's original_name when
 * there is one, else the stored name with either service's prefix removed.
 * @param {string} real  Absolute path of the stored file.
 * @param {string} base  Its basename.
 * @returns {string}
 */
export function originalNameFor(real, base) {
  try {
    const meta = JSON.parse(readFileSync(`${ real }.meta.json`, 'utf8'));
    const name = meta && (meta.original_name || meta.filename);
    if (typeof name === 'string' && name.trim()) return name.trim().split(/[\\/]/).pop();
  } catch { /* no sidecar, or unreadable: fall back to the stored shape */ }
  return base
    .replace(/^\d{10,}_[0-9a-f]{8}_/, '')   // gateway: <ts>_<md5:8>_<name>
    .replace(/^\d{10,}_/, '');              // connector: <ts>_<name>
}

/**
 * Remove expired bundles, then blobs no live manifest references.
 * @param {number} [now]
 * @returns {{ bundles_removed: number, blobs_removed: number }}
 */
export function sweepExpiredBundles(now = Date.now()) {
  const d = dirs();
  if (!existsSync(d.manifests)) return { bundles_removed: 0, blobs_removed: 0 };
  let bundlesRemoved = 0;
  const live = new Set();
  for (const f of readdirSync(d.manifests)) {
    if (!f.endsWith('.json')) continue;
    const p = join(d.manifests, f);
    let rec;
    try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    if (Date.parse(rec.expires_at) <= now) {
      unlinkSync(p);
      bundlesRemoved += 1;
    } else {
      for (const e of rec.manifest.entries) live.add(e.sha256);
    }
  }
  let blobsRemoved = 0;
  if (existsSync(d.blobs)) {
    for (const f of readdirSync(d.blobs)) {
      if (/^[0-9a-f]{64}$/.test(f) && !live.has(f)) { unlinkSync(join(d.blobs, f)); blobsRemoved += 1; }
    }
  }
  // v13.30.0: a crash between writeFileSync and renameSync leaves a .tmp file
  // that nothing else ever removes.
  let tmpRemoved = 0;
  for (const dir of [ d.blobs, d.manifests ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tmp')) continue;
      try {
        if (now - statSync(join(dir, f)).mtimeMs > 3600 * 1000) { unlinkSync(join(dir, f)); tmpRemoved += 1; }
      } catch { /* vanished under us: nothing to remove */ }
    }
  }
  return { bundles_removed: bundlesRemoved, blobs_removed: blobsRemoved, tmp_removed: tmpRemoved };
}
