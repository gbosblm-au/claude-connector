// src/tools/memory-write.js
// Tool handler for memory_write (TDD Section 6.1).
// Upsert semantics: insert if (category, key) is new, otherwise replace value,
// tags, ttl, confidence, and source_session on the existing row. The id and
// created_at fields are immutable after first insert.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { memoryWriteSchema, MAX_VALUE_LENGTH } from "./schemas/index.js";
import { ToolError } from "./errors.js";

function nowIso() {
  return new Date().toISOString();
}

function ttlFromDays(days) {
  if (days === null || days === undefined) return null;
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

export async function handleMemoryWrite(rawArgs) {
  const parsed = memoryWriteSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_write.",
      400,
      parsed.error.flatten(),
    );
  }
  const args = parsed.data;

  const serialisedValue = JSON.stringify(args.value);
  if (serialisedValue.length > MAX_VALUE_LENGTH) {
    throw new ToolError(
      "VALUE_TOO_LARGE",
      `Serialised value exceeds ${MAX_VALUE_LENGTH} characters (got ${serialisedValue.length}).`,
      400,
    );
  }

  const db = getDb();
  const now = nowIso();
  const ttl = ttlFromDays(args.ttl_days);
  const tagsJson = JSON.stringify(args.tags || []);
  const sourceSession = args.source_session ?? null;
  const confidence = args.confidence ?? 1.0;

  const selectStmt = db.prepare(
    "SELECT id, created_at FROM memories WHERE category = ? AND key = ?",
  );
  const existing = selectStmt.get(args.category, args.key);

  let id;
  let operation;

  if (existing) {
    id = existing.id;
    operation = "updated";
    const updateStmt = db.prepare(`
      UPDATE memories
         SET value = ?,
             tags = ?,
             updated_at = ?,
             ttl = ?,
             source_session = ?,
             confidence = ?
       WHERE id = ?
    `);
    updateStmt.run(
      serialisedValue,
      tagsJson,
      now,
      ttl,
      sourceSession,
      confidence,
      id,
    );
  } else {
    id = uuidv4();
    operation = "created";
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (id, category, key, value, tags, created_at, updated_at, ttl, source_session, confidence)
      VALUES
        (?,  ?,        ?,   ?,     ?,    ?,          ?,          ?,   ?,              ?)
    `);
    insertStmt.run(
      id,
      args.category,
      args.key,
      serialisedValue,
      tagsJson,
      now,
      now,
      ttl,
      sourceSession,
      confidence,
    );
  }

  return {
    success: true,
    id,
    operation,
    updated_at: now,
  };
}
