// src/server-http.js  v7.0.0
// HTTP MCP server for browser-based Claude (claude.ai) and Railway deployment.
//
// v7.0 CHANGES (TrueSource Outreach Direct Send):
//   - SCOPE-01 Tools: email_send, email_get_config, email_get_sender_profiles, email_validate_address
//   - SCOPE-03 HTML email templating integrated into email_send
//   - SCOPE-04 Tracking endpoints: GET /track/open, GET /track/click
//              + tools: email_get_tracking, email_tracking_summary
//   - SCOPE-05 Scheduling: cron-driven in-process scheduler started at boot
//              + tools: email_schedule, email_schedule_cancel, email_schedule_list

import "dotenv/config";
import { createServer } from "http";
import express from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { webSearchToolDefinition, handleWebSearch } from "./tools/webSearch.js";
import { newsSearchToolDefinition, handleNewsSearch } from "./tools/newsSearch.js";
import { imageSearchToolDefinition, handleImageSearch } from "./tools/imageSearch.js";
import {
  linkedinLoadToolDefinition, linkedinSearchToolDefinition,
  linkedinCountToolDefinition, linkedinProfileToolDefinition,
  handleLinkedinLoad, handleLinkedinSearch,
  handleLinkedinCount, handleLinkedinProfile,
} from "./tools/linkedin.js";
import {
  linkedinOAuthStartToolDefinition, linkedinOAuthStatusToolDefinition,
  linkedinOAuthLogoutToolDefinition, linkedinLiveProfileToolDefinition,
  handleLinkedinOAuthStart, handleLinkedinOAuthStatus,
  handleLinkedinOAuthLogout, handleLinkedinLiveProfile,
} from "./tools/linkedinOAuth.js";

import {
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpCreateCategoryToolDefinition,
  wpCreateTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  handleWpSiteInfo,
  handleWpListPosts,
  handleWpListPages,
  handleWpListCategories,
  handleWpListTags,
  handleWpCreateCategory,
  handleWpCreateTags,
  handleWpListMenus,
  handleWpListMenuItems,
  handleWpCreatePost,
  handleWpCreatePage,
  handleWpAddMenuItem,
  handleWpUpdateContent,
} from "./tools/wordpress.js";

import {
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
  handleSetWordPressCredentials,
  handleGetWordPressCredentials,
  handleClearWordPressCredentials,
  handleSetLinkedInCredentials,
  handleGetLinkedInCredentials,
  handleClearLinkedInCredentials,
} from "./tools/credentials.js";

import {
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
  handleWpSetSeoMeta,
  handleWpCreateServicePage,
} from "./tools/marketPublisher.js";

import {
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  handleImageDownload,
  handleImageSearchDownload,
} from "./tools/imageDownloader.js";
import {
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  handleWpUploadMedia,
  handleWpSetFeaturedImage,
} from "./tools/wordpressMedia.js";
import {
  googleDriveUploadToolDefinition,
  googleDriveListToolDefinition,
  handleGoogleDriveUpload,
  handleGoogleDriveList,
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  handleGoogleDriveCheckConnection,
  handleGoogleDriveSearchFiles,
  handleGoogleDriveReadFileContent,
  handleGoogleDriveDownloadFileContent,
  handleGoogleDriveCreateFile,
  handleGoogleDriveGetFileMetadata,
  handleGoogleDriveListRecentFiles,
  handleGoogleDriveGetFilePermissions,
} from "./tools/googleDrive.js";

import {
  psychologyEmotionTaxonomyToolDefinition,
  psychologySentimentAnalyzeToolDefinition,
  psychologyAlignmentAssessToolDefinition,
  handlePsychologyEmotionTaxonomy,
  handlePsychologySentimentAnalyze,
  handlePsychologyAlignmentAssess,
} from "./tools/psychology.js";

// ---------- TrueSource outreach direct send (SCOPE-01/03/04/05) ----------
import {
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  handleEmailSend,
  handleEmailGetConfig,
  handleEmailGetSenderProfiles,
  handleEmailValidateAddress,
} from "./tools/email.js";
import {
  emailGetTrackingToolDefinition,
  emailTrackingSummaryToolDefinition,
  handleEmailGetTracking,
  handleEmailTrackingSummary,
} from "./tools/emailTracking.js";
import {
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,
  handleEmailSchedule,
  handleEmailScheduleCancel,
  handleEmailScheduleList,
} from "./tools/emailSchedule.js";
import {
  PIXEL_PNG,
  appendTrackingEvent,
  classifyUserAgent,
  hashIp,
  getSendMetadata,
  incrementOpen,
} from "./utils/tracking.js";
import { startScheduler } from "./utils/scheduler.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";
import { validateAndConsumeState, storeToken } from "./utils/tokenStore.js";
import { getLinkedInCredentials } from "./utils/credentialStore.js";
import { config } from "./config.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || "";

// -----------------------------------------------------------------------
// Tool registry
// -----------------------------------------------------------------------
const TOOLS = [
  webSearchToolDefinition,
  newsSearchToolDefinition,
  imageSearchToolDefinition,
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  linkedinOAuthStartToolDefinition,
  linkedinOAuthStatusToolDefinition,
  linkedinOAuthLogoutToolDefinition,
  linkedinLiveProfileToolDefinition,
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpCreateCategoryToolDefinition,
  wpCreateTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  googleDriveUploadToolDefinition,
  googleDriveListToolDefinition,
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  psychologyEmotionTaxonomyToolDefinition,
  psychologySentimentAnalyzeToolDefinition,
  psychologyAlignmentAssessToolDefinition,

  // ---------- TrueSource outreach direct send ----------
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  emailGetTrackingToolDefinition,
  emailTrackingSummaryToolDefinition,
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,

  {
    name: "get_current_datetime",
    description: "Returns the current UTC date and time.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// -----------------------------------------------------------------------
// MCP Server factory
// -----------------------------------------------------------------------
function createMcpServer() {
  const server = new Server(
    { name: "claude-connector", version: "7.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("info", `Tool: ${name}`);
    try {
      switch (name) {
        case "web_search":                  return await handleWebSearch(args);
        case "news_search":                 return await handleNewsSearch(args);
        case "image_search":                return await handleImageSearch(args);
        case "linkedin_load_connections":   return await handleLinkedinLoad(args);
        case "linkedin_search_connections": return await handleLinkedinSearch(args);
        case "linkedin_connection_count":   return await handleLinkedinCount(args);
        case "linkedin_get_profile":        return await handleLinkedinProfile(args);
        case "linkedin_start_oauth":        return await handleLinkedinOAuthStart(args);
        case "linkedin_oauth_status":       return await handleLinkedinOAuthStatus(args);
        case "linkedin_oauth_logout":       return await handleLinkedinOAuthLogout(args);
        case "linkedin_get_live_profile":   return await handleLinkedinLiveProfile(args);
        case "set_wordpress_credentials":   return await handleSetWordPressCredentials(args);
        case "get_wordpress_credentials":   return await handleGetWordPressCredentials(args);
        case "clear_wordpress_credentials": return await handleClearWordPressCredentials(args);
        case "set_linkedin_credentials":    return await handleSetLinkedInCredentials(args);
        case "get_linkedin_credentials":    return await handleGetLinkedInCredentials(args);
        case "clear_linkedin_credentials":  return await handleClearLinkedInCredentials(args);
        case "wordpress_site_info":         return await handleWpSiteInfo(args);
        case "wordpress_list_posts":        return await handleWpListPosts(args);
        case "wordpress_list_pages":        return await handleWpListPages(args);
        case "wordpress_list_categories":   return await handleWpListCategories(args);
        case "wordpress_list_tags":         return await handleWpListTags(args);
        case "wordpress_create_category":   return await handleWpCreateCategory(args);
        case "wordpress_create_tags":       return await handleWpCreateTags(args);
        case "wordpress_list_menus":        return await handleWpListMenus(args);
        case "wordpress_list_menu_items":   return await handleWpListMenuItems(args);
        case "wordpress_create_post":       return await handleWpCreatePost(args);
        case "wordpress_create_page":       return await handleWpCreatePage(args);
        case "wordpress_add_menu_item":     return await handleWpAddMenuItem(args);
        case "wordpress_update_content":    return await handleWpUpdateContent(args);
        case "wordpress_set_seo_meta":      return await handleWpSetSeoMeta(args);
        case "wordpress_create_service_page": return await handleWpCreateServicePage(args);
        case "image_download":              return await handleImageDownload(args);
        case "image_search_download":       return await handleImageSearchDownload(args);
        case "wordpress_upload_media":      return await handleWpUploadMedia(args);
        case "wordpress_set_featured_image":return await handleWpSetFeaturedImage(args);
        case "google_drive_upload":         return await handleGoogleDriveUpload(args);
        case "google_drive_list":           return await handleGoogleDriveList(args);
        case "google_drive_check_connection":      return await handleGoogleDriveCheckConnection(args);
        case "google_drive_search_files":          return await handleGoogleDriveSearchFiles(args);
        case "google_drive_read_file_content":     return await handleGoogleDriveReadFileContent(args);
        case "google_drive_download_file_content": return await handleGoogleDriveDownloadFileContent(args);
        case "google_drive_create_file":           return await handleGoogleDriveCreateFile(args);
        case "google_drive_get_file_metadata":     return await handleGoogleDriveGetFileMetadata(args);
        case "google_drive_list_recent_files":     return await handleGoogleDriveListRecentFiles(args);
        case "google_drive_get_file_permissions":  return await handleGoogleDriveGetFilePermissions(args);
        case "psychology_emotion_taxonomy":  return await handlePsychologyEmotionTaxonomy(args);
        case "psychology_sentiment_analyze": return await handlePsychologySentimentAnalyze(args);
        case "psychology_alignment_assess":  return await handlePsychologyAlignmentAssess(args);

        // ---------- TrueSource outreach direct send ----------
        case "email_send":                   return await handleEmailSend(args);
        case "email_get_config":             return await handleEmailGetConfig(args);
        case "email_get_sender_profiles":    return await handleEmailGetSenderProfiles(args);
        case "email_validate_address":       return await handleEmailValidateAddress(args);
        case "email_get_tracking":           return await handleEmailGetTracking(args);
        case "email_tracking_summary":       return await handleEmailTrackingSummary(args);
        case "email_schedule":               return await handleEmailSchedule(args);
        case "email_schedule_cancel":        return await handleEmailScheduleCancel(args);
        case "email_schedule_list":          return await handleEmailScheduleList(args);

        case "get_current_datetime":
          return { content: [{ type: "text", text: JSON.stringify(getCurrentDateTime(), null, 2) }] };
        default:
          throw new Error(`Unknown tool: "${name}"`);
      }
    } catch (err) {
      log("error", `Tool "${name}" error: ${err.message}`);
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// -----------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// -----------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "claude-connector",
    version: "7.0.0",
    transport: ["streamable-http", "sse-legacy"],
    linkedinOAuth: !!(config.linkedinClientId && config.linkedinClientSecret),
    psychologyEndpoints: true,
    emailSendEnabled: config.emailSendEnabled,
    emailHtmlEnabled: config.emailHtmlEnabled,
    emailTrackingEnabled: config.emailTrackingEnabled,
    scheduleEnabled: config.scheduleEnabled,
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------
// SCOPE-04 -- Tracking endpoints
// -----------------------------------------------------------------------

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return fwd || req.ip || req.connection?.remoteAddress || "";
}

app.get("/track/open", async (req, res) => {
  // Always return the pixel - never expose validation errors to the recipient
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).end(PIXEL_PNG);

  if (!config.emailTrackingEnabled) return;

  try {
    const id = String(req.query.id || "");
    if (!id) return;
    const ua = req.headers["user-agent"] || "";
    const ref = req.headers["referer"] || req.headers["referrer"] || "";
    const uaType = classifyUserAgent(ua, ref);
    const ipHash = hashIp(clientIp(req));

    const meta = getSendMetadata(id) || {};
    const open_count = incrementOpen(id);

    appendTrackingEvent({
      tracking_id: id,
      event_type: "open",
      to_address: meta.to_address || "",
      to_name: meta.to_name || "",
      subject: meta.subject || "",
      sender_id: meta.sender_id || "",
      company: meta.company || "",
      send_timestamp: meta.send_timestamp || "",
      click_url: "",
      user_agent_type: uaType,
      open_count,
      schedule_id: meta.schedule_id || "",
      user_agent_raw: ua,
      ip_hash: ipHash,
    }).catch((e) => log("warn", `track/open append failed: ${e.message}`));
  } catch (err) {
    log("warn", `track/open handler error: ${err.message}`);
  }
});

app.get("/track/click", async (req, res) => {
  const SAFE_FALLBACK = "https://truesourceconsulting.com.au";
  let target = SAFE_FALLBACK;

  try {
    const id = String(req.query.id || "");
    const rawUrl = String(req.query.url || "");
    let isValid = false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol === "https:") {
        target = u.toString();
        isValid = true;
      }
    } catch (_) {
      isValid = false;
    }

    if (config.emailTrackingEnabled && id) {
      const ua = req.headers["user-agent"] || "";
      const ref = req.headers["referer"] || req.headers["referrer"] || "";
      const uaType = classifyUserAgent(ua, ref);
      const ipHash = hashIp(clientIp(req));
      const meta = getSendMetadata(id) || {};

      appendTrackingEvent({
        tracking_id: id,
        event_type: "click",
        to_address: meta.to_address || "",
        to_name: meta.to_name || "",
        subject: meta.subject || "",
        sender_id: meta.sender_id || "",
        company: meta.company || "",
        send_timestamp: meta.send_timestamp || "",
        click_url: isValid ? target : "",
        user_agent_type: uaType,
        schedule_id: meta.schedule_id || "",
        user_agent_raw: ua,
        ip_hash: ipHash,
      }).catch((e) => log("warn", `track/click append failed: ${e.message}`));
    }
  } catch (err) {
    log("warn", `track/click handler error: ${err.message}`);
  }

  res.redirect(302, target);
});

// -----------------------------------------------------------------------
// LinkedIn OAuth callback
// -----------------------------------------------------------------------
app.get("/auth/linkedin/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">LinkedIn Authorization Failed</h2>
      <p><strong>Error:</strong> ${error}</p><p>${error_description || ""}</p>
      <p>Close this tab and call <code>linkedin_start_oauth</code> again in Claude.</p>
    </body></html>`);
    return;
  }

  if (!code || !state) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Invalid Callback</h2><p>Missing code or state. Try the authorization flow again.</p>
    </body></html>`);
    return;
  }

  if (!validateAndConsumeState(state)) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Expired or Invalid State</h2>
      <p>The authorization link expired (10 min limit) or was already used.</p>
      <p>Call <code>linkedin_start_oauth</code> in Claude to get a fresh link.</p>
    </body></html>`);
    return;
  }

  try {
    const tokenResp = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: getLinkedInCredentials().redirectUri,
        client_id: getLinkedInCredentials().clientId,
        client_secret: getLinkedInCredentials().clientSecret,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text().catch(() => "");
      throw new Error(`LinkedIn token exchange failed (${tokenResp.status}): ${errBody}`);
    }

    const tokenData = await tokenResp.json();
    storeToken(tokenData);
    log("info", "LinkedIn token stored successfully");

    const expiresHours = tokenData.expires_in ? Math.round(tokenData.expires_in / 3600) : "unknown";

    res.send(`<html>
    <head><title>LinkedIn Connected</title></head>
    <body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center">
      <div style="background:#e8f5e9;border:2px solid #4caf50;border-radius:10px;padding:40px">
        <h2 style="color:#2e7d32;margin-top:0">LinkedIn Connected!</h2>
        <p style="font-size:16px">Your LinkedIn account is now authorized.</p>
        <p>Close this tab and return to Claude.</p>
      </div>
      <p style="color:#888;font-size:12px;margin-top:20px">Token expires in approx. ${expiresHours} hours</p>
    </body></html>`);
  } catch (err) {
    log("error", `LinkedIn callback error: ${err.message}`);
    res.status(500).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Server Error</h2><p>${err.message}</p>
      <p>Try <code>linkedin_start_oauth</code> again in Claude.</p>
    </body></html>`);
  }
});

// -----------------------------------------------------------------------
// Streamable HTTP - PRIMARY MCP TRANSPORT FOR CLAUDE.AI
// -----------------------------------------------------------------------
const streamableSessions = {};

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && streamableSessions[sessionId]) {
      await streamableSessions[sessionId].handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createMcpServer();
      transport.onclose = () => {
        if (transport.sessionId) { delete streamableSessions[transport.sessionId]; }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        streamableSessions[transport.sessionId] = transport;
        log("info", `New session: ${transport.sessionId}`);
      }
      return;
    }
    if (req.method === "GET" && !sessionId) {
      res.status(405).json({ error: "Session required for GET" });
      return;
    }
    res.status(400).json({ error: "Bad request: missing or invalid session" });
  } catch (err) {
    log("error", `MCP error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------
// Legacy SSE transport
// -----------------------------------------------------------------------
const sseSessions = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;
  res.on("close", () => { delete sseSessions[transport.sessionId]; });
  await createMcpServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseSessions[req.query.sessionId];
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
  await transport.handlePostMessage(req, res, req.body);
});

// -----------------------------------------------------------------------
// CSV upload endpoint (protected by UPLOAD_API_KEY)
// -----------------------------------------------------------------------
app.post("/upload/connections", async (req, res) => {
  if (!UPLOAD_API_KEY) {
    res.status(403).json({ error: "Upload disabled. Set UPLOAD_API_KEY in Railway Variables." });
    return;
  }
  if ((req.headers["x-upload-key"] || "") !== UPLOAD_API_KEY) {
    res.status(401).json({ error: "Invalid upload key" });
    return;
  }

  const ct = req.headers["content-type"] || "";
  let csvContent = "";
  if (ct.includes("text/csv") || ct.includes("text/plain")) {
    csvContent = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  } else if (req.body?.csv_base64) {
    csvContent = Buffer.from(req.body.csv_base64, "base64").toString("utf-8");
  } else if (req.body?.csv) {
    csvContent = req.body.csv;
  } else {
    res.status(400).json({ error: "Provide CSV as text/csv body, JSON {csv: '...'} or {csv_base64: '...'}" });
    return;
  }

  if (!csvContent?.trim()) { res.status(400).json({ error: "CSV is empty" }); return; }

  const targetPath = config.linkedinCsvPath;
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(targetPath, csvContent, "utf-8");
    log("info", `CSV uploaded: ${csvContent.length} bytes`);
    res.json({ success: true, bytes: csvContent.length });
  } catch (err) {
    res.status(500).json({ error: `Write failed: ${err.message}` });
  }
});

// -----------------------------------------------------------------------
// 404
// -----------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: {
      mcp: "POST /mcp",
      health: "GET /health",
      linkedinCallback: "GET /auth/linkedin/callback",
      trackOpen: "GET /track/open?id=...",
      trackClick: "GET /track/click?id=...&url=...",
      upload: "POST /upload/connections",
    },
  });
});

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------
const httpServer = createServer(app);
httpServer.listen(PORT, HOST, () => {
  log("info", `claude-connector v7.0.0 on http://${HOST}:${PORT}`);
  log("info", `MCP: http://${HOST}:${PORT}/mcp (NO auth - open for claude.ai)`);
  log("info", `LinkedIn OAuth: ${config.linkedinClientId ? "CONFIGURED" : "not configured"}`);
  log("info", `Email send: ${config.emailSendEnabled ? "ENABLED" : "disabled"} | ` +
    `HTML: ${config.emailHtmlEnabled ? "ENABLED" : "disabled"} | ` +
    `Tracking: ${config.emailTrackingEnabled ? "ENABLED" : "disabled"} | ` +
    `Scheduling: ${config.scheduleEnabled ? "ENABLED" : "disabled"}`);
  log("info", `Tracking endpoints: GET /track/open, GET /track/click`);
  log("info", "Psychology endpoints: ENABLED (emotion/taxonomy, sentiment/analyze, alignment/assess)");

  // Boot the in-process scheduler (loads schedule_store.json + starts cron)
  try {
    startScheduler();
  } catch (err) {
    log("error", `Scheduler boot failed: ${err.message}`);
  }
});

process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
