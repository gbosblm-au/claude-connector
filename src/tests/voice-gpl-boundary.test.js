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
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

test('the Piper worker is referenced as a path to spawn, never as an import', () => {
  const supervisor = read(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  const shared = read(join(VOICE_DIR, 'stdio-worker.js'));

  // A URL resolved to a pathname, handed to spawn. That is the only legitimate
  // way this file may appear in Node source.
  assert.ok(supervisor.includes("new URL('./piper_worker.py', import.meta.url).pathname"),
    'the worker is located as a filesystem path');
  // v12.54.0: the spawn itself moved to the shared lifecycle module, which both
  // engines use. It is still a spawn of a path.
  assert.ok(/spawn\(interpreter, args/.test(shared),
    'and it is spawned as its own process');

  // No import or require of the .py, in any Node file.
  for (const file of jsFiles(SRC)) {
    const src = read(file);
    assert.ok(!/(?:import|require)\s*\(?\s*['"][^'"]*piper_worker\.py['"]/.test(src),
      `${file} must not import piper_worker.py`);
  }
});

test('Piper is spawned as a separate process in both paths', () => {
  const engines = read(join(VOICE_DIR, 'voice-engines.js'));
  // The CLI path.
  assert.ok(/spawn\(PIPER_BIN, args/.test(engines),
    'the CLI path spawns the Piper binary directly');
  // The resident path, via the supervisor.
  assert.ok(engines.includes("from './piper-worker-supervisor.js'"),
    'the resident path goes through the supervisor, which spawns');
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

test('the two supervisors resolve different interpreters', () => {
  const piper = code(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  const stt = code(join(VOICE_DIR, 'stt-worker-supervisor.js'));

  // The GPL side.
  assert.ok(piper.includes("env('VOICE_PIPER_PYTHON'"),
    'the Piper supervisor resolves VOICE_PIPER_PYTHON');
  assert.ok(!piper.includes('VOICE_PYTHON_BIN'),
    'and never reads the MIT interpreter variable');

  // The MIT side.
  assert.ok(stt.includes('process.env.VOICE_PYTHON_BIN'),
    'the STT supervisor resolves VOICE_PYTHON_BIN');
  assert.ok(!stt.includes('VOICE_PIPER_PYTHON'),
    'and never reads the GPL interpreter variable');
});

test('the two default interpreters cannot collapse to one path', () => {
  const piper = code(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  const stt = code(join(VOICE_DIR, 'stt-worker-supervisor.js'));

  // Both fall back to the bare string 'python3' when unset, which resolves via
  // PATH -- and if that were the whole story the two workers WOULD share an
  // interpreter on a default deployment.
  //
  // It is not the whole story: the Piper supervisor prefers the venv inside
  // VOICE_PIPER_DIR and only falls back to PATH when that venv is absent, and
  // when it is absent the worker cannot import piper anyway, so it never
  // starts and the CLI path serves synthesis. The bare-python3 case is
  // therefore a state in which the GPL worker does not run at all.
  assert.ok(piper.includes("join(dir, 'venv', 'bin', 'python3')"),
    'the Piper worker prefers its own venv, not the system interpreter');
  assert.ok(/existsSync\(venv\) \? venv : 'python3'/.test(piper),
    'and only falls back when that venv does not exist');
  assert.ok(!stt.includes("'venv'"),
    'the STT worker uses the interpreter that already runs voice_stt.py');
});

test('the STT worker is referenced as a path to spawn, never as an import', () => {
  const stt = read(join(VOICE_DIR, 'stt-worker-supervisor.js'));
  assert.ok(stt.includes("new URL('./voice_stt_worker.py', import.meta.url).pathname"));
  for (const file of jsFiles(SRC)) {
    assert.ok(!/(?:import|require)\s*\(?\s*['"][^'"]*voice_stt_worker\.py['"]/.test(read(file)),
      `${file} must not import voice_stt_worker.py`);
  }
});

test('the Piper child gets argv and pipes, and nothing else', () => {
  for (const file of ['voice-engines.js', 'piper-worker-supervisor.js',
                      'stdio-worker.js', 'stt-worker-supervisor.js']) {
    const src = read(join(VOICE_DIR, file));
    // An argv ARRAY, never a shell string: an argv array cannot be word-split,
    // so a voice id containing a shell metacharacter is one opaque argument.
    assert.ok(!/\bexecSync\s*\(|\bexec\s*\(\s*[`'"]/.test(src),
      `${file} must not run Piper through a shell`);
    assert.ok(!/shell\s*:\s*true/.test(src),
      `${file} must not enable a shell for the child`);
  }
});

// ===========================================================================
// 2. The two interpreters are distinct
// ===========================================================================

test('the Piper worker does not run on the STT interpreter', () => {
  const supervisor = code(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  const engines = code(join(VOICE_DIR, 'voice-engines.js'));

  // VOICE_PYTHON_BIN names the interpreter for voice_stt.py, which imports
  // faster-whisper. Using it for the worker would put piper and faster-whisper
  // in one site-packages.
  //
  // Checked against CODE rather than raw text: the supervisor's own comments
  // name this variable to explain why it is not used, and an assertion that
  // fires on that explanation would be a false alarm on correct code.
  assert.ok(!supervisor.includes('VOICE_PYTHON_BIN'),
    'the supervisor must not reach for the STT interpreter');
  assert.ok(supervisor.includes("env('VOICE_PIPER_PYTHON'"),
    'it resolves its own interpreter variable');
  assert.ok(supervisor.includes("join(dir, 'venv', 'bin', 'python3')"),
    'defaulting into the Piper directory tree, not the system one');

  // And the STT side still uses its own.
  assert.ok(engines.includes("process.env.VOICE_PYTHON_BIN"),
    'the STT helper keeps VOICE_PYTHON_BIN');
});

test('every worker runs with a minimal environment', () => {
  const shared = read(join(VOICE_DIR, 'stdio-worker.js'));

  // Section 4.3: "with the existing minimal environment (PATH, HOME,
  // PYTHONDONTWRITEBYTECODE, OMP_NUM_THREADS, ORT_NUM_THREADS)". Node's default
  // is to hand a child the entire parent environment, which on this connector
  // includes API keys, the database URL and the session secret. A transcription
  // worker has no business holding any of them.
  const spawnBlock = shared.slice(shared.indexOf('child = spawn(interpreter'),
                                  shared.indexOf("stdio: ['pipe', 'pipe', 'pipe']"));
  assert.ok(spawnBlock.includes('PATH: process.env.PATH'));
  assert.ok(spawnBlock.includes('HOME: cwd'));
  assert.ok(spawnBlock.includes("PYTHONDONTWRITEBYTECODE: '1'"));

  // The thread posture is per-engine and is merged over the base.
  const piper = code(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  const stt = code(join(VOICE_DIR, 'stt-worker-supervisor.js'));
  assert.ok(piper.includes('OMP_NUM_THREADS') && piper.includes('ORT_NUM_THREADS'));
  assert.ok(stt.includes('OMP_NUM_THREADS'));

  // The check that matters: no wholesale inheritance, in the one place that
  // spawns anything.
  assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(shared),
    'a worker must not inherit the connector environment');
  assert.ok(!/env:\s*process\.env(?!\.)/.test(shared),
    'a worker must not inherit the connector environment');
});

test('workers communicate over stdio only', () => {
  const shared = read(join(VOICE_DIR, 'stdio-worker.js'));
  assert.ok(shared.includes("stdio: ['pipe', 'pipe', 'pipe']"));
  // No socket, no shared file, no named pipe. argv in, JSON lines out.
  assert.ok(!/node:net|node:dgram|createServer|listen\(/.test(shared),
    'no socket is opened to a worker');
});

// ===========================================================================
// 3. Neither Python program imports the other's dependency
// ===========================================================================

test('voice_stt.py never imports piper', () => {
  const stt = read(join(VOICE_DIR, 'voice_stt.py'));
  assert.ok(!/^\s*(?:import|from)\s+piper\b/m.test(stt),
    'the MIT helper must not import the GPL engine');
});

test('piper_worker.py never imports faster_whisper', () => {
  const worker = read(join(VOICE_DIR, 'piper_worker.py'));
  assert.ok(!/^\s*(?:import|from)\s+faster_whisper\b/m.test(worker),
    'the GPL worker must not import the MIT engine');
  // It should import piper -- that is its whole purpose, and the boundary is
  // that it does so in its own process rather than that it does not do so.
  assert.ok(/\bimport piper\b|from piper/.test(worker),
    'the worker does import piper, in its own process, which is the point');
});

test('voice_stt_worker.py never imports piper', () => {
  const worker = read(join(VOICE_DIR, 'voice_stt_worker.py'));
  // The same rule voice_stt.py carries, and it is now MORE load-bearing rather
  // than less: both workers are supervised by one module, so this file is where
  // the MIT half of the boundary is actually enforced.
  assert.ok(!/^\s*(?:import|from)\s+piper\b/m.test(worker),
    'the MIT worker must not import the GPL engine');
  assert.ok(/faster_whisper/.test(worker),
    'it does import faster-whisper, in its own process, which is the point');
});

test('the STT worker never execs the Piper binary', () => {
  const worker = read(join(VOICE_DIR, 'voice_stt_worker.py'));
  assert.ok(!/subprocess|os\.system|os\.exec|popen/i.test(worker),
    'the MIT worker spawns nothing at all, least of all Piper');
});

test('requirements-voice.txt keeps piper-tts out of the MIT environment', () => {
  const requirements = read(join(VOICE_DIR, 'requirements-voice.txt'));
  const declared = requirements
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  assert.ok(declared.some(line => line.startsWith('faster-whisper')),
    'the MIT engine is declared here');
  assert.ok(!declared.some(line => /piper/i.test(line)),
    'piper-tts must never be installed into the STT environment');
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

test('the worker script is never executed with the gate off', () => {
  // startWorker is only reachable from synthesizeViaWorker and prewarm, and
  // synthesis is unreachable when the routes 404. This asserts the second
  // entry point is gated, since the first is gated by the route.
  const supervisor = read(join(VOICE_DIR, 'piper-worker-supervisor.js'));
  assert.ok(supervisor.includes('export async function prewarm(modelPath)'));
  assert.ok(/if \(!workerEnabled\(\) \|\| !prewarmEnabled\(\)\) return false;/.test(supervisor),
    'and it also respects its own two flags');
});
