// src/tools/selfModelQuery.js
// self_model_query - answer questions the assistant asks about itself using
// structured query dispatch against the self-model database, rather than memory
// search and reconstruction.
//
// The tool classifies a natural-language question into one of six fixed intents
// and executes the intent's hard-coded, parameterised SQL. User text is never
// interpolated into SQL (see tools-self-model/intent.js).

import { getSelfModelDb, isSelfModelEnabled } from "../tools-self-model/db.js";
import { classifyIntent, buildQueryPlan, INTENTS } from "../tools-self-model/intent.js";
import { log } from "../utils/logger.js";

export const selfModelQueryToolDefinition = {
  name: "self_model_query",
  description:
    "Answer a question about the assistant's own operational history using the self-model database. " +
    "Reports which modules were most active, which tools were used most, when sessions usually run, " +
    "what topics recur, which modules have gone unused, and how behaviour is trending over time. " +
    "Pass a natural-language question in `query`; the tool selects the correct data source automatically. " +
    "Supported intents: module_activity, tool_activity, session_patterns, topic_history, module_gaps, self_trend.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The natural-language question about the self, e.g. 'What modules were most active this week?' " +
          "or 'Which tools have I used most?'",
      },
      intent: {
        type: "string",
        enum: INTENTS,
        description:
          "Optional explicit intent override. When omitted, the intent is classified from `query`.",
      },
      window_days: {
        type: "integer",
        description: "Look-back window in days (default 30, min 1, max 3650).",
      },
      limit: {
        type: "integer",
        description: "Maximum rows to return (default 10, min 1, max 200).",
      },
    },
    required: ["query"],
  },
};

/**
 * Format a query result set into a compact, readable text block.
 * @param {string} intent
 * @param {Array<object>} rows
 * @returns {string}
 */
function formatRows(intent, rows) {
  if (!rows || rows.length === 0) return "No records found for this question within the window.";
  const header = Object.keys(rows[0]);
  const lines = rows.map((r) =>
    header.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return "-";
      if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
      return String(v);
    }).join("  |  ")
  );
  return [header.join("  |  "), ...lines].join("\n");
}

/**
 * Handle a self_model_query call.
 * @param {object} args
 * @returns {Promise<{content: Array, isError?: boolean}>}
 */
export async function handleSelfModelQuery(args = {}) {
  const query = typeof args.query === "string" ? args.query : "";

  if (!isSelfModelEnabled()) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          reason: "self_model_disabled",
          message: "The self-model subsystem is disabled (SELF_MODEL_ENABLED=false).",
        }, null, 2),
      }],
      isError: true,
    };
  }

  if (!query.trim() && !args.intent) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          reason: "empty_query",
          message: "Provide a natural-language question in `query`, or set an explicit `intent`.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  const db = getSelfModelDb();
  if (!db) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          reason: "not_provisioned",
          message:
            "The self-model database is not available. Ensure the Railway volume is mounted and " +
            "SELF_MODEL_DB_PATH (default /data/self-model.db) is writable.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  // Determine intent: explicit override wins, else classify.
  const intent = (args.intent && INTENTS.includes(args.intent))
    ? args.intent
    : classifyIntent(query);

  if (!intent) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          reason: "unclassified",
          message:
            "Could not map this question to a self-model intent. Try rephrasing, or pass one of: " +
            INTENTS.join(", ") + " as `intent`.",
          supported_intents: INTENTS,
        }, null, 2),
      }],
      isError: false,
    };
  }

  const plan = buildQueryPlan(intent, {
    windowDays: args.window_days,
    limit: args.limit,
  });

  if (!plan) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: false, reason: "no_plan", intent }, null, 2),
      }],
      isError: true,
    };
  }

  try {
    const rows = db.prepare(plan.sql).all(plan.params);
    const payload = {
      ok: true,
      intent: plan.intent,
      tables: plan.tables,
      description: plan.description,
      window_days: plan.params && plan.params.cutoff ? args.window_days ?? 30 : 30,
      row_count: rows.length,
      rows,
    };
    return {
      content: [{
        type: "text",
        text:
          `Intent: ${plan.intent}\nSource: ${plan.tables.join(", ")}\n${plan.description}\n\n` +
          formatRows(plan.intent, rows) +
          `\n\n` + JSON.stringify(payload, null, 2),
      }],
      isError: false,
    };
  } catch (err) {
    log("error", `[self-model] query execution failed (intent=${intent}): ${err.message}`);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          reason: "query_failed",
          intent,
          message: err.message,
        }, null, 2),
      }],
      isError: true,
    };
  }
}
