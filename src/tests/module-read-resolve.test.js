/**
 * src/tests/module-read-resolve.test.js
 *
 * v13.27.0 — module_read and module_resolve (SPEC-SOCIAL-003 v1.1 §3, §14).
 *
 * These tests DRIVE THE REAL HANDLERS against a real temporary volume rather
 * than asserting on source text. The defect class they protect against is not
 * visible in the shape of the code: the old failure was that a bare module id
 * resolved through whatever the loader found first, and every line involved
 * looked correct in isolation. Only which physical file came back distinguishes
 * a correct resolve from a shadowed one, so the fixture builds an actual
 * duplicate tree and the assertions read the returned paths and hashes.
 *
 * The fixture reproduces the duplication that exists on the live volume:
 * modules/philosophy/phil-identity-parfit.md is shadowed by
 * modules/modules/philosophy/phil-identity-parfit.md with different content.
 *
 * DESTRUCTIVE FIXTURE NOTICE
 * --------------------------
 * This suite creates and removes a directory tree. It writes ONLY inside a
 * freshly created mkdtempSync directory under the OS temp dir, and it removes
 * only that directory. It never touches /data, and it redirects the tools by
 * setting SKILL_FILE_PATH at the top of the run, before importing the module
 * under test. The assertion below refuses to run if that redirection did not
 * take effect, because a suite that reads the real volume would report on
 * production content while claiming to test a fixture.
 *
 * WP backup is left unconfigured, so no network call is attempted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
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

/** Find one entry in a module_resolve payload by its normalised path. */
function entryFor(payload, normalised) {
  const hit = payload.entries.find((e) => e.normalised === normalised);
  assert.ok(hit, `no entry for ${normalised} in ${payload.entries.map((e) => e.normalised).join(', ')}`);
  return hit;
}

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'module-read-'));
  process.env.SKILL_FILE_PATH = join(root, 'skill', 'SKILL.md');
  delete process.env.WP_SKILL_URL;
  delete process.env.WP_SKILL_KEY;
  delete process.env.MODULE_READ_MAX_FILES;
  delete process.env.MODULE_READ_MAX_TOTAL_CHARS;

  const AVA = join(root, 'skill', 'ava');
  const MODULES = join(AVA, 'modules');

  // The intended tree.
  mkdirSync(join(MODULES, 'philosophy'), { recursive: true });
  mkdirSync(join(MODULES, 'voice'), { recursive: true });
  mkdirSync(join(MODULES, 'social-media'), { recursive: true });
  // The shadow tree, as it exists on the live volume.
  mkdirSync(join(MODULES, 'modules', 'philosophy'), { recursive: true });

  const PARFIT_REAL = '# Parfit\nIntended copy. Identity over time.\n';
  const PARFIT_SHADOW = '# Parfit\nStale shadow copy.\nExtra line that the intended copy does not have.\n';
  const REPLY_SHAPES = '# Reply shapes\nA reply is not an essay.\n';

  writeFileSync(join(MODULES, 'philosophy', 'phil-identity-parfit.md'), PARFIT_REAL, 'utf8');
  writeFileSync(join(MODULES, 'modules', 'philosophy', 'phil-identity-parfit.md'), PARFIT_SHADOW, 'utf8');
  writeFileSync(join(MODULES, 'voice', 'voice-reply-shapes.md'), REPLY_SHAPES, 'utf8');
  writeFileSync(join(MODULES, 'social-media', 'social-media-linkedin.md'), '# LinkedIn\n', 'utf8');

  // A file outside the modules root, used as the escape target.
  writeFileSync(join(AVA, 'SECRET.md'), 'must never be readable through module_read\n', 'utf8');

  const mod = await import('../tools/skill-content.js');
  const { handleModuleRead, handleModuleResolve } = mod;

  // ── Fixture guard ────────────────────────────────────────────────────────
  // Runs first and hard-exits on failure. Every assertion below is meaningless
  // if the tools are pointed at the real volume, and a suite that silently
  // reads /data would still print passes.
  {
    const probe = body(handleModuleResolve({ file: 'voice/voice-reply-shapes.md' }));
    if (!probe.modules_dir.startsWith(root)) {
      console.error(`\nFIXTURE GUARD FAILED: tools resolved to ${probe.modules_dir}, not the temp volume at ${root}.`);
      console.error('Refusing to run. SKILL_FILE_PATH redirection did not take effect.');
      rmSync(root, { recursive: true, force: true });
      process.exit(1);
    }
    console.log(`\nfixture guard: tools are pointed at ${probe.modules_dir}`);
  }

  console.log('\nmodule_read returns the file named, not a same-named shadow');

  await check('reads the intended copy when the path names it', () => {
    const r = body(handleModuleRead({ file: 'philosophy/phil-identity-parfit.md' }));
    assert.equal(r.returned, 1);
    assert.equal(r.complete, true);
    assert.equal(r.files[0].content, PARFIT_REAL);
    // The assertion that matters: the physical file, not merely the text.
    assert.ok(
      r.files[0].resolved_path.endsWith(join('modules', 'philosophy', 'phil-identity-parfit.md')),
      `resolved to ${r.files[0].resolved_path}`
    );
    assert.ok(
      !r.files[0].resolved_path.includes(`${sep}modules${sep}modules${sep}`),
      'read resolved into the double-nested shadow tree'
    );
  });

  await check('reads the shadow copy when the path names THAT', () => {
    const r = body(handleModuleRead({ file: 'modules/philosophy/phil-identity-parfit.md' }));
    // normaliseModulePath strips every leading 'modules/', so this spelling is
    // the INTENDED file, not the shadow. That is the documented, deliberate
    // trade-off of the SPEC-FIX-MODULE-WRITE-001 normalisation, and pinning it
    // here means a future change to that rule fails loudly rather than quietly
    // redirecting every bundle entry.
    assert.equal(r.files[0].content, PARFIT_REAL);
    assert.equal(r.files[0].normalised, 'philosophy/phil-identity-parfit.md');
  });

  await check('a batch preserves order and collapses duplicate spellings', () => {
    const r = body(handleModuleRead({
      files: [
        'voice/voice-reply-shapes.md',
        'modules/voice/voice-reply-shapes.md',
        'social-media/social-media-linkedin.md',
      ],
    }));
    assert.equal(r.requested, 2, 'the two spellings of the same file collapse to one request');
    assert.equal(r.returned, 2);
    assert.equal(r.files[0].normalised, 'voice/voice-reply-shapes.md');
    assert.equal(r.files[1].normalised, 'social-media/social-media-linkedin.md');
  });

  await check('a missing entry is reported without failing the batch', () => {
    const r = body(handleModuleRead({
      files: ['voice/voice-reply-shapes.md', 'philosophy/phil-epistemology-virtue.md'],
    }));
    assert.equal(r.returned, 1);
    assert.equal(r.complete, false, 'complete must be false when any entry failed');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, 'module_not_found');
  });

  await check('a batch where nothing resolves is a failed call', () => {
    const r = handleModuleRead({ files: ['nope/missing.md'] });
    assert.equal(r.isError, true);
    assert.equal(body(r).returned, 0);
  });

  console.log('\nmodule_read containment');

  await check('refuses traversal out of the modules root', () => {
    const r = body(handleModuleRead({ file: '../SECRET.md' }));
    assert.equal(r.returned, 0);
    assert.equal(r.errors[0].code, 'validation_error');
    assert.ok(!JSON.stringify(r).includes('must never be readable'));
  });

  await check('refuses a symlink pointing outside the modules root', () => {
    let linked = false;
    try {
      symlinkSync(join(AVA, 'SECRET.md'), join(MODULES, 'voice', 'leak.md'));
      linked = true;
    } catch {
      console.log('    (symlink creation unavailable on this filesystem; skipped)');
    }
    if (!linked) return;
    const r = body(handleModuleRead({ file: 'voice/leak.md' }));
    assert.equal(r.returned, 0, 'a symlinked module was read');
    assert.ok(!JSON.stringify(r).includes('must never be readable'));
  });

  await check('refuses a non-module extension', () => {
    const r = body(handleModuleRead({ file: 'voice/notes.txt' }));
    assert.equal(r.errors[0].code, 'validation_error');
  });

  await check('no path at all is an argument error', () => {
    const r = handleModuleRead({});
    assert.equal(r.isError, true);
    assert.equal(body(r).code, 'validation_error');
  });

  console.log('\nmodule_read ceilings');

  await check('the per-call file ceiling refuses the overflow rather than the call', async () => {
    process.env.MODULE_READ_MAX_FILES = '1';
    const fresh = await import(`../tools/skill-content.js?ceil=${Date.now()}`);
    const r = body(fresh.handleModuleRead({
      files: ['voice/voice-reply-shapes.md', 'social-media/social-media-linkedin.md'],
    }));
    assert.equal(r.returned, 1);
    assert.equal(r.errors[0].code, 'module_read_max_files_exceeded');
    delete process.env.MODULE_READ_MAX_FILES;
  });

  await check('the total-character ceiling stops the batch and names why', async () => {
    process.env.MODULE_READ_MAX_TOTAL_CHARS = '10';
    const fresh = await import(`../tools/skill-content.js?chars=${Date.now()}`);
    const r = body(fresh.handleModuleRead({
      files: ['voice/voice-reply-shapes.md', 'social-media/social-media-linkedin.md'],
    }));
    assert.ok(r.errors.some((e) => e.code === 'module_read_total_chars_exceeded'));
    delete process.env.MODULE_READ_MAX_TOTAL_CHARS;
  });

  console.log('\nmodule_resolve reports resolution and shadowing');

  await check('a resolving path reports match_count 1 with stats', () => {
    const r = body(handleModuleResolve({ file: 'voice/voice-reply-shapes.md' }));
    const e = entryFor(r, 'voice/voice-reply-shapes.md');
    assert.equal(e.exists, true);
    assert.equal(e.match_count, 1);
    assert.equal(e.line_count, REPLY_SHAPES.split('\n').length);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.all_resolved, true);
  });

  await check('a shadowed module names the shadow and shows it differs', () => {
    const r = body(handleModuleResolve({ file: 'philosophy/phil-identity-parfit.md' }));
    const e = entryFor(r, 'philosophy/phil-identity-parfit.md');
    assert.equal(e.match_count, 1, 'the exact path still resolves to exactly one file');
    assert.equal(e.shadows.length, 1, 'the duplicate under modules/modules/ was not reported');
    assert.equal(e.shadows[0].path, 'modules/modules/philosophy/phil-identity-parfit.md');
    assert.equal(e.shadows[0].identical, false, 'the shadow is a DIVERGENT copy and must be reported as such');
    assert.notEqual(e.shadows[0].sha256, e.sha256);
    assert.equal(r.shadowed, 1);
  });

  await check('an unshadowed module reports an empty shadow list', () => {
    const r = body(handleModuleResolve({ file: 'voice/voice-reply-shapes.md' }));
    assert.deepEqual(entryFor(r, 'voice/voice-reply-shapes.md').shadows, []);
  });

  await check('a missing module resolves to match_count 0 and all_resolved false', () => {
    const r = body(handleModuleResolve({
      files: ['voice/voice-reply-shapes.md', 'philosophy/phil-epistemology-virtue.md'],
    }));
    assert.equal(r.all_resolved, false);
    assert.equal(r.unresolved, 1);
    const e = entryFor(r, 'philosophy/phil-epistemology-virtue.md');
    assert.equal(e.exists, false);
    assert.equal(e.match_count, 0);
    assert.equal(e.code, 'module_not_found');
  });

  await check('module_resolve never returns file content', () => {
    const r = body(handleModuleResolve({ file: 'philosophy/phil-identity-parfit.md' }));
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes('Identity over time'), 'resolve leaked file content');
    assert.ok(!serialised.includes('Stale shadow copy'), 'resolve leaked shadow content');
  });

  await check('the index does not descend through a directory symlink', () => {
    let linked = false;
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'voice'), { recursive: true });
    writeFileSync(join(outside, 'voice', 'voice-reply-shapes.md'), '# decoy\n', 'utf8');
    try {
      symlinkSync(outside, join(MODULES, 'linked-tree'));
      linked = true;
    } catch {
      console.log('    (symlink creation unavailable on this filesystem; skipped)');
    }
    if (!linked) return;
    const r = body(handleModuleResolve({ file: 'voice/voice-reply-shapes.md' }));
    const e = entryFor(r, 'voice/voice-reply-shapes.md');
    assert.deepEqual(e.shadows, [], 'the walk descended through a symlinked directory');
  });

  rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
