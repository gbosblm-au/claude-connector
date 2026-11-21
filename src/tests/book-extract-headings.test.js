/**
 * src/tests/book-extract-headings.test.js   (connector v13.40.0, WO-2026-11-21-01 B.5, B-6)
 *
 * The widened heading detection in scripts/book_extract.py, driven through
 * the real script: its functions are imported by python3 from the shipped
 * file, and the end-to-end case runs the script itself. Both halves of B-6:
 * the widened rules FIND Hegel's all-caps headings, Wittgenstein's section
 * lines and DIVISION / SECTION headings, AND the rejection rule refuses
 * "Part Two likewise has three divisions:1", a footnote fragment Being and
 * Time minted as a chapter title. A detector passing only the first half is
 * the over-firing the order guards against.
 *
 * The gateway's mirror of these rules (Gateway-Service lib/vault-sequence.js
 * detectHeading, used to classify boundaries) is tested on the same cases in
 * Gateway-Service tests/vault-sequence.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const SCRIPTS = join( ROOT, 'scripts' );

/** Run candidate_marks over `lines` in the shipped script; returns [line_no, text, pattern_no, rejection]. */
function marks( lines ) {
  const py = [
    'import sys, json',
    `sys.path.insert(0, ${ JSON.stringify( SCRIPTS ) })`,
    'import book_extract as b',
    'lines = json.loads(sys.stdin.read())',
    'print(json.dumps([[i, t, n, r, b.is_strong(n)] for i, t, n, r in b.candidate_marks(lines)]))',
  ].join( '\n' );
  return JSON.parse( execFileSync( 'python3', [ '-I', '-c', py ], { input: JSON.stringify( lines ), encoding: 'utf8' } ) );
}

const PARA = 'It is customary to preface a work with an explanation of the author’s aim, why he wrote the book, and the relationship in which he believes it to stand to other earlier or contemporary treatises on the same subject. In the case of a philosophical work, however, such an explanation seems not only superfluous but even inappropriate and misleading. ';

test( 'B-6, first half: the widened rules find all-caps headings, section lines, DIVISION and SECTION', () => {
  const lines = [ 'PREFACE', '', PARA, '', 'CONTENTS', '', PARA, '', '§ 143.', PARA, '§ 185 Let us return to our example', PARA,
    'DIVISION ONE', '', PARA, 'SECTION 3', '', PARA, 'Part Two', '', PARA, 'Division Two', '', PARA, 'Section 4', '', PARA ];
  // "Division Two" and "Section 4" are explicit only through the keyword rule
  // (in capitals the all-caps rule would also catch them).
  const kept = marks( lines ).filter( ( m ) => null === m[ 3 ] ).map( ( m ) => [ m[ 1 ], m[ 4 ] ] );
  assert.deepEqual( kept, [ [ 'PREFACE', true ], [ 'CONTENTS', true ], [ '§ 143.', true ], [ '§ 185 Let us return to our example', true ],
    [ 'DIVISION ONE', true ], [ 'SECTION 3', true ], [ 'Part Two', true ], [ 'Division Two', true ], [ 'Section 4', true ] ] );
} );

test( 'B-6, second half: the footnote fragment is rejected, with the reason', () => {
  const lines = [ PARA, '', 'Part Two likewise has three divisions:1', '', PARA ];
  const got = marks( lines );
  assert.equal( got.length, 1 );
  assert.equal( got[ 0 ][ 1 ], 'Part Two likewise has three divisions:1' );
  assert.equal( got[ 0 ][ 3 ], 'colon_then_numeral', 'matched by the PART rule, then refused' );
} );

test( 'B.5 rejection rule: a footnote marker, a sentence continuation, a running header and endnote text are refused', () => {
  const header = 'PHENOMENOLOGY OF SPIRIT';
  const lines = [ 'Chapter of Being2 and Time', PARA, 'and the argument runs', 'part of the claim', header, PARA, header, PARA, header, PARA, header, PARA,
    'CHAPTER IV The Unhappy Consciousness Returns', PARA, 'Notes', 'CHAPTER IV The Unhappy Consciousness Returns' ];
  const byText = new Map( marks( lines ).map( ( m ) => [ `${ m[ 0 ] }:${ m[ 1 ] }`, m[ 3 ] ] ) );
  assert.equal( byText.get( '0:Chapter of Being2 and Time' ), 'footnote_marker' );
  assert.equal( byText.get( `4:${ header }` ), 'running_header', 'an all-caps line repeated four times is a running header' );
  assert.equal( byText.get( '12:CHAPTER IV The Unhappy Consciousness Returns' ), 'in_endnotes' );
} );

test( 'B-6 negative: ordinary body sentences and a short quotation are not headings', () => {
  const got = marks( [ PARA, 'He said no.', 'the end of a sentence', PARA ] );
  assert.deepEqual( got, [] );
} );

test( 'end to end: the extractor splits at the widened headings and never at the fragment', () => {
  const dir = mkdtempSync( join( tmpdir(), 'headings-' ) );
  try {
    const body = [ 'PREFACE', PARA.repeat( 8 ), 'Part Two likewise has three divisions:1', PARA.repeat( 2 ), 'INTRODUCTION', PARA.repeat( 8 ), 'DIVISION ONE', PARA.repeat( 8 ) ].join( '\n\n' );
    const file = join( dir, 'book.txt' );
    writeFileSync( file, body );
    const out = JSON.parse( execFileSync( 'python3', [ join( SCRIPTS, 'book_extract.py' ), '--path', file, '--format', 'txt' ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ) );
    assert.equal( out.ingest_status, 'ok' );
    assert.deepEqual( out.chapters.map( ( c ) => c.title ), [ 'PREFACE', 'INTRODUCTION', 'DIVISION ONE' ] );
    assert.ok( out.chapters[ 0 ].content.includes( 'Part Two likewise has three divisions:1' ), 'the fragment stays in its chapter’s text' );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
} );
