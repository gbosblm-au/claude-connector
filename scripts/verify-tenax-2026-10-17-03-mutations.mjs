#!/usr/bin/env node
/**
 * scripts/verify-tenax-2026-10-17-03-mutations.mjs   (claude-connector v13.40.0)
 *
 * The named mutations of TENAX-2026-10-17-03 (the memory ceiling as a runtime
 * value), connector half, run through scripts/mutation-verifier.mjs: for each,
 * the claim's probe passes on this tree with at least one test executed, the
 * mutation is applied to a scratch copy (each patched text occurring exactly
 * once), and the same probe must then FAIL.
 *
 *   npm run tenax-2026-10-17-03:mutations
 *   npm run tenax-2026-10-17-03:mutations -- C-VAR-READS
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMutations } from './mutation-verifier.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

const T = 'src/tests/memory-capacity.test.js';
const T_TWIN = 'src/tests/memory-write-guard.test.js';
const GUARD = 'src/tools-memory/memoryWriteGuard.js';
const MW = 'src/tools-memory/memory-write.js';
const WPM = 'src/tools-memory/wp-memory.js';
const SERVER = 'src/server-http.js';
const FIXTURE = 'src/tests/fixtures/memory-guard-fixture.json';

const MUTATIONS = [
  { claim: 'C-VAR-DEFAULT', name: 'the default changed to 1001', test: T, pattern: 'C-VAR-DEFAULT',
    edits: [ { file: GUARD, find: 'export const MEMORY_CAPACITY_DEFAULT = 1000;', replace: 'export const MEMORY_CAPACITY_DEFAULT = 1001;' } ] },
  { claim: 'C-VAR-READS', name: 'the exported ceiling is the constant, not the variable', test: T, pattern: 'C-VAR-READS',
    edits: [ { file: GUARD, find: 'export const MEMORY_CAPACITY_PER_SCOPE = MEMORY_CAPACITY.limit;', replace: 'export const MEMORY_CAPACITY_PER_SCOPE = MEMORY_CAPACITY_DEFAULT;' } ] },
  { claim: 'C-VAR-READS', name: 'the SQLite path reads a fixed ceiling (one surface only)', test: T, pattern: 'C-VAR-READS on the SQLite store',
    edits: [ { file: MW, find: '    scopeRows,\n    recheckClass: args.recheck_class ?? null,', replace: '    scopeRows,\n    limit: 1000,\n    recheckClass: args.recheck_class ?? null,' } ] },
  { claim: 'C-VAR-READS', name: 'the tenant path reads a fixed ceiling (one surface only)', test: T, pattern: 'C-VAR-READS on the WordPress',
    edits: [ { file: WPM, find: '    scopeRows,\n    scopeCount,', replace: '    scopeRows,\n    scopeCount,\n    limit: 1000,' } ] },
  { claim: 'C-VAR-STRICT', name: 'parseInt instead of the strict parse', test: T, pattern: 'C-VAR-STRICT',
    edits: [ { file: GUARD, find: '  const n = DECIMAL_NUMBER.test( raw ) ? Number( raw ) : NaN;', replace: '  const n = parseInt( raw, 10 );' } ] },
  { claim: 'C-VAR-BOUNDS', name: 'the minimum clamp removed', test: T, pattern: 'C-VAR-BOUNDS',
    edits: [ { file: GUARD, find: '  if ( n < MEMORY_CAPACITY_MIN ) {', replace: '  if ( false ) {' } ] },
  { claim: 'C-VAR-TWIN', name: 'the shared file edited in this tree only', test: T_TWIN, pattern: 'the guard and the fixture are the pinned bytes',
    edits: [ { file: GUARD, find: '/** The ceiling when the variable is unset or unusable. */', replace: '/** The ceiling when the variable is unset or unusable (edited here only). */' } ] },
  { claim: 'C-VAR-TWIN', name: 'the shared fixture edited in this tree only', test: T_TWIN, pattern: 'the guard and the fixture are the pinned bytes',
    edits: [ { file: FIXTURE, find: '{ "id": "hex", "value": "0x3e8",', replace: '{ "id": "hex",  "value": "0x3e8",' } ] },
  { claim: 'C-REFUSAL-NAMES-VAR', name: 'the variable dropped from the reason', test: T, pattern: 'C-REFUSAL-NAMES-VAR',
    edits: [ { file: GUARD, find: ' The ceiling (${ limit }, ${ LIMIT_SOURCE_WORDS[ limitSource ] || limitSource }) is the ${ MEMORY_CAPACITY_ENV } variable, which must hold the same value on the gateway and the connector and takes a restart.`,', replace: '`,' } ] },
  { claim: 'C-HEALTH-REPORTS', name: '/health reports the constant', test: T, pattern: 'C-HEALTH-REPORTS',
    edits: [ { file: SERVER, find: '      capacity_per_scope: MEMORY_CAPACITY.limit,', replace: '      capacity_per_scope: 1000,' } ] },
  { claim: 'C-HEALTH-REPORTS', name: 'the boot line reports the constant', test: T, pattern: 'C-HEALTH-REPORTS',
    edits: [ { file: SERVER, find: '  log(MEMORY_CAPACITY.warning ? "warn" : "info", describeMemoryCapacity(MEMORY_CAPACITY));', replace: '  log(MEMORY_CAPACITY.warning ? "warn" : "info", describeMemoryCapacity({ limit: 1000, raw: null, warning: null }));' } ] },
  { claim: 'C-TEST-INDEPENDENT', name: 'the test follows the environment (50000) instead of its own limit', test: T, pattern: 'C-VAR-READS',
    edits: [ { file: T, find: 'process.env.MEMORY_CAPACITY_PER_SCOPE = String( CAP );', replace: "process.env.MEMORY_CAPACITY_PER_SCOPE = '50000';" } ] },
];

process.exit( verifyMutations( {
  root: ROOT, mutations: MUTATIONS, defaultTest: T, scratchPrefix: 'cc-tenax-1017-03-mut-', only: process.argv[ 2 ] || null,
  nodeArgs: [ '--experimental-test-module-mocks' ],
} ) );
