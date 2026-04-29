// src/tools/email.js
//
// MCP tool definitions and handlers for SCOPE-01 / SCOPE-03.
//
//   email_send                  -- dispatch outreach email via SMTP
//   email_get_config            -- per-sender config (no credentials)
//   email_get_sender_profiles   -- list of all configured senders
//   email_validate_address      -- format check on a recipient address

import { config, getSenderProfile, listSenderProfiles, smtpConfigured } from "../config.js";
import {
  sendEmailInternal,
  validateEmailFormat,
} from "../utils/email.js";

// -----------------------------------------------------------------------
// Tool: email_send
// -----------------------------------------------------------------------
export const emailSendToolDefinition = {
  name: "email_send",
  description:
    "Send a single outreach email via SMTP from the nominated TrueSource sender. " +
    "From address is always TrueSource Consulting <team@truesourceconsulting.com.au>. " +
    "Reply-To is set per sender (Brian / Michael / Robbie) so replies land in their inbox. " +
    "When EMAIL_HTML_ENABLED is true (default), the email is sent as HTML with a plain-text " +
    "fallback. Pass format:\"text\" to force plain text. Tracking pixel and click tracking " +
    "are added automatically when EMAIL_TRACKING_ENABLED is true.",
  inputSchema: {
    type: "object",
    properties: {
      to_address: { type: "string", description: "Recipient email address" },
      to_name:    { type: "string", description: "Recipient display name (optional)" },
      subject:    { type: "string", description: "Email subject line" },
      body_text:  { type: "string", description: "Plain text body. Signature is appended server-side. Max 4000 chars." },
      sender_id:  { type: "string", description: "brian | michael | robbie. Defaults to brian.", enum: ["brian", "michael", "robbie"] },
      format:     { type: "string", description: "html | text. Defaults to html.", enum: ["html", "text"] },
      company:    { type: "string", description: "Company name (used by tracking and reporting)" },
    },
    required: ["to_address", "subject", "body_text"],
  },
};

export async function handleEmailSend(args) {
  const result = await sendEmailInternal(args || {});
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.status !== "sent",
  };
}

// -----------------------------------------------------------------------
// Tool: email_get_config
// -----------------------------------------------------------------------
export const emailGetConfigToolDefinition = {
  name: "email_get_config",
  description:
    "Return the send configuration for a specific sender so the skill UI can show " +
    "who the email will be sent from and preview the signature. Never returns credentials.",
  inputSchema: {
    type: "object",
    properties: {
      sender_id: { type: "string", enum: ["brian", "michael", "robbie"], description: "Defaults to brian." },
    },
  },
};

export async function handleEmailGetConfig(args) {
  const profile = getSenderProfile(args?.sender_id || "brian");
  const configured = smtpConfigured();
  const out = profile
    ? {
        sender_id: profile.sender_id,
        sender_name: profile.sender_name,
        sender_title: profile.sender_title,
        reply_to: profile.reply_to,
        from_address: `${config.smtpFromName} <${config.smtpFromEmail}>`,
        signature_preview: profile.signature_preview,
        smtp_host: config.smtpHost || "",
        smtp_configured: configured,
        html_enabled: Boolean(config.emailHtmlEnabled && configured),
        tracking_enabled: Boolean(config.emailTrackingEnabled && configured),
        scheduling_enabled: Boolean(config.scheduleEnabled),
      }
    : {
        sender_id: args?.sender_id || null,
        sender_name: null,
        sender_title: null,
        reply_to: null,
        from_address: `${config.smtpFromName} <${config.smtpFromEmail}>`,
        signature_preview: null,
        smtp_host: config.smtpHost || "",
        smtp_configured: false,
        html_enabled: false,
        tracking_enabled: false,
        scheduling_enabled: Boolean(config.scheduleEnabled),
        error: `Unknown sender_id "${args?.sender_id}". Expected brian | michael | robbie.`,
      };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// -----------------------------------------------------------------------
// Tool: email_get_sender_profiles
// -----------------------------------------------------------------------
export const emailGetSenderProfilesToolDefinition = {
  name: "email_get_sender_profiles",
  description:
    "Return all configured TrueSource sender profiles so the skill UI can build a sender selector. " +
    "Never returns SMTP credentials.",
  inputSchema: { type: "object", properties: {} },
};

export async function handleEmailGetSenderProfiles() {
  const profiles = listSenderProfiles().map((p) => ({
    sender_id: p.sender_id,
    sender_name: p.sender_name,
    sender_title: p.sender_title,
    reply_to: p.reply_to,
  }));
  const out = {
    from_address: `${config.smtpFromName} <${config.smtpFromEmail}>`,
    profiles,
    default_sender_id: "brian",
    smtp_configured: smtpConfigured(),
    html_enabled: Boolean(config.emailHtmlEnabled && smtpConfigured()),
    tracking_enabled: Boolean(config.emailTrackingEnabled && smtpConfigured()),
    scheduling_enabled: Boolean(config.scheduleEnabled),
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

// -----------------------------------------------------------------------
// Tool: email_validate_address
// -----------------------------------------------------------------------
export const emailValidateAddressToolDefinition = {
  name: "email_validate_address",
  description:
    "Lightweight format validation of a recipient email address. Does NOT perform an SMTP " +
    "handshake or deliverability check.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Email address to validate" },
    },
    required: ["email"],
  },
};

export async function handleEmailValidateAddress(args) {
  const r = validateEmailFormat(args?.email);
  const out = r.valid
    ? {
        valid: true,
        email: r.email,
        domain: r.domain,
        note: "Format valid. Deliverability not verified.",
      }
    : {
        valid: false,
        email: args?.email || "",
        domain: null,
        note: r.reason,
      };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}
