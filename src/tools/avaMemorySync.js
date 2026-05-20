// src/tools/avaMemorySync.js
// Three tools for durable MySQL-backed memory via the ts-ava-memory WordPress plugin.
//
//   ava_memory_backup        Push all Railway SQLite records to WordPress MySQL.
//   ava_memory_restore       Pull all WordPress MySQL records back into Railway SQLite.
//   ava_memory_sync_status   Compare record counts and last-updated timestamps.
//
// Both backup and restore use bulk upsert so they are safe to call repeatedly;
// they are idempotent.  Backup should be called at session close; restore should
// be called automatically when the Railway memory store is detected as empty on
// session open.

import { config } from '../config.js';

/* =========================================================================
   TOOL DEFINITIONS
   ========================================================================= */

export const avaMemoryBackupToolDefinition = {
  name: 'ava_memory_backup',
  description:
    'Push ALL records currently in the Railway SQLite memory store to the ' +
    'WordPress MySQL durable backup (ts-ava-memory plugin). Call this at the ' +
    'end of every substantive session to ensure memory survives a Railway reset. ' +
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
    'Pull ALL records from the WordPress MySQL durable backup into the Railway ' +
    'SQLite memory store. Call this automatically on session open when the Railway ' +
    'memory store is found to be empty (0 records). ' +
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
    'Compare the Railway SQLite memory store against the WordPress MySQL durable ' +
    'backup. Returns record counts for both stores, the most-recent updated_at ' +
    'timestamp in each, and a recommendation on whether a backup or restore is needed.',
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
    'User-Agent': 'claude-connector/7.0.1 (ava-memory-sync)',
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
 * dispatchMemoryTool handler.  We import lazily to avoid circular dependency
 * and to handle the case where memory is disabled.
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
            value:          entry.value,   // already a string from SQLite
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
      // Parse value back if it is a JSON string.
      let parsedValue;
      try {
        parsedValue = JSON.parse(record.value);
      } catch {
        parsedValue = record.value;
      }

      // Calculate ttl_days if ttl timestamp is provided.
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

export async function handleAvaMemoryBackup(args) {
  const { wpUrl, wpKey } = getWpConfig();
  const includeCategories = args.include_categories || [];

  // 1. Read all records from Railway SQLite.
  const records = await readAllRailwayRecords(includeCategories);

  if (records.length === 0) {
    return {
      success: true,
      message: 'Railway memory store is empty - nothing to back up.',
      railway_records: 0,
      wordpress_result: null,
    };
  }

  // 2. Push to WordPress in bulk.
  const wpResult = await wpFetch(wpUrl, wpKey, '/bulk-upsert', {
    method: 'POST',
    body: JSON.stringify({ records }),
  });

  return {
    success:          true,
    message:          `Backup complete. ${records.length} records pushed to WordPress MySQL.`,
    railway_records:  records.length,
    wordpress_result: wpResult.results,
    backed_up_at:     new Date().toISOString(),
  };
}

export async function handleAvaMemoryRestore(args) {
  const { wpUrl, wpKey } = getWpConfig();

  // 1. Fetch all records from WordPress.
  const wpData = await wpFetch(wpUrl, wpKey, '/all');

  if (!wpData.records || wpData.records.length === 0) {
    return {
      success: true,
      message: 'WordPress MySQL backup is empty - nothing to restore.',
      wordpress_records: 0,
      railway_result: null,
    };
  }

  // 2. Write into Railway SQLite.
  const railwayResult = await writeRecordsToRailway(wpData.records);

  return {
    success:           true,
    message:           `Restore complete. ${wpData.records.length} records pulled from WordPress MySQL.`,
    wordpress_records: wpData.records.length,
    railway_result:    railwayResult,
    restored_at:       new Date().toISOString(),
  };
}

export async function handleAvaMemorySyncStatus() {
  const { wpUrl, wpKey } = getWpConfig();

  // 1. WordPress stats.
  let wpStats;
  try {
    wpStats = await wpFetch(wpUrl, wpKey, '/stats');
  } catch (err) {
    wpStats = { error: err.message, total: null };
  }

  // 2. Railway stats via memory_list across all categories.
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

  // 3. Recommendation.
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
