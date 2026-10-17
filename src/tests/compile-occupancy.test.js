// src/tests/compile-occupancy.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-7: compile occupancy reporting and body-size listing.
//
//   C-OCC-REPORTED           a compile reports tokens used against the cap, with
//                            the counting method named; always_load members are
//                            in the total
//   C-OCC-PER-MODULE         every assembled part's body size is listable, on
//                            the compile AND the recompile path
//   C-OCC-TRUNCATION-POLICY  the policy is written next to the cap and the
//                            behaviour matches it: over the token cap the body
//                            is returned whole and flagged; over the line budget
//                            whole modules are demoted and named, never cut
//
// Drives the real skill_compile / skill_recompile handlers against a volume.
// ---------------------------------------------------------------------------

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCompileVolume, expectedBody, tokensOf, FILES } from './helpers/compile-volume.js';

process.env.TS_CLIENT_MODE = 'owner';
process.env.AVA_PERSON_PRIOR_ENABLED = 'false';

const SM = await import( '../tools/skill-modular.js' );
const OCC = await import( '../tools/skill-occupancy.js' );

const body = ( r ) => JSON.parse( r.content[ 0 ].text );
const HERE = dirname( fileURLToPath( import.meta.url ) );
const ALWAYS = 'modules/meta/always.md';
const GARDEN = 'modules/garden/garden.md';
const COOKING = 'modules/cooking/cooking.md';
const SELF = 'modules/meta/self-check.md';

let vol = null;
afterEach( () => { if ( vol ) vol.cleanup(); vol = null; } );

describe( 'H-7 compile occupancy', () => {
  test( 'C-OCC-REPORTED: tokens used against the cap, method named, and the total includes the always_load member', async () => {
    vol = buildCompileVolume();
    const r = body( await SM.handleSkillCompile( { query: 'how should I water my garden', session_id: 's1' } ) );
    assert.deepEqual( [ ...r.modules_loaded ].sort(), [ 'always-meta', 'garden', 'meta-self-check' ] );
    assert.equal( r.content, expectedBody( r.modules_loaded ), 'the compile body the occupancy describes' );
    const o = r.occupancy;
    assert.equal( o.path, 'compile' );
    assert.equal( o.cap, OCC.COMPILE_TOKEN_CAP_DEFAULT );
    assert.match( o.cap_source, /^default/ );
    assert.equal( o.method, OCC.OCCUPANCY_METHOD );
    assert.match( o.method, /assembly_estimate/ );
    // Independently: the sum of what was concatenated, part by part.
    const want = tokensOf( FILES[ 'CORE.md' ] ) + tokensOf( '\n\n' + FILES[ 'PERSONALITY.md' ].trim() )
      + tokensOf( '\n\n' + FILES[ ALWAYS ] ) + tokensOf( '\n\n' + FILES[ GARDEN ] ) + tokensOf( '\n\n' + FILES[ SELF ] );
    assert.equal( o.tokens_used, want );
    const always = o.modules.find( ( m ) => m.id === 'always-meta' );
    assert.ok( always, 'the always_load member is a measured part' );
    assert.equal( always.tokens_est, tokensOf( '\n\n' + FILES[ ALWAYS ] ) );
    assert.equal( o.pct_of_cap, Math.round( ( want / o.cap ) * 1000 ) / 10 );
    assert.equal( o.over_cap, false );
  } );

  test( 'C-OCC-REPORTED: a manifest cap is honoured and its source named', async () => {
    vol = buildCompileVolume( { max_compiled_tokens: 12345 } );
    const o = body( await SM.handleSkillCompile( { query: 'garden' } ) ).occupancy;
    assert.equal( o.cap, 12345 );
    assert.equal( o.cap_source, 'MANIFEST.json budget.max_compiled_tokens' );
  } );

  test( 'C-OCC-PER-MODULE: every assembled part is listed with its body size, largest first', async () => {
    vol = buildCompileVolume();
    const o = body( await SM.handleSkillCompile( { query: 'garden and cooking' } ) ).occupancy;
    const ids = o.modules.map( ( m ) => m.id );
    assert.deepEqual( [ ...ids ].sort(), [ 'CORE', 'PERSONALITY', 'always-meta', 'cooking', 'garden', 'meta-self-check' ] );
    assert.equal( ids[ 0 ], 'cooking', 'sorted by size, largest first' );
    const cooking = o.modules[ 0 ];
    assert.equal( cooking.role, 'module' );
    assert.equal( cooking.path, COOKING );
    assert.equal( cooking.chars, ( '\n\n' + FILES[ COOKING ] ).length );
    assert.equal( cooking.lines, ( '\n\n' + FILES[ COOKING ] ).split( '\n' ).length );
    for ( let i = 1; i < o.modules.length; i += 1 ) assert.ok( o.modules[ i - 1 ].tokens_est >= o.modules[ i ].tokens_est );
    assert.equal( o.modules.find( ( m ) => m.id === 'meta-self-check' ).role, 'self_check' );
  } );

  test( 'C-OCC-PER-MODULE: the recompile path reports the delta it returns, part by part, and an empty delta still reports', async () => {
    vol = buildCompileVolume();
    const r = body( await SM.handleSkillRecompile( { new_query: 'cooking tonight', current_modules: [ 'always-meta', 'garden', 'meta-self-check' ] } ) );
    assert.deepEqual( r.new_modules, [ 'cooking' ] );
    assert.equal( r.occupancy.path, 'recompile' );
    assert.deepEqual( r.occupancy.modules.map( ( m ) => [ m.id, m.chars ] ), [ [ 'cooking', ( '\n\n' + FILES[ COOKING ] ).length ] ] );
    assert.equal( r.occupancy.tokens_used, tokensOf( r.content ) );
    const none = body( await SM.handleSkillRecompile( { new_query: 'cooking', current_modules: [ 'always-meta', 'cooking', 'meta-self-check' ] } ) );
    assert.deepEqual( none.new_modules, [] );
    assert.equal( none.occupancy.path, 'recompile' );
    assert.equal( none.occupancy.tokens_used, 0 );
    assert.equal( none.occupancy.method, OCC.OCCUPANCY_METHOD );
  } );

  test( 'C-OCC-TRUNCATION-POLICY: over the token cap the body is returned whole and the overrun is flagged with a marker', async () => {
    vol = buildCompileVolume( { max_compiled_tokens: 10 } );
    const r = body( await SM.handleSkillCompile( { query: 'garden and cooking' } ) );
    assert.deepEqual( [ ...r.modules_loaded ].sort(), [ 'always-meta', 'cooking', 'garden', 'meta-self-check' ] );
    assert.equal( r.content, expectedBody( r.modules_loaded ), 'not one character cut' );
    const t = r.occupancy;
    assert.equal( t.over_cap, true );
    assert.equal( t.truncation.text_truncated, false );
    assert.equal( t.truncation.policy, OCC.TRUNCATION_POLICY );
    assert.ok( t.truncation.markers.some( ( m ) => /exceeds the 10-token cap/.test( m ) && /returned whole, not truncated/.test( m ) ) );
  } );

  test( 'C-OCC-TRUNCATION-POLICY: over the line budget a whole module is demoted and named; nothing is cut part-way', async () => {
    vol = buildCompileVolume( { max_compiled_lines: 300, core_reserve_lines: 250 } );
    const r = body( await SM.handleSkillCompile( { query: 'garden and cooking' } ) );
    assert.deepEqual( [ ...r.modules_loaded ].sort(), [ 'always-meta', 'garden', 'meta-self-check' ] );
    assert.equal( r.content, expectedBody( r.modules_loaded ), 'cooking is absent whole, the rest present whole' );
    assert.ok( ! r.content.includes( 'Step 0: taste' ), 'no fragment of the demoted module' );
    const t = r.occupancy.truncation;
    assert.deepEqual( t.demoted, [ 'cooking' ] );
    assert.ok( t.markers.some( ( m ) => /demoted by the line budget \(300 lines\): cooking/.test( m ) ) );
    assert.deepEqual( r.occupancy.line_budget, { max_lines: 300, core_reserve_lines: 250, lines_returned: r.line_count } );
  } );

  test( 'C-OCC-TRUNCATION-POLICY: the policy is written next to the cap at source', () => {
    const src = readFileSync( join( HERE, '..', 'tools', 'skill-occupancy.js' ), 'utf8' );
    const capAt = src.indexOf( 'export const COMPILE_TOKEN_CAP_DEFAULT' );
    const policyAt = src.indexOf( 'TRUNCATION POLICY (written next to the cap' );
    assert.ok( capAt > 0 && policyAt > 0 && capAt - policyAt < 2000, 'the policy block sits directly above the cap constant' );
  } );
} );

// ── The wire to the gateway (twin fixture) ──────────────────────────────────
//
// src/tests/fixtures/compile-occupancy-wire.json is byte-identical to the
// gateway's tests/fixtures/compile-occupancy-wire.json (both pin its sha256).
// Here it must be exactly what buildOccupancy produces today; on the gateway it
// must read through lib/compile-occupancy.js. A change to the occupancy shape
// reddens this test first; regenerating the fixture changes the sha, which
// reddens the gateway's pin until the gateway reader is checked against it.

const WIRE_SHA256 = '1b5a25ac95e91de2d6d47772c617904fb1855c3980170c35af2e634cb1e894c9';

describe( 'compile occupancy wire (twin fixture with the gateway)', () => {
  const raw = readFileSync( join( HERE, 'fixtures', 'compile-occupancy-wire.json' ) );

  test( 'the fixture is the pinned one', async () => {
    const { createHash } = await import( 'node:crypto' );
    assert.equal( createHash( 'sha256' ).update( raw ).digest( 'hex' ), WIRE_SHA256 );
  } );

  test( 'C-OCC-REPORTED: buildOccupancy still produces the fixture, byte for byte, for each case', () => {
    const wire = JSON.parse( raw.toString( 'utf8' ) );
    assert.ok( wire.cases.length >= 2 );
    for ( const c of wire.cases ) {
      const parts = c.input.parts.map( ( p ) => OCC.measurePart( p.id, p.role, p.text ) );
      const out = OCC.buildOccupancy( { ...c.input, parts } );
      assert.deepEqual( out, c.output, c.name );
    }
  } );
} );
