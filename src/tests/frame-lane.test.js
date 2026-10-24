// src/tests/frame-lane.test.js  (claude-connector v13.42.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-24-02, the connector half: MANIFEST.json budget.frame_lane_lines
// is held back from the compile, so the gateway's one drawn module per session
// has lines no compiled module can take (Brian's ruling 2026-10-24, and the
// decision recorded in Gateway CHANGELOG-v2.279.0.md: the compile's specialist
// allowance is max - core - lane).
//
//   C-FLANE-NO-COMPILE-DELTA  raising max_compiled_lines by exactly the lane
//                             leaves the compile byte-identical: same body,
//                             same modules, same demotions
//   C-FLANE-ZERO-DISABLES     lane absent, null or 0: the response is the
//                             pre-13.42.0 response, byte for byte
//   C-FLANE-CEILING-FLOOR     a lane the ceiling cannot hold, or a value that
//                             is not a whole number of lines, is not applied
//                             (the compile is as if no lane were set) and is
//                             named in line_budget and the markers
//
// Drives the real skill_compile handler against a volume
// (helpers/compile-volume.js), so the arithmetic tested is the dispatcher's.
// The fixture's cooking module is 400 lines and only lexical (not protected),
// so it is the one the line budget decides.
// ---------------------------------------------------------------------------

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildCompileVolume } from './helpers/compile-volume.js';

process.env.TS_CLIENT_MODE = 'owner';
process.env.AVA_PERSON_PRIOR_ENABLED = 'false';

const SM = await import( '../tools/skill-modular.js' );

let vol = null;
afterEach( () => { if ( vol ) vol.cleanup(); vol = null; } );

const QUERY = { query: 'garden and cooking', session_id: 'lane-1' };

/** One real compile against a fresh volume with this budget. */
async function compile( budget ) {
  if ( vol ) vol.cleanup();
  vol = buildCompileVolume( budget );
  const r = await SM.handleSkillCompile( QUERY );
  vol.cleanup();
  vol = null;
  return { text: r.content[ 0 ].text, body: JSON.parse( r.content[ 0 ].text ) };
}

/** The compile itself: what was selected and what was sent. */
const selectionHash = ( b ) => createHash( 'sha256' ).update( JSON.stringify( {
  content: b.content, modules_loaded: b.modules_loaded, line_count: b.line_count, specialist_count: b.specialist_count,
  demoted: b.occupancy.truncation.demoted,
} ) ).digest( 'hex' );

describe( 'TENAX-2026-10-24-02 frame lane (compile)', () => {
  test( 'C-FLANE-NO-COMPILE-DELTA: the ceiling raised by exactly the lane compiles byte-identically', async () => {
    // A budget that binds: 100 specialist lines, so the 400-line module is
    // demoted. Were the lane's 350 lines handed to the compile, the allowance
    // would be 450 and the module (407 lines with the others) would load.
    const tight = await compile( { max_compiled_lines: 350, core_reserve_lines: 250 } );
    const tightLane = await compile( { max_compiled_lines: 700, core_reserve_lines: 250, frame_lane_lines: 350 } );
    assert.deepEqual( tight.body.occupancy.truncation.demoted, [ 'cooking' ], 'the fixture budget binds' );
    assert.equal( selectionHash( tightLane.body ), selectionHash( tight.body ),
      'the 350 raised lines are the lane\'s: no compiled module takes them' );
    assert.equal( tightLane.body.content, tight.body.content );
    // The order's own figures: 900 / 250 and 1,250 / 250 / 350.
    const live = await compile( { max_compiled_lines: 900, core_reserve_lines: 250 } );
    const liveLane = await compile( { max_compiled_lines: 1250, core_reserve_lines: 250, frame_lane_lines: 350 } );
    assert.equal( selectionHash( liveLane.body ), selectionHash( live.body ) );
    assert.deepEqual( liveLane.body.occupancy.line_budget,
      { max_lines: 1250, core_reserve_lines: 250, frame_lane_lines: 350, specialist_lines: 650, lines_returned: live.body.line_count },
      'the allowance is reported beside the ceiling, so 1,250 is not read as the compile\'s allowance' );
  } );

  test( 'C-FLANE-ZERO-DISABLES: lane absent, null or 0 gives the pre-lane response byte for byte', async () => {
    // 200 / 250: a ceiling below the core reserve; a lane of 0 must not turn that into a lane problem.
    for ( const base of [ { max_compiled_lines: 300, core_reserve_lines: 250 }, { max_compiled_lines: 900, core_reserve_lines: 250 },
      { max_compiled_lines: 200, core_reserve_lines: 250 } ] ) {
      const absent = await compile( base );
      for ( const v of [ 0, null ] ) {
        const r = await compile( { ...base, frame_lane_lines: v } );
        assert.equal( r.text, absent.text, `frame_lane_lines ${ v }: byte-identical response` );
      }
      assert.deepEqual( Object.keys( absent.body.occupancy.line_budget ), [ 'max_lines', 'core_reserve_lines', 'lines_returned' ],
        'no lane, no new keys' );
    }
    assert.deepEqual( SM.resolveLineBudget( {} ), { maxLines: 750, coreLines: 250, frameLaneLines: 0, specialistLines: 500, problem: null },
      'no lane is shipped as a default' );
  } );

  test( 'C-FLANE-CEILING-FLOOR: a lane the ceiling cannot hold, or a malformed one, is not applied and is named', async () => {
    const base = { max_compiled_lines: 300, core_reserve_lines: 250 };
    const none = await compile( base );
    const over = await compile( { ...base, frame_lane_lines: 350 } );
    assert.equal( selectionHash( over.body ), selectionHash( none.body ), 'the compile is as if no lane were set: never shrunk or emptied' );
    assert.match( over.body.occupancy.line_budget.frame_lane_problem, /does not fit: max_compiled_lines 300 less core_reserve_lines 250 leaves 50/ );
    assert.match( over.body.occupancy.line_budget.frame_lane_problem, /raise max_compiled_lines to at least 600/ );
    assert.ok( over.body.occupancy.truncation.markers.some( ( m ) => /frame_lane_lines 350 does not fit/.test( m ) ) );
    for ( const bad of [ -1, 3.5, '350', true, {} ] ) {
      const r = await compile( { max_compiled_lines: 900, core_reserve_lines: 250, frame_lane_lines: bad } );
      assert.match( r.body.occupancy.line_budget.frame_lane_problem, /must be a whole number of lines/, JSON.stringify( bad ) );
      assert.equal( r.body.occupancy.line_budget.frame_lane_lines, undefined );
    }
    // The edge: a lane that leaves an allowance of exactly 0 fits.
    assert.equal( SM.resolveLineBudget( { max_compiled_lines: 600, core_reserve_lines: 250, frame_lane_lines: 350 } ).problem, null );
    assert.match( SM.resolveLineBudget( { max_compiled_lines: 599, core_reserve_lines: 250, frame_lane_lines: 350 } ).problem, /does not fit/ );
  } );

  test( 'the lane is subtracted from the allowance, not from the core reserve', () => {
    const r = SM.resolveLineBudget( { max_compiled_lines: 1250, core_reserve_lines: 250, frame_lane_lines: 350 } );
    assert.deepEqual( r, { maxLines: 1250, coreLines: 250, frameLaneLines: 350, specialistLines: 650, problem: null } );
    // max and core keep their existing `|| default` reading.
    assert.equal( SM.resolveLineBudget( { max_compiled_lines: 0, core_reserve_lines: 0 } ).specialistLines, 500 );
  } );
} );
