// src/tests/preview-signature-alignment.test.js  v1.0.0
// ---------------------------------------------------------------------------
// CONN-V2-FIX-01 -- duplicate and invalid download signatures in the preview
// interface.
//
// THE DEFECT
// ----------
// The signature payload is `${filename}:${exp}`, so a signature authorises
// exactly one filename. Several layers derived a second URL from the first by
// rewriting the last path segment (typically .html <-> .docx) while carrying
// the original query string, including exp and sig, verbatim. The result was
// two structurally identical URLs with the SAME expiry and DIFFERENT
// signatures, one of which the connector refused with
// "Invalid download link signature."
//
// Separately, GET /preview/:filename interpolated a bare identifier `token`
// that was never declared in the handler or at module scope, so the docx
// extract-fallback page and the non-previewable page threw ReferenceError.
//
// WHAT THIS FILE LOCKS DOWN
// -------------------------
//   1. download_url and preview_url for one file carry the SAME signature.
//      This is the spec's "Preview-Signature Alignment" assertion.
//   2. Rewriting the filename while keeping the query is refused, which is the
//      property that makes the derivation bug a bug rather than a style issue.
//   3. Swapping only the ROUTE segment is safe, which is what licenses the
//      corrected derivation in the gateway and the WordPress UI.
//   4. The preview route's HTML templates no longer reference an undeclared
//      identifier, and no longer emit a `?token=` link while signed links are
//      the active scheme.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname( fileURLToPath( import.meta.url ) );

/** Environment keys every test in this file mutates. */
const ENV_KEYS = [
  'SIGNED_URL_SECRET', 'SIGNED_URL_SECRET_PATH', 'ENABLE_SIGNED_LINKS',
  'LINK_EXPIRY_SECONDS', 'ALLOW_LEGACY_DOWNLOAD_TOKEN',
  'CONNECTOR_URL', 'DOCUMENT_DOWNLOAD_TOKEN', 'DOWNLOADS_DIR',
  'RAILWAY_PUBLIC_DOMAIN',
];

let saved;

before( () => {
  saved = {};
  for ( const k of ENV_KEYS ) saved[ k ] = process.env[ k ];
} );

after( () => {
  for ( const k of ENV_KEYS ) {
    if ( saved[ k ] === undefined ) delete process.env[ k ];
    else process.env[ k ] = saved[ k ];
  }
} );

beforeEach( async () => {
  const { resetSigningSecretCache } = await import( '../utils/signedUrls.js' );
  resetSigningSecretCache();
  for ( const k of ENV_KEYS ) delete process.env[ k ];
  process.env.SIGNED_URL_SECRET = 'a'.repeat( 64 );
} );

/**
 * Stage a downloads directory containing the given files and return a fresh
 * downloadLinks module bound to it.
 *
 * The cache-busting query on the import specifier is required: downloadLinks.js
 * reads DOWNLOADS_DIR through a function rather than at module load, but the
 * import cache would otherwise share module state across tests that set
 * different environments, which makes failures order-dependent.
 *
 * @param {string[]} filenames
 * @returns {Promise<{ dir: string, before: Map<string,string>, mod: object }>}
 */
async function stageDownloads( filenames ) {
  const dir = mkdtempSync( join( tmpdir(), 'conn-v2-fix-01-' ) );
  process.env.DOWNLOADS_DIR = dir;
  process.env.CONNECTOR_URL = 'https://connector.example.com';

  const mod    = await import( `../utils/downloadLinks.js?fix01=${ Math.random() }` );
  const before = mod.snapshotDownloads();

  for ( const name of filenames ) writeFileSync( join( dir, name ), 'x' );

  return { dir, before, mod };
}

/** Parse a URL and return its exp and sig query parameters. */
function creds( url ) {
  const u = new URL( url );
  return { exp: u.searchParams.get( 'exp' ), sig: u.searchParams.get( 'sig' ) };
}

/** The last path segment of a URL, percent-decoded. */
function lastSegment( url ) {
  return decodeURIComponent( new URL( url ).pathname.split( '/' ).pop() || '' );
}

// ---------------------------------------------------------------------------
// 1. Preview-Signature Alignment (the spec's regression assertion)
// ---------------------------------------------------------------------------

describe( 'CONN-V2-FIX-01: one file yields exactly one signature', () => {
  test( 'download_url and preview_url for a file carry identical exp and sig', async () => {
    const { before, mod, dir } = await stageDownloads( [ 'Report.docx' ] );

    const { links } = mod.buildDownloadLinks( { before } );
    assert.equal( links.length, 1 );

    const link = links[ 0 ];
    assert.ok( link.preview_url, '.docx is previewable, so a preview_url is expected' );

    const dl = creds( link.download_url );
    const pv = creds( link.preview_url );

    assert.equal( pv.exp, dl.exp, 'expiry must match between the two paths' );
    assert.equal( pv.sig, dl.sig,
      `HMAC MISMATCH: ${ link.filename } preview differs from API return` );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'the two URLs differ only in the route segment', async () => {
    const { before, mod, dir } = await stageDownloads( [ 'Report.docx' ] );

    const link = mod.buildDownloadLinks( { before } ).links[ 0 ];

    assert.equal( lastSegment( link.preview_url ), lastSegment( link.download_url ),
      'the preview URL must address the same filename, or the signature cannot verify' );
    assert.equal( link.download_url.replace( '/download/', '/preview/' ), link.preview_url );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'a document and its .html sidecar get separate, non-interchangeable signatures', async () => {
    const { before, mod, dir } = await stageDownloads( [ 'Report.docx', 'Report.html' ] );
    const { verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { links } = mod.buildDownloadLinks( { before } );
    assert.equal( links.length, 2 );

    const docx = links.find( ( l ) => l.filename === 'Report.docx' );
    const html = links.find( ( l ) => l.filename === 'Report.html' );
    assert.ok( docx && html );

    // Both are minted in the same tick, so the expiries match. That is exactly
    // what made the original failure confusing to diagnose: the two URLs looked
    // interchangeable because only the signature differed.
    assert.equal( creds( docx.download_url ).exp, creds( html.download_url ).exp );
    assert.notEqual( creds( docx.download_url ).sig, creds( html.download_url ).sig );

    // Each verifies for its own file and for nothing else.
    const h = creds( html.download_url );
    assert.equal( verifySignedRequest( { filename: 'Report.html', exp: h.exp, sig: h.sig } ).ok, true );
    assert.equal(
      verifySignedRequest( { filename: 'Report.docx', exp: h.exp, sig: h.sig } ).reason,
      'bad_signature',
      'carrying a sidecar signature onto the source document must be refused' );

    rmSync( dir, { recursive: true, force: true } );
  } );
} );

// ---------------------------------------------------------------------------
// 2. The derivation rule the client layers must obey
// ---------------------------------------------------------------------------

describe( 'CONN-V2-FIX-01: filename rewriting invalidates a signed link', () => {
  test( 'rewriting the extension while keeping the query is refused', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    // This is the exact transformation the UI used to perform.
    const { exp, sig } = buildSignedQuery( { filename: 'Report.html' } );

    assert.equal( verifySignedRequest( { filename: 'Report.html', exp, sig } ).ok, true );
    assert.equal( verifySignedRequest( { filename: 'Report.docx', exp, sig } ).reason,
      'bad_signature',
      'the .html -> .docx rewrite is the root cause of the reported failure' );
  } );

  test( 'swapping only the route segment preserves validity', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig, query } = buildSignedQuery( { filename: 'Report.docx' } );

    const downloadUrl = `https://c.example/download/Report.docx${ query }`;
    const previewUrl  = downloadUrl.replace( '/download/', '/preview/' );

    // The connector verifies both routes against the same normalised filename,
    // so the route segment is outside the signature payload by design.
    assert.equal( lastSegment( previewUrl ), 'Report.docx' );
    assert.equal( verifySignedRequest( { filename: lastSegment( previewUrl ), exp, sig } ).ok, true );
  } );

  test( 'the expiry alone never distinguishes a good link from a bad one', async () => {
    const { buildSignedQuery } = await import( '../utils/signedUrls.js' );

    const now = 1_800_000_000;
    const a = buildSignedQuery( { filename: 'Deck.pptx', now } );
    const b = buildSignedQuery( { filename: 'Deck.pptx.html', now } );

    assert.equal( a.exp, b.exp );
    assert.notEqual( a.sig, b.sig );
  } );
} );

// ---------------------------------------------------------------------------
// 3. Source-level guards on the preview route
// ---------------------------------------------------------------------------

describe( 'CONN-V2-FIX-01: GET /preview/:filename templates', () => {
  /** The body of the /preview/:filename handler, as source text. */
  function previewHandlerSource() {
    const src   = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' );
    const start = src.indexOf( "app.get( '/preview/:filename'" );
    assert.notEqual( start, -1, 'the preview route must still exist' );

    // The next top-level route registration bounds the handler. Anchoring on a
    // marker rather than a line number keeps this test stable across edits
    // elsewhere in the file.
    const after = src.indexOf( '\napp.', start + 1 );
    const end   = after === -1 ? src.length : after;
    return src.slice( start, end );
  }

  test( 'no template references an undeclared `token` identifier', () => {
    const body = previewHandlerSource();

    assert.equal( /encodeURIComponent\(\s*token\s*\)/.test( body ), false,
      'the handler never declared `token`; interpolating it threw ReferenceError' );
    assert.equal( /\?token=\$\{/.test( body ), false,
      'a hardcoded ?token= link is refused once ALLOW_LEGACY_DOWNLOAD_TOKEN=false' );
  } );

  test( 'every download link in the preview HTML is built from the caller credential', () => {
    const body = previewHandlerSource();

    const hrefs = body.match( /href="\/download\/[^"]*"/g ) || [];
    assert.ok( hrefs.length >= 2, 'the extract-fallback and non-previewable pages both link to /download' );

    for ( const href of hrefs ) {
      assert.ok( href.includes( 'authQuery' ),
        `download link does not propagate the request credential: ${ href }` );
      assert.ok( href.includes( 'encodeURIComponent(safeName)' ) || href.includes( 'encodeURIComponent( safeName )' ),
        `download link must target the validated filename, not a rewritten one: ${ href }` );
    }
  } );

  test( 'the credential is derived once, after authorisation, via sameFileAuthQuery', () => {
    const body = previewHandlerSource();
    const src  = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' );

    assert.ok( /function sameFileAuthQuery\s*\(/.test( src ),
      'the helper must exist at module scope so the handler can reach it' );

    const authIdx  = body.indexOf( 'authoriseDocumentRequest( req, safeName )' );
    const queryIdx = body.indexOf( 'sameFileAuthQuery( req )' );

    assert.notEqual( authIdx, -1 );
    assert.notEqual( queryIdx, -1 );
    assert.ok( queryIdx > authIdx,
      'the credential must only be echoed after it has been verified' );
  } );
} );

// ---------------------------------------------------------------------------
// 4. Legacy mode is untouched
// ---------------------------------------------------------------------------

describe( 'CONN-V2-FIX-01: ENABLE_SIGNED_LINKS=false is unaffected', () => {
  test( 'legacy links still carry the global token and no signature', async () => {
    process.env.ENABLE_SIGNED_LINKS   = 'false';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'legacy-token-value';

    const { before, mod, dir } = await stageDownloads( [ 'Legacy.docx' ] );
    const { links } = mod.buildDownloadLinks( { before } );

    assert.equal( links.length, 1 );
    assert.match( links[ 0 ].download_url, /\?token=legacy-token-value$/ );
    assert.equal( links[ 0 ].download_url.includes( 'sig=' ), false );
    assert.equal( links[ 0 ].expires_at, undefined,
      'legacy links have no expiry, which is the behaviour signed links replace' );

    rmSync( dir, { recursive: true, force: true } );
  } );
} );
