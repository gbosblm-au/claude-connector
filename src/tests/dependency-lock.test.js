// src/tests/dependency-lock.test.js
//
// The lockfile is a build input, and this asserts it is a valid one. v13.20.1.
//
// ===========================================================================
// WHY THIS TEST EXISTS
// ===========================================================================
//
// v13.20.0 failed to deploy. Two mistakes, stacked, and neither was caught by
// any test because both were about a file rather than about code:
//
//   `ws` was added to package.json dependencies and package-lock.json was never
//   updated, so the two were out of step.
//
//   package-lock.json was then omitted from the release archive entirely.
//
// The Dockerfile's deps stage runs `npm ci`, which fails loudly on either --
// which is precisely why it is used, and the reasoning is written into the
// Dockerfile at TNX-H-010: `npm install` would silently mutate the tree to
// satisfy caret ranges, so two builds of one commit could resolve different
// dependency trees and "roll back and confirm" would stop being dependable.
//
// The failure surfaced as a red Railway build. It should have surfaced here,
// in seconds, before anything was packaged. That is the whole point of this
// file: it is the cheapest possible check for the one file the build cannot
// proceed without.
//
// This does not duplicate `npm ci`. It cannot -- it does no network work and
// resolves nothing. It catches the specific, repeated mistake of editing
// package.json without the lock, which is the form the failure actually took.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const PKG_PATH = join( ROOT, 'package.json' );
const LOCK_PATH = join( ROOT, 'package-lock.json' );

/** @returns {object} */
function readJson( path ) {
  return JSON.parse( readFileSync( path, 'utf8' ) );
}

/**
 * Does a concrete version satisfy a declared range?
 *
 * ── Why this is deliberately narrow ─────────────────────────────────────
 *
 * Only the range forms this project actually uses are understood: exact,
 * caret, tilde, `*`, and `>=`. A range shape it does not recognise is REPORTED
 * as unrecognised rather than quietly passed, so adding an unusual range makes
 * this test speak up instead of going silently blind.
 *
 * Implementing full semver here would mean a semver implementation with no
 * tests of its own guarding the build, which is worse than a narrow one that
 * admits its limits.
 *
 * @param {string} version A concrete version from the lockfile.
 * @param {string} range The declared range from package.json.
 * @returns {{ok: boolean, reason?: string}}
 */
function satisfies( version, range ) {
  const v = String( version || '' ).trim();
  const r = String( range || '' ).trim();

  if ( '*' === r || '' === r || 'latest' === r ) return { ok: true };

  // Anything not a plain registry range: a git URL, a file path, an alias.
  // Not judged, because the lockfile entry for these does not carry a
  // comparable version.
  if ( /^(git|github:|file:|link:|npm:|https?:)/.test( r ) ) return { ok: true };

  const parse = ( s ) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec( s );
    return m ? [ Number( m[ 1 ] ), Number( m[ 2 ] ), Number( m[ 3 ] ) ] : null;
  };

  const vp = parse( v );
  if ( ! vp ) return { ok: false, reason: `lockfile version "${ v }" is not semver` };

  if ( /^\d/.test( r ) ) {
    const rp = parse( r );
    if ( ! rp ) return { ok: false, reason: `range "${ r }" is not semver` };
    return { ok: v === r || ( vp[ 0 ] === rp[ 0 ] && vp[ 1 ] === rp[ 1 ] && vp[ 2 ] === rp[ 2 ] ),
             reason: `exact range ${ r } but lockfile has ${ v }` };
  }

  if ( r.startsWith( '^' ) ) {
    const rp = parse( r.slice( 1 ) );
    if ( ! rp ) return { ok: false, reason: `range "${ r }" is not semver` };
    // Caret on a 0.x release pins the minor, which is the case most likely to
    // be got wrong by hand.
    if ( 0 === rp[ 0 ] ) {
      return { ok: 0 === vp[ 0 ] && vp[ 1 ] === rp[ 1 ] && vp[ 2 ] >= rp[ 2 ],
               reason: `${ r } does not admit ${ v }` };
    }
    const atLeast = vp[ 0 ] > rp[ 0 ] ? true
      : ( vp[ 1 ] > rp[ 1 ] || ( vp[ 1 ] === rp[ 1 ] && vp[ 2 ] >= rp[ 2 ] ) );
    return { ok: vp[ 0 ] === rp[ 0 ] && atLeast, reason: `${ r } does not admit ${ v }` };
  }

  if ( r.startsWith( '~' ) ) {
    const rp = parse( r.slice( 1 ) );
    if ( ! rp ) return { ok: false, reason: `range "${ r }" is not semver` };
    return { ok: vp[ 0 ] === rp[ 0 ] && vp[ 1 ] === rp[ 1 ] && vp[ 2 ] >= rp[ 2 ],
             reason: `${ r } does not admit ${ v }` };
  }

  if ( r.startsWith( '>=' ) ) {
    const rp = parse( r.slice( 2 ) );
    if ( ! rp ) return { ok: false, reason: `range "${ r }" is not semver` };
    for ( let i = 0; i < 3; i += 1 ) {
      if ( vp[ i ] > rp[ i ] ) return { ok: true };
      if ( vp[ i ] < rp[ i ] ) return { ok: false, reason: `${ r } does not admit ${ v }` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unrecognised range form "${ r }"; `
    + 'teach satisfies() about it rather than removing this assertion' };
}

// ===========================================================================

test( 'package-lock.json exists', () => {
  // v13.20.0 shipped without it. The Dockerfile's `COPY package.json
  // package-lock.json ./` fails on a missing file, so the build cannot even
  // reach `npm ci`.
  assert.ok( existsSync( LOCK_PATH ),
    'package-lock.json is a required build input; see TNX-H-010 in the Dockerfile' );
} );

test( 'every runtime dependency is present in the lockfile', () => {
  // THE v13.20.0 FAILURE. `ws` was added to dependencies and the lock was not
  // regenerated, so `npm ci` refused: "Missing: ws@8.21.3 from lock file".
  const pkg = readJson( PKG_PATH );
  const lock = readJson( LOCK_PATH );
  const packages = lock.packages || {};

  const missing = [];
  for ( const name of Object.keys( pkg.dependencies || {} ) ) {
    if ( ! packages[ `node_modules/${ name }` ] ) missing.push( name );
  }

  assert.deepEqual( missing, [],
    `these dependencies are not in the lockfile, so \`npm ci\` will refuse to `
    + `install: ${ missing.join( ', ' ) }. Run \`npm install --package-lock-only\`.` );
} );

test( 'every dev dependency is present in the lockfile', () => {
  // `npm ci` checks the whole tree, not just production, even when invoked
  // with --omit=dev. A dev dependency missing from the lock fails the build
  // exactly as a runtime one does.
  const pkg = readJson( PKG_PATH );
  const lock = readJson( LOCK_PATH );
  const packages = lock.packages || {};

  const missing = Object.keys( pkg.devDependencies || {} )
    .filter( ( name ) => ! packages[ `node_modules/${ name }` ] );

  assert.deepEqual( missing, [], `missing from the lockfile: ${ missing.join( ', ' ) }` );
} );

test( 'each locked version satisfies its declared range', () => {
  // The subtler half. A dependency can be present in the lock at a version the
  // range no longer admits -- after a hand-edited bump, for instance -- and
  // `npm ci` refuses that too.
  const pkg = readJson( PKG_PATH );
  const lock = readJson( LOCK_PATH );
  const packages = lock.packages || {};

  const problems = [];
  const declared = { ...( pkg.dependencies || {} ), ...( pkg.devDependencies || {} ) };

  for ( const [ name, range ] of Object.entries( declared ) ) {
    const entry = packages[ `node_modules/${ name }` ];
    if ( ! entry ) continue;   // reported by the tests above
    const verdict = satisfies( entry.version, range );
    if ( ! verdict.ok ) problems.push( `${ name }: ${ verdict.reason }` );
  }

  assert.deepEqual( problems, [], problems.join( '\n' ) );
} );

test( 'the lockfile declares the format npm ci expects', () => {
  const lock = readJson( LOCK_PATH );
  assert.ok( lock.lockfileVersion >= 2,
    `lockfileVersion ${ lock.lockfileVersion } predates the \`packages\` map that `
    + '`npm ci` reads; regenerate with a current npm' );
  assert.equal( typeof lock.packages, 'object' );
} );

test( 'ws is locked, because the streaming endpoint cannot start without it', () => {
  // Named specifically. It is the dependency whose omission broke the deploy,
  // and it is the only runtime dependency this project has added in a long
  // time -- so it is the one most likely to be forgotten again.
  const lock = readJson( LOCK_PATH );
  const ws = ( lock.packages || {} )[ 'node_modules/ws' ];

  assert.ok( ws, 'ws is missing from the lockfile' );
  assert.ok( ws.integrity, 'the ws entry has no integrity hash' );
  assert.equal( ws.license, 'MIT',
    'ws must stay MIT: it sits in the request path, on the transcription side of '
    + 'the documented licence boundary' );
} );
