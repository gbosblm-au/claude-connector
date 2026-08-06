// src/utils/internalConfig.js  v1.0.0
// ---------------------------------------------------------------------------
// Internal configuration bridge.
//
// Publishes a narrow, code-bounded set of runtime values to a caller holding
// X-Railway-Restore-Token, so that the session orchestrator can learn the
// connector's own public URL without that value being hardcoded in a skill file.
//
// SCOPE, and why it is smaller than it first looks
// ------------------------------------------------
// The original requirement was for this endpoint to publish CONNECTOR_URL,
// DOCUMENT_DOWNLOAD_TOKEN and DATABASE_URL, so that the model could assemble
// document download links itself and pass credentials into script_execute.
//
// As of v12.37.0 it does not need to do either:
//
//   - script_execute returns finished download URLs in `download_links`. The
//     connector builds them, because the connector is the process that already
//     holds both halves and serves /download. See utils/downloadLinks.js.
//   - Scripts needing DATABASE_URL receive it through the existing
//     SCRIPT_GRANTABLE_ENV + SCRIPT_ENV_MANIFEST grant in utils/scriptEnv.js,
//     injected server-side, per script.
//
// So the default published set is CONNECTOR_URL alone, which is not a secret:
// it is the connector's public hostname, already served unauthenticated by
// GET /api/config.js. The other two remain reachable through
// INTERNAL_CONFIG_KEYS for an operator who has a use this design did not
// anticipate, but they are off unless explicitly named.
//
// This module is separate from server-http.js so the authentication path can be
// unit tested without binding a listener.
// ---------------------------------------------------------------------------

/**
 * Names this endpoint is ever permitted to publish. Hard ceiling.
 *
 * INTERNAL_CONFIG_KEYS filters against this list; it does not replace it. A
 * name absent here cannot be published no matter how the variable is set, so
 * widening the endpoint is a code change and a review, not a deploy setting.
 * That distinction is the whole control: the failure mode being prevented is
 * `INTERNAL_CONFIG_KEYS=ANTHROPIC_API_KEY` turning a config endpoint into a
 * credential dump.
 *
 * @type {readonly string[]}
 */
export const INTERNAL_CONFIG_ALLOWED_KEYS = Object.freeze( [
  'CONNECTOR_URL',
  'DOCUMENT_DOWNLOAD_TOKEN',
  'DATABASE_URL',
] );

/**
 * Published when INTERNAL_CONFIG_KEYS is unset. Non-secret only.
 * @type {readonly string[]}
 */
export const INTERNAL_CONFIG_DEFAULT_KEYS = Object.freeze( [ 'CONNECTOR_URL' ] );

/**
 * Resolve the set of names this deployment publishes.
 *
 * A configured name outside the ceiling is dropped and reported rather than
 * honoured, so a typo or an over-broad setting fails closed.
 *
 * @param {(level: string, message: string) => void} [log] Optional logger.
 * @returns {string[]}
 */
export function resolveInternalConfigKeys( log ) {
  const raw = String( process.env.INTERNAL_CONFIG_KEYS || '' ).trim();
  if ( ! raw ) return [ ...INTERNAL_CONFIG_DEFAULT_KEYS ];

  const requested = raw.split( ',' ).map( ( n ) => n.trim() ).filter( Boolean );
  const permitted = [];

  for ( const name of requested ) {
    if ( INTERNAL_CONFIG_ALLOWED_KEYS.includes( name ) ) {
      permitted.push( name );
    } else if ( typeof log === 'function' ) {
      log( 'warn', `[/internal/config/env] INTERNAL_CONFIG_KEYS requests ${ name }, which is not publishable. Ignored.` );
    }
  }

  return permitted;
}

/**
 * Resolve a single publishable value.
 *
 * CONNECTOR_URL is read from the environment variable of the same name, which
 * is set on the connector service. The RAILWAY_PUBLIC_DOMAIN fallback exists so
 * that a deployment which has not set it still returns something usable rather
 * than an empty response, and matches the derivation in GET /api/config.js.
 *
 * @param {string} name Variable name, already checked against the ceiling.
 * @returns {string} The value, or an empty string when unavailable.
 */
export function resolveInternalConfigValue( name ) {
  if ( name === 'CONNECTOR_URL' ) {
    const explicit = String( process.env.CONNECTOR_URL || '' ).trim();
    if ( explicit ) return explicit;
    const domain = String( process.env.RAILWAY_PUBLIC_DOMAIN || '' ).trim();
    return domain ? `https://${ domain }` : '';
  }
  return String( process.env[ name ] || '' ).trim();
}

/**
 * Build the Express handler.
 *
 * Dependencies are injected rather than imported so that server-http.js keeps
 * ownership of the token constant and the comparison helper, and so this module
 * can be exercised without the HTTP server.
 *
 * @param {object} deps
 * @param {() => string} deps.getRestoreToken
 *        Returns the configured RAILWAY_RESTORE_TOKEN.
 * @param {(a: string, b: string) => boolean} deps.constantTimeEquals
 *        Constant-time comparison. MUST hash both operands to a fixed length
 *        first: crypto.timingSafeEqual throws on a length mismatch, and the
 *        resulting 500 would itself disclose the expected token length.
 * @param {(level: string, message: string) => void} [deps.log]
 * @returns {(req: import('express').Request, res: import('express').Response) => void}
 */
export function createInternalConfigHandler( deps ) {
  const { getRestoreToken, constantTimeEquals, log } = deps || {};

  if ( typeof getRestoreToken !== 'function' || typeof constantTimeEquals !== 'function' ) {
    throw new Error( 'createInternalConfigHandler requires getRestoreToken and constantTimeEquals.' );
  }

  return function handleInternalConfigEnv( req, res ) {
    const restoreToken = getRestoreToken();

    if ( ! restoreToken ) {
      res.status( 503 ).json( {
        error: 'RAILWAY_RESTORE_TOKEN not set in Railway Variables. Cannot authenticate internal config requests.',
      } );
      return;
    }

    const provided = String( req.headers?.[ 'x-railway-restore-token' ] || '' ).trim();

    if ( ! constantTimeEquals( provided, restoreToken ) ) {
      res.status( 401 ).json( { error: 'Invalid or missing X-Railway-Restore-Token.' } );
      return;
    }

    const keys    = resolveInternalConfigKeys( log );
    const payload = {};
    const missing = [];

    for ( const name of keys ) {
      const value = resolveInternalConfigValue( name );
      if ( value ) payload[ name ] = value;
      else missing.push( name );
    }

    if ( missing.length > 0 && typeof log === 'function' ) {
      // Names only. Logging a value here would put a download token or a
      // database password into the platform log, which is exactly the
      // disclosure this endpoint is scoped to avoid.
      log( 'warn', `[/internal/config/env] publishable but unset: ${ missing.join( ', ' ) }` );
    }

    // The response may carry credentials when the operator has widened the key
    // set, so no intermediary may retain it.
    res.setHeader( 'Cache-Control', 'no-store, no-cache, must-revalidate, private' );
    res.setHeader( 'Pragma', 'no-cache' );
    res.setHeader( 'Referrer-Policy', 'no-referrer' );
    res.json( payload );
  };
}

export default {
  createInternalConfigHandler,
  resolveInternalConfigKeys,
  resolveInternalConfigValue,
  INTERNAL_CONFIG_ALLOWED_KEYS,
  INTERNAL_CONFIG_DEFAULT_KEYS,
};
