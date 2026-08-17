// src/middleware/mcpAuth.js  v1.0.0
// ---------------------------------------------------------------------------
// Connector-wide authentication gate.
//
// Remediates TNX-C-001 (audit TNX-AUDIT-2026-08): the MCP transports `/sse`,
// `/messages` and `/mcp` read no credential of any kind, so anyone able to
// resolve the connector hostname obtained the entire tool surface -- Google
// Drive, WordPress publishing, SMTP dispatch, arbitrary Python execution and
// the persistent memory store.
//
// Design
// ------
// 1. Deny by default. Every route is authenticated unless it appears on the
//    PUBLIC_ROUTES allowlist below, and every entry on that list carries a
//    written justification.
//
// 2. Fail closed at boot. `assertConfigured()` throws when MCP_API_KEY is
//    absent or too short. server-http.js calls it before binding the listener
//    and exits non-zero. A connector that starts without a key is the defect,
//    so there is deliberately no environment variable that disables this.
//
// 3. Constant-time comparison. `crypto.timingSafeEqual` over SHA-256 digests
//    of the two values. Hashing first gives both buffers a fixed 32-byte
//    length, which is required because timingSafeEqual throws on a length
//    mismatch -- and that throw would itself be an oracle for the key length.
//
// 4. Route-coverage assertion. `assertAllRoutesCovered(app)` walks the Express
//    router stack after every route is registered and fails the boot if any
//    registered path is neither protected by this middleware nor explicitly
//    public. The defect class here is not "someone forgot a check", it is
//    "nothing verifies that checks exist", so the verification is the fix.
// ---------------------------------------------------------------------------

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Minimum acceptable key length. 32 characters of a hex or base64url alphabet
 * is roughly 128 bits of entropy, which is the floor for a bearer credential
 * that guards remote code execution.
 */
const MIN_KEY_LENGTH = 32;

/**
 * Routes reachable without MCP_API_KEY, each with the control that replaces it.
 *
 * `exact`  matches req.path exactly.
 * `prefix` matches req.path.startsWith(value). Used only for parameterised
 *          routes, and every prefix entry enforces its own token internally.
 */
const PUBLIC_ROUTES = [
  // Liveness probe. Must answer before any credential is available to the
  // orchestrator. Reports status only; see TNX-M-004 for the payload
  // reduction that removes provider enumeration from this response.
  { exact: '/health' },
  // v12.28.0 (TNX-H-004): liveness and readiness are separate endpoints. Both
  // must answer before any credential is available to the orchestrator.
  // /health/live carries no configuration detail at all; /health/ready returns
  // only pass/fail per check to an unauthenticated caller and the full
  // integration inventory to an authenticated one.
  { exact: '/health/live' },
  { exact: '/health/ready' },

  // Public front-end self-discovery. Returns the connector's own public
  // hostname, which is already public by definition.
  { exact: '/api/config.js' },

  // Email tracking pixels and click redirects. Fetched by arbitrary mail
  // clients on behalf of recipients; a credential cannot be distributed to
  // them. Both handlers are read-mostly and never expose tool surface.
  { exact: '/track/open' },
  { exact: '/track/click' },

  // LinkedIn OAuth redirect target. LinkedIn performs this GET; it carries
  // the OAuth `state` parameter as its own CSRF control.
  { exact: '/auth/linkedin/callback' },

  // Inbound webhook receiver. Enforces X-Webhook-Secret internally.
  { exact: '/webhook' },

  // LinkedIn CSV import. Enforces X-Upload-Key / UPLOAD_API_KEY internally.
  { exact: '/upload/connections' },

  // Memory corpus export. Enforces its own MEMORY_AUTH_TOKEN bearer.
  { exact: '/memory/admin/dump' },

  // Document upload used by the browser chat surface. Enforces the upload
  // extension allowlist and denylist plus a size cap internally.
  //
  // RESIDUAL RISK, flagged for the platform owner: this endpoint is still
  // unauthenticated, because the browser cannot hold MCP_API_KEY without
  // disclosing it. The audit scoped only /data/upload-binary for removal
  // (TNX-C-003) and endorsed this handler's extension policy as the control.
  // The durable fix is a short-lived per-session upload token minted by the
  // Gateway Service; that is Phase 1 work, not Phase 0.
  { exact: '/data/upload' },

  // Document download and preview. Both enforce DOCUMENT_DOWNLOAD_TOKEN or
  // RAILWAY_RESTORE_TOKEN with a constant-time comparison, because the links
  // are opened directly by a browser that cannot set an Authorization header.
  { prefix: '/download/' },
  { prefix: '/preview/' },
];

/**
 * Routes that carry their own independent credential and are therefore exempt
 * from the MCP key, but which are NOT public. These still appear in the
 * coverage assertion as "covered", because a reviewer reading this file can
 * see which control applies.
 */
const SELF_AUTHENTICATED_ROUTES = [
  // ── X-Railway-Restore-Token ────────────────────────────────────────────
  //
  // Every route below verifies RAILWAY_RESTORE_TOKEN internally before doing
  // any work. They are exempt from MCP_API_KEY because the ts-client-gateway
  // WordPress plugin authenticates to them with that token and has no way to
  // hold the connector key.
  //
  // REGRESSION HISTORY (v12.31.0). v12.28.0 allowlisted only /tools and
  // /tool-call and missed the other twenty-one. The visible symptom was NOT a
  // clean 401: the plugin streams an 11 MB tar.gz to POST /volume-restore, this
  // gate rejected it the moment the headers arrived, and the server reset the
  // HTTP/2 stream while the body was still uploading. cURL reported
  // "error 92: HTTP/2 stream 1 was not closed cleanly: CANCEL" with no status
  // code, so connector snapshot restore failed after every deployment with an
  // error that pointed at the network rather than at authentication.
  //
  // The list is verified by a test that scans server-http.js and the route
  // modules for handlers reading x-railway-restore-token and asserts each one
  // appears here. Maintaining this by hand is what broke it the first time.
  { exact: '/tools' },
  { exact: '/tool-call' },

  // v12.37.0: internal config bridge. Publishes a fixed, code-bounded set of
  // runtime values (CONNECTOR_URL, DOCUMENT_DOWNLOAD_TOKEN, DATABASE_URL) to
  // the session orchestrator, which forwards them into script_execute as
  // custom_env. Verifies RAILWAY_RESTORE_TOKEN with constantTimeEquals()
  // before reading any variable, and returns 401 otherwise.
  //
  // Exempt from MCP_API_KEY for the same reason /tool-call is: the caller is
  // the gateway, which holds the restore token and has no way to hold the
  // connector key. Registered for both GET and POST; the path is identical.
  { exact: '/internal/config/env' },

  // Skill and content restore targets used by the plugin's provisioning and
  // Disaster Recovery pushes.
  { exact: '/restore-skill' },
  { exact: '/restore-books' },
  { exact: '/restore-profiles' },
  { exact: '/restore-modules' },
  { exact: '/restore-personality' },
  { exact: '/restore-dispatch-rules' },
  { exact: '/restore-archive' },
  { exact: '/restore-references' },
  { exact: '/restore-scripts' },

  // Whole-volume snapshot and restore. /volume-restore is the endpoint the
  // Connector Snapshots page posts its archive to.
  { exact: '/volume-snapshot' },
  { exact: '/volume-restore' },
  { exact: '/volume-snapshot/status' },

  // Modular mode, brain scan and skill compilation.
  { exact: '/set-modular-mode' },
  { exact: '/brain-data' },
  { exact: '/brain-data/status' },
  { exact: '/brain-scan' },
  { exact: '/skill-export' },
  { exact: '/ti-skill-compile' },
  { exact: '/ti-skill-check-scope' },

  // Connector provisioning. In owner mode this verifies RAILWAY_RESTORE_TOKEN
  // with a constant-time comparison; in tenant mode it validates the supplied
  // api_key against the Gateway Service. Either way it authenticates itself,
  // and the plugin's provisioning flow cannot present the connector key.
  //
  // NOTE: GET /export-all is deliberately NOT listed. It has no credential of
  // its own, so it correctly remains behind the MCP key.
  { exact: '/provision' },

  // ── Tenax Voice (v12.50.0) ─────────────────────────────────────────────
  //
  // The caller in production is the Gateway Service (routes/ti-voice.js). It
  // holds the per-tenant connector restore token, not MCP_API_KEY, so with
  // these three paths behind the MCP gate every gateway call was answered 401
  // before any voice code ran: /ti-voice/status reported
  // 'connector_unreachable' and the mic button never rendered, whatever
  // VOICE_ENABLED was set to.
  //
  // Exempt here, verified in src/voice/voice-auth.js, which accepts EITHER
  // MCP_API_KEY (the operator) or RAILWAY_RESTORE_TOKEN (the gateway) with a
  // constant-time comparison and 401s otherwise. Exactly the pattern the
  // /restore-* and /volume-* routes above already follow.
  //
  // Exemption from the MCP key is not exemption from the feature gate. Both
  // layers of voice-gate.js -- the VOICE_ENABLED master switch and the
  // per-user VOICE_TEST_USERS allowlist -- still run on every request, and
  // still answer 404 rather than 403 to anyone they refuse.
  //
  // These are `exact`, not a `/voice/` prefix. A prefix entry would exempt
  // every future /voice/* route from authentication by default, which is the
  // failure mode TNX-C-001 was about.
  { exact: '/voice/health' },
  { exact: '/voice/transcribe' },
  { exact: '/voice/synthesize' },
];

/** Cached digest of MCP_API_KEY. Populated by assertConfigured(). */
let _expectedDigest = null;

/**
 * Read the configured key from the environment.
 * Read lazily rather than at module load so tests can set it before boot.
 *
 * @returns {string} The raw key, or an empty string when unset.
 */
function readKey() {
  return ( process.env.MCP_API_KEY || '' ).trim();
}

/**
 * Validate configuration and cache the expected digest.
 *
 * Call this once at boot, BEFORE binding the HTTP listener.
 *
 * @throws {Error} When MCP_API_KEY is unset, too short, or an obvious placeholder.
 * @returns {void}
 */
export function assertConfigured() {
  const key = readKey();

  if ( ! key ) {
    throw new Error(
      'MCP_API_KEY is not set. The connector exposes remote code execution, ' +
      'Google Drive, WordPress publishing and SMTP dispatch, and will not start ' +
      'without an authentication key. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      'then set MCP_API_KEY in the deployment environment.'
    );
  }

  if ( key.length < MIN_KEY_LENGTH ) {
    throw new Error(
      `MCP_API_KEY is ${ key.length } characters. A minimum of ${ MIN_KEY_LENGTH } is required ` +
      'for a credential that guards remote code execution.'
    );
  }

  const placeholders = [ 'changeme', 'change-me', 'your-key-here', 'replace-me', 'secret', 'test' ];
  if ( placeholders.includes( key.toLowerCase() ) ) {
    throw new Error( 'MCP_API_KEY is a placeholder value. Set a real generated key.' );
  }

  _expectedDigest = createHash( 'sha256' ).update( key, 'utf8' ).digest();
}

/**
 * Constant-time bearer comparison.
 *
 * Both operands are hashed to a fixed 32 bytes before comparison so that
 * timingSafeEqual never throws on a length mismatch. A throw would leak the
 * expected key length through the difference between a 500 and a 401.
 *
 * @param {string} supplied Token presented by the caller.
 * @returns {boolean} True when the token matches the configured key.
 */
function tokenMatches( supplied ) {
  if ( ! _expectedDigest ) return false;
  if ( typeof supplied !== 'string' || supplied.length === 0 ) return false;

  const suppliedDigest = createHash( 'sha256' ).update( supplied, 'utf8' ).digest();
  return timingSafeEqual( suppliedDigest, _expectedDigest );
}

/**
 * Extract a bearer token from the request.
 *
 * Accepted carriers, in order of preference:
 *   Authorization: Bearer <key>   -- canonical
 *   X-MCP-Api-Key: <key>          -- for clients that cannot set Authorization
 *
 * The query string is deliberately NOT accepted. Query parameters appear in
 * access logs, proxy logs, browser history and the Referer header of any
 * outbound request the page makes.
 *
 * @param {import('express').Request} req
 * @returns {string} The presented token, or an empty string.
 */
function extractToken( req ) {
  const header = String( req.headers.authorization || '' ).trim();
  const match  = /^Bearer\s+(.+)$/i.exec( header );
  if ( match ) return match[ 1 ].trim();

  const alt = req.headers[ 'x-mcp-api-key' ];
  if ( typeof alt === 'string' && alt.trim() ) return alt.trim();

  return '';
}

/**
 * Test whether a request path is on the public allowlist.
 *
 * @param {string} pathname req.path
 * @returns {boolean}
 */
export function isPublicPath( pathname ) {
  const p = String( pathname || '' );
  return PUBLIC_ROUTES.some( ( r ) =>
    ( r.exact !== undefined && p === r.exact ) ||
    ( r.prefix !== undefined && p.startsWith( r.prefix ) )
  );
}

/**
 * Test whether a path carries its own independent credential.
 *
 * @param {string} pathname req.path
 * @returns {boolean}
 */
export function isSelfAuthenticatedPath( pathname ) {
  const p = String( pathname || '' );
  return SELF_AUTHENTICATED_ROUTES.some( ( r ) =>
    ( r.exact !== undefined && p === r.exact ) ||
    ( r.prefix !== undefined && p.startsWith( r.prefix ) )
  );
}

/**
 * Express middleware. Mount once, immediately after the CORS handler and
 * before every route.
 *
 * CORS preflight (OPTIONS) is answered by the CORS handler before this
 * middleware runs, so no OPTIONS special case is needed here.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Function}                   next
 * @returns {void}
 */
export function mcpAuthMiddleware( req, res, next ) {
  if ( isPublicPath( req.path ) || isSelfAuthenticatedPath( req.path ) ) {
    return next();
  }

  const supplied = extractToken( req );

  if ( ! tokenMatches( supplied ) ) {
    // WWW-Authenticate is required by RFC 7235 for a 401 and tells a
    // well-behaved client exactly what to present.
    res.setHeader( 'WWW-Authenticate', 'Bearer realm="claude-connector"' );

    /**
     * Send the rejection.
     * @returns {void}
     */
    const reject = () => {
      if ( res.headersSent ) return;
      res.status( 401 ).json( {
        error: 'Authentication required.',
        code:  'MCP_AUTH_REQUIRED',
        hint:  'Present the connector key as: Authorization: Bearer <MCP_API_KEY>',
      } );
    };

    // v12.31.0: drain any inbound request body before responding.
    //
    // Responding while the client is still uploading causes the server to reset
    // the stream. Over HTTP/2 the client then reports a transport error
    // ("stream was not closed cleanly: CANCEL", cURL error 92) and never sees
    // the status code at all, so an authentication failure is indistinguishable
    // from a network fault. That is precisely how the v12.28.0 allowlist gap
    // presented, and it cost far more time to diagnose than a plain 401 would
    // have.
    //
    // Draining is capped: a caller must not be able to make an unauthenticated
    // request cheap for itself and expensive for us by streaming indefinitely.
    // Past the cap we destroy the socket, which is the correct outcome for a
    // caller that is both unauthenticated and uncooperative.
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.readable;

    if ( ! hasBody ) {
      reject();
      return;
    }

    const DRAIN_LIMIT_BYTES = 2 * 1024 * 1024;
    const DRAIN_TIMEOUT_MS  = 5000;
    let drained  = 0;
    let finished = false;

    /**
     * @param {boolean} destroy Whether to tear down the socket.
     * @returns {void}
     */
    const finish = ( destroy ) => {
      if ( finished ) return;
      finished = true;
      clearTimeout( timer );
      req.removeListener( 'data', onData );
      req.removeListener( 'end', onEnd );
      req.removeListener( 'error', onEnd );
      reject();
      if ( destroy && typeof req.destroy === 'function' ) req.destroy();
    };

    const onData = ( chunk ) => {
      drained += chunk.length;
      if ( drained > DRAIN_LIMIT_BYTES ) finish( true );
    };
    const onEnd = () => finish( false );

    const timer = setTimeout( () => finish( true ), DRAIN_TIMEOUT_MS );
    if ( typeof timer.unref === 'function' ) timer.unref();

    req.on( 'data', onData );
    req.on( 'end', onEnd );
    req.on( 'error', onEnd );
    return;
  }

  req.mcpAuthenticated = true;
  return next();
}

/**
 * Walk the Express router stack and assert that every registered route is
 * either covered by mcpAuthMiddleware or explicitly allowlisted.
 *
 * This is the recurrence control for TNX-C-001. Adding a new route without
 * thinking about authentication now fails the boot rather than shipping.
 *
 * Express does not expose a stable public API for the router stack, so this
 * reads `app._router.stack` (Express 4) or `app.router.stack` (Express 5).
 * If neither shape is present the function reports that it could not verify
 * rather than silently passing, because a silent pass would defeat the point.
 *
 * @param {import('express').Application} app Fully configured Express app.
 * @returns {{ ok: boolean, checked: number, uncovered: string[], reason?: string }}
 */
export function auditRouteCoverage( app ) {
  const stack = app?._router?.stack || app?.router?.stack;

  if ( ! Array.isArray( stack ) ) {
    return {
      ok:        false,
      checked:   0,
      uncovered: [],
      reason:    'Express router stack is not introspectable in this version. ' +
                 'Route coverage could not be verified.',
    };
  }

  // Confirm the gate itself is mounted. Without it, every route is uncovered
  // regardless of what the allowlist says.
  const gateMounted = stack.some(
    ( layer ) => layer.handle === mcpAuthMiddleware || layer.name === 'mcpAuthMiddleware'
  );

  if ( ! gateMounted ) {
    return {
      ok:        false,
      checked:   0,
      uncovered: [],
      reason:    'mcpAuthMiddleware is not mounted on the application. ' +
                 'Every route is reachable without authentication.',
    };
  }

  // Determine where the gate sits. Any route layer registered BEFORE it is
  // not covered, because Express runs the stack in registration order.
  const gateIndex = stack.findIndex(
    ( layer ) => layer.handle === mcpAuthMiddleware || layer.name === 'mcpAuthMiddleware'
  );

  const uncovered = [];
  let   checked   = 0;

  stack.forEach( ( layer, index ) => {
    if ( ! layer.route ) return;      // not a route layer (middleware, router mount)
    checked += 1;

    const routePath = layer.route.path;
    const paths     = Array.isArray( routePath ) ? routePath : [ routePath ];

    paths.forEach( ( p ) => {
      const asString = String( p );

      // Parameterised paths (e.g. "/download/:filename") never equal a literal
      // request path, so match them against the prefix entries by stripping the
      // parameter segment before testing.
      const literalPrefix = asString.split( '/:' )[ 0 ];
      const probe         = asString.includes( '/:' ) ? `${ literalPrefix }/x` : asString;

      const allowlisted = isPublicPath( probe ) || isSelfAuthenticatedPath( probe );

      if ( index < gateIndex && ! allowlisted ) {
        uncovered.push( `${ asString } (registered before the auth gate)` );
      }
    } );
  } );

  return { ok: uncovered.length === 0, checked, uncovered };
}

/**
 * Detect a method/path pair registered more than once.
 *
 * TNX-M-002 resolution. `GET /tools` was registered twice; Express dispatches
 * to the first match, so the second handler was unreachable dead code. The two
 * differed, and the later one had NO authentication -- so a routine reordering
 * of this 3,500-line file could have silently swapped an authenticated handler
 * for an unauthenticated one.
 *
 * Duplicate registration is almost never intentional, and when it is (an
 * explicit fall-through chain) the handlers are adjacent and obvious. Failing
 * the boot is the right response because the alternative is code that looks
 * live, is reviewed as live, and never runs.
 *
 * @param {import('express').Application} app
 * @returns {{ ok: boolean, duplicates: string[] }}
 */
export function findDuplicateRoutes( app ) {
  const stack = app?._router?.stack || app?.router?.stack;
  if ( ! Array.isArray( stack ) ) return { ok: true, duplicates: [] };

  /** @type {Map<string, number>} */
  const seen = new Map();

  for ( const layer of stack ) {
    if ( ! layer.route ) continue;
    const paths = Array.isArray( layer.route.path ) ? layer.route.path : [ layer.route.path ];

    for ( const p of paths ) {
      // route.methods is { get: true, post: true, ... }
      for ( const method of Object.keys( layer.route.methods || {} ) ) {
        // Express registers app.all() as every method at once; counting those
        // as duplicates of a specific handler would be a false positive.
        if ( method === '_all' ) continue;
        const key = `${ method.toUpperCase() } ${ p }`;
        seen.set( key, ( seen.get( key ) || 0 ) + 1 );
      }
    }
  }

  const duplicates = [ ...seen.entries() ]
    .filter( ( [ , n ] ) => n > 1 )
    .map( ( [ key, n ] ) => `${ key } (registered ${ n } times)` );

  return { ok: duplicates.length === 0, duplicates };
}

/**
 * Boot-time wrapper. Runs the coverage audit and throws on failure.
 *
 * @param {import('express').Application} app
 * @throws {Error} When any route is reachable unauthenticated.
 * @returns {{ checked: number }}
 */
export function assertAllRoutesCovered( app ) {
  const result = auditRouteCoverage( app );

  if ( ! result.ok ) {
    const detail = result.reason
      ? result.reason
      : `The following routes are reachable without authentication:\n  - ${ result.uncovered.join( '\n  - ' ) }`;
    throw new Error( `Route coverage assertion failed.\n${ detail }` );
  }

  // TNX-M-002: a duplicate registration means one handler is unreachable.
  const dupes = findDuplicateRoutes( app );
  if ( ! dupes.ok ) {
    throw new Error(
      'These routes are registered more than once, so all but the first are unreachable:\n  - ' +
      dupes.duplicates.join( '\n  - ' )
    );
  }

  return { checked: result.checked };
}

/**
 * Exposed for tests and for operator diagnostics.
 * @returns {{ public: string[], selfAuthenticated: string[] }}
 */
export function describeAllowlist() {
  return {
    public: PUBLIC_ROUTES.map( ( r ) => r.exact ?? `${ r.prefix }*` ),
    selfAuthenticated: SELF_AUTHENTICATED_ROUTES.map( ( r ) => r.exact ?? `${ r.prefix }*` ),
  };
}

export default {
  assertConfigured,
  mcpAuthMiddleware,
  assertAllRoutesCovered,
  auditRouteCoverage,
  isPublicPath,
  isSelfAuthenticatedPath,
  describeAllowlist,
};
