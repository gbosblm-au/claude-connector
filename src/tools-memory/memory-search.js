// src/tools/memory-search.js
// Tool handler for memory_search (TDD Section 6.3).
// Full-text search over the FTS5 virtual table joined back to the primary
// memories table to surface full row metadata. Results ranked by BM25.

import { getDb } from "./db.js";
import { memorySearchSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

/**
 * Sanitise an FTS5 query so callers can pass natural-language strings without
 * triggering syntax errors. Preserves explicit FTS5 operators (* " AND OR NOT)
 * when present, but escapes lone single quotes and trims surrounding noise.
 *
 * Rationale: Claude often supplies raw conversational search terms. The TDD
 * states FTS5 match syntax is supported (Section 6.3), but unintentional
 * special characters in user input would otherwise yield SQLite errors.
 */
function safeFtsQuery(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  // If the caller is clearly using FTS5 syntax, pass through unchanged.
  if (/["*]|\b(AND|OR|NOT|NEAR)\b/.test(trimmed)) {
    return trimmed.replace(/'/g, "''");
  }

  // Otherwise, split on whitespace and wrap each token to match prefix-OR-not.
  // We quote tokens to avoid colon-based column filters being misinterpreted.
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export async function handleMemorySearch(rawArgs) {
  const parsed = memorySearchSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_search.",
      400,
      parsed.error.flatten(),
    );
  }
  const args = parsed.data;

  const db = getDb();
  const now = nowIso();
  const ftsQuery = safeFtsQuery(args.query);

  if (!ftsQuery) {
    return { results: [], count: 0 };
  }

  const where = ["memories_fts MATCH ?", "(m.ttl IS NULL OR m.ttl > ?)"];
  const params = [ftsQuery, now];

  if (args.category) {
    where.push("m.category = ?");
    params.push(args.category);
  }

  const sql = `
    SELECT m.*, bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
     WHERE ${where.join(" AND ")}
     ORDER BY rank
     LIMIT ?
  `;
  params.push(args.limit);

  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch (err) {
    throw new ToolError(
      "VALIDATION_ERROR",
      `FTS5 query rejected: ${err.message}`,
      400,
    );
  }

  const results = rows.map((r) => ({
    ...rowToEntry(r, { includeValue: true }),
    rank: typeof r.rank === "number" ? r.rank : null,
  }));
  return { results, count: results.length };
}
