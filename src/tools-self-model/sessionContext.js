// src/tools-self-model/sessionContext.js
// Resolves a stable session id for self-model recording.
//
// The connector does not carry an explicit per-request session object through
// every tool call, so this module keeps an in-process "current session id".
// The id is:
//   - taken from an explicit arg (session_id / _session_id / tenant session) when
//     one is supplied on a tool call, or
//   - established from ts_gateway_session_init (session start), or
//   - lazily generated on the first recorded event.
//
// This is deliberately lightweight. Aggregation and querying roll up by
// session_id, so the only requirement is that events within one session share
// an id and that a new id is minted per process/session start.

import { randomUUID } from "node:crypto";

let _currentSessionId = null;
let _currentSessionStart = null;

/**
 * Generate a new session id: a UTC date prefix plus a short random suffix,
 * e.g. "2026-07-19-3f9c1a". Human-scannable and collision-resistant.
 * @returns {string}
 */
function mintSessionId() {
  const day = new Date().toISOString().slice(0, 10);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
  return `${day}-${suffix}`;
}

/**
 * Extract an explicit session id from tool-call args, if present and valid.
 * @param {object} [args]
 * @returns {string|null}
 */
function sessionIdFromArgs(args) {
  if (!args || typeof args !== "object") return null;
  const candidate = args.session_id || args._session_id || args.sessionId || null;
  if (typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= 128) {
    return candidate.trim();
  }
  return null;
}

/**
 * Begin (or restart) the current session with an explicit id.
 * Called by ts_gateway_session_init. Idempotent for the same id.
 * @param {string} sessionId
 * @returns {{ id: string, startTime: string }}
 */
export function beginSession(sessionId) {
  const id = (typeof sessionId === "string" && sessionId.trim()) ? sessionId.trim() : mintSessionId();
  _currentSessionId = id;
  _currentSessionStart = new Date().toISOString();
  return { id: _currentSessionId, startTime: _currentSessionStart };
}

/**
 * Resolve the session id for the current event.
 * Prefers an explicit id on args; otherwise returns the current session id,
 * minting one lazily if none exists yet.
 * @param {object} [args]
 * @returns {string}
 */
export function resolveSessionId(args) {
  const explicit = sessionIdFromArgs(args);
  if (explicit) {
    if (explicit !== _currentSessionId) {
      _currentSessionId = explicit;
      _currentSessionStart = _currentSessionStart || new Date().toISOString();
    }
    return explicit;
  }
  if (!_currentSessionId) {
    beginSession(mintSessionId());
  }
  return _currentSessionId;
}

/**
 * Current session start time (ISO-8601) if known, else null.
 * @returns {string|null}
 */
export function getSessionStart() {
  return _currentSessionStart;
}

/**
 * Reset in-process state (tests only).
 */
export function _resetSessionContext() {
  _currentSessionId = null;
  _currentSessionStart = null;
}
