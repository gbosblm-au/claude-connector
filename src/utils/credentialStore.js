// utils/credentialStore.js  v2.0.0
//
// Runtime credential store for WordPress and LinkedIn credentials, set via the
// MCP tools set_wordpress_credentials and set_linkedin_credentials rather than
// baked into Railway environment variables.
//
// ── v12.30.0: remediates TNX-H-014 ────────────────────────────────────────
//
// Four defects, of which the first was silently destroying data.
//
// 1. THE FILE WAS ON THE WRONG FILESYSTEM. The path was:
//
//        const __dirname = dirname(fileURLToPath(import.meta.url));
//        const DATA_DIR  = resolve(__dirname, "../../data");
//
//    From /app/src/utils/ that resolves to /app/data -- INSIDE THE CONTAINER
//    IMAGE. The Railway volume is mounted at /data (railway.toml: dest="/data").
//    So every credential set through the documented MCP workflow was lost on
//    every redeploy, with no error and no warning. Operators following the
//    documented process would find their WordPress and LinkedIn integrations
//    breaking after each deploy with nothing explaining why.
//
//    The old module header asserted the opposite: "With a Railway volume
//    mounted at /data (or similar), the file persists across restarts." That
//    was wrong, because the file was never written to /data in the first place.
//
// 2. PLAINTEXT AT REST. No encryption, and writeFileSync used the default mode
//    (0666 before umask), so the file was likely world-readable inside the
//    container. Any tool with filesystem access could read it -- script_execute
//    (TNX-C-004) being the obvious one.
//
// 3. NON-ATOMIC WRITES. writeFileSync truncates in place. A crash between the
//    truncate and the write left an empty or partial file, losing every stored
//    credential rather than just the one being written.
//
// 4. NO WRITABILITY CHECK. A read-only or unmounted volume produced a failure
//    only at the moment someone tried to save a credential, rather than at boot.
//
// ── What this version does ────────────────────────────────────────────────
//
//   - DATA_DIR defaults to /data (override with CONNECTOR_DATA_DIR), and the
//     module warns loudly at load if the resolved directory is inside the
//     image, because that is the silent-data-loss condition.
//   - Secret fields are encrypted with AES-256-GCM via ./secretBox.js, which
//     mirrors the gateway's lib/workflow-secrets.js scheme exactly.
//   - The file is written 0600 and the directory 0700.
//   - Writes are atomic: a temp file in the same directory, fsync, then rename.
//   - A one-time migration reads any legacy /app/data/credentials.json and
//     rewrites it encrypted at the correct path.
//
// Environment variables still take precedence and are used as a fallback when
// a field is absent from the store. That behaviour is unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
         unlinkSync, openSync, fsyncSync, closeSync, chmodSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";
import { encryptSecret, decryptSecret, encryptionEnabled, looksEncrypted } from "./secretBox.js";

// ── Paths ────────────────────────────────────────────────────────────────
//
// Defaults to the volume mount point, NOT a path relative to this file.
const DATA_DIR  = resolve(process.env.CONNECTOR_DATA_DIR || "/data");
const CRED_FILE = resolve(DATA_DIR, "credentials.json");

// The legacy location, retained solely so the migration below can find and
// rescue credentials written by earlier versions before they are lost.
const __dirname          = dirname(fileURLToPath(import.meta.url));
const LEGACY_DATA_DIR    = resolve(__dirname, "../../data");
const LEGACY_CRED_FILE   = resolve(LEGACY_DATA_DIR, "credentials.json");

/**
 * Fields that hold secret material and must be encrypted at rest.
 *
 * An allowlist rather than a denylist: a field added in future is treated as
 * non-secret only if someone decides so explicitly, and getting that wrong for
 * a URL is harmless whereas getting it wrong for a password is not. Anything
 * that is a credential belongs here.
 */
const SECRET_FIELDS = new Set([
  "wp_password",
  "linkedin_client_secret",
]);

// In-memory cache - loaded once at startup, updated on every write.
// Holds DECRYPTED values; encryption happens at the disk boundary.
let _cache = null;

/** Set once so the storage-location warning is not repeated per call. */
let _pathWarningIssued = false;

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/**
 * Create the data directory if absent, with restrictive permissions.
 * @returns {void}
 */
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(DATA_DIR, 0o700);
  } catch {
    // A volume mounted with fixed ownership may refuse chmod. Not fatal: the
    // 0600 file mode is the control that matters.
  }
}

/**
 * Verify at load time that credentials will actually persist.
 *
 * This is the check whose absence let defect 1 go unnoticed. It runs once and
 * reports rather than throwing, because an unwritable credential directory
 * must not stop a connector that is otherwise fully functional from starting.
 *
 * @returns {{ ok: boolean, writable: boolean, insideImage: boolean, detail: string }}
 */
export function checkStorageLocation() {
  const insideImage = DATA_DIR.startsWith("/app") || DATA_DIR === LEGACY_DATA_DIR;
  let writable = false;
  let detail   = "";

  try {
    ensureDataDir();
    const probe = join(DATA_DIR, `.cred-probe-${randomBytes(4).toString("hex")}`);
    writeFileSync(probe, "probe", { mode: 0o600 });
    unlinkSync(probe);
    writable = true;
  } catch (err) {
    detail = err.message;
  }

  if (!_pathWarningIssued) {
    _pathWarningIssued = true;

    if (insideImage) {
      log("error",
        `credentialStore: DATA_DIR resolves to ${DATA_DIR}, which is INSIDE THE CONTAINER IMAGE. ` +
        "Credentials set via MCP tools will be LOST on every redeploy. Mount a persistent " +
        "volume and set CONNECTOR_DATA_DIR to its mount point (Railway default: /data). " +
        "This is audit finding TNX-H-014.");
    } else if (!writable) {
      log("error",
        `credentialStore: ${DATA_DIR} is not writable (${detail}). Credentials cannot be ` +
        "persisted and will be lost when this container stops.");
    } else if (!encryptionEnabled()) {
      log("warn",
        "credentialStore: CONNECTOR_SECRET_KEY is not set, so credentials are stored " +
        "UNENCRYPTED at rest. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    } else {
      log("info", `credentialStore: ${CRED_FILE} (encrypted, mode 0600)`);
    }
  }

  return { ok: writable && !insideImage, writable, insideImage, detail };
}

/**
 * Decrypt the secret fields of a loaded record.
 *
 * A field that fails to decrypt is dropped rather than propagated, and the
 * failure is logged. Returning ciphertext as if it were a password would send
 * garbage to WordPress and produce a confusing authentication error rather than
 * an obvious configuration one.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function decryptRecord(record) {
  const out = { ...record };

  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (typeof value !== "string" || !value) continue;

    if (!looksEncrypted(value)) {
      // A legacy plaintext value written before this release. Left as-is so it
      // keeps working; it is re-encrypted on the next write.
      continue;
    }

    try {
      out[field] = decryptSecret(value);
    } catch (err) {
      log("error",
        `credentialStore: could not decrypt ${field} (${err.message}). ` +
        "The value was encrypted with a different CONNECTOR_SECRET_KEY, or the file was " +
        "modified. Re-set the credential with the corresponding MCP tool.");
      delete out[field];
    }
  }

  return out;
}

/**
 * Encrypt the secret fields of a record for writing.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function encryptRecord(record) {
  const out = { ...record };
  if (!encryptionEnabled()) return out;

  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (typeof value !== "string" || !value) continue;
    if (looksEncrypted(value)) continue;   // already encrypted, do not double-wrap
    out[field] = encryptSecret(value);
  }

  return out;
}

/**
 * Read the store from disk, decrypting secret fields.
 * @returns {Record<string, unknown>}
 */
function loadFromDisk() {
  try {
    if (!existsSync(CRED_FILE)) return {};
    const raw = readFileSync(CRED_FILE, "utf-8").trim();
    if (!raw) return {};
    return decryptRecord(JSON.parse(raw));
  } catch (err) {
    log("warn", `credentialStore: could not read ${CRED_FILE}: ${err.message}`);
    return {};
  }
}

/**
 * Persist the store atomically with restrictive permissions.
 *
 * The sequence is write-temp, fsync, rename. rename() is atomic within a
 * filesystem, so a reader sees either the complete old file or the complete new
 * one and never a truncated one. The previous implementation called
 * writeFileSync directly on the live path, which truncates in place: a crash
 * between truncate and write lost every stored credential, not just the one
 * being saved.
 *
 * fsync before rename matters too. Without it the rename can reach the disk
 * before the data does, and a power loss leaves a correctly-named empty file.
 *
 * @param {Record<string, unknown>} data
 * @returns {void}
 */
function saveToDisk(data) {
  const tmpFile = `${CRED_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    ensureDataDir();

    const payload = JSON.stringify(encryptRecord(data), null, 2);

    // The temp file MUST be in the same directory as the target: rename() is
    // only atomic within a single filesystem, and /tmp is frequently a
    // different mount from a volume.
    writeFileSync(tmpFile, payload, { encoding: "utf-8", mode: 0o600 });

    const fd = openSync(tmpFile, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpFile, CRED_FILE);

    try {
      chmodSync(CRED_FILE, 0o600);
    } catch { /* mode was already set on create; a refusal here is not fatal */ }

    log("info", `credentialStore: ${CRED_FILE} updated${encryptionEnabled() ? " (encrypted)" : " (UNENCRYPTED - set CONNECTOR_SECRET_KEY)"}`);
  } catch (err) {
    // Clean up the temp file so a failed write does not litter the volume.
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* ignore */ }
    log("error", `credentialStore: could not write ${CRED_FILE}: ${err.message}`);
    throw new Error(`Failed to persist credentials: ${err.message}`);
  }
}

/**
 * One-time migration from the legacy in-image path.
 *
 * Reads /app/data/credentials.json if it exists and the new location has no
 * file yet, then rewrites it encrypted at the correct path. The legacy file is
 * left in place rather than deleted: it lives in the image and will vanish on
 * the next deploy anyway, and deleting it would remove the only copy if the
 * write to the volume were to fail.
 *
 * @returns {boolean} True when a migration was performed.
 */
export function migrateLegacyCredentials() {
  try {
    if (LEGACY_CRED_FILE === CRED_FILE) return false;
    if (!existsSync(LEGACY_CRED_FILE))  return false;
    if (existsSync(CRED_FILE))          return false;   // never overwrite live data

    const raw = readFileSync(LEGACY_CRED_FILE, "utf-8").trim();
    if (!raw) return false;

    const legacy = JSON.parse(raw);
    if (!legacy || typeof legacy !== "object" || Object.keys(legacy).length === 0) return false;

    saveToDisk(decryptRecord(legacy));
    _cache = null;   // force a reload from the new location

    log("warn",
      `credentialStore: migrated ${Object.keys(legacy).length} credential field(s) from the ` +
      `legacy in-image path ${LEGACY_CRED_FILE} to ${CRED_FILE}. These would have been lost ` +
      "on the next redeploy (TNX-H-014).");

    return true;
  } catch (err) {
    log("error", `credentialStore: legacy migration failed: ${err.message}`);
    return false;
  }
}

/**
 * Current file mode, for diagnostics and tests.
 * @returns {string|null} Octal mode string, or null when the file is absent.
 */
export function getCredentialFileMode() {
  try {
    if (!existsSync(CRED_FILE)) return null;
    return (statSync(CRED_FILE).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

/** Exposed for tests and diagnostics. @returns {{ dataDir: string, credFile: string }} */
export function getStoragePaths() {
  return { dataDir: DATA_DIR, credFile: CRED_FILE };
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
