// src/bundles/zip-archive.js  v13.29.0
//
// The connector's one zip reader. SPEC-SOURCE-BUNDLE-001 s6.
//
// Lifted from src/homework/docx-text.js, which walked the central directory to
// pull word/document.xml out of a .docx. That walk was the right foundation and
// is kept: the central directory is authoritative, a local header's sizes can
// be zeroed by a streaming data descriptor, and a reader that trusts the local
// header yields empty content and no error. docx-text now calls this module, so
// the platform has one zip reader instead of two.
//
// What this adds, because a user-supplied archive is hostile input where a
// student's .docx mostly was not:
//
//   - Entry names decoded per the EFS flag (general-purpose bit 11): UTF-8 when
//     set, IBM code page 437 otherwise. Decoding everything as UTF-8 silently
//     renames every non-ASCII entry a cp437 writer produced, and a silent rename
//     breaks the manifest.
//   - Unix mode bits read from the external attributes when the entry was made
//     on a unix host, so symlink entries can be refused rather than materialised.
//   - The encryption flag (bit 0), so an encrypted entry is reported as such
//     instead of being inflated into garbage.
//   - zip64 archives refused as archive_corrupt with that reason: every bound
//     in this spec is far below the 4 GB / 65535-entry limits zip64 exists for,
//     so a zip64 marker here is either an unusual writer or a crafted file.
//   - Bounded extraction. inflateRawSync is given maxOutputLength = declared + 1,
//     so a central directory that under-declares a size cannot make the reader
//     inflate unbounded bytes: the overrun is detected at declared + 1 bytes and
//     reported as entry_size_mismatch. A bound on total bytes that trusts
//     declared values is a bound that trusts the attacker.
//   - CRC-32 verified with zlib.crc32 (Node 22): corrupt data is reported, not
//     returned.
//
// Nothing here writes to disk. This module reads a Buffer and returns records.

import { inflateRawSync, crc32 } from 'node:zlib';

/** Zip signatures, little-endian. */
export const EOCD_SIG = 0x06054b50;
export const CD_SIG   = 0x02014b50;
export const LFH_SIG  = 0x04034b50;

/** General-purpose flag bits. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_EFS_UTF8  = 0x0800;

/** Host system values in the high byte of "version made by". */
const HOST_UNIX = 3;

/** File-type bits of a unix st_mode. */
const S_IFMT  = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/**
 * IBM code page 437, bytes 0x80..0xFF. Bytes below 0x80 are ASCII.
 * Source: the published CP437 table (Unicode mapping CP437.TXT).
 */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/**
 * A zip-level failure with a spec refusal code.
 */
export class ZipError extends Error {
  /**
   * @param {string} code  One of the SPEC-SOURCE-BUNDLE-001 s12 codes.
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Decode an entry name from its raw bytes.
 * @param {Buffer} bytes
 * @param {boolean} utf8  The EFS flag.
 * @returns {{ name: string, ok: boolean }} ok is false when the EFS flag
 *   promised UTF-8 and the bytes are not valid UTF-8.
 */
export function decodeEntryName(bytes, utf8) {
  if (utf8) {
    try {
      return { name: new TextDecoder('utf-8', { fatal: true }).decode(bytes), ok: true };
    } catch {
      return { name: new TextDecoder('utf-8').decode(bytes), ok: false };
    }
  }
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return { name: s, ok: true };
}

/**
 * Locate the End of Central Directory record.
 *
 * Scanned BACKWARDS from the end because the EOCD is last and carries a
 * variable-length comment, so its offset cannot be computed. The 22-byte
 * minimum plus a 64 KB maximum comment bounds the search.
 *
 * @param {Buffer} buf
 * @returns {number} Offset, or -1.
 */
export function findEocd(buf) {
  const minimum = 22;
  if (!Buffer.isBuffer(buf) || buf.length < minimum) return -1;
  const earliest = Math.max(0, buf.length - minimum - 0xFFFF);
  for (let i = buf.length - minimum; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Whether a buffer begins with a zip signature (a local file header, or the
 * EOCD of an empty archive).
 * @param {Buffer|Uint8Array} bytes
 * @returns {boolean}
 */
export function hasZipSignature(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const b = bytes;
  return b[0] === 0x50 && b[1] === 0x4B &&
    ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06));
}

/**
 * Read every central directory record. Reads the WHOLE directory before any
 * caller classifies or filters anything, which is what makes entries_total a
 * count of the archive rather than a count of what a filter chose to see
 * (SPEC-SOURCE-BUNDLE-001 s7).
 *
 * @param {Buffer} buf
 * @returns {Array<object>} One record per central directory entry, in order.
 * @throws {ZipError} archive_corrupt on any structural failure.
 */
export function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('archive_corrupt', 'No end-of-central-directory record: not a zip archive.');

  const diskNo     = buf.readUInt16LE(eocd + 4);
  const cdDisk     = buf.readUInt16LE(eocd + 6);
  const count      = buf.readUInt16LE(eocd + 10);
  const cdSize     = buf.readUInt32LE(eocd + 12);
  const cdOffset   = buf.readUInt32LE(eocd + 16);

  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    throw new ZipError('archive_corrupt', 'zip64 archives are not supported.');
  }
  if (diskNo !== 0 || cdDisk !== 0) {
    throw new ZipError('archive_corrupt', 'Multi-disk (split) archives are not supported.');
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipError('archive_corrupt', 'Central directory extends past the end-of-central-directory record.');
  }

  const entries = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || buf.readUInt32LE(offset) !== CD_SIG) {
      throw new ZipError('archive_corrupt', `Central directory record ${index} is missing or truncated.`);
    }
    const madeBy       = buf.readUInt16LE(offset + 4);
    const flags        = buf.readUInt16LE(offset + 8);
    const method       = buf.readUInt16LE(offset + 10);
    const crc          = buf.readUInt32LE(offset + 16);
    const compressed   = buf.readUInt32LE(offset + 20);
    const uncompressed = buf.readUInt32LE(offset + 24);
    const nameLen      = buf.readUInt16LE(offset + 28);
    const extraLen     = buf.readUInt16LE(offset + 30);
    const commentLen   = buf.readUInt16LE(offset + 32);
    const external     = buf.readUInt32LE(offset + 38);
    const localAt      = buf.readUInt32LE(offset + 42);

    if (compressed === 0xFFFFFFFF || uncompressed === 0xFFFFFFFF || localAt === 0xFFFFFFFF) {
      throw new ZipError('archive_corrupt', 'zip64 archives are not supported.');
    }
    const end = offset + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new ZipError('archive_corrupt', `Central directory record ${index} overruns the directory.`);

    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen);
    const efs = (flags & FLAG_EFS_UTF8) !== 0;
    const decoded = decodeEntryName(rawName, efs);
    const host = madeBy >> 8;
    const mode = host === HOST_UNIX ? (external >>> 16) : 0;

    entries.push({
      index,
      name: decoded.name,
      name_decoding: efs ? 'utf-8' : 'cp437',
      name_valid: decoded.ok,
      flags,
      method,
      crc,
      compressed,
      uncompressed,
      local_offset: localAt,
      unix_mode: mode,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      is_symlink: mode !== 0 && (mode & S_IFMT) === S_IFLNK,
      is_directory: decoded.name.endsWith('/') || (mode !== 0 && (mode & S_IFMT) === S_IFDIR) ||
                    (host === 0 && (external & 0x10) !== 0),
    });
    offset = end;
  }
  return entries;
}

/**
 * Extract one entry's bytes, verifying the declared size and the CRC.
 *
 * @param {Buffer} buf  The whole archive.
 * @param {object} entry  A record from readCentralDirectory.
 * @returns {Buffer}
 * @throws {ZipError} entry_size_mismatch, archive_corrupt or archive_encrypted.
 */
export function extractEntry(buf, entry) {
  if (entry.encrypted) throw new ZipError('archive_encrypted', 'The entry is encrypted.');
  const at = entry.local_offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LFH_SIG) {
    throw new ZipError('archive_corrupt', 'Local file header is missing.');
  }
  // The local header's OWN name and extra lengths, which differ from the
  // central directory's: writers pad the local extra field for alignment.
  const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  if (dataAt + entry.compressed > buf.length) {
    throw new ZipError('archive_corrupt', 'Entry data runs past the end of the archive.');
  }
  const data = buf.subarray(dataAt, dataAt + entry.compressed);

  let out;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: entry.uncompressed + 1 });
    } catch (err) {
      if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) {
        throw new ZipError('entry_size_mismatch',
          `Inflated past the declared ${entry.uncompressed} bytes; refused before inflating further.`);
      }
      throw new ZipError('archive_corrupt', `Deflate stream is corrupt: ${err.message}`);
    }
  } else {
    throw new ZipError('archive_corrupt', `Compression method ${entry.method} is not supported.`);
  }

  if (out.length !== entry.uncompressed) {
    throw new ZipError('entry_size_mismatch',
      `Declared ${entry.uncompressed} bytes, extracted ${out.length}.`);
  }
  if ((crc32(out) >>> 0) !== (entry.crc >>> 0)) {
    throw new ZipError('archive_corrupt', 'CRC-32 does not match the extracted bytes.');
  }
  return out;
}

/**
 * Read one named entry, or null. The convenience the .docx reader needs.
 * Returns null for any failure, which is docx-text's established contract.
 * @param {Buffer} buf
 * @param {string} wanted  Exact entry name.
 * @returns {Buffer|null}
 */
export function readNamedEntry(buf, wanted) {
  let entries;
  try { entries = readCentralDirectory(buf); } catch { return null; }
  const entry = entries.find((e) => e.name === wanted);
  if (!entry) return null;
  try { return extractEntry(buf, entry); } catch { return null; }
}
