// src/tools-self-model/recorder.js
// Write path for the self-model database.
//
// Every function is defensive: it acquires the DB handle via getSelfModelDb()
// and no-ops silently (with a warn log) if the subsystem is unavailable. None
// of these functions throw, so they are safe to call from fire-and-forget hooks
// on the hot path of a tool call.

import { getSelfModelDb } from "./db.js";
import { log } from "../utils/logger.js";

const nowIso = () => new Date().toISOString();

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
 * @param {string} [opts.startTime] ISO-8601 start; falls back to stored start_time.
 * @param {number} [opts.messageCount]
 * @param {string} [opts.topicSummary]
 * @returns {void}
 */
export function closeSession(sessionId, opts = {}) {
  const db = getSelfModelDb();
  if (!db || !sessionId) return;
  try {
    const endTs = nowIso();

    // Ensure the row exists before we read start_time back.
    touchSession(sessionId);

    const row = db.prepare(`SELECT start_time, message_count FROM session_log WHERE id = ?`).get(sessionId);
    const startTime = opts.startTime || (row && row.start_time) || endTs;

    db.prepare(`
      UPDATE session_log SET
        end_time      = @end,
        message_count = COALESCE(@mc, message_count),
        topic_summary = COALESCE(@ts, topic_summary)
      WHERE id = @sid
    `).run({
      sid: sessionId,
      end: endTs,
      mc:  Number.isFinite(opts.messageCount) ? opts.messageCount : null,
      ts:  typeof opts.topicSummary === "string" ? opts.topicSummary : null,
    });

    // Derive timing row.
    const start = new Date(startTime);
    const end = new Date(endTs);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const durationMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
      db.prepare(`
        INSERT INTO session_timing (session_id, day_of_week, hour_of_day, duration_minutes)
        VALUES (@sid, @dow, @hod, @dur)
        ON CONFLICT(session_id) DO UPDATE SET
          day_of_week      = @dow,
          hour_of_day      = @hod,
          duration_minutes = @dur
      `).run({
        sid: sessionId,
        dow: start.getUTCDay(),
        hod: start.getUTCHours(),
        dur: durationMinutes,
      });
    }
  } catch (err) {
    log("warn", `[self-model] closeSession failed: ${err.message}`);
  }

  // Phase 6: mirror this session's rows to the gateway self-model store when
  // dual-write is enabled. Fire and forget, fully guarded.
  dualWriteIngestToGateway(sessionId);
}

/**
 * Best-effort ingest of a session's rows (log, module activations, tool usage,
 * topic clusters) to the gateway self-model API. Enabled only when
 * SELF_MODEL_DUAL_WRITE=1 and GATEWAY_URL is set. Never throws into the caller.
 */
function dualWriteIngestToGateway(sessionId) {
  try {
    if (process.env.SELF_MODEL_DUAL_WRITE !== "1") return;
    const base = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
    const token = process.env.GATEWAY_API_KEY || "";
    if (!base || !sessionId || typeof fetch !== "function") return;

    const db = getSelfModelDb();
    if (!db) return;

    const logRow = db.prepare(
      `SELECT start_time, end_time, message_count, topic_summary FROM session_log WHERE id = ?`
    ).get(sessionId) || {};
    const modules = db.prepare(
      `SELECT module_id, load_count, total_time_active AS total_time_ms FROM module_activations WHERE session_id = ?`
    ).all(sessionId);
    const tools = db.prepare(
      `SELECT tool_name, call_count, total_duration_ms FROM tool_usage WHERE session_id = ?`
    ).all(sessionId);
    let topics = [];
    try {
      topics = db.prepare(
        `SELECT topic_keyword, weight FROM topic_clusters WHERE session_id = ?`
      ).all(sessionId);
    } catch { topics = []; }  // topic_clusters may carry no weight column in older schemas

    const payload = {
      session_id: sessionId,
      log: {
        start_time: logRow.start_time || null,
        end_time: logRow.end_time || null,
        message_count: Number.isFinite(logRow.message_count) ? logRow.message_count : null,
        topic_summary: logRow.topic_summary || null,
        status: "closed",
      },
      module_activations: modules,
      tool_usage: tools,
      topic_clusters: topics,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch(`${base}/ti-self-model/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => { /* swallow: SQLite is source of truth */ })
      .finally(() => clearTimeout(timer));
  } catch { /* never let dual-write affect the primary path */ }
}

/**
 * Write a self-insight row (used by summariser output surfaced from Node, and
 * available for Phase 2/3 producers).
 *
 * @param {object} insight
 * @param {string} insight.text
 * @param {string} [insight.sessionId]
 * @param {string} [insight.category='observation']
 * @param {string} [insight.sourceModule]
 * @returns {void}
 */
export function recordInsight(insight = {}) {
  const db = getSelfModelDb();
  if (!db || !insight.text) return;
  try {
    db.prepare(`
      INSERT INTO self_insights (session_id, insight_text, category, source_module, created_at)
      VALUES (@sid, @text, @cat, @src, @ts)
    `).run({
      sid:  insight.sessionId || null,
      text: String(insight.text),
      cat:  insight.category || "observation",
      src:  insight.sourceModule || null,
      ts:   nowIso(),
    });
  } catch (err) {
    log("warn", `[self-model] recordInsight failed: ${err.message}`);
  }
}
