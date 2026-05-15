// src/tools/memory-read.js
// Tool handler for memory_read (TDD Section 6.2).
// Filtered retrieval. Requires at least one filter parameter (category, key,
// or non-empty tags) to prevent accidental full-corpus reads.

import { getDb } from "./db.js";
import { memoryReadSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

export async function handleMemoryRead(rawArgs) {
  const parsed = memoryReadSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const message =
      flat?.formErrors?.[0] ||
      Object.values(flat?.fieldErrors || {}).flat()[0] ||
      "Invalid input for memory_read.";

    // Distinguish the "no filter" case for the documented error code.
    if (
      message.includes("At least one of category, key, or a non-empty tags")
    ) {
      throw new ToolError("NO_FILTER_PROVIDED", message, 400, flat);
    }
    throw new ToolError("VALIDATION_ERROR", message, 400, flat);
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
  if (args.key) {
    where.push("key = ?");
    params.push(args.key);
  }

  let sql = `SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`;
  params.push(args.limit);

  let rows = db.prepare(sql).all(...params);

  // Tag filter is applied in JS because tags are stored as a JSON array. The
  // contract is "contains ALL supplied tags".
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    const required = new Set(args.tags);
    rows = rows.filter((row) => {
      let tagArr = [];
      try {
        tagArr = JSON.parse(row.tags || "[]");
      } catch (_) {
        tagArr = [];
      }
      const have = new Set(tagArr);
      for (const t of required) {
        if (!have.has(t)) return false;
      }
      return true;
    });
  }

  const entries = rows.map((r) => rowToEntry(r, { includeValue: true }));
  return { entries, count: entries.length };
}
