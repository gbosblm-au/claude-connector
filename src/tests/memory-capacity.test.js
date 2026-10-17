// src/tests/memory-capacity.test.js  (claude-connector v13.40.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-17-03, connector half: the memory ceiling as a runtime value.
//
//   C-VAR-DEFAULT        unset, the ceiling is 1000 from the default
//   C-VAR-READS          a valid MEMORY_CAPACITY_PER_SCOPE changes the ceiling on
//                        both connector write paths (SQLite, and the
//                        WordPress/tenant path that writes to the gateway), and
//                        they refuse BEFORE the gateway is called
//   C-VAR-STRICT /       the shared fixture's resolver cases, through this
//   C-VAR-BOUNDS         tree's copy of the shared file
//   C-REFUSAL-NAMES-VAR  the refusal names the variable, the limit and its source
//   C-NO-EVICTION        nothing is removed at the ceiling; an existing key
//   C-UPDATE-ALWAYS      still updates
//   C-HEALTH-REPORTS     the boot line and the authenticated /health report the
//                        resolved value
//   C-TEST-INDEPENDENT   the test's own explicit ceiling (CAP), not the constant
//
// The variable is set to CAP before the guard loads, so every module this file
// imports resolves CAP. Each test file runs in its own process.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank } from './helpers/source-scan.js';

/** The explicit ceiling this file tests at (C-TEST-INDEPENDENT). */
const CAP = 120;
process.env.MEMORY_CAPACITY_PER_SCOPE = String( CAP );

const HERE = dirname( fileURLToPath( import.meta.url ) );
const ROOT = join( HERE, '..', '..' );
const FIXTURE = JSON.parse( readFileSync( join( HERE, 'fixtures', 'memory-guard-fixture.json' ), 'utf8' ) );

const G = await import( '../tools-memory/memoryWriteGuard.js' );
const { initDb, getDb, closeDb } = await import( '../tools-memory/db.js' );
const { handleMemoryWrite } = await import( '../tools-memory/memory-write.js' );
const { handleWpMemoryWrite } = await import( '../tools-memory/wp-memory.js' );

/** The matches of `re` that start in code, not in a comment or a string. */
function codeMatches( rel, re ) {
  const raw = readFileSync( join( ROOT, rel ), 'utf8' );
  const blanked = blank( raw );
  return [ ...raw.matchAll( re ) ].filter( ( m ) => blanked[ m.index ] === raw[ m.index ] );
}

async function rejects( p, code ) {
  try {
    await p;
  } catch ( err ) {
    assert.equal( err.code, code, err.message );
    return err;
  }
  assert.fail( `expected ${ code }, but the call succeeded` );
}

describe( 'the ceiling as a runtime value', () => {
  test( 'C-VAR-DEFAULT: with the variable unset the ceiling is 1000, from the default', () => {
    const r = spawnSync( process.execPath, [ '--input-type=module', '-e',
      "import * as G from './src/tools-memory/memoryWriteGuard.js'; console.log( JSON.stringify( [ G.MEMORY_CAPACITY_PER_SCOPE, G.MEMORY_CAPACITY ] ) );" ],
    { cwd: ROOT, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 } );
    assert.equal( r.status, 0, r.stderr );
    assert.deepEqual( JSON.parse( r.stdout ), [ 1000, { limit: 1000, source: 'default', raw: null, warning: null } ] );
  } );

  test( 'C-VAR-STRICT / C-VAR-BOUNDS: every shared fixture case resolves as recorded', () => {
    assert.ok( FIXTURE.capacity_env.length >= 19 );
    for ( const c of FIXTURE.capacity_env ) {
      const r = G.resolveMemoryCapacity( c.value === null ? {} : { MEMORY_CAPACITY_PER_SCOPE: c.value } );
      assert.deepEqual( { limit: r.limit, source: r.source, warned: r.warning !== null }, c.expect, `capacity_env ${ c.id }` );
      assert.ok( Number.isInteger( r.limit ) && r.limit >= G.MEMORY_CAPACITY_MIN && r.limit <= G.MEMORY_CAPACITY_MAX );
    }
  } );

  test( 'C-HEALTH-REPORTS: the boot line and the authenticated /health report the resolved value and its source', () => {
    assert.equal( G.describeMemoryCapacity(), `Memory ceiling: ${ CAP } entries/scope (MEMORY_CAPACITY_PER_SCOPE=${ CAP })` );
    assert.equal( codeMatches( 'src/server-http.js', /log\(MEMORY_CAPACITY\.warning \? "warn" : "info", describeMemoryCapacity\(MEMORY_CAPACITY\)\);/g ).length, 1, 'the boot line' );
    assert.equal( codeMatches( 'src/server-http.js', /memory_store: \{\s*capacity_per_scope: MEMORY_CAPACITY\.limit,\s*source: MEMORY_CAPACITY\.source,/g ).length, 1, '/health' );
  } );
} );

describe( 'C-VAR-READS on the SQLite store', () => {
  let dbDir = null;
  before( () => { dbDir = mkdtempSync( join( tmpdir(), 'mcap-' ) ); initDb( join( dbDir, 'memory.sqlite' ) ); } );
  after( () => { closeDb(); if ( dbDir ) rmSync( dbDir, { recursive: true, force: true } ); } );
  beforeEach( () => getDb().exec( 'DELETE FROM memories' ) );
  const count = () => getDb().prepare( 'SELECT COUNT(*) AS n FROM memories' ).get().n;

  test( 'C-VAR-READS / C-REFUSAL-NAMES-VAR / C-NO-EVICTION / C-UPDATE-ALWAYS: at CAP a new key is refused, naming the variable; nothing is removed; an existing key updates', async () => {
    const base = Date.parse( '2026-01-01T00:00:00.000Z' );
    const insert = getDb().prepare(
      `INSERT INTO memories (id, category, key, value, tags, created_at, updated_at, ttl, recheck_class, recheck_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, NULL, NULL, NULL)` );
    getDb().transaction( () => {
      for ( let i = 0; i < CAP; i += 1 ) {
        const at = new Date( base + i * 60000 ).toISOString();
        insert.run( randomUUID(), 'session', `k${ String( i ).padStart( 4, '0' ) }`, JSON.stringify( `entry number ${ i }` ), at, at );
      }
    } )();
    assert.equal( count(), CAP );
    const err = await rejects( handleMemoryWrite( { category: 'session', key: 'one-more', value: 'one entry too many for this scope' } ), 'MEMORY_AT_CAPACITY' );
    assert.deepEqual( [ err.details.limit, err.details.count, err.details.limit_source, err.details.limit_variable ], [ CAP, CAP, 'env', 'MEMORY_CAPACITY_PER_SCOPE' ] );
    assert.match( err.message, new RegExp( `The ceiling \\(${ CAP }, set by MEMORY_CAPACITY_PER_SCOPE\\)` ) );
    assert.equal( count(), CAP, 'nothing evicted' );
    assert.equal( ( await handleMemoryWrite( { category: 'session', key: 'k0000', value: 'entry number 0, revised' } ) ).operation, 'updated' );
    assert.equal( count(), CAP );
  } );
} );

describe( 'C-VAR-READS on the WordPress/tenant path: refused here, before the gateway is called', () => {
  let server;
  const calls = [];
  let stats = CAP;

  before( async () => {
    server = createServer( ( req, res ) => {
      let body = '';
      req.on( 'data', ( c ) => { body += c; } );
      req.on( 'end', () => {
        const path = req.url.split( '?' )[ 0 ].replace( /^\/memory/, '' );
        calls.push( path );
        const replies = {
          '/stats': { categories: [ { category: 'bulk', count: stats } ] },
          '/list': { entries: [ { category: 'bulk', key: 'k0000', value: '"entry 0"', updated_at: '2026-01-01T00:00:00.000Z' } ] },
          '/upsert': { id: 'x1', operation: 'created', updated_at: '2026-10-17T00:00:00.000Z' },
        };
        if ( ! replies[ path ] ) { res.writeHead( 404 ); res.end( '{}' ); return; }
        res.writeHead( 200, { 'Content-Type': 'application/json' } );
        res.end( JSON.stringify( replies[ path ] ) );
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
  } );

  test( 'a scope at CAP refuses a new key with the variable named, and nothing is sent to the gateway\'s upsert', async () => {
    calls.length = 0;
    stats = CAP;
    const err = await rejects( handleWpMemoryWrite( { category: 'facts', key: 'new', value: 'a brand new fact about the garden' } ), 'MEMORY_AT_CAPACITY' );
    assert.deepEqual( [ err.details.limit, err.details.limit_source, err.details.limit_variable ], [ CAP, 'env', 'MEMORY_CAPACITY_PER_SCOPE' ] );
    assert.ok( ! calls.includes( '/upsert' ), 'the connector refused first' );
    calls.length = 0;
    stats = CAP - 1;
    await handleWpMemoryWrite( { category: 'facts', key: 'new', value: 'a brand new fact about the garden' } );
    assert.ok( calls.includes( '/upsert' ), 'one under the ceiling, the write goes through' );
  } );
} );
