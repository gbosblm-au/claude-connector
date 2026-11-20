/**
 * scripts/mutation-verifier.mjs   (claude-connector v13.39.0)
 *
 * The named-mutation verifier. Copied from Gateway Service
 * scripts/mutation-verifier.mjs (v2.255.0, itself extracted from
 * scripts/verify-dual-lane-mutations.mjs) so the connector proves its claims
 * the same way the gateway does rather than with a second design. Two
 * adaptations, both for this tree:
 *
 *   - nodeArgs: extra node flags for each probe. The connector's suite runs
 *     every test file with --experimental-test-module-mocks, so probes do too.
 *   - the scratch copy leaves out data/google-service-account.json, a
 *     credential no probe reads, so it is never copied to a temp directory.
 *
 * "Every claim ships green; every named mutation must be demonstrated red at
 * least once." For each named mutation:
 *
 *   1. run the claim's probe against the UNMUTATED code and require it to
 *      pass with at least one test executed (a pattern that matched nothing
 *      would "pass" both ways and prove nothing);
 *   2. apply the mutation to a scratch copy of the tree (never to the
 *      working tree), requiring each patched text to occur EXACTLY once;
 *   3. run the same probe and require it to FAIL;
 *   4. restore the file.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run one test file filtered to one probe.
 *
 * @param {string} dir
 * @param {string} file     Test file, relative to dir.
 * @param {string} pattern  --test-name-pattern value.
 * @param {string[]} [nodeArgs]  Extra node flags.
 * @returns {{ code: number, tests: number, pass: number, fail: number }}
 */
export function runProbe( dir, file, pattern, nodeArgs = [] ) {
  const r = spawnSync( process.execPath, [ ...nodeArgs, '--test', `--test-name-pattern=${ pattern }`, file ], {
    cwd: dir, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, NODE_ENV: 'test' },
  } );
  const out = `${ r.stdout || '' }`;
  const num = ( label ) => { const m = new RegExp( `^# ${ label } (\\d+)$`, 'm' ).exec( out ); return m ? Number( m[ 1 ] ) : 0; };
  return { code: r.status === null ? -1 : r.status, tests: num( 'tests' ), pass: num( 'pass' ), fail: num( 'fail' ) };
}

/**
 * Patch text, requiring the find to occur exactly once. CRLF files are
 * matched with their own line endings.
 *
 * @param {string} text
 * @param {{find: string, replace: string}} edit
 * @returns {string}
 */
export function patch( text, edit ) {
  const crlf = text.includes( '\r\n' );
  const find = crlf ? edit.find.replace( /\n/g, '\r\n' ) : edit.find;
  const replace = crlf ? edit.replace.replace( /\n/g, '\r\n' ) : edit.replace;
  const count = text.split( find ).length - 1;
  if ( count !== 1 ) throw new Error( `mutation text occurs ${ count } times, expected exactly 1: ${ edit.find.slice( 0, 70 ) }` );
  return text.replace( find, () => replace );
}

/**
 * Verify a set of named mutations against a scratch copy of `root`.
 *
 * @param {object} o
 * @param {string} o.root            The gateway tree.
 * @param {Array<{claim: string, name: string, pattern: string, test?: string, edits: Array<{file: string, find: string, replace: string}>}>} o.mutations
 * @param {string} o.defaultTest     Test file for mutations that name none.
 * @param {string} o.scratchPrefix   mkdtemp prefix.
 * @param {string|null} [o.only]     Restrict to one claim id.
 * @param {string[]} [o.nodeArgs]    Extra node flags for every probe.
 * @returns {number} Process exit code: 0 when every mutation reddened its probe and every control was green.
 */
export function verifyMutations( { root, mutations, defaultTest, scratchPrefix, only = null, nodeArgs = [] } ) {
  const list = only ? mutations.filter( ( m ) => m.claim === only ) : mutations;
  if ( ! list.length ) {
    console.error( `no mutations for "${ only }"` );
    return 2;
  }

  const scratch = mkdtempSync( join( tmpdir(), scratchPrefix ) );
  console.log( `scratch copy: ${ scratch }` );
  cpSync( root, scratch, {
    recursive: true,
    filter: ( src ) => ! /[\\/](node_modules|\.git)([\\/]|$)/.test( src.slice( root.length ) )
      && ! /[\\/]data[\\/]google-service-account\.json$/.test( src.slice( root.length ) ),
  } );
  if ( existsSync( join( root, 'node_modules' ) ) ) symlinkSync( join( root, 'node_modules' ), join( scratch, 'node_modules' ), 'dir' );

  const results = [];
  const controls = new Map();
  try {
    for ( const m of list ) {
      const file = m.test || defaultTest;
      const key = `${ file }\u0000${ m.pattern }`;
      if ( ! controls.has( key ) ) controls.set( key, runProbe( scratch, file, m.pattern, nodeArgs ) );
      const control = controls.get( key );
      const controlOk = control.code === 0 && control.tests > 0 && control.fail === 0;

      const originals = new Map();
      let mutated = null;
      let error = null;
      try {
        for ( const e of m.edits ) {
          const path = join( scratch, e.file );
          if ( ! originals.has( path ) ) originals.set( path, readFileSync( path, 'utf8' ) );
          writeFileSync( path, patch( readFileSync( path, 'utf8' ), e ) );
        }
        mutated = runProbe( scratch, file, m.pattern, nodeArgs );
      } catch ( err ) {
        error = err.message;
      } finally {
        for ( const [ path, text ] of originals ) writeFileSync( path, text );
      }

      const red = !! mutated && mutated.code !== 0 && mutated.fail > 0;
      results.push( { ...m, control, mutated, controlOk, red, error } );
      console.log( `${ controlOk && red ? 'RED  ' : 'FAIL ' } ${ m.claim.padEnd( 20 ) } ${ m.name }`
        + `  [control ${ control.pass }/${ control.tests } pass; mutated ${ mutated ? `${ mutated.fail }/${ mutated.tests } fail` : `error: ${ error }` }]` );
    }
  } finally {
    rmSync( scratch, { recursive: true, force: true } );
  }

  const bad = results.filter( ( r ) => ! ( r.controlOk && r.red ) );
  console.log( `\n${ results.length - bad.length }/${ results.length } named mutations demonstrated red, controls green.` );
  return bad.length ? 1 : 0;
}

export default { runProbe, patch, verifyMutations };
