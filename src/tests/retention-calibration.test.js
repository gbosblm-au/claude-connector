// src/tests/retention-calibration.test.js  v1.0.0
// ---------------------------------------------------------------------------
// Retention calibration: signed-link lifetime, artefact deletion, sidebar TTL.
//
// WHY THIS FILE EXISTS
// --------------------
// Three settings govern how long a generated document remains usable, and they
// live in two separate deployments:
//
//   1. LINK_EXPIRY_SECONDS   (here, src/utils/signedUrls.js)  -- 259200s / 3d
//   2. DOWNLOADS_TTL_HOURS   (here, src/server-http.js)       -- 72h     / 3d
//   3. DOCUMENT_TTL_DAYS     (Gateway Service, ti-documents)  -- 3       / 3d
//
// The Gateway Service persists the connector's signed download_url and
// preview_url onto a document row and the sidebar serves them unchanged for
// that row's entire life. So if (1) is shorter than (3), every Preview and
// Download button in the sidebar is dead while the countdown beside it still
// shows days remaining. Nothing errors until a user clicks, which is how the
// previous configuration -- a 1 hour link lifetime against a 14 day row TTL --
// survived unnoticed: buttons died after an hour and stayed visible for a
// fortnight.
//
// Ordering also matters between (1) and (2). The reaper keys off file mtime and
// links are minted at file-creation time, so (2) must be >= (1). Equal is fine
// and means the file outlives its link by up to one sweep interval, which is
// the safe direction: a late user gets "link expired" rather than a 404 on a
// link that still looks valid.
//
// These tests fail if one value is changed without the others.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname( fileURLToPath( import.meta.url ) );

/** The single source of truth this suite enforces. */
const TARGET_DAYS    = 3;
const TARGET_SECONDS = TARGET_DAYS * 24 * 3600;   // 259200
const TARGET_HOURS   = TARGET_DAYS * 24;          // 72

const ENV_KEYS = [ 'LINK_EXPIRY_SECONDS', 'DOWNLOADS_TTL_HOURS', 'SIGNED_URL_SECRET' ];
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
  process.env.SIGNED_URL_SECRET = 'c'.repeat( 64 );
} );

/**
 * server-http.js cannot be imported in a test: it binds a port and starts
 * sweepers at module scope. The constant is read from source instead, which is
 * sufficient because the assertion is about the literal default.
 */
function downloadsTtlHoursDefault() {
  const src = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' );
  const m = src.match(
    /const\s+DOWNLOADS_TTL_HOURS\s*=\s*parseInt\(\s*process\.env\.DOWNLOADS_TTL_HOURS\s*\|\|\s*String\(([^)]+)\)/
  );
  assert.ok( m, 'DOWNLOADS_TTL_HOURS must remain a parseInt over an env var with a String() default' );
  // The default is written as an arithmetic expression (3 * 24) for legibility.
  const expr = m[ 1 ].trim();
  assert.ok( /^[\d\s*+]+$/.test( expr ), `unexpected default expression: ${ expr }` );
  // eslint-disable-next-line no-new-func
  return Function( `"use strict"; return (${ expr });` )();
}

// ---------------------------------------------------------------------------

describe( 'retention calibration: the three settings agree', () => {
  test( 'the signed-link default lifetime is 3 days', async () => {
    const { linkExpirySeconds } = await import( '../utils/signedUrls.js' );

    assert.equal( linkExpirySeconds(), TARGET_SECONDS );
    assert.equal( linkExpirySeconds() / 86400, TARGET_DAYS );
  } );

  test( 'the downloads reaper default is 3 days', () => {
    assert.equal( downloadsTtlHoursDefault(), TARGET_HOURS );
    assert.equal( downloadsTtlHoursDefault() / 24, TARGET_DAYS );
  } );

  test( 'the reaper never deletes a file while its link is still valid', async () => {
    const { linkExpirySeconds } = await import( '../utils/signedUrls.js' );

    const reaperSeconds = downloadsTtlHoursDefault() * 3600;

    assert.ok( reaperSeconds >= linkExpirySeconds(),
      `DOWNLOADS_TTL_HOURS (${ reaperSeconds }s) must be >= LINK_EXPIRY_SECONDS ` +
      `(${ linkExpirySeconds() }s), or a valid link can point at a deleted file` );
  } );

  test( 'an issued link expires exactly 3 days out', async () => {
    const { buildSignedQuery } = await import( '../utils/signedUrls.js' );

    const now = 1_800_000_000;
    const { exp } = buildSignedQuery( { filename: 'Report.docx', now } );

    assert.equal( exp - now, TARGET_SECONDS );
  } );

  test( 'a link is still valid at 2 days 23 hours and refused just past 3 days', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    const now = 1_800_000_000;
    const { exp, sig } = buildSignedQuery( { filename: 'Report.docx', now } );

    const at = ( offset ) =>
      verifySignedRequest( { filename: 'Report.docx', exp, sig, now: now + offset } );

    // The previous 1 hour default failed this first assertion, which is the
    // regression being locked down.
    assert.equal( at( 3600 ).ok, true, 'valid at 1 hour' );
    assert.equal( at( 86400 ).ok, true, 'valid at 1 day' );
    assert.equal( at( TARGET_SECONDS - 3600 ).ok, true, 'valid at 2d23h' );
    assert.equal( at( TARGET_SECONDS + 60 ).ok, false, 'refused just past 3 days' );
    assert.equal( at( TARGET_SECONDS + 60 ).reason, 'expired' );
  } );

  test( 'a sidebar link survives the whole 3 day row lifetime', async () => {
    const { buildSignedQuery, verifySignedRequest } = await import( '../utils/signedUrls.js' );

    // Simulates the real sequence: the connector mints the link, the Gateway
    // Service stores it on a row with a DOCUMENT_TTL_DAYS lifetime, and the
    // sidebar serves it unchanged until the row expires.
    const now = 1_800_000_000;
    const { exp, sig } = buildSignedQuery( { filename: 'Report.docx', now } );
    const rowExpiresAt = now + ( TARGET_DAYS * 86400 );

    // Sample every 6 hours across the row's life.
    for ( let t = now; t < rowExpiresAt; t += 6 * 3600 ) {
      const v = verifySignedRequest( { filename: 'Report.docx', exp, sig, now: t } );
      assert.equal( v.ok, true,
        `the sidebar link must work at +${ ( ( t - now ) / 3600 ).toFixed( 0 ) }h, ` +
        `which is inside the row's ${ TARGET_DAYS } day lifetime` );
    }
  } );

  test( 'the environment overrides still work and remain capped', async () => {
    const mod = await import( '../utils/signedUrls.js' );

    process.env.LINK_EXPIRY_SECONDS = '600';
    assert.equal( mod.linkExpirySeconds(), 600, 'an operator can still shorten the window' );

    process.env.LINK_EXPIRY_SECONDS = '999999999';
    assert.equal( mod.linkExpirySeconds(), 30 * 24 * 3600, 'the 30 day cap still applies' );

    delete process.env.LINK_EXPIRY_SECONDS;
    assert.equal( mod.linkExpirySeconds(), TARGET_SECONDS );
    assert.ok( TARGET_SECONDS < 30 * 24 * 3600,
      'the 3 day default must sit under the cap, or the cap would silently clamp it' );
  } );
} );

describe( 'retention calibration: documentation matches the code', () => {
  test( '.env.example advertises the calibrated values', () => {
    const env = readFileSync( join( HERE, '..', '..', '.env.example' ), 'utf8' );

    assert.ok( env.includes( 'LINK_EXPIRY_SECONDS=259200' ),
      '.env.example must show the 3 day link lifetime' );
    assert.ok( env.includes( 'DOWNLOADS_TTL_HOURS=72' ),
      '.env.example must document the download reaper, which was previously undocumented' );
    assert.ok( /DOCUMENT_TTL_DAYS/.test( env ),
      '.env.example must point operators at the Gateway Service setting too, ' +
      'because changing one of the three alone reintroduces the mismatch' );
  } );

  test( 'the boot log reports the calibrated reaper window', () => {
    const src = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' );

    assert.ok( src.includes( 'DOWNLOADS_TTL_HOURS / 24' ),
      'the startup line must keep reporting the window in days so a ' +
      'misconfiguration is visible in the logs at boot' );
  } );
} );

// ---------------------------------------------------------------------------
// v13.37.0 -- TENAX-2026-10-09-01. C-CALIBRATION and C-NEG-STALE-LINK: the
// ordering reaper >= link is ENFORCED, not only documented. The coding delivery
// tool publishes into the same directory under the same reaper, so a reaper
// shorter than the link would turn a delivered project's link into a 404.
// ---------------------------------------------------------------------------

describe( 'retention calibration: reaper >= link is enforced (v13.37.0)', () => {
  test( 'C-CALIBRATION: a reaper configured below the link lifetime runs at the link lifetime, and says so', async () => {
    const { calibrateDownloadsTtl, fileOutlivesLink } = await import( '../utils/retentionCalibration.js' );
    const { linkExpirySeconds } = await import( '../utils/signedUrls.js' );

    for ( const configured of [ 1, 24, 71 ] ) {
      const c = calibrateDownloadsTtl( configured, linkExpirySeconds() );
      assert.equal( c.raised, true, `${ configured }h was not raised` );
      assert.equal( c.hours, TARGET_HOURS );
      assert.ok( fileOutlivesLink( c.hours, linkExpirySeconds() ) );
      assert.match( c.message, /DOWNLOADS_TTL_HOURS=\d+ is shorter than the 72h signed-link lifetime/ );
    }
    // Equal or longer is left alone.
    for ( const configured of [ 72, 96, 24 * 14 ] ) {
      const c = calibrateDownloadsTtl( configured, linkExpirySeconds() );
      assert.deepEqual( [ c.raised, c.hours, c.message ], [ false, configured, null ] );
    }
    // A link lifetime that is not a whole number of hours rounds UP, never down.
    assert.equal( calibrateDownloadsTtl( 1, 3601 ).hours, 2 );
    // An operator who shortens the link gets no forced change to the reaper.
    process.env.LINK_EXPIRY_SECONDS = '600';
    assert.equal( calibrateDownloadsTtl( 72, linkExpirySeconds() ).raised, false );
  } );

  test( 'C-NEG-STALE-LINK: no configuration leaves a file reaped while its link still verifies', async () => {
    const { calibrateDownloadsTtl } = await import( '../utils/retentionCalibration.js' );
    const { buildSignedQuery, verifySignedRequest, linkExpirySeconds } = await import( '../utils/signedUrls.js' );

    const minted = 1_800_000_000;
    const { exp, sig } = buildSignedQuery( { filename: 'widget-d1.zip', now: minted } );
    for ( const configured of [ 1, 12, 48, 72 ] ) {
      const reaperHours = calibrateDownloadsTtl( configured, linkExpirySeconds() ).hours;
      const reapedAt = minted + reaperHours * 3600;
      // The instant before the reaper may take the file, the link must already
      // have stopped verifying (or be exactly at its end): otherwise the user
      // holds a link that verifies and a file that is gone -- a 404.
      const atReap = verifySignedRequest( { filename: 'widget-d1.zip', exp, sig, now: reapedAt + 1 } );
      assert.equal( atReap.ok, false, `DOWNLOADS_TTL_HOURS=${ configured }: the link still verifies when the file is reaped` );
      assert.equal( atReap.reason, 'expired' );
    }
  } );

  test( 'the reaper sweeps at the calibrated window, not the raw configured one', () => {
    const code = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' )
      .replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' );
    assert.match( code, /const DOWNLOADS_REAPER = calibrateDownloadsTtl\(DOWNLOADS_TTL_HOURS, linkExpirySeconds\(\)\);/ );
    const sweep = code.slice( code.indexOf( 'function sweepExpiredDownloads()' ) );
    assert.match( sweep.slice( 0, 300 ), /ttlHours:\s+DOWNLOADS_REAPER_HOURS,/ );
    assert.match( code, /if \(DOWNLOADS_REAPER\.raised\) log\('warn'/ );
  } );
} );
