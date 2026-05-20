// src/tools-memory/index.js
// Aggregator for the Memory MCP subsystem.
//
// Store selection (in priority order):
//   1. MySQL-primary (WordPress plugin) - when AVA_MEMORY_WP_URL + AVA_MEMORY_WP_KEY are set.
//      All six tools route through the WordPress REST API. Railway needs no
//      persistent storage. Memory survives Railway resets and redeploys.
//   2. SQLite fallback - when MEMORY_AUTH_TOKEN is set (legacy / local dev).
//      Original behaviour unchanged.
//   3. Disabled - when neither is configured.

import { config } from '../config.js';
import { log } from '../utils/logger.js';
import { asToolResult, formatToolError } from './errors.js';

// SQLite imports - lazy to avoid crashing when better-sqlite3 is unavailable.
let _sqliteHandlers = null;
let _sqliteInit     = null;
let _sqliteHealth   = () => ({ enabled: false });

// WordPress handlers - always importable (pure fetch, no native deps).
import {
  handleWpMemoryWrite,
  handleWpMemoryRead,
  handleWpMemorySearch,
  handleWpMemoryDelete,
  handleWpMemoryList,
  handleWpMemoryGetSessionContext,
  getWpMemoryHealthSnapshot,
} from './wp-memory.js';

export {
  memoryWriteToolDefinition,
  memoryReadToolDefinition,
  memorySearchToolDefinition,
  memoryDeleteToolDefinition,
  memoryListToolDefinition,
  memoryGetSessionContextToolDefinition,
  ALL_MEMORY_TOOL_DEFINITIONS,
} from './definitions.js';

// Which store is active for this deployment.
// Resolved once at initMemorySubsystem() time.
let _activeStore = 'disabled'; // 'wp' | 'sqlite' | 'disabled'

/**
 * Initialise the memory subsystem. Called once at server boot by server-http.js.
 * Determines active store; for SQLite, also opens the database file and starts
 * the TTL worker.
 */
export async function initMemorySubsystem({
  dbPath = process.env.MEMORY_DB_PATH || process.env.DB_PATH || '/data/memory.db',
  ttlIntervalMs = parseInt(process.env.TTL_WORKER_INTERVAL_MS || '3600000', 10),
} = {}) {

  const wpConfigured = !!(config.avaMemoryWpUrl && config.avaMemoryWpKey);
  const sqliteConfigured = !!process.env.MEMORY_AUTH_TOKEN;

  if (wpConfigured) {
    _activeStore = 'wp';
    log('info', `[memory] store=mysql-primary via ${config.avaMemoryWpUrl}`);

    // Ping the WordPress health endpoint to confirm reachability.
    try {
      const snap = await getWpMemoryHealthSnapshot();
      log('info', `[memory] wordpress ping OK - ${snap.entry_count ?? '?'} records`);
    } catch (err) {
      // Non-fatal: tools still available, error surfaces on first use.
      log('warn', `[memory] wordpress ping failed: ${err.message}. Tools will surface error on first call.`);
    }
    return;
  }

  if (sqliteConfigured) {
    _activeStore = 'sqlite';
    log('info', `[memory] store=sqlite at ${dbPath}`);

    try {
      const { initDb } = await import('./db.js');
      const { startTtlWorker } = await import('./ttlExpiry.js');
      const handlers = await import('./memory-write.js').then(async () => ({
        write:          (await import('./memory-write.js')).handleMemoryWrite,
        read:           (await import('./memory-read.js')).handleMemoryRead,
        search:         (await import('./memory-search.js')).handleMemorySearch,
        delete:         (await import('./memory-delete.js')).handleMemoryDelete,
        list:           (await import('./memory-list.js')).handleMemoryList,
        sessionContext: (await import('./memory-get-session-context.js')).handleMemoryGetSessionContext,
      }));

      _sqliteHandlers = handlers;

      initDb(dbPath);
      log('info', `[memory] sqlite initialised at ${dbPath} (WAL mode)`);
      startTtlWorker({ intervalMs: ttlIntervalMs });
      log('info', `[memory] TTL worker started (interval ${ttlIntervalMs}ms)`);

      const { getDb } = await import('./db.js');
      _sqliteHealth = () => {
        try {
          const db  = getDb();
          const now = new Date().toISOString();
          const rows = db.prepare(
            'SELECT category, COUNT(*) AS n FROM memories WHERE (ttl IS NULL OR ttl > ?) GROUP BY category',
          ).all(now);
          const byCategory = {};
          let total = 0;
          for (const r of rows) {
            byCategory[r.category] = r.n;
            total += r.n;
          }
          return { enabled: true, store: 'sqlite', entry_count: total, by_category: byCategory };
        } catch (err) {
          return { enabled: false, store: 'sqlite', error: err.message };
        }
      };
    } catch (err) {
      log('error', `[memory] sqlite init failed: ${err.message}. Memory disabled.`);
      _activeStore = 'disabled';
    }
    return;
  }

  _activeStore = 'disabled';
  log('info', '[memory] disabled. Set AVA_MEMORY_WP_URL + AVA_MEMORY_WP_KEY (MySQL-primary) or MEMORY_AUTH_TOKEN (SQLite) to enable.');
}

/**
 * Dispatch a memory tool call to the active store.
 */
export async function dispatchMemoryTool(name, args) {
  try {
    if (_activeStore === 'wp') {
      return asToolResult(await dispatchToWp(name, args || {}));
    }

    if (_activeStore === 'sqlite' && _sqliteHandlers) {
      return asToolResult(await dispatchToSqlite(name, args || {}));
    }

    // Disabled.
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Memory subsystem is disabled. Set AVA_MEMORY_WP_URL + AVA_MEMORY_WP_KEY or MEMORY_AUTH_TOKEN.',
        code:  'MEMORY_DISABLED',
      }, null, 2) }],
      isError: true,
    };
  } catch (err) {
    log('warn', `[memory] ${name} failed: ${err.message}`);
    return formatToolError(err);
  }
}

async function dispatchToWp(name, args) {
  switch (name) {
    case 'memory_write':               return handleWpMemoryWrite(args);
    case 'memory_read':                return handleWpMemoryRead(args);
    case 'memory_search':              return handleWpMemorySearch(args);
    case 'memory_delete':              return handleWpMemoryDelete(args);
    case 'memory_list':                return handleWpMemoryList(args);
    case 'memory_get_session_context': return handleWpMemoryGetSessionContext(args);
    default: throw new Error(`Unknown memory tool: ${name}`);
  }
}

async function dispatchToSqlite(name, args) {
  const h = _sqliteHandlers;
  switch (name) {
    case 'memory_write':               return h.write(args);
    case 'memory_read':                return h.read(args);
    case 'memory_search':              return h.search(args);
    case 'memory_delete':              return h.delete(args);
    case 'memory_list':                return h.list(args);
    case 'memory_get_session_context': return h.sessionContext(args);
    default: throw new Error(`Unknown memory tool: ${name}`);
  }
}

/**
 * Names of the six memory tools - used by server-http.js for fast routing.
 */
export const MEMORY_TOOL_NAMES = new Set([
  'memory_write',
  'memory_read',
  'memory_search',
  'memory_delete',
  'memory_list',
  'memory_get_session_context',
]);

/**
 * Health snapshot for the /health endpoint.
 */
export async function getMemoryHealthSnapshot() {
  if (_activeStore === 'wp')     return getWpMemoryHealthSnapshot();
  if (_activeStore === 'sqlite') return _sqliteHealth();
  return { enabled: false, store: 'disabled' };
}

/**
 * Whether memory is active (either store). Used by server-http.js.
 */
export function isMemoryEnabled() {
  return _activeStore !== 'disabled';
}
