// src/tools/avaMemorySync.js
// Three tools for memory management and health reporting.
//
// v10.3.0: MySQL-primary mode awareness added.
//
// When AVA_MEMORY_WP_URL + AVA_MEMORY_WP_KEY are set, MySQL IS the primary
// memory store. All memory_* tool calls go directly to MySQL via the WordPress
// REST API. There is no Railway SQLite layer to sync. In this mode:
//
//   ava_memory_backup     - Returns an informational message confirming MySQL
//                           is already the live store. No action taken.
//   ava_memory_restore    - Returns an informational message confirming MySQL
//                           is already the live store. No action taken.
//   ava_memory_sync_status - Returns live MySQL health stats (entry counts by
//                            category, last updated timestamp).
//
// When MEMORY_AUTH_TOKEN is set without WP keys (SQLite fallback mode), the
// original backup / restore / sync behaviour is preserved unchanged.
//
// Both backup and restore in SQLite mode use bulk upsert so they are safe to
// call repeatedly; they are idempotent. Backup should be called at session
// close; restore should be called automatically when the Railway memory store
// is detected as empty on session open.

import { config } from '../config.js';

/* =========================================================================
   Mode detection
   ========================================================================= */

/**
 * Returns true when MySQL is the primary memory store (WP keys configured).
 * Returns false when SQLite fallback is active (MEMORY_AUTH_TOKEN only).
 */
function isMysqlPrimaryMode() {
  return !!(config.avaMemoryWpUrl && config.avaMemoryWpKey);
}

/* =========================================================================
   TOOL DEFINITIONS
   ========================================================================= */

export const avaMemoryBackupToolDefinition = {
  name: 'ava_memory_backup',
  description:
    'In MySQL-primary mode: confirms that MySQL is already the live memory store ' +
    'and no backup action is required. In SQLite fallback mode: push ALL records ' +
    'currently in the Railway SQLite memory store to the WordPress MySQL durable ' +
    'backup (ts-ava-memory plugin). Call this at the end of every substantive ' +
    'session to ensure memory survives a Railway reset. ' +
    'The operation is a full bulk-upsert: safe to call multiple times. ' +
    'Returns a summary of inserted and updated record counts.',
  inputSchema: {
    type: 'object',
    properties: {
      include_categories: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional. Limit backup to these categories. ' +
          'Omit to back up all categories (recommended).',
      },
    },
    required: [],
  },
};

export const avaMemoryRestoreToolDefinition = {
  name: 'ava_memory_restore',
  description:
    'In MySQL-primary mode: confirms that MySQL is already the live memory store ' +
    'and no restore action is required. In SQLite fallback mode: pull ALL records ' +
    'from the WordPress MySQL durable backup into the Railway SQLite memory store. ' +
    'Call this automatically on session open when the Railway memory store is ' +
    'found to be empty (0 records). ' +
    'The operation is a full bulk-upsert: safe to call multiple times. ' +
    'Returns a summary of inserted and updated record counts.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const avaMemorySyncStatusToolDefinition = {
  name: 'ava_memory_sync_status',
  description:
    'In MySQL-primary mode: returns live MySQL memory health stats (entry counts ' +
    'by category, total records, last updated timestamp, and active store mode). ' +
    'In SQLite fallback mode: compares the Railway SQLite memory store against the ' +
    'WordPress MySQL durable backup, returning record counts for both stores, the ' +
    'most-recent updated_at timestamp in each, and a recommendation on whether a ' +
    'backup or restore is needed.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/* =========================================================================
   HELPERS
   ========================================================================= */

function getWpConfig() {
  const wpUrl = (config.avaMemoryWpUrl || '').replace(/\/$/, '');
  const wpKey = config.avaMemoryWpKey || '';

  if (!wpUrl || !wpKey) {
    throw new Error(
      'AVA_MEMORY_WP_URL and AVA_MEMORY_WP_KEY must be set in Railway Variables. ' +
      'See the ts-ava-memory WordPress plugin settings page for the correct values.',
    );
  }

  return { wpUrl, wpKey };
}

async function wpFetch(wpUrl, wpKey, path, options = {}) {
  const url = `${wpUrl}${path}`;
  const headers = {
    'X-Ava-Memory-Key': wpKey,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-connector/10.3.0 (ava-memory-sync)',
    ...options.headers,
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WordPress ava-memory API error ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * Read all records from the Railway SQLite memory store via the internal
 * dispatchMemoryTool handler. Used only in SQLite fallback mode.
 * Lazy import avoids circular dependency and handles disabled memory gracefully.
 */
async function readAllRailwayRecords(includeCategories) {
  let dispatchFn;
  try {
    const mod = await import('../tools-memory/index.js');
    dispatchFn = mod.dispatchMemoryTool;
  } catch {
    throw new Error(
      'Railway memory subsystem is not available. ' +
      'Ensure MEMORY_AUTH_TOKEN is set and the memory subsystem is initialised.',
    );
  }

  const CATEGORIES = ['projects', 'skills', 'preferences', 'contacts', 'facts', 'session', 'conversations'];
  const targets = includeCategories && includeCategories.length > 0
    ? includeCategories.filter(c => CATEGORIES.includes(c))
    : CATEGORIES;

  const records = [];

  for (const category of targets) {
    try {
      const result = await dispatchFn('memory_list', { category, limit: 500 });
      if (result && result.entries) {
        for (const entry of result.entries) {
          records.push({
            id:             entry.id,
            category:       entry.category,
            key_name:       entry.key,
            value:          entry.value,
            tags:           entry.tags,
            created_at:     entry.created_at,
            updated_at:     entry.updated_at,
            ttl:            entry.ttl ?? null,
            source_session: entry.source_session ?? null,
            confidence:     entry.confidence ?? 1.0,
          });
        }
      }
    } catch {
      // Category may be empty - not an error.
    }
  }

  return records;
}

/**
 * Write records into Railway SQLite via dispatchMemoryTool.
 * Used only in SQLite fallback mode.
 */
async function writeRecordsToRailway(records) {
  let dispatchFn;
  try {
    const mod = await import('../tools-memory/index.js');
    dispatchFn = mod.dispatchMemoryTool;
  } catch {
    throw new Error(
      'Railway memory subsystem is not available. ' +
      'Ensure MEMORY_AUTH_TOKEN is set and the memory subsystem is initialised.',
    );
  }

  const results = { inserted: 0, updated: 0, errors: [] };

  for (const record of records) {
    try {
      let parsedValue;
      try {
        parsedValue = JSON.parse(record.value);
      } catch {
        parsedValue = record.value;
      }

      let ttl_days = null;
      if (record.ttl) {
        const expiresAt = new Date(record.ttl).getTime();
        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          // Skip expired records.
          continue;
        }
        ttl_days = remainingMs / (1000 * 60 * 60 * 24);
      }

      const res = await dispatchFn('memory_write', {
        category:       record.category,
        key:            record.key_name || record.key,
        value:          parsedValue,
        tags:           record.tags,
        source_session: record.source_session,
        confidence:     record.confidence,
        ...(ttl_days ? { ttl_days } : {}),
      });

      if (res && res.operation === 'created') {
        results.inserted++;
      } else {
        results.updated++;
      }
    } catch (err) {
      results.errors.push({
        key:   record.key_name || record.key,
        error: err.message,
      });
    }
  }

  return results;
}

/* =========================================================================
   HANDLERS
   ========================================================================= */

/**
 * ava_memory_backup
 *
 * MySQL-primary mode: no-op. Returns a clear message explaining that MySQL
 * is already the live store and no backup step is required.
 *
 * SQLite fallback mode: reads all records from Railway SQLite and pushes
 * them to WordPress MySQL via bulk-upsert.
 */
export async function handleAvaMemoryBackup(args) {
  // MySQL-primary mode: MySQL IS the store. There is no SQLite layer to back up.
  if (isMysqlPrimaryMode()) {
    return {
      success:   true,
      mode:      'mysql-primary',
      message:
        'Running in MySQL-primary mode. All memory_write calls go directly to ' +
        'MySQL via the WordPress REST API. There is no Railway SQLite layer. ' +
        'No backup action is required or possible.',
      backed_up_at: new Date().toISOString(),
    };
  }

  // SQLite fallback mode: original backup logic.
  const { wpUrl, wpKey } = getWpConfig();
  const includeCategories = args.include_categories || [];

  const records = await readAllRailwayRecords(includeCategories);

  if (records.length === 0) {
    return {
      success:          true,
      mode:             'sqlite-fallback',
      message:          'Railway memory store is empty - nothing to back up.',
      railway_records:  0,
      wordpress_result: null,
    };
  }

  const wpResult = await wpFetch(wpUrl, wpKey, '/bulk-upsert', {
    method: 'POST',
    body: JSON.stringify({ records }),
  });

  return {
    success:          true,
    mode:             'sqlite-fallback',
    message:          `Backup complete. ${records.length} records pushed to WordPress MySQL.`,
    railway_records:  records.length,
    wordpress_result: wpResult.results,
    backed_up_at:     new Date().toISOString(),
  };
}

/**
 * ava_memory_restore
 *
 * MySQL-primary mode: no-op. Returns a clear message explaining that MySQL
 * is already the live store and no restore step is required.
 *
 * SQLite fallback mode: pulls all records from WordPress MySQL and writes
 * them into Railway SQLite.
 */
export async function handleAvaMemoryRestore(args) {
  // MySQL-primary mode: MySQL IS the store. There is no SQLite layer to restore into.
  if (isMysqlPrimaryMode()) {
    return {
      success:      true,
      mode:         'mysql-primary',
      message:
        'Running in MySQL-primary mode. All memory_read calls go directly to ' +
        'MySQL via the WordPress REST API. There is no Railway SQLite layer. ' +
        'No restore action is required or possible.',
      restored_at: new Date().toISOString(),
    };
  }

  // SQLite fallback mode: original restore logic.
  const { wpUrl, wpKey } = getWpConfig();

  const wpData = await wpFetch(wpUrl, wpKey, '/all');

  if (!wpData.records || wpData.records.length === 0) {
    return {
      success:           true,
      mode:              'sqlite-fallback',
      message:           'WordPress MySQL backup is empty - nothing to restore.',
      wordpress_records: 0,
      railway_result:    null,
    };
  }

  const railwayResult = await writeRecordsToRailway(wpData.records);

  return {
    success:           true,
    mode:              'sqlite-fallback',
    message:           `Restore complete. ${wpData.records.length} records pulled from WordPress MySQL.`,
    wordpress_records: wpData.records.length,
    railway_result:    railwayResult,
    restored_at:       new Date().toISOString(),
  };
}

/**
 * ava_memory_sync_status
 *
 * MySQL-primary mode: returns live MySQL health stats from the /stats endpoint.
 * No SQLite comparison is performed because there is no SQLite layer.
 *
 * SQLite fallback mode: compares Railway SQLite vs WordPress MySQL record
 * counts and returns a sync recommendation.
 */
export async function handleAvaMemorySyncStatus() {
  if (isMysqlPrimaryMode()) {
    // MySQL-primary mode: report MySQL health directly.
    const { wpUrl, wpKey } = getWpConfig();

    let wpStats;
    let error = null;
    try {
      wpStats = await wpFetch(wpUrl, wpKey, '/stats');
    } catch (err) {
      wpStats = null;
      error = err.message;
    }

    // Derive last_updated from the latest updated_at in the entries, if available.
    let lastUpdated = null;
    let byCategory = {};
    let total = 0;

    if (wpStats) {
      for (const row of wpStats.categories || []) {
        const count = parseInt(row.count, 10) || 0;
        byCategory[row.category] = count;
        total += count;
      }
      lastUpdated = wpStats.last_updated || null;
    }

    return {
      mode:        'mysql-primary',
      description: 'Memory reads and writes go directly to MySQL. No SQLite layer is active.',
      mysql: {
        connected:    error === null,
        total_records: total,
        by_category:  byCategory,
        last_updated: lastUpdated,
        error:        error,
        endpoint:     config.avaMemoryWpUrl || null,
      },
      checked_at: new Date().toISOString(),
    };
  }

  // SQLite fallback mode: original comparison logic.
  const { wpUrl, wpKey } = getWpConfig();

  let wpStats;
  try {
    wpStats = await wpFetch(wpUrl, wpKey, '/stats');
  } catch (err) {
    wpStats = { error: err.message, total: null };
  }

  let railwayTotal = 0;
  let railwayLastUpdated = null;

  try {
    const records = await readAllRailwayRecords([]);
    railwayTotal = records.length;
    if (records.length > 0) {
      const sorted = records
        .map(r => r.updated_at)
        .filter(Boolean)
        .sort()
        .reverse();
      railwayLastUpdated = sorted[0] || null;
    }
  } catch (err) {
    railwayTotal = -1;
  }

  let recommendation = 'unknown';
  if (railwayTotal >= 0 && wpStats.total !== null) {
    if (railwayTotal === 0 && wpStats.total > 0) {
      recommendation = 'RESTORE_NEEDED - Railway store is empty, WordPress has records. Call ava_memory_restore.';
    } else if (railwayTotal > 0 && wpStats.total === 0) {
      recommendation = 'BACKUP_NEEDED - WordPress store is empty, Railway has records. Call ava_memory_backup.';
    } else if (railwayTotal === 0 && wpStats.total === 0) {
      recommendation = 'BOTH_EMPTY - No records in either store.';
    } else {
      recommendation = 'IN_SYNC - Both stores have records. Call ava_memory_backup at session close to keep WordPress current.';
    }
  }

  return {
    mode: 'sqlite-fallback',
    railway: {
      total:        railwayTotal,
      last_updated: railwayLastUpdated,
    },
    wordpress: {
      total:      wpStats.total,
      categories: wpStats.categories || [],
      error:      wpStats.error || null,
    },
    recommendation,
    checked_at: new Date().toISOString(),
  };
}
