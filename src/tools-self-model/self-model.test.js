// src/tools-self-model/self-model.test.js
// Unit tests for the self-model intent classifier and query-plan builder.
// Runs with: node --test src/tools-self-model/self-model.test.js
// No native dependency required (pure logic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, buildQueryPlan, INTENTS } from "./intent.js";

// Expected intent -> the tables that plan must target.
const EXPECTED_TABLES = {
  module_activity:  ["module_activations", "session_log"],
  tool_activity:    ["tool_usage"],
  session_patterns: ["session_timing"],
  topic_history:    ["topic_clusters", "session_log"],
  module_gaps:      ["module_activations", "session_log"],
  self_trend:       ["self_insights", "session_log"],
};

test("classifyIntent maps the specification's example questions", () => {
  const cases = [
    ["What modules were most active this week?", "module_activity"],
    ["Which tools have I used most?", "tool_activity"],
    ["When do I usually work with Brian?", "session_patterns"],
    ["What topics have we covered?", "topic_history"],
    ["Which modules have never been activated?", "module_gaps"],
    ["Is my response quality changing?", "self_trend"],
  ];
  for (const [query, expected] of cases) {
    assert.equal(classifyIntent(query), expected, `query: ${query}`);
  }
});

test("classifyIntent returns null for empty or unrelated input", () => {
  assert.equal(classifyIntent(""), null);
  assert.equal(classifyIntent("   "), null);
  assert.equal(classifyIntent("what is the capital of France"), null);
});

test("module_gaps is preferred over module_activity when 'never activated' present", () => {
  assert.equal(classifyIntent("which modules have never been activated"), "module_gaps");
  assert.equal(classifyIntent("show me unused modules"), "module_gaps");
});

test("buildQueryPlan targets the correct tables for every intent", () => {
  for (const intent of INTENTS) {
    const plan = buildQueryPlan(intent, {});
    assert.ok(plan, `plan exists for ${intent}`);
    assert.equal(plan.intent, intent);
    assert.deepEqual(
      plan.tables.slice().sort(),
      EXPECTED_TABLES[intent].slice().sort(),
      `tables for ${intent}`
    );
    assert.equal(typeof plan.sql, "string");
    assert.ok(plan.sql.trim().length > 0, `sql non-empty for ${intent}`);
  }
});

test("buildQueryPlan binds only numeric window/limit params, never raw text", () => {
  const plan = buildQueryPlan("tool_activity", { windowDays: 7, limit: 5 });
  assert.equal(plan.params.limit, 5);
  assert.match(plan.params.cutoff, /^\d{4}-\d{2}-\d{2}T/);
  // Only cutoff and limit are bound. No user text is present as a param.
  assert.deepEqual(Object.keys(plan.params).sort(), ["cutoff", "limit"]);
});

test("buildQueryPlan clamps out-of-range window and limit", () => {
  const tooBig = buildQueryPlan("module_activity", { windowDays: 999999, limit: 999999 });
  assert.equal(tooBig.params.limit, 200);
  const tooSmall = buildQueryPlan("module_activity", { windowDays: -5, limit: 0 });
  assert.equal(tooSmall.params.limit, 1);
});

test("buildQueryPlan returns null for an unknown intent", () => {
  assert.equal(buildQueryPlan("not_an_intent", {}), null);
});
