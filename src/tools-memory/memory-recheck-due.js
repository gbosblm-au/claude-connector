// src/tools-memory/memory-recheck-due.js  (claude-connector v13.39.0)
// TENAX-2026-10-15-01 H-10: the SQLite half of memory_recheck_due.
//
// Lists entries whose re-check date has passed. Read-only: an expired re-check
// is an obligation to re-verify by reading the artefact, never a removal or a
// demotion. TTL expiry (ttlExpiry.js) is a different mechanism and is not
// touched here; a past-due entry stays in every read until someone rewrites it.

import { getDb } from "./db.js";
import { memoryRecheckDueSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry } from "./rowMapper.js";

export async function handleMemoryRecheckDue(rawArgs) {
  const parsed = memoryRecheckDueSchema.safeParse(rawArgs || {});
  if (!parsed.success) {
    throw new ToolError("VALIDATION_ERROR", "Invalid input for memory_recheck_due.", 400, parsed.error.flatten());
  }
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(
      `SELECT * FROM memories
        WHERE recheck_at IS NOT NULL AND recheck_at <= ?
          AND (ttl IS NULL OR ttl > ?)
        ORDER BY recheck_at ASC
        LIMIT ?`,
    )
    .all(now, now, parsed.data.limit);
  return {
    entries: rows.map((r) => rowToEntry(r)),
    count: rows.length,
    note: "Each entry is due to be re-verified by reading its artefact. Nothing has been removed or demoted.",
  };
}
