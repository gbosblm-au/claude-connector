// src/test-http.js
// Tests the HTTP server endpoints without needing real API keys.
// Starts the server on a random port, runs requests against it, shuts down.

import "dotenv/config";
import { createServer } from "http";
import express from "express";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: resp.status, body: json, headers: resp.headers };
}

console.log("\n=== claude-connector HTTP server tests ===\n");

// -----------------------------------------------------------------------
// Start a real HTTP server instance on a random available port
// -----------------------------------------------------------------------

// We import the express app logic inline rather than importing server-http.js
// (which would actually start the server) by replicating just what we need.

// We'll test by starting server-http.js in a child process and sending HTTP requests.

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use a non-default port so we don't collide with any running instance
const TEST_PORT = 13947;

const serverProc = spawn(
  "node",
  [join(__dirname, "server-http.js")],
  {
    env: { ...process.env, PORT: String(TEST_PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let serverReady = false;
let serverError = "";

serverProc.stderr.on("data", (d) => {
  const msg = d.toString();
  if (msg.includes("listening on")) serverReady = true;
  if (msg.includes("error") || msg.includes("Error")) serverError = msg;
});

// Wait for server to be ready (max 5 seconds)
await new Promise((resolve, reject) => {
  const start = Date.now();
  const check = setInterval(() => {
    if (serverReady) { clearInterval(check); resolve(); }
    if (Date.now() - start > 5000) {
      clearInterval(check);
      reject(new Error(`Server did not start in time. Error: ${serverError}`));
    }
  }, 50);
});

const BASE = `http://127.0.0.1:${TEST_PORT}`;

console.log(`Server started on port ${TEST_PORT}\n`);

// -----------------------------------------------------------------------
// Health endpoint
// -----------------------------------------------------------------------
console.log("-- Health endpoint --");

await test("GET /health returns 200", async () => {
  const { status, body } = await fetchJson(`${BASE}/health`);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.status === "ok", "status should be ok");
  assert(body.server === "claude-connector", "server name should match");
  assert(Array.isArray(body.transport), "transport should be an array");
});

// -----------------------------------------------------------------------
// 404 fallback
// -----------------------------------------------------------------------
console.log("\n-- 404 fallback --");

await test("GET /nonexistent returns 404 with endpoint list", async () => {
  const { status, body } = await fetchJson(`${BASE}/nonexistent`);
  assert(status === 404, `Expected 404, got ${status}`);
  assert(body.endpoints, "Should return endpoint list");
  assert(body.endpoints.mcp, "Should include /mcp endpoint");
});

// -----------------------------------------------------------------------
// CORS headers
// -----------------------------------------------------------------------
console.log("\n-- CORS headers --");

await test("OPTIONS /mcp returns correct CORS headers", async () => {
  const resp = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
  assert(resp.status === 204, `Expected 204, got ${resp.status}`);
  assert(
    resp.headers.get("access-control-allow-origin") === "*",
    "CORS origin should be *"
  );
  assert(
    resp.headers.get("access-control-allow-methods")?.includes("POST"),
    "CORS methods should include POST"
  );
});

// -----------------------------------------------------------------------
// MCP Streamable HTTP endpoint
// -----------------------------------------------------------------------
console.log("\n-- Streamable HTTP /mcp endpoint --");

await test("POST /mcp with initialize request returns valid session", async () => {
  const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };

  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(initRequest),
  });

  assert(resp.status === 200, `Expected 200, got ${resp.status}`);
  const sessionId = resp.headers.get("mcp-session-id");
  assert(sessionId, "Should return mcp-session-id header");

  // Parse response body
  const text = await resp.text();
  // Could be SSE format or JSON
  assert(text.length > 0, "Response should not be empty");
});

await test("POST /mcp without session and non-initialize request returns 400", async () => {
  const { status } = await fetchJson(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert(status === 400, `Expected 400, got ${status}`);
});

// -----------------------------------------------------------------------
// MCP tools/list via full session
// -----------------------------------------------------------------------
console.log("\n-- MCP tools/list via session --");

await test("Can list tools via initialized session", async () => {
  // Step 1: Initialize
  const initResp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
  const sessionId = initResp.headers.get("mcp-session-id");
  assert(sessionId, "Session ID must exist after init");

  // Step 2: List tools
  const listResp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert(listResp.status === 200, `Expected 200, got ${listResp.status}`);
  const text = await listResp.text();
  assert(text.includes("web_search"), "Should include web_search tool");
  assert(text.includes("news_search"), "Should include news_search tool");
  assert(text.includes("linkedin_search_connections"), "Should include linkedin tool");
});

// -----------------------------------------------------------------------
// Upload endpoint (disabled without key)
// -----------------------------------------------------------------------
console.log("\n-- Upload endpoint --");

await test("POST /upload/connections without key returns 403 when UPLOAD_API_KEY not set", async () => {
  const { status } = await fetchJson(`${BASE}/upload/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv: "First Name,Last Name\nAlice,Smith" }),
  });
  // With no UPLOAD_API_KEY set, should be 403 (disabled)
  assert(status === 403, `Expected 403, got ${status}`);
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

serverProc.kill("SIGTERM");

await new Promise((r) => setTimeout(r, 500));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
