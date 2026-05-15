// src/tools/memory-list.js
// Tool handler for memory_list (TDD Section 6.5).
// Summary list. Omits value by default to keep responses lean.

import { getDb } from "./db.js";
import { memoryListSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

export async function handleMemoryList(rawArgs) {
  const parsed = memoryListSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_list.",
      400,
      parsed.error.flatten(),
    );
  }
  const args = parsed.data;

  const db = getDb();
  const now = nowIso();

  const where = ["(ttl IS NULL OR ttl > ?)"];
  const params = [now];

  if (args.category) {
    where.push("category = ?");
    params.push(args.category);
  }

  const sql = `SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`;
  const rows = db.prepare(sql).all(...params);

  const entries = rows.map((r) => {
    const base = rowToEntry(r, { includeValue: args.include_value });
    // memory_list response (TDD) does not include created_at, ttl, etc. We
    // surface the documented subset.
    const out = {
      id: base.id,
      category: base.category,
      key: base.key,
      tags: base.tags,
      updated_at: base.updated_at,
    };
    if (args.include_value) out.value = base.value;
    return out;
  });

  const byCategory = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  }

  return {
    entries,
    total: entries.length,
    by_category: byCategory,
  };
}
