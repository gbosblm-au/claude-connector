#!/usr/bin/env node
/**
 * scripts/voice-worker-smoke.mjs
 *
 * PIPER-PRELOAD-v1.1 Section 8, item 1 -- THE HARD GATE.
 *
 * "Smoke test as a hard gate: prove the worker imports PiperVoice against the
 * pinned 1.2.0 in the deployed venv, loads en_US-kristin-medium.onnx, and
 * synthesises. This resolves the one API-version question (1.2.0 versus the
 * newer 1.6.0 documentation) before any agent work proceeds."
 *
 * ── Why this is a script and not a unit test ──────────────────────────────
 *
 * It is the only check here that needs the REAL deployment: the real Piper
 * virtual environment, the real interpreter, the real model file on the real
 * volume. None of those exist in CI, and a unit test that quietly skipped when
 * they were missing would report green for the one question this gate exists
 * to answer.
 *
 * So the unit tests assert the things that are true everywhere (the protocol,
 * the boundary, the transform), and this script answers the thing that is only
 * true on the box:
 *
 *     Does `from piper import PiperVoice` actually work in the venv we ship,
 *     and does the voice we ship actually produce audio through it?
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *     npm run voice:smoke
 *     npm run voice:smoke -- --voice en_US-kristin-medium
 *
 * Exits 0 on a pass and 1 on a failure, so it can gate a deploy.
 */

import { spawn }                    from 'node:child_process';
import { existsSync, readdirSync }  from 'node:fs';
import { join }                     from 'node:path';
// The single source of truth for which interpreter runs the worker.
import { workerState }              from '../src/voice/piper-worker-supervisor.js';

const WORKER = new URL('../src/voice/piper_worker.py', import.meta.url).pathname;

const PIPER_DIR  = process.env.VOICE_PIPER_DIR  || '/data/voice/piper';
const VOICES_DIR = process.env.VOICE_VOICES_DIR || join(PIPER_DIR, 'voices');
const THREADS    = process.env.VOICE_TTS_THREADS || '1';

/**
 * The interpreter the supervisor will use.
 *
 * IMPORTED, NOT REIMPLEMENTED. This was a second copy of the resolution logic,
 * and the two drifted the moment the supervisor's was corrected -- which is the
 * worst possible place for a gate to disagree with the thing it gates. A smoke
 * test that resolves a different interpreter from production can pass while
 * production fails, or fail while production works.
 *
 * @returns {string} The interpreter path, or '' when none resolves.
 */
function piperPython() {
  return workerState().interpreter || '';
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return (index !== -1 && process.argv[index + 1]) ? process.argv[index + 1] : fallback;
}

function installedVoices() {
  try {
    if (!existsSync(VOICES_DIR)) return [];
    return readdirSync(VOICES_DIR)
      .filter(f => f.endsWith('.onnx'))
      .map(f => f.slice(0, -'.onnx'.length))
      .sort();
  } catch (err) { return []; }
}

/**
 * Run the worker's --probe and return its JSON answer.
 *
 * @param {string} modelPath
 * @returns {Promise<{code: number, parsed: object|null, stderr: string}>}
 */
function probe(modelPath) {
  return new Promise((resolve) => {
    const args = [WORKER, '--probe'];
    if (modelPath) args.push('--model', modelPath);

    const child = spawn(piperPython(), args, {
      cwd: existsSync(PIPER_DIR) ? PIPER_DIR : undefined,
      // The same minimal environment the supervisor uses, so this proves the
      // configuration that will actually run rather than a friendlier one.
      env: {
        PATH: process.env.PATH,
        HOME: PIPER_DIR,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
        OMP_NUM_THREADS: THREADS,
        ORT_NUM_THREADS: THREADS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { if (err.length < 8192) err += c.toString(); });

    child.on('error', (spawnErr) => {
      resolve({ code: -1, parsed: null, stderr: `${spawnErr.message}` });
    });

    child.on('close', (code) => {
      let parsed = null;
      // Parse whatever the exit code: the worker writes its diagnosis to
      // stdout and exits non-zero on a failure, so refusing to read stdout on
      // a non-zero exit would throw away the explanation.
      const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
      try { parsed = JSON.parse(lastLine); } catch (parseErr) { parsed = null; }
      resolve({ code, parsed, stderr: err });
    });

    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      resolve({ code: -2, parsed: null, stderr: 'the probe timed out after 120s' });
    }, 120_000).unref();
  });
}

function fail(message, detail) {
  console.error(`\nFAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

async function main() {
  console.log('Tenax voice -- Piper worker smoke test (PIPER-PRELOAD-v1.1 Section 8)');
  console.log(`  interpreter : ${piperPython()}`);
  console.log(`  piper dir   : ${PIPER_DIR}`);
  console.log(`  voices dir  : ${VOICES_DIR}`);
  console.log(`  worker      : ${WORKER}\n`);

  if (!existsSync(WORKER)) fail(`the worker script is missing at ${WORKER}`);

  if (!piperPython()) {
    fail('no Piper interpreter could be resolved',
      'Set VOICE_PIPER_PYTHON to the python3 inside the Piper virtual environment.\n'
      + 'In the image built by this repository\'s Dockerfile that is:\n'
      + '  VOICE_PIPER_PYTHON=/opt/piper/bin/python3\n'
      + 'Note that VOICE_PIPER_DIR is the VOICES directory on the volume, not the venv.\n'
      + 'Synthesis will use the CLI fallback until this resolves.');
  }

  const installed = installedVoices();
  console.log(`Installed voices: ${installed.length ? installed.join(', ') : '(none)'}`);

  // Section 8 names en_US-kristin-medium, which is the English default the
  // licence audit settled on. Overridable, because the gate should follow the
  // voice actually deployed rather than the one the document was written
  // against.
  const preferred = arg('voice', process.env.VOICE_SMOKE_VOICE || 'en_US-kristin-medium');
  const voice = installed.includes(preferred) ? preferred : installed[0];

  if (!voice) {
    // Import alone is still worth proving: it answers the API-version question
    // even where no model has been downloaded yet.
    console.log('\nNo voice model installed; checking the import only.');
    const result = await probe('');
    if (!result.parsed) {
      fail('the worker produced no parseable answer',
           result.stderr || `exit ${result.code}`);
    }
    if (!result.parsed.ok) {
      fail(result.parsed.error || 'piper could not be imported', result.stderr);
    }
    console.log(`\nPASS (import only): piper imports in this venv.`);
    console.log(`  SynthesisConfig available: ${result.parsed.synthesis_config}`);
    console.log('  Download a voice and re-run to complete the gate.');
    return;
  }

  const modelPath = join(VOICES_DIR, `${voice}.onnx`);
  console.log(`\nProbing with ${voice}`);
  console.log(`  model: ${modelPath}`);
  if (!existsSync(modelPath)) fail(`no model file at ${modelPath}`);
  if (!existsSync(`${modelPath}.json`)) {
    // Piper needs the config beside the model; without it the sample rate and
    // phoneme map are missing and the failure is opaque.
    fail(`the voice config is missing at ${modelPath}.json`);
  }

  const started = Date.now();
  const result = await probe(modelPath);
  const elapsed = Date.now() - started;

  if (!result.parsed) {
    fail('the worker produced no parseable answer',
         result.stderr || `exit ${result.code}`);
  }

  const p = result.parsed;
  if (!p.ok) {
    console.error('\nWorker diagnosis:');
    console.error(`  code  : ${p.code || 'unknown'}`);
    console.error(`  error : ${p.error || '(none given)'}`);
    if ('piper_import_failed' === p.code) {
      console.error('\n  This is the Section 8 question answering itself: the venv at');
      console.error(`  ${piperPython()} cannot import piper. Install piper-tts into the`);
      console.error('  Piper directory tree, or set VOICE_PIPER_PYTHON to the interpreter');
      console.error('  that can. Until this passes, synthesis runs on the CLI fallback.');
    }
    fail('the worker could not synthesise', result.stderr);
  }

  console.log('\nPASS');
  console.log(`  adapter      : ${p.adapter}  (the Piper API generation in use)`);
  console.log(`  sample rate  : ${p.sample_rate} Hz`);
  console.log(`  pcm bytes    : ${p.pcm_bytes}`);
  console.log(`  synthesis    : ${p.synthesis_ms} ms (warm, after load)`);
  console.log(`  total probe  : ${elapsed} ms (includes the cold model load)`);
  console.log('\nThe resident worker can serve synthesis on this deployment.');
  console.log('Section 8 item 2 (the p50/p95 benchmark on the real CPU) is a separate,');
  console.log('still-open gate: run npm run voice:benchmark once this passes.');
}

main().catch((err) => fail(err.message, err.stack));
