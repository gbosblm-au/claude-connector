// src/tests/route-inventory.test.js   (claude-connector v13.37.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-09-01 C-NO-NEW-PUBLIC-WRITE and C-NEG-UNAUTH-PUSH: no new route
// writes into /data/downloads, and in particular no unauthenticated one.
//
// The work order records why (section 2E): /data/upload is unauthenticated by
// design, because the browser cannot hold MCP_API_KEY, and v13.29.0 removed
// archive ingest from it for exactly that reason. Route A1 therefore adds NO
// route: the delivered archive arrives through the tool layer
// (coding_deliverable_publish, reached by POST /tool-call with the restore
// token, or by an MCP tool call).
//
// Two checks, both against comment-free source:
//
//   1. The inventory. Every mutating route registration (post, put, patch,
//      delete) across src/ is listed here with the credential it requires. A
//      new one fails this test until it is added, deliberately, with the
//      credential named. The 13.36.0 inventory was read at source for this
//      list; v13.37.0 adds none.
//   2. The writers. Only the modules named here may write a file into the
//      downloads directory, and none of them is a route handler.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

/** Source without comments, so prose that names a route is not counted as one. */
function code( abs ) {
  return readFileSync( abs, 'utf8' ).replace( /\r\n/g, '\n' )
    .replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' );
}

/** Every .js file under src/, tests excluded. */
function sources( dir = SRC, out = [] ) {
  for ( const name of readdirSync( dir ) ) {
    const abs = join( dir, name );
    const st = statSync( abs );
    if ( st.isDirectory() ) {
      if ( name === 'tests' || name === 'node_modules' || name === '__pycache__' ) continue;
      sources( abs, out );
    } else if ( name.endsWith( '.js' ) && ! name.endsWith( '.test.js' ) ) {
      out.push( abs );
    }
  }
  return out;
}

/**
 * The mutating routes, and what each requires. `public` marks the two
 * deliberately unauthenticated browser routes; neither writes to downloads.
 */
const MUTATING_ROUTES = Object.freeze( {
  'POST /internal/config/env': 'internal config token',
  'POST /messages': 'MCP session (mcpAuth)',
  'POST /webhook': 'webhook secret',
  'POST /upload/connections': 'MCP_API_KEY',
  'POST /data/upload': 'public (browser staging, writes /data/uploads only)',
  'POST /restore-skill': 'X-Railway-Restore-Token',
  'POST /restore-profiles': 'X-Railway-Restore-Token',
  'POST /restore-modules': 'X-Railway-Restore-Token',
  'POST /restore-personality': 'X-Railway-Restore-Token',
  'POST /restore-dispatch-rules': 'X-Railway-Restore-Token',
  'POST /restore-archive': 'X-Railway-Restore-Token',
  'POST /restore-references': 'X-Railway-Restore-Token',
  'POST /restore-scripts': 'X-Railway-Restore-Token',
  'POST /tool-call': 'X-Railway-Restore-Token',
  'POST /data/upload-binary': 'public (browser staging, writes /data/uploads only)',
  'POST /set-modular-mode': 'MCP_API_KEY',
  'POST /brain-scan': 'MCP_API_KEY',
  'POST /ti-skill-compile': 'X-Railway-Restore-Token',
  'POST /ti-skill-check-scope': 'X-Railway-Restore-Token',
  'POST /homework/parse-upload': 'X-Railway-Restore-Token',
  'POST /provision': 'provision token',
  'POST /voice/transcribe': 'voice credential',
  'POST /voice/elevenlabs/probe': 'voice credential',
  'POST /voice/synthesize': 'voice credential',
  'POST /voice/synthesize/stream': 'voice credential',
  'POST /voice/synthesize/incremental': 'voice credential',
  'POST /voice/prosody/analyse': 'voice credential',
  'POST /volume-restore': 'MCP_API_KEY (authorise)',
} );

/**
 * Tool-layer modules that write into the downloads directory. The first three
 * predate v13.37.0 (the gateway render, edit and validation tools, reached by
 * /tool-call or MCP); the delivery tool is the one v13.37.0 adds. None is a
 * route handler.
 */
const DOWNLOADS_WRITERS = Object.freeze( [
  'tools/coding-delivery.js',
  'tools/edit-tools.js',
  'tools/render-tools.js',
  'tools/validation-tools.js',
] );

/** Every mutating registration in the source, as "METHOD /path". */
function mutatingRegistrations() {
  const found = [];
  for ( const abs of sources() ) {
    const src = code( abs );
    for ( const m of src.matchAll( /\bapp\.(post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g ) ) {
      found.push( `${ m[ 1 ].toUpperCase() } ${ m[ 3 ] }` );
    }
  }
  return found.sort();
}

test( 'C-NO-NEW-PUBLIC-WRITE: the mutating routes are exactly the inventoried ones', () => {
  const found = mutatingRegistrations();
  const listed = Object.keys( MUTATING_ROUTES ).sort();
  assert.ok( found.length >= 20, `floor: only ${ found.length } registrations found, the scan is broken` );
  const added = found.filter( ( r ) => ! listed.includes( r ) );
  const removed = listed.filter( ( r ) => ! found.includes( r ) );
  assert.deepEqual( added, [],
    'a mutating route was added. If it is authenticated, add it to MUTATING_ROUTES with its credential; '
    + 'if it accepts files for /data/downloads without one, it is the push path TENAX-2026-10-09-01 '
    + 'section 2E rejects.' );
  assert.deepEqual( removed, [], 'an inventoried route is gone; remove it from MUTATING_ROUTES' );
} );

test( 'C-NEG-UNAUTH-PUSH: no route handler writes into the downloads directory', () => {
  const routeFiles = sources().filter( ( abs ) => /\bapp\.(post|put|patch|delete)\(/.test( code( abs ) ) );
  for ( const abs of routeFiles ) {
    const src = code( abs );
    // A downloads-directory constant or helper used by a write call in the same file.
    const writesDownloads = /(writeFile|writeFileSync|createWriteStream|renameSync|rename|copyFile|copyFileSync)\([^;]*(DOWNLOADS_DIR|DOWNLOADS_BASE|downloadsBase\(\))/.test( src );
    assert.ok( ! writesDownloads, `${ relative( SRC, abs ) } writes into the downloads directory from a route file` );
  }
  // The two public routes stage into /data/uploads and nowhere else.
  const server = code( join( SRC, 'server-http.js' ) );
  for ( const route of [ "'/data/upload'", "'/data/upload-binary'" ] ) {
    const start = server.indexOf( `app.post(${ route }` );
    assert.ok( start > 0, `found ${ route }` );
    const next = server.indexOf( '\napp.', start + 10 );
    const body = server.slice( start, next > start ? next : undefined );
    assert.ok( ! /DOWNLOADS_DIR|DOWNLOADS_BASE|downloadsBase\(\)/.test( body ), `${ route } references the downloads directory` );
  }
} );

test( 'the downloads writers are the inventoried tool-layer modules, and the delivery tool registers no route', () => {
  const writers = [];
  for ( const abs of sources() ) {
    const rel = relative( SRC, abs ).split( '\\' ).join( '/' );
    if ( rel === 'server-http.js' ) continue;
    const src = code( abs );
    if ( /downloadsBase\(\)/.test( src ) && /(writeFileSync|renameSync)\(/.test( src ) ) writers.push( rel );
  }
  assert.deepEqual( writers.sort(), [ ...DOWNLOADS_WRITERS ].sort() );
  const delivery = code( join( SRC, 'tools', 'coding-delivery.js' ) );
  assert.ok( ! /\bapp\.|express\(|Router\(/.test( delivery ), 'the delivery tool registers a route' );
} );
