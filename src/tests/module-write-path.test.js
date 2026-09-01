/**
 * src/tests/module-write-path.test.js
 *
 * SPEC-FIX-MODULE-WRITE-001 — the modules/ double-nesting bug.
 *
 * The bug: module_write's base already resolves to /data/skill/ava/modules/,
 * and the handler join()ed the caller's path onto it unchanged. So
 * 'modules/meta/x.md' landed at .../modules/modules/meta/x.md while
 * 'meta/x.md' landed at .../modules/meta/x.md. Both returned success.
 *
 * Why this file writes to a real temp volume rather than asserting on source
 * text: the defect was never visible in the shape of the code. Every line of
 * the old handler looked correct in isolation, and the only signal was which
 * physical file existed afterwards. A grep-style test would have passed against
 * the broken version. So these checks perform actual writes and then assert on
 * the resulting directory tree.
 *
 * WP backup is left unconfigured (no WP_SKILL_URL / WP_SKILL_KEY), so
 * pushContentToWp short-circuits to { skipped: true } and no network call is
 * attempted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0;
let fail = 0;

function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  PASS ${label}`); })
    .catch((e) => { fail += 1; console.error(`  FAIL ${label}: ${e.message}`); });
}

/** Parse the JSON body out of an MCP tool result. */
function body(result) {
  return JSON.parse(result.content[0].text);
}

/** Recursively collect every file path under a directory, base-relative. */
function walk(dir, base, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'module-write-'));
  // getContentPaths() derives everything from SKILL_FILE_PATH by stripping the
  // trailing SKILL.md, so this is the one knob that redirects the whole tool
  // at a temp volume.
  process.env.SKILL_FILE_PATH = join(root, 'skill', 'SKILL.md');
  delete process.env.WP_SKILL_URL;
  delete process.env.WP_SKILL_KEY;

  const AVA = join(root, 'skill', 'ava');
  const MODULES = join(AVA, 'modules');
  mkdirSync(MODULES, { recursive: true });

  const mod = await import('../tools/skill-content.js');
  const { handleModuleWrite, normaliseModulePath } = mod;

  console.log('\nnormaliseModulePath collapses every spelling to one');
  await check('a bare path is unchanged', () => {
    assert.equal(normaliseModulePath('meta/x.md'), 'meta/x.md');
  });
  await check('a modules/ prefix is stripped', () => {
    assert.equal(normaliseModulePath('modules/meta/x.md'), 'meta/x.md');
  });
  await check('a ./ prefix is stripped', () => {
    assert.equal(normaliseModulePath('./modules/meta/x.md'), 'meta/x.md');
  });
  await check('a leading slash is stripped', () => {
    assert.equal(normaliseModulePath('/modules/meta/x.md'), 'meta/x.md');
  });
  await check('duplicate separators collapse (the modules//meta stray copy)', () => {
    assert.equal(normaliseModulePath('modules//meta/x.md'), 'meta/x.md');
  });
  await check('a repeated prefix is stripped repeatedly', () => {
    // A single-pass strip would leave 'modules/meta/x.md' here, which joins
    // straight back to the double-nested path the fix exists to prevent.
    assert.equal(normaliseModulePath('modules/modules/meta/x.md'), 'meta/x.md');
  });
  await check('normalisation is idempotent', () => {
    const once = normaliseModulePath('modules/meta/x.md');
    assert.equal(normaliseModulePath(once), once);
  });

  console.log('\nAcceptance criteria (spec section 5)');

  await check('both spellings write to the identical physical path', async () => {
    const a = body(await handleModuleWrite({
      file: 'meta/accept.md', content: '# A\n\nfirst write\n',
    }));
    assert.equal(a.success, true);

    // Second call, prefixed spelling, force:true because the file now exists.
    const b = body(await handleModuleWrite({
      file: 'modules/meta/accept.md', content: '# A\n\nsecond write\n', force: true,
    }));
    assert.equal(b.success, true);

    assert.equal(a.resolved_path, b.resolved_path,
      `spellings diverged: ${a.resolved_path} vs ${b.resolved_path}`);
    assert.equal(a.resolved_path, join(MODULES, 'meta', 'accept.md'));
    // The prefixed call OVERWROTE rather than creating a second file.
    assert.equal(b.action, 'overwritten');
    assert.match(readFileSync(join(MODULES, 'meta', 'accept.md'), 'utf8'), /second write/);
  });

  await check('neither call creates a nested modules/modules path', () => {
    assert.equal(existsSync(join(MODULES, 'modules')), false,
      'a modules/modules directory was created');
  });

  await check('the response reports the resolved path for either spelling', async () => {
    const r = body(await handleModuleWrite({
      file: 'modules/meta/reported.md', content: '# R\n\nbody\n',
    }));
    assert.equal(r.resolved_path, join(MODULES, 'meta', 'reported.md'));
    // And makes the normalisation legible rather than implicit.
    assert.equal(r.requested_file, 'modules/meta/reported.md');
    assert.equal(r.normalised_file, 'meta/reported.md');
  });

  await check('the exact failing case overwrites the canonical file', async () => {
    // Re-run of the 2026-08-31 failure verbatim.
    await handleModuleWrite({
      file: 'meta/meta-deflection-watch.md', content: '# v1\n\noriginal\n',
    });
    const r = body(await handleModuleWrite({
      file: 'modules/meta/meta-deflection-watch.md',
      content: '# v2\n\nreplacement\n',
      force: true,
    }));
    assert.equal(r.success, true);
    assert.equal(r.action, 'overwritten');
    assert.equal(r.resolved_path, join(MODULES, 'meta', 'meta-deflection-watch.md'));
    assert.match(readFileSync(r.resolved_path, 'utf8'), /replacement/);
  });

  await check('exactly one file exists per module, at the canonical path', () => {
    const files = walk(MODULES, MODULES).sort();
    const deflection = files.filter((f) => f.endsWith('meta-deflection-watch.md'));
    assert.equal(deflection.length, 1, `stray copies found: ${JSON.stringify(deflection)}`);
    assert.equal(deflection[0], 'meta/meta-deflection-watch.md');
    // No path anywhere in the tree contains a nested modules segment.
    for (const f of files) {
      assert.equal(/(^|\/)modules(\/|$)/.test(f), false, `nested modules segment in ${f}`);
    }
  });

  console.log('\nThe overwrite guardrail still works, and reports the resolved path');

  await check('a prefixed spelling is blocked by the existing-file guard', async () => {
    // The guard must see the CANONICAL file. Before the fix, a prefixed write
    // was checking a different (non-existent) path, so it sailed past the
    // guardrail entirely and silently created the double-nested copy -- the
    // safety control was being bypassed by the same bug.
    const r = body(await handleModuleWrite({
      file: 'modules/meta/accept.md', content: '# nope\n',
    }));
    assert.equal(r.blocked, true);
    assert.equal(r.existing_file.resolved_path, join(MODULES, 'meta', 'accept.md'));
    assert.equal(r.diagnostics.normalised_file, 'meta/accept.md');
  });

  console.log('\nManifest registration is repaired by the same normalisation');

  await check('a prefixed write registers the correct category and path', async () => {
    // deriveModuleEntry takes category from the first path segment and sets
    // path to `modules/${cleanPath}`. With the prefix left on, a prefixed write
    // registered category 'modules' and path 'modules/modules/meta/x.md' -- so
    // the manifest pointed at the double-nested copy.
    const r = body(await handleModuleWrite({
      file: 'modules/meta/registered.md',
      content: '# Registered\n\n## Purpose\n\nbody text for mining\n',
    }));
    assert.equal(r.manifest_registration.registered, true,
      `registration failed: ${JSON.stringify(r.manifest_registration)}`);
    assert.equal(r.manifest_registration.module_path, 'modules/meta/registered.md');

    const fragPath = join(AVA, r.manifest_registration.fragment_file);
    assert.ok(existsSync(fragPath), `fragment not written at ${fragPath}`);
    const frag = JSON.parse(readFileSync(fragPath, 'utf8'));
    const entries = frag.modules || frag.entries || [];
    const entry = entries.find((e) => e && /registered/.test(e.id || ''));
    assert.ok(entry, `no module entry in fragment: ${JSON.stringify(frag).slice(0, 300)}`);
    assert.equal(entry.category, 'meta', `category was "${entry.category}", not "meta"`);
    assert.equal(entry.path, 'modules/meta/registered.md');
  });

  console.log('\nRegression guard (spec section 7)');

  await check('traversal is still refused', async () => {
    const r = body(await handleModuleWrite({
      file: 'modules/../../escape.md', content: '# no\n',
    }));
    assert.ok(r.error, 'traversal was not refused');
    assert.equal(existsSync(join(root, 'escape.md')), false);
  });

  await check('an empty module path is refused', async () => {
    const r = body(await handleModuleWrite({ file: 'modules/', content: '# no\n' }));
    assert.ok(r.error, 'an empty path was accepted');
  });

  await check('a non-md/json extension is still refused', async () => {
    const r = body(await handleModuleWrite({ file: 'modules/meta/x.sh', content: '# no\n' }));
    assert.ok(r.error, 'a .sh module was accepted');
  });

  rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS FAILURE:', e);
  process.exit(1);
});
