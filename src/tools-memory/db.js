// src/db.js
// SQLite initialisation, schema DDL, FTS5 virtual table, and sync triggers.
// Implements TDD Section 5 (Data Model) verbatim.

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

let _db = null;

/**
 * Initialise the SQLite database, create schema if it does not exist, enable
 * WAL mode, and return a singleton Database instance.
 *
 * @param {string} dbPath Absolute or relative path to the SQLite file.
 * @returns {Database.Database}
 */
export function initDb(dbPath) {
  if (_db) return _db;

  const absolutePath = resolve(dbPath);
  const dir = dirname(absolutePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(absolutePath);

  // WAL mode for concurrent read safety while a write is in flight.
  // Rationale: TDD Section 9 mandates WAL mode for the single-process Railway service.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // -----------------------------------------------------------------------
  // Primary memories table (TDD Section 5.1)
  // -----------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id             TEXT    PRIMARY KEY,
      category       TEXT    NOT NULL,
      key            TEXT    NOT NULL,
      value          TEXT    NOT NULL,
      tags           TEXT    NOT NULL DEFAULT '[]',
      created_at     TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL,
      ttl            TEXT    DEFAULT NULL,
      source_session TEXT    DEFAULT NULL,
      confidence     REAL    NOT NULL DEFAULT 1.0,
      UNIQUE(category, key)
    );
  `);

  // -----------------------------------------------------------------------
  // v13.39.0 (TENAX-2026-10-15-01 H-10): re-check columns, added in place on
  // an existing database. ADD COLUMN with a NULL default touches no row, so an
  // existing store is unchanged until an entry is written with a re-check.
  // -----------------------------------------------------------------------
  {
    const have = new Set(db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name));
    for (const [name, ddl] of [
      ['recheck_class',   'TEXT DEFAULT NULL'],
      ['recheck_at',      'TEXT DEFAULT NULL'],
      ['verified_at',     'TEXT DEFAULT NULL'],
      ['verified_source', 'TEXT DEFAULT NULL'],
    ]) {
      if (!have.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_recheck ON memories(recheck_at)');
  }

  // -----------------------------------------------------------------------
  // Indexes (TDD Section 5.3)
  // -----------------------------------------------------------------------
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_updated  ON memories(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_ttl      ON memories(ttl);
  `);

  // -----------------------------------------------------------------------
  // FTS5 virtual table (TDD Section 5.2)
  // -----------------------------------------------------------------------
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id        UNINDEXED,
      category,
      key,
      value,
      tags,
      content='memories',
      content_rowid='rowid'
    );
  `);

  // -----------------------------------------------------------------------
  // Sync triggers: insert, update, delete (TDD Section 5.2)
  // -----------------------------------------------------------------------
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, category, key, value, tags)
      VALUES (new.rowid, new.id, new.category, new.key, new.value, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, category, key, value, tags)
      VALUES ('delete', old.rowid, old.id, old.category, old.key, old.value, old.tags);
      INSERT INTO memories_fts(rowid, id, category, key, value, tags)
      VALUES (new.rowid, new.id, new.category, new.key, new.value, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, category, key, value, tags)
      VALUES ('delete', old.rowid, old.id, old.category, old.key, old.value, old.tags);
    END;
  `);

  _db = db;
  return db;
}

/**
 * Return the singleton database. Initialise lazily if not already initialised
 * using the supplied default path. Use only in modules where the path is
 * already known to be configured (i.e. after src/index.js has called initDb).
 */
export function getDb() {
  if (!_db) {
    throw new Error("Database not initialised. Call initDb() from src/index.js first.");
  }
  return _db;
}

/**
 * Close the database handle. Used by tests and graceful shutdown.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
