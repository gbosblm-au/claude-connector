// utils/tokenStore.js
// In-memory store for LinkedIn OAuth tokens and pending auth states.
//
// IMPORTANT: This is in-memory only. On Railway (and most cloud platforms),
// the server process restarts periodically, which clears all tokens.
// Users will need to re-authenticate after a server restart.

import { randomBytes } from "node:crypto";
import { log } from "./logger.js";

// Pending OAuth states: stateKey -> { createdAt }
const pendingStates = new Map();

// Active LinkedIn token (single-user deployment)
let activeToken = null;

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// -----------------------------------------------------------------------
// State management (CSRF protection)
// -----------------------------------------------------------------------

export function createState() {
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });
  log("debug", `OAuth state created: ${state}`);
  return state;
}

export function validateAndConsumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) {
    log("warn", `OAuth state not found: ${state}`);
    return false;
  }
  const age = Date.now() - entry.createdAt;
  pendingStates.delete(state);
  if (age > STATE_TTL_MS) {
    log("warn", `OAuth state expired (${Math.round(age / 1000)}s): ${state}`);
    return false;
  }
  log("debug", `OAuth state validated: ${state}`);
  return true;
}

// -----------------------------------------------------------------------
// Token management
// -----------------------------------------------------------------------

export function storeToken(tokenData) {
  activeToken = {
    accessToken: tokenData.access_token,
    expiresAt: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : null,
    scope: tokenData.scope || "",
    storedAt: new Date().toISOString(),
  };
  log("info", "LinkedIn OAuth token stored");
}

export function getToken() {
  if (!activeToken) return null;
  if (activeToken.expiresAt && Date.now() > activeToken.expiresAt) {
    log("info", "LinkedIn token expired, clearing");
    activeToken = null;
    return null;
  }
  return activeToken;
}

export function clearToken() {
  activeToken = null;
  log("info", "LinkedIn token cleared");
}

export function getTokenStatus() {
  if (!activeToken) return { authenticated: false, reason: "No token stored" };
  if (activeToken.expiresAt && Date.now() > activeToken.expiresAt) {
    activeToken = null;
    return { authenticated: false, reason: "Token expired" };
  }
  const expiresIn = activeToken.expiresAt
    ? Math.round((activeToken.expiresAt - Date.now()) / 1000)
    : null;
  return {
    authenticated: true,
    storedAt: activeToken.storedAt,
    expiresIn: expiresIn ? `${expiresIn} seconds` : "no expiry set",
    scope: activeToken.scope,
  };
}
