// src/tools/homeworkTools.js
// Phase 5b: Assessed Homework PDF Render - the connector side.
//
//   homework_assess_render - given a homework spec and the student's answers,
//     assesses each answer and renders a marked PDF (colour-coded markers,
//     per-page score badge, tone-calibrated comments, results summary). Returns
//     the summary plus the PDF as base64 so the caller can deliver it.
//
// The three triggers in the spec (A file upload, B in-session review, C session
// summary reconstruction) all assemble the same questions array upstream; this
// tool assesses + renders it. Shells out to homework_assessment.py (reportlab).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../utils/logger.js";

const SCRIPTS_BASE = process.env.SCRIPTS_DIR
  ? resolvePath(process.env.SCRIPTS_DIR)
  : resolvePath("/data/skill/ava/scripts");

const MAX_PDF_BYTES = 6 * 1024 * 1024;   // guard the base64 payload size

function pythonBin() {
  return existsSync("/mise/shims/python3") ? "/mise/shims/python3" : "python3";
}

export const homeworkAssessRenderToolDefinition = {
  name: "homework_assess_render",
  description:
    "Assess a student's homework answers against the model answers and render a marked PDF with " +
    "colour-coded feedback, a score badge, tone-calibrated comments, and a results summary. Provide the " +
    "questions with correct_answer and student_answer; optionally set assessment (correct|partial|incorrect) " +
    "and comment per question to override the automatic matcher. Returns a summary and the PDF as base64.",
  inputSchema: {
    type: "object",
    properties: {
      homework_slug: { type: "string", description: "Identifier for the homework (used in the title)." },
      student_name: { type: "string", description: "Student's name (optional)." },
      student_age: { type: "integer", description: "Student's age; selects the comment tone. Defaults to the 11-13 register." },
      questions: {
        type: "array",
        description: "The assessed questions.",
        items: {
          type: "object",
          properties: {
            number: { type: "integer" },
            concept: { type: "string" },
            question: { type: "string" },
            correct_answer: { type: "string" },
            student_answer: { type: "string" },
            assessment: { type: "string", enum: ["correct", "partial", "incorrect"] },
            comment: { type: "string" },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
};

export async function handleHomeworkAssessRender(args = {}) {
  const questions = Array.isArray(args.questions) ? args.questions : null;
  if (!questions || questions.length === 0) {
    return errorResult("bad_request", "questions is required and must be a non-empty array.");
  }

  const scriptPath = resolvePath(SCRIPTS_BASE, "homework_assessment.py");
  if (!scriptPath.startsWith(SCRIPTS_BASE) || !existsSync(scriptPath)) {
    return errorResult("scripts_missing",
      `homework_assessment.py not found in ${SCRIPTS_BASE}. Deploy the Phase 5b script to the volume.`);
  }

  let workDir;
  try {
    workDir = mkdtempSync(joinPath(tmpdir(), "hw-"));
  } catch (err) {
    return errorResult("tmp_error", `could not create a temp directory: ${err.message}`);
  }
  const inputPath = joinPath(workDir, "answers.json");
  const outputPath = joinPath(workDir, "marked.pdf");

  const payload = {
    homework_slug: args.homework_slug || "",
    student_name: args.student_name || "",
    student_age: Number.isFinite(args.student_age) ? args.student_age : null,
    questions,
  };

  try {
    writeFileSync(inputPath, JSON.stringify(payload), "utf8");

    const result = spawnSync(
      pythonBin(),
      [scriptPath, "--input", inputPath, "--output", outputPath],
      { cwd: SCRIPTS_BASE, timeout: 60000, maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" } }
    );

    if (result.error) {
      return errorResult("subprocess_error",
        `Failed to run homework_assessment.py: ${result.error.code || result.error.message}. Is python3/reportlab available?`);
    }
    const stdout = (result.stdout?.toString() || "").trim();
    const stderr = (result.stderr?.toString() || "").trim();
    let summary = null;
    try { summary = JSON.parse(stdout); } catch { /* non-JSON */ }

    if (result.status !== 0 || !summary || summary.ok === false) {
      return errorResult("render_failed", (summary && summary.error) || stderr || `exit ${result.status}`);
    }
    if (!existsSync(outputPath)) {
      return errorResult("render_failed", "the renderer reported success but no PDF was produced.");
    }
    const pdf = readFileSync(outputPath);
    if (pdf.length > MAX_PDF_BYTES) {
      return errorResult("too_large", `the rendered PDF is ${pdf.length} bytes, over the ${MAX_PDF_BYTES} limit.`);
    }

    const slug = (args.homework_slug || "homework").replace(/[^a-zA-Z0-9._-]/g, "-");
    return okResult({
      ok: true,
      summary: {
        score: summary.score, percentage: summary.percentage, tally: summary.tally,
        band: summary.band, strong_areas: summary.strong_areas, focus_areas: summary.focus_areas,
      },
      filename: `${slug}-assessed.pdf`,
      pdf_base64: pdf.toString("base64"),
    });
  } catch (err) {
    log("error", `[homework] assess/render failed: ${err.message}`);
    return errorResult("exception", err.message);
  } finally {
    for (const p of [inputPath, outputPath]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
    }
  }
}

function okResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
}

function errorResult(reason, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, message }, null, 2) }],
    isError: true,
  };
}
