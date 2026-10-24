// src/tests/memory-user-forwarding.test.js  (claude-connector v13.41.0)
// ---------------------------------------------------------------------------
// Gateway WO-ISO-276-001 A3, the connector half: every tenant-mode memory call
// names the account it acts for, and a call that cannot name one is refused
// here, before anything is sent. A stub gateway records every request body.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank } from './helpers/source-scan.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const { runWithCallContext, resolveMemoryUserId, positiveUserId } = await import( '../utils/callContext.js' );
const { handleWpMemoryRead, handleWpMemoryList, handleWpMemorySearch } = await import( '../tools-memory/wp-memory.js' );

const calls = [];
let server;

before( async () => {
  server = createServer( ( req, res ) => {
    let body = '';
    req.on( 'data', ( c ) => { body += c; } );
    req.on( 'end', () => {
      const path = req.url.split( '?' )[ 0 ].replace( /^\/memory/, '' );
      calls.push( { path, body: body ? JSON.parse( body ) : null } );
      const replies = {
        '/read': { entries: [], count: 0 },
        '/list': { entries: [], total: 0, by_category: {} },
        '/search': { entries: [], count: 0, query: 'x' },
      };
      res.writeHead( replies[ path ] ? 200 : 404, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( replies[ path ] || {} ) );
    } );
  } );
  await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
  process.env.TS_CLIENT_MODE = 'tenant';
  process.env.TS_TENANT_GATEWAY_URL = `http://127.0.0.1:${ server.address().port }`;
  process.env.TS_CLIENT_API_KEY = 'test-key-not-a-secret';
} );

after( async () => {
  await new Promise( ( r ) => server.close( r ) );
  delete process.env.TS_CLIENT_MODE;
  delete process.env.TS_TENANT_GATEWAY_URL;
  delete process.env.TS_CLIENT_API_KEY;
  delete process.env.TS_CLIENT_USER_ID;
} );

beforeEach( () => {
  calls.length = 0;
  delete process.env.TS_CLIENT_USER_ID;
} );

async function rejects( p, code ) {
  try { await p; } catch ( err ) { assert.equal( err.code, code, err.message ); return err; }
  assert.fail( `expected a ${ code } refusal` );
}

describe( 'C-CONN-USER: the account a tenant memory call names', () => {
  test( 'a gateway-proxied call forwards the per-call user_id', async () => {
    await runWithCallContext( { tenant_id: 't1', user_id: 41 }, () => handleWpMemoryRead( { category: 'facts' } ) );
    assert.equal( calls.length, 1 );
    assert.equal( calls[ 0 ].body.user_id, 41 );
  } );

  test( 'with no per-call user, TS_CLIENT_USER_ID names the account', async () => {
    process.env.TS_CLIENT_USER_ID = '9';
    await handleWpMemoryList( {} );
    assert.equal( calls[ 0 ].body.user_id, 9 );
  } );

  test( 'the per-call user wins over TS_CLIENT_USER_ID', async () => {
    process.env.TS_CLIENT_USER_ID = '9';
    await runWithCallContext( { user_id: '12' }, () => handleWpMemoryList( {} ) );
    assert.equal( calls[ 0 ].body.user_id, 12 );
  } );

  test( 'C-CONN-USER-REFUSE: no account at all is refused before anything is sent', async () => {
    const err = await rejects( handleWpMemorySearch( { query: 'garden' } ), 'TENANT_USER_REQUIRED' );
    assert.match( err.message, /TS_CLIENT_USER_ID/ );
    assert.equal( calls.length, 0, 'nothing reached the gateway' );
  } );

  test( 'C-CONN-USER-MALFORMED: a malformed per-call id is refused, never replaced by the configured one', async () => {
    process.env.TS_CLIENT_USER_ID = '9';
    await rejects( runWithCallContext( { user_id: 'abc' }, () => handleWpMemoryList( {} ) ), 'TENANT_USER_REQUIRED' );
    assert.equal( calls.length, 0 );
  } );

  test( 'C-CONN-USER-GATEWAY-NO-USER: a gateway call naming a tenant and no user is refused, never given TS_CLIENT_USER_ID', async () => {
    process.env.TS_CLIENT_USER_ID = '9';
    await rejects( runWithCallContext( { tenant_id: 't1', user_id: null }, () => handleWpMemoryList( {} ) ), 'TENANT_USER_REQUIRED' );
    assert.equal( calls.length, 0 );
    // A direct call (no gateway context) still uses the configured account.
    await runWithCallContext( undefined, () => handleWpMemoryList( {} ) );
    assert.equal( calls[ 0 ].body.user_id, 9 );
  } );

  test( 'a malformed TS_CLIENT_USER_ID is refused', async () => {
    process.env.TS_CLIENT_USER_ID = '7x';
    await rejects( handleWpMemoryList( {} ), 'TENANT_USER_REQUIRED' );
    assert.equal( calls.length, 0 );
  } );

  test( 'C-CONN-USER-CONCURRENT: two calls in flight at once each name their own account', async () => {
    // Each call yields before it reaches the gateway client, as a real tool
    // call does (dispatchToolCallCore awaits before the handler runs), and the
    // first-started finishes last: a process-wide "current user" would hand
    // both calls the second caller's account.
    const later = ( ms, fn ) => async () => { await new Promise( ( r ) => setTimeout( r, ms ) ); return fn(); };
    await Promise.all( [
      runWithCallContext( { user_id: 101 }, later( 30, () => handleWpMemoryRead( { category: 'facts' } ) ) ),
      runWithCallContext( { user_id: 202 }, later( 5, () => handleWpMemoryRead( { category: 'projects' } ) ) ),
    ] );
    const ids = calls.map( ( c ) => c.body.user_id ).sort( ( x, y ) => x - y );
    assert.deepEqual( ids, [ 101, 202 ] );
  } );
} );

describe( 'C-CONN-USER-SHAPE: what counts as an account id', () => {
  test( 'positive whole numbers only', () => {
    assert.equal( positiveUserId( 5 ), 5 );
    assert.equal( positiveUserId( ' 6 ' ), 6 );
    for ( const bad of [ 0, -1, 1.5, '1e0', '7x', '', null, true, [ 1 ] ] ) assert.equal( positiveUserId( bad ), null, JSON.stringify( bad ) );
  } );

  test( 'outside any call scope with nothing configured, resolution refuses', () => {
    const r = resolveMemoryUserId( {} );
    assert.equal( r.ok, false );
  } );
} );

describe( 'C-CONN-DISPATCH-SCOPE: every tool call runs inside its own context scope', () => {
  test( 'dispatchToolCall runs dispatchToolCallCore through runWithCallContext with the caller\'s context', () => {
    const src = blank( readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' ) );
    const start = src.indexOf( 'async function dispatchToolCall(' );
    assert.ok( start !== -1 );
    const body = src.slice( start, src.indexOf( 'async function dispatchToolCallCore(' ) );
    assert.match( body, /runWithCallContext\(\s*context\s*,\s*\(\)\s*=>\s*dispatchToolCallCore\(\s*name\s*,\s*args\s*,\s*context\s*\)\s*\)/ );
  } );
} );
