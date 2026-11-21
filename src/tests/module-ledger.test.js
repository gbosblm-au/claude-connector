// src/tests/module-ledger.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-3: module write audit ledger.
//
//   C-LEDGER-ENTRY     every mutation appends before/after hashes, reason and
//                      timestamp (module body, fragment registration, the
//                      canonical SKILL.md, PERSONALITY.md, DISPATCH_RULES.json,
//                      a WordPress modules push)
//   C-LEDGER-READABLE  the last N mutations are listable for any module, with
//                      hashes and reasons
//   C-LEDGER-APPEND    entries are append-only: earlier bytes never change and
//                      the hash chain holds
//
// Drives the real handlers against a throwaway volume.
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync( join( tmpdir(), 'h3-ledger-' ) );
const SKILL = join( ROOT, 'skill' );
const AVA = join( SKILL, 'ava' );
process.env.SKILL_FILE_PATH = join( SKILL, 'SKILL.md' );
process.env.TS_CLIENT_MODE = 'owner';
process.env.WP_SKILL_URL = '';
process.env.WP_SKILL_KEY = '';

const L = await import( '../utils/moduleLedger.js' );
const SC = await import( '../tools/skill-content.js' );
const SK = await import( '../tools/skill.js' );
const SM = await import( '../tools/skill-modular.js' );
const ADMIN = await import( '../tools/hermes-admin-tools.js' );

const sha = ( s ) => createHash( 'sha256' ).update( s ).digest( 'hex' );
const body = ( r ) => JSON.parse( r.content[ 0 ].text );

describe( 'H-3 module write audit ledger', () => {
  before( () => {
    for ( const d of [ 'modules/meta', 'references/manifest' ] ) mkdirSync( join( AVA, d ), { recursive: true } );
    writeFileSync( join( AVA, 'MANIFEST.json' ), JSON.stringify( { modules: [] } ) );
    writeFileSync( join( AVA, 'DISPATCH_RULES.json' ), JSON.stringify( { learned_linkages: { rules: [] } } ) );
    writeFileSync( join( AVA, 'PERSONALITY.md' ), '# Personality\n\n## Section A\n\n## Section B\n' );
  } );
  after( () => rmSync( ROOT, { recursive: true, force: true } ) );

  test( 'C-LEDGER-ENTRY: a module create appends after-hash, actor, reason and time; an overwrite appends before and after', async () => {
    const v1 = '# Ledger probe\nAbout widgets and their care.\n';
    const r1 = body( await SC.handleModuleWrite( { file: 'meta/ledger-probe.md', content: v1, change_note: 'first draft' }, { tenant_id: 't1', user_id: 7 } ) );
    assert.equal( r1.success, true, JSON.stringify( r1 ) );
    assert.equal( r1.ledger.recorded, true );

    const v2 = '# Ledger probe\nAbout widgets, their care and their feeding.\n';
    body( await SC.handleModuleWrite( { file: 'meta/ledger-probe.md', content: v2, change_note: 'add feeding', force: true } ) );

    const entries = L.readLedgerFor( 'meta/ledger-probe.md', 10 );
    const bodyEntries = entries.filter( ( e ) => e.kind === 'module' );
    assert.equal( bodyEntries.length, 2 );
    const [ newest, oldest ] = bodyEntries;
    assert.equal( oldest.action, 'create' );
    assert.equal( oldest.before_sha256, null );
    assert.equal( oldest.after_sha256, sha( v1 ) );
    assert.equal( oldest.reason, 'first draft' );
    assert.equal( oldest.actor, 'gateway:tenant=t1/user=7' );
    assert.match( oldest.at, /^\d{4}-\d{2}-\d{2}T/ );
    assert.equal( newest.action, 'overwrite' );
    assert.equal( newest.before_sha256, sha( v1 ) );
    assert.equal( newest.after_sha256, sha( v2 ) );
    assert.equal( newest.reason, 'add feeding' );
    assert.equal( newest.actor, 'mcp:direct' );
  } );

  test( 'C-LEDGER-ENTRY: the fragment registration is its own mutation, with the fragment file\'s hashes', async () => {
    const all = L.readAllLedgerEntries().filter( ( e ) => e.kind === 'fragment' );
    assert.ok( all.length >= 1 );
    const f = all.at( -1 );
    assert.equal( f.action, 'register' );
    assert.match( f.path, /^ava\/references\/manifest\/\d+-meta\.json$/ );
    const onDisk = readFileSync( join( SKILL, f.path ) );
    assert.equal( f.after_sha256, createHash( 'sha256' ).update( onDisk ).digest( 'hex' ) );
    assert.equal( f.extra.module_id, 'ledger-probe' );
  } );

  test( 'C-LEDGER-ENTRY: skill-file writes are ledgered (SKILL.md, PERSONALITY.md, DISPATCH_RULES.json, a WordPress push)', async () => {
    await SK.handleSkillWrite( { content: '# Skill v1\n', change_summary: 'seed' } );
    await SK.handleSkillWrite( { content: '# Skill v2\n', change_summary: 'tighten' } );
    const skill = L.readLedgerFor( 'SKILL.md', 5 );
    assert.equal( skill[ 0 ].before_sha256, sha( '# Skill v1\n' ) );
    assert.equal( skill[ 0 ].after_sha256, sha( '# Skill v2\n' ) );
    assert.equal( skill[ 0 ].reason, 'tighten' );

    const pw = await SM.handlePersonalityWrite( { observation: 'Notices pauses.', observation_label: 'On pauses' } );
    assert.notEqual( pw.isError, true, pw.content[ 0 ].text );
    assert.equal( L.readLedgerFor( 'ava/PERSONALITY.md', 1 )[ 0 ].tool, 'personality_write' );

    // dispatch_rule_add validates module_to_add against the static MANIFEST.json
    // (the dispatch layer is frozen, so the test seeds the manifest rather than
    // relying on the fragment registration above).
    writeFileSync( join( AVA, 'MANIFEST.json' ), JSON.stringify( { modules: [ { id: 'ledger-probe', file: 'modules/meta/ledger-probe.md' } ] } ) );
    const dr = await SM.handleDispatchRuleAdd( { trigger_description: 'compassion', trigger_patterns: [ 'grief' ], module_to_add: 'ledger-probe' } );
    assert.notEqual( dr.isError, true, dr.content[ 0 ].text );
    const rule = L.readLedgerFor( 'ava/DISPATCH_RULES.json', 1 )[ 0 ];
    assert.equal( rule.tool, 'dispatch_rule_add' );
    assert.notEqual( rule.before_sha256, rule.after_sha256 );

    const pushed = await SM.handleModulesRestoreFromWp( { files: { 'modules/meta/pushed.md': '# pushed\n' }, source: 'wp-admin', change_summary: 'restore after loss' } );
    assert.equal( pushed.success, true );
    const p = L.readLedgerFor( 'modules/meta/pushed.md', 1 )[ 0 ];
    assert.equal( p.action, 'restore' );
    assert.equal( p.reason, 'restore after loss' );
    assert.match( p.actor, /^wordpress-restore:wp-admin/ );
  } );

  test( 'C-LEDGER-READABLE: module_ledger lists the last N mutations with hashes and reasons, newest first', () => {
    const r = body( ADMIN.handleModuleLedger( { module: 'modules/meta/ledger-probe.md', limit: 1 } ) );
    assert.equal( r.module, 'ava/modules/meta/ledger-probe.md' );
    assert.equal( r.count, 1 );
    assert.equal( r.mutations[ 0 ].reason, 'add feeding' );
    assert.ok( r.mutations[ 0 ].before_sha256 && r.mutations[ 0 ].after_sha256 );
    assert.equal( r.chain.ok, true );
    assert.ok( r.intake && r.intake.passed, 'the module\'s intake record travels with its ledger' );
    // Every accepted spelling names the same module.
    for ( const q of [ 'meta/ledger-probe.md', 'ava/modules/meta/ledger-probe.md' ] ) {
      assert.equal( body( ADMIN.handleModuleLedger( { module: q } ) ).module, 'ava/modules/meta/ledger-probe.md' );
    }
  } );

  test( 'C-LEDGER-APPEND: an append never changes earlier bytes, and the hash chain holds', async () => {
    const path = L.ledgerPath();
    const before = readFileSync( path );
    await SC.handleModuleWrite( { file: 'meta/third.md', content: '# Third\nOn the third thing.\n', change_note: 'third' } );
    const after = readFileSync( path );
    assert.ok( after.length > before.length );
    assert.ok( after.subarray( 0, before.length ).equals( before ), 'the earlier ledger is a byte-exact prefix' );
    assert.deepEqual( L.verifyLedgerChain(), { ok: true, entries: after.toString().trim().split( '\n' ).length, broken_at: null } );
  } );

  test( 'C-LEDGER-APPEND: an edit in place breaks the chain at the edited line', () => {
    const path = L.ledgerPath();
    const lines = readFileSync( path, 'utf8' ).trim().split( '\n' );
    const edited = JSON.parse( lines[ 1 ] );
    edited.reason = 'rewritten after the fact';
    const tampered = [ lines[ 0 ], JSON.stringify( edited ), ...lines.slice( 2 ) ].join( '\n' ) + '\n';
    const original = readFileSync( path );
    writeFileSync( path, tampered );
    try {
      const v = L.verifyLedgerChain();
      assert.equal( v.ok, false );
      assert.equal( v.broken_at, 2 );
    } finally {
      writeFileSync( path, original );
    }
  } );

  test( 'kinds and actions are closed sets', () => {
    assert.equal( L.appendLedgerEntry( { file: join( AVA, 'x' ), kind: 'free text', action: 'create', actor: 'a', before: {}, after: {} } ).ok, false );
    assert.equal( L.appendLedgerEntry( { file: join( AVA, 'x' ), kind: 'module', action: 'whatever', actor: 'a', before: {}, after: {} } ).ok, false );
    assert.ok( existsSync( L.ledgerPath() ) );
  } );
} );
