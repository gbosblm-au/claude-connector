// src/utils/rowMapper.js
// Convert a raw SQLite row into the response shape defined in TDD Section 6.

// v13.39.0 (TENAX-2026-10-15-01 H-6): redaction before injection. Every read
// tool that hands memory to a model maps its rows here, so credential-shaped
// strings stored before the write guard existed are redacted on the way out.
// The admin export (a backup, not an injection) opts out with redact: false.
import { redactDeepForInjection } from "./memoryWriteGuard.js";

export function rowToEntry(row, { includeValue = true, redact = true } = {}) {
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
    // v13.39.0 (H-10): the re-check obligation travels with the entry. A
    // past-due date is a prompt to re-verify, never a reason to hide the entry.
    recheck_class: row.recheck_class ?? null,
    recheck_at: row.recheck_at ?? null,
    verified_at: row.verified_at ?? null,
    verified_source: row.verified_source ?? null,
  };
  if (includeValue) {
    const value = safeParseJson(row.value, row.value);
    entry.value = redact ? redactDeepForInjection(value) : value;
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
