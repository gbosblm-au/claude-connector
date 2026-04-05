// utils/helpers.js

/**
 * Returns the current UTC date/time broken into useful parts.
 */
export function getCurrentDateTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    utcDate: now.toISOString().split("T")[0],
    utcTime: now.toISOString().split("T")[1].replace("Z", ""),
    timezone: "UTC",
    unixTimestamp: Math.floor(now.getTime() / 1000),
  };
}

/**
 * Clamps a number between min and max.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Safely truncates a string to `maxLen` characters.
 */
export function truncate(str, maxLen = 500) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

/**
 * Builds a text block suitable for MCP tool responses.
 */
export function textContent(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

/**
 * Formats milliseconds into a human-readable duration.
 */
export function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
