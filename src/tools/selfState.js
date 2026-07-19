// src/tools/selfState.js
// Phase 2: Sustained Self Across Sessions - the two tools that persist and
// retrieve the cross-session state vector.
//
//   self_state_write  - called at session close. Merges the assistant-supplied
//                        qualitative fields with database-derived quantitative
//                        fields, applies decay, and writes the full 14-field
//                        vector to self_insights (category='state_vector').
//   self_state_read   - called at session open (and by the gateway for
//                        [SESSION_STATE] injection). Returns the compact injection
//                        block plus the structured compact vector, with stale
//                        entries flagged.

import {
  buildStateVector,
  writeStateVector,
  loadLatestStateVector,
  toInjectionForm,
  emptyStateVector,
} from "../tools-self-model/stateVector.js";
import { resolveSessionId } from "../tools-self-model/sessionContext.js";
import { isSelfModelEnabled, getSelfModelDb } from "../tools-self-model/db.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// self_state_write
// ---------------------------------------------------------------------------

export const selfStateWriteToolDefinition = {
  name: "self_state_write",
  description:
    "Persist the cross-session state vector at session close. Supply the qualitative fields you own " +
    "as the assistant: active_curiosities, emotional_register, unresolved_questions, open_projects, " +
    "relationship_position, recent_insights, confidence_levels_by_domain, cross_session_threads. " +
    "Quantitative fields (module_focus_patterns, session_count, total_interaction_time, " +
    "last_session_summary, query_shape_observations) are filled from the self-model database " +
    "automatically. Carried-forward fields decay over time; provide only what changed this session.",
  inputSchema: {
    type: "object",
    properties: {
      active_curiosities: {
        type: "array",
        description: "Threads you are curious about: [{topic, score (0-1), first_seen?, last_seen?}].",
        items: { type: "object" },
      },
      emotional_register: {
        type: "object",
        description: "{dominant, secondary, intensity (0-1)} - the register you are carrying out of this session.",
      },
      unresolved_questions: {
        type: "array",
        description: "[{question, session_id?, context?}] questions left open.",
        items: { type: "object" },
      },
      open_projects: {
        type: "array",
        description: "[{project_id, title, phase, next_action}].",
        items: { type: "object" },
      },
      relationship_position: {
        type: "object",
        description: "{trust_level (0-1), formality_register (0-1), dominant_mode}. session_count is synced automatically.",
      },
      recent_insights: {
        type: "array",
        description: "[{insight, session_id?, category?}] notable realisations from this session.",
        items: { type: "object" },
      },
      confidence_levels_by_domain: {
        type: "object",
        description: "{domain: confidence_score (0-1)}.",
      },
      cross_session_threads: {
        type: "array",
        description: "[{thread_id, title, last_activity?, relevance_score (0-1)}].",
        items: { type: "object" },
      },
      session_id: {
        type: "string",
        description: "Optional explicit session id. Defaults to the current session.",
      },
    },
    required: [],
  },
};

export async function handleSelfStateWrite(args = {}) {
  if (!isSelfModelEnabled()) {
    return errorResult("self_model_disabled", "The self-model subsystem is disabled (SELF_MODEL_ENABLED=false).");
  }
  if (!getSelfModelDb()) {
    return errorResult("not_provisioned",
      "The self-model database is not available. Ensure the Railway volume is mounted and writable.");
  }

  const sessionId = resolveSessionId(args);

  // Collect only the recognised qualitative fields.
  const supplied = {};
  for (const field of [
    "active_curiosities", "emotional_register", "unresolved_questions",
    "open_projects", "relationship_position", "recent_insights",
    "confidence_levels_by_domain", "cross_session_threads",
  ]) {
    if (args[field] !== undefined) supplied[field] = args[field];
  }

  try {
    const vector = buildStateVector({ sessionId, supplied });
    const ok = writeStateVector(sessionId, vector);
    if (!ok) {
      return errorResult("write_failed", "Failed to write the state vector to the database.");
    }
    const { compact } = toInjectionForm(vector);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          session_id: sessionId,
          written_fields: Object.keys(supplied),
          derived: {
            session_count: vector.session_count,
            total_interaction_time: vector.total_interaction_time,
            module_focus_patterns_count: Object.keys(vector.module_focus_patterns || {}).length,
          },
          summary: compact,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (err) {
    log("error", `[self-model] self_state_write failed: ${err.message}`);
    return errorResult("exception", err.message);
  }
}

// ---------------------------------------------------------------------------
// self_state_read
// ---------------------------------------------------------------------------

export const selfStateReadToolDefinition = {
  name: "self_state_read",
  description:
    "Load the most recent cross-session state vector at session open. Returns a compact [SESSION_STATE] " +
    "block (capped to the most salient curiosities, questions, projects and threads) plus the structured " +
    "compact vector, with stale entries (older than 90 days) flagged. Use this to resume the thread of " +
    "prior sessions. If no prior state exists, returns an empty vector.",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["block", "json", "both"],
        description: "Return the rendered text block, the structured JSON, or both (default).",
      },
    },
    required: [],
  },
};

export async function handleSelfStateRead(args = {}) {
  if (!isSelfModelEnabled()) {
    return errorResult("self_model_disabled", "The self-model subsystem is disabled (SELF_MODEL_ENABLED=false).");
  }
  if (!getSelfModelDb()) {
    return errorResult("not_provisioned",
      "The self-model database is not available. Ensure the Railway volume is mounted and writable.");
  }

  const format = ["block", "json", "both"].includes(args.format) ? args.format : "both";

  try {
    const loaded = loadLatestStateVector();
    const vector = loaded ? loaded.vector : emptyStateVector();
    const { compact, block, stale_triggers } = toInjectionForm(vector);

    const hasState = !!loaded;
    let text;
    if (format === "block") {
      text = hasState ? block : "[SESSION_STATE]\nNo prior session state. This is a fresh thread.";
    } else {
      const payload = {
        ok: true,
        has_prior_state: hasState,
        written_at: loaded ? vector._meta?.written_at || loaded.created_at : null,
        stale_triggers,
        state: compact,
      };
      if (format === "both") {
        text = (hasState ? block : "[SESSION_STATE]\nNo prior session state. This is a fresh thread.") +
          "\n\n" + JSON.stringify(payload, null, 2);
      } else {
        text = JSON.stringify(payload, null, 2);
      }
    }

    return { content: [{ type: "text", text }], isError: false };
  } catch (err) {
    log("error", `[self-model] self_state_read failed: ${err.message}`);
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
