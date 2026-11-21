// src/tools/memory-write.js
// Tool handler for memory_write (TDD Section 6.1).
// Upsert semantics: insert if (category, key) is new, otherwise replace value,
// tags, ttl, confidence, and source_session on the existing row. The id and
// created_at fields are immutable after first insert.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { memoryWriteSchema, MAX_VALUE_LENGTH } from "./schemas/index.js";
import { ToolError } from "./errors.js";
// v13.39.0 (TENAX-2026-10-15-01 H-6, H-10): the shared write guard. The same
// file decides for the gateway's memory routes, byte for byte.
import { guardMemoryWrite } from "./memoryWriteGuard.js";

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

  // ── H-6 / H-10: scan, redact, re-check, duplicate and capacity ─────────
  //
  // The scope is every unexpired row: this SQLite store is single-owner, so
  // the rows the writer's prompts can read are all of them.
  const scopeRows = db
    .prepare("SELECT category, key, value, updated_at FROM memories WHERE (ttl IS NULL OR ttl > ?)")
    .all(now);
  const decision = guardMemoryWrite({
    category: args.category,
    key: args.key,
    value: args.value,
    scopeRows,
    recheckClass: args.recheck_class ?? null,
    recheckAfterDays: args.recheck_after_days ?? null,
  });
  if (!decision.ok) {
    const { ok: _ok, code, reason, ...details } = decision;
    throw new ToolError(code, reason, code === "MEMORY_DUPLICATE" || code === "MEMORY_AT_CAPACITY" ? 409 : 400,
      Object.keys(details).length ? details : null);
  }
  // A string value is stored as its JSON string; anything else as its
  // (redacted) JSON text, which redaction keeps parseable.
  let storedValue = typeof args.value === "string" ? JSON.stringify(decision.text) : decision.text;
  try { JSON.parse(storedValue); } catch { storedValue = JSON.stringify(decision.text); }
  const verifiedAt = args.verified_source ? now : null;

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
             confidence = ?,
             recheck_class = ?,
             recheck_at = ?,
             verified_at = COALESCE(?, verified_at),
             verified_source = COALESCE(?, verified_source)
       WHERE id = ?
    `);
    updateStmt.run(
      storedValue,
      tagsJson,
      now,
      ttl,
      sourceSession,
      confidence,
      decision.recheck.recheck_class,
      decision.recheck.recheck_at,
      verifiedAt,
      args.verified_source ?? null,
      id,
    );
  } else {
    id = uuidv4();
    operation = "created";
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (id, category, key, value, tags, created_at, updated_at, ttl, source_session, confidence,
         recheck_class, recheck_at, verified_at, verified_source)
      VALUES
        (?,  ?,        ?,   ?,     ?,    ?,          ?,          ?,   ?,              ?,
         ?,             ?,          ?,           ?)
    `);
    insertStmt.run(
      id,
      args.category,
      args.key,
      storedValue,
      tagsJson,
      now,
      now,
      ttl,
      sourceSession,
      confidence,
      decision.recheck.recheck_class,
      decision.recheck.recheck_at,
      verifiedAt,
      args.verified_source ?? null,
    );
  }

  return {
    success: true,
    id,
    operation,
    updated_at: now,
    // v13.39.0 (H-6, H-10): what the guard did to this write.
    redactions: decision.redactions.length ? decision.redactions : undefined,
    recheck_class: decision.recheck.recheck_class,
    recheck_at: decision.recheck.recheck_at,
    recheck_inferred: decision.recheck.recheck_class ? decision.recheck.inferred : undefined,
  };
}
