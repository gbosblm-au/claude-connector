/**
 * src/tests/module-integrity-wo-2026-11-21-01.test.js   (connector v13.39.0)
 *
 * WO-2026-11-21-01: the duplicate-minting guard, the frozen-manifest ruling,
 * and the auditor's own reporting. Every test drives the shipped handler or
 * function against a throwaway modular volume built per test; nothing reads
 * source text.
 *
 * Section 11 of the order, item by item:
 *   - the guard is shown REFUSING, not only passing: R2, R3 and the mirror skip
 *     in R15 each construct the refusal and assert the code and that nothing
 *     was written (the whole tree is hashed before and after)
 *   - R4, the direction most likely to be missed: a genuinely new id creates
 *   - the status field has three tests, not one: not_run, clean, unverified
 *   - the tier register is tested both ways: add an entry, the finding moves to
 *     accepted; remove it, the finding returns
 *   - the mutations (break the resolver call in module_write; return clean
 *     unconditionally) are in scripts/verify-module-files-mutations.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const sha = ( s ) => createHash( 'sha256' ).update( s ).digest( 'hex' );

/** A modular volume (the same shape module-files.test.js builds). */
function volume( { files = {}, manifest = [], fragments = {}, append = null, core = '# core\n' } = {} ) {
  const root = mkdtempSync( join( tmpdir(), 'wo-21-01-' ) );
  const ava = join( root, 'ava' );
  mkdirSync( join( ava, 'modules' ), { recursive: true } );
  mkdirSync( join( ava, 'references', 'manifest' ), { recursive: true } );
  writeFileSync( join( root, 'SKILL.md' ), '# S' );
  writeFileSync( join( root, '.modular_mode' ), 'true' );
  writeFileSync( join( ava, 'CORE.md' ), core );
  writeFileSync( join( ava, 'DISPATCH_RULES.json' ), '{}\n' );
  writeFileSync( join( ava, 'MANIFEST.json' ), JSON.stringify( { modules: manifest, budget: {} } ) );
  if ( append ) writeFileSync( join( ava, 'MANIFEST_APPEND.json' ), JSON.stringify( { modules: append } ) );
  for ( const [ name, modules ] of Object.entries( fragments ) ) {
    writeFileSync( join( ava, 'references', 'manifest', name ), JSON.stringify( { source: name.replace( /^\d+-|\.json$/g, '' ), modules }, null, 2 ) );
  }
  for ( const [ p, content ] of Object.entries( files ) ) {
    mkdirSync( dirname( join( ava, p ) ), { recursive: true } );
    writeFileSync( join( ava, p ), content );
  }
  return { root, ava, done: () => rmSync( root, { recursive: true, force: true } ) };
}

/** Run `fn` with SKILL_FILE_PATH at the volume; no WordPress backup is attempted. */
async function on( vol, fn ) {
  const saved = { s: process.env.SKILL_FILE_PATH, u: process.env.WP_SKILL_URL, k: process.env.WP_SKILL_KEY, r: process.env.SKILL_AUDIT_ACCEPTED_REGISTER };
  process.env.SKILL_FILE_PATH = join( vol.root, 'SKILL.md' );
  delete process.env.WP_SKILL_URL;
  delete process.env.WP_SKILL_KEY;
  delete process.env.SKILL_AUDIT_ACCEPTED_REGISTER;
  try { return await fn(); } finally {
    for ( const [ k, v ] of [ [ 'SKILL_FILE_PATH', saved.s ], [ 'WP_SKILL_URL', saved.u ], [ 'WP_SKILL_KEY', saved.k ], [ 'SKILL_AUDIT_ACCEPTED_REGISTER', saved.r ] ] ) {
      if ( v === undefined ) delete process.env[ k ]; else process.env[ k ] = v;
    }
  }
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

const MF = await import( '../tools/module-files.js' );
const TOOLS = await import( '../tools/module-file-tools.js' );
const { handleModuleWrite } = await import( '../tools/skill-content.js' );
const { handleSkillAudit } = await import( '../tools/skill.js' );
const { runConsistencyAudit } = await import( '../tools/module-consistency.js' );
const { handleModulesRestoreFromWp } = await import( '../tools/skill-modular.js' );

const parse = ( r ) => JSON.parse( r.content[ 0 ].text );
const write = async ( args ) => { const r = await handleModuleWrite( args ); return { body: parse( r ), isError: r.isError === true }; };
const del = async ( args ) => parse( await TOOLS.handleModuleDelete( args ) );
const restore = async ( args ) => parse( await TOOLS.handleModuleRestore( args ) );
const events = ( args = {} ) => parse( TOOLS.handleModuleFileEvents( args ) );

/** One module x registered at modules/meta/x.md. */
const oneModule = () => volume( {
  files: { 'modules/meta/x.md': '# x\nthe registered body\n' },
  fragments: { '10-meta.json': [ { id: 'x', path: 'modules/meta/x.md' } ] },
} );

// ───────────────────────────── R1-R5: the write guard ──────────────────────

test( 'R2: a second file for an existing id is refused, naming the resolved path, and nothing is written', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body, isError } = await write( { file: 'other/x.md', content: '# x\na second copy\n' } );
      assert.equal( body.code, 'duplicate_id_path' );
      assert.equal( isError, true );
      const r = body.refusals[ 0 ];
      assert.equal( r.id, 'x' );
      assert.equal( r.resolved_path, 'modules/meta/x.md' );
      assert.equal( r.requested_path, 'modules/other/x.md' );
      assert.equal( r.resolved_by, 'manifest_fragment' );
      assert.deepEqual( r.candidates.map( ( c ) => [ c.path, c.sha256, c.lines ] ), [ [ 'modules/meta/x.md', sha( '# x\nthe registered body\n' ), 3 ] ] );
      assert.deepEqual( r.routes.map( ( x ) => x.route ), [ 'acknowledge_resolved_path', 'quarantine_existing' ] );
      assert.equal( existsSync( join( vol.ava, 'modules/other/x.md' ) ), false, 'no file at the requested path' );
      assert.deepEqual( tree( vol ), before, 'nothing on the volume changed, fragments included' );
    } );
  } finally { vol.done(); }
} );

test( 'R1: the id comes from the frontmatter where present, so a different file name does not evade the guard', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'other/renamed.md', content: '---\nid: x\n---\n# x under another name\n' } );
      assert.equal( body.code, 'duplicate_id_path' );
      assert.equal( body.refusals[ 0 ].id, 'x' );
      assert.equal( existsSync( join( vol.ava, 'modules/other/renamed.md' ) ), false );
    } );
  } finally { vol.done(); }
} );

test( 'R1: unparseable frontmatter falls back to the file name, and the resolver still runs', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      // An unterminated block: the frontmatter parser yields nothing, so the id
      // is the file name, exactly as deriveModuleEntry would register it.
      const { body } = await write( { file: 'other/x.md', content: '---\nid: [unterminated\n# body\n' } );
      assert.equal( body.code, 'duplicate_id_path' );
      assert.equal( body.write_guard.ids.includes( 'x' ), true );
    } );
  } finally { vol.done(); }
} );

test( 'R1: the guard runs before the overwrite guard: force on a shadow copy is still refused', async () => {
  const same = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': same, 'modules/b/twin.md': same },
    fragments: { '10-a.json': [ { id: 'twin', path: 'modules/a/twin.md' } ] } } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body } = await write( { file: 'b/twin.md', content: '# twin, edited in the shadow\n', force: true } );
      assert.equal( body.code, 'duplicate_id_path', 'the shadow is not the file the compile loads' );
      assert.equal( body.refusals[ 0 ].resolved_path, 'modules/a/twin.md' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'R3: a path holding another id is refused even with force, and the file is unchanged', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body, isError } = await write( { file: 'meta/x.md', content: '---\nid: y\n---\n# y\n', force: true } );
      assert.equal( body.code, 'path_holds_other_id' );
      assert.equal( isError, true );
      const r = body.refusals.find( ( x ) => x.code === 'path_holds_other_id' );
      assert.deepEqual( { path: r.path, existing_id: r.existing_id, incoming_id: r.incoming_id }, { path: 'modules/meta/x.md', existing_id: 'x', incoming_id: 'y' } );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'R3: a manifest_entry id that differs from the file at the path is refused too', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const { body } = await write( { file: 'meta/x.md', content: '# x\nrevised\n', force: true, manifest_entry: { id: 'z' } } );
      assert.equal( body.code, 'path_holds_other_id' );
      assert.equal( body.refusals[ 0 ].incoming_id, 'z' );
    } );
  } finally { vol.done(); }
} );

test( 'R4: a module id that exists nowhere is created cleanly, with no refusal', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const { body, isError } = await write( { file: 'brand/new-module.md', content: '# new\nbody\n' } );
      assert.equal( isError, false );
      assert.equal( body.success, true, JSON.stringify( body ) );
      assert.equal( body.action, 'created' );
      assert.equal( body.write_guard.verdict, 'new_id' );
      assert.equal( body.refusals, undefined );
      assert.ok( existsSync( join( vol.ava, 'modules/brand/new-module.md' ) ) );
      assert.equal( body.manifest_registration.registered, true );
    } );
  } finally { vol.done(); }
} );

test( 'R4: rewriting an id at its own resolved path passes the guard and reaches the overwrite guard', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const blocked = ( await write( { file: 'meta/x.md', content: '# x\nrevised\n' } ) ).body;
      assert.equal( blocked.blocked, true );
      assert.equal( blocked.code, undefined, 'blocked by the overwrite guard, not by a guard refusal' );
      const forced = ( await write( { file: 'meta/x.md', content: '# x\nrevised\n', force: true } ) ).body;
      assert.equal( forced.success, true );
      assert.equal( forced.write_guard.verdict, 'resolved_here' );
    } );
  } finally { vol.done(); }
} );

test( 'R5: the dry run returns the same refusal as the real call and writes nothing', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const dry = await write( { file: 'other/x.md', content: '# x\ncopy\n', dry_run: true } );
      const real = await write( { file: 'other/x.md', content: '# x\ncopy\n' } );
      assert.equal( dry.body.dry_run, true );
      assert.equal( dry.body.code, 'duplicate_id_path' );
      assert.deepEqual( dry.body.refusals, real.body.refusals, 'the same verdict, refusal for refusal' );
      const dry3 = await write( { file: 'meta/x.md', content: '---\nid: y\n---\n', dry_run: true, force: true } );
      assert.equal( dry3.body.code, 'path_holds_other_id' );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'R5: a dry run of a new id says it would create, and writes nothing', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const { body } = await write( { file: 'brand/new.md', content: '# new\n', dry_run: true } );
      assert.equal( body.dry_run, true );
      assert.equal( body.written, false );
      assert.equal( body.would, 'create' );
      assert.deepEqual( body.refusals, [] );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

test( 'R2 route: acknowledge_resolved_path equal to resolved_path writes the resolved file; any other value is refused', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const wrong = ( await write( { file: 'other/x.md', content: '# x v2\n', force: true, acknowledge_resolved_path: 'modules/other/x.md' } ) ).body;
      assert.equal( wrong.code, 'duplicate_id_path' );
      assert.equal( wrong.refusals[ 0 ].acknowledge_resolved_path_rejected, 'modules/other/x.md' );
      const ok = ( await write( { file: 'other/x.md', content: '# x v2\n', force: true, acknowledge_resolved_path: 'modules/meta/x.md' } ) ).body;
      assert.equal( ok.success, true, JSON.stringify( ok ) );
      assert.equal( ok.write_guard.verdict, 'redirected_to_resolved' );
      assert.equal( readFileSync( join( vol.ava, 'modules/meta/x.md' ), 'utf8' ), '# x v2\n' );
      assert.equal( existsSync( join( vol.ava, 'modules/other/x.md' ) ), false );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R9: the status field, three values ─────────

test( 'R9 not_run: checks ["C-E"] runs no deterministic check, and says so', async () => {
  const vol = oneModule();
  try {
    await on( vol, () => {
      const d = runConsistencyAudit( { checks: [ 'C-E' ] } ).deterministic;
      assert.equal( d.status, 'not_run' );
      assert.deepEqual( d.requested, [ 'C-E' ] );
      assert.deepEqual( d.ran, [] );
      assert.equal( d.skipped.length, 1 );
      assert.equal( d.skipped[ 0 ].check, 'C-E' );
      assert.match( d.skipped[ 0 ].reason, /advisory/ );
    } );
  } finally { vol.done(); }
} );

test( 'R9 clean: checks ["C-A"] on a healthy tree ran and passed', async () => {
  const vol = oneModule();
  try {
    await on( vol, () => {
      const d = runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic;
      assert.equal( d.status, 'clean' );
      assert.deepEqual( d.ran, [ 'C-A' ] );
      assert.deepEqual( d.skipped, [] );
    } );
  } finally { vol.done(); }
} );

test( 'R9 unverified: an empty volume fails the floor, and no check ran', async () => {
  const vol = volume();
  try {
    await on( vol, () => {
      const d = runConsistencyAudit().deterministic;
      assert.equal( d.status, 'unverified' );
      assert.deepEqual( d.ran, [] );
      assert.deepEqual( d.skipped.map( ( s ) => s.check ), [ 'C-A', 'C-B', 'C-C', 'C-D', 'C-F' ] );
    } );
  } finally { vol.done(); }
} );

test( 'R9 findings: a requested check that finds something reports findings', async () => {
  const vol = volume( { files: { 'modules/a/a.md': '# a\n', 'modules/a/stray.md': '# s\n' }, fragments: { '10-a.json': [ { id: 'a', path: 'modules/a/a.md' } ] } } );
  try {
    await on( vol, () => assert.equal( runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic.status, 'findings' ) );
  } finally { vol.done(); }
} );

// ───────────────────────────── R10: tiers, both ways ──────────────────────

test( 'R10: the register moves a finding to accepted and back; blocking and new are told apart', async () => {
  const same = '# twin\n';
  const vol = volume( {
    files: { 'modules/a/a.md': '# a\n', 'modules/b/twin.md': same, 'modules/c/twin.md': same },
    fragments: { '10-a.json': [ { id: 'a', path: 'modules/a/a.md' }, { id: 'ghost', path: 'modules/a/ghost.md' },
      { id: 'twin', path: 'modules/b/twin.md' }, { id: 'twin', path: 'modules/c/twin.md' } ] },
  } );
  try {
    await on( vol, () => {
      const first = runConsistencyAudit( { checks: [ 'C-A', 'C-B' ] } );
      assert.equal( Object.keys( first )[ 0 ], 'headline', 'the report opens with the headline' );
      assert.equal( first.tiers.blocking, 1, 'the ghost entry: C-A is blocking by default' );
      assert.equal( first.tiers.new, 1, 'the identical twin: C-B is not blocking' );
      assert.equal( first.headline, '1 blocking, 0 accepted, 1 new' );

      const reg = join( vol.ava, 'audit', 'accepted_findings.json' );
      mkdirSync( dirname( reg ), { recursive: true } );
      writeFileSync( reg, JSON.stringify( { entries: [
        { id: '2026-11-21-04', match: 'C-A:entry:references/manifest/10-a.json:*', reason: 'pathless index, external', accepted: '2026-11-21' },
        { id: 'bad', match: 'C-B:*', reason: '' },
      ] } ) );
      const second = runConsistencyAudit( { checks: [ 'C-A', 'C-B' ] } );
      assert.equal( second.tiers.blocking, 0 );
      assert.equal( second.tiers.accepted, 1 );
      assert.equal( second.tiers.new, 1, 'the invalid entry (no reason, no date) is not applied' );
      assert.equal( second.tiers.by_check[ 'C-A' ].headline, 'C-A: 1 finding, all accepted (register entry 2026-11-21-04)' );
      assert.deepEqual( second.tiers.register.invalid_entries.map( ( e ) => e.id ), [ 'bad' ] );
      assert.equal( second.headline, '0 blocking, 1 accepted, 1 new' );

      unlinkSync( reg );
      const third = runConsistencyAudit( { checks: [ 'C-A', 'C-B' ] } );
      assert.equal( third.tiers.blocking, 1, 'removing the entry returns the finding' );
      assert.equal( third.tiers.accepted, 0 );
      assert.equal( readFileSync( join( vol.ava, 'references/manifest/10-a.json' ), 'utf8' ).includes( 'ghost' ), true, 'the audit changed nothing' );
    } );
  } finally { vol.done(); }
} );

test( 'R10: the audit never writes the register', async () => {
  const vol = oneModule();
  try {
    await on( vol, () => {
      runConsistencyAudit();
      assert.equal( existsSync( join( vol.ava, 'audit' ) ), false );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R11: the log outside quarantine ─────────────

test( 'R11: module_file_events returns log_path on every call, including before any log exists', async () => {
  const vol = oneModule();
  try {
    await on( vol, () => {
      const e = events();
      assert.equal( e.log_present, false );
      assert.equal( e.log_path, 'module-history/module_file_events.jsonl' );
      assert.equal( e.log_outside_quarantine, true );
    } );
  } finally { vol.done(); }
} );

test( 'R11: a log left inside quarantine/ is read, then carried forward with a relocation event, and the old file is kept', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      const legacyRow = { event_id: 'old-1', id: 'other', path: 'modules/z/other.md', action: 'quarantined', sha256: 'aa', at: '2026-11-20T00:00:00.000Z' };
      mkdirSync( join( vol.ava, 'quarantine' ), { recursive: true } );
      const legacyText = `${ JSON.stringify( legacyRow ) }\n`;
      writeFileSync( join( vol.ava, 'quarantine/module_file_events.jsonl' ), legacyText );
      const pending = events();
      assert.equal( pending.relocation_pending, true );
      assert.equal( pending.read_from, 'quarantine/module_file_events.jsonl' );
      assert.equal( pending.events.length, 1 );

      const q = await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( q.done, true, JSON.stringify( q.refusals ) );
      const after = events();
      assert.equal( after.relocation_pending, false );
      assert.equal( after.read_from, 'module-history/module_file_events.jsonl' );
      assert.deepEqual( after.events.map( ( e ) => e.action ), [ 'quarantined', 'log_relocated', 'quarantined' ] );
      const rel = after.events[ 1 ];
      assert.equal( rel.from, 'quarantine/module_file_events.jsonl' );
      assert.equal( rel.to, 'module-history/module_file_events.jsonl' );
      assert.equal( rel.events_carried, 1 );
      assert.equal( rel.legacy_sha256, sha( legacyText ) );
      assert.equal( readFileSync( join( vol.ava, 'quarantine/module_file_events.jsonl' ), 'utf8' ), legacyText, 'the old file is kept, unchanged' );
    } );
  } finally { vol.done(); }
} );

test( 'R11: purging quarantine leaves the record of the purge', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      const p = await del( { file: 'quarantine/modules/b/twin.md', purge: true, confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( p.done, true, JSON.stringify( p.refusals ) );
      // The worst case D15 names: the whole quarantine directory is removed.
      rmSync( join( vol.ava, 'quarantine' ), { recursive: true, force: true } );
      assert.deepEqual( events( { path: 'modules/b/twin.md' } ).events.map( ( e ) => e.action ), [ 'quarantined', 'purged' ] );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R12-R14: resolution defects ────────────────

test( 'R12: a path-less registration is never presented as registering the inferred path', async () => {
  const vol = volume( {
    files: { 'modules/tutor/tutor-timing-ladder.md': '# ladder\n' },
    fragments: { '10-tools-fast-index.json': [ { id: 'tutor-timing-ladder', category: 'tutor' } ] },
  } );
  try {
    await on( vol, () => {
      const r = MF.resolveModulePath( 'tutor-timing-ladder' );
      assert.equal( r.resolved_path, 'modules/tutor/tutor-timing-ladder.md' );
      assert.equal( r.path_source, 'inferred_fallback' );
      assert.equal( r.merge_inferred_path, 'modules/tutor/tutor-timing-ladder.md' );
      assert.deepEqual( r.pathless_registrations, [ { source: 'references/manifest/10-tools-fast-index.json', id: 'tutor-timing-ladder', path: null, declared_path: false } ] );
      for ( const c of r.candidates ) {
        assert.deepEqual( c.registered_in, [], 'no candidate carries the inferred registration' );
        assert.ok( ! JSON.stringify( c ).includes( 'inferred' ) );
      }
      const cc = runConsistencyAudit( { checks: [ 'C-C' ] } ).deterministic[ 'C-C' ];
      assert.ok( ! JSON.stringify( cc ).includes( '(path inferred)' ) );
    } );
  } finally { vol.done(); }
} );

test( 'R12: a declared registration is structured { source, id, path, declared_path }', async () => {
  const vol = oneModule();
  try {
    await on( vol, () => {
      const c = MF.resolveModulePath( 'x' ).candidates[ 0 ];
      assert.deepEqual( c.registered_in, [ { source: 'references/manifest/10-meta.json', id: 'x', path: 'modules/meta/x.md', declared_path: true } ] );
    } );
  } finally { vol.done(); }
} );

test( 'R13: the four directory-walk ids each carry resolved_path, and resolved_by stays directory_walk', async () => {
  const ids = [ 'phil-happiness-antidote-unknown', 'strategy-capability-differentiation', 'strategy-usp-complement-analysis', 'writing-le-guin-many-voice-truth' ];
  const files = Object.fromEntries( ids.map( ( id ) => [ `modules/${ id.split( '-' )[ 0 ] }/${ id }.md`, `# ${ id }\n` ] ) );
  const vol = volume( { files } );
  try {
    await on( vol, async () => {
      for ( const id of ids ) {
        const r = MF.resolveModulePath( id );
        assert.equal( r.resolved_path, `modules/${ id.split( '-' )[ 0 ] }/${ id }.md`, id );
        assert.equal( r.resolved_by, 'directory_walk' );
        assert.equal( r.loadable, false );
      }
      const a = parse( await handleSkillAudit( {} ) );
      const row = a.modules_by_id.find( ( m ) => m.id === ids[ 0 ] );
      assert.equal( row.resolved_path, `modules/phil/${ ids[ 0 ] }.md` );
      assert.ok( row.candidates, 'the weaker evidence keeps its candidates' );
    } );
  } finally { vol.done(); }
} );

test( 'R14: one file claimed by two ids is a multi_id_file in skill_audit and in C-C', async () => {
  const vol = volume( {
    files: { 'modules/strategy/strategy-capability-differentiation.md': '# capability\n', 'modules/a/a.md': '# a\n' },
    fragments: { '10-strategy.json': [ { id: 'capability-differentiation', path: 'modules/strategy/strategy-capability-differentiation.md' },
      { id: 'a', path: 'modules/a/a.md' } ] },
  } );
  try {
    await on( vol, async () => {
      const a = parse( await handleSkillAudit( {} ) );
      assert.equal( a.counts.multi_id_files, 1 );
      assert.deepEqual( a.multi_id_files[ 0 ].ids, [ 'capability-differentiation', 'strategy-capability-differentiation' ] );
      assert.equal( a.ids_by_file.find( ( f ) => f.path === 'modules/a/a.md' ).multi_id_file, false );
      const cc = runConsistencyAudit( { checks: [ 'C-C' ] } ).deterministic[ 'C-C' ];
      assert.equal( cc.pass, false );
      assert.deepEqual( cc.multi_id_files.map( ( m ) => m.path ), [ 'modules/strategy/strategy-capability-differentiation.md' ] );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R6-R8: the frozen manifest ─────────────────

test( 'R6: a divergent id registered in MANIFEST.json is reported, with the fragment, resolved path and sibling hashes', async () => {
  const vol = volume( {
    files: { 'modules/a/d.md': '# d\none text\n', 'modules/b/d.md': '# d\nanother text\n' },
    manifest: [ { id: 'd', path: 'modules/a/d.md' } ],
  } );
  try {
    await on( vol, () => {
      const r = runConsistencyAudit( { checks: [ 'C-B' ] } ).divergent_frozen_registration;
      assert.equal( r.status, 'findings' );
      assert.equal( r.holds, false );
      assert.equal( r.findings.length, 1 );
      const f = r.findings[ 0 ];
      assert.deepEqual( f.registrations, [ { fragment: 'MANIFEST.json', path: 'modules/a/d.md', declared_path: true } ] );
      assert.equal( f.resolved_path, 'modules/a/d.md' );
      assert.deepEqual( f.siblings.map( ( s ) => s.sha256 ).sort(), [ sha( '# d\none text\n' ), sha( '# d\nanother text\n' ) ].sort() );
      assert.equal( r.report_only, true );
    } );
  } finally { vol.done(); }
} );

test( 'R6/R7: a divergent group registered only in a fragment holds the invariant, and resolved_is_registered is true', async () => {
  const vol = volume( {
    files: { 'modules/a/d.md': '# d\none\n', 'modules/b/d.md': '# d\ntwo\n' },
    fragments: { '10-a.json': [ { id: 'd', path: 'modules/a/d.md' } ] },
  } );
  try {
    await on( vol, () => {
      const out = runConsistencyAudit( { checks: [ 'C-A' ] } );
      assert.equal( out.divergent_frozen_registration.status, 'clean', 'measured even when C-B was not requested' );
      assert.equal( out.divergent_frozen_registration.holds, true );
      const g = runConsistencyAudit( { checks: [ 'C-B' ] } ).deterministic[ 'C-B' ].groups[ 0 ];
      assert.equal( g.resolved_is_registered, true );
    } );
  } finally { vol.done(); }
} );

test( 'R7: when the resolved copy is not the registered one, the registered path is named separately', async () => {
  // The registration names a path that no longer exists; two unregistered copies remain.
  const vol = volume( {
    files: { 'modules/b/d.md': '# d\none\n', 'modules/c/d.md': '# d\ntwo\n' },
    fragments: { '10-a.json': [ { id: 'd', path: 'modules/a/d.md' } ] },
  } );
  try {
    await on( vol, () => {
      const g = runConsistencyAudit( { checks: [ 'C-B' ] } ).deterministic[ 'C-B' ].groups[ 0 ];
      assert.equal( g.resolved_is_registered, false );
      assert.equal( g.resolved_path, null );
      assert.equal( g.registered_path, 'modules/a/d.md' );
    } );
  } finally { vol.done(); }
} );

test( 'R8: the frozen-manifest refusal names reconciliation as external, and nothing moves', async () => {
  const body = '# f\n';
  const vol = volume( { files: { 'modules/a/f.md': body, 'modules/b/f.md': body }, manifest: [ { id: 'f', path: 'modules/a/f.md' } ] } );
  try {
    await on( vol, async () => {
      const before = tree( vol );
      const out = await del( { file: 'modules/a/f.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      const r = out.refusals.find( ( x ) => x.code === 'registered_in_frozen_manifest' );
      assert.ok( r, JSON.stringify( out.refusals ) );
      assert.equal( r.reconciliation, 'external' );
      assert.match( r.reconciliation_note, /external decision, not a tooling operation/ );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R15: the mirror ────────────────────────────

test( 'R15: a mirror push skips a quarantined path, reports it, and does not re-create it', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body } } );
  try {
    await on( vol, async () => {
      const q = await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      assert.equal( q.done, true, JSON.stringify( q.refusals ) );
      const push = await handleModulesRestoreFromWp( { files: { 'modules/b/twin.md': body, 'modules/a/twin.md': '# twin\n', 'modules/c/new.md': '# new\n' } } );
      assert.equal( existsSync( join( vol.ava, 'modules/b/twin.md' ) ), false, 'the quarantine stands' );
      assert.equal( push.files_skipped, 1 );
      assert.equal( push.skipped[ 0 ].path, 'modules/b/twin.md' );
      assert.match( push.skipped[ 0 ].reason, /^quarantined/ );
      assert.equal( push.skipped[ 0 ].last_event.action, 'quarantined' );
      assert.equal( push.results[ 'modules/b/twin.md' ], undefined, 'not written, not silently counted' );
      assert.ok( existsSync( join( vol.ava, 'modules/c/new.md' ) ), 'other paths are written as before' );
      assert.equal( push.success, true );
    } );
  } finally { vol.done(); }
} );

test( 'R15: after a restore the path is a mirror target again; a purged path stays skipped', async () => {
  const body = '# twin\n';
  const vol = volume( { files: { 'modules/a/twin.md': body, 'modules/b/twin.md': body, 'modules/c/twin.md': body } } );
  try {
    await on( vol, async () => {
      await del( { file: 'modules/b/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      await restore( { file: 'quarantine/modules/b/twin.md', confirm: true, dry_run: false } );
      await del( { file: 'modules/c/twin.md', confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      await del( { file: 'quarantine/modules/c/twin.md', purge: true, confirm: true, dry_run: false, expected_sha256: sha( body ) } );
      const push = await handleModulesRestoreFromWp( { files: { 'modules/b/twin.md': '# twin, pushed\n', 'modules/c/twin.md': body } } );
      assert.equal( readFileSync( join( vol.ava, 'modules/b/twin.md' ), 'utf8' ), '# twin, pushed\n' );
      assert.deepEqual( push.skipped.map( ( s ) => s.path ), [ 'modules/c/twin.md' ] );
      assert.match( push.skipped[ 0 ].reason, /^purged/ );
      assert.equal( existsSync( join( vol.ava, 'modules/c/twin.md' ) ), false );
    } );
  } finally { vol.done(); }
} );

test( 'R15 / D15: a mirror push cannot write the event record or the quarantine', async () => {
  const vol = oneModule();
  try {
    await on( vol, async () => {
      const push = await handleModulesRestoreFromWp( { files: { 'module-history/module_file_events.jsonl': '{}\n', 'quarantine/modules/meta/x.md': '# planted\n' } } );
      assert.equal( push.files_skipped, 2 );
      assert.equal( existsSync( join( vol.ava, 'module-history/module_file_events.jsonl' ) ), false );
      assert.equal( existsSync( join( vol.ava, 'quarantine/modules/meta/x.md' ) ), false );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R16: nested trees ──────────────────────────

test( 'R16: a nested modules/ tree is one finding with its file count and duplicated ids, report only', async () => {
  const vol = volume( {
    files: {
      'modules/meta/m.md': '# m\n', 'modules/modules/meta/m.md': '# m\n', 'modules/modules/philosophy/p.md': '# p\n',
      'modules/modules/existential/e.md': '# e\n', 'modules/existential/e.md': '# e (other)\n',
    },
    fragments: { '10-x.json': [ { id: 'm', path: 'modules/meta/m.md' }, { id: 'e', path: 'modules/existential/e.md' } ] },
  } );
  try {
    await on( vol, () => {
      const before = tree( vol );
      const n = runConsistencyAudit().nested_module_trees;
      assert.equal( n.trees, 1 );
      const f = n.findings[ 0 ];
      assert.equal( f.tree, 'modules/modules/' );
      assert.equal( f.file_count, 3 );
      assert.deepEqual( f.subdirectories, [ 'existential', 'meta', 'philosophy' ] );
      assert.deepEqual( f.ids_duplicated, [ 'e', 'm' ] );
      assert.deepEqual( f.ids_only_in_tree, [ 'p' ] );
      assert.equal( f.unregistered_files, 3 );
      assert.equal( n.report_only, true );
      assert.deepEqual( tree( vol ), before );
    } );
  } finally { vol.done(); }
} );

// ───────────────────────────── R17-R19: report shapes ─────────────────────

test( 'R17: the always-load aggregate is reported on every run, naming its estimator and the policy ceiling', async () => {
  const vol = volume( { files: { 'modules/meta/a.md': 'x'.repeat( 400 ) }, fragments: { '10-m.json': [ { id: 'a', path: 'modules/meta/a.md', always_load: true } ] }, core: 'c'.repeat( 100 ) } );
  try {
    await on( vol, () => {
      const out = runConsistencyAudit( { checks: [ 'C-A' ] } );
      assert.equal( out.advisory[ 'C-E' ], undefined, 'C-E was not requested' );
      const g = out.always_load_aggregate;
      assert.equal( g.aggregate_bytes, 500 );
      assert.equal( g.aggregate_estimated_tokens, 125 );
      assert.equal( g.estimator.name, 'bytes_div_4_ceil' );
      assert.equal( g.estimator.formula, 'ceil(bytes / 4)' );
      assert.equal( g.ceiling_kind, 'policy' );
      assert.match( g.ceiling_basis, /policy figure, not a measured/ );
      assert.equal( g.headroom_estimated_tokens, g.token_ceiling - 125 );
    } );
  } finally { vol.done(); }
} );

test( 'R18: C-H groups by module pair, ranks by shared triggers, lists generic triggers apart, and counts what it truncates', async () => {
  const mods = [];
  const files = {};
  // a and b share two phrases; a and c share one; "common thread" is claimed by five (generic).
  const add = ( id, phrases ) => { files[ `modules/t/${ id }.md` ] = `# ${ id }\n`; mods.push( { id, path: `modules/t/${ id }.md`, triggers: { phrases, keywords: [] } } ); };
  add( 'a', [ 'bad faith', 'radical freedom', 'thrownness', 'common thread' ] );
  add( 'b', [ 'bad faith', 'radical freedom', 'common thread' ] );
  add( 'c', [ 'thrownness', 'common thread' ] );
  add( 'd', [ 'common thread' ] );
  add( 'e', [ 'common thread' ] );
  // 22 more pairs, one shared phrase each, to force truncation at 20.
  for ( let i = 0; i < 22; i++ ) { add( `p${ i }x`, [ `phrase ${ i }` ] ); add( `p${ i }y`, [ `phrase ${ i }` ] ); }
  const vol = volume( { files, fragments: { '10-t.json': mods } } );
  try {
    await on( vol, () => {
      const h = runConsistencyAudit( { checks: [ 'C-H' ] } ).advisory[ 'C-H' ];
      assert.deepEqual( h.findings[ 0 ].modules.map( ( m ) => m.id ), [ 'a', 'b' ] );
      assert.equal( h.findings[ 0 ].shared_trigger_count, 2 );
      assert.equal( h.module_pairs, 24 );
      assert.equal( h.findings.length, 20 );
      assert.equal( h.truncated, true );
      assert.equal( h.rows_not_shown, 4 );
      assert.deepEqual( h.generic_triggers, [ { trigger: 'common thread', kind: 'phrase', module_count: 5 } ] );
      assert.ok( ! h.findings.some( ( f ) => f.triggers.some( ( t ) => t.trigger === 'common thread' ) ), 'a generic trigger is never paired' );
    } );
  } finally { vol.done(); }
} );

test( 'R19: C-I reports the drift count, the worst ten with both numbers, and field_unmaintained above the threshold', async () => {
  const files = {};
  const mods = [];
  // 12 modules state the field; 7 drift (58%), the worst by a factor of 3.
  // The compile counts every line of the file, frontmatter included:
  // 4 frontmatter lines + 15 body lines + the empty string after the last
  // newline = 20.
  const bodyOf = ( i, stated ) => `---\nid: m${ i }\nline_count_estimate: ${ stated }\n---\n${ 'l\n'.repeat( 15 ) }`;
  for ( let i = 0; i < 12; i++ ) {
    const stated = i < 7 ? ( i === 0 ? 60 : 20 + i ) : 20;
    files[ `modules/m/m${ i }.md` ] = bodyOf( i, stated );
    assert.equal( bodyOf( i, stated ).split( '\n' ).length, 20, 'fixture: the file is 20 lines as the compile counts them' );
    mods.push( { id: `m${ i }`, path: `modules/m/m${ i }.md` } );
  }
  const vol = volume( { files, fragments: { '10-m.json': mods } } );
  try {
    await on( vol, () => {
      const lc = runConsistencyAudit( { checks: [ 'C-I' ] } ).advisory[ 'C-I' ].line_count_estimate;
      assert.equal( lc.modules_stating_field, 12 );
      assert.equal( lc.drift_count, 7 );
      assert.equal( lc.field_unmaintained, true );
      assert.deepEqual( [ lc.worst[ 0 ].id, lc.worst[ 0 ].stated, lc.worst[ 0 ].actual, lc.worst[ 0 ].factor ], [ 'm0', 60, 20, 3 ] );
      assert.equal( lc.worst.length, 7 );
      assert.equal( lc.truncated, false );
    } );
  } finally { vol.done(); }
} );

test( 'R19: a maintained field is not flagged, and a small sample is not decided', async () => {
  const files = {};
  const mods = [];
  // 4 frontmatter lines + 2 body lines + the trailing empty string = 7 lines.
  for ( let i = 0; i < 12; i++ ) {
    files[ `modules/m/m${ i }.md` ] = `---\nid: m${ i }\nline_count_estimate: ${ i === 0 ? 99 : 7 }\n---\nl\nl\n`;
    mods.push( { id: `m${ i }`, path: `modules/m/m${ i }.md` } );
  }
  const vol = volume( { files, fragments: { '10-m.json': mods } } );
  const small = volume( { files: { 'modules/m/s.md': '---\nid: s\nline_count_estimate: 99\n---\nl\n' }, fragments: { '10-m.json': [ { id: 's', path: 'modules/m/s.md' } ] } } );
  try {
    await on( vol, () => assert.equal( runConsistencyAudit( { checks: [ 'C-I' ] } ).advisory[ 'C-I' ].line_count_estimate.field_unmaintained, false ) );
    await on( small, () => {
      const lc = runConsistencyAudit( { checks: [ 'C-I' ] } ).advisory[ 'C-I' ].line_count_estimate;
      assert.equal( lc.field_unmaintained, null );
      assert.match( lc.field_unmaintained_reason, /not decided below 10/ );
    } );
  } finally { vol.done(); small.done(); }
} );

// ───────────────────────────── Section 10 (G2) ────────────────────────────

test( 'G2: entries without a file are grouped by source fragment, with the ids that resolve elsewhere and the orphans', async () => {
  const vol = volume( {
    files: { 'modules/a/alpha.md': '# alpha\n', 'modules/b/beta.md': '# beta\n' },
    fragments: {
      '10-core.json': [ { id: 'alpha', path: 'modules/a/alpha.md' }, { id: 'beta', path: 'modules/b/beta.md' } ],
      '90-tools-fast-index.json': [ { id: 'alpha' }, { id: 'beta' }, { id: 'zip-workspace' } ],
    },
  } );
  try {
    await on( vol, async () => {
      const ca = runConsistencyAudit( { checks: [ 'C-A' ] } ).deterministic[ 'C-A' ];
      assert.equal( ca.manifest_entries_without_file_by_source.length, 1, 'one fragment reads as one line' );
      const g = ca.manifest_entries_without_file_by_source[ 0 ];
      assert.equal( g.source, 'references/manifest/90-tools-fast-index.json' );
      assert.equal( g.count, 3 );
      assert.equal( g.declares_no_path, 3 );
      assert.equal( g.ids_resolving_elsewhere, 2 );
      assert.deepEqual( g.orphan_ids, [ 'zip-workspace' ] );
      assert.equal( ca.manifest_entries_without_file.length, 3, 'the flat list is kept' );
    } );
  } finally { vol.done(); }
} );
