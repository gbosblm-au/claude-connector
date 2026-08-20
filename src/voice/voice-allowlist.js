// src/voice/voice-allowlist.js
//
// Tenax Voice -- where the per-user allowlist comes from.
//
// ===========================================================================
// WHY THIS MODULE EXISTS: THE REVOKE-DRIFT FAILURE
// ===========================================================================
//
// v12.47.0 read the allowlist from VOICE_TEST_USERS, a Railway environment
// variable. ts-client-gateway v5.129.0 then added an admin screen that records
// grants in ti_users.voice_enabled and GENERATES that string for an operator to
// paste back into Railway.
//
// That leaves two sources of truth bridged only by a human remembering to copy.
// The two drift directions are not equally bad, and the asymmetry is the point:
//
//   GRANT and forget to sync   -> the user has no voice. Annoying. SAFE.
//   REVOKE and forget to sync  -> the user KEEPS voice. The console says off,
//                                 the connector says on, and nobody finds out
//                                 until someone who should not have voice is
//                                 using it.
//
// The second is a security-relevant lie told by an admin screen, and it is
// exactly the class of failure that goes unnoticed. A notice on the screen is
// not a fix: it relies on the operator being careful every single time, which
// is the assumption that fails.
//
// So the connector can now read the allowlist FROM THE GATEWAY directly. One
// source of truth, and drift becomes structurally impossible rather than
// merely discouraged.
//
// ===========================================================================
// WHAT DID NOT CHANGE, AND WHY
// ===========================================================================
//
// VOICE_ENABLED remains an environment variable and remains the master kill
// switch. That is its correct role: an emergency stop must not depend on a
// network call to the very system it might be stopping. If the gateway is
// compromised, unreachable, or serving nonsense, VOICE_ENABLED=false still
// kills voice for everyone, immediately, with no dependency on anything.
//
// Env mode also remains the DEFAULT. Switching an existing deployment's
// security gate to a network dependency without being asked would be a worse
// decision than the drift it fixes.
//
// ===========================================================================
// FAILURE BEHAVIOUR: BOUNDED STALENESS, THEN CLOSED
// ===========================================================================
//
// A network read on a security path has to answer "what if it fails?".
//
//   Deny immediately on any error -- a one-second gateway blip cuts voice off
//     mid-sentence. Too brittle to be the right answer, and an operator whose
//     voice keeps dropping will move to env mode, which is worse.
//
//   Serve the last good answer forever -- reinvents the unbounded drift this
//     module exists to remove, only now invisibly.
//
// So: serve the last good answer for a BOUNDED window, then deny everyone.
// Staleness is capped at VOICE_ALLOWLIST_MAX_STALE_MS (default five minutes)
// rather than lasting until someone remembers to paste. A revoke propagates
// within one TTL normally, and within the stale cap in the worst case.
//
// With no snapshot at all -- first request, gateway down -- the answer is deny.
// A gate that fails open on startup is not a gate.

// v13.2.0. The only import this module needs: deploymentConfigProblems below
// checks whether pinned interpreter and artifact paths actually exist, and a
// path that is merely a string tells an operator nothing.
import { existsSync } from 'node:fs';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_STALE_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const cache = {
  entries: null,      // string[] | null. null means "never successfully fetched"
  fetchedAt: 0,
  refreshing: null,   // in-flight promise, so concurrent requests share one fetch
  lastError: null,
  lastErrorAt: 0,
};

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Where the allowlist comes from: 'env' or 'gateway'.
 *
 * Defaults to 'env'. Only the exact string 'gateway' switches over, matching
 * the strictness of VOICE_ENABLED -- a typo must not silently change where a
 * security gate reads its data from.
 */
export function allowlistSource() {
  const raw = String(process.env.VOICE_ALLOWLIST_SOURCE || '').trim().toLowerCase();
  return raw === 'gateway' ? 'gateway' : 'env';
}

export function allowlistConfig() {
  return {
    source: allowlistSource(),
    url: String(process.env.VOICE_ALLOWLIST_URL || '').replace(/\/$/, ''),
    key: String(process.env.VOICE_ALLOWLIST_KEY || process.env.GATEWAY_ADMIN_KEY || ''),
    ttlMs: intEnv('VOICE_ALLOWLIST_TTL_MS', DEFAULT_TTL_MS),
    maxStaleMs: intEnv('VOICE_ALLOWLIST_MAX_STALE_MS', DEFAULT_MAX_STALE_MS),
    timeoutMs: intEnv('VOICE_ALLOWLIST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Split a comma-separated allowlist string into entries.
 *
 * Shared by both sources so env mode and gateway mode cannot disagree about
 * what an entry is. Empty entries are dropped: an empty string would match a
 * caller who sent no identity at all, so a trailing comma would otherwise be an
 * open door.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseAllowlist(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Fetch the allowlist from the gateway.
 *
 * Reads `voice_test_users` -- the same field the admin screen shows for pasting
 * -- so both modes consume the identical string and a deployment can switch
 * between them without the meaning changing.
 *
 * @returns {Promise<string[]>}
 */
async function fetchFromGateway() {
  const cfg = allowlistConfig();
  if (!cfg.url) throw new Error('VOICE_ALLOWLIST_URL is not set.');
  if (!cfg.key) throw new Error('VOICE_ALLOWLIST_KEY (or GATEWAY_ADMIN_KEY) is not set.');

  const res = await fetch(`${cfg.url}/admin/ti-users/voice-access/allowlist`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!res.ok) throw new Error(`gateway returned HTTP ${res.status}`);

  const body = await res.json();
  // The field must be a STRING and must be present. A missing field is a
  // contract change, not an empty allowlist -- treating it as empty would
  // revoke everyone silently, and treating it as an error keeps the last good
  // snapshot until the stale cap, which is the safer failure.
  if (typeof body.voice_test_users !== 'string') {
    throw new Error('gateway response has no voice_test_users string');
  }
  return parseAllowlist(body.voice_test_users);
}

/**
 * Make sure the cached allowlist is fresh enough to use.
 *
 * A no-op in env mode. In gateway mode it refreshes when the TTL has expired
 * and is safe to await on every request: a fresh cache returns immediately.
 *
 * Concurrent callers share one in-flight fetch, so a burst of voice requests
 * after the TTL expires produces one gateway call, not one per request.
 *
 * @returns {Promise<void>}
 */
export async function ensureAllowlistFresh() {
  if (allowlistSource() !== 'gateway') return;

  const cfg = allowlistConfig();
  const age = Date.now() - cache.fetchedAt;
  if (cache.entries !== null && age < cfg.ttlMs) return;

  if (cache.refreshing) { await cache.refreshing; return; }

  cache.refreshing = (async () => {
    try {
      const entries = await fetchFromGateway();
      cache.entries = entries;
      cache.fetchedAt = Date.now();
      cache.lastError = null;
    } catch (err) {
      cache.lastError = err.message;
      cache.lastErrorAt = Date.now();
      // Never logs the entries themselves -- they are account identifiers.
      console.warn(`[voice] allowlist refresh failed: ${err.message}`);
    } finally {
      cache.refreshing = null;
    }
  })();

  await cache.refreshing;
}

/**
 * The allowlist entries to enforce right now. Synchronous.
 *
 * In gateway mode this reads the cached snapshot, which is why callers on the
 * request path await ensureAllowlistFresh() first. Returning [] here means
 * "deny everyone", and it is what happens when the snapshot is missing or has
 * aged past the stale cap.
 *
 * @returns {string[]}
 */
export function currentAllowlist() {
  if (allowlistSource() !== 'gateway') {
    return parseAllowlist(process.env.VOICE_TEST_USERS);
  }

  // Never fetched successfully: deny. A gate that fails open on startup is not
  // a gate.
  if (cache.entries === null) return [];

  const cfg = allowlistConfig();
  const age = Date.now() - cache.fetchedAt;
  if (age > cfg.maxStaleMs) {
    // Past the cap. The snapshot is old enough that a revoke could already have
    // gone unnoticed for longer than the deployment accepts, so it stops being
    // trusted. Loud, because voice going dark for everyone needs a reason in
    // the logs an operator can find.
    console.error(
      `[voice] allowlist is ${Math.round(age / 1000)}s stale (cap `
      + `${Math.round(cfg.maxStaleMs / 1000)}s); refusing all voice requests until a `
      + `refresh succeeds. Last error: ${cache.lastError || 'none'}`);
    return [];
  }
  return cache.entries;
}

/**
 * Configuration faults that make voice unreachable no matter what else is set.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A deployment set VOICE_ALLOWLIST_SOURCE=gateway and VOICE_ENABLED=true, but no
 * VOICE_ALLOWLIST_URL. In gateway mode the env allowlist is ignored, the fetch
 * cannot be attempted, currentAllowlist() returns [] and every user is denied.
 *
 * That is correct fail-closed behaviour, and it is INDISTINGUISHABLE from the
 * outside from voice simply being switched off: no mic button, no error, and
 * VOICE_TEST_USERS sitting in the variable list looking like it should be doing
 * something. The operator cannot tell a misconfiguration from a working "off".
 *
 * So the faults are named and reported by /voice/health. A silent correct
 * refusal is still a support call.
 *
 * @returns {string[]} Empty when the configuration is coherent.
 */
/**
 * Deployment faults OUTSIDE the allowlist that make voice, or its output,
 * unusable.
 *
 * v13.2.0. Same philosophy as allowlistConfigProblems below, applied to the rest
 * of the deployment: a silent correct refusal is still a support call.
 *
 * Reported by /voice/health and logged once at boot. Nothing here throws -- a
 * connector with a bad voice configuration must still serve everything else.
 *
 * @returns {string[]} Empty when the configuration is coherent.
 */
export function deploymentConfigProblems() {
  const problems = [];

  // CONNECTOR_URL is not a voice variable, and it is named here because its
  // absence produced the hardest-to-diagnose bug in this system: documents that
  // rendered successfully and came back with no way to open them. v13.1.1 made
  // that render FAIL rather than return an unusable success -- but a failure an
  // operator has to trigger to discover is still worse than a line at boot
  // naming the variable.
  if (!String(process.env.CONNECTOR_URL || '').trim()) {
    problems.push(
      'CONNECTOR_URL is not set, so no download link can be built for any '
      + 'rendered document or audio file. Rendering reports no_output_produced. '
      + "Set it to this service's public base URL.");
  }

  // A pinned interpreter that is not there. Reported rather than guessed at,
  // because the TTS supervisor deliberately declines rather than falling back to
  // a bare `python3` -- the system interpreter is the one we can be confident
  // does NOT have kokoro-onnx installed.
  for (const [name, effect] of [
    ['VOICE_PYTHON_BIN', 'Speech-to-text will fail on the first request'],
    ['VOICE_KOKORO_PYTHON', 'Text-to-speech cannot start'],
  ]) {
    const bin = String(process.env[name] || '').trim();
    if (bin && !existsSync(bin)) {
      problems.push(`${name} is set to "${bin}", which does not exist. ${effect}. `
        + 'Unset it to use the image default.');
    }
  }

  // A pinned artifact path that is not there. The resolver honours an explicit
  // path even when the file is absent, precisely so this is visible rather than
  // silently running different weights -- but it has to be SAID.
  for (const [name, label] of [
    ['VOICE_KOKORO_MODEL', 'model'],
    ['VOICE_KOKORO_VOICES', 'voice bundle'],
  ]) {
    const pinned = String(process.env[name] || '').trim();
    if (pinned && !existsSync(pinned)) {
      problems.push(`${name} is pinned to "${pinned}", which does not exist, so `
        + `the ${label} baked into the image is NOT being used. Unset it to fall `
        + 'back to the image copy.');
    }
  }

  return problems;
}

export function allowlistConfigProblems() {
  const cfg = allowlistConfig();
  const problems = [];

  if (cfg.source === 'gateway') {
    if (!cfg.url) {
      problems.push(
        'VOICE_ALLOWLIST_SOURCE=gateway but VOICE_ALLOWLIST_URL is not set, so the '
        + 'allowlist cannot be fetched and every user is denied. Set it to the gateway '
        + 'base URL, or set VOICE_ALLOWLIST_SOURCE=env to use VOICE_TEST_USERS.');
    }
    if (!cfg.key) {
      problems.push(
        'VOICE_ALLOWLIST_SOURCE=gateway but neither VOICE_ALLOWLIST_KEY nor '
        + 'GATEWAY_ADMIN_KEY is set, so the gateway will reject the request.');
    }
    // Named specifically: the variable is present and looks operative, and that
    // is exactly what makes it misleading.
    if (process.env.VOICE_TEST_USERS) {
      problems.push(
        'VOICE_TEST_USERS is set but IGNORED, because VOICE_ALLOWLIST_SOURCE=gateway. '
        + 'The allowlist comes from the gateway in this mode.');
    }
  } else if (!parseAllowlist(process.env.VOICE_TEST_USERS).length) {
    problems.push(
      'VOICE_TEST_USERS is empty, so no user can use voice even though VOICE_ENABLED '
      + 'is true. Add <tenant_id>:<user_id> entries, or paste the value generated by '
      + 'the Voice Access admin screen.');
  }

  return problems;
}

/** Diagnostics for /voice/health. Never includes the entries themselves. */
export function allowlistState() {
  const cfg = allowlistConfig();
  const source = cfg.source;
  if (source !== 'gateway') {
    return {
      source: 'env',
      problems: allowlistConfigProblems(),
      count: parseAllowlist(process.env.VOICE_TEST_USERS).length,
      // Surfaced so an operator can see, from health alone, that this
      // deployment is the one where a revoke needs a manual paste.
      drift_risk: 'A revoke in the admin screen does not take effect until '
        + 'VOICE_TEST_USERS is updated on this connector and it is redeployed.',
    };
  }

  const age = cache.fetchedAt ? Date.now() - cache.fetchedAt : null;
  return {
    source: 'gateway',
    problems: allowlistConfigProblems(),
    count: cache.entries === null ? 0 : cache.entries.length,
    fetched: cache.entries !== null,
    age_seconds: age === null ? null : Math.round(age / 1000),
    ttl_seconds: Math.round(cfg.ttlMs / 1000),
    max_stale_seconds: Math.round(cfg.maxStaleMs / 1000),
    stale: age !== null && age > cfg.maxStaleMs,
    last_error: cache.lastError,
    drift_risk: null,
  };
}

/** Test seam: drop the cached snapshot. */
export function resetAllowlistCache() {
  cache.entries = null;
  cache.fetchedAt = 0;
  cache.refreshing = null;
  cache.lastError = null;
  cache.lastErrorAt = 0;
}

export default {
  allowlistSource, allowlistConfig, parseAllowlist, allowlistConfigProblems,
  ensureAllowlistFresh, currentAllowlist, allowlistState, resetAllowlistCache,
};
