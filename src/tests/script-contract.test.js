/**
 * src/tests/script-contract.test.js
 *
 * Do the scripts this repository ships accept the arguments script_execute
 * actually passes?  v13.21.2.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * script_execute builds every command as
 *
 *     <script> [--input FILE] --output DIR [caller args...]
 *
 * unconditionally, for every script. A script that does not accept those flags
 * exits 2 on argparse before running a line of its own code.
 *
 * book_extract.py shipped without them. The failure surfaced three layers away
 * as "the extractor ran but returned no payload file" -- and the extractor had
 * never run. It cost several round trips to find, and every check in the
 * pipeline passed: the script's syntax was fine, its own tests passed, and it
 * worked perfectly when invoked by hand.
 *
 * That is the gap. Nothing tested the script against the CALLER's contract,
 * only against its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );

/**
 * The flags script_execute appends to every invocation.
 *
 * Read from the source rather than restated, so a change there fails this test
 * instead of silently making it describe a contract nobody honours any more.
 */
function callerFlags() {
  const src = readFileSync(
    join( ROOT, 'src', 'tools', 'script-execute.js' ), 'utf8' );

  const flags = [];
  if ( /cmdArgs\.push\( *'--input', *inputFile *\)/.test( src ) ) flags.push( '--input' );
  if ( /cmdArgs\.push\( *'--output', *outputDir *\)/.test( src ) ) flags.push( '--output' );
  return flags;
}

test( 'script_execute still passes the flags this test assumes', () => {
  // If this fails, the contract moved and the assertions below are stale.
  assert.deepEqual( callerFlags(), [ '--input', '--output' ] );
} );

test( 'book_extract.py accepts the arguments script_execute passes', () => {
  const script = join( ROOT, 'scripts', 'book_extract.py' );
  if ( ! existsSync( script ) ) return;   // not shipped in this build

  const dir = mkdtempSync( join( tmpdir(), 'script-contract-' ) );
  const sample = join( dir, 'sample.txt' );
  // Long enough to clear the extractor's minimum-content threshold, so the
  // run exercises the real path rather than an early refusal.
  writeSample( sample );

  try {
    // The EXACT shape script_execute builds: caller args last, --output always.
    const out = execFileSync( 'python3',
      [ script, '--output', dir, '--path', sample, '--title', 'Contract Test' ],
      { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } );

    const summary = JSON.parse( out );
    assert.equal( summary.ok, true );
    assert.equal( summary.payload_file, 'book_extract.json',
      'the payload must go to a file, not to stdout: stdout is capped at 50 KB' );
    assert.ok( existsSync( join( dir, 'book_extract.json' ) ),
      'the payload file must land in the directory --output names' );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
} );

test( 'book_extract.py declares both caller flags', () => {
  const script = join( ROOT, 'scripts', 'book_extract.py' );
  if ( ! existsSync( script ) ) return;
  const src = readFileSync( script, 'utf8' );

  // Asserted on the source as well as by running it, because argparse accepts
  // an undeclared flag silently in some configurations and the running check
  // above would then pass while the value was ignored.
  for ( const flag of callerFlags() ) {
    assert.ok( src.includes( `"${ flag }"` ),
      `book_extract.py must declare ${ flag }` );
  }
} );

test( 'chapter detection ranks explicit headings above bare numerals', () => {
  // The pilot-book regression. "1. A Parade in Erhenrang" is the commonest
  // chapter style in fiction, and a printed book carries a page number every
  // few paragraphs. Pooled, the page numbers outnumber the headings nine to
  // one, the median section collapses, the plausibility check refuses the
  // split, and a twenty-chapter novel is stored as a single chapter.
  const script = join( ROOT, 'scripts', 'book_extract.py' );
  if ( ! existsSync( script ) ) return;

  const dir = mkdtempSync( join( tmpdir(), 'chapter-detect-' ) );
  try {
    const para = `${ 'The snow of Gethen fell on Orgoreyn and the ice of Karhide. '.repeat( 24 ) }\n\n`;
    let body = '';
    let page = 1;
    for ( const [ n, title ] of [ [ 1, 'A Parade in Erhenrang' ],
                                  [ 2, 'The Place Inside the Blizzard' ],
                                  [ 3, 'The Mad King' ],
                                  [ 4, 'The Nineteenth Day' ] ] ) {
      body += `${ n }. ${ title }\n\n`;
      for ( let i = 0; i < 8; i += 1 ) body += `${ para }${ page++ }\n\n`;
    }
    const file = join( dir, 'novel.txt' );
    writeFileSync( file, body );

    const out = JSON.parse( execFileSync( 'python3',
      [ script, '--output', dir, '--path', file, '--title', 'Novel' ],
      { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } ) );

    assert.equal( out.ingest_status, 'ok',
      'a book with real headings must not fall back to a single chapter' );
    assert.equal( out.chapter_count, 4 );
    assert.match( out.chapter_titles[ 0 ], /A Parade in Erhenrang/ );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
} );

test( 'a book of page numbers and no headings still falls back', () => {
  // The other half. The guard that stops page numbers being read as chapters
  // must survive the change that stops them DROWNING chapters -- and §6.1
  // requires the whole text be kept when the split is refused.
  const script = join( ROOT, 'scripts', 'book_extract.py' );
  if ( ! existsSync( script ) ) return;

  const dir = mkdtempSync( join( tmpdir(), 'chapter-fallback-' ) );
  try {
    let body = '';
    for ( let page = 1; page <= 60; page += 1 ) {
      body += `${ 'Ice and snow and the long winter of Gethen. '.repeat( 20 ) }\n\n${ page }\n\n`;
    }
    const file = join( dir, 'nopages.txt' );
    writeFileSync( file, body );

    const out = JSON.parse( execFileSync( 'python3',
      [ script, '--output', dir, '--path', file ],
      { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } ) );

    assert.equal( out.ingest_status, 'single_chapter_fallback' );
    assert.equal( out.chapter_count, 1 );
    // Nothing lost to the refusal.
    assert.ok( out.char_count > body.length * 0.9 );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
} );

test( 'an EPUB is split by its spine, not by a heading search', () => {
  // v13.21.5. A publisher declares chapter structure in the spine, and running
  // the text heuristic over concatenated EPUB documents throws that away and
  // tries to guess it back from headings.
  //
  // Discworld is the case that forced this: most of the novels have no chapter
  // headings at all, only scene breaks, so a heading search finds nothing and a
  // whole novel becomes one chapter. The spine still knows where the sections
  // are. The fixture below has NO headings anywhere, exactly like the book.
  const script = join( ROOT, 'scripts', 'book_extract.py' );
  if ( ! existsSync( script ) ) return;

  const dir = mkdtempSync( join( tmpdir(), 'epub-spine-' ) );
  try {
    const file = join( dir, 'novel.epub' );
    writeEpub( file, 10 );

    const out = JSON.parse( execFileSync( 'python3',
      [ script, '--output', dir, '--path', file, '--title', 'Spine Test' ],
      { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } ) );

    assert.equal( out.source_format, 'epub' );
    assert.equal( out.ingest_status, 'ok',
      'a headingless EPUB must still split, because the spine declares the split' );
    assert.ok( out.chapter_count >= 8,
      `expected the spine's sections, got ${ out.chapter_count }` );
    // The spine covers the whole book, so unlike the heuristic nothing sits
    // outside a chapter.
    assert.equal( out.unassigned_word_count, 0 );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
} );

/**
 * A minimal EPUB with front matter and `count` headingless sections.
 *
 * @param {string} path
 * @param {number} count
 * @returns {void}
 */
function writeEpub( path, count ) {
  const zip = [];
  const para = `<p>${ 'Lu-Tze swept the floor of the Temple of Wen while the Auditors watched. '.repeat( 18 ) }</p>`;
  const docs = [ [ 'cover.xhtml', '<html><body><p>Cover</p></body></html>' ],
                 [ 'title.xhtml', '<html><body><p>Novel</p></body></html>' ] ];
  for ( let i = 1; i <= count; i += 1 ) {
    docs.push( [ `s${ i }.xhtml`, `<html><body>${ para.repeat( 5 ) }</body></html>` ] );
  }

  const manifest = docs.map( ( d, n ) => `<item id="i${ n }" href="${ d[ 0 ] }"/>` ).join( '' );
  const spine = docs.map( ( _d, n ) => `<itemref idref="i${ n }"/>` ).join( '' );
  zip.push( [ 'content.opf',
    `<package><manifest>${ manifest }</manifest><spine>${ spine }</spine></package>` ] );
  for ( const d of docs ) zip.push( d );

  // Written with the system zip so the test needs no archive dependency.
  const dir = mkdtempSync( join( tmpdir(), 'epub-build-' ) );
  try {
    for ( const [ name, content ] of zip ) writeFileSync( join( dir, name ), content );
    execFileSync( 'zip', [ '-q', '-j', path, ...zip.map( ( z ) => join( dir, z[ 0 ] ) ) ],
      { stdio: 'ignore' } );
  } finally {
    rmSync( dir, { recursive: true, force: true } );
  }
}

/**
 * @param {string} path
 * @returns {void}
 */
function writeSample( path ) {
  const line = 'The snow of Gethen fell on Orgoreyn and on the ice of Karhide.\n';
  const body = `CHAPTER 1\n\n${ line.repeat( 40 ) }\nThérèse, naïve, café.\n`;
  writeFileSync( path, body );
}
