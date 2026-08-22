// src/tests/homework-real-worksheet.test.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Sections 5 and 6.
//
// ===========================================================================
// THIS REPLACES A TEST THAT PROVED NOTHING
// ===========================================================================
//
// `homework-roundtrip.test.js` rendered a worksheet to a layout convention I
// had written down, then proved the reader agreed with it. Both sides came from
// me, so it could only ever pass. It reported closure while the real generator
// produced something quite different.
//
// The fixtures here are the genuine article: `real-worksheet-blank.docx` was
// built by `homework_docx_build.build_docx()` from the generator's own
// `homework_test_spec.json`, and `real-worksheet-filled.docx` is that file with
// the spec's own answer key typed into the answer lines.
//
// ── What it caught ────────────────────────────────────────────────────────
//
// Four defects, none of which the convention test could see, and each of which
// marked a correct paper wrong:
//
//   1. The per-question meta line `[2 pts]  ~1m 30s` was read as the first line
//      of the answer. 23 of 23 keyed answers scored WRONG on a perfect paper.
//   2. The section heading `Number Patterns  [Core]` was absorbed into the
//      previous answer, so the last question of every section scored wrong.
//   3. A question ending in data rather than punctuation -- "...pattern? 2, 6,
//      18, 54, 162" -- swallowed the student's answer as a wrapped line, and
//      three questions were reported unanswered.
//   4. A decimal answer `2.4 hours` parsed as question number 2, creating a
//      phantom question and losing the real one.
//
// The whole point of a deterministic key comparison is that it cannot be wrong.
// It was wrong on every question, because the text it compared was never the
// student's answer.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { docxToText } from '../homework/docx-text.js';
import { parseBlocks, alignToRegistry, assessable } from '../homework/homework-extract.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const FIXTURES = join( HERE, 'fixtures' );

const SPEC = JSON.parse(
  readFileSync( join( FIXTURES, 'real-homework-spec.json' ), 'utf8' ) );

/** The registry rows, flattened exactly as lib/homework-registry.js flattens them. */
const REGISTRY = SPEC.sections
  .flatMap( ( s ) => s.questions )
  .map( ( q, i ) => ( {
    id: `q${ i + 1 }`,
    position: i + 1,
    question_text: q.text,
    answer_key: q.answer,
  } ) );

/**
 * Extract and align one fixture.
 *
 * @param {string} name
 * @returns {object}
 */
function align( name ) {
  const buf = readFileSync( join( FIXTURES, `${ name }.docx` ) );
  const extracted = docxToText( buf );
  assert.equal( extracted.ok, true, `extraction failed: ${ extracted.reason || '' }` );
  return { text: extracted.text, ...alignToRegistry( REGISTRY, extracted.text ) };
}

// ===========================================================================
// The round trip that matters
// ===========================================================================

test( 'the fixtures are the generator\'s real output, not a reconstruction', () => {
  assert.ok( existsSync( join( FIXTURES, 'real-worksheet-blank.docx' ) ) );
  assert.ok( existsSync( join( FIXTURES, 'real-worksheet-filled.docx' ) ) );
  assert.equal( REGISTRY.length, 25, 'the real spec carries 25 questions' );

  // The layout markers that broke the reader, present in the extracted text.
  // If the generator ever stops emitting them, this test says so rather than
  // the reader silently depending on something that has gone.
  const { text } = align( 'real-worksheet-blank' );
  assert.match( text, /\[\d+ pts?\]\s+~\d+m \d+s/, 'the per-question meta line' );
  assert.match( text, /\s\[(?:Core|Stretch|Foundation|Extension|Olympiad)\]/,
    'the section heading badge' );
} );

test( 'a perfectly answered real worksheet scores 25 out of 25', () => {
  // THE ONE THAT MATTERS. Every question answered with the spec's own key.
  // Anything less than a clean sweep means a student who got everything right
  // is told otherwise, by a comparison that is supposed to be incapable of
  // being wrong.
  const r = align( 'real-worksheet-filled' );

  assert.deepEqual( r.summary,
    { total: 25, matched: 25, mismatched: 0, missing: 0 },
    JSON.stringify( r.rows.filter( ( x ) => 'exact_match' !== x.match_status ), null, 1 ) );

  const keyed = r.rows.filter( ( x ) => null !== x.key_match );
  assert.equal( keyed.length, 25, 'every question has an answer key' );
  assert.equal( keyed.filter( ( x ) => true === x.key_match ).length, 25,
    'and every one is marked correct: '
    + JSON.stringify( keyed.filter( ( x ) => ! x.key_match )
        .map( ( x ) => ( { p: x.position, a: x.student_answer } ) ) ) );

  assert.equal( r.extras.length, 0, 'no phantom questions' );
  assert.deepEqual( r.duplicates, [] );
  assert.equal( assessable( r.rows ).length, 25 );
} );

test( 'a blank real worksheet reports every question unanswered, and marks none', () => {
  // The other end of the same guarantee. A student who submits the worksheet
  // untouched must not have the generator's own furniture read as answers.
  const r = align( 'real-worksheet-blank' );

  assert.equal( r.summary.matched, 0 );
  assert.equal( r.summary.missing, 25 );
  assert.equal( assessable( r.rows ).length, 0 );
  assert.equal( r.rows.filter( ( x ) => null !== x.key_match ).length, 0,
    'no key verdict is offered for a question that was not answered' );
} );

// ===========================================================================
// The four defects, pinned individually
// ===========================================================================

test( 'the per-question meta line is not read as an answer', () => {
  const blocks = parseBlocks(
    '1. What is 5/6 - 1/3?\n[2 pts]  ~1m 30s\n1/2' );

  assert.equal( blocks.length, 1 );
  assert.equal( blocks[ 0 ].answer, '1/2',
    'the meta line belongs to neither the question nor the answer' );
} );

test( 'a section heading is not absorbed into the previous answer', () => {
  const blocks = parseBlocks(
    '5. Simplify the fraction 18/24.\n[2 pts]  ~1m 30s\n3/4\n'
    + 'Number Patterns  [Core]\n'
    + '6. Find the missing number.\n[2 pts]  ~1m 30s\n95' );

  assert.equal( blocks.length, 2 );
  assert.equal( blocks[ 0 ].answer, '3/4',
    'the heading does not become part of question 5\'s answer' );
  assert.equal( blocks[ 1 ].answer, '95' );
} );

test( 'a question ending in data still separates from its answer', () => {
  // "...pattern? 2, 6, 18, 54, 162" has no terminal punctuation at the end of
  // the line, so the wrap heuristic would treat the answer as a continuation.
  // The meta line settles it, because the generator always emits one.
  const blocks = parseBlocks(
    '7. What is the rule for this pattern? 2, 6, 18, 54, 162\n'
    + '[2 pts]  ~1m 30s\nMultiply by 3' );

  assert.equal( blocks[ 0 ].question,
    'What is the rule for this pattern? 2, 6, 18, 54, 162' );
  assert.equal( blocks[ 0 ].answer, 'Multiply by 3' );
} );

test( 'a decimal answer is not mistaken for a question number', () => {
  // `2.4 hours` parsed as question 2 with the text "4 hours", creating a
  // phantom question and losing the real answer to question 25.
  const blocks = parseBlocks(
    '25. How long does it take to fill the tank?\n[4 pts]  ~2m 30s\n2.4 hours' );

  assert.equal( blocks.length, 1, 'no phantom question is created' );
  assert.equal( blocks[ 0 ].number, 25 );
  assert.equal( blocks[ 0 ].answer, '2.4 hours' );
} );

test( 'the numbering styles a hand-typed worksheet uses still parse', () => {
  // The separator now requires trailing whitespace, which is what distinguishes
  // numbering from a decimal. Every generator form keeps working; only
  // "1.Text" with no space is given up, and a missed question is reported as
  // unanswered rather than silently consuming a real answer.
  for ( const line of [ '1. Q text?', '1) Q text?', '1: Q text?',
                        'Q1. Q text?', 'Question 1. Q text?' ] ) {
    const b = parseBlocks( `${ line }\nAnswer: x` );
    assert.equal( b.length, 1, line );
    assert.equal( b[ 0 ].number, 1, line );
  }
} );

// ===========================================================================
// A genuinely student-submitted worksheet
// ===========================================================================
//
// `student-submitted-worksheet.docx` was produced by the generator and filled
// in by an actual student in Word -- not by a script writing runs into the XML.
// It is the one input nothing else in this suite can stand in for, because the
// run structure Word produces when a person types is not the run structure a
// fixture builder produces.

/** The questions, read from the submitted file itself. */
function submittedQuestions() {
  const buf = readFileSync( join( FIXTURES, 'student-submitted-worksheet.docx' ) );
  const text = docxToText( buf ).text;
  const out = {};
  for ( const line of text.split( '\n' ) ) {
    const m = line.match( /^(\d+)\. (.*)$/s );
    if ( m ) out[ Number( m[ 1 ] ) ] = m[ 2 ];
  }
  return { text, questions: out };
}

test( 'a real student submission parses into one block per question', () => {
  const { text } = submittedQuestions();
  const blocks = parseBlocks( text );

  assert.equal( blocks.length, 10 );
  assert.deepEqual( blocks.map( ( b ) => b.number ),
    [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ] );

  // Every numeric answer is the bare value, with no meta line, heading or
  // blank-line furniture attached.
  assert.deepEqual( blocks.slice( 0, 9 ).map( ( b ) => b.answer ),
    [ '160', '170', '200', '250', '400', '92', '10', '162', '8' ] );

  // The long-form answer survives whole. A PEEL paragraph is several sentences,
  // and truncating it would send the marker a fragment to judge.
  assert.ok( blocks[ 9 ].answer.length > 400,
    'the written-expression answer is not truncated' );
  assert.match( blocks[ 9 ].answer, /^Uniforms offer a great deal of protection/ );
  assert.match( blocks[ 9 ].answer, /how they should wear them\.$/ );
} );

test( 'the marking key matches however the tutor wrote the units', () => {
  // THE DEFECT THIS CAUGHT, on this exact file.
  //
  // Strict comparison scored 1 of 9 correct answers as right when the key was
  // written the way a tutor actually writes one -- `$160`, `92 m²`, `x = 8`.
  // The student wrote the bare number, as students do. Every other question on
  // a correct paper was marked wrong.
  //
  // Both key styles must now give the same verdict, because the difference
  // between them is the tutor's formatting and not the student's work.
  const { text, questions } = submittedQuestions();

  const bare  = { 1: '160', 2: '170', 3: '200', 4: '250', 5: '400',
                  6: '92', 7: '10', 8: '162', 9: '8', 10: null };
  const typed = { 1: '$160', 2: '$170', 3: '$200', 4: '$250', 5: '$400',
                  6: '92 m\u00B2', 7: '10 m', 8: '162', 9: 'x = 8', 10: null };

  for ( const [ label, keys ] of [ [ 'bare', bare ], [ 'with units', typed ] ] ) {
    const registry = Object.keys( questions ).map( Number ).sort( ( a, b ) => a - b )
      .map( ( n ) => ( { id: `q${ n }`, position: n,
                         question_text: questions[ n ], answer_key: keys[ n ] } ) );

    const r = alignToRegistry( registry, text );

    assert.deepEqual( r.summary, { total: 10, matched: 10, mismatched: 0, missing: 0 },
      `${ label }: every question should align` );

    const keyed = r.rows.filter( ( x ) => null !== x.key_match );
    assert.equal( keyed.length, 9, `${ label }: nine questions carry a key` );
    assert.equal( keyed.filter( ( x ) => true === x.key_match ).length, 9,
      `${ label }: all nine should be correct, wrong were `
      + JSON.stringify( keyed.filter( ( x ) => ! x.key_match )
          .map( ( x ) => x.position ) ) );
  }
} );

test( 'the free-text question is left for a model, not judged by comparison', () => {
  // Question 10 is a PEEL paragraph. There is no key, so `key_match` is null
  // and it is the one question a model should actually score.
  const { text, questions } = submittedQuestions();
  const registry = Object.keys( questions ).map( Number ).sort( ( a, b ) => a - b )
    .map( ( n ) => ( { id: `q${ n }`, position: n, question_text: questions[ n ],
                       answer_key: 10 === n ? null : 'x' } ) );

  const r = alignToRegistry( registry, text );
  const q10 = r.rows.find( ( x ) => 10 === x.position );

  assert.equal( q10.key_match, null );
  assert.equal( q10.match_status, 'exact_match',
    'it still passes the gate, so it is markable' );
} );

// ===========================================================================
// Per-section numbering, per ref-homework-render-spec
// ===========================================================================

/** A worksheet whose numbering restarts in each section. */
const PER_SECTION_DOC = [
  'Reverse Percentages  [Core]',
  '1. First section q one?', '[2 pts]  ~1m 00s', '10',
  '2. First section q two?', '[2 pts]  ~1m 00s', '20',
  'Number Patterns  [Stretch]',
  '1. Second section q one?', '[2 pts]  ~1m 00s', '30',
  '2. Second section q two?', '[2 pts]  ~1m 00s', '40',
].join( '\n' );

const PER_SECTION_REGISTRY = [
  { id: 'q1', position: 1, question_text: 'First section q one?', answer_key: '10' },
  { id: 'q2', position: 2, question_text: 'First section q two?', answer_key: '20' },
  { id: 'q3', position: 3, question_text: 'Second section q one?', answer_key: '30' },
  { id: 'q4', position: 4, question_text: 'Second section q two?', answer_key: '40' },
];

test( 'numbering that restarts per section still aligns', () => {
  // ref-homework-render-spec defines `number` as "Question number WITHIN the
  // section". The registry flattens to a running position across sections, so
  // the two disagree the moment a worksheet has more than one section and the
  // generator numbers them per-section.
  //
  // Before this was handled, section two's questions collided with section
  // one's, were flagged as duplicates and dropped: half the paper reported
  // unanswered on a fully answered submission.
  //
  // The bundled test spec happens to number globally 1..25, which is why every
  // earlier round-trip passed while this was broken.
  const r = alignToRegistry( PER_SECTION_REGISTRY, PER_SECTION_DOC );

  assert.deepEqual( r.summary, { total: 4, matched: 4, mismatched: 0, missing: 0 },
    JSON.stringify( r.rows, null, 1 ) );
  assert.deepEqual( r.rows.map( ( x ) => x.student_answer ),
    [ '10', '20', '30', '40' ] );
  assert.deepEqual( r.duplicates, [],
    'a restarted number is not a duplicate' );
} );

test( 'global numbering is unaffected by the per-section handling', () => {
  // The common case must not regress. Numbers that never restart are used
  // directly, and a skipped question still damages only itself.
  const registry = [
    { id: 'q1', position: 1, question_text: 'One?', answer_key: '1' },
    { id: 'q2', position: 2, question_text: 'Two?', answer_key: '2' },
    { id: 'q3', position: 3, question_text: 'Three?', answer_key: '3' },
  ];
  const doc = [
    '1. One?', '[1 pt]  ~1m 00s', '1',
    '3. Three?', '[1 pt]  ~1m 00s', '3',
  ].join( '\n' );

  const r = alignToRegistry( registry, doc );
  assert.equal( r.summary.matched, 2 );
  assert.equal( r.rows.find( ( x ) => 2 === x.position ).match_status, 'missing' );
  assert.equal( r.rows.find( ( x ) => 3 === x.position ).student_answer, '3',
    'question three is unaffected by the gap above it' );
} );

test( 'a gap in the middle of a section does not shift the next section', () => {
  // The number carries the gap, so section two still starts in the right place.
  const doc = [
    'Section One  [Core]',
    '1. First section q one?', '[2 pts]  ~1m 00s', '10',
    '3. First section q three?', '[2 pts]  ~1m 00s', '15',
    'Section Two  [Stretch]',
    '1. Second section q one?', '[2 pts]  ~1m 00s', '30',
  ].join( '\n' );

  const registry = [
    { id: 'q1', position: 1, question_text: 'First section q one?', answer_key: '10' },
    { id: 'q2', position: 2, question_text: 'First section q two?', answer_key: '20' },
    { id: 'q3', position: 3, question_text: 'First section q three?', answer_key: '15' },
    { id: 'q4', position: 4, question_text: 'Second section q one?', answer_key: '30' },
  ];

  const r = alignToRegistry( registry, doc );
  assert.equal( r.rows.find( ( x ) => 2 === x.position ).match_status, 'missing' );
  assert.equal( r.rows.find( ( x ) => 3 === x.position ).student_answer, '15' );
  assert.equal( r.rows.find( ( x ) => 4 === x.position ).student_answer, '30',
    'the following section is unaffected' );
} );

test( 'a question skipped at the END of a section is caught, not mismarked', () => {
  // THE RESIDUAL LIMITATION, asserted rather than hoped about.
  //
  // A gap in the middle of a section is visible in the numbering and the offset
  // absorbs it. A question skipped at the very END of a section is invisible --
  // the document simply moves to the next heading -- so every following section
  // is shifted by one.
  //
  // What matters is that this fails SAFELY. The shifted question's text no
  // longer agrees with the registry, so the agreement gate reports a mismatch
  // and refuses to mark it. The student's answer is never scored against the
  // wrong question; a human is asked instead.
  const doc = [
    'Section One  [Core]',
    '1. First section q one?', '[2 pts]  ~1m 00s', '10',
    'Section Two  [Stretch]',
    '1. Second section q one?', '[2 pts]  ~1m 00s', '30',
    '2. Second section q two?', '[2 pts]  ~1m 00s', '40',
  ].join( '\n' );

  const r = alignToRegistry( PER_SECTION_REGISTRY, doc );

  assert.equal( r.rows.find( ( x ) => 2 === x.position ).match_status, 'mismatch',
    'the shift is detected by the gate' );
  assert.equal( r.summary.matched, 1, 'only the unshifted question is markable' );
  assert.ok( ! assessable( r.rows ).some( ( x ) => 1 !== x.position ),
    'nothing shifted is ever sent to a marker' );
} );

// ===========================================================================
// Writing-Question Assessment Spec v1.0.0 — R2 and R4
// ===========================================================================

test( 'R2: a writing question is never key-compared, even when it would match', () => {
  // THE SILENT VERDICT THIS PREVENTS. Routing used to depend on comparison
  // FAILING on a model paragraph versus a student paragraph. A student whose
  // writing closely resembled the model -- or that the normaliser collapsed --
  // would have received a deterministic binary mark on an essay, with no
  // review at all.
  //
  // The answer here is byte-identical to the model paragraph, so the old
  // arrangement would have marked it correct outright. Ineligibility is
  // structural now: it keys on the declared type, not on the outcome.
  const model = 'Uniforms improve safety because they make students identifiable.';
  const registry = [
    { id: 'q1', position: 1, question_text: 'Write one PEEL paragraph on uniforms.',
      answer_key: model, question_type: 'writing' },
  ];
  const doc = [ '1. Write one PEEL paragraph on uniforms.',
                '[5 pts]  ~2m 00s', model ].join( '\n' );

  const r = alignToRegistry( registry, doc );

  assert.equal( r.rows[ 0 ].question_type, 'writing' );
  assert.equal( r.rows[ 0 ].key_match, null,
    'no key verdict is produced for a writing question, whatever it would have been' );
  assert.equal( r.rows[ 0 ].match_status, 'exact_match',
    'it still passes the agreement gate, so it is reviewable' );
} );

test( 'question_type defaults to standard, so existing specs are unchanged', () => {
  // Backward compatibility, R9. A spec written before the field existed must
  // behave exactly as it did.
  const registry = [
    { id: 'q1', position: 1, question_text: 'What is 15% of 240?', answer_key: '36' },
  ];
  const r = alignToRegistry( registry,
    '1. What is 15% of 240?\n[2 pts]  ~1m 00s\n36' );

  assert.equal( r.rows[ 0 ].question_type, 'standard' );
  assert.equal( r.rows[ 0 ].key_match, true, 'the deterministic path still runs' );
} );

test( 'R4: a blank is only VERIFIED when the question was actually located', () => {
  // "The student answered nothing" is a verdict, and this layer has produced it
  // wrongly before -- the meta line, the section heading and the decimal
  // false-positive each caused it. A blank is a zero only when it is known to
  // be a real blank.
  const registry = [
    { id: 'q1', position: 1, question_text: 'One?', answer_key: '1' },
    { id: 'q2', position: 2, question_text: 'Two?', answer_key: '2' },
  ];

  // Question 1 is present with an empty answer region; question 2 is absent
  // from the document entirely.
  const doc = [ '1. One?', '[1 pt]  ~1m 00s' ].join( '\n' );
  const r = alignToRegistry( registry, doc );

  const q1 = r.rows.find( ( x ) => 1 === x.position );
  const q2 = r.rows.find( ( x ) => 2 === x.position );

  assert.equal( q1.match_status, 'missing' );
  assert.equal( q2.match_status, 'missing' );

  // The difference that matters: one may be auto-zeroed, the other may not.
  assert.equal( q1.blank_state, 'verified',
    'the student saw this question and left it' );
  assert.equal( q2.blank_state, 'ambiguous',
    'extraction never found this one, which is a different claim' );
} );

test( 'R4: a section edge makes a blank ambiguous, because a shift is invisible there', () => {
  // A question skipped at the end of a section shifts everything after it and
  // the document gives no sign. Auto-zeroing at that boundary would reintroduce
  // the "answered nothing" false verdict by a new route.
  const doc = [
    'Section One  [Core]',
    '1. First q?', '[1 pt]  ~1m 00s', '10',
    '2. Second q?', '[1 pt]  ~1m 00s',
    'Section Two  [Stretch]',
    '1. Third q?', '[1 pt]  ~1m 00s', '30',
  ].join( '\n' );

  const registry = [
    { id: 'q1', position: 1, question_text: 'First q?', answer_key: '10' },
    { id: 'q2', position: 2, question_text: 'Second q?', answer_key: '20' },
    { id: 'q3', position: 3, question_text: 'Third q?', answer_key: '30' },
  ];

  const r = alignToRegistry( registry, doc );
  const q2 = r.rows.find( ( x ) => 2 === x.position );

  assert.equal( q2.match_status, 'missing' );
  assert.equal( q2.blank_state, 'ambiguous',
    'the last question of a section is exactly where a shift hides' );
} );

test( 'an answered question carries no blank state at all', () => {
  const registry = [ { id: 'q1', position: 1, question_text: 'One?', answer_key: '1' } ];
  const r = alignToRegistry( registry, '1. One?\n[1 pt]  ~1m 00s\n1' );
  assert.equal( r.rows[ 0 ].blank_state, null );
} );
