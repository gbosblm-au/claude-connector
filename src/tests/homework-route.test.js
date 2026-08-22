// src/tests/homework-route.test.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6.
//
// The route is mounted on a real express app and driven over a live socket
// with real .docx bytes. Nothing about the parsing path is mocked: the only
// thing this file supplies that production would not is the credential and the
// registry rows, both of which the gateway supplies for real.
//
// The auth assertions matter more than they look. A connector route that the
// gateway cannot reach fails SILENTLY -- the upload simply never parses, and
// the tutor sees an empty result rather than an error. That is exactly how
// /voice/synthesize/stream stayed broken from v12.53.0 to v13.4.0, and the
// same mistake was available here.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSelfAuthenticatedPath } from '../middleware/mcpAuth.js';

const DIR = mkdtempSync( join( tmpdir(), 'hw-route-' ) );
const KEY = 'test-key-for-homework-route';

// Set BEFORE any module that reads them is imported.
//
// The two are checked against DIFFERENT headers, which is worth stating because
// the first draft of this file got it wrong and read as a route bug:
// MCP_API_KEY is matched against the Authorization bearer, while
// RAILWAY_RESTORE_TOKEN is matched against X-Railway-Restore-Token. Setting one
// and sending the other 401s, correctly.
//
// Production sends the restore token -- the gateway does not hold the MCP key
// -- so that is the credential these tests exercise.
process.env.MCP_API_KEY = KEY;
process.env.RAILWAY_RESTORE_TOKEN = KEY;

let docxAvailable = false;
try {
  execFileSync( 'python3', [ '-c', 'import docx' ], { stdio: 'ignore' } );
  execFileSync( 'python3', [ '-c', `
import sys
from docx import Document
out = sys.argv[1]
d = Document()
d.add_paragraph('1. What is 15% of 240?')
d.add_paragraph('Answer: 36')
d.add_paragraph('2. Simplify 18/24.')
d.add_paragraph('Answer: 3/4')
d.save(out + '/upload.docx')
`, DIR ], { stdio: 'ignore' } );
  docxAvailable = existsSync( join( DIR, 'upload.docx' ) );
} catch ( err ) {
  docxAvailable = false;
}

const REGISTRY = [
  { id: 'q1', position: 1, question_text: 'What is 15% of 240?' },
  { id: 'q2', position: 2, question_text: 'Simplify 18/24.' },
];

/** The live server, booted once. */
let app = null;

/**
 * Boot the real route on a real socket.
 *
 * @returns {Promise<{ base: string, close: Function }>}
 */
async function boot() {
  if ( app ) return app;

  process.env.USER_DATA_UPLOAD_DIR = DIR;

  const express = ( await import( 'express' ) ).default;
  const { registerHomeworkRoutes } = await import( '../routes/homework.js' );

  const server = express();
  registerHomeworkRoutes( server );

  const listening = server.listen( 0 );
  await new Promise( ( r ) => listening.once( 'listening', r ) );

  app = {
    base: `http://127.0.0.1:${ listening.address().port }`,
    close: () => new Promise( ( r ) => listening.close( r ) ),
  };
  return app;
}

test.after( async () => { if ( app ) await app.close(); } );

/**
 * POST to the route.
 *
 * @param {object} body
 * @param {object} [opts]
 * @returns {Promise<{ status: number, json: object }>}
 */
async function post( body, opts = {} ) {
  const a = await boot();
  const headers = { 'Content-Type': 'application/json' };
  if ( ! opts.noAuth ) headers[ 'X-Railway-Restore-Token' ] = opts.key || KEY;

  const res = await fetch( `${ a.base }/homework/parse-upload`, {
    method: 'POST', headers, body: JSON.stringify( body ),
  } );
  return { status: res.status, json: await res.json().catch( () => ( {} ) ) };
}

// ===========================================================================
// Reachability and credential
// ===========================================================================

test( 'the route is self-authenticated, so the gateway can actually reach it', () => {
  // Without this entry mcpAuthMiddleware answers 401 before the route runs, and
  // the upload never parses. The failure is silent: the tutor sees an empty
  // result, not an error.
  assert.equal( isSelfAuthenticatedPath( '/homework/parse-upload' ), true );

  // And no prefix leak. `exact` entries are the whole point of that list.
  assert.equal( isSelfAuthenticatedPath( '/homework/anything' ), false );
  assert.equal( isSelfAuthenticatedPath( '/homework/parse-upload/evil' ), false );
} );

test( 'being on that list does not make the route unauthenticated', async () => {
  // The list decides WHICH gate applies, not whether one does. The route still
  // verifies the same secret itself.
  const none = await post( { questions: REGISTRY, content_base64: '' }, { noAuth: true } );
  assert.equal( none.status, 401 );

  const wrong = await post( { questions: REGISTRY, content_base64: '' },
    { key: 'not-the-key' } );
  assert.equal( wrong.status, 401 );
} );

// ===========================================================================
// The happy path, with real bytes
// ===========================================================================

test( 'a real docx parses and every question matches',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, async () => {
    const bytes = readFileSync( join( DIR, 'upload.docx' ) ).toString( 'base64' );
    const r = await post( { questions: REGISTRY, content_base64: bytes } );

    assert.equal( r.status, 200 );
    assert.equal( r.json.ok, true );
    assert.deepEqual( r.json.summary, { total: 2, matched: 2, mismatched: 0, missing: 0 } );
    assert.deepEqual( r.json.assessable_positions, [ 1, 2 ] );

    // The question id travels back, so the gateway can write the answer row
    // without re-deriving which question it belongs to.
    assert.equal( r.json.rows[ 0 ].question_id, 'q1' );
    assert.equal( r.json.rows[ 0 ].student_answer, '36' );
  } );

test( 'a staged file is read by path',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, async () => {
    const r = await post( { questions: REGISTRY, filepath: 'upload.docx' } );
    assert.equal( r.status, 200 );
    assert.equal( r.json.summary.matched, 2 );
  } );

// ===========================================================================
// Path containment
// ===========================================================================

test( 'a path outside the upload directory is refused', async () => {
  for ( const bad of [ '../../etc/passwd', '/etc/passwd', '../secrets.env',
                       'subdir/../../escape.docx' ] ) {
    const r = await post( { questions: REGISTRY, filepath: bad } );
    assert.ok( [ 400, 404, 415 ].includes( r.status ),
      `${ bad } must not be read, got ${ r.status }` );
    assert.notEqual( r.status, 200 );
  }
} );

test( 'a non-docx extension is refused with a message a tutor can act on', async () => {
  writeFileSync( join( DIR, 'homework.pdf' ), 'not really a pdf' );
  const r = await post( { questions: REGISTRY, filepath: 'homework.pdf' } );

  assert.equal( r.status, 415 );
  assert.match( r.json.message, /\.docx/ );
} );

test( 'a file that is not a Word document is refused, not read as blank', async () => {
  // Parsing a PDF into empty text would report the student as having answered
  // nothing, which is a worse outcome than an error: it looks like a verdict.
  const r = await post( {
    questions: REGISTRY,
    content_base64: Buffer.from( '%PDF-1.7 not a docx' ).toString( 'base64' ),
  } );

  assert.equal( r.status, 422 );
  assert.equal( r.json.error, 'not_a_docx' );
  assert.match( r.json.message, /Word document/ );
} );

// ===========================================================================
// The registry contract
// ===========================================================================

test( 'an empty registry is refused rather than answered with zero matches', async () => {
  // "0 of 0 matched" reads to the caller as a successful parse. Section 6
  // permits marking only against a canonical question, so a set with none
  // cannot produce a markable outcome at all.
  const r = await post( { questions: [], content_base64: 'x' } );
  assert.equal( r.status, 422 );
  assert.equal( r.json.error, 'empty_registry' );
} );

test( 'a question with blank canonical text is refused loudly', async () => {
  // An empty truth matches nothing, so every answer under it would be
  // quarantined with no explanation a tutor could act on.
  const r = await post( {
    questions: [ { id: 'q1', position: 1, question_text: '   ' } ],
    content_base64: 'x',
  } );
  assert.equal( r.status, 422 );
  assert.equal( r.json.error, 'malformed_questions' );
} );

test( 'a question with no position is refused', async () => {
  const r = await post( {
    questions: [ { id: 'q1', question_text: 'What is 15% of 240?' } ],
    content_base64: 'x',
  } );
  assert.equal( r.status, 422 );
  assert.equal( r.json.error, 'malformed_questions' );
} );

test( 'missing questions or missing file are both refused', async () => {
  assert.equal( ( await post( { content_base64: 'x' } ) ).json.error, 'questions_required' );
  assert.equal( ( await post( { questions: REGISTRY } ) ).json.error, 'no_file' );
} );

// ===========================================================================
// The gate, over the wire
// ===========================================================================

test( 'a mismatched question is never reported as assessable',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, async () => {
    // The registry says one thing, the upload another. This is the 19 July
    // failure in miniature and the whole reason the gate exists.
    const altered = [
      { id: 'q1', position: 1, question_text: 'What is 15% of 240?' },
      { id: 'q2', position: 2, question_text: 'Simplify 42/56.' },
    ];
    const bytes = readFileSync( join( DIR, 'upload.docx' ) ).toString( 'base64' );
    const r = await post( { questions: altered, content_base64: bytes } );

    assert.equal( r.status, 200 );
    assert.deepEqual( r.json.assessable_positions, [ 1 ] );

    const q2 = r.json.rows.find( ( x ) => 2 === x.position );
    assert.equal( q2.match_status, 'mismatch' );
    assert.equal( q2.student_answer, '3/4',
      'the answer is still returned, so the tutor can see what was written' );
  } );

test( 'assessable_positions never disagrees with the row statuses',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, async () => {
    // The connector computes this AND the gateway filters independently. If the
    // two ever disagree the disagreement must be visible, so the invariant is
    // pinned here.
    const bytes = readFileSync( join( DIR, 'upload.docx' ) ).toString( 'base64' );
    const r = await post( { questions: REGISTRY, content_base64: bytes } );

    const fromRows = r.json.rows
      .filter( ( x ) => 'exact_match' === x.match_status )
      .map( ( x ) => x.position );

    assert.deepEqual( r.json.assessable_positions, fromRows );
  } );

test( 'an oversized upload is refused before it is inflated', async () => {
  const huge = Buffer.alloc( 11 * 1024 * 1024, 0 ).toString( 'base64' );
  const r = await post( { questions: REGISTRY, content_base64: huge } );
  assert.equal( r.status, 413 );
} );
