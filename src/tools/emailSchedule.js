// src/tools/emailSchedule.js
//
// MCP tool definitions and handlers for SCOPE-05 scheduling surface:
//   email_schedule         -- queue a deferred send or define a drip sequence
//   email_schedule_cancel  -- cancel a pending send or sequence
//   email_schedule_list    -- list scheduled sends (filterable)

import {
  createDeferredSchedule,
  createDripSequence,
  cancelSchedule,
  listSchedules,
} from "../utils/scheduler.js";
import { config } from "../config.js";

// -----------------------------------------------------------------------
// Tool: email_schedule
// -----------------------------------------------------------------------
export const emailScheduleToolDefinition = {
  name: "email_schedule",
  description:
    "Queue an email to send at a specific future date/time in AEST/AEDT, OR define a multi-step " +
    "drip sequence where each step sends only if the previous step has not been opened or clicked. " +
    "All times must use a +10:00 (AEST) or +11:00 (AEDT) offset; UTC offsets are rejected. " +
    "Maximum 10 steps per drip sequence; maximum 50 pending schedules total.",
  inputSchema: {
    type: "object",
    properties: {
      to_address: { type: "string", description: "Recipient email address" },
      to_name:    { type: "string", description: "Recipient display name (optional)" },
      subject:    { type: "string", description: "Subject line (single deferred send)" },
      body_text:  { type: "string", description: "Body text (single deferred send)" },
      sender_id:  { type: "string", enum: ["brian", "michael", "robbie"], description: "Defaults to brian." },
      send_at:    { type: "string", description: "ISO 8601 datetime in AEST/AEDT, e.g. 2026-04-29T09:00:00+10:00. Required for single deferred send." },
      format:     { type: "string", enum: ["html", "text"], description: "Defaults to html." },
      company:    { type: "string", description: "Company name for tracking and reporting" },
      sequence:   {
        type: "array",
        description: "Array of drip step objects. If provided, top-level subject/body_text/send_at are ignored.",
        items: {
          type: "object",
          properties: {
            step_number: { type: "integer" },
            subject:     { type: "string" },
            body_text:   { type: "string" },
            send_at:     { type: "string" },
          },
          required: ["step_number", "subject", "body_text", "send_at"],
        },
      },
    },
    required: ["to_address"],
  },
};

export async function handleEmailSchedule(args) {
  args = args || {};
  if (!config.scheduleEnabled) {
    const out = { status: "failed", code: "SCHEDULE_DISABLED",
      error: "Scheduling is disabled (SCHEDULE_ENABLED=false)." };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }

  // Drip mode
  if (Array.isArray(args.sequence) && args.sequence.length > 0) {
    const result = createDripSequence({
      to_address: args.to_address,
      to_name: args.to_name,
      sender_id: args.sender_id,
      format: args.format,
      company: args.company,
      sequence: args.sequence,
    });
    if (result.error) {
      const out = { status: "failed", code: result.code || "VALIDATION_ERROR", error: result.error };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
    }
    const out = {
      status: "scheduled",
      schedule_type: "drip",
      sequence_id: result.sequence.sequence_id,
      step_count: result.scheduleRecords.length,
      to_address: args.to_address,
      sender_id: args.sender_id || "brian",
      stop_on_engagement: true,
      steps: result.scheduleRecords.map((s) => ({
        step_number: s.step_number,
        schedule_id: s.schedule_id,
        subject: s.subject,
        send_at: s.send_at,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }

  // Single deferred send
  if (!args.subject || !args.body_text || !args.send_at) {
    const out = { status: "failed", code: "VALIDATION_ERROR",
      error: "Single deferred send requires subject, body_text, and send_at." };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }

  const result = createDeferredSchedule({
    to_address: args.to_address,
    to_name: args.to_name,
    subject: args.subject,
    body_text: args.body_text,
    sender_id: args.sender_id,
    send_at: args.send_at,
    format: args.format,
    company: args.company,
  });
  if (result.error) {
    const out = { status: "failed", code: result.code || "VALIDATION_ERROR", error: result.error };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }

  const out = {
    status: "scheduled",
    schedule_type: "deferred",
    schedule_id: result.schedule_id,
    send_at: result.send_at,
    to_address: result.to_address,
    sender_id: result.sender_id,
    subject: result.subject,
    company: result.company,
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// -----------------------------------------------------------------------
// Tool: email_schedule_cancel
// -----------------------------------------------------------------------
export const emailScheduleCancelToolDefinition = {
  name: "email_schedule_cancel",
  description:
    "Cancel a pending scheduled send (by schedule_id) or every remaining pending step in a " +
    "drip sequence (by sequence_id). Sends already dispatched cannot be cancelled.",
  inputSchema: {
    type: "object",
    properties: {
      schedule_id: { type: "string", description: "Cancel a single scheduled send" },
      sequence_id: { type: "string", description: "Cancel all pending steps in a sequence" },
    },
  },
};

export async function handleEmailScheduleCancel(args) {
  args = args || {};
  if (!args.schedule_id && !args.sequence_id) {
    const out = { status: "failed", code: "VALIDATION_ERROR",
      error: "Provide schedule_id or sequence_id." };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }
  const result = cancelSchedule(args);
  if (result.error) {
    const out = { status: "failed", code: result.code || "UNKNOWN", error: result.error,
      was_pending: result.was_pending === true };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }
  const out = {
    status: "cancelled",
    schedule_id: result.schedule_id || null,
    sequence_id: result.sequence_id || null,
    was_pending: result.was_pending === true,
    cancelled_steps: result.cancelled_steps != null ? result.cancelled_steps : null,
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// -----------------------------------------------------------------------
// Tool: email_schedule_list
// -----------------------------------------------------------------------
export const emailScheduleListToolDefinition = {
  name: "email_schedule_list",
  description:
    "List scheduled sends. By default shows pending sends. Use status:\"all\" to include sent, " +
    "cancelled, failed, and skipped records within the lookback window.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "sent", "cancelled", "failed", "skipped", "all"],
               description: "Default pending." },
      since_days: { type: "integer", description: "Lookback window for non-pending records. Default 7." },
      company: { type: "string", description: "Filter by company name" },
    },
  },
};

export async function handleEmailScheduleList(args) {
  args = args || {};
  const out = listSchedules({
    status: args.status || "pending",
    since_days: args.since_days != null ? args.since_days : 7,
    company: args.company,
  });
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}
