/**
 * tests/script-audit-register.test.js  --  SPEC-AUDIT-REG-001
 *
 * The register's Python half is verified end to end by
 * `script_audit_register.py verify`, which runs a real interpreter and asserts
 * a line appears. This file covers the JavaScript half: that the connector
 * hands the hook what it needs, that it is OFF unless asked for, and above all
 * that adding a PYTHONPATH entry has not reopened the code-execution vector
 * src/tests/internal-config-custom-env.test.js exists to close.
 *
 * That last one is the reason this file exists. PYTHONPATH shadows any import,
 * so a change that puts a directory on it is a change to what a spawned script
 * can be made to run. The guard is a caller-supplied refusal; the entry added
 * here is server-derived. Those are different things, and the tests below say
 * so rather than leaving a reader to work it out.
 *
 *   node --test tests/script-audit-register.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScriptEnv } from '../src/utils/scriptEnv.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const SCRIPTS = join( ROOT, 'scripts' );

const SAVED = {};
const KEYS = [ 'TENAX_AUDIT_REGISTER', 'TENAX_SCRIPTS_BASE',
  'TENAX_AUDIT_REGISTER_PATH', 'PYTHONPATH' ];

beforeEach( () => { for ( const k of KEYS ) { SAVED[ k ] = process.env[ k ]; delete process.env[ k ]; } } );
afterEach( () => {
  for ( const k of KEYS ) {
    if ( SAVED[ k ] === undefined ) delete process.env[ k ];
    else process.env[ k ] = SAVED[ k ];
  }
} );

/** Turn the register on for one test. */
function enable( base = '/data/skill/ava/scripts' ) {
  process.env.TENAX_AUDIT_REGISTER = 'true';
  process.env.TENAX_SCRIPTS_BASE = base;
}

// ---------------------------------------------------------------------------

describe( 'the deliverables exist where the spec names them', () => {
  test( 'both scripts and the hook are on the scripts volume', () => {
    for ( const f of [ 'script_audit_register.py', 'script_audit_report.py', 'sitecustomize.py' ] ) {
      assert.ok( existsSync( join( SCRIPTS, f ) ), f );
    }
  } );

  test( 'the report tool has no delete path at all', () => {
    // Spec: "No script is deletable by the tooling". The way to make that true
    // is for the capability not to exist, rather than to be guarded -- a guard
    // can be bypassed by the next person who needs "just a quick cleanup".
    const src = readFileSync( join( SCRIPTS, 'script_audit_report.py' ), 'utf8' );
    assert.ok( ! /os\.remove|os\.unlink|shutil\.rmtree|rmdir/.test( src ),
      'no filesystem deletion primitive appears in the report tool' );
    // Quarantine is a MOVE.
    assert.ok( /shutil\.move/.test( src ) );
  } );

  test( 'the register tool is append-only', () => {
    // "Idempotent append: do not rewrite or compact it during the observation
    // window." Enforced by there being no other write mode in the module.
    // Scoped to opens of the REGISTER. The verify command writes throwaway
    // probe scripts in "w" mode, which is correct and unrelated -- an
    // unscoped scan flags it and teaches the reader to ignore this test.
    const src = readFileSync( join( SCRIPTS, 'script_audit_register.py' ), 'utf8' );
    const registerOpens = src.match( /open\(\s*register_path[^)]*\)/g ) || [];
    assert.ok( registerOpens.length >= 2, 'the register is opened for read and for append' );
    for ( const m of registerOpens ) {
      assert.ok( /"[ar]"/.test( m ), `only append and read modes on the register, found ${ m }` );
    }
    assert.ok( ! /open\(\s*register_path[^)]*"w"/.test( src ),
      'the register is never truncated' );
  } );

  test( 'quarantine refuses to run on an empty register', () => {
    // With no observation, every script classifies as never-invoked and the
    // tool would quarantine the entire volume. That is the single most
    // damaging thing this code could do, so it is prevented rather than warned
    // about.
    const src = readFileSync( join( SCRIPTS, 'script_audit_report.py' ), 'utf8' );
    assert.match( src, /REFUSING: the register is empty/ );
  } );

  test( 'the audit machinery excludes itself from the report', () => {
    // A report that nominated its own tooling for quarantine would be absurd,
    // and on a second pass self-inflicted.
    const src = readFileSync( join( SCRIPTS, 'script_audit_report.py' ), 'utf8' );
    for ( const f of [ 'sitecustomize.py', 'script_audit_register.py', 'script_audit_report.py' ] ) {
      assert.ok( src.includes( f ), `${ f } is in the skip set` );
    }
  } );
} );

// ---------------------------------------------------------------------------

describe( 'the hook never breaks a script', () => {
  const src = readFileSync( join( SCRIPTS, 'sitecustomize.py' ), 'utf8' );

  test( 'every recording path is wrapped', () => {
    // sitecustomize is imported BEFORE the script's own code, so an exception
    // here turns a working renderer into a hard failure for the sake of a
    // diagnostic.
    assert.match( src, /except Exception:/ );
    assert.match( src, /must never break a script/ );
  } );

  test( 'it is inert unless explicitly enabled', () => {
    assert.match( src, /if _ENABLED and _REGISTER_PATH:/ );
  } );

  test( 'the error path is covered by excepthook as well as atexit', () => {
    // exit status alone cannot distinguish a ValueError from a deliberate
    // sys.exit(1) or an argparse rejection, and the register is meant to tell
    // debug traces from real failures.
    assert.match( src, /sys\.excepthook = _on_exception/ );
    assert.match( src, /atexit\.register\(\s*_on_exit\s*\)/ );
  } );

  test( 'the SIGKILL gap is documented rather than hidden', () => {
    assert.match( src, /Neither fires on SIGKILL/ );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'buildScriptEnv wiring', () => {
  test( 'OFF by default: no audit variables, PYTHONPATH untouched', () => {
    const env = buildScriptEnv( { scriptKey: 'document_render.py' } );
    assert.equal( env.TENAX_AUDIT_REGISTER, undefined );
    assert.equal( env.TENAX_AUDIT_CALLER, undefined );
    assert.equal( env.PYTHONPATH, undefined );
  } );

  test( 'enabled: the hook gets base, flag and path', () => {
    enable();
    process.env.TENAX_AUDIT_REGISTER_PATH = '/data/audit/register.jsonl';
    const env = buildScriptEnv( { scriptKey: 'document_render.py' } );
    assert.equal( env.TENAX_AUDIT_REGISTER, 'true' );
    assert.equal( env.TENAX_SCRIPTS_BASE, '/data/skill/ava/scripts' );
    assert.equal( env.TENAX_AUDIT_REGISTER_PATH, '/data/audit/register.jsonl' );
    assert.match( env.PYTHONPATH, /\/data\/skill\/ava\/scripts/ );
  } );

  test( 'caller classification: a named script is a registered_tool call', () => {
    // The distinction decides the verdict: a fallback-only script is a
    // quarantine candidate and a tool-bound one never is.
    enable();
    assert.equal( buildScriptEnv( { scriptKey: 'document_render.py' } ).TENAX_AUDIT_CALLER, 'registered_tool' );
    assert.equal( buildScriptEnv( {} ).TENAX_AUDIT_CALLER, 'direct' );
    assert.equal( buildScriptEnv( { auditCaller: 'fallback' } ).TENAX_AUDIT_CALLER, 'fallback' );
  } );

  test( 'the scripts base is PREPENDED to an operator PYTHONPATH', () => {
    // Appended, the hook could be shadowed by another sitecustomize earlier on
    // the path and the register would silently record nothing.
    enable();
    process.env.PYTHONPATH = '/opt/site-packages';
    const env = buildScriptEnv( { scriptKey: 'x.py' } );
    assert.ok( env.PYTHONPATH.startsWith( '/data/skill/ava/scripts' ) );
    assert.ok( env.PYTHONPATH.includes( '/opt/site-packages' ), 'the operator value survives' );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'the PYTHONPATH guard is NOT reopened', () => {
  // The important block. PYTHONPATH shadows any import, so adding an entry to
  // it is a change to what a spawned script can be made to run.

  test( 'a caller-supplied PYTHONPATH is still refused, register ON', () => {
    enable();
    const env = buildScriptEnv( { scriptKey: 'x.py', extra: { PYTHONPATH: '/tmp/attacker' } } );
    assert.ok( ! env.PYTHONPATH.includes( '/tmp/attacker' ) );
    assert.equal( env.PYTHONPATH, '/data/skill/ava/scripts' );
  } );

  test( 'and refused with the register OFF', () => {
    const env = buildScriptEnv( { scriptKey: 'x.py', extra: { PYTHONPATH: '/tmp/attacker' } } );
    assert.ok( ! ( env.PYTHONPATH || '' ).includes( '/tmp/attacker' ) );
  } );

  test( 'the other interpreter-hijack variables stay refused', () => {
    enable();
    const env = buildScriptEnv( { scriptKey: 'x.py', extra: {
      PYTHONSTARTUP: '/tmp/evil.py', PYTHONHOME: '/tmp', LD_PRELOAD: '/tmp/evil.so',
    } } );
    for ( const k of [ 'PYTHONSTARTUP', 'PYTHONHOME', 'LD_PRELOAD' ] ) {
      assert.ok( ! env[ k ] || ! env[ k ].includes( '/tmp' ), k );
    }
  } );

  test( 'the value added is SERVER-derived, never caller-derived', () => {
    // The distinction that makes this safe: the entry comes from the
    // connector's own configuration, and the scripts base is already a
    // directory the connector executes from, so putting it on the import path
    // grants nothing that was not already granted.
    const src = readFileSync( join( ROOT, 'src', 'utils', 'scriptEnv.js' ), 'utf8' );
    assert.match( src, /process\.env\.TENAX_SCRIPTS_BASE \|\| '\/data\/skill\/ava\/scripts'/ );
    assert.match( src, /SERVER-controlled/ );
    // Applied before the caller-supplied block, which still rejects it.
    assert.ok( src.indexOf( 'env.PYTHONPATH = env.PYTHONPATH ?' ) < src.indexOf( 'Refusing to let a caller override' ),
      'the server entry is applied before the caller guard runs' );
  } );
} );
