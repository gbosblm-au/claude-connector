// src/tools-self-model/identity-scoping.test.js
//
// End-to-end test of per-user-per-tenant identity scoping in the self-model
// recording path. Exercises the real hook + recorder against a temp SQLite DB,
// with global.fetch mocked to capture the gateway /ingest POST bodies.
//
// Guards the fix for: self_model rows written with null user_id/tenant_id.
// The identity must come from the per-call context the gateway supplies, be
// concurrency-safe (each call self-identifies), and never be hardcoded from
// environment variables.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// Env must be set BEFORE importing the modules (recorder reads GATEWAY_URL /
// GATEWAY_ADMIN_KEY at module load, db resolves the path lazily).
const DB_PATH = join(tmpdir(), `self-model-test-${randomUUID()}.db`);
process.env.SELF_MODEL_DB_PATH = DB_PATH;
process.env.SELF_MODEL_ENABLED = "true";
process.env.GATEWAY_URL = "http://gateway.test.local";
process.env.GATEWAY_ADMIN_KEY = "test-admin-key";
// Deliberately set the rejected hardcode env vars to prove they are NOT used.
process.env.TENANT_ID = "ts_HARDCODED_SHOULD_NOT_APPEAR";
process.env.USER_ID = "999999";

let hook, sessionCtx, dbmod;
let posts = [];

before(async () => {
  hook = await import("./hook.js");
  sessionCtx = await import("./sessionContext.js");
  dbmod = await import("./db.js");
});

beforeEach(() => {
  posts = [];
  // gatewayIngest calls fetch() synchronously; capture the parsed body.
  global.fetch = (url, opts) => {
    try {
      posts.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    } catch { /* ignore */ }
    return Promise.resolve({ ok: true, status: 200 });
  };
  if (sessionCtx._resetSessionContext) sessionCtx._resetSessionContext();
});

after(() => {
  try { dbmod.closeSelfModelDb && dbmod.closeSelfModelDb(); } catch {}
  for (const ext of ["", "-wal", "-shm"]) {
    try { rmSync(DB_PATH + ext, { force: true }); } catch {}
  }
});

const CTX = { tenant_id: "ts_50f3be57", user_id: "8" };

function postsFor(eventType) {
  return posts.filter(p => p.body && p.body.event_type === eventType);
}

test("resolveRecordingIdentity: per-call context is authoritative", () => {
  const id = hook.resolveRecordingIdentity(CTX);
  assert.strictEqual(id.tenantId, "ts_50f3be57");
  assert.strictEqual(id.userId, "8");
});

test("resolveRecordingIdentity: falls back to session context when no per-call context", () => {
  sessionCtx.setCurrentUser("ts_fallback", "42");
  const id = hook.resolveRecordingIdentity(null);
  assert.strictEqual(id.tenantId, "ts_fallback");
  assert.strictEqual(id.userId, "42");
});

test("resolveRecordingIdentity: never falls back to env hardcode", () => {
  // No context, no session identity set -> nulls, NOT the TENANT_ID/USER_ID env.
  const id = hook.resolveRecordingIdentity(null);
  assert.strictEqual(id.tenantId, null);
  assert.strictEqual(id.userId, null);
});

test("a proxied tool call ingests tool + session with the context identity", () => {
  hook.selfModelRecordToolCall("memory_search", { query: "x" }, { content: [] }, Date.now() - 5, CTX);

  const tool = postsFor("tool");
  const session = postsFor("session");
  assert.ok(tool.length >= 1, "a tool event must be posted");
  assert.ok(session.length >= 1, "a session event must be posted");

  for (const p of [...tool, ...session]) {
    assert.strictEqual(p.body.tenant_id, "ts_50f3be57", "tenant_id must be the context tenant");
    assert.strictEqual(p.body.user_id, "8", "user_id must be the context user");
    assert.strictEqual(p.headers["X-Admin-Key"], "test-admin-key");
  }
  // The rejected env hardcode must never surface.
  assert.ok(!posts.some(p => p.body.tenant_id === "ts_HARDCODED_SHOULD_NOT_APPEAR"));
  assert.ok(!posts.some(p => p.body.user_id === "999999"));
});

test("skill_compile ingests module + compile events scoped to the context identity", () => {
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify({
        modules_loaded: ["teaching-core", "diagnostic"],
        compile_time_ms: 120,
        manifest_version: "5.40.0",
      }),
    }],
  };
  hook.selfModelRecordToolCall("skill_compile", {}, result, Date.now() - 10, CTX);

  const modules = postsFor("module");
  const compile = postsFor("compile");
  assert.strictEqual(modules.length, 2, "one module event per loaded module");
  assert.ok(compile.length >= 1, "a compile event must be posted");
  for (const p of [...modules, ...compile]) {
    assert.strictEqual(p.body.tenant_id, "ts_50f3be57");
    assert.strictEqual(p.body.user_id, "8");
  }
  assert.deepStrictEqual(
    modules.map(m => m.body.data.module_id).sort(),
    ["diagnostic", "teaching-core"]
  );
});

test("session-init seeds session context from per-call context for later no-context calls", () => {
  const initResult = {
    content: [{ type: "text", text: JSON.stringify({ session_authenticated: true, tenant_id: "ts_50f3be57", user_id: null }) }],
  };
  // Even though the session-init RESULT has user_id null, the per-call context
  // carries the real user, which must seed the session context.
  hook.selfModelRecordToolCall("ts_gateway_session_init", {}, initResult, Date.now() - 2, CTX);

  const seeded = sessionCtx.getCurrentUser();
  assert.strictEqual(seeded.tenantId, "ts_50f3be57");
  assert.strictEqual(seeded.userId, "8");

  // A subsequent tool call with NO context now falls back to the seeded identity.
  posts = [];
  hook.selfModelRecordToolCall("web_search", { query: "y" }, { content: [] }, Date.now() - 3, null);
  const tool = postsFor("tool");
  assert.ok(tool.length >= 1);
  assert.strictEqual(tool[0].body.tenant_id, "ts_50f3be57");
  assert.strictEqual(tool[0].body.user_id, "8");
});

test("two interleaved users do not contaminate each other (per-call scoping)", () => {
  const userA = { tenant_id: "ts_A", user_id: "1" };
  const userB = { tenant_id: "ts_B", user_id: "2" };

  hook.selfModelRecordToolCall("memory_search", {}, { content: [] }, Date.now() - 1, userA);
  hook.selfModelRecordToolCall("memory_search", {}, { content: [] }, Date.now() - 1, userB);
  hook.selfModelRecordToolCall("memory_search", {}, { content: [] }, Date.now() - 1, userA);

  const toolPosts = postsFor("tool");
  assert.strictEqual(toolPosts.filter(p => p.body.user_id === "1").length, 2);
  assert.strictEqual(toolPosts.filter(p => p.body.user_id === "2").length, 1);
  // No record leaked the other user's tenant.
  for (const p of toolPosts) {
    if (p.body.user_id === "1") assert.strictEqual(p.body.tenant_id, "ts_A");
    if (p.body.user_id === "2") assert.strictEqual(p.body.tenant_id, "ts_B");
  }
});
