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
 * everyone including an overridden student, and no identity is ever consulted.
 *
 * @returns {boolean}
 */
export function voiceEnabled() {
  const raw = process.env.VOICE_ENABLED;
  if (raw === undefined || raw === null) return false;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

// ===========================================================================
// LAYER B -- identity, and the gateway's entitlement claim
// ===========================================================================
//
// v13.37.0 (TENAX-VOICE-2026-10-07-02). The per-user allowlist is RETIRED, not
// repaired. Until 13.36.0 this layer read VOICE_TEST_USERS (or a copy fetched
// from the gateway) and admitted the identities on it, a permission list with
// two homes bridged by an operator pasting a generated string. Voice is now
// available to every account except students without an override (decisions
// D1 and D2), and that is a fact about the account row, which lives on the
// gateway. So the gateway decides it, per request, with one function
// (lib/voice-entitlement.js there), and the connector keeps no list at all.
//
// What is left here:
//
//   Identity    X-Tenax-User-Id, set by the gateway from the verified JWT. Its
//               PRESENCE is an explicit predicate (identityPresent): a request
//               with no user id is refused, as before.
//
//   The claim   X-Tenax-Voice-Entitlement, set by the gateway from the same
//               function that refuses at the stream. It decides what
//               /voice/health RENDERS for this user and nothing else. "A
//               header is a claim and not an authority: the connector renders
//               from it, never enforces with it, and the gateway still
//               refuses at the stream." (section 5). The routes do not read
//               it; the gateway does not forward a request it has refused.
//
// The transport credential (voice-auth.js) is what makes the headers worth
// reading: only the gateway's restore token or the operator's MCP key reaches
// these routes, and a browser holds neither.
//
// ---------------------------------------------------------------------------
// WHICH IDENTITY FIELD (settled in 12.47.0, unchanged)
// ---------------------------------------------------------------------------
//
// Not req.tsTenantId (a TENANT id: every user of a tenant shares it), and not
// the process-level session context seeded by ts_gateway_session_init (a
// process-wide singleton: whoever ran session-init last would set the identity
// every request is judged against). The per-call user id the gateway sends.

/** Identity headers, matching the field names the gateway already uses. */
export const USER_ID_HEADER = 'x-tenax-user-id';
export const TENANT_ID_HEADER = 'x-tenax-tenant-id';

/**
 * The gateway's per-request entitlement claim (v13.37.0). `entitled` means the
 * gateway's predicate allowed this user; anything else, including absence,
 * renders as not entitled.
 */
export const ENTITLEMENT_HEADER = 'x-tenax-voice-entitlement';
export const ENTITLED = 'entitled';

/**
 * Read the calling identity off a request.
 *
 * Deliberately does NOT fall back to the process-level session context: that
 * singleton is not concurrency-safe, and a gate that consults it can judge one
 * user's request against another's identity.
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
 * Is there an identity on this request? An explicit predicate (section 5:
 * "Identity presence as an explicit predicate, not an inherited side effect
 * of a lookup"). No identity is never "allowed by default".
 *
 * @param {{userId: string|null}} identity
 * @returns {boolean}
 */
export function identityPresent(identity) {
  return !!(identity && typeof identity.userId === 'string' && identity.userId.trim() !== '');
}

/**
 * Did the gateway claim this user is entitled? For RENDERING only.
 *
 * Exact match on one value: a header sent twice, a typo, or anything other
 * than `entitled` reads as not entitled, which renders nothing.
 *
 * @param {object} req
 * @returns {boolean}
 */
export function entitlementClaimed(req) {
  const v = req && req.headers ? req.headers[ENTITLEMENT_HEADER] : undefined;
  if (typeof v !== 'string') return false;
  return v.trim().toLowerCase() === ENTITLED;
}

/**
 * May this request reach a voice route? The master switch, then identity.
 *
 * The master switch is evaluated FIRST and short-circuits, so when voice is
 * globally off no identity is read at all, and nothing here ever makes a
 * network or database call: an emergency stop must never wait on anything
 * (claim C-08). Entitlement is not read here: the gateway enforced it before
 * forwarding (TENAX-VOICE-2026-10-07-02 section 5).
 *
 * @param {object} req
 * @returns {boolean}
 */
export function voiceAvailableFor(req) {
  if (!voiceEnabled()) return false;
  return identityPresent(resolveIdentity(req));
}

/**
 * Should the voice UI render for this request? The routes' answer AND the
 * gateway's entitlement claim. Read by /voice/health and gateState only.
 *
 * @param {object} req
 * @returns {boolean}
 */
export function voiceRenderableFor(req) {
  return voiceAvailableFor(req) && entitlementClaimed(req);
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
  // v13.37.0: rendered from the gateway's entitlement claim, never computed
  // here from a list.
  const forThisUser = on && voiceRenderableFor(req);

  return {
    enabled: on,
    // Section 2.2 / 4.2. This is the flag the UI must actually branch on.
    voice_enabled_for_this_user: forThisUser,
    // Render the voice UI at all. Keyed on the PER-USER answer, so a
    // user the gateway did not entitle emits nothing while the master switch is on --
    // the same "absent from the DOM, not merely hidden" discipline, scoped to
    // the requesting user.
    render_voice_ui: forThisUser,
    // Section 7: "If the gate is on but the engine fails to initialise, the UI
    // shows a degraded voice state". Degraded is NOT the same as off -- off
    // emits nothing, degraded emits a disabled control that explains itself.
    // Readiness is reported per-user too. A user who is not entitled seeing
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
 * Every refusal -- master switch off, no identity -- produces the
 * byte-identical 404 the global gate produced. Section 4.1: "never as 'route
 * exists but you are not allowed'". A user the gateway did not entitle never
 * reaches here: the gateway refuses before forwarding.
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

export default {
  voiceEnabled, benchmarkState, gateState,
  requireVoiceEnabled, requireVoiceForUser,
  resolveIdentity, identityPresent, entitlementClaimed, voiceAvailableFor, voiceRenderableFor,
  USER_ID_HEADER, TENANT_ID_HEADER, ENTITLEMENT_HEADER, ENTITLED,
};
