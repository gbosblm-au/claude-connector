// src/tools/post-session.test.js
// Unit tests for the post-session knowledge-graph extraction and quality-scoring
// tool normalisers. Pure logic, no gateway. Run:
//   node --test src/tools/post-session.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction } from './knowledgeGraph.js';
import { normalizeQuality } from './qualityScore.js';

// ── knowledge extraction ─────────────────────────────────────────────────────

test('normalizeExtraction keeps valid entities, dedupes, defaults external_id', () => {
  const out = normalizeExtraction({
    entities: [
      { type: 'topic', label: 'Pricing' },
      { type: 'topic', label: 'Pricing' },                 // dup
      { type: 'invalid', label: 'X' },                     // bad type
      { type: 'person', label: '' },                       // no label
      { type: 'document', label: 'Q3 Report', external_id: 'doc_9' },
    ],
  });
  assert.equal(out.entities.length, 2);
  assert.equal(out.entities[0].external_id, 'topic:pricing');
  assert.equal(out.entities[1].external_id, 'doc_9');
});

test('normalizeExtraction keeps only relationships between known entities', () => {
  const out = normalizeExtraction({
    entities: [
      { type: 'topic', label: 'Pricing', external_id: 'topic:pricing' },
      { type: 'person', label: 'Sarah', external_id: 'person:sarah' },
    ],
    relationships: [
      { source: 'topic:pricing', target: 'person:sarah', type: 'Discussed_With' },
      { source: 'topic:pricing', target: 'ghost' },        // unknown target
      { source: 'topic:pricing', target: 'topic:pricing' },// self
      { source: 'Sarah', target: 'Pricing' },              // by label (case-insensitive)
    ],
  });
  assert.equal(out.relationships.length, 2);
  assert.equal(out.relationships[0].type, 'discussed_with', 'edge type lowercased');
});

test('normalizeExtraction caps entity count', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ type: 'topic', label: 'T' + i }));
  const out = normalizeExtraction({ entities: many });
  assert.ok(out.entities.length <= 60, 'entity cap enforced');
});

test('normalizeExtraction tolerates missing/garbage input', () => {
  assert.deepEqual(normalizeExtraction(undefined), { entities: [], relationships: [] });
  assert.deepEqual(normalizeExtraction({ entities: 'nope' }), { entities: [], relationships: [] });
});

// ── quality scoring ──────────────────────────────────────────────────────────

test('normalizeQuality clamps components to 0..1', () => {
  const out = normalizeQuality({ components: { tvrl_coverage: 1.5, response_coherence: -0.2, memory_accuracy: 0.6, unknown_key: 0.9 } });
  assert.equal(out.components.tvrl_coverage, 1);
  assert.equal(out.components.response_coherence, 0);
  assert.equal(out.components.memory_accuracy, 0.6);
  assert.equal('unknown_key' in out.components, false, 'unknown component dropped');
});

test('normalizeQuality coerces signals to booleans/number', () => {
  const out = normalizeQuality({ components: {}, signals: { hallucination_rate: 2, user_reported_issue: true, tvrl_critical_failed: 'yes' } });
  assert.equal(out.signals.hallucination_rate, 1, 'rate clamped');
  assert.equal(out.signals.user_reported_issue, true);
  assert.equal(out.signals.tvrl_critical_failed, false, 'non-true coerced to false');
  assert.equal(out.signals.assistant_flagged_uncertainty, false);
});

test('normalizeQuality resolves consent: explicit arg wins', () => {
  assert.equal(normalizeQuality({ components: {}, consent: true }).consent, true);
  assert.equal(normalizeQuality({ components: {}, consent: false }).consent, false);
  // Absent consent falls back to the env default (unset in tests => false).
  assert.equal(normalizeQuality({ components: {} }).consent, false);
});

test('normalizeQuality passes through a trimmed session_id or null', () => {
  assert.equal(normalizeQuality({ components: {}, session_id: '  s1 ' }).session_id, 's1');
  assert.equal(normalizeQuality({ components: {} }).session_id, null);
});
