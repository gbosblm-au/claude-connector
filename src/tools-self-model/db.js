// src/tools-self-model/db.js
// Self-Model Interrogation database (Phase 1).
//
// Owns a dedicated SQLite file on the Railway persistent volume, separate from
// the memory database (/data/memory.db). The self-model records the assistant's
// own operational history: which modules were loaded, which tools were called,
// when sessions ran, and how compilation performed over time.
//
// The schema is defined once in schema.sql and applied idempotently here so the
// file is created automatically on first use and survives redeploys.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

let _db = null;
let _initError = null;

/**
 * Resolve the self-model database path.
 * Priority: SELF_MODEL_DB_PATH, then a sibling of the memory DB, then default.
 * @returns {string}
 */
export function getSelfModelDbPath() {
  if (process.env.SELF_MODEL_DB_PATH) return process.env.SELF_MODEL_DB_PATH;
  return "/data/self-model.db";
}

/**
 * Whether the self-model subsystem is enabled. Defaults to enabled; can be
 * turned off explicitly with SELF_MODEL_ENABLED=false. Recording and querying
 * both honour this flag so the feature can be dark-launched.
 * @returns {boolean}
 */
export function isSelfModelEnabled() {
  return String(process.env.SELF_MODEL_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * Load the canonical schema DDL from schema.sql.
 * @returns {string}
 */
function loadSchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

/**
 * Initialise (or return the singleton) self-model database. Idempotent.
 * Never throws: on failure it records the error and returns null so callers
 * (recording hooks, query tool) can degrade gracefully.
 *
 * @param {string} [dbPath] Optional explicit path (defaults to getSelfModelDbPath()).
 * @returns {Database.Database|null}
 */
export function initSelfModelDb(dbPath = getSelfModelDbPath()) {
  if (_db) return _db;
  if (_initError) return null;

  try {
    const absolutePath = resolve(dbPath);
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new Database(absolutePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000"); // tolerate the Python aggregator holding a write lock

    db.exec(loadSchemaSql());

    _db = db;
    log("info", `[self-model] database ready at ${absolutePath}`);
    return _db;
  } catch (err) {
    _initError = err;
    log("warn", `[self-model] database init failed (feature will no-op): ${err.message}`);
    return null;
  }
}

/**
 * Return the singleton handle if already initialised, otherwise attempt init.
 * @returns {Database.Database|null}
 */
export function getSelfModelDb() {
  if (_db) return _db;
  if (!isSelfModelEnabled()) return null;
  return initSelfModelDb();
}

/**
 * Close the database (used by tests). Safe to call when uninitialised.
 */
export function closeSelfModelDb() {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
  }
  _db = null;
  _initError = null;
}
