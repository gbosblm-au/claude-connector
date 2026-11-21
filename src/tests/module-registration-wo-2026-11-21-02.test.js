// src/tests/module-registration-wo-2026-11-21-02.test.js
// ---------------------------------------------------------------------------
// WO-2026-11-21-02: derived manifest entries and duplicate-minting in
// automatic module registration.
//
// Every acceptance test names its negative input, and each input is one the
// code before this order would have registered wrongly (the comment on each
// test says how), so a check that cannot fail is not counted as a pass.
//
//   P-1..P-8  phase P: what module_write may write into a registration
//   Q-1..Q-4  phase Q: update in place, never mint a second registration
//   S-1, S-2  C-L fires on the known-bad fragment and is clean on the corrected
//   plus the routes and judgements the order also requires: P9 refusals, the
//   Q3 acknowledgement, the dry run, retention on update (R3), C-F's defect
//   judgement (S2) and the read-only repair report (R1-R4).
//
// Drives the real module_write handler and the real audit against throwaway
// volumes. The S-1 / S-2 fragments are reconstructed from the evidence quoted
// in the order (sections 2.1 to 2.4); the live fragment was not available.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const { handleModuleWrite } = await import( '../tools/skill-content.js' );
const { runConsistencyAudit } = await import( '../tools/module-consistency.js' );
const MF = await import( '../tools/manifest-fragments.js' );

const sha = ( b ) => createHash( 'sha256' ).update( b ).digest( 'hex' );

/** A throwaway volume. fragments: { name: object | modules[] } (an object is written as given, so "source" can be omitted). */
function volume( { manifest = [], append = null, fragments = {}, files = {} } = {} ) {
  const root = mkdtempSync( join( tmpdir(), 'wo-02-' ) );
  const ava = join( root, 'ava' );
  for ( const d of [ 'modules', 'references/manifest' ] ) mkdirSync( join( ava, d ), { recursive: true } );
  writeFileSync( join( ava, 'MANIFEST.json' ), JSON.stringify( { modules: manifest, budget: {} } ) );
  if ( append ) writeFileSync( join( ava, 'MANIFEST_APPEND.json' ), JSON.stringify( { modules: append } ) );
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

/** Every registration of an id, from every source. */
function registrationsOf( vol, id ) {
  const out = [];
  for ( const [ src, file ] of [ [ 'MANIFEST.json', 'MANIFEST.json' ], [ 'MANIFEST_APPEND.json', 'MANIFEST_APPEND.json' ] ] ) {
    const p = join( vol.ava, file );
    if ( existsSync( p ) ) for ( const m of JSON.parse( readFileSync( p, 'utf8' ) ).modules || [] ) if ( m.id === id ) out.push( { source: src, entry: m } );
  }
  for ( const [ name, frag ] of Object.entries( fragments( vol ) ) ) {
    for ( const m of frag.modules || [] ) if ( m.id === id ) out.push( { source: name, entry: m } );
  }
  return out;
}

/** The one fragment registration of an id (asserts there is exactly one). */
function theEntry( vol, id ) {
  const regs = registrationsOf( vol, id ).filter( ( r ) => r.source.endsWith( '.json' ) && r.source !== 'MANIFEST.json' && r.source !== 'MANIFEST_APPEND.json' );
  assert.equal( regs.length, 1, `expected one fragment registration of ${ id }, found ${ regs.length }: ${ JSON.stringify( regs.map( ( r ) => r.source ) ) }` );
  return regs[ 0 ].entry;
}

/** Every file under avaDir with its hash: "nothing was written" is this, unchanged. */
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

const allStrings = ( v ) => JSON.stringify( v ).toLowerCase();

// ─────────────────────────────── Phase P ───────────────────────────────────

test( 'P-1: a body with headings and no frontmatter triggers registers with none, triggers_source "none" and a warning', async () => {
  // Negative input: the headings "The Positive Account" and "Appendix B". The
  // old derivation put H2 headings into task_class and provides and the first
  // heading's words into keywords.
  const vol = volume();
  try {
    await on( vol, async () => {
      const content = '# The Positive Account\n\nIntro.\n\n## The Positive Account\nBody.\n\n## Appendix B\nMore.\n';
      const { body } = await write( { file: 'existential/positive.md', content } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'positive' );
      assert.deepEqual( e.triggers.phrases, [] );
      assert.deepEqual( e.triggers.keywords, [] );
      assert.deepEqual( e.triggers.task_class, [] );
      assert.equal( e.triggers_source, 'none' );
      assert.equal( e.registered_by, 'module_write', 'the marker C-F reads (S2)' );
      assert.ok( ! allStrings( e.triggers ).includes( 'positive account' ) && ! allStrings( e.triggers ).includes( 'appendix' ), 'no trigger from either heading' );
      const w = body.registration_warnings.find( ( x ) => x.code === 'registered_without_triggers' );
      assert.ok( w, 'a warning is returned' );
      assert.equal( w.module_id, 'positive' );
      assert.match( w.message, /registered without dispatch triggers and will not be selected by trigger until they are supplied/ );
      assert.match( body.note, /WITHOUT dispatch triggers/ );
      assert.equal( body.manifest_registration.triggers_source, 'none' );
    } );
  } finally { vol.done(); }
} );

test( 'P-2: no phrase of "held out", "out into" or "into the" is registered, from the body or supplied', async () => {
  // Negative input: "he held out into the nothing", twice, so the old bigram
  // miner (two or more occurrences) registered "held out", "out into", "into
  // the". The supplied variant hands the same fragments in explicitly.
  const vol = volume();
  try {
    await on( vol, async () => {
      const content = '# Angst\nHe held out into the nothing. Again he held out into the nothing.\n';
      const { body } = await write( { file: 'existential/angst-probe.md', content } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const forbidden = [ 'held out', 'out into', 'into the' ];
      for ( const p of theEntry( vol, 'angst-probe' ).triggers.phrases ) assert.ok( ! forbidden.includes( p.toLowerCase() ), `phrase "${ p }" registered` );

      const supplied = [ 'held out', 'out into', 'into the', 'the nothing', 'held out into the nothing' ];
      const r2 = await write( { file: 'existential/angst-probe-2.md', content, manifest_entry: { triggers: { phrases: supplied } } } );
      assert.equal( r2.body.success, true );
      const phrases = theEntry( vol, 'angst-probe-2' ).triggers.phrases.map( ( p ) => p.toLowerCase() );
      for ( const p of forbidden ) assert.ok( ! phrases.includes( p ), `phrase "${ p }" registered` );
      assert.deepEqual( phrases, [ 'held out into the nothing' ] );
      const drops = r2.body.registration_warnings.filter( ( x ) => x.code === 'trigger_dropped' ).map( ( x ) => x.value ).sort();
      assert.deepEqual( drops, [ 'held out', 'into the', 'out into', 'the nothing' ], 'every drop is reported' );
    } );
  } finally { vol.done(); }
} );

test( 'P-3: a module at modules/existential/new-module.md has none of exist, existential or new among its keywords', async () => {
  // Negative input: the path. The old derivation tokenised the file name and
  // category into keywords ("new", "module", "existential").
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/new-module.md', content: '# New module\nOn dread.\n' } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const kw = theEntry( vol, 'new-module' ).triggers.keywords.map( ( k ) => k.toLowerCase() );
      for ( const bad of [ 'exist', 'existential', 'new', 'module' ] ) assert.ok( ! kw.includes( bad ), `keyword "${ bad }" registered` );

      // P4 on supplied keywords: every directory on the path, the file name, and module/skill/note.
      const r2 = await write( { file: 'existential/new-module-2.md', content: '# n\n',
        manifest_entry: { triggers: { keywords: [ 'existential', 'modules', 'new-module-2', 'module', 'skill', 'note', 'dread' ] } } } );
      assert.deepEqual( theEntry( vol, 'new-module-2' ).triggers.keywords, [ 'dread' ] );
      assert.equal( r2.body.registration_warnings.filter( ( x ) => x.code === 'trigger_dropped' ).length, 6 );
    } );
  } finally { vol.done(); }
} );

test( 'P-4: a "## Provides" heading with no frontmatter provides gives provides [], with a warning', async () => {
  // Negative input: the heading. The old derivation filled provides from H2 headings.
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/prov.md', content: '# Prov\n\n## Provides\n- a capability\n\n## Fingarettes Positive Account v2.2.0\nText.\n' } );
      assert.equal( body.success, true );
      assert.deepEqual( theEntry( vol, 'prov' ).provides, [] );
      assert.ok( body.registration_warnings.some( ( x ) => x.code === 'registered_without_provides' && x.module_id === 'prov' ) );
    } );
  } finally { vol.done(); }
} );

test( 'P-5: a long descriptive # heading and no frontmatter title gives the module id as title', async () => {
  // Negative input: the heading. The old derivation used the first # heading as the title.
  const vol = volume();
  try {
    await on( vol, async () => {
      await write( { file: 'existential/titled.md', content: '# A long descriptive account of attunement, mood and boredom in Heidegger\nBody.\n' } );
      assert.equal( theEntry( vol, 'titled' ).title, 'titled' );
      await write( { file: 'existential/titled-fm.md', content: '---\ntitle: Attunement\n---\n# A long heading\n' } );
      assert.equal( theEntry( vol, 'titled-fm' ).title, 'Attunement', 'a frontmatter title is used' );
    } );
  } finally { vol.done(); }
} );

test( 'P-6: "Alev Türker" in the frontmatter triggers is stored exactly; no "rker", no U+FFFD', async () => {
  // Negative input: the name in the body and in the frontmatter triggers. The
  // old tokenizer split on anything outside a-z0-9 and registered "alev rker".
  const vol = volume();
  try {
    await on( vol, async () => {
      const content = '---\nid: exist-bad-faith-probe\ntriggers:\n  keywords: [Alev Türker, Fingarette]\n  phrases:\n    - translated by Alev Türker\n---\n'
        + '# Bad faith\n\nTranslated by Alev Türker. Translated by Alev Türker.\n';
      const { body } = await write( { file: 'existential/exist-bad-faith-probe.md', content } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'exist-bad-faith-probe' );
      assert.ok( e.triggers.keywords.includes( 'Alev Türker' ), JSON.stringify( e.triggers ) );
      assert.ok( e.triggers.phrases.includes( 'translated by Alev Türker' ) );
      assert.equal( e.triggers_source, 'frontmatter' );
      const raw = readFileSync( join( vol.ava, 'references', 'manifest', Object.keys( fragments( vol ) )[ 0 ] ) );
      assert.ok( raw.includes( Buffer.from( 'Alev Türker', 'utf8' ) ), 'the bytes on disk are the UTF-8 of the name' );
      const text = raw.toString( 'utf8' );
      assert.ok( ! /(^|[^\p{L}])rker/u.test( text ), 'no "rker" (a letter before it, as in Türker, is the name intact)' );
      assert.ok( ! text.toLowerCase().includes( 'alev rker' ) );
      assert.ok( ! text.includes( '\uFFFD' ), 'no U+FFFD' );
    } );
  } finally { vol.done(); }
} );

test( 'P9: a registration string that does not survive UTF-8 refuses the write, and nothing is written', async () => {
  // Negative inputs: an unpaired surrogate in a supplied phrase (it becomes
  // U+FFFD in UTF-8), and a frontmatter title already carrying U+FFFD.
  const vol = volume();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const a = await write( { file: 'existential/surrogate.md', content: '# s\n', manifest_entry: { triggers: { phrases: [ 'a broken \uD800 surrogate phrase' ] } } } );
      assert.equal( a.isError, true );
      assert.equal( a.body.code, 'registration_encoding_loss' );
      assert.match( a.body.refusals[ 0 ].problems[ 0 ].reason, /round-trip/ );
      const b = await write( { file: 'existential/replaced.md', content: '---\ntitle: Alev T\uFFFDrker\n---\n# r\n' } );
      assert.equal( b.body.code, 'registration_encoding_loss' );
      assert.match( b.body.refusals[ 0 ].problems[ 0 ].reason, /U\+FFFD/ );
      const dry = await write( { file: 'existential/replaced.md', content: '---\ntitle: Alev T\uFFFDrker\n---\n# r\n', dry_run: true } );
      assert.equal( dry.body.code, 'registration_encoding_loss', 'the dry run returns the same refusal' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'P-7: the fragment version follows the frontmatter version on every write, and is never carried forward', async () => {
  // Negative input: three writes, the frontmatter version changing each time.
  // The old derivation wrote "1.0.0" on every write.
  const vol = volume();
  try {
    await on( vol, async () => {
      const at = ( v ) => `---\nversion: ${ v }\n---\n# Versioned\nBody ${ v }.\n`;
      for ( const [ i, v ] of [ '1.1.0', '1.2.0', '1.3.0' ].entries() ) {
        const { body } = await write( { file: 'existential/versioned.md', content: at( v ), force: i > 0 } );
        assert.equal( body.success, true, JSON.stringify( body ) );
        assert.equal( theEntry( vol, 'versioned' ).version, v );
      }
      await write( { file: 'existential/versioned.md', content: '# Versioned\nNo version now.\n', force: true } );
      assert.equal( 'version' in theEntry( vol, 'versioned' ), false, 'a version the frontmatter no longer states is not carried forward or invented' );
    } );
  } finally { vol.done(); }
} );

test( 'P-8: line_count_estimate is the 79 lines just written, not a previous value', async () => {
  // Negative input: the registration already says 26 for this path.
  const lines = Array.from( { length: 79 }, ( _, i ) => ( i === 0 ? '# Seventy-nine' : `Line ${ i + 1} of the module.` ) ).join( '\n' );
  const vol = volume( {
    files: { 'modules/existential/seventy-nine.md': '# old\n' },
    fragments: { '100-existential.json': [ { id: 'seventy-nine', path: 'modules/existential/seventy-nine.md', line_count_estimate: 26, triggers: { keywords: [ 'counting' ] } } ] },
  } );
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/seventy-nine.md', content: lines, force: true } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      assert.equal( theEntry( vol, 'seventy-nine' ).line_count_estimate, 79 );
    } );
  } finally { vol.done(); }
} );

test( 'P (R3): an update with no triggers supplied keeps the existing triggers; an explicit empty set clears them', async () => {
  const vol = volume( {
    files: { 'modules/existential/kept.md': '# kept\n' },
    fragments: { '100-existential.json': [ { id: 'kept', path: 'modules/existential/kept.md', triggers: { keywords: [ 'dread' ], phrases: [ 'fundamental moods' ] }, provides: [ 'angst-model' ], load_priority: 3, notes: 'hand note' } ] },
  } );
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/kept.md', content: '# kept\nEdited.\n', force: true } );
      assert.equal( body.manifest_registration.registration_action, 'update_in_place' );
      const e = theEntry( vol, 'kept' );
      assert.deepEqual( e.triggers, { keywords: [ 'dread' ], phrases: [ 'fundamental moods' ] } );
      assert.deepEqual( e.provides, [ 'angst-model' ] );
      assert.equal( e.load_priority, 3 );
      assert.equal( e.notes, 'hand note', 'keys module_write does not manage are kept' );
      assert.ok( body.registration_warnings.some( ( x ) => x.code === 'triggers_retained' ) );

      await write( { file: 'existential/kept.md', content: '# kept\nEdited again.\n', force: true,
        manifest_entry: { triggers: { keywords: [], phrases: [], task_class: [] }, provides: [] } } );
      const e2 = theEntry( vol, 'kept' );
      assert.equal( e2.triggers_source, 'none' );
      assert.deepEqual( e2.triggers.keywords, [] );
      assert.deepEqual( e2.provides, [] );
    } );
  } finally { vol.done(); }
} );

// ─────────────────────────────── Phase Q ───────────────────────────────────

test( 'Q-1: a module registered only in 100-existential.json, written twice, has exactly one registration', async () => {
  // Negative input: 100-existential.json has no "source" field. The old code
  // matched a category fragment by "source" alone, so it minted a new
  // "existential" fragment beside it: two registrations.
  const vol = volume( {
    files: { 'modules/existential/once.md': '# once\n' },
    fragments: { '100-existential.json': { modules: [ { id: 'once', path: 'modules/existential/once.md', triggers: { keywords: [ 'dread' ] } } ] } },
  } );
  try {
    await on( vol, async () => {
      for ( const n of [ 1, 2 ] ) {
        const { body } = await write( { file: 'existential/once.md', content: `# once\nwrite ${ n }\n`, force: true } );
        assert.equal( body.success, true, JSON.stringify( body ) );
        assert.equal( body.manifest_registration.registration_action, 'update_in_place' );
        assert.equal( body.manifest_registration.fragment_file, 'references/manifest/100-existential.json' );
      }
      assert.equal( registrationsOf( vol, 'once' ).length, 1 );
      assert.deepEqual( Object.keys( fragments( vol ) ), [ '100-existential.json' ] );
    } );
  } finally { vol.done(); }
} );

test( 'Q-1 (Q2): an id registered in another category\'s fragment at this path is updated there, not registered again', async () => {
  // Negative input: the registration sits in 110-general.json. The old code
  // upserted only within the path's own category fragment, adding a second.
  const vol = volume( {
    files: { 'modules/existential/moved.md': '# moved\n' },
    fragments: { '100-existential.json': [ { id: 'other', path: 'modules/existential/other.md' } ], '110-general.json': [ { id: 'moved', path: 'modules/existential/moved.md' } ] },
  } );
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/moved.md', content: '# moved\nagain\n', force: true } );
      assert.equal( body.manifest_registration.fragment_file, 'references/manifest/110-general.json' );
      assert.equal( registrationsOf( vol, 'moved' ).length, 1 );
    } );
  } finally { vol.done(); }
} );

test( 'Q-2: an id registered in MANIFEST.json gets no fragment registration, and the reply names the frozen manifest', async () => {
  // Negative input: exist-angst-kierkegaard-heidegger registered in MANIFEST.json.
  // The old code added a fragment registration beside it.
  const id = 'exist-angst-kierkegaard-heidegger';
  const vol = volume( { manifest: [ { id, path: `modules/existential/${ id }.md` } ] } );
  try {
    await on( vol, async () => {
      const { body } = await write( { file: `existential/${ id }.md`, content: '---\nversion: 1.3.0\n---\n# Angst\n' } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      assert.equal( existsSync( join( vol.ava, 'modules', 'existential', `${ id }.md` ) ), true, 'the module file is written' );
      assert.equal( body.manifest_registration.registered, false );
      assert.equal( body.manifest_registration.code, 'registered_in_frozen_manifest' );
      assert.deepEqual( body.manifest_registration.frozen_manifest, [ 'MANIFEST.json' ] );
      assert.match( body.manifest_registration.reason, /frozen manifest \(MANIFEST\.json\)/ );
      assert.deepEqual( registrationsOf( vol, id ).map( ( r ) => r.source ), [ 'MANIFEST.json' ] );
    } );
  } finally { vol.done(); }
} );

test( 'Q-3: an id whose only registration names a different path is refused id_registered_elsewhere, naming both paths; nothing written', async () => {
  // Negative input: 80-philosophy.json registers q3 at modules/philosophy/q3.md.
  const vol = volume( { fragments: { '80-philosophy.json': [ { id: 'q3', path: 'modules/philosophy/q3.md' } ] } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body, isError } = await write( { file: 'existential/q3.md', content: '# q3\n' } );
      assert.equal( isError, true );
      assert.equal( body.code, 'id_registered_elsewhere' );
      const r = body.refusals.find( ( x ) => x.code === 'id_registered_elsewhere' );
      assert.equal( r.requested_path, 'modules/existential/q3.md' );
      assert.deepEqual( r.registrations.map( ( x ) => [ x.source, x.effective_path ] ), [ [ 'references/manifest/80-philosophy.json', 'modules/philosophy/q3.md' ] ] );
      assert.match( r.message, /modules\/philosophy\/q3\.md/ );
      assert.match( r.message, /modules\/existential\/q3\.md/ );
      assert.ok( r.routes.some( ( x ) => x.route === 'acknowledge_existing_registration' && x.value === 'references/manifest/80-philosophy.json' ) );
      assert.deepEqual( tree( vol ), before, 'nothing written' );
      const dry = await write( { file: 'existential/q3.md', content: '# q3\n', dry_run: true } );
      assert.equal( dry.body.code, 'id_registered_elsewhere', 'the dry run returns the same refusal' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'Q3: a shadowed registration elsewhere, invisible to the R2 file guard, is refused too', async () => {
  // The case WO-2026-11-21-01 R2 cannot see: the compile's winner is at this
  // path, and a second registration in another fragment names another path.
  const vol = volume( {
    files: { 'modules/existential/shadowed.md': '# shadowed\n' },
    fragments: { '100-existential.json': [ { id: 'shadowed', path: 'modules/existential/shadowed.md' } ], '80-philosophy.json': [ { id: 'shadowed', path: 'modules/philosophy/shadowed.md' } ] },
  } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body } = await write( { file: 'existential/shadowed.md', content: '# shadowed\nedit\n', force: true } );
      assert.equal( body.code, 'id_registered_elsewhere' );
      assert.equal( body.refusals.some( ( x ) => x.code === 'duplicate_id_path' ), false, 'R2 passes: the winner is at this path' );
      assert.deepEqual( body.refusals[ 0 ].registrations.map( ( x ) => x.source ).sort(), [ 'references/manifest/100-existential.json', 'references/manifest/80-philosophy.json' ] );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'Q3: where a file still holds the id elsewhere, duplicate_id_path stays first and id_registered_elsewhere is listed with it', async () => {
  const vol = volume( { files: { 'modules/philosophy/held.md': '# held\n' }, fragments: { '80-philosophy.json': [ { id: 'held', path: 'modules/philosophy/held.md' } ] } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body } = await write( { file: 'existential/held.md', content: '# held\n' } );
      assert.equal( body.code, 'duplicate_id_path' );
      assert.ok( body.refusals.some( ( x ) => x.code === 'id_registered_elsewhere' ) );
      const ack = await write( { file: 'existential/held.md', content: '# held\n', acknowledge_existing_registration: 'references/manifest/80-philosophy.json' } );
      assert.equal( ack.body.code, 'duplicate_id_path', 'the acknowledgement does not lift the refusal while a file holds the id' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'Q3 route: acknowledge_existing_registration updates that registration in place; a wrong name is refused', async () => {
  const vol = volume( { fragments: { '80-philosophy.json': [ { id: 'q3', path: 'modules/philosophy/q3.md', triggers: { keywords: [ 'kept' ] } } ] } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const bad = await write( { file: 'existential/q3.md', content: '# q3\n', acknowledge_existing_registration: 'references/manifest/999-none.json' } );
      assert.equal( bad.body.code, 'acknowledge_existing_registration_rejected' );
      assert.deepEqual( tree( vol ), before );
      const { body } = await write( { file: 'existential/q3.md', content: '# q3\n', acknowledge_existing_registration: 'references/manifest/80-philosophy.json' } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      assert.equal( body.manifest_registration.registration_action, 'update_acknowledged' );
      assert.equal( body.manifest_registration.previous_path, 'modules/philosophy/q3.md' );
      const regs = registrationsOf( vol, 'q3' );
      assert.equal( regs.length, 1 );
      assert.equal( regs[ 0 ].source, '80-philosophy.json' );
      assert.equal( regs[ 0 ].entry.path, 'modules/existential/q3.md' );
      assert.deepEqual( regs[ 0 ].entry.triggers, { keywords: [ 'kept' ] }, 'no triggers supplied: the existing ones are kept' );
    } );
  } finally { vol.done(); }
} );

test( 'Q-4: five existential modules written in sequence land in one fragment, five entries', async () => {
  // Negative input: 100-existential.json exists without a "source" field, and
  // a second volume has no fragment at all. The old code created a new
  // fragment beside the first.
  for ( const seed of [ { '100-existential.json': { modules: [] } }, {} ] ) {
    const vol = volume( { fragments: seed } );
    try {
      await on( vol, async () => {
        for ( let i = 1; i <= 5; i += 1 ) {
          const { body } = await write( { file: `existential/five-${ i }.md`, content: `# five ${ i }\n` } );
          assert.equal( body.success, true, JSON.stringify( body ) );
        }
        const frags = fragments( vol );
        assert.equal( Object.keys( frags ).length, 1, JSON.stringify( Object.keys( frags ) ) );
        assert.equal( Object.values( frags )[ 0 ].modules.length, 5 );
      } );
    } finally { vol.done(); }
  }
} );

// ─────────────────────────────── Phase S ───────────────────────────────────

const ANGST = 'exist-angst-kierkegaard-heidegger';
const ATTUNE = 'exist-attunement-heidegger';
const BADFAITH = 'exist-bad-faith-sartre-fingarette';
const angstBody = '---\nid: exist-angst-kierkegaard-heidegger\nversion: 1.3.0\n---\n# Angst\n' + Array.from( { length: 20 }, ( _, i ) => `Line ${ i } on anxiety.` ).join( '\n' ) + '\n';
const attuneBody = '---\nid: exist-attunement-heidegger\nversion: 1.1.0\ntriggers:\n  keywords: [attunement, heidegger]\n  phrases:\n    - fundamental moods\n    - moodless neutrality of the everyday\n---\n# Attunement\nMood discloses the world.\n';
const badFaithBody = '---\nid: exist-bad-faith-sartre-fingarette\nversion: 2.2.0\nprovides: self-deception-model\n---\n# Bad faith\n\n## Fingarettes positive account v2.2.0\nTranslated by Alev Türker.\n\n## Appendix B: 1998, the paradox dissolved\nText.\n';
const lc = ( t ) => t.split( '\n' ).length;

/** 100-existential.json as it stood before the hand corrections, reconstructed from the order's sections 2.1 to 2.4. */
const BEFORE = { modules: [
  { id: ATTUNE, title: 'Attunement', version: '1.0.0', category: 'existential', path: `modules/existential/${ ATTUNE }.md`, load_priority: 5,
    triggers: { keywords: [ 'exist', 'attunement', 'heidegger', 'existential' ], phrases: [ 'mood disclosure', 'moodless neutrality', 'fundamental moods', 'boredom levelled', 'levelled world', 'attunement the' ], task_class: [] },
    depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: lc( attuneBody ), always_load: false },
  { id: ANGST, title: 'Angst', version: '1.0.0', category: 'existential', path: `modules/existential/${ ANGST }.md`, load_priority: 5,
    triggers: { keywords: [ 'angst', 'kierkegaard' ], phrases: [ 'held out', 'out into', 'into the', 'the nothing' ], task_class: [] },
    depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: 26, always_load: false },
  { id: BADFAITH, title: 'Bad faith', version: '1.0.0', category: 'existential', path: `modules/existential/${ BADFAITH }.md`, load_priority: 5,
    triggers: { keywords: [ 'sartre', 'fingarette' ], phrases: [ 'alev rker', 'bad faith' ], task_class: [] },
    depends_on: [], provides: [ 'fingarettes positive account v220', 'appendix b 1998 the paradox dissolved' ], load_strategy: 'on_demand', line_count_estimate: lc( badFaithBody ), always_load: false },
] };

/** The same fragment corrected the way R2 proposes and R4 records: frontmatter triggers where there are any, otherwise none. */
const AFTER = { modules: [
  { id: ATTUNE, title: 'Attunement', version: '1.1.0', category: 'existential', path: `modules/existential/${ ATTUNE }.md`, load_priority: 5,
    triggers: { keywords: [ 'attunement', 'heidegger' ], phrases: [ 'fundamental moods', 'moodless neutrality of the everyday' ], task_class: [] }, triggers_source: 'frontmatter',
    depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: lc( attuneBody ), always_load: false },
  { id: ANGST, title: 'Angst', version: '1.3.0', category: 'existential', path: `modules/existential/${ ANGST }.md`, load_priority: 5,
    triggers: { keywords: [], phrases: [], task_class: [] }, triggers_source: 'none',
    depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: lc( angstBody ), always_load: false },
  { id: BADFAITH, title: 'Bad faith', version: '2.2.0', category: 'existential', path: `modules/existential/${ BADFAITH }.md`, load_priority: 5,
    triggers: { keywords: [], phrases: [], task_class: [] }, triggers_source: 'none',
    depends_on: [], provides: [ 'self-deception-model' ], load_strategy: 'on_demand', line_count_estimate: lc( badFaithBody ), always_load: false },
] };

const existentialVolume = ( fragment, extra = {} ) => volume( {
  files: { [ `modules/existential/${ ATTUNE }.md` ]: attuneBody, [ `modules/existential/${ ANGST }.md` ]: angstBody, [ `modules/existential/${ BADFAITH }.md` ]: badFaithBody },
  fragments: { '100-existential.json': fragment },
  ...extra,
} );

test( 'S-1: C-L against 100-existential.json as it stood before the hand corrections reports all four defects', async () => {
  const vol = existentialVolume( BEFORE );
  try {
    await on( vol, async () => {
      const out = runConsistencyAudit( { checks: [ 'C-L' ] } );
      const cl = out.advisory[ 'C-L' ];
      const kinds = new Set( cl.findings.map( ( f ) => f.kind ) );
      for ( const k of [ 'path_segment_keyword', 'stopword_phrase', 'stale_version', 'provides_not_a_token' ] ) assert.ok( kinds.has( k ), `no ${ k } finding: ${ JSON.stringify( cl.by_kind ) }` );
      assert.ok( cl.finding_count >= 4 );
      assert.ok( cl.findings.some( ( f ) => f.kind === 'path_segment_keyword' && f.id === ATTUNE && f.value === 'existential' ) );
      assert.ok( cl.findings.some( ( f ) => f.kind === 'stopword_phrase' && f.value === 'attunement the' ) );
      assert.ok( cl.findings.some( ( f ) => f.kind === 'stopword_phrase' && f.value === 'into the' ) );
      assert.ok( cl.findings.some( ( f ) => f.kind === 'stale_version' && f.id === ANGST && f.value === '1.0.0' && f.frontmatter_version === '1.3.0' ) );
      assert.ok( cl.findings.some( ( f ) => f.kind === 'provides_not_a_token' && f.value === 'fingarettes positive account v220' ) );
      assert.equal( cl.blocks, false, 'C-L is advisory' );
      assert.equal( out.deterministic.ran.includes( 'C-L' ), false, 'never in the deterministic section' );
    } );
  } finally { vol.done(); }
} );

test( 'S-2: C-L against the corrected 100-existential.json reports nothing', async () => {
  const vol = existentialVolume( AFTER );
  try {
    await on( vol, async () => {
      const cl = runConsistencyAudit( { checks: [ 'C-L' ] } ).advisory[ 'C-L' ];
      assert.equal( cl.finding_count, 0, JSON.stringify( cl.findings ) );
      assert.equal( cl.entries_read, 3, 'it read the three entries' );
    } );
  } finally { vol.done(); }
} );

test( 'C-L: U+FFFD anywhere and a double space in a name field are reported; line count off by more than 20% too', async () => {
  const vol = volume( {
    files: { 'modules/existential/x.md': Array.from( { length: 10 }, () => 'line' ).join( '\n' ) },
    fragments: { '100-existential.json': [ { id: 'x', path: 'modules/existential/x.md', title: 'Alev  Türker', line_count_estimate: 40, triggers: { phrases: [ 'alev t\uFFFDrker' ] } } ] },
  } );
  try {
    await on( vol, async () => {
      const kinds = runConsistencyAudit( { checks: [ 'C-L' ] } ).advisory[ 'C-L' ].findings.map( ( f ) => f.kind ).sort();
      assert.deepEqual( kinds, [ 'double_space', 'line_count_drift', 'replacement_character' ] );
    } );
  } finally { vol.done(); }
} );

test( 'S2: C-F judges duplicates minted by module_write as defects, apart from registrations that predate the tool', async () => {
  const minted = { registered_by: 'module_write' };
  const vol = volume( {
    files: { [ `modules/existential/${ ANGST }.md` ]: angstBody, 'modules/philosophy/legacy.md': '# l\n', 'modules/meta/hand.md': '# h\n' },
    manifest: [ { id: ANGST, path: `modules/existential/${ ANGST }.md` } ],
    fragments: {
      '100-existential.json': [ { id: ANGST, path: `modules/existential/${ ANGST }.md`, ...minted } ],
      '110-general.json': [ { id: ANGST, path: `modules/${ ANGST }.md`, ...minted }, { id: 'hand', path: 'modules/meta/hand.md', notes: 'by hand' } ],
      '80-philosophy.json': [ { id: ANGST, path: `modules/philosophy/${ ANGST }.md`, ...minted },
        { id: 'legacy', title: 'l', version: '1.0.0', category: 'philosophy', path: 'modules/philosophy/legacy.md', load_priority: 5, triggers: {}, depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: 2, always_load: false } ],
      '90-meta.json': [ { id: 'hand', path: 'modules/meta/hand.md' } ],
    },
  } );
  try {
    await on( vol, async () => {
      const cf = runConsistencyAudit( { checks: [ 'C-F' ] } ).deterministic[ 'C-F' ];
      const angst = cf.findings.find( ( f ) => f.id === ANGST );
      assert.equal( angst.registrations_by_module_write, 3 );
      assert.equal( angst.judgement, 'defect_minted_on_write' );
      assert.equal( angst.defect, true );
      assert.equal( angst.registrations.find( ( r ) => r.source === 'MANIFEST.json' ).created_by, 'not_module_write' );
      const hand = cf.findings.find( ( f ) => f.id === 'hand' );
      assert.equal( hand.judgement, 'predates_tool' );
      assert.equal( hand.defect, false );
      assert.ok( hand.registrations.every( ( r ) => r.created_by === 'predates_tool_or_hand_made' ) );
      assert.equal( cf.defects, 1 );
      assert.doesNotMatch( JSON.stringify( cf ), /Removing one registration leaves the module present/, 'the old framing is gone' );
    } );
  } finally { vol.done(); }
} );

test( 'S2: C-F attributes a registration to module_write from the H-3 ledger and from the old derived-entry shape', async () => {
  const legacy = ( id, path ) => ( { id, title: id, version: '1.0.0', category: 'existential', path, load_priority: 5, triggers: { keywords: [], phrases: [], task_class: [] }, depends_on: [], provides: [], load_strategy: 'on_demand', line_count_estimate: 3, always_load: false } );
  const vol = volume( {
    files: { 'modules/existential/dup.md': '# d\n' },
    fragments: { '100-existential.json': [ legacy( 'dup', 'modules/existential/dup.md' ) ], '110-general.json': [ { id: 'dup', path: 'modules/dup.md' } ] },
  } );
  try {
    await on( vol, async () => {
      const ledger = join( vol.root, 'ava', '.ledger', 'mutations.jsonl' );
      mkdirSync( dirname( ledger ), { recursive: true } );
      writeFileSync( ledger, JSON.stringify( { at: '2026-11-20T00:00:00Z', path: 'ava/references/manifest/110-general.json', kind: 'fragment', action: 'register', tool: 'module_write', extra: { module_id: 'dup' } } ) + '\n' );
      const f = runConsistencyAudit( { checks: [ 'C-F' ] } ).deterministic[ 'C-F' ].findings.find( ( x ) => x.id === 'dup' );
      const by = Object.fromEntries( f.registrations.map( ( r ) => [ r.source, r ] ) );
      assert.match( by[ 'references/manifest/110-general.json' ].evidence, /H-3 ledger/ );
      assert.match( by[ 'references/manifest/100-existential.json' ].evidence, /key set/ );
      assert.equal( f.judgement, 'defect_minted_on_write' );
    } );
  } finally { vol.done(); }
} );

// ─────────────────────────────── Phase R ───────────────────────────────────

test( 'R1-R3: the repair report lists the auto-derived entries with a proposal each, needs approval, and writes nothing', async () => {
  const vol = existentialVolume( BEFORE );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const rep = runConsistencyAudit( { checks: [ 'C-A' ], registration_repair_report: true } ).registration_repair_report;
      assert.equal( rep.read_only, true );
      assert.equal( rep.selected, 3 );
      assert.equal( rep.with_defects, 3 );
      const by = Object.fromEntries( rep.modules.map( ( m ) => [ m.id, m ] ) );
      assert.deepEqual( by[ ATTUNE ].proposed.triggers.phrases, [ 'fundamental moods', 'moodless neutrality of the everyday' ], 'frontmatter triggers proposed (R2)' );
      assert.equal( by[ ANGST ].proposed.triggers_source, 'none', 'no frontmatter triggers: empty proposed, with a warning' );
      assert.ok( by[ ANGST ].proposed.warnings.some( ( w ) => /without dispatch triggers/.test( w ) ) );
      assert.deepEqual( by[ BADFAITH ].proposed.provides, [ 'self-deception-model' ] );
      assert.equal( by[ BADFAITH ].proposed.version, '2.2.0' );
      assert.ok( rep.modules.every( ( m ) => m.approval_required === true ) );
      assert.match( rep.approval, /approval for that module \(R3\)/ );
      assert.deepEqual( tree( vol ), before, 'the report is read-only' );
    } );
  } finally { vol.done(); }
} );

test( 'R4: corrected entries without the marker are listed with no change proposed; a frozen-manifest id is marked external', async () => {
  const unmarked = { modules: AFTER.modules.map( ( { triggers_source, ...m } ) => m ) };
  const vol = existentialVolume( unmarked, { manifest: [ { id: ANGST, path: `modules/existential/${ ANGST }.md` } ] } );
  try {
    await on( vol, async () => {
      const rep = runConsistencyAudit( { checks: [ 'C-A' ], registration_repair_report: true } ).registration_repair_report;
      assert.equal( rep.with_defects, 0, JSON.stringify( rep.modules.map( ( m ) => [ m.id, m.quality_findings, m.phrase_failures ] ) ) );
      for ( const m of rep.modules ) {
        assert.equal( m.status, 'passes_lint_without_marker' );
        assert.equal( m.proposed, null, `${ m.id }: a hand correction is never proposed for change` );
      }
      assert.ok( rep.modules.find( ( m ) => m.id === ANGST ).frozen_manifest );
    } );
  } finally { vol.done(); }
} );

test( 'dry run: reports the registration it would make and its warnings, and writes nothing', async () => {
  const vol = volume( { fragments: { '100-existential.json': { modules: [] } } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body } = await write( { file: 'existential/dry.md', content: '# dry\n', dry_run: true } );
      assert.equal( body.registration.action, 'create' );
      assert.equal( body.registration.target_fragment, 'references/manifest/100-existential.json' );
      assert.equal( body.registration.triggers_source, 'none' );
      assert.ok( body.registration_warnings.some( ( w ) => w.code === 'registered_without_triggers' ) );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'P2: triggers written as a one-line flow mapping are read; an unreadable triggers value warns instead of vanishing', async () => {
  // Negative input: "triggers: { keywords: [...] }". Neither the old parser nor
  // a block-only reader saw it, so the module registered as if untriggered.
  const vol = volume();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'existential/flow.md', content: '---\ntriggers: { keywords: [Alev Türker, dread], phrases: ["moodless neutrality of the everyday"] }\n---\n# Flow\n' } );
      assert.equal( body.success, true, JSON.stringify( body ) );
      const e = theEntry( vol, 'flow' );
      assert.deepEqual( e.triggers.keywords, [ 'Alev Türker', 'dread' ] );
      assert.deepEqual( e.triggers.phrases, [ 'moodless neutrality of the everyday' ] );
      assert.equal( e.triggers_source, 'frontmatter' );
      const bad = await write( { file: 'existential/flow-bad.md', content: '---\ntriggers: keywords dread and angst\n---\n# Bad\n' } );
      assert.ok( bad.body.registration_warnings.some( ( w ) => w.code === 'frontmatter_unreadable' && w.key === 'triggers' ), JSON.stringify( bad.body.registration_warnings ) );
    } );
  } finally { vol.done(); }
} );

test( 'P9 and the warnings concern registration only: a skip_manifest edit and a frozen-manifest id are not refused or warned', async () => {
  // Negative inputs: a frontmatter title carrying U+FFFD, written with
  // skip_manifest (no registration is written) and for a MANIFEST.json id (Q4).
  const vol = volume( {
    files: { 'modules/existential/body-only.md': '# b\n' },
    manifest: [ { id: 'frozen-one', path: 'modules/existential/frozen-one.md' } ],
    fragments: { '100-existential.json': [ { id: 'body-only', path: 'modules/existential/body-only.md', triggers: { keywords: [ 'kept' ] } } ] },
  } );
  try {
    await on( vol, async () => {
      const fragBefore = JSON.stringify( fragments( vol ) );
      const a = await write( { file: 'existential/body-only.md', content: '---\ntitle: Alev T\uFFFDrker\n---\n# b\nedited\n', force: true, skip_manifest: true } );
      assert.equal( a.body.success, true, JSON.stringify( a.body ) );
      assert.deepEqual( a.body.registration_warnings, [] );
      assert.equal( JSON.stringify( fragments( vol ) ), fragBefore, 'the registration is untouched' );
      const b = await write( { file: 'existential/frozen-one.md', content: '---\ntitle: Alev T\uFFFDrker\n---\n# f\n' } );
      assert.equal( b.body.success, true, JSON.stringify( b.body ) );
      assert.equal( b.body.manifest_registration.code, 'registered_in_frozen_manifest' );
      assert.deepEqual( b.body.registration_warnings, [], 'no "registered without dispatch triggers" for a module registered in MANIFEST.json' );
    } );
  } finally { vol.done(); }
} );

test( 'verbatim frontmatter reader: inline arrays, quoted items, block lists, nested and dotted trigger keys, no case change', () => {
  const r = MF.readRegistrationFrontmatter( '---\nid: x\ntitle: "Being and Time: Mood"\ntriggers:\n  keywords: [Alev Türker, "Kierkegaard, Søren"]\n  phrases:\n    - Fundamental Moods of Dasein\ntriggers.task_class: Reading\nprovides:\n  - angst-model\n---\nbody\n' );
  assert.deepEqual( r.triggers.keywords, [ 'Alev Türker', 'Kierkegaard, Søren' ] );
  assert.deepEqual( r.triggers.phrases, [ 'Fundamental Moods of Dasein' ] );
  assert.deepEqual( r.triggers.task_class, [ 'Reading' ] );
  assert.equal( r.fields.title, 'Being and Time: Mood' );
  assert.deepEqual( r.fields.provides, [ 'angst-model' ] );
  assert.equal( r.has_triggers, true );
} );
