// src/voice/voice-schema.js
//
// Tenax Voice -- data model. Specification Section 9: "Three tables. Audio
// content itself is never stored."
//
//   voice_settings    per-user preferences
//   voice_catalog     the commercial-OK allowlist, mirrored from code
//   voice_usage_log   metadata-only accounting -- never audio bytes
//
// ---------------------------------------------------------------------------
// WHY THE CATALOGUE IS IN CODE *AND* IN A TABLE
// ---------------------------------------------------------------------------
//
// voice-catalog.js is the source of truth and the enforcement point: a voice is
// refused there, in-process, before any GPL child process starts. The table is
// a MIRROR, synced on startup, and exists for two reasons the code cannot serve:
//
//   - an operator can query the audit state without reading source
//   - a licence audit has an "as at" record, which is what a compliance
//     conversation actually needs
//
// The table is never read to decide whether a voice may be used. If it were, a
// row edited by hand could authorise a non-commercial voice that the audited
// code refuses -- which is exactly the failure the allowlist exists to prevent.
//
// ---------------------------------------------------------------------------
// WHAT voice_usage_log MUST NEVER HOLD
// ---------------------------------------------------------------------------
//
// Section 10: "Only metadata (duration, language, character count) may be
// logged for usage accounting." No transcript, no synthesised text, no audio,
// no filename. The columns below are the whole permitted set, and there is
// deliberately no free-text column for someone to put a transcript in later.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname }               from 'node:path';

import { VOICE_CATALOG }         from './voice-catalog.js';

export const VOICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS voice_settings (
  user_id          TEXT PRIMARY KEY,
  preferred_voice  TEXT,
  speed            REAL    NOT NULL DEFAULT 1.0,
  language         TEXT,
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voice_catalog (
  voice_id             TEXT PRIMARY KEY,
  language             TEXT    NOT NULL,
  licence              TEXT,
  commercial_ok        INTEGER,
  attribution_required INTEGER,
  audited              INTEGER NOT NULL DEFAULT 0,
  model_card           TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  synced_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voice_usage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  direction   TEXT    NOT NULL CHECK (direction IN ('stt','tts')),
  language    TEXT,
  duration_ms INTEGER,
  char_count  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voice_usage_user_time
  ON voice_usage_log (user_id, created_at);
`;

/**
 * Create the tables and mirror the catalogue.
 *
 * Idempotent, so it is safe on every boot. Called only when voice is enabled:
 * a disabled feature should not create tables, and Section 7 wants the gate to
 * leave no trace.
 *
 * @param {object} db  A better-sqlite3 handle.
 */
export function initVoiceSchema(db) {
  if (!db) throw new Error('initVoiceSchema needs a database handle.');
  db.exec(VOICE_SCHEMA_SQL);
  syncCatalog(db);
}

/**
 * Mirror voice-catalog.js into the table.
 *
 * The code is authoritative, so this overwrites. A hand-edited row that
 * disagrees with the audited code is a compliance hazard, not a customisation,
 * and letting it survive would create a second answer to "may this voice ship".
 *
 * @param {object} db
 */
export function syncCatalog(db) {
  const upsert = db.prepare(`
    INSERT INTO voice_catalog
      (voice_id, language, licence, commercial_ok, attribution_required,
       audited, model_card, active, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (voice_id) DO UPDATE SET
      language             = excluded.language,
      licence              = excluded.licence,
      commercial_ok        = excluded.commercial_ok,
      attribution_required = excluded.attribution_required,
      audited              = excluded.audited,
      model_card           = excluded.model_card,
      active               = excluded.active,
      synced_at            = datetime('now')
  `);

  // NULL, not 0, for an unverified licence: 0 would read as "audited and found
  // non-commercial", which is a different and much stronger claim than "nobody
  // has looked yet".
  const bit = v => (v === null || v === undefined ? null : (v ? 1 : 0));

  const tx = db.transaction((rows) => {
    for (const v of rows) {
      upsert.run(v.voice_id, v.language, v.licence,
                 bit(v.commercial_ok), bit(v.attribution_required),
                 v.audited ? 1 : 0, v.model_card, v.active ? 1 : 0);
    }
  });
  tx(VOICE_CATALOG);
}

/** @returns {{preferred_voice: string|null, speed: number, language: string|null}|null} */
export function getVoiceSettings(db, userId) {
  if (!db || !userId) return null;
  const row = db.prepare(
    'SELECT preferred_voice, speed, language FROM voice_settings WHERE user_id = ?'
  ).get(String(userId));
  return row || null;
}

/**
 * Save a user's preferences.
 *
 * The voice is NOT validated here. Validation belongs at the point of use, in
 * voicePermitted(), because the audit state changes over time: a voice legally
 * saved today can become unusable when an audit finds it non-commercial, and a
 * stored preference must not be able to outvote that.
 */
export function setVoiceSettings(db, userId, settings) {
  if (!db || !userId) return;
  const s = settings || {};
  const speed = Number(s.speed);
  db.prepare(`
    INSERT INTO voice_settings (user_id, preferred_voice, speed, language, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_voice = excluded.preferred_voice,
      speed           = excluded.speed,
      language        = excluded.language,
      updated_at      = datetime('now')
  `).run(
    String(userId),
    s.preferred_voice ? String(s.preferred_voice) : null,
    Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1.0,
    s.language ? String(s.language) : null,
  );
}

/**
 * Record one unit of usage.
 *
 * Signature carries no field capable of holding content. There is no `text`
 * and no `transcript` parameter, so a future caller cannot pass one by
 * accident -- the type is the control.
 */
export function logVoiceUsage(db, entry) {
  if (!db) return;
  const e = entry || {};
  if (e.direction !== 'stt' && e.direction !== 'tts') return;
  db.prepare(`
    INSERT INTO voice_usage_log (user_id, direction, language, duration_ms, char_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    e.user_id ? String(e.user_id) : null,
    e.direction,
    e.language ? String(e.language) : null,
    Number.isFinite(e.duration_ms) ? Math.round(e.duration_ms) : null,
    Number.isFinite(e.char_count) ? Math.round(e.char_count) : null,
  );
}

/** Ensure a directory exists for a SQLite file path. */
export function ensureDirFor(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export default {
  VOICE_SCHEMA_SQL, initVoiceSchema, syncCatalog,
  getVoiceSettings, setVoiceSettings, logVoiceUsage, ensureDirFor,
};
