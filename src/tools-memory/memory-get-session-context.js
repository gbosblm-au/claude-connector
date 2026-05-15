// src/tools/memory-get-session-context.js
// Tool handler for memory_get_session_context (TDD Section 6.6).
// Assembles a curated context bundle:
//   - projects, preferences, facts: all entries (full inclusion)
//   - skills:   20 most recently updated
//   - contacts: 10 most recently updated
//   - session:   5 most recent
// Expired entries (ttl in the past) are excluded universally.

import { getDb } from "./db.js";
import { memorySessionContextSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

const CATEGORY_CAPS = {
  projects: null, // unbounded
  preferences: null, // unbounded
  facts: null, // unbounded
  skills: 20,
  contacts: 10,
  session: 5,
};

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

  const db = getDb();
  const now = nowIso();

  const context = {
    projects: {},
    skills: {},
    preferences: {},
    contacts: {},
    facts: {},
    session: {},
  };

  let entryCount = 0;

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

  return {
    context,
    assembled_at: now,
    entry_count: entryCount,
  };
}
