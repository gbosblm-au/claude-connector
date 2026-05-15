// src/tools-memory/memory-get-session-context.js
// Tool handler for memory_get_session_context (TDD Section 6.6).
//
// Assembles a curated context bundle:
//   - projects, preferences, facts: all entries (full inclusion)
//   - skills:         20 most recently updated
//   - contacts:       10 most recently updated
//   - session:         5 most recent
//   - conversations:   up to conversations_limit entries (default 5),
//                      selected by FTS5 relevance when context_hint is
//                      provided, otherwise by recency.
//
// context_hint enables ambient surfacing of relevant prior conversations
// without requiring the caller to know which keys to look up.

import { getDb } from "./db.js";
import { memorySessionContextSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

// Category caps for the standard recency-based retrieval path.
// null = unbounded (all entries returned).
// "conversations" is handled separately via the context_hint branch
// but still needs a recency cap for the no-hint fallback.
const CATEGORY_CAPS = {
  projects:      null,
  preferences:   null,
  facts:         null,
  skills:        20,
  contacts:      10,
  session:       5,
  // conversations is not listed here; handled by its own block below.
};

/**
 * Sanitise a natural-language string into a safe FTS5 match expression.
 * Mirrors the same helper in memory-search.js to avoid an import cycle.
 * Preserves explicit FTS5 operators when already present; otherwise wraps
 * each whitespace-separated token in double quotes for exact-token matching.
 */
function safeFtsQuery(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  // Pass through if the caller is using explicit FTS5 syntax.
  if (/["*]|\b(AND|OR|NOT|NEAR)\b/.test(trimmed)) {
    return trimmed.replace(/'/g, "''");
  }

  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export async function handleMemoryGetSessionContext(rawArgs) {
  const parsed = memorySessionContextSchema.safeParse(rawArgs || {});
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_get_session_context.",
      400,
      parsed.error.flatten(),
    );
  }

  const { context_hint, conversations_limit = 5 } = parsed.data;
  const db   = getDb();
  const now  = nowIso();

  const context = {
    projects:      {},
    skills:        {},
    preferences:   {},
    contacts:      {},
    facts:         {},
    session:       {},
    conversations: [],   // array: entries are episodic records, not named slots
  };

  let entryCount = 0;

  // -----------------------------------------------------------------------
  // Standard categories: recency-based retrieval with per-category caps.
  // -----------------------------------------------------------------------
  for (const [category, cap] of Object.entries(CATEGORY_CAPS)) {
    const params = [now, category];
    let sql = `
      SELECT * FROM memories
       WHERE (ttl IS NULL OR ttl > ?)
         AND category = ?
       ORDER BY updated_at DESC
    `;
    if (cap !== null) {
      sql += " LIMIT ?";
      params.push(cap);
    }
    const rows = db.prepare(sql).all(...params);
    for (const row of rows) {
      const entry = rowToEntry(row, { includeValue: true });
      context[category][entry.key] = entry.value;
      entryCount += 1;
    }
  }

  // -----------------------------------------------------------------------
  // Conversations category: relevance-ranked when context_hint supplied,
  // recency-ranked otherwise.
  // -----------------------------------------------------------------------
  const convLimit = Math.max(1, Math.min(conversations_limit ?? 5, 20));

  if (context_hint) {
    // FTS5 relevance path: surface conversations most relevant to the current topic.
    const ftsQuery = safeFtsQuery(context_hint);
    if (ftsQuery) {
      let convRows = [];
      try {
        const sql = `
          SELECT m.*, bm25(memories_fts) AS rank
            FROM memories_fts
            JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ?
             AND m.category = 'conversations'
             AND (m.ttl IS NULL OR m.ttl > ?)
           ORDER BY rank
           LIMIT ?
        `;
        convRows = db.prepare(sql).all(ftsQuery, now, convLimit);
      } catch (_ftsErr) {
        // FTS query rejected (e.g. malformed tokens) — fall back to recency.
        convRows = db
          .prepare(
            `SELECT * FROM memories
              WHERE (ttl IS NULL OR ttl > ?)
                AND category = 'conversations'
              ORDER BY updated_at DESC
              LIMIT ?`,
          )
          .all(now, convLimit);
      }
      for (const row of convRows) {
        context.conversations.push(rowToEntry(row, { includeValue: true }));
        entryCount += 1;
      }
    }
  } else {
    // Recency path: most recently updated conversations.
    const convRows = db
      .prepare(
        `SELECT * FROM memories
          WHERE (ttl IS NULL OR ttl > ?)
            AND category = 'conversations'
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(now, convLimit);
    for (const row of convRows) {
      context.conversations.push(rowToEntry(row, { includeValue: true }));
      entryCount += 1;
    }
  }

  return {
    context,
    assembled_at:   now,
    entry_count:    entryCount,
    context_hint:   context_hint ?? null,
    conversations_mode: context_hint ? "relevance" : "recency",
  };
}
