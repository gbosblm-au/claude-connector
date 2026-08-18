// src/voice/stt-worker-supervisor.js
//
// Tenax Voice -- supervisor for the resident speech-to-text worker.
// PIPER-PRELOAD-v1.1 Section 6 (Change 3).
//
// ===========================================================================
// WHAT THIS ADDS OVER THE PIPER SUPERVISOR
// ===========================================================================
//
// Almost nothing, which is the point: the lifecycle lives in stdio-worker.js
// and both engines use it. What is here is only what is genuinely specific to
// Whisper:
//
//   - a DIFFERENT INTERPRETER (see the licence note below)
//   - a three-state residency model rather than an on/off one
//   - a much longer request timeout, because transcription of a minute of
//     audio legitimately takes longer than synthesising a phrase
//
// ===========================================================================
// THE LICENCE BOUNDARY (voice spec Section 6.2, compliance obligation 1)
// ===========================================================================
//
// This worker imports faster_whisper, which is MIT. It runs on
// VOICE_PYTHON_BIN, the same interpreter voice_stt.py has always used.
//
// The Piper worker imports piper, which is GPL-3.0-or-later, and runs on
// VOICE_PIPER_PYTHON.
//
// THOSE TWO MUST NEVER BE THE SAME INTERPRETER. Since v12.54.0 both workers are
// supervised by one shared module, which means the separation is now expressed
// as a difference in what each supervisor PASSES IN rather than as a difference
// between two files. That is a genuine weakening of a structural guarantee, and
// it is compensated for by asserting it directly in
// src/tests/voice-gpl-boundary.test.js -- which checks that this file resolves
// VOICE_PYTHON_BIN, that piper-worker-supervisor.js never mentions it, and that
// the two resolvers cannot collapse to one value by default.

import { join }        from 'node:path';
import { createStdioWorker } from './stdio-worker.js';

const WORKER_SCRIPT = new URL('./voice_stt_worker.py', import.meta.url).pathname;

function boolEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if ('' === raw) return fallback;
  return 'true' === raw || '1' === raw || 'yes' === raw;
}

function intEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** Section 10: default true. The worker may run at all. */
export function sttWorkerEnabled() {
  return boolEnv('VOICE_STT_WORKER_ENABLED', true);
}

/**
 * Section 10: default true. Whether the model is HELD between requests.
 *
 * Separate from sttWorkerEnabled() because Section 6 makes it separate:
 * "because holding Whisper plus Piper resident simultaneously may exceed a
 * small instance's memory, STT residency is independently configurable".
 *
 * With this false the process still stays warm -- saving the interpreter start
 * and the faster_whisper import, which is a second or more -- while holding no
 * model between requests. An operator on a tight instance gives up only the
 * part that actually costs memory, instead of the whole optimisation.
 *
 * @returns {boolean}
 */
export function sttWorkerResident() {
  return boolEnv('VOICE_STT_WORKER_RESIDENT', true);
}

/**
 * The interpreter for this worker.
 *
 * VOICE_PYTHON_BIN, deliberately and by name: this is the MIT side of the
 * licence boundary and it runs where voice_stt.py has always run. See the
 * header.
 *
 * @returns {string}
 */
function sttPython() {
  return process.env.VOICE_PYTHON_BIN || 'python3';
}

/**
 * Transcription needs far longer than synthesis.
 *
 * A minute of audio on the base tier is seconds of work even warm, and the
 * first request after a cold start also pays the model load. Reusing the
 * synthesis timeout here would kill legitimate long transcriptions and look
 * exactly like a wedged worker.
 *
 * Follows VOICE_STT_TIMEOUT so the resident path and the per-request path share
 * one ceiling, plus headroom for a first-request model load.
 *
 * @returns {number}
 */
function requestTimeoutMs() {
  const base = intEnv('VOICE_STT_TIMEOUT', 120_000, 1000, 900_000);
  return base + intEnv('VOICE_STT_WORKER_LOAD_GRACE_MS', 60_000, 0, 600_000);
}

const worker = createStdioWorker({
  name: 'stt',
  script: WORKER_SCRIPT,
  interpreter: sttPython,
  // The model cache root, which is where the worker will read and write. Using
  // the connector's own cwd would let a stray relative path escape into the
  // application tree.
  cwd: () => process.env.VOICE_MODEL_DIR || '/data/voice/models',
  env: () => ({
    // The thread posture the per-request path already uses, inherited
    // unchanged. CTranslate2 reads OMP_NUM_THREADS, and a resident worker that
    // suddenly used every core would starve synthesis on a shared instance.
    OMP_NUM_THREADS: String(intEnv('VOICE_STT_THREADS', 1, 1, 64)),
  }),
  args: () => ['--resident', sttWorkerResident() ? 'true' : 'false'],
  enabled: sttWorkerEnabled,
  timeoutMs: requestTimeoutMs,
  // Whisper is the larger model of the two, so it is released sooner by
  // default. On an instance holding both, this is the one whose idle footprint
  // is worth reclaiming first.
  idleMs: () => intEnv('VOICE_STT_WORKER_IDLE_MS', 180_000, 0, 24 * 3600_000),
  // Loading a model can legitimately take minutes on a cold cache, because it
  // may be downloading several hundred megabytes.
  startMs: () => intEnv('VOICE_STT_WORKER_START_MS', 60_000, 1000, 900_000),
  meta: () => ({ resident: sttWorkerResident() }),
});

/**
 * Transcribe one audio file through the resident worker.
 *
 * RESOLVES TO NULL WHEN THE WORKER CANNOT SERVE IT, which the caller reads as
 * "use the per-request spawn". Section 6: transcribe() routes here "and falls
 * back to the current per-request spawn on failure", so the worst case of
 * enabling this is the behaviour that already shipped.
 *
 * A transcription REFUSAL -- an unknown tier, a missing file -- still rejects,
 * because the per-request path would refuse identically and more slowly.
 *
 * @param {{path: string, model: string, modelDir: string, language?: string}} opts
 * @returns {Promise<{text: string, language: string, duration_seconds: number, segments: Array}|null>}
 */
export async function transcribeViaWorker(opts) {
  const o = opts || {};
  if (!sttWorkerEnabled()) return null;

  const response = await worker.call({
    op: 'transcribe',
    path: o.path,
    model: o.model,
    model_dir: o.modelDir,
    language: o.language || undefined,
  }, {
    // Preload at spawn only when residency is on. Asking a worker that has
    // promised to release the model after the next request to preload one is
    // work with no beneficiary, and the worker itself declines it.
    startArgs: (sttWorkerResident() && o.model)
      ? ['--model', o.model, '--model-dir', o.modelDir || '']
      : [],
  });

  if (!response) return null;

  // Shaped exactly like voice_stt.py's stdout, minus the protocol envelope, so
  // transcribe() cannot tell which path produced it.
  return {
    text: String(response.text || ''),
    language: String(response.language || ''),
    duration_seconds: Number(response.duration_seconds) || 0,
    segments: Array.isArray(response.segments) ? response.segments : [],
  };
}

/**
 * Warm the worker at boot.
 *
 * Gated by the caller on voiceEnabled(), so the master switch still means no
 * process exists. Never throws and never blocks a boot.
 *
 * @param {{model: string, modelDir: string}} opts
 * @returns {Promise<boolean>}
 */
export async function prewarm(opts) {
  const o = opts || {};
  if (!sttWorkerEnabled()) return false;
  // Nothing to warm when the model will be released after the next request
  // anyway. The process still starts on first use; this only skips loading a
  // model the operator asked us not to hold.
  if (!sttWorkerResident()) return false;

  try {
    const started = await worker.start(
      o.model ? ['--model', o.model, '--model-dir', o.modelDir || ''] : []
    );
    if (!started) return false;
    await worker.request({ op: 'load', model: o.model, model_dir: o.modelDir || '' },
                         requestTimeoutMs());
    console.log('[voice] stt worker pre-warmed; the first transcription will be warm');
    return true;
  } catch (err) {
    console.error(`[voice] stt pre-warm did not complete: ${err.message}`);
    return false;
  }
}

/** @returns {object} */
export function sttWorkerState() {
  return worker.health();
}

/** @returns {Promise<void>} */
export function stopSttWorker() {
  return worker.stop();
}

/** Reset for tests. */
export function resetSttWorker() {
  worker.reset();
}

export default {
  sttWorkerEnabled, sttWorkerResident, transcribeViaWorker,
  prewarm, sttWorkerState, stopSttWorker, resetSttWorker,
};
