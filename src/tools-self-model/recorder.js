// src/tools-self-model/recorder.js
// Write path for the self-model database.
//
// Every function is defensive: it acquires the DB handle via getSelfModelDb()
// and no-ops silently (with a warn log) if the subsystem is unavailable. None
// of these functions throw, so they are safe to call from fire-and-forget hooks
// on the hot path of a tool call.
//
// v12.24.0: All gateway POSTs now include tenant_id and user_id from
// session context so self-model records are scoped per-user per-tenant.
// Gateway endpoint uses X-Admin-Key auth (for owner connector) OR tenant
// API key auth (for tenant connectors).

import { getSelfModelDb } from "./db.js";
import { log } from "../utils/logger.js";

const GATEWAY_URL = (process.env.GATEWAY_URL || process.env.TS_TENANT_GATEWAY_URL || "").replace(/\/$/, "");
const ADMIN_KEY = (process.env.GATEWAY_ADMIN_KEY || "").trim();

const nowIso = () => new Date().toISOString();

/**
 * Fire-and-forget POST to the gateway's self-model ingest endpoint.
 * Uses X-Admin-Key if available (owner connector), otherwise uses tenant
 * API key if TS_CLIENT_API_KEY is set (tenant connector).
 * Completely silent on failure — never throws, never logs warnings for
 * transient gateway blips. Logs a single debug line on hard failure.
 *
 * @param {string} eventType  - one of: session, module, tool, topic, insight, compile
 * @param {object} payload    - event data
 * @param {string|null} tenantId - from session context
 * @param {string|null} userId   - from session context
 */
function gatewayIngest(eventType, payload, tenantId, userId) {
  if (!GATEWAY_URL) return;

  const body = {
    event_type: eventType,
    data: payload,
    ingested_at: nowIso(),
  };

  // Per-user-per-tenant scoping: only attach identity when both are resolved.
  // If either is null, the record is still submitted so the session has data,
  // but the gateway will tag it with null tenant_id/user_id.
  if (tenantId) body.tenant_id = tenantId;
  if (userId) body.user_id = userId;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "claude-connector/12.24.0 (self-model-recorder)",
  };

  // Owner connector: use admin key header
  if (ADMIN_KEY) {
    headers["X-Admin-Key"] = ADMIN_KEY;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  fetch(`${GATEWAY_URL}/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(res => {
    if (!res.ok) {
      log("debug", `[self-model] gateway ingest ${eventType} returned ${res.status}`);
    }
  }).catch(() => {
    // Gateway unreachable — this is normal during startup or brief outages.
    // Data is preserved in SQLite.
  }).finally(() => {
    clearTimeout(timeout);
  });
}

/**
 * Import getCurrentUser lazily to avoid circular dependency at module scope.
 * @returns {{ tenantId: string|null, userId: string|null }}
 */
function currentUser() {
  try {
    const ctx = require("./sessionContext.js");
    return ctx.getCurrentUser();
  } catch {
    return { tenantId: null, userId: null };
  }
}

/**
 * @returns {{ tenantId: string|null, userId: string|null }}
 */
function resolveCurrentUser() {
  try {
    const mod = require("./sessionContext.js");
    return mod.getCurrentUser ? mod.getCurrentUser() : { tenantId: null, userId: null };
  } catch {
    return { tenantId: null, userId: null };
  }
}

// ── Import sessionContext dynamically (ESM circular-safe pattern) ─────────
let _sessionContext = null;
function getSessionContext() {
  if (!_sessionContext) {
    try {
      // Dynamic import avoids the circular dependency at module scope:
      // sessionContext.js does not import recorder.js.
      // This is safe because the recording hooks are never called during
      // module initialisation — they fire after the dispatch loop starts.
      _sessionContext = import("./sessionContext.js");
    } catch {
      return null;
    }
  }
  return _sessionContext;
}

/**
 * Ensure a session_log row exists and refresh its liveness (end_time,
 * message_count). Called on every recorded event so the row always reflects
 * the latest activity even if no explicit close fires.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.incrementMessage=false] Count this event as a turn.
 * @returns {void}
 */
export function touchSession(sessionId, opts = {}) {
  const db = getSelfModelDb();
  if (!db || !sessionId) return;
  try {
    const ts = nowIso();
    const inc = opts.incrementMessage ? 1 : 0;
    db.prepare(`
      INSERT INTO session_log (id, start_time, end_time, message_count)
      VALUES (@id, @ts, @ts, @inc)
      ON CONFLICT(id) DO UPDATE SET
        end_time      = @ts,
        message_count = session_log.message_count + @inc
    `).run({ id: sessionId, ts, inc });

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      gatewayIngest("session", {
        session_id: sessionId,
        message_count_increment: inc,
        last_activity: ts,
      }, user.tenantId, user.userId);
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] touchSession failed: ${err.message}`);
  }
}

/**
 * Record a single tool call: increment call_count and accumulate duration.
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @param {number} [durationMs=0]
 * @returns {void}
 */
export function recordToolCall(sessionId, toolName, durationMs = 0) {
  const db = getSelfModelDb();
  if (!db || !sessionId || !toolName) return;
  try {
    const dur = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
    db.prepare(`
      INSERT INTO tool_usage (session_id, tool_name, call_count, total_duration_ms)
      VALUES (@sid, @tool, 1, @dur)
      ON CONFLICT(session_id, tool_name) DO UPDATE SET
        call_count        = tool_usage.call_count + 1,
        total_duration_ms = tool_usage.total_duration_ms + @dur
    `).run({ sid: sessionId, tool: toolName, dur });

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      gatewayIngest("tool", {
        session_id: sessionId,
        tool_name: toolName,
        call_count_increment: 1,
        duration_ms: dur,
      }, user.tenantId, user.userId);
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] recordToolCall failed: ${err.message}`);
  }
}

/**
 * Record module activations for a compiled skill. Increments load_count for
 * each module id and attributes an equal share of compile time to each.
 *
 * @param {string} sessionId
 * @param {string[]} moduleIds
 * @param {number} [compileTimeMs=0] Total compile time to attribute across modules.
 * @returns {void}
 */
export function recordModuleActivations(sessionId, moduleIds, compileTimeMs = 0) {
  const db = getSelfModelDb();
  if (!db || !sessionId || !Array.isArray(moduleIds) || moduleIds.length === 0) return;
  try {
    const perModule = Number.isFinite(compileTimeMs) && compileTimeMs > 0
      ? Math.round(compileTimeMs / moduleIds.length)
      : 0;
    const stmt = db.prepare(`
      INSERT INTO module_activations (session_id, module_id, load_count, total_time_active)
      VALUES (@sid, @mid, 1, @dur)
      ON CONFLICT(session_id, module_id) DO UPDATE SET
        load_count        = module_activations.load_count + 1,
        total_time_active = module_activations.total_time_active + @dur
    `);
    const tx = db.transaction((ids) => {
      for (const mid of ids) {
        if (typeof mid === "string" && mid.trim()) {
          stmt.run({ sid: sessionId, mid: mid.trim(), dur: perModule });
        }
      }
    });
    tx(moduleIds);

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      for (const mid of moduleIds) {
        if (typeof mid === "string" && mid.trim()) {
          gatewayIngest("module", {
            session_id: sessionId,
            module_id: mid.trim(),
            time_active_ms: perModule,
          }, user.tenantId, user.userId);
        }
      }
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] recordModuleActivations failed: ${err.message}`);
  }
}

/**
 * Record a compile event in compile_history.
 *
 * @param {string} sessionId
 * @param {object} info
 * @param {number} [info.compile_time_ms]
 * @param {number} [info.modules_loaded_count]
 * @param {string} [info.manifest_version]
 * @returns {void}
 */
export function recordCompile(sessionId, info = {}) {
  const db = getSelfModelDb();
  if (!db || !sessionId) return;
  try {
    db.prepare(`
      INSERT INTO compile_history
        (session_id, compile_time_ms, modules_loaded_count, manifest_version, created_at)
      VALUES (@sid, @ct, @mlc, @mv, @ts)
    `).run({
      sid: sessionId,
      ct:  Number.isFinite(info.compile_time_ms) ? Math.round(info.compile_time_ms) : null,
      mlc: Number.isFinite(info.modules_loaded_count) ? info.modules_loaded_count : null,
      mv:  typeof info.manifest_version === "string" ? info.manifest_version : null,
      ts:  nowIso(),
    });

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      gatewayIngest("compile", {
        session_id: sessionId,
        compile_time_ms: info.compile_time_ms || null,
        modules_loaded_count: info.modules_loaded_count || null,
        manifest_version: info.manifest_version || null,
      }, user.tenantId, user.userId);
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] recordCompile failed: ${err.message}`);
  }
}

/**
 * Finalise a session: set end_time, message_count (if provided) and the
 * natural-language topic_summary. Also writes a session_timing row derived from
 * the session's start time and duration.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.topicSummary]
 * @returns {void}
 */
export function closeSession(sessionId, opts = {}) {
  const db = getSelfModelDb();
  if (!db || !sessionId) return;
  try {
    const ts = nowIso();
    const info = db.prepare(`
      SELECT start_time, message_count FROM session_log WHERE id = ?
    `).get(sessionId);

    const startIso = info?.start_time || ts;
    const msgCount = info?.message_count || 0;

    db.prepare(`
      UPDATE session_log SET
        end_time      = @ts,
        message_count = @msgCount,
        topic_summary = @topic
      WHERE id = @sid
    `).run({
      sid: sessionId,
      ts,
      msgCount,
      topic: opts.topicSummary || null,
    });

    // Derive session_timing from start time
    const startMs = new Date(startIso).getTime();
    if (Number.isFinite(startMs)) {
      const nowMs = Date.now();
      const durMin = Math.round((nowMs - startMs) / 60000);
      const startDate = new Date(startMs);
      db.prepare(`
        INSERT INTO session_timing (session_id, day_of_week, hour_of_day, duration_minutes)
        VALUES (@sid, @dow, @hod, @dur)
        ON CONFLICT(session_id) DO UPDATE SET
          day_of_week      = @dow,
          hour_of_day      = @hod,
          duration_minutes = @dur
      `).run({
        sid: sessionId,
        dow: startDate.getUTCDay(),
        hod: startDate.getUTCHours(),
        dur: durMin,
      });
    }

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      gatewayIngest("session", {
        session_id: sessionId,
        status: "complete",
        message_count: msgCount,
        topic_summary: opts.topicSummary || null,
        end_time: ts,
      }, user.tenantId, user.userId);
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] closeSession failed: ${err.message}`);
  }
}

/**
 * Write a self-model insight row.
 *
 * @param {object} insight
 * @param {string} [insight.sessionId]
 * @param {string} insight.category
 * @param {string} insight.text
 * @param {string} [insight.sourceModule]
 * @param {number} [insight.confidence]
 * @returns {void}
 */
export function recordInsight(insight) {
  const db = getSelfModelDb();
  if (!db) return;
  try {
    const cat = String(insight.category || "general").trim();
    const txt = String(insight.text || "").trim();
    if (!cat || !txt) return;

    db.prepare(`
      INSERT INTO self_insights (session_id, category, insight_text, source_module, confidence, created_at)
      VALUES (@sid, @cat, @txt, @mod, @conf, @ts)
    `).run({
      sid: insight.sessionId || null,
      cat,
      txt,
      mod: insight.sourceModule || null,
      conf: Number.isFinite(insight.confidence) ? insight.confidence : null,
      ts: nowIso(),
    });

    // Fire-and-forget gateway POST
    getSessionContext().then(ctx => {
      const user = ctx ? ctx.getCurrentUser() : { tenantId: null, userId: null };
      gatewayIngest("insight", {
        session_id: insight.sessionId || null,
        category: cat,
        text: txt,
        source_module: insight.sourceModule || null,
        confidence: insight.confidence || null,
      }, user.tenantId, user.userId);
    }).catch(() => {});
  } catch (err) {
    log("warn", `[self-model] recordInsight failed: ${err.message}`);
  }
}