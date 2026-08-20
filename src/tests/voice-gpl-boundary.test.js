// src/tests/voice-gpl-boundary.test.js
//
// Voice specification Section 6.2 / 6.3 (compliance obligation 1):
// "maintain the separate-process boundary for GPL Piper (documented,
// verifiable in CI)".
//
// PIPER-PRELOAD-v1.1 Section 4.3 and A6 extend the same obligation to the new
// resident worker: "tests/voice-gpl-boundary.test.js is extended to assert the
// worker file is never imported by Node and never shares an interpreter with
// the MIT STT helper."
//
// Run: node --test src/tests/voice-gpl-boundary.test.js
//
// ===========================================================================
// A NOTE ON WHY THIS FILE IS NEW IN v12.53.0
// ===========================================================================
//
// Both the voice-engines.js header comment and PIPER-PRELOAD-v1.1 Section 2.5
// state that this test already exists and asserts the boundary. IT DID NOT.
// There was no file of this name anywhere in the repository.
//
// That is worth recording rather than quietly fixing, because of what it
// means: the compliance obligation was believed to be enforced in CI, was
// cited as enforced in a specification written against the source, and was in
// fact enforced by nothing at all. A licence boundary that everyone believes
// is tested is more dangerous than one everyone knows is manual, because
// nobody looks at it.
//
// The assertions below are what those two documents describe.
//
// ===========================================================================
// THE BOUNDARY, PRECISELY
// ===========================================================================
//
//   Piper           GPL-3.0-or-later. Runs as its own OS process, from its own
//                   directory, via its own interpreter. argv and pipes only.
//   faster-whisper  MIT. Imported by voice_stt.py, a helper we control.
//
// Three things must hold, and each has a test below:
//
//   1. Nothing GPL enters the Node import graph. Node cannot import Python at
//      all, so what this really means is that no Node file may name a Python
//      module as an import, and the worker script must be referenced as a PATH
//      that gets spawned, never as a module.
//
//   2. The two Python programs must not share an interpreter. voice_stt.py
//      imports faster-whisper; piper_worker.py imports piper. One site-packages
//      holding both is the entanglement the boundary exists to prevent, which
//      is why VOICE_PIPER_PYTHON is resolved separately from VOICE_PYTHON_BIN.
//
//   3. voice_stt.py must never import piper, and piper_worker.py must never
//      import faster-whisper.

import test           from 'node:test';
import assert         from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const VOICE_DIR = join(SRC, 'voice');

function read(path) {
  return readFileSync(path, 'utf8');
}

/**
 * A file's CODE, with comments removed.
 *
 * The boundary assertions below search for variable names, and this file is
 * full of prose EXPLAINING which variable must not be used and why. Searching
 * the raw text finds those explanations and fails on correct code -- which
 * teaches whoever hits it to weaken the assertion, and that is precisely how a
 * compliance control quietly stops controlling anything.
 *
 * @param {string} path
 * @returns {string} Source with block and line comments stripped.
 */
function code(path) {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every .js file under src/, recursively, excluding node_modules. */
function jsFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { jsFiles(full, found); continue; }
    if ('.js' === extname(entry) || '.mjs' === extname(entry)) found.push(full);
  }
  return found;
}

// ===========================================================================
// 1. Nothing GPL enters the Node import graph
// ===========================================================================

test('no Node source imports or requires a Python module', () => {
  // Node cannot import Python, so this is really a guard against someone
  // wiring in a bridge (python-shell, pyodide, a napi binding) that WOULD put
  // GPL code in our process.
  const bridges = /require\s*\(\s*['"](python-shell|node-calls-python|pyodide|python-bridge)['"]|from\s+['"](python-shell|node-calls-python|pyodide|python-bridge)['"]/;
  for (const file of jsFiles(SRC)) {
    assert.ok(!bridges.test(read(file)),
      `${file} must not bridge a Python runtime into this process`);
  }
});

// ---------------------------------------------------------------------------
// v12.54.0: THE SHARED SUPERVISOR MAKES THE SEPARATION A CONFIG DIFFERENCE
// ---------------------------------------------------------------------------
//
// Until v12.54.0 the GPL worker and the MIT worker were spawned by two
// different files, so "they do not share an interpreter" was visible in the
// structure of the code. Change 3 needed the same four hundred lines of
// lifecycle for Whisper, so it was extracted and both now go through
// stdio-worker.js.
//
// That is a REAL WEAKENING of a structural guarantee: the separation is now a
// difference in what each supervisor passes in. These tests are the
// compensation, and they are deliberately stricter than the ones they replace.

test('the shared supervisor never picks an interpreter of its own', () => {
  const shared = code(join(VOICE_DIR, 'stdio-worker.js'));

  // The module that spawns BOTH engines must have no opinion about which
  // interpreter either one uses. If it could default, fall back, or read an
  // environment variable itself, a misconfiguration could silently collapse the
  // two onto one interpreter -- which is the entanglement the boundary exists
  // to prevent.
  assert.ok(!/VOICE_PYTHON_BIN|VOICE_PIPER_PYTHON/.test(shared),
    'the shared spawner reads neither interpreter variable');
  assert.ok(!/python3/.test(shared),
    'and has no interpreter default to fall back to');
  assert.ok(/interpreter:\s*\(\)\s*=>\s*string|spec\.interpreter\(\)/.test(shared),
    'the interpreter is supplied by the caller, every time');
});

test('the shared supervisor knows nothing about either engine', () => {
  const shared = code(join(VOICE_DIR, 'stdio-worker.js'));
  // A lifecycle module that named an engine could grow engine-specific
  // behaviour, and the two would start to differ again in the one file written
  // to stop them differing.
  assert.ok(!/piper|whisper|faster_whisper|onnx/i.test(shared),
    'no engine name appears in the shared lifecycle');
});

test('the STT worker is referenced as a path to spawn, never as an import', () => {
  const stt = read(join(VOICE_DIR, 'stt-worker-supervisor.js'));
  assert.ok(stt.includes("new URL('./voice_stt_worker.py', import.meta.url).pathname"));
  for (const file of jsFiles(SRC)) {
    assert.ok(!/(?:import|require)\s*\(?\s*['"][^'"]*voice_stt_worker\.py['"]/.test(read(file)),
      `${file} must not import voice_stt_worker.py`);
  }
});

test('workers communicate over stdio only', () => {
  const shared = read(join(VOICE_DIR, 'stdio-worker.js'));
  assert.ok(shared.includes("stdio: ['pipe', 'pipe', 'pipe']"));
  // No socket, no shared file, no named pipe. argv in, JSON lines out.
  assert.ok(!/node:net|node:dgram|createServer|listen\(/.test(shared),
    'no socket is opened to a worker');
});

// ===========================================================================
// The gate: with voice off, nothing is spawned (Section 7, A7)
// ===========================================================================

test('A7: nothing is warmed or spawned when the master switch is off', () => {
  const engines = read(join(VOICE_DIR, 'voice-engines.js'));

  const prewarm = engines.slice(engines.indexOf('export async function prewarmTts'),
                                engines.indexOf('export function ttsWorkerState'));
  assert.ok(prewarm.includes('if (!voiceEnabled()) return false;'),
    'pre-warm is gated on the master switch');

  const probe = engines.slice(engines.indexOf('export async function probeEngines'));
  assert.ok(probe.slice(0, 400).includes('if (!voiceEnabled())'),
    'and so is the engine probe');

  const sttPrewarm = engines.slice(engines.indexOf('export async function prewarmStt'),
                                   engines.indexOf('export function sttWorkerHealth'));
  assert.ok(sttPrewarm.includes('if (!voiceEnabled()) return false;'),
    'the STT pre-warm is gated on the master switch too');

  const routes = read(join(SRC, 'routes', 'voice.js'));
  const boot = routes.slice(routes.indexOf('if (voiceEnabled()) {'));
  assert.ok(boot.includes('prewarmTts()'),
    'the TTS boot pre-warm sits inside the voiceEnabled guard');
  assert.ok(boot.includes('prewarmStt()'),
    'and so does the STT one');
});

test('the Dockerfile ships the scripts the npm entries point at', () => {
  // scripts/ was allowed by .dockerignore but never COPYed, so `npm run
  // voice:smoke` -- the deployment gate for exactly the interpreter problem
  // above -- failed in the container with MODULE_NOT_FOUND. The gate could not
  // catch the fault because the gate was not in the image.
  const dockerfile = readFileSync(join(SRC, '..', 'Dockerfile'), 'utf8');
  assert.ok(/^COPY scripts\/ \.\/scripts\/$/m.test(dockerfile),
    'the runtime image must contain scripts/');

  const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    const m = /(?:^|\s)(scripts\/[\w./-]+)/.exec(cmd);
    if (!m) continue;
    assert.ok(existsSync(join(SRC, '..', m[1])),
      `npm run ${name} points at ${m[1]}, which does not exist`);
  }
});

// ===========================================================================
// v13 -- THE BOUNDARY AFTER PIPER
// ===========================================================================
//
// Piper was GPL-3.0, and every assertion above that named it has been removed
// because the program it described no longer exists. Deleting a test for
// deleted code is correct; deleting the PROPERTY it protected would not be.
//
// The property survives, because the GPL dependency did. Kokoro-82M is
// Apache-2.0, but kokoro-onnx phonemises through `phonemizer`, which drives
// espeak-ng, and ESPEAK-NG IS GPL-3.0. The obligation moved from the model to
// the phonemiser.
//
// So the same two disciplines still hold, and are re-asserted here against the
// new engine:
//
//   1. Nothing in the Node source imports the worker; it is a path to spawn.
//   2. The Kokoro environment and the MIT STT environment never share an
//      interpreter, because one site-packages holding both is the entanglement
//      the boundary exists to prevent.

test('the Kokoro worker is referenced as a path to spawn, never as an import', () => {
  for (const file of jsFiles(SRC)) {
    const src = code(file);
    assert.ok(! /^\s*import\s+[^;]*kokoro_worker/mu.test(src),
      `${file} imports kokoro_worker.py`);
    assert.ok(! /require\(\s*['"][^'"]*kokoro_worker/u.test(src),
      `${file} requires kokoro_worker.py`);
  }
  // Named as a URL path, which is how a file becomes argv rather than a module.
  const sup = code(join(VOICE_DIR, 'kokoro-worker-supervisor.js'));
  assert.match(sup, /new URL\('\.\/kokoro_worker\.py', import\.meta\.url\)/u,
    'the supervisor resolves the worker as a path');
});

test('the two supervisors resolve different interpreters', () => {
  // The whole boundary rests on this. VOICE_PYTHON_BIN runs faster-whisper
  // (MIT); VOICE_KOKORO_PYTHON runs kokoro-onnx and, through phonemizer,
  // espeak-ng (GPL-3.0). Conflating them puts both in one site-packages.
  // code(), not read(): this suite and the supervisors themselves explain in
  // PROSE which variable must not be used. Searching raw text finds those
  // explanations and fails on correct code -- which teaches whoever hits it to
  // weaken the assertion, and that is how a compliance control stops
  // controlling anything.
  const kokoro = code(join(VOICE_DIR, 'kokoro-worker-supervisor.js'));
  const stt = code(join(VOICE_DIR, 'stt-worker-supervisor.js'));

  assert.ok(kokoro.includes('VOICE_KOKORO_PYTHON'),
    'the Kokoro supervisor names its own interpreter variable');
  assert.ok(! kokoro.includes('VOICE_PYTHON_BIN'),
    'the Kokoro supervisor must never read the MIT interpreter variable');
  assert.ok(stt.includes('VOICE_PYTHON_BIN'),
    'the STT supervisor names the MIT interpreter variable');
  assert.ok(! stt.includes('VOICE_KOKORO_PYTHON'),
    'the STT supervisor must never read the GPL-adjacent interpreter variable');
});

test('an absent Kokoro venv declines rather than falling back to system python', () => {
  // A guess that is wrong BY CONSTRUCTION is worse than no guess. The system
  // interpreter is the one we can be confident does NOT have the engine, since
  // the venv exists precisely to keep the dependency out of everything else.
  // Piper's supervisor fell back to it and produced a worker that started
  // cleanly, reported ready, then failed every request with ModuleNotFoundError.
  const sup = code(join(VOICE_DIR, 'kokoro-worker-supervisor.js'));
  const fn = sup.slice(sup.indexOf('export function kokoroPython'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/return '';/u.test(body),
    'kokoroPython returns empty when no venv is found');
  assert.ok(! /return 'python3'/u.test(body),
    'and never guesses the bare system interpreter');
});

test('the Kokoro child gets a minimal environment, not the connector\'s', () => {
  // The boundary is as much about what the child cannot SEE as about which
  // interpreter runs it. An inherited environment hands this process every API
  // key the connector holds.
  const sup = code(join(VOICE_DIR, 'kokoro-worker-supervisor.js'));
  const fn = sup.slice(sup.indexOf('function childEnv()'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.ok(! /\.\.\.process\.env/u.test(body),
    'the child environment must not spread process.env');
  assert.ok(! /Object\.assign\(\s*\{\}\s*,\s*process\.env/u.test(body),
    'nor copy it wholesale');
  for (const allowed of ['PATH', 'HOME', 'OMP_NUM_THREADS', 'VOICE_KOKORO_MODEL']) {
    assert.ok(body.includes(allowed), `${allowed} is passed explicitly`);
  }
});

test('kokoro_worker.py never imports faster_whisper', () => {
  // The mirror of voice_stt.py never importing the TTS engine. One
  // site-packages holding both is the start of the entanglement.
  const src = read(join(VOICE_DIR, 'kokoro_worker.py'));
  assert.ok(! /faster_whisper/u.test(src));
});

test('no Piper artifact survives anywhere in the source tree', () => {
  // The retirement, asserted. A stale supervisor or requirements file left
  // behind would be a GPL-3.0 dependency still declared by a deployment that
  // believes it has removed one.
  for (const gone of ['piper_worker.py', 'piper-worker-supervisor.js',
                      'requirements-piper.txt']) {
    assert.ok(! existsSync(join(VOICE_DIR, gone)),
      `${gone} still exists`);
  }
  // THIS FILE IS EXCLUDED FROM ITS OWN SCAN, and that is not a loophole -- the
  // names being searched for necessarily appear in the search itself, in the
  // regex above and the array below. Without the exclusion the assertion fails
  // permanently on correct code, and the only ways out are to weaken the
  // pattern or delete the test. Both lose the control.
  const self = fileURLToPath(import.meta.url);
  for (const file of jsFiles(SRC)) {
    if (file === self) continue;
    const src = code(file);
    assert.ok(! /piper-worker-supervisor|piper_worker\.py/u.test(src),
      `${file} still references a deleted Piper module`);
  }
});
