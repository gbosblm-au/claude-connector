// src/tests/signed-urls.test.js  v1.0.0
// ---------------------------------------------------------------------------
// TNX-FEAT-SIGNEDURLS -- per-file signed download URLs.
//
// Structured against the acceptance criteria in the spec:
//
//   1. Signed requests verify.
//   2. Expired requests are refused.
//   3. Tampered requests are refused (missing sig, swapped filename, altered
//      expiry, flipped signature bits).
//   4. ENABLE_SIGNED_LINKS=false restores the previous global-token behaviour.
//   5. The master secret persists across restarts.
//   6. Existing render scripts are unaffected.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ---------------------------------------------------------------------------
// Criterion 1 -- valid signed requests
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: a correctly signed request verifies', () => {
  test( 'a freshly built signature verifies for its own filename', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig, query } = buildSignedQuery( { filename: 'report.docx' } );

    assert.match( query, /^\?exp=\d+&sig=[a-f0-9]{64}$/ );
    assert.equal( verifySignedRequest( { filename: 'report.docx', exp, sig } ).ok, true );
  } );

  test( 'the default lifetime is three days', async () => {
    const { buildSignedQuery, linkExpirySeconds } = await import( '../utils/signedUrls.js' );

    // 259200s = 3 days, calibrated to match DOWNLOADS_TTL_HOURS in
    // server-http.js and DOCUMENT_TTL_DAYS in the Gateway Service. A link that
    // expires before the sidebar row holding it produces dead buttons under a
    // live countdown, which is why this is asserted rather than left implicit.
    assert.equal( linkExpirySeconds(), 259200 );

    const now = 1_700_000_000;
    const { exp } = buildSignedQuery( { filename: 'a.pdf', now } );
    assert.equal( exp, now + 259200 );
    assert.equal( ( exp - now ) / 86400, 3, 'the default must be exactly three days' );
  } );

  test( 'LINK_EXPIRY_SECONDS overrides the lifetime, with sane fallbacks', async () => {
    const mod = await import( '../utils/signedUrls.js' );

    process.env.LINK_EXPIRY_SECONDS = '120';
    assert.equal( mod.linkExpirySeconds(), 120 );

    // A zero, negative or non-numeric value must not produce links that are
    // already expired at the moment they are issued.
    for ( const bad of [ '0', '-5', 'abc', '' ] ) {
      process.env.LINK_EXPIRY_SECONDS = bad;
      assert.equal( mod.linkExpirySeconds(), 259200, `"${ bad }" must fall back to the default` );
    }

    // Capped, so a milliseconds value pasted into a seconds field cannot
    // silently restore the unlimited lifetime this feature removes.
    process.env.LINK_EXPIRY_SECONDS = '999999999';
    assert.equal( mod.linkExpirySeconds(), 30 * 24 * 3600 );

    // The 3 day default sits well under the 30 day cap, so the cap does not
    // interfere with it.
    delete process.env.LINK_EXPIRY_SECONDS;
    assert.ok( mod.linkExpirySeconds() < 30 * 24 * 3600 );
  } );
} );

// ---------------------------------------------------------------------------
// Criterion 2 -- expiry
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: expired links are refused', () => {
  test( 'a signature valid in the past is refused now', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const past = Math.floor( Date.now() / 1000 ) - 7200;
    const { exp, sig } = buildSignedQuery( { filename: 'old.docx', now: past, expirySeconds: 3600 } );

    const verdict = verifySignedRequest( { filename: 'old.docx', exp, sig } );
    assert.equal( verdict.ok, false );
    assert.equal( verdict.reason, 'expired' );
  } );

  test( 'a link expiring exactly now is refused, not accepted', async () => {
    const { computeSignature, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const now = 1_700_000_000;
    const sig = computeSignature( 'edge.docx', now, 'a'.repeat( 64 ) );

    // exp <= now is the boundary. Accepting equality would leave a one-second
    // window after expiry, which is a small bug that is very hard to see.
    assert.equal( verifySignedRequest( { filename: 'edge.docx', exp: now, sig, now } ).reason, 'expired' );
    assert.equal( verifySignedRequest( { filename: 'edge.docx', exp: now + 1, sig: computeSignature( 'edge.docx', now + 1, 'a'.repeat( 64 ) ), now } ).ok, true );
  } );

  test( 'extending exp without re-signing is refused as a bad signature', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const past = Math.floor( Date.now() / 1000 ) - 7200;
    const { sig } = buildSignedQuery( { filename: 'old.docx', now: past, expirySeconds: 3600 } );

    // The obvious attack on an expired link: keep the signature, push the
    // expiry forward. exp is inside the signed payload, so this fails.
    const far = Math.floor( Date.now() / 1000 ) + 999_999;
    const verdict = verifySignedRequest( { filename: 'old.docx', exp: far, sig } );

    assert.equal( verdict.ok, false );
    assert.equal( verdict.reason, 'bad_signature' );
  } );
} );

// ---------------------------------------------------------------------------
// Criterion 3 -- tampering
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: tampered links are refused', () => {
  test( 'signature swapping onto a different filename fails', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    // The core reason the filename is inside the HMAC payload. Without it, one
    // harvested signature would open every file and the global blast radius
    // would be back.
    const { exp, sig } = buildSignedQuery( { filename: 'public_notice.pdf' } );

    assert.equal( verifySignedRequest( { filename: 'public_notice.pdf', exp, sig } ).ok, true );

    for ( const other of [ 'salaries.xlsx', 'public_notice.pdff', 'Public_Notice.pdf', '' ] ) {
      const verdict = verifySignedRequest( { filename: other, exp, sig } );
      assert.equal( verdict.ok, false, `signature must not verify for ${ JSON.stringify( other ) }` );
      assert.equal( verdict.reason, 'bad_signature' );
    }
  } );

  test( 'a missing sig or exp is refused', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig } = buildSignedQuery( { filename: 'a.docx' } );

    assert.equal( verifySignedRequest( { filename: 'a.docx', exp, sig: '' } ).reason, 'malformed' );
    assert.equal( verifySignedRequest( { filename: 'a.docx', exp: '', sig } ).reason, 'malformed' );
    assert.equal( verifySignedRequest( { filename: 'a.docx', exp: '', sig: '' } ).reason, 'missing' );
  } );

  test( 'a flipped bit in the signature is refused', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig } = buildSignedQuery( { filename: 'a.docx' } );
    const flipped = ( sig[ 0 ] === '0' ? '1' : '0' ) + sig.slice( 1 );

    assert.equal( verifySignedRequest( { filename: 'a.docx', exp, sig: flipped } ).reason, 'bad_signature' );
  } );

  test( 'malformed exp and sig shapes are rejected before hashing', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig } = buildSignedQuery( { filename: 'a.docx' } );

    // parseInt would accept "1700000000abc"; strict validation avoids a
    // confusing bad_signature where the real fault is a mangled URL.
    for ( const badExp of [ `${ exp }abc`, '0x10', '1e9', '-1', '1'.repeat( 20 ) ] ) {
      assert.equal( verifySignedRequest( { filename: 'a.docx', exp: badExp, sig } ).reason, 'malformed',
        `exp ${ JSON.stringify( badExp ) } must be malformed` );
    }

    for ( const badSig of [ sig.slice( 0, 63 ), `${ sig }0`, `${ sig.slice( 0, 63 ) }z` ] ) {
      assert.equal( verifySignedRequest( { filename: 'a.docx', exp, sig: badSig } ).reason, 'malformed' );
    }

    // Surrounding whitespace is trimmed rather than rejected. Some link
    // rewriters introduce it, and the trimmed value is what the signature is
    // checked against, so leniency here grants nothing.
    assert.equal( verifySignedRequest( { filename: 'a.docx', exp: ` ${ exp } `, sig: ` ${ sig } ` } ).ok, true );
  } );

  test( 'a signature made with a different secret is refused', async () => {
    const mod = await import( '../utils/signedUrls.js' );

    const foreign = mod.computeSignature( 'a.docx', 9_999_999_999, 'b'.repeat( 64 ) );
    const verdict = mod.verifySignedRequest( { filename: 'a.docx', exp: 9_999_999_999, sig: foreign } );

    assert.equal( verdict.reason, 'bad_signature' );
  } );

  test( 'signature case is normalised, so an upper-case URL still verifies', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { exp, sig } = buildSignedQuery( { filename: 'a.docx' } );

    // Some mail clients and link rewriters upper-case query values. Refusing
    // those would present as random link failures with no pattern.
    assert.equal( verifySignedRequest( { filename: 'a.docx', exp, sig: sig.toUpperCase() } ).ok, true );
  } );
} );

// ---------------------------------------------------------------------------
// Criterion 5 -- secret persistence
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: the signing secret persists', () => {
  test( 'a missing secret is generated, written 0600, and reused', async () => {
    const dir  = mkdtempSync( join( tmpdir(), 'sec-' ) );
    const path = join( dir, '.url_secret' );

    delete process.env.SIGNED_URL_SECRET;
    process.env.SIGNED_URL_SECRET_PATH = path;

    const mod = await import( '../utils/signedUrls.js' );
    mod.resetSigningSecretCache();

    const warnings = [];
    const first = mod.resolveSigningSecret( ( level, msg ) => warnings.push( `${ level }:${ msg }` ) );

    assert.equal( first.length, 64, 'a 64-character hex secret must be generated' );
    assert.match( first, /^[a-f0-9]{64}$/ );
    assert.equal( existsSync( path ), true, 'the secret must be persisted to the volume' );
    assert.equal( readFileSync( path, 'utf8' ).trim(), first );
    assert.equal( warnings.some( ( w ) => w.startsWith( 'warn:' ) ), true,
      'the operator must be told a secret was generated' );

    // Simulate a restart: clear the cache, resolve again, expect the same value.
    mod.resetSigningSecretCache();
    assert.equal( mod.resolveSigningSecret( () => {} ), first,
      'the secret must survive a restart, or every outstanding link breaks' );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'a link signed before a restart still verifies after it', async () => {
    const dir  = mkdtempSync( join( tmpdir(), 'sec2-' ) );
    delete process.env.SIGNED_URL_SECRET;
    process.env.SIGNED_URL_SECRET_PATH = join( dir, '.url_secret' );

    const mod = await import( '../utils/signedUrls.js' );
    mod.resetSigningSecretCache();

    const { exp, sig } = mod.buildSignedQuery( { filename: 'persist.docx', log: () => {} } );

    mod.resetSigningSecretCache();   // restart
    assert.equal( mod.verifySignedRequest( { filename: 'persist.docx', exp, sig, log: () => {} } ).ok, true );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'SIGNED_URL_SECRET takes precedence over the persisted file', async () => {
    const dir  = mkdtempSync( join( tmpdir(), 'sec3-' ) );
    const path = join( dir, '.url_secret' );
    writeFileSync( path, 'f'.repeat( 64 ) );

    process.env.SIGNED_URL_SECRET_PATH = path;
    process.env.SIGNED_URL_SECRET      = 'e'.repeat( 64 );

    const mod = await import( '../utils/signedUrls.js' );
    mod.resetSigningSecretCache();

    assert.equal( mod.resolveSigningSecret( () => {} ), 'e'.repeat( 64 ),
      'an operator-managed secret must win, so rotation is a variable change' );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'a too-short SIGNED_URL_SECRET is refused rather than used', async () => {
    const dir = mkdtempSync( join( tmpdir(), 'sec4-' ) );
    process.env.SIGNED_URL_SECRET_PATH = join( dir, '.url_secret' );
    process.env.SIGNED_URL_SECRET      = 'tooshort';

    const mod = await import( '../utils/signedUrls.js' );
    mod.resetSigningSecretCache();

    const warnings = [];
    const secret = mod.resolveSigningSecret( ( l, m ) => warnings.push( `${ l }:${ m }` ) );

    assert.notEqual( secret, 'tooshort' );
    assert.equal( secret.length, 64 );
    assert.equal( warnings.some( ( w ) => w.includes( 'minimum' ) ), true );

    rmSync( dir, { recursive: true, force: true } );
  } );

  test( 'rotating the secret invalidates every outstanding link', async () => {
    const mod = await import( '../utils/signedUrls.js' );

    process.env.SIGNED_URL_SECRET = 'a'.repeat( 64 );
    mod.resetSigningSecretCache();
    const { exp, sig } = mod.buildSignedQuery( { filename: 'r.docx' } );

    process.env.SIGNED_URL_SECRET = 'c'.repeat( 64 );
    mod.resetSigningSecretCache();

    // Links are stateless, so there is no per-link revocation. Rotation is the
    // bulk revoke, and this documents that it works.
    assert.equal( mod.verifySignedRequest( { filename: 'r.docx', exp, sig } ).reason, 'bad_signature' );
  } );
} );

// ---------------------------------------------------------------------------
// Criteria 4 and 6 -- link generation, legacy mode, zero script impact
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: generated links', () => {
  /**
   * Create a downloads directory containing one file.
   * @returns {{ dir: string, before: Map<string,string> }}
   */
  async function stageDownload( filename = 'Report.docx' ) {
    const dir = mkdtempSync( join( tmpdir(), 'dl-sig-' ) );
    process.env.DOWNLOADS_DIR = dir;
    process.env.CONNECTOR_URL = 'https://connector.example.com';

    const mod = await import( `../utils/downloadLinks.js?sig=${ Math.random() }` );
    const before = mod.snapshotDownloads();
    writeFileSync( join( dir, filename ), 'x' );
    return { dir, before, mod };
  }

  test( 'links are signed by default and carry no global token', async () => {
    const { before, mod } = await stageDownload();
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'global-token-must-not-appear';

    const { links } = mod.buildDownloadLinks( { before } );

    assert.equal( links.length, 1 );
    assert.match( links[ 0 ].download_url,
      /^https:\/\/connector\.example\.com\/download\/Report\.docx\?exp=\d+&sig=[a-f0-9]{64}$/ );
    assert.match( links[ 0 ].preview_url, /\/preview\/Report\.docx\?exp=\d+&sig=[a-f0-9]{64}$/ );
    assert.equal( JSON.stringify( links ).includes( 'global-token-must-not-appear' ), false );
  } );

  test( 'the expiry is surfaced to the caller', async () => {
    const { before, mod } = await stageDownload();
    process.env.LINK_EXPIRY_SECONDS = '600';

    const { links, warnings } = mod.buildDownloadLinks( { before } );

    assert.equal( typeof links[ 0 ].expires_at, 'string' );
    assert.ok( links[ 0 ].expires_in_seconds > 0 && links[ 0 ].expires_in_seconds <= 600 );
    assert.equal( warnings.some( ( w ) => w.includes( 'expire' ) ), true,
      'the caller must be told the link is time limited so it can tell the user' );
  } );

  test( 'a generated link verifies end to end', async () => {
    const { before, mod } = await stageDownload( 'Verified.docx' );
    const { verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const { links } = mod.buildDownloadLinks( { before } );
    const url = new URL( links[ 0 ].download_url );

    assert.equal( verifySignedRequest( {
      filename: 'Verified.docx',
      exp:      url.searchParams.get( 'exp' ),
      sig:      url.searchParams.get( 'sig' ),
    } ).ok, true );
  } );

  test( 'signed links do not require DOCUMENT_DOWNLOAD_TOKEN to be set', async () => {
    const { before, mod } = await stageDownload();
    delete process.env.DOCUMENT_DOWNLOAD_TOKEN;

    const { links, warnings } = mod.buildDownloadLinks( { before } );

    assert.equal( links.length, 1 );
    assert.equal( warnings.some( ( w ) => w.includes( 'DOCUMENT_DOWNLOAD_TOKEN' ) ), false );
  } );

  test( 'ENABLE_SIGNED_LINKS=false restores the global-token link exactly', async () => {
    const { before, mod } = await stageDownload();
    process.env.ENABLE_SIGNED_LINKS     = 'false';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'legacy-token';

    const { links } = mod.buildDownloadLinks( { before } );

    assert.equal( links[ 0 ].download_url,
      'https://connector.example.com/download/Report.docx?token=legacy-token' );
    assert.equal( links[ 0 ].expires_at, undefined, 'legacy links do not expire' );
  } );

  test( 'legacy mode with no token reports the misconfiguration', async () => {
    const { before, mod } = await stageDownload();
    process.env.ENABLE_SIGNED_LINKS = 'false';
    delete process.env.DOCUMENT_DOWNLOAD_TOKEN;

    const { links, warnings } = mod.buildDownloadLinks( { before } );

    assert.deepEqual( links, [] );
    assert.equal( warnings.some( ( w ) => w.includes( 'ENABLE_SIGNED_LINKS is false' ) ), true );
  } );

  test( 'zero script impact: detection is still by directory diff', async () => {
    // Criterion 6. Scripts write a file and exit; nothing about signing is
    // visible to them, and no script needs the secret or the token.
    const { before, mod } = await stageDownload( 'Untouched_By_Script.docx' );

    const { links } = mod.buildDownloadLinks( { before } );
    assert.deepEqual( links.map( ( l ) => l.filename ), [ 'Untouched_By_Script.docx' ] );
  } );
} );

// ---------------------------------------------------------------------------
// Request authorisation wiring
// ---------------------------------------------------------------------------

describe( 'TNX-FEAT-SIGNEDURLS: server-http wiring', () => {
  /**
   * Read the authoriseDocumentRequest body out of server-http.js.
   * @returns {string}
   */
  function authoriseSource() {
    const src = readFileSync(
      new URL( '../server-http.js', import.meta.url ), 'utf8' );
    const start = src.indexOf( 'function authoriseDocumentRequest' );
    assert.notEqual( start, -1, 'authoriseDocumentRequest must exist' );
    return src.slice( start, src.indexOf( '\n}', start ) );
  }

  test( 'the filename is validated before authorisation on both routes', () => {
    const src = readFileSync( new URL( '../server-http.js', import.meta.url ), 'utf8' );

    for ( const route of [ "app.get( '/download/:filename'", "app.get( '/preview/:filename'" ] ) {
      const start = src.indexOf( route );
      assert.notEqual( start, -1, `${ route } must exist` );
      const body = src.slice( start, start + 3000 );

      const nameAt = body.indexOf( 'isSafeFilename( safeName )' );
      const authAt = body.indexOf( 'authoriseDocumentRequest( req, safeName )' );

      assert.notEqual( authAt, -1, `${ route } must call the shared authoriser` );
      assert.ok( nameAt !== -1 && nameAt < authAt,
        `${ route } must normalise the filename before verifying a signature over it` );
    }
  } );

  test( 'a signed request never falls through to the token path', () => {
    const body = authoriseSource();

    // If a failed signature could fall through to the global token, expiry
    // would be unenforceable for anyone holding that token.
    assert.match( body, /hasSignedParams/ );
    assert.match( body, /return \{ ok: false, status: 403/ );
  } );

  test( 'signature failures return 403, matching the spec', () => {
    const body = authoriseSource();
    assert.match( body, /status: 403/ );
    assert.match( body, /expired:/ );
    assert.match( body, /bad_signature:/ );
  } );

  test( 'legacy token acceptance is gated and defaults to on for rollout', () => {
    const src = readFileSync( new URL( '../server-http.js', import.meta.url ), 'utf8' );
    assert.match( src, /function legacyDownloadTokenAllowed/ );
    assert.match( src, /ALLOW_LEGACY_DOWNLOAD_TOKEN \|\| 'true'/ );
  } );
} );
