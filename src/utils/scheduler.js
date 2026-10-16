// src/utils/scheduler.js
//
// In-process scheduler for SCOPE-05 (deferred sends + drip sequences).
//
// Architecture summary:
//   - JSON file at config.scheduleStorePath holds all schedule and sequence
//     records, persisted to a Railway volume.
//   - node-cron fires checkAndFireDueSchedules() every 60 seconds.
//   - Sends are dispatched via sendEmailInternal() from utils/email.js.
//   - Drip sequences pause when an open or click is detected against an
//     earlier step's tracking_id (SCOPE-04 integration).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DateTime } from "luxon";
import cron from "node-cron";
import { config } from "../config.js";
import { log } from "./logger.js";
import { sendEmailInternal } from "./email.js";
import { detectSequenceEngagement, appendTrackingEvent } from "./tracking.js";

const TZ = "Australia/Melbourne";

// -----------------------------------------------------------------------
// v13.39.0 (TENAX-2026-10-15-01 H-5): the unattended default, stated.
//
// A scheduled send runs with nobody there to answer, and an email cannot be
// recalled. So this path FAILS CLOSED wherever the human intent behind the
// schedule may no longer hold:
//
//   LATE   A send whose send_at has passed by more than the late grace (the
//          connector was down, the volume was restored, the tick stalled) is
//          not sent late. It is HELD (status held_overdue) for a person to
//          release (email_schedule_release) or cancel. Before this release the
//          boot catch-up sent every overdue email the moment the process came
//          back, however old.
//   TWICE  Overlapping ticks cannot dispatch the same pending send twice: a
//          tick that finds one already running does nothing.
//   NEVER  A hold nobody answers within the hold expiry TIMES OUT and the send
//          is denied (status expired_unconfirmed). A timeout is not a refusal:
//          it is not counted with cancellations, and asking again (a new
//          email_schedule) is never penalised.
//
// Both windows are operator settings with stated defaults:
//   SCHEDULE_LATE_GRACE_MINUTES   default 60, 1..10080
//   SCHEDULE_HOLD_EXPIRY_DAYS     default 7, 1..90
// -----------------------------------------------------------------------
function boundedEnvInt(name, fallback, min, max) {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
export function lateGraceMs() { return boundedEnvInt("SCHEDULE_LATE_GRACE_MINUTES", 60, 1, 10080) * 60000; }
export function holdExpiryMs() { return boundedEnvInt("SCHEDULE_HOLD_EXPIRY_DAYS", 7, 1, 90) * 86400000; }

/** Statuses a person decided (refusals). A timeout is deliberately not one. */
export const REFUSAL_STATUSES = Object.freeze(["cancelled"]);

let _tickInFlight = false;

// -----------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------
let store = { schedules: [], sequences: [], _counter: 0 };

function ensureStoreDir() {
  const dir = dirname(config.scheduleStorePath);
  try {
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    log("warn", `Could not create schedule store dir ${dir}: ${err.message}`);
  }
}

function loadStore() {
  try {
    if (existsSync(config.scheduleStorePath)) {
      const raw = readFileSync(config.scheduleStorePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        store = {
          schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
          sequences: Array.isArray(parsed.sequences) ? parsed.sequences : [],
          _counter: parsed._counter || 0,
        };
        log("info", `Schedule store loaded: ${store.schedules.length} schedules, ${store.sequences.length} sequences`);
        return;
      }
    }
  } catch (err) {
    log("warn", `Schedule store load failed (starting empty): ${err.message}`);
  }
  store = { schedules: [], sequences: [], _counter: 0 };
}

function saveStore() {
  try {
    ensureStoreDir();
    writeFileSync(config.scheduleStorePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    log("error", `Schedule store save failed: ${err.message}`);
  }
}

function nextScheduleId() {
  store._counter = (store._counter || 0) + 1;
  return `sch_${String(store._counter).padStart(3, "0")}`;
}

function nextSequenceId() {
  // Use a separate counter range to avoid collisions
  const all = store.sequences.map((s) => parseInt(String(s.sequence_id).replace(/[^0-9]/g, ""), 10) || 0);
  const next = (all.length ? Math.max(...all) : 0) + 1;
  return `seq_${String(next).padStart(3, "0")}`;
}

// -----------------------------------------------------------------------
// Validation (AEST/AEDT offset, future, drip ordering)
// -----------------------------------------------------------------------
function isAestOffset(iso) {
  // Accept +10:00 (AEST) or +11:00 (AEDT). Reject other offsets including UTC (Z or +00:00).
  return /[+]1[01]:00$/.test(iso);
}

export function validateSendAt(iso) {
  if (!iso || typeof iso !== "string") {
    return { ok: false, error: "send_at must be an ISO 8601 string." };
  }
  if (!isAestOffset(iso)) {
    return {
      ok: false,
      error: "send_at must use AEST/AEDT offset (+10:00 or +11:00). UTC is not accepted.",
    };
  }
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) {
    return { ok: false, error: `Could not parse send_at: ${dt.invalidReason || "invalid date"}` };
  }
  const minFuture = DateTime.now().plus({ minutes: 5 });
  if (dt < minFuture) {
    return { ok: false, error: "send_at must be at least 5 minutes in the future." };
  }
  return { ok: true, dt };
}

function pendingCount() {
  return store.schedules.filter((s) => s.status === "pending").length;
}

// -----------------------------------------------------------------------
// Public API: create deferred send
// -----------------------------------------------------------------------
export function createDeferredSchedule(input) {
  if (!config.scheduleEnabled) {
    return { error: "Scheduling is disabled (SCHEDULE_ENABLED=false).", code: "SCHEDULE_DISABLED" };
  }
  if (pendingCount() >= (config.scheduleMaxPending || 50)) {
    return { error: `Maximum pending schedules (${config.scheduleMaxPending}) reached.`, code: "SCHEDULE_LIMIT_EXCEEDED" };
  }

  const v = validateSendAt(input.send_at);
  if (!v.ok) return { error: v.error, code: "VALIDATION_ERROR" };

  const sender_id = (input.sender_id || "brian").toLowerCase();

  const record = {
    schedule_id: nextScheduleId(),
    schedule_type: "deferred",
    status: "pending",
    created_at: DateTime.now().setZone(TZ).toISO({ suppressMilliseconds: true }),
    sender_id,
    to_address: input.to_address,
    to_name: input.to_name || "",
    subject: input.subject,
    body_text: input.body_text,
    format: input.format || "html",
    send_at: input.send_at,
    tracking_id: null,
    sent_at: null,
    cancelled_at: null,
    company: input.company || "",
    sequence_id: null,
    step_number: null,
    error_code: null,
  };
  store.schedules.push(record);
  saveStore();
  return record;
}

// -----------------------------------------------------------------------
// Public API: create drip sequence
// -----------------------------------------------------------------------
export function createDripSequence(input) {
  if (!config.scheduleEnabled) {
    return { error: "Scheduling is disabled (SCHEDULE_ENABLED=false).", code: "SCHEDULE_DISABLED" };
  }
  const steps = Array.isArray(input.sequence) ? input.sequence : [];
  if (steps.length < 1) {
    return { error: "sequence must contain at least one step.", code: "VALIDATION_ERROR" };
  }
  if (steps.length > 10) {
    return { error: "sequence cannot exceed 10 steps.", code: "VALIDATION_ERROR" };
  }
  if (pendingCount() + steps.length > (config.scheduleMaxPending || 50)) {
    return { error: `Maximum pending schedules (${config.scheduleMaxPending}) would be exceeded.`, code: "SCHEDULE_LIMIT_EXCEEDED" };
  }

  // Validate each step's send_at and chronological order
  let prevTs = 0;
  for (const step of steps) {
    if (step.step_number == null || step.subject == null || step.body_text == null || !step.send_at) {
      return { error: "Each step requires step_number, subject, body_text, and send_at.", code: "VALIDATION_ERROR" };
    }
    const v = validateSendAt(step.send_at);
    if (!v.ok) return { error: `Step ${step.step_number}: ${v.error}`, code: "VALIDATION_ERROR" };
    const ts = v.dt.toMillis();
    if (ts <= prevTs) {
      return { error: `Step ${step.step_number} send_at must be strictly later than the previous step.`, code: "VALIDATION_ERROR" };
    }
    prevTs = ts;
  }

  const sender_id = (input.sender_id || "brian").toLowerCase();
  const sequence_id = nextSequenceId();

  const created = DateTime.now().setZone(TZ).toISO({ suppressMilliseconds: true });
  const stepRecords = steps
    .slice()
    .sort((a, b) => a.step_number - b.step_number)
    .map((step) => {
      const sched = {
        schedule_id: nextScheduleId(),
        schedule_type: "drip",
        status: "pending",
        created_at: created,
        sender_id,
        to_address: input.to_address,
        to_name: input.to_name || "",
        subject: step.subject,
        body_text: step.body_text,
        format: input.format || "html",
        send_at: step.send_at,
        tracking_id: null,
        sent_at: null,
        cancelled_at: null,
        company: input.company || "",
        sequence_id,
        step_number: step.step_number,
        error_code: null,
      };
      store.schedules.push(sched);
      return sched;
    });

  const sequence = {
    sequence_id,
    status: "active",
    created_at: created,
    company: input.company || "",
    to_address: input.to_address,
    to_name: input.to_name || "",
    sender_id,
    stop_on_engagement: true,
    steps: stepRecords.map((s) => ({
      step_number: s.step_number,
      schedule_id: s.schedule_id,
      subject: s.subject,
      send_at: s.send_at,
      status: s.status,
    })),
  };
  store.sequences.push(sequence);
  saveStore();
  return { sequence, scheduleRecords: stepRecords };
}

// -----------------------------------------------------------------------
// Public API: cancel
// -----------------------------------------------------------------------
export function cancelSchedule({ schedule_id, sequence_id }) {
  const now = DateTime.now().setZone(TZ).toISO({ suppressMilliseconds: true });

  if (schedule_id) {
    const rec = store.schedules.find((s) => s.schedule_id === schedule_id);
    if (!rec) return { error: `Unknown schedule_id "${schedule_id}".`, code: "NOT_FOUND" };
    if (rec.status === "sent" || rec.status === "failed") {
      return { error: `Cannot cancel a schedule with status "${rec.status}".`, code: "INVALID_STATE", was_pending: false };
    }
    // v13.39.0 (H-5): an expired hold already denied the send by timeout.
    // Cancelling it would rewrite a timeout as a refusal, so it stays expired.
    if (rec.status === "expired_unconfirmed") {
      return { error: "This send already expired unconfirmed and was not sent; there is nothing to cancel.", code: "INVALID_STATE", was_pending: false };
    }
    const wasPending = rec.status === "pending";
    rec.status = "cancelled";
    rec.cancelled_at = now;
    saveStore();
    return { schedule_id, was_pending: wasPending };
  }

  if (sequence_id) {
    const seq = store.sequences.find((s) => s.sequence_id === sequence_id);
    if (!seq) return { error: `Unknown sequence_id "${sequence_id}".`, code: "NOT_FOUND" };
    let cancelledCount = 0;
    for (const sched of store.schedules) {
      // v13.39.0 (H-5): a held step belongs to the sequence too; cancelling the
      // sequence cancels it rather than leaving it to time out.
      if (sched.sequence_id === sequence_id && (sched.status === "pending" || sched.status === "held_overdue")) {
        sched.status = "cancelled";
        sched.cancelled_at = now;
        cancelledCount += 1;
      }
    }
    seq.status = "cancelled";
    saveStore();
    return { sequence_id, cancelled_steps: cancelledCount };
  }

  return { error: "Provide schedule_id or sequence_id.", code: "VALIDATION_ERROR" };
}

// -----------------------------------------------------------------------
// Public API: list
// -----------------------------------------------------------------------
export function listSchedules({ status = "pending", since_days = 7, company } = {}) {
  const cutoffMs = since_days > 0 ? Date.now() - since_days * 86400000 : 0;
  const out = [];
  for (const s of store.schedules) {
    if (status !== "all" && s.status !== status) continue;
    if (company && s.company.toLowerCase() !== company.toLowerCase()) continue;
    if (cutoffMs > 0 && s.status !== "pending") {
      const ts = Date.parse(s.sent_at || s.cancelled_at || s.expired_at || s.held_at || s.created_at);
      if (!isNaN(ts) && ts < cutoffMs) continue;
    }
    out.push({
      schedule_id: s.schedule_id,
      sequence_id: s.sequence_id,
      step_number: s.step_number,
      status: s.status,
      to_address: s.to_address,
      to_name: s.to_name,
      company: s.company,
      subject: s.subject,
      sender_id: s.sender_id,
      send_at: s.send_at,
      sent_at: s.sent_at,
      cancelled_at: s.cancelled_at,
      // v13.39.0 (H-5): held and expired sends say when and why.
      held_at: s.held_at || null,
      held_reason: s.held_reason || null,
      expired_at: s.expired_at || null,
      schedule_type: s.schedule_type,
      tracking_id: s.tracking_id,
      error_code: s.error_code,
    });
  }
  out.sort((a, b) => (a.send_at < b.send_at ? -1 : 1));
  return { total: out.length, schedules: out };
}

// -----------------------------------------------------------------------
// Cron: dispatch due sends
// -----------------------------------------------------------------------
async function maybeSkipDueToEngagement(sched) {
  if (!sched.sequence_id) return false;
  const earlierSteps = store.schedules.filter(
    (s) =>
      s.sequence_id === sched.sequence_id &&
      s.step_number < sched.step_number &&
      s.tracking_id
  );
  if (earlierSteps.length === 0) return false;
  const trackingIds = earlierSteps.map((s) => s.tracking_id);
  return await detectSequenceEngagement(trackingIds);
}

export async function checkAndFireDueSchedules({ send = sendEmailInternal, nowMs = Date.now() } = {}) {
  if (!config.scheduleEnabled) return { ran: false, reason: "disabled" };
  // H-5 TWICE: one tick at a time. An overlapping tick does nothing.
  if (_tickInFlight) {
    log("warn", "Scheduler tick skipped: the previous tick is still dispatching");
    return { ran: false, reason: "tick_in_flight" };
  }
  _tickInFlight = true;
  try {
    return await fireDue({ send, nowMs });
  } finally {
    _tickInFlight = false;
  }
}

async function fireDue({ send, nowMs }) {
  const nowIsoTz = DateTime.fromMillis(nowMs).setZone(TZ).toISO({ suppressMilliseconds: true });
  let changed = false;

  // H-5 NEVER: a hold nobody released within the expiry times out. The send
  // is denied; the record says expired, not cancelled.
  for (const s of store.schedules) {
    if (s.status !== "held_overdue") continue;
    const heldMs = Date.parse(s.held_at || "");
    if (Number.isFinite(heldMs) && nowMs - heldMs >= holdExpiryMs()) {
      s.status = "expired_unconfirmed";
      s.expired_at = nowIsoTz;
      changed = true;
      log("warn", `Schedule ${s.schedule_id} hold expired unconfirmed after ${Math.round((nowMs - heldMs) / 86400000)}d; not sent (a timeout, not a refusal)`);
    }
  }

  const due = store.schedules.filter(
    (s) => s.status === "pending" && Date.parse(s.send_at) <= nowMs
  );
  if (due.length === 0) {
    if (changed) saveStore();
    return { ran: true, sent: 0, held: 0, expired: changed };
  }

  // Process oldest first (preserve drip ordering)
  due.sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));

  let sentCount = 0;
  let heldCount = 0;
  for (const sched of due) {
    // H-5: the due list was taken before the first await, and a person can
    // cancel while an earlier send in this tick is in flight. Re-check, so a
    // cancelled send is never dispatched.
    if (sched.status !== "pending") continue;
    // H-5 LATE: past the grace, the send is held for a person, never sent late.
    const lateMs = nowMs - Date.parse(sched.send_at);
    if (lateMs > lateGraceMs()) {
      sched.status = "held_overdue";
      sched.held_at = nowIsoTz;
      sched.held_reason = `send_at passed ${Math.round(lateMs / 60000)} minutes ago, beyond the ${Math.round(lateGraceMs() / 60000)}-minute late grace. `
        + "Sending this late with nobody present could surprise the recipient; release it with email_schedule_release or cancel it.";
      heldCount += 1;
      log("warn", `Schedule ${sched.schedule_id} HELD: ${sched.held_reason}`);
      if (sched.sequence_id) {
        const seq = store.sequences.find((q) => q.sequence_id === sched.sequence_id);
        const stepRef = seq && seq.steps.find((st) => st.schedule_id === sched.schedule_id);
        if (stepRef) stepRef.status = "held_overdue";
      }
      continue;
    }
    try {
      // Drip engagement gate
      if (await maybeSkipDueToEngagement(sched)) {
        sched.status = "skipped";
        sched.cancelled_at = DateTime.now().setZone(TZ).toISO({ suppressMilliseconds: true });
        log("info", `Schedule ${sched.schedule_id} skipped (engagement detected on earlier sequence step)`);

        appendTrackingEvent({
          tracking_id: sched.schedule_id,
          event_type: "skipped",
          to_address: sched.to_address,
          to_name: sched.to_name,
          subject: sched.subject,
          sender_id: sched.sender_id,
          company: sched.company,
          send_timestamp: sched.send_at,
          schedule_id: sched.schedule_id,
        }).catch(() => {});

        // Update sequence record
        if (sched.sequence_id) {
          const seq = store.sequences.find((q) => q.sequence_id === sched.sequence_id);
          if (seq) {
            const stepRef = seq.steps.find((st) => st.schedule_id === sched.schedule_id);
            if (stepRef) stepRef.status = "skipped";
          }
        }
        continue;
      }

      const result = await send({
        to_address: sched.to_address,
        to_name: sched.to_name,
        subject: sched.subject,
        body_text: sched.body_text,
        sender_id: sched.sender_id,
        format: sched.format,
        company: sched.company,
        schedule_id: sched.schedule_id,
      });

      if (result.status === "sent") {
        sentCount += 1;
        sched.status = "sent";
        sched.sent_at = result.timestamp;
        sched.tracking_id = result.tracking_id;
        log("info", `Schedule ${sched.schedule_id} dispatched (tracking_id=${result.tracking_id})`);
        if (sched.sequence_id) {
          const seq = store.sequences.find((q) => q.sequence_id === sched.sequence_id);
          if (seq) {
            const stepRef = seq.steps.find((st) => st.schedule_id === sched.schedule_id);
            if (stepRef) stepRef.status = "sent";
          }
        }
      } else {
        sched.status = "failed";
        sched.error_code = result.code || "UNKNOWN";
        log("error", `Schedule ${sched.schedule_id} failed: ${result.error}`);
      }
    } catch (err) {
      sched.status = "failed";
      sched.error_code = "EXCEPTION";
      log("error", `Schedule ${sched.schedule_id} threw: ${err.message}`);
    }
  }

  saveStore();
  return { ran: true, sent: sentCount, held: heldCount, expired: changed };
}

// -----------------------------------------------------------------------
// v13.39.0 (H-5): a person releases a held send, or reads the outcomes.
// -----------------------------------------------------------------------

/**
 * Release a held send: it becomes pending, due now, and the next tick sends it.
 *
 * @param {{ schedule_id: string, released_by?: string }} input
 * @returns {object}
 */
export function releaseHeldSchedule({ schedule_id, released_by = "operator" } = {}) {
  const rec = store.schedules.find((s) => s.schedule_id === schedule_id);
  if (!rec) return { error: `Unknown schedule_id "${schedule_id}".`, code: "NOT_FOUND" };
  if (rec.status !== "held_overdue") {
    return {
      error: rec.status === "expired_unconfirmed"
        ? "This hold has expired and the send was denied. Schedule it again with email_schedule if it is still wanted."
        : `Only a held send can be released; this one is "${rec.status}".`,
      code: "INVALID_STATE",
    };
  }
  const now = DateTime.now().setZone(TZ).toISO({ suppressMilliseconds: true });
  rec.status = "pending";
  rec.released_at = now;
  rec.released_by = String(released_by || "operator").slice(0, 60);
  rec.original_send_at = rec.original_send_at || rec.send_at;
  rec.send_at = now;
  if (rec.sequence_id) {
    const seq = store.sequences.find((q) => q.sequence_id === rec.sequence_id);
    const stepRef = seq && seq.steps.find((st) => st.schedule_id === rec.schedule_id);
    if (stepRef) stepRef.status = "pending";
  }
  saveStore();
  return { schedule_id, status: "pending", send_at: now, released_at: now };
}

/**
 * Counts by outcome. `refusals` counts what a person declined; a timed-out
 * hold is reported as expired and never folded into refusals.
 *
 * @returns {{ by_status: Record<string, number>, refusals: number, expired: number }}
 */
export function scheduleOutcomes() {
  const by = {};
  for (const s of store.schedules) by[s.status] = (by[s.status] || 0) + 1;
  return {
    by_status: by,
    refusals: REFUSAL_STATUSES.reduce((n, st) => n + (by[st] || 0), 0),
    expired: by.expired_unconfirmed || 0,
  };
}

/** Test support only: replace the in-memory store. */
export function _setStoreForTests(next) {
  store = { schedules: [], sequences: [], _counter: 0, ...(next || {}) };
  _tickInFlight = false;
}

// -----------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------
let started = false;
/**
 * Persist the in-memory schedule store to disk.
 *
 * v12.28.0 (TNX-H-006): exported so the shutdown handler can flush on the way
 * out. saveStore() is already called on every mutation, so this is insurance
 * rather than the primary persistence path -- but a drain that exits without
 * flushing would lose any state written by an in-flight mutation that had not
 * yet reached its own saveStore() call.
 *
 * @returns {boolean} True when the store was written, false on failure.
 */
export function flushScheduleStore() {
  try {
    saveStore();
    return true;
  } catch {
    return false;
  }
}

export function startScheduler() {
  if (started) return;
  loadStore();
  if (!config.scheduleEnabled) {
    log("info", "Scheduler disabled (SCHEDULE_ENABLED=false). Tools registered but cron loop NOT started.");
    started = true;
    return;
  }
  cron.schedule("*/1 * * * *", () => {
    checkAndFireDueSchedules().catch((err) =>
      log("error", `Scheduler tick failure: ${err.message}`)
    );
  });
  // Fire once at startup to catch up sends due during downtime
  setTimeout(() => {
    checkAndFireDueSchedules().catch((err) =>
      log("error", `Scheduler initial tick failure: ${err.message}`)
    );
  }, 5000).unref?.();
  started = true;
  log("info", `Scheduler started. Pending=${pendingCount()} store=${config.scheduleStorePath}`);
}
