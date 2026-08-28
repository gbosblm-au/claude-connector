/**
 * src/tests/heteronym-resolver.test.js
 *
 * SPEC-HET-002 §12. Table-driven, no model, no venv, no espeak (AC4).
 *
 * ── What "both directions" means and why it is the whole suite ───────────
 *
 * A heteronym rule can fail two ways and only one of them is visible in a demo.
 * Firing when it should is easy to check. NOT firing when it should not is the
 * property that matters, because every rule here targets the MINORITY sense: a
 * false fire mispronounces the common case, which is most sentences.
 *
 * So every entry is asserted in both directions (§12, AC6), and word-boundary
 * safety is asserted separately because "reader" and "leadership" contain the
 * whole surface form and are the obvious way to get this wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveHeteronyms, tokenise, lexicon,
} from '../voice/heteronym-resolver.js';
import { CLASS_A } from '../voice/heteronym-lexicon.js';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve with strategy B on, so both strategies are exercised. */
function resolve( text, opts ) {
  const saved = process.env.VOICE_HETERONYM_STRATEGY_B;
  process.env.VOICE_HETERONYM_STRATEGY_B = 'true';
  try {
    return resolveHeteronyms( text, { markupSupported: true, ...( opts || {} ) } );
  } finally {
    if ( undefined === saved ) delete process.env.VOICE_HETERONYM_STRATEGY_B;
    else process.env.VOICE_HETERONYM_STRATEGY_B = saved;
  }
}

// ===========================================================================
// AC1 and AC2 -- the headline cases
// ===========================================================================

test( 'AC1: past-sense read resolves to the red pronunciation', () => {
  assert.equal( resolve( 'She read the book last night' ).text,
    'She red the book last night' );
} );

test( 'AC2: present-sense read is left untouched', () => {
  assert.equal( resolve( 'I will read it now' ).text, 'I will read it now' );
} );

// ===========================================================================
// Both directions, per rule
// ===========================================================================

const CASES = [
  // [ input, expected, note ]
  [ 'I have read that already', 'I have red that already', 'perfect aspect' ],
  [ "I've read it twice", "I've red it twice", 'contraction as marker' ],
  [ 'I read every day', 'I read every day', 'habitual present' ],
  [ 'Read this when you can', 'Read this when you can', 'imperative' ],

  [ 'a lead pipe burst', 'a led pipe burst', 'material noun' ],
  [ 'lead the team forward', 'lead the team forward', 'the verb' ],
  [ 'sales lead generation', 'sales lead generation', 'business sense' ],

  [ 'he plays bass guitar', 'he plays base guitar', 'musical context' ],
  [ 'we caught a bass', 'we caught a bass', 'the fish, left to the engine' ],

  [ 'tear up the letter', 'tear up the letter', 'strategy B, markup applied' ],

  [ 'Read it yesterday', 'Red it yesterday', 'capitalisation preserved' ],
  [ 'READ IT YESTERDAY', 'RED IT YESTERDAY', 'upper case preserved' ],
];

for ( const [ input, expected, note ] of CASES ) {
  test( `${ note }: ${ JSON.stringify( input ) }`, () => {
    const out = resolve( input ).text;
    // Strategy B entries wrap rather than replace, so compare on the wrapper
    // being present instead of demanding an exact string.
    if ( out.includes( '](/' ) ) {
      // Markup WRAPS: "tear" becomes "[tear](/tˈɛr/)". The original word must
      // still be present inside the brackets -- a replacement would change
      // what misaki phonemises, and an engine that ignored the override would
      // then speak the wrong word rather than the right one badly.
      const word = input.split( ' ' )[ 0 ];
      assert.ok( out.includes( `[${ word }](/` ),
        `markup must wrap ${ word }, not replace it: ${ out }` );
      return;
    }
    assert.equal( out, expected );
  } );
}

test( 'word boundaries are respected', () => {
  // The single easiest way to get this wrong, and the most audible.
  const safe = 'The reader read leadership articles about misleading bassoons';
  const out = resolve( safe ).text;

  assert.ok( out.includes( 'reader' ), 'reader must survive' );
  assert.ok( out.includes( 'leadership' ), 'leadership must survive' );
  assert.ok( out.includes( 'misleading' ), 'misleading must survive' );
  assert.ok( out.includes( 'bassoons' ), 'bassoons must survive' );
} );

test( 'each occurrence is judged on its own context', () => {
  // A regex over the whole string would rewrite both, or neither. The
  // positional rewrite is what makes one sentence able to hold both senses.
  const out = resolve( 'I read every day, and I read that one yesterday' ).text;
  assert.ok( out.includes( 'I read every day' ), 'the present sense stays' );
  assert.ok( out.includes( 'red that one yesterday' ), 'the past sense resolves' );
} );

test( 'resolution does not run twice', () => {
  const once = resolve( 'I have read it' ).text;
  assert.equal( resolve( once ).text, once,
    'a resolved text must be stable, or repeated passes compound' );
} );

// ===========================================================================
// §4.2 and §11 -- every error path lands on today's behaviour
// ===========================================================================

test( 'AC5: a resolver fault yields the unmodified input', () => {
  const saved = process.env.VOICE_HETERONYM_LEXICON;
  // A lexicon entry shaped to break the matcher.
  process.env.VOICE_HETERONYM_LEXICON = JSON.stringify( {
    read: { word: 'read', strategy: 'A', respell: null, confidence: 'high',
            when: 'not-an-array' },
  } );
  try {
    const input = 'I have read it';
    assert.equal( resolveHeteronyms( input, { markupSupported: true } ).text, input );
  } finally {
    if ( undefined === saved ) delete process.env.VOICE_HETERONYM_LEXICON;
    else process.env.VOICE_HETERONYM_LEXICON = saved;
  }
} );

test( 'malformed lexicon JSON falls back to the built-in table', () => {
  const saved = process.env.VOICE_HETERONYM_LEXICON;
  process.env.VOICE_HETERONYM_LEXICON = '{ broken';
  try {
    assert.equal( lexicon().length, CLASS_A.length );
    assert.equal( resolve( 'I have read it' ).text, 'I have red it' );
  } finally {
    if ( undefined === saved ) delete process.env.VOICE_HETERONYM_LEXICON;
    else process.env.VOICE_HETERONYM_LEXICON = saved;
  }
} );

test( 'the resolver is total', () => {
  for ( const input of [ undefined, null, '', 0, [], {}, 'x'.repeat( 50_000 ) ] ) {
    assert.doesNotThrow( () => resolveHeteronyms( input, {} ) );
  }
  assert.equal( resolveHeteronyms( null, {} ).text, '' );
} );

test( 'the master switch disables everything', () => {
  const saved = process.env.VOICE_HETERONYM_RESOLVE;
  process.env.VOICE_HETERONYM_RESOLVE = 'false';
  try {
    assert.equal( resolve( 'I have read it' ).text, 'I have read it' );
  } finally {
    if ( undefined === saved ) delete process.env.VOICE_HETERONYM_RESOLVE;
    else process.env.VOICE_HETERONYM_RESOLVE = saved;
  }
} );

// ===========================================================================
// §5.2 and §11 item 12 -- strategy B is inert on espeak
// ===========================================================================

test( 'strategy B emits no markup when the g2p cannot read it', () => {
  // espeak would SPEAK the brackets. Suppression is recorded rather than
  // silent, exactly as the emphasis and lexicon machinery already behaves.
  const out = resolve( 'tear up the letter', { markupSupported: false } );

  assert.equal( out.text, 'tear up the letter' );
  assert.ok( out.suppressed.some( ( sup ) => 'heteronym_needs_misaki_g2p' === sup.reason ) );
} );

test( 'strategy B is off by default', () => {
  // OD-1 and OD-2 are unresolved: the exact IPA subset misaki accepts has not
  // been validated, and an unaccepted symbol is worse than no override.
  const out = resolveHeteronyms( 'tear up the letter', { markupSupported: true } );
  assert.equal( out.text, 'tear up the letter' );
  assert.ok( out.suppressed.some( ( sup ) => 'strategy_b_disabled' === sup.reason ) );
} );

test( 'strategy A works on both g2p paths', () => {
  // §5.1: it finishes before phonemisation starts, so it needs no markup.
  assert.equal( resolve( 'I have read it', { markupSupported: false } ).text,
    'I have red it' );
} );

// ===========================================================================
// AC6 -- low-confidence entries ship disabled
// ===========================================================================

test( 'low-confidence entries do not fire', () => {
  // §7 and AC6: they need an ear test (OD-4) before they are enabled, and
  // "moapt" in particular is not a word.
  for ( const entry of CLASS_A.filter( ( e ) => 'low' === e.confidence ) ) {
    const probe = `the ${ entry.word } around`;
    assert.equal( resolve( probe ).text, probe,
      `${ entry.word } is low confidence and must ship disabled` );
  }
} );

test( 'every table entry declares what it needs', () => {
  for ( const entry of CLASS_A ) {
    assert.ok( entry.word, 'every entry needs a word' );
    assert.ok( [ 'A', 'B' ].includes( entry.strategy ), `${ entry.word }: strategy` );
    assert.ok( [ 'high', 'medium', 'low' ].includes( entry.confidence ),
      `${ entry.word }: confidence` );
    if ( 'A' === entry.strategy ) {
      assert.ok( entry.respell, `${ entry.word }: strategy A needs a homophone` );
    } else {
      assert.ok( entry.ipa, `${ entry.word }: strategy B needs IPA` );
    }
  }
} );

test( 'tokenising keeps contractions whole', () => {
  // "I've" must be one token or it cannot be matched as a past marker.
  const tokens = tokenise( "I've read it" ).map( ( t ) => t.lower );
  assert.deepEqual( tokens, [ "i've", 'read', 'it' ] );
} );

// ===========================================================================
// AC3 -- the written text is never altered for the reader
// ===========================================================================

test( 'AC3: the caller\'s string is not mutated', () => {
  // The resolver returns a NEW string for the engine. The transcript, the
  // displayed message and anything persisted keep the author's words.
  const input = 'I have read it';
  const before = String( input );
  resolve( input );
  assert.equal( input, before );
} );

test( 'the call site EXECUTES without throwing', () => {
  // v13.23.3, and the reason voice was "dropping out at random intervals".
  //
  // withHeteronyms called log(), which voice-engines.js has never imported.
  // Every branch that logged threw ReferenceError, the catch swallowed it, and
  // synthesize / synthesizeProsody / synthesizeProsodyStream all failed --
  // tts_failed, tts_stream_error, tts_incremental_error, prosody fallback --
  // whenever a reply happened to contain a heteronym. Random-looking, entirely
  // deterministic.
  //
  // Every other test in this file READS the call site. None ran it, which is
  // exactly why a missing import survived them all. This one extracts the
  // helper and executes it.
  const src = readFileSync(
    join( dirname( fileURLToPath( import.meta.url ) ), '..', 'voice',
          'voice-engines.js' ), 'utf8' );

  const body = src.slice( src.indexOf( 'function withHeteronyms' ),
                          src.indexOf( 'export async function synthesize(' ) );
  assert.ok( body.length > 200, 'withHeteronyms was not found' );

  // eslint-disable-next-line no-new-func
  const withHeteronyms = new Function( 'resolveHeteronyms', 'g2pMode',
    `${ body }; return withHeteronyms;` )( resolveHeteronyms, () => 'espeak' );

  // One input per branch: a resolved word, a suppressed one, and neither.
  assert.equal( withHeteronyms( 'She read the book last night', 'synthesize' ),
    'She red the book last night' );
  assert.equal( withHeteronyms( 'tear up the letter', 'synthesizeProsody' ),
    'tear up the letter' );
  assert.equal( withHeteronyms( 'plain text', 'synthesizeProsodyStream' ),
    'plain text' );
} );

test( 'the call site uses only identifiers its module actually has', () => {
  // The general form. voice-engines.js logs with console.*; a bare log() there
  // is an identifier from a different file's conventions, and it fails only on
  // the branch that reaches it.
  const src = readFileSync(
    join( dirname( fileURLToPath( import.meta.url ) ), '..', 'voice',
          'voice-engines.js' ), 'utf8' );

  const code = src.split( '\n' )
    .filter( ( l ) => {
      const t = l.trim();
      return ! t.startsWith( '//' ) && ! t.startsWith( '*' ) && ! t.startsWith( '/*' );
    } )
    .join( '\n' );

  const importsLog = /import\s*\{[^}]*\blog\b[^}]*\}\s*from/.test( code );
  const callsLog = /(?<![.\w])log\(/.test( code );

  assert.ok( ! callsLog || importsLog,
    'voice-engines.js calls log() without importing it. Every branch reaching '
    + 'that call throws ReferenceError, and the surrounding catch turns it into '
    + 'a synthesis failure.' );
} );

test( 'AC3: the resolved text is used only for synthesis', () => {
  // Asserted at the call site, because that is where the property lives: the
  // engines pass the resolved string onward and never write it back.
  const src = readFileSync(
    join( dirname( fileURLToPath( import.meta.url ) ), '..', 'voice',
          'voice-engines.js' ), 'utf8' );

  assert.match( src, /function withHeteronyms\(text, where\)/ );
  // Three call sites, per §9.
  assert.equal( src.split( 'withHeteronyms(' ).length - 1, 4,
    'one definition plus exactly three call sites' );
  // Never in the per-phrase path, which would destroy the context.
  // Each CALL is identified by the where-label it passes, which names the
  // function it sits in. That is exact, where a positional slice is not: the
  // helper is defined immediately before synthesize(), so any window anchored
  // on synthesizePcm swallows the definition and reports a neighbour's correct
  // call as this function's mistake. It did.
  // Located by FUNCTION BOUNDARIES, not by the label the call passes.
  //
  // The label is a string I wrote, so it agrees with my intention rather than
  // with reality. The first version of this change put the call inside
  // synthesizePcm -- the per-phrase path §9 explicitly forbids -- while passing
  // the label 'synthesize'. The label assertion passed. The code was wrong.
  //
  // This computes which function each call actually sits in.
  const bounds = [ ...src.matchAll( /^export async function (\w+)/gm ) ]
    .map( ( m ) => ( { name: m[ 1 ], at: m.index } ) );
  assert.ok( bounds.length > 3, 'function boundaries were not found' );

  const sites = [ ...src.matchAll( /withHeteronyms\(/g ) ]
    .map( ( m ) => m.index )
    // The first occurrence is the definition, which is not a call.
    .filter( ( at ) => ! src.slice( at - 20, at ).includes( 'function ' ) )
    .map( ( at ) => {
      let fn = '(top level)';
      for ( const b of bounds ) if ( b.at < at ) fn = b.name;
      return fn;
    } );

  assert.deepEqual( sites.slice().sort(),
    [ 'synthesize', 'synthesizeProsody', 'synthesizeProsodyStream' ],
    `§9 names exactly these three functions; the calls are in: ${ sites.join( ', ' ) }` );

  // The per-phrase path, named explicitly because putting it there is the
  // mistake that was actually made.
  assert.ok( ! sites.includes( 'synthesizePcm' ),
    'synthesizePcm is per-phrase; resolution there destroys the sentence context' );
  assert.ok( ! sites.includes( 'prepareForKokoro' ) );
} );
