/**
 * src/tests/module-files.test.js   (connector v13.38.0, WO-2026-11-20-03 rev 2)
 *
 * The resolver, the grouped skill_audit, skill_consistency_audit and the
 * guarded quarantine, each driven through the shipped handlers against a
 * throwaway modular volume built per test.
 *
 * Section 8 of the order, item by item:
 *   12  every deterministic check has its stated negative input (C-A, C-B,
 *       C-C, C-D, C-F); the advisory and judgment checks get their negative
 *       inputs too (C-E delta, C-G calibration, C-H, C-I, C-J)
 *   13  each of D4's six refusals is shown FAILING, with its code, and that no
 *       file moved (the whole tree is hashed before and after)
 *   14  hash mismatch: read, modify, delete with the stale hash
 *   15  divergence refusal names all three hashes; with the acknowledgement
 *       exactly one file moves and the retained copy is the acknowledged one
 *   16  compile survival (R6) after each quarantine
 *   17  restore round trip, byte-identical, both events logged
 *   18  empty-set floor: unverified, not clean
 *   19  C-A both directions, each side added independently
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const sha = ( s ) => createHash( 'sha256' ).update( s ).digest( 'hex' );

/**
 * A modular volume. `files` maps an avaDir-relative path to content;
 * `manifest` is MANIFEST.json's module list; `fragments` maps a fragment file
 * name to its module list.
 */
function volume( { files = {}, manifest = [], fragments = {}, append = null, core = '# core\n' } = {} ) {
  const root = mkdtempSync( join( tmpdir(), 'module-files-' ) );
  const ava = join( root, 'ava' );
  mkdirSync( join( ava, 'modules' ), { recursive: true } );
  mkdirSync( join( ava, 'references', 'manifest' ), { recursive: true } );
  writeFileSync( join( root, 'SKILL.md' ), '# S' );
  writeFileSync( join( root, '.modular_mode' ), 'true' );
  writeFileSync( join( ava, 'CORE.md' ), core );
  writeFileSync( join( ava, 'DISPATCH_RULES.json' ), '{}\n' );
  writeFileSync( join( ava, 'MANIFEST.json' ), JSON.stringify( { modules: manifest, budget: {} } ) );
  if ( append ) writeFileSync( join( ava, 'MANIFEST_APPEND.json' ), JSON.stringify( { modules: append } ) );
  for ( const [ name, modules ] of Object.entries( fragments ) ) {
    writeFileSync( join( ava, 'references', 'manifest', name ), JSON.stringify( { source: name.replace( /^\d+-|\.json$/g, '' ), modules }, null, 2 ) );
  }
  for ( const [ p, content ] of Object.entries( files ) ) {
    mkdirSync( dirname( join( ava, p ) ), { recursive: true } );
    writeFileSync( join( ava, p ), content );
  }
  return { root, ava, done: () => rmSync( root, { recursive: true, force: true } ) };
}

/** Run `fn` with SKILL_FILE_PATH pointing at the volume. */
async function on( vol, fn ) {
  const saved = process.env.SKILL_FILE_PATH;
  process.env.SKILL_FILE_PATH = join( vol.root, 'SKILL.md' );
  try { return await fn(); } finally {
    if ( saved === undefined ) delete process.env.SKILL_FILE_PATH; else process.env.SKILL_FILE_PATH = saved;
  }
}

/** Every file under avaDir, with its hash: "no file moved" is this, unchanged. */
function tree( vol ) {
  const out = {};
  ( function walk( d ) {
    for ( const n of readdirSync( d ) ) {
      const p = join( d, n );
      if ( lstatSync( p ).isDirectory() ) walk( p );
      else out[ relative( vol.ava, p ) ] = sha( readFileSync( p ) );
    }
  } )( vol.ava );
  return out;
}

const MF = await import( '../tools/module-files.js' );
const TOOLS = await import( '../tools/module-file-tools.js' );
const { handleSkillAudit } = await import( '../tools/skill.js' );
const { runConsistencyAudit, checkE } = await import( '../tools/module-consistency.js' );
const { handleSkillCompile } = await import( '../tools/skill-modular.js' );

const parse = ( r ) => JSON.parse( r.content[ 0 ].text );
const del = async ( args ) => parse( await TOOLS.handleModuleDelete( args ) );
const restore = async ( args ) => parse( await TOOLS.handleModuleRestore( args ) );
const events = ( args = {} ) => parse( TOOLS.handleModuleFileEvents( args ) );

// The section 2 shape: exist-angst-kierkegaard-heidegger at three paths with
// three different contents; the registered copy is the root one.
const ANGST = 'exist-angst-kierkegaard-heidegger';
function angstVolume() {
  return volume( {
    files: {
      'modules/exist-angst-kierkegaard-heidegger.md': '# Angst (root)\nnineteen lines of one reading\n',
      'modules/existential/exist-angst-kierkegaard-heidegger.md': '# Angst (existential)\nseventeen lines of another\n',
      'modules/philosophy/exist-angst-kierkegaard-heidegger.md': '# Angst (philosophy)\na third document\n',
      'modules/meta/meta-self-check.md': '# self check\n',
    },
    fragments: {
      '10-existential.json': [ { id: ANGST, path: 'modules/exist-angst-kierkegaard-heidegger.md' } ],
      '20-meta.json': [ { id: 'meta-self-check', path: 'modules/meta/meta-self-check.md', always_load: true } ],
    },
  } );
}

// ───────────────────────────── D3 / R4: the resolver ──────────────────────

test( 'D3: the resolver names the file the compile loads, and the evidence', async () => {
  const vol = volume( {
    files: { 'modules/a/x.md': '# first\nFIRST BODY\n', 'modules/b/x.md': '# second\nSECOND BODY\n' },
    // Two MANIFEST.json entries for one id: the compile's moduleMap takes the
    // LAST, skill_load_specialist the FIRST.
    manifest: [ { id: 'x', path: 'modules/a/x.md', always_load: true }, { id: 'x', path: 'modules/b/x.md', always_load: true } ],
  } );
  try {
    await on( vol, async () => {
      const r = MF.resolveModulePath( 'x' );
      assert.equal( r.resolved_path, 'modules/b/x.md' );
      assert.equal( r.resolved_by, 'manifest' );
      assert.equal( r.resolved_from, 'MANIFEST.json' );
      assert.equal( r.path_source, 'declared' );
      assert.equal( r.ambiguous, true );
      assert.deepEqual( r.loaders, { skill_compile: 'modules/b/x.md', skill_load_specialist: 'modules/a/x.md', disagree: true } );
      const compiled = parse( await handleSkillCompile( { query: '' } ) ).content;
      assert.ok( compiled.includes( 'SECOND BODY' ), 'the compile loads the resolved file' );
      assert.ok( ! compiled.includes( 'FIRST BODY' ), 'and not the other candidate' );
    } );
  } finally { vol.done(); }
} );

test( 'D3: an inferred fragment path is reported as the fallback it is', async () => {
  const vol = volume( { files: { 'modules/travel/travel-x.md': '# t\n' }, fragments: { '10-travel.json': [ { id: 'travel-x', category: 'travel' } ] } } );
  try {
    await on( vol, () => {
      const r = MF.resolveModulePath( 'travel-x' );
      assert.equal( r.resolved_path, 'modules/travel/travel-x.md' );
      assert.equal( r.resolved_by, 'manifest_fragment' );
      assert.equal( r.path_source, 'inferred_fallback' );
    } );
  } finally { vol.done(); }
} );

test( 'D3: a file no manifest registers resolves by directory walk only, and the compile cannot load it', async () => {
  const vol = volume( { files: { 'modules/loose/loose.md': '# loose\n' } } );
  try {
    await on( vol, () => {
      const r = MF.resolveModulePath( 'loose' );
      assert.equal( r.resolved_by, 'directory_walk' );
      assert.equal( r.resolved_path, null );
      assert.equal( r.registered, false );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R4 / R5 / D6 / D10: skill_audit ────────────

test( 'R4/R5: skill_audit groups by id, separates its counts, and keeps the flat list', async () => {
  const same = '# meta deflection\nidentical body\n';
  const vol = volume( {
    files: { 'modules/meta-deflection-watch.md': same, 'modules/meta/meta-deflection-watch.md': same, 'modules/modules/meta/meta-deflection-watch.md': same },
    fragments: { '10-meta.json': [ { id: 'meta-deflection-watch', path: 'modules/meta/meta-deflection-watch.md' } ] },
  } );
  try {
    await on( vol, async () => {
      const a = parse( await handleSkillAudit( {} ) );
      assert.equal( a.files.filter( ( f ) => f.label.startsWith( 'modules/' ) ).length, 3, 'the flat list still has every path' );
      const g = a.modules_by_id.find( ( m ) => m.id === 'meta-deflection-watch' );
      assert.equal( g.resolved_path, 'modules/meta/meta-deflection-watch.md' );
      assert.equal( g.resolved_by, 'manifest_fragment' );
      assert.equal( g.candidates.length, 3 );
      assert.equal( a.counts.path_entries, 6, 'CORE, MANIFEST, DISPATCH_RULES and three module paths' );
      assert.equal( a.counts.module_files, 3 );
      assert.equal( a.counts.distinct_files, 1, 'one content reached at three paths is one file' );
      assert.equal( a.counts.distinct_module_ids, 1 );
      assert.equal( a.summary.files_found, 6, 'files_found keeps its old meaning' );
      assert.equal( a.summary.counts.distinct_files, 1 );
      assert.equal( a.floor.status, 'verified' );
      assert.equal( a.registration.files_without_manifest_entry.length, 2, 'the two unregistered copies' );
    } );
  } finally { vol.done(); }
} );

test( 'D10: skill_audit over an empty modules tree reports unverified, not clean', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const a = parse( await handleSkillAudit( {} ) );
      assert.equal( a.floor.status, 'unverified' );
      assert.equal( a.floor.modules_read, 0 );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── 5.1 deterministic checks ───────────────────

test( 'D10/8.18: the consistency audit of an empty set is unverified and passes nothing', async () => {
  const vol = volume();
  try {
    await on( vol, () => {
      const c = runConsistencyAudit();
      assert.equal( c.status, 'unverified' );
      assert.equal( c.deterministic.status, 'unverified' );
      for ( const k of [ 'C-A', 'C-B', 'C-C', 'C-D', 'C-F' ] ) assert.equal( c.deterministic[ k ].pass, null, `${ k } must not pass an empty set` );
      assert.equal( c.floor.modules_read, 0 );
    } );
  } finally { vol.done(); }
} );

test( 'C-A (8.19, one side): a manifest entry for a path that does not exist is reported', async () => {
  const vol = volume( { files: { 'modules/a/a.md': '# a\n' },
    fragments: { '10-a.json': [ { id: 'a', path: 'modules/a/a.md' }, { id: 'ghost', path: 'modules/a/ghost.md' } ] } } );
  try {
    await on( vol, () => {
      const ca = runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic[ 'C-A' ];
      assert.equal( ca.pass, false );
      assert.deepEqual( ca.manifest_entries_without_file.map( ( e ) => e.path ), [ 'modules/a/ghost.md' ] );
      assert.deepEqual( ca.files_without_manifest_entry, [] );
    } );
  } finally { vol.done(); }
} );

test( 'C-A (8.19, the other side): a module file no entry names is reported', async () => {
  const vol = volume( { files: { 'modules/a/a.md': '# a\n', 'modules/a/stray.md': '# stray\n' },
    fragments: { '10-a.json': [ { id: 'a', path: 'modules/a/a.md' } ] } } );
  try {
    await on( vol, () => {
      const ca = runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic[ 'C-A' ];
      assert.equal( ca.pass, false );
      assert.deepEqual( ca.manifest_entries_without_file, [] );
      assert.deepEqual( ca.files_without_manifest_entry.map( ( f ) => f.path ), [ 'modules/a/stray.md' ] );
    } );
  } finally { vol.done(); }
} );

test( 'C-A: a consistent tree passes', async () => {
  const vol = volume( { files: { 'modules/a/a.md': '# a\n' }, fragments: { '10-a.json': [ { id: 'a', path: 'modules/a/a.md' } ] } } );
  try { await on( vol, () => assert.equal( runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic[ 'C-A' ].pass, true ) ); } finally { vol.done(); }
} );

test( 'C-B: two files, one id, different content of the SAME size, classify divergent (hash, not size)', async () => {
  const vol = volume( { files: { 'modules/a/dup.md': '# dup\nAAAA\n', 'modules/b/dup.md': '# dup\nBBBB\n', 'modules/c/same.md': '# s\n', 'modules/d/same.md': '# s\n' } } );
  try {
    await on( vol, () => {
      const cb = runConsistencyAudit( { checks: [ 'C-B' ] } ).deterministic[ 'C-B' ];
      const dup = cb.groups.find( ( g ) => g.id === 'dup' );
      assert.equal( dup.files[ 0 ].size_bytes, dup.files[ 1 ].size_bytes, 'the negative input: equal sizes' );
      assert.equal( dup.classification, 'divergent' );
      assert.equal( dup.severity, 'high' );
      assert.equal( cb.groups.find( ( g ) => g.id === 'same' ).classification, 'identical' );
      assert.equal( cb.pass, false );
    } );
  } finally { vol.done(); }
} );

test( 'C-C: an id with two registered candidates is reported as ambiguous, not resolved silently', async () => {
  const vol = volume( { files: { 'modules/a/two.md': '# one\n', 'modules/b/two.md': '# other\n' },
    manifest: [ { id: 'two', path: 'modules/a/two.md' } ],
    fragments: { '10-b.json': [ { id: 'two', path: 'modules/b/two.md' } ] } } );
  try {
    await on( vol, () => {
      const cc = runConsistencyAudit( { checks: [ 'C-C' ] } ).deterministic[ 'C-C' ];
      assert.equal( cc.pass, false );
      const f = cc.findings.find( ( x ) => x.id === 'two' );
      assert.ok( f.problems.some( ( p ) => p.startsWith( 'ambiguous' ) ) );
      assert.deepEqual( f.candidates.map( ( c ) => c.path ).sort(), [ 'modules/a/two.md', 'modules/b/two.md' ] );
      assert.equal( f.resolved_path, 'modules/a/two.md', 'the path the loader returns is still stated' );
    } );
  } finally { vol.done(); }
} );

test( 'C-D: a second DISPATCH_RULES.json under modules/ is reported as a shadow', async () => {
  const vol = volume( { files: { 'modules/ava/DISPATCH_RULES.json': '{"shadow":true}\n', 'modules/references/manifest/20-i18n-core.json': '{}\n', 'modules/a/a.md': '# a\n' } } );
  try {
    await on( vol, () => {
      const cd = runConsistencyAudit( { checks: [ 'C-D' ] } ).deterministic[ 'C-D' ];
      assert.equal( cd.pass, false );
      assert.deepEqual( cd.shadow_copies.map( ( s ) => s.path ).sort(),
        [ 'modules/ava/DISPATCH_RULES.json', 'modules/references/manifest/20-i18n-core.json' ] );
      assert.deepEqual( cd.canonical_missing, [] );
    } );
  } finally { vol.done(); }
} );

test( 'C-F: one id registered in two fragments names both', async () => {
  const vol = volume( { files: { 'modules/reading/reading-book-protocol.md': '# r\n' },
    fragments: { '10-reading.json': [ { id: 'reading-book-protocol', path: 'modules/reading/reading-book-protocol.md' } ],
      '30-books.json': [ { id: 'reading-book-protocol', path: 'modules/reading/reading-book-protocol.md' } ] } } );
  try {
    await on( vol, () => {
      const cf = runConsistencyAudit( { checks: [ 'C-F' ] } ).deterministic[ 'C-F' ];
      assert.equal( cf.pass, false );
      assert.deepEqual( cf.findings[ 0 ].fragments, [ 'references/manifest/10-reading.json', 'references/manifest/30-books.json' ] );
    } );
  } finally { vol.done(); }
} );

test( 'D9: deterministic and advisory findings are separate sections with no shared total', async () => {
  const vol = angstVolume();
  try {
    await on( vol, () => {
      const c = runConsistencyAudit();
      assert.ok( c.deterministic && c.advisory && c.judgment );
      for ( const k of [ 'C-E', 'C-G', 'C-H', 'C-I' ] ) assert.equal( c.deterministic[ k ], undefined, `${ k } is advisory` );
      assert.equal( JSON.stringify( c ).includes( 'total_findings' ), false );
      assert.equal( c.read_only, true );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── 5.2 / 5.3 advisory and judgment ────────────

test( 'C-E: the always-load aggregate moves by exactly the module added (nine, then ten)', async () => {
  const files = {};
  const frag = [];
  for ( let i = 1; i <= 10; i++ ) {
    files[ `modules/m/m${ i }.md` ] = `# m${ i }\n${ 'x'.repeat( 100 * i ) }\n`;
    frag.push( { id: `m${ i }`, path: `modules/m/m${ i }.md`, always_load: i <= 9 } );
  }
  const vol = volume( { files, fragments: { '10-m.json': frag }, core: 'C'.repeat( 4000 ) } );
  try {
    await on( vol, () => {
      const nine = runConsistencyAudit( { checks: [ 'C-E' ] } ).advisory[ 'C-E' ];
      assert.equal( nine.always_load_modules, 9 );
      assert.equal( nine.core_bytes, 4000 );
      frag[ 9 ].always_load = true;
      writeFileSync( join( vol.ava, 'references', 'manifest', '10-m.json' ), JSON.stringify( { source: 'm', modules: frag } ) );
      const ten = runConsistencyAudit( { checks: [ 'C-E' ] } ).advisory[ 'C-E' ];
      assert.equal( ten.always_load_modules, 10 );
      const added = Buffer.byteLength( files[ 'modules/m/m10.md' ] );
      assert.equal( ten.aggregate_bytes - nine.aggregate_bytes, added );
      assert.equal( ten.aggregate_estimated_tokens, Math.ceil( ten.aggregate_bytes / 4 ) );
      assert.equal( ten.headroom_estimated_tokens, 40000 - ten.aggregate_estimated_tokens );
    } );
  } finally { vol.done(); }
} );

/** Ten modules that declare provides; `missing` of them do not carry one. */
function providesVolume( count, missing ) {
  const files = {};
  const frag = [];
  for ( let i = 0; i < count; i++ ) {
    const body = i < missing ? `# p${ i }\nnothing relevant\n` : `# p${ i }\nThis module handles lemon tart baking.\n`;
    files[ `modules/p/p${ i }.md` ] = body;
    frag.push( { id: `p${ i }`, path: `modules/p/p${ i }.md`, provides: [ 'lemon tart baking' ] } );
  }
  return volume( { files, fragments: { '10-p.json': frag } } );
}

test( 'C-G: below a ten-module sample the check is not run', async () => {
  const vol = providesVolume( 9, 1 );
  try { await on( vol, () => assert.equal( runConsistencyAudit( { checks: [ 'C-G' ] } ).advisory[ 'C-G' ].status, 'not_run' ) ); } finally { vol.done(); }
} );

test( 'C-G: a missing capability fires when the calibration rate is within twenty per cent', async () => {
  const vol = providesVolume( 10, 1 );
  try {
    await on( vol, () => {
      const g = runConsistencyAudit( { checks: [ 'C-G' ] } ).advisory[ 'C-G' ];
      assert.equal( g.status, 'run' );
      assert.equal( g.calibration_fire_rate, 0.1 );
      assert.deepEqual( g.findings.map( ( f ) => f.id ), [ 'p0' ] );
    } );
  } finally { vol.done(); }
} );

test( 'C-G: above twenty per cent on the sample the check is dropped, not tuned', async () => {
  const vol = providesVolume( 10, 3 );
  try {
    await on( vol, () => {
      const g = runConsistencyAudit( { checks: [ 'C-G' ] } ).advisory[ 'C-G' ];
      assert.equal( g.status, 'dropped' );
      assert.equal( g.findings, undefined );
    } );
  } finally { vol.done(); }
} );

test( 'C-H: two modules claiming one phrase are reported with their load_priority', async () => {
  const vol = volume( { files: { 'modules/a/a.md': '# a\n', 'modules/b/b.md': '# b\n' },
    fragments: { '10-x.json': [
      { id: 'a', path: 'modules/a/a.md', load_priority: 3, triggers: { phrases: [ 'bad faith' ], keywords: [] } },
      { id: 'b', path: 'modules/b/b.md', load_priority: 7, triggers: { phrases: [ 'Bad Faith' ], keywords: [] } } ] } } );
  try {
    await on( vol, () => {
      const h = runConsistencyAudit( { checks: [ 'C-H' ] } ).advisory[ 'C-H' ];
      assert.equal( h.collisions, 1 );
      assert.deepEqual( h.findings[ 0 ].modules, [ { id: 'a', load_priority: 3 }, { id: 'b', load_priority: 7 } ] );
    } );
  } finally { vol.done(); }
} );

test( 'C-I: a stated line_count_estimate that the file does not have is reported (144 against 136)', async () => {
  const body = `---\nid: meta-deepseek-counterpull\nline_count_estimate: 144\n---\n${ 'line\n'.repeat( 131 ) }`;
  const vol = volume( { files: { 'modules/meta/meta-deepseek-counterpull.md': body },
    fragments: { '10-meta.json': [ { id: 'meta-deepseek-counterpull', path: 'modules/meta/meta-deepseek-counterpull.md' } ] } } );
  try {
    await on( vol, () => {
      const i = runConsistencyAudit( { checks: [ 'C-I' ] } ).advisory[ 'C-I' ];
      assert.deepEqual( i.findings.map( ( f ) => [ f.kind, f.stated, f.actual ] ), [ [ 'line_count_estimate', 144, 136 ] ] );
    } );
  } finally { vol.done(); }
} );

test( 'C-J: a one-sided disagreement is reported; a reciprocal one is not', async () => {
  const vol = volume( {
    files: {
      'modules/p/phil-virtue-aristotle-macintyre.md': '# virtue\nThis disagrees with phil-self-authorship-kegan on the socially constituted self.\n',
      'modules/p/phil-self-authorship-kegan.md': '# kegan\nSelf-authorship.\n',
      'modules/p/phil-a.md': '# a\nIn tension with phil-b on beauty.\n',
      'modules/p/phil-b.md': '# b\nphil-a reads this differently.\n',
    },
    fragments: { '10-p.json': [ 'phil-virtue-aristotle-macintyre', 'phil-self-authorship-kegan', 'phil-a', 'phil-b' ].map( ( id ) => ( { id, path: `modules/p/${ id }.md` } ) ) },
  } );
  try {
    await on( vol, () => {
      const j = runConsistencyAudit( { checks: [ 'C-J' ] } ).judgment[ 'C-J' ];
      assert.deepEqual( j.findings.map( ( f ) => [ f.module, f.names ] ), [ [ 'phil-virtue-aristotle-macintyre', 'phil-self-authorship-kegan' ] ] );
      assert.match( j.findings[ 0 ].finding, /does not record/ );
    } );
  } finally { vol.done(); }
} );

test( 'C-K: delegated to vault_provenance_audit, not re-implemented; the registered ids are handed over', async () => {
  const vol = angstVolume();
  try {
    await on( vol, () => {
      const c = runConsistencyAudit();
      assert.equal( c.judgment[ 'C-K' ].status, 'delegated' );
      assert.equal( c.judgment[ 'C-K' ].delegated_to, 'vault_provenance_audit' );
      assert.deepEqual( c.registered_module_ids, [ ANGST, 'meta-self-check' ] );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── D1 / D4 / R1: module_delete ────────────────

test( 'R1: the first call is a dry run that returns the whole picture and changes nothing', async () => {
  const vol = angstVolume();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const r = await del( { file: 'modules/philosophy/exist-angst-kierkegaard-heidegger.md' } );
      assert.equal( r.dry_run, true );
      assert.equal( r.done, false );
      assert.equal( r.resolution.resolved_path, 'modules/exist-angst-kierkegaard-heidegger.md' );
      assert.equal( r.siblings.length, 2 );
      assert.ok( r.siblings.every( ( s ) => /^[0-9a-f]{64}$/.test( s.sha256 ) && s.first_differing_line ) );
      assert.equal( r.always_load, false );
      assert.equal( r.would.move_to, 'quarantine/modules/philosophy/exist-angst-kierkegaard-heidegger.md' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

/** Assert a confirmed call was refused with `code` and nothing on the volume changed. */
async function refused( vol, args, code ) {
  const before = tree( vol );
  const r = await del( { confirm: true, dry_run: false, ...args } );
  assert.equal( r.done, false );
  assert.ok( r.refusals.some( ( x ) => x.code === code ), `expected ${ code }, got ${ JSON.stringify( r.refusals.map( ( x ) => x.code ) ) }` );
  assert.deepEqual( tree( vol ), before, 'no file moved' );
  return r;
}

test( 'D4.1: a protected name inside modules/, and a path outside modules/, are refused', async () => {
  const vol = volume( { files: { 'modules/ava/DISPATCH_RULES.json': '{}\n', 'modules/a/a.md': '# a\n', 'modules/existential/exist-x.md': '# x\n' } } );
  try {
    await on( vol, async () => {
      await refused( vol, { file: 'modules/ava/DISPATCH_RULES.json', expected_sha256: sha( '{}\n' ) }, 'protected_path' );
      await refused( vol, { file: 'CORE.md' }, 'outside_modules' );
      await refused( vol, { file: 'modules/../CORE.md' }, 'outside_modules' );
      // The module_write spelling without the prefix is refused, not guessed at.
      await refused( vol, { file: 'a/a.md', expected_sha256: sha( '# a\n' ) }, 'outside_modules' );
      await refused( vol, { file: 'existential/exist-x.md', expected_sha256: sha( '# x\n' ) }, 'outside_modules' );
    } );
  } finally { vol.done(); }
} );

test( 'D4.2 / 8.14: no hash is refused; a stale hash (read, then the file changes) is refused with the actual hash', async () => {
  const vol = volume( { files: { 'modules/a/x.md': '# x\n', 'modules/b/x.md': '# x\n' } } );
  try {
    await on( vol, async () => {
      await refused( vol, { file: 'modules/b/x.md' }, 'hash_required' );
      const read = sha( readFileSync( join( vol.ava, 'modules/b/x.md' ) ) );
      writeFileSync( join( vol.ava, 'modules/b/x.md' ), '# x\nchanged after the read\n' );
      const r = await refused( vol, { file: 'modules/b/x.md', expected_sha256: read }, 'hash_mismatch' );
      const m = r.refusals.find( ( x ) => x.code === 'hash_mismatch' );
      assert.equal( m.actual_sha256, sha( '# x\nchanged after the read\n' ) );
    } );
  } finally { vol.done(); }
} );

test( 'D4.3: the live copy with no registered replacement is refused', async () => {
  const body = '# live\n';
  const vol = volume( { files: { 'modules/a/live.md': body, 'modules/modules/a/live.md': body },
    fragments: { '10-a.json': [ { id: 'live', path: 'modules/a/live.md' } ] } } );
  try {
    await on( vol, () => refused( vol, { file: 'modules/a/live.md', expected_sha256: sha( body ) }, 'live_copy_no_replacement' ) );
  } finally { vol.done(); }
} );

test( 'D4.4: the last file for an id is refused', async () => {
  const vol = volume( { files: { 'modules/a/only.md': '# only\n' } } );
  try {
    await on( vol, () => refused( vol, { file: 'modules/a/only.md', expected_sha256: sha( '# only\n' ) }, 'last_file_for_id' ) );
  } finally { vol.done(); }
} );

test( 'D4.5 / 8.15: divergent copies are refused naming all three hashes; acknowledged, exactly one file moves', async () => {
  const vol = angstVolume();
  try {
    await on( vol, async () => {
      const target = 'modules/philosophy/exist-angst-kierkegaard-heidegger.md';
      const hash = ( p ) => sha( readFileSync( join( vol.ava, p ) ) );
      const r = await refused( vol, { file: target, expected_sha256: hash( target ) }, 'divergent_siblings' );
      const d = r.refusals.find( ( x ) => x.code === 'divergent_siblings' );
      const named = new Set( [ d.target.sha256, ...d.siblings.map( ( s ) => s.sha256 ) ] );
      assert.equal( named.size, 3, 'all three different hashes are named' );
      assert.ok( d.siblings.every( ( s ) => s.first_differing_line && s.first_differing_line.line === 1 ) );

      // An acknowledgement without a reason is still refused.
      const retained = 'modules/existential/exist-angst-kierkegaard-heidegger.md';
      await refused( vol, { file: target, expected_sha256: hash( target ), acknowledge_divergence: hash( retained ) }, 'divergent_siblings' );

      const before = tree( vol );
      const ok = await del( { file: target, confirm: true, dry_run: false, expected_sha256: hash( target ),
        acknowledge_divergence: hash( retained ), reason: 'the existential copy is the reviewed reading' } );
      assert.equal( ok.done, true, JSON.stringify( ok.refusals ) );
      const after = tree( vol );
      const moved = Object.keys( before ).filter( ( p ) => ! ( p in after ) );
      assert.deepEqual( moved, [ target ], 'exactly one file left modules/' );
      assert.equal( after[ `quarantine/${ target }` ], before[ target ] );
      assert.equal( ok.retained_path, retained, 'the retained copy is the acknowledged one' );
      const ev = events( { id: ANGST } ).events.pop();
      assert.equal( ev.action, 'quarantined' );
      assert.equal( ev.retained_path, retained );
      assert.equal( ev.acknowledged_divergence, hash( retained ) );
    } );
  } finally { vol.done(); }
} );

test( 'D4.6: an always_load module that would stop resolving is refused', async () => {
  const body = '# always\n';
  const vol = volume( { files: { 'modules/a/always.md': body, 'modules/modules/a/always.md': body },
    fragments: { '10-a.json': [ { id: 'always', path: 'modules/a/always.md', always_load: true } ] } } );
  try {
    await on( vol, () => refused( vol, { file: 'modules/a/always.md', expected_sha256: sha( body ) }, 'always_load_floor' ) );
  } finally { vol.done(); }
} );

test( 'fail closed: a file registered in MANIFEST.json (frozen) is refused rather than left registered and missing', async () => {
  const body = '# frozen\n';
  const vol = volume( { files: { 'modules/a/f.md': body, 'modules/b/f.md': body },
    manifest: [ { id: 'f', path: 'modules/b/f.md' }, { id: 'f2', path: 'modules/a/f.md' } ] } );
  try {
    await on( vol, () => refused( vol, { file: 'modules/a/f.md', expected_sha256: sha( body ) }, 'registered_in_frozen_manifest' ) );
  } finally { vol.done(); }
} );

// ───────────────────────────── D6 / R6 / R2 / D5 ──────────────────────────

test( 'D6 / R6 / 8.16: an identical duplicate is quarantined, its registration removed, and the compile still resolves everything', async () => {
  const body = '# meta deflection\nsame\n';
  const vol = volume( {
    files: { 'modules/meta/meta-deflection-watch.md': body, 'modules/modules/meta/meta-deflection-watch.md': body, 'modules/meta/meta-self-check.md': '# sc\n' },
    fragments: {
      '10-meta.json': [ { id: 'meta-deflection-watch', path: 'modules/meta/meta-deflection-watch.md' }, { id: 'meta-self-check', path: 'modules/meta/meta-self-check.md', always_load: true } ],
      '40-old.json': [ { id: 'meta-deflection-watch', path: 'modules/modules/meta/meta-deflection-watch.md' } ],
    },
  } );
  try {
    await on( vol, async () => {
      const target = 'modules/modules/meta/meta-deflection-watch.md';
      const r = await del( { file: target, confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( r.done, true, JSON.stringify( r.refusals ) );
      assert.ok( existsSync( join( vol.ava, 'quarantine', target ) ) );
      const frag = JSON.parse( readFileSync( join( vol.ava, 'references', 'manifest', '40-old.json' ), 'utf8' ) );
      assert.deepEqual( frag.modules, [], 'the quarantined file\'s registration is gone with it' );
      // R6, asserted independently of the tool's own report.
      const snap = MF.buildModuleSnapshot();
      const integrity = MF.compileIntegrity( snap );
      assert.deepEqual( integrity.broken_ids, [] );
      assert.ok( integrity.always_load.every( ( a ) => a.resolves ) );
      assert.equal( MF.resolveModulePath( 'meta-deflection-watch' ).resolved_path, 'modules/meta/meta-deflection-watch.md' );
      assert.deepEqual( r.compile_check.broken_after, [] );
      const a = parse( await handleSkillAudit( {} ) );
      assert.deepEqual( a.registration.manifest_entries_without_file, [], 'no entry is left pointing at the moved file' );
    } );
  } finally { vol.done(); }
} );

test( 'R2 / 8.17: quarantine then restore is byte-identical, re-registers, and the log carries both rows', async () => {
  const body = '# twin\nbody\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body },
    fragments: { '10-a.json': [ { id: 'twin', path: 'modules/a/twin.md' } ], '20-b.json': [ { id: 'twin', path: 'modules/b/twin.md' } ] } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const q = await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( q.done, true, JSON.stringify( q.refusals ) );
      const dry = await restore( { file: q.restore_with.file } );
      assert.equal( dry.dry_run, true );
      assert.ok( existsSync( join( vol.ava, 'quarantine/modules/b/twin.md' ) ), 'a dry restore moves nothing' );
      const r = await restore( { file: q.restore_with.file, confirm: true, dry_run: false } );
      assert.equal( r.done, true, JSON.stringify( r.refusals ) );
      const after = tree( vol );
      assert.ok( after[ 'quarantine/module_file_events.jsonl' ], 'the log is the one new file' );
      delete after[ 'quarantine/module_file_events.jsonl' ];
      assert.deepEqual( after, before, 'every other file, fragments included, is byte-identical to before' );
      const log = events( { path: 'modules/b/twin.md' } ).events.map( ( e ) => e.action );
      assert.deepEqual( log, [ 'quarantined', 'restored' ] );
    } );
  } finally { vol.done(); }
} );

test( 'R2: a restore onto an occupied location is refused', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      const q = await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( q.done, true, JSON.stringify( q.refusals ) );
      writeFileSync( join( vol.ava, 'modules/b/twin.md' ), '# newcomer\n' );
      const r = await restore( { file: 'quarantine/modules/b/twin.md', confirm: true, dry_run: false } );
      assert.equal( r.done, false );
      assert.equal( r.code, 'restore_target_occupied' );
      assert.equal( readFileSync( join( vol.ava, 'modules/b/twin.md' ), 'utf8' ), '# newcomer\n' );
    } );
  } finally { vol.done(); }
} );

test( 'D1 / D5: purge is a second call, only from quarantine, and the record keeps the content', async () => {
  const body = '# twin\nkeep me\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      const notQ = await del( { file: 'modules/b/twin.md', purge: true, confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( notQ.code, 'not_in_quarantine' );
      assert.ok( existsSync( join( vol.ava, 'modules/b/twin.md' ) ), 'a purge never reaches into modules/' );
      await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      const noHash = await del( { file: 'quarantine/modules/b/twin.md', purge: true, confirm: true, dry_run: false } );
      assert.equal( noHash.code, 'hash_required' );
      const p = await del( { file: 'quarantine/modules/b/twin.md', purge: true, confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( p.done, true, JSON.stringify( p.refusals ) );
      assert.equal( existsSync( join( vol.ava, 'quarantine/modules/b/twin.md' ) ), false );
      const ev = events( { path: 'modules/b/twin.md', include_snapshot: true } ).events;
      assert.deepEqual( ev.map( ( e ) => e.action ), [ 'quarantined', 'purged' ] );
      assert.equal( ev[ 1 ].content_snapshot, body, 'the file is gone; its content is not' );
      assert.equal( ev[ 1 ].sha256, sha( body ) );
    } );
  } finally { vol.done(); }
} );

test( 'R3: the event log filters by id and by path, and omits snapshots by default', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      assert.deepEqual( events().events, [] );
      await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      const byId = events( { id: 'twin' } ).events;
      assert.equal( byId.length, 1 );
      assert.equal( byId[ 0 ].content_snapshot, undefined );
      assert.equal( byId[ 0 ].content_snapshot_bytes, Buffer.byteLength( body ) );
      assert.equal( events( { path: 'quarantine/modules/b/twin.md' } ).events.length, 1 );
      assert.equal( events( { id: 'other' } ).events.length, 0 );
    } );
  } finally { vol.done(); }
} );

test( 'D4.5: identical siblings need no acknowledgement', async () => {
  const body = '# same\n';
  const vol = volume( { files: { 'modules/a/same.md': body, 'modules/b/same.md': body } } );
  try {
    await on( vol, async () => {
      const r = await del( { file: 'modules/b/same.md' } );
      assert.deepEqual( r.refusals.map( ( x ) => x.code ), [ 'hash_required' ], 'only the hash is missing on a dry run' );
      assert.match( r.next_step, /expected_sha256/ );
    } );
  } finally { vol.done(); }
} );

test( 'checkE is exported for the gateway-free measurement', () => { assert.equal( typeof checkE, 'function' ); } );

test( 'D3 (structural): the compile asks the shared resolver for the file of every module it loads, and of meta-self-check', () => {
  // The resolver's compile form applies the loop's own rule, so a reversion to
  // `paths.avaDir + module.path` would compile identically today; this is the
  // pin that keeps one resolver rather than two that happen to agree.
  // Line comments only: a block-comment strip would also eat code between a
  // '/*' inside a string (a glob in a path list) and the next comment close.
  const src = readFileSync( new URL( '../tools/skill-modular.js', import.meta.url ), 'utf8' )
    .replace( /^\s*\/\/.*$/gm, '' );
  const body = src.slice( src.indexOf( 'function compileSkill(' ), src.indexOf( 'const compiled = parts.join(' ) );
  assert.match( body, /const modulePath = resolveModulePath\(id, \{ paths, manifest \}\)\.resolved_path_absolute;/ );
  assert.match( body, /const selfCheckPath = resolveModulePath\(selfCheckId, \{ paths, manifest \}\)\.resolved_path_absolute;/ );
  assert.doesNotMatch( body, /paths\.avaDir \+ module\.path|paths\.avaDir \+ moduleMap\[/ );
} );
