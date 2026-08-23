// src/tests/skill-budget-guard.test.js
//
// Fix 2 — Compile Budget Code Guard.
//
// ── What the guard is defending ───────────────────────────────────────────
//
// The module-selection budget reads `line_count_estimate || line_count || 20`.
// That default is fine for one unmeasured module and catastrophic when every
// module falls through: the budget believes a 4,000-line skill is 20 lines per
// entry and admits far more than it can carry.
//
// The failure is silent. Nothing in the compile looks wrong -- the skill is
// simply too big, and the cause is a manifest field nobody noticed had gone.
//
// So the assertions here are about the DIFFERENCE the guard makes to the number
// the budget would use, not merely that a field got populated. A guard that
// writes `line_count` somewhere the budget does not read is no guard at all.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hydrateLineCounts } from '../tools/skill-modular.js';

/**
 * A temporary ava volume with module files on disk.
 *
 * @param {object} files Relative path to contents.
 * @returns {{ paths: object, dir: string }}
 */
function volume( files ) {
  const dir = mkdtempSync( join( tmpdir(), 'ava-vol-' ) );

  for ( const [ rel, content ] of Object.entries( files ) ) {
    const full = join( dir, rel );
    mkdirSync( join( full, '..' ), { recursive: true } );
    writeFileSync( full, content );
  }

  // getModularPaths builds paths by string concatenation, so avaDir carries a
  // trailing separator. Matched here rather than assumed.
  return { dir, paths: { avaDir: `${ dir }/` } };
}

/** The budget's own arithmetic, so the tests measure what it will measure. */
function budgetFor( module ) {
  return module?.line_count_estimate || module?.line_count || 20;
}

const BIG = Array.from( { length: 400 }, ( _, i ) => `line ${ i }` ).join( '\n' );

// ===========================================================================
// The acceptance criteria
// ===========================================================================

test( 'a manifest with no line-count data is sized from the real files', () => {
  // AC 1. This is the regression: every module falls through to 20, and the
  // budget admits a skill several times larger than it thinks.
  const { paths } = volume( {
    'modules/a.md': BIG,
    'modules/b.md': 'one\ntwo\nthree',
  } );

  const manifest = { modules: [
    { id: 'a', path: 'modules/a.md' },
    { id: 'b', path: 'modules/b.md' },
  ] };

  // Before: both would be budgeted at the default.
  assert.equal( budgetFor( manifest.modules[ 0 ] ), 20 );

  const result = hydrateLineCounts( manifest, paths );

  assert.equal( result.measured, 2 );
  assert.equal( budgetFor( manifest.modules[ 0 ] ), 400,
    'the 400-line module is budgeted at 400, not 20' );
  assert.equal( budgetFor( manifest.modules[ 1 ] ), 3 );
} );

test( 'a manifest that already carries counts is untouched', () => {
  // AC 2. The healthy case must cost nothing: the loop short-circuits before it
  // reaches the disk.
  const { paths } = volume( { 'modules/a.md': BIG } );

  const manifest = { modules: [
    { id: 'a', path: 'modules/a.md', line_count_estimate: 120 },
    { id: 'b', path: 'modules/b.md', line_count: 45 },
  ] };

  const result = hydrateLineCounts( manifest, paths );

  assert.equal( result.measured, 0, 'nothing was read' );
  assert.equal( manifest.modules[ 0 ].line_count_estimate, 120,
    'a declared estimate is not overwritten by a measurement' );
  assert.equal( manifest.modules[ 1 ].line_count, 45 );

  // And b.md does not exist on disk, yet nothing was reported missing --
  // because the guard never looked, which is the point.
  assert.deepEqual( result.unmeasured, [] );
} );

test( 'a module whose file is missing compiles and is reported', () => {
  // AC 3. The default still applies, so the module stays selectable at a
  // conservative estimate rather than vanishing from the skill.
  const { paths } = volume( {} );

  const manifest = { modules: [ { id: 'gone', path: 'modules/gone.md' } ] };
  const result = hydrateLineCounts( manifest, paths );

  assert.equal( result.measured, 0 );
  assert.equal( result.unmeasured.length, 1 );
  assert.match( result.unmeasured[ 0 ], /gone/ );
  assert.match( result.unmeasured[ 0 ], /file missing/ );

  assert.equal( manifest.modules[ 0 ].line_count, undefined,
    'the module is left untouched, not zeroed' );
  assert.equal( budgetFor( manifest.modules[ 0 ] ), 20,
    'so the existing default applies and it remains selectable' );
} );

test( 'a module measured as zero is NOT written as zero', () => {
  // The subtle one. Writing 0 would make the module free, and a free module is
  // always selectable -- the budget would admit it ahead of modules that
  // honestly declared their size.
  //
  // countLines returns 0 only for empty content, so an empty file falls through
  // to the default rather than becoming a zero-cost entry.
  const { paths } = volume( { 'modules/empty.md': '' } );

  const manifest = { modules: [ { id: 'empty', path: 'modules/empty.md' } ] };
  hydrateLineCounts( manifest, paths );

  assert.notEqual( manifest.modules[ 0 ].line_count, 0,
    'an empty module never becomes a free module' );
  assert.equal( budgetFor( manifest.modules[ 0 ] ), 20 );
} );

// ===========================================================================
// The mutation the acceptance criteria call for
// ===========================================================================

test( 'AC 4: dropping the fields from one entry sizes it from its file', () => {
  // The criterion states this as a mutation test, so it is written as one: the
  // same manifest, one entry stripped, and the budget for that entry must come
  // from the file rather than the default.
  const { paths } = volume( {
    'modules/measured.md': BIG,
    'modules/stripped.md': BIG,
  } );

  const manifest = { modules: [
    { id: 'measured', path: 'modules/measured.md', line_count_estimate: 400 },
    { id: 'stripped', path: 'modules/stripped.md' },   // both fields removed
  ] };

  hydrateLineCounts( manifest, paths );

  assert.equal( budgetFor( manifest.modules[ 1 ] ), 400,
    'the stripped entry is sized from its file, not from 20' );
  assert.equal( budgetFor( manifest.modules[ 0 ] ),
                budgetFor( manifest.modules[ 1 ] ),
    'and agrees with the entry that declared the same size' );
} );

// ===========================================================================
// The guard must never be the reason a compile fails
// ===========================================================================

test( 'malformed manifest entries are skipped, not thrown on', () => {
  // A compile that dies here costs the session its entire skill, which is a far
  // worse outcome than a mis-sized budget.
  const { paths } = volume( { 'modules/ok.md': 'a\nb' } );

  const manifest = { modules: [
    null,
    undefined,
    {},                                   // no path
    { id: 'no-path' },
    { id: 'ok', path: 'modules/ok.md' },
  ] };

  assert.doesNotThrow( () => hydrateLineCounts( manifest, paths ) );
  assert.equal( manifest.modules[ 4 ].line_count, 2, 'the valid entry is still measured' );
} );

test( 'a manifest with no modules array is handled', () => {
  const { paths } = volume( {} );
  for ( const manifest of [ {}, { modules: null }, null, undefined ] ) {
    assert.doesNotThrow( () => hydrateLineCounts( manifest, paths ) );
  }
} );

test( 'an unreadable file is reported, not thrown on', { skip: 0 === process.getuid?.()
  ? 'running as root, permissions are not enforced' : false }, () => {
  const { paths, dir } = volume( { 'modules/locked.md': BIG } );
  chmodSync( join( dir, 'modules/locked.md' ), 0o000 );

  try {
    const manifest = { modules: [ { id: 'locked', path: 'modules/locked.md' } ] };
    const result = hydrateLineCounts( manifest, paths );

    assert.equal( result.unmeasured.length, 1 );
    assert.match( result.unmeasured[ 0 ], /unreadable/ );
    assert.equal( budgetFor( manifest.modules[ 0 ] ), 20, 'the default still applies' );
  } finally {
    chmodSync( join( dir, 'modules/locked.md' ), 0o644 );
    rmSync( dir, { recursive: true, force: true } );
  }
} );

// ===========================================================================
// The guard is actually called
// ===========================================================================

test( 'compileSkill runs the guard immediately after loading the manifest', async () => {
  // A guard nothing calls is not a guard. Asserted against the source because
  // compileSkill is internal and needs a full volume to invoke.
  const { readFileSync } = await import( 'node:fs' );
  const { dirname, join: j } = await import( 'node:path' );
  const { fileURLToPath } = await import( 'node:url' );

  const here = dirname( fileURLToPath( import.meta.url ) );
  const src = readFileSync( j( here, '..', 'tools', 'skill-modular.js' ), 'utf8' );

  const at = src.indexOf( 'const merged = loadMergedManifest(paths, readJsonFile);' );
  assert.notEqual( at, -1 );

  const after = src.slice( at, at + 400 );
  assert.match( after, /hydrateLineCounts\(manifest, paths\)/,
    'the guard runs before any budget arithmetic' );
} );
