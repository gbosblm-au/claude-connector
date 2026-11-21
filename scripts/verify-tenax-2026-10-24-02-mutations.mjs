#!/usr/bin/env node
/**
 * scripts/verify-tenax-2026-10-24-02-mutations.mjs   (claude-connector v13.42.0)
 *
 * The named mutations of TENAX-2026-10-24-02 (the frame lane), connector
 * half: the compile holds MANIFEST.json budget.frame_lane_lines back from its
 * specialist allowance. Run through scripts/mutation-verifier.mjs: for each,
 * the claim's probe passes on this tree with at least one test executed, the
 * mutation is applied to a scratch copy (each patched text occurring exactly
 * once), and the same probe must then FAIL.
 *
 * The gateway half (the draw charged to the lane, the over-lane exclusion,
 * the refusals, the measurement) is Gateway 2.279.0
 * scripts/verify-module-draw-mutations.mjs.
 *
 *   npm run tenax-2026-10-24-02:mutations
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMutations } from './mutation-verifier.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

const T = 'src/tests/frame-lane.test.js';
const SM = 'src/tools/skill-modular.js';

const MUTATIONS = [
  { claim: 'C-FLANE-NO-COMPILE-DELTA', name: 'the lane injected into the compile\'s allowance: the raised ceiling\'s lines handed to compiled modules', test: T, pattern: 'C-FLANE-NO-COMPILE-DELTA',
    edits: [ { file: SM, find: '  const specialistBudget = resolveLineBudget(budget).specialistLines;',
      replace: '  const specialistBudget = resolveLineBudget(budget).specialistLines + resolveLineBudget(budget).frameLaneLines;' } ] },
  { claim: 'C-FLANE-ZERO-DISABLES', name: 'a 350-line lane shipped as the default', test: T, pattern: 'C-FLANE-ZERO-DISABLES',
    edits: [ { file: SM, find: '  let lane = 0;\n  let problem = null;', replace: '  let lane = 350;\n  let problem = null;' } ] },
  { claim: 'C-FLANE-ZERO-DISABLES', name: 'a lane of 0 judged against the ceiling (a problem named where no lane was set)', test: T, pattern: 'C-FLANE-ZERO-DISABLES',
    edits: [ { file: SM, find: '  if (raw !== undefined && raw !== null && raw !== 0) {', replace: '  if (raw !== undefined && raw !== null) {' } ] },
  { claim: 'C-FLANE-CEILING-FLOOR', name: 'a lane the ceiling cannot hold applied anyway', test: T, pattern: 'C-FLANE-CEILING-FLOOR',
    edits: [ { file: SM, find: '    } else if (maxLines - coreLines - raw < 0) {', replace: '    } else if (false) {' } ] },
  { claim: 'C-FLANE-CEILING-FLOOR', name: 'a malformed lane applied', test: T, pattern: 'C-FLANE-CEILING-FLOOR',
    edits: [ { file: SM, find: '    if (!Number.isInteger(raw) || raw < 0) {', replace: '    if (false) {' } ] },
];

const only = process.argv[ 2 ] || null;
const code = verifyMutations( {
  root:          ROOT,
  mutations:     MUTATIONS,
  defaultTest:   T,
  scratchPrefix: 'tenax-2026-10-24-02-mutations-',
  only,
  nodeArgs:      [ '--experimental-test-module-mocks' ],
} );
const claims = new Set( MUTATIONS.map( ( m ) => m.claim ) );
console.log( `${ claims.size } claims carry named mutations (the compile half of TENAX-2026-10-24-02).` );
process.exit( code );
