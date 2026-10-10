// src/voice/voice-stream-auth.js
//
// Tenax Voice -- authentication for the streaming WebSocket upgrade.
// STREAM-WHISPER-v1.0.0 Section 7.
//
// ===========================================================================
// WHY THIS IS A SEPARATE MODULE AND NOT MIDDLEWARE
// ===========================================================================
//
// An upgrade request never reaches Express. It arrives on the raw socket and
// is dispatched by the `upgrade` event on the HTTP server, before any router,
// so none of the existing voice middleware can run on it: they all take
// (req, res, next) and there is no res.
//
// The checks themselves are NOT reimplemented. Every one of them is the
// existing function, called directly:
//
//     classifyVoiceCredential   the transport credential  (voice-auth.js)
//     voiceEnabled              the master switch          (voice-gate.js)
//     resolveIdentity           the caller's identity      (voice-gate.js)
//     identityPresent           identity as a predicate    (voice-gate.js)
//
// Section 7 says "the gateway's existing voice entitlement check applies at
// upgrade time". v13.37.0 (TENAX-VOICE-2026-10-07-02): it applies AT THE
// GATEWAY. The per-user allowlist this module used to consult is retired; the
// gateway's lib/voice-stream-proxy.js runs its one entitlement predicate
// before it opens the upstream socket, so a refused user never reaches here.
// What this module still checks is what it can know: the flags, the
// transport credential, and that an identity was sent.
//
// ===========================================================================
// THE ORDER OF THE CHECKS IS THE CHEAP-FIRST ORDER
// ===========================================================================
//
// An unauthenticated upgrade should cost as little as possible, because it is
// the one an attacker sends repeatedly. So: the flag (an env read), then the
// credential (a constant-time compare), then identity (header parsing). None
// of them makes a network call.

import { classifyVoiceCredential } from './voice-auth.js';
import { voiceEnabled, resolveIdentity, identityPresent } from './voice-gate.js';
import { streamingEnabled } from './voice-stream-config.js';

/**
 * Decide whether an upgrade may proceed.
 *
 * ── Why the reasons are coarse ───────────────────────────────────────────
 *
 * The refusal reason travels in an HTTP status line and a header on a
 * connection that is about to be destroyed, so it is visible to anyone who can
 * reach the port. It names the CLASS of failure and never which check the
 * caller passed: "unauthorised" for a bad credential and for a good credential
 * with no identity, because distinguishing them would confirm to an
 * unauthenticated caller that their credential was valid.
 *
 * `voice_disabled` is deliberately distinct. It is a deployment state rather
 * than a fact about the caller, and an operator debugging a dead mic button
 * needs to tell "off" from "refused".
 *
 * @param {object} req The upgrade request.
 * @returns {Promise<{ok: boolean, status?: number, reason?: string,
 *          userId?: string, tenantId?: string}>}
 */
export async function authenticateUpgrade( req ) {
  // Section 9. Checked again here even though attachVoiceStream() already
  // refuses to attach when the flag is off: the flag can be turned off in the
  // environment of a running process, and an endpoint that stays live because
  // it was attached at boot is not what "default false, opt-in" means.
  if ( ! streamingEnabled() ) {
    return { ok: false, status: 404, reason: 'streaming_disabled' };
  }

  // The master switch for voice as a whole. A deployment with voice off must
  // not expose a transcription socket, flag or no flag.
  if ( ! voiceEnabled() ) {
    return { ok: false, status: 404, reason: 'voice_disabled' };
  }

  const credential = classifyVoiceCredential( req );
  if ( ! credential.ok ) {
    return { ok: false, status: 401, reason: 'unauthorised' };
  }

  const identity = resolveIdentity( req );
  if ( ! identityPresent( identity ) ) {
    // Section 7: no anonymous streams. A valid transport credential proves the
    // GATEWAY is calling; it says nothing about which user. Both are required.
    return { ok: false, status: 401, reason: 'unauthorised' };
  }

  return { ok: true, userId: identity.userId, tenantId: identity.tenantId || '' };
}

export default { authenticateUpgrade };
