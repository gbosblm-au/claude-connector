// config.js
// Reads and validates environment configuration at startup.

const REQUIRED_FOR_BRAVE = ["BRAVE_API_KEY"];
const REQUIRED_FOR_TAVILY = ["TAVILY_API_KEY"];
const REQUIRED_FOR_NEWSAPI = ["NEWS_API_KEY"];

export const config = {
  // Search provider: "brave" | "tavily"
  searchProvider: (process.env.SEARCH_PROVIDER || "brave").toLowerCase(),

  // News provider: "brave" | "newsapi"
  newsProvider: (process.env.NEWS_PROVIDER || "brave").toLowerCase(),

  // API keys
  braveApiKey: process.env.BRAVE_API_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  newsApiKey: process.env.NEWS_API_KEY || "",

  // LinkedIn CSV path (defaults to ./data/connections.csv relative to cwd)
  linkedinCsvPath:
    process.env.LINKEDIN_CSV_PATH ||
    new URL("../../data/connections.csv", import.meta.url).pathname,

  // LinkedIn profile JSON path (optional manual profile data)
  linkedinProfilePath:
    process.env.LINKEDIN_PROFILE_PATH ||
    new URL("../../data/profile.json", import.meta.url).pathname,

  // Default result limits
  defaultWebResults: parseInt(process.env.DEFAULT_WEB_RESULTS || "10", 10),
  defaultNewsResults: parseInt(process.env.DEFAULT_NEWS_RESULTS || "10", 10),

  // Maximum results the caller is allowed to request
  maxWebResults: parseInt(process.env.MAX_WEB_RESULTS || "20", 10),
  maxNewsResults: parseInt(process.env.MAX_NEWS_RESULTS || "20", 10),
};

// -----------------------------------------------------------------------
// Validation helpers (called lazily per tool so the server still starts
// even if only some keys are missing)
// -----------------------------------------------------------------------

export function requireBraveKey() {
  if (!config.braveApiKey) {
    throw new Error(
      "BRAVE_API_KEY is not set. Add it to your .env file or MCP environment configuration."
    );
  }
}

export function requireTavilyKey() {
  if (!config.tavilyApiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. Add it to your .env file or MCP environment configuration."
    );
  }
}

export function requireNewsApiKey() {
  if (!config.newsApiKey) {
    throw new Error(
      "NEWS_API_KEY is not set. Add it to your .env file or MCP environment configuration."
    );
  }
}
