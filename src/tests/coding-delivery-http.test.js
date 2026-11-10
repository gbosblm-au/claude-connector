// src/tests/coding-delivery-http.test.js   (claude-connector v13.38.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-10-02 C-LINK-APPEARS, through the REAL server: src/server-http.js
// is spawned twice on free ports, once without TENAX_FRAME_READ_TOKEN and once
// with it, and asked for its tool manifest (GET /tools) and to run the tool
// (POST /tool-call), as the Gateway Service asks.
//
//   without the token  coding_deliverable_publish is not advertised, and a call
//                      that names it anyway is refused frame_not_configured
//                      with no link: nothing is fabricated;
//   with the token     it is advertised, and a call reaches the frame: here a
//                      fake frame that reads the credential as an OPERATOR,
//                      so the call is refused frame_credential_overprivileged
//                      and nothing but GET /v1/credential is asked of it.
//
// v13.37.0 pinned the advertisement by matching the source text of the TOOLS
// array (src/tests/coding-delivery.test.js, kept); this drives what the server
// actually serves.
//
// WRITES: temporary upload, bundle and downloads directories under
// os.tmpdir(), removed in after().
// ---------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const RESTORE = 'coding-delivery-http-restore-token-0123456789';
const READ_TOKEN = 'reader-token-for-the-http-test-0123456789';
const TREE = 'a'.repeat( 64 );

const dirs = [];
const procs = [];
const frameAsked = [];

/** A fake frame that reads every credential as an operator. */
const frame = http.createServer( ( req, res ) => {
  frameAsked.push( req.url );
  if ( req.url === '/v1/credential' ) {
    res.writeHead( 200, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( { role: 'operator', credential_id: 'cred:000000000000', writes: [ 'artefact.write', 'run.start' ], service: 'tenax-frame', version: '1.9.0' } ) );
    return;
  }
  res.writeHead( 500, { 'Content-Type': 'application/json' } );
  res.end( '{"error":"the test frame answers nothing else"}' );
} );

function freePort() {
  return new Promise( ( resolve, reject ) => {
    const s = createServer();
    s.listen( 0, '127.0.0.1', () => { const { port } = s.address(); s.close( () => resolve( port ) ); } );
    s.on( 'error', reject );
  } );
}

/** Start src/server-http.js with these frame variables; resolve its base URL. */
async function startServer( frameEnv ) {
  const port = await freePort();
  const tmp = mkdtempSync( join( tmpdir(), 'coding-delivery-http-' ) );
  dirs.push( tmp );
  const env = { ...process.env };
  delete env.TENAX_FRAME_URL;
  delete env.TENAX_FRAME_READ_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  Object.assign( env, {
    PORT: String( port ), HOST: '127.0.0.1', SELF_MODEL_ENABLED: 'false', UPLOAD_SWEEP_ENABLED: 'false',
    MCP_API_KEY: 'coding-delivery-http-mcp-key-0123456789', RAILWAY_RESTORE_TOKEN: RESTORE,
    USER_DATA_UPLOAD_DIR: join( tmp, 'uploads' ), BUNDLE_DIR: join( tmp, 'bundles' ), DOWNLOADS_DIR: join( tmp, 'downloads' ),
    ...frameEnv,
  } );
  const proc = spawn( process.execPath, [ join( ROOT, 'src', 'server-http.js' ) ], { cwd: ROOT, env, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
  procs.push( proc );
  let out = '';
  await new Promise( ( resolve, reject ) => {
    const timer = setTimeout( () => reject( new Error( `server did not start:\n${ out.slice( -2000 ) }` ) ), 30000 );
    const onData = ( d ) => {
      out += d.toString();
      if ( /listening on|on http:\/\//.test( out ) ) { clearTimeout( timer ); resolve(); }
    };
    proc.stdout.on( 'data', onData );
    proc.stderr.on( 'data', onData );
    proc.on( 'exit', ( code ) => { clearTimeout( timer ); reject( new Error( `server exited ${ code }:\n${ out.slice( -2000 ) }` ) ); } );
  } );
  return { base: `http://127.0.0.1:${ port }`, downloads: join( tmp, 'downloads' ) };
}

async function toolNames( base ) {
  const r = await fetch( `${ base }/tools`, { headers: { 'X-Railway-Restore-Token': RESTORE } } );
  assert.equal( r.status, 200 );
  const body = await r.json();
  return body.tools.map( ( t ) => t.name );
}

async function callTool( base ) {
  const r = await fetch( `${ base }/tool-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Railway-Restore-Token': RESTORE },
    body: JSON.stringify( { tool_name: 'coding_deliverable_publish', tool_input: { tree_hash: TREE, filename: `widget-d1-${ TREE.slice( 0, 12 ) }.zip` } } ),
  } );
  return { status: r.status, body: await r.json() };
}

let unconfigured;
let configured;

before( async () => {
  await new Promise( ( r ) => frame.listen( 0, '127.0.0.1', r ) );
  unconfigured = await startServer( {} );
  configured = await startServer( { TENAX_FRAME_URL: `http://127.0.0.1:${ frame.address().port }`, TENAX_FRAME_READ_TOKEN: READ_TOKEN } );
} );

after( () => {
  for ( const p of procs ) { p.removeAllListeners( 'exit' ); p.kill( 'SIGTERM' ); }
  frame.close();
  for ( const d of dirs ) rmSync( d, { recursive: true, force: true } );
} );

test( 'C-LINK-APPEARS without TENAX_FRAME_READ_TOKEN the tool is not advertised, and a call fabricates no link', async () => {
  // MUTATION: advertise the tool unconditionally in server-http TOOLS. Reddens.
  const names = await toolNames( unconfigured.base );
  assert.ok( names.length > 0, 'the manifest lists other tools' );
  assert.ok( ! names.includes( 'coding_deliverable_publish' ), 'advertised with no frame credential' );
  const r = await callTool( unconfigured.base );
  assert.equal( r.status, 200 );
  assert.equal( r.body.is_error, true );
  const result = JSON.parse( r.body.result );
  assert.equal( result.error_kind, 'frame_not_configured' );
  assert.equal( result.download_url, undefined, 'no link is fabricated' );
  assert.ok( ! /\/download\//.test( r.body.result ), 'no download path in the answer' );
} );

test( 'C-LINK-APPEARS with the token the tool is advertised, and a credential the frame reads as an operator fetches nothing', async () => {
  const names = await toolNames( configured.base );
  assert.ok( names.includes( 'coding_deliverable_publish' ), 'not advertised with the frame configured' );
  frameAsked.length = 0;
  const r = await callTool( configured.base );
  assert.equal( r.body.is_error, true );
  const result = JSON.parse( r.body.result );
  assert.equal( result.error_kind, 'frame_credential_overprivileged' );
  assert.equal( result.frame_role, 'operator' );
  assert.deepEqual( frameAsked, [ '/v1/credential' ], 'nothing but the credential was asked of the frame' );
  assert.ok( ! r.body.result.includes( READ_TOKEN ), 'the token is never echoed' );
  let written = [];
  try { written = readdirSync( configured.downloads ); } catch { written = []; }
  assert.deepEqual( written, [], 'nothing was written to downloads' );
} );
