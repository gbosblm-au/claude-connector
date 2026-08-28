/**
 * src/tests/skill-audit-personality.test.js
 *
 * Connector v13.23.3.
 *
 * skill_audit reported ava/PERSONALITY.md as permanently missing. The file is
 * not missing -- personality moved to Postgres, and the audit's modular-mode
 * list still named it unconditionally.
 *
 * An audit that always shows one red line trains its reader to skip the list,
 * which costs more than the check was worth. So absence is no longer a fault,
 * and presence is still audited: a deployment that predates the migration has
 * the file on its volume and should still see its state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A modular skill volume, optionally carrying a legacy PERSONALITY.md. */
function volume( withPersonality ) {
  const root = mkdtempSync( join( tmpdir(), 'skill-audit-' ) );
  const ava = join( root, 'ava' );
  mkdirSync( join( ava, 'modules' ), { recursive: true } );
  writeFileSync( join( root, 'SKILL.md' ), '# S' );
  writeFileSync( join( root, '.modular_mode' ), 'true' );
  writeFileSync( join( ava, 'CORE.md' ), '# core' );
  writeFileSync( join( ava, 'MANIFEST.json' ), '{}' );
  writeFileSync( join( ava, 'DISPATCH_RULES.json' ), '{}' );
  if ( withPersonality ) writeFileSync( join( ava, 'PERSONALITY.md' ), '# legacy' );
  return root;
}

/** Run the audit against a volume. */
async function audit( root ) {
  const saved = process.env.SKILL_FILE_PATH;
  process.env.SKILL_FILE_PATH = join( root, 'SKILL.md' );
  try {
    const { handleSkillAudit } = await import( '../tools/skill.js' );
    return JSON.parse( ( await handleSkillAudit( {} ) ).content[ 0 ].text );
  } finally {
    if ( undefined === saved ) delete process.env.SKILL_FILE_PATH;
    else process.env.SKILL_FILE_PATH = saved;
  }
}

test( 'a Postgres-backed volume reports nothing missing', () => {
  const root = volume( false );
  return audit( root ).then( ( result ) => {
    const missing = result.files.filter( ( f ) => ! f.exists ).map( ( f ) => f.label );
    assert.deepEqual( missing, [],
      `the audit flags files that are not missing: ${ missing.join( ', ' ) }` );
    assert.equal( result.personality_source, 'postgres',
      'the audit should say where personality lives, not merely go quiet' );
  } ).finally( () => rmSync( root, { recursive: true, force: true } ) );
} );

test( 'a legacy volume still has its PERSONALITY.md audited', () => {
  // Removing the entry outright would have hidden a real file on any
  // deployment that predates the migration.
  const root = volume( true );
  return audit( root ).then( ( result ) => {
    const entry = result.files.find( ( f ) => 'PERSONALITY.md' === f.label );
    assert.ok( entry, 'a present PERSONALITY.md must still be reported' );
    assert.equal( entry.exists, true );
    assert.equal( result.personality_source, undefined,
      'the Postgres note belongs only where the file is absent' );
  } ).finally( () => rmSync( root, { recursive: true, force: true } ) );
} );

test( 'the other modular files are still required', () => {
  // The fix must not turn every expected file into an optional one.
  const root = volume( false );
  return audit( root ).then( ( result ) => {
    for ( const label of [ 'CORE.md', 'MANIFEST.json', 'DISPATCH_RULES.json' ] ) {
      assert.ok( result.files.some( ( f ) => label === f.label ), label );
    }
  } ).finally( () => rmSync( root, { recursive: true, force: true } ) );
} );

test( 'a genuinely missing CORE.md is still reported', () => {
  const root = volume( false );
  rmSync( join( root, 'ava', 'CORE.md' ) );
  return audit( root ).then( ( result ) => {
    const core = result.files.find( ( f ) => 'CORE.md' === f.label );
    assert.ok( core && false === core.exists,
      'a real absence must still surface, or the audit reports nothing at all' );
  } ).finally( () => rmSync( root, { recursive: true, force: true } ) );
} );
