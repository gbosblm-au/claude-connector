#!/usr/bin/env node
// scripts/register-audit.mjs
//
// Work order W7 rev 2.1, diagnostic D6: the classification audit. Connector
// v13.36.0.
//
// Compares the registry (src/voice/register-grammar.v1.json, every token the
// formatter can remove or pass through) against every token the WRITER can
// emit, in both directions, so a token that is emittable but unregistered
// fails rather than passing silently (it would be left as content and read
// aloud), and a registered Class A token with no emitter left anywhere fails
// too (a stale entry).
//
// The writer set is DERIVED BY WALKING the two repositories that hold the
// writer's vocabulary, never hand-listed:
//
//   W1  gateway prompt instructions: string literals under lib/ and routes/
//       that contain a backticked bracket token, which is how a prompt tells
//       the model to write one (lib/thought-trace.js markerInstruction()).
//   W2  client consumer declarations: array literals assigned to a name
//       containing MARKER, of quoted bracket tokens (06b-output-marker.js).
//   W3  client consumer patterns: regular-expression literals that match one
//       literal bracket token (06-markdown.js panel triggers, 09d control line).
//
// Class B has no code emitter in these trees: the cues are written by the
// model from the work orders' vocabulary, and the register layer that would
// instruct them is parked (SPEC-AUDIO-003 Section 10). They are reported, and
// they do not fail the reverse check. Tokens the CLIENT writes into the USER's
// turn (tutoring directives such as [session-complete]) are not the reply
// writer's and are out of these walkers by construction.
//
// Usage:
//   node scripts/register-audit.mjs --gateway <dir> --client <dir> [--json]
//
// Exit codes: 0 both directions clean, 1 a mismatch (named), 2 usage error or
// a walker that found nothing (a floor: a walk that saw no token proves
// nothing, so it fails rather than passes).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
}
const KNOWN = new Set(['--gateway', '--client', '--json']);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--') && !KNOWN.has(args[i])) {
    process.stderr.write(`unknown option ${args[i]}\n`);
    process.exit(2);
  }
}
const gatewayDir = flag('--gateway');
const clientDir = flag('--client');
const asJson = args.includes('--json');
if (!gatewayDir || !clientDir || !existsSync(gatewayDir) || !existsSync(clientDir)) {
  process.stderr.write('usage: node scripts/register-audit.mjs --gateway <dir> --client <dir> [--json]\n');
  process.exit(2);
}

const { REGISTRY } = await import('../src/voice/engine-form.js');

/**
 * Every .js file under a directory, skipping dependencies and tests.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if ('node_modules' === name || 'tests' === name || 'dist' === name) continue;
      out.push(...jsFiles(p));
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/** token -> Set of "walker file" sources */
const writer = new Map();
const floors = { W1: 0, W2: 0, W3: 0 };
function found(token, walker, file, root) {
  floors[walker] += 1;
  if (!writer.has(token)) writer.set(token, new Set());
  writer.get(token).add(`${walker} ${relative(root, file)}`);
}

// W1: gateway prompt instructions.
for (const file of [...jsFiles(join(gatewayDir, 'lib')), ...jsFiles(join(gatewayDir, 'routes'))]) {
  const src = readFileSync(file, 'utf8');
  for (const lit of src.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/gu)) {
    for (const t of lit[0].matchAll(/`(\[\[?[A-Za-z][A-Za-z0-9_-]*\]\]?)`/gu)) found(t[1], 'W1', file, gatewayDir);
  }
}

// W2 and W3: client consumers.
for (const file of jsFiles(join(clientDir, 'src', 'js'))) {
  const src = readFileSync(file, 'utf8');
  for (const decl of src.matchAll(/\b[A-Za-z_$][\w$]*MARKER[\w$]*\s*=\s*\[\s*((?:'\[[^'\]\n]+\]'\s*,?\s*)+)\]/gu)) {
    for (const t of decl[1].matchAll(/'(\[[^'\]\n]+\])'/gu)) found(t[1], 'W2', file, clientDir);
  }
  for (const re of src.matchAll(/\/\^?((?:\\\[){1,2}[A-Za-z][A-Za-z0-9_-]*(?:\\\]){1,2})/gu)) {
    found(re[1].replace(/\\/gu, ''), 'W3', file, clientDir);
  }
}

const registered = new Map(REGISTRY.entries.map((e) => [e.token, e]));
const unregistered = [...writer.keys()].filter((t) => !registered.has(t)
  && !REGISTRY.entries.some((e) => e.spellings.includes(t)));
const stale = REGISTRY.entries.filter((e) => 'A' === e.cls && !e.spellings.some((s) => writer.has(s)))
  .map((e) => e.token);
const cuesWithoutEmitter = REGISTRY.entries.filter((e) => 'B' === e.cls).map((e) => e.token);
const emptyWalkers = Object.entries(floors).filter(([, n]) => 0 === n).map(([w]) => w);

const report = {
  registry: REGISTRY.version,
  walkers: floors,
  writer_tokens: Object.fromEntries([...writer].map(([t, s]) => [t, [...s].sort()])),
  emittable_but_unregistered: unregistered,
  registered_class_a_without_emitter: stale,
  class_b_documented_no_code_emitter: cuesWithoutEmitter,
  empty_walkers: emptyWalkers,
};
const code = emptyWalkers.length ? 2 : ((unregistered.length || stale.length) ? 1 : 0);
report.exit_code = code;

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`register audit, ${REGISTRY.version}\n`);
  process.stdout.write(`  walkers: W1=${floors.W1} W2=${floors.W2} W3=${floors.W3}\n`);
  for (const [t, s] of writer) process.stdout.write(`  writer ${t}  <- ${[...s].join(', ')}\n`);
  process.stdout.write(`  emittable but unregistered: ${unregistered.join(' ') || 'none'}\n`);
  process.stdout.write(`  registered Class A without an emitter: ${stale.join(' ') || 'none'}\n`);
  process.stdout.write(`  Class B, documented, no code emitter: ${cuesWithoutEmitter.join(' ')}\n`);
  if (emptyWalkers.length) process.stdout.write(`  EMPTY WALKER(S): ${emptyWalkers.join(' ')} (floor failed)\n`);
}
process.exit(code);
