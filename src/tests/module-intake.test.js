// src/tests/module-intake.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-11: module intake gate.
//
//   C-INTAKE-RECORD        no registration without an intake record taken over
//                          the exact content being registered
//   C-INTAKE-RESCAN        a content change re-runs the checks
//   C-INTAKE-NAMED-REFUSAL a failed check refuses the write and the refusal
//                          names the check
//   advisory lint          the three H-9 shapes warn and never refuse
//   record unwritable      a record that cannot be written refuses the write
//
// Drives the real module_write handler against a throwaway volume.
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync( join( tmpdir(), 'h11-intake-' ) );
const SKILL = join( ROOT, 'skill' );
const AVA = join( SKILL, 'ava' );
process.env.SKILL_FILE_PATH = join( SKILL, 'SKILL.md' );
process.env.TS_CLIENT_MODE = 'owner';
process.env.WP_SKILL_URL = '';
process.env.WP_SKILL_KEY = '';

const I = await import( '../tools/module-intake.js' );
const SC = await import( '../tools/skill-content.js' );
const MF = await import( '../tools/manifest-fragments.js' );

const sha = ( s ) => createHash( 'sha256' ).update( s ).digest( 'hex' );
const body = ( r ) => JSON.parse( r.content[ 0 ].text );
const fragmentDir = () => join( AVA, 'references', 'manifest' );
const fragmentText = () => ( existsSync( fragmentDir() ) ? readdirSync( fragmentDir() ).map( ( n ) => readFileSync( join( fragmentDir(), n ), 'utf8' ) ).join( '\n' ) : '' );

const GOOD = '# Garden care\nHow to look after a garden through the seasons.\n\n## Watering\nWater deeply and rarely.\n';

describe( 'H-11 module intake gate', () => {
  before( () => {
    for ( const d of [ 'modules/meta', 'references/manifest' ] ) mkdirSync( join( AVA, d ), { recursive: true } );
    writeFileSync( join( AVA, 'MANIFEST.json' ), JSON.stringify( { modules: [ { id: 'base-skill', path: 'modules/meta/base-skill.md' } ] } ) );
  } );
  after( () => rmSync( ROOT, { recursive: true, force: true } ) );

  test( 'C-INTAKE-RECORD: a new module gets a passing intake record over its exact content, and only then a fragment', async () => {
    const r = body( await SC.handleModuleWrite( { file: 'meta/garden.md', content: GOOD, change_note: 'new' } ) );
    assert.equal( r.success, true, JSON.stringify( r ) );
    assert.equal( r.manifest_registration.registered, true );
    assert.equal( r.intake.passed, true );
    assert.deepEqual( r.intake.checks.map( ( c ) => c.name ), [ ...I.INTAKE_CHECKS ] );
    const rec = I.readIntakeRecord( 'meta/garden.md' );
    assert.equal( rec.content_sha256, sha( GOOD ) );
    assert.equal( rec.module_path, 'modules/meta/garden.md' );
    assert.equal( rec.module_id, 'garden' );
    assert.match( fragmentText(), /"id": "garden"/ );
  } );

  test( 'C-INTAKE-RECORD: registration with no intake record is refused and writes no fragment', () => {
    const before = fragmentText();
    const entry = MF.deriveModuleEntry( 'meta/unrecorded.md', '# Unrecorded\nBody.\n' );
    const reg = I.registerModuleWithIntake( { avaDir: AVA + '/', cleanPath: 'meta/unrecorded.md', content: '# Unrecorded\nBody.\n', entry } );
    assert.equal( reg.ok, false );
    assert.equal( reg.code, 'intake_record_missing' );
    assert.equal( fragmentText(), before, 'no fragment written' );
    assert.doesNotMatch( fragmentText(), /"id": "unrecorded"/ );
  } );

  test( 'C-INTAKE-RECORD: a record taken over different content is stale and refuses registration', () => {
    const before = fragmentText();
    const entry = MF.deriveModuleEntry( 'meta/garden.md', GOOD + 'edited\n' );
    const reg = I.registerModuleWithIntake( { avaDir: AVA + '/', cleanPath: 'meta/garden.md', content: GOOD + 'edited\n', entry } );
    assert.equal( reg.ok, false );
    assert.equal( reg.code, 'intake_record_stale' );
    assert.equal( fragmentText(), before );
  } );

  test( 'C-INTAKE-RESCAN: a content change re-runs the checks and the record follows the new content', async () => {
    const v2 = GOOD + '\n## Pruning\nPrune in late winter.\n';
    const r = body( await SC.handleModuleWrite( { file: 'meta/garden.md', content: v2, change_note: 'pruning', force: true } ) );
    assert.equal( r.success, true, JSON.stringify( r ) );
    const rec = I.readIntakeRecord( 'meta/garden.md' );
    assert.equal( rec.content_sha256, sha( v2 ), 'the record was retaken over the changed content' );
    assert.equal( rec.is_new, false );
    const hist = I.readIntakeHistory( 'meta/garden.md' );
    assert.equal( hist.length, 2 );
    assert.deepEqual( hist.map( ( h ) => h.content_sha256 ), [ sha( v2 ), sha( GOOD ) ] );
  } );

  test( 'C-INTAKE-RESCAN: a change that introduces a failing command is caught on the rescan; the body and the attached record stay as they were', async () => {
    const onDisk = readFileSync( join( AVA, 'modules', 'meta', 'garden.md' ), 'utf8' );
    const recBefore = I.readIntakeRecord( 'meta/garden.md' );
    const bad = onDisk + '\n## Reset\n```bash\nsystemctl restart nginx\n```\n\n## Verification\nCheck the page loads.\n';
    const r = body( await SC.handleModuleWrite( { file: 'meta/garden.md', content: bad, change_note: 'add reset', force: true } ) );
    assert.equal( r.refused, true );
    assert.deepEqual( r.failed_checks, [ 'commands_referenced' ] );
    assert.equal( readFileSync( join( AVA, 'modules', 'meta', 'garden.md' ), 'utf8' ), onDisk, 'nothing written' );
    assert.deepEqual( I.readIntakeRecord( 'meta/garden.md' ), recBefore, 'the attached record still describes the content on disk' );
    assert.equal( I.readIntakeHistory( 'meta/garden.md', 1 )[ 0 ].passed, false, 'the refused attempt is in the history' );
  } );

  const REFUSALS = [
    {
      check: 'triggers',
      file: 'meta/untriggered.md',
      content: '# Untriggered\nBody.\n',
      manifest_entry: { triggers: { keywords: [], phrases: [], task_class: [] } },
      detail: /nothing could dispatch this module/,
    },
    {
      check: 'commands_referenced',
      file: 'meta/killer.md',
      content: '# Killer\n```bash\npkill -f node\n```\n\n## Verification\nConfirm it stopped.\n',
      detail: /refused command/,
    },
    {
      check: 'credentials_or_volumes',
      file: 'meta/leaky.md',
      content: '# Leaky\nUse the key sk-ant-api03-' + 'A'.repeat( 40 ) + ' for calls.\n',
      detail: /credential-shaped value/,
    },
    {
      check: 'verification_step',
      file: 'meta/unverified.md',
      content: '# Unverified\n```bash\nls -la /data/skill\n```\n',
      detail: /says nowhere how the result is verified/,
    },
    {
      check: 'independence_gate',
      file: 'meta/dangling.md',
      content: '# Dangling\nBody.\n',
      manifest_entry: { depends_on: [ 'no-such-module' ] },
      detail: /depends_on does not resolve: no-such-module/,
    },
    {
      check: 'independence_gate',
      file: 'meta/shadow.md',
      content: '# Shadow\nBody.\n',
      manifest_entry: { id: 'base-skill' },
      detail: /already registered at modules\/meta\/base-skill\.md/,
    },
  ];

  for ( const c of REFUSALS ) {
    test( `C-INTAKE-NAMED-REFUSAL: ${ c.check } (${ c.file }) refuses by name and writes nothing`, async () => {
      const before = fragmentText();
      const r = body( await SC.handleModuleWrite( { file: c.file, content: c.content, change_note: 'probe', manifest_entry: c.manifest_entry } ) );
      assert.equal( r.refused, true, JSON.stringify( r ) );
      assert.equal( r.code, 'intake_check_failed' );
      assert.deepEqual( r.failed_checks, [ c.check ] );
      assert.ok( r.message.includes( `${ c.check }: ` ), `the message names the check: ${ r.message }` );
      assert.match( r.message, c.detail );
      assert.equal( existsSync( join( AVA, 'modules', c.file ) ), false, 'no body written' );
      assert.equal( fragmentText(), before, 'no fragment written' );
      const rec = I.readIntakeRecord( c.file );
      assert.equal( rec.passed, false, 'a refused create still leaves its record' );
      assert.deepEqual( rec.failed, [ c.check ] );
    } );
  }

  test( 'advisory lint: incident-log shape, references sprawl and an oversized body warn and never refuse', async () => {
    const dated = Array.from( { length: 6 }, ( _, i ) => `- 2026-0${ ( i % 9 ) + 1 }-1${ i } something happened` ).join( '\n' );
    const refs = Array.from( { length: 16 }, ( _, i ) => `See references/notes/n${ i }.md` ).join( '\n' );
    // module_write's chunk guard (CHUNK_LIMIT_LINES, default 150) blocks long
    // interactive writes before the intake runs, so on this path the oversized
    // lint is reached through its byte ceiling: 120 lines of ~290 bytes.
    const filler = Array.from( { length: 120 }, ( _, i ) => `Line ${ i } of guidance: ${ 'keep the soil moist and the beds weeded. '.repeat( 7 ) }` ).join( '\n' );
    const content = `# Sprawling\n${ dated }\n${ refs }\n${ filler }\n`;
    const r = body( await SC.handleModuleWrite( { file: 'meta/sprawling.md', content, change_note: 'lint probe' } ) );
    assert.equal( r.success, true, JSON.stringify( r ) );
    assert.equal( r.intake.passed, true );
    assert.deepEqual( r.intake.lint_warnings.map( ( w ) => w.name ).sort(), [ ...I.INTAKE_LINTS ].sort() );
  } );

  test( 'record unwritable: the write is refused and nothing changes', async () => {
    const hist = join( AVA, '.ledger', 'intake.jsonl' );
    const saved = readFileSync( hist );
    rmSync( hist );
    mkdirSync( hist ); // appendFileSync on a directory fails
    try {
      const before = fragmentText();
      const r = body( await SC.handleModuleWrite( { file: 'meta/orphan.md', content: GOOD.replace( 'Garden care', 'Orphan' ), change_note: 'x' } ) );
      assert.equal( r.refused, true );
      assert.equal( r.code, 'intake_record_unwritable' );
      assert.equal( existsSync( join( AVA, 'modules', 'meta', 'orphan.md' ) ), false );
      assert.equal( fragmentText(), before );
    } finally {
      rmSync( hist, { recursive: true, force: true } );
      writeFileSync( hist, saved );
    }
  } );

  test( 'the checklist names are a closed, ordered set', () => {
    assert.deepEqual( [ ...I.INTAKE_CHECKS ], [ 'triggers', 'commands_referenced', 'credentials_or_volumes', 'verification_step', 'independence_gate' ] );
    assert.ok( Object.isFrozen( I.INTAKE_CHECKS ) && Object.isFrozen( I.INTAKE_LINTS ) );
  } );
} );
