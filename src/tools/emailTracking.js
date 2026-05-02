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

// =======================================================================
// NEW: email_reply_check
// =======================================================================
// Determines whether a tracked send appears to have received a reply.
//
// How replies are detected:
//   The tracking CSV records "sent", "open", and "click" events. Replies
//   are NOT currently captured by pixel / redirect tracking (that would
//   require IMAP polling, which is out of scope for this server). Instead
//   this tool surfaces a structured "engagement summary" per recipient that
//   lets Claude infer reply likelihood from open and click behaviour, and
//   flags senders where a reply is the expected next step.
//
// When IMAP polling is added in a future version, a "reply" event_type
//   will be emitted into the CSV and this tool will surface it directly.

export const emailReplyCheckToolDefinition = {
  name: "email_reply_check",
  description:
    "Check whether a tracked outreach email appears to have had a reply or significant engagement. " +
    "Because reply events require IMAP polling (not yet implemented), this tool instead returns " +
    "a per-recipient engagement summary: open count, click count, last activity timestamp, and " +
    "an engagement signal (none / low / medium / high) that can be used to prioritise follow-up. " +
    "Supply at least one of tracking_id, to_address, or company.",
  inputSchema: {
    type: "object",
    properties: {
      tracking_id: {
        type: "string",
        description: "Tracking ID of the specific send to check.",
      },
      to_address: {
        type: "string",
        description: "Recipient email address to check across all sends.",
      },
      company: {
        type: "string",
        description: "Company name to check across all sends to that company.",
      },
      since_days: {
        type: "integer",
        description: "Lookback window in days. Default 30.",
      },
    },
  },
};

export async function handleEmailReplyCheck(args) {
  args = args || {};
  if (!args.tracking_id && !args.to_address && !args.company) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "Provide at least one of tracking_id, to_address, or company." },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const events = await queryEvents({
    tracking_id: args.tracking_id,
    to_address: args.to_address,
    company: args.company,
    since_days: args.since_days != null ? args.since_days : 30,
    event_type: "all",
  });

  // Group events by tracking_id (one send per group)
  const byTrackingId = new Map();
  for (const ev of events) {
    if (!byTrackingId.has(ev.tracking_id)) {
      byTrackingId.set(ev.tracking_id, {
        tracking_id: ev.tracking_id,
        to_address: ev.to_address || "",
        subject: ev.subject || "",
        sender_id: ev.sender_id || "",
        company: ev.company || "",
        send_timestamp: ev.send_timestamp || ev.event_timestamp || "",
        opens: 0,
        clicks: 0,
        last_activity: "",
        has_reply_event: false,
      });
    }
    const rec = byTrackingId.get(ev.tracking_id);
    if (ev.event_type === "open" && ev.user_agent_type !== "bot") {
      rec.opens += 1;
      if (!rec.last_activity || ev.event_timestamp > rec.last_activity) {
        rec.last_activity = ev.event_timestamp;
      }
    }
    if (ev.event_type === "click" && ev.user_agent_type !== "bot") {
      rec.clicks += 1;
      if (!rec.last_activity || ev.event_timestamp > rec.last_activity) {
        rec.last_activity = ev.event_timestamp;
      }
    }
    // Future: ev.event_type === "reply" will set has_reply_event = true
    if (ev.event_type === "reply") {
      rec.has_reply_event = true;
    }
  }

  const results = Array.from(byTrackingId.values()).map((rec) => {
    let engagement;
    if (rec.has_reply_event) {
      engagement = "replied";
    } else if (rec.clicks >= 2 || (rec.clicks >= 1 && rec.opens >= 3)) {
      engagement = "high";
    } else if (rec.clicks >= 1 || rec.opens >= 2) {
      engagement = "medium";
    } else if (rec.opens >= 1) {
      engagement = "low";
    } else {
      engagement = "none";
    }

    return {
      tracking_id: rec.tracking_id,
      to_address: rec.to_address,
      subject: rec.subject,
      sender_id: rec.sender_id,
      company: rec.company,
      send_timestamp: rec.send_timestamp,
      opens: rec.opens,
      clicks: rec.clicks,
      last_activity: rec.last_activity || null,
      engagement,
      reply_detected: rec.has_reply_event,
      follow_up_recommended: !rec.has_reply_event && (engagement === "medium" || engagement === "high"),
    };
  });

  // Sort: replied first, then high, medium, low, none
  const engagementOrder = { replied: 0, high: 1, medium: 2, low: 3, none: 4 };
  results.sort(
    (a, b) =>
      (engagementOrder[a.engagement] ?? 5) - (engagementOrder[b.engagement] ?? 5)
  );

  const out = {
    query: {
      tracking_id: args.tracking_id || null,
      to_address: args.to_address || null,
      company: args.company || null,
      since_days: args.since_days != null ? args.since_days : 30,
    },
    total_sends_checked: results.length,
    replied_count: results.filter((r) => r.reply_detected).length,
    high_engagement_count: results.filter((r) => r.engagement === "high").length,
    follow_up_recommended_count: results.filter((r) => r.follow_up_recommended).length,
    results,
    note:
      "Reply detection requires IMAP polling (not yet configured). " +
      "Engagement level is inferred from open and click tracking. " +
      "reply_detected will be true once IMAP polling is enabled and a reply event is recorded.",
    caveats: [
      "Open rates are understated for Outlook/M365 (images blocked by default).",
      "Apple Mail Privacy Protection may inflate open counts.",
    ],
  };

  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}
