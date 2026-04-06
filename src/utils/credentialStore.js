// utils/credentialStore.js
//
// Runtime credential store for WordPress and LinkedIn credentials.
//
// Credentials can be set at runtime via MCP tools (set_wordpress_credentials,
// set_linkedin_credentials) rather than requiring them to be baked into
// Railway environment variables.
//
// PERSISTENCE STRATEGY:
//   Credentials are written to ./data/credentials.json on disk.
//   On Railway without a persistent volume, this file survives the current
//   container lifetime but not a full redeploy. With a Railway volume mounted
//   at /data (or similar), the file persists across restarts.
//   Environment variables always take precedence and are used as a fallback
//   if the credentials file is absent or a field is missing.
//
// SECURITY NOTE:
//   Credentials are stored as plain text in the data directory.
//   Ensure your Railway deployment is not exposing the /data directory
//   via any public route. The /mcp endpoint itself does not expose stored
//   credentials - they are used server-side only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

// Resolve the credentials file path relative to the project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");
const CRED_FILE = resolve(DATA_DIR, "credentials.json");

// In-memory cache - loaded once at startup, updated on every write
let _cache = null;

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromDisk() {
  try {
    if (!existsSync(CRED_FILE)) return {};
    const raw = readFileSync(CRED_FILE, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    log("warn", `credentialStore: could not read credentials.json: ${err.message}`);
    return {};
  }
}

function saveToDisk(data) {
  try {
    ensureDataDir();
    writeFileSync(CRED_FILE, JSON.stringify(data, null, 2), "utf-8");
    log("info", "credentialStore: credentials.json updated");
  } catch (err) {
    log("error", `credentialStore: could not write credentials.json: ${err.message}`);
    throw new Error(`Failed to persist credentials: ${err.message}`);
  }
}

function getCache() {
  if (_cache === null) {
    _cache = loadFromDisk();
  }
  return _cache;
}

function updateCache(updates) {
  _cache = { ...getCache(), ...updates };
  saveToDisk(_cache);
}

// -----------------------------------------------------------------------
// WordPress credentials
// -----------------------------------------------------------------------

/**
 * Returns WordPress credentials, preferring the runtime store over env vars.
 * Returns null if no credentials are available from either source.
 */
export function getWordPressCredentials() {
  const store = getCache();

  const url      = (store.wp_url      || process.env.WP_URL       || "").replace(/\/$/, "");
  const username = store.wp_username  || process.env.WP_USERNAME   || "";
  const password = store.wp_password  || process.env.WP_APP_PASSWORD || "";

  if (!url || !username || !password) return null;

  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  return { url, username, authHeader, baseApi: `${url}/wp-json/wp/v2` };
}

/**
 * Persists WordPress credentials to the runtime store.
 * Overwrites only the fields provided; leaves others untouched.
 */
export function setWordPressCredentials({ wp_url, wp_username, wp_password }) {
  if (!wp_url)      throw new Error("wp_url is required");
  if (!wp_username) throw new Error("wp_username is required");
  if (!wp_password) throw new Error("wp_password is required");

  const cleanUrl = wp_url.trim().replace(/\/$/, "");
  if (!cleanUrl.startsWith("http")) {
    throw new Error("wp_url must start with http:// or https://");
  }

  updateCache({
    wp_url:      cleanUrl,
    wp_username: wp_username.trim(),
    wp_password: wp_password.trim(),
  });
}

/**
 * Removes all stored WordPress credentials (env var values are unaffected).
 */
export function clearWordPressCredentials() {
  const store = getCache();
  delete store.wp_url;
  delete store.wp_username;
  delete store.wp_password;
  _cache = store;
  saveToDisk(store);
}

/**
 * Returns a safe status object (no passwords) for display to the user.
 */
export function getWordPressStatus() {
  const store  = getCache();
  const creds  = getWordPressCredentials();

  const source = store.wp_url
    ? "runtime (set via set_wordpress_credentials)"
    : process.env.WP_URL
      ? "environment variables (Railway)"
      : "not configured";

  return {
    configured: !!creds,
    source,
    wp_url:      creds?.url      || null,
    wp_username: creds?.username || null,
    // Never expose the password
  };
}

// -----------------------------------------------------------------------
// LinkedIn OAuth credentials
// -----------------------------------------------------------------------

/**
 * Returns LinkedIn OAuth app credentials, preferring the runtime store.
 */
export function getLinkedInCredentials() {
  const store = getCache();

  const clientId     = store.linkedin_client_id     || process.env.LINKEDIN_CLIENT_ID     || "";
  const clientSecret = store.linkedin_client_secret || process.env.LINKEDIN_CLIENT_SECRET || "";

  // Redirect URI: runtime > env > auto-detect from RAILWAY_PUBLIC_DOMAIN
  let redirectUri = store.linkedin_redirect_uri || process.env.LINKEDIN_REDIRECT_URI || "";
  if (!redirectUri) {
    redirectUri = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/linkedin/callback`
      : "http://localhost:3000/auth/linkedin/callback";
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Persists LinkedIn OAuth credentials to the runtime store.
 */
export function setLinkedInCredentials({ linkedin_client_id, linkedin_client_secret, linkedin_redirect_uri }) {
  if (!linkedin_client_id)     throw new Error("linkedin_client_id is required");
  if (!linkedin_client_secret) throw new Error("linkedin_client_secret is required");

  const updates = {
    linkedin_client_id:     linkedin_client_id.trim(),
    linkedin_client_secret: linkedin_client_secret.trim(),
  };
  if (linkedin_redirect_uri) {
    updates.linkedin_redirect_uri = linkedin_redirect_uri.trim();
  }

  updateCache(updates);
}

/**
 * Removes all stored LinkedIn credentials (env var values are unaffected).
 */
export function clearLinkedInCredentials() {
  const store = getCache();
  delete store.linkedin_client_id;
  delete store.linkedin_client_secret;
  delete store.linkedin_redirect_uri;
  _cache = store;
  saveToDisk(store);
}

/**
 * Returns a safe status object (no secrets) for display to the user.
 */
export function getLinkedInStatus() {
  const store  = getCache();
  const creds  = getLinkedInCredentials();

  const source = store.linkedin_client_id
    ? "runtime (set via set_linkedin_credentials)"
    : process.env.LINKEDIN_CLIENT_ID
      ? "environment variables (Railway)"
      : "not configured";

  return {
    configured:   !!(creds.clientId && creds.clientSecret),
    source,
    client_id:    creds.clientId    || null,
    redirect_uri: creds.redirectUri || null,
    // Never expose client_secret
  };
}
