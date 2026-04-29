// src/tools/emailTracking.js
//
// MCP tool definitions and handlers for SCOPE-04 query surface:
//   email_get_tracking       -- filtered events for a tracking_id, recipient, or company
//   email_tracking_summary   -- aggregate stats over a lookback window

import { queryEvents } from "../utils/tracking.js";

const CAVEATS = [
  "Open rates are understated for Outlook/M365 recipients (images blocked by default).",
  "Apple Mail Privacy Protection may inflate open counts (proxied opens classified as bot).",
  "Zero opens does not confirm an email was unread.",
];

function isRealOpenOrClick(row) {
  return (row.event_type === "open" || row.event_type === "click") && row.user_agent_type !== "bot";
}

function summariseEvents(events) {
  const sentRows = events.filter((e) => e.event_type === "sent");
  const opens = events.filter((e) => e.event_type === "open" && e.user_agent_type !== "bot");
  const clicks = events.filter((e) => e.event_type === "click" && e.user_agent_type !== "bot");

  const total_sent = sentRows.length;
  const total_opens = opens.length;
  const total_clicks = clicks.length;
  const unique_openers = new Set(opens.map((e) => e.tracking_id)).size;
  const unique_clickers = new Set(clicks.map((e) => e.tracking_id)).size;

  const open_rate_pct = total_sent ? Math.round((unique_openers / total_sent) * 100) : 0;
  const click_rate_pct = total_sent ? Math.round((unique_clickers / total_sent) * 100) : 0;

  // Top engaged companies
  const byCompany = {};
  for (const e of events) {
    if (!e.company) continue;
    if (!byCompany[e.company]) byCompany[e.company] = { company: e.company, opens: 0, clicks: 0 };
    if (e.event_type === "open" && e.user_agent_type !== "bot") byCompany[e.company].opens += 1;
    if (e.event_type === "click" && e.user_agent_type !== "bot") byCompany[e.company].clicks += 1;
  }
  const top_engaged_companies = Object.values(byCompany)
    .sort((a, b) => b.opens + b.clicks - (a.opens + a.clicks))
    .slice(0, 5);

  // Unengaged sends (sent but no real open or click)
  const engagedTrackingIds = new Set(
    events.filter(isRealOpenOrClick).map((e) => e.tracking_id)
  );
  const unengaged_sends = sentRows
    .filter((e) => !engagedTrackingIds.has(e.tracking_id))
    .map((e) => ({
      to_address: e.to_address,
      subject: e.subject,
      send_timestamp: e.send_timestamp || e.event_timestamp,
      sender_id: e.sender_id,
      company: e.company,
    }));

  return {
    total_sent,
    total_opens,
    unique_openers,
    total_clicks,
    open_rate_pct,
    click_rate_pct,
    top_engaged_companies,
    unengaged_sends,
  };
}

// -----------------------------------------------------------------------
// Tool: email_get_tracking
// -----------------------------------------------------------------------
export const emailGetTrackingToolDefinition = {
  name: "email_get_tracking",
  description:
    "Return tracking events from the TrueSource_Email_Tracking.csv on Google Drive. " +
    "At least one of tracking_id, to_address, or company must be supplied so results are scoped.",
  inputSchema: {
    type: "object",
    properties: {
      tracking_id: { type: "string", description: "Filter to a specific send" },
      to_address:  { type: "string", description: "Filter to a specific recipient" },
      company:     { type: "string", description: "Filter to a named company (CLIENT_NAME)" },
      since_days:  { type: "integer", description: "Lookback window in days. Default 30." },
      event_type:  { type: "string", enum: ["sent", "open", "click", "skipped", "all"], description: "Default all." },
    },
  },
};

export async function handleEmailGetTracking(args) {
  args = args || {};
  if (!args.tracking_id && !args.to_address && !args.company) {
    const out = {
      error: "Provide at least one of tracking_id, to_address, or company.",
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  }

  const events = await queryEvents({
    tracking_id: args.tracking_id,
    to_address: args.to_address,
    company: args.company,
    since_days: args.since_days != null ? args.since_days : 30,
    event_type: args.event_type || "all",
  });

  const summary = summariseEvents(events);

  const slim = events
    .sort((a, b) => (a.event_timestamp < b.event_timestamp ? 1 : -1))
    .slice(0, 200)
    .map((e) => ({
      event_id: e.event_id,
      tracking_id: e.tracking_id,
      event_type: e.event_type,
      event_timestamp: e.event_timestamp,
      to_address: e.to_address,
      subject: e.subject,
      sender_id: e.sender_id,
      company: e.company,
      click_url: e.click_url || null,
      user_agent_type: e.user_agent_type || null,
      schedule_id: e.schedule_id || null,
    }));

  const out = {
    query: {
      tracking_id: args.tracking_id || null,
      to_address: args.to_address || null,
      company: args.company || null,
      since_days: args.since_days != null ? args.since_days : 30,
      event_type: args.event_type || "all",
    },
    summary: {
      total_sent: summary.total_sent,
      total_opens: summary.total_opens,
      unique_openers: summary.unique_openers,
      total_clicks: summary.total_clicks,
      open_rate_pct: summary.open_rate_pct,
      click_rate_pct: summary.click_rate_pct,
    },
    events: slim,
    truncated: events.length > slim.length,
    caveats: CAVEATS,
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// -----------------------------------------------------------------------
// Tool: email_tracking_summary
// -----------------------------------------------------------------------
export const emailTrackingSummaryToolDefinition = {
  name: "email_tracking_summary",
  description:
    "Aggregate tracking stats across all sends in a lookback window. Bot/scanner opens " +
    "are excluded from rate calculations but remain in the raw CSV.",
  inputSchema: {
    type: "object",
    properties: {
      since_days: { type: "integer", description: "Lookback window in days. Default 30." },
      sender_id:  { type: "string", enum: ["brian", "michael", "robbie"], description: "Filter to a specific sender." },
    },
  },
};

export async function handleEmailTrackingSummary(args) {
  args = args || {};
  const since_days = args.since_days != null ? args.since_days : 30;
  const events = await queryEvents({
    sender_id: args.sender_id,
    since_days,
    event_type: "all",
  });
  const summary = summariseEvents(events);

  const out = {
    period_days: since_days,
    sender_id: args.sender_id || "all",
    total_sent: summary.total_sent,
    total_opens: summary.total_opens,
    unique_openers: summary.unique_openers,
    total_clicks: summary.total_clicks,
    open_rate_pct: summary.open_rate_pct,
    click_rate_pct: summary.click_rate_pct,
    top_engaged_companies: summary.top_engaged_companies,
    unengaged_sends: summary.unengaged_sends.slice(0, 25),
    caveats: CAVEATS,
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}
