// src/tests/skill-file-cache.test.js
//
// The mtime-validated read-through cache for modular skill files. v13.20.0.
//
// ===========================================================================
// WHAT THIS IS FIXING, AND WHY THE OBVIOUS FIX WAS REJECTED
// ===========================================================================
//
// /ti-skill-compile was overrunning the gateway's compile timeout, so the
// gateway fell back to the static skill and the session ran with no specialist
// modules at all.
//
// The proposed fix was a tenant-keyed cache of the COMPILED SKILL. That is
// unsafe, and the reason is in compileSkill(): modules are selected from the
// query (detectTriggerConditions, layer1Score) and the person prior. Two
// sessions that open with different questions get different module sets,
// correctly. A tenant-keyed output cache would serve one session's modules to
// another, and a silently absent specialist module is far harder to notice than
// a slow compile.
//
// So the INPUT is cached instead: the filesystem reads that feed selection,
// keyed by path and validated by mtime. Selection itself is recomputed exactly,
// every call.
//
// The assertions below are therefore about two things: that the cache actually
// removes reads, and that it can never serve anything the filesystem does not
// currently say.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync, rmSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cachedReadFile, cachedReadJson, cachedLineCount,
  invalidateSkillFile, skillFileCacheStats,
} from '../tools/skill-file-cache.js';

/** Count lines the way skill-modular does. */
const countLines = ( t ) => String( t || '' ).split( '\n' ).filter( Boolean ).length;

/** A scratch directory, cleaned up by the caller. */
function scratch() {
  return mkdtempSync( join( tmpdir(), 'skill-fc-' ) );
}

/**
 * Write a file and push its mtime forward.
 *
 * ── Why the mtime is forced ──────────────────────────────────────────────
 *
 * Some filesystems report mtime at one-second granularity. A test that writes
 * twice inside the same second would see an unchanged mtime and conclude the
 * cache had failed to invalidate, when in fact the filesystem never told it
 * anything had changed. Forcing the timestamp tests the cache rather than the
 * clock. (The size check catches most of these anyway, which is why both are
 * compared -- but not all: a same-length edit changes neither.)
 */
function writeNewer( path, content, secondsAhead ) {
  writeFileSync( path, content );
  const when = new Date( Date.now() + ( secondsAhead || 2 ) * 1000 );
  utimesSync( path, when, when );
}

/** Reads performed since a marker. */
function readsSince( before ) {
  return skillFileCacheStats().reads - before;
}

// ===========================================================================
// It removes reads
// ===========================================================================

test( 'repeated reads of an unchanged file hit the disk once', () => {
  const dir = scratch();
  try {
    const f = join( dir, 'core.md' );
    writeFileSync( f, 'alpha\nbeta\n' );
    invalidateSkillFile();

    const before = skillFileCacheStats().reads;
    for ( let i = 0; i < 5; i += 1 ) cachedReadFile( f );

    assert.equal( readsSince( before ), 1 );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'a line count reuses the cached text rather than re-reading', () => {
  // The dominant cost this exists to remove: hydrateLineCounts reads EVERY
  // module on every compile, before any module has been selected, purely to
  // feed the budget calculation.
  const dir = scratch();
  try {
    const f = join( dir, 'mod.md' );
    writeFileSync( f, 'one\ntwo\nthree\n' );
    invalidateSkillFile();

    const before = skillFileCacheStats().reads;
    assert.equal( cachedLineCount( f, countLines ), 3 );
    assert.equal( cachedLineCount( f, countLines ), 3 );
    cachedReadFile( f );

    assert.equal( readsSince( before ), 1,
      'the count and the body must share one read' );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'parsed JSON is cached, not just its text', () => {
  // MANIFEST.json is the largest JSON in the compile path and parsing it is
  // not free either.
  const dir = scratch();
  try {
    const f = join( dir, 'MANIFEST.json' );
    writeFileSync( f, JSON.stringify( { modules: [ { id: 'a' }, { id: 'b' } ] } ) );
    invalidateSkillFile();

    const before = skillFileCacheStats().reads;
    for ( let i = 0; i < 4; i += 1 ) {
      assert.equal( cachedReadJson( f, {} ).modules.length, 2 );
    }
    assert.equal( readsSince( before ), 1 );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

// ===========================================================================
// It can never serve what the filesystem no longer says
// ===========================================================================

test( 'a changed file invalidates on mtime', () => {
  const dir = scratch();
  try {
    const f = join( dir, 'mod.md' );
    writeFileSync( f, 'one\ntwo\nthree\n' );
    invalidateSkillFile();

    assert.equal( cachedLineCount( f, countLines ), 3 );
    writeNewer( f, 'only\n' );

    assert.equal( cachedLineCount( f, countLines ), 1,
      'a rewritten module must be re-read' );
    assert.equal( cachedReadFile( f ), 'only\n' );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'a same-length edit is still caught', () => {
  // Size alone would miss this, which is why mtime is compared too.
  const dir = scratch();
  try {
    const f = join( dir, 'mod.md' );
    writeFileSync( f, 'aaa\n' );
    invalidateSkillFile();
    assert.equal( cachedReadFile( f ), 'aaa\n' );

    writeNewer( f, 'bbb\n' );
    assert.equal( cachedReadFile( f ), 'bbb\n' );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'a deleted file is dropped, not resurrected', () => {
  // Serving the contents of a deleted module would put it back into every
  // later compile, and nothing on disk would explain where it came from.
  const dir = scratch();
  try {
    const f = join( dir, 'gone.json' );
    writeFileSync( f, JSON.stringify( { modules: [ { id: 'x' } ] } ) );
    invalidateSkillFile();
    assert.equal( cachedReadJson( f, { modules: [] } ).modules.length, 1 );

    rmSync( f );
    assert.deepEqual( cachedReadJson( f, { modules: [] } ), { modules: [] } );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'an explicit invalidation is honoured immediately', () => {
  // module_write calls this. mtime would catch the change on most
  // filesystems; invalidating explicitly removes the dependence on stat
  // granularity, which matters most for an author who writes a module and
  // immediately asks about it.
  const dir = scratch();
  try {
    const f = join( dir, 'mod.md' );
    writeFileSync( f, 'first\n' );
    invalidateSkillFile();
    assert.equal( cachedReadFile( f ), 'first\n' );

    // Same second, same length: neither mtime nor size need differ.
    writeFileSync( f, 'secnd\n' );
    invalidateSkillFile( f );

    assert.equal( cachedReadFile( f ), 'secnd\n' );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

// ===========================================================================
// The mutation hazard
// ===========================================================================

test( 'a caller cannot mutate the cached JSON', () => {
  // THE trap in caching this particular object. compileSkill mutates what
  // readJsonFile returns: hydrateLineCounts writes `m.line_count` onto manifest
  // entries, and fragment dispatch rules are merged into
  // learned_linkages.rules in memory.
  //
  // Handing out the cached object itself would mean line counts looked measured
  // when they were not, and fragment rules accumulated on every compile until
  // they had been applied many times over -- both silent, and both changing
  // which modules get selected.
  const dir = scratch();
  try {
    const f = join( dir, 'MANIFEST.json' );
    writeFileSync( f, JSON.stringify( {
      modules: [ { id: 'a', path: '/a.md' } ],
      learned_linkages: { rules: [] },
    } ) );
    invalidateSkillFile();

    const first = cachedReadJson( f, {} );
    first.modules[ 0 ].line_count = 999;
    first.learned_linkages.rules.push( { id: 'injected' } );

    const second = cachedReadJson( f, {} );
    assert.equal( 'line_count' in second.modules[ 0 ], false,
      'a hydrated line count leaked into the next compile' );
    assert.equal( second.learned_linkages.rules.length, 0,
      'a fragment rule leaked into the next compile' );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'nested structures are copied, not shared', () => {
  const dir = scratch();
  try {
    const f = join( dir, 'd.json' );
    writeFileSync( f, JSON.stringify( { a: { b: { c: [ 1, 2 ] } } } ) );
    invalidateSkillFile();

    const one = cachedReadJson( f, {} );
    one.a.b.c.push( 3 );
    assert.deepEqual( cachedReadJson( f, {} ).a.b.c, [ 1, 2 ] );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

// ===========================================================================
// Failure behaviour is unchanged from the uncached path
// ===========================================================================

test( 'a missing file throws exactly as readFileSync does', () => {
  // hydrateLineCounts catches this and records the module as unmeasured rather
  // than failing the compile. That must keep working: one unreadable module
  // must not cost the session its whole skill.
  const dir = scratch();
  try {
    assert.throws( () => cachedReadFile( join( dir, 'nope.md' ) ),
      ( err ) => 'ENOENT' === err.code );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'a missing JSON file yields the fallback', () => {
  const dir = scratch();
  try {
    assert.deepEqual( cachedReadJson( join( dir, 'nope.json' ), { d: 1 } ), { d: 1 } );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'malformed JSON yields the fallback and is not re-parsed every call', () => {
  // A broken manifest would otherwise be re-read and re-parsed on every
  // compile, for as long as it stayed broken -- which is precisely when the
  // volume is least worth hammering.
  const dir = scratch();
  try {
    const f = join( dir, 'bad.json' );
    writeFileSync( f, '{ not json' );
    invalidateSkillFile();

    const before = skillFileCacheStats().reads;
    assert.deepEqual( cachedReadJson( f, { ok: false } ), { ok: false } );
    assert.deepEqual( cachedReadJson( f, { ok: false } ), { ok: false } );
    assert.equal( readsSince( before ), 1 );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

test( 'a repaired file is picked up after being cached as malformed', () => {
  const dir = scratch();
  try {
    const f = join( dir, 'fix.json' );
    writeFileSync( f, '{ broken' );
    invalidateSkillFile();
    assert.deepEqual( cachedReadJson( f, { ok: false } ), { ok: false } );

    writeNewer( f, JSON.stringify( { ok: true } ) );
    assert.deepEqual( cachedReadJson( f, { ok: false } ), { ok: true } );
  } finally { rmSync( dir, { recursive: true, force: true } ); }
} );

// ===========================================================================
// The escape hatch
// ===========================================================================

test( 'the cache can be switched off without a rollback', () => {
  const dir = scratch();
  const saved = process.env.SKILL_FILE_CACHE_ENABLED;
  try {
    const f = join( dir, 'mod.md' );
    writeFileSync( f, 'first\n' );
    invalidateSkillFile();
    assert.equal( cachedReadFile( f ), 'first\n' );

    process.env.SKILL_FILE_CACHE_ENABLED = 'false';
    // Same second, same length -- a cached read would return the old content.
    writeFileSync( f, 'secnd\n' );
    assert.equal( cachedReadFile( f ), 'secnd\n' );
    assert.deepEqual( cachedReadJson( join( dir, 'x.json' ), { d: 2 } ), { d: 2 } );
  } finally {
    if ( undefined === saved ) delete process.env.SKILL_FILE_CACHE_ENABLED;
    else process.env.SKILL_FILE_CACHE_ENABLED = saved;
    rmSync( dir, { recursive: true, force: true } );
  }
} );

test( 'the stats report counters and never file contents', () => {
  const s = skillFileCacheStats();
  for ( const field of [ 'hits', 'misses', 'invalidations', 'reads', 'bytes', 'entries' ] ) {
    assert.equal( typeof s[ field ], 'number', field );
  }
  assert.doesNotMatch( JSON.stringify( s ), /[a-z]{20,}/i,
    'the stats must not carry content' );
} );
