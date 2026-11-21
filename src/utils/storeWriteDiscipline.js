// src/utils/storeWriteDiscipline.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-2, TENAX-2026-10-15-01: store-write discipline.
//
// WHAT THIS IS
// ------------
// A declared-writer mechanism per store family. A process that is about to
// rewrite a store (a restore from WordPress, a volume restore, an operator
// maintenance window) declares a CLAIM on that store family. While the claim is
// active, any write by anyone other than the holder is REFUSED, not applied,
// and the refusal names the holder. The refused content is not discarded: it
// is captured, with the state it would have replaced, to a forensics directory
// with a manifest.json.
//
// The protocol this implements is references/protocol/store-write-discipline.md
// (written by Ava in the same pass). Where the two disagree, the protocol is the
// authority and this file is the defect.
//
// WHY
// ---
// The failure this exists to prevent is a store rewritten while another
// process may hold a copy of it: the second writer's stale copy lands on top of
// the first writer's work, and nothing records what was lost. A refusal that
// names the holder turns a silent overwrite into a visible conflict; the
// capture turns "we lost it" into "it is in forensics/<dir>, with a manifest".
//
// STORE FAMILIES
// --------------
// The closed set is { references, modules, archive, scripts, vault }. The first
// four live on this connector's volume. The vault is the gateway's Reading Vault
// in Postgres and its discipline is implemented there (lib/store-claims.js);
// it is in the closed set here so a family name cannot be invented, and a claim
// on it from this side is refused with a pointer to where it lives.
//
// WHERE THE STATE LIVES
// ---------------------
//   <ava>/.store-discipline/claims/<family>.json          the active claim
//   <ava>/.store-discipline/claims/expired/*.json          lapsed claims, kept
//   <ava>/.store-discipline/forensics/<stamp>-<family>-<id>/
//       manifest.json      what was refused, by whom, against whom, hashes
//       attempted/<path>   the content the refused write carried
//       held/<path>        the content on disk that it would have replaced
//
// <ava> is the owner ava directory (SKILL_FILE_PATH's directory + 'ava/'), the
// same base getContentPaths() in tools/skill-content.js uses for the content
// stores. A test asserts the two derivations agree.
//
// A claim file is created atomically: written to a unique temporary name, then
// hard-linked onto the claim path. link(2) fails with EEXIST when a claim is
// already there, so two writers racing to declare cannot both succeed and a
// reader never sees a half-written claim.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  linkSync,
  unlinkSync,
  renameSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveContained } from './pathContainment.js';
import { log } from './logger.js';

/** The closed set of store families. Anything else is refused by name. */
export const STORE_FAMILIES = Object.freeze( [ 'references', 'modules', 'archive', 'scripts', 'vault' ] );

/** The families whose storage is on this connector's volume. */
export const CONNECTOR_STORE_FAMILIES = Object.freeze( [ 'references', 'modules', 'archive', 'scripts' ] );

/** Holder kinds. Closed, so a refusal can say what sort of process holds the store. */
export const HOLDER_KINDS = Object.freeze( [ 'operator', 'restore', 'import', 'process' ] );

/** Default claim lifetime: long enough for a restore, short enough to lapse if its holder dies. */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

/** Ceiling on any claim's lifetime. A claim that outlives a working day is an abandoned claim. */
export const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on the bytes one forensic capture writes. Beyond it, each further
 * file is still listed in the manifest with its hash and size and the reason it
 * was not copied, so nothing is dropped silently: the manifest says what the
 * sender still holds and must keep.
 */
export const FORENSIC_CAPTURE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Store directories, derived exactly as tools/skill-content.js getContentPaths()
 * derives them. Kept here rather than imported, because skill-content imports
 * this module and a cycle between the two would be a load-order hazard.
 *
 * @returns {{ avaDir: string, references: string, modules: string, archive: string, scripts: string }}
 */
export function storeDirs() {
  const skillFilePath = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  const baseDir = skillFilePath.replace( /SKILL\.md$/, '' );
  const avaDir = baseDir + 'ava/';
  return {
    avaDir,
    references: avaDir + 'references/',
    modules:    avaDir + 'modules/',
    archive:    avaDir + 'archive/',
    scripts:    avaDir + 'scripts/',
  };
}

/** @returns {string} The discipline root on the volume. */
export function disciplineRoot() {
  return join( storeDirs().avaDir, '.store-discipline' );
}

function claimsDir() { return join( disciplineRoot(), 'claims' ); }
function expiredDir() { return join( claimsDir(), 'expired' ); }
function forensicsDir() { return join( disciplineRoot(), 'forensics' ); }

/**
 * Validate a family name against the closed set.
 *
 * @param {unknown} family
 * @returns {{ ok: true, family: string } | { ok: false, code: string, message: string }}
 */
export function checkFamily( family ) {
  if ( typeof family !== 'string' || ! STORE_FAMILIES.includes( family ) ) {
    return {
      ok: false,
      code: 'unknown_store_family',
      message: `"${ String( family ).slice( 0, 40 ) }" is not a store family. The families are: ${ STORE_FAMILIES.join( ', ' ) }.`,
    };
  }
  if ( ! CONNECTOR_STORE_FAMILIES.includes( family ) ) {
    return {
      ok: false,
      code: 'store_family_not_on_connector',
      message: `The ${ family } store lives on the gateway (Postgres). Declare its claims there: Gateway Service lib/store-claims.js.`,
    };
  }
  return { ok: true, family };
}

function sha256( buf ) {
  return createHash( 'sha256' ).update( buf ).digest( 'hex' );
}

function nowIso( now = Date.now() ) {
  return new Date( now ).toISOString();
}

/**
 * Read one claim file. A file that cannot be parsed is treated as HELD by an
 * unknown holder, never as absent: an unreadable claim is still a claim, and
 * reading it as "no claim" is exactly the fail-open this module exists to stop.
 *
 * @param {string} path
 * @returns {object|null}
 */
function readClaimFile( path ) {
  if ( ! existsSync( path ) ) return null;
  try {
    const parsed = JSON.parse( readFileSync( path, 'utf8' ) );
    if ( parsed && typeof parsed === 'object' && parsed.claim_id ) return parsed;
  } catch { /* fall through */ }
  return {
    claim_id: 'unreadable',
    family: null,
    holder: { id: 'unknown:unreadable-claim-file', kind: 'process', label: 'unreadable claim file' },
    purpose: `claim file ${ path } could not be parsed; remove it by hand after checking no process holds the store`,
    declared_at: null,
    expires_at: null,
    unreadable: true,
  };
}

/**
 * The active claim on a family, or null. A lapsed claim is moved to
 * claims/expired/ (kept, not deleted) and reported as absent.
 *
 * @param {string} family
 * @param {number} [now]
 * @returns {object|null}
 */
export function activeClaim( family, now = Date.now() ) {
  const fam = checkFamily( family );
  if ( ! fam.ok ) return null;
  const path = join( claimsDir(), `${ family }.json` );
  const claim = readClaimFile( path );
  if ( ! claim ) return null;
  if ( claim.unreadable ) return claim;
  const expires = Date.parse( claim.expires_at || '' );
  if ( Number.isFinite( expires ) && expires <= now ) {
    try {
      mkdirSync( expiredDir(), { recursive: true } );
      renameSync( path, join( expiredDir(), `${ family }-${ claim.claim_id }.json` ) );
      log( 'info', `[store-discipline] claim on ${ family } by ${ claim.holder && claim.holder.id } lapsed at ${ claim.expires_at }; moved to claims/expired/` );
    } catch ( err ) {
      // Another process moved it first, or the rename failed. Either way the
      // claim has lapsed by its own record, so it is not active.
      if ( err && err.code !== 'ENOENT' ) log( 'warn', `[store-discipline] could not move lapsed claim ${ path }: ${ err.message }` );
    }
    return null;
  }
  return claim;
}

/**
 * Every active claim on this connector's families.
 *
 * @returns {object[]}
 */
export function listClaims() {
  const out = [];
  for ( const family of CONNECTOR_STORE_FAMILIES ) {
    const c = activeClaim( family );
    if ( c ) out.push( c );
  }
  return out;
}

/**
 * Build the holder record. `kind` is from the closed set; anything else is
 * refused rather than stored as free text.
 *
 * @param {{ kind?: string, label?: string }} h
 * @returns {object}
 */
function makeHolder( { kind = 'process', label = '' } = {} ) {
  const k = HOLDER_KINDS.includes( kind ) ? kind : null;
  if ( ! k ) throw new TypeError( `holder kind "${ String( kind ).slice( 0, 30 ) }" is not one of ${ HOLDER_KINDS.join( ', ' ) }` );
  const cleanLabel = String( label || '' ).replace( /[^\w .:@/-]/g, '' ).slice( 0, 80 ) || 'unnamed';
  return {
    id: `${ k }:${ cleanLabel }`,
    kind: k,
    label: cleanLabel,
    pid: process.pid,
    host: hostname(),
  };
}

/**
 * Declare a claim on a store family.
 *
 * @param {string} family
 * @param {object} opts
 * @param {string} opts.kind      Holder kind (HOLDER_KINDS).
 * @param {string} opts.label     Who: "brian", "wordpress-restore", "volume-restore".
 * @param {string} opts.purpose   Why, in a sentence. Required: a claim with no
 *                                purpose cannot be judged by whoever it refuses.
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @returns {{ ok: true, claim: object } | { ok: false, code: string, message: string, holder?: object, claim_id?: string, expires_at?: string }}
 */
export function declareClaim( family, { kind = 'process', label = '', purpose = '', ttlMs = DEFAULT_CLAIM_TTL_MS, now = Date.now() } = {} ) {
  const fam = checkFamily( family );
  if ( ! fam.ok ) return fam;
  const why = String( purpose || '' ).trim();
  if ( ! why ) return { ok: false, code: 'claim_purpose_required', message: 'A claim must state its purpose.' };

  let holder;
  try { holder = makeHolder( { kind, label } ); } catch ( err ) {
    return { ok: false, code: 'invalid_holder_kind', message: err.message };
  }

  const ttl = Math.min( Math.max( Number.isFinite( ttlMs ) ? Math.floor( ttlMs ) : DEFAULT_CLAIM_TTL_MS, 1000 ), MAX_CLAIM_TTL_MS );
  const claim = {
    claim_id: randomUUID(),
    family,
    holder,
    purpose: why.slice( 0, 500 ),
    declared_at: nowIso( now ),
    expires_at: nowIso( now + ttl ),
  };

  const dir = claimsDir();
  mkdirSync( dir, { recursive: true } );
  const path = join( dir, `${ family }.json` );

  // A lapsed claim is moved aside first so it does not block a new one.
  activeClaim( family, now );

  const tmp = join( dir, `.${ family }.${ claim.claim_id }.tmp` );
  const fd = openSync( tmp, 'wx' );
  try {
    writeSync( fd, JSON.stringify( claim, null, 2 ) + '\n' );
  } finally {
    closeSync( fd );
  }
  try {
    linkSync( tmp, path );
  } catch ( err ) {
    try { unlinkSync( tmp ); } catch { /* best effort */ }
    if ( err && err.code === 'EEXIST' ) {
      const held = readClaimFile( path ) || {};
      return {
        ok: false,
        code: 'claim_held',
        message: `The ${ family } store is already claimed by ${ held.holder ? held.holder.id : 'an unknown holder' }`
          + ( held.purpose ? ` ("${ held.purpose }")` : '' ) + ( held.expires_at ? ` until ${ held.expires_at }` : '' ) + '.',
        holder: held.holder || null,
        claim_id: held.claim_id || null,
        expires_at: held.expires_at || null,
      };
    }
    throw err;
  }
  try { unlinkSync( tmp ); } catch { /* the claim is in place; a stray temp name is harmless */ }
  log( 'info', `[store-discipline] claim declared on ${ family } by ${ holder.id } until ${ claim.expires_at }: ${ claim.purpose }` );
  return { ok: true, claim };
}

/**
 * Release a claim. Only the holder (by claim id) can release it.
 *
 * @param {string} family
 * @param {string} claimId
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function releaseClaim( family, claimId ) {
  const fam = checkFamily( family );
  if ( ! fam.ok ) return fam;
  const path = join( claimsDir(), `${ family }.json` );
  const claim = readClaimFile( path );
  if ( ! claim ) return { ok: true, code: 'no_claim', message: `No claim is held on ${ family }.` };
  if ( claim.claim_id !== claimId ) {
    return {
      ok: false,
      code: 'not_holder',
      message: `The claim on ${ family } is held by ${ claim.holder ? claim.holder.id : 'an unknown holder' }; only its holder can release it.`,
    };
  }
  try {
    mkdirSync( expiredDir(), { recursive: true } );
    renameSync( path, join( expiredDir(), `${ family }-${ claim.claim_id }-released.json` ) );
  } catch ( err ) {
    if ( err && err.code !== 'ENOENT' ) throw err;
  }
  log( 'info', `[store-discipline] claim on ${ family } released by ${ claim.holder && claim.holder.id }` );
  return { ok: true };
}

/**
 * Collision-free forensic directory name.
 *
 * @param {string} family
 * @param {number} now
 * @returns {string}
 */
function forensicName( family, now ) {
  const stamp = nowIso( now ).replace( /[-:]/g, '' ).replace( /\.\d{3}Z$/, 'Z' );
  return `${ stamp }-${ family }-${ randomBytes( 4 ).toString( 'hex' ) }`;
}

/**
 * Write one captured file under a capture root, contained.
 *
 * @returns {{ written: boolean, rel: string, reason?: string }}
 */
function writeCaptured( root, rel, buf ) {
  const safeRel = String( rel ).replace( /\\/g, '/' ).replace( /^\/+/, '' ).replace( /\.\.(\/|$)/g, '_parent_$1' ) || 'unnamed';
  // resolveContained measures containment against the base's real path, so
  // the base must exist before a not-yet-existing file can be placed in it.
  mkdirSync( root, { recursive: true } );
  const full = resolveContained( root, safeRel );
  if ( ! full ) return { written: false, rel: safeRel, reason: 'path could not be contained inside the capture directory' };
  mkdirSync( dirname( full ), { recursive: true } );
  writeFileSync( full, buf );
  return { written: true, rel: safeRel };
}

/**
 * Capture a refused write to forensics, with a manifest.
 *
 * Nothing here may throw past its caller: a capture that fails must not turn a
 * refusal into an unhandled error. The failure is reported in the return value
 * and logged at error level, and the refusal still stands.
 *
 * @param {object} o
 * @param {string} o.family
 * @param {Array<{ rel: string, content: string|Buffer }>} o.attempted
 * @param {string} [o.storeDir]   Directory to read the held state from.
 * @param {string} o.tool
 * @param {string} o.actor
 * @param {object} o.refusal      { code, holder, claim_id, message }
 * @param {number} [o.now]
 * @returns {{ ok: boolean, dir: string|null, manifest?: object, error?: string }}
 */
export function captureForensics( { family, attempted = [], storeDir = null, tool = 'unknown', actor = 'unknown', refusal = {}, now = Date.now() } ) {
  try {
    const name = forensicName( family, now );
    const root = join( forensicsDir(), name );
    mkdirSync( root, { recursive: true } );

    let budget = FORENSIC_CAPTURE_MAX_BYTES;
    const files = [];

    for ( const item of attempted ) {
      const buf = Buffer.isBuffer( item.content ) ? item.content : Buffer.from( String( item.content ?? '' ), 'utf8' );
      const entry = { role: 'attempted', path: String( item.rel ), sha256: sha256( buf ), bytes: buf.length };
      if ( buf.length <= budget ) {
        const w = writeCaptured( join( root, 'attempted' ), item.rel, buf );
        entry.captured = w.written;
        entry.captured_as = w.written ? `attempted/${ w.rel }` : null;
        if ( ! w.written ) entry.reason = w.reason;
        else budget -= buf.length;
      } else {
        entry.captured = false;
        entry.reason = 'capture bound reached; the sender still holds this file and must keep it';
      }
      files.push( entry );

      // The state the write would have replaced. Read, never followed through
      // a symlink, and only when the store directory is known.
      if ( storeDir ) {
        const heldPath = resolveContained( storeDir, String( item.rel ) );
        if ( heldPath && existsSync( heldPath ) && statSync( heldPath ).isFile() ) {
          const held = readFileSync( heldPath );
          const h = { role: 'held', path: String( item.rel ), sha256: sha256( held ), bytes: held.length };
          if ( held.length <= budget ) {
            const w = writeCaptured( join( root, 'held' ), item.rel, held );
            h.captured = w.written;
            h.captured_as = w.written ? `held/${ w.rel }` : null;
            if ( ! w.written ) h.reason = w.reason;
            else budget -= held.length;
          } else {
            h.captured = false;
            h.reason = 'capture bound reached; the held file is still on disk, unchanged';
          }
          files.push( h );
        }
      }
    }

    const manifest = {
      schema: 'tenax.store-forensics/1',
      captured_at: nowIso( now ),
      family,
      tool,
      actor,
      refusal: {
        code: refusal.code || 'store_claimed',
        message: refusal.message || '',
        holder: refusal.holder || null,
        claim_id: refusal.claim_id || null,
      },
      files,
      note: 'Nothing in this directory was applied to the store. "attempted" is what the refused write carried; "held" is what it would have replaced.',
    };
    writeFileSync( join( root, 'manifest.json' ), JSON.stringify( manifest, null, 2 ) + '\n' );
    log( 'warn', `[store-discipline] refused ${ tool } on ${ family } (holder ${ manifest.refusal.holder ? manifest.refusal.holder.id : 'unknown' }); captured to forensics/${ name }` );
    return { ok: true, dir: `forensics/${ name }`, manifest };
  } catch ( err ) {
    log( 'error', `[store-discipline] FORENSIC CAPTURE FAILED for ${ tool } on ${ family }: ${ err.message }. The write was still refused.` );
    return { ok: false, dir: null, error: err.message };
  }
}

/**
 * Guard one interactive write against an active claim.
 *
 * Allowed when no claim is active, or when the caller presents the claim id of
 * the active claim (the holder may write its own store). Otherwise refused,
 * with the holder named and the content captured.
 *
 * @param {object} o
 * @param {string} o.family
 * @param {string} o.target        Path relative to the family's directory.
 * @param {string|Buffer} o.content
 * @param {string} o.tool
 * @param {string} [o.actor]
 * @param {string|null} [o.claimId]
 * @returns {{ allowed: true, claim: object|null } | { allowed: false, refusal: object }}
 */
export function guardStoreWrite( { family, target, content, tool, actor = 'tool-call', claimId = null } ) {
  const fam = checkFamily( family );
  if ( ! fam.ok ) return { allowed: false, refusal: { refused: true, code: fam.code, message: fam.message } };
  const claim = activeClaim( family );
  if ( ! claim ) return { allowed: true, claim: null };
  if ( claimId && claim.claim_id === claimId ) return { allowed: true, claim };

  const holderId = claim.holder ? claim.holder.id : 'unknown';
  const message = `Refused: the ${ family } store has a declared writer, ${ holderId }`
    + ( claim.purpose ? ` ("${ claim.purpose }")` : '' )
    + ( claim.expires_at ? `, until ${ claim.expires_at }` : '' )
    + '. The write was not applied.';
  const capture = captureForensics( {
    family,
    attempted: [ { rel: target, content } ],
    storeDir: storeDirs()[ family ],
    tool,
    actor,
    refusal: { code: 'store_claimed', message, holder: claim.holder || null, claim_id: claim.claim_id },
  } );
  return {
    allowed: false,
    refusal: {
      refused: true,
      code: 'store_claimed',
      message: capture.ok ? `${ message } It was captured to ${ capture.dir }.` : `${ message } Capture to forensics FAILED (${ capture.error }); keep your copy.`,
      family,
      holder: claim.holder || null,
      claim_id: claim.claim_id,
      expires_at: claim.expires_at || null,
      forensics: capture.ok ? capture.dir : null,
      forensics_error: capture.ok ? undefined : capture.error,
    },
  };
}

/**
 * Begin a bulk rewrite (restore, import) over one or more families.
 *
 * Declares a claim on every family it touches. If any family is already
 * claimed by someone else, nothing is declared, the whole payload is captured
 * to forensics against that family, and the refusal names the holder.
 *
 * @param {object} o
 * @param {string[]} o.families
 * @param {string} o.label        Holder label, e.g. "wordpress-restore".
 * @param {string} o.purpose
 * @param {'restore'|'import'|'operator'|'process'} [o.kind]
 * @param {Array<{ family: string, rel: string, content: string|Buffer }>} [o.payload]
 * @param {string} o.tool
 * @param {string} [o.actor]
 * @returns {{ ok: true, claims: object[], release: () => void } | { ok: false, refusal: object }}
 */
export function beginBulkRewrite( { families, label, purpose, kind = 'restore', payload = [], tool, actor = 'bulk-rewrite' } ) {
  const declared = [];
  const releaseAll = () => {
    for ( const c of declared ) {
      try { releaseClaim( c.family, c.claim_id ); } catch ( err ) {
        log( 'error', `[store-discipline] could not release ${ c.family } claim ${ c.claim_id }: ${ err.message }` );
      }
    }
  };
  for ( const family of [ ...new Set( families ) ] ) {
    const r = declareClaim( family, { kind, label, purpose } );
    if ( r.ok ) { declared.push( r.claim ); continue; }

    releaseAll();
    const forFamily = payload.filter( ( p ) => p.family === family );
    const others = payload.filter( ( p ) => p.family !== family );
    const capture = captureForensics( {
      family,
      attempted: [ ...forFamily, ...others.map( ( p ) => ( { rel: `_other_families/${ p.family }/${ p.rel }`, content: p.content } ) ) ],
      storeDir: storeDirs()[ family ] || null,
      tool,
      actor,
      refusal: { code: r.code, message: r.message, holder: r.holder || null, claim_id: r.claim_id || null },
    } );
    return {
      ok: false,
      refusal: {
        refused: true,
        code: r.code === 'claim_held' ? 'store_claimed' : r.code,
        message: `${ r.message } The ${ tool } was not applied${ capture.ok ? `; its payload was captured to ${ capture.dir }` : `; capture FAILED (${ capture.error }), keep the source copy` }.`,
        family,
        holder: r.holder || null,
        claim_id: r.claim_id || null,
        forensics: capture.ok ? capture.dir : null,
      },
    };
  }
  return { ok: true, claims: declared, release: releaseAll };
}

/**
 * Forensic captures on disk, newest first, read from their manifests.
 *
 * @param {number} [limit]
 * @returns {object[]}
 */
export function listForensics( limit = 20 ) {
  const dir = forensicsDir();
  if ( ! existsSync( dir ) ) return [];
  const names = readdirSync( dir ).filter( ( n ) => existsSync( join( dir, n, 'manifest.json' ) ) ).sort().reverse();
  const out = [];
  for ( const n of names.slice( 0, Math.max( 1, Math.min( 200, limit ) ) ) ) {
    try {
      const m = JSON.parse( readFileSync( join( dir, n, 'manifest.json' ), 'utf8' ) );
      out.push( { dir: `forensics/${ n }`, captured_at: m.captured_at, family: m.family, tool: m.tool, holder: m.refusal && m.refusal.holder ? m.refusal.holder.id : null, files: ( m.files || [] ).length } );
    } catch ( err ) {
      out.push( { dir: `forensics/${ n }`, error: `manifest unreadable: ${ err.message }` } );
    }
  }
  return out;
}

/** Test support: resolve a path inside the discipline root. */
export function _disciplinePath( ...parts ) {
  return resolvePath( disciplineRoot(), ...parts );
}

export default {
  STORE_FAMILIES, CONNECTOR_STORE_FAMILIES, HOLDER_KINDS, DEFAULT_CLAIM_TTL_MS, MAX_CLAIM_TTL_MS,
  storeDirs, disciplineRoot, checkFamily, activeClaim, listClaims, declareClaim, releaseClaim,
  captureForensics, guardStoreWrite, beginBulkRewrite, listForensics,
};
