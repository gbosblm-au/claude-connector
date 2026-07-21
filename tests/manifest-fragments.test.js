/**
 * tests/manifest-fragments.test.js
 *
 * Covers src/tools/manifest-fragments.js (v12.21.0).
 *
 * The behaviour under test is the 2026-07-21 production failure: a module
 * written to modules/travel/ that MANIFEST.json never learned about, leaving
 * skill_compile unable to select it. Registration is now structural:
 * module_write writes a fragment, and the compile/load/scan paths read the
 * merged view.
 *
 * Run:  node --test tests/manifest-fragments.test.js
 */

import test   from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifestFragments, mergeFragmentsIntoManifest, fragmentDispatchToLinkages,
  loadMergedManifest, deriveModuleEntry, writeModuleFragment, inferModulePath,
  fragmentsDirFor,
} from '../src/tools/manifest-fragments.js';

function makeAva() {
  const avaDir = mkdtempSync(join(tmpdir(), 'ava-'));
  mkdirSync(join(avaDir, 'references', 'manifest'), { recursive: true });
  mkdirSync(join(avaDir, 'modules', 'travel'), { recursive: true });
  writeFileSync(join(avaDir, 'MANIFEST.json'), JSON.stringify({
    manifest_version: '3.0',
    modules: [{ id: 'core-identity', path: 'modules/core/core-identity.md', always_load: true }],
    mandatory_for_triggers: { code: ['code-standards'] },
    tag_web: { travel: ['flights'] },
    budget: {},
  }));
  return avaDir;
}
const readJsonFile = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};
const pathsFor = (avaDir) => ({
  avaDir: avaDir + '/',
  manifestFile: join(avaDir, 'MANIFEST.json'),
  manifestAppendFile: join(avaDir, 'MANIFEST_APPEND.json'),
});

// The shipped 70-travel.json shape: module entry WITHOUT a path field.
const TRAVEL_FRAGMENT = {
  manifest_append_version: '1.12',
  source: 'travel',
  modules: [{
    id: 'travel-master-dispatch',
    title: 'Travel & Holiday Planning Engine',
    category: 'travel',
    load_priority: 5,
    triggers: { keywords: ['travel', 'flights'], phrases: ['plan a trip to'], task_class: ['flight_search'] },
    load_strategy: 'on_demand',
  }],
  references: [{ file: 'travel/travel-ui-sidebar-spec.md', title: 'Travel UI Spec' }],
  dispatch_rules: [{
    id: 'rule-travel-planning-001',
    trigger_patterns: { keywords: ['travel', 'flights'], phrases: ['plan a trip to'] },
    module_to_add: 'travel-master-dispatch',
    confidence: 0.9,
  }],
};

// ── Reading ─────────────────────────────────────────────────────────────────

test('fragments are read in filename order; placeholders and bad JSON degrade only themselves', () => {
  const ava = makeAva();
  const dir = fragmentsDirFor(ava);
  writeFileSync(join(dir, '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT));
  writeFileSync(join(dir, '10-social.json'), JSON.stringify({ source: 'social', modules: [{ id: 'social-core' }] }));
  writeFileSync(join(dir, '90-broken.json'), '{not json');
  writeFileSync(join(dir, '95-deprecated.json'), JSON.stringify({ deprecated: true, note: 'moved' }));
  writeFileSync(join(dir, 'MANIFEST_DIRECTORY_PROTOCOL.md'), '# protocol');

  const { fragments, skipped } = loadManifestFragments(ava);
  assert.deepEqual(fragments.map(f => f.file), ['10-social.json', '70-travel.json']);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.find(s => s.file === '90-broken.json'));
  assert.ok(skipped.find(s => s.file === '95-deprecated.json'));
});

// ── Merging (THE FIX) ───────────────────────────────────────────────────────

test('THE FIX: a fragment-registered module becomes visible to the compile merge', () => {
  const ava = makeAva();
  writeFileSync(join(ava, 'modules', 'travel', 'travel-master-dispatch.md'), '# Travel Engine\nbody');
  writeFileSync(join(fragmentsDirFor(ava), '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT));

  const { manifest, fragmentStats } = loadMergedManifest(pathsFor(ava), readJsonFile);
  const ids = manifest.modules.map(m => m.id);
  assert.ok(ids.includes('travel-master-dispatch'), 'fragment module registered');
  assert.ok(ids.includes('core-identity'), 'MANIFEST modules untouched');
  assert.deepEqual(fragmentStats.added, ['travel-master-dispatch']);
});

test('missing path is inferred with an existence check (the 70-travel.json latent bug)', () => {
  const ava = makeAva();
  writeFileSync(join(ava, 'modules', 'travel', 'travel-master-dispatch.md'), '# Travel Engine');
  writeFileSync(join(fragmentsDirFor(ava), '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT));

  const { manifest, fragmentStats } = loadMergedManifest(pathsFor(ava), readJsonFile);
  const mod = manifest.modules.find(m => m.id === 'travel-master-dispatch');
  assert.equal(mod.path, 'modules/travel/travel-master-dispatch.md', 'path inferred from category/id');
  assert.deepEqual(fragmentStats.pathInferred, ['travel-master-dispatch']);
  assert.equal(mod._source_fragment, '70-travel.json', 'provenance recorded');
});

test('a module with no path and no matching file is registered but flagged, never guessed', () => {
  const ava = makeAva();
  writeFileSync(join(fragmentsDirFor(ava), '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT)); // no .md on disk
  const { manifest, fragmentStats } = loadMergedManifest(pathsFor(ava), readJsonFile);
  const mod = manifest.modules.find(m => m.id === 'travel-master-dispatch');
  assert.equal(mod.path, undefined);
  assert.deepEqual(fragmentStats.pathMissing, ['travel-master-dispatch']);
});

test('MANIFEST and MANIFEST_APPEND always win over fragments (first-definition-wins)', () => {
  const ava = makeAva();
  writeFileSync(join(ava, 'MANIFEST_APPEND.json'), JSON.stringify({
    modules: [{ id: 'travel-master-dispatch', path: 'modules/travel/override.md', title: 'Append version' }],
  }));
  writeFileSync(join(fragmentsDirFor(ava), '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT));
  const { manifest, fragmentStats } = loadMergedManifest(pathsFor(ava), readJsonFile);
  const mods = manifest.modules.filter(m => m.id === 'travel-master-dispatch');
  assert.equal(mods.length, 1, 'no duplicates');
  assert.equal(mods[0].title, 'Append version', 'APPEND entry took priority');
  assert.deepEqual(fragmentStats.skippedExisting, ['travel-master-dispatch']);
});

test('mandatory_for_triggers union and tag_web add-new match compile semantics', () => {
  const ava = makeAva();
  writeFileSync(join(fragmentsDirFor(ava), '20-x.json'), JSON.stringify({
    source: 'x',
    modules: [{ id: 'x-core', path: 'modules/x.md' }],
    mandatory_for_triggers: { code: ['x-core'], newcond: ['x-core'] },
    tag_web: { travel: ['SHOULD-NOT-OVERRIDE'], newtag: ['fresh'] },
  }));
  const { manifest } = loadMergedManifest(pathsFor(ava), readJsonFile);
  assert.deepEqual(manifest.mandatory_for_triggers.code, ['code-standards', 'x-core'], 'union, no dupes');
  assert.deepEqual(manifest.mandatory_for_triggers.newcond, ['x-core']);
  assert.deepEqual(manifest.tag_web.travel, ['flights'], 'existing tag not overridden');
  assert.deepEqual(manifest.tag_web.newtag, ['fresh']);
});

// ── Dispatch rule conversion ────────────────────────────────────────────────

test('fragment dispatch_rules convert to the flat string-array shape applyLearnedLinkages consumes', () => {
  const ava = makeAva();
  writeFileSync(join(fragmentsDirFor(ava), '70-travel.json'), JSON.stringify(TRAVEL_FRAGMENT));
  const { fragmentLinkages } = loadMergedManifest(pathsFor(ava), readJsonFile);
  assert.equal(fragmentLinkages.length, 1);
  const rule = fragmentLinkages[0];
  assert.equal(rule.id, 'rule-travel-planning-001');
  assert.equal(rule.module_to_add, 'travel-master-dispatch');
  assert.ok(Array.isArray(rule.trigger_patterns), 'trigger_patterns is an ARRAY');
  assert.ok(rule.trigger_patterns.every(p => typeof p === 'string'), 'of strings');
  assert.ok(rule.trigger_patterns.includes('plan a trip to'), 'phrases flattened in');
  assert.equal(rule.confidence, 0.9);
  // Prove it actually fires through the consumer's logic shape:
  const queryLower = 'can you plan a trip to vietnam';
  assert.ok(rule.trigger_patterns.some(p => queryLower.includes(p.toLowerCase())), 'rule fires on a travel query');
});

test('already-flat trigger_patterns arrays and missing confidence are handled', () => {
  const linkages = fragmentDispatchToLinkages([{
    file: 'f.json', source: 'f',
    dispatch_rules: [
      { id: 'a', trigger_patterns: ['one', 'two'], module_to_add: 'm1' },
      { id: 'b', trigger_patterns: {}, module_to_add: 'm2' },           // no patterns -> dropped
      { id: 'c', trigger_patterns: ['x'] },                             // no module -> dropped
    ],
  }]);
  assert.equal(linkages.length, 1);
  assert.equal(linkages[0].confidence, 0.7, 'default confidence in valid range');
});

// ── module_write registration path ──────────────────────────────────────────

test('deriveModuleEntry produces a dispatchable entry from path and content alone', () => {
  const entry = deriveModuleEntry('travel/travel-master-dispatch.md', '# Travel & Holiday Planning Engine\n\nBody line');
  assert.equal(entry.id, 'travel-master-dispatch');
  assert.equal(entry.category, 'travel');
  assert.equal(entry.path, 'modules/travel/travel-master-dispatch.md');
  assert.equal(entry.title, 'Travel & Holiday Planning Engine');
  assert.ok(entry.triggers.keywords.includes('travel'));
  assert.equal(entry.load_strategy, 'on_demand');
  assert.equal(entry.always_load, false);
});

test('caller manifest_entry overrides derived fields but can never blank id/path', () => {
  const entry = deriveModuleEntry('travel/x.md', '# X', {
    title: 'Custom', load_priority: 9, triggers: { keywords: ['custom'] }, id: '', path: '',
  });
  assert.equal(entry.title, 'Custom');
  assert.equal(entry.load_priority, 9);
  assert.deepEqual(entry.triggers.keywords, ['custom'], 'provided triggers override');
  assert.deepEqual(entry.triggers.phrases, [], 'unprovided trigger keys keep derived defaults');
  assert.equal(entry.id, 'x', 'id restored');
  assert.equal(entry.path, 'modules/travel/x.md', 'path restored');
});

test('writeModuleFragment creates a new prefixed fragment, then upserts into it', () => {
  const ava = makeAva();
  writeFileSync(join(fragmentsDirFor(ava), '10-social.json'), JSON.stringify({ source: 'social', modules: [{ id: 's' }] }));

  const entry = deriveModuleEntry('travel/travel-master-dispatch.md', '# Travel Engine');
  const first = writeModuleFragment(ava, entry, { trigger_patterns: { keywords: ['travel'] }, module_to_add: entry.id, confidence: 0.9 });
  assert.equal(first.action, 'created');
  assert.equal(first.file, '20-travel.json', 'prefix auto-increments past existing 10-');
  assert.equal(first.module_action, 'added');

  const written = JSON.parse(readFileSync(join(fragmentsDirFor(ava), '20-travel.json'), 'utf8'));
  assert.equal(written.source, 'travel');
  assert.equal(written.modules[0].id, 'travel-master-dispatch');
  assert.equal(written.dispatch_rules[0].id, 'rule-travel-master-dispatch', 'rule id defaulted');

  // Second write for the same category and id updates in place — no duplicate file, no duplicate entry.
  const entry2 = { ...entry, title: 'Updated title' };
  const second = writeModuleFragment(ava, entry2);
  assert.equal(second.action, 'updated');
  assert.equal(second.file, '20-travel.json');
  assert.equal(second.module_action, 'replaced');
  const rewritten = JSON.parse(readFileSync(join(fragmentsDirFor(ava), '20-travel.json'), 'utf8'));
  assert.equal(rewritten.modules.length, 1);
  assert.equal(rewritten.modules[0].title, 'Updated title');
});

test('end-to-end: writeModuleFragment output is immediately selectable by the merged view', () => {
  const ava = makeAva();
  writeFileSync(join(ava, 'modules', 'travel', 'new-module.md'), '# New Module');
  const entry = deriveModuleEntry('travel/new-module.md', '# New Module');
  writeModuleFragment(ava, entry);

  const { manifest } = loadMergedManifest(pathsFor(ava), readJsonFile);
  const mod = manifest.modules.find(m => m.id === 'new-module');
  assert.ok(mod, 'registered module visible to compile');
  assert.equal(mod.path, 'modules/travel/new-module.md');
  assert.ok(existsSync(join(ava, mod.path)), 'and its body loads from that path');
});

test('inferModulePath falls back to modules/{id}.md and returns null when nothing exists', () => {
  const ava = makeAva();
  writeFileSync(join(ava, 'modules', 'flat.md'), '# Flat');
  assert.equal(inferModulePath(ava, { id: 'flat' }), 'modules/flat.md');
  assert.equal(inferModulePath(ava, { id: 'ghost', category: 'nowhere' }), null);
});
