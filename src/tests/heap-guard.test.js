/**
 * src/tests/heap-guard.test.js
 *
 * Connector v13.23.0.
 *
 * ── The incident ─────────────────────────────────────────────────────────
 *
 *     07:34:26  process start
 *     07:34:32  [/tool-call] dispatching: module_write
 *     07:34:32  [module_write] Overwriting existing file (force=true confirmed)
 *     07:36:07  FATAL ERROR: Reached heap limit          (uptime 100,404 ms)
 *
 * 4.9 GB in 95 seconds, no other tool call in the window, four crashes in six
 * minutes as the caller retried into a process that kept dying. Every attempt
 * surfaced as a bare 502.
 *
 * These tests cover the CONTAINMENT, not the cause. The allocation site is
 * still unidentified and this file does not pretend otherwise -- the guard's
 * job is to make sure that whichever bug it is, present or future, cannot take
 * the process down with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkHeapBeforeTool, heapRefusalResult, heapGuardHealth, heapUsage,
} from '../utils/heap-guard.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );

/** Run a body with environment overrides, restoring afterwards. */
function withEnv( vars, body ) {
  const saved = {};
  for ( const [ k, v ] of Object.entries( vars ) ) {
    saved[ k ] = process.env[ k ];
    if ( undefined === v ) delete process.env[ k ];
    else process.env[ k ] = String( v );
  }
  try { return body(); }
  finally {
    for ( const [ k, v ] of Object.entries( saved ) ) {
      if ( undefined === v ) delete process.env[ k ];
      else process.env[ k ] = v;
    }
  }
}

test( 'heap usage is measured against the limit V8 will enforce', () => {
  // Not against container memory: V8 may be willing to use far less than the
  // container has, and comparing against the container would report plenty of
  // room right up until the process aborted.
  const usage = heapUsage();
  assert.ok( usage.limit > 0 );
  assert.ok( usage.used > 0 && usage.used <= usage.limit );
  assert.ok( usage.fraction > 0 && usage.fraction <= 1 );
} );

test( 'a normal call proceeds', () => {
  assert.equal( checkHeapBeforeTool( 'module_write' ).allow, true );
} );

test( 'a call under memory pressure is refused, not crashed into', () => {
  withEnv( { HEAP_GUARD_REFUSE_ABOVE: '0.0001' }, () => {
    const verdict = checkHeapBeforeTool( 'module_write' );
    assert.equal( verdict.allow, false );
    assert.equal( verdict.reason, 'memory_pressure' );
    assert.match( verdict.message, /memory limit/ );
  } );
} );

test( 'diagnostics still run under pressure', () => {
  // A guard that blocks the tools used to diagnose it is a guard that gets
  // switched off during the next incident.
  withEnv( { HEAP_GUARD_REFUSE_ABOVE: '0.0001' }, () => {
    for ( const tool of [ 'self_state_read', 'skill_read', 'memory_search' ] ) {
      assert.equal( checkHeapBeforeTool( tool ).allow, true, tool );
    }
  } );
} );

test( 'thresholds are read at call time, not captured at import', () => {
  // A threshold fixed at module load cannot be changed without a restart --
  // and a restart is exactly what an operator is least able to do when the
  // reason they are reaching for the setting is a process under pressure.
  withEnv( { HEAP_GUARD_REFUSE_ABOVE: '0.0001' }, () => {
    assert.equal( checkHeapBeforeTool( 'module_write' ).allow, false );
  } );
  assert.equal( checkHeapBeforeTool( 'module_write' ).allow, true,
    'the threshold must revert when the environment does' );
} );

test( 'the guard can be switched off entirely', () => {
  withEnv( { HEAP_GUARD_ENABLED: 'false', HEAP_GUARD_REFUSE_ABOVE: '0.0001' }, () => {
    assert.equal( checkHeapBeforeTool( 'module_write' ).allow, true );
  } );
} );

test( 'a refusal is an ANSWER, not an exception', () => {
  // A throw becomes a 500, which is barely more informative than the 502 this
  // exists to prevent -- and the caller cannot tell a refusal from a crash.
  withEnv( { HEAP_GUARD_REFUSE_ABOVE: '0.0001' }, () => {
    const verdict = checkHeapBeforeTool( 'module_write' );
    const result = heapRefusalResult( 'module_write', verdict );

    assert.equal( result.isError, true );
    const body = JSON.parse( result.content[ 0 ].text );
    assert.equal( body.error, 'memory_pressure' );
    assert.equal( body.tool, 'module_write' );
    // The caller must be told not to hammer it: retrying into a dying process
    // is what turned one bug into four crashes.
    assert.equal( body.retry, 'not_immediately' );
    assert.ok( body.heap_used_mb > 0 && body.heap_limit_mb > 0 );
  } );
} );

test( 'the guard sits at the single tool dispatch choke point', () => {
  // Every tool passes through dispatchToolCallCore. Guarding one handler would
  // leave the next unbounded allocation unprotected.
  const src = readFileSync( join( ROOT, 'src', 'server-http.js' ), 'utf8' );
  const at = src.indexOf( 'async function dispatchToolCallCore' );
  assert.ok( at > -1 );

  const head = src.slice( at, at + 1600 );
  assert.match( head, /const heap = checkHeapBeforeTool\(name\);/ );
  assert.match( head, /if \(!heap\.allow\) return heapRefusalResult\(name, heap\);/ );
} );

test( 'module_write has an upper bound on content', () => {
  // There was none -- only a non-empty check. A skill module is prose meant to
  // be read; the write survives any size, but everything downstream that
  // re-serialises the string does not.
  const src = readFileSync( join( ROOT, 'src', 'tools', 'skill-content.js' ), 'utf8' );
  assert.match( src, /MODULE_WRITE_MAX_CHARS/ );
  assert.match( src, /error: 'module_too_large'/ );

  // Checked BEFORE the empty-string guard, so an oversized payload is refused
  // before anything touches it.
  assert.ok( src.indexOf( 'module_too_large' )
    < src.indexOf( "typeof content !== 'string' || content.length === 0" ) );
} );

test( 'the start command bounds the heap and captures a snapshot', () => {
  // --heapsnapshot-near-heap-limit is the change that will actually find the
  // allocation. The crash output carried an EMPTY JS stack, so neither the log
  // nor reading the code identified it.
  const dockerfile = readFileSync( join( ROOT, 'Dockerfile' ), 'utf8' );
  assert.match( dockerfile, /--max-old-space-size=\$\{NODE_MAX_OLD_SPACE\}/ );
  assert.match( dockerfile, /--heapsnapshot-near-heap-limit=1/ );
  assert.match( dockerfile, /ENV NODE_MAX_OLD_SPACE=\d+/ );

  // exec, so node is PID 1 and receives the container's signals directly. A
  // bare `sh -c node ...` leaves the shell as PID 1 and swallows SIGTERM,
  // turning graceful shutdown into a kill.
  assert.match( dockerfile, /exec node /, 'node must replace the shell' );
} );

test( 'health reports the numbers an operator needs', () => {
  const health = heapGuardHealth();
  for ( const field of [ 'enabled', 'refuse_above', 'warn_above',
                         'heap_used_mb', 'heap_limit_mb', 'heap_fraction' ] ) {
    assert.ok( field in health, field );
  }
  assert.ok( 'number' === typeof health.stats.refusals );
} );

// ── Version reporting (v13.23.1) ───────────────────────────────────────────

test( 'no source file reports a hardcoded connector version', () => {
  // The startup banner said v12.28.0 while CONNECTOR_VERSION -- read from
  // package.json a thousand lines above, and used by /health and /version --
  // said something else. The banner is the line an operator reads to answer
  // "what is deployed", and during the module_write OOM it was taken as
  // evidence that recent work was not on the box, sending the diagnosis the
  // wrong way before the timestamps settled it.
  //
  // A second one was in the module_write User-Agent, so WordPress had been
  // logging these backups under the wrong build for a long time.
  const files = [
    join( ROOT, 'src', 'server-http.js' ),
    join( ROOT, 'src', 'tools', 'skill-content.js' ),
  ];

  for ( const file of files ) {
    // Comments legitimately name old versions when recording what changed --
    // asserting on the raw text matched this test's own rationale and aborted
    // the fix that introduced it.
    const code = readFileSync( file, 'utf8' ).split( '\n' )
      .filter( ( line ) => {
        const t = line.trim();
        return ! t.startsWith( '//' ) && ! t.startsWith( '*' ) && ! t.startsWith( '/*' );
      } )
      .join( '\n' );

    const literals = code.match( /claude-connector[/ ]v?\d+\.\d+\.\d+/g ) || [];
    assert.deepEqual( literals, [],
      `${ file } hardcodes a version: ${ literals.join( ', ' ) }. `
      + 'Read it from package.json instead -- two sources drift, and the one '
      + 'an operator reads is the one that misleads.' );
  }
} );

test( 'the banner and the User-Agent read the single source', () => {
  const server = readFileSync( join( ROOT, 'src', 'server-http.js' ), 'utf8' );
  assert.match( server, /claude-connector v\$\{CONNECTOR_VERSION\}/ );

  const content = readFileSync( join( ROOT, 'src', 'tools', 'skill-content.js' ), 'utf8' );
  assert.match( content, /function connectorVersion\(\)/ );
  assert.match( content, /claude-connector\/\$\{connectorVersion\(\)\}/ );
} );

test( 'the size cap would NOT have caught the reported module', () => {
  // Honesty, asserted. The module that crashed the process is 14.6 KB against a
  // 512 KB limit, so the cap is irrelevant to it: 14.6 KB becoming 4.9 GB is
  // ~330,000x amplification, which is algorithmic, not volumetric.
  //
  // The cap remains worth having -- an unbounded input on the path that crashed
  // is not something to leave in place -- but recording here that it is not the
  // fix stops a future reader concluding the incident is closed.
  const reported = 14.6 * 1024;
  const limit = parseInt( process.env.MODULE_WRITE_MAX_CHARS || '524288', 10 );

  assert.ok( reported < limit,
    'the reported module is well under the cap; the cap did not and could not '
    + 'have prevented this OOM' );
} );
