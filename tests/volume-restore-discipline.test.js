// tests/volume-restore-discipline.test.js  (claude-connector v13.39.0)
//
// TENAX-2026-10-15-01 H-2, connector half, on the volume restore:
//
//   C-RESTORE-INSPECTED (connector)  POST /volume-restore runs the helper's
//       read-only inspect pass before extract writes anything; an archive the
//       inspect pass cannot read is refused with nothing written
//   C-WRITE-DECLARED-REFUSED / C-WRITE-CAPTURED  a restore while another
//       process holds a claim on any store family is refused (409), names the
//       holder, extracts nothing and captures the uploaded archive
//
// Same shape as tests/volume-snapshot.test.js: a real volume in a temp
// directory, the real routes on a throwaway express app, the real Python helper.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const TOKEN = 'test-restore-token-h2-discipline';
const ROOT = mkdtempSync( join( tmpdir(), 'vrestore-h2-' ) );
const SKILL_DIR = join( ROOT, 'skill' );
const AVA_DIR = join( SKILL_DIR, 'ava' );
const DOWNLOADS_DIR = join( ROOT, 'downloads' );
const TMP_DIR = join( ROOT, 'tmp' );

process.env.RAILWAY_RESTORE_TOKEN = TOKEN;
process.env.SKILL_FILE_PATH = join( SKILL_DIR, 'SKILL.md' );
process.env.DOWNLOADS_DIR = DOWNLOADS_DIR;
process.env.AVA_MODULAR_DIR = AVA_DIR;
process.env.SNAPSHOT_TMP_DIR = TMP_DIR;
process.env.TS_CLIENT_MODE = 'owner';
process.env.LOG_LEVEL = 'error';

let server;
let baseUrl;
let D;

before( async () => {
  for ( const d of [ 'modules/finance', 'references/erp', 'scripts', 'archive' ] ) mkdirSync( join( AVA_DIR, d ), { recursive: true } );
  mkdirSync( DOWNLOADS_DIR, { recursive: true } );
  mkdirSync( TMP_DIR, { recursive: true } );
  writeFileSync( join( AVA_DIR, 'CORE.md' ), '# Core\n' );
  writeFileSync( join( AVA_DIR, 'modules', 'finance', 'aml.md' ), '# AML v1\n' );
  writeFileSync( join( AVA_DIR, 'references', 'erp', 'checklist.md' ), '# Checklist v1\n' );

  const express = ( await import( 'express' ) ).default;
  const { registerVolumeSnapshotRoutes } = await import( '../src/routes/volume-snapshot.js' );
  D = await import( '../src/utils/storeWriteDiscipline.js' );
  const app = express();
  registerVolumeSnapshotRoutes( app );
  server = await new Promise( ( r ) => { const s = app.listen( 0, '127.0.0.1', () => r( s ) ); } );
  baseUrl = `http://127.0.0.1:${ server.address().port }`;
} );

after( async () => {
  if ( server ) await new Promise( ( r ) => server.close( r ) );
  rmSync( ROOT, { recursive: true, force: true } );
} );

async function snapshot() {
  const res = await fetch( `${ baseUrl }/volume-snapshot?include_downloads=0`, { headers: { 'X-Railway-Restore-Token': TOKEN } } );
  assert.equal( res.status, 200 );
  return Buffer.from( await res.arrayBuffer() );
}

async function restore( body ) {
  return fetch( `${ baseUrl }/volume-restore?scan=0`, {
    method: 'POST',
    headers: { 'X-Railway-Restore-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body,
  } );
}

test( 'C-RESTORE-INSPECTED: the restore reports the inspect pass it ran before extracting', async () => {
  const archive = await snapshot();
  writeFileSync( join( AVA_DIR, 'modules', 'finance', 'aml.md' ), '# AML changed\n' );
  const res = await restore( archive );
  const json = await res.json();
  assert.equal( res.status, 200, JSON.stringify( json ) );
  assert.ok( json.inspect, 'the inspect result travels in the response' );
  assert.equal( json.inspect.ok, true );
  assert.ok( json.inspect.ava_file_count >= 3 );
  assert.equal( readFileSync( join( AVA_DIR, 'modules', 'finance', 'aml.md' ), 'utf8' ), '# AML v1\n', 'restored' );
  assert.equal( D.activeClaim( 'modules' ), null, 'the restore released its claims' );
} );

test( 'C-RESTORE-INSPECTED: an archive the inspect pass cannot read is refused before any write', async () => {
  // Valid gzip, not a tar: passes the magic-byte check, fails inspection.
  const notTar = gzipSync( Buffer.from( 'this is not a tar archive at all '.repeat( 40 ) ) );
  writeFileSync( join( AVA_DIR, 'references', 'erp', 'checklist.md' ), '# Checklist kept\n' );
  const res = await restore( notTar );
  const json = await res.json();
  assert.equal( res.status, 400, JSON.stringify( json ) );
  assert.match( json.error, /Inspect pass failed; nothing was written/ );
  assert.equal( readFileSync( join( AVA_DIR, 'references', 'erp', 'checklist.md' ), 'utf8' ), '# Checklist kept\n' );
} );

test( 'C-WRITE-DECLARED-REFUSED: a restore while a store is claimed is refused with the holder named, and the upload captured', async () => {
  const archive = await snapshot();
  writeFileSync( join( AVA_DIR, 'modules', 'finance', 'aml.md' ), '# AML live edit\n' );
  const claim = D.declareClaim( 'modules', { kind: 'operator', label: 'brian', purpose: 'editing modules by hand' } );
  assert.equal( claim.ok, true );
  try {
    const res = await restore( archive );
    const json = await res.json();
    assert.equal( res.status, 409, JSON.stringify( json ) );
    assert.equal( json.refusal.holder.id, 'operator:brian' );
    assert.match( json.error, /operator:brian/ );
    assert.equal( readFileSync( join( AVA_DIR, 'modules', 'finance', 'aml.md' ), 'utf8' ), '# AML live edit\n', 'nothing extracted' );
    const dir = join( AVA_DIR, '.store-discipline', json.refusal.forensics );
    const manifest = JSON.parse( readFileSync( join( dir, 'manifest.json' ), 'utf8' ) );
    const captured = manifest.files.find( ( f ) => f.role === 'attempted' );
    assert.equal( captured.bytes, archive.length, 'the whole upload is captured, not discarded' );
    assert.ok( existsSync( join( dir, captured.captured_as ) ) );
  } finally {
    D.releaseClaim( 'modules', claim.claim.claim_id );
  }
} );
