// src/voice/voice-auth.js
//
// Tenax Voice -- the transport credential for /voice/*.  (v12.50.0)
//
// ===========================================================================
// WHY THIS FILE EXISTS: THE GATEWAY COULD NOT REACH VOICE AT ALL
// ===========================================================================
//
// Until v12.50.0 the three voice routes sat behind mcpAuthMiddleware like any
// ordinary route, which means they demanded MCP_API_KEY. The caller that has to
// reach them in production is the Gateway Service (routes/ti-voice.js), and it
// does not hold MCP_API_KEY. It holds the per-tenant connector restore token,
// which it already sends as X-Railway-Restore-Token alongside the verified
// identity headers.
//
// So every gateway call was answered 401 by the auth gate before a line of
// voice code ran:
//
//   GET  /voice/health     -> 401  -> ti-voice /status reported
//                                     available:false, reason 'connector_unreachable'
//   POST /voice/transcribe -> 401  -> passed through to the browser
//   POST /voice/synthesize -> 401  -> passed through to the browser
//
// The mic button therefore never rendered, no matter what VOICE_ENABLED and
// VOICE_TEST_USERS were set to. The symptom looked like a feature flag being
// ignored; the cause was a credential the caller cannot present.
//
// The fix mirrors the pattern already used by /volume-restore, /restore-skill,
// /tool-call and the other twenty-odd plugin-facing routes: the route is exempt
// from the MCP key in middleware/mcpAuth.js, and verifies a credential of its
// own here instead. Nothing becomes public.
//
// ===========================================================================
// TWO ACCEPTED CREDENTIALS, AND WHAT EACH ONE MEANS
// ===========================================================================
//
//   Authorization: Bearer <MCP_API_KEY>   (or X-MCP-Api-Key)
//       The OPERATOR. This is the connector's own key; anyone holding it
//       already has remote code execution here, so voice grants nothing new.
//       Marked req.voiceOperator = true, which is what /voice/health uses to
//       decide whether it may explain a refusal.
//
//   X-Railway-Restore-Token: <RAILWAY_RESTORE_TOKEN>
//       The GATEWAY. Same token it already uses for volume restore and skill
//       pushes, so no new secret has to be provisioned or rotated. NOT an
//       operator: the response it receives is unchanged from before, so the
//       /ti-voice contract and the "never reveal that the feature exists"
//       discipline both hold for anything that reaches a browser.
//
// Neither credential says anything about WHICH USER is calling. That remains
// the job of voice-gate.js, reading X-Tenax-User-Id / X-Tenax-Tenant-Id. This
// module answers "may this MACHINE talk to the voice routes at all"; the gate
// answers "may this PERSON use voice". Both must pass.
//
// ===========================================================================
// WHY THE BODY IS DRAINED BEFORE A 401
// ===========================================================================
//
// Identical reasoning to mcpAuth.js, and learned the same expensive way in
// v12.31.0: POST /voice/transcribe streams audio, and answering while the
// client is still uploading resets the stream. Over HTTP/2 the client then
// reports a transport error with no status code, so an authentication failure
// is indistinguishable from a network fault. Draining is capped so an
// unauthenticated caller cannot make its own request cheap and ours expensive.

import { createHash, timingSafeEqual } from 'node:crypto';

/** Header carrying the gateway's per-tenant connector token. */
export const RESTORE_TOKEN_HEADER = 'x-railway-restore-token';

/** Cap on how much of an unauthenticated body we are willing to absorb. */
const DRAIN_LIMIT_BYTES = 2 * 1024 * 1024;
const DRAIN_TIMEOUT_MS  = 5000;

let _warnedUnconfigured = false;

/**
 * SHA-256 of a value, so comparisons are always over a fixed 32 bytes and
 * timingSafeEqual can never throw on a length mismatch. A throw would leak the
 * expected length through the difference between a 500 and a 401.
 *
 * @param {string} value
 * @returns {Buffer}
 */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/**
 * Constant-time string comparison. Empty operands never match.
 *
 * @param {string} supplied
 * @param {string} expected
 * @returns {boolean}
 */
export function constantTimeEquals(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * The credentials this connector is configured to accept.
 *
 * Read on every call rather than cached at module load, so a test can set them
 * after import and so a value corrected in the environment takes effect on the
 * next process start without a code path that remembers the old one.
 *
 * @returns {{mcpKey: string, restoreToken: string}}
 */
export function configuredCredentials() {
  return {
    mcpKey:       String(process.env.MCP_API_KEY || '').trim(),
    restoreToken: String(process.env.RAILWAY_RESTORE_TOKEN || '').trim(),
  };
}

/**
 * Read a single header value, rejecting the ambiguous cases.
 *
 * An array means the header arrived twice with different values. Section 6.4
 * says fail closed on any ambiguity, so it is treated as absent rather than
 * having one of the two picked for the caller.
 *
 * @param {object} headers
 * @param {string} name Lower-case header name.
 * @returns {string}
 */
function readHeader(headers, name) {
  const raw = (headers || {})[name];
  if (raw === undefined || raw === null) return '';
  if (Array.isArray(raw)) return '';
  return String(raw).trim();
}

/**
 * The bearer token presented by the caller.
 *
 * Accepted carriers match mcpAuth.js exactly, so a client that can already talk
 * to the connector needs no new behaviour. The query string is deliberately not
 * accepted: query parameters appear in access logs, proxy logs, browser history
 * and the Referer header of any outbound request.
 *
 * @param {object} req
 * @returns {string}
 */
export function extractBearer(req) {
  const headers = (req && req.headers) || {};
  const auth = readHeader(headers, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1].trim();
  return readHeader(headers, 'x-mcp-api-key');
}

/**
 * The gateway's restore token, if presented.
 *
 * @param {object} req
 * @returns {string}
 */
export function extractRestoreToken(req) {
  return readHeader((req && req.headers) || {}, RESTORE_TOKEN_HEADER);
}

/**
 * Classify the caller's credential without sending a response.
 *
 * Exported separately from the middleware so it can be unit tested and so a
 * caller that needs the answer without the 401 machinery can ask for it.
 *
 * @param {object} req
 * @returns {{ok: boolean, credential: 'mcp_api_key'|'restore_token'|'unconfigured'|'none',
 *             operator: boolean}}
 */
export function classifyVoiceCredential(req) {
  const { mcpKey, restoreToken } = configuredCredentials();

  // Nothing to check against. This cannot happen on a deployed connector:
  // assertConfigured() in middleware/mcpAuth.js refuses to boot without a
  // usable MCP_API_KEY, and there is deliberately no variable that suppresses
  // it. It happens only in unit tests that mount the voice routes on a bare
  // Express app, so the routes stay testable without a credential fixture.
  //
  // It reports ok:false, NOT ok:true. The middleware lets the request continue
  // so those tests behave as before, but nothing downstream is told the caller
  // was authenticated -- requireAuth still refuses an anonymous request, which
  // is the behaviour the Section 16 acceptance test asserts.
  if (!mcpKey && !restoreToken) {
    return { ok: false, credential: 'unconfigured', operator: false };
  }

  if (mcpKey && constantTimeEquals(extractBearer(req), mcpKey)) {
    return { ok: true, credential: 'mcp_api_key', operator: true };
  }

  if (restoreToken && constantTimeEquals(extractRestoreToken(req), restoreToken)) {
    return { ok: true, credential: 'restore_token', operator: false };
  }

  return { ok: false, credential: 'none', operator: false };
}

/**
 * Send the 401, draining any inbound body first.
 *
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function reject401(req, res) {
  let finished = false;

  const send = () => {
    if (res.headersSent) return;
    // Required by RFC 7235 for a 401, and it tells a well-behaved client
    // exactly what to present.
    res.setHeader('WWW-Authenticate', 'Bearer realm="claude-connector"');
    res.status(401).json({
      error: 'unauthenticated',
      code: 'VOICE_AUTH_REQUIRED',
      message: 'Voice requires the connector key (Authorization: Bearer <MCP_API_KEY>) '
        + 'or the gateway token (X-Railway-Restore-Token).',
    });
  };

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.readable;
  if (!hasBody) { send(); return; }

  let drained = 0;

  const finish = (destroy) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onEnd);
    send();
    if (destroy && typeof req.destroy === 'function') req.destroy();
  };

  const onData = (chunk) => {
    drained += chunk.length;
    // Past the cap the socket is torn down, which is the correct outcome for a
    // caller that is both unauthenticated and uncooperative.
    if (drained > DRAIN_LIMIT_BYTES) finish(true);
  };
  const onEnd = () => finish(false);

  const timer = setTimeout(() => finish(true), DRAIN_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onEnd);
}

/**
 * Express middleware. Mount as the FIRST handler on every /voice/* route.
 *
 * First, and specifically ahead of express.raw(), so an unauthenticated caller
 * cannot make the connector buffer a 25 MB audio body before being refused.
 *
 * Sets, for downstream handlers:
 *   req.voiceAuthenticated  true when a configured credential matched
 *   req.voiceOperator       true only for MCP_API_KEY
 *   req.voiceCredential     'mcp_api_key' | 'restore_token' | 'unconfigured'
 *
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 * @returns {void}
 */
export function voiceCredential(req, res, next) {
  const verdict = classifyVoiceCredential(req);

  req.voiceCredential    = verdict.credential;
  req.voiceAuthenticated = verdict.ok;
  req.voiceOperator      = verdict.operator;

  if (verdict.ok) { next(); return; }

  if (verdict.credential === 'unconfigured') {
    if (!_warnedUnconfigured) {
      _warnedUnconfigured = true;
      console.warn('[voice] neither MCP_API_KEY nor RAILWAY_RESTORE_TOKEN is set; '
        + 'the voice transport credential cannot be verified. A deployed connector '
        + 'cannot reach this state -- it refuses to boot without MCP_API_KEY.');
    }
    next();
    return;
  }

  reject401(req, res);
}

/** Test seam: allow the one-time warning to fire again. */
export function resetVoiceAuthWarning() { _warnedUnconfigured = false; }

export default {
  voiceCredential, classifyVoiceCredential, configuredCredentials,
  extractBearer, extractRestoreToken, constantTimeEquals,
  RESTORE_TOKEN_HEADER, resetVoiceAuthWarning,
};
