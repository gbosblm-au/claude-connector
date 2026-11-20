// src/utils/zipCentralDirectory.js  v1.1.0   (claude-connector v13.38.0)
// ---------------------------------------------------------------------------
// Read what a ZIP archive holds, from its central directory, and read one
// member's bytes. For the coding delivery tool (src/tools/coding-delivery.js),
// which must check that an archive fetched from the frame runner carries the
// WHOLE delivered tree before it is published (TENAX-2026-10-09-01 C2: a
// re-zipped archive carrying only edited members is a subset, not a
// deliverable).
//
// WHY THIS IS WRITTEN HERE
// ------------------------
// The connector depends on no ZIP library (package.json), and the archive
// tooling it does have is Python on the volume (archive_extract.py,
// zip_workspace.py), which is not in this repository and is not something a
// Node tool can import. What is needed is small: locate the end-of-central-
// directory record, walk the directory, and inflate one member with node:zlib.
//
// WHAT IT REFUSES
// ---------------
// ZIP64 (a count or size field at its sentinel), an encrypted member, a
// compression method other than STORE (0) or DEFLATE (8), and any record that
// runs past the bytes it sits in. Each is refused with code `zip_unreadable`
// and a message, never read as something it is not.
//
// v1.1.0 (13.38.0, TENAX-2026-10-10-02 C-LINK-CONTENT): readZipMemberAsync,
// for reading EVERY member of a delivery archive (up to 200 MiB) to check it
// against the frame's listing. It inflates on the thread pool (zlib.inflateRaw)
// and computes the CRC-32 in 4 MiB pieces with a turn of the event loop
// between them, so a large archive does not hold the connector's other
// requests while it is checked. The connector supports Node 20, which has no
// zlib.crc32, hence the table below. readZipMember (synchronous) is unchanged.
// ---------------------------------------------------------------------------

import { inflateRawSync, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify( inflateRaw );

/** How many bytes the yielding CRC-32 reads between turns of the event loop. */
export const YIELD_CHUNK = 4 * 1024 * 1024;

const SIG_END = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U16_SENTINEL = 0xffff;
const U32_SENTINEL = 0xffffffff;

/**
 * An error this module raises.
 *
 * @param {string} message
 * @returns {Error}
 */
function unreadable( message ) {
  const err = new Error( message );
  err.code = 'zip_unreadable';
  return err;
}

let CRC_TABLE = null;

/**
 * CRC-32 (IEEE 802.3), as ZIP records it. A table of its own because
 * zlib.crc32 only exists from Node 22.2 and the connector supports Node 20.
 *
 * v1.1.0: incremental. `previous` is the CRC-32 of the bytes before `buf`
 * (0 for none), so crc32( b, crc32( a ) ) === crc32( Buffer.concat( [ a, b ] ) ).
 *
 * @param {Buffer} buf
 * @param {number} [previous]
 * @returns {number} Unsigned.
 */
export function crc32( buf, previous = 0 ) {
  if ( ! CRC_TABLE ) {
    CRC_TABLE = new Uint32Array( 256 );
    for ( let n = 0; n < 256; n++ ) {
      let c = n;
      for ( let k = 0; k < 8; k++ ) c = ( c & 1 ) ? ( 0xedb88320 ^ ( c >>> 1 ) ) : ( c >>> 1 );
      CRC_TABLE[ n ] = c >>> 0;
    }
  }
  let crc = ( previous ^ 0xffffffff ) >>> 0;
  for ( let i = 0; i < buf.length; i++ ) crc = CRC_TABLE[ ( crc ^ buf[ i ] ) & 0xff ] ^ ( crc >>> 8 );
  return ( crc ^ 0xffffffff ) >>> 0;
}

/** One turn of the event loop. */
export function yieldToLoop() {
  return new Promise( ( resolve ) => setImmediate( resolve ) );
}

/**
 * CRC-32 of a buffer, YIELD_CHUNK bytes at a time with a turn of the event
 * loop between pieces (v1.1.0).
 *
 * @param {Buffer} buf
 * @param {number} [chunk]
 * @returns {Promise<number>} Unsigned.
 */
export async function crc32Yielding( buf, chunk = YIELD_CHUNK ) {
  let crc = 0;
  for ( let at = 0; at < buf.length; at += chunk ) {
    crc = crc32( buf.subarray( at, Math.min( buf.length, at + chunk ) ), crc );
    if ( at + chunk < buf.length ) await yieldToLoop();
  }
  return crc;
}

/**
 * The members of a ZIP archive, from its central directory.
 *
 * @param {Buffer} buf
 * @returns {Array<{ name: string, size: number, compressed: number, method: number,
 *                   crc: number, offset: number, encrypted: boolean, directory: boolean }>}
 * @throws {Error} code zip_unreadable.
 */
export function listZipMembers( buf ) {
  if ( ! Buffer.isBuffer( buf ) || buf.length < 22 ) throw unreadable( 'Too short to be a ZIP archive.' );
  const floor = Math.max( 0, buf.length - 22 - 0xffff );
  let at = -1;
  for ( let i = buf.length - 22; i >= floor; i-- ) {
    if ( buf.readUInt32LE( i ) === SIG_END ) { at = i; break; }
  }
  if ( at < 0 ) throw unreadable( 'No end of central directory record.' );
  const count = buf.readUInt16LE( at + 10 );
  const size = buf.readUInt32LE( at + 12 );
  const start = buf.readUInt32LE( at + 16 );
  if ( count === U16_SENTINEL || size === U32_SENTINEL || start === U32_SENTINEL ) {
    throw unreadable( 'The archive uses ZIP64, which this reader does not support.' );
  }
  if ( start + size > at ) throw unreadable( 'The central directory runs past its end record.' );
  const out = [];
  let p = start;
  for ( let n = 0; n < count; n++ ) {
    if ( p + 46 > at || buf.readUInt32LE( p ) !== SIG_CENTRAL ) {
      throw unreadable( `Central directory entry ${ n } is malformed.` );
    }
    const flags = buf.readUInt16LE( p + 8 );
    const method = buf.readUInt16LE( p + 10 );
    const crc = buf.readUInt32LE( p + 16 );
    const compressed = buf.readUInt32LE( p + 20 );
    const sizeOf = buf.readUInt32LE( p + 24 );
    const nameLen = buf.readUInt16LE( p + 28 );
    const extraLen = buf.readUInt16LE( p + 30 );
    const commentLen = buf.readUInt16LE( p + 32 );
    const offset = buf.readUInt32LE( p + 42 );
    if ( p + 46 + nameLen + extraLen + commentLen > at ) {
      throw unreadable( `Central directory entry ${ n } runs past the directory.` );
    }
    if ( compressed === U32_SENTINEL || sizeOf === U32_SENTINEL || offset === U32_SENTINEL ) {
      throw unreadable( `Central directory entry ${ n } uses ZIP64, which this reader does not support.` );
    }
    const name = buf.toString( 'utf8', p + 46, p + 46 + nameLen );
    out.push( {
      name, size: sizeOf, compressed, method, crc, offset,
      encrypted: ( flags & 0x1 ) === 0x1,
      directory: name.endsWith( '/' ),
    } );
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The uncompressed bytes of one member, checked against its recorded size and
 * CRC-32.
 *
 * @param {Buffer} buf The whole archive.
 * @param {{ name: string, size: number, compressed: number, method: number,
 *           crc: number, offset: number, encrypted: boolean }} member From listZipMembers.
 * @returns {Buffer}
 * @throws {Error} code zip_unreadable.
 */
export function readZipMember( buf, member ) {
  if ( member.encrypted ) throw unreadable( `${ member.name } is encrypted.` );
  const p = member.offset;
  if ( p + 30 > buf.length || buf.readUInt32LE( p ) !== SIG_LOCAL ) {
    throw unreadable( `The local header of ${ member.name } is missing or malformed.` );
  }
  const nameLen = buf.readUInt16LE( p + 26 );
  const extraLen = buf.readUInt16LE( p + 28 );
  const dataStart = p + 30 + nameLen + extraLen;
  const dataEnd = dataStart + member.compressed;
  if ( dataEnd > buf.length ) throw unreadable( `The data of ${ member.name } runs past the archive.` );
  const raw = buf.subarray( dataStart, dataEnd );
  let data;
  if ( member.method === 0 ) data = Buffer.from( raw );
  else if ( member.method === 8 ) {
    try {
      data = inflateRawSync( raw, { maxOutputLength: member.size + 1 } );
    } catch ( err ) {
      throw unreadable( `${ member.name } does not inflate: ${ err.message }` );
    }
  } else {
    throw unreadable( `${ member.name } uses compression method ${ member.method }; only STORE and DEFLATE are read.` );
  }
  if ( data.length !== member.size ) {
    throw unreadable( `${ member.name } is ${ data.length } bytes and its directory entry says ${ member.size }.` );
  }
  if ( crc32( data ) !== member.crc ) throw unreadable( `${ member.name } fails its CRC-32 check.` );
  return data;
}

/**
 * readZipMember, without holding the event loop (v1.1.0): DEFLATE is inflated
 * on the thread pool and the CRC-32 is computed in pieces. The same checks and
 * the same refusals, by the same code `zip_unreadable`.
 *
 * @param {Buffer} buf The whole archive.
 * @param {object} member From listZipMembers.
 * @returns {Promise<Buffer>}
 * @throws {Error} code zip_unreadable.
 */
export async function readZipMemberAsync( buf, member ) {
  if ( member.encrypted ) throw unreadable( `${ member.name } is encrypted.` );
  const p = member.offset;
  if ( p + 30 > buf.length || buf.readUInt32LE( p ) !== SIG_LOCAL ) {
    throw unreadable( `The local header of ${ member.name } is missing or malformed.` );
  }
  const nameLen = buf.readUInt16LE( p + 26 );
  const extraLen = buf.readUInt16LE( p + 28 );
  const dataStart = p + 30 + nameLen + extraLen;
  const dataEnd = dataStart + member.compressed;
  if ( dataEnd > buf.length ) throw unreadable( `The data of ${ member.name } runs past the archive.` );
  const raw = buf.subarray( dataStart, dataEnd );
  let data;
  if ( member.method === 0 ) data = Buffer.from( raw );
  else if ( member.method === 8 ) {
    try {
      data = await inflateRawAsync( raw, { maxOutputLength: member.size + 1 } );
    } catch ( err ) {
      throw unreadable( `${ member.name } does not inflate: ${ err.message }` );
    }
  } else {
    throw unreadable( `${ member.name } uses compression method ${ member.method }; only STORE and DEFLATE are read.` );
  }
  if ( data.length !== member.size ) {
    throw unreadable( `${ member.name } is ${ data.length } bytes and its directory entry says ${ member.size }.` );
  }
  if ( ( await crc32Yielding( data ) ) !== member.crc ) throw unreadable( `${ member.name } fails its CRC-32 check.` );
  return data;
}

export default { listZipMembers, readZipMember, readZipMemberAsync, crc32, crc32Yielding, yieldToLoop, YIELD_CHUNK };
