-- src/tools-self-model/schema.sql
-- Canonical schema for the Self-Model Interrogation database (Phase 1).
--
-- Single source of truth shared by:
--   - db.js               (Node / better-sqlite3, runtime writer)
--   - self_model_aggregator.py / self_model_summarizer.py (Python, stdlib sqlite3)
--   - self-model.test.js  (verification)
--
-- Seven tables, matching the Neural Capability Expansion specification exactly:
--   session_log, module_activations, tool_usage, topic_clusters,
--   session_timing, compile_history, self_insights
--
-- All DDL is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- so it can be applied on every boot without error and without data loss.

-- ---------------------------------------------------------------------------
-- session_log : one row per session, opened lazily on first event, finalised
--               at session close.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_log (
  id             TEXT    PRIMARY KEY,               -- session id (string)
  start_time     TEXT    NOT NULL,                  -- ISO-8601 UTC
  end_time       TEXT    DEFAULT NULL,              -- ISO-8601 UTC, set/updated on activity + close
  message_count  INTEGER NOT NULL DEFAULT 0,        -- turns observed in this session
  topic_summary  TEXT    DEFAULT NULL               -- natural-language summary written at close
);

CREATE INDEX IF NOT EXISTS idx_session_log_start ON session_log(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_session_log_end   ON session_log(end_time DESC);

-- ---------------------------------------------------------------------------
-- module_activations : per-session module usage tracking.
--   One row per (session_id, module_id). load_count increments each time the
--   module is loaded into a compiled skill; total_time_active accumulates the
--   active duration attributed to the module (milliseconds).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_activations (
  session_id        TEXT    NOT NULL,
  module_id         TEXT    NOT NULL,
  load_count        INTEGER NOT NULL DEFAULT 0,
  total_time_active INTEGER NOT NULL DEFAULT 0,     -- milliseconds
  PRIMARY KEY (session_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_module_activations_module ON module_activations(module_id);

-- ---------------------------------------------------------------------------
-- tool_usage : per-session tool usage aggregation.
--   One row per (session_id, tool_name). call_count increments per call;
--   total_duration_ms accumulates measured handler duration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_usage (
  session_id        TEXT    NOT NULL,
  tool_name         TEXT    NOT NULL,
  call_count        INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);

-- ---------------------------------------------------------------------------
-- topic_clusters : topic frequency tracking derived from session summaries.
--   Populated by the aggregator from session_log.topic_summary. One row per
--   (session_id, topic_keyword) with an accumulated weight.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_clusters (
  session_id    TEXT    NOT NULL,
  topic_keyword TEXT    NOT NULL,
  weight        REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, topic_keyword)
);

CREATE INDEX IF NOT EXISTS idx_topic_clusters_keyword ON topic_clusters(topic_keyword);

-- ---------------------------------------------------------------------------
-- session_timing : session pattern analysis (one row per session).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_timing (
  session_id       TEXT    PRIMARY KEY,
  day_of_week      INTEGER,                          -- 0=Sunday .. 6=Saturday
  hour_of_day      INTEGER,                          -- 0..23 (UTC of session start)
  duration_minutes INTEGER
);

CREATE INDEX IF NOT EXISTS idx_session_timing_dow  ON session_timing(day_of_week);
CREATE INDEX IF NOT EXISTS idx_session_timing_hour ON session_timing(hour_of_day);

-- ---------------------------------------------------------------------------
-- compile_history : compile performance tracking. One row per skill_compile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compile_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL,
  compile_time_ms       INTEGER,
  modules_loaded_count  INTEGER,
  manifest_version      TEXT,
  created_at            TEXT    NOT NULL             -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_compile_history_session ON compile_history(session_id);

-- ---------------------------------------------------------------------------
-- self_insights : surfaced observations and generated summaries.
--   category distinguishes sources, e.g. 'summary', 'observation', and (from
--   Phase 2) 'state_vector'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS self_insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  insight_text  TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'observation',
  source_module TEXT,
  created_at    TEXT    NOT NULL                     -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_self_insights_category ON self_insights(category);
CREATE INDEX IF NOT EXISTS idx_self_insights_session  ON self_insights(session_id);

-- ---------------------------------------------------------------------------
-- nudges : proactively surfaced observations (Phase 3: Initiative and
--          Background Awareness). One row per detected pattern instance,
--          keyed by a stable pattern_id (category:subject) so re-detection
--          updates rather than duplicates.
--   status: pending | surfaced | snoozed | dismissed | actioned
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nudges (
  pattern_id        TEXT    PRIMARY KEY,             -- stable, e.g. "topic_recurrence:locale"
  pattern_category  TEXT    NOT NULL,                -- one of the 7 detector categories
  message           TEXT    NOT NULL,                -- the nudge text to surface
  score             REAL    NOT NULL DEFAULT 0,      -- combined priority score
  relevance_score   REAL    DEFAULT NULL,
  urgency_score     REAL    DEFAULT NULL,
  receptivity_score REAL    DEFAULT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending',
  first_detected    TEXT    NOT NULL,                -- ISO-8601 UTC
  last_surfaced     TEXT    DEFAULT NULL,            -- ISO-8601 UTC
  dismiss_count     INTEGER NOT NULL DEFAULT 0,      -- per-pattern dismissals
  session_id        TEXT    DEFAULT NULL,            -- session that produced it
  updated_at        TEXT    NOT NULL                 -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_nudges_status   ON nudges(status);
CREATE INDEX IF NOT EXISTS idx_nudges_category ON nudges(pattern_category);
CREATE INDEX IF NOT EXISTS idx_nudges_score    ON nudges(score DESC);

-- ---------------------------------------------------------------------------
-- nudge_optouts : per-category dismissal tracking. Two dismissals of the same
--                 pattern category permanently opt that category out (the
--                 prioritiser stops storing new nudges of that category and
--                 nudge_check refuses to surface them).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nudge_optouts (
  pattern_category TEXT    PRIMARY KEY,
  dismiss_count    INTEGER NOT NULL DEFAULT 0,
  opted_out        INTEGER NOT NULL DEFAULT 0,       -- 0 = active, 1 = permanently off
  updated_at       TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- student_model : cross-session map of what the recipient understands, keyed by
--                 concept (Phase 4: Socratic Tutor Mode). Confidence is stored
--                 with an uncertainty interval; low-confidence estimates decay
--                 faster (Bayesian-style updating in student_model.py). seam_scores
--                 is a JSON object of {seam_type: score} plus optional relational
--                 hints (e.g. conflicts_with, adjacent_to) used by seam detection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_model (
  concept          TEXT    PRIMARY KEY,
  confidence       REAL    NOT NULL DEFAULT 0.0,     -- point estimate 0..1
  confidence_lower REAL    NOT NULL DEFAULT 0.0,     -- lower bound of interval
  confidence_upper REAL    NOT NULL DEFAULT 1.0,     -- upper bound of interval
  observations     INTEGER NOT NULL DEFAULT 0,       -- evidence count (Bayesian n)
  source           TEXT    NOT NULL DEFAULT 'inferred', -- inferred | explicit
  domain           TEXT    DEFAULT NULL,             -- optional grouping
  seam_scores      TEXT    DEFAULT NULL,             -- JSON {seam_type: score, ...}
  first_seen       TEXT    NOT NULL,                 -- ISO-8601 UTC
  last_updated     TEXT    NOT NULL                  -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_student_model_confidence ON student_model(confidence);
CREATE INDEX IF NOT EXISTS idx_student_model_domain     ON student_model(domain);
