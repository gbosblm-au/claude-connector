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
  memoryRecheckDueSchema,
  MAX_VALUE_LENGTH,
} from './schemas/index.js';
import { ToolError } from './errors.js';
// v13.39.0 (TENAX-2026-10-15-01 H-6, H-10): the shared write guard.
import { guardMemoryWrite, redactDeepForInjection } from './memoryWriteGuard.js';
// v13.41.0 (Gateway WO-ISO-276-001 A3): the account each tenant-mode memory
// call acts for, from the per-call context or TS_CLIENT_USER_ID.
import { resolveMemoryUserId } from '../utils/callContext.js';

/* =========================================================================
   HTTP helper
   ========================================================================= */

// ---------------------------------------------------------------------------
// v12.0.0: Tenant-aware config and fetch.
// In tenant mode, memory calls route to the ts-gateway/v1/memory/* endpoints
// with api_key in the POST body. In owner mode, the original wp-memory path
// is used with X-Ava-Memory-Key header.
// ---------------------------------------------------------------------------

function getClientMode() {
  return (process.env.TS_CLIENT_MODE || 'owner').toLowerCase();
}

function getGatewayConfig() {
  const gatewayUrl = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
  const apiKey     = process.env.TS_CLIENT_API_KEY || '';
  const tenantId   = process.env.TS_TENANT_ID || '';
  if (!gatewayUrl || !apiKey) {
    throw new ToolError(
      'TENANT_GATEWAY_NOT_CONFIGURED',
      'TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY must both be set for tenant memory access.',
      503,
    );
  }
  return { gatewayUrl, apiKey, tenantId };
}

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

/**
 * Unified memory fetch. In tenant mode routes to the gateway memory endpoints.
 * In owner mode uses the existing wp-memory path unchanged.
 *
 * Tenant gateway endpoints expect { api_key, ...payload } in the POST body.
 * The gateway validates the key, resolves the tenant_id, and namespaces the record.
 */
async function wpFetch(path, options = {}) {
  const mode = getClientMode();

  if (mode === 'tenant') {
    const { gatewayUrl, apiKey } = getGatewayConfig();
    // Remap owner memory paths to gateway memory paths
    // e.g. /write -> /memory/write, /read -> /memory/read
    const segment = path.replace(/^\//, '');
    const url = `${gatewayUrl}/memory/${segment}`;

    // Inject api_key into the POST body
    let body = {};
    if (options.body) {
      try { body = JSON.parse(options.body); } catch (_) {}
    }
    body.api_key = apiKey;

    // v13.41.0 (Gateway WO-ISO-276-001 A3): name the account. Gateway 2.277.0
    // refuses a memory request without one (it used to fall back to every
    // tenant-wide and ownerless row). Refused here, before anything is sent,
    // when no account can be named; the reason says how to name one.
    const who = resolveMemoryUserId();
    if (!who.ok) {
      throw new ToolError(
        'TENANT_USER_REQUIRED',
        `Tenant memory refused: ${who.reason}. Set TS_CLIENT_USER_ID to the gateway account this connector acts for, or call through the gateway, which supplies it per call.`,
        400,
      );
    }
    body.user_id = who.userId;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':   'claude-connector/12.0.0 (ts-gateway-tenant-memory)',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (netErr) {
      throw new ToolError(
        'TENANT_GATEWAY_NETWORK_ERROR',
        `Cannot reach tenant memory gateway at ${gatewayUrl}: ${netErr.message}`,
        503,
      );
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let detail = bodyText.slice(0, 300);
      try {
        const parsed = JSON.parse(bodyText);
        detail = parsed.error || parsed.message || detail;
      } catch (_) {}
      throw new ToolError(
        'TENANT_GATEWAY_API_ERROR',
        `Tenant memory gateway returned ${res.status}: ${detail}`,
        res.status >= 500 ? 502 : res.status,
      );
    }

    return res.json();
  }

  // Owner mode: original behaviour unchanged
  const { wpUrl, wpKey } = getWpConfig();
  const url = `${wpUrl}${path}`;

  const headers = {
    'X-Ava-Memory-Key': wpKey,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-connector/12.0.0 (ava-memory-mysql-primary)',
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

  // ── H-6 / H-10: the shared write guard, against the writer's visible scope ──
  //
  // The scope is read before the write: /stats for the count the capacity
  // ceiling applies to, /list?include_value=true for the values the duplicate
  // guard compares (the store's list is bounded at its most recent 500; in
  // tenant mode the gateway route re-checks against every row). If the scope
  // cannot be read the write is refused: a guard that cannot see what it
  // guards has not checked anything, and storing anyway is the fail-open.
  let scopeRows;
  let scopeCount;
  try {
    const [stats, listed] = await Promise.all([
      // Same call shapes as getWpMemoryHealthSnapshot and handleWpMemoryList.
      wpFetch('/stats'),
      wpFetch('/list?include_value=true'),
    ]);
    // /stats counts every visible row; /list is bounded, so the true count
    // goes to the guard separately and the ceiling sees it even when the
    // listing was cut. Consolidation candidates come from the listed rows.
    scopeCount = (stats.categories || []).reduce((n, r) => n + (parseInt(r.count, 10) || 0), 0);
    scopeRows = (listed.entries || []).map((e) => ({ category: e.category, key: e.key ?? e.key_name, value: e.value, updated_at: e.updated_at }));
  } catch (err) {
    throw new ToolError('MEMORY_GUARD_UNAVAILABLE',
      `Refused: the memory store's current entries could not be read to check this write (${err.message}). Nothing was stored; try again.`, 503);
  }
  const decision = guardMemoryWrite({
    category: args.category,
    key: args.key,
    value: args.value,
    scopeRows,
    scopeCount,
    recheckClass: args.recheck_class ?? null,
    recheckAfterDays: args.recheck_after_days ?? null,
  });
  if (!decision.ok) {
    const { ok: _ok, code, reason, ...details } = decision;
    throw new ToolError(code, reason, code === 'MEMORY_DUPLICATE' || code === 'MEMORY_AT_CAPACITY' ? 409 : 400,
      Object.keys(details).length ? details : null);
  }
  let storedValue = typeof args.value === 'string' ? JSON.stringify(decision.text) : decision.text;
  try { JSON.parse(storedValue); } catch { storedValue = JSON.stringify(decision.text); }

  // Calculate TTL ISO string if ttl_days provided.
  let ttl = null;
  if (args.ttl_days != null) {
    ttl = new Date(Date.now() + args.ttl_days * 86400000).toISOString();
  }

  const body = {
    category:       args.category,
    key_name:       args.key,
    value:          storedValue,
    tags:           JSON.stringify(args.tags || []),
    ttl,
    source_session: args.source_session ?? null,
    confidence:     args.confidence ?? 1.0,
    // v13.39.0 (H-10): the re-check obligation, decided by the shared guard.
    recheck_class:      decision.recheck.recheck_class,
    recheck_at:         decision.recheck.recheck_at,
    verified_source:    args.verified_source ?? null,
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
    redactions: decision.redactions.length ? decision.redactions : undefined,
    recheck_class: decision.recheck.recheck_class,
    recheck_at: decision.recheck.recheck_at,
    recheck_inferred: decision.recheck.recheck_class ? decision.recheck.inferred : undefined,
  };
}

/* =========================================================================
   memory_recheck_due  (v13.39.0, TENAX-2026-10-15-01 H-10)
   ========================================================================= */

export async function handleWpMemoryRecheckDue(rawArgs) {
  const parsed = memoryRecheckDueSchema.safeParse(rawArgs || {});
  if (!parsed.success) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid input for memory_recheck_due.', 400, parsed.error.flatten());
  }
  const result = await wpFetch(`/recheck-due?limit=${parsed.data.limit}`);
  return {
    entries: redactDeepForInjection(result.entries || []),
    count: result.count ?? (result.entries || []).length,
    note: 'Each entry is due to be re-verified by reading its artefact. Nothing has been removed or demoted.',
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

  // v13.39.0 (H-6): redaction before injection, as on the SQLite store.
  return {
    entries: redactDeepForInjection(result.entries || []),
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
    entries: redactDeepForInjection(result.entries || []),
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
    entries:     redactDeepForInjection(result.entries || []),
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
  //
  // SPEC-2026-09-06 Section 3.5. This is an explicit field whitelist, not a
  // spread, so a field added upstream is DROPPED here rather than forwarded.
  // The gateway's new `tiered` array would therefore have been assembled,
  // serialised, sent, and then discarded one function short of the model --
  // the retrieval would have looked correct in every gateway log and changed
  // nothing the model could see.
  //
  // `tiered` is defaulted to an empty array rather than left undefined so that
  // a gateway running a pre-tiering build (or the WordPress memory router,
  // which has not been ported yet) yields a readable empty result instead of
  // an absent key that a caller would have to guard.
  return {
    context:             redactDeepForInjection(result.context),
    assembled_at:        result.assembled_at,
    entry_count:         result.entry_count,
    context_hint:        result.context_hint ?? null,
    conversations_mode:  result.conversations_mode,
    conversations_tiers: result.conversations_tiers ?? {
      exact: 0, related: 0, associative: 0, recency: 0,
    },
    tiered:              Array.isArray( result.tiered ) ? redactDeepForInjection( result.tiered ) : [],
    // v13.39.0 (H-10): the gateway's past-due list. Whitelisted here for the
    // same reason as `tiered`: a field this function does not copy never
    // reaches the model. Defaulted so a pre-2.262.0 gateway reads as empty.
    recheck_due:         Array.isArray( result.recheck_due ) ? redactDeepForInjection( result.recheck_due ) : [],
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
