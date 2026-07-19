// src/tools-self-model/intent.js
// Natural-language query dispatch for the self-model.
//
// SECURITY MODEL (important): user-supplied natural language NEVER becomes SQL.
// The classifier maps the free-text query to exactly one of six fixed intents.
// Each intent owns a hard-coded, parameterised SQL statement. The only value
// that flows from the caller into a query is a numeric window (days) and a
// numeric limit, both coerced to integers and range-clamped. There is no string
// interpolation of user text into SQL anywhere in this module.
//
// The six intents match the specification's dispatch table:
//   module_activity  -> module_activations, session_log
//   tool_activity    -> tool_usage
//   session_patterns -> session_timing
//   topic_history    -> topic_clusters, session_log
//   module_gaps      -> module_activations (+ MANIFEST, supplied by caller)
//   self_trend       -> self_insights, session_log

export const INTENTS = [
  "module_activity",
  "tool_activity",
  "session_patterns",
  "topic_history",
  "module_gaps",
  "self_trend",
];

// Ordered rules. First matching rule wins. Order matters: more specific intents
// are tested before more general ones. Each rule is a set of keyword tokens and
// phrase fragments; a rule matches if any phrase fragment is a substring of the
// lowercased query, or if any keyword appears as a whole word.
const RULES = [
  {
    intent: "module_gaps",
    phrases: ["never been activated", "never activated", "never used", "unused module",
              "which modules have never", "modules i have not", "modules not used", "dead module",
              "which modules are unused"],
    keywords: ["gap", "gaps", "unused"],
  },
  {
    intent: "tool_activity",
    phrases: ["which tools", "what tools", "tool have i used", "tools have i used",
              "used most", "tool usage", "which tool", "most called tool"],
    keywords: ["tool", "tools"],
  },
  {
    intent: "session_patterns",
    phrases: ["when do i", "what time", "day of week", "time of day", "how long are my sessions",
              "session length", "usually work", "work with brian", "when do we", "what days"],
    keywords: ["when", "schedule", "timing"],
  },
  {
    intent: "topic_history",
    phrases: ["what topics", "topics have we", "topics we", "what have we covered",
              "what did we cover", "what have we discussed", "recurring topic", "topic history"],
    keywords: ["topic", "topics", "covered", "discussed"],
  },
  {
    intent: "self_trend",
    phrases: ["response quality", "am i changing", "is my", "how have i changed",
              "am i improving", "quality changing", "trend", "over time", "my behaviour",
              "my behavior", "am i getting"],
    keywords: ["trend", "changing", "improving", "quality"],
  },
  {
    intent: "module_activity",
    phrases: ["which modules", "what modules", "modules were most active", "most active module",
              "module activity", "modules active", "which module", "modules have i loaded"],
    keywords: ["module", "modules"],
  },
];

/**
 * Tokenise a string into lowercased word tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9_]+/g) || [];
}

/**
 * Classify a natural-language query into one of the six intents.
 * Falls back to 'module_activity' only when nothing matches and the text is
 * empty; otherwise returns the best rule match. When ambiguous (no rule fires)
 * returns null so the caller can ask for clarification.
 *
 * @param {string} query
 * @returns {string|null} intent name, or null if unclassifiable
 */
export function classifyIntent(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;
  const tokens = new Set(tokenise(q));

  for (const rule of RULES) {
    for (const phrase of rule.phrases) {
      if (q.includes(phrase)) return rule.intent;
    }
  }
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (tokens.has(kw)) return rule.intent;
    }
  }
  return null;
}

/**
 * Clamp a value to an integer within [min, max], falling back to def.
 */
function clampInt(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the query plan (SQL + parameters + target tables) for a given intent.
 * All SQL is fixed; only numeric window/limit values are bound.
 *
 * @param {string} intent
 * @param {object} [opts]
 * @param {number} [opts.windowDays=30]
 * @param {number} [opts.limit=10]
 * @returns {{ intent: string, tables: string[], sql: string, params: object, description: string }|null}
 */
export function buildQueryPlan(intent, opts = {}) {
  const windowDays = clampInt(opts.windowDays, 30, 1, 3650);
  const limit = clampInt(opts.limit, 10, 1, 200);
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const params = { cutoff, limit };

  switch (intent) {
    case "module_activity":
      return {
        intent,
        tables: ["module_activations", "session_log"],
        description: `Modules ranked by load count across sessions active since the window start.`,
        sql: `
          SELECT ma.module_id                 AS module_id,
                 SUM(ma.load_count)            AS total_loads,
                 SUM(ma.total_time_active)     AS total_time_active_ms,
                 COUNT(DISTINCT ma.session_id) AS sessions_active
          FROM module_activations ma
          JOIN session_log sl ON sl.id = ma.session_id
          WHERE sl.start_time >= @cutoff
          GROUP BY ma.module_id
          ORDER BY total_loads DESC, sessions_active DESC
          LIMIT @limit
        `,
        params,
      };

    case "tool_activity":
      return {
        intent,
        tables: ["tool_usage"],
        description: `Tools ranked by call count within the window.`,
        sql: `
          SELECT tu.tool_name               AS tool_name,
                 SUM(tu.call_count)         AS total_calls,
                 SUM(tu.total_duration_ms)  AS total_duration_ms
          FROM tool_usage tu
          JOIN session_log sl ON sl.id = tu.session_id
          WHERE sl.start_time >= @cutoff
          GROUP BY tu.tool_name
          ORDER BY total_calls DESC
          LIMIT @limit
        `,
        params,
      };

    case "session_patterns":
      return {
        intent,
        tables: ["session_timing"],
        description: `Session distribution by day of week and hour of day, with average duration.`,
        sql: `
          SELECT st.day_of_week              AS day_of_week,
                 st.hour_of_day              AS hour_of_day,
                 COUNT(*)                    AS session_count,
                 AVG(st.duration_minutes)    AS avg_duration_minutes
          FROM session_timing st
          JOIN session_log sl ON sl.id = st.session_id
          WHERE sl.start_time >= @cutoff
          GROUP BY st.day_of_week, st.hour_of_day
          ORDER BY session_count DESC
          LIMIT @limit
        `,
        params,
      };

    case "topic_history":
      return {
        intent,
        tables: ["topic_clusters", "session_log"],
        description: `Topic keywords ranked by accumulated weight within the window.`,
        sql: `
          SELECT tc.topic_keyword            AS topic_keyword,
                 SUM(tc.weight)              AS total_weight,
                 COUNT(DISTINCT tc.session_id) AS sessions
          FROM topic_clusters tc
          JOIN session_log sl ON sl.id = tc.session_id
          WHERE sl.start_time >= @cutoff
          GROUP BY tc.topic_keyword
          ORDER BY total_weight DESC
          LIMIT @limit
        `,
        params,
      };

    case "module_gaps":
      // Modules that have been loaded at least once historically but have zero
      // activations inside the window. The caller may cross-reference the
      // MANIFEST for modules that exist but were never loaded at all.
      return {
        intent,
        tables: ["module_activations", "session_log"],
        description: `Modules with no activations inside the window (candidate gaps). Cross-reference MANIFEST for never-loaded modules.`,
        sql: `
          SELECT ma.module_id                   AS module_id,
                 MAX(sl.start_time)              AS last_active,
                 SUM(ma.load_count)              AS lifetime_loads
          FROM module_activations ma
          JOIN session_log sl ON sl.id = ma.session_id
          GROUP BY ma.module_id
          HAVING MAX(sl.start_time) < @cutoff
          ORDER BY last_active ASC
          LIMIT @limit
        `,
        params,
      };

    case "self_trend":
      return {
        intent,
        tables: ["self_insights", "session_log"],
        description: `Most recent self-insight and trend records within the window.`,
        sql: `
          SELECT si.created_at    AS created_at,
                 si.category      AS category,
                 si.insight_text  AS insight_text,
                 si.source_module AS source_module
          FROM self_insights si
          WHERE si.created_at >= @cutoff
          ORDER BY si.created_at DESC
          LIMIT @limit
        `,
        params,
      };

    default:
      return null;
  }
}
