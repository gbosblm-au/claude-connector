// src/tools/ti-tools-client.js
//
// Thin client for the gateway's server-to-server /ti-tools endpoints, plus the
// session-identity resolver used by the Postgres-primary profile tools.
//
// Identity is resolved per call, in priority order, so it is concurrency-safe
// and never hardcoded to a single user:
//   1. per-call context supplied by the gateway on a proxied /tool-call
//   2. explicit tenant_id / user_id on the tool args
//   3. the connector session context (seeded at ts_gateway_session_init)
//   4. tenant only: TS_TENANT_ID (the owner connector's own tenant)
//
// When the user cannot be resolved, callers fall back to PROFILES.md on the
// volume (the store's designed degradation path).

import { log } from "../utils/logger.js";
import { getCurrentUser } from "../tools-self-model/sessionContext.js";

const GATEWAY_URL = (process.env.GATEWAY_URL || process.env.TS_TENANT_GATEWAY_URL || "").replace(/\/$/, "");
const ADMIN_KEY   = (process.env.GATEWAY_ADMIN_KEY || "").trim();
const TIMEOUT_MS  = 5000;

/** True when the connector is configured to reach the gateway ti-tools API. */
export function gatewayConfigured() {
  return Boolean(GATEWAY_URL && ADMIN_KEY);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/**
 * Resolve { tenantId, userId } for the current call.
 * @param {object|null} context  Per-call { tenant_id, user_id } from the gateway.
 * @param {object|null} args     Tool args (may carry tenant_id / user_id).
 * @returns {{ tenantId: string|null, userId: string|null }}
 */
export function resolveSessionIdentity(context = null, args = null) {
  const ctxTenant = context && (context.tenant_id ?? context.tenantId);
  const ctxUser   = context && (context.user_id  ?? context.userId);
  const argTenant = args && (args.tenant_id ?? args.tenantId);
  const argUser   = args && (args.user_id  ?? args.userId);

  let sc = { tenantId: null, userId: null };
  try { sc = getCurrentUser() || sc; } catch { /* self-model may be disabled */ }

  const tenantId = firstNonEmpty(ctxTenant, argTenant, sc.tenantId, process.env.TS_TENANT_ID);
  const userId   = firstNonEmpty(ctxUser, argUser, sc.userId);
  return { tenantId, userId };
}

async function callGateway(method, path, { body = null, query = null } = {}) {
  if (!gatewayConfigured()) {
    const err = new Error("gateway_not_configured");
    err.code = "gateway_not_configured";
    throw err;
  }
  let url = `${GATEWAY_URL}${path}`;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
    if (qs) url += `?${qs}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": ADMIN_KEY,
        "User-Agent": "claude-connector/12.26.0 (ti-tools-client)",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try { json = await resp.json(); } catch { json = null; }
    return { status: resp.status, ok: resp.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a user's profile from Postgres.
 * @returns {Promise<{existing:boolean, content?:string, revision?:number, updated_at?:string, source?:string}>}
 * @throws on network / non-(200|404) responses (caller falls back to volume).
 */
export async function profileReadRemote(tenantId, userId) {
  const { status, json } = await callGateway("POST", "/ti-tools/profile-read", {
    body: { tenant_id: tenantId, user_id: userId },
  });
  if (status === 200) return { existing: true, ...(json || {}) };
  if (status === 404) return { existing: false };
  const err = new Error(`profile-read failed: HTTP ${status}`);
  err.status = status;
  throw err;
}

/**
 * Write a user's profile to Postgres.
 * @returns {Promise<object>} the gateway response body ({ ok, changed, revision, ... }).
 * @throws on network / non-2xx responses.
 */
export async function profileWriteRemote({ tenantId, userId, mode, content, section, reason, source }) {
  const { status, ok, json } = await callGateway("POST", "/ti-tools/profile-write", {
    body: { tenant_id: tenantId, user_id: userId, mode, content, section, reason, source },
  });
  if (!ok) {
    const err = new Error(`profile-write failed: HTTP ${status}`);
    err.status = status;
    err.body = json;
    throw err;
  }
  return json || {};
}

/**
 * Aggregate module frequency for a user from self_model.
 * @returns {Promise<Array<{module_id:string, sessions_total:number, sessions_active:number, frequency:number}>>}
 * @throws on network / non-2xx responses.
 */
export async function moduleFrequencyRemote(tenantId, userId) {
  const { status, ok, json } = await callGateway("POST", "/ti-tools/module-frequency", {
    body: { tenant_id: tenantId, user_id: userId },
  });
  if (!ok) {
    const err = new Error(`module-frequency failed: HTTP ${status}`);
    err.status = status;
    throw err;
  }
  return Array.isArray(json?.modules) ? json.modules : [];
}

/**
 * Resolve the effective assistant name for a user.
 * @returns {Promise<{assistant_name:string, source:string}>}
 * @throws on network / non-2xx responses.
 */
export async function assistantNameRemote(tenantId, userId) {
  const { status, ok, json } = await callGateway("GET", "/ti-tools/assistant-name", {
    query: { tenant_id: tenantId, user_id: userId },
  });
  if (!ok) {
    const err = new Error(`assistant-name failed: HTTP ${status}`);
    err.status = status;
    throw err;
  }
  return json || { assistant_name: "Ava", source: "default" };
}
