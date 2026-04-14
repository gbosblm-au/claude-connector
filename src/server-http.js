// src/server-http.js  v5.0.0
// HTTP MCP server for browser-based Claude (claude.ai)
//
// v5 CHANGES:
//   - ADDED wordpress_set_seo_meta — sets Yoast SEO / RankMath meta on any page or post
//   - ADDED wordpress_create_service_page — creates brand-consistent TrueSource service pages
//     with Elementor-compatible HTML structure, capabilities grid, FAQs, hero and CTA sections
//   - Both tools are consumed by the Market Intelligence & Service Page Publisher skill

import "dotenv/config";
import { createServer } from "http";
import express from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

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
  // Credential management tools — set WP and LinkedIn credentials from within Claude
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
  // WordPress publishing tools - only invoked when explicitly called by Claude
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
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
    { name: "claude-connector", version: "5.0.0" },
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
        case "image_search":               return await handleImageSearch(args);
        case "linkedin_load_connections":   return await handleLinkedinLoad(args);
        case "linkedin_search_connections": return await handleLinkedinSearch(args);
        case "linkedin_connection_count":   return await handleLinkedinCount(args);
        case "linkedin_get_profile":        return await handleLinkedinProfile(args);
        case "linkedin_start_oauth":        return await handleLinkedinOAuthStart(args);
        case "linkedin_oauth_status":       return await handleLinkedinOAuthStatus(args);
        case "linkedin_oauth_logout":       return await handleLinkedinOAuthLogout(args);
        case "linkedin_get_live_profile":   return await handleLinkedinLiveProfile(args);
        // Credential management
        case "set_wordpress_credentials":      return await handleSetWordPressCredentials(args);
        case "get_wordpress_credentials":      return await handleGetWordPressCredentials(args);
        case "clear_wordpress_credentials":    return await handleClearWordPressCredentials(args);
        case "set_linkedin_credentials":       return await handleSetLinkedInCredentials(args);
        case "get_linkedin_credentials":       return await handleGetLinkedInCredentials(args);
        case "clear_linkedin_credentials":     return await handleClearLinkedInCredentials(args);
        // WordPress tools
        case "wordpress_site_info":         return await handleWpSiteInfo(args);
        case "wordpress_list_posts":        return await handleWpListPosts(args);
        case "wordpress_list_pages":        return await handleWpListPages(args);
        case "wordpress_list_categories":   return await handleWpListCategories(args);
        case "wordpress_list_tags":         return await handleWpListTags(args);
        case "wordpress_list_menus":        return await handleWpListMenus(args);
        case "wordpress_list_menu_items":   return await handleWpListMenuItems(args);
        case "wordpress_create_post":       return await handleWpCreatePost(args);
        case "wordpress_create_page":       return await handleWpCreatePage(args);
        case "wordpress_add_menu_item":     return await handleWpAddMenuItem(args);
        case "wordpress_update_content":    return await handleWpUpdateContent(args);
        case "wordpress_set_seo_meta":      return await handleWpSetSeoMeta(args);
        case "wordpress_create_service_page": return await handleWpCreateServicePage(args);
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
    version: "4.0.0",
    transport: ["streamable-http", "sse-legacy"],
    linkedinOAuth: !!(config.linkedinClientId && config.linkedinClientSecret),
    timestamp: new Date().toISOString(),
  });
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
        <p>Call <strong>linkedin_get_live_profile</strong> to fetch your profile,
        or <strong>linkedin_oauth_status</strong> to confirm the connection.</p>
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
// NO authentication on this endpoint - claude.ai does not support
// custom Bearer token auth when connecting to custom connectors.
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
      upload: "POST /upload/connections",
    },
  });
});

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------
const httpServer = createServer(app);
httpServer.listen(PORT, HOST, () => {
  log("info", `claude-connector v4.0.0 on http://${HOST}:${PORT}`);
  log("info", `MCP: http://${HOST}:${PORT}/mcp (NO auth - open for claude.ai)`);
  log("info", `LinkedIn OAuth: ${config.linkedinClientId ? "CONFIGURED" : "not configured"}`);
});

process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
