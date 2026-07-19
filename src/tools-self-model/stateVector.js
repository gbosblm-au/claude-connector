// src/tools-self-model/stateVector.js
// Phase 2: Sustained Self Across Sessions.
//
// The state vector is a 14-field JSON object that carries a continuous thread of
// experience between sessions. It is stored in the self_insights table with
// category='state_vector' (no schema change: Phase 1 already provides the table
// and a category index).
//
// Field ownership:
//   - Qualitative fields are supplied by the assistant at session close via
//     self_state_write (active_curiosities, emotional_register,
//     unresolved_questions, open_projects, relationship_position,
//     recent_insights, confidence_levels_by_domain, cross_session_threads).
//   - Quantitative fields are derived from the self-model database here
//     (module_focus_patterns, query_shape_observations, last_session_summary,
//     session_count, total_interaction_time).
//   - stale_triggers is computed at read time.
//
// A write starts from the previous vector (carry-forward), overlays the supplied
// qualitative fields, refreshes derived fields, applies curiosity/thread decay,
// and stamps per-field last_updated. A read loads the most recent vector, flags
// entries older than the TTL, and produces a compact injection form.

import { getSelfModelDb } from "./db.js";
import { log } from "../utils/logger.js";

export const STATE_VECTOR_CATEGORY = "state_vector";
export const STALE_TTL_DAYS = 90;

// Injection caps (risk mitigation: keep the injected block small).
export const MAX_INJECT_CURIOSITIES = 3;
export const MAX_INJECT_UNRESOLVED = 3;
export const MAX_INJECT_THREADS = 3;
export const MAX_INJECT_PROJECTS = 3;

// Curiosity / thread decay: score multiplied by DECAY_PER_DAY^(days idle).
const DECAY_PER_DAY = 0.98;
const MIN_KEEP_SCORE = 0.1; // drop curiosities/threads that decay below this

const nowIso = () => new Date().toISOString();

/**
 * The canonical 14-field empty vector. Every field is present so downstream
 * consumers never have to guard for undefined.
 * @returns {object}
 */
export function emptyStateVector() {
  return {
    active_curiosities: [],            // [{topic, score, first_seen, last_seen}]
    emotional_register: null,          // {dominant, secondary, intensity}
    unresolved_questions: [],          // [{question, session_id, context, first_seen}]
    open_projects: [],                 // [{project_id, title, phase, next_action}]
    relationship_position: null,       // {session_count, trust_level, formality_register, dominant_mode}
    recent_insights: [],               // [{insight, session_id, category}]
    module_focus_patterns: {},         // {module_id: sessions_active_count}
    query_shape_observations: {},      // {preferred_depth, preferred_register, topic_shift_rate}
    confidence_levels_by_domain: {},   // {domain: confidence_score}
    last_session_summary: null,        // text
    session_count: 0,                  // integer
    total_interaction_time: 0,         // integer minutes
    cross_session_threads: [],         // [{thread_id, title, last_activity, relevance_score}]
    stale_triggers: [],                // [{field, last_updated, days_since_update}]
    _meta: { field_updated: {}, written_at: null, written_by_session: null },
  };
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (b - a) / 86400000);
}

/**
 * Load the most recent stored state vector, or null if none exists.
 * @returns {{ vector: object, created_at: string, session_id: string }|null}
 */
export function loadLatestStateVector() {
  const db = getSelfModelDb();
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT session_id, insight_text, created_at
      FROM self_insights
      WHERE category = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(STATE_VECTOR_CATEGORY);
    if (!row) return null;
    let vector;
    try {
      vector = JSON.parse(row.insight_text);
    } catch (parseErr) {
      log("warn", `[self-model] latest state_vector is not valid JSON: ${parseErr.message}`);
      return null;
    }
    return { vector: { ...emptyStateVector(), ...vector }, created_at: row.created_at, session_id: row.session_id };
  } catch (err) {
    log("warn", `[self-model] loadLatestStateVector failed: ${err.message}`);
    return null;
  }
}

/**
 * Derive quantitative fields from the self-model database.
 * @returns {object} partial vector with derived fields
 */
export function deriveQuantitativeFields() {
  const db = getSelfModelDb();
  const derived = {
    module_focus_patterns: {},
    query_shape_observations: {},
    last_session_summary: null,
    session_count: 0,
    total_interaction_time: 0,
  };
  if (!db) return derived;

  try {
    // module_focus_patterns: sessions each module was active in.
    const mods = db.prepare(`
      SELECT module_id, COUNT(DISTINCT session_id) AS sessions_active
      FROM module_activations
      GROUP BY module_id
      ORDER BY sessions_active DESC
    `).all();
    for (const m of mods) derived.module_focus_patterns[m.module_id] = m.sessions_active;

    // session_count
    const sc = db.prepare(`SELECT COUNT(*) AS n FROM session_log`).get();
    derived.session_count = sc ? sc.n : 0;

    // total_interaction_time (minutes)
    const tt = db.prepare(`SELECT COALESCE(SUM(duration_minutes),0) AS m FROM session_timing`).get();
    derived.total_interaction_time = tt ? tt.m : 0;

    // last_session_summary: most recent finalised session with a summary.
    const ls = db.prepare(`
      SELECT topic_summary FROM session_log
      WHERE topic_summary IS NOT NULL AND topic_summary != ''
      ORDER BY start_time DESC LIMIT 1
    `).get();
    derived.last_session_summary = ls ? ls.topic_summary : null;

    // query_shape_observations.topic_shift_rate: distinct topics / total topic rows
    // over the recent window (a rough proxy; qualitative depth/register are
    // supplied by the assistant and preserved by the merge).
    const shift = db.prepare(`
      SELECT COUNT(DISTINCT topic_keyword) AS distinct_topics, COUNT(*) AS total
      FROM topic_clusters
    `).get();
    if (shift && shift.total > 0) {
      derived.query_shape_observations.topic_shift_rate =
        Math.round((shift.distinct_topics / shift.total) * 100) / 100;
    }
  } catch (err) {
    log("warn", `[self-model] deriveQuantitativeFields failed: ${err.message}`);
  }
  return derived;
}

/**
 * Apply time decay to curiosity and thread scores based on how long since each
 * was last seen. Drops entries that fall below MIN_KEEP_SCORE.
 * @param {object} vector
 * @param {string} asOfIso
 * @returns {object} the same vector (mutated)
 */
export function applyDecay(vector, asOfIso = nowIso()) {
  const decayList = (list, scoreKey, stampKey) => {
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const last = item[stampKey] || item.first_seen || null;
        if (!last || typeof item[scoreKey] !== "number") return item;
        const idleDays = daysBetween(last, asOfIso);
        const decayed = item[scoreKey] * Math.pow(DECAY_PER_DAY, idleDays);
        return { ...item, [scoreKey]: Math.round(decayed * 1000) / 1000 };
      })
      .filter((item) => typeof item[scoreKey] !== "number" || item[scoreKey] >= MIN_KEEP_SCORE);
  };

  vector.active_curiosities = decayList(vector.active_curiosities, "score", "last_seen");
  vector.cross_session_threads = decayList(vector.cross_session_threads, "relevance_score", "last_activity");
  return vector;
}

/**
 * Merge assistant-supplied qualitative fields onto a base vector. Only known
 * fields are accepted; unknown keys are ignored. Arrays/objects replace when
 * provided, otherwise the base value is carried forward.
 * @param {object} base
 * @param {object} supplied
 * @param {string} stampIso
 * @returns {object} new merged vector
 */
export function mergeQualitative(base, supplied, stampIso = nowIso()) {
  const out = { ...emptyStateVector(), ...base };
  out._meta = { ...emptyStateVector()._meta, ...(base._meta || {}) };
  out._meta.field_updated = { ...(base._meta?.field_updated || {}) };

  const QUALITATIVE_ARRAY_FIELDS = ["active_curiosities", "unresolved_questions", "open_projects", "recent_insights", "cross_session_threads"];
  const QUALITATIVE_OBJECT_FIELDS = ["emotional_register", "relationship_position", "confidence_levels_by_domain"];

  if (supplied && typeof supplied === "object") {
    for (const field of QUALITATIVE_ARRAY_FIELDS) {
      if (Array.isArray(supplied[field])) {
        out[field] = supplied[field];
        out._meta.field_updated[field] = stampIso;
      }
    }
    for (const field of QUALITATIVE_OBJECT_FIELDS) {
      if (supplied[field] && typeof supplied[field] === "object") {
        out[field] = supplied[field];
        out._meta.field_updated[field] = stampIso;
      }
    }
  }
  return out;
}

/**
 * Timestamp helper: add last_seen to curiosities and last_activity to threads
 * that were just supplied without one, so decay has an anchor.
 */
function anchorTimestamps(vector, stampIso) {
  if (Array.isArray(vector.active_curiosities)) {
    vector.active_curiosities = vector.active_curiosities.map((c) => ({
      first_seen: c.first_seen || stampIso,
      last_seen: c.last_seen || stampIso,
      ...c,
    }));
  }
  if (Array.isArray(vector.cross_session_threads)) {
    vector.cross_session_threads = vector.cross_session_threads.map((t) => ({
      last_activity: t.last_activity || stampIso,
      ...t,
    }));
  }
  return vector;
}

/**
 * Build the full state vector to be written at session close.
 * @param {object} params
 * @param {string} params.sessionId
 * @param {object} [params.supplied] Assistant-supplied qualitative fields.
 * @returns {object} the full 14-field vector
 */
export function buildStateVector({ sessionId, supplied = {} } = {}) {
  const stamp = nowIso();
  const prev = loadLatestStateVector();
  const base = prev ? prev.vector : emptyStateVector();

  // 1. carry-forward + overlay qualitative
  let vector = mergeQualitative(base, supplied, stamp);

  // 2. anchor timestamps for decayable entries, then decay
  vector = anchorTimestamps(vector, stamp);
  vector = applyDecay(vector, stamp);

  // 3. refresh derived quantitative fields
  const derived = deriveQuantitativeFields();
  vector.module_focus_patterns = derived.module_focus_patterns;
  vector.session_count = derived.session_count;
  vector.total_interaction_time = derived.total_interaction_time;
  vector.last_session_summary = derived.last_session_summary;
  vector.query_shape_observations = {
    ...vector.query_shape_observations,
    ...derived.query_shape_observations,
  };
  const dstamp = stamp;
  for (const f of ["module_focus_patterns", "session_count", "total_interaction_time", "last_session_summary", "query_shape_observations"]) {
    vector._meta.field_updated[f] = dstamp;
  }

  // 4. relationship_position.session_count kept in sync with derived count if present
  if (vector.relationship_position && typeof vector.relationship_position === "object") {
    vector.relationship_position = { ...vector.relationship_position, session_count: derived.session_count };
  }

  vector._meta.written_at = stamp;
  vector._meta.written_by_session = sessionId || null;
  return vector;
}

/**
 * Compute stale_triggers for a vector against the TTL, as of now.
 * @param {object} vector
 * @param {string} [asOfIso]
 * @returns {Array<{field, last_updated, days_since_update}>}
 */
export function computeStaleTriggers(vector, asOfIso = nowIso()) {
  const triggers = [];
  const updated = vector?._meta?.field_updated || {};
  for (const [field, ts] of Object.entries(updated)) {
    const days = Math.floor(daysBetween(ts, asOfIso));
    if (days > STALE_TTL_DAYS) {
      triggers.push({ field, last_updated: ts, days_since_update: days });
    }
  }
  return triggers;
}

/**
 * Produce the compact injection form of a vector: capped lists and a rendered
 * [SESSION_STATE] text block. This is what the gateway injects on the first turn.
 * @param {object} vector
 * @returns {{ compact: object, block: string, stale_triggers: Array }}
 */
export function toInjectionForm(vector) {
  const staleTriggers = computeStaleTriggers(vector);

  const curiosities = [...(vector.active_curiosities || [])]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_INJECT_CURIOSITIES);
  const unresolved = (vector.unresolved_questions || []).slice(0, MAX_INJECT_UNRESOLVED);
  const threads = [...(vector.cross_session_threads || [])]
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .slice(0, MAX_INJECT_THREADS);
  const projects = (vector.open_projects || []).slice(0, MAX_INJECT_PROJECTS);

  const compact = {
    active_curiosities: curiosities,
    emotional_register: vector.emotional_register || null,
    unresolved_questions: unresolved,
    open_projects: projects,
    relationship_position: vector.relationship_position || null,
    cross_session_threads: threads,
    last_session_summary: vector.last_session_summary || null,
    session_count: vector.session_count || 0,
    stale_triggers: staleTriggers,
  };

  const lines = [];
  lines.push("[SESSION_STATE]");
  if (compact.last_session_summary) lines.push(`Last session: ${compact.last_session_summary}`);
  if (compact.relationship_position) {
    const rp = compact.relationship_position;
    const bits = [];
    if (rp.dominant_mode) bits.push(`mode ${rp.dominant_mode}`);
    if (typeof rp.trust_level === "number") bits.push(`trust ${rp.trust_level}`);
    if (typeof rp.formality_register === "number") bits.push(`formality ${rp.formality_register}`);
    if (bits.length) lines.push(`Relationship: ${bits.join(", ")} (session ${compact.session_count}).`);
  }
  if (compact.emotional_register) {
    const er = compact.emotional_register;
    lines.push(`Register carried in: ${[er.dominant, er.secondary].filter(Boolean).join(" / ")}${typeof er.intensity === "number" ? ` (intensity ${er.intensity})` : ""}.`);
  }
  if (curiosities.length) {
    lines.push(`Open curiosities: ${curiosities.map((c) => `${c.topic}${typeof c.score === "number" ? ` (${c.score})` : ""}`).join("; ")}.`);
  }
  if (unresolved.length) {
    lines.push(`Unresolved: ${unresolved.map((u) => u.question || u.q).filter(Boolean).join("; ")}.`);
  }
  if (projects.length) {
    lines.push(`Open projects: ${projects.map((p) => `${p.title}${p.phase ? ` [${p.phase}]` : ""}${p.next_action ? ` next: ${p.next_action}` : ""}`).join("; ")}.`);
  }
  if (staleTriggers.length) {
    lines.push(`Stale (>${STALE_TTL_DAYS}d, treat with fresh eyes): ${staleTriggers.map((s) => s.field).join(", ")}.`);
  }
  lines.push("Carry this thread forward naturally. Do not recite it back to the user.");

  return { compact, block: lines.join("\n"), stale_triggers: staleTriggers };
}

/**
 * Persist a full vector as a state_vector row in self_insights.
 * @param {string} sessionId
 * @param {object} vector
 * @returns {boolean} success
 */
export function writeStateVector(sessionId, vector) {
  const db = getSelfModelDb();
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO self_insights (session_id, insight_text, category, source_module, created_at)
      VALUES (@sid, @text, @cat, 'state_vector_engine', @ts)
    `).run({
      sid: sessionId || null,
      text: JSON.stringify(vector),
      cat: STATE_VECTOR_CATEGORY,
      ts: nowIso(),
    });
    return true;
  } catch (err) {
    log("warn", `[self-model] writeStateVector failed: ${err.message}`);
    return false;
  }
}
