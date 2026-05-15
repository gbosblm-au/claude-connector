// src/utils/rowMapper.js
// Convert a raw SQLite row into the response shape defined in TDD Section 6.

export function rowToEntry(row, { includeValue = true } = {}) {
  if (!row) return null;
  const entry = {
    id: row.id,
    category: row.category,
    key: row.key,
    tags: safeParseJson(row.tags, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ttl: row.ttl ?? null,
    source_session: row.source_session ?? null,
    confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
  };
  if (includeValue) {
    entry.value = safeParseJson(row.value, row.value);
  }
  return entry;
}

export function safeParseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

/**
 * Return an ISO8601 string representing "now". Centralised here so tests can
 * monkey-patch a single source of truth if required.
 */
export function nowIso() {
  return new Date().toISOString();
}
