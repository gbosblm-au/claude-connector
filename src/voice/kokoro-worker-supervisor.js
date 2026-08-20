// src/voice/kokoro-worker-supervisor.js
//
// Tenax Voice -- supervisor for the resident Kokoro-82M TTS worker.
// SPEC-KOKORO-001 v1.1, Section 7.2.
//
// ===========================================================================
// WHAT THIS REPLACES, AND WHAT IT KEEPS
// ===========================================================================
//
// This is the retired Piper supervisor with the engine swapped. The lifecycle --
// spawn, NDJSON framing, id routing, request timeouts, exponential backoff,
// idle unloading, health reporting -- all still lives in stdio-worker.js and is
// shared with the STT worker. Only what is genuinely Kokoro-specific is here.
//
// The PUBLIC API is deliberately unchanged: same exports, same signatures, same
// null-means-fall-back contract. voice-engines.js calls this module, and keeping
// the shape means the swap is a change of engine rather than a rewrite of the
// caller.
//
// ===========================================================================
// THE FALLBACK CONTRACT IS NOW LOAD-BEARING IN A WAY IT WAS NOT BEFORE
// ===========================================================================
//
// Under Piper there were always two routes to audio: this worker, and a fresh
// `piper` binary per utterance. A null answer from here meant "use the CLI
// spawn", and that is why a crashed or backing-off worker cost LATENCY rather
// than SPEECH.
//
// Retiring Piper deletes that second route. If the resident worker were the only
// path, one bad model load or one OOM kill would leave the platform mute with no
// way back until a restart.
//
// So the subprocess mode of Section 7.1 is kept as the second tier rather than
// discarded after the evaluation phase, and `synthesizeOnce()` below is it. It
// runs the SAME script with --once: one request in, one response out, then exit.
// Same code, same request shape, so the two tiers cannot drift the way two
// implementations would. It pays a full model load per utterance -- precisely
// the cost the resident worker exists to avoid -- which is the right trade for a
// degraded path nobody should normally be on.
//
// ===========================================================================
// THE GPL BOUNDARY MOVED WITH THE ENGINE; IT DID NOT GO AWAY
// ===========================================================================
//
// Kokoro-82M is Apache-2.0, so it is tempting to conclude the process boundary
// Piper needed is now ceremony.
//
// It is not. kokoro-onnx phonemises through `phonemizer`, which drives espeak-ng,
// and ESPEAK-NG IS GPL-3.0. The GPL dependency moved from the model to the
// phonemiser. The separation is therefore still a difference in the INTERPRETER
// each supervisor supplies:
//
//     this file                  -> VOICE_KOKORO_PYTHON  (espeak-ng, GPL-3.0)
//     stt-worker-supervisor.js   -> VOICE_PYTHON_BIN     (faster-whisper, MIT)
//
// Conflating them puts both engines in one site-packages, which is the
// entanglement the boundary exists to prevent. VOICE_PYTHON_BIN is never read in
// this file.

import { existsSync }         from 'node:fs';
import { spawn }              from 'node:child_process';
import { join, dirname }      from 'node:path';
import { createStdioWorker }  from './stdio-worker.js';

const WORKER_SCRIPT = new URL('./kokoro_worker.py', import.meta.url).pathname;

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

/** Where the model, the voice bundle and the venv live. */
export function kokoroDir() {
  return env('VOICE_KOKORO_DIR', '/data/voice/kokoro');
}

/**
 * Where the engine artifacts are baked into the IMAGE.
 *
 * v13.2.0. Deliberately NOT under /data.
 *
 * ── The mistake this exists to correct ────────────────────────────────────
 *
 * v13.0.0's Dockerfile ran `mkdir -p /data/voice/kokoro` and set the artifact
 * paths there. On a platform that mounts a persistent volume at /data, THE
 * MOUNT SHADOWS EVERYTHING THE IMAGE PUT THERE. So baking the model to that
 * path would not merely have been redundant, it would have been invisible: the
 * files would exist in the image layer and be unreachable at runtime.
 *
 * /opt is part of the image filesystem and nothing mounts over it, which is why
 * the venv already lives there.
 */
const BAKED_DIR = '/opt/kokoro/models';

/**
 * Resolve one engine artifact, in precedence order.
 *
 *   1. An explicit environment variable   -- the operator said exactly where.
 *   2. The volume, if the file is there   -- an override, or a newer model
 *                                            dropped in without a rebuild.
 *   3. The copy baked into the image      -- always present, survives every
 *                                            redeploy, needs no network.
 *
 * An explicit path is honoured EVEN WHEN THE FILE IS ABSENT, so the failure
 * names what the operator configured rather than silently falling back to
 * something they did not ask for. Silently substituting a different model for
 * the one someone deliberately pointed at is how a deployment comes to be
 * running weights nobody chose.
 *
 * @param {string} envName
 * @param {string} filename
 * @returns {string}
 */
function resolveArtifact(envName, filename) {
  const explicit = env(envName, '');
  if (explicit) return explicit;

  const onVolume = join(kokoroDir(), filename);
  try {
    if (existsSync(onVolume)) return onVolume;
  } catch (err) {
    // An unreadable volume is not a reason to have no engine at all.
  }

  return join(BAKED_DIR, filename);
}

/** The ONNX model file. */
export function modelPath() {
  return resolveArtifact('VOICE_KOKORO_MODEL', 'kokoro-v1.0.onnx');
}

/** The bundle of voice style vectors. */
export function voicesPath() {
  return resolveArtifact('VOICE_KOKORO_VOICES', 'voices-v1.0.bin');
}

/**
 * Where the artifacts actually came from, for /voice/health.
 *
 * An operator debugging "why does it sound different after the redeploy" needs
 * to know whether the engine is running the image's copy or one someone left on
 * the volume. Reporting the resolved PATH alone does not answer that, because
 * both paths look equally plausible in a log line.
 *
 * @returns {{model: string, voices: string}}
 */
export function artifactSource() {
  const describe = (resolved, envName) => {
    if (env(envName, '')) return 'configured';
    return resolved.startsWith(BAKED_DIR) ? 'image' : 'volume';
  };
  return {
    model: describe(modelPath(), 'VOICE_KOKORO_MODEL'),
    voices: describe(voicesPath(), 'VOICE_KOKORO_VOICES'),
  };
}

/** The image-baked artifact directory, for provisioning and diagnostics. */
export function bakedDir() {
  return BAKED_DIR;
}

/**
 * Which grapheme-to-phoneme front end to use.
 *
 * 'espeak' is the default because it is what a bare `pip install kokoro-onnx`
 * provides. 'misaki' is what makes the Section 4 markup real -- and the reason
 * voice-prosody-prep.js emits no markup at all on the espeak path is that
 * espeak PRONOUNCES the brackets rather than ignoring them.
 *
 * @returns {'espeak'|'misaki'}
 */
export function g2pMode() {
  const raw = env('VOICE_KOKORO_G2P', 'espeak').trim().toLowerCase();
  return 'misaki' === raw ? 'misaki' : 'espeak';
}

/**
 * The interpreter that runs the Kokoro worker.
 *
 * DELIBERATELY NOT VOICE_PYTHON_BIN. That names the interpreter for
 * voice_stt.py, which imports faster-whisper. This one imports kokoro_onnx and,
 * through phonemizer, reaches espeak-ng. The boundary rests on those two never
 * sharing a site-packages.
 *
 * Returns EMPTY rather than 'python3' when no venv is found. The Piper
 * supervisor learned this the hard way: falling back to the bare system
 * interpreter is very nearly the worst possible guess, because the system python
 * is the one we can be confident does NOT have the engine installed -- the venv
 * exists precisely to keep the dependency out of everything else. The result was
 * a worker that started cleanly, reported ready, and then failed every request
 * with ModuleNotFoundError.
 *
 * A guess that is wrong by construction is worse than no guess. Empty makes
 * startWorker decline, and synthesis takes the one-shot path.
 *
 * @returns {string}
 */
export function kokoroPython() {
  const explicit = env('VOICE_KOKORO_PYTHON', '');
  if (explicit) return explicit;

  // Derive from the venv beside the model directory, which is where
  // `python3 -m venv` inside the image puts it. Checked for existence rather
  // than assumed, so a wrong layout declines instead of half-working.
  for (const candidate of [
    join(kokoroDir(), 'venv', 'bin', 'python3'),
    join('/opt/kokoro', 'bin', 'python3'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  return '';
}

/** Resident worker on by default. */
export function workerEnabled() {
  return boolEnv('VOICE_TTS_WORKER_ENABLED', true);
}

/** Pre-warm at boot on by default. */
export function prewarmEnabled() {
  return boolEnv('VOICE_TTS_PREWARM', true);
}

/**
 * Is the one-shot subprocess fallback available?
 *
 * On by default, and this default matters more than it looks: with Piper gone it
 * is the only thing between a sick worker and a mute platform. Switching it off
 * is a deliberate choice to accept total voice loss on worker failure in
 * exchange for never paying a cold model load.
 */
export function fallbackEnabled() {
  return boolEnv('VOICE_TTS_SUBPROCESS_FALLBACK', true);
}

/**
 * Environment for the child.
 *
 * Explicit and minimal. The default would hand this process every API key the
 * connector holds, and the boundary is as much about what the child cannot see
 * as about which interpreter runs it.
 *
 * @returns {object}
 */
function childEnv() {
  // onnxruntime and OpenMP size their thread pools from the CPU count they can
  // SEE, which on a container is the host's count rather than the share this
  // service is entitled to. On a small instance that is a dozen threads fighting
  // over a fraction of a core, each with its own arena -- slower AND heavier than
  // running single-threaded. The platform decision is a CPU budget, so 1 is the
  // right default and the value is overridable for a larger plan.
  const threads = String(intEnv('VOICE_TTS_THREADS', 1, 1, 64));
  const vars = {
    PATH: process.env.PATH,
    HOME: kokoroDir(),
    PYTHONDONTWRITEBYTECODE: '1',
    OMP_NUM_THREADS: threads,
    ORT_NUM_THREADS: threads,
    VOICE_KOKORO_MODEL: modelPath(),
    VOICE_KOKORO_VOICES: voicesPath(),
    VOICE_KOKORO_G2P: g2pMode(),
    VOICE_MISAKI_ESPEAK_FALLBACK:
      env('VOICE_MISAKI_ESPEAK_FALLBACK', 'true'),
  };
  // espeak-ng needs to find its data directory when it is not on the default
  // prefix. Passed through only if set, so an unset value does not become the
  // string "undefined" in the child's environment.
  const espeakData = env('ESPEAK_DATA_PATH', '');
  if (espeakData) vars.ESPEAK_DATA_PATH = espeakData;
  return vars;
}

/** Fixed argv for the resident worker. */
function workerArgs() {
  return ['--model', modelPath(), '--voices', voicesPath(), '--g2p', g2pMode()];
}

const worker = createStdioWorker({
  name: 'kokoro',
  script: WORKER_SCRIPT,
  interpreter: kokoroPython,
  cwd: kokoroDir,
  env: childEnv,
  args: workerArgs,
  enabled: workerEnabled,

  // Codes that must NOT fall back, because the one-shot path would reject them
  // identically and more slowly.
  //
  // Note what is deliberately ABSENT: synthesis_failed, kokoro_import_failed,
  // no_audio. Those can all be true of a sick resident worker while a fresh
  // process works perfectly -- a worker whose model got corrupted in memory, or
  // one that was OOM-killed mid-request, says nothing about whether a new
  // process can load the same file from disk.
  //
  // unknown_voice IS a refusal: the bundle on disk is the same bundle either
  // way, so a second process would reach the same answer.
  refusals: () => ['empty_text', 'invalid_length_scale', 'invalid_sample_rate',
                   'no_voice', 'unknown_voice', 'unknown_op', 'bad_request'],
  timeoutMs: () => intEnv('VOICE_TTS_WORKER_TIMEOUT_MS', 60_000, 1000, 600_000),
  idleMs: () => intEnv('VOICE_TTS_WORKER_IDLE_MS', 300_000, 0, 24 * 3600_000),
  startMs: () => intEnv('VOICE_TTS_WORKER_START_MS', 45_000, 1000, 300_000),
  meta: () => ({
    prewarm: prewarmEnabled(),
    g2p: g2pMode(),
    model: modelPath(),
    bundle: voicesPath(),
    subprocess_fallback: fallbackEnabled(),
  }),
});

/**
 * Build the wire request for one utterance.
 *
 * Shared by both tiers so they cannot disagree about what was asked for. A
 * divergence here would be the worst kind of bug: audio that changes character
 * when the worker happens to be unhealthy.
 *
 * @param {object} o
 * @returns {object}
 */
function synthesisRequest(o) {
  return {
    op: 'synthesize',
    text: o.text,
    voice: o.voice,
    // The caller supplies an ABSOLUTE length_scale rather than a speed, because
    // the prosody layer varies it per phrase and cannot express "the voice's own
    // base times 1.08" as a speed multiplier. The worker converts once.
    length_scale: Number.isFinite(o.lengthScale) && o.lengthScale > 0
      ? o.lengthScale : undefined,
    sample_rate: Number.isFinite(o.sampleRate) && o.sampleRate > 0
      ? o.sampleRate : undefined,
    lang: o.lang || undefined,
  };
}

/**
 * Interpret a worker response as PCM.
 *
 * @param {object|null} response
 * @param {string} tier For the log line when the payload is malformed.
 * @returns {{pcm: Buffer, sampleRate: number, degraded: Array<string>}|null}
 */
function readPcm(response, tier) {
  if (!response) return null;

  const pcm = Buffer.from(String(response.pcm_b64 || ''), 'base64');
  if (!pcm.length) return null;

  // An odd byte count is not 16-bit audio. Rather than hand the WAV writer a
  // buffer that will shift every sample after the first -- which is heard as a
  // burst of noise, not as a glitch -- this is treated as a fault so the caller
  // can try the other tier.
  if (pcm.length % 2 !== 0) {
    console.error(`[voice] kokoro ${tier} returned an odd byte count; treating as a fault`);
    return null;
  }

  return {
    pcm,
    sampleRate: Number(response.sample_rate) || 0,
    degraded: Array.isArray(response.degraded) ? response.degraded : [],
  };
}

/**
 * Synthesise one unit of text through the resident worker.
 *
 * RESOLVES TO NULL WHEN THE WORKER CANNOT SERVE THE REQUEST, rather than
 * rejecting. Null means "the resident path is unavailable, try the next tier".
 * A genuine refusal -- empty text, an unknown voice, a bad length_scale -- still
 * rejects, because reaching the same refusal through a second process helps
 * nobody.
 *
 * @param {{text: string, voice: string, lengthScale?: number,
 *          sampleRate?: number, lang?: string}} opts
 * @returns {Promise<{pcm: Buffer, sampleRate: number, degraded: Array<string>}|null>}
 */
export async function synthesizeViaWorker(opts) {
  const o = opts || {};
  if (!workerEnabled()) return null;

  const response = await worker.call(synthesisRequest(o), { startArgs: workerArgs() });
  return readPcm(response, 'worker');
}

/**
 * Synthesise one unit of text in a fresh process (Section 7.1).
 *
 * The second tier. Pays a full model load, and is worth it only because the
 * alternative -- with Piper retired -- is no audio at all.
 *
 * Rejects rather than returning null, because there is no third tier: by the
 * time this fails the caller has run out of options and needs the reason, not
 * another null to interpret.
 *
 * @param {{text: string, voice: string, lengthScale?: number,
 *          sampleRate?: number, lang?: string}} opts
 * @returns {Promise<{pcm: Buffer, sampleRate: number, degraded: Array<string>}>}
 */
export function synthesizeOnce(opts) {
  const o = opts || {};

  return new Promise((resolve, reject) => {
    const interpreter = kokoroPython();
    if (!interpreter) {
      const err = new Error(
        'No Kokoro interpreter found. Set VOICE_KOKORO_PYTHON to the venv '
        + 'python3 that has kokoro-onnx installed.');
      err.code = 'no_interpreter';
      reject(err);
      return;
    }

    const timeoutMs = intEnv('VOICE_TTS_ONESHOT_TIMEOUT_MS', 120_000, 1000, 600_000);
    let child;
    try {
      child = spawn(interpreter, [WORKER_SCRIPT, '--once', ...workerArgs()], {
        cwd: existsSync(kokoroDir()) ? kokoroDir() : undefined,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) { reject(err); return; }

    let out = '';
    let errText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      const err = new Error(`Kokoro one-shot timed out after ${timeoutMs}ms`);
      err.code = 'tts_timeout';
      reject(err);
    }, timeoutMs);

    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { if (errText.length < 16_384) errText += c.toString(); });

    // stdin can EPIPE if the child dies before reading. The close handler
    // already reports that, so this only stops it becoming an unhandled error.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(synthesisRequest(o)) + '\n', 'utf8');

    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // The LAST line, not the first. The child writes only protocol frames to
      // stdout, but a dependency that prints a warning there on import would
      // otherwise become the response.
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { parsed = JSON.parse(lines[i]); break; } catch (e) { /* keep looking */ }
      }

      if (!parsed) {
        const err = new Error(describeOneShotFailure(code, signal, errText));
        err.code = 'tts_failed';
        reject(err);
        return;
      }

      if (!parsed.ok) {
        const err = new Error(parsed.error || 'Kokoro one-shot failed.');
        err.code = parsed.code || 'tts_failed';
        reject(err);
        return;
      }

      const result = readPcm(parsed, 'one-shot');
      if (!result) {
        const err = new Error('Kokoro one-shot returned no usable audio.');
        err.code = 'tts_failed';
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Explain a one-shot process that died without a protocol frame.
 *
 * A signal is reported by NAME, and SIGKILL is called what it almost always is
 * on a small container: the kernel's OOM killer. The alternative message --
 * "exited null with no audio" -- names neither the cause nor where to look, and
 * that is the exact failure mode this path exists to survive.
 *
 * @param {number|null} code
 * @param {string|null} signal
 * @param {string} errText
 * @returns {string}
 */
function describeOneShotFailure(code, signal, errText) {
  const stderr = errText.trim().slice(0, 400);
  if ('SIGKILL' === signal) {
    return 'Kokoro one-shot was killed (SIGKILL), which on a small instance is '
      + 'almost always the kernel OOM killer: onnxruntime holds the model plus '
      + `its arenas. ${stderr ? `stderr: ${stderr}` : 'No stderr was written.'}`;
  }
  if (signal) return `Kokoro one-shot was terminated by ${signal}. ${stderr}`;
  return stderr || `Kokoro one-shot exited ${code} without a response.`;
}

/**
 * Warm the worker and load the model at boot.
 *
 * Never throws and never blocks a boot: a health check has a deadline, and a
 * model load must not fail a deploy. A failed pre-warm is not a failed boot --
 * the one-shot path still works and the worker is retried on the first real
 * request.
 *
 * @returns {Promise<boolean>}
 */
export async function prewarm() {
  if (!workerEnabled() || !prewarmEnabled()) return false;
  if (!existsSync(modelPath()) || !existsSync(voicesPath())) return false;

  try {
    const started = await worker.start(workerArgs());
    if (!started) return false;
    // The worker loads at startup, before it reports ready. This confirms the
    // load landed and surfaces the bundle's voice list for /voice/health and for
    // the registry's reconciliation.
    await worker.request({ op: 'load' }, 60_000);
    console.log('[voice] kokoro worker pre-warmed; the first utterance will be warm');
    return true;
  } catch (err) {
    console.error(`[voice] pre-warm did not complete: ${err.message}`);
    return false;
  }
}

/**
 * Voices the loaded bundle actually contains, or null if not yet known.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS, and the registry treats them
 * differently: null means "nothing has reported yet" (at boot, or with the
 * worker disabled), while an empty array would mean "the bundle holds nothing".
 * Collapsing the two would narrow the offered voice set to zero during startup
 * and make the platform look mute.
 *
 * @returns {Array<string>|null}
 */
export function bundleVoices() {
  const health = worker.health();
  const voices = health && health.capabilities && health.capabilities.voices;
  return Array.isArray(voices) && voices.length ? voices.slice() : null;
}

/**
 * Start the worker directly.
 *
 * @returns {Promise<boolean>}
 */
export function startWorker() {
  return worker.start(workerArgs());
}

/** @returns {Promise<void>} */
export function stopWorker() {
  return worker.stop();
}

/**
 * What the worker is doing, for /voice/health.
 *
 * `g2p` is flattened out of capabilities rather than left nested, for the same
 * reason the Piper supervisor flattened `adapter`: a health endpoint is an
 * interface, and moving a field because an internal refactor made it convenient
 * is how a dashboard silently starts reporting "unknown".
 *
 * @returns {object}
 */
export function workerState() {
  const health = worker.health();
  const caps = health.capabilities || {};
  return Object.assign({}, health, {
    engine: 'kokoro',
    g2p: caps.g2p || g2pMode(),
    native_sample_rate: caps.native_sample_rate || null,
    voice_count: Number.isFinite(caps.voice_count) ? caps.voice_count : null,
  });
}

/** Reset for tests. */
export function resetWorkerState() {
  worker.reset();
}

export default {
  workerEnabled, prewarmEnabled, fallbackEnabled, startWorker, synthesizeViaWorker,
  synthesizeOnce, prewarm, stopWorker, workerState, resetWorkerState,
  bundleVoices, modelPath, voicesPath, kokoroDir, kokoroPython, g2pMode,
  artifactSource, bakedDir,
};
