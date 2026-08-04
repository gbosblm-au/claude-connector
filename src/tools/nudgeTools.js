// src/tools/nudgeTools.js
// Phase 3: Initiative and Background Awareness - the connector side of the nudge
// system.
//
//   nudge_analyze - session close: runs the Python pattern analyzer + prioritiser
//                   pipeline against the self-model database, storing any
//                   qualifying nudges as pending.
//   nudge_check   - session open: returns the single highest-scoring pending
//                   nudge (max one), marks it surfaced. Quiet by default.
//   nudge_action  - applies the recipient's decision: show_me | snooze | dismiss.
//                   Two dismissals of a category opt it out permanently.
//
// nudge_check and nudge_action operate directly on the SQLite database (fast, no
// subprocess). nudge_analyze shells out to Python, reusing the same binary
// resolution and scripts directory as script_execute.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { getSelfModelDb, getSelfModelDbPath, isSelfModelEnabled } from "../tools-self-model/db.js";
import { log } from "../utils/logger.js";

import { buildScriptEnv } from "../utils/scriptEnv.js";
const SCRIPTS_BASE = process.env.SCRIPTS_DIR
  ? resolvePath(process.env.SCRIPTS_DIR)
  : resolvePath("/data/skill/ava/scripts");

const OPTOUT_DISMISS_THRESHOLD = 2;
const nowIso = () => new Date().toISOString();

function pythonBin() {
  return existsSync("/mise/shims/python3") ? "/mise/shims/python3" : "python3";
}

function guardEnabled() {
  if (!isSelfModelEnabled()) {
    return errorResult("self_model_disabled", "The self-model subsystem is disabled (SELF_MODEL_ENABLED=false).");
  }
  if (!getSelfModelDb()) {
    return errorResult("not_provisioned",
      "The self-model database is not available. Ensure the Railway volume is mounted and writable.");
  }
  return null;
}

// ---------------------------------------------------------------------------
// nudge_analyze
// ---------------------------------------------------------------------------

export const nudgeAnalyzeToolDefinition = {
  name: "nudge_analyze",
  description:
    "Run the background pattern analysis at session close. Executes the pattern analyzer and nudge " +
    "prioritiser over the self-model database and stores any observations that clear the priority " +
    "thresholds as pending nudges. Returns a summary of what was evaluated and stored. Surfacing is " +
    "handled separately by nudge_check; this only detects and stores.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: {
        type: "integer",
        description: "Max seconds for the analysis subprocess (default 60, max 120).",
      },
    },
    required: [],
  },
};

export async function handleNudgeAnalyze(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;

  const prioritizerPath = resolvePath(SCRIPTS_BASE, "nudge_prioritizer.py");
  if (!prioritizerPath.startsWith(SCRIPTS_BASE) || !existsSync(prioritizerPath)) {
    return errorResult("scripts_missing",
      `nudge_prioritizer.py not found in ${SCRIPTS_BASE}. Deploy the Phase 3 scripts to the volume.`);
  }

  const timeout = Math.min(120, Math.max(5, Number.parseInt(args.timeout_seconds, 10) || 60));
  const dbPath = getSelfModelDbPath();

  try {
    const result = spawnSync(
      pythonBin(),
      [prioritizerPath, "--analyze", "--db", dbPath],
      { cwd: SCRIPTS_BASE, timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024,
        // v12.28.0 (TNX-C-004): this module spawned Python with the connector's
// COMPLETE process environment. The audit cited only script-execute.js, but a
// verification sweep for the `...process.env` idiom found this site too. Every
// script run from here inherited ANTHROPIC_API_KEY, GOOGLE_REFRESH_TOKEN,
// SLACK_BOT_TOKEN, WP_APP_PASSWORD, RAILWAY_RESTORE_TOKEN, MCP_API_KEY and the
// rest. Replaced by the shared allowlist builder, which constructs the child
// environment from scratch rather than filtering process.env.
        env: buildScriptEnv({ scriptKey: "nudge_prioritizer.py", extra: { SELF_MODEL_DB_PATH: dbPath } }) }
    );

    if (result.error) {
      return errorResult("subprocess_error",
        `Failed to run analysis: ${result.error.code || result.error.message}. Is python3 available?`);
    }

    const stdout = (result.stdout?.toString() || "").trim();
    const stderr = (result.stderr?.toString() || "").trim();
    let summary = null;
    try { summary = JSON.parse(stdout); } catch { /* non-JSON output */ }

    if (result.status !== 0 || (summary && summary.error)) {
      return errorResult("analysis_failed",
        (summary && summary.error) || stderr || `exit code ${result.status}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, summary: summary || { raw: stdout } }, null, 2) }],
      isError: false,
    };
  } catch (err) {
    log("error", `[self-model] nudge_analyze failed: ${err.message}`);
    return errorResult("exception", err.message);
  }
}

// ---------------------------------------------------------------------------
// nudge_check
// ---------------------------------------------------------------------------

export const nudgeCheckToolDefinition = {
  name: "nudge_check",
  description:
    "At session open, return the single highest-priority pending nudge, if any, and mark it surfaced. " +
    "Returns at most one nudge per call (max one per session). If nothing clears the bar, returns none - " +
    "quiet is the default. Nudges in opted-out categories are never surfaced.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Optional session id for attribution." },
    },
    required: [],
  },
};

export async function handleNudgeCheck(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const db = getSelfModelDb();

  try {
    const row = db.prepare(`
      SELECT n.pattern_id, n.pattern_category, n.message, n.score
      FROM nudges n
      WHERE n.status = 'pending'
        AND n.pattern_category NOT IN (
          SELECT pattern_category FROM nudge_optouts WHERE opted_out = 1
        )
      ORDER BY n.score DESC, n.first_detected ASC
      LIMIT 1
    `).get();

    if (!row) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, nudge: null }, null, 2) }],
        isError: false,
      };
    }

    db.prepare(`
      UPDATE nudges SET status = 'surfaced', last_surfaced = @ts, updated_at = @ts
      WHERE pattern_id = @pid
    `).run({ ts: nowIso(), pid: row.pattern_id });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          nudge: {
            nudge_id: row.pattern_id,
            category: row.pattern_category,
            message: row.message,
            score: row.score,
          },
        }, null, 2),
      }],
      isError: false,
    };
  } catch (err) {
    log("error", `[self-model] nudge_check failed: ${err.message}`);
    return errorResult("exception", err.message);
  }
}

// ---------------------------------------------------------------------------
// nudge_action
// ---------------------------------------------------------------------------

export const nudgeActionToolDefinition = {
  name: "nudge_action",
  description:
    "Record the recipient's response to a surfaced nudge. Actions: 'show_me' (acted on - marks it done), " +
    "'snooze' (re-surface next session), 'dismiss' (remove; two dismissals of a category permanently opt " +
    "that category out).",
  inputSchema: {
    type: "object",
    properties: {
      nudge_id: { type: "string", description: "The pattern_id returned by nudge_check." },
      action: { type: "string", enum: ["show_me", "snooze", "dismiss"], description: "The recipient's decision." },
    },
    required: ["nudge_id", "action"],
  },
};

export async function handleNudgeAction(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const db = getSelfModelDb();

  const nudgeId = typeof args.nudge_id === "string" ? args.nudge_id.trim() : "";
  const action = args.action;
  if (!nudgeId) return errorResult("bad_request", "nudge_id is required.");
  if (!["show_me", "snooze", "dismiss"].includes(action)) {
    return errorResult("bad_request", "action must be one of show_me, snooze, dismiss.");
  }

  try {
    const nudge = db.prepare(`SELECT pattern_id, pattern_category, status FROM nudges WHERE pattern_id = ?`).get(nudgeId);
    if (!nudge) return errorResult("not_found", `No nudge with id ${nudgeId}.`);

    const ts = nowIso();
    let optedOut = false;

    if (action === "show_me") {
      db.prepare(`UPDATE nudges SET status = 'actioned', updated_at = ? WHERE pattern_id = ?`).run(ts, nudgeId);
    } else if (action === "snooze") {
      // Re-eligible next session (nudge_check surfaces 'pending').
      db.prepare(`UPDATE nudges SET status = 'pending', updated_at = ? WHERE pattern_id = ?`).run(ts, nudgeId);
    } else if (action === "dismiss") {
      db.prepare(`
        UPDATE nudges SET status = 'dismissed', dismiss_count = dismiss_count + 1, updated_at = ?
        WHERE pattern_id = ?
      `).run(ts, nudgeId);

      // Category-level opt-out tracking.
      db.prepare(`
        INSERT INTO nudge_optouts (pattern_category, dismiss_count, opted_out, updated_at)
        VALUES (@cat, 1, 0, @ts)
        ON CONFLICT(pattern_category) DO UPDATE SET
          dismiss_count = nudge_optouts.dismiss_count + 1,
          updated_at = @ts
      `).run({ cat: nudge.pattern_category, ts });

      const optRow = db.prepare(`SELECT dismiss_count FROM nudge_optouts WHERE pattern_category = ?`).get(nudge.pattern_category);
      if (optRow && optRow.dismiss_count >= OPTOUT_DISMISS_THRESHOLD) {
        db.prepare(`UPDATE nudge_optouts SET opted_out = 1, updated_at = ? WHERE pattern_category = ?`)
          .run(ts, nudge.pattern_category);
        optedOut = true;
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          nudge_id: nudgeId,
          action,
          category: nudge.pattern_category,
          category_opted_out: optedOut,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (err) {
    log("error", `[self-model] nudge_action failed: ${err.message}`);
    return errorResult("exception", err.message);
  }
}

// ---------------------------------------------------------------------------

function errorResult(reason, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, message }, null, 2) }],
    isError: true,
  };
}
