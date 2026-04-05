// utils/logger.js
// All logging goes to stderr so it does not corrupt the MCP stdio stream.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? LEVELS.info;

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} message
 * @param {*} [data]
 */
export function log(level, message, data) {
  if ((LEVELS[level] ?? 99) < currentLevel) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [claude-connector]`;
  const line = data !== undefined
    ? `${prefix} ${message} ${typeof data === "object" ? JSON.stringify(data) : data}`
    : `${prefix} ${message}`;

  process.stderr.write(line + "\n");
}
