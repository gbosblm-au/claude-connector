// src/tools-self-model/recorder.js
// Write path for the self-model database.
//
// Every function is defensive: it acquires the DB handle via getSelfModelDb()
// and no-ops silently (with a warn log) if the subsystem is unavailable. None
// of these functions throw, so they are safe to call from fire-and-forget hooks
// on the hot path of a tool call.
//
// v12.25.0: Identity (tenant_id, user_id) is now passed in explicitly by the
// caller (the self-model hook resolves it from the gateway-supplied per-call
// context, falling back to the process session context). This removes the two
// previous defects:
//   1. The async dynamic import() of sessionContext, which raced the write and
//      often resolved after the POST was already sent with null identity.
//   2. The process.env.TENANT_ID / process.env.USER_ID hardcode fallbacks,
//      which are wrong for a multi-user connector and were explicitly rejected.
// The local SQLite writes are unchanged; identity only scopes the gateway POST.

import { getSelfModelDb } from "./db.js";
import { log } from "../utils/logger.js";

const GATEWAY_URL = (process.env.GATEWAY_URL || process.env.TS_TENANT_GATEWAY_URL || "").replace(/\/$/, "");
const ADMIN_KEY = (process.env.GATEWAY_ADMIN_KEY || "").trim();

const nowIso = () => new Date().toISOString();

/**
 * Normalise a caller-supplied identity object to { tenantId, userId } with
 * null defaults. Accepts either shape ({tenantId,userId} or {tenant_id,user_id})
 * so it is tolerant of both the hook's output and any direct caller.
 *
 * @param {object|null|undefined} identity
 * @returns {{ tenantId: string|null, userId: string|null }}
 */
function normaliseIdentity(identity) {
  if (!identity || typeof identity !== "object") return { tenantId: null, userId: null };
  const t = identity.tenantId ?? identity.tenant_id ?? null;
  const u = identity.userId ?? identity.user_id ?? null;
  return {
    tenantId: (t !== null && t !== undefined && String(t).trim() !== "") ? String(t).trim() : null,
    userId:   (u !== null && u !== undefined && String(u).trim() !== "") ? String(u).trim() : null,
  };
}

/**
 * Fire-and-forget POST to the gateway's self-model ingest endpoint.
 * Sends the tenant_id and user_id exactly as resolved for this call. When the
 * identity is unknown (null), the fields are sent as null and the gateway
 * records the row with null scope rather than guessing — the connector never
 * fabricates or hardcodes an identity.
 *
 * Completely silent on failure: never throws, and only logs a debug line on a
 * non-OK response. The local SQLite copy is the durable buffer.
 *
 * @param {string} eventType  One of: session, module, tool, topic, insight, compile.
 * @param {object} payload    Event data.
 * @param {{tenantId: string|null, userId: string|null}} identity  Resolved identity.
 */
function gatewayIngest(eventType, payload, identity) {
  if (!GATEWAY_URL) return;

  const { tenantId, userId } = normaliseIdentity(identity);

  const body = {
    event_type: eventType,
    data: payload,
    ingested_at: nowIso(),
    tenant_id: tenantId,
    user_id: userId,
  };

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "claude-connector/12.25.0 (self-model-recorder)",
  };

  // Owner connector authenticates the ingest with the shared admin key. The
  // per-record identity is carried in the body (above), independent of auth.
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
    // Gateway unreachable — normal during startup or brief outages. Data is
    // preserved in SQLite.
  }).finally(() => {
    clearTimeout(timeout);
  });
}

/**
 * Ensure a session_log row exists and refresh its liveness (end_time,
 * message_count). Called on every recorded event so the row always reflects
 * the latest activity even if no explicit close fires.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.incrementMessage=false] Count this event as a turn.
 * @param {{tenantId,userId}} [opts.identity] Resolved identity for the gateway POST.
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

    gatewayIngest("session", {
      session_id: sessionId,
      message_count_increment: inc,
      last_activity: ts,
    }, opts.identity);
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
 * @param {{tenantId,userId}} [identity]
 * @returns {void}
 */
export function recordToolCall(sessionId, toolName, durationMs = 0, identity = null) {
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

    gatewayIngest("tool", {
      session_id: sessionId,
      tool_name: toolName,
      call_count_increment: 1,
      duration_ms: dur,
    }, identity);
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
 * @param {{tenantId,userId}} [identity]
 * @returns {void}
 */
export function recordModuleActivations(sessionId, moduleIds, compileTimeMs = 0, identity = null) {
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

    for (const mid of moduleIds) {
      if (typeof mid === "string" && mid.trim()) {
        gatewayIngest("module", {
          session_id: sessionId,
          module_id: mid.trim(),
          time_active_ms: perModule,
        }, identity);
      }
    }
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
 * @param {{tenantId,userId}} [identity]
 * @returns {void}
 */
export function recordCompile(sessionId, info = {}, identity = null) {
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

    gatewayIngest("compile", {
      session_id: sessionId,
      compile_time_ms: info.compile_time_ms || null,
      modules_loaded_count: info.modules_loaded_count || null,
      manifest_version: info.manifest_version || null,
    }, identity);
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
 * @param {{tenantId,userId}} [opts.identity]
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

    gatewayIngest("session", {
      session_id: sessionId,
      status: "complete",
      message_count: msgCount,
      topic_summary: opts.topicSummary || null,
      end_time: ts,
    }, opts.identity);
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
 * @param {{tenantId,userId}} [identity]
 * @returns {void}
 */
export function recordInsight(insight, identity = null) {
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

    gatewayIngest("insight", {
      session_id: insight.sessionId || null,
      category: cat,
      text: txt,
      source_module: insight.sourceModule || null,
      confidence: insight.confidence || null,
    }, identity || insight.identity || null);
  } catch (err) {
    log("warn", `[self-model] recordInsight failed: ${err.message}`);
  }
}
