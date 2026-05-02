// src/tools/googleCalendar.js
//
// Google Calendar integration for claude-connector v8.0.0
//
// TOOLS PROVIDED:
//   calendar_list_events   -- List events from a calendar within a time window
//   calendar_create_event  -- Create a new calendar event
//   calendar_update_event  -- Update an existing event by event ID
//   calendar_delete_event  -- Delete an event by event ID
//
// AUTHENTICATION:
//   Reuses the Google OAuth2 / Service Account infrastructure from googleDrive.js.
//   Additional scope required: https://www.googleapis.com/auth/calendar
//   Add this to GOOGLE_DRIVE_SCOPES (space-separated) in Railway Variables:
//     GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar
//
// DEFAULT CALENDAR:
//   Set GOOGLE_CALENDAR_ID in env to override "primary".
//   "primary" resolves to the calendar of the authenticated principal.

import { config } from "../config.js";
import { log } from "../utils/logger.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Auth helper - reuse token infrastructure from googleDrive.js
// ---------------------------------------------------------------------------

async function getCalendarToken() {
  // Lazily import the Drive module to reuse its JWT/OAuth2 token helpers
  // without duplicating auth logic. The Drive module exports getAccessToken
  // via its internal helpers; we call the same underlying functions via a
  // re-export shim added to googleDrive.js.
  const drive = await import("./googleDrive.js");
  // getAccessToken is the backward-compat helper that returns a plain string.
  return drive.getAccessToken();
}

async function calFetch(token, url, init = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(
      `Google Calendar API ${init.method || "GET"} ${url} failed (${resp.status}): ${body}`
    );
    err.status = resp.status;
    throw err;
  }
  return resp;
}

function defaultCalendarId() {
  return (config.googleCalendarId || "primary").trim() || "primary";
}

function formatEventLine(ev, index) {
  const start = ev.start?.dateTime || ev.start?.date || "";
  const end = ev.end?.dateTime || ev.end?.date || "";
  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees.map((a) => `${a.displayName || a.email} <${a.email}>`).join(", ")
    : "";

  const parts = [`[${index}] ${ev.summary || "(no title)"}`];
  parts.push(`  ID:        ${ev.id}`);
  parts.push(`  Start:     ${start}`);
  parts.push(`  End:       ${end}`);
  if (ev.location) parts.push(`  Location:  ${ev.location}`);
  if (ev.status) parts.push(`  Status:    ${ev.status}`);
  if (attendees) parts.push(`  Attendees: ${attendees}`);
  if (ev.description) parts.push(`  Desc:      ${ev.description.slice(0, 200)}`);
  if (ev.htmlLink) parts.push(`  Link:      ${ev.htmlLink}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tool: calendar_list_events
// ---------------------------------------------------------------------------

export const calendarListEventsToolDefinition = {
  name: "calendar_list_events",
  description:
    "List events from a Google Calendar within a specified time window. " +
    "Returns event IDs, titles, start/end times, locations, attendees, and links. " +
    "Defaults to the primary calendar and the next 7 days. " +
    "Requires the Google Calendar scope in GOOGLE_DRIVE_SCOPES.",
  inputSchema: {
    type: "object",
    properties: {
      calendar_id: {
        type: "string",
        description:
          "Calendar ID to query. Defaults to 'primary' (or GOOGLE_CALENDAR_ID env var). " +
          "Find a calendar ID in Google Calendar settings under 'Calendar address'.",
      },
      time_min: {
        type: "string",
        description:
          "RFC 3339 timestamp for the start of the query window (e.g. '2025-06-01T00:00:00Z'). " +
          "Defaults to now.",
      },
      time_max: {
        type: "string",
        description:
          "RFC 3339 timestamp for the end of the query window (e.g. '2025-06-08T23:59:59Z'). " +
          "Defaults to 7 days from now.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of events to return (1-250, default 25).",
      },
      query: {
        type: "string",
        description: "Free-text search within event titles and descriptions.",
      },
      single_events: {
        type: "boolean",
        description:
          "If true (default), expand recurring events into individual instances.",
      },
      order_by: {
        type: "string",
        enum: ["startTime", "updated"],
        description: "Sort order. 'startTime' (default) or 'updated'.",
      },
      show_deleted: {
        type: "boolean",
        description: "If true, include deleted/cancelled events. Default false.",
      },
    },
    required: [],
  },
};

export async function handleCalendarListEvents(args) {
  const calId = encodeURIComponent(args?.calendar_id || defaultCalendarId());
  const now = new Date();
  const defaultMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const timeMin = args?.time_min || now.toISOString();
  const timeMax = args?.time_max || defaultMax.toISOString();
  const maxResults = Math.min(Math.max(Number(args?.max_results) || 25, 1), 250);
  const singleEvents = args?.single_events !== false;
  const orderBy = singleEvents ? (args?.order_by || "startTime") : "updated";
  const showDeleted = args?.show_deleted === true;

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: String(singleEvents),
    orderBy,
    showDeleted: String(showDeleted),
  });
  if (args?.query) params.set("q", args.query);

  const token = await getCalendarToken();
  const resp = await calFetch(
    token,
    `${CALENDAR_API}/calendars/${calId}/events?${params.toString()}`
  );
  const data = await resp.json();
  const items = data.items || [];

  if (!items.length) {
    return {
      content: [
        {
          type: "text",
          text: `No events found between ${timeMin} and ${timeMax} in calendar ${decodeURIComponent(calId)}.`,
        },
      ],
    };
  }

  const header = `Google Calendar Events (${items.length}) | ${decodeURIComponent(calId)} | ${timeMin.slice(0, 10)} to ${timeMax.slice(0, 10)}`;
  const body = items.map((ev, i) => formatEventLine(ev, i + 1)).join("\n\n");
  const footer = data.nextPageToken ? `\n\nNext page token: ${data.nextPageToken}` : "";

  return { content: [{ type: "text", text: `${header}\n\n${body}${footer}` }] };
}

// ---------------------------------------------------------------------------
// Tool: calendar_create_event
// ---------------------------------------------------------------------------

export const calendarCreateEventToolDefinition = {
  name: "calendar_create_event",
  description:
    "Create a new event on a Google Calendar. " +
    "Supports all-day events (date only) and timed events (dateTime with timezone). " +
    "Returns the created event ID and link.",
  inputSchema: {
    type: "object",
    properties: {
      calendar_id: {
        type: "string",
        description: "Calendar ID. Defaults to primary.",
      },
      summary: {
        type: "string",
        description: "Event title.",
      },
      description: {
        type: "string",
        description: "Event description / notes.",
      },
      location: {
        type: "string",
        description: "Event location (address or meeting URL).",
      },
      start_datetime: {
        type: "string",
        description:
          "Event start as RFC 3339 (e.g. '2025-06-10T09:00:00+10:00') for timed events, " +
          "or a date string 'YYYY-MM-DD' for all-day events.",
      },
      end_datetime: {
        type: "string",
        description:
          "Event end as RFC 3339 or 'YYYY-MM-DD'. Must match format of start_datetime.",
      },
      timezone: {
        type: "string",
        description:
          "IANA timezone for timed events (e.g. 'Australia/Melbourne'). " +
          "Required when start_datetime is a dateTime without offset.",
      },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "List of attendee email addresses.",
      },
      send_updates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: "Whether to send invites to attendees. Default 'none'.",
      },
    },
    required: ["summary", "start_datetime", "end_datetime"],
  },
};

export async function handleCalendarCreateEvent(args) {
  if (!args?.summary) throw new Error("'summary' is required.");
  if (!args?.start_datetime) throw new Error("'start_datetime' is required.");
  if (!args?.end_datetime) throw new Error("'end_datetime' is required.");

  const calId = encodeURIComponent(args?.calendar_id || defaultCalendarId());
  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start_datetime);

  const eventBody = {
    summary: args.summary,
    start: isAllDay ? { date: args.start_datetime } : { dateTime: args.start_datetime, timeZone: args.timezone || "UTC" },
    end: isAllDay ? { date: args.end_datetime } : { dateTime: args.end_datetime, timeZone: args.timezone || "UTC" },
  };

  if (args.description) eventBody.description = args.description;
  if (args.location) eventBody.location = args.location;
  if (Array.isArray(args.attendees) && args.attendees.length > 0) {
    eventBody.attendees = args.attendees.map((email) => ({ email }));
  }

  const sendUpdates = args?.send_updates || "none";
  const params = new URLSearchParams({ sendUpdates });

  const token = await getCalendarToken();
  const resp = await calFetch(
    token,
    `${CALENDAR_API}/calendars/${calId}/events?${params.toString()}`,
    {
      method: "POST",
      body: JSON.stringify(eventBody),
    }
  );
  const ev = await resp.json();

  const lines = [
    "Google Calendar Event Created",
    "==============================",
    `Event ID:   ${ev.id}`,
    `Title:      ${ev.summary}`,
    `Start:      ${ev.start?.dateTime || ev.start?.date}`,
    `End:        ${ev.end?.dateTime || ev.end?.date}`,
    ev.location ? `Location:   ${ev.location}` : null,
    `Status:     ${ev.status}`,
    `Link:       ${ev.htmlLink}`,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tool: calendar_update_event
// ---------------------------------------------------------------------------

export const calendarUpdateEventToolDefinition = {
  name: "calendar_update_event",
  description:
    "Update fields on an existing Google Calendar event by event ID. " +
    "Only supplied fields are modified (PATCH semantics). " +
    "Retrieve the event ID with calendar_list_events first.",
  inputSchema: {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        description: "Google Calendar event ID to update.",
      },
      calendar_id: {
        type: "string",
        description: "Calendar ID. Defaults to primary.",
      },
      summary: { type: "string", description: "New event title." },
      description: { type: "string", description: "New description." },
      location: { type: "string", description: "New location." },
      start_datetime: {
        type: "string",
        description: "New start as RFC 3339 dateTime or YYYY-MM-DD.",
      },
      end_datetime: {
        type: "string",
        description: "New end as RFC 3339 dateTime or YYYY-MM-DD.",
      },
      timezone: {
        type: "string",
        description: "IANA timezone for timed events.",
      },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Replacement attendee list (full replacement, not append).",
      },
      send_updates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: "Whether to send update notifications. Default 'none'.",
      },
    },
    required: ["event_id"],
  },
};

export async function handleCalendarUpdateEvent(args) {
  const eventId = (args?.event_id || "").trim();
  if (!eventId) throw new Error("'event_id' is required.");

  const calId = encodeURIComponent(args?.calendar_id || defaultCalendarId());
  const patch = {};

  if (args.summary !== undefined) patch.summary = args.summary;
  if (args.description !== undefined) patch.description = args.description;
  if (args.location !== undefined) patch.location = args.location;

  if (args.start_datetime !== undefined) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start_datetime);
    patch.start = isAllDay
      ? { date: args.start_datetime }
      : { dateTime: args.start_datetime, timeZone: args.timezone || "UTC" };
  }
  if (args.end_datetime !== undefined) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.end_datetime);
    patch.end = isAllDay
      ? { date: args.end_datetime }
      : { dateTime: args.end_datetime, timeZone: args.timezone || "UTC" };
  }
  if (Array.isArray(args.attendees)) {
    patch.attendees = args.attendees.map((email) => ({ email }));
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("At least one field to update must be provided.");
  }

  const sendUpdates = args?.send_updates || "none";
  const params = new URLSearchParams({ sendUpdates });
  const token = await getCalendarToken();

  const resp = await calFetch(
    token,
    `${CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(eventId)}?${params.toString()}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  const ev = await resp.json();

  const lines = [
    "Google Calendar Event Updated",
    "==============================",
    `Event ID:   ${ev.id}`,
    `Title:      ${ev.summary}`,
    `Start:      ${ev.start?.dateTime || ev.start?.date}`,
    `End:        ${ev.end?.dateTime || ev.end?.date}`,
    ev.location ? `Location:   ${ev.location}` : null,
    `Status:     ${ev.status}`,
    `Link:       ${ev.htmlLink}`,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tool: calendar_delete_event
// ---------------------------------------------------------------------------

export const calendarDeleteEventToolDefinition = {
  name: "calendar_delete_event",
  description:
    "Delete (cancel) an event from a Google Calendar by event ID. " +
    "This action is irreversible. Retrieve the event ID with calendar_list_events first.",
  inputSchema: {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        description: "Google Calendar event ID to delete.",
      },
      calendar_id: {
        type: "string",
        description: "Calendar ID. Defaults to primary.",
      },
      send_updates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: "Whether to notify attendees of cancellation. Default 'none'.",
      },
    },
    required: ["event_id"],
  },
};

export async function handleCalendarDeleteEvent(args) {
  const eventId = (args?.event_id || "").trim();
  if (!eventId) throw new Error("'event_id' is required.");

  const calId = encodeURIComponent(args?.calendar_id || defaultCalendarId());
  const sendUpdates = args?.send_updates || "none";
  const params = new URLSearchParams({ sendUpdates });

  const token = await getCalendarToken();
  const url = `${CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(eventId)}?${params.toString()}`;

  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 204 || resp.ok) {
    return {
      content: [
        {
          type: "text",
          text: `Event ${eventId} deleted successfully from calendar ${decodeURIComponent(calId)}.`,
        },
      ],
    };
  }

  const body = await resp.text().catch(() => "");
  throw new Error(`Calendar delete failed (${resp.status}): ${body}`);
}
