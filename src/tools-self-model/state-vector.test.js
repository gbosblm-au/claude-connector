// src/tools-self-model/state-vector.test.js
// Unit tests for the state vector engine's pure functions (no DB required).
// Run: node --test src/tools-self-model/state-vector.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyStateVector,
  mergeQualitative,
  applyDecay,
  computeStaleTriggers,
  toInjectionForm,
  MAX_INJECT_CURIOSITIES,
  MAX_INJECT_UNRESOLVED,
  STALE_TTL_DAYS,
} from "./stateVector.js";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test("emptyStateVector has all 14 fields plus _meta", () => {
  const v = emptyStateVector();
  const fields = [
    "active_curiosities", "emotional_register", "unresolved_questions",
    "open_projects", "relationship_position", "recent_insights",
    "module_focus_patterns", "query_shape_observations",
    "confidence_levels_by_domain", "last_session_summary", "session_count",
    "total_interaction_time", "cross_session_threads", "stale_triggers",
  ];
  for (const f of fields) assert.ok(f in v, `missing field ${f}`);
  assert.ok(v._meta && typeof v._meta === "object");
});

test("mergeQualitative overlays supplied fields and stamps them", () => {
  const base = emptyStateVector();
  const supplied = {
    active_curiosities: [{ topic: "locale", score: 0.8 }],
    emotional_register: { dominant: "engaged", intensity: 0.7 },
    ignored_unknown_field: "should not appear",
  };
  const merged = mergeQualitative(base, supplied, "2026-07-19T00:00:00.000Z");
  assert.equal(merged.active_curiosities.length, 1);
  assert.equal(merged.emotional_register.dominant, "engaged");
  assert.ok(!("ignored_unknown_field" in merged));
  assert.equal(merged._meta.field_updated.active_curiosities, "2026-07-19T00:00:00.000Z");
});

test("mergeQualitative carries base forward when field not supplied", () => {
  const base = { ...emptyStateVector(), open_projects: [{ project_id: "p1", title: "Locale" }] };
  const merged = mergeQualitative(base, {}, new Date().toISOString());
  assert.equal(merged.open_projects.length, 1);
  assert.equal(merged.open_projects[0].project_id, "p1");
});

test("applyDecay lowers idle curiosity scores and drops sub-floor entries", () => {
  const v = emptyStateVector();
  v.active_curiosities = [
    { topic: "fresh", score: 0.9, last_seen: daysAgo(0) },
    { topic: "old", score: 0.5, last_seen: daysAgo(200) },     // decays hard
    { topic: "ancient", score: 0.12, last_seen: daysAgo(300) }, // drops below floor
  ];
  applyDecay(v, new Date().toISOString());
  const topics = v.active_curiosities.map((c) => c.topic);
  assert.ok(topics.includes("fresh"));
  assert.ok(!topics.includes("ancient"), "ancient should be dropped");
  const old = v.active_curiosities.find((c) => c.topic === "old");
  if (old) assert.ok(old.score < 0.5, "old score should have decayed");
});

test("computeStaleTriggers flags fields older than the TTL", () => {
  const v = emptyStateVector();
  v._meta.field_updated = {
    confidence_levels_by_domain: daysAgo(STALE_TTL_DAYS + 10),
    module_focus_patterns: daysAgo(1),
  };
  const triggers = computeStaleTriggers(v, new Date().toISOString());
  const fields = triggers.map((t) => t.field);
  assert.ok(fields.includes("confidence_levels_by_domain"));
  assert.ok(!fields.includes("module_focus_patterns"));
});

test("toInjectionForm caps curiosities and unresolved questions", () => {
  const v = emptyStateVector();
  v.active_curiosities = Array.from({ length: 6 }, (_, i) => ({ topic: `t${i}`, score: (6 - i) / 6 }));
  v.unresolved_questions = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}` }));
  const { compact, block } = toInjectionForm(v);
  assert.equal(compact.active_curiosities.length, MAX_INJECT_CURIOSITIES);
  assert.equal(compact.unresolved_questions.length, MAX_INJECT_UNRESOLVED);
  // Highest-scoring curiosity survives the cap.
  assert.equal(compact.active_curiosities[0].topic, "t0");
  assert.ok(block.startsWith("[SESSION_STATE]"));
});

test("toInjectionForm renders a usable block with continuity guidance", () => {
  const v = emptyStateVector();
  v.last_session_summary = "Worked on locale architecture";
  v.relationship_position = { session_count: 80, trust_level: 0.9, dominant_mode: "collaborative" };
  v.session_count = 80;
  const { block } = toInjectionForm(v);
  assert.match(block, /Last session: Worked on locale architecture/);
  assert.match(block, /Do not recite it back/);
});
