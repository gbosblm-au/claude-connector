// src/utils/email.js
//
// Email helpers shared across SCOPE-01 (SMTP send), SCOPE-03 (HTML template),
// SCOPE-04 (tracking pixel + tracked links), and SCOPE-05 (scheduler).

import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { config, getSenderProfile, smtpConfigured } from "../config.js";
import { log } from "./logger.js";
import {
  registerSend,
  buildTrackingPixelUrl,
  buildClickTrackedUrl,
  appendTrackingEvent,
} from "./tracking.js";

const MAX_BODY_TEXT_LENGTH = 4000;
const SMTP_TIMEOUT_MS = 15000;

const EMAIL_RE =
  /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// -----------------------------------------------------------------------
// Rolling rate limiter (per process)
// -----------------------------------------------------------------------
const sendTimestamps = [];

function pruneSendTimestamps() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (sendTimestamps.length && sendTimestamps[0] < cutoff) {
    sendTimestamps.shift();
  }
}

export function withinRateLimit() {
  pruneSendTimestamps();
  return sendTimestamps.length < (config.emailRateLimitPerHour || 20);
}

export function recordSendAttempt() {
  sendTimestamps.push(Date.now());
}

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------
export function validateEmailFormat(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, reason: "Empty or non-string input" };
  }
  const trimmed = email.trim();
  if (!EMAIL_RE.test(trimmed)) {
    return { valid: false, reason: "Format does not match email pattern" };
  }
  const domain = trimmed.split("@")[1];
  return { valid: true, email: trimmed, domain };
}

// -----------------------------------------------------------------------
// HTML helpers
// -----------------------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

export function plainTextToHtmlBody(text, { linkRewriter } = {}) {
  const raw = (text || "").replace(/\r\n/g, "\n");
  const urls = [];
  const placeheld = raw.replace(URL_RE, (u) => {
    const idx = urls.push(u) - 1;
    return `\u0001URL${idx}\u0001`;
  });
  let escaped = escapeHtml(placeheld);
  escaped = escaped.replace(/\u0001URL(\d+)\u0001/g, (_, i) => {
    const original = urls[Number(i)];
    const href = linkRewriter ? linkRewriter(original) : original;
    return (
      `<a href="${escapeHtml(href)}" ` +
      `style="color:#D4AF37;text-decoration:underline;" ` +
      `target="_blank" rel="noopener">${escapeHtml(original)}</a>`
    );
  });
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br>"))
    .filter((p) => p.length > 0)
    .map((p) => `<p style="margin:0 0 14px 0;">${p}</p>`)
    .join("");
  return paragraphs || `<p style="margin:0;">&nbsp;</p>`;
}

// -----------------------------------------------------------------------
// HTML email envelope (SCOPE-03)
// -----------------------------------------------------------------------
export function buildHtmlEmail({
  bodyText,
  senderName,
  senderTitle,
  senderPhone,
  senderEmail,
  senderWebsite = "truesourceconsulting.com.au",
  senderLinkedIn,
  confidentialityFooter,
  logoUrl,
  trackingPixelUrl,
  linkRewriter,
}) {
  const bodyHtml = plainTextToHtmlBody(bodyText, { linkRewriter });

  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="TrueSource Consulting" width="180" height="40" style="display:block;border:0;outline:none;height:40px;width:auto;">`
    : `<span style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;letter-spacing:0.5px;">TrueSource Consulting</span>`;

  const phoneRow = senderPhone
    ? `<tr><td style="padding:1px 0;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:13px;">T: ${escapeHtml(senderPhone)}</td></tr>`
    : "";

  const linkedinRow = senderLinkedIn
    ? `<tr><td style="padding:4px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;"><a href="https://${escapeHtml(senderLinkedIn.replace(/^https?:\/\//, ""))}" style="color:#D4AF37;text-decoration:none;" target="_blank" rel="noopener">LinkedIn profile</a></td></tr>`
    : "";

  const pixel = trackingPixelUrl
    ? `<img src="${escapeHtml(trackingPixelUrl)}" alt="" width="1" height="1" style="display:block;border:0;outline:none;width:1px;height:1px;" />`
    : "";

  const footer = escapeHtml(confidentialityFooter || "");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrueSource Consulting</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f0f0">
  <tr><td align="center" style="padding:24px 8px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;">
      <tr><td bgcolor="#123F4B" align="center" style="padding:22px 20px;">${logoBlock}</td></tr>
      <tr><td bgcolor="#ffffff" style="padding:28px 32px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
      <tr><td bgcolor="#f5f5f5" style="border-top:3px solid #123F4B;padding:20px 32px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-size:14px;font-weight:bold;color:#1a1a1a;padding-bottom:2px;">${escapeHtml(senderName || "")}</td></tr>
          <tr><td style="font-size:13px;color:#444444;padding-bottom:6px;">${escapeHtml(senderTitle || "Director")} | TrueSource Consulting</td></tr>
          ${phoneRow}
          <tr><td style="padding:1px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
            <a href="mailto:${escapeHtml(senderEmail || "")}" style="color:#D4AF37;text-decoration:none;">${escapeHtml(senderEmail || "")}</a>
            &nbsp;|&nbsp;
            <a href="https://${escapeHtml(senderWebsite)}" style="color:#D4AF37;text-decoration:none;" target="_blank" rel="noopener">${escapeHtml(senderWebsite)}</a>
          </td></tr>
          ${linkedinRow}
        </table>
      </td></tr>
      <tr><td bgcolor="#f0f0f0" style="padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#888888;line-height:1.5;">
        ${footer}<br><br>
        <a href="#unsubscribe" style="color:#888888;text-decoration:underline;">Unsubscribe</a>
      </td></tr>
    </table>
    ${pixel}
  </td></tr>
</table>
</body></html>`;
}

// -----------------------------------------------------------------------
// SMTP transport (lazy singleton)
// -----------------------------------------------------------------------
let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  if (!smtpConfigured()) {
    throw new Error("SMTP credentials not set. SMTP_HOST, SMTP_USER, SMTP_PASS are required.");
  }
  _transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return _transport;
}

// -----------------------------------------------------------------------
// sendEmailInternal -- shared by email_send tool and scheduler
// -----------------------------------------------------------------------
export async function sendEmailInternal(args) {
  const sender_id = (args.sender_id || "brian").toLowerCase();
  const profile = getSenderProfile(sender_id);

  if (!config.emailSendEnabled) {
    return { status: "failed", code: "SEND_DISABLED",
      error: "Outbound email is disabled (EMAIL_SEND_ENABLED=false)." };
  }
  if (!profile) {
    return { status: "failed", code: "UNKNOWN_SENDER",
      error: `Unknown sender_id "${args.sender_id}". Expected brian | michael | robbie.` };
  }

  const fmt = validateEmailFormat(args.to_address);
  if (!fmt.valid) {
    return { status: "failed", code: "RECIPIENT_REJECTED",
      error: `Invalid recipient address: ${fmt.reason}` };
  }
  if (!args.subject || !args.body_text) {
    return { status: "failed", code: "RECIPIENT_REJECTED",
      error: "subject and body_text are required." };
  }
  if (args.body_text.length > MAX_BODY_TEXT_LENGTH) {
    return { status: "failed", code: "RECIPIENT_REJECTED",
      error: `body_text exceeds ${MAX_BODY_TEXT_LENGTH} character limit.` };
  }
  if (!smtpConfigured()) {
    return { status: "failed", code: "SMTP_AUTH_FAILURE",
      error: "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in Railway." };
  }
  if (!withinRateLimit()) {
    return { status: "failed", code: "RATE_LIMIT_EXCEEDED",
      error: `Rate limit reached (${config.emailRateLimitPerHour} sends/hour across all senders).` };
  }

  const requestedFormat = (args.format || "").toLowerCase();
  const useHtml = config.emailHtmlEnabled && requestedFormat !== "text";

  const tracking_id = randomUUID();
  const trackingActive = useHtml && config.emailTrackingEnabled;

  const textPart = `${args.body_text}\n\n${profile.signature_preview}`;

  let htmlPart = null;
  if (useHtml) {
    const pixelUrl = trackingActive ? buildTrackingPixelUrl(tracking_id) : null;
    const linkRewriter = trackingActive
      ? (u) => buildClickTrackedUrl(tracking_id, u)
      : null;
    htmlPart = buildHtmlEmail({
      bodyText: args.body_text,
      senderName: profile.sender_name,
      senderTitle: profile.sender_title,
      senderPhone: profile.phone,
      senderEmail: profile.reply_to,
      senderLinkedIn: profile.linkedin,
      confidentialityFooter: config.emailConfidentialityFooter,
      logoUrl: config.emailLogoUrl,
      trackingPixelUrl: pixelUrl,
      linkRewriter,
    });
  }

  const fromAddress = `${config.smtpFromName} <${config.smtpFromEmail}>`;
  const toAddress = args.to_name ? `${args.to_name} <${fmt.email}>` : fmt.email;

  const mail = {
    from: fromAddress,
    to: toAddress,
    replyTo: profile.reply_to,
    subject: args.subject,
    text: textPart,
  };
  if (htmlPart) mail.html = htmlPart;

  recordSendAttempt();

  let info;
  try {
    info = await getTransport().sendMail(mail);
  } catch (err) {
    log("error", `email_send failure: ${err.message}`);
    let code = "UNKNOWN";
    if (/auth|535|530/i.test(err.message)) code = "SMTP_AUTH_FAILURE";
    else if (/timeout|timed out|ETIMEDOUT|ESOCKET/i.test(err.message)) code = "CONNECTION_TIMEOUT";
    else if (/recipient|550|553|invalid/i.test(err.message)) code = "RECIPIENT_REJECTED";
    return { status: "failed", code, error: err.message };
  }

  const timestamp = new Date().toISOString();

  log("info", `email_send sent | sender=${sender_id} to=${fmt.email} subject="${args.subject.slice(0, 60)}" tracking_id=${tracking_id}`);

  if (config.emailTrackingEnabled) {
    registerSend({
      tracking_id,
      to_address: fmt.email,
      to_name: args.to_name || "",
      subject: args.subject,
      sender_id,
      company: args.company || "",
      send_timestamp: timestamp,
      schedule_id: args.schedule_id || "",
    });
    appendTrackingEvent({
      tracking_id,
      event_type: "sent",
      to_address: fmt.email,
      to_name: args.to_name || "",
      subject: args.subject,
      sender_id,
      company: args.company || "",
      send_timestamp: timestamp,
      click_url: "",
      user_agent_type: "",
      schedule_id: args.schedule_id || "",
    }).catch((e) => log("warn", `tracking CSV seed append failed: ${e.message}`));
  }

  return {
    status: "sent",
    message_id: info.messageId || `<${tracking_id}@truesourceconsulting.com.au>`,
    timestamp,
    to: fmt.email,
    subject: args.subject,
    sender_id,
    from: fromAddress,
    reply_to: profile.reply_to,
    format: useHtml ? "html" : "text",
    tracking_id,
    tracking_enabled: Boolean(trackingActive),
  };
}
