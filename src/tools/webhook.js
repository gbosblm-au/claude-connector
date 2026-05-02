// src/tools/webhook.js
//
// Inbound webhook receiver for claude-connector v8.0.0
//
// ARCHITECTURE:
//   The HTTP server (server-http.js) exposes a POST /webhook endpoint.
//   Any external service can POST JSON (or form-encoded) data to that URL.
//   Incoming payloads are stored in a bounded in-memory queue (capped at
//   WEBHOOK_QUEUE_SIZE, default 200) and optionally written to a JSON file
//   for persistence across restarts.
//
//   Claude polls the queue with the webhook_poll_events tool.
//   Claude can also clear consumed events with webhook_clear_events.
//
// TOOLS PROVIDED:
//   webhook_poll_events   -- Return pending events from the inbound queue
//   webhook_clear_events  -- Acknowledge and remove events by event_id
//   webhook_queue_status  -- Summary of current queue depth and oldest/newest event
//
// SECURITY:
//   Set WEBHOOK_SECRET in Railway Variables. When set, the server validates
//   an X-Webhook-Secret header on every inbound request. Requests without
//   a matching secret return 401. Leave blank to disable auth (not recommended
//   for public deployments).
//
// ENDPOINT (registered in server-http.js):
//   POST /webhook
//   Content-Type: application/json  (or application/x-www-form-urlencoded)
//   X-Webhook-Secret: <WEBHOOK_SECRET>  (when configured)
//
// EXTERNAL REGISTRATION:
//   Configure the calling service (form tool, CRM, CI system, etc.) to POST
//   to https://<your-railway-domain>/webhook with the secret header.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// In-memory event queue
// ---------------------------------------------------------------------------

const MAX_QUEUE_SIZE = Math.max(10, parseInt(process.env.WEBHOOK_QUEUE_SIZE || "200", 10));
const eventQueue = []; // Array<WebhookEvent>

/** @typedef {{ event_id: string, received_at: string, source_ip: string, headers: object, payload: unknown }} WebhookEvent */

// ---------------------------------------------------------------------------
// Persistence (optional)
// ---------------------------------------------------------------------------

function persistencePath() {
  return (process.env.WEBHOOK_PERSIST_PATH || "").trim();
}

function loadPersistedEvents() {
  const path = persistencePath();
  if (!path || !existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      eventQueue.push(...parsed.slice(-MAX_QUEUE_SIZE));
      log("info", `webhook: loaded ${eventQueue.length} persisted events from ${path}`);
    }
  } catch (err) {
    log("warn", `webhook: failed to load persisted events: ${err.message}`);
  }
}

function persistEvents() {
  const path = persistencePath();
  if (!path) return;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(eventQueue, null, 2), "utf-8");
  } catch (err) {
    log("warn", `webhook: failed to persist events: ${err.message}`);
  }
}

// Load on module import (server startup)
loadPersistedEvents();

// ---------------------------------------------------------------------------
// Core enqueue function (called by the HTTP handler in server-http.js)
// ---------------------------------------------------------------------------

export function enqueueWebhookEvent(payload, sourceIp = "", rawHeaders = {}) {
  // Strip auth headers before storing
  const safeHeaders = { ...rawHeaders };
  delete safeHeaders["x-webhook-secret"];
  delete safeHeaders["authorization"];
  delete safeHeaders["cookie"];

  const event = {
    event_id: randomUUID(),
    received_at: new Date().toISOString(),
    source_ip: sourceIp,
    headers: safeHeaders,
    payload,
  };

  eventQueue.push(event);

  // Trim oldest events when queue is full
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    const removed = eventQueue.splice(0, eventQueue.length - MAX_QUEUE_SIZE);
    log("warn", `webhook: queue overflow - dropped ${removed.length} oldest event(s)`);
  }

  persistEvents();
  log("info", `webhook: enqueued event ${event.event_id} (queue depth: ${eventQueue.length})`);
  return event.event_id;
}

// ---------------------------------------------------------------------------
// Webhook secret validation (called by HTTP handler)
// ---------------------------------------------------------------------------

export function validateWebhookSecret(reqHeaders = {}) {
  const secret = (process.env.WEBHOOK_SECRET || "").trim();
  if (!secret) return true; // Auth disabled
  const provided = String(reqHeaders["x-webhook-secret"] || "").trim();
  return provided === secret;
}

// ---------------------------------------------------------------------------
// Tool: webhook_poll_events
// ---------------------------------------------------------------------------

export const webhookPollEventsToolDefinition = {
  name: "webhook_poll_events",
  description:
    "Return pending inbound webhook events from the server queue. " +
    "Events are posted by external services to the POST /webhook endpoint. " +
    "Returns events in arrival order. Use webhook_clear_events to acknowledge " +
    "and remove processed events from the queue.",
  inputSchema: {
    type: "object",
    properties: {
      max_events: {
        type: "number",
        description: "Maximum number of events to return (1-50, default 20).",
      },
      since_event_id: {
        type: "string",
        description:
          "If provided, return only events that arrived after this event_id " +
          "(exclusive). Useful for incremental polling without re-processing.",
      },
      source_filter: {
        type: "string",
        description:
          "Optional substring filter applied to source_ip or payload JSON. " +
          "Returns only events whose source IP or JSON payload contains this string.",
      },
    },
    required: [],
  },
};

export async function handleWebhookPollEvents(args) {
  const maxEvents = Math.min(Math.max(Number(args?.max_events) || 20, 1), 50);
  const sinceEventId = (args?.since_event_id || "").trim();
  const sourceFilter = (args?.source_filter || "").trim().toLowerCase();

  let filtered = [...eventQueue];

  // Apply since_event_id cursor
  if (sinceEventId) {
    const idx = filtered.findIndex((e) => e.event_id === sinceEventId);
    if (idx !== -1) {
      filtered = filtered.slice(idx + 1);
    }
  }

  // Apply source filter
  if (sourceFilter) {
    filtered = filtered.filter((ev) => {
      if (ev.source_ip && ev.source_ip.toLowerCase().includes(sourceFilter)) return true;
      try {
        const payloadStr = JSON.stringify(ev.payload).toLowerCase();
        return payloadStr.includes(sourceFilter);
      } catch {
        return false;
      }
    });
  }

  const page = filtered.slice(0, maxEvents);

  const out = {
    queue_depth: eventQueue.length,
    events_returned: page.length,
    has_more: filtered.length > maxEvents,
    events: page,
  };

  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Tool: webhook_clear_events
// ---------------------------------------------------------------------------

export const webhookClearEventsToolDefinition = {
  name: "webhook_clear_events",
  description:
    "Acknowledge and remove processed events from the webhook queue by event_id. " +
    "Pass an array of event_ids to remove specific events, or set clear_all=true " +
    "to drain the entire queue.",
  inputSchema: {
    type: "object",
    properties: {
      event_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of event_id values to remove from the queue.",
      },
      clear_all: {
        type: "boolean",
        description: "If true, remove all events from the queue. Overrides event_ids.",
      },
    },
    required: [],
  },
};

export async function handleWebhookClearEvents(args) {
  if (args?.clear_all === true) {
    const count = eventQueue.length;
    eventQueue.splice(0, eventQueue.length);
    persistEvents();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { cleared: count, remaining: 0, action: "clear_all" },
            null,
            2
          ),
        },
      ],
    };
  }

  const ids = Array.isArray(args?.event_ids) ? new Set(args.event_ids) : new Set();
  if (ids.size === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              cleared: 0,
              remaining: eventQueue.length,
              note: "No event_ids provided and clear_all is not true. Nothing removed.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  let cleared = 0;
  for (let i = eventQueue.length - 1; i >= 0; i--) {
    if (ids.has(eventQueue[i].event_id)) {
      eventQueue.splice(i, 1);
      cleared++;
    }
  }

  persistEvents();

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            cleared,
            not_found: ids.size - cleared,
            remaining: eventQueue.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: webhook_queue_status
// ---------------------------------------------------------------------------

export const webhookQueueStatusToolDefinition = {
  name: "webhook_queue_status",
  description:
    "Return a summary of the current inbound webhook queue: depth, oldest event, " +
    "newest event, and server configuration. Use this to check whether new events " +
    "have arrived without retrieving all event payloads.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export async function handleWebhookQueueStatus() {
  const secretConfigured = Boolean((process.env.WEBHOOK_SECRET || "").trim());
  const persistPath = persistencePath();

  const oldest = eventQueue.length > 0 ? eventQueue[0] : null;
  const newest = eventQueue.length > 0 ? eventQueue[eventQueue.length - 1] : null;

  const out = {
    queue_depth: eventQueue.length,
    max_queue_size: MAX_QUEUE_SIZE,
    oldest_event_id: oldest?.event_id || null,
    oldest_received_at: oldest?.received_at || null,
    newest_event_id: newest?.event_id || null,
    newest_received_at: newest?.received_at || null,
    config: {
      secret_configured: secretConfigured,
      persistence_enabled: Boolean(persistPath),
      persistence_path: persistPath || null,
      endpoint: "POST /webhook",
      header: secretConfigured ? "X-Webhook-Secret: <WEBHOOK_SECRET>" : "No auth required",
    },
  };

  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}
