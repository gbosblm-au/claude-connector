// src/tests/trigger-phrases-wo-2026-11-24-03.test.js
// ---------------------------------------------------------------------------
// WO-2026-11-24-03: trigger-phrase validation, the rule, and making a drop
// impossible to miss.
//
//   R1  condition 3 ("no stopword at either end") is replaced. As shipped,
//       per Brian's decision recorded on delivery: a phrase is refused as a
//       stopword phrase only when every token is a stopword (R1 (a)). R1 (b)
//       ("fewer than two non-stopword tokens") is NOT shipped: run against
//       R2 with the unchanged stopword list it refused four of the six rows
//       R2 requires kept ("where should I stay in", "what are you curious
//       about", "for their own good", "held against my will"). The R1 (b)
//       row below pins that it stays out.
//   R2  the thirteen-row falsifier, one subtest per row, through the real lint
//       and through a real module_write.
//   R3  option (b): the trigger_dropped block persisted beside triggers; C-L
//       reads it (refused_on_write vs would_be_refused_on_next_write) and
//       reconciles frontmatter phrases against the registration.
//   R4  the six constructed negative inputs, each run through module_write.
//   R5  keyword validation unchanged; the frozen manifests untouched.
//   R6  C-L's phrase_rederivation: newly kept, still refused, refused only as
//       a substring, reported separately.
//
// Drives the real module_write handler and the real audit against throwaway
// volumes. Module ids and phrase sets here are constructed inputs; where a
// phrase is quoted from the order's table it is used only as a phrase.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const { handleModuleWrite } = await import( '../tools/skill-content.js' );
const { runConsistencyAudit, reconcileFrontmatterPhrases, CL_STATE } = await import( '../tools/module-consistency.js' );
const MF = await import( '../tools/manifest-fragments.js' );

const sha = ( b ) => createHash( 'sha256' ).update( b ).digest( 'hex' );

/** A throwaway volume with the three frozen compile inputs present, so R5 can hash them. */
function volume( { fragments = {}, files = {} } = {} ) {
  const root = mkdtempSync( join( tmpdir(), 'wo-24-03-' ) );
  const ava = join( root, 'ava' );
  for ( const d of [ 'modules', 'references/manifest' ] ) mkdirSync( join( ava, d ), { recursive: true } );
  writeFileSync( join( ava, 'MANIFEST.json' ), JSON.stringify( { modules: [], budget: {} } ) );
  writeFileSync( join( ava, 'MANIFEST_APPEND.json' ), JSON.stringify( { modules: [] } ) );
  writeFileSync( join( ava, 'DISPATCH_RULES.json' ), JSON.stringify( { rules: [] } ) );
  for ( const [ name, frag ] of Object.entries( fragments ) ) {
    const obj = Array.isArray( frag ) ? { source: name.replace( /^\d+-|\.json$/g, '' ), modules: frag } : frag;
    writeFileSync( join( ava, 'references', 'manifest', name ), JSON.stringify( obj, null, 2 ) );
  }
  for ( const [ p, content ] of Object.entries( files ) ) {
    mkdirSync( dirname( join( ava, p ) ), { recursive: true } );
    writeFileSync( join( ava, p ), content );
  }
  return { root, ava, done: () => rmSync( root, { recursive: true, force: true } ) };
}

/** Run fn with SKILL_FILE_PATH at the volume and no WordPress backup. */
async function on( vol, fn ) {
  const saved = { s: process.env.SKILL_FILE_PATH, u: process.env.WP_SKILL_URL, k: process.env.WP_SKILL_KEY };
  process.env.SKILL_FILE_PATH = join( vol.root, 'SKILL.md' );
  delete process.env.WP_SKILL_URL;
  delete process.env.WP_SKILL_KEY;
  try { return await fn(); } finally {
    for ( const [ k, v ] of [ [ 'SKILL_FILE_PATH', saved.s ], [ 'WP_SKILL_URL', saved.u ], [ 'WP_SKILL_KEY', saved.k ] ] ) {
      if ( v === undefined ) delete process.env[ k ]; else process.env[ k ] = v;
    }
  }
}

const write = async ( args ) => {
  const r = await handleModuleWrite( args, { actor: 'test' } );
  return { body: JSON.parse( r.content[ 0 ].text ), isError: r.isError === true };
};

/** Every fragment file, parsed. */
function fragments( vol ) {
  const dir = join( vol.ava, 'references', 'manifest' );
  return Object.fromEntries( readdirSync( dir ).filter( ( n ) => n.endsWith( '.json' ) ).sort()
    .map( ( n ) => [ n, JSON.parse( readFileSync( join( dir, n ), 'utf8' ) ) ] ) );
}

/** Every fragment registration of an id. */
function fragmentRegistrationsOf( vol, id ) {
  const out = [];
  for ( const [ name, frag ] of Object.entries( fragments( vol ) ) ) for ( const m of frag.modules || [] ) if ( m.id === id ) out.push( { source: name, entry: m } );
  return out;
}

/** The one fragment registration of an id (asserts there is exactly one). */
function theEntry( vol, id ) {
  const regs = fragmentRegistrationsOf( vol, id );
  assert.equal( regs.length, 1, `expected one fragment registration of ${ id }, found ${ regs.length }` );
  return regs[ 0 ].entry;
}

/** Every file under avaDir with its hash. */
function tree( vol ) {
  const out = {};
  ( function walk( d ) {
    for ( const n of readdirSync( d ) ) {
      const p = join( d, n );
      if ( lstatSync( p ).isDirectory() ) walk( p );
      else out[ relative( vol.ava, p ) ] = sha( readFileSync( p ) );
    }
  } )( vol.ava );
  return out;
}

/** A module with a frontmatter triggers: block. */
const moduleWith = ( id, { phrases = null, keywords = null, version = null } = {} ) => {
  const lines = [ '---', `id: ${ id }` ];
  if ( version ) lines.push( `version: ${ version }` );
  if ( phrases || keywords ) {
    lines.push( 'triggers:' );
    if ( keywords ) { lines.push( '  keywords:' ); for ( const k of keywords ) lines.push( `    - ${ k }` ); }
    if ( phrases ) { lines.push( '  phrases:' ); for ( const p of phrases ) lines.push( `    - ${ p }` ); }
  }
  lines.push( '---', `# ${ id }`, 'Body text.', '' );
  return lines.join( '\n' );
};

const lower = ( xs ) => xs.map( ( x ) => x.toLowerCase() );

// ─────────────────────────────── R2 ────────────────────────────────────────

/** The order's thirteen rows, verbatim. */
const R2_ROWS = [
  [ 'into the', 'refused' ],
  [ 'and the', 'refused' ],
  [ 'with the', 'refused' ],
  [ 'not the', 'refused' ],
  [ 'the past', 'refused' ],
  [ 'plan a trip to', 'kept' ],
  [ 'where should I stay in', 'kept' ],
  [ 'what are you curious about', 'kept' ],
  [ 'for their own good', 'kept' ],
  [ 'held against my will', 'kept' ],
  [ 'nobody asked me', 'kept' ],
  [ 'go', 'refused' ],
  [ 'kpi', 'refused' ],
];

R2_ROWS.forEach( ( [ phrase, want ], i ) => {
  test( `R2 row ${ i + 1 }: "${ phrase }" is ${ want }`, () => {
    const reasons = MF.phraseLintReasons( phrase, [] );
    assert.equal( reasons.length ? 'refused' : 'kept', want, `reasons: ${ JSON.stringify( reasons ) }` );
  } );
} );

test( 'R2 discard condition: "into the" is refused, and refused as consisting only of stopwords', () => {
  const reasons = MF.phraseLintReasons( 'into the', [] );
  assert.ok( reasons.some( ( r ) => r.startsWith( MF.PHRASE_STOPWORDS_ONLY_REASON ) ), JSON.stringify( reasons ) );
  // Not refused only by the length floor: a 12-character all-stopword phrase is refused too.
  assert.ok( MF.phraseLintReasons( 'into the very same', [] ).some( ( r ) => r.startsWith( MF.PHRASE_STOPWORDS_ONLY_REASON ) ) );
} );

test( 'R1 (b) is not shipped: one content word among stopwords is enough, so the four R2 rows it refused are kept', () => {
  // These four have exactly one non-stopword token under the unchanged list
  // ("should", "about", "own" and "will" are stopwords). R1 (b) refused them.
  for ( const p of [ 'where should I stay in', 'what are you curious about', 'for their own good', 'held against my will' ] ) {
    const content = p.split( /\s+/ ).filter( ( t ) => ! MF.REGISTRATION_STOPWORDS.includes( t.toLowerCase() ) );
    assert.equal( content.length, 1, `${ p }: ${ content }` );
    assert.deepEqual( MF.phraseLintReasons( p, [] ), [], p );
  }
} );

test( 'R1: the stopword list is unchanged, and a lone punctuation token carries no content', () => {
  assert.equal( MF.REGISTRATION_STOPWORDS.length, 144 );
  assert.equal( sha( JSON.stringify( MF.REGISTRATION_STOPWORDS ) ), STOPWORD_LIST_SHA );
  assert.equal( MF.phraseIsStopwordsOnly( 'into the -- of' ), true );
  assert.equal( MF.phraseIsStopwordsOnly( 'into the void' ), false );
  assert.equal( MF.phraseIsStopwordsOnly( 'Into, THE!' ), true, 'case and edge punctuation are ignored' );
} );

test( 'R2 through module_write: the six rows are stored, the seven are refused and recorded in trigger_dropped', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'travel/r2-falsifier.md', content: moduleWith( 'r2-falsifier', { phrases: R2_ROWS.map( ( r ) => r[ 0 ] ) } ) } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'r2-falsifier' );
      assert.deepEqual( e.triggers.phrases, R2_ROWS.filter( ( r ) => r[ 1 ] === 'kept' ).map( ( r ) => r[ 0 ] ) );
      assert.deepEqual( e.trigger_dropped.map( ( d ) => d.phrase ), R2_ROWS.filter( ( r ) => r[ 1 ] === 'refused' ).map( ( r ) => r[ 0 ] ) );
      assert.ok( e.trigger_dropped.every( ( d ) => typeof d.reason === 'string' && d.reason.length > 0 ) );
    } );
  } finally { vol.done(); }
} );

// The list as it stood before this order (manifest-fragments.js v13.40.0).
const STOPWORD_LIST_SHA = sha( JSON.stringify( [
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'than', 'as', 'because', 'while', 'though', 'although', 'whether',
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'down', 'with',
  'within', 'without', 'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'before', 'behind',
  'below', 'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'inside', 'near', 'outside', 'past', 'since',
  'through', 'throughout', 'toward', 'towards', 'under', 'underneath', 'until', 'upon', 'via',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them',
  'their', 'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'all', 'any', 'each', 'some', 'such', 'own', 'same', 'very', 'too', 'just', 'also',
  'there', 'here', 'when', 'where', 'why', 'how', 'again', 'once', 'only', 'both', 'few', 'more', 'most', 'other',
] ) );

// ─────────────────────────────── R4 ────────────────────────────────────────

test( 'R4-1: a module with no triggers: block registers with none, triggers_source "none", a warning, no crash', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body, isError } = await write( { file: 'travel/r4-none.md', content: moduleWith( 'r4-none' ) } );
      assert.equal( isError, false );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'r4-none' );
      assert.equal( e.triggers_source, 'none' );
      assert.deepEqual( e.triggers, { keywords: [], phrases: [], task_class: [] } );
      assert.deepEqual( e.trigger_dropped, [], 'nothing was supplied, so nothing was refused' );
      assert.ok( body.registration_warnings.some( ( w ) => w.code === 'registered_without_triggers' && w.module_id === 'r4-none' ) );
    } );
  } finally { vol.done(); }
} );

test( 'R4-2: every phrase only stopwords: all refused under (a), the module still registers, no crash', async () => {
  // Each is at least 12 characters and two words, so condition 3 alone refuses it.
  const phrases = [ 'with all of them', 'into the very same', 'and then there' ];
  for ( const p of phrases ) assert.ok( [ ...p ].length >= 12 && p.split( ' ' ).length >= 2, p );
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body, isError } = await write( { file: 'travel/r4-stop.md', content: moduleWith( 'r4-stop', { phrases } ) } );
      assert.equal( isError, false );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'r4-stop' );
      assert.deepEqual( e.triggers.phrases, [] );
      assert.equal( e.triggers_source, 'none', 'nothing survived, so it is registered without triggers' );
      assert.deepEqual( e.trigger_dropped.map( ( d ) => d.phrase ), phrases );
      for ( const d of e.trigger_dropped ) assert.ok( d.reason.startsWith( MF.PHRASE_STOPWORDS_ONLY_REASON ), d.reason );
      assert.equal( body.registration_warnings.filter( ( w ) => w.code === 'trigger_dropped' ).length, 3 );
    } );
  } finally { vol.done(); }
} );

test( 'R4-3: a phrase that is a strict substring of another: the shorter is refused under condition 4, the longer kept', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      await write( { file: 'travel/r4-sub.md', content: moduleWith( 'r4-sub', { phrases: [ 'book a flight home', 'book a flight home today' ] } ) } );
      const e = theEntry( vol, 'r4-sub' );
      assert.deepEqual( e.triggers.phrases, [ 'book a flight home today' ] );
      assert.equal( e.trigger_dropped.length, 1 );
      assert.equal( e.trigger_dropped[ 0 ].phrase, 'book a flight home' );
      assert.equal( e.trigger_dropped[ 0 ].reason, `${ MF.PHRASE_SUBSTRING_REASON_PREFIX } ("book a flight home today")`, 'condition 4 only' );
    } );
  } finally { vol.done(); }
} );

test( 'R4-4: exactly 12 characters with two non-stopword tokens is kept', async () => {
  assert.equal( [ ...'spring break' ].length, 12 );
  const vol = volume();
  try {
    await on( vol, async () => {
      await write( { file: 'travel/r4-twelve.md', content: moduleWith( 'r4-twelve', { phrases: [ 'spring break' ] } ) } );
      const e = theEntry( vol, 'r4-twelve' );
      assert.deepEqual( e.triggers.phrases, [ 'spring break' ] );
      assert.deepEqual( e.trigger_dropped, [] );
    } );
  } finally { vol.done(); }
} );

test( 'R4-5: 11 characters with two non-stopword tokens is refused', async () => {
  assert.equal( [ ...'summer camp' ].length, 11 );
  const vol = volume();
  try {
    await on( vol, async () => {
      await write( { file: 'travel/r4-eleven.md', content: moduleWith( 'r4-eleven', { phrases: [ 'summer camp' ] } ) } );
      const e = theEntry( vol, 'r4-eleven' );
      assert.deepEqual( e.triggers.phrases, [] );
      assert.deepEqual( e.trigger_dropped, [ { phrase: 'summer camp', reason: `shorter than ${ MF.PHRASE_MIN_CHARS } characters` } ] );
    } );
  } finally { vol.done(); }
} );

test( 'R4-6: a re-write with an unchanged triggers: block stores the identical set and block, and mints no second registration', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const content = moduleWith( 'r4-again', { keywords: [ 'travel', 'itinerary' ], phrases: [ 'plan a trip to', 'into the', 'summer camp', 'find flights to' ] } );
      const first = await write( { file: 'travel/r4-again.md', content } );
      assert.equal( first.body.success, true, JSON.stringify( first.body ) );
      // The ledger (.ledger/) is append-only and records every write; everything else must not move.
      const registers = ( t ) => Object.fromEntries( Object.entries( t ).filter( ( [ k ] ) => ! k.startsWith( '.ledger' ) ) );
      const fragsAfterFirst = registers( tree( vol ) );
      assert.ok( Object.keys( fragsAfterFirst ).some( ( k ) => k.startsWith( 'references/manifest/' ) ) );
      const e1 = theEntry( vol, 'r4-again' );
      assert.ok( e1.trigger_dropped.length >= 3, 'the input has refusals, so idempotence of the block is exercised' );

      const second = await write( { file: 'travel/r4-again.md', content, force: true } );
      assert.equal( second.body.success, true, JSON.stringify( second.body ) );
      const e2 = theEntry( vol, 'r4-again' );
      assert.deepEqual( e2.triggers, e1.triggers, 'the stored set is identical' );
      assert.deepEqual( e2.trigger_dropped, e1.trigger_dropped, 'the trigger_dropped block is identical' );
      assert.deepEqual( e2, e1, 'the whole entry is identical' );
      assert.equal( fragmentRegistrationsOf( vol, 'r4-again' ).length, 1, 'no second registration' );
      assert.deepEqual( registers( tree( vol ) ), fragsAfterFirst, 'every file outside the ledger, fragments included, is byte-identical after the re-write' );
    } );
  } finally { vol.done(); }
} );

// ─────────────────────────────── R3 ────────────────────────────────────────

test( 'R3-5: refusals are persisted beside triggers, phrases and keywords, never inside triggers', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      await write( { file: 'travel/r3-persist.md', content: moduleWith( 'r3-persist', { keywords: [ 'travel', 'flights', 'module' ], phrases: [ 'plan a trip to', 'and the' ] } ) } );
      const raw = JSON.parse( readFileSync( join( vol.ava, 'references', 'manifest', Object.keys( fragments( vol ) )[ 0 ] ), 'utf8' ) );
      const e = raw.modules.find( ( m ) => m.id === 'r3-persist' );
      const keys = Object.keys( e );
      assert.equal( keys.indexOf( 'trigger_dropped' ), keys.indexOf( 'triggers_source' ) + 1, 'beside triggers' );
      assert.equal( 'trigger_dropped' in e.triggers, false, 'the compile scores triggers; a refusal is never inside it' );
      assert.deepEqual( e.triggers.phrases, [ 'plan a trip to' ] );
      assert.deepEqual( e.triggers.keywords, [ 'flights' ] );
      assert.deepEqual( e.trigger_dropped.map( ( d ) => d.keyword || d.phrase ), [ 'travel', 'module', 'and the' ] );
      assert.match( e.trigger_dropped[ 0 ].reason, /segment of the module's own path/ );
      assert.match( e.trigger_dropped[ 2 ].reason, /consists only of stopwords/ );
    } );
  } finally { vol.done(); }
} );

test( 'R3-5: a manifest_entry cannot supply trigger_dropped; an update with no triggers keeps the block it had', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const content = moduleWith( 'r3-keep', { phrases: [ 'plan a trip to', 'with the' ] } );
      await write( { file: 'travel/r3-keep.md', content, manifest_entry: { trigger_dropped: [ { phrase: 'forged', reason: 'not from the lint' } ] } } );
      const e1 = theEntry( vol, 'r3-keep' );
      assert.deepEqual( e1.trigger_dropped.map( ( d ) => d.phrase ), [ 'with the' ], 'the lint decides the block' );

      // A body edit with no triggers block: triggers and their record are retained (R3 of WO-2026-11-21-02).
      await write( { file: 'travel/r3-keep.md', content: '---\nid: r3-keep\n---\n# r3-keep\nEdited.\n', force: true } );
      const e2 = theEntry( vol, 'r3-keep' );
      assert.deepEqual( e2.triggers, e1.triggers );
      assert.deepEqual( e2.trigger_dropped, e1.trigger_dropped );
    } );
  } finally { vol.done(); }
} );

test( 'R3-5: retained triggers from a registration written before this order get no invented trigger_dropped', async () => {
  const legacy = { id: 'r3-legacy', title: 'r3-legacy', category: 'travel', path: 'modules/travel/r3-legacy.md', load_priority: 5,
    triggers: { keywords: [ 'flights' ], phrases: [], task_class: [] }, triggers_source: 'frontmatter',
    depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: 3, always_load: false, registered_by: 'module_write' };
  const vol = volume( { fragments: { '100-travel.json': [ legacy ] }, files: { 'modules/travel/r3-legacy.md': '# r3-legacy\nOld.\n' } } );
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'travel/r3-legacy.md', content: '# r3-legacy\nNew.\n', force: true } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'r3-legacy' );
      assert.deepEqual( e.triggers, legacy.triggers );
      assert.equal( 'trigger_dropped' in e, false, 'what that write refused is not known, so nothing is recorded' );
    } );
  } finally { vol.done(); }
} );

test( 'R3-6: C-L tells a refusal recorded on write from a stored phrase the next write would refuse', async () => {
  const vol = volume( {
    files: { 'modules/travel/r3-states.md': '# r3-states\nNo frontmatter.\n' },
    fragments: { '100-travel.json': [ { id: 'r3-states', path: 'modules/travel/r3-states.md', line_count_estimate: 3,
      triggers: { keywords: [], phrases: [ 'with all of them', 'plan a trip to' ], task_class: [] },
      trigger_dropped: [ { phrase: 'into the', reason: 'consists only of stopwords ("into", "the"); shorter than 12 characters' },
        { phrase: 'summer camp', reason: 'shorter than 12 characters' } ] } ] },
  } );
  try {
    await on( vol, async () => {
      const cl = runConsistencyAudit( { checks: [ 'C-L' ] } ).advisory[ 'C-L' ];
      const sp = cl.findings.filter( ( f ) => f.kind === 'stopword_phrase' );
      assert.deepEqual( sp.map( ( f ) => [ f.value, f.state, f.live_loss ] ).sort(), [
        [ 'into the', CL_STATE.REFUSED_ON_WRITE, true ],
        [ 'with all of them', CL_STATE.WOULD_BE_REFUSED, false ],
      ] );
      const other = cl.findings.filter( ( f ) => f.kind === 'trigger_dropped' );
      assert.deepEqual( other.map( ( f ) => [ f.value, f.state, f.field ] ), [ [ 'summer camp', CL_STATE.REFUSED_ON_WRITE, 'phrases' ] ] );
      assert.equal( cl.by_state[ CL_STATE.REFUSED_ON_WRITE ], 2 );
      assert.equal( cl.by_state[ CL_STATE.WOULD_BE_REFUSED ], 1 );
      assert.equal( cl.blocks, false );
    } );
  } finally { vol.done(); }
} );

test( 'R3-7: a module whose frontmatter declares phrases the registration does not hold gets a C-L finding naming it and the count', async () => {
  // The state the order describes: the file says nine phrases, the fragment
  // says none, and nothing records why (a registration written under the old
  // rule). Constructed: nine phrases, of which the old rule refused all nine.
  const nine = [ 'nobody asked me', 'I never actually agreed', 'for their own good', 'held against my will', 'what are you curious about',
    'plan a trip to', 'into the', 'travel from', 'flights to tokyo' ];
  const declared = [ ...nine, 'find flights to tokyo' ];
  // The rule this order replaces (conditions 1, 2, the edge-stopword condition 3, and 4).
  const old = ( p ) => {
    const t = p.split( ' ' );
    const sw = ( w ) => MF.REGISTRATION_STOPWORDS.includes( w.toLowerCase() );
    return t.length < 2 || p.length < 12 || sw( t[ 0 ] ) || sw( t[ t.length - 1 ] )
      || declared.some( ( o ) => o !== p && o.toLowerCase().includes( p.toLowerCase() ) );
  };
  assert.ok( nine.every( old ), 'every one of the nine was refused by the rule this order replaces' );
  assert.equal( old( 'find flights to tokyo' ), false, 'and the tenth was kept by it' );
  const id = 'consent-probe';
  const content = moduleWith( id, { phrases: declared } );
  const vol = volume( {
    files: { [ `modules/phil/${ id }.md` ]: content },
    fragments: { '100-phil.json': [ { id, path: `modules/phil/${ id }.md`, line_count_estimate: content.split( '\n' ).length,
      triggers: { keywords: [], phrases: [ 'find flights to tokyo' ], task_class: [] }, triggers_source: 'frontmatter' } ] },
  } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const cl = runConsistencyAudit( { checks: [ 'C-L' ] } ).advisory[ 'C-L' ];
      const f = cl.findings.find( ( x ) => x.kind === 'frontmatter_phrases_unregistered' );
      assert.ok( f, JSON.stringify( cl.by_kind ) );
      assert.equal( f.id, id );
      assert.equal( f.count, 9 );
      assert.equal( f.declared, 10 );
      assert.equal( f.registered, 1 );
      assert.equal( f.unrecorded, 9, 'nothing recorded why: the original loss' );
      assert.deepEqual( f.value, nine );

      // R6 on the same input: recall gained and precision spent, separately.
      const r = cl.phrase_rederivation;
      assert.deepEqual( r.newly_kept.map( ( x ) => x.phrase ), [ 'nobody asked me', 'I never actually agreed', 'for their own good',
        'held against my will', 'what are you curious about', 'plan a trip to' ] );
      assert.deepEqual( r.still_refused.map( ( x ) => x.phrase ), [ 'into the', 'travel from' ] );
      assert.ok( r.still_refused.every( ( x ) => x.reasons.length > 0 ) );
      assert.deepEqual( r.refused_as_substring.map( ( x ) => x.phrase ), [ 'flights to tokyo' ] );
      assert.equal( r.newly_kept_count + r.still_refused_count + r.refused_as_substring_count, f.count );
      assert.deepEqual( tree( vol ), before, 'the audit writes nothing' );

      // The module is written again: the phrases are restored, the refusals
      // recorded, and the finding now counts only recorded refusals.
      const { body } = await write( { file: `phil/${ id }.md`, content, force: true } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, id );
      assert.deepEqual( lower( e.triggers.phrases ).sort(), lower( [ ...r.newly_kept.map( ( x ) => x.phrase ), 'find flights to tokyo' ] ).sort() );
      const after = runConsistencyAudit( { checks: [ 'C-L' ] } ).advisory[ 'C-L' ];
      const f2 = after.findings.find( ( x ) => x.kind === 'frontmatter_phrases_unregistered' );
      assert.equal( f2.count, 3 );
      assert.equal( f2.recorded_in_trigger_dropped, 3 );
      assert.equal( f2.unrecorded, 0, 'every phrase the frontmatter has and the registration lacks is now explained in the fragment' );
      assert.equal( after.phrase_rederivation.newly_kept_count, 0, 'nothing left to restore' );
    } );
  } finally { vol.done(); }
} );

test( 'R3-7: frontmatter and registration agreeing produce no reconciliation finding; case is ignored', () => {
  const file = { path: 'modules/x/agree.md', text: moduleWith( 'agree', { phrases: [ 'plan a trip to' ] } ) };
  assert.equal( reconcileFrontmatterPhrases( file, { triggers: { phrases: [ 'Plan A Trip To' ] } } ), null );
  assert.equal( reconcileFrontmatterPhrases( { path: 'modules/x/none.md', text: '# none\n' }, { triggers: { phrases: [] } } ), null, 'no frontmatter triggers' );
  assert.equal( reconcileFrontmatterPhrases( file, { triggers: {} } ).missing.length, 1 );
} );

test( 'R3: the repair report does not count a recorded refusal as a defect, and proposes the block a re-write would persist', async () => {
  const clean = { id: 'rep-clean', path: 'modules/travel/rep-clean.md', line_count_estimate: 2,
    triggers: { keywords: [], phrases: [ 'plan a trip to' ], task_class: [] },
    trigger_dropped: [ { phrase: 'into the', reason: 'consists only of stopwords ("into", "the"); shorter than 12 characters' } ] };
  const dirtyBody = moduleWith( 'rep-dirty', { phrases: [ 'plan a trip to', 'into the' ] } );
  const dirty = { id: 'rep-dirty', path: 'modules/travel/rep-dirty.md', line_count_estimate: dirtyBody.split( '\n' ).length,
    triggers: { keywords: [], phrases: [ 'with all of them' ], task_class: [] } };
  const vol = volume( {
    files: { 'modules/travel/rep-clean.md': '# rep-clean\n', 'modules/travel/rep-dirty.md': dirtyBody },
    fragments: { '100-travel.json': [ clean, dirty ] },
  } );
  try {
    await on( vol, async () => {
      const rep = runConsistencyAudit( { checks: [ 'C-A' ], registration_repair_report: true } ).registration_repair_report;
      const by = Object.fromEntries( rep.modules.map( ( m ) => [ m.id, m ] ) );
      assert.equal( by[ 'rep-clean' ].status, 'passes_lint_without_marker', JSON.stringify( by[ 'rep-clean' ].quality_findings ) );
      assert.equal( by[ 'rep-dirty' ].status, 'auto_derived_defects' );
      assert.deepEqual( by[ 'rep-dirty' ].proposed.triggers.phrases, [ 'plan a trip to' ] );
      assert.deepEqual( by[ 'rep-dirty' ].proposed.trigger_dropped.map( ( d ) => d.phrase ), [ 'into the' ] );
    } );
  } finally { vol.done(); }
} );

// ─────────────────────────────── R5 ────────────────────────────────────────

test( 'R5: keyword validation, provides, version and line count are unchanged; the frozen manifests are untouched', async () => {
  const vol = volume();
  try {
    await on( vol, async () => {
      const frozen = ( t ) => Object.fromEntries( [ 'MANIFEST.json', 'MANIFEST_APPEND.json', 'DISPATCH_RULES.json' ].map( ( n ) => [ n, t[ n ] ] ) );
      const before = frozen( tree( vol ) );
      const content = moduleWith( 'r5-same', { version: '2.1.0', keywords: [ 'travel', 'r5-same', 'skill', 'itinerary' ], phrases: [ 'plan a trip to' ] } );
      await write( { file: 'travel/r5-same.md', content } );
      const e = theEntry( vol, 'r5-same' );
      assert.deepEqual( e.triggers.keywords, [ 'itinerary' ], 'P4 still drops path segments and forbidden words' );
      assert.equal( e.version, '2.1.0' );
      assert.equal( e.line_count_estimate, MF.lineCountOf( content ) );
      assert.deepEqual( e.provides, [] );
      assert.deepEqual( frozen( tree( vol ) ), before, 'MANIFEST.json, MANIFEST_APPEND.json and DISPATCH_RULES.json are unchanged' );
      for ( const k of [ 'travel', 'r5-same', 'skill' ] ) {
        assert.equal( MF.keywordLintReason( k, MF.pathSegmentsOf( 'modules/travel/r5-same.md' ) ) !== null, true, k );
      }
    } );
  } finally { vol.done(); }
} );
