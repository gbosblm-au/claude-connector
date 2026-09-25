// src/bundles/classify.js  v13.29.0
//
// classifyEntry: the connector's one decision about what a file IS.
// SPEC-SOURCE-BUNDLE-001 s5.
//
// Content decides. The name is used only for a cost short-circuit and is never
// the authority. This removes the defect behind "Dockerfile / .dockerfile / .mjs
// are not ingested": the browser, the connector's upload gate and the gateway's
// upload gate all classified by extension, and extensionless names have none
// (on Node 22, path.extname returns '' for Dockerfile, .dockerfile, Makefile,
// .gitignore, LICENSE and Procfile).
//
// Order, each step for a stated reason:
//
//   1. Container check. A zip signature makes the entry `archive` whatever its
//      name, so notes.txt that is really a zip is not returned as mojibake.
//   2. Known-binary suffix. Cost only: an entry with such a suffix and a NUL in
//      its first 512 bytes is `binary` without the full sniff. With no NUL there
//      it falls through, so a .png that is really text is text.
//   3. Byte-order mark. UTF-32 is tested BEFORE UTF-16 because the UTF-32LE mark
//      (FF FE 00 00) begins with the UTF-16LE mark (FF FE). And BOMs are tested
//      BEFORE the NUL test: a UTF-16 file is full of NUL bytes and a naive sniff
//      calls it binary (the UTF-16 trap, real in Windows-authored zips).
//   4. NUL in the first 8000 bytes: `binary`. The test git and file(1) use.
//   5. Strict UTF-8 over the window: success is `text`; failure is
//      `text-uncertain` with the first failing byte offset recorded.
//   6. Anything unclassified is `unsupported`, a named outcome.

import { hasZipSignature } from './zip-archive.js';

export const SNIFF_WINDOW = 8000;
const QUICK_WINDOW = 512;

/** Cost short-circuit only; see step 2. Lower-case, with the dot. */
export const KNOWN_BINARY_SUFFIXES = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif', '.heic',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.o', '.obj', '.a', '.lib', '.so', '.dylib', '.dll', '.exe', '.class', '.pyc', '.wasm', '.node',
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.oga', '.flac', '.webm', '.mov', '.avi', '.mkv',
  '.pdf', '.sqlite', '.db',
]);

/**
 * The lower-cased suffix of the last path segment, including the dot, or ''.
 * Deliberately NOT path.extname: this is only used for the cost short-circuit,
 * and it must treat ".png" (a dotfile) as having no suffix, which extname does.
 * @param {string} path
 * @returns {string}
 */
function suffixOf(path) {
  const base = String(path || '').split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * Detect a byte-order mark.
 * @param {Uint8Array} b
 * @returns {{ encoding: string, length: number }|null}
 */
export function detectBom(b) {
  if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xFE && b[2] === 0x00 && b[3] === 0x00) return { encoding: 'utf-32le', length: 4 };
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xFE && b[3] === 0xFF) return { encoding: 'utf-32be', length: 4 };
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { encoding: 'utf-8', length: 3 };
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { encoding: 'utf-16le', length: 2 };
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { encoding: 'utf-16be', length: 2 };
  return null;
}

/**
 * Decode UTF-32 (TextDecoder does not support it).
 * @param {Uint8Array} b  Bytes after the BOM.
 * @param {boolean} little
 * @returns {string}
 * @throws {Error} on a length that is not a multiple of 4 or an invalid code point.
 */
function decodeUtf32(b, little) {
  if (b.length % 4 !== 0) throw new Error('UTF-32 length is not a multiple of 4');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 4) {
    const cp = dv.getUint32(i, little);
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) throw new Error(`invalid code point at byte ${i}`);
    s += String.fromCodePoint(cp);
  }
  return s;
}

/**
 * Decode bytes of a known encoding strictly. Strips the BOM.
 * @param {Uint8Array} bytes
 * @param {string} encoding  utf-8 | utf-16le | utf-16be | utf-32le | utf-32be
 * @returns {string}
 * @throws {Error} when the bytes are not valid in that encoding.
 */
export function decodeStrict(bytes, encoding) {
  const bom = detectBom(bytes);
  const body = bom && bom.encoding === encoding ? bytes.subarray(bom.length) : bytes;
  if (encoding === 'utf-32le') return decodeUtf32(body, true);
  if (encoding === 'utf-32be') return decodeUtf32(body, false);
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body);
}

/**
 * Offset of the first byte at which strict UTF-8 decoding fails, or -1.
 * A multi-byte sequence cut off by the END of a window that is shorter than the
 * whole entry is not a failure: the window boundary split it, not the data.
 * @param {Uint8Array} b
 * @param {boolean} truncated  Whether b is a prefix of a longer entry.
 * @returns {number}
 */
export function firstInvalidUtf8(b, truncated) {
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let need; let min;
    if (c < 0x80) { i += 1; continue; }
    if (c >= 0xC2 && c <= 0xDF) { need = 1; min = 0x80; }
    else if (c >= 0xE0 && c <= 0xEF) { need = 2; min = 0x800; }
    else if (c >= 0xF0 && c <= 0xF4) { need = 3; min = 0x10000; }
    else return i;
    if (i + need >= b.length) {
      // The sequence runs past the end of what we have. Every byte that IS
      // present must still be a continuation byte; if so, it is valid only
      // when the window is a prefix of a longer entry.
      for (let k = 1; i + k < b.length; k += 1) {
        if ((b[i + k] & 0xC0) !== 0x80) return i;
      }
      return truncated ? -1 : i;
    }
    let cp = c & (need === 1 ? 0x1F : need === 2 ? 0x0F : 0x07);
    for (let k = 1; k <= need; k += 1) {
      const cc = b[i + k];
      if ((cc & 0xC0) !== 0x80) return i;
      cp = (cp << 6) | (cc & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return i;
    i += need + 1;
  }
  return -1;
}

/**
 * Classify one entry by content.
 *
 * @param {string} path  Entry path, used only for the cost short-circuit.
 * @param {Uint8Array} bytes  The entry's bytes (the whole entry or at least a
 *   prefix of it; pass the whole entry when available).
 * @returns {{ class: 'text'|'text-uncertain'|'binary'|'archive'|'unsupported',
 *             encoding: string|null, confidence: 'high'|'low', sniffed: boolean,
 *             bom: boolean, first_bad_offset?: number, reason?: string }}
 */
export function classifyEntry(path, bytes) {
  if (!bytes || typeof bytes.length !== 'number') {
    return { class: 'unsupported', encoding: null, confidence: 'high', sniffed: false, bom: false, reason: 'no_bytes' };
  }
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length === 0) {
    return { class: 'text', encoding: 'utf-8', confidence: 'high', sniffed: true, bom: false };
  }

  // 1. Container check.
  if (hasZipSignature(b)) {
    return { class: 'archive', encoding: null, confidence: 'high', sniffed: true, bom: false };
  }

  // 2. Known-binary suffix: cost only, never the authority.
  if (KNOWN_BINARY_SUFFIXES.has(suffixOf(path)) && b.subarray(0, QUICK_WINDOW).includes(0)) {
    return { class: 'binary', encoding: null, confidence: 'high', sniffed: false, bom: false };
  }

  const window = b.subarray(0, SNIFF_WINDOW);
  const truncated = b.length > SNIFF_WINDOW;

  // 3. Byte-order mark, before the NUL test (the UTF-16 trap).
  const bom = detectBom(window);
  if (bom) {
    try {
      // Validate the whole entry when we have it: a BOM followed by invalid
      // data is not text of that encoding.
      decodeStrict(b, bom.encoding);
      return { class: 'text', encoding: bom.encoding, confidence: 'high', sniffed: true, bom: true };
    } catch (err) {
      return { class: 'unsupported', encoding: bom.encoding, confidence: 'low', sniffed: true, bom: true,
               reason: `bom_declared_${bom.encoding}_but_invalid: ${err.message}` };
    }
  }

  // 4. NUL in the window.
  if (window.includes(0)) {
    return { class: 'binary', encoding: null, confidence: 'high', sniffed: true, bom: false };
  }

  // 5. Strict UTF-8 over the window.
  const bad = firstInvalidUtf8(window, truncated);
  if (bad < 0) {
    return { class: 'text', encoding: 'utf-8', confidence: 'high', sniffed: true, bom: false };
  }
  return { class: 'text-uncertain', encoding: 'utf-8', confidence: 'low', sniffed: true, bom: false,
           first_bad_offset: bad };
}
