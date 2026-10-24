#!/usr/bin/env node
/**
 * scripts/verify-wo-iso-276-001-mutations.mjs   (claude-connector v13.41.0)
 *
 * The named mutations of WO-ISO-276-001 rev 1 A3, connector half (every
 * tenant-mode memory call names the account it acts for), run through
 * scripts/mutation-verifier.mjs: for each, the claim's probe passes on this
 * tree with at least one test executed, the mutation is applied to a scratch
 * copy (each patched text occurring exactly once), and the same probe must
 * then FAIL.
 *
 * Each mutation re-creates a way the connector could fail to name the right
 * account: not sending it, sending without one, replacing a malformed id with
 * a different identity, a process-wide "current user", and a tool call that
 * runs outside its own scope.
 *
 *   npm run wo-iso-276-001:mutations
 *   npm run wo-iso-276-001:mutations -- C-CONN-USER-CONCURRENT
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMutations } from './mutation-verifier.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

const T = 'src/tests/memory-user-forwarding.test.js';
const CTX = 'src/utils/callContext.js';
const WPM = 'src/tools-memory/wp-memory.js';
const SERVER = 'src/server-http.js';
const EXPORT = 'src/utils/skillExport.js';
const T_EXPORT = 'src/tests/skill-export-client.test.js';

const MUTATIONS = [
  { claim: 'C-CONN-USER', name: 'the resolved account never put on the request', test: T, pattern: 'forwards the per-call user_id',
    edits: [ { file: WPM, find: '    body.user_id = who.userId;\n', replace: '' } ] },
  { claim: 'C-CONN-USER', name: 'TS_CLIENT_USER_ID never read', test: T, pattern: 'TS_CLIENT_USER_ID names the account',
    edits: [ { file: CTX, find: '  const configured = env.TS_CLIENT_USER_ID;', replace: '  const configured = undefined; void env;' } ] },
  { claim: 'C-CONN-USER', name: 'the configured account preferred over the caller', test: T, pattern: 'the per-call user wins',
    edits: [ { file: CTX, find: "  const hasUser = ctx && ctx.userId !== null && ctx.userId !== undefined && ctx.userId !== '';",
      replace: "  const hasUser = ! env.TS_CLIENT_USER_ID && ctx && ctx.userId !== null && ctx.userId !== undefined && ctx.userId !== '';" } ] },
  { claim: 'C-CONN-USER-REFUSE', name: 'a request with no account sent anyway', test: T, pattern: 'C-CONN-USER-REFUSE',
    edits: [ { file: WPM, find: '    if (!who.ok) {\n      throw new ToolError(\n        \'TENANT_USER_REQUIRED\',', replace: '    if (false) {\n      throw new ToolError(\n        \'TENANT_USER_REQUIRED\',' } ] },
  { claim: 'C-CONN-USER-MALFORMED', name: 'a malformed per-call id skipped in favour of the configured one', test: T, pattern: 'C-CONN-USER-MALFORMED',
    edits: [ { file: CTX, find: "  const hasUser = ctx && ctx.userId !== null && ctx.userId !== undefined && ctx.userId !== '';",
      replace: '  const hasUser = ctx && positiveUserId( ctx.userId ) !== null;' } ] },
  { claim: 'C-CONN-USER-GATEWAY-NO-USER', name: 'a gateway call with no user completed with TS_CLIENT_USER_ID', test: T, pattern: 'C-CONN-USER-GATEWAY-NO-USER',
    edits: [ { file: CTX, find: '  if ( ctx && ctx.tenantId ) {\n', replace: '  if ( false ) {\n' } ] },
  { claim: 'C-CONN-USER-CONCURRENT', name: 'a process-wide current user in place of AsyncLocalStorage', test: T, pattern: 'C-CONN-USER-CONCURRENT',
    edits: [
      { file: CTX, find: 'export function runWithCallContext( context, fn ) {\n  return store.run( normalise( context ), fn );\n}',
        replace: 'let processWide = null;\nexport function runWithCallContext( context, fn ) {\n  processWide = normalise( context );\n  return fn();\n}' },
      { file: CTX, find: '  return store.getStore() || null;', replace: '  void store; return processWide;' },
    ] },
  { claim: 'C-EXPORT-CLIENT', name: 'a tenant-mode connector exports the owner directory only (the 13.40.0 export)', test: T_EXPORT, pattern: 'tenant mode: `files` unchanged',
    edits: [ { file: EXPORT, find: '  if ( t && t.isTenantMode && t.tenantId && t.clientDir && existsSync( t.clientDir ) ) {', replace: '  if ( false ) {' } ] },
  { claim: 'C-EXPORT-CLIENT', name: 'the route hands the owner directory as the client directory', test: T_EXPORT, pattern: 'the route builds its body',
    edits: [ { file: SERVER, find: 'clientDir: mp.avaDir.replace(/\\/+$/, "") },', replace: 'clientDir: avaDir },' } ] },
  { claim: 'C-CONN-DISPATCH-SCOPE', name: 'a tool call dispatched outside its own context scope', test: T, pattern: 'C-CONN-DISPATCH-SCOPE',
    edits: [ { file: SERVER, find: '  const result = await runWithCallContext(context, () => dispatchToolCallCore(name, args, context));',
      replace: '  const result = await dispatchToolCallCore(name, args, context);' } ] },
];

const only = process.argv[ 2 ] || null;
const code = verifyMutations( {
  root:          ROOT,
  mutations:     MUTATIONS,
  defaultTest:   T,
  scratchPrefix: 'wo-iso-276-001-mutations-',
  only,
} );
const claims = new Set( MUTATIONS.map( ( m ) => m.claim ) );
console.log( `${ MUTATIONS.length } named mutations over ${ claims.size } claims (WO-ISO-276-001 rev 1 A3, connector half; C-EXPORT-CLIENT for TENAX-2026-10-23-01).` );
process.exit( code );
