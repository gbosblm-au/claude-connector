// src/server-http.js
// HTTP-based MCP server for use with browser-based Claude (claude.ai).
//
// Architecture:
//   - Primary transport:  Streamable HTTP  (POST/GET /mcp)   - required for claude.ai
//   - Legacy transport:   SSE              (GET /sse, POST /messages) - for older clients
//   - Upload endpoint:    POST /upload/connections  - lets you push a new connections.csv
//   - Health endpoint:    GET /health               - liveness check
//
// Claude.ai connects to this server from Anthropic's cloud infrastructure.
// The server must be reachable over public HTTPS.
// For local development, use ngrok or Cloudflare Tunnel to expose it.

import "dotenv/config";
import { createServer } from "http";
import express from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  webSearchToolDefinition,
  handleWebSearch,
} from "./tools/webSearch.js";
import {
  newsSearchToolDefinition,
  handleNewsSearch,
} from "./tools/newsSearch.js";
import {
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  handleLinkedinLoad,
  handleLinkedinSearch,
  handleLinkedinCount,
  handleLinkedinProfile,
} from "./tools/linkedin.js";
import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Optional API key to protect the upload and admin endpoints.
// If not set, upload endpoint is disabled.
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || "";

// Optional API key to restrict MCP access (recommended for production).
// If set, requests must include: Authorization: Bearer <MCP_API_KEY>
const MCP_API_KEY = process.env.MCP_API_KEY || "";

// -----------------------------------------------------------------------
// Tool registry (same as stdio server)
// -----------------------------------------------------------------------

const TOOLS = [
  webSearchToolDefinition,
  newsSearchToolDefinition,
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  {
    name: "get_current_datetime",
    description:
      "Returns the current UTC date and time. Useful for anchoring time-sensitive queries.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// -----------------------------------------------------------------------
// MCP Server factory
// Each Streamable HTTP session gets its own Server instance to avoid
// request-ID collisions across concurrent sessions.
// -----------------------------------------------------------------------

function createMcpServer() {
  const server = new Server(
    { name: "claude-connector", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("debug", "ListTools");
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("info", `Tool call: ${name}`);
    try {
      switch (name) {
        case "web_search":               return await handleWebSearch(args);
        case "news_search":              return await handleNewsSearch(args);
        case "linkedin_load_connections": return await handleLinkedinLoad(args);
        case "linkedin_search_connections": return await handleLinkedinSearch(args);
        case "linkedin_connection_count":  return await handleLinkedinCount(args);
        case "linkedin_get_profile":      return await handleLinkedinProfile(args);
        case "get_current_datetime": {
          const dt = getCurrentDateTime();
          return { content: [{ type: "text", text: JSON.stringify(dt, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: "${name}"`);
      }
    } catch (err) {
      log("error", `Tool "${name}" error: ${err.message}`);
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// -----------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS: Anthropic's cloud infrastructure must be able to reach this server.
// The wildcard is safe here because MCP_API_KEY provides authentication.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Accept"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// -----------------------------------------------------------------------
// Optional Bearer token auth for MCP endpoints
// -----------------------------------------------------------------------

function mcpAuthMiddleware(req, res, next) {
  if (!MCP_API_KEY) return next(); // auth disabled

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (token !== MCP_API_KEY) {
    log("warn", `Rejected request to ${req.path} - invalid or missing API key`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// -----------------------------------------------------------------------
// Health endpoint (unprotected - for uptime monitors and deployment checks)
// -----------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "claude-connector",
    version: "1.0.0",
    transport: ["streamable-http", "sse-legacy"],
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------
// Streamable HTTP transport  (primary - required for claude.ai)
// Endpoint: POST /mcp  and  GET /mcp
// -----------------------------------------------------------------------

// Session store for stateful Streamable HTTP connections
const streamableSessions = {};

app.all("/mcp", mcpAuthMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  try {
    // ---- Re-use existing session ----
    if (sessionId && streamableSessions[sessionId]) {
      const transport = streamableSessions[sessionId];
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // ---- New session: must be an Initialize request ----
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = createMcpServer();

      // Clean up when session closes
      transport.onclose = () => {
        if (transport.sessionId) {
          log("info", `Session closed: ${transport.sessionId}`);
          delete streamableSessions[transport.sessionId];
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Store after handling so sessionId is populated
      if (transport.sessionId) {
        streamableSessions[transport.sessionId] = transport;
        log("info", `New session created: ${transport.sessionId}`);
      }
      return;
    }

    // ---- GET without session: open SSE notification stream ----
    if (req.method === "GET" && !sessionId) {
      // Stateless GET - return 405 to signal the client should use POST
      res.status(405).json({ error: "Session required for GET requests" });
      return;
    }

    // ---- Anything else is invalid ----
    res
      .status(400)
      .json({ error: "Bad Request: missing or invalid session ID" });
  } catch (err) {
    log("error", `Streamable HTTP error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// -----------------------------------------------------------------------
// Legacy SSE transport (for backwards compatibility with older clients)
// Endpoints: GET /sse  and  POST /messages
// -----------------------------------------------------------------------

const sseSessions = {};

app.get("/sse", mcpAuthMiddleware, async (req, res) => {
  log("info", "New SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;

  res.on("close", () => {
    log("info", `SSE session closed: ${transport.sessionId}`);
    delete sseSessions[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", mcpAuthMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseSessions[sessionId];

  if (!transport) {
    log("warn", `SSE message for unknown session: ${sessionId}`);
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

// -----------------------------------------------------------------------
// Upload endpoint - push a new Connections.csv to the server
// Protected by UPLOAD_API_KEY (must be set in .env to enable)
// -----------------------------------------------------------------------

app.post("/upload/connections", async (req, res) => {
  if (!UPLOAD_API_KEY) {
    res.status(403).json({
      error:
        "Upload endpoint is disabled. Set UPLOAD_API_KEY in your environment to enable it.",
    });
    return;
  }

  const key = req.headers["x-upload-key"] || "";
  if (key !== UPLOAD_API_KEY) {
    res.status(401).json({ error: "Invalid upload key" });
    return;
  }

  // Accept either raw CSV text in body, or a base64-encoded CSV
  const contentType = req.headers["content-type"] || "";
  let csvContent = "";

  if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
    // Raw text body - express.json() won't parse this, read raw
    csvContent = await readRawBody(req);
  } else if (req.body && req.body.csv_base64) {
    // JSON body with base64-encoded CSV
    csvContent = Buffer.from(req.body.csv_base64, "base64").toString("utf-8");
  } else if (req.body && req.body.csv) {
    // JSON body with raw CSV string
    csvContent = req.body.csv;
  } else {
    res.status(400).json({
      error:
        "Provide CSV as: (a) raw text/csv body, (b) JSON {csv: '...'}, or (c) JSON {csv_base64: '...'}",
    });
    return;
  }

  if (!csvContent || csvContent.trim().length === 0) {
    res.status(400).json({ error: "CSV content is empty" });
    return;
  }

  // Determine write path
  const { config } = await import("./config.js");
  const targetPath = config.linkedinCsvPath;

  // Ensure directory exists
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    writeFileSync(targetPath, csvContent, "utf-8");
    log("info", `Connections CSV uploaded: ${csvContent.length} bytes -> ${targetPath}`);
    res.json({
      success: true,
      message: `Connections CSV saved to ${targetPath}`,
      bytes: csvContent.length,
    });
  } catch (err) {
    log("error", `CSV write failed: ${err.message}`);
    res.status(500).json({ error: `Failed to save CSV: ${err.message}` });
  }
});

// Helper: read raw body from request (for text/csv uploads)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// -----------------------------------------------------------------------
// 404 fallback
// -----------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: {
      mcp: "POST /mcp  (Streamable HTTP - claude.ai compatible)",
      sse: "GET /sse   (Legacy SSE transport)",
      messages: "POST /messages  (Legacy SSE message endpoint)",
      health: "GET /health",
      upload: "POST /upload/connections  (requires UPLOAD_API_KEY header)",
    },
  });
});

// -----------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------

const httpServer = createServer(app);

httpServer.listen(PORT, HOST, () => {
  log(
    "info",
    `claude-connector HTTP server listening on http://${HOST}:${PORT}`
  );
  log("info", `MCP endpoint (Streamable HTTP): http://${HOST}:${PORT}/mcp`);
  log("info", `MCP endpoint (Legacy SSE):       http://${HOST}:${PORT}/sse`);
  log("info", `Health check:                    http://${HOST}:${PORT}/health`);

  if (MCP_API_KEY) {
    log("info", "MCP API key authentication is ENABLED");
  } else {
    log(
      "warn",
      "MCP API key authentication is DISABLED. Set MCP_API_KEY in .env for production use."
    );
  }

  if (UPLOAD_API_KEY) {
    log("info", "CSV upload endpoint is ENABLED at POST /upload/connections");
  }
});

// Graceful shutdown
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function shutdown(signal) {
  log("info", `${signal} received, shutting down gracefully...`);
  httpServer.close(() => {
    log("info", "HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    log("warn", "Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}
