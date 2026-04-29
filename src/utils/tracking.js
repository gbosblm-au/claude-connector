// src/utils/tracking.js
//
// Open / click tracking infrastructure for SCOPE-04.
//
// Responsibilities:
//   - Generate tracking pixel and click-redirect URLs
//   - Maintain an in-memory index of tracking_id -> send metadata
//     (so /track/open and /track/click can write rich rows to the CSV
//     without re-reading it on every event)
//   - Append rows to TrueSource_Email_Tracking.csv in Google Drive,
//     with a 60s/10min retry queue for transient API failures
//   - Classify User-Agent strings into the five buckets defined in scope
//   - Hash IP addresses (SHA-256 + salt, never raw)
//   - Provide query helpers used by the email_get_tracking and
//     email_tracking_summary tools

import { randomUUID, createHash } from "node:crypto";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { log } from "./logger.js";

// Drive API access reuses the helpers exported from the existing googleDrive
// module. We import them lazily to avoid circular import issues at startup.
let _driveHelpers = null;
async function driveHelpers() {
  if (_driveHelpers) return _driveHelpers;
  _driveHelpers = await import("../tools/googleDrive.js");
  return _driveHelpers;
}

// -----------------------------------------------------------------------
// In-memory metadata index: tracking_id -> send metadata
// -----------------------------------------------------------------------
const sendIndex = new Map();
const openCounts = new Map(); // tracking_id -> int

export function registerSend(metadata) {
  sendIndex.set(metadata.tracking_id, { ...metadata });
  openCounts.set(metadata.tracking_id, 0);
}

export function getSendMetadata(tracking_id) {
  return sendIndex.get(tracking_id) || null;
}

export function incrementOpen(tracking_id) {
  const cur = openCounts.get(tracking_id) || 0;
  openCounts.set(tracking_id, cur + 1);
  return cur + 1;
}

// -----------------------------------------------------------------------
// URL builders
// -----------------------------------------------------------------------
export function buildTrackingPixelUrl(tracking_id) {
  const base = (config.trackingBaseUrl || "").replace(/\/$/, "");
  return `${base}/track/open?id=${encodeURIComponent(tracking_id)}`;
}

export function buildClickTrackedUrl(tracking_id, originalUrl) {
  const base = (config.trackingBaseUrl || "").replace(/\/$/, "");
  return `${base}/track/click?id=${encodeURIComponent(tracking_id)}&url=${encodeURIComponent(originalUrl)}`;
}

// -----------------------------------------------------------------------
// IP hashing (never store raw)
// -----------------------------------------------------------------------
export function hashIp(ip) {
  if (!ip) return "";
  return createHash("sha256")
    .update(`${config.trackingIpHashSalt}|${ip}`)
    .digest("hex")
    .slice(0, 16);
}

// -----------------------------------------------------------------------
// User-Agent classification
// -----------------------------------------------------------------------
export function classifyUserAgent(ua, referer = "") {
  const u = (ua || "").toLowerCase();
  const r = (referer || "").toLowerCase();

  // Bot / scanner first
  if (
    /googlebot|bingbot|preview|prefetch|safelinks|barracuda|proofpoint|mimecast|symantec|crawler|spider|facebookexternalhit|slackbot|telegrambot|whatsapp/.test(u) ||
    /applemail.*proxy|applemailprivacyproxy/.test(u)
  ) {
    return "bot";
  }

  if (/mail\.google\.com|outlook\.live\.com|outlook\.office\.com|yahoo\.com\/mail/.test(r)) {
    return "webmail";
  }

  if (/iphone|ipad|android/.test(u) && /mail/.test(u)) {
    return "mobile_email";
  }

  if (/outlook|thunderbird|apple ?mail|airmail|spark/.test(u)) {
    return "desktop_email";
  }

  if (/iphone|ipad|android/.test(u)) {
    return "mobile_email";
  }

  return "unknown";
}

// -----------------------------------------------------------------------
// CSV row formatting and append (Google Drive)
// -----------------------------------------------------------------------
const CSV_HEADER = [
  "event_id",
  "tracking_id",
  "event_type",
  "event_timestamp",
  "to_address",
  "to_name",
  "subject",
  "sender_id",
  "company",
  "send_timestamp",
  "click_url",
  "user_agent_type",
  "open_count",
  "schedule_id",
  "user_agent_raw",
  "ip_hash",
];

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsvLine(row) {
  return CSV_HEADER.map((c) => csvEscape(row[c])).join(",");
}

// In-memory event cache (used by query tools and as a write-through cache)
const eventBuffer = []; // newest at end

function pushEventToBuffer(row) {
  eventBuffer.push(row);
  // Keep last 5000 events in memory; older still readable from Drive
  if (eventBuffer.length > 5000) eventBuffer.shift();
}

// Pending events queued for Drive append (retried on failure)
const pendingAppends = []; // [{row, attempts, firstSeen}]
let appendLoopStarted = false;

function startAppendLoop() {
  if (appendLoopStarted) return;
  appendLoopStarted = true;
  setInterval(processPendingAppends, 60 * 1000).unref?.();
}

async function processPendingAppends() {
  if (pendingAppends.length === 0) return;
  const now = Date.now();
  const stillPending = [];
  for (const item of pendingAppends) {
    if (now - item.firstSeen > 10 * 60 * 1000) {
      log(
        "error",
        `tracking CSV append GIVING UP after 10 min: ${JSON.stringify(item.row)}`
      );
      continue;
    }
    try {
      await driveAppendRow(item.row);
    } catch (err) {
      item.attempts += 1;
      stillPending.push(item);
      log("warn", `tracking CSV append retry queued (attempt ${item.attempts}): ${err.message}`);
    }
  }
  pendingAppends.length = 0;
  pendingAppends.push(...stillPending);
}

// Lazily ensure the CSV exists. Returns the Drive file ID.
let _trackingFileId = null;
let _ensurePromise = null;

async function ensureTrackingCsv() {
  if (_trackingFileId) return _trackingFileId;
  if (config.trackingGdriveFileId) {
    _trackingFileId = config.trackingGdriveFileId;
    return _trackingFileId;
  }
  if (_ensurePromise) return _ensurePromise;

  _ensurePromise = (async () => {
    const { handleGoogleDriveSearchFiles, handleGoogleDriveCreateFile } =
      await driveHelpers();

    // Try to find existing file by name
    try {
      const search = await handleGoogleDriveSearchFiles({
        name_contains: config.trackingFilename,
        max_results: 5,
      });
      const text = search?.content?.[0]?.text || "";
      const match = text.match(/"id":\s*"([A-Za-z0-9_\-]+)"[^}]*"name":\s*"([^"]+)"/);
      if (match && match[2] === config.trackingFilename) {
        _trackingFileId = match[1];
        log("info", `Tracking CSV located on Drive: ${_trackingFileId}`);
        return _trackingFileId;
      }
    } catch (err) {
      log("warn", `Tracking CSV search failed (will attempt create): ${err.message}`);
    }

    // Create with header row
    const createArgs = {
      name: config.trackingFilename,
      mime_type: "text/csv",
      content: CSV_HEADER.join(",") + "\n",
    };
    if (config.trackingGdriveFolderId) createArgs.parent_id = config.trackingGdriveFolderId;

    const created = await handleGoogleDriveCreateFile(createArgs);
    const cText = created?.content?.[0]?.text || "";
    const idMatch = cText.match(/"id":\s*"([A-Za-z0-9_\-]+)"/);
    if (!idMatch) throw new Error("Could not parse new tracking CSV file ID");
    _trackingFileId = idMatch[1];
    log("warn",
      `Tracking CSV created on Drive: id=${_trackingFileId}. ` +
      `Set TRACKING_GDRIVE_FILE_ID=${_trackingFileId} to persist this across restarts.`
    );
    return _trackingFileId;
  })().catch((err) => {
    _ensurePromise = null;
    throw err;
  });

  return _ensurePromise;
}

// Direct Drive append using read-modify-write (acceptable for the low
// volumes anticipated; Drive's API does not support O(1) append).
async function driveAppendRow(row) {
  const { handleGoogleDriveReadFileContent, handleGoogleDriveCreateFile } =
    await driveHelpers();

  const fileId = await ensureTrackingCsv();

  // Read existing content
  let existing = "";
  try {
    const r = await handleGoogleDriveReadFileContent({ file_id: fileId });
    const text = r?.content?.[0]?.text || "";
    // Tool wraps content with metadata header. Extract content section.
    const idx = text.indexOf("---\n");
    existing = idx >= 0 ? text.slice(idx + 4) : text;
  } catch (err) {
    // If read fails we still attempt overwrite with header + new row to avoid dropping events
    existing = CSV_HEADER.join(",") + "\n";
    log("warn", `Tracking CSV read failed; overwriting from header: ${err.message}`);
  }

  if (!existing.startsWith(CSV_HEADER[0])) {
    existing = CSV_HEADER.join(",") + "\n" + existing;
  }
  if (!existing.endsWith("\n")) existing += "\n";

  const updated = existing + rowToCsvLine(row) + "\n";

  await handleGoogleDriveCreateFile({
    file_id: fileId,
    name: config.trackingFilename,
    mime_type: "text/csv",
    content: updated,
    overwrite: true,
  });
}

/**
 * Append a tracking event row. Always returns quickly: the row is
 * pushed into the in-memory buffer immediately, then written to Drive
 * in the background with retry-on-failure.
 */
export async function appendTrackingEvent(partial) {
  startAppendLoop();

  const tz = "Australia/Melbourne";
  const eventTimestamp = DateTime.now().setZone(tz).toISO({ suppressMilliseconds: true });

  const row = {
    event_id: randomUUID(),
    tracking_id: partial.tracking_id || "",
    event_type: partial.event_type || "open",
    event_timestamp: eventTimestamp,
    to_address: partial.to_address || "",
    to_name: partial.to_name || "",
    subject: partial.subject || "",
    sender_id: partial.sender_id || "",
    company: partial.company || "",
    send_timestamp: partial.send_timestamp || "",
    click_url: partial.click_url || "",
    user_agent_type: partial.user_agent_type || "",
    open_count: partial.open_count != null ? String(partial.open_count) : "",
    schedule_id: partial.schedule_id || "",
    user_agent_raw: partial.user_agent_raw || "",
    ip_hash: partial.ip_hash || "",
  };

  pushEventToBuffer(row);

  try {
    await driveAppendRow(row);
  } catch (err) {
    pendingAppends.push({ row, attempts: 1, firstSeen: Date.now() });
    log("warn", `tracking CSV append queued for retry: ${err.message}`);
  }
  return row;
}

// -----------------------------------------------------------------------
// Read events (from in-memory buffer, falling back to a Drive read)
// -----------------------------------------------------------------------
let _csvLastFetched = 0;
let _csvCache = null;

async function loadAllEvents({ force = false } = {}) {
  const now = Date.now();
  if (!force && _csvCache && now - _csvLastFetched < 30 * 1000) {
    return _csvCache;
  }
  try {
    const fileId = await ensureTrackingCsv();
    const { handleGoogleDriveReadFileContent } = await driveHelpers();
    const r = await handleGoogleDriveReadFileContent({ file_id: fileId });
    const text = r?.content?.[0]?.text || "";
    const idx = text.indexOf("---\n");
    const csvBody = idx >= 0 ? text.slice(idx + 4) : text;
    _csvCache = parseCsv(csvBody);
    _csvLastFetched = now;
    return _csvCache;
  } catch (err) {
    log("warn", `loadAllEvents falling back to memory buffer: ${err.message}`);
    return [...eventBuffer];
  }
}

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return rows;
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields;
      continue;
    }
    const row = {};
    header.forEach((col, j) => {
      row[col] = fields[j] != null ? fields[j] : "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === ',') { out.push(cur); cur = ""; }
      else if (c === '"' && cur === "") { inQ = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

// -----------------------------------------------------------------------
// Query helpers used by email_get_tracking + email_tracking_summary
// -----------------------------------------------------------------------
export async function queryEvents(filter = {}) {
  const all = await loadAllEvents();
  const sinceDays = filter.since_days != null ? Number(filter.since_days) : 30;
  const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;

  return all.filter((r) => {
    if (filter.tracking_id && r.tracking_id !== filter.tracking_id) return false;
    if (filter.to_address && r.to_address.toLowerCase() !== filter.to_address.toLowerCase()) return false;
    if (filter.company && r.company.toLowerCase() !== filter.company.toLowerCase()) return false;
    if (filter.sender_id && r.sender_id !== filter.sender_id) return false;
    if (filter.event_type && filter.event_type !== "all" && r.event_type !== filter.event_type) return false;
    if (cutoffMs > 0) {
      const ts = Date.parse(r.event_timestamp);
      if (!isNaN(ts) && ts < cutoffMs) return false;
    }
    return true;
  });
}

export async function detectSequenceEngagement(trackingIds) {
  if (!trackingIds || trackingIds.length === 0) return false;
  const all = await loadAllEvents({ force: true });
  return all.some(
    (r) =>
      trackingIds.includes(r.tracking_id) &&
      (r.event_type === "open" || r.event_type === "click") &&
      r.user_agent_type !== "bot"
  );
}

// -----------------------------------------------------------------------
// 1x1 transparent PNG (hardcoded constant per scope)
// -----------------------------------------------------------------------
export const PIXEL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
