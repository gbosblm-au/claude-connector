// config.js
// Reads and validates environment configuration at startup.


// User-Agent string sent with all outbound HTTP requests.
// Identifies the connector to remote servers and security systems.
export const CONNECTOR_USER_AGENT = 'claude-connector/7.0.0 (TrueSource Consulting; WordPress automation; +https://truesourceconsulting.com.au)';
import { existsSync } from "node:fs";

const DEFAULT_LINKEDIN_CSV_PATH = new URL("../data/connections.csv", import.meta.url).pathname;
const DEFAULT_LINKEDIN_PROFILE_PATH = new URL("../data/profile.json", import.meta.url).pathname;
const BUNDLED_GOOGLE_SERVICE_ACCOUNT_KEY_FILE = new URL(
  "../data/google-service-account.json",
  import.meta.url
).pathname;

export const config = {
  // Search provider: "brave" | "tavily"
  searchProvider: (process.env.SEARCH_PROVIDER || "brave").toLowerCase(),

  // News provider: "brave" | "newsapi"
  newsProvider: (process.env.NEWS_PROVIDER || "brave").toLowerCase(),

  // Image provider: "pexels" | "unsplash" | "both" | "auto"
  // "auto" prefers Pexels when PEXELS_API_KEY is set, otherwise falls back to Unsplash.
  imageProvider: (process.env.IMAGE_PROVIDER || "auto").toLowerCase(),

  // API keys - search & news
  braveApiKey: process.env.BRAVE_API_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  newsApiKey: process.env.NEWS_API_KEY || "",

  // API keys - image search
  // Pexels: https://www.pexels.com/api/
  pexelsApiKey: process.env.PEXELS_API_KEY || "",
  // Unsplash: https://unsplash.com/developers
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY || "",

  // LinkedIn CSV path (defaults to ./data/connections.csv inside this project)
  linkedinCsvPath: process.env.LINKEDIN_CSV_PATH || DEFAULT_LINKEDIN_CSV_PATH,

  // LinkedIn profile JSON path (optional manual profile data)
  linkedinProfilePath:
    process.env.LINKEDIN_PROFILE_PATH || DEFAULT_LINKEDIN_PROFILE_PATH,

  // LinkedIn OAuth 2.0 (optional - for live profile fetching)
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID || "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
  linkedinRedirectUri:
    process.env.LINKEDIN_REDIRECT_URI ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/linkedin/callback`
      : "http://localhost:3000/auth/linkedin/callback"),

  // WordPress REST API (optional - for publishing to WordPress)
  // WP_URL:          your WordPress site URL, e.g. https://yoursite.com
  // WP_USERNAME:     your WordPress login username
  // WP_APP_PASSWORD: Application Password from WP Admin > Users > Profile
  wpUrl: (process.env.WP_URL || "").replace(/\/$/, ""),
  wpUsername: process.env.WP_USERNAME || "",
  wpAppPassword: process.env.WP_APP_PASSWORD || "",

  // Image download directory
  imageDownloadDir: process.env.IMAGE_DOWNLOAD_DIR || "",

  // Google Drive API (optional)
  // Option A: Service Account (recommended)
  // If GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set, the connector will also
  // auto-load ./data/google-service-account.json when that file exists.
  googleServiceAccountKeyFile:
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
    (existsSync(BUNDLED_GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
      ? BUNDLED_GOOGLE_SERVICE_ACCOUNT_KEY_FILE
      : ""),
  // Option B: OAuth2 Refresh Token
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  // Default folder ID for uploads (optional)
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
  // OAuth scopes used when requesting an access token. Default grants full
  // Drive access which is required for search / read / write across files
  // that were not created by this app. Override with a space or comma
  // separated list (e.g. "https://www.googleapis.com/auth/drive.readonly").
  googleDriveScopes:
    process.env.GOOGLE_DRIVE_SCOPES || "https://www.googleapis.com/auth/drive",
  // Optional: impersonate a Workspace user via domain-wide delegation when
  // using a service account (leave blank otherwise).
  googleImpersonateSubject: process.env.GOOGLE_IMPERSONATE_SUBJECT || "",

  // Default result limits
  defaultWebResults: parseInt(process.env.DEFAULT_WEB_RESULTS || "10", 10),
  defaultNewsResults: parseInt(process.env.DEFAULT_NEWS_RESULTS || "10", 10),
  defaultImageResults: parseInt(process.env.DEFAULT_IMAGE_RESULTS || "5", 10),

  // Maximum results the caller is allowed to request
  maxWebResults: parseInt(process.env.MAX_WEB_RESULTS || "20", 10),
  maxNewsResults: parseInt(process.env.MAX_NEWS_RESULTS || "20", 10),
  maxImageResults: parseInt(process.env.MAX_IMAGE_RESULTS || "20", 10),

  // -------------------------------------------------------------------
  // SCOPE-01 / SCOPE-03 / SCOPE-04 / SCOPE-05 -- TrueSource email send
  // -------------------------------------------------------------------

  // Shared SMTP credentials (team@truesourceconsulting.com.au)
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || "team@truesourceconsulting.com.au",
  smtpFromName: process.env.SMTP_FROM_NAME || "TrueSource Consulting",

  // Master kill-switch for outbound sends
  emailSendEnabled: (process.env.EMAIL_SEND_ENABLED || "true").toLowerCase() === "true",

  // Rate limit: 20 sends per 60-minute rolling window across all senders.
  emailRateLimitPerHour: parseInt(process.env.EMAIL_RATE_LIMIT_PER_HOUR || "20", 10),

  // SCOPE-03 -- HTML templating
  emailHtmlEnabled: (process.env.EMAIL_HTML_ENABLED || "true").toLowerCase() === "true",
  emailLogoUrl: process.env.EMAIL_LOGO_URL || "",
  emailConfidentialityFooter:
    process.env.EMAIL_CONFIDENTIALITY_FOOTER ||
    "This email and any attachments are confidential and intended solely for the named addressee. " +
    "If you have received this email in error, please notify the sender immediately and delete it " +
    "from your system. TrueSource Consulting Pty Ltd.",

  // SCOPE-04 -- tracking
  emailTrackingEnabled: (process.env.EMAIL_TRACKING_ENABLED || "true").toLowerCase() === "true",
  trackingBaseUrl:
    process.env.TRACKING_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://claude-connector-production.up.railway.app"),
  trackingGdriveFileId: process.env.TRACKING_GDRIVE_FILE_ID || "",
  trackingGdriveFolderId: process.env.TRACKING_GDRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || "",
  trackingFilename: process.env.TRACKING_FILENAME || "TrueSource_Email_Tracking.csv",
  trackingIpHashSalt: process.env.TRACKING_IP_HASH_SALT || "truesource-tracking-salt",

  // SCOPE-05 -- scheduling
  scheduleEnabled: (process.env.SCHEDULE_ENABLED || "true").toLowerCase() === "true",
  scheduleStorePath: process.env.SCHEDULE_STORE_PATH || "/data/schedule_store.json",
  scheduleMaxPending: parseInt(process.env.SCHEDULE_MAX_PENDING || "50", 10),

  // ---------------------------------------------------------------------------
  // Google Calendar (v8.0.0)
  // Requires scope: https://www.googleapis.com/auth/calendar
  // Add to GOOGLE_DRIVE_SCOPES (space-separated) alongside the Drive scope.
  // ---------------------------------------------------------------------------
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "primary",

  // ---------------------------------------------------------------------------
  // Google Sheets (v8.0.0)
  // Requires scope: https://www.googleapis.com/auth/spreadsheets
  // Add to GOOGLE_DRIVE_SCOPES (space-separated) alongside the Drive scope.
  // ---------------------------------------------------------------------------
  googleSheetsId: process.env.GOOGLE_SHEETS_ID || "",

  // ---------------------------------------------------------------------------
  // Slack (v8.0.0)
  // Bot OAuth Token from https://api.slack.com/apps
  // Required scopes: chat:write, chat:write.public
  // ---------------------------------------------------------------------------
  slackBotToken: process.env.SLACK_BOT_TOKEN || "",
  slackDefaultChannel: process.env.SLACK_DEFAULT_CHANNEL || "",

  // ---------------------------------------------------------------------------
  // Microsoft Teams (v8.0.0)
  // Incoming Webhook URL from Teams channel Connectors settings
  // ---------------------------------------------------------------------------
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL || "",

  // ---------------------------------------------------------------------------
  // Inbound Webhook receiver (v8.0.0)
  // WEBHOOK_SECRET: shared secret validated via X-Webhook-Secret header
  // WEBHOOK_QUEUE_SIZE: max events held in memory (default 200)
  // WEBHOOK_PERSIST_PATH: optional file path to persist queue across restarts
  // ---------------------------------------------------------------------------
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  webhookQueueSize: parseInt(process.env.WEBHOOK_QUEUE_SIZE || "200", 10),
  webhookPersistPath: process.env.WEBHOOK_PERSIST_PATH || "",
};

// -----------------------------------------------------------------------
// Sender profile helper - reads SENDER_BRIAN_*, SENDER_MICHAEL_*, SENDER_ROBBIE_*
// env vars and returns a normalised profile object.
//
// senderId must be one of: "brian", "michael", "robbie".
// Returns null for unknown sender_id values.
// -----------------------------------------------------------------------
const SENDER_DEFAULTS = {
  brian:   { name: "Brian Le Mon",   title: "Director", reply: "brian@truesourceconsulting.com.au" },
  michael: { name: "Michael Phan",   title: "Director", reply: "michael@truesourceconsulting.com.au" },
  robbie:  { name: "Robbie Singh",   title: "Director", reply: "robbie@truesourceconsulting.com.au" },
};

function signatureFor(name, replyTo) {
  return [
    name,
    "Director | TrueSource Consulting",
    `E: ${replyTo}`,
    "W: truesourceconsulting.com.au",
    "",
    "This email and any attachments are confidential and intended solely for the",
    "addressee. If you have received this email in error please notify the sender.",
  ].join("\n");
}

export function getSenderProfile(senderId) {
  const id = (senderId || "brian").toLowerCase();
  const def = SENDER_DEFAULTS[id];
  if (!def) return null;

  const KEY = id.toUpperCase();
  const name = process.env[`SENDER_${KEY}_NAME`] || def.name;
  const title = process.env[`SENDER_${KEY}_TITLE`] || def.title;
  const replyTo = process.env[`SENDER_${KEY}_REPLY_TO`] || def.reply;
  const phone = process.env[`SENDER_${KEY}_PHONE`] || "";
  const linkedin = process.env[`SENDER_${KEY}_LINKEDIN`] || "";
  const signature =
    process.env[`SENDER_${KEY}_SIGNATURE`] || signatureFor(name, replyTo);

  return {
    sender_id: id,
    sender_name: name,
    sender_title: title,
    reply_to: replyTo,
    phone,
    linkedin,
    signature_preview: signature,
  };
}

export function listSenderProfiles() {
  return ["brian", "michael", "robbie"]
    .map((id) => getSenderProfile(id))
    .filter(Boolean);
}

export function smtpConfigured() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

// -----------------------------------------------------------------------
// Validation helpers (called lazily per tool)
// -----------------------------------------------------------------------

export function requireBraveKey() {
  if (!config.braveApiKey) {
    throw new Error("BRAVE_API_KEY is not set. Add it in Railway Variables.");
  }
}

export function requireTavilyKey() {
  if (!config.tavilyApiKey || config.tavilyApiKey === "your_tavily_api_key_here") {
    throw new Error(
      "TAVILY_API_KEY is not set or is still the placeholder value. " +
      "Either set a real key at https://app.tavily.com or switch to SEARCH_PROVIDER=brave."
    );
  }
}

export function requireNewsApiKey() {
  if (!config.newsApiKey) {
    throw new Error(
      "NEWS_API_KEY is not set. Add it in Railway Variables or switch NEWS_PROVIDER=brave."
    );
  }
}

export function requirePexelsKey() {
  if (!config.pexelsApiKey) {
    throw new Error(
      "PEXELS_API_KEY is not set. " +
      "Get a free key at https://www.pexels.com/api/ and add it to your environment variables."
    );
  }
}

export function requireUnsplashKey() {
  if (!config.unsplashAccessKey) {
    throw new Error(
      "UNSPLASH_ACCESS_KEY is not set. " +
      "Get a free key at https://unsplash.com/developers and add it to your environment variables."
    );
  }
}

export function requireLinkedinOAuth() {
  if (!config.linkedinClientId) {
    throw new Error("LINKEDIN_CLIENT_ID is not set. See linkedin_start_oauth tool for setup instructions.");
  }
  if (!config.linkedinClientSecret) {
    throw new Error("LINKEDIN_CLIENT_SECRET is not set. See linkedin_start_oauth tool for setup instructions.");
  }
}

export function requireWordPress() {
  if (!config.wpUrl) {
    throw new Error(
      "WordPress is not configured. Add WP_URL, WP_USERNAME, and WP_APP_PASSWORD to Railway Variables."
    );
  }
  if (!config.wpUsername || !config.wpAppPassword) {
    throw new Error(
      "WP_USERNAME and WP_APP_PASSWORD must both be set. " +
      "Create an Application Password in WordPress Admin > Users > Your Profile."
    );
  }
}
