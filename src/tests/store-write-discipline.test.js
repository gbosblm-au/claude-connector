// src/tests/store-write-discipline.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-2: store-write discipline, connector half.
//
//   C-WRITE-DECLARED-REFUSED   a write against a store with a declared holder
//                              is refused and names the holder
//   C-WRITE-CAPTURED           a refusal produces a forensic capture plus
//                              manifest
//   C-CANONICAL-DERIVED-SEPARABLE  a derived index is detached and rebuilt
//                              without touching canonical data
//   C-WRITE-PATHS-DERIVED      the store write-path inventory is produced by a
//                              scan of src/ and compared with the registry in
//                              both directions
//
// Drives the real write handlers (tools/skill-content.js, the WordPress
// restore handlers, tools/skill-modular.js handleModulesRestoreFromWp) against
// a throwaway volume. Nothing is mocked.
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jsFiles, findCalls, readBlanked } from './helpers/source-scan.js';

const SRC = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const ROOT = mkdtempSync( join( tmpdir(), 'h2-discipline-' ) );
const SKILL = join( ROOT, 'skill' );
const AVA = join( SKILL, 'ava' );
process.env.SKILL_FILE_PATH = join( SKILL, 'SKILL.md' );
process.env.TS_CLIENT_MODE = 'owner';
process.env.WP_SKILL_URL = '';
process.env.WP_SKILL_KEY = '';

const D = await import( '../utils/storeWriteDiscipline.js' );
const SC = await import( '../tools/skill-content.js' );
const SM = await import( '../tools/skill-modular.js' );
const DI = await import( '../utils/derivedIndexes.js' );

const sha = ( s ) => createHash( 'sha256' ).update( s ).digest( 'hex' );
const body = ( r ) => JSON.parse( r.content[ 0 ].text );

function seed() {
  rmSync( AVA, { recursive: true, force: true } );
  for ( const d of [ 'references/manifest', 'references/erp', 'modules/meta', 'archive', 'scripts' ] ) mkdirSync( join( AVA, d ), { recursive: true } );
  writeFileSync( join( AVA, 'CORE.md' ), '# Core\n' );
  writeFileSync( join( AVA, 'MANIFEST.json' ), JSON.stringify( { modules: [] } ) );
  writeFileSync( join( AVA, 'references', 'erp', 'checklist.md' ), '# Checklist v1\n' );
  writeFileSync( join( AVA, 'archive', 'INSTALL.md' ), '# Install\n' );
}

describe( 'H-2 store-write discipline (connector)', () => {
  before( seed );
  beforeEach( seed );
  after( () => rmSync( ROOT, { recursive: true, force: true } ) );

  test( 'C-WRITE-DECLARED-REFUSED: a write against a claimed store is refused, not applied, and names the holder', async () => {
    const c = D.declareClaim( 'references', { kind: 'operator', label: 'brian', purpose: 'reorganising erp/' } );
    assert.equal( c.ok, true, JSON.stringify( c ) );

    const r = await SC.handleReferenceWrite( { filename: 'erp/checklist.md', content: '# Checklist v2 (stale copy)\n' } );
    assert.equal( r.isError, true );
    const b = body( r );
    assert.equal( b.refused, true );
    assert.equal( b.code, 'store_claimed' );
    assert.equal( b.holder.id, 'operator:brian' );
    assert.match( b.message, /operator:brian/ );
    assert.match( b.message, /reorganising erp\// );
    assert.equal( readFileSync( join( AVA, 'references', 'erp', 'checklist.md' ), 'utf8' ), '# Checklist v1\n', 'the store is unchanged' );

    // The holder may write its own store.
    const ok = await SC.handleReferenceWrite( { filename: 'erp/checklist.md', content: '# Checklist v2\n', claim_id: c.claim.claim_id } );
    assert.notEqual( ok.isError, true, ok.content[ 0 ].text );
    assert.equal( readFileSync( join( AVA, 'references', 'erp', 'checklist.md' ), 'utf8' ), '# Checklist v2\n' );

    assert.equal( D.releaseClaim( 'references', c.claim.claim_id ).ok, true );
    const after = await SC.handleReferenceWrite( { filename: 'erp/checklist.md', content: '# Checklist v3\n' } );
    assert.notEqual( after.isError, true, 'released: an ordinary write lands again' );
  } );

  test( 'C-WRITE-DECLARED-REFUSED: every store family on the write path is guarded (archive, scripts, modules)', async () => {
    for ( const [ family, call ] of [
      [ 'archive', () => SC.handleArchiveWrite( { filename: 'INSTALL.md', content: '# new\n' } ) ],
      [ 'scripts', () => SC.handleScriptWrite( { filename: 'tools/x.py', content: 'print(1)\n' } ) ],
      [ 'modules', () => SC.handleModuleWrite( { file: 'meta/new-mod.md', content: '# New module\nAbout widgets.\n' } ) ],
    ] ) {
      const c = D.declareClaim( family, { kind: 'restore', label: 'wordpress-restore', purpose: `restore-${ family }` } );
      assert.equal( c.ok, true );
      const r = await call();
      assert.equal( r.isError, true, `${ family }: refused` );
      assert.equal( body( r ).holder.id, 'restore:wordpress-restore', `${ family }: holder named` );
      D.releaseClaim( family, c.claim.claim_id );
    }
  } );

  test( 'C-WRITE-CAPTURED: a refusal captures the attempted content and the held state, with a manifest', async () => {
    const c = D.declareClaim( 'references', { kind: 'operator', label: 'brian', purpose: 'maintenance' } );
    const attempted = '# Checklist v9 (would have overwritten)\n';
    const r = body( await SC.handleReferenceWrite( { filename: 'erp/checklist.md', content: attempted } ) );
    assert.ok( r.forensics, 'the refusal names its capture directory' );
    const dir = join( AVA, '.store-discipline', r.forensics );
    const manifest = JSON.parse( readFileSync( join( dir, 'manifest.json' ), 'utf8' ) );
    assert.equal( manifest.family, 'references' );
    assert.equal( manifest.refusal.holder.id, 'operator:brian' );
    const att = manifest.files.find( ( f ) => f.role === 'attempted' );
    const held = manifest.files.find( ( f ) => f.role === 'held' );
    assert.equal( att.sha256, sha( attempted ) );
    assert.equal( readFileSync( join( dir, att.captured_as ), 'utf8' ), attempted, 'nothing discarded: the refused content is on disk' );
    assert.equal( held.sha256, sha( '# Checklist v1\n' ) );
    assert.equal( readFileSync( join( dir, held.captured_as ), 'utf8' ), '# Checklist v1\n', 'the state it would have replaced is captured too' );
    D.releaseClaim( 'references', c.claim.claim_id );
  } );

  test( 'C-WRITE-CAPTURED: a WordPress restore against a claimed store is refused whole, captured, and named', async () => {
    const c = D.declareClaim( 'archive', { kind: 'operator', label: 'brian', purpose: 'hand repair' } );
    const res = await SC.handleArchiveRestoreFromWp( { files: { 'INSTALL.md': '# from WP\n', 'NEW.md': '# new\n' }, source: 'wp-admin' } );
    assert.equal( res.success, false );
    assert.equal( res.refusal.holder.id, 'operator:brian' );
    assert.equal( res.files_restored, 0 );
    assert.equal( readFileSync( join( AVA, 'archive', 'INSTALL.md' ), 'utf8' ), '# Install\n' );
    assert.equal( existsSync( join( AVA, 'archive', 'NEW.md' ) ), false );
    const manifest = JSON.parse( readFileSync( join( AVA, '.store-discipline', res.refusal.forensics, 'manifest.json' ), 'utf8' ) );
    assert.deepEqual( manifest.files.filter( ( f ) => f.role === 'attempted' ).map( ( f ) => f.path ).sort(), [ 'INSTALL.md', 'NEW.md' ] );
    D.releaseClaim( 'archive', c.claim.claim_id );
  } );

  test( 'a restore holds a claim for its duration, so an interactive write meanwhile is refused and names the restore', async () => {
    const bulk = D.beginBulkRewrite( { families: [ 'references' ], label: 'wordpress-restore', purpose: 'restore-references', tool: 'restore-references', payload: [] } );
    assert.equal( bulk.ok, true );
    const r = body( await SC.handleReferenceWrite( { filename: 'erp/checklist.md', content: '# racing write\n' } ) );
    assert.equal( r.holder.id, 'restore:wordpress-restore' );
    bulk.release();
    assert.equal( D.activeClaim( 'references' ), null, 'released at the end' );
    // And the real restore handler leaves no claim behind on success.
    const ok = await SC.handleReferenceRestoreFromWp( { files: { 'erp/checklist.md': '# restored\n' } } );
    assert.equal( ok.success, true );
    assert.equal( D.activeClaim( 'references' ), null );
  } );

  test( 'handleModulesRestoreFromWp claims only the families its paths touch, and is refused under a held claim', async () => {
    const c = D.declareClaim( 'modules', { kind: 'operator', label: 'brian', purpose: 'module audit' } );
    const refused = await SM.handleModulesRestoreFromWp( { files: { 'modules/meta/x.md': '# x\n' } } );
    assert.equal( refused.success, false );
    assert.equal( refused.refusal.holder.id, 'operator:brian' );
    // CORE.md is not in a store family: no claim, not refused.
    const core = await SM.handleModulesRestoreFromWp( { files: { 'CORE.md': '# Core v2\n' } } );
    assert.equal( core.success, true );
    D.releaseClaim( 'modules', c.claim.claim_id );
  } );

  test( 'a lapsed claim is moved aside, not deleted, and no longer refuses', async () => {
    const c = D.declareClaim( 'scripts', { kind: 'process', label: 'test', purpose: 'brief', ttlMs: 1000, now: Date.now() - 60000 } );
    assert.equal( c.ok, true );
    assert.equal( D.activeClaim( 'scripts' ), null );
    assert.ok( readdirSync( join( AVA, '.store-discipline', 'claims', 'expired' ) ).some( ( n ) => n.includes( c.claim.claim_id ) ) );
    const ok = await SC.handleScriptWrite( { filename: 'a/b.py', content: 'x=1\n' } );
    assert.notEqual( ok.isError, true );
  } );

  test( 'an unreadable claim file is treated as held, never as absent', async () => {
    mkdirSync( join( AVA, '.store-discipline', 'claims' ), { recursive: true } );
    writeFileSync( join( AVA, '.store-discipline', 'claims', 'archive.json' ), '{ not json' );
    const r = await SC.handleArchiveWrite( { filename: 'INSTALL.md', content: '# x\n' } );
    assert.equal( r.isError, true );
    assert.match( body( r ).holder.id, /unreadable/ );
  } );

  test( 'two declarations race: exactly one wins and the loser is told who holds it', () => {
    const a = D.declareClaim( 'modules', { kind: 'process', label: 'a', purpose: 'p' } );
    const b = D.declareClaim( 'modules', { kind: 'process', label: 'b', purpose: 'p' } );
    assert.equal( a.ok, true );
    assert.equal( b.ok, false );
    assert.equal( b.code, 'claim_held' );
    assert.equal( b.holder.id, 'process:a' );
    assert.equal( D.releaseClaim( 'modules', 'not-the-id' ).ok, false, 'only the holder can release' );
  } );

  test( 'the family set is closed; the vault is the gateway\'s and is refused here with a pointer', () => {
    assert.equal( D.declareClaim( 'notes', { purpose: 'x' } ).code, 'unknown_store_family' );
    const v = D.declareClaim( 'vault', { purpose: 'x' } );
    assert.equal( v.code, 'store_family_not_on_connector' );
    assert.match( v.message, /lib\/store-claims\.js/ );
    assert.equal( D.declareClaim( 'archive', { purpose: '' } ).code, 'claim_purpose_required' );
  } );

  test( 'storeDirs() agrees with the content tools\' own path derivation', () => {
    const listed = body( SC.handleReferenceList( {} ) );
    assert.equal( listed.path, D.storeDirs().references );
    assert.equal( body( SC.handleArchiveList( {} ) ).path, D.storeDirs().archive );
  } );

  test( 'C-CANONICAL-DERIVED-SEPARABLE: detaching and rebuilding a derived index leaves every canonical file byte-identical', () => {
    writeFileSync( join( AVA, 'scripts', 'brain_tools_catalog.json' ), '{"tools":["old"]}' );
    writeFileSync( join( AVA, 'modules', 'meta', 'm.md' ), '# m\n' );
    const before = DI.canonicalDigest();
    assert.ok( ! DI.canonicalFiles().includes( 'scripts/brain_tools_catalog.json' ), 'the derived artefact is not canonical' );
    const r = DI.detachAndRebuild( {
      id: 'brain_tools_catalog',
      rebuild: () => { writeFileSync( join( AVA, 'scripts', 'brain_tools_catalog.json' ), '{"tools":["new"]}' ); return true; },
    } );
    assert.equal( r.ok, true, JSON.stringify( r ) );
    assert.equal( r.canonical_untouched, true );
    assert.equal( DI.canonicalDigest().digest, before.digest );
    assert.ok( r.detached_to && existsSync( join( AVA, r.detached_to ) ), 'the old artefact is kept, not deleted' );
    // The merged manifest is derived in memory and never written back.
    const manifestBefore = readFileSync( join( AVA, 'MANIFEST.json' ), 'utf8' );
    const m = DI.detachAndRebuild( { id: 'merged_manifest', rebuild: () => true } );
    assert.equal( m.ok, true );
    assert.equal( readFileSync( join( AVA, 'MANIFEST.json' ), 'utf8' ), manifestBefore );
  } );

  test( 'C-CANONICAL-DERIVED-SEPARABLE: a rebuild that writes canonical data is reported as a failure', () => {
    const r = DI.detachAndRebuild( {
      id: 'brain_tools_catalog',
      rebuild: () => { writeFileSync( join( AVA, 'references', 'manifest', '99-folded.json' ), '{}' ); return true; },
    } );
    assert.equal( r.ok, false );
    assert.equal( r.canonical_untouched, false );
  } );
} );

// ── C-WRITE-PATHS-DERIVED: the inventory is produced by a scan ───────────────

/**
 * Every filesystem write call in a file that can name a store directory.
 * The rule is structural: a file that resolves a store path (getContentPaths,
 * getModularPaths, storeDirs, the content store names, SCRIPTS_DIR) and calls a
 * write primitive is a candidate store write site.
 */
const STORE_AWARE = /getContentPaths\s*\(|getModularPaths\s*\(|storeDirs\s*\(|referencesDir|archiveDir|scriptsDir|modulesDir|avaDir|SCRIPTS_DIR/;
const WRITE_CALL = /(?<![.\w$])(writeFileSync|appendFileSync|renameSync|copyFileSync|cpSync|unlinkSync|rmSync|createWriteStream)\s*\(/g;

/**
 * The registry: every store-aware write site, keyed file|anchor|callee, with
 * what it writes and how it is governed. `guard` is 'guardStoreWrite' or
 * 'beginBulkRewrite' (must appear in the same function before the call), or a
 * stated reason the site is not a store-family write.
 */
export const STORE_WRITE_SITES = {
  'tools/skill-content.js|writeContentFile|writeFileSync':           { family: 'archive|references|scripts', guard: 'guardStoreWrite' },
  'tools/skill-content.js|handleModuleWrite|writeFileSync':          { family: 'modules', guard: 'guardStoreWrite' },
  'tools/skill-content.js|restoreFromWp|writeFileSync':              { family: 'archive|references|scripts', guard: 'beginBulkRewrite', anchorFn: 'buildRestoreHandler' },
  'tools/skill-modular.js|handleModulesRestoreFromWp|writeFileSync': { family: 'modules|references|archive|scripts', guard: 'beginBulkRewrite' },
  'tools/skill-modular.js|handlePersonalityWrite|writeFileSync':     { family: null, reason: 'PERSONALITY.md: a compile input outside the store families; ledgered (H-3)' },
  'tools/skill-modular.js|handleDispatchRuleAdd|writeFileSync':      { family: null, reason: 'DISPATCH_RULES.json: a dispatch input outside the store families; ledgered (H-3)' },
  'tools/manifest-fragments.js|writeModuleFragment|writeFileSync':   { family: 'references', guard: 'caller', reason: 'reached only through module-intake registerModuleWithIntake, after handleModuleWrite has guarded the references family' },
  'tools/skill.js|writeMeta|writeFileSync':                          { family: null, reason: 'canonical SKILL.md metadata, outside the store families' },
  'tools/skill.js|writeHistory|writeFileSync':                       { family: null, reason: 'canonical SKILL.md history, outside the store families' },
  'tools/skill.js|writeAdditionsMeta|writeFileSync':                 { family: null, reason: 'staged-additions metadata, outside the store families' },
  'tools/skill.js|archiveCurrent|writeFileSync':                     { family: null, reason: 'SKILL.md version archive, outside the store families' },
  'tools/skill.js|canonicalWrite|writeFileSync':                     { family: null, reason: 'canonical SKILL.md, outside the store families; ledgered (H-3)' },
  'tools/skill.js|handleSkillWrite|writeFileSync':                   { family: null, reason: 'MANIFEST_APPEND.json and SKILL_PENDING.md, outside the store families; ledgered (H-3)' },
  'tools/skill.js|handleSkillWriteAddition|writeFileSync':           { family: null, reason: 'staged additions, outside the store families; ledgered (H-3)' },
  'tools/skill.js|handleSkillMergeAdditions|writeFileSync':          { family: null, reason: 'clears staged additions after a merge; ledgered (H-3)' },
  'tools/brain-scan-trigger.js|writeToolCatalog|writeFileSync':      { family: null, reason: 'derived index scripts/brain_tools_catalog.json, declared in utils/derivedIndexes.js' },
  'tools/brain-scan-trigger.js|writeToolCatalog|renameSync':         { family: null, reason: 'derived index, atomic rename of the catalogue' },
  'tools/brain-scan-trigger.js|writeCompileRecord|writeFileSync':    { family: null, reason: 'derived observability record under ava/downloads' },
  'tools/brain-scan-trigger.js|writeCompileRecord|renameSync':       { family: null, reason: 'derived observability record, atomic rename' },
  'tools/script-execute.js|handleScriptExecute|writeFileSync':       { family: null, reason: 'per-run temp input file under /tmp' },
  'tools/script-execute.js|handleScriptExecute|unlinkSync':          { family: null, reason: 'per-run temp files under /tmp' },
  'tools/script-execute.js|handleScriptExecute|rmSync':              { family: null, reason: 'per-run temp output directory under /tmp' },
  'tools/render-tools.js|stageSpec|writeFileSync':                   { family: null, reason: 'per-call staged spec file' },
  'tools/render-tools.js|cleanupStaged|unlinkSync':                  { family: null, reason: 'per-call staged spec file' },
  'tools/homeworkTools.js|handleHomeworkAssessRender|writeFileSync': { family: null, reason: 'per-call temp input under the OS temp directory' },
  'tools/homeworkTools.js|handleHomeworkAssessRender|unlinkSync':    { family: null, reason: 'per-call temp files' },
  'routes/volume-snapshot.js|safeUnlink|unlinkSync':                 { family: null, reason: 'upload temp archive under SNAPSHOT_TMP_DIR' },
  'routes/volume-snapshot.js|registerVolumeSnapshotRoutes|writeFileSync': { family: null, reason: 'buffers the upload to a temp file; the extraction that rewrites the stores runs under beginBulkRewrite (checked by its own test below)' },
  'server-http.js|run|writeFileSync':                                { family: null, reason: 'readiness probe file' },
  'server-http.js|run|unlinkSync':                                   { family: null, reason: 'readiness probe file' },
  'server-http.js|safeUnlinkUpload|unlinkSync':                      { family: null, reason: 'retention sweep of uploads and downloads' },
  'server-http.js|(module)|writeFileSync':                           { family: null, reason: 'LinkedIn CSV, uploads, upload metadata and the modular-mode file: none is a store family' },
};

describe( 'C-WRITE-PATHS-DERIVED: the store write-path inventory', () => {
  const files = jsFiles( SRC, [ '.' ], ( r ) => ! /(^|\/)tests?\//.test( r ) && ! r.endsWith( '.test.js' ) && ! r.startsWith( 'utils/storeWriteDiscipline' ) && ! r.startsWith( 'utils/derivedIndexes' ) && ! r.startsWith( 'utils/moduleLedger' ) && ! r.startsWith( 'tools/module-intake' ) && ! r.startsWith( 'tools/selection-telemetry' ) && ! r.startsWith( 'utils/processGuard' ) );
  const storeAware = files.filter( ( f ) => STORE_AWARE.test( readBlanked( SRC, f ).code ) || STORE_AWARE.test( readFileSync( join( SRC, f ), 'utf8' ).replace( /\/\/.*$/gm, '' ) ) );
  const sites = findCalls( SRC, storeAware, WRITE_CALL );
  const keyOf = ( s ) => `${ s.file }|${ s.anchor }|${ s.callee }`;
  const lookup = ( s ) => STORE_WRITE_SITES[ keyOf( s ) ] || STORE_WRITE_SITES[ `${ s.file }|*|${ s.callee }` ];

  test( 'every scanned store-aware write site is in the registry (scan -> registry)', () => {
    const missing = sites.filter( ( s ) => ! lookup( s ) ).map( ( s ) => `${ keyOf( s ) } (line ${ s.line })` );
    assert.deepEqual( missing, [], 'unregistered store write site(s): classify each in STORE_WRITE_SITES' );
  } );

  test( 'every registry entry still exists at source (registry -> scan)', () => {
    const found = new Set( sites.map( keyOf ) );
    const wild = new Set( sites.map( ( s ) => `${ s.file }|*|${ s.callee }` ) );
    const stale = Object.keys( STORE_WRITE_SITES ).filter( ( k ) => ! found.has( k ) && ! wild.has( k ) );
    assert.deepEqual( stale, [], 'registry entries whose site is gone' );
  } );

  test( 'every store-family write site calls its guard in the same function before writing', () => {
    const unguarded = [];
    for ( const s of sites ) {
      const reg = lookup( s );
      if ( ! reg || ! reg.family || reg.guard === 'caller' ) continue;
      const { src } = readBlanked( SRC, s.file );
      const before = src.slice( 0, s.index );
      const fnName = reg.anchorFn || s.anchor;
      const start = fnName === '(module)' ? 0 : before.lastIndexOf( fnName );
      const window = before.slice( start === -1 ? 0 : start );
      if ( ! window.includes( `${ reg.guard }(` ) ) unguarded.push( `${ keyOf( s ) } expects ${ reg.guard }` );
    }
    assert.deepEqual( unguarded, [] );
  } );

  test( 'the volume restore claims every family before the extraction that rewrites them', () => {
    const { src } = readBlanked( SRC, 'routes/volume-snapshot.js' );
    const claim = src.indexOf( 'beginBulkRewrite(' );
    const extract = src.indexOf( "'extract'," );
    const inspect = src.indexOf( "'inspect'," );
    assert.ok( claim > 0 && extract > 0 && inspect > 0 );
    assert.ok( inspect < claim && claim < extract, 'inspect, then claim, then extract' );
  } );

  test( 'the scan finds the sites it must find (control: the walk is not vacuous)', () => {
    const keys = new Set( sites.map( keyOf ) );
    for ( const k of [ 'tools/skill-content.js|writeContentFile|writeFileSync', 'tools/skill-content.js|handleModuleWrite|writeFileSync', 'tools/skill-modular.js|handleModulesRestoreFromWp|writeFileSync' ] ) {
      assert.ok( keys.has( k ), `${ k } found by the scan` );
    }
  } );

  test( 'the inventory written to the delivery is this scan', () => {
    const inventory = sites.map( ( s ) => ( { site: keyOf( s ), line: s.line, ...lookup( s ) } ) );
    assert.ok( inventory.length >= 20 );
    if ( process.env.H2_INVENTORY_OUT ) writeFileSync( process.env.H2_INVENTORY_OUT, JSON.stringify( inventory, null, 2 ) );
  } );
} );
