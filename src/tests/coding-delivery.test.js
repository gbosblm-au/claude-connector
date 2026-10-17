// src/tests/coding-delivery.test.js   (claude-connector v13.38.0)
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
//   v13.38.0, TENAX-2026-10-10-02:
//   C-READER-ORDER        (connector half) nothing is fetched unless the frame
//                         reads the credential as a reader that writes nothing
//   C-LINK-CONTENT        every member is checked against the listing by
//                         sha256: an altered member at the same size is refused
// ---------------------------------------------------------------------------

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleCodingDeliverablePublish, validatePublishInput, validArchiveRoot, checkArchiveComplete, frameDeliveryConfigured,
  codingDeliverablePublishToolDefinition, CODING_DELIVERY_TOOL, checkArchiveContent, sha256Yielding,
} from '../tools/coding-delivery.js';
import { crc32, crc32Yielding, listZipMembers, readZipMember, readZipMemberAsync } from '../utils/zipCentralDirectory.js';
import { verifySignedRequest, resetSigningSecretCache } from '../utils/signedUrls.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const SRC = join( HERE, '..' );

/**
 * A ZIP writer, enough to play the frame in a test: STORE, or DEFLATE when
 * `deflate` is set (v13.38.0, so the asynchronous inflate is exercised).
 */
function zip( members, { deflate = false } = {} ) {
  const local = [];
  const central = [];
  let offset = 0;
  for ( const m of members ) {
    const name = Buffer.from( m.name, 'utf8' );
    const data = Buffer.isBuffer( m.data ) ? m.data : Buffer.from( m.data );
    const crc = crc32( data );
    const stored = deflate ? deflateRawSync( data ) : data;
    const method = deflate ? 8 : 0;
    const lh = Buffer.alloc( 30 );
    lh.writeUInt32LE( 0x04034b50, 0 ); lh.writeUInt16LE( 20, 4 ); lh.writeUInt16LE( 0x0800, 6 );
    lh.writeUInt16LE( method, 8 ); lh.writeUInt32LE( crc, 14 ); lh.writeUInt32LE( stored.length, 18 );
    lh.writeUInt32LE( data.length, 22 ); lh.writeUInt16LE( name.length, 26 );
    const ch = Buffer.alloc( 46 );
    ch.writeUInt32LE( 0x02014b50, 0 ); ch.writeUInt16LE( 20, 4 ); ch.writeUInt16LE( 20, 6 );
    ch.writeUInt16LE( 0x0800, 8 ); ch.writeUInt16LE( method, 10 ); ch.writeUInt32LE( crc, 16 ); ch.writeUInt32LE( stored.length, 20 );
    ch.writeUInt32LE( data.length, 24 ); ch.writeUInt16LE( name.length, 28 ); ch.writeUInt32LE( offset, 42 );
    local.push( lh, name, stored );
    central.push( ch, name );
    offset += 30 + name.length + stored.length;
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

function archiveOf( files, man, root = 'widget', opts = {} ) {
  const p = root ? `${ root }/` : '';
  return zip( [
    ...files.map( ( f ) => ( { name: p + f.path, data: f.data } ) ),
    { name: `${ p }.tenax/delivery.json`, data: `${ JSON.stringify( man, null, 2 ) }\n` },
  ].sort( ( a, b ) => ( a.name < b.name ? -1 : 1 ) ), opts );
}

/** What GET /v1/credential answers for the reader token (tenax-frame 1.10.2). */
const READER_CREDENTIAL = Object.freeze( { role: 'reader', credential_id: 'cred:0123456789ab', writes: [], service: 'tenax-frame', version: '1.10.2' } );

/** What the fake frame serves next, and what it was asked. */
const frame = { archive: null, sha: null, treeHash: TREE, requests: [], listingStatus: 200, listing: null,
  credentialStatus: 200, credential: READER_CREDENTIAL };
const server = http.createServer( ( req, res ) => {
  frame.requests.push( { url: req.url, auth: req.headers.authorization } );
  if ( req.headers.authorization !== 'Bearer reader-token-0123456789' ) {
    res.writeHead( 401, { 'Content-Type': 'application/json' } ); res.end( '{"error":"unauthorised"}' ); return;
  }
  if ( req.url === '/v1/credential' ) {
    res.writeHead( frame.credentialStatus, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( frame.credentialStatus === 404 ? { error: 'not_found' } : frame.credential ) );
    return;
  }
  if ( req.url === `/v1/tree/${ TREE }` ) {
    res.writeHead( frame.listingStatus, { 'Content-Type': 'application/json' } );
    res.end( JSON.stringify( { tree_hash: TREE, entries: frame.listing || LISTING, excluded: [] } ) );
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
  frame.listing = null;
  frame.credentialStatus = 200;
  frame.credential = READER_CREDENTIAL;
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
  // v13.38.0: the credential was verified first, and every member checked by content.
  assert.equal( frame.requests[ 0 ].url, '/v1/credential', 'the credential is verified before anything is fetched' );
  assert.deepEqual( body.frame_credential, { role: 'reader', credential_id: 'cred:0123456789ab', frame_version: '1.10.2' } );
  assert.equal( body.content_checked, FILES.length );

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

// ── v13.38.0, TENAX-2026-10-10-02 ─────────────────────────────────────────

test( 'C-READER-ORDER (connector half): a credential the frame reads as anything but a reader is refused, and nothing is fetched or written', async () => {
  // A frame older than the reader role read reader:<token> as an operator
  // token. The connector asks, and refuses to act as one.
  // MUTATION: accept any role in verifyReaderCredential. Reddens.
  for ( const credential of [
    { ...READER_CREDENTIAL, role: 'operator', writes: [ 'artefact.write', 'claim-set.write', 'finding.close', 'run.start' ] },
    { ...READER_CREDENTIAL, role: 'author', writes: [ 'claim-set.write' ] },
    // MUTATION: drop the writes check (role alone). Reddens on this one.
    { ...READER_CREDENTIAL, writes: [ 'run.start' ] },
  ] ) {
    frame.requests.length = 0;
    frame.credential = credential;
    const { isError, body } = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
    assert.equal( isError, true );
    assert.equal( body.error_kind, 'frame_credential_overprivileged', JSON.stringify( credential ) );
    assert.equal( body.frame_role, credential.role );
    assert.deepEqual( body.frame_writes, credential.writes );
    assert.ok( ! JSON.stringify( body ).includes( 'reader-token' ), 'the token is never echoed' );
    assert.deepEqual( frame.requests.map( ( r ) => r.url ), [ '/v1/credential' ], 'nothing but the credential was asked' );
    assert.equal( body.download_url, undefined, 'no link is fabricated' );
  }
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'C-READER-ORDER (connector half): a frame that cannot say what the credential is (before 1.10.2) is refused unverified', async () => {
  // MUTATION: treat a 404 from /v1/credential as a reader. Reddens.
  frame.credentialStatus = 404;
  const old = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( old.body.error_kind, 'frame_credential_unverified' );
  assert.match( old.body.message, /older than tenax-frame 1\.10\.2/ );
  assert.deepEqual( frame.requests.map( ( r ) => r.url ), [ '/v1/credential' ] );
  // A body that does not say: no role, or no writes list.
  frame.credentialStatus = 200;
  for ( const credential of [ { role: 'reader' }, { writes: [] }, null ] ) {
    frame.requests.length = 0;
    frame.credential = credential;
    assert.equal( out( await handleCodingDeliverablePublish( INPUT, { env } ) ).body.error_kind, 'frame_credential_unverified', JSON.stringify( credential ) );
    assert.equal( frame.requests.length, 1 );
  }
  // A refused credential is refused by name, as before.
  frame.credential = READER_CREDENTIAL;
  frame.requests.length = 0;
  const wrong = out( await handleCodingDeliverablePublish( INPUT, { env: { ...env, TENAX_FRAME_READ_TOKEN: 'wrong-token-0000' } } ) );
  assert.equal( wrong.body.error_kind, 'frame_refused' );
  assert.deepEqual( readdirSync( downloads ), [] );
} );

test( 'C-LINK-CONTENT: a member altered at the same size is refused by its sha256, and nothing is published', async () => {
  // Same path, same length, different bytes: the size check alone passed it.
  // MUTATION: skip checkArchiveContent in handleCodingDeliverablePublish. Reddens.
  const altered = FILES.map( ( f ) => ( f.path === 'src/index.js' ? { ...f, data: 'export const x = 2;\n' } : f ) );
  assert.equal( Buffer.byteLength( altered[ 1 ].data ), LISTING[ 1 ].bytes, 'the altered member keeps its size' );
  for ( const deflate of [ false, true ] ) {
    frame.archive = archiveOf( altered, manifest(), 'widget', { deflate } );
    const { isError, body } = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
    assert.equal( isError, true );
    assert.equal( body.error_kind, 'archive_content_mismatch', `deflate ${ deflate }` );
    assert.deepEqual( body.detail.altered, [ 'src/index.js' ] );
  }
  assert.deepEqual( readdirSync( downloads ), [], 'an altered member reached the downloads directory' );
  // The same tree DEFLATEd is published: the content check reads inflated bytes.
  frame.archive = archiveOf( FILES, manifest(), 'widget', { deflate: true } );
  const ok = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( ok.isError, false, JSON.stringify( ok.body ) );
  assert.equal( ok.body.content_checked, FILES.length );
} );

test( 'C-LINK-CONTENT: a listing that gives no sha256 cannot vouch for an archive, and is refused unverifiable', async () => {
  // MUTATION: skip entries without a sha256 instead of refusing. Reddens.
  frame.listing = LISTING.map( ( e, i ) => ( i === 0 ? { path: e.path, bytes: e.bytes } : e ) );
  const r = out( await handleCodingDeliverablePublish( INPUT, { env } ) );
  assert.equal( r.body.error_kind, 'archive_unverifiable' );
  assert.deepEqual( r.body.detail.unhashed, [ LISTING[ 0 ].path ] );
  assert.deepEqual( readdirSync( downloads ), [] );
  // Directly: the check passes the frame's own listing.
  const a = archiveOf( FILES, manifest() );
  assert.deepEqual( await checkArchiveContent( a, LISTING, 'widget' ), { ok: true, checked: FILES.length } );
} );

test( 'the asynchronous reader agrees with the synchronous one, and the CRC-32 is incremental', async () => {
  const big = Buffer.alloc( 9 * 1024 * 1024 + 7 );
  for ( let i = 0; i < big.length; i++ ) big[ i ] = ( i * 2654435761 ) >>> 24;
  assert.equal( crc32( big.subarray( 5 ), crc32( big.subarray( 0, 5 ) ) ), crc32( big ) );
  // Yields between 4 MiB pieces, and gives the same value.
  let turns = 0;
  const ticker = setInterval( () => { turns += 1; }, 0 );
  const yielded = await crc32Yielding( big );
  clearInterval( ticker );
  assert.equal( yielded, crc32( big ) );
  // MUTATION: drop the yield in crc32Yielding. Reddens: no timer runs.
  assert.ok( turns >= 1, 'the event loop turned while the CRC was computed' );
  // The member's sha256 likewise (independent review, 2026-10-10).
  let shaTurns = 0;
  const shaTicker = setInterval( () => { shaTurns += 1; }, 0 );
  const digest = await sha256Yielding( Buffer.concat( [ big, big, big ] ) );
  clearInterval( shaTicker );
  assert.equal( digest, createHash( 'sha256' ).update( Buffer.concat( [ big, big, big ] ) ).digest( 'hex' ) );
  // MUTATION: drop the yield in sha256Yielding. Reddens.
  assert.ok( shaTurns >= 1, 'the event loop turned while the sha256 was computed' );
  for ( const deflate of [ false, true ] ) {
    const a = zip( [ { name: 'big.bin', data: big }, { name: 'small.txt', data: 'hello\n' } ], { deflate } );
    for ( const m of listZipMembers( a ) ) {
      assert.deepEqual( await readZipMemberAsync( a, m ), readZipMember( a, m ), `${ m.name } deflate ${ deflate }` );
    }
    // A corrupted byte in the stored data fails the CRC (STORE) or the inflate (DEFLATE), by code.
    const bad = Buffer.from( a );
    const first = listZipMembers( bad ).find( ( m ) => m.name === 'small.txt' );
    bad[ first.offset + 30 + 'small.txt'.length + 1 ] ^= 0xff;
    await assert.rejects( readZipMemberAsync( bad, first ), { code: 'zip_unreadable' } );
  }
} );
