/**
 * scripts/probe-module-write-oom.mjs
 *
 * Reproduce the module_write out-of-memory locally, under a heap snapshot.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The containment fix (heap guard, bounded heap, snapshot flag) keeps the
 * process alive but leaves the allocation site unfound, and "retrieve the
 * snapshot next time it happens in production" waits on a crash nobody wants.
 *
 * The triggering input is known exactly: a force overwrite of an
 * already-registered module whose frontmatter carries ~26 keywords and ~8
 * multi-word phrases. That is reproducible on a laptop in seconds. Waiting for
 * production was the wrong call.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 *
 * Builds a throwaway skill volume, registers the module once so the second
 * write takes the force-overwrite branch the incident took, then writes it
 * repeatedly, reporting heap after each pass.
 *
 * Repetition is the amplifier. A single call allocating a few megabytes and
 * never releasing them is invisible; the same call a hundred times is a
 * straight line on the RSS column, and the slope names the leak. If heap
 * returns to its floor after each pass, the allocation is NOT here.
 *
 * ── Running it ───────────────────────────────────────────────────────────
 *
 *   node --max-old-space-size=256 --heapsnapshot-near-heap-limit=1 \
 *        scripts/probe-module-write-oom.mjs [iterations]
 *
 * A small heap on purpose: it reaches the ceiling in seconds rather than the
 * ninety-five it took in production, and writes the snapshot that names the
 * retaining object.
 *
 * Exit 0 means it did NOT reproduce, which is itself a finding: the allocation
 * is somewhere this probe does not reach.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const iterations = parseInt( process.argv[ 2 ] || '200', 10 );

// A throwaway volume. SKILL_FILE_PATH is what getContentPaths() derives every
// other directory from, so setting it isolates the probe from any real data.
const root = mkdtempSync( join( tmpdir(), 'module-write-probe-' ) );
const skillFile = join( root, 'SKILL.md' );
process.env.SKILL_FILE_PATH = skillFile;

// The WordPress backup is deliberately left unconfigured. It is the one part of
// the path that leaves the process, and including it would make the probe
// measure a network call instead of the allocation.
delete process.env.WP_SKILL_URL;
delete process.env.WP_SKILL_KEY;

// The guard would refuse the call as the probe approached the ceiling, which is
// correct in production and defeats the purpose here: this run is trying to
// reach the ceiling.
process.env.HEAP_GUARD_ENABLED = 'false';

for ( const dir of [ 'ava', 'ava/modules', 'ava/modules/philosophy',
                     'ava/references', 'ava/references/manifest' ] ) {
  mkdirSync( join( root, dir ), { recursive: true } );
}
writeFileSync( skillFile, '# SKILL\n' );

/**
 * The incident's module, reproduced in shape rather than in full.
 *
 * What matters is the frontmatter: 26 keywords, 8 multi-word phrases, 8
 * `provides` entries, and a body of several thousand words. The prose is padded
 * to roughly 14.6 KB, the size of the file that crashed the process.
 */
function buildModule() {
  const keywords = [
    'phenomenology', 'merleau-ponty', 'husserl', 'perception', 'perceiving',
    'body', 'embodiment', 'lived body', 'phänomenologie', 'motor intentionality',
    'body schema', 'sedimentation', 'phenomenal field', 'intentional arc',
    'motor project', 'lebenswelt', 'prereflective', 'gestalt',
    'figure and ground', 'corporeal', 'habit', 'in the world', 'flesh',
    'chiasm', 'reversibility', 'fond de la chair',
  ];
  const phrases = [
    'I am my body',
    'the body is our general means of having a world',
    'consciousness is originarily an I can',
    'to look is to be looked at',
    'the body inhabits space',
    'I perceive with my hands',
    'speech accomplishes thought',
    'the sensible world is older than the world of thought',
  ];

  const front = [
    '---',
    'id: phil-phenomenology-husserl-merleau',
    'version: 1.5.0',
    'category: philosophy',
    'provides: embodied_cognition, perception_as_ground, motor_intentionality, '
      + 'sedimentation_dialectic, body_schema, expressive_limit, '
      + 'recalcitrant_subject, horizon_fundierung',
    'depends_on: []',
    'load_priority: optional',
    'triggers:',
    `  keywords: ${ JSON.stringify( keywords ) }`,
    `  phrases: ${ JSON.stringify( phrases ) }`,
    'task_class: ["phenomenological description", "embodied cognition analysis", '
      + '"perception analysis", "body-schema reasoning", "expressive-limit analysis"]',
    '---',
    '# Phenomenology (Husserl, Merleau-Ponty)',
    '',
  ].join( '\n' );

  // Repeated prose with recurring bigrams, because mineBodyContent counts them
  // and a body of unique words would exercise that path differently from the
  // real module.
  const para = 'The body is our general means of having a world, and the lived '
    + 'body inhabits space rather than occupying it. Motor intentionality is '
    + 'the projective grasp through which the body schema finds its way. ';
  let body = front;
  while ( body.length < 14_600 ) body += `\n## Section\n\n${ para.repeat( 3 ) }\n`;
  return body;
}

const content = buildModule();
console.log( `[probe] module is ${ content.length } bytes `
  + `(the incident's file was ~14,950)` );

const { handleModuleWrite } = await import( '../src/tools/skill-content.js' );

/** @returns {number} Heap used, in MB. */
function heapMb() {
  return Math.round( process.memoryUsage().heapUsed / 1048576 );
}

const args = {
  file: 'philosophy/phil-phenomenology-husserl-merleau.md',
  content,
  change_note: 'probe',
  force: true,
};

// First write registers the module and creates the fragment, so every pass
// after it takes the force-overwrite branch the incident took.
await handleModuleWrite( { ...args, force: false } ).catch( () => {} );

const start = heapMb();
console.log( `[probe] baseline after first write: ${ start } MB` );
console.log( `[probe] running ${ iterations } force overwrites...` );

let peak = start;
for ( let i = 1; i <= iterations; i += 1 ) {
  await handleModuleWrite( args );

  if ( 0 === i % 20 || i === iterations ) {
    const now = heapMb();
    peak = Math.max( peak, now );
    console.log( `[probe] pass ${ String( i ).padStart( 4 ) }  heap ${ now } MB` );
  }
}

// A forced collection separates "held" from "not yet collected". Without it a
// rising line proves only that GC had not run, which is not a leak.
if ( 'function' === typeof globalThis.gc ) globalThis.gc();
const settled = heapMb();

console.log( '' );
console.log( `[probe] baseline ${ start } MB -> peak ${ peak } MB -> `
  + `after GC ${ settled } MB` );

const grew = settled - start;
if ( grew > 50 ) {
  console.log( `[probe] REPRODUCED: ${ grew } MB retained across ${ iterations } `
    + 'writes and survived a forced collection. That is the leak. Run again '
    + 'under --heapsnapshot-near-heap-limit=1 with a small --max-old-space-size '
    + 'to capture the retaining object.' );
} else {
  console.log( `[probe] NOT reproduced here: ${ grew } MB retained. The `
    + 'allocation is somewhere this probe does not reach -- the WordPress '
    + 'backup, the manifest reload on the next compile, or a caller-side path.' );
}

rmSync( root, { recursive: true, force: true } );
process.exit( grew > 50 ? 1 : 0 );
