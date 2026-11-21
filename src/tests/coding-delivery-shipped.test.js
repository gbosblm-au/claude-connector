// src/tests/coding-delivery-shipped.test.js   (claude-connector v13.43.0)
// ---------------------------------------------------------------------------
// coding_deliverable_publish with the shipped directories (tenax-frame 1.11.0,
// TENAX-2026-10-27-03 rev 2 D1, D4, decision D-1a), driven against a fake
// frame on a real socket, a real downloads directory and the real signed-link
// builder.
//
// Claims:
//   C-SHIPPED-ASKED      given `shipped`, the tool asks the frame for it, and an
//                        archive holding the listing plus every shipped file, each
//                        at its recorded size and sha256, is published with the
//                        shipped summary in the result
//   C-SHIPPED-EXACT      a shipped file missing, altered, or extra, a manifest
//                        naming another digest, and a listing without the record
//                        are each refused by name
//   C-SHIPPED-NOT-ASKED  without `shipped` the archive is the listing alone, as in
//                        13.42.0, and a shipped member in it is refused as extra
// ---------------------------------------------------------------------------

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleCodingDeliverablePublish, validatePublishInput, codingDeliverablePublishToolDefinition } from '../tools/coding-delivery.js';
import { crc32 } from '../utils/zipCentralDirectory.js';
import { resetSigningSecretCache } from '../utils/signedUrls.js';

function zip( members ) {
  const local = [];
  const central = [];
  let offset = 0;
  for ( const m of members ) {
    const name = Buffer.from( m.name, 'utf8' );
    const data = Buffer.isBuffer( m.data ) ? m.data : Buffer.from( m.data );
    const crc = crc32( data );
    const lh = Buffer.alloc( 30 );
    lh.writeUInt32LE( 0x04034b50, 0 ); lh.writeUInt16LE( 20, 4 ); lh.writeUInt16LE( 0x0800, 6 );
    lh.writeUInt32LE( crc, 14 ); lh.writeUInt32LE( data.length, 18 ); lh.writeUInt32LE( data.length, 22 ); lh.writeUInt16LE( name.length, 26 );
    const ch = Buffer.alloc( 46 );
    ch.writeUInt32LE( 0x02014b50, 0 ); ch.writeUInt16LE( 20, 4 ); ch.writeUInt16LE( 20, 6 ); ch.writeUInt16LE( 0x0800, 8 );
    ch.writeUInt32LE( crc, 16 ); ch.writeUInt32LE( data.length, 20 ); ch.writeUInt32LE( data.length, 24 );
    ch.writeUInt16LE( name.length, 28 ); ch.writeUInt32LE( offset, 42 );
    local.push( lh, name, data );
    central.push( ch, name );
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat( central );
  const end = Buffer.alloc( 22 );
  end.writeUInt32LE( 0x06054b50, 0 ); end.writeUInt16LE( members.length, 8 ); end.writeUInt16LE( members.length, 10 );
  end.writeUInt32LE( cd.length, 12 ); end.writeUInt32LE( offset, 16 );
  return Buffer.concat( [ ...local, cd, end ] );
}

const sha = ( d ) => createHash( 'sha256' ).update( d ).digest( 'hex' );
const TREE = 'a'.repeat( 64 );
const SHIPPED = 'e'.repeat( 64 );
const FILES = [ { path: 'plugin.php', data: '<?php\n' }, { path: 'src/js/app.js', data: 'export const a = 1;\n' } ];
const SHIP = [ { path: 'dist/app.js', data: 'bundle\n' }, { path: 'vendor/autoload.php', data: '<?php // autoload\n' } ];
const entry = ( f ) => ( { path: f.path, bytes: Buffer.byteLength( f.data ), sha256: sha( f.data ) } );
const SHIPPED_RECORD = { revision: 'tenax-shipped-v1', refused: null, hash: SHIPPED, entry_count: 2, total_bytes: SHIP.reduce( ( n, f ) => n + Buffer.byteLength( f.data ), 0 ),
  directories: [ { path: 'dist', entry_count: 1, bytes: 7 }, { path: 'vendor', entry_count: 1, bytes: 18 } ], entries: SHIP.map( entry ), skipped: [] };

function manifest( over = {} ) {
  return {
    schema: 'tenax-delivery-v1', generated_by: 'tenax-frame 1.11.0', tree_hash: TREE, entry_count: FILES.length,
    total_bytes: FILES.reduce( ( n, f ) => n + Buffer.byteLength( f.data ), 0 ), archive_root: 'client', predecessor_tree_hash: null,
    supersedes_archive_sha256: null, changed_files: null, excluded: [ 'node_modules' ],
    shipped: { ...SHIPPED_RECORD }, shipped_available: { ...SHIPPED_RECORD, entries: undefined }, run: null, ...over,
  };
}
const archiveOf = ( files, man ) => zip( [
  ...files.map( ( f ) => ( { name: `client/${ f.path }`, data: f.data } ) ),
  { name: 'client/.tenax/delivery.json', data: `${ JSON.stringify( man ) }\n` },
].sort( ( a, b ) => ( a.name < b.name ? -1 : 1 ) ) );

const frame = { archive: null, listing: null, requests: [] };
const server = http.createServer( ( req, res ) => {
  frame.requests.push( req.url );
  if ( req.url === '/v1/credential' ) {
    res.writeHead( 200, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( { role: 'reader', credential_id: 'cred:x', writes: [], service: 'tenax-frame', version: '1.11.0' } ) );
    return;
  }
  if ( req.url === `/v1/tree/${ TREE }` ) {
    res.writeHead( 200, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( frame.listing ) );
    return;
  }
  if ( req.url.startsWith( `/v1/artefacts/${ TREE }/archive` ) ) {
    res.writeHead( 200, { 'Content-Type': 'application/zip', 'Content-Length': String( frame.archive.length ),
      'X-Frame-Archive-Sha256': sha( frame.archive ), 'X-Frame-Tree-Hash': TREE } );
    res.end( frame.archive );
    return;
  }
  res.writeHead( 404 ); res.end();
} );

let downloads;
let env;
const INPUT = { tree_hash: TREE, filename: 'client-project-aaaaaaaaaaaa.zip', root: 'client', shipped: SHIPPED };
const out = ( r ) => ( { isError: r.isError, body: JSON.parse( r.content[ 0 ].text ) } );

before( async () => {
  await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
  downloads = mkdtempSync( join( tmpdir(), 'coding-delivery-shipped-' ) );
  process.env.DOWNLOADS_DIR = downloads;
  process.env.CONNECTOR_URL = 'https://connector.example.test';
  process.env.SIGNED_URL_SECRET = 'd'.repeat( 64 );
  resetSigningSecretCache();
  env = { TENAX_FRAME_URL: `http://127.0.0.1:${ server.address().port }`, TENAX_FRAME_READ_TOKEN: 'reader-token-0123456789' };
} );
after( () => { server.close(); rmSync( downloads, { recursive: true, force: true } ); } );
beforeEach( () => {
  frame.listing = { tree_hash: TREE, entries: FILES.map( entry ), excluded: [], shipped: SHIPPED_RECORD };
  frame.archive = archiveOf( [ ...FILES, ...SHIP ], manifest() );
  frame.requests.length = 0;
  for ( const f of readdirSync( downloads ) ) rmSync( join( downloads, f ), { force: true } );
} );

test( 'C-SHIPPED-ASKED: the archive with every shipped file is published, and the frame was asked for that digest', async () => {
  // MUTATION: check the archive against the listing alone. Reddens (the shipped members are extra).
  const { isError, body } = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( isError, false, JSON.stringify( body ) );
  assert.equal( body.content_checked, 4, 'the listed and the shipped files, each by content' );
  assert.ok( frame.requests.some( ( u ) => u.includes( `shipped=${ SHIPPED }` ) ) );
  assert.deepEqual( body.manifest.shipped, { hash: SHIPPED, entry_count: 2, total_bytes: SHIPPED_RECORD.total_bytes, directories: SHIPPED_RECORD.directories } );
  assert.deepEqual( body.manifest.excluded, [ 'node_modules' ] );
  assert.equal( body.manifest.shipped_available.hash, SHIPPED );
  assert.ok( codingDeliverablePublishToolDefinition.inputSchema.properties.shipped );
  assert.equal( validatePublishInput( { ...INPUT, shipped: 'nope' } ).ok, false );
} );

test( 'C-SHIPPED-EXACT: a shipped file missing, altered or extra, another digest, and no record are each refused by name', async () => {
  const run = async () => out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body;
  frame.archive = archiveOf( [ ...FILES, SHIP[ 0 ] ], manifest() );
  assert.equal( ( await run() ).error_kind, 'archive_incomplete', 'a shipped file missing' );
  frame.archive = archiveOf( [ ...FILES, SHIP[ 0 ], { path: SHIP[ 1 ].path, data: '<?php // AUTOLOAD\n' } ], manifest() );
  assert.equal( ( await run() ).error_kind, 'archive_content_mismatch', 'a shipped file altered at the same size' );
  frame.archive = archiveOf( [ ...FILES, ...SHIP, { path: 'dist/extra.js', data: 'x' } ], manifest() );
  assert.equal( ( await run() ).error_kind, 'archive_incomplete', 'a file neither listed nor shipped' );
  // MUTATION: drop the manifest's shipped digest check. Reddens.
  frame.archive = archiveOf( [ ...FILES, ...SHIP ], manifest( { shipped: { ...SHIPPED_RECORD, hash: 'f'.repeat( 64 ) } } ) );
  assert.equal( ( await run() ).error_kind, 'archive_manifest_mismatch' );
  frame.listing = { ...frame.listing, shipped: { ...SHIPPED_RECORD, hash: 'f'.repeat( 64 ) } };
  const replaced = await run();
  assert.equal( replaced.error_kind, 'shipped_unavailable' );
  assert.match( replaced.message, /a later upload replaced them/ );
  frame.listing = { tree_hash: TREE, entries: FILES.map( entry ), excluded: [] };
  assert.equal( ( await run() ).error_kind, 'shipped_unavailable', 'a frame or install before 1.11.0' );
  frame.listing = { tree_hash: TREE, entries: [ ...FILES.map( entry ), entry( SHIP[ 0 ] ) ], excluded: [], shipped: SHIPPED_RECORD };
  assert.equal( ( await run() ).error_kind, 'frame_error', 'a path both listed and shipped' );
  assert.equal( readdirSync( downloads ).length, 0, 'nothing was published' );
} );

test( 'C-SHIPPED-NOT-ASKED: without `shipped`, the listing alone, as in 13.42.0', async () => {
  const { shipped: _s, ...plainInput } = INPUT;
  frame.archive = archiveOf( FILES, manifest( { shipped: null, excluded: [ 'dist', 'node_modules', 'vendor' ] } ) );
  const ok = out( await handleCodingDeliverablePublish( plainInput, { env } ) );
  assert.equal( ok.isError, false, JSON.stringify( ok.body ) );
  assert.equal( ok.body.manifest.shipped, null );
  assert.deepEqual( ok.body.manifest.excluded, [ 'dist', 'node_modules', 'vendor' ] );
  assert.ok( ! frame.requests.some( ( u ) => u.includes( 'shipped=' ) ) );
  frame.archive = archiveOf( [ ...FILES, ...SHIP ], manifest() );
  assert.equal( out( await handleCodingDeliverablePublish( plainInput, { env } ) ).body.error_kind, 'archive_incomplete',
    'shipped members nobody asked for are extra' );
} );
