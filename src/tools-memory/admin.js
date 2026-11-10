// src/tools-memory/admin.js
// Full corpus JSON export. Called by the connector's
// GET /memory/admin/dump route after bearer-token validation.

import { getDb } from "./db.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

export function adminDumpHandler(_req, res) {
  const db = getDb();
  const now = nowIso();
  const rows = db
    .prepare(
      "SELECT * FROM memories WHERE (ttl IS NULL OR ttl > ?) ORDER BY category, key",
    )
    .all(now);
  // A backup carries the stored bytes; redaction applies on the injection
  // paths (rowToEntry's default), not to an export that may be re-imported.
  const entries = rows.map((r) => rowToEntry(r, { includeValue: true, redact: false }));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="memory_dump_${now.replace(/[:.]/g, "-")}.json"`,
  );
  res.status(200).json({
    exported_at: now,
    version: "10.0.0",
    total: entries.length,
    entries,
  });
}
