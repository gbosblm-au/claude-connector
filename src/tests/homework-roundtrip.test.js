// src/tests/homework-roundtrip.test.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Sections 5 and 6, the
// join between them.
//
// ===========================================================================
// THE GAP THIS CLOSES
// ===========================================================================
//
// Every other test in this area starts from a document and asks whether the
// reader copes. None of them asked the question that actually matters in
// production:
//
//   A worksheet this system GENERATED, filled in and handed back unaltered,
//   must align perfectly against the registry rows written from the same spec.
//
// If that round trip does not close, nothing else matters. A student who
// changes nothing and submits gets mismatches, and the tutor is sent to
// investigate a wording discrepancy that the system introduced itself.
//
// ===========================================================================
// WHY THE CONVENTION IS PINNED HERE AND NOT INFERRED
// ===========================================================================
//
// homework_render.py resolves from a mounted volume, not from this repository,
// so this suite cannot run it. What it can do is pin the LAYOUT CONVENTION the
// reader depends on, in one named place, and prove the reader honours it.
//
// That makes the coupling explicit rather than accidental. Today the reader
// tolerates several numbering styles; the convention below is the one the
// generator is expected to emit, and if the generator ever changes, this file
// is what fails and names the mismatch — instead of a student's homework
// silently failing to align in production.
//
// Structure that survives extraction is the only structure worth having. The
// review document is assembled from the parsed TEXT, not the original layout,
// so visual bounding buys nothing here: alignment keys on the question number
// in the text, and a number on its own line binds an answer as firmly as any
// container could.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docxToText } from '../homework/docx-text.js';
import { alignToRegistry, assessable } from '../homework/homework-extract.js';

// ===========================================================================
// The convention
// ===========================================================================

/**
 * The worksheet layout the reader depends on.
 *
 * Question number, a full stop, then the question text, all on ONE line.
 * The answer follows on the next line, labelled.
 *
 * Both halves matter and for different reasons:
 *
 *   The number must lead the line, because that is the key alignment uses. A
 *   number anywhere else in the line is question CONTENT -- "What is 15% of
 *   240" contains two numbers and neither identifies the question.
 *
 *   The question must be complete on its line, because a wrapped question is
 *   indistinguishable from a question followed by an answer, and the reader
 *   resolves that ambiguity by looking for terminal punctuation.
 */
const CONVENTION = {
  question: ( n, text ) => `${ n }. ${ text }`,
  answer: ( text ) => `Answer: ${ text }`,
};

/** The spec a generation call would carry, and the registry rows written from it. */
const SPEC_SECTIONS = [
  {
    topic: 'Percentages',
    questions: [
      { number: 1, text: 'What is 15% of 240?', answer: '36', points: 2 },
      { number: 2, text: 'Increase 80 by 25%.', answer: '100', points: 2 },
    ],
  },
  {
    topic: 'Fractions',
    questions: [
      { number: 3, text: 'Simplify 18/24.', answer: '3/4', points: 3 },
      // Deliberately awkward: currency, a thousands separator and a decimal,
      // all of which the normaliser transforms. If the generator and the reader
      // disagree about any of them, this is the question that shows it.
      { number: 4, text: 'A jacket costs $1,234.50. What is 10% off?',
        answer: '$1,111.05', points: 3 },
      // A question long enough that a renderer might wrap it.
      { number: 5, text: 'A train leaves at 09:15 and arrives at 13:40. '
        + 'How long is the journey, in hours and minutes?', answer: '4h 25m', points: 4 },
    ],
  },
];

/** The registry rows, flattened exactly as lib/homework-registry.js flattens them. */
const REGISTRY = SPEC_SECTIONS
  .flatMap( ( s ) => s.questions )
  .map( ( q, i ) => ( {
    id: `q${ i + 1 }`,
    position: i + 1,
    question_text: q.text,
  } ) );

// ===========================================================================
// Fixtures — a worksheet rendered to the convention, and filled in
// ===========================================================================

const DIR = mkdtempSync( join( tmpdir(), 'hw-roundtrip-' ) );
let available = false;

/**
 * Render the spec to a .docx the way the generator is expected to.
 *
 * @param {string} layout 'paragraphs' or 'table'
 * @returns {string} Path to the file.
 */
function render( layout ) {
  const lines = [];
  for ( const section of SPEC_SECTIONS ) {
    for ( const q of section.questions ) {
      lines.push( [ CONVENTION.question( q.number, q.text ),
                    CONVENTION.answer( q.answer ) ] );
    }
  }

  const payload = JSON.stringify( { layout, lines } );
  writeFileSync( join( DIR, 'payload.json' ), payload );

  execFileSync( 'python3', [ '-c', `
import json, sys
from docx import Document

out = sys.argv[1]
data = json.load(open(out + '/payload.json'))

d = Document()
d.add_heading('Week 3 Homework', 0)
d.add_paragraph('Name: Mila')

if data['layout'] == 'table':
    # The two-column form: Question | Your answer. The reader already handles
    # table cells, and it gives a cleaner "type here" affordance while answers
    # stay short.
    t = d.add_table(rows=len(data['lines']), cols=2)
    for i, (q, a) in enumerate(data['lines']):
        t.cell(i, 0).text = q
        t.cell(i, 1).text = a
else:
    for q, a in data['lines']:
        d.add_paragraph(q)
        d.add_paragraph(a)

d.save(out + '/worksheet_' + data['layout'] + '.docx')
` , DIR ], { stdio: 'ignore' } );

  return join( DIR, `worksheet_${ layout }.docx` );
}

try {
  execFileSync( 'python3', [ '-c', 'import docx' ], { stdio: 'ignore' } );
  render( 'paragraphs' );
  render( 'table' );
  available = existsSync( join( DIR, 'worksheet_paragraphs.docx' ) );
} catch ( err ) {
  available = false;
}

/**
 * Extract and align one rendered worksheet.
 *
 * @param {string} layout
 * @returns {object}
 */
function roundTrip( layout ) {
  const extracted = docxToText( readFileSync( join( DIR, `worksheet_${ layout }.docx` ) ) );
  assert.equal( extracted.ok, true, `extraction failed: ${ extracted.reason || '' }` );
  return alignToRegistry( REGISTRY, extracted.text );
}

// ===========================================================================
// The round trip
// ===========================================================================

test( 'a generated worksheet, filled in and returned, aligns perfectly',
  { skip: available ? false : 'python-docx unavailable' }, () => {
    // THE ONE THAT MATTERS. Anything less than every question matching means a
    // student who changed nothing gets a mismatch, and the tutor investigates a
    // discrepancy this system introduced itself.
    const r = roundTrip( 'paragraphs' );

    assert.deepEqual( r.summary,
      { total: 5, matched: 5, mismatched: 0, missing: 0 },
      JSON.stringify( r.rows, null, 1 ) );

    assert.equal( r.extras.length, 0, 'nothing in the document is unaccounted for' );
    assert.deepEqual( r.duplicates, [] );
    assert.equal( assessable( r.rows ).length, 5, 'every question is markable' );
  } );

test( 'the two-column table layout round-trips as well as paragraphs',
  { skip: available ? false : 'python-docx unavailable' }, () => {
    // The one structured alternative worth supporting: the reader already
    // handles cells, and it gives a cleaner "type here" affordance. Asserted so
    // that if the generator ever adopts it, the reader is known to cope.
    //
    // It is only viable while answers stay short. A question asking for working
    // needs room a cell does not give, and paragraphs win the moment that
    // happens -- which is why both layouts are pinned rather than one.
    const r = roundTrip( 'table' );

    assert.deepEqual( r.summary,
      { total: 5, matched: 5, mismatched: 0, missing: 0 },
      JSON.stringify( r.rows, null, 1 ) );
  } );

test( 'the answers survive the round trip, not merely the questions',
  { skip: available ? false : 'python-docx unavailable' }, () => {
    // Matching every question while mangling the answers would pass the gate
    // and mark nonsense. The awkward ones are the point: currency, a thousands
    // separator, a decimal, a slash and a colon-formatted time.
    const r = roundTrip( 'paragraphs' );
    const byPosition = Object.fromEntries( r.rows.map( ( x ) => [ x.position, x ] ) );

    assert.equal( byPosition[ 1 ].student_answer, '36' );
    assert.equal( byPosition[ 3 ].student_answer, '3/4' );
    assert.equal( byPosition[ 4 ].student_answer, '$1,111.05' );
    assert.equal( byPosition[ 5 ].student_answer, '4h 25m' );
  } );

test( 'a question containing its own numbers is not split by them',
  { skip: available ? false : 'python-docx unavailable' }, () => {
    // "A jacket costs $1,234.50" and "A train leaves at 09:15" both carry digits
    // followed by punctuation that the question-start pattern could mistake for
    // numbering. If it did, the question would break in half and fail the gate.
    const r = roundTrip( 'paragraphs' );

    const q4 = r.rows.find( ( x ) => 4 === x.position );
    assert.equal( q4.match_status, 'exact_match' );
    assert.match( q4.uploaded_question, /jacket costs/ );

    const q5 = r.rows.find( ( x ) => 5 === x.position );
    assert.equal( q5.match_status, 'exact_match' );
    assert.match( q5.uploaded_question, /09:15/ );
  } );

// ===========================================================================
// The convention itself
// ===========================================================================

test( 'the reader honours the pinned convention', () => {
  // Pinned in one place so the coupling to the generator is explicit rather
  // than accidental. homework_render.py lives on a mounted volume and cannot be
  // run here; if its layout ever changes, this is the test that fails and names
  // the mismatch, rather than a student's homework silently failing to align.
  const text = [
    CONVENTION.question( 1, 'What is 15% of 240?' ),
    CONVENTION.answer( '36' ),
  ].join( '\n' );

  const r = alignToRegistry(
    [ { id: 'q1', position: 1, question_text: 'What is 15% of 240?' } ], text );

  assert.equal( r.summary.matched, 1 );
  assert.equal( r.rows[ 0 ].student_answer, '36' );
} );

test( 'the number must lead the line for alignment to key on it', () => {
  // The convention is not decorative. A number that does not lead is question
  // CONTENT -- "What is 15% of 240" holds two numbers and neither identifies
  // the question.
  const wrong = 'Question one: What is 15% of 240?\nAnswer: 36';
  const r = alignToRegistry(
    [ { id: 'q1', position: 1, question_text: 'What is 15% of 240?' } ], wrong );

  assert.equal( r.summary.matched, 0,
    'an unnumbered question cannot be aligned, and is reported rather than guessed' );
  assert.equal( r.rows[ 0 ].match_status, 'missing' );
} );
