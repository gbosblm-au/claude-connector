// src/tools/socraticTools.js
// Phase 4: Socratic Tutor Mode - the connector side.
//
//   student_model_observe  - record an observation about a concept (Bayesian
//                            update; explicit confirmations weigh more than
//                            inferred reads).
//   student_model_relate   - record relational hints (adjacent_to / conflicts_with)
//                            that seam detection uses.
//   socratic_seam_question - run the pipeline (student model -> seam detection ->
//                            question generation) and return one seam-targeting
//                            question, or none if nothing passes the naturalness
//                            filter.
//   student_model_read     - read the current student model (introspection).
//
// The write and generate paths shell out to the Python scripts (single source of
// truth for the update/decay/seam logic); the read path queries SQLite directly.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { getSelfModelDb, getSelfModelDbPath, isSelfModelEnabled } from "../tools-self-model/db.js";
import { log } from "../utils/logger.js";

const SCRIPTS_BASE = process.env.SCRIPTS_DIR
  ? resolvePath(process.env.SCRIPTS_DIR)
  : resolvePath("/data/skill/ava/scripts");

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

function runScript(scriptName, scriptArgs, timeoutSeconds = 30) {
  const scriptPath = resolvePath(SCRIPTS_BASE, scriptName);
  if (!scriptPath.startsWith(SCRIPTS_BASE) || !existsSync(scriptPath)) {
    return { ok: false, reason: "scripts_missing",
      message: `${scriptName} not found in ${SCRIPTS_BASE}. Deploy the Phase 4 scripts to the volume.` };
  }
  const dbPath = getSelfModelDbPath();
  const result = spawnSync(
    pythonBin(),
    [scriptPath, ...scriptArgs, "--db", dbPath],
    { cwd: SCRIPTS_BASE, timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1", SELF_MODEL_DB_PATH: dbPath } }
  );
  if (result.error) {
    return { ok: false, reason: "subprocess_error",
      message: `Failed to run ${scriptName}: ${result.error.code || result.error.message}. Is python3 available?` };
  }
  const stdout = (result.stdout?.toString() || "").trim();
  const stderr = (result.stderr?.toString() || "").trim();
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* non-JSON */ }
  if (result.status !== 0 || (parsed && parsed.ok === false) || (parsed && parsed.error)) {
    return { ok: false, reason: "script_failed",
      message: (parsed && (parsed.error || parsed.message)) || stderr || `exit ${result.status}` };
  }
  return { ok: true, data: parsed !== null ? parsed : { raw: stdout } };
}

// ---------------------------------------------------------------------------
// student_model_observe
// ---------------------------------------------------------------------------

export const studentModelObserveToolDefinition = {
  name: "student_model_observe",
  description:
    "Record an observation about the recipient's understanding of a concept. Updates a cross-session " +
    "confidence estimate (Bayesian: explicit confirmations weigh more than inferred reads). signal is one " +
    "of mastered|confident|partial|unsure|struggled|incorrect, or a number 0..1.",
  inputSchema: {
    type: "object",
    properties: {
      concept: { type: "string", description: "The concept observed (e.g. 'recursion')." },
      signal: { type: "string", description: "mastered|confident|partial|unsure|struggled|incorrect, or 0..1." },
      source: { type: "string", enum: ["inferred", "explicit"], description: "Explicit = the recipient confirmed it." },
      domain: { type: "string", description: "Optional domain grouping (e.g. 'architecture')." },
    },
    required: ["concept", "signal"],
  },
};

export async function handleStudentModelObserve(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const concept = typeof args.concept === "string" ? args.concept.trim() : "";
  const signal = args.signal;
  if (!concept) return errorResult("bad_request", "concept is required.");
  if (signal === undefined || signal === null || `${signal}`.trim() === "") {
    return errorResult("bad_request", "signal is required.");
  }
  const scriptArgs = ["--observe", "--concept", concept, "--signal", `${signal}`,
    "--source", args.source === "explicit" ? "explicit" : "inferred"];
  if (args.domain) scriptArgs.push("--domain", `${args.domain}`);

  const r = runScript("student_model.py", scriptArgs);
  return r.ok ? okResult(r.data) : errorResult(r.reason, r.message);
}

// ---------------------------------------------------------------------------
// student_model_relate
// ---------------------------------------------------------------------------

export const studentModelRelateToolDefinition = {
  name: "student_model_relate",
  description:
    "Record a relationship between concepts for seam detection. adjacent_to marks two concepts as " +
    "neighbouring (enables activation/transfer seams); conflicts_with marks two confident beliefs as " +
    "potentially incompatible (enables contradiction seams).",
  inputSchema: {
    type: "object",
    properties: {
      concept: { type: "string", description: "The concept to attach the relation to." },
      adjacent_to: { type: "string", description: "A neighbouring concept." },
      conflicts_with: { type: "string", description: "A concept that may conflict with this one." },
    },
    required: ["concept"],
  },
};

export async function handleStudentModelRelate(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const concept = typeof args.concept === "string" ? args.concept.trim() : "";
  if (!concept) return errorResult("bad_request", "concept is required.");
  if (!args.adjacent_to && !args.conflicts_with) {
    return errorResult("bad_request", "provide adjacent_to and/or conflicts_with.");
  }
  const scriptArgs = ["--relate", "--concept", concept];
  if (args.adjacent_to) scriptArgs.push("--adjacent-to", `${args.adjacent_to}`);
  if (args.conflicts_with) scriptArgs.push("--conflicts-with", `${args.conflicts_with}`);

  const r = runScript("student_model.py", scriptArgs);
  return r.ok ? okResult(r.data) : errorResult(r.reason, r.message);
}

// ---------------------------------------------------------------------------
// socratic_seam_question
// ---------------------------------------------------------------------------

export const socraticSeamQuestionToolDefinition = {
  name: "socratic_seam_question",
  description:
    "Run the Socratic pipeline over the student model and return one seam-targeting question, or none. " +
    "Seam questions create productive tension at the edge of understanding rather than filling gaps. " +
    "Returns null when nothing passes the naturalness filter - in which case do not force a question.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: { type: "integer", description: "Max seconds for the pipeline (default 45, max 90)." },
    },
    required: [],
  },
};

export async function handleSocraticSeamQuestion(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const timeout = Math.min(90, Math.max(5, Number.parseInt(args.timeout_seconds, 10) || 45));
  const r = runScript("question_generation.py", ["--next"], timeout);
  return r.ok ? okResult(r.data) : errorResult(r.reason, r.message);
}

// ---------------------------------------------------------------------------
// student_model_read  (direct SQLite read)
// ---------------------------------------------------------------------------

export const studentModelReadToolDefinition = {
  name: "student_model_read",
  description:
    "Read the current student model: concepts with confidence estimates, uncertainty intervals, evidence " +
    "counts, and relational hints. For introspection and calibration.",
  inputSchema: {
    type: "object",
    properties: {
      min_confidence: { type: "number", description: "Optional: only concepts at or above this confidence." },
      limit: { type: "integer", description: "Max concepts to return (default 50)." },
    },
    required: [],
  },
};

export async function handleStudentModelRead(args = {}) {
  const guard = guardEnabled();
  if (guard) return guard;
  const db = getSelfModelDb();
  const limit = Math.min(500, Math.max(1, Number.parseInt(args.limit, 10) || 50));
  const minConf = Number.isFinite(args.min_confidence) ? Number(args.min_confidence) : null;

  try {
    const rows = minConf === null
      ? db.prepare(`SELECT concept, confidence, confidence_lower, confidence_upper, observations, source, domain, seam_scores, first_seen, last_updated
                    FROM student_model ORDER BY confidence DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT concept, confidence, confidence_lower, confidence_upper, observations, source, domain, seam_scores, first_seen, last_updated
                    FROM student_model WHERE confidence >= ? ORDER BY confidence DESC LIMIT ?`).all(minConf, limit);

    const concepts = rows.map((r) => ({
      ...r,
      seam_scores: safeParse(r.seam_scores),
    }));
    return okResult({ ok: true, count: concepts.length, concepts });
  } catch (err) {
    log("error", `[self-model] student_model_read failed: ${err.message}`);
    return errorResult("exception", err.message);
  }
}

// ---------------------------------------------------------------------------

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function okResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

function errorResult(reason, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, message }, null, 2) }],
    isError: true,
  };
}
