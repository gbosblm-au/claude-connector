// src/utils/serviceRuntime.js  v1.0.0
// ---------------------------------------------------------------------------
// Process-level guards, HTTP timeout tuning and graceful drain for the
// connector.
//
// Remediates TNX-H-006, and provides the readiness machinery for TNX-H-004.
//
// What the connector had
// ----------------------
// The complete process handling was two lines:
//
//     process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
//     process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
//
// Absent: unhandledRejection, uncaughtException, a forced-exit deadline,
// keepAliveTimeout, headersTimeout, requestTimeout, and any drain.
//
// The gateway implements all of these, and its source carries comments
// explaining that each was added in response to a specific production symptom:
// silent SSE drops, unexplained ECONNRESET from proxy socket reuse, aborted
// large uploads. Every one of those failure modes was still live in the
// connector, which serves SSE and long-running script_execute calls.
//
// The single worst consequence
// ----------------------------
// `httpServer.close()` waits INDEFINITELY for open connections to end. The
// connector serves SSE, and an SSE connection by definition does not end. So
// close() never invoked its callback, the process never exited, Railway
// SIGKILLed it after the grace period, and every in-flight tool call was
// severed mid-frame. The two-line handler did not merely fail to drain; it
// guaranteed a hard kill on every single redeploy.
//
// Why this is a separate module
// -----------------------------
// The audit's Phase 2 roadmap calls for extracting a shared
// `@tenax/service-runtime` package so the two Node services cannot drift again.
// This module is that extraction's first half: the connector's copy is written
// as a standalone, dependency-free unit with an injected configuration surface,
// so promoting it to a shared package later is a move rather than a rewrite.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReadinessCheck
 * @property {string}   name Short identifier reported in the response.
 * @property {Function} run  Returns true, or throws / returns false when unhealthy.
 * @property {boolean} [critical=true] When false, a failure degrades but does not fail readiness.
 */

/** Shared drain state, read by the readiness handler. */
const state = {
  shuttingDown: false,
  startedAt:    Date.now(),
};

/**
 * Whether the process is draining.
 * @returns {boolean}
 */
export function isShuttingDown() {
  return state.shuttingDown;
}

/**
 * Process uptime in seconds.
 * @returns {number}
 */
export function uptimeSeconds() {
  return Math.floor( ( Date.now() - state.startedAt ) / 1000 );
}

/**
 * Install unhandledRejection and uncaughtException handlers.
 *
 * The two are treated differently on purpose, and the difference matters:
 *
 *   unhandledRejection -- log with the full stack and KEEP RUNNING. A rejected
 *   promise in one tool handler says nothing about the health of the other
 *   sixty tools. Exiting here would let any single malformed tool call take
 *   down the whole connector.
 *
 *   uncaughtException -- log and EXIT NON-ZERO. By the time this fires, the
 *   stack has already been unwound past every catch block in the program. The
 *   process is in an indeterminate state and any further work it does is
 *   unpredictable, which is worse than being down. Exiting lets the
 *   orchestrator's restart policy do its job.
 *
 * @param {object} opts
 * @param {Function} opts.log Logger with signature (level, message).
 * @returns {void}
 */
export function installProcessGuards( { log } ) {
  process.on( 'unhandledRejection', ( reason, promise ) => {
    const detail = reason instanceof Error
      ? `${ reason.message }\n${ reason.stack }`
      : String( reason );
    log( 'error', `Unhandled promise rejection. The process is CONTINUING.\n${ detail }` );
    // Retain the promise reference in the log line so a repeated rejection from
    // the same site is identifiable in aggregate logs.
    if ( promise && typeof promise.then === 'function' ) {
      log( 'error', '  (rejection originated from an un-awaited promise)' );
    }
  } );

  process.on( 'uncaughtException', ( err, origin ) => {
    const detail = err instanceof Error ? `${ err.message }\n${ err.stack }` : String( err );
    log( 'error', `Uncaught exception (origin: ${ origin }). EXITING.\n${ detail }` );
    // Flush synchronously where possible, then exit. No async work here: the
    // event loop cannot be trusted at this point.
    process.exit( 1 );
  } );
}

/**
 * Apply the four Node HTTP timeouts.
 *
 * The relationship between them is not arbitrary and getting it wrong
 * reintroduces the bug it exists to prevent:
 *
 *   keepAliveTimeout  How long an idle keep-alive socket is held open. Node's
 *                     default is 5 seconds, which is BELOW the idle timeout of
 *                     essentially every reverse proxy and load balancer. The
 *                     proxy therefore reuses a socket that Node has already
 *                     decided to close, and the client sees an unexplained
 *                     ECONNRESET. Raising it above the proxy's own timeout is
 *                     the fix.
 *
 *   headersTimeout    Must be STRICTLY GREATER than keepAliveTimeout. If it is
 *                     lower, Node can time out waiting for headers on a socket
 *                     it is still willing to keep alive, and the request is
 *                     killed for no reason. Enforced as keepAlive + 5000 here.
 *
 *   requestTimeout    Time allowed to receive the entire request body. Must be
 *                     generous for the connector, which accepts 50 MB dataset
 *                     and document uploads over slow links.
 *
 *   timeout           Socket inactivity. Left at 0 (disabled) because SSE
 *                     connections are legitimately idle for long periods and
 *                     this would kill them.
 *
 * @param {import('node:http').Server} server
 * @param {object} opts
 * @param {Function} opts.log
 * @returns {{ keepAliveTimeout: number, headersTimeout: number, requestTimeout: number }}
 */
export function applyServerTimeouts( server, { log } ) {
  const keepAliveTimeout = parseInt( process.env.KEEP_ALIVE_TIMEOUT_MS || '310000', 10 );
  const requestTimeout   = parseInt( process.env.REQUEST_BODY_TIMEOUT_MS || '600000', 10 );

  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout   = keepAliveTimeout + 5000;
  server.requestTimeout   = requestTimeout;

  // 0 disables the socket inactivity timeout. SSE streams are idle by design
  // between events; a non-zero value here silently kills them.
  server.timeout = 0;

  log( 'info', `HTTP timeouts: keepAlive=${ server.keepAliveTimeout }ms ` +
               `headers=${ server.headersTimeout }ms request=${ server.requestTimeout }ms` );

  return {
    keepAliveTimeout: server.keepAliveTimeout,
    headersTimeout:   server.headersTimeout,
    requestTimeout:   server.requestTimeout,
  };
}

/**
 * Install SIGTERM and SIGINT handlers implementing a real drain.
 *
 * Sequence, and why each step is in this order:
 *
 *   1. Set the drain flag so /health/ready starts returning 503.
 *   2. Wait PRESTOP_DELAY_MS for the platform to observe that and stop routing.
 *      Skipping this drops requests the balancer already dispatched.
 *   3. Notify open SSE sessions so clients reconnect deliberately rather than
 *      inferring a drop from silence.
 *   4. Run caller-supplied flush hooks (credential store, schedule store).
 *   5. Destroy remaining SSE sockets. THIS IS THE STEP THE CONNECTOR LACKED:
 *      without it, server.close() waits forever on connections that never end.
 *   6. server.close(), then exit.
 *   7. A forced-exit timer, unref'd, guarantees termination inside the grace
 *      window regardless of what any of the above does.
 *
 * @param {object} opts
 * @param {import('node:http').Server} opts.server
 * @param {Function} opts.log
 * @param {() => Iterable<any>} [opts.getSseSessions] Returns open SSE transports.
 * @param {Array<{ name: string, run: () => any }>} [opts.flushHooks]
 * @returns {void}
 */
export function installShutdownHandlers( { server, log, getSseSessions = null, flushHooks = [] } ) {
  const graceMs    = parseInt( process.env.SHUTDOWN_GRACE_MS || '15000', 10 );
  const preStopMs  = parseInt( process.env.PRESTOP_DELAY_MS  || '6000',  10 );

  /**
   * @param {string} signal
   * @returns {Promise<void>}
   */
  const shutdown = async ( signal ) => {
    if ( state.shuttingDown ) return;
    state.shuttingDown = true;
    log( 'info', `${ signal } received. Draining...` );

    // Guarantees exit inside the platform's grace window no matter what the
    // rest of this function does. unref'd so it is not itself a reason to stay
    // alive if everything else finishes early.
    const forceExit = setTimeout( () => {
      log( 'warn', `Drain deadline of ${ graceMs }ms reached. Forcing exit.` );
      process.exit( 0 );
    }, graceMs );
    if ( typeof forceExit.unref === 'function' ) forceExit.unref();

    // 2. Let the platform notice readiness has failed.
    if ( preStopMs > 0 ) {
      log( 'info', `Readiness failing. Waiting ${ preStopMs }ms for deregistration...` );
      await new Promise( ( resolve ) => setTimeout( resolve, preStopMs ) );
    }

    // 3 and 5. Notify, then tear down SSE sockets.
    if ( typeof getSseSessions === 'function' ) {
      try {
        const sessions = getSseSessions() || [];
        let closed = 0;
        for ( const session of sessions ) {
          try {
            const res = session && ( session.res || session.response || session );
            if ( res && typeof res.write === 'function' && ! res.writableEnded ) {
              res.write( `event: shutdown\ndata: ${ JSON.stringify( { reason: 'server_restarting' } ) }\n\n` );
            }
            if ( res && typeof res.end === 'function' && ! res.writableEnded ) {
              res.end();
            }
            // Destroying the socket is what allows server.close() to return.
            if ( res && res.socket && ! res.socket.destroyed ) res.socket.destroy();
            closed += 1;
          } catch { /* an already-dead session is not an error here */ }
        }
        if ( closed ) log( 'info', `Closed ${ closed } SSE session(s).` );
      } catch ( err ) {
        log( 'warn', `Could not close SSE sessions cleanly: ${ err.message }` );
      }
    }

    // 4. Flush anything that must survive the restart.
    for ( const hook of flushHooks ) {
      try {
        await hook.run();
        log( 'info', `Flushed ${ hook.name }.` );
      } catch ( err ) {
        log( 'error', `Failed to flush ${ hook.name }: ${ err.message }` );
      }
    }

    // 6. Stop accepting connections and wait for in-flight requests.
    server.close( () => {
      clearTimeout( forceExit );
      log( 'info', 'Shutdown complete.' );
      process.exit( 0 );
    } );

    // Belt and braces: ask Node to close idle keep-alive sockets immediately.
    // Available from Node 18.2; guarded so an older runtime does not throw.
    if ( typeof server.closeIdleConnections === 'function' ) {
      server.closeIdleConnections();
    }
  };

  process.on( 'SIGTERM', () => { shutdown( 'SIGTERM' ); } );
  process.on( 'SIGINT',  () => { shutdown( 'SIGINT'  ); } );
}

/**
 * Run a set of readiness checks and produce a report.
 *
 * @param {ReadinessCheck[]} checks
 * @returns {Promise<{ ready: boolean, checks: Record<string, { ok: boolean, detail?: string }> }>}
 */
export async function runReadinessChecks( checks ) {
  /** @type {Record<string, { ok: boolean, detail?: string }>} */
  const results = {};
  let ready = true;

  for ( const check of checks ) {
    const critical = check.critical !== false;
    try {
      const outcome = await check.run();
      const ok = outcome !== false;
      results[ check.name ] = ok ? { ok: true } : { ok: false, detail: 'check returned false' };
      if ( ! ok && critical ) ready = false;
    } catch ( err ) {
      results[ check.name ] = { ok: false, detail: err.message };
      if ( critical ) ready = false;
    }
  }

  return { ready, checks: results };
}

export default {
  installProcessGuards,
  applyServerTimeouts,
  installShutdownHandlers,
  runReadinessChecks,
  isShuttingDown,
  uptimeSeconds,
};
