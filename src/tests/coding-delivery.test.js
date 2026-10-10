// src/tests/coding-delivery.test.js   (claude-connector v13.37.0)
// ---------------------------------------------------------------------------
// coding_deliverable_publish, driven end to end against a fake frame runner on
// a real socket, a real downloads directory and the real signed-link builder.
// TENAX-2026-10-09-01 Track A (route A1) and Track C.
//
// Claims:
//   C-DOWNLOADS-CONTENTS  the archive is in the downloads directory, under a
//                         single-segment name, before the link is built
//   C-NO-BUILT-URL        the link is the connector's (buildDownloadLinks), not
//                         one this tool assembled
//   C-LINK-SIGNED         /download/<name>?exp=<n>&sig=<hex>, no bare token
//   C-LINK-EXPIRY         expires_in_seconds is 259200 and the file is present
//   C-NEG-SUBSET-ZIP      an archive carrying only some of the tree is refused
//   C-FRAME-PREDECESSOR   (connector half) a manifest that does not record the
//                         predecessor and superseded archive asked for is
//                         refused, so a dropped predecessor cannot be published
// ---------------------------------------------------------------------------

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleCodingDeliverablePublish, validatePublishInput, validArchiveRoot, checkArchiveComplete, frameDeliveryConfigured,
  codingDeliverablePublishToolDefinition, CODING_DELIVERY_TOOL,
} from '../tools/coding-delivery.js';
import { crc32, listZipMembers, readZipMember } from '../utils/zipCentralDirectory.js';
import { verifySignedRequest, resetSigningSecretCache } from '../utils/signedUrls.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const SRC = join( HERE, '..' );

/** A STORE-only ZIP writer, enough to play the frame in a test. */
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
    lh.writeUInt16LE( 0, 8 ); lh.writeUInt32LE( crc, 14 ); lh.writeUInt32LE( data.length, 18 );
    lh.writeUInt32LE( data.length, 22 ); lh.writeUInt16LE( name.length, 26 );
    const ch = Buffer.alloc( 46 );
    ch.writeUInt32LE( 0x02014b50, 0 ); ch.writeUInt16LE( 20, 4 ); ch.writeUInt16LE( 20, 6 );
    ch.writeUInt16LE( 0x0800, 8 ); ch.writeUInt32LE( crc, 16 ); ch.writeUInt32LE( data.length, 20 );
    ch.writeUInt32LE( data.length, 24 ); ch.writeUInt16LE( name.length, 28 ); ch.writeUInt32LE( offset, 42 );
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

const TREE = 'a'.repeat( 64 );
const PRED = 'b'.repeat( 64 );
const SUPERSEDES = 'c'.repeat( 64 );
const FILES = [
  { path: 'README.md', data: '# Widget\n' },
  { path: 'src/index.js', data: 'export const x = 1;\n' },
  { path: '.tenax/project.json', data: '{"platform":"tenax-coding-platform"}\n' },
];
const LISTING = FILES.map( ( f ) => ( { path: f.path, bytes: Buffer.byteLength( f.data ), sha256: createHash( 'sha256' ).update( f.data ).digest( 'hex' ) } ) );

function manifest( over = {} ) {
  return {
    schema: 'tenax-delivery-v1', generated_by: 'tenax-frame 1.10.0', tree_hash: TREE,
    entry_count: FILES.length, total_bytes: LISTING.reduce( ( n, e ) => n + e.bytes, 0 ),
    archive_root: 'widget', predecessor_tree_hash: PRED, supersedes_archive_sha256: SUPERSEDES,
    changed_files: { added: [ 'src/index.js' ], modified: [ 'README.md' ], removed: [] },
    excluded: [], run: null, ...over,
  };
}

function archiveOf( files, man, root = 'widget' ) {
  const p = root ? `${ root }/` : '';
  return zip( [
    ...files.map( ( f ) => ( { name: p + f.path, data: f.data } ) ),
    { name: `${ p }.tenax/delivery.json`, data: `${ JSON.stringify( man, null, 2 ) }\n` },
  ].sort( ( a, b ) => ( a.name < b.name ? -1 : 1 ) ) );
}

/** What the fake frame serves next, and what it was asked. */
const frame = { archive: null, sha: null, treeHash: TREE, requests: [], listingStatus: 200 };
const server = http.createServer( ( req, res ) => {
  frame.requests.push( { url: req.url, auth: req.headers.authorization } );
  if ( req.headers.authorization !== 'Bearer reader-token-0123456789' ) {
    res.writeHead( 401, { 'Content-Type': 'application/json' } ); res.end( '{"error":"unauthorised"}' ); return;
  }
  if ( req.url === `/v1/tree/${ TREE }` ) {
    res.writeHead( frame.listingStatus, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( { tree_hash: TREE, entries: LISTING, excluded: [] } ) );
    return;
  }
  if ( req.url.startsWith( `/v1/artefacts/${ TREE }/archive` ) ) {
    res.writeHead( 200, {
      'Content-Type': 'application/zip', 'Content-Length': String( frame.archive.length ),
      'X-Frame-Archive-Sha256': frame.sha || createHash( 'sha256' ).update( frame.archive ).digest( 'hex' ),
      'X-Frame-Tree-Hash': frame.treeHash,
    } );
    res.end( frame.archive );
    return;
  }
  res.writeHead( 404, { 'Content-Type': 'application/json' } ); res.end( '{"error":"not_found"}' );
} );

let downloads;
let env;
const INPUT = { tree_hash: TREE, filename: 'widget-d1-aaaaaaaaaaaa.zip', root: 'widget', predecessor: PRED, supersedes: SUPERSEDES };

/** Parse the MCP result. */
function out( result ) {
  return { isError: result.isError, body: JSON.parse( result.content[ 0 ].text ) };
}

before( async () => {
  await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
  downloads = mkdtempSync( join( tmpdir(), 'coding-delivery-' ) );
  process.env.DOWNLOADS_DIR = downloads;
  process.env.CONNECTOR_URL = 'https://connector.example.test';
  process.env.SIGNED_URL_SECRET = 'd'.repeat( 64 );
  delete process.env.LINK_EXPIRY_SECONDS;
  delete process.env.ENABLE_SIGNED_LINKS;
  resetSigningSecretCache();
  env = { TENAX_FRAME_URL: `http://127.0.0.1:${ server.address().port }`, TENAX_FRAME_READ_TOKEN: 'reader-token-0123456789' };
} );

after( () => {
  server.close();
  rmSync( downloads, { recursive: true, force: true } );
} );

beforeEach( () => {
  frame.archive = archiveOf( FILES, manifest() );
  frame.sha = null;
  frame.treeHash = TREE;
  frame.requests.length = 0;
  frame.listingStatus = 200;
  for ( const f of readdirSync( downloads ) ) rmSync( join( downloads, f ), { force: true } );
} );

test( 'C-DOWNLOADS-CONTENTS / C-LINK-SIGNED / C-LINK-EXPIRY: the whole archive lands in downloads and the connector\'s signed 3-day link is returned', async () => {
  const { isError, body } = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( isError, false, JSON.stringify( body ) );
  assert.equal( body.ok, true );
  assert.equal( body.filename, INPUT.filename );

  // In the downloads directory, under the single-segment name, byte for byte.
  const onDisk = join( downloads, INPUT.filename );
  assert.ok( existsSync( onDisk ), 'the archive is not in the downloads directory' );
  assert.deepEqual( readFileSync( onDisk ), frame.archive );
  assert.equal( body.size_bytes, frame.archive.length );
  assert.equal( body.archive_sha256, createHash( 'sha256' ).update( frame.archive ).digest( 'hex' ) );
  assert.deepEqual( readdirSync( downloads ), [ INPUT.filename ], 'no temporary file is left behind' );

  // The connector's own signed link, verifiable by its own verifier.
  const u = new URL( body.download_url );
  assert.equal( u.origin, 'https://connector.example.test' );
  assert.equal( u.pathname, `/download/${ INPUT.filename }` );
  assert.ok( /^\d+$/.test( u.searchParams.get( 'exp' ) ) && /^[0-9a-f]{64}$/.test( u.searchParams.get( 'sig' ) ) );
  assert.equal( u.searchParams.get( 'token' ), null, 'no bare global token' );
  const verdict = verifySignedRequest( { filename: INPUT.filename, exp: u.searchParams.get( 'exp' ), sig: u.searchParams.get( 'sig' ) } );
  assert.equal( verdict.ok, true );
  assert.ok( body.expires_in_seconds >= 259200 - 5 && body.expires_in_seconds <= 259200, String( body.expires_in_seconds ) );
  assert.ok( statSync( onDisk ).isFile(), 'the file is present at the instant the link is reported' );

  // The manifest the frame wrote, surfaced.
  assert.equal( body.manifest.predecessor_tree_hash, PRED );
  assert.equal( body.manifest.supersedes_archive_sha256, SUPERSEDES );
  assert.deepEqual( body.manifest.changed_files, { added: [ 'src/index.js' ], modified: [ 'README.md' ], removed: [] } );
  assert.equal( body.manifest.archive_root, 'widget' );

  // The read credential was used and never echoed.
  assert.ok( frame.requests.every( ( r ) => r.auth === 'Bearer reader-token-0123456789' ) );
  assert.ok( ! JSON.stringify( body ).includes( 'reader-token' ) );
  assert.ok( frame.requests.some( ( r ) => r.url.includes( `predecessor=${ PRED }` ) && r.url.includes( `supersedes=${ SUPERSEDES }` ) && r.url.includes( 'root=widget' ) ) );
} );

test( 'C-NEG-SUBSET-ZIP: an archive carrying only the changed members is refused and nothing is published', async () => {
  frame.archive = archiveOf( FILES.filter( ( f ) => f.path === 'src/index.js' ), manifest() );
  const { isError, body } = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( isError, true );
  assert.equal( body.error_kind, 'archive_incomplete' );
  assert.deepEqual( body.detail.missing.sort(), [ '.tenax/project.json', 'README.md' ] );
  assert.deepEqual( readdirSync( downloads ), [], 'a subset reached the downloads directory' );
} );

test( 'an archive with a member the tree does not list, or at the wrong size, is refused', async () => {
  frame.archive = archiveOf( [ ...FILES, { path: 'extra.txt', data: 'x' } ], manifest() );
  assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'archive_incomplete' );
  frame.archive = archiveOf( FILES.map( ( f ) => ( f.path === 'README.md' ? { ...f, data: '# Widget, longer\n' } : f ) ), manifest() );
  const r = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( r.body.error_kind, 'archive_incomplete' );
  assert.equal( r.body.detail.wrong_size.length, 1 );
  // Under a different root than asked for: every member is unexpected.
  frame.archive = archiveOf( FILES, manifest(), 'other' );
  assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'archive_incomplete' );
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'C-FRAME-PREDECESSOR (connector half): a manifest missing the predecessor or the superseded archive is refused', async () => {
  for ( const over of [ { predecessor_tree_hash: null }, { supersedes_archive_sha256: null }, { tree_hash: 'e'.repeat( 64 ) }, { archive_root: null } ] ) {
    frame.archive = archiveOf( FILES, manifest( over ) );
    const r = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
    assert.equal( r.body.error_kind, 'archive_manifest_mismatch', JSON.stringify( over ) );
  }
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'an archive altered in transit, or of another tree, is refused', async () => {
  frame.sha = 'f'.repeat( 64 );
  assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'archive_mismatch' );
  frame.sha = null;
  frame.treeHash = 'e'.repeat( 64 );
  assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'archive_mismatch' );
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'refusals before any fetch: not configured, bad filename, bad hashes', async () => {
  const none = out( await handleCodingDeliverablePublish( INPUT, { env: {} } ) );
  assert.equal( none.body.error_kind, 'frame_not_configured' );
  assert.equal( frameDeliveryConfigured( {} ), false );
  assert.equal( frameDeliveryConfigured( env ), true );
  for ( const bad of [
    { ...INPUT, filename: 'dir/widget.zip' }, { ...INPUT, filename: '../widget.zip' }, { ...INPUT, filename: 'widget.tar' },
    { ...INPUT, filename: '.hidden.zip' }, { ...INPUT, tree_hash: 'A'.repeat( 64 ) }, { ...INPUT, predecessor: 'xyz' },
    { ...INPUT, supersedes: 'c'.repeat( 63 ) }, { ...INPUT, root: 'a/b' }, { ...INPUT, root: '..' }, { ...INPUT, run: 'r un' },
    { ...INPUT, root: 'a\\b' }, { ...INPUT, root: 'x\u0000y' }, { ...INPUT, root: 'x'.repeat( 201 ) },
    // The name is bound to the tree: anything that does not end
    // -<first 12 of tree_hash>.zip could replace another file in downloads.
    // MUTATION: drop the tree-binding check. Reddens on these two.
    { ...INPUT, filename: 'report.zip' }, { ...INPUT, filename: 'widget-d1-bbbbbbbbbbbb.zip' },
  ] ) {
    assert.equal( validatePublishInput( bad ).ok, false, JSON.stringify( bad ) );
    assert.equal( out( await handleCodingDeliverablePublish( bad, { env } ) ).body.error_kind, 'invalid_input' );
  }
  assert.equal( frame.requests.length, 0, 'the frame was asked despite a refusal' );
} );

test( 'C3: a root with a space or an accent is a root, delivered as the folder the person named', async () => {
  // Review finding (v13.37.0): the first cut accepted only [A-Za-z0-9._-], so
  // an archive made from a folder called "My App" was accepted at intake and
  // refused at every publication. A root is one segment, not a character class.
  // MUTATION: restore the [A-Za-z0-9._-]{1,200} class in validArchiveRoot. Reddens.
  for ( const good of [ 'My App', 'Projet Été', 'x'.repeat( 200 ) ] ) {
    assert.equal( validArchiveRoot( good ), true, good );
  }
  frame.archive = archiveOf( FILES, manifest( { archive_root: 'My App' } ), 'My App' );
  const { isError, body } = out( await handleCodingDeliverablePublish( { ...INPUT, root: 'My App' }, { env } ) );
  assert.equal( isError, false, JSON.stringify( body ) );
  assert.equal( body.manifest.archive_root, 'My App' );
  const asked = frame.requests.find( ( r ) => r.url.includes( '/archive' ) );
  assert.equal( new URL( asked.url, 'http://x' ).searchParams.get( 'root' ), 'My App', 'the root travels intact in the query' );
} );

test( 'a frame that refuses the credential or has no such tree is reported by name', async () => {
  const wrong = out( await handleCodingDeliverablePublish( INPUT, { env: { ...env, TENAX_FRAME_READ_TOKEN: 'wrong-token-0000' } } ) );
  assert.equal( wrong.body.error_kind, 'frame_refused' );
  assert.ok( ! JSON.stringify( wrong.body ).includes( 'wrong-token' ) );
  frame.listingStatus = 404;
  assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'tree_not_found' );
} );

test( 'the archive bound is enforced while reading', async () => {
  const r = out( await handleCodingDeliverablePublish( INPUT, { env: { ...env, CODING_DELIVERY_MAX_BYTES: '100' } } ) );
  assert.equal( r.body.error_kind, 'archive_too_large' );
  assert.equal( r.body.limit_bytes, 100 );
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'the zip reader reads what it lists, and refuses what it cannot read', () => {
  const a = archiveOf( FILES, manifest() );
  const members = listZipMembers( a );
  assert.equal( members.length, FILES.length + 1 );
  const readme = members.find( ( m ) => m.name === 'widget/README.md' );
  assert.equal( readZipMember( a, readme ).toString(), '# Widget\n' );
  assert.throws( () => listZipMembers( Buffer.from( 'not a zip at all, not at all' ) ), { code: 'zip_unreadable' } );
  const bad = Buffer.from( a );
  bad[ 30 + 'widget/.tenax/delivery.json'.length + 2 ] ^= 0xff;
  const first = listZipMembers( bad )[ 0 ];
  assert.throws( () => readZipMember( bad, first ), { code: 'zip_unreadable' } );
  assert.equal( checkArchiveComplete( Buffer.from( 'x' ), LISTING, null ).kind, 'archive_unreadable' );
} );

test( 'C-NO-BUILT-URL: the tool assembles no URL of its own; the link comes from buildDownloadLinks', () => {
  const code = readFileSync( join( SRC, 'tools', 'coding-delivery.js' ), 'utf8' )
    .replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' );
  assert.ok( ! /['"`]\/download\//.test( code ), 'a /download/ path literal in the tool' );
  assert.ok( ! /CONNECTOR_URL|connectorBaseUrl|buildSignedQuery|DOCUMENT_DOWNLOAD_TOKEN/.test( code ),
    'the tool reads the URL ingredients itself' );
  assert.match( code, /buildDownloadLinks\( \{ before, declared: \[ filename \] \} \)/ );
  assert.match( code, /download_url: link\.download_url/ );
} );

test( 'the tool is dispatched by the tool layer and advertised only when configured', () => {
  const server = readFileSync( join( SRC, 'server-http.js' ), 'utf8' );
  assert.match( server, /case CODING_DELIVERY_TOOL: return await handleCodingDeliverablePublish\(args\);/ );
  assert.match( server, /\.\.\.\(frameDeliveryConfigured\(\) \? \[codingDeliverablePublishToolDefinition\] : \[\]\)/ );
  assert.equal( codingDeliverablePublishToolDefinition.name, CODING_DELIVERY_TOOL );
  assert.deepEqual( codingDeliverablePublishToolDefinition.inputSchema.required, [ 'tree_hash', 'filename' ] );
} );
