// src/utils/derivedIndexes.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-2, TENAX-2026-10-15-01: canonical data stays separable from derived
// indexes, so an index can be detached and rebuilt without touching a single
// canonical record.
//
// CANONICAL on this volume: every file in the four store families (modules/,
// references/, archive/, scripts/) and the compile inputs beside them (CORE.md,
// MANIFEST.json, MANIFEST_APPEND.json, DISPATCH_RULES.json, PERSONALITY.md,
// PROFILES.md), apart from the paths declared derived below.
//
// DERIVED: artefacts computed from canonical data or from the running build,
// which can be thrown away and regenerated:
//
//   brain_tools_catalog   scripts/brain_tools_catalog.json, written from this
//                         connector's live tool registry (writeToolCatalog)
//   merged_manifest       the merged module manifest (MANIFEST.json +
//                         MANIFEST_APPEND.json + references/manifest/*.json),
//                         rebuilt in memory on every compile and NEVER written
//                         back over any of its inputs
//
// detachAndRebuild() moves a persisted derived artefact aside (kept, under
// .store-discipline/detached/), regenerates it, and proves the canonical set
// is byte-identical before and after by digest. A rebuild that changed any
// canonical file is reported as a failure, not as a success with a note.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { storeDirs, disciplineRoot } from './storeWriteDiscipline.js';

/** Compile inputs that sit beside the stores and are canonical. */
const CANONICAL_ROOT_FILES = Object.freeze( [
  'CORE.md', 'MANIFEST.json', 'MANIFEST_APPEND.json', 'DISPATCH_RULES.json', 'PERSONALITY.md', 'PROFILES.md',
] );

/**
 * The derived artefacts. `rel` is relative to the ava directory; `persisted`
 * false means the artefact only ever exists in memory.
 */
export const DERIVED_INDEXES = Object.freeze( [
  { id: 'brain_tools_catalog', rel: 'scripts/brain_tools_catalog.json', persisted: true },
  { id: 'merged_manifest',     rel: null,                               persisted: false },
] );

const DERIVED_RELS = new Set( DERIVED_INDEXES.filter( ( d ) => d.rel ).map( ( d ) => d.rel ) );

/**
 * Every canonical file under the ava directory, relative, sorted.
 *
 * @returns {string[]}
 */
export function canonicalFiles() {
  const ava = storeDirs().avaDir;
  const out = [];
  for ( const f of CANONICAL_ROOT_FILES ) if ( existsSync( join( ava, f ) ) ) out.push( f );
  const walk = ( abs ) => {
    if ( ! existsSync( abs ) ) return;
    for ( const name of readdirSync( abs ) ) {
      const p = join( abs, name );
      const st = lstatSync( p );
      if ( st.isSymbolicLink() ) continue;
      if ( st.isDirectory() ) walk( p );
      else {
        const rel = relative( ava, p ).split( '\\' ).join( '/' );
        if ( ! DERIVED_RELS.has( rel ) && ! rel.endsWith( '.tmp' ) ) out.push( rel );
      }
    }
  };
  // Only the four store families and the root compile inputs are walked, so
  // the discipline state beside them (.store-discipline/, .ledger/,
  // .process-guard/, telemetry/) is never part of the canonical set.
  for ( const fam of [ 'modules', 'references', 'archive', 'scripts' ] ) walk( join( ava, fam ) );
  return out.sort();
}

/**
 * One digest over every canonical file's path and bytes.
 *
 * @returns {{ digest: string, files: number }}
 */
export function canonicalDigest() {
  const ava = storeDirs().avaDir;
  const h = createHash( 'sha256' );
  const files = canonicalFiles();
  for ( const rel of files ) {
    h.update( rel, 'utf8' );
    h.update( '\0' );
    h.update( readFileSync( join( ava, rel ) ) );
    h.update( '\0' );
  }
  return { digest: h.digest( 'hex' ), files: files.length };
}

/**
 * Detach a derived artefact and rebuild it, proving the canonical set is
 * untouched.
 *
 * @param {object} o
 * @param {string} o.id                 A DERIVED_INDEXES id.
 * @param {() => (boolean|object)} o.rebuild  Regenerates the artefact.
 * @returns {{ ok: boolean, id: string, detached_to: string|null, canonical_before: object, canonical_after: object, rebuilt: boolean, error?: string }}
 */
export function detachAndRebuild( { id, rebuild } ) {
  const entry = DERIVED_INDEXES.find( ( d ) => d.id === id );
  if ( ! entry ) return { ok: false, id, error: `"${ id }" is not a declared derived index (${ DERIVED_INDEXES.map( ( d ) => d.id ).join( ', ' ) })` };
  if ( typeof rebuild !== 'function' ) return { ok: false, id, error: 'no rebuild function supplied' };

  const before = canonicalDigest();
  let detachedTo = null;
  if ( entry.persisted && entry.rel ) {
    const src = join( storeDirs().avaDir, entry.rel );
    if ( existsSync( src ) && statSync( src ).isFile() ) {
      const stamp = new Date().toISOString().replace( /[-:]/g, '' ).replace( /\.\d{3}Z$/, 'Z' );
      const dir = join( disciplineRoot(), 'detached', `${ stamp }-${ id }` );
      mkdirSync( dir, { recursive: true } );
      detachedTo = join( dir, entry.rel.split( '/' ).pop() );
      renameSync( src, detachedTo );
    }
  }
  let rebuilt = false;
  let error;
  try {
    const r = rebuild();
    rebuilt = r !== false;
  } catch ( err ) {
    error = err.message;
  }
  const after = canonicalDigest();
  const untouched = before.digest === after.digest;
  return {
    ok: untouched && rebuilt && ! error,
    id,
    detached_to: detachedTo ? relative( storeDirs().avaDir, detachedTo ).split( '\\' ).join( '/' ) : null,
    canonical_before: before,
    canonical_after: after,
    canonical_untouched: untouched,
    rebuilt,
    error: error || ( untouched ? undefined : 'the rebuild changed canonical data; it is not a derived-index rebuild' ),
  };
}

export default { DERIVED_INDEXES, canonicalFiles, canonicalDigest, detachAndRebuild };
