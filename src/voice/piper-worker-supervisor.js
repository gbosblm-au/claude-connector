// src/voice/piper-worker-supervisor.js
//
// Tenax Voice -- supervisor for the resident Piper TTS worker.
// PIPER-PRELOAD-v1.1 Section 4.3.
//
// ===========================================================================
// v12.54.0: THE LIFECYCLE MOVED, THE BEHAVIOUR DID NOT
// ===========================================================================
//
// v12.53.0 implemented spawn, NDJSON framing, id routing, request timeouts,
// exponential backoff, idle unloading and health reporting inline in this file.
// Change 3 needed every one of them again for the Whisper worker, so they were
// extracted to stdio-worker.js and both engines now share them. Four hundred
// lines written twice is four hundred lines that drift: a backpressure fix
// applied to one, a leak fixed in the other, and eventually two supervisors
// that behave differently under load for reasons nobody remembers.
//
// The PUBLIC API here is unchanged -- same exports, same signatures, same
// null-means-fall-back contract -- because voice-engines.js calls it and A5
// requires that disabling the worker still yields byte-identical CLI behaviour.
// What remains below is only what is genuinely specific to Piper.
//
// ===========================================================================
// THE GPL BOUNDARY IS UNCHANGED, AND NOW NEEDS SAYING OUT LOUD
// ===========================================================================
//
// The worker is a SEPARATE OS PROCESS, run by the Piper venv's own interpreter,
// from the Piper directory, over stdio. Nothing GPL enters the Node import
// graph -- this file names a path, it does not import one.
//
// The discipline that got harder to SEE in v12.54.0: the Whisper worker is now
// supervised by the same module. The separation between them is therefore a
// difference in the INTERPRETER each supervisor supplies, not a difference in
// which file does the spawning. Concretely:
//
//     this file                  -> VOICE_PIPER_PYTHON  (piper, GPL-3.0+)
//     stt-worker-supervisor.js   -> VOICE_PYTHON_BIN    (faster-whisper, MIT)
//
// Conflating them puts both engines in one site-packages, which is exactly the
// entanglement the boundary exists to prevent. VOICE_PYTHON_BIN is never read
// in this file, and src/tests/voice-gpl-boundary.test.js asserts both halves.

import { existsSync }         from 'node:fs';
import { join, dirname }      from 'node:path';
import { createStdioWorker }  from './stdio-worker.js';

const WORKER_SCRIPT = new URL('./piper_worker.py', import.meta.url).pathname;

function env(name, fallback) {
  const raw = process.env[name];
  return (raw === undefined || raw === null || '' === String(raw).trim())
    ? fallback : String(raw);
}

function intEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function boolEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if ('' === raw) return fallback;
  return 'true' === raw || '1' === raw || 'yes' === raw;
}

/**
 * The interpreter that runs the Piper worker.
 *
 * DELIBERATELY NOT VOICE_PYTHON_BIN. That variable names the interpreter for
 * voice_stt.py and voice_stt_worker.py, which import faster-whisper. This one
 * imports piper. The whole boundary rests on those two never sharing a
 * site-packages.
 *
 * The default reaches into the Piper directory's own virtual environment, which
 * is where `pip install piper-tts` inside VOICE_PIPER_DIR puts an interpreter.
 * If that path does not exist the worker never starts and the CLI fallback
 * carries the feature, which is the correct failure.
 *
 * @returns {string}
 */
function piperPython() {
  const explicit = env('VOICE_PIPER_PYTHON', '');
  if (explicit) return explicit;

  // DERIVE THE INTERPRETER FROM THE BINARY WE ALREADY KNOW.
  //
  // The first version guessed `VOICE_PIPER_DIR/venv/bin/python3`, on the
  // assumption that the venv lived inside the Piper directory. It does not, and
  // the Dockerfile in this very repository says so:
  //
  //     VOICE_PIPER_BIN=/opt/piper/bin/piper     <- the venv
  //     VOICE_PIPER_DIR=/data/voice/piper        <- voices, on the volume
  //
  // Those are two different things. VOICE_PIPER_DIR is a DATA directory on the
  // mounted volume; the virtual environment is baked into the image at
  // /opt/piper. So the guess pointed at a path that never existed on any
  // correctly built deployment, and the old fallback then quietly used the
  // system python -- which cannot import piper, by design.
  //
  // VOICE_PIPER_BIN is the console script of the very venv we want, and it is
  // already set by the image. `dirname(bin)/python3` is that venv's interpreter
  // by construction: `python3 -m venv /opt/piper` puts both in /opt/piper/bin.
  // Deriving beats guessing -- the two cannot drift apart, because one is
  // computed from the other.
  const bin = env('VOICE_PIPER_BIN', '');
  if (bin) {
    const sibling = join(dirname(bin), 'python3');
    if (existsSync(sibling)) return sibling;
  }

  // Retained as a secondary guess for a layout that really does put the venv
  // under the Piper directory. Tried second because the derivation above is
  // evidence and this is an assumption.
  const dir = env('VOICE_PIPER_DIR', '/data/voice/piper');
  const venv = join(dir, 'venv', 'bin', 'python3');
  // EMPTY, NOT 'python3', WHEN THE VENV IS ABSENT.
  //
  // This previously fell back to the bare system interpreter, which is very
  // nearly the worst possible guess: the system python is the one interpreter
  // we can be confident does NOT have piper installed, because piper lives in
  // its own directory precisely to keep the GPL dependency out of everything
  // else. So the fallback reliably spawned a worker that started cleanly,
  // reported ready, and then failed every request with ModuleNotFoundError.
  //
  // A guess that is wrong by construction is worse than no guess. Returning
  // empty makes startWorker decline, and synthesis uses the CLI path -- which
  // drives the piper BINARY and is unaffected by any of this.
  return existsSync(venv) ? venv : '';
}

/** Section 10: default true. */
export function workerEnabled() {
  return boolEnv('VOICE_TTS_WORKER_ENABLED', true);
}

/** Section 10: default true. */
export function prewarmEnabled() {
  return boolEnv('VOICE_TTS_PREWARM', true);
}

/** Voices held loaded before LRU eviction. Section 4.2, default 1. */
function residentVoices() {
  return intEnv('VOICE_TTS_RESIDENT_VOICES', 1, 1, 8);
}

const worker = createStdioWorker({
  name: 'piper',
  script: WORKER_SCRIPT,
  interpreter: piperPython,
  cwd: () => env('VOICE_PIPER_DIR', '/data/voice/piper'),
  env: () => {
    // v12.52.0's thread posture, inherited unchanged (Section 2.5).
    const threads = String(intEnv('VOICE_TTS_THREADS', 1, 1, 64));
    return { OMP_NUM_THREADS: threads, ORT_NUM_THREADS: threads };
  },
  args: () => ['--resident-voices', String(residentVoices())],
  enabled: workerEnabled,

  // Codes that must NOT fall back to the CLI spawn, because the CLI spawn
  // would reject them identically. Everything else degrades (see call()).
  //
  // Note what is deliberately ABSENT: synthesis_failed, piper_import_failed,
  // model_load_failed, no_audio. Every one of those can be true of the resident
  // worker while the CLI binary works perfectly -- they are different programs
  // reaching Piper by different routes, and the Python module being missing
  // says nothing about the binary.
  refusals: () => ['empty_text', 'invalid_length_scale', 'no_model_path',
                   'unknown_op', 'bad_request'],
  timeoutMs: () => intEnv('VOICE_TTS_WORKER_TIMEOUT_MS', 60_000, 1000, 600_000),
  idleMs: () => intEnv('VOICE_TTS_WORKER_IDLE_MS', 300_000, 0, 24 * 3600_000),
  startMs: () => intEnv('VOICE_TTS_WORKER_START_MS', 45_000, 1000, 300_000),
  meta: () => ({
    prewarm: prewarmEnabled(),
    resident_voices: residentVoices(),
  }),
});

/**
 * Synthesise one unit of text through the resident worker.
 *
 * RESOLVES TO NULL WHEN THE WORKER CANNOT SERVE THE REQUEST, rather than
 * rejecting. That distinction is the fallback contract (Section 4.3, A5): null
 * means "the resident path is unavailable, use the CLI spawn". A genuine
 * synthesis refusal -- empty text, a bad length_scale -- still rejects, because
 * retrying it on the CLI path would produce the same refusal more slowly.
 *
 * @param {{text: string, modelPath: string, lengthScale?: number}} opts
 * @returns {Promise<{pcm: Buffer, sampleRate: number}|null>}
 */
export async function synthesizeViaWorker(opts) {
  const o = opts || {};
  if (!workerEnabled()) return null;

  const response = await worker.call({
    op: 'synthesize',
    text: o.text,
    model_path: o.modelPath,
    length_scale: Number.isFinite(o.lengthScale) && o.lengthScale > 0
      ? o.lengthScale : undefined,
  }, {
    startArgs: o.modelPath ? ['--model', o.modelPath] : [],
  });

  if (!response) return null;

  const pcm = Buffer.from(String(response.pcm_b64 || ''), 'base64');
  if (!pcm.length) return null;

  // An odd byte count is not 16-bit audio. Rather than hand the WAV writer a
  // buffer that will shift every sample after the first, this is treated as a
  // worker fault and falls back -- the CLI path is known to produce well-formed
  // PCM, so the user hears a reply instead of a burst of noise.
  if (pcm.length % 2 !== 0) {
    console.error('[voice] piper worker returned an odd byte count; using the CLI path');
    return null;
  }

  return { pcm, sampleRate: Number(response.sample_rate) || 0 };
}

/**
 * Warm the worker and load the default voice at boot (Section 5).
 *
 * Gated by the caller on voiceEnabled(), so Section 7 holds: with voice off, no
 * Piper process exists. Never throws and never blocks a boot -- Railway's health
 * check has a deadline, and a model load must not fail a deploy.
 *
 * @param {string} modelPath
 * @returns {Promise<boolean>}
 */
export async function prewarm(modelPath) {
  if (!workerEnabled() || !prewarmEnabled()) return false;
  if (!modelPath || !existsSync(modelPath)) return false;

  try {
    const started = await worker.start(['--model', modelPath]);
    if (!started) return false;
    // The --model flag already asked for a preload; this confirms it landed and
    // surfaces the sample rate and adapter for /voice/health.
    await worker.request({ op: 'load', model_path: modelPath }, 60_000);
    console.log('[voice] piper worker pre-warmed; the first utterance will be warm');
    return true;
  } catch (err) {
    // A failed pre-warm is not a failed boot. The CLI path still works and the
    // worker will be retried on the first real request.
    console.error(`[voice] pre-warm did not complete: ${err.message}`);
    return false;
  }
}

/**
 * Start the worker directly.
 *
 * @param {string} [preloadModel]
 * @returns {Promise<boolean>}
 */
export function startWorker(preloadModel) {
  return worker.start(preloadModel ? ['--model', preloadModel] : []);
}

/** @returns {Promise<void>} */
export function stopWorker() {
  return worker.stop();
}

/**
 * What the worker is doing, for /voice/health.
 *
 * A2 requires that "two consecutive synthesis requests reuse the same worker
 * process (asserted via a worker pid or warm flag surfaced in /voice/health)",
 * which is what `pid` and `warm` are for.
 *
 * `adapter` is FLATTENED out of capabilities rather than left nested, purely so
 * the shape v12.53.0 published stays the shape v12.54.0 publishes. A health
 * endpoint is an interface; moving a field because an internal refactor made it
 * convenient is how a dashboard silently starts reporting "unknown".
 *
 * @returns {object}
 */
export function workerState() {
  const health = worker.health();
  return Object.assign({}, health, {
    adapter: (health.capabilities && health.capabilities.adapter) || null,
  });
}

/** Reset for tests. */
export function resetWorkerState() {
  worker.reset();
}

export default {
  workerEnabled, prewarmEnabled, startWorker, synthesizeViaWorker,
  prewarm, stopWorker, workerState, resetWorkerState,
};
