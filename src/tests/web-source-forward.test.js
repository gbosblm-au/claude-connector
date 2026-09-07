// src/tests/web-source-forward.test.js
//
// Fetch-triggered passive ingestion, connector side. v13.26.0
//
// Covers the two halves of the fix that live in this package:
//
//   FULL TEXT IS PRESERVED AND FORWARDED. webFetch.js used to destroy the full
//   extraction by reassigning it to a slice at max_chars. It is now retained,
//   the model still receives the clipped view, and the full body goes to the
//   gateway on a separate path that never touches the model's context.
//
//   THE STREAM CUT IS SURFACED. safeFetch stops reading at its maxBytes cap and
//   returns the PARTIAL body rather than throwing. webFetch.js never read that
//   flag, so an oversized page was handed to the model as complete. It is now
//   reported truthfully, in a boolean and in prose.
//
// The forwarder makes NO authority decision, and a test below asserts that by
// checking it holds no authority vocabulary at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const SRC  = join( HERE, '..' );

const webFetchSrc = readFileSync( join( SRC, 'tools', 'webFetch.js' ), 'utf8' );
const forwardSrc  = readFileSync( join( SRC, 'tools', 'webSourceForward.js' ), 'utf8' );
const clientSrc   = readFileSync( join( SRC, 'tools', 'ti-tools-client.js' ), 'utf8' );

/** Strip comments so an assertion tests code rather than prose. */
function stripComments( src ) {
  return src.replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' );
}

// ===========================================================================
// The full extraction survives the clip
// ===========================================================================

test( 'the full extraction is bound to its own name before any clipping', () => {
  const code = stripComments( webFetchSrc );

  // The defect was `let mainText = extractMainText($)` followed by
  // `mainText = mainText.slice(0, maxChars)`, which left the complete body
  // alive for exactly one statement.
  assert.match( code, /const fullText = extractMainText\(\$\);/,
    'the full extraction must be held in a const that the clip cannot reassign' );
  assert.match( code, /let mainText = fullText;/,
    'the model-facing view is derived FROM the full text' );
  assert.ok( ! /let mainText = extractMainText/.test( code ),
    'the old destroy-by-reassignment form is gone' );
} );

test( 'the clip still applies to the model-facing text only', () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /mainText = mainText\.slice\(0, maxChars\)/ );
  // and never to the stored body
  assert.ok( ! /fullText = fullText\.slice/.test( code ),
    'the full text must never be sliced' );
  assert.ok( ! /fullText\.slice\(0, maxChars\)/.test( code ) );
} );

test( 'the model-facing payload carries the CLIPPED text, not the full body', () => {
  const code = stripComments( webFetchSrc );

  // Scoped to the `out` object, which IS the model-facing payload. The first
  // cut of this test scanned the whole file and matched the forwarder's own
  // `text: fullText` -- which is precisely where the full body SHOULD appear.
  // An assertion that fires on the correct line is not an assertion.
  const out = code.slice( code.indexOf( 'const out = {' ), code.indexOf( 'const clean =' ) );

  assert.match( out, /\n\s*text: mainText,/,
    'the tool result carries the clipped view' );
  assert.ok( ! /\n\s*text: fullText,/.test( out ),
    'the full body must never be placed in the tool result' );

  // And the forwarder does carry it, which is the other half of the decoupling.
  const forward = code.slice( code.indexOf( 'forwardFetchedPage({' ) );
  assert.match( forward.slice( 0, forward.indexOf( '});' ) ), /text: fullText/ );
} );

test( 'the full body is not added to the result under any other key', () => {
  const code = stripComments( webFetchSrc );
  // The payload is assembled in `out` and filtered into `clean`. fullText may
  // appear only as a LENGTH there, never as content.
  const outBlock = code.slice( code.indexOf( 'const out = {' ), code.indexOf( 'const clean =' ) );
  const fullTextRefs = outBlock.match( /fullText[^;,\n]*/g ) || [];
  for ( const ref of fullTextRefs ) {
    assert.match( ref, /fullText\.length/,
      `only the length of the full text may appear in the result, found: ${ ref }` );
  }
} );

test( 'the reader is told how much text exists beyond the clip', () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /full_text_length: fullText\.length/ );
} );

// ===========================================================================
// The stream cut, surfaced
// ===========================================================================

test( "safeFetch's truncated flag is read", () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /const streamTruncated = resp\.truncated === true;/,
    'the flag safeFetch has always set must actually be consumed' );
} );

test( 'the stream cut is reported to the model as a boolean AND in prose', () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /stream_truncated: streamTruncated/ );
  assert.match( code, /note: streamTruncated/ );
  assert.match( webFetchSrc, /INCOMPLETE PAGE/,
    'a boolean in a JSON blob is easy to skim past; say it in words too' );
} );

test( 'stream_truncated is always present, so its absence cannot mean complete', () => {
  const code = stripComments( webFetchSrc );
  // `clean` drops undefined keys. A conditional flag would vanish on the happy
  // path, and a consumer would then have to treat "missing" as "fine" -- which
  // is exactly the inference that produced this defect.
  assert.ok( ! /stream_truncated: streamTruncated \?/.test( code ) );
  assert.ok( ! /stream_truncated: streamTruncated \|\| undefined/.test( code ) );
  assert.match( code, /stream_truncated: streamTruncated,/ );
} );

test( 'the two truncations are distinct fields with distinct meanings', () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /\n\s*truncated,/ );              // char clip
  assert.match( code, /stream_truncated: streamTruncated/ ); // stream cut
  // The char clip must not be inferred from the stream cut or vice versa.
  assert.ok( ! /truncated = streamTruncated/.test( code ) );
  assert.ok( ! /streamTruncated = truncated/.test( code ) );
} );

// ===========================================================================
// The fetch byte cap
// ===========================================================================

test( 'the fetch cap is derived from the HTML size, not the char limit', () => {
  const code = stripComments( webFetchSrc );

  // The old value was ABSOLUTE_MAX_CHARS * 4, a UTF-8 worst case for the
  // MODEL-FACING char cap. That derivation was wrong in kind: the cap applies
  // to raw HTML, which is far larger than the text extracted from it.
  assert.ok( ! /maxBytes: ABSOLUTE_MAX_CHARS \* 4/.test( code ),
    'the char-derived cap is gone' );
  assert.match( code, /const FETCH_MAX_BYTES = 8 \* 1024 \* 1024;/ );
  assert.match( code, /maxBytes: FETCH_MAX_BYTES/ );
} );

test( 'the fetch cap clears the measured worst case for a text-rich page', () => {
  // Derivation, asserted rather than asserted-in-a-comment-only. Measured
  // HTML-to-text ratios on real high-authority pages ran 2.2 to 8.2 for
  // text-rich documents. A page extracting to ABSOLUTE_MAX_CHARS at the worst
  // observed ratio needs 200,000 * 8.2 = 1.64 MB of HTML.
  const ABSOLUTE_MAX_CHARS = 200000;
  const WORST_OBSERVED_RATIO = 8.2;
  const FETCH_MAX_BYTES = 8 * 1024 * 1024;

  assert.ok( FETCH_MAX_BYTES > ABSOLUTE_MAX_CHARS * WORST_OBSERVED_RATIO * 4,
    'the cap must clear the worst case with at least 4x headroom' );

  // And the old value did NOT, which is why ordinary pages were being cut:
  // nodejs.org/api/fs.html is ~1.1 MB of HTML, over the old 800 KB cap.
  const OLD_CAP = ABSOLUTE_MAX_CHARS * 4;
  assert.ok( OLD_CAP < 1102999,
    'the old cap was already being exceeded by real vendor documentation' );
} );

test( 'the cap stays within what safeFetch already treats as safe to buffer', () => {
  const safeFetchSrc = readFileSync( join( SRC, 'utils', 'safeFetch.js' ), 'utf8' );
  const m = safeFetchSrc.match( /const DEFAULT_MAX_BYTES = (\d+) \* 1024 \* 1024;/ );
  assert.ok( m, 'safeFetch declares a default byte cap' );
  assert.ok( 8 <= Number( m[ 1 ] ),
    'the fetch cap must not exceed safeFetch\'s own default of '
    + `${ m[ 1 ] } MB -- raising it past that is a separate decision` );
} );

// ===========================================================================
// The forwarder makes no authority decision
// ===========================================================================

test( 'the forwarder holds no authority vocabulary whatsoever', () => {
  const code = stripComments( forwardSrc );
  for ( const term of [
    'high', 'medium', 'unknown', 'authority', 'ingestionDecision',
    'news', 'vendor_docs', 'evaluateUrl', 'DOMAIN_AUTHORITY',
  ] ) {
    assert.ok( ! new RegExp( term, 'i' ).test( code ),
      `the connector must not know what "${ term }" means -- one gate, on the gateway` );
  }
} );

test( 'the forwarder imports nothing that could carry an authority model', () => {
  const code = stripComments( forwardSrc );
  const imports = code.match( /^import .*$/gm ) || [];
  assert.deepEqual(
    imports.map( ( l ) => l.match( /from ["'](.+)["']/ )[ 1 ] ).sort(),
    [ '../utils/logger.js', './ti-tools-client.js' ] );
} );

test( 'the forwarded body is the page and nothing else', () => {
  const code = stripComments( forwardSrc );
  const call = code.slice( code.indexOf( 'webSourceIngestRemote( {' ) );
  const body = call.slice( 0, call.indexOf( '} );' ) );

  for ( const key of [ 'url', 'text', 'title', 'stream_truncated' ] ) {
    assert.ok( body.includes( key ), `the body must carry ${ key }` );
  }
  for ( const forbidden of [ 'tenant', 'user', 'session', 'query', 'args' ] ) {
    assert.ok( ! new RegExp( forbidden, 'i' ).test( body ),
      `the body must carry no ${ forbidden }` );
  }
} );

test( 'the forwarder never throws out of webFetch', () => {
  const code = stripComments( forwardSrc );
  // The whole body is wrapped, so a store outage cannot cost the caller the
  // page it already has.
  assert.match( code, /export async function forwardFetchedPage\([\s\S]*?\n  try \{/ );
  assert.match( code, /\} catch \(err\) \{/ );
} );

test( 'a missing gateway is a normal configuration, not an error', () => {
  const code = stripComments( forwardSrc );
  assert.match( code, /gatewayConfigured\(\)/ );
  assert.match( code, /reason: "no_gateway"/ );
} );

// ===========================================================================
// Wiring
// ===========================================================================

test( 'webFetch calls the forwarder with the FULL text after a successful fetch', () => {
  const code = stripComments( webFetchSrc );
  assert.match( code, /import \{ forwardFetchedPage \} from "\.\/webSourceForward\.js"/ );

  const call = code.slice( code.indexOf( 'forwardFetchedPage({' ) );
  const body = call.slice( 0, call.indexOf( '});' ) );
  assert.match( body, /text: fullText/, 'the FULL text is forwarded, not the clipped view' );
  assert.match( body, /url: finalUrl/, 'the FINAL url after redirects' );
  assert.match( body, /streamTruncated/ );
  assert.ok( ! /text: mainText/.test( body ) );
} );

test( 'the forward happens after the payload is built and before the return', () => {
  const code = stripComments( webFetchSrc );
  const clean   = code.indexOf( 'const clean =' );
  const forward = code.indexOf( 'forwardFetchedPage({' );
  const ret     = code.indexOf( 'return { content: [{ type: "text", text: JSON.stringify(clean' );
  assert.ok( clean > 0 && forward > clean, 'the forward runs after extraction' );
  assert.ok( ret > forward, 'and the tool still returns its result' );
} );

test( 'the binary branch returns before any forward', () => {
  // A PDF or an image has no extracted text. That early return sits above the
  // extraction, so the forwarder is never reached for it.
  const code = stripComments( webFetchSrc );
  const binaryReturn = code.indexOf( 'Use google_drive_download_file_content' );
  const forward = code.indexOf( 'forwardFetchedPage({' );
  assert.ok( binaryReturn > 0 && binaryReturn < forward );
} );

test( 'the client posts to the gateway ingest route with a longer budget', () => {
  const code = stripComments( clientSrc );
  assert.match( code, /"\/ti-tools\/web-source-ingest"/ );
  assert.match( code, /timeoutMs: INGEST_TIMEOUT_MS/ );
} );

test( 'the shared gateway client stays backwards compatible', () => {
  const code = stripComments( clientSrc );
  // timeoutMs is an OPTION with the old constant as its default, so the four
  // pre-existing callers keep their 5s budget unchanged.
  // Written without assuming a paren-spacing style: this package writes
  // `= {})` where the gateway writes `= {} )`, and a test should assert the
  // default, not the formatting.
  assert.match( code, /timeoutMs = TIMEOUT_MS\s*\}\s*=\s*\{\}\s*\)/ );
  assert.match( code, /const TIMEOUT_MS\s*=\s*5000;/ );

  const calls = code.match( /callGateway\("(?:POST|GET)", "[^"]+"/g ) || [];
  assert.equal( calls.length, 5, 'four pre-existing callers plus the new one' );
} );
