// src/utils/signedUrls.js  v1.0.0
// ---------------------------------------------------------------------------
// Per-file signed download URLs.  (TNX-FEAT-SIGNEDURLS)
//
// Replaces the single global DOCUMENT_DOWNLOAD_TOKEN in generated links with a
// stateless HMAC signature scoped to one filename and one expiry.
//
// WHAT THIS FIXES
// ---------------
// The global token has unlimited lifetime and global blast radius: it cannot be
// revoked without rotating the variable and restarting, and one leaked link
// grants read access to every document produced since deployment. A signed link
// is useless once `exp` passes, and useless against any filename other than the
// one it was signed for.
//
// URL SHAPE
//   https://<connector>/download/<name>?exp=<unix_seconds>&sig=<hex>
//
// SIGNATURE PAYLOAD
//   `${safeFilename}:${exp}`
//
// The filename is inside the payload deliberately. Without it, a valid
// signature harvested from one link could be pasted onto any other filename
// (signature swapping) and would verify, which would reinstate the global blast
// radius the feature exists to remove.
//
// STATELESS BY DESIGN
// The connector stores nothing per link. Verification recomputes the HMAC from
// the request itself, so links survive restarts and horizontal scaling without
// shared session state. The cost is that a link cannot be individually revoked
// before its expiry; rotating the secret revokes all of them at once.
//
// NOT SOLVED HERE: replay. A link stolen inside its validity window works until
// it expires. Session-scoping the signature would address that and is out of
// scope for v1.0, per the spec.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Default link lifetime in seconds. */
const DEFAULT_EXPIRY_SECONDS = 3600;

/**
 * Lower bound on the secret length. 32 hex characters is 128 bits, which is the
 * floor for a key that authorises document retrieval.
 */
const MIN_SECRET_LENGTH = 32;

/** Cached secret, so the volume is read once rather than per request. */
let _cachedSecret = null;

/** True once the "generated a new secret" warning has been emitted. */
let _warnedGenerated = false;

/**
 * Path the bootstrapped secret is persisted to.
 *
 * On the Railway deployment /data is the mounted volume, so the secret survives
 * redeploys. If it did not, every previously issued link would break on every
 * deploy, which is indistinguishable from an outage to a user holding a link.
 *
 * @returns {string} Absolute path to the secret file.
 */
export function secretFilePath() {
  return process.env.SIGNED_URL_SECRET_PATH || '/data/.url_secret';
}

/**
 * Whether signed links are enabled.
 *
 * Defaults to true. ENABLE_SIGNED_LINKS=false is the rollout escape hatch and
 * restores the previous global-token behaviour exactly.
 *
 * @returns {boolean}
 */
export function signedLinksEnabled() {
  return String( process.env.ENABLE_SIGNED_LINKS || 'true' ).trim().toLowerCase() !== 'false';
}

/**
 * Configured link lifetime in seconds.
 *
 * A non-numeric, zero or negative value falls back to the default rather than
 * producing links that are already expired at the moment they are issued, which
 * would present as "downloads are broken" rather than as a bad setting.
 *
 * @returns {number} Positive integer seconds.
 */
export function linkExpirySeconds() {
  const raw = parseInt( process.env.LINK_EXPIRY_SECONDS || '', 10 );
  if ( ! Number.isFinite( raw ) || raw <= 0 ) return DEFAULT_EXPIRY_SECONDS;
  // Cap at 30 days. A longer window is almost certainly a typo (milliseconds
  // pasted into a seconds field) and would silently recreate the unlimited
  // lifetime this feature removes.
  return Math.min( raw, 30 * 24 * 3600 );
}

/**
 * Resolve the signing secret, bootstrapping it on first use.
 *
 * Precedence:
 *   1. SIGNED_URL_SECRET, when set and long enough. An operator-managed secret
 *      is preferred because it can be rotated deliberately and shared across
 *      replicas.
 *   2. The persisted file on the volume.
 *   3. A freshly generated 64-character hex string, written to the volume.
 *
 * If the volume cannot be written the secret is still returned so the feature
 * works, but the failure is logged loudly: an in-memory-only secret means every
 * outstanding link breaks on the next restart.
 *
 * @param {(level: string, message: string) => void} [log]
 * @returns {string} The signing secret.
 */
export function resolveSigningSecret( log ) {
  if ( _cachedSecret ) return _cachedSecret;

  const report = typeof log === 'function'
    ? log
    : ( level, message ) => console.error( `[signedUrls] ${ level }: ${ message }` );

  const fromEnv = String( process.env.SIGNED_URL_SECRET || '' ).trim();

  if ( fromEnv ) {
    if ( fromEnv.length < MIN_SECRET_LENGTH ) {
      report( 'warn',
        `SIGNED_URL_SECRET is ${ fromEnv.length } characters; a minimum of ${ MIN_SECRET_LENGTH } is ` +
        'required. Falling back to the persisted volume secret.' );
    } else {
      _cachedSecret = fromEnv;
      return _cachedSecret;
    }
  }

  const path = secretFilePath();

  if ( existsSync( path ) ) {
    try {
      const fromFile = readFileSync( path, 'utf8' ).trim();
      if ( fromFile.length >= MIN_SECRET_LENGTH ) {
        _cachedSecret = fromFile;
        return _cachedSecret;
      }
      report( 'warn', `${ path } holds a secret shorter than ${ MIN_SECRET_LENGTH } characters. Regenerating.` );
    } catch ( err ) {
      report( 'error', `Could not read ${ path }: ${ err.message }. Regenerating.` );
    }
  }

  const generated = randomBytes( 32 ).toString( 'hex' );   // 64 hex characters

  try {
    mkdirSync( dirname( path ), { recursive: true } );
    // 0600: the secret is equivalent to read access to every generated
    // document, so it must not be world-readable on a shared volume.
    writeFileSync( path, generated, { encoding: 'utf8', mode: 0o600 } );

    if ( ! _warnedGenerated ) {
      _warnedGenerated = true;
      report( 'warn',
        `No signing secret was configured, so one was generated and written to ${ path }. ` +
        'OPERATOR ACTION: copy it into the SIGNED_URL_SECRET variable. Until you do, the ' +
        'secret lives only on this volume, and losing the volume invalidates every ' +
        'outstanding download link.' );
    }
  } catch ( err ) {
    if ( ! _warnedGenerated ) {
      _warnedGenerated = true;
      report( 'error',
        `A signing secret was generated but could NOT be persisted to ${ path } (${ err.message }). ` +
        'It exists only in memory, so every download link issued by this process will stop ' +
        'working at the next restart, and replicas will not agree on signatures. ' +
        'Set SIGNED_URL_SECRET to fix this.' );
    }
  }

  _cachedSecret = generated;
  return _cachedSecret;
}

/**
 * Clear the cached secret. Test support only.
 * @returns {void}
 */
export function resetSigningSecretCache() {
  _cachedSecret   = null;
  _warnedGenerated = false;
}

/**
 * Compute the signature for a filename and expiry.
 *
 * @param {string} safeFilename Single path segment, already validated.
 * @param {number} exp          Expiry as unix seconds.
 * @param {string} secret       Signing secret.
 * @returns {string} Lower-case hex HMAC-SHA256.
 */
export function computeSignature( safeFilename, exp, secret ) {
  const payload = `${ safeFilename }:${ exp }`;
  return createHmac( 'sha256', secret ).update( payload, 'utf8' ).digest( 'hex' );
}

/**
 * Build the query string for a signed link.
 *
 * @param {object} opts
 * @param {string} opts.filename          Single path segment, already validated.
 * @param {number} [opts.expirySeconds]   Override the configured lifetime.
 * @param {number} [opts.now]             Unix seconds; injectable for tests.
 * @param {(level: string, message: string) => void} [opts.log]
 * @returns {{ exp: number, sig: string, query: string }}
 */
export function buildSignedQuery( opts = {} ) {
  const { filename, expirySeconds, now, log } = opts;

  if ( typeof filename !== 'string' || ! filename ) {
    throw new Error( 'buildSignedQuery requires a filename.' );
  }

  const nowSeconds = Number.isFinite( now ) ? Math.floor( now ) : Math.floor( Date.now() / 1000 );
  const ttl        = Number.isFinite( expirySeconds ) && expirySeconds > 0
    ? Math.floor( expirySeconds )
    : linkExpirySeconds();

  const exp = nowSeconds + ttl;
  const sig = computeSignature( filename, exp, resolveSigningSecret( log ) );

  return { exp, sig, query: `?exp=${ exp }&sig=${ sig }` };
}

/**
 * Constant-time hex comparison.
 *
 * Both operands are hashed to a fixed 32 bytes before comparison. Hashing first
 * is required rather than cosmetic: crypto.timingSafeEqual throws on a length
 * mismatch, and the resulting 500 would itself disclose the expected signature
 * length and distinguish "wrong length" from "wrong value".
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeHexEquals( a, b ) {
  if ( typeof a !== 'string' || typeof b !== 'string' ) return false;
  if ( a.length === 0 || b.length === 0 ) return false;
  const ha = createHash( 'sha256' ).update( a, 'utf8' ).digest();
  const hb = createHash( 'sha256' ).update( b, 'utf8' ).digest();
  return timingSafeEqual( ha, hb );
}

/**
 * Verify a signed request.
 *
 * @param {object} opts
 * @param {string} opts.filename  Safe filename taken from the resolved path,
 *                                NOT from the raw request. Verifying against
 *                                the raw parameter would let an unnormalised
 *                                variant satisfy a signature for a different
 *                                file.
 * @param {unknown} opts.exp      Raw `exp` query parameter.
 * @param {unknown} opts.sig      Raw `sig` query parameter.
 * @param {number} [opts.now]     Unix seconds; injectable for tests.
 * @param {(level: string, message: string) => void} [opts.log]
 * @returns {{ ok: boolean, reason?: 'missing'|'malformed'|'expired'|'bad_signature' }}
 */
export function verifySignedRequest( opts = {} ) {
  const { filename, exp, sig, now, log } = opts;

  const expRaw = String( exp ?? '' ).trim();
  const sigRaw = String( sig ?? '' ).trim();

  if ( ! expRaw && ! sigRaw ) return { ok: false, reason: 'missing' };
  if ( ! expRaw || ! sigRaw ) return { ok: false, reason: 'malformed' };

  // Strict integer. parseInt would accept "1700000000abc" and "0x..." forms,
  // which then hash differently from the canonical value and produce confusing
  // signature failures instead of a clear malformed result.
  if ( ! /^\d{1,15}$/.test( expRaw ) ) return { ok: false, reason: 'malformed' };
  if ( ! /^[a-f0-9]{64}$/i.test( sigRaw ) ) return { ok: false, reason: 'malformed' };

  const expSeconds = Number( expRaw );
  const nowSeconds = Number.isFinite( now ) ? Math.floor( now ) : Math.floor( Date.now() / 1000 );

  // Signature is checked before expiry so that both outcomes cost the same
  // work, and so an attacker probing signatures learns nothing from response
  // timing on an expired link.
  const expected = computeSignature( String( filename || '' ), expSeconds, resolveSigningSecret( log ) );
  const sigOk    = constantTimeHexEquals( sigRaw.toLowerCase(), expected );

  if ( ! sigOk ) return { ok: false, reason: 'bad_signature' };
  if ( expSeconds <= nowSeconds ) return { ok: false, reason: 'expired' };

  return { ok: true };
}

export default {
  signedLinksEnabled,
  linkExpirySeconds,
  resolveSigningSecret,
  resetSigningSecretCache,
  computeSignature,
  buildSignedQuery,
  verifySignedRequest,
  secretFilePath,
};
