// src/utils/moduleLedger.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-3, TENAX-2026-10-15-01: module write audit ledger.
//
// One append-only line per mutation of a skill file: a module body, a manifest
// fragment registration, the canonical SKILL.md and its additions, and the
// personal files the compile reads (PERSONALITY.md, DISPATCH_RULES.json, and
// the CORE/MANIFEST files a WordPress push restores). Each line carries the
// file, the actor, the reason (the caller's change_note), the time, and the
// sha256 of the file before and after.
//
// WHY
// ---
// Prior versions are archived and backed up to WordPress, but nothing recorded
// what changed in a given mutation and why beyond a free-text change note that
// lived only in the WordPress backup. Two incidents in a fortnight each cost a
// verification round for want of a before/after record. With this ledger the
// question "what was this module before that write, and who made it" is a read.
//
// APPEND-ONLY, AND HOW THAT IS ENFORCED
// -------------------------------------
// Lines are only ever added, with O_APPEND (appendFileSync). Nothing in this
// module opens the ledger for writing in any other mode. Each line also
// carries `prev`, the sha256 of the line before it, so an edit in place is
// detectable by verifyLedgerChain(): changing any earlier line breaks the
// link from the line after it.
//
// WHERE
// -----
//   <skill base>/ava/.ledger/mutations.jsonl
//
// <skill base> is SKILL_FILE_PATH's directory. Paths in entries are relative to
// it ("SKILL.md", "ava/modules/meta/x.md"), so the ledger reads the same on
// any machine the volume is restored onto. A file outside the base (a tenant's
// /data/clients/<id>/ personal files) is recorded by its absolute path.
//
// FAILURE POSTURE
// ---------------
// A ledger append that fails is logged at error level and returned as
// { ok: false }. Callers decide: the module write path refuses a mutation it
// cannot record (H-11 hooks into the same surface), while the restore paths
// record what they can and report the gap in their results.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, appendFileSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join, relative, resolve as resolvePath, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { log } from './logger.js';

/** Closed set of mutation kinds. */
export const LEDGER_KINDS = Object.freeze( [ 'module', 'fragment', 'skill_file' ] );

/** Closed set of actions. */
export const LEDGER_ACTIONS = Object.freeze( [ 'create', 'overwrite', 'register', 'restore', 'rollback', 'merge', 'append', 'write' ] );

/** @returns {string} The skill base directory (SKILL_FILE_PATH's directory). */
export function skillBaseDir() {
  const skillFilePath = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  return skillFilePath.replace( /SKILL\.md$/, '' ) || './';
}

/** @returns {string} The ledger file path. */
export function ledgerPath() {
  return join( skillBaseDir(), 'ava', '.ledger', 'mutations.jsonl' );
}

/**
 * sha256 of a file's current bytes, or null when it does not exist.
 *
 * @param {string} absPath
 * @returns {{ sha256: string|null, bytes: number|null }}
 */
export function fileDigest( absPath ) {
  try {
    if ( ! absPath || ! existsSync( absPath ) ) return { sha256: null, bytes: null };
    const buf = readFileSync( absPath );
    return { sha256: createHash( 'sha256' ).update( buf ).digest( 'hex' ), bytes: buf.length };
  } catch {
    return { sha256: null, bytes: null };
  }
}

/**
 * sha256 of content about to be written.
 *
 * @param {string|Buffer} content
 * @returns {{ sha256: string, bytes: number }}
 */
export function contentDigest( content ) {
  const buf = Buffer.isBuffer( content ) ? content : Buffer.from( String( content ?? '' ), 'utf8' );
  return { sha256: createHash( 'sha256' ).update( buf ).digest( 'hex' ), bytes: buf.length };
}

/**
 * The ledger-relative name of a file: relative to the skill base when inside
 * it, absolute otherwise.
 *
 * @param {string} absPath
 * @returns {string}
 */
export function ledgerName( absPath ) {
  const base = resolvePath( skillBaseDir() );
  const full = resolvePath( absPath );
  const rel = relative( base, full );
  if ( rel && ! rel.startsWith( '..' ) && ! isAbsolute( rel ) ) return rel.split( '\\' ).join( '/' );
  return full;
}

/**
 * Normalise a caller's module reference to the ledger name.
 *
 * "meta/x.md", "modules/meta/x.md", "ava/modules/meta/x.md" and an absolute
 * path all name the same module; "SKILL.md" names the canonical skill file.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseLedgerQuery( raw ) {
  let p = String( raw || '' ).trim().replace( /\\/g, '/' );
  if ( ! p ) return '';
  if ( isAbsolute( p ) ) return ledgerName( p );
  p = p.replace( /^\.\//, '' ).replace( /^\/+/, '' );
  if ( p === 'SKILL.md' || p.startsWith( 'ava/' ) ) return p;
  if ( p.startsWith( 'modules/' ) || p.startsWith( 'references/' ) ) return `ava/${ p }`;
  if ( /\.(md|json)$/i.test( p ) && p.includes( '/' ) ) return `ava/modules/${ p }`;
  return `ava/${ p }`;
}

/**
 * The last line of the ledger, read from the end without loading the file.
 *
 * @returns {string|null}
 */
function lastLine() {
  const path = ledgerPath();
  if ( ! existsSync( path ) ) return null;
  const fd = openSync( path, 'r' );
  try {
    const size = fstatSync( fd ).size;
    if ( size === 0 ) return null;
    let window = Math.min( size, 64 * 1024 );
    for ( ;; ) {
      const buf = Buffer.alloc( window );
      readSync( fd, buf, 0, window, size - window );
      const text = buf.toString( 'utf8' ).replace( /\n+$/, '' );
      const nl = text.lastIndexOf( '\n' );
      if ( nl !== -1 || window === size ) return nl === -1 ? text : text.slice( nl + 1 );
      window = Math.min( size, window * 4 );
    }
  } finally {
    closeSync( fd );
  }
}

/**
 * Append one mutation record.
 *
 * @param {object} e
 * @param {string} e.file          Absolute path of the mutated file.
 * @param {string} e.kind          LEDGER_KINDS.
 * @param {string} e.action        LEDGER_ACTIONS.
 * @param {string} e.actor         Who: "mcp:direct", "gateway:tenant=t/user=7", "wordpress-restore".
 * @param {string} [e.reason]      Why: the caller's change_note.
 * @param {string} [e.tool]
 * @param {{sha256: string|null, bytes: number|null}} e.before
 * @param {{sha256: string|null, bytes: number|null}} e.after
 * @param {object} [e.extra]       Small structured context (module id, fragment action).
 * @returns {{ ok: boolean, entry?: object, error?: string }}
 */
export function appendLedgerEntry( { file, kind, action, actor, reason = '', tool = '', before, after, extra = null } ) {
  try {
    if ( ! LEDGER_KINDS.includes( kind ) ) throw new TypeError( `ledger kind "${ kind }" is not one of ${ LEDGER_KINDS.join( ', ' ) }` );
    if ( ! LEDGER_ACTIONS.includes( action ) ) throw new TypeError( `ledger action "${ action }" is not one of ${ LEDGER_ACTIONS.join( ', ' ) }` );
    const path = ledgerPath();
    mkdirSync( join( path, '..' ), { recursive: true } );
    const prevLine = lastLine();
    const entry = {
      at:            new Date().toISOString(),
      path:          ledgerName( file ),
      kind,
      action,
      actor:         String( actor || 'unknown' ).slice( 0, 120 ),
      reason:        String( reason || '' ).slice( 0, 1000 ),
      tool:          String( tool || '' ).slice( 0, 60 ),
      before_sha256: before && before.sha256 ? before.sha256 : null,
      after_sha256:  after && after.sha256 ? after.sha256 : null,
      bytes_before:  before && Number.isFinite( before.bytes ) ? before.bytes : null,
      bytes_after:   after && Number.isFinite( after.bytes ) ? after.bytes : null,
      prev:          prevLine ? createHash( 'sha256' ).update( prevLine, 'utf8' ).digest( 'hex' ) : null,
    };
    if ( extra && typeof extra === 'object' ) entry.extra = extra;
    appendFileSync( path, JSON.stringify( entry ) + '\n', { encoding: 'utf8', flag: 'a' } );
    return { ok: true, entry };
  } catch ( err ) {
    log( 'error', `[module-ledger] APPEND FAILED for ${ file }: ${ err.message }` );
    return { ok: false, error: err.message };
  }
}

/**
 * Every ledger line, parsed. A line that does not parse is returned as
 * { unparseable: true, line } rather than skipped, so a corrupted ledger shows.
 *
 * @returns {object[]}
 */
export function readAllLedgerEntries() {
  const path = ledgerPath();
  if ( ! existsSync( path ) ) return [];
  const out = [];
  for ( const line of readFileSync( path, 'utf8' ).split( '\n' ) ) {
    if ( ! line ) continue;
    try { out.push( JSON.parse( line ) ); } catch { out.push( { unparseable: true, line: line.slice( 0, 200 ) } ); }
  }
  return out;
}

/**
 * The last N mutations of one file, newest first.
 *
 * @param {string} query   Module path in any of the accepted spellings.
 * @param {number} [limit]
 * @returns {object[]}
 */
export function readLedgerFor( query, limit = 10 ) {
  const name = normaliseLedgerQuery( query );
  const n = Math.max( 1, Math.min( 200, Number.isFinite( limit ) ? Math.floor( limit ) : 10 ) );
  return readAllLedgerEntries().filter( ( e ) => e.path === name ).reverse().slice( 0, n );
}

/**
 * Check the hash chain: every line's `prev` must be the sha256 of the line
 * before it.
 *
 * @returns {{ ok: boolean, entries: number, broken_at: number|null }}
 */
export function verifyLedgerChain() {
  const path = ledgerPath();
  if ( ! existsSync( path ) ) return { ok: true, entries: 0, broken_at: null };
  const lines = readFileSync( path, 'utf8' ).split( '\n' ).filter( Boolean );
  for ( let i = 0; i < lines.length; i += 1 ) {
    let parsed;
    try { parsed = JSON.parse( lines[ i ] ); } catch { return { ok: false, entries: lines.length, broken_at: i }; }
    const expected = i === 0 ? null : createHash( 'sha256' ).update( lines[ i - 1 ], 'utf8' ).digest( 'hex' );
    if ( ( parsed.prev || null ) !== expected ) return { ok: false, entries: lines.length, broken_at: i };
  }
  return { ok: true, entries: lines.length, broken_at: null };
}

/**
 * Describe the caller for the ledger.
 *
 * @param {object|null} context  The per-call identity dispatchToolCall passes.
 * @param {string} [fallback]
 * @returns {string}
 */
export function actorFrom( context, fallback = 'mcp:direct' ) {
  if ( context && ( context.tenant_id || context.user_id ) ) {
    return `gateway:tenant=${ String( context.tenant_id || '' ).slice( 0, 40 ) }/user=${ String( context.user_id || '' ).slice( 0, 20 ) }`;
  }
  return fallback;
}

export default {
  LEDGER_KINDS, LEDGER_ACTIONS, skillBaseDir, ledgerPath, fileDigest, contentDigest, ledgerName,
  normaliseLedgerQuery, appendLedgerEntry, readAllLedgerEntries, readLedgerFor, verifyLedgerChain, actorFrom,
};
