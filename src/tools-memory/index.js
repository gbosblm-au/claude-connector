// src/tools-memory/index.js
// Aggregator module for the integrated Memory MCP. Exposes the six tool
// definitions, the six dispatcher handlers, and the init/start functions
// that src/server-http.js calls during boot.

import { initDb, getDb } from "./db.js";
import { startTtlWorker } from "./ttlExpiry.js";
import { asToolResult, formatToolError } from "./errors.js";
import { log } from "../utils/logger.js";

import { handleMemoryWrite } from "./memory-write.js";
import { handleMemoryRead } from "./memory-read.js";
import { handleMemorySearch } from "./memory-search.js";
import { handleMemoryDelete } from "./memory-delete.js";
import { handleMemoryList } from "./memory-list.js";
import { handleMemoryGetSessionContext } from "./memory-get-session-context.js";

export {
  memoryWriteToolDefinition,
  memoryReadToolDefinition,
  memorySearchToolDefinition,
  memoryDeleteToolDefinition,
  memoryListToolDefinition,
  memoryGetSessionContextToolDefinition,
  ALL_MEMORY_TOOL_DEFINITIONS,
} from "./definitions.js";

/**
 * Initialise the memory subsystem. Safe to call once at server boot.
 * Reads configuration from environment variables; honours the same vars as
 * the standalone TrueSource Memory MCP service so deployments are portable.
 */
export function initMemorySubsystem({
  dbPath = process.env.MEMORY_DB_PATH || process.env.DB_PATH || "/data/memory.db",
  ttlIntervalMs = parseInt(process.env.TTL_WORKER_INTERVAL_MS || "3600000", 10),
} = {}) {
  initDb(dbPath);
  log("info", `[memory] initialised at ${dbPath} (WAL mode)`);
  startTtlWorker({ intervalMs: ttlIntervalMs });
  log("info", `[memory] TTL worker started (interval ${ttlIntervalMs}ms)`);
}

/**
 * Wrap each handler so it returns the MCP { content: [...] } envelope on
 * success, and a structured { isError: true } body on validation failure.
 * Mirrors the pattern used across the rest of claude-connector.
 */
export async function dispatchMemoryTool(name, args) {
  try {
    switch (name) {
      case "memory_write":
        return asToolResult(await handleMemoryWrite(args || {}));
      case "memory_read":
        return asToolResult(await handleMemoryRead(args || {}));
      case "memory_search":
        return asToolResult(await handleMemorySearch(args || {}));
      case "memory_delete":
        return asToolResult(await handleMemoryDelete(args || {}));
      case "memory_list":
        return asToolResult(await handleMemoryList(args || {}));
      case "memory_get_session_context":
        return asToolResult(await handleMemoryGetSessionContext(args || {}));
      default:
        throw new Error(`Unknown memory tool: ${name}`);
    }
  } catch (err) {
    log("warn", `[memory] ${name} failed: ${err.message}`);
    return formatToolError(err);
  }
}

/**
 * Names of the six memory tools, exported so server-http.js can quickly route
 * incoming tool calls without enumerating each case.
 */
export const MEMORY_TOOL_NAMES = new Set([
  "memory_write",
  "memory_read",
  "memory_search",
  "memory_delete",
  "memory_list",
  "memory_get_session_context",
]);

/**
 * Helper for the connector's /health endpoint: returns the live corpus
 * snapshot in the same shape as the standalone service.
 */
export function getMemoryHealthSnapshot() {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const rows = db
      .prepare(
        "SELECT category, COUNT(*) AS n FROM memories WHERE (ttl IS NULL OR ttl > ?) GROUP BY category",
      )
      .all(now);
    const byCategory = {};
    let total = 0;
    for (const r of rows) {
      byCategory[r.category] = r.n;
      total += r.n;
    }
    return { enabled: true, entry_count: total, by_category: byCategory };
  } catch (err) {
    return { enabled: false, error: err.message };
  }
}
