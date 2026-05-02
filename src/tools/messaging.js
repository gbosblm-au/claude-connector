// src/tools/messaging.js
//
// Slack and Microsoft Teams message dispatch for claude-connector v8.0.0
//
// TOOLS PROVIDED:
//   slack_send_message    -- Send a message to a Slack channel or user
//   teams_send_message    -- Send an Adaptive Card or plain message to a Teams channel
//
// SLACK SETUP:
//   1. Create a Slack App at https://api.slack.com/apps
//   2. Add the Bot Token Scopes: chat:write, chat:write.public
//   3. Install the app to your workspace
//   4. Copy the Bot OAuth Token (starts with xoxb-)
//   5. Set SLACK_BOT_TOKEN in Railway Variables
//   6. Optionally set SLACK_DEFAULT_CHANNEL (e.g. #general or C01234ABC)
//
// TEAMS SETUP:
//   Teams messages are sent via an Incoming Webhook connector URL.
//   1. In Teams, open a channel > ... > Connectors > Incoming Webhook > Configure
//   2. Give it a name (e.g. "Claude Connector") and copy the Webhook URL
//   3. Set TEAMS_WEBHOOK_URL in Railway Variables
//   (For multiple channels, pass the webhook_url parameter per call.)

import { config } from "../config.js";
import { log } from "../utils/logger.js";
import { truncate } from "../utils/helpers.js";

const SLACK_API = "https://slack.com/api";

// ---------------------------------------------------------------------------
// Tool: slack_send_message
// ---------------------------------------------------------------------------

export const slackSendMessageToolDefinition = {
  name: "slack_send_message",
  description:
    "Send a message to a Slack channel or direct message thread. " +
    "Supports plain text and Slack's mrkdwn formatting. " +
    "Requires SLACK_BOT_TOKEN in Railway Variables. " +
    "Returns the message timestamp for use as a thread parent.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description:
          "Slack channel name (e.g. '#general', '#leads') or channel ID (e.g. 'C01234ABC') " +
          "or user ID for a DM (e.g. 'U0123ABC'). " +
          "Defaults to SLACK_DEFAULT_CHANNEL env var.",
      },
      text: {
        type: "string",
        description:
          "Message text. Supports Slack mrkdwn: *bold*, _italic_, `code`, " +
          "```code block```, <URL|link text>, @mentions.",
      },
      thread_ts: {
        type: "string",
        description:
          "Timestamp of a parent message to reply in a thread (e.g. '1234567890.123456'). " +
          "Omit to post as a new message.",
      },
      username: {
        type: "string",
        description:
          "Override the bot's display name for this message. " +
          "Only works when the Slack app has chat:write.customize scope.",
      },
      icon_emoji: {
        type: "string",
        description:
          "Override the bot's icon with an emoji (e.g. ':robot_face:'). " +
          "Only works with chat:write.customize scope.",
      },
      unfurl_links: {
        type: "boolean",
        description: "Whether to unfurl URL previews. Default false.",
      },
    },
    required: ["text"],
  },
};

export async function handleSlackSendMessage(args) {
  const token = (process.env.SLACK_BOT_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "SLACK_BOT_TOKEN is not set. " +
        "Create a Slack App at https://api.slack.com/apps, add Bot Token Scopes " +
        "(chat:write, chat:write.public), install it to your workspace, and set " +
        "SLACK_BOT_TOKEN=xoxb-... in Railway Variables."
    );
  }

  const channel = (
    args?.channel ||
    process.env.SLACK_DEFAULT_CHANNEL ||
    ""
  ).trim();
  if (!channel) {
    throw new Error(
      "'channel' is required or set SLACK_DEFAULT_CHANNEL in Railway Variables."
    );
  }

  const text = (args?.text || "").trim();
  if (!text) throw new Error("'text' is required.");

  const body = {
    channel,
    text,
    unfurl_links: args?.unfurl_links === true,
    unfurl_media: args?.unfurl_links === true,
  };

  if (args?.thread_ts) body.thread_ts = String(args.thread_ts);
  if (args?.username) body.username = String(args.username);
  if (args?.icon_emoji) body.icon_emoji = String(args.icon_emoji);

  log("info", `slack_send_message: channel=${channel}, chars=${text.length}`);

  const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Slack API HTTP error ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();

  if (!data.ok) {
    throw new Error(
      `Slack API error: ${data.error || "unknown"}${data.warning ? ` (warning: ${data.warning})` : ""}`
    );
  }

  const lines = [
    "Slack Message Sent",
    "==================",
    `Channel:   ${data.channel}`,
    `Timestamp: ${data.ts}`,
    `Text:      ${truncate(text, 120)}`,
    data.message?.thread_ts !== data.ts
      ? `Thread ts: ${data.message?.thread_ts}`
      : null,
  ].filter(Boolean);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

// ---------------------------------------------------------------------------
// Tool: teams_send_message
// ---------------------------------------------------------------------------

export const teamsSendMessageToolDefinition = {
  name: "teams_send_message",
  description:
    "Send a message to a Microsoft Teams channel via an Incoming Webhook. " +
    "Supports plain text or a simple Adaptive Card with title, text body, and optional action buttons. " +
    "Requires TEAMS_WEBHOOK_URL in Railway Variables or the webhook_url parameter.",
  inputSchema: {
    type: "object",
    properties: {
      webhook_url: {
        type: "string",
        description:
          "Teams Incoming Webhook URL for this channel. " +
          "Defaults to TEAMS_WEBHOOK_URL env var.",
      },
      title: {
        type: "string",
        description: "Card title (shown in bold at the top of the message).",
      },
      text: {
        type: "string",
        description:
          "Message body text. Supports basic Markdown: **bold**, _italic_, " +
          "[link text](URL), bullet lists with '-'.",
      },
      color: {
        type: "string",
        description:
          "Accent colour for the card left border as a hex string (e.g. '#123F4B'). " +
          "Default is TrueSource teal '#123F4B'.",
      },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
          required: ["name", "value"],
        },
        description:
          "Optional key-value fact rows shown in the card body (e.g. [{name:'Status', value:'Complete'}]).",
      },
      action_url: {
        type: "string",
        description: "Optional URL for an 'Open' action button at the bottom of the card.",
      },
      action_label: {
        type: "string",
        description: "Label for the action button. Default 'Open'.",
      },
    },
    required: ["text"],
  },
};

export async function handleTeamsSendMessage(args) {
  const webhookUrl = (
    args?.webhook_url ||
    process.env.TEAMS_WEBHOOK_URL ||
    ""
  ).trim();
  if (!webhookUrl) {
    throw new Error(
      "TEAMS_WEBHOOK_URL is not set. " +
        "In Teams, open a channel > ... > Connectors > Incoming Webhook > Configure. " +
        "Copy the webhook URL and set TEAMS_WEBHOOK_URL in Railway Variables."
    );
  }

  if (!webhookUrl.startsWith("https://")) {
    throw new Error("webhook_url must be an HTTPS URL.");
  }

  const text = (args?.text || "").trim();
  if (!text) throw new Error("'text' is required.");

  const title = (args?.title || "").trim();
  const color = (args?.color || "#123F4B").replace("#", "");
  const facts = Array.isArray(args?.facts) ? args.facts : [];
  const actionUrl = (args?.action_url || "").trim();
  const actionLabel = (args?.action_label || "Open").trim();

  // Build an Adaptive Card (Office 365 Connector Card format, broadly supported)
  const card = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: color,
    summary: title || text.slice(0, 80),
    sections: [
      {
        activityTitle: title || undefined,
        activityText: text,
        facts: facts.length > 0 ? facts.map((f) => ({ name: f.name, value: f.value })) : undefined,
        markdown: true,
      },
    ],
  };

  if (actionUrl) {
    card.potentialAction = [
      {
        "@type": "OpenUri",
        name: actionLabel,
        targets: [{ os: "default", uri: actionUrl }],
      },
    ];
  }

  log("info", `teams_send_message: posting to webhook (chars=${text.length})`);

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Teams webhook HTTP error ${resp.status}: ${errBody}`);
  }

  const responseText = await resp.text().catch(() => "");

  // Teams returns "1" on success
  if (responseText.trim() !== "1" && responseText.trim().toLowerCase() !== "ok") {
    log("warn", `teams_send_message: unexpected response body: "${responseText}"`);
  }

  const lines = [
    "Teams Message Sent",
    "==================",
    title ? `Title:   ${title}` : null,
    `Text:    ${truncate(text, 120)}`,
    `Color:   #${color}`,
    facts.length > 0 ? `Facts:   ${facts.length} key-value rows` : null,
    actionUrl ? `Action:  ${actionLabel} -> ${actionUrl}` : null,
    `Status:  Delivered to Teams webhook`,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
