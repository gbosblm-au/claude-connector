// src/tests/internal-config-custom-env.test.js  v1.0.0
// ---------------------------------------------------------------------------
// v12.37.0 -- custom_env injection and the internal config bridge.
//
// Two features that are only safe together, so they are tested together:
//
//   1. GET|POST /internal/config/env publishes a code-bounded set of runtime
//      values to a caller holding X-Railway-Restore-Token.
//   2. script_execute accepts those values back as `custom_env` and injects
//      them into the spawned Python process.
//
// The hazard both introduce is a re-run of TNX-C-004. The obvious
// implementation of (2) is `{ ...process.env, ...input.custom_env }`, which is
// the exact idiom the v12.28.0 remediation removed from five modules. The
// second-most-obvious is `Object.assign(env, input.custom_env)` on top of the
// allowlisted base, which does not leak the connector's environment but does
// let a caller set PYTHONSTARTUP, PYTHONPATH or LD_PRELOAD and thereby execute
// code of their choosing inside the sandbox.
//
// These tests exist so that neither shortcut can be reintroduced silently.
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// custom_env sanitisation
// ---------------------------------------------------------------------------

describe( 'v12.37.0: custom_env is name-allowlisted, not passed through', () => {
  let savedKeys;

  before( () => {
    savedKeys = process.env.SCRIPT_CUSTOM_ENV_KEYS;
    delete process.env.SCRIPT_CUSTOM_ENV_KEYS;   // exercise the default list
  } );

  after( () => {
    if ( savedKeys === undefined ) delete process.env.SCRIPT_CUSTOM_ENV_KEYS;
    else process.env.SCRIPT_CUSTOM_ENV_KEYS = savedKeys;
  } );

  test( 'the intended variables are accepted', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    const { env, rejected } = sanitizeCustomEnv( {
      CONNECTOR_URL: 'https://connector.example.com',
      DATABASE_URL:  'postgres://u:p@host:5432/db',
    } );

    assert.deepEqual( rejected, [] );
    assert.equal( env.CONNECTOR_URL, 'https://connector.example.com' );
    assert.equal( env.DATABASE_URL, 'postgres://u:p@host:5432/db' );
  } );

  test( 'DOCUMENT_DOWNLOAD_TOKEN is not accepted by default', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    // A script never needs the download token. The connector builds the URL
    // after the script exits, so routing the token through the caller and back
    // would put a long-lived shared credential into a model context for no gain.
    const { env, rejected } = sanitizeCustomEnv( { DOCUMENT_DOWNLOAD_TOKEN: 'tok_abc123' } );

    assert.equal( env.DOCUMENT_DOWNLOAD_TOKEN, undefined );
    assert.equal( rejected.length, 1 );
  } );

  test( 'interpreter and loader hijack names are refused', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    // Every one of these is remote code execution inside the sandbox if it is
    // honoured. PYTHONSTARTUP and PYTHONPATH are the ones a naive
    // Object.assign implementation would let straight through, because the
    // pre-existing PROTECTED set in scriptEnv.js did not cover them.
    const hostile = [
      'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONEXECUTABLE',
      'PYTHONUSERBASE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
      'PATH', 'HOME', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'IFS',
    ];

    for ( const name of hostile ) {
      const { env, rejected } = sanitizeCustomEnv( { [ name ]: '/tmp/evil' } );
      assert.equal( env[ name ], undefined, `${ name } must be refused` );
      assert.equal( rejected.length, 1, `${ name } must be reported as refused` );
    }
  } );

  test( 'malformed names are refused before the allowlist is consulted', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    const malformed = [ 'lower_case', '1LEADING_DIGIT', 'HAS-DASH', 'HAS SPACE', '', 'A'.repeat( 65 ) ];

    for ( const name of malformed ) {
      const { env, rejected } = sanitizeCustomEnv( { [ name ]: 'x' } );
      assert.equal( Object.keys( env ).length, 0, `${ JSON.stringify( name ) } must be refused` );
      assert.equal( rejected.length, 1 );
      assert.match( rejected[ 0 ], /not a valid environment variable name/ );
    }
  } );

  test( 'non-string values are refused', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    for ( const value of [ 42, true, null, { a: 1 }, [ 'x' ] ] ) {
      const { env, rejected } = sanitizeCustomEnv( { CONNECTOR_URL: value } );
      assert.equal( env.CONNECTOR_URL, undefined, `${ JSON.stringify( value ) } must be refused` );
      assert.equal( rejected.length, 1 );
    }
  } );

  test( 'a NUL byte in a value is refused', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    // A NUL truncates the variable at the execve boundary, so the child would
    // see a different value from the one that was validated here.
    const { env, rejected } = sanitizeCustomEnv( { CONNECTOR_URL: 'https://a.example\0evil' } );
    assert.equal( env.CONNECTOR_URL, undefined );
    assert.match( rejected[ 0 ], /NUL byte/ );
  } );

  test( 'over-long values and over-wide objects are refused', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    const long = sanitizeCustomEnv( { CONNECTOR_URL: 'x'.repeat( 4097 ) } );
    assert.equal( long.env.CONNECTOR_URL, undefined );
    assert.match( long.rejected[ 0 ], /maximum is 4096/ );

    /** @type {Record<string,string>} */
    const wide = {};
    for ( let i = 0; i < 17; i += 1 ) wide[ `KEY_${ i }` ] = 'v';
    const wideResult = sanitizeCustomEnv( wide );
    assert.equal( Object.keys( wideResult.env ).length, 0 );
    assert.match( wideResult.rejected[ 0 ], /maximum is 16/ );
  } );

  test( 'non-object custom_env is refused rather than coerced', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    for ( const bad of [ 'CONNECTOR_URL=x', 42, true, [ 'CONNECTOR_URL' ] ] ) {
      const { env, rejected } = sanitizeCustomEnv( bad );
      assert.equal( Object.keys( env ).length, 0 );
      assert.equal( rejected.length, 1 );
    }
  } );

  test( 'absent custom_env produces an empty result with no complaint', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    for ( const nothing of [ undefined, null ] ) {
      const { env, rejected } = sanitizeCustomEnv( nothing );
      assert.deepEqual( env, {} );
      assert.deepEqual( rejected, [] );
    }
  } );

  test( 'SCRIPT_CUSTOM_ENV_KEYS narrows the allowlist and cannot widen it to a hijack name', async () => {
    const { sanitizeCustomEnv } = await import( '../tools/script-execute.js' );

    process.env.SCRIPT_CUSTOM_ENV_KEYS = 'CONNECTOR_URL';

    const narrowed = sanitizeCustomEnv( {
      CONNECTOR_URL: 'https://a.example',
      DATABASE_URL:  'postgres://u:p@h/db',
    } );  // SCRIPT_CUSTOM_ENV_KEYS is set to CONNECTOR_URL only, above
    assert.equal( narrowed.env.CONNECTOR_URL, 'https://a.example' );
    assert.equal( narrowed.env.DATABASE_URL, undefined, 'a name outside the configured list is refused' );

    // An operator can name PYTHONSTARTUP here, but scriptEnv.js still refuses
    // it, so the two filters have to fail together for a hijack to land.
    process.env.SCRIPT_CUSTOM_ENV_KEYS = 'PYTHONSTARTUP';
    const widened = sanitizeCustomEnv( { PYTHONSTARTUP: '/tmp/evil.py' } );

    const { buildScriptEnv } = await import( '../utils/scriptEnv.js' );
    const finalEnv = buildScriptEnv( { scriptKey: 'x.py', extra: widened.env } );
    assert.equal( finalEnv.PYTHONSTARTUP, undefined,
      'scriptEnv.js PROTECTED is the second, independent filter' );

    delete process.env.SCRIPT_CUSTOM_ENV_KEYS;
  } );
} );

// ---------------------------------------------------------------------------
// The spawned environment
// ---------------------------------------------------------------------------

describe( 'v12.37.0: custom_env reaches the child without reopening TNX-C-004', () => {
  const SENTINEL_NAMES = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLIENT_SECRET',
    'SLACK_BOT_TOKEN', 'WP_APP_PASSWORD', 'MEMORY_AUTH_TOKEN',
    'RAILWAY_RESTORE_TOKEN', 'MCP_API_KEY', 'DATABASE_URL',
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

  test( 'the three-argument wrapper injects extras and still leaks nothing', async () => {
    const { buildScriptEnv } = await import( '../tools/script-execute.js' );

    // DATABASE_URL is deliberately supplied as a caller value that differs from
    // the process-environment sentinel. The child must see the caller's value,
    // which proves the variable arrived through custom_env and not through
    // environment inheritance.
    const env = buildScriptEnv( '/tmp/out', 'report.py', {
      CONNECTOR_URL: 'https://connector.example.com',
      DATABASE_URL:  'postgres://caller-supplied/db',
    } );

    assert.equal( env.CONNECTOR_URL, 'https://connector.example.com' );
    assert.equal( env.DATABASE_URL, 'postgres://caller-supplied/db' );

    for ( const [ key, value ] of Object.entries( env ) ) {
      assert.equal( String( value ).startsWith( 'sentinel-' ), false,
        `${ key } leaked a process-environment secret` );
    }
  } );

  test( 'the two-argument call signature is unchanged', async () => {
    const { buildScriptEnv } = await import( '../tools/script-execute.js' );

    // Back-compat guard. phase0-security.test.js and any external caller use
    // the two-argument form; the third parameter must be purely additive.
    const env = buildScriptEnv( '/tmp/out-dir', 'report.py' );

    assert.equal( env.PATH, '/usr/local/bin:/usr/bin:/bin' );
    assert.equal( env.HOME, '/tmp' );
    assert.equal( env.PYTHONUNBUFFERED, '1' );
    assert.equal( env.SCRIPT_OUTPUT_DIR, '/tmp/out-dir' );
    assert.equal( env.DATABASE_URL, undefined );
  } );

  test( 'script-execute.js does not contain the spread idiom', async () => {
    const { readFileSync } = await import( 'node:fs' );
    const { join, dirname }  = await import( 'node:path' );
    const { fileURLToPath }  = await import( 'node:url' );

    const file  = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'tools', 'script-execute.js' );
    const lines = readFileSync( file, 'utf8' ).split( '\n' );

    const offenders = [];
    lines.forEach( ( line, i ) => {
      const stripped = line.trim();
      if ( stripped.startsWith( '//' ) || stripped.startsWith( '*' ) ) return;
      if ( stripped.includes( '...process.env' ) ) offenders.push( i + 1 );
    } );

    assert.deepEqual( offenders, [],
      'the custom_env feature must not reintroduce process.env inheritance' );
  } );
} );

// ---------------------------------------------------------------------------
// Internal config bridge
// ---------------------------------------------------------------------------

describe( 'v12.37.0: /internal/config/env', () => {
  test( 'the route is exempt from the MCP key gate', async () => {
    const { isSelfAuthenticatedPath, isPublicPath } = await import( '../middleware/mcpAuth.js' );

    assert.equal( isSelfAuthenticatedPath( '/internal/config/env' ), true,
      'the gateway holds the restore token, not MCP_API_KEY, so the route must be exempt' );
    assert.equal( isPublicPath( '/internal/config/env' ), false,
      'exempt from the MCP key is not the same as public' );
  } );

  test( 'no sibling path under /internal is exempted by accident', async () => {
    const { isSelfAuthenticatedPath, isPublicPath } = await import( '../middleware/mcpAuth.js' );

    // The allowlist entry is `exact`, not `prefix`. A prefix entry here would
    // exempt every future /internal/* route from authentication by default,
    // which is the failure mode TNX-C-001 was about.
    for ( const p of [ '/internal', '/internal/config', '/internal/config/env/extra', '/internal/config/envx' ] ) {
      assert.equal( isSelfAuthenticatedPath( p ), false, `${ p } must not be exempt` );
      assert.equal( isPublicPath( p ), false, `${ p } must not be public` );
    }
  } );

  test( 'a request with no token is refused', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );
    const { makeRes } = await import( './helpers/mockRes.js' );

    const handler = createInternalConfigHandler( {
      getRestoreToken:    () => 'the-real-restore-token-0123456789',
      constantTimeEquals: ( a, b ) => a.length > 0 && a === b,
    } );

    const res = makeRes();
    handler( { headers: {} }, res );

    assert.equal( res.statusCode, 401 );
    assert.equal( res.body.error, 'Invalid or missing X-Railway-Restore-Token.' );
    assert.equal( JSON.stringify( res.body ).includes( 'the-real-restore-token' ), false,
      'the error must not echo the expected token' );
  } );

  test( 'a wrong token of the same length is refused', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );
    const { makeRes } = await import( './helpers/mockRes.js' );

    const real    = 'the-real-restore-token-0123456789';
    const handler = createInternalConfigHandler( {
      getRestoreToken:    () => real,
      constantTimeEquals: ( a, b ) => a.length > 0 && a === b,
    } );

    const res = makeRes();
    handler( { headers: { 'x-railway-restore-token': 'x'.repeat( real.length ) } }, res );

    assert.equal( res.statusCode, 401 );
  } );

  test( 'an unconfigured restore token yields 503, never an open endpoint', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );
    const { makeRes } = await import( './helpers/mockRes.js' );

    const handler = createInternalConfigHandler( {
      getRestoreToken:    () => '',
      constantTimeEquals: () => true,   // would pass; must never be reached
    } );

    const res = makeRes();
    handler( { headers: {} }, res );

    assert.equal( res.statusCode, 503 );
    assert.equal( res.body.CONNECTOR_URL, undefined );
  } );

  test( 'a correct token returns CONNECTOR_URL with no-store headers', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );
    const { makeRes } = await import( './helpers/mockRes.js' );

    const savedUrl  = process.env.CONNECTOR_URL;
    const savedKeys = process.env.INTERNAL_CONFIG_KEYS;
    process.env.CONNECTOR_URL = 'https://connector.example.com';
    delete process.env.INTERNAL_CONFIG_KEYS;

    const real    = 'the-real-restore-token-0123456789';
    const handler = createInternalConfigHandler( {
      getRestoreToken:    () => real,
      constantTimeEquals: ( a, b ) => a.length > 0 && a === b,
    } );

    const res = makeRes();
    handler( { headers: { 'x-railway-restore-token': real } }, res );

    assert.equal( res.statusCode, 200 );
    assert.equal( res.body.CONNECTOR_URL, 'https://connector.example.com' );
    assert.match( res.headers[ 'Cache-Control' ], /no-store/ );
    assert.equal( res.headers[ 'Referrer-Policy' ], 'no-referrer' );

    if ( savedUrl === undefined ) delete process.env.CONNECTOR_URL;
    else process.env.CONNECTOR_URL = savedUrl;
    if ( savedKeys !== undefined ) process.env.INTERNAL_CONFIG_KEYS = savedKeys;
  } );

  test( 'secrets are withheld by default and only published when named', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );
    const { makeRes } = await import( './helpers/mockRes.js' );

    const saved = {
      CONNECTOR_URL:           process.env.CONNECTOR_URL,
      DOCUMENT_DOWNLOAD_TOKEN: process.env.DOCUMENT_DOWNLOAD_TOKEN,
      DATABASE_URL:            process.env.DATABASE_URL,
      INTERNAL_CONFIG_KEYS:    process.env.INTERNAL_CONFIG_KEYS,
    };

    process.env.CONNECTOR_URL           = 'https://connector.example.com';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'doc-token';
    process.env.DATABASE_URL            = 'postgres://u:p@h/db';
    delete process.env.INTERNAL_CONFIG_KEYS;

    const real    = 'the-real-restore-token-0123456789';
    const handler = createInternalConfigHandler( {
      getRestoreToken:    () => real,
      constantTimeEquals: ( a, b ) => a.length > 0 && a === b,
    } );

    let res = makeRes();
    handler( { headers: { 'x-railway-restore-token': real } }, res );

    assert.equal( res.body.CONNECTOR_URL, 'https://connector.example.com' );
    assert.equal( res.body.DOCUMENT_DOWNLOAD_TOKEN, undefined,
      'the download token must not be published unless explicitly named' );
    assert.equal( res.body.DATABASE_URL, undefined,
      'the database DSN must not be published unless explicitly named' );

    process.env.INTERNAL_CONFIG_KEYS = 'CONNECTOR_URL,DOCUMENT_DOWNLOAD_TOKEN,DATABASE_URL';
    res = makeRes();
    handler( { headers: { 'x-railway-restore-token': real } }, res );

    assert.equal( res.body.DOCUMENT_DOWNLOAD_TOKEN, 'doc-token' );
    assert.equal( res.body.DATABASE_URL, 'postgres://u:p@h/db' );

    for ( const [ k, v ] of Object.entries( saved ) ) {
      if ( v === undefined ) delete process.env[ k ];
      else process.env[ k ] = v;
    }
  } );

  test( 'INTERNAL_CONFIG_KEYS cannot publish a name outside the frozen ceiling', async () => {
    const { resolveInternalConfigKeys, INTERNAL_CONFIG_ALLOWED_KEYS } =
      await import( '../utils/internalConfig.js' );

    const saved = process.env.INTERNAL_CONFIG_KEYS;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-be-published';

    process.env.INTERNAL_CONFIG_KEYS = 'ANTHROPIC_API_KEY,MCP_API_KEY,RAILWAY_RESTORE_TOKEN,CONNECTOR_URL';
    assert.deepEqual( resolveInternalConfigKeys(), [ 'CONNECTOR_URL' ] );

    assert.throws( () => { INTERNAL_CONFIG_ALLOWED_KEYS.push( 'ANTHROPIC_API_KEY' ); },
      'the ceiling must be frozen so it cannot be widened at runtime' );

    if ( saved === undefined ) delete process.env.INTERNAL_CONFIG_KEYS;
    else process.env.INTERNAL_CONFIG_KEYS = saved;
    if ( savedKey === undefined ) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  } );

  test( 'the handler refuses to be constructed without its auth dependencies', async () => {
    const { createInternalConfigHandler } = await import( '../utils/internalConfig.js' );

    // Failing closed at construction is what makes "someone wired it up wrong"
    // a boot failure rather than an unauthenticated endpoint.
    assert.throws( () => createInternalConfigHandler( {} ) );
    assert.throws( () => createInternalConfigHandler( { getRestoreToken: () => 'x' } ) );
    assert.throws( () => createInternalConfigHandler( undefined ) );
  } );

  test( 'CONNECTOR_URL is read from the variable, with a platform fallback', async () => {
    const { resolveInternalConfigValue } = await import( '../utils/internalConfig.js' );

    const saved = { c: process.env.CONNECTOR_URL, d: process.env.RAILWAY_PUBLIC_DOMAIN };

    process.env.CONNECTOR_URL = 'https://set-explicitly.example.com';
    assert.equal( resolveInternalConfigValue( 'CONNECTOR_URL' ), 'https://set-explicitly.example.com' );

    delete process.env.CONNECTOR_URL;
    process.env.RAILWAY_PUBLIC_DOMAIN = 'platform.example.com';
    assert.equal( resolveInternalConfigValue( 'CONNECTOR_URL' ), 'https://platform.example.com' );

    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    assert.equal( resolveInternalConfigValue( 'CONNECTOR_URL' ), '' );

    if ( saved.c === undefined ) delete process.env.CONNECTOR_URL; else process.env.CONNECTOR_URL = saved.c;
    if ( saved.d === undefined ) delete process.env.RAILWAY_PUBLIC_DOMAIN; else process.env.RAILWAY_PUBLIC_DOMAIN = saved.d;
  } );
} );

// ---------------------------------------------------------------------------
// Download links
// ---------------------------------------------------------------------------

describe( 'v12.37.0: the connector builds download links, the model does not', () => {
  const saved = {};
  const KEYS  = [ 'CONNECTOR_URL', 'DOCUMENT_DOWNLOAD_TOKEN', 'RAILWAY_PUBLIC_DOMAIN', 'DOWNLOADS_DIR' ];

  before( async () => {
    for ( const k of KEYS ) saved[ k ] = process.env[ k ];
  } );

  after( () => {
    for ( const k of KEYS ) {
      if ( saved[ k ] === undefined ) delete process.env[ k ];
      else process.env[ k ] = saved[ k ];
    }
  } );

  test( 'a trailing slash on CONNECTOR_URL does not produce a double slash', async () => {
    const { connectorBaseUrl } = await import( '../utils/downloadLinks.js' );

    process.env.CONNECTOR_URL = 'https://connector.example.com/';
    assert.equal( connectorBaseUrl(), 'https://connector.example.com' );

    process.env.CONNECTOR_URL = 'https://connector.example.com///';
    assert.equal( connectorBaseUrl(), 'https://connector.example.com' );
  } );

  test( 'a scheme-less CONNECTOR_URL is upgraded to https', async () => {
    const { connectorBaseUrl } = await import( '../utils/downloadLinks.js' );

    process.env.CONNECTOR_URL = 'connector.example.com';
    assert.equal( connectorBaseUrl(), 'https://connector.example.com' );

    process.env.CONNECTOR_URL = '  https://connector.example.com  ';
    assert.equal( connectorBaseUrl(), 'https://connector.example.com' );
  } );

  test( 'an unset CONNECTOR_URL falls back to the platform hostname', async () => {
    const { connectorBaseUrl } = await import( '../utils/downloadLinks.js' );

    delete process.env.CONNECTOR_URL;
    process.env.RAILWAY_PUBLIC_DOMAIN = 'fallback.example.com';
    assert.equal( connectorBaseUrl(), 'https://fallback.example.com' );

    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    assert.equal( connectorBaseUrl(), '', 'no source configured must yield empty, not "undefined"' );
  } );

  test( 'links carry DOCUMENT_DOWNLOAD_TOKEN and never RAILWAY_RESTORE_TOKEN', async () => {
    const { mkdtempSync, writeFileSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const { join }   = await import( 'node:path' );

    const dir = mkdtempSync( join( tmpdir(), 'dl-test-' ) );
    process.env.DOWNLOADS_DIR           = dir;
    process.env.CONNECTOR_URL           = 'https://connector.example.com';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'doc-token';
    process.env.RAILWAY_RESTORE_TOKEN   = 'restore-token-full-connector-control';

    const { buildDownloadLinks, snapshotDownloads } = await import(
      `../utils/downloadLinks.js?dl=${ Date.now() }` );

    const before = snapshotDownloads();
    writeFileSync( join( dir, 'Report.docx' ), 'x' );

    const { links } = buildDownloadLinks( { before } );

    assert.equal( links.length, 1 );
    assert.equal( links[ 0 ].download_url,
      'https://connector.example.com/download/Report.docx?token=doc-token' );
    assert.equal( links[ 0 ].preview_url,
      'https://connector.example.com/preview/Report.docx?token=doc-token' );

    // GET /download accepts either token. The restore token also authenticates
    // /tool-call and every /restore-* route, so a link carrying it would turn a
    // shared URL into full connector control.
    assert.equal( JSON.stringify( links ).includes( 'restore-token-full-connector-control' ), false );
  } );

  test( 'a token containing URL-significant characters is encoded', async () => {
    const { mkdtempSync, writeFileSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const { join }   = await import( 'node:path' );

    const dir = mkdtempSync( join( tmpdir(), 'dl-enc-' ) );
    process.env.DOWNLOADS_DIR           = dir;
    process.env.CONNECTOR_URL           = 'https://c.example';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 'a/b+c=d e&f';

    const { buildDownloadLinks, snapshotDownloads } = await import(
      `../utils/downloadLinks.js?enc=${ Date.now() }` );

    const before = snapshotDownloads();
    writeFileSync( join( dir, 'Doc.pdf' ), 'x' );

    const { links } = buildDownloadLinks( { before } );

    assert.equal( links[ 0 ].download_url,
      'https://c.example/download/Doc.pdf?token=a%2Fb%2Bc%3Dd%20e%26f' );
    assert.equal( links[ 0 ].preview_url, undefined, '.pdf is not previewable' );
  } );

  test( 'declared filenames are validated and traversal is refused', async () => {
    const { mkdtempSync, writeFileSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const { join }   = await import( 'node:path' );

    const dir = mkdtempSync( join( tmpdir(), 'dl-trav-' ) );
    process.env.DOWNLOADS_DIR           = dir;
    process.env.CONNECTOR_URL           = 'https://c.example';
    process.env.DOCUMENT_DOWNLOAD_TOKEN = 't';
    writeFileSync( join( dir, 'Real.docx' ), 'x' );

    const { buildDownloadLinks, snapshotDownloads } = await import(
      `../utils/downloadLinks.js?trav=${ Date.now() }` );

    // `before` taken AFTER the write, so nothing is detected by diff and only
    // the declared names are under test.
    const before = snapshotDownloads();

    const { links, warnings } = buildDownloadLinks( {
      before,
      declared: [ '../../etc/passwd', '/etc/passwd', 'Missing.docx', 'Real.docx' ],
    } );

    assert.deepEqual( links.map( ( l ) => l.filename ), [ 'Real.docx' ] );
    assert.equal( warnings.length, 3, 'each refused name must be reported, not dropped silently' );
  } );

  test( 'a missing downloads directory yields no links and no throw', async () => {
    process.env.DOWNLOADS_DIR = '/tmp/definitely-not-a-real-directory-4f2a';
    process.env.CONNECTOR_URL = 'https://c.example';

    const { buildDownloadLinks, snapshotDownloads } = await import(
      `../utils/downloadLinks.js?missing=${ Date.now() }` );

    const { links, warnings } = buildDownloadLinks( { before: snapshotDownloads() } );
    assert.deepEqual( links, [] );
    assert.deepEqual( warnings, [] );
  } );

  test( 'an unconfigured token is reported rather than producing a tokenless link', async () => {
    const { mkdtempSync, writeFileSync } = await import( 'node:fs' );
    const { tmpdir } = await import( 'node:os' );
    const { join }   = await import( 'node:path' );

    const dir = mkdtempSync( join( tmpdir(), 'dl-notok-' ) );
    process.env.DOWNLOADS_DIR = dir;
    process.env.CONNECTOR_URL = 'https://c.example';
    delete process.env.DOCUMENT_DOWNLOAD_TOKEN;

    const { buildDownloadLinks, snapshotDownloads } = await import(
      `../utils/downloadLinks.js?notok=${ Date.now() }` );

    const before = snapshotDownloads();
    writeFileSync( join( dir, 'A.docx' ), 'x' );

    const { links, warnings } = buildDownloadLinks( { before } );

    // A link without a token 401s. Emitting one would look like success and
    // fail only when the user clicks it.
    assert.deepEqual( links, [] );
    assert.equal( warnings.length, 1 );
    assert.match( warnings[ 0 ], /DOCUMENT_DOWNLOAD_TOKEN is not set/ );
  } );
} );
