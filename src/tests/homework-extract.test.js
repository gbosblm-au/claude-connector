// src/tests/homework-extract.test.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6 (upload
// parsing, agreement gate), Section 12 (extras, gaps, duplicates).
//
// ===========================================================================
// THESE TESTS RUN AGAINST REAL .docx FILES
// ===========================================================================
//
// The fixtures are built by python-docx at test time, not hand-written XML.
// That matters: the defects this reader has to survive are the ones Word and
// its clones actually produce -- runs split mid-word, table cells, tracked
// changes, entity escaping -- and hand-rolled XML reproduces none of them
// because it is written by someone who already knows what the parser expects.
//
// If python-docx is unavailable the docx tests SKIP rather than pass. A silent
// pass on a missing fixture is worse than a visible skip: it reports that
// extraction works when nothing was extracted.
//
// The parsing and alignment layers are pure and are tested directly from
// strings, so a layout that parses wrongly can be reproduced from a bug report
// without a file attachment.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docxToText, documentXmlToText } from '../homework/docx-text.js';
import { parseBlocks, alignToRegistry, assessable } from '../homework/homework-extract.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = mkdtempSync( join( tmpdir(), 'hw-fixtures-' ) );
let docxAvailable = false;

try {
  execFileSync( 'python3', [ '-c', 'import docx' ], { stdio: 'ignore' } );
  const script = `
import sys
from docx import Document
out = sys.argv[1]

d = Document()
d.add_heading('Week 3 Homework', 0)
d.add_paragraph('Name: Mila')
d.add_paragraph('1. What is 15% of 240?')
d.add_paragraph('Answer: 36')
d.add_paragraph('2. Increase 80 by 25%.')
d.add_paragraph('Answer: 100')
d.add_paragraph('3. Simplify 18/24.')
d.add_paragraph('Answer: 3/4')
d.save(out + '/worksheet.docx')

# A student who skips question 2 entirely.
d = Document()
d.add_paragraph('1. What is 15% of 240?')
d.add_paragraph('Answer: 36')
d.add_paragraph('3. Simplify 18/24.')
d.add_paragraph('Answer: 3/4')
d.save(out + '/skipped.docx')

# A student who altered the wording of question 2.
d = Document()
d.add_paragraph('1. What is 15% of 240?')
d.add_paragraph('Answer: 36')
d.add_paragraph('2. Increase 80 by 35%.')
d.add_paragraph('Answer: 108')
d.add_paragraph('3. Simplify 18/24.')
d.add_paragraph('Answer: 3/4')
d.save(out + '/altered.docx')

# Runs split mid-token, which Word does constantly.
d = Document()
p = d.add_paragraph()
for piece in ['1. Simpl', 'ify ', '18', '/', '24', '.']:
    p.add_run(piece)
d.add_paragraph('Answer: 3/4')
d.save(out + '/splitruns.docx')

# Answers laid out in a table.
d = Document()
t = d.add_table(rows=2, cols=2)
t.cell(0,0).text = '1. What is 15% of 240?'
t.cell(0,1).text = 'Answer: 36'
t.cell(1,0).text = '2. Simplify 18/24.'
t.cell(1,1).text = 'Answer: 3/4'
d.save(out + '/table.docx')

# A text box and a content control, written as Word actually writes them.
# python-docx cannot produce these, so the document part is rewritten directly.
d = Document()
d.add_paragraph('1. What is 15% of 240?')
d.add_paragraph('PLACEHOLDER_TEXTBOX')
d.add_paragraph('2. Simplify 18/24.')
d.add_paragraph('PLACEHOLDER_SDT')
d.save(out + '/tb_base.docx')

import zipfile
textbox = ('<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
'<mc:Choice Requires="wps"><w:drawing><wps:txbx xmlns:wps="z"><w:txbxContent>'
'<w:p><w:r><w:t>36</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice>'
'<mc:Fallback><w:pict><v:textbox xmlns:v="urn:schemas-microsoft-com:vml"><w:txbxContent>'
'<w:p><w:r><w:t>36</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback>'
'</mc:AlternateContent></w:r></w:p>')
sdt = ('<w:sdt><w:sdtPr><w:alias w:val="ans"/></w:sdtPr><w:sdtContent>'
'<w:p><w:r><w:t>3/4</w:t></w:r></w:p></w:sdtContent></w:sdt>')

zin = zipfile.ZipFile(out + '/tb_base.docx')
xml = zin.read('word/document.xml').decode('utf8')
xml = xml.replace('<w:p><w:r><w:t>PLACEHOLDER_TEXTBOX</w:t></w:r></w:p>', textbox)
xml = xml.replace('<w:p><w:r><w:t>PLACEHOLDER_SDT</w:t></w:r></w:p>', sdt)
assert 'PLACEHOLDER' not in xml
zout = zipfile.ZipFile(out + '/textbox.docx', 'w', zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == 'word/document.xml':
        data = xml.encode('utf8')
    zout.writestr(item, data)
zout.close()

# Characters that must survive XML escaping.
d = Document()
d.add_paragraph('1. What\\u2019s 15% of 240? Use <, > & "quotes"')
d.add_paragraph('Answer: 36')
d.save(out + '/entities.docx')
`;
  execFileSync( 'python3', [ '-c', script, DIR ], { stdio: 'ignore' } );
  docxAvailable = existsSync( join( DIR, 'worksheet.docx' ) );
} catch ( err ) {
  docxAvailable = false;
}

/** The registry rows every alignment test aligns against. */
const REGISTRY = [
  { id: 'q1', position: 1, question_text: 'What is 15% of 240?' },
  { id: 'q2', position: 2, question_text: 'Increase 80 by 25%.' },
  { id: 'q3', position: 3, question_text: 'Simplify 18/24.' },
];

/**
 * Read a fixture and extract its text.
 *
 * @param {string} name
 * @returns {string}
 */
function textOf( name ) {
  const r = docxToText( readFileSync( join( DIR, `${ name }.docx` ) ) );
  assert.equal( r.ok, true, `${ name }.docx should extract: ${ r.reason || '' }` );
  return r.text;
}

// ===========================================================================
// The reader, against real files
// ===========================================================================

test( 'a real docx extracts to one line per paragraph',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    const text = textOf( 'worksheet' );

    assert.match( text, /Week 3 Homework/ );
    assert.match( text, /1\. What is 15% of 240\?/ );

    // Paragraph structure is what the extractor downstream relies on. Without
    // it, questions and answers run together into a single line and the
    // agreement gate sees a question that matches nothing.
    const lines = text.split( '\n' ).filter( Boolean );
    assert.ok( lines.length >= 6, `expected several lines, got ${ lines.length }` );
  } );

test( 'a token split across runs is reassembled without a gap',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    // THE CASE THAT DICTATES THE DESIGN. Word splits a single typed word across
    // several <w:t> elements whenever formatting or spell-check state changes
    // mid-word. Joining runs with a space would turn `18/24` into `18 / 24`,
    // and the agreement gate would reject a question the student copied
    // perfectly.
    const text = textOf( 'splitruns' );
    assert.match( text, /Simplify 18\/24\./ );
    assert.ok( ! /18 \/ 24/.test( text ), 'runs must join with no separator' );
  } );

test( 'table cells do not run into one another',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    const text = textOf( 'table' );
    const r = alignToRegistry(
      [ REGISTRY[ 0 ], { id: 'q2', position: 2, question_text: 'Simplify 18/24.' } ],
      text );

    // Without a cell boundary the question and its answer concatenate and the
    // answer becomes part of the question text, failing the gate.
    assert.equal( r.summary.matched, 2, JSON.stringify( r.rows ) );
  } );

test( 'XML entities decode, and decode once',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    const text = textOf( 'entities' );
    assert.match( text, /</ );
    assert.match( text, />/ );
    assert.match( text, /&/ );
    assert.match( text, /"quotes"/ );
    assert.ok( ! /&amp;|&lt;|&gt;/.test( text ), 'no entity survives undecoded' );
  } );

test( 'text boxes and content controls are read, and read once',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    // WHERE STUDENTS ACTUALLY WRITE. On a worksheet with answer boxes, the
    // student's answer is inside <w:txbxContent> or a content control's
    // <w:sdtContent>, not in a body paragraph. A reader that walked only the
    // body would extract the questions and none of the answers -- and because
    // empty extraction looks like a result rather than an error, every question
    // would come back `missing` and the student would be recorded as having
    // answered nothing.
    const text = textOf( 'textbox' );

    const r = alignToRegistry(
      [ { id: 'q1', position: 1, question_text: 'What is 15% of 240?' },
        { id: 'q2', position: 2, question_text: 'Simplify 18/24.' } ],
      text );

    assert.equal( r.summary.matched, 2, JSON.stringify( r.rows ) );
    assert.equal( r.rows[ 0 ].student_answer, '36', 'the text box answer is read' );
    assert.equal( r.rows[ 1 ].student_answer, '3/4', 'the content control answer is read' );
  } );

test( 'a text box is not counted twice through mc:AlternateContent', () => {
  // THE DEFECT THIS CAUGHT. Word 2010+ writes a text box twice -- once under
  // <mc:Choice Requires="wps"> as DrawingML, again under <mc:Fallback> as
  // legacy VML, with the same text in both.
  //
  // A labelled answer survives by luck, because the second "Answer: 36"
  // overwrites the first with the same value. An UNLABELLED one does not: the
  // runs concatenate into "36 36", which is marked wrong, and the student is
  // told their correct answer was incorrect.
  const xml =
    '<w:p><w:r><w:t>1. What is 15% of 240?</w:t></w:r></w:p>'
    + '<w:p><w:r><mc:AlternateContent>'
    + '<mc:Choice Requires="wps"><w:txbxContent><w:p><w:r><w:t>36</w:t></w:r></w:p>'
    + '</w:txbxContent></mc:Choice>'
    + '<mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>36</w:t></w:r></w:p>'
    + '</w:txbxContent></w:pict></mc:Fallback>'
    + '</mc:AlternateContent></w:r></w:p>';

  const blocks = parseBlocks( documentXmlToText( xml ) );
  assert.equal( blocks[ 0 ].answer, '36',
    'the Choice branch is used and the Fallback dropped' );
} );

test( 'an AlternateContent with only a Fallback still yields its text', () => {
  // Dropping Fallback unconditionally would lose the answer outright, which is
  // the worse of the two failures: a duplicated answer is visibly odd, a
  // missing one reads as a student who did not attempt the question.
  const xml =
    '<w:p><w:r><w:t>1. Q?</w:t></w:r></w:p>'
    + '<w:p><w:r><mc:AlternateContent><mc:Fallback><w:txbxContent>'
    + '<w:p><w:r><w:t>99</w:t></w:r></w:p></w:txbxContent></mc:Fallback>'
    + '</mc:AlternateContent></w:r></w:p>';

  assert.equal( parseBlocks( documentXmlToText( xml ) )[ 0 ].answer, '99' );
} );

test( 'a table cell boundary separates content that has no paragraph of its own', () => {
  // WHY THIS IS TESTED FROM XML AND NOT FROM A FIXTURE. python-docx always
  // wraps cell text in a <w:p>, so the paragraph rule alone separates the cells
  // and the fixture cannot tell whether the cell rule does anything -- removing
  // it leaves every generated-fixture test green.
  //
  // Real documents are not so tidy: content controls and some export pipelines
  // emit runs directly inside <w:tc>. Without the cell rule those concatenate,
  // so a question and its answer become one string and the gate rejects a
  // question the student copied perfectly.
  const withoutParagraphs =
    '<w:tbl><w:tr>'
    + '<w:tc><w:r><w:t>1. What is 15% of 240?</w:t></w:r></w:tc>'
    + '<w:tc><w:r><w:t>Answer: 36</w:t></w:r></w:tc>'
    + '</w:tr></w:tbl>';

  const text = documentXmlToText( withoutParagraphs );
  assert.ok( /240\?\s+Answer/.test( text ),
    `cells must not run together, got ${ JSON.stringify( text ) }` );
} );

test( 'the double-unescape defect is not present', () => {
  // `&amp;lt;` must decode to the literal text `&lt;`, never to `<`. Unescaping
  // `&amp;` first would invent markup that was never in the document.
  const xml = '<w:p><w:r><w:t>a &amp;lt; b</w:t></w:r></w:p>';
  assert.equal( documentXmlToText( xml ), 'a &lt; b' );
} );

test( 'tracked deletions are excluded from the submitted text', () => {
  // <w:delText> is text the student REMOVED. Including it would mark work they
  // deliberately took out.
  const xml = '<w:p><w:r><w:t>keep this </w:t></w:r>'
            + '<w:r><w:delText>and not this</w:delText></w:r>'
            + '<w:r><w:t>and this</w:t></w:r></w:p>';
  assert.equal( documentXmlToText( xml ), 'keep this and this' );
} );

test( 'a non-docx is refused with a reason rather than read as blank', () => {
  // Refusing up front means a tutor is told "this is not a Word document".
  // Parsing it into empty text would report a blank submission, and the student
  // would be marked as having answered nothing.
  assert.deepEqual( docxToText( Buffer.from( '%PDF-1.7 ...' ) ),
    { ok: false, reason: 'not_a_docx' } );
  assert.deepEqual( docxToText( Buffer.alloc( 0 ) ),
    { ok: false, reason: 'empty_file' } );
  assert.deepEqual( docxToText( 'a string, not a buffer' ),
    { ok: false, reason: 'empty_file' } );

  // A zip that is not a docx: right signature, no document part.
  const notDocx = Buffer.concat( [ Buffer.from( 'PK\u0003\u0004' ), Buffer.alloc( 64 ) ] );
  const r = docxToText( notDocx );
  assert.equal( r.ok, false );
  assert.ok( [ 'no_document_part', 'corrupt_archive' ].includes( r.reason ) );
} );

// ===========================================================================
// Block parsing — pure, from strings
// ===========================================================================

test( 'numbered questions and labelled answers are separated', () => {
  const blocks = parseBlocks(
    '1. What is 15% of 240?\nAnswer: 36\n2. Simplify 18/24.\nAnswer: 3/4' );

  assert.equal( blocks.length, 2 );
  // `section` is carried so per-section numbering can be resolved; asserted by
  // field rather than by whole-object equality, which broke when it was added.
  assert.equal( blocks[ 0 ].number, 1 );
  assert.equal( blocks[ 0 ].question, 'What is 15% of 240?' );
  assert.equal( blocks[ 0 ].answer, '36' );
  assert.equal( blocks[ 1 ].number, 2 );
  assert.equal( blocks[ 1 ].question, 'Simplify 18/24.' );
  assert.equal( blocks[ 1 ].answer, '3/4' );
} );

test( 'several numbering styles are accepted', () => {
  for ( const line of [ '1. Q text?', '1) Q text?', '1: Q text?',
                        'Q1. Q text?', 'Question 1. Q text?' ] ) {
    const b = parseBlocks( `${ line }\nAnswer: x` );
    assert.equal( b.length, 1, line );
    assert.equal( b[ 0 ].number, 1, line );
    assert.equal( b[ 0 ].question, 'Q text?', line );
  }
} );

test( 'a number inside a question does not start a new block', () => {
  // An unanchored pattern matches the `15` in "What is 15% of 240" and splits
  // the question in half, which then fails the gate.
  const blocks = parseBlocks( '1. What is 15% of 240?\nAnswer: 36' );
  assert.equal( blocks.length, 1 );
  assert.equal( blocks[ 0 ].question, 'What is 15% of 240?' );
} );

test( 'an explicit answer label overrides working shown above it', () => {
  // A student who shows their working and then writes "Answer: 36" means the
  // 36. Sending the marker a paragraph of arithmetic where it expects a value
  // produces a mark against the wrong thing.
  const b = parseBlocks( '1. What is 15% of 240?\n240 x 0.15\n= 36\nAnswer: 36' );
  assert.equal( b[ 0 ].answer, '36' );
} );

test( 'a question wrapped across lines is not mistaken for an answer', () => {
  const b = parseBlocks(
    '1. What is the total cost if each item\ncosts $12 and you buy 4?\nAnswer: 48' );

  assert.equal( b[ 0 ].question, 'What is the total cost if each item costs $12 and you buy 4?' );
  assert.equal( b[ 0 ].answer, '48' );
} );

test( 'an unlabelled answer on the line after a complete question is found', () => {
  const b = parseBlocks( '1. What is 15% of 240?\n36' );
  assert.equal( b[ 0 ].answer, '36' );
} );

test( 'headings before the first question are ignored', () => {
  const b = parseBlocks( 'Week 3 Homework\nName: Mila\n1. What is 15% of 240?\nAnswer: 36' );
  assert.equal( b.length, 1 );
  assert.equal( b[ 0 ].answer, '36' );
} );

// ===========================================================================
// Alignment and the agreement gate
// ===========================================================================

test( 'a clean upload matches every question', () => {
  const r = alignToRegistry( REGISTRY,
    '1. What is 15% of 240?\nAnswer: 36\n'
    + '2. Increase 80 by 25%.\nAnswer: 100\n'
    + '3. Simplify 18/24.\nAnswer: 3/4' );

  assert.deepEqual( r.summary, { total: 3, matched: 3, mismatched: 0, missing: 0 } );
  assert.equal( assessable( r.rows ).length, 3 );
} );

test( 'a skipped question damages only itself', () => {
  // THE CASE THAT DICTATES NUMBER-BASED ALIGNMENT. Zipping registry against
  // blocks in order would pair Q3's answer with Q2's question text, and every
  // remaining question would fail the gate. The student would be told six
  // questions failed when they skipped one.
  const r = alignToRegistry( REGISTRY,
    '1. What is 15% of 240?\nAnswer: 36\n3. Simplify 18/24.\nAnswer: 3/4' );

  assert.deepEqual( r.summary, { total: 3, matched: 2, mismatched: 0, missing: 1 } );

  const q2 = r.rows.find( ( x ) => 2 === x.position );
  assert.equal( q2.match_status, 'missing' );

  const q3 = r.rows.find( ( x ) => 3 === x.position );
  assert.equal( q3.match_status, 'exact_match',
    'question 3 is unaffected by the gap above it' );
  assert.equal( q3.student_answer, '3/4' );
} );

test( 'an altered question is quarantined, not marked against the wrong key', () => {
  // The 19 July failure, in miniature: the student answers a question that is
  // not the one the registry holds. Marking 108 against the key for
  // "increase 80 by 25%" would produce a confident, wrong result.
  const r = alignToRegistry( REGISTRY,
    '1. What is 15% of 240?\nAnswer: 36\n'
    + '2. Increase 80 by 35%.\nAnswer: 108\n'
    + '3. Simplify 18/24.\nAnswer: 3/4' );

  const q2 = r.rows.find( ( x ) => 2 === x.position );
  assert.equal( q2.match_status, 'mismatch' );
  assert.equal( q2.student_answer, '108', 'the answer is still recorded for the tutor' );
  assert.ok( q2.reason.length > 10 );

  assert.ok( ! assessable( r.rows ).some( ( x ) => 2 === x.position ),
    'a mismatched question is never dispatched for assessment' );
} );

test( 'the uploaded question is stored even when it matches', () => {
  // It is the evidence behind the gate's decision. Without it a disputed
  // mismatch cannot be investigated after the fact.
  const r = alignToRegistry( REGISTRY, '1. What is 15% of 240?\nAnswer: 36' );
  const q1 = r.rows.find( ( x ) => 1 === x.position );
  assert.equal( q1.uploaded_question, 'What is 15% of 240?' );
} );

test( 'cosmetic differences still pass the gate', () => {
  // The normaliser's job, exercised through the real path: a student who
  // re-types a question with a curly apostrophe, no trailing stop and different
  // spacing has copied it correctly.
  const registry = [ { id: 'q1', position: 1, question_text: "What's 15% of 240?" } ];
  const r = alignToRegistry( registry, '1.  What\u2019s 15% of 240\nAnswer: 36' );
  assert.equal( r.rows[ 0 ].match_status, 'exact_match' );
} );

test( 'extras are reported and never marked', () => {
  // Section 12. Usually a student renumbering after inserting their own
  // working; occasionally the wrong worksheet. There is no canonical question
  // to mark them against, which is precisely why they are reported only.
  const r = alignToRegistry( REGISTRY,
    '1. What is 15% of 240?\nAnswer: 36\n'
    + '2. Increase 80 by 25%.\nAnswer: 100\n'
    + '3. Simplify 18/24.\nAnswer: 3/4\n'
    + '4. A question that was never set.\nAnswer: 12' );

  assert.equal( r.extras.length, 1 );
  assert.equal( r.extras[ 0 ].number, 4 );
  assert.equal( r.rows.length, 3, 'extras never become rows' );
} );

test( 'a duplicated number keeps the first and flags it', () => {
  const r = alignToRegistry( REGISTRY,
    '1. What is 15% of 240?\nAnswer: 36\n1. What is 15% of 240?\nAnswer: 99' );

  assert.deepEqual( r.duplicates, [ 1 ] );
  const q1 = r.rows.find( ( x ) => 1 === x.position );
  assert.equal( q1.student_answer, '36',
    'the first is kept; the second is usually working or a correction' );
} );

test( 'an empty or unreadable upload marks everything missing, never matched', () => {
  for ( const text of [ '', '   ', 'no numbered questions at all' ] ) {
    const r = alignToRegistry( REGISTRY, text );
    assert.equal( r.summary.matched, 0, JSON.stringify( text ) );
    assert.equal( r.summary.missing, 3, JSON.stringify( text ) );
    assert.equal( assessable( r.rows ).length, 0 );
  }
} );

test( 'assessable returns only exact matches, whatever it is handed', () => {
  // The gate's enforcement point. A caller that dispatches anything else has
  // defeated the feature, so this must not be lenient.
  const rows = [
    { position: 1, match_status: 'exact_match' },
    { position: 2, match_status: 'mismatch' },
    { position: 3, match_status: 'missing' },
    { position: 4, match_status: 'pending' },
    null,
  ];
  assert.deepEqual( assessable( rows ).map( ( r ) => r.position ), [ 1 ] );
  assert.deepEqual( assessable( null ), [] );
  assert.deepEqual( assessable( 'nonsense' ), [] );
} );

test( 'the real skipped-question fixture behaves the same as the string case',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    const r = alignToRegistry( REGISTRY, textOf( 'skipped' ) );
    assert.deepEqual( r.summary, { total: 3, matched: 2, mismatched: 0, missing: 1 } );
  } );

test( 'the real altered fixture is quarantined',
  { skip: docxAvailable ? false : 'python-docx unavailable' }, () => {
    const r = alignToRegistry( REGISTRY, textOf( 'altered' ) );
    assert.equal( r.summary.mismatched, 1 );
    assert.equal( assessable( r.rows ).length, 2 );
  } );

// ===========================================================================
// v13.11.0 — the answer key, compared rather than judged
// ===========================================================================

test( 'a keyed question is decided by comparison, not by a model', () => {
  // The key was in the registry from the first release, written at generation
  // time from the spec's own `answer` field, and was being handed to the marker
  // as "guidance" instead of being used.
  //
  // For a question whose answer is 36, exact equality after normalisation
  // cannot be wrong and does not vary between runs. It takes a model off the
  // critical path for exactly the questions where a wrong mark is least
  // defensible.
  const registry = [
    { id: 'q1', position: 1, question_text: 'What is 15% of 240?', answer_key: '36' },
    { id: 'q2', position: 2, question_text: 'Simplify 18/24.', answer_key: '3/4' },
    { id: 'q3', position: 3, question_text: 'Explain your method.', answer_key: null },
  ];

  const r = alignToRegistry( registry,
    '1. What is 15% of 240?\nAnswer: 36\n'
    + '2. Simplify 18/24.\nAnswer: 5/6\n'
    + '3. Explain your method.\nAnswer: I halved it twice' );

  assert.equal( r.rows[ 0 ].key_match, true );
  assert.equal( r.rows[ 1 ].key_match, false );
  assert.equal( r.rows[ 2 ].key_match, null,
    'no key means correctness is a judgement -- which is what a model is for' );
} );

test( 'the key comparison runs through the same normaliser as the gate', () => {
  // A student writing 36.00, $1,234.50 or a curly apostrophe has given the
  // right answer. A raw string comparison would mark all three wrong, and the
  // student would have no way to tell why.
  const registry = [
    { id: 'q1', position: 1, question_text: 'What is 15% of 240?', answer_key: '36' },
    { id: 'q2', position: 2, question_text: 'Cost?', answer_key: '$1234.50' },
  ];

  const r = alignToRegistry( registry,
    '1. What is 15% of 240?\nAnswer: 36.00\n2. Cost?\nAnswer: $1,234.50' );

  assert.equal( r.rows[ 0 ].key_match, true, '36.00 is 36' );
  assert.equal( r.rows[ 1 ].key_match, true, '$1,234.50 is $1234.50' );
} );

test( 'the key is never compared on a question that failed the gate', () => {
  // Comparing an answer to the key of a question the student demonstrably did
  // not answer would produce a confident mark for the wrong question -- the
  // 19 July failure with a deterministic veneer.
  const registry = [
    { id: 'q1', position: 1, question_text: 'Increase 80 by 25%.', answer_key: '100' },
  ];

  const r = alignToRegistry( registry, '1. Increase 80 by 35%.\nAnswer: 100' );

  assert.equal( r.rows[ 0 ].match_status, 'mismatch' );
  assert.equal( r.rows[ 0 ].key_match, null,
    'no key verdict is offered for a question that did not match' );
} );
