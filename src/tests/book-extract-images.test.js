/**
 * src/tests/book-extract-images.test.js   (connector v13.45.0, WORK-ORDER-2026-11-26-01)
 *
 * The image half of scripts/book_extract.py, driven through the real script
 * on books built from nothing by src/tests/fixtures/make_image_books.py.
 *
 *   C-IMG-TEXT-UNCHANGED   without --images the payload carries no images key,
 *                          and with --images every other key is identical:
 *                          the text is never changed by the image pass (test 1)
 *   C-IMG-ZERO             a text-only book and the same book with its images
 *                          stripped answer image_count 0 (tests 1 and 3)
 *   C-IMG-PLACEMENT        each image's chapter offset is where its tag stood
 *                          in the text, in reading order, and its raw offset
 *                          is the same place in raw_text (R1)
 *   C-IMG-ALT              publisher alt text kept verbatim; a filename, an
 *                          asset id or a generic word is not a description (R3)
 *   C-IMG-CAPTION          a figcaption in the same <figure> is attributed;
 *                          a PDF "Figure 1." block under the figure is too (R6)
 *   C-IMG-DEDUPE           a repeated ornament is one asset (R9)
 *   C-IMG-BYTES            describe mode carries the deduplicated bytes, count
 *                          mode none, and a payload ceiling omits by name (R9)
 *   C-IMG-SCANNED          a scan with a text layer is refused by name, routed
 *                          to OCR, and not counted as figures (R11, test 9)
 *   C-IMG-STDOUT           the stdout summary never carries the block (50 KB)
 *   C-IMG-TRACKED          the position tracker arrives at strip_html's text
 *                          exactly, through the whitespace steps
 *
 * Self-skips, and says so, when Pillow or PyMuPDF is not installed (both are
 * in the connector image; see Dockerfile).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const SCRIPT = join( ROOT, 'scripts', 'book_extract.py' );
const MAKER = join( ROOT, 'src', 'tests', 'fixtures', 'make_image_books.py' );
const DIR = mkdtempSync( join( tmpdir(), 'img-books-' ) );

const made = spawnSync( 'python3', [ '-I', MAKER, DIR ], { encoding: 'utf8' } );
const SKIP = 0 === made.status ? false : `fixtures could not be built: ${ ( made.stderr || made.error || '' ).toString().trim() }`;
if ( SKIP ) console.log( `[book-extract-images] SKIPPED: ${ SKIP }` );

test.after( () => rmSync( DIR, { recursive: true, force: true } ) );

/** Run the shipped script on a fixture; returns the parsed payload. */
function extract( file, extra = [] ) {
  const out = execFileSync( 'python3', [ '-I', SCRIPT, '--path', join( DIR, file ), ...extra ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: [ 'ignore', 'pipe', 'ignore' ] } );
  return JSON.parse( out );
}

/** Call a function of the shipped script by name with JSON arguments. */
function py( expr, input ) {
  const code = [
    'import sys, json',
    `sys.path.insert(0, ${ JSON.stringify( join( ROOT, 'scripts' ) ) })`,
    'import book_extract as b',
    'args = json.loads(sys.stdin.read())',
    `print(json.dumps(${ expr }))`,
  ].join( '\n' );
  return JSON.parse( execFileSync( 'python3', [ '-I', '-c', code ], { input: JSON.stringify( input ), encoding: 'utf8' } ) );
}

const chapterOf = ( payload, p ) => payload.chapters.find( ( c ) => c.ordinal === p.chapter_ordinal );

test( 'C-IMG-TEXT-UNCHANGED: --images changes no key but adds images, on every fixture', { skip: SKIP }, () => {
  for ( const f of [ 'illustrated.epub', 'stripped.epub', 'text_only.epub', 'born_digital.pdf', 'scanned.pdf' ] ) {
    const plain = extract( f );
    assert.equal( 'images' in plain, false, `${ f }: no images key without --images` );
    for ( const mode of [ 'count', 'describe' ] ) {
      const withImages = extract( f, [ '--images', mode ] );
      assert.ok( withImages.images && withImages.images.mode === mode, `${ f } ${ mode }` );
      const { images: _drop, ...rest } = withImages;
      assert.deepEqual( rest, plain, `${ f } ${ mode }: every other key identical` );
    }
  }
} );

test( 'C-IMG-ZERO: text-only and stripped books answer zero, not silence', { skip: SKIP }, () => {
  for ( const f of [ 'text_only.epub', 'stripped.epub' ] ) {
    const im = extract( f, [ '--images', 'count' ] ).images;
    assert.equal( im.image_count, 0, f );
    assert.equal( im.unique_count, 0, f );
    assert.deepEqual( im.placements, [], f );
  }
} );

test( 'C-IMG-PLACEMENT: offsets are where the tags stood, in reading order, in chapters and raw_text', { skip: SKIP }, () => {
  const p = extract( 'illustrated.epub', [ '--images', 'count' ] );
  const im = p.images;
  assert.equal( im.image_count, 10 );
  assert.deepEqual( im.placements.map( ( x ) => x.index ), [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 ] );
  // The plate page has no text: its image opens the next document with text.
  const plate = im.placements.find( ( x ) => x.href === 'images/plate.png' );
  assert.equal( plate.precision, 'adjacent' );
  assert.equal( plate.offset, 0 );
  assert.ok( chapterOf( p, plate ).content.slice( 0, 12 ).includes( 'Chapter 4' ), 'the next document (its <title> text leads it)' );
  for ( const x of im.placements.filter( ( y ) => y !== plate ) ) {
    const ch = chapterOf( p, x );
    assert.ok( ch, `placement ${ x.index } names a chapter` );
    assert.ok( x.offset >= 0 && x.offset <= ch.content.length );
    // The same place in raw_text: the 40 characters before match.
    const n = Math.min( 40, x.offset );
    assert.equal( p.raw_text.slice( x.raw_offset - n, x.raw_offset ), ch.content.slice( x.offset - n, x.offset ), `placement ${ x.index }` );
    assert.equal( x.precision, 'exact' );
  }
  const glyph = im.placements.find( ( x ) => x.href === 'images/glyph.png' );
  const ch3 = chapterOf( p, glyph );
  assert.equal( ch3.content.slice( glyph.offset - 9, glyph.offset ), 'The mark ' );
  assert.equal( ch3.content.slice( glyph.offset, glyph.offset + 8 ), ' appears' );
  const plan = im.placements.find( ( x ) => x.href === 'images/plan.png' );
  assert.ok( chapterOf( p, plan ).content.slice( plan.offset ).startsWith( 'Figure 1. Plan of the moss garden.' ) );
  const late = im.placements.find( ( x ) => x.href === 'images/fig_0012.png' );
  assert.ok( chapterOf( p, late ).content.slice( 0, late.offset ).endsWith( 'finished.' ), 'after the last paragraph of chapter 2' );
} );

test( 'C-IMG-ALT: substantive alt text verbatim; filename, asset id and generic words refused', { skip: SKIP }, () => {
  const im = extract( 'illustrated.epub', [ '--images', 'count' ] ).images;
  const by = ( h ) => im.placements.find( ( x ) => x.href === h );
  assert.equal( by( 'images/lantern.png' ).alt, 'A stone lantern half hidden by maple leaves' );
  assert.equal( by( 'images/fig_0012.png' ).alt, null, 'a filename is never a description' );
  assert.equal( by( 'images/plate.png' ).alt, null, 'a bare filename with no digit is never a description' );
  assert.equal( by( 'images/cover.png' ).alt, null, 'a generic word is not a description' );
  assert.equal( by( 'images/plan.png' ).alt, null, 'empty alt falls through' );
  const cases = py( '[b.substantive_alt(a) for a in args]',
    [ '', '   ', 'img_0045', 'Image00045', 'fig-3a.jpg', 'lantern.png', 'figure', 'A torii gate at dusk', 'x' ] );
  assert.deepEqual( cases, [ null, null, null, null, null, null, null, 'A torii gate at dusk', null ] );
} );

test( 'C-IMG-CAPTION: figcaption in the same figure, and the PDF caption block, are attributed', { skip: SKIP }, () => {
  const im = extract( 'illustrated.epub', [ '--images', 'count' ] ).images;
  const plan = im.placements.find( ( x ) => x.href === 'images/plan.png' );
  assert.equal( plan.caption, 'Figure 1. Plan of the moss garden.' );
  assert.equal( plan.caption_source, 'figcaption' );
  assert.equal( im.placements.find( ( x ) => x.href === 'images/lantern.png' ).caption, null );
  const pdf = extract( 'born_digital.pdf', [ '--images', 'count' ] );
  assert.equal( pdf.images.image_count, 1 );
  const fig = pdf.images.placements[ 0 ];
  assert.equal( fig.caption, 'Figure 1. The approach to the tea house.' );
  assert.equal( fig.caption_source, 'pdf_adjacent' );
  assert.equal( fig.precision, 'block' );
  assert.ok( chapterOf( pdf, fig ).content.slice( fig.offset ).replace( /^\s+/, '' ).startsWith( 'Figure 1.' ),
    'placed after the block above the figure, before its caption' );
} );

test( 'C-IMG-DEDUPE: the ornament on every opener is one asset with its occurrences', { skip: SKIP }, () => {
  const im = extract( 'illustrated.epub', [ '--images', 'count' ] ).images;
  assert.equal( im.unique_count, 7 );
  const orn = im.placements.filter( ( x ) => x.href === 'images/ornament.png' );
  assert.equal( orn.length, 4 );
  assert.equal( new Set( orn.map( ( x ) => x.asset ) ).size, 1 );
  assert.equal( im.assets[ orn[ 0 ].asset ].occurrences, 4 );
  assert.equal( im.assets[ orn[ 0 ].asset ].width, 40 );
} );

test( 'C-IMG-BYTES: describe carries bytes, count none, and the payload ceiling omits by name', { skip: SKIP }, () => {
  const count = extract( 'illustrated.epub', [ '--images', 'count' ] ).images;
  assert.ok( Object.values( count.assets ).every( ( a ) => ! ( 'data_base64' in a ) ) );
  const describe = extract( 'illustrated.epub', [ '--images', 'describe' ] ).images;
  const withData = Object.values( describe.assets ).filter( ( a ) => a.data_base64 );
  assert.equal( withData.length, 7 );
  assert.equal( describe.payload_bytes, withData.reduce( ( n, a ) => n + a.data_bytes, 0 ) );
  const tight = extract( 'illustrated.epub', [ '--images', 'describe', '--image-payload-budget', '3000' ] ).images;
  const omitted = Object.values( tight.assets ).filter( ( a ) => 'payload_budget' === a.data_omitted );
  assert.ok( omitted.length >= 1, 'something was over the ceiling' );
  assert.ok( tight.payload_bytes <= 3000 );
} );

test( 'C-IMG-SCANNED: a scan with a text layer is refused by name and its pages are not figures', { skip: SKIP }, () => {
  const im = extract( 'scanned.pdf', [ '--images', 'describe' ] ).images;
  assert.equal( im.routing.refused, 'scanned_pdf_page_images' );
  assert.equal( im.routing.route, 'ocr_correction' );
  assert.equal( im.routing.pages_with_page_image, 6 );
  assert.equal( im.image_count, 0, 'not a book of six figures' );
  assert.equal( im.page_images_excluded, 6 );
  assert.equal( im.payload_bytes, 0, 'no page bytes sent' );
} );

test( 'C-IMG-STDOUT: through script_execute the summary carries counts, never the block', { skip: SKIP }, () => {
  const out = mkdtempSync( join( tmpdir(), 'img-out-' ) );
  try {
    const stdout = execFileSync( 'python3', [ '-I', SCRIPT, '--output', out, '--path', join( DIR, 'illustrated.epub' ), '--images', 'describe' ],
      { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } );
    const summary = JSON.parse( stdout );
    assert.equal( 'images' in summary, false );
    assert.equal( summary.images_summary.image_count, 10 );
    assert.ok( stdout.length < 50000 );
    const payload = JSON.parse( readFileSync( join( out, 'book_extract.json' ), 'utf8' ) );
    assert.equal( payload.images.image_count, 10 );
  } finally {
    rmSync( out, { recursive: true, force: true } );
  }
} );

test( 'C-IMG-TRACKED: positions survive the whitespace steps and the text is strip_html exactly', { skip: SKIP }, () => {
  const docs = [
    '<p>One <img src="a.png"/> \n two</p>',
    '<p>Before</p>\n\n<img src="b.png"/>\n\n<p>After</p>',
    '  <img src="c.png"/><p>Lead</p>',
    '<p>Tail</p><img src="d.png"/>   ',
    '<script>var x = "<img src=s.png>";</script><p>Only &amp; this</p><img src="e.png">',
  ];
  for ( const markup of docs ) {
    const [ found, exact, text ] = py( '[*b.html_image_positions(args), b.strip_html(args)]', markup );
    assert.equal( exact, true, markup );
    for ( const f of found ) assert.ok( f.position >= 0 && f.position <= text.length, markup );
  }
  const [ found ] = py( 'b.html_image_positions(args)', '<script>var x = "<img src=s.png>";</script><p>Only &amp; this</p><img src="e.png">' );
  assert.deepEqual( found.map( ( f ) => f.attrs.src ), [ 'e.png' ], 'an image inside a script is not an image' );
  const [ f2, , t2 ] = py( '[*b.html_image_positions(args), b.strip_html(args)]', '<p>Before</p>\n\n<img src="b.png"/>\n\n<p>After</p>' );
  assert.equal( t2.slice( 0, f2[ 0 ].position ).trim(), 'Before' );
  assert.equal( t2.slice( f2[ 0 ].position ).trim(), 'After' );
} );
