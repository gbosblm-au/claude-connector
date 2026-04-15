// config.js
// Reads and validates environment configuration at startup.

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

  // LinkedIn CSV path (defaults to ./data/connections.csv relative to cwd)
  linkedinCsvPath:
    process.env.LINKEDIN_CSV_PATH ||
    new URL("../../data/connections.csv", import.meta.url).pathname,

  // LinkedIn profile JSON path (optional manual profile data)
  linkedinProfilePath:
    process.env.LINKEDIN_PROFILE_PATH ||
    new URL("../../data/profile.json", import.meta.url).pathname,

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

  // Google Drive API (optional - for uploading images to Google Drive)
  // Option A: Service Account (recommended)
  googleServiceAccountKeyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "",
  // Option B: OAuth2 Refresh Token
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  // Default folder ID for uploads (optional)
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",

  // Default result limits
  defaultWebResults: parseInt(process.env.DEFAULT_WEB_RESULTS || "10", 10),
  defaultNewsResults: parseInt(process.env.DEFAULT_NEWS_RESULTS || "10", 10),
  defaultImageResults: parseInt(process.env.DEFAULT_IMAGE_RESULTS || "5", 10),

  // Maximum results the caller is allowed to request
  maxWebResults: parseInt(process.env.MAX_WEB_RESULTS || "20", 10),
  maxNewsResults: parseInt(process.env.MAX_NEWS_RESULTS || "20", 10),
  maxImageResults: parseInt(process.env.MAX_IMAGE_RESULTS || "20", 10),
};

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
