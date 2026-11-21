/**
 * src/tests/manifest-h2-loop.test.js
 *
 * The module_write out-of-memory. Connector v13.23.2.
 *
 * ── The bug, in one line ─────────────────────────────────────────────────
 *
 *     const h2Pattern = /^##\s+(.+)$/m;      // /m, no /g
 *     while ((h2Match = h2Pattern.exec(body)) !== null) { ... }
 *
 * RegExp.exec only advances lastIndex on a GLOBAL regex. Without /g it stays
 * 0, every call re-matches the first H2, and the loop pushes the same string
 * into an array until V8 aborts the process.
 *
 * ── Why it looked like something else ────────────────────────────────────
 *
 * In production it presented as 14.6 KB of input producing 4.9 GB of heap,
 * ~95 seconds after the call, with an EMPTY JS stack in the crash output. That
 * shape suggested a leak or a pathological payload, and neither was true: input
 * size is irrelevant, because the loop never reads past the first heading. Any
 * module with at least one H2 reaches it.
 *
 * It survived because module_write is rare and the heap took ninety-five
 * seconds to fill. Every call had been broken.
 *
 * ── What this test does ──────────────────────────────────────────────────
 *
 * Bounds the loop rather than trusting the flag: a timeout catches the defect
 * whatever future edit reintroduces it, where asserting on the regex source
 * would only catch this exact spelling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveModuleEntry } from '../tools/manifest-fragments.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );

/** A module with several H2 headings, the shape that triggered the incident. */
function moduleWithHeadings( count ) {
  let body = '---\nid: probe\ncategory: philosophy\n---\n# Title\n\n';
  for ( let i = 1; i <= count; i += 1 ) {
    body += `## Section ${ i }\n\nThe body is our general means of having a world. `
      + 'Motor intentionality is the projective grasp of the body schema.\n\n';
  }
  return body;
}

test( 'body mining terminates', () => {
  // THE regression. Before the fix this never returned: it allocated until the
  // process died, so the assertion is that we reach the next line at all.
  const started = Date.now();
  const entry = deriveModuleEntry( 'philosophy/probe.md', moduleWithHeadings( 12 ), {} );
  const elapsed = Date.now() - started;

  assert.ok( entry && entry.id, 'the entry must be produced' );
  assert.ok( elapsed < 2000,
    `body mining took ${ elapsed }ms; before the /g fix it never terminated` );
} );

test( 'no H2 heading becomes a task class or a capability (WO-2026-11-21-02 P1, P6, P10)', () => {
  // This test used to require every H2 to become a task class. WO-2026-11-21-02
  // removed body derivation entirely: headings are document structure, not
  // registry content. task_class and provides come only from the frontmatter
  // or manifest_entry, and are empty here.
  const entry = deriveModuleEntry( 'philosophy/probe.md', moduleWithHeadings( 5 ), {} );
  assert.deepEqual( entry.triggers.task_class, [] );
  assert.deepEqual( entry.provides, [] );
  assert.equal( entry.triggers_source, 'none' );
  assert.ok( ! JSON.stringify( entry ).toLowerCase().includes( 'section 1' ), 'no heading text anywhere in the entry' );
} );

test( 'a module with one heading does not loop', () => {
  // The minimum case. One heading is exactly the condition under which a
  // non-global exec re-matches forever.
  const started = Date.now();
  deriveModuleEntry( 'philosophy/probe.md', moduleWithHeadings( 1 ), {} );
  assert.ok( Date.now() - started < 2000 );
} );

test( 'a module with no headings is handled', () => {
  const entry = deriveModuleEntry( 'philosophy/probe.md',
    '---\nid: probe\n---\n# Only a title\n\nProse with no H2 at all.\n', {} );
  assert.ok( Array.isArray( entry.triggers.task_class ) );
} );

test( 'memory does not grow across repeated derivations', () => {
  // The production signature was ~95 seconds of growth to 4.9 GB. Two hundred
  // passes here previously exhausted a 2 GB heap; they now hold flat.
  const body = moduleWithHeadings( 8 );
  const before = process.memoryUsage().heapUsed;

  for ( let i = 0; i < 200; i += 1 ) deriveModuleEntry( 'philosophy/probe.md', body, {} );

  if ( 'function' === typeof globalThis.gc ) globalThis.gc();
  const grew = ( process.memoryUsage().heapUsed - before ) / 1048576;

  assert.ok( grew < 50,
    `${ Math.round( grew ) } MB retained across 200 derivations` );
} );

test( 'every exec loop in this module uses a global regex', () => {
  // The general form of the defect, not this one instance. A non-global regex
  // driving an exec loop cannot terminate, and the failure is always an OOM
  // several layers from the cause.
  const src = readFileSync(
    join( ROOT, 'src', 'tools', 'manifest-fragments.js' ), 'utf8' );

  const loops = [ ...src.matchAll( /while\s*\(\s*\(\s*(\w+)\s*=\s*(\w+)\.exec\(/g ) ];
  // WO-2026-11-21-02 removed the H2-mining loop with the rest of body
  // derivation, so there may be no exec loop left to check. That the mining
  // code is gone is asserted here instead of a non-zero loop count.
  assert.doesNotMatch( src, /function mineBodyContent\b/, 'body mining was removed (P1)' );

  for ( const [ , , patternName ] of loops ) {
    const declaration = new RegExp( `const ${ patternName }\\s*=\\s*/.*?/([gimsuy]*)` );
    const found = src.match( declaration );
    assert.ok( found, `could not find the declaration of ${ patternName }` );
    assert.ok( found[ 1 ].includes( 'g' ),
      `${ patternName } drives an exec loop without the /g flag, so lastIndex `
      + 'never advances and the loop cannot terminate. This is the exact defect '
      + 'that took the connector out four times in six minutes.' );
  }
} );
