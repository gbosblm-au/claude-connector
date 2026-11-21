// src/tests/selection-telemetry.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-8: module selection telemetry, read-only.
//
//   C-SEL-RECORDED             every compile AND recompile appends a record:
//                              selected set with tiers, always_load members,
//                              person-prior outcome, time
//   C-SEL-READONLY             nothing consumes the log to alter selection
//                              (static guard over the source tree)
//   C-SEL-CONSTRAINT-TRAVELLED every report output carries the constraint
//   C-SEL-CLOSED               enumerated fields read from closed sets; an
//                              unknown value reads 'other'
// ---------------------------------------------------------------------------

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCompileVolume } from './helpers/compile-volume.js';
import { jsFiles, readBlanked } from './helpers/source-scan.js';

process.env.TS_CLIENT_MODE = 'owner';
process.env.AVA_PERSON_PRIOR_ENABLED = 'false';

const SM = await import( '../tools/skill-modular.js' );
const ST = await import( '../tools/selection-telemetry.js' );

const HERE = dirname( fileURLToPath( import.meta.url ) );
const SRC = join( HERE, '..' );
const body = ( r ) => JSON.parse( r.content[ 0 ].text );

let vol = null;
afterEach( () => { if ( vol ) vol.cleanup(); vol = null; } );

describe( 'H-8 module selection telemetry', () => {
  test( 'C-SEL-RECORDED: a compile and a recompile each append a record with the selected set, tiers, always_load and prior outcome', async () => {
    vol = buildCompileVolume();
    await SM.handleSkillCompile( { query: 'how should I water my garden', session_id: 'sess-1', person_name: 'Brian' } );
    await SM.handleSkillRecompile( { new_query: 'cooking tonight', current_modules: [ 'always-meta', 'garden', 'meta-self-check' ], session_id: 'sess-1' } );
    const rows = ST.readSelectionRecords( vol.ava + '/' );
    assert.equal( rows.length, 2 );
    const [ c, rc ] = rows;
    assert.equal( c.path, 'compile' );
    assert.equal( c.session_id, 'sess-1' );
    assert.equal( c.person, 'brian' );
    assert.equal( c.person_prior, 'disabled', 'AVA_PERSON_PRIOR_ENABLED=false with a person named' );
    assert.deepEqual( Object.fromEntries( c.modules.map( ( m ) => [ m.id, m.tier ] ) ), { 'always-meta': 'always_load', garden: 'lexical', 'meta-self-check': 'self_check' } );
    assert.deepEqual( c.always_load, [ 'always-meta' ] );
    assert.match( c.at, /^\d{4}-\d{2}-\d{2}T/ );
    assert.equal( c.delta, null );
    assert.equal( rc.path, 'recompile' );
    assert.equal( rc.person_prior, 'no_person' );
    assert.ok( rc.modules.some( ( m ) => m.id === 'cooking' && m.tier === 'lexical' ) );
    assert.deepEqual( rc.delta, [ 'cooking' ], 'the subset the recompile actually returned' );
  } );

  test( 'C-SEL-RECORDED: records are appended, one line per compile, and earlier lines never change', async () => {
    vol = buildCompileVolume();
    await SM.handleSkillCompile( { query: 'garden' } );
    const dir = ST.selectionDir( vol.ava + '/' );
    const [ file ] = readdirSync( dir );
    const before = readFileSync( join( dir, file ) );
    await SM.handleSkillCompile( { query: 'cooking' } );
    const after = readFileSync( join( dir, file ) );
    assert.ok( after.subarray( 0, before.length ).equals( before ) );
    assert.equal( after.toString().trim().split( '\n' ).length, 2 );
  } );

  test( 'C-SEL-RECORDED: an unwritable telemetry directory never costs the compile', async () => {
    vol = buildCompileVolume();
    mkdirSync( join( vol.ava, 'telemetry' ), { recursive: true } );
    writeFileSync( join( vol.ava, 'telemetry', 'selection' ), 'a file where the directory should be' );
    const r = await SM.handleSkillCompile( { query: 'garden' } );
    assert.notEqual( r.isError, true );
    assert.ok( body( r ).content.length > 0 );
  } );

  test( 'C-SEL-READONLY: nothing outside the report reads the log, and the dispatch layer only writes it', () => {
    const readers = [ 'readSelectionRecords', 'selectionReport', 'handleSkillSelectionReport', 'selectionDir' ];
    const offenders = [];
    for ( const rel of jsFiles( SRC, [ '.' ], ( r ) => ! r.startsWith( 'tests/' ) && r !== 'tools/selection-telemetry.js' ) ) {
      const { src, code } = readBlanked( SRC, rel );
      for ( const name of readers ) {
        if ( new RegExp( `\\b${ name }\\b` ).test( code ) && ! ( rel === 'server-http.js' && name === 'handleSkillSelectionReport' ) ) offenders.push( `${ rel }: ${ name }` );
      }
      // The log's files are reached only through the telemetry module: no
      // other file names the directory in a path literal.
      if ( /['"`]telemetry['"`]\s*,\s*['"`]selection['"`]|['"`][^'"`\n]*telemetry\/selection/.test( src ) ) offenders.push( `${ rel }: names the selection log directly` );
    }
    assert.deepEqual( offenders, [], 'only the read-only tool handler reads selection data' );
    // skill-modular.js (the dispatch layer) imports the writer and nothing else.
    const { src, code } = readBlanked( SRC, 'tools/skill-modular.js' );
    const imports = [];
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]/g;
    let m;
    while ( ( m = re.exec( code ) ) !== null ) {
      if ( src.slice( m.index, m.index + m[ 0 ].length + 40 ).includes( './selection-telemetry.js' ) ) imports.push( ...m[ 1 ].split( ',' ).map( ( x ) => x.trim() ).filter( Boolean ) );
    }
    assert.deepEqual( imports, [ 'recordSelection' ] );
  } );

  test( 'C-SEL-READONLY: the telemetry module itself never rewrites, deletes or renames anything', () => {
    const { src, code } = readBlanked( SRC, 'tools/selection-telemetry.js' );
    for ( const fn of [ 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync', 'copyFileSync', 'writeFile', 'rename', 'unlink' ] ) {
      assert.doesNotMatch( code, new RegExp( `\\b${ fn }\\s*\\(` ), fn );
    }
    assert.doesNotMatch( src, /from\s*['"]\.\/(?:skill-modular|skill-content|manifest-fragments|skill)\.js['"]/, 'no reach into the dispatch or manifest writers' );
  } );

  test( 'C-SEL-CONSTRAINT-TRAVELLED: every report output carries the constraint: empty, filtered, populated, and on error', async () => {
    vol = buildCompileVolume();
    const ava = vol.ava + '/';
    const outputs = [ body( ST.handleSkillSelectionReport( {}, ava ) ) ];
    await SM.handleSkillCompile( { query: 'garden' } );
    outputs.push( body( ST.handleSkillSelectionReport( {}, ava ) ) );
    outputs.push( body( ST.handleSkillSelectionReport( { module: 'garden', window: 'week' }, ava ) ) );
    outputs.push( body( ST.handleSkillSelectionReport( { task_class: 'writing' }, ava ) ) );
    outputs.push( body( ST.handleSkillSelectionReport( { person: 'nobody' }, ava ) ) );
    const err = ST.handleSkillSelectionReport( { limit: 5 }, null );
    assert.equal( err.isError, true );
    outputs.push( body( err ) );
    for ( const o of outputs ) assert.equal( o.constraint, ST.SELECTION_CONSTRAINT );
    assert.match( ST.SELECTION_CONSTRAINT, /Low selection is not a problem/ );
    assert.match( ST.SELECTION_CONSTRAINT, /No automatic action may be derived/ );
    assert.match( ST.skillSelectionReportToolDefinition.description, /no automatic action may be derived/i );
    assert.equal( outputs[ 1 ].compiles, 1 );
    assert.equal( outputs[ 2 ].by_module.garden.compiles, 1 );
  } );

  test( 'C-SEL-CLOSED: free-text tiers, conditions, outcomes and paths are recorded as other', () => {
    vol = buildCompileVolume();
    const r = ST.recordSelection( vol.ava + '/', {
      path: 'sideways', conditions: [ 'creative_fiction', 'made up condition' ],
      modules: [ { id: 'garden', tier: 'because I said so' }, { id: 'cooking', tier: 'lexical' } ],
      alwaysLoad: [], prior: 'mysterious',
    } );
    assert.equal( r.ok, true );
    assert.equal( r.record.path, 'other' );
    assert.deepEqual( r.record.conditions, [ 'creative_fiction', 'other' ] );
    assert.equal( r.record.task_class, 'creative' );
    assert.deepEqual( r.record.modules.map( ( m ) => m.tier ), [ 'other', 'lexical' ] );
    assert.equal( r.record.person_prior, 'other' );
    for ( const set of [ ST.SELECTION_TIERS, ST.SELECTION_CONDITIONS, ST.SELECTION_TASK_CLASSES, ST.PRIOR_OUTCOMES, ST.SELECTION_PATHS ] ) {
      assert.ok( Object.isFrozen( set ) && set.includes( 'other' ) );
    }
    // A report filter outside the set reads as 'other' too, rather than matching free text.
    assert.equal( ST.selectionReport( vol.ava + '/', { task_class: 'anything goes' } ).compiles, 0 );
  } );
} );
