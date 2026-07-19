// src/tools-self-model/hook.js
// Fire-and-forget per-turn recorder wired into the connector's tool dispatch.
//
// This is the "session close protocol" write path from the specification,
// realised incrementally: rather than batching writes at session close (where
// state can be lost if a session ends abruptly), module_activations and
// tool_usage are written after every turn. session_log liveness is refreshed on
// each event, and session_timing is derived at close.
//
// The hook must never affect a tool call's success. It swallows all errors and
// returns nothing.

import { isSelfModelEnabled } from "./db.js";
import {
  recordToolCall,
  recordModuleActivations,
  recordCompile,
  touchSession,
  closeSession,
} from "./recorder.js";
import { resolveSessionId, beginSession } from "./sessionContext.js";
import { log } from "../utils/logger.js";

/**
 * Best-effort extraction of the compiled-skill result payload from an MCP tool
 * result. skill_compile returns its JSON as text in content[0].text.
 * @param {object} result
 * @returns {object|null}
 */
function parseCompileResult(result) {
  try {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return null;
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record one completed tool call. Called from dispatchToolCall after the core
 * handler returns. Safe to call unconditionally.
 *
 * @param {string} name    Tool name.
 * @param {object} args    Tool arguments (may carry an explicit session id).
 * @param {object} result  MCP result object { content, isError }.
 * @param {number} startedAt  performance timestamp (ms) captured before dispatch.
 * @returns {void}
 */
export function selfModelRecordToolCall(name, args, result, startedAt) {
  if (!isSelfModelEnabled()) return;
  try {
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;

    // Session lifecycle: session-init opens a session; other tools resolve the
    // current one.
    let sessionId;
    if (name === "ts_gateway_session_init") {
      const explicit = (args && typeof args === "object" &&
        (args.session_id || args._session_id || args.sessionId)) || null;
      sessionId = beginSession(explicit || "").id;
    } else {
      sessionId = resolveSessionId(args);
    }

    // Every tool call is a turn.
    touchSession(sessionId, { incrementMessage: true });
    recordToolCall(sessionId, name, durationMs);

    // skill_compile also yields module activations and a compile record.
    if (name === "skill_compile") {
      const payload = parseCompileResult(result);
      if (payload) {
        const moduleIds = Array.isArray(payload.modules_loaded) ? payload.modules_loaded : [];
        const compileTimeMs = Number.isFinite(payload.compile_time_ms)
          ? payload.compile_time_ms
          : (Number.isFinite(payload.line_count) ? 0 : 0);
        if (moduleIds.length > 0) {
          recordModuleActivations(sessionId, moduleIds, compileTimeMs);
        }
        recordCompile(sessionId, {
          compile_time_ms: compileTimeMs,
          modules_loaded_count: moduleIds.length || payload.specialist_count || null,
          manifest_version: payload.manifest_version || null,
        });
      }
    }
  } catch (err) {
    log("warn", `[self-model] recording hook error after ${name}: ${err.message}`);
  }
}

/**
 * Explicitly finalise the current session. Exposed for callers that know a
 * session is ending (e.g. a future gateway close signal). Best-effort.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.topicSummary]
 * @returns {void}
 */
export function selfModelCloseSession(opts = {}) {
  if (!isSelfModelEnabled()) return;
  try {
    const sessionId = opts.sessionId || resolveSessionId();
    closeSession(sessionId, { topicSummary: opts.topicSummary });
  } catch (err) {
    log("warn", `[self-model] close session hook error: ${err.message}`);
  }
}
