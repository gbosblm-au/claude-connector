// src/tools-memory/wp-memory.js
// WordPress MySQL-primary memory handlers.
//
// Replaces the SQLite-based handlers in memory-write.js, memory-read.js,
// memory-search.js, memory-delete.js, memory-list.js, and
// memory-get-session-context.js when AVA_MEMORY_WP_URL + AVA_MEMORY_WP_KEY
// are both set.
//
// All six memory_* tools keep identical names, input schemas, and response
// shapes. Claude sees no difference. Only the storage layer changes.
//
// Performance note: each tool call makes one HTTP request to the WordPress
// plugin REST API (~50-200ms). This is acceptable because memory operations
// are session-boundary events, not per-turn calls. The gain — permanent
// storage independent of Railway uptime — outweighs the latency cost.

import { config } from '../config.js';
import { log } from '../utils/logger.js';
import {
  memoryWriteSchema,
  memoryReadSchema,
  memorySearchSchema,
  memoryDeleteSchema,
  memoryListSchema,
  memorySessionContextSchema,
  MAX_VALUE_LENGTH,
} from './schemas/index.js';
import { ToolError } from './errors.js';

/* =========================================================================
   HTTP helper
   ========================================================================= */

function getWpConfig() {
  const wpUrl = (config.avaMemoryWpUrl || '').replace(/\/$/, '');
  const wpKey = config.avaMemoryWpKey || '';
  if (!wpUrl || !wpKey) {
    throw new ToolError(
      'WP_MEMORY_NOT_CONFIGURED',
      'AVA_MEMORY_WP_URL and AVA_MEMORY_WP_KEY must both be set in Railway Variables.',
      503,
    );
  }
  return { wpUrl, wpKey };
}

async function wpFetch(path, options = {}) {
  const { wpUrl, wpKey } = getWpConfig();
  const url = `${wpUrl}${path}`;

  const headers = {
    'X-Ava-Memory-Key': wpKey,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-connector/7.0.1 (ava-memory-mysql-primary)',
    ...options.headers,
  };

  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (netErr) {
    throw new ToolError(
      'WP_MEMORY_NETWORK_ERROR',
      `Cannot reach Ava Memory endpoint at ${wpUrl}: ${netErr.message}`,
      503,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.error || detail;
    } catch (_) { /* keep raw text */ }

    throw new ToolError(
      'WP_MEMORY_API_ERROR',
      `WordPress Ava Memory API returned ${res.status}: ${detail}`,
      res.status >= 500 ? 502 : res.status,
    );
  }

  return res.json();
}

/* =========================================================================
   memory_write
   ========================================================================= */

export async function handleWpMemoryWrite(rawArgs) {
  const parsed = memoryWriteSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_write.', 400, parsed.error.flatten());
  }
  const args = parsed.data;

  const serialisedValue = JSON.stringify(args.value);
  if (serialisedValue.length > MAX_VALUE_LENGTH) {
    throw new ToolError(
      'VALUE_TOO_LARGE',
      `Serialised value exceeds ${MAX_VALUE_LENGTH} characters (got ${serialisedValue.length}).`,
      400,
    );
  }

  // Calculate TTL ISO string if ttl_days provided.
  let ttl = null;
  if (args.ttl_days != null) {
    ttl = new Date(Date.now() + args.ttl_days * 86400000).toISOString();
  }

  const body = {
    category:       args.category,
    key_name:       args.key,
    value:          serialisedValue,
    tags:           JSON.stringify(args.tags || []),
    ttl,
    source_session: args.source_session ?? null,
    confidence:     args.confidence ?? 1.0,
  };

  const result = await wpFetch('/upsert', {
    method:  'POST',
    body:    JSON.stringify(body),
  });

  return {
    success:    true,
    id:         result.id,
    operation:  result.operation,
    updated_at: result.updated_at,
  };
}

/* =========================================================================
   memory_read
   ========================================================================= */

export async function handleWpMemoryRead(rawArgs) {
  const parsed = memoryReadSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const message =
      flat?.formErrors?.[0] ||
      Object.values(flat?.fieldErrors || {}).flat()[0] ||
      'Invalid input for memory_read.';

    if (message.includes('At least one of category, key, or a non-empty tags')) {
      throw new ToolError('NO_FILTER_PROVIDED', message, 400, flat);
    }
    throw new ToolError('VALIDATION_ERROR', message, 400, flat);
  }
  const args = parsed.data;

  const params = new URLSearchParams();
  if (args.category) params.set('category', args.category);
  if (args.key)      params.set('key', args.key);
  if (args.tags && args.tags.length > 0) params.set('tags', args.tags.join(','));
  if (args.limit)    params.set('limit', String(args.limit));

  const result = await wpFetch(`/read?${params.toString()}`);

  return {
    entries: result.entries || [],
    count:   result.count ?? 0,
  };
}

/* =========================================================================
   memory_search
   ========================================================================= */

export async function handleWpMemorySearch(rawArgs) {
  const parsed = memorySearchSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_search.', 400, parsed.error.flatten());
  }
  const args = parsed.data;

  const result = await wpFetch('/search', {
    method: 'POST',
    body:   JSON.stringify({
      query:    args.query,
      category: args.category ?? null,
      limit:    args.limit,
    }),
  });

  return {
    entries: result.entries || [],
    count:   result.count ?? 0,
    query:   args.query,
  };
}

/* =========================================================================
   memory_delete
   ========================================================================= */

export async function handleWpMemoryDelete(rawArgs) {
  const parsed = memoryDeleteSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_delete.', 400, parsed.error.flatten());
  }
  const args = parsed.data;

  const params = new URLSearchParams({
    category: args.category,
    key_name: args.key,
  });

  const result = await wpFetch(`/delete?${params.toString()}`, { method: 'DELETE' });

  return {
    success: true,
    deleted: result.deleted ?? false,
    key:     args.key,
    category: args.category,
  };
}

/* =========================================================================
   memory_list
   ========================================================================= */

export async function handleWpMemoryList(rawArgs) {
  const parsed = memoryListSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_list.', 400, parsed.error.flatten());
  }
  const args = parsed.data;

  const params = new URLSearchParams();
  if (args.category)     params.set('category', args.category);
  if (args.include_value) params.set('include_value', 'true');

  const result = await wpFetch(`/list?${params.toString()}`);

  return {
    entries:     result.entries || [],
    total:       result.total ?? 0,
    by_category: result.by_category ?? {},
  };
}

/* =========================================================================
   memory_get_session_context
   ========================================================================= */

export async function handleWpMemoryGetSessionContext(rawArgs) {
  const parsed = memorySessionContextSchema.safeParse(rawArgs || {});
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_get_session_context.', 400, parsed.error.flatten());
  }
  const args = parsed.data;

  const params = new URLSearchParams();
  if (args.context_hint)        params.set('context_hint', args.context_hint);
  if (args.conversations_limit) params.set('conversations_limit', String(args.conversations_limit));

  const result = await wpFetch(`/session-context?${params.toString()}`);

  // Return the response in the exact shape the connector's callers expect.
  return {
    context:             result.context,
    assembled_at:        result.assembled_at,
    entry_count:         result.entry_count,
    context_hint:        result.context_hint ?? null,
    conversations_mode:  result.conversations_mode,
    conversations_tiers: result.conversations_tiers ?? {
      exact: 0, related: 0, associative: 0, recency: 0,
    },
  };
}

/* =========================================================================
   Health snapshot (used by /health endpoint in server-http.js)
   ========================================================================= */

export async function getWpMemoryHealthSnapshot() {
  try {
    const result = await wpFetch('/stats');
    const byCategory = {};
    let total = 0;
    for (const row of result.categories || []) {
      byCategory[row.category] = parseInt(row.count, 10);
      total += byCategory[row.category];
    }
    return {
      enabled:      true,
      store:        'mysql-primary',
      entry_count:  total,
      by_category:  byCategory,
    };
  } catch (err) {
    log('warn', `[memory:wp] health snapshot failed: ${err.message}`);
    return { enabled: false, store: 'mysql-primary', error: err.message };
  }
}
