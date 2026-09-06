// src/tests/memory-tiered-passthrough.test.js
//
// SPEC-2026-09-06 Section 3.5, Phase 1 close-out Gate 2 (connector half).
//
// ── The defect this exists to prevent recurring ─────────────────────────
//
// handleWpMemoryGetSessionContext returns an explicit field whitelist, not a
// spread of the gateway's response. When the gateway added `tiered` -- the
// per-entry retrieval_tier and matched_terms array that is the whole point of
// the tiering work -- the connector assembled nothing, logged nothing, and
// simply did not copy the field across. The array was built by the gateway,
// serialised, sent over the wire, and discarded one function short of the
// model.
//
// Unit tests on BOTH sides passed. The gateway's tests asserted it emitted
// `tiered`; the connector's tests asserted the six fields it forwarded. Neither
// side owned the question "does the field arrive". That gap is the reason this
// file is a CONTRACT test rather than another unit test: it pins the boundary,
// which is the thing neither unit suite covers.
//
// ── Why it fetches rather than mocking the module ───────────────────────
//
// wpFetch is module-private, so the handler is exercised against a real local
// HTTP server standing in for the gateway. That means the assertion covers the
// actual code path -- schema validation, URL building, fetch, response mapping
// -- rather than a re-implementation of it. A test that re-implemented the
// mapping would have passed against the broken original.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { handleWpMemoryGetSessionContext } from "../tools-memory/wp-memory.js";

let server = null;
let lastPath = "";

/**
 * The response a tiering-enabled gateway returns, transcribed from
 * gateway routes/memory.js POST /memory/session-context.
 */
const GATEWAY_RESPONSE = {
  context: "## identity\n- name: Ava\n## conversations\n- conv_exact: the synthetic body question",
  assembled_at: "2026-09-08T00:00:00.000Z",
  entry_count: 4,
  context_hint: "synthetic body",
  conversations_mode: "context-hint",
  conversations_tiers: { exact: 1, related: 1, associative: 1, recency: 1 },
  tiered: [
    {
      category: "conversations",
      key: "conv_exact",
      value: "the synthetic body question",
      retrieval_tier: 1,
      tier_label: "exact",
      matched_terms: ["synthetic", "body"],
      tags: ["embodiment", "mind"],
    },
    {
      category: "conversations",
      key: "conv_assoc",
      value: "notes on gardening",
      retrieval_tier: 3,
      tier_label: "associative",
      matched_terms: ["mind"],
      tags: ["mind"],
    },
  ],
};

/** Response shape of a gateway that predates the tiering work. */
const LEGACY_RESPONSE = {
  context: "## identity\n- name: Ava",
  assembled_at: "2026-09-08T00:00:00.000Z",
  entry_count: 1,
  context_hint: null,
  conversations_mode: "recency",
  conversations_tiers: { exact: 0, related: 0, associative: 0, recency: 1 },
};

let payload = GATEWAY_RESPONSE;

before(async () => {
  server = createServer((req, res) => {
    lastPath = req.url;
    // Drain the body so the socket closes cleanly.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  // Tenant mode: memory calls route to the gateway's /memory/* endpoints.
  process.env.TS_CLIENT_MODE = "tenant";
  process.env.TS_TENANT_GATEWAY_URL = `http://127.0.0.1:${port}`;
  process.env.TS_CLIENT_API_KEY = "test-key-not-a-secret";
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.TS_CLIENT_MODE;
  delete process.env.TS_TENANT_GATEWAY_URL;
  delete process.env.TS_CLIENT_API_KEY;
});

test("the tiered array survives the response whitelist", async () => {
  payload = GATEWAY_RESPONSE;

  const result = await handleWpMemoryGetSessionContext({
    context_hint: "synthetic body",
  });

  assert.ok(Array.isArray(result.tiered), "tiered must be forwarded");
  assert.equal(result.tiered.length, 2, "every record must arrive, not just the first");
});

test("per-entry tier information arrives intact, not merely present", async () => {
  payload = GATEWAY_RESPONSE;

  const result = await handleWpMemoryGetSessionContext({
    context_hint: "synthetic body",
  });

  // Asserting that the array is non-empty would pass on an array of empty
  // objects. The model needs the tier and the reason, so both are checked.
  const exact = result.tiered.find((r) => r.key === "conv_exact");
  assert.ok(exact, "the Tier 1 record must reach the caller");
  assert.equal(exact.retrieval_tier, 1);
  assert.equal(exact.tier_label, "exact");
  assert.deepEqual(exact.matched_terms, ["synthetic", "body"]);

  const assoc = result.tiered.find((r) => r.key === "conv_assoc");
  assert.equal(assoc.retrieval_tier, 3);
  // A Tier 3 record matched no query token; its justification is the shared
  // tag, and a record whose justification is not inspectable is the opaque
  // dump the spec's Section 4.2 exists to prevent.
  assert.deepEqual(assoc.matched_terms, ["mind"]);
});

test("the honest tier counters survive the whitelist", async () => {
  payload = GATEWAY_RESPONSE;

  const result = await handleWpMemoryGetSessionContext({ context_hint: "synthetic body" });

  // related and associative were hardcoded zeros before the fix. If the
  // whitelist ever substitutes its own default object for the gateway's real
  // counters, these regress to zero and this fails.
  assert.equal(result.conversations_tiers.related, 1);
  assert.equal(result.conversations_tiers.associative, 1);
  assert.equal(result.conversations_mode, "context-hint");
});

test("a pre-tiering gateway yields an empty array, not undefined", async () => {
  payload = LEGACY_RESPONSE;

  const result = await handleWpMemoryGetSessionContext({});

  // A missing key would force every caller to guard. An empty array is
  // readable on every path. This is also the shape the WordPress memory
  // router returns, since it has not been ported.
  assert.ok(Array.isArray(result.tiered));
  assert.equal(result.tiered.length, 0);
  assert.equal(result.conversations_mode, "recency");
});

test("the hint is forwarded to the gateway as a query parameter", async () => {
  payload = GATEWAY_RESPONSE;

  await handleWpMemoryGetSessionContext({
    context_hint: "synthetic body",
    conversations_limit: 7,
  });

  // The matcher cannot tier on a hint it never receives. This pins the request
  // half of the boundary, not just the response half.
  assert.ok(lastPath.includes("context_hint=synthetic+body")
    || lastPath.includes("context_hint=synthetic%20body"), lastPath);
  assert.ok(lastPath.includes("conversations_limit=7"), lastPath);
});
