// src/voice/voice-gate.js
//
// Tenax Voice -- feature gate and kill switch. Specification Section 7.
//
// ---------------------------------------------------------------------------
// THE VARIABLE NAME (Open Item 2, resolved)
// ---------------------------------------------------------------------------
//
// The specification leaves the name open: "VOICE_ENABLED vs a Tenax-prefixed
// alternative". The existing convention answers it. Every feature flag in this
// connector is a bare, unprefixed <FEATURE>_ENABLED:
//
//   BRAIN_SCAN_ENABLED    EDIT_TOOLS_ENABLED    EMAIL_SEND_ENABLED
//   MEMORY_ENABLED        PROFILES_ENABLED      RENDER_TOOLS_ENABLED
//   SCHEDULE_ENABLED      SELF_MODEL_ENABLED    SKILL_ENABLED
//   SNAPSHOT_ENABLED      UPLOAD_SWEEP_ENABLED  VALIDATION_TOOLS_ENABLED
//
// Sixteen of them, no prefix on any. VOICE_ENABLED it is.
//
// ---------------------------------------------------------------------------
// DEFAULT OFF, AND WHY THAT IS NOT THE HOUSE STYLE
// ---------------------------------------------------------------------------
//
// The other flags mostly default ON and are opt-OUT: SNAPSHOT_ENABLED reads
// `!== 'false'`, so anything unset means enabled. Voice inverts that. It
// defaults OFF and requires the exact string 'true'.
//
// This is deliberate and the specification is explicit about it (Section 7,
// "Default: false (voice off until explicitly enabled)"). Voice is not like the
// other features:
//
//   - It ships before its Phase 0 benchmark gate has run, and Section 14 makes
//     that gate hard: "no defaults ship until the benchmark confirms the
//     Section 12 budgets."
//   - It carries an unresolved GPL legal question (Open Item 1).
//   - It loads hundreds of megabytes of models and spawns child processes, on a
//     box already running the rest of the connector.
//
// A feature with three open gates must not switch itself on because a variable
// was left unset. Opt-out would do exactly that on every existing deployment.
//
// ---------------------------------------------------------------------------
// THE THREE LAYERS
// ---------------------------------------------------------------------------
//
// Section 7 requires the gate at three places, and they are three because each
// one alone is insufficient:
//
//   1. Startup       -- no models loaded, no child process spawned. Without
//                       this the gate saves no memory or CPU, only URLs.
//   2. Route         -- /voice/transcribe and /voice/synthesize 404. Without
//                       this the engine is unreachable but the API surface
//                       still advertises a feature that cannot work.
//   3. UI render     -- no voice elements in the DOM AT ALL. Section 7 says
//                       "absent from the DOM, not merely hidden", which is why
//                       gateState() is exposed for server-side rendering rather
//                       than left to a CSS class.
//
// /voice/health is the single exception: it answers whether the gate is on or
// off, so the UI can learn the feature is unavailable in one cheap call rather
// than probing a route that 404s.

import { currentAllowlist, ensureAllowlistFresh, allowlistState, allowlistSource }
  from './voice-allowlist.js';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

/**
 * Is voice enabled? (Layer A -- the master switch.)
 *
 * Strict: only an explicit affirmative turns voice on. A typo
 * (`VOICE_ENABLED=ture`) leaves it off, which is the safe direction for a
 * feature with an open legal item and an unrun benchmark. Compare
 * SNAPSHOT_ENABLED, where a typo would leave the feature ON.
 *
 * This is the KILL SWITCH. When it is not exactly true, voice is off for
 * everyone including allowlisted test users, and no identity is ever consulted.
 *
 * @returns {boolean}
 */
export function voiceEnabled() {
  const raw = process.env.VOICE_ENABLED;
  if (raw === undefined || raw === null) return false;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

// ===========================================================================
// LAYER B -- the per-user allowlist (keyhole)
// ===========================================================================
//
// ---------------------------------------------------------------------------
// OPEN ITEM: WHICH IDENTITY FIELD.  Settled here, with the reasoning.
// ---------------------------------------------------------------------------
//
// The specification flags this as "decide before build ... scoping the gate to
// the wrong field locks the operator out of their own testing". Three
// candidates exist in this connector, and only one of them is safe:
//
//   1. req.tsTenantId (middleware/tenantAuth.js)
//      REJECTED. It is a TENANT id, not a user id. In tenant mode every user of
//      a tenant shares one value, so allowlisting it would admit every user of
//      that tenant -- which is exactly the leak this gate exists to close.
//
//   2. getCurrentUser() -- the process-level session context seeded by
//      ts_gateway_session_init (tools-self-model/hook.js).
//      REJECTED, and this is the important one. It is a PROCESS-WIDE SINGLETON.
//      The self-model's own comment says per-call context is used because it is
//      "concurrency-safe: the identity travels with the individual call, so
//      simultaneous sessions from different users never overwrite one another",
//      and the singleton is only a fallback for direct MCP calls.
//
//      As a recorder that is a small attribution inaccuracy. As a SECURITY GATE
//      it is a hole: whoever ran session-init most recently sets the identity
//      that every subsequent voice request is judged against, so a
//      non-allowlisted user's request could be evaluated as the operator's. A
//      gate built on it would appear to work in single-user testing and fail
//      open under exactly the shared conditions it was written for.
//
//   3. The per-call user_id the gateway already sends. CHOSEN.
//      /tool-call carries { tenant_id, user_id } in its body, and this is the
//      value the specification recommends: "the same identity value the
//      UI/gateway exposes when it records a session".
//
// The gap this leaves, stated plainly: /voice/transcribe and /voice/synthesize
// are DIRECT HTTP ROUTES, not proxied tool calls, so no per-call context is
// injected into them today. The identity therefore has to be supplied on the
// voice request itself -- X-Tenax-User-Id, matching the user_id the gateway
// already knows. Absent identity FAILS CLOSED (404), so a caller that does not
// send it gets the same answer as a caller who is not allowlisted.
//
// ---------------------------------------------------------------------------
// TENANT-QUALIFIED ENTRIES
// ---------------------------------------------------------------------------
//
// Observed user_id values are small integers ("8" in the self-model tests). On
// a multi-tenant connector, user 8 of tenant A is a different person from user
// 8 of tenant B, and a bare "8" in the allowlist would admit both.
//
// So an entry may be written either way:
//
//   8                    matches user_id 8 in ANY tenant
//   ts_50f3be57:8        matches user_id 8 ONLY in tenant ts_50f3be57
//
// The qualified form is the safer one and is what should be used on any
// deployment serving more than one tenant.

/** Identity headers, matching the field names the gateway already uses. */
export const USER_ID_HEADER = 'x-tenax-user-id';
export const TENANT_ID_HEADER = 'x-tenax-tenant-id';

/**
 * The allowlist, parsed from VOICE_TEST_USERS.
 *
 * Empty by default, so voice is unreachable until an identity is added --
 * turning the master switch on alone opens nothing.
 *
 * Entries are trimmed but NOT case-folded and NOT pattern-matched. The
 * specification is explicit: "no substring match, no case folding -- an
 * identity must match a listed value verbatim so a typo cannot accidentally
 * include someone." A prefix match on "8" would admit "80" and "8-guest".
 *
 * @returns {string[]}
 */
export function testUsers() {
  // Delegated to voice-allowlist.js, which owns WHERE the list comes from --
  // VOICE_TEST_USERS, or a live read from the gateway. This function owns what
  // an entry MEANS, and that is identical either way, so the two modes cannot
  // disagree about who is allowed. Empty entries are dropped there, which
  // matters: an empty string would match a caller who sent no identity at all.
  return currentAllowlist();
}

/**
 * Read the calling identity off a request.
 *
 * Deliberately does NOT fall back to the process-level session context. See the
 * rejection of candidate 2 above: that singleton is not concurrency-safe, and a
 * gate that consults it can judge one user's request against another's identity.
 *
 * @param {object} req
 * @returns {{userId: string|null, tenantId: string|null, source: string}}
 */
export function resolveIdentity(req) {
  if (!req) return { userId: null, tenantId: null, source: 'none' };

  const headers = req.headers || {};
  const pick = (v) => {
    if (v === undefined || v === null) return null;
    // An array means the header was sent twice with different values. That is
    // ambiguous, and Section 6.4 says fail closed on any ambiguity.
    if (Array.isArray(v)) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  };

  // An upstream middleware may already have resolved the identity; prefer it
  // over the raw header, since it has had the chance to verify it.
  const preset = req.tsVoiceIdentity;
  if (preset && preset.userId) {
    return {
      userId: String(preset.userId).trim() || null,
      tenantId: preset.tenantId ? String(preset.tenantId).trim() : null,
      source: 'middleware',
    };
  }

  const userId = pick(headers[USER_ID_HEADER]);
  const tenantId = pick(headers[TENANT_ID_HEADER]) || (req.tsTenantId ? String(req.tsTenantId) : null);

  return { userId, tenantId, source: userId ? 'header' : 'none' };
}

/**
 * Is this identity on the allowlist? (Layer B alone -- ignores the master switch.)
 *
 * @param {{userId: string|null, tenantId: string|null}} identity
 * @returns {boolean}
 */
export function userAllowed(identity) {
  const list = testUsers();
  if (!list.length) return false;

  const userId = identity && identity.userId ? String(identity.userId).trim() : '';
  // No identity is not "allowed by default". Fail closed.
  if (!userId) return false;

  const tenantId = identity && identity.tenantId ? String(identity.tenantId).trim() : '';

  for (const entry of list) {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      if (entry === userId) return true;
      continue;
    }
    // Tenant-qualified. BOTH halves must match: a qualified entry is a narrower
    // grant than a bare one, and matching only the user half would silently
    // widen it back out to every tenant.
    const wantTenant = entry.slice(0, colon).trim();
    const wantUser = entry.slice(colon + 1).trim();
    if (!wantTenant || !wantUser) continue;
    if (wantUser === userId && wantTenant === tenantId) return true;
  }
  return false;
}

/**
 * Both layers. Voice is reachable only when the master switch is on AND the
 * caller is allowlisted.
 *
 * The master switch is evaluated FIRST and short-circuits, so when voice is
 * globally off no identity is read at all -- matching the specification's
 * "the master switch still gates every route ... before identity is even
 * consulted". Two independent failures must both happen for an unauthorised
 * caller to get through.
 *
 * @param {object} req
 * @returns {boolean}
 */
export function voiceAvailableFor(req) {
  if (!voiceEnabled()) return false;
  return userAllowed(resolveIdentity(req));
}

/**
 * Whether the Phase 0 benchmark (Section 14) has been recorded.
 *
 * Section 14 calls the gate hard. This is the machine-readable half of it: the
 * benchmark writes VOICE_BENCHMARK_COMPLETED=<iso-date> once it has confirmed
 * the Section 12 budgets on the real target CPU, and the defaults it measured
 * are what gets locked.
 *
 * It does NOT block the routes. Blocking them would make the benchmark
 * unrunnable, since the benchmark drives those very routes. It is surfaced on
 * /voice/health instead, so an operator can see at a glance that voice is
 * answering on provisional defaults rather than measured ones.
 *
 * @returns {{completed: boolean, at: string|null}}
 */
export function benchmarkState() {
  const raw = (process.env.VOICE_BENCHMARK_COMPLETED || '').trim();
  if (!raw) return { completed: false, at: null };
  const t = Date.parse(raw);
  // A date that cannot be parsed is treated as NOT completed. Accepting an
  // unparseable value would let `VOICE_BENCHMARK_COMPLETED=soon` satisfy a gate
  // the specification calls hard.
  if (!Number.isFinite(t)) return { completed: false, at: null };
  return { completed: true, at: new Date(t).toISOString() };
}

/**
 * The state the server hands to the UI layer (Section 7, layer 3).
 *
 * Returned even when voice is off, because "off" is exactly what the UI needs
 * to know in order to emit nothing. The flags are deliberately flat and
 * boolean: a template deciding whether to render a mic button should not have
 * to parse anything.
 *
 * @param {{sttReady?: boolean, ttsReady?: boolean, degraded?: boolean}} [engine]
 * @returns {object}
 */
export function gateState(engine, req) {
  const on = voiceEnabled();
  const e = engine || {};
  const bench = benchmarkState();

  // Per-user, not global (Section 4.2: "The UI is told per-user, not
  // globally"). A UI handed a global `enabled` would render a mic button for
  // every user on a connector where one operator is testing.
  const identity = on ? resolveIdentity(req) : { userId: null, tenantId: null, source: 'none' };
  const forThisUser = on && userAllowed(identity);

  return {
    enabled: on,
    // Section 2.2 / 4.2. This is the flag the UI must actually branch on.
    voice_enabled_for_this_user: forThisUser,
    // Render the voice UI at all. Keyed on the PER-USER answer, so a
    // non-allowlisted user emits nothing even while the master switch is on --
    // the same "absent from the DOM, not merely hidden" discipline, scoped to
    // the requesting user.
    render_voice_ui: forThisUser,
    // Section 7: "If the gate is on but the engine fails to initialise, the UI
    // shows a degraded voice state". Degraded is NOT the same as off -- off
    // emits nothing, degraded emits a disabled control that explains itself.
    // Readiness is reported per-user too. A non-allowlisted user seeing
    // stt_ready:true would have grounds to render something, which is the leak
    // this gate exists to close.
    degraded: forThisUser ? !!e.degraded : false,
    stt_ready: forThisUser ? !!e.sttReady : false,
    tts_ready: forThisUser ? !!e.ttsReady : false,
    benchmark_completed: bench.completed,
    benchmark_at: bench.at,
    // Section 13: "The UI must present TTS language availability explicitly
    // rather than implying symmetric coverage." STT does ~99 languages and TTS
    // does four at differing quality, so the UI is told the two sets differ
    // rather than being left to assume one list covers both.
    asymmetric_language_support: true,
  };
}

/**
 * Guard on the master switch alone. Retained for callers that have no request.
 *
 * Sends a 404, not a 403: the routes must be indistinguishable from routes that
 * do not exist. A 403 would confirm the feature exists and is merely switched
 * off, which is a different statement.
 *
 * @param {object} res
 * @returns {boolean}
 */
export function requireVoiceEnabled(res) {
  if (voiceEnabled()) return true;
  res.status(404).json({ error: 'not_found' });
  return false;
}

/**
 * Guard on BOTH layers. This is what the voice routes use.
 *
 * Every refusal -- master switch off, no identity, unknown identity, identity
 * not allowlisted -- produces the byte-identical 404 the global gate produced
 * before this change. Section 4.1: "never as 'route exists but you are not
 * allowed'". A distinct status or message for "not allowlisted" would tell an
 * unauthorised caller that the feature exists and that they are simply on the
 * wrong side of it.
 *
 * @param {object} req
 * @param {object} res
 * @returns {boolean}
 */
export function requireVoiceForUser(req, res) {
  if (voiceAvailableFor(req)) return true;
  res.status(404).json({ error: 'not_found' });
  return false;
}

/**
 * The request-path gate. Async, because in gateway mode the allowlist may need
 * refreshing before the answer can be trusted.
 *
 * The master switch is checked FIRST and short-circuits, so a disabled
 * deployment never makes a network call -- an emergency stop must never wait on
 * the system it might be stopping.
 *
 * @param {object} req
 * @returns {Promise<boolean>}
 */
export async function voiceAvailableForAsync(req) {
  if (!voiceEnabled()) return false;
  await ensureAllowlistFresh();
  return userAllowed(resolveIdentity(req));
}

/** Where the allowlist is read from, and how stale it is. For /voice/health. */
export function allowlistDiagnostics() { return allowlistState(); }

/** 'env' or 'gateway'. */
export function currentAllowlistSource() { return allowlistSource(); }

export default {
  voiceEnabled, benchmarkState, gateState,
  requireVoiceEnabled, requireVoiceForUser,
  testUsers, resolveIdentity, userAllowed, voiceAvailableFor,
  voiceAvailableForAsync, allowlistDiagnostics, currentAllowlistSource,
  USER_ID_HEADER, TENANT_ID_HEADER,
};
