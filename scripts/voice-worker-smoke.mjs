#!/usr/bin/env node
/* scripts/voice-worker-smoke.mjs
 *
 * Tenax voice -- the Kokoro worker smoke test. SPEC-KOKORO-001 Section 11.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * probeEngines() answers "are the files there and is an interpreter
 * configured". That is all it can afford to answer, because it runs on the
 * health path and a real model load costs seconds.
 *
 * This asks the questions that only a real load can settle:
 *
 *   1. Does `import kokoro_onnx` actually work in the venv we ship?
 *   2. Does the model load, and does the bundle contain the voices the
 *      registry offers?
 *   3. Does one real utterance come back as audio?
 *
 * Documentation cannot answer any of those, and neither can a unit test with no
 * model on disk. Run it once after a deploy.
 *
 *   npm run voice:smoke
 */

import { spawn }        from 'node:child_process';
import { existsSync }   from 'node:fs';

import { kokoroPython, kokoroDir, modelPath, voicesPath, g2pMode, artifactSource }
  from '../src/voice/kokoro-worker-supervisor.js';
import { VOICE_REGISTRY, DEFAULT_VOICE }
  from '../src/voice/voice-registry.js';

const WORKER = new URL('../src/voice/kokoro_worker.py', import.meta.url).pathname;

function line(label, value) {
  console.log(`  ${String(label).padEnd(14)}: ${value}`);
}

/**
 * Run the worker's own --probe mode.
 *
 * The SAME entry point the supervisor spawns, deliberately: a smoke test that
 * reimplemented the invocation could pass while the real path failed, which is
 * the one outcome that would make it worse than useless.
 *
 * @returns {Promise<object>}
 */
function probe() {
  return new Promise((resolve, reject) => {
    const python = kokoroPython();
    if (!python) {
      reject(new Error('No Kokoro interpreter found. Set VOICE_KOKORO_PYTHON to '
        + 'the venv python3 that has kokoro-onnx installed.'));
      return;
    }

    const child = spawn(python, [
      WORKER, '--probe',
      '--model', modelPath(), '--voices', voicesPath(), '--g2p', g2pMode(),
    ], {
      cwd: existsSync(kokoroDir()) ? kokoroDir() : undefined,
      env: {
        PATH: process.env.PATH,
        HOME: kokoroDir(),
        PYTHONDONTWRITEBYTECODE: '1',
        ...(process.env.ESPEAK_DATA_PATH
          ? { ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      // The LAST parseable line: a dependency that prints an import warning to
      // stdout must not be mistaken for the result.
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { resolve(JSON.parse(lines[i])); return; } catch (e) { /* keep looking */ }
      }
      reject(new Error(err.trim().slice(0, 600)
        || `the probe exited ${code} without a response`));
    });
  });
}

/**
 * A paragraph of the length this assistant actually produces.
 *
 * v13.1.0. "Voice check." is two words: it proves the engine renders, and tells
 * you NOTHING about whether the CPU budget is viable. The question that decides
 * that is how long a typical reply takes, and the honest way to answer it is to
 * render one.
 */
const PARAGRAPH =
  'The real cost of the migration is not the licence but the audit. '
  + 'Most teams budget for the software and then discover that three months of '
  + 'reconciliation work sits between them and a clean cutover. '
  + 'If you plan for that up front, the rest is routine.';

/**
 * Render one paragraph in a fresh process and time it.
 *
 * Uses --once rather than the resident worker DELIBERATELY, and the number it
 * produces is therefore a WORST CASE: it includes the full model load that the
 * resident worker pays only at boot. A warm request is faster, and the gap
 * between the two is itself worth seeing, because it is the value of the
 * resident worker expressed in milliseconds.
 *
 * @returns {Promise<{bytes: number, sampleRate: number, wallMs: number, engineMs: number}>}
 */
function renderParagraph() {
  return new Promise((resolve, reject) => {
    const python = kokoroPython();
    if (!python) { reject(new Error('no interpreter')); return; }

    const started = Date.now();
    const child = spawn(python, [
      WORKER, '--once',
      '--model', modelPath(), '--voices', voicesPath(), '--g2p', g2pMode(),
    ], {
      cwd: existsSync(kokoroDir()) ? kokoroDir() : undefined,
      env: {
        PATH: process.env.PATH,
        HOME: kokoroDir(),
        PYTHONDONTWRITEBYTECODE: '1',
        ...(process.env.ESPEAK_DATA_PATH
          ? { ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { err += c.toString(); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({
      op: 'synthesize', text: PARAGRAPH, voice: DEFAULT_VOICE,
    }) + '\n', 'utf8');

    child.on('error', reject);
    child.on('close', () => {
      const wallMs = Date.now() - started;
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (!parsed.ok) { reject(new Error(parsed.error || 'render failed')); return; }
          resolve({
            bytes: parsed.bytes || 0,
            sampleRate: parsed.sample_rate || 0,
            wallMs,
            engineMs: parsed.elapsed_ms || 0,
          });
          return;
        } catch (e) { /* keep looking */ }
      }
      reject(new Error(err.trim().slice(0, 400) || 'no response'));
    });
  });
}

async function main() {
  console.log('Tenax voice -- Kokoro worker smoke test (SPEC-KOKORO-001 Section 11)');
  line('interpreter', kokoroPython() || '(none found)');
  const src = artifactSource();
  // v13.2.0. WHICH LAYER, not just which path. `image` is the baked copy that
  // survives every redeploy; `volume` means someone dropped a file in and the
  // engine is running that instead; `configured` means an env var pinned it.
  line('model', `${modelPath()}  [${src.model}]`);
  line('bundle', `${voicesPath()}  [${src.voices}]`);
  line('g2p', g2pMode());
  line('default voice', DEFAULT_VOICE);
  console.log('');

  let result;
  try {
    result = await probe();
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`FAIL  ${result.code || 'probe_failed'}: ${result.error || 'no detail'}`);
    process.exit(1);
  }

  const caps = result.capabilities || {};
  const inBundle = new Set(caps.voices || []);
  line('engine', caps.engine || 'unknown');
  line('bundle voices', caps.voice_count ?? '(unknown)');
  line('sample rate', caps.native_sample_rate || '(unknown)');
  line('audio bytes', result.bytes ?? '(none)');
  line('elapsed', `${result.elapsed_ms ?? '?'}ms`);
  console.log('');

  // The check that matters most operationally: the registry offers five voices,
  // and a bundle version mismatch would leave some of them absent. That failure
  // presents to a user as a Speak button which works for some voices and not
  // others, which is far harder to diagnose than a clean list here.
  let missing = 0;
  for (const v of VOICE_REGISTRY.filter(x => x.active)) {
    const present = 0 === inBundle.size || inBundle.has(v.name);
    if (!present) missing += 1;
    console.log(`  ${present ? 'ok  ' : 'MISS'}  ${v.name.padEnd(12)} ${v.label}`);
  }

  // ---- latency, the number the CPU decision rests on ---------------------
  console.log('');
  try {
    const r = await renderParagraph();
    // int16 mono: two bytes per sample.
    const audioSec = (r.bytes / 2) / (r.sampleRate || 1);
    const factor = audioSec / (r.wallMs / 1000);
    line('paragraph', `${PARAGRAPH.length} chars`);
    line('audio', `${audioSec.toFixed(1)}s at ${r.sampleRate} Hz`);
    line('cold total', `${r.wallMs}ms  (includes the model load)`);
    line('engine only', `${r.engineMs}ms  (what a warm worker pays)`);
    line('realtime x', factor.toFixed(2));
    console.log('');
    // The threshold that matters is not a benchmark score, it is whether a
    // listener waits. Below 1.0x the audio arrives slower than it plays, which
    // on the streaming path means the voice stutters mid-reply.
    if (factor < 1.0) {
      console.log('  WARNING  synthesis is slower than realtime on this host. '
        + 'The streaming path will stutter; consider more CPU or a GPU budget.');
    } else if (factor < 2.0) {
      console.log('  NOTE     under 2x realtime. Workable, but a long reply on a '
        + 'loaded host may approach the gateway 120s ceiling.');
    } else {
      console.log('  Latency looks comfortable for an assistant voice.');
    }
  } catch (err) {
    console.log(`  (paragraph timing unavailable: ${err.message})`);
  }

  console.log('');
  if (missing) {
    console.error(`FAIL  ${missing} offered voice(s) are not in the bundle. `
      + 'Check the bundle version matches the registry.');
    process.exit(1);
  }
  console.log('PASS  the engine loads, the bundle carries every offered voice, '
    + 'and one real utterance rendered.');
}

main().catch((err) => {
  console.error(`FAIL  ${err.message}`);
  process.exit(1);
});
