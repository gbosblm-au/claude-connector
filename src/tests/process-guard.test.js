// src/tests/process-guard.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-4: the self-termination guard.
//
//   C-GUARD-HOST-KILL        a script attempting to kill/stop the host is
//                            refused with a reason
//   C-GUARD-IMAGE-KILL       image-level kills are refused
//   C-GUARD-NON-OVERRIDABLE  no flag bypasses the guard
//   C-GUARD-SITES-DERIVED    the guarded call-site set is produced by a scan of
//                            src/ and compared with GUARDED_SITES both ways;
//                            a planted call site reddens the walk
//
// Drives the real script_execute handler with real Python. When no python3 is
// on PATH the Python-dependent cases say so on stdout and skip by name; the
// static and walk cases never need it.
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { jsFiles, findCalls, readBlanked } from './helpers/source-scan.js';

const SRC = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const ROOT = mkdtempSync( join( tmpdir(), 'h4-guard-' ) );
const SCRIPTS = join( ROOT, 'skill', 'ava', 'scripts' );
mkdirSync( SCRIPTS, { recursive: true } );
process.env.SKILL_FILE_PATH = join( ROOT, 'skill', 'SKILL.md' );
process.env.SCRIPTS_DIR = SCRIPTS;
process.env.DOWNLOADS_DIR = join( ROOT, 'downloads' );
mkdirSync( process.env.DOWNLOADS_DIR, { recursive: true } );

const PG = await import( '../utils/processGuard.js' );
const SE = await import( '../tools/script-execute.js' );

const PY = existsSync( '/mise/shims/python3' ) ? '/mise/shims/python3' : 'python3';
const HAVE_PY = spawnSync( PY, [ '-c', 'print(1)' ] ).status === 0;
if ( ! HAVE_PY ) console.log( 'SKIP process-guard runtime cases: python3 is not available on this machine; the static and walk cases still run.' );
const needPy = { skip: HAVE_PY ? false : 'python3 not available' };

const script = ( name, body ) => { writeFileSync( join( SCRIPTS, name ), body ); return name; };
const audit = () => existsSync( PG.auditPath() ) ? readFileSync( PG.auditPath(), 'utf8' ).trim().split( '\n' ).map( ( l ) => JSON.parse( l ) ) : [];

describe( 'H-4 self-termination guard', () => {
  after( () => rmSync( ROOT, { recursive: true, force: true } ) );

  test( 'C-GUARD-HOST-KILL: a script that signals the connector is refused with a stated reason, and nothing runs', needPy, async () => {
    const marker = join( ROOT, 'ran-host-kill' );
    script( 'kill_host.py', `import os, signal\nopen(${ JSON.stringify( marker ) }, 'w').write('ran')\nos.kill(os.getppid(), signal.SIGTERM)\n` );
    const before = audit().length;
    const r = await SE.handleScriptExecute( { script_path: 'kill_host.py' } );
    assert.equal( r.refused, true );
    assert.equal( r.code, 'host_kill' );
    assert.match( r.error, /Refused by the process guard: .*host/ );
    assert.equal( existsSync( marker ), false, 'the script never started' );
    const entries = audit();
    assert.equal( entries.length, before + 1, 'the attempt left an audit entry' );
    assert.equal( entries.at( -1 ).code, 'host_kill' );
  } );

  test( 'C-GUARD-HOST-KILL: PID 1, a process group and stop/restart commands are refused too', () => {
    for ( const [ src, code ] of [
      [ 'import os\nos.kill(1, 9)\n', 'host_kill' ],
      [ 'import os\nos.killpg(os.getpgrp(), 15)\n', 'host_kill' ],
      [ 'import os\nos.system("shutdown -h now")\n', 'host_stop_restart' ],
      [ 'import subprocess\nsubprocess.run(["systemctl", "restart", "connector"])\n', 'host_stop_restart' ],
      [ 'import subprocess\nsubprocess.run("railway redeploy", shell=True)\n', 'host_stop_restart' ],
      [ 'import ctypes\nctypes.CDLL(None).kill(1, 9)\n', 'raw_signal_via_ctypes' ],
      [ 'import importlib, os\nimportlib.reload(os)\n', 'guard_tamper' ],
    ] ) {
      const f = PG.inspectPythonSource( src, 't.py' );
      assert.ok( f.length, `refused: ${ src.trim() }` );
      assert.equal( f[ 0 ].code, code, src.trim() );
      assert.ok( f[ 0 ].reason.length > 10, 'with a stated reason' );
    }
  } );

  test( 'C-GUARD-IMAGE-KILL: image-level and name-derived kills are refused', needPy, async () => {
    for ( const [ name, src ] of [
      [ 'pkill.py', 'import subprocess\nsubprocess.run(["pkill", "-f", "node"])\n' ],
      [ 'killall.py', 'import os\nos.system("killall node")\n' ],
      [ 'xargs.py', 'import os\nos.system("pgrep node | xargs kill -9")\n' ],
      [ 'iter.py', 'import psutil\nfor p in psutil.process_iter():\n    if p.name() == "node":\n        p.kill()\n' ],
    ] ) {
      script( name, src );
      const r = await SE.handleScriptExecute( { script_path: name } );
      assert.equal( r.refused, true, `${ name } refused` );
      assert.ok( [ 'image_level_kill', 'name_derived_kill' ].includes( r.code ), `${ name }: ${ r.code }` );
    }
  } );

  test( 'C-GUARD-NON-OVERRIDABLE: no flag, argument or override field bypasses the guard', needPy, async () => {
    script( 'kill_host2.py', 'import os, signal\nos.kill(os.getppid(), signal.SIGKILL)\n' );
    const r = await SE.handleScriptExecute( {
      script_path: 'kill_host2.py',
      force: true, override: true, allow_kill: true, guard: false, unsafe: true, process_guard: 'off',
      args: [ '--force' ],
    } );
    assert.equal( r.refused, true );
    assert.equal( r.code, 'host_kill' );
  } );

  test( 'the runtime layer refuses what the static scan cannot see (an obfuscated kill), and the connector survives', needPy, async () => {
    script( 'sneaky.py', [
      'import os, sys',
      "fn = getattr(os, 'ki' + 'll')",
      'try:',
      '    fn(os.getppid(), 0)',
      "    print('SIGNAL-SENT')",
      'except PermissionError as e:',
      "    print('REFUSED-AT-RUNTIME', e)",
      '',
    ].join( '\n' ) );
    const r = await SE.handleScriptExecute( { script_path: 'sneaky.py' } );
    assert.equal( r.refused, undefined, 'the static layer let it through' );
    assert.match( r.stdout, /REFUSED-AT-RUNTIME/ );
    assert.doesNotMatch( r.stdout, /SIGNAL-SENT/ );
    assert.ok( r.process_guard_refusals && r.process_guard_refusals[ 0 ].code === 'host_kill', 'the runtime refusal is reported' );
    assert.ok( audit().some( ( e ) => e.layer === 'runtime' && e.code === 'host_kill' ), 'and audited' );
  } );

  test( 'an ordinary script still runs, sees its own path and arguments, and may signal its own child', needPy, async () => {
    script( 'ok.py', [
      'import os, sys, subprocess, signal',
      'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])',
      'os.kill(child.pid, signal.SIGTERM)',
      'child.wait()',
      'print("argv0=" + os.path.basename(sys.argv[0]), "args=" + ",".join(sys.argv[1:]), "child_rc=" + str(child.returncode))',
      '',
    ].join( '\n' ) );
    const r = await SE.handleScriptExecute( { script_path: 'ok.py', args: [ 'alpha' ] } );
    assert.equal( r.return_code, 0, r.stderr );
    assert.match( r.stdout, /argv0=ok\.py/ );
    assert.match( r.stdout, /alpha/ );
    assert.match( r.stdout, /child_rc=-15/ );
  } );

  test( 'a sitecustomize.py on the scripts volume is inspected too: it runs before every script', needPy, async () => {
    writeFileSync( join( SCRIPTS, 'sitecustomize.py' ), 'import os\nos.kill(os.getppid(), 9)\n' );
    script( 'innocent.py', 'print("hello")\n' );
    try {
      const r = await SE.handleScriptExecute( { script_path: 'innocent.py' } );
      assert.equal( r.refused, true );
      assert.match( r.error, /sitecustomize\.py/ );
    } finally {
      rmSync( join( SCRIPTS, 'sitecustomize.py' ) );
    }
  } );

  test( 'assertLaunchAllowed refuses refused binaries and unregistered sites, with an audit entry', () => {
    assert.throws( () => PG.assertLaunchAllowed( 'script_execute.run', 'pkill', [ 'node' ] ), PG.ProcessGuardRefusal );
    assert.throws( () => PG.assertLaunchAllowed( 'script_execute.run', '/usr/bin/systemctl', [ 'stop', 'x' ] ), /host_stop_restart/ );
    assert.throws( () => PG.assertLaunchAllowed( 'export.python_inline', 'python3 -c "import os; os.kill(os.getppid(), 9)"', [], { shell: true } ), /host_kill/ );
    assert.throws( () => PG.assertLaunchAllowed( 'no.such.site', 'python3', [] ), /unregistered_call_site/ );
    assert.equal( PG.assertLaunchAllowed( 'brain_scan.python', 'python3', [ 'brain_scan.py' ] ), true );
  } );

  test( 'command position: a refused word is a command only where a command starts, not as a path segment or argument value', () => {
    // Regression pin for the v13.39.0 review finding: "/data/skill" (the skill
    // volume) read as the procps "skill" command, and an argument value
    // "service" as the service command.
    for ( const benign of [ 'ls -la /data/skill', 'cat /app/service.log', '--mode service', 'grep -c service file', '/data/skill/scripts/run.py', 'python3 run.py skill' ] ) {
      assert.equal( PG.inspectCommandText( benign ), null, benign );
    }
    for ( const [ text, code ] of [
      [ 'kill -9 1', 'image_level_kill' ], [ '/usr/bin/kill 1', 'image_level_kill' ], [ 'echo hi; pkill node', 'image_level_kill' ],
      [ 'bash -c "killall node"', 'image_level_kill' ], [ 'if true; then kill 1; fi', 'image_level_kill' ], [ 'timeout 5 kill 3', 'image_level_kill' ],
      [ 'sudo reboot', 'host_stop_restart' ], [ 'x && shutdown -h now', 'host_stop_restart' ], [ 'echo a\nservice nginx restart', 'host_stop_restart' ],
      [ 'nohup docker restart x', 'host_stop_restart' ], [ '["systemctl restart connector"]', 'host_stop_restart' ],
    ] ) {
      const f = PG.inspectCommandText( text );
      assert.ok( f, `refused: ${ text }` );
      assert.equal( f.code, code, text );
    }
    // Script arguments: a single word is data; a command line is refused.
    const dir = mkdtempSync( join( tmpdir(), 'h4-args-' ) );
    try {
      writeFileSync( join( dir, 'ok.py' ), 'print(1)\n' );
      assert.equal( PG.inspectScriptExecution( { scriptPath: join( dir, 'ok.py' ), args: [ '--section', 'service', 'skill' ], scriptsBase: dir } ).allowed, true );
      assert.equal( PG.inspectScriptExecution( { scriptPath: join( dir, 'ok.py' ), args: [ 'kill -9 1' ], scriptsBase: dir } ).allowed, false );
    } finally {
      rmSync( dir, { recursive: true, force: true } );
    }
  } );

  test( 'the runtime boot file and the static layer refuse the same binaries', () => {
    const py = readFileSync( PG.PROC_GUARD_BOOT, 'utf8' );
    const block = /REFUSED_BINARIES = \(([\s\S]*?)\)/.exec( py )[ 1 ];
    const names = [ ...block.matchAll( /"([^"]+)"/g ) ].map( ( m ) => m[ 1 ] ).sort();
    assert.deepEqual( names, [ ...PG.REFUSED_BINARIES ].sort() );
  } );
} );

// ── C-GUARD-SITES-DERIVED ────────────────────────────────────────────────────

const PROC_CALL = /(?<![.\w$])(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork)\s*\(|(process\.kill)\s*\(|\b([A-Za-z_$][\w$]*\.kill)\s*\(/g;

describe( 'C-GUARD-SITES-DERIVED: the guarded call-site set is produced by a scan', () => {
  const files = jsFiles( SRC, [ '.' ], ( r ) => ! /(^|\/)tests?\//.test( r ) && ! r.endsWith( '.test.js' ) );
  const sites = findCalls( SRC, files, PROC_CALL );
  const key = ( s ) => `${ s.file }|${ s.callee }|${ s.anchor }`;
  const registry = PG.GUARDED_SITES;
  const regKeys = new Set( registry.map( ( r ) => `${ r.file }|${ r.callee }|${ r.anchor }` ) );

  test( 'every process-control call site found by the scan is registered (scan -> registry)', () => {
    const missing = sites.filter( ( s ) => ! regKeys.has( key( s ) ) ).map( ( s ) => `${ key( s ) } (line ${ s.line })` );
    assert.deepEqual( missing, [], 'unregistered process-control call site(s)' );
  } );

  test( 'every registered site still exists at source (registry -> scan)', () => {
    const found = new Set( sites.map( key ) );
    const stale = registry.filter( ( r ) => ! found.has( `${ r.file }|${ r.callee }|${ r.anchor }` ) ).map( ( r ) => r.id );
    assert.deepEqual( stale, [] );
  } );

  test( 'every launch site calls assertLaunchAllowed with its own id before it spawns', () => {
    const bad = [];
    for ( const s of sites ) {
      const reg = registry.find( ( r ) => `${ r.file }|${ r.callee }|${ r.anchor }` === key( s ) );
      if ( ! reg || reg.kind !== 'launch' ) continue;
      const { src } = readBlanked( SRC, s.file );
      const window = src.slice( Math.max( 0, s.index - 1500 ), s.index );
      const calls = [ ...window.matchAll( /assertLaunchAllowed\(\s*['"]([\w.]+)['"]/g ) ];
      if ( ! calls.length || calls.at( -1 )[ 1 ] !== reg.id ) bad.push( `${ reg.id } at ${ s.file }:${ s.line }` );
    }
    assert.deepEqual( bad, [] );
  } );

  test( 'the scan is not vacuous: it finds script_execute\'s spawn', () => {
    assert.ok( sites.some( ( s ) => s.file === 'tools/script-execute.js' && s.callee === 'spawnSync' ) );
  } );
} );
