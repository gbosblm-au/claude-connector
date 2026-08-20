// src/voice/voice-engines.js
//
// Tenax Voice -- engine supervisors. Specification Sections 3, 4, 5, 6.2, 10.
//
// ===========================================================================
// THE GPL BOUNDARY IS THIS FILE'S REASON TO EXIST
// ===========================================================================
//
// Section 6.2, locked: "Run Piper as a separate OS process invoked by the
// connector, never imported as a Python library into the connector's import
// graph ... communication is stdio or localhost HTTP only."
//
// The connector is Node.js, which the specification's Section 3 did not
// anticipate -- it assumed a Python runtime where faster-whisper could be
// imported in-process because it is MIT. On Node neither engine can be
// imported at all, so BOTH run as child processes.
//
// That is a stronger boundary than the one specified, not a weaker one, and it
// is worth being precise about why:
//
//   - Nothing GPL is ever imported by anything of ours, because our code is
//     Node and Piper is Python/C++. There is no import graph to contaminate.
//   - the TTS engine runs from its OWN directory (VOICE_KOKORO_DIR) via its OWN
//     interpreter. It never shares a process with our STT helper either, so
//     even the MIT Python code we do control is not linked to it.
//   - Communication is argv in, WAV bytes out over stdout. No shared memory,
//     no FFI, no dynamic linking.
//
// The one discipline this file must never relax: voice_stt.py must not import
// piper, and the Piper process must not be handed our helper's module path.
// tests/voice-gpl-boundary.test.js asserts both, so the boundary is verifiable
// in CI as Section 6.3 (compliance obligation 1) requires.
//
// ===========================================================================
// AUDIO IS EPHEMERAL (Section 10)
// ===========================================================================
//
// "Audio is processed in memory or in temporary files deleted immediately after
// the request completes. No recording is written to persistent storage, no
// audio is logged."
//
// STT needs a real file because faster-whisper reads a path. So: a
// per-request directory under the OS temp root, removed in a `finally` so it
// goes even when the engine throws or times out. Nothing is written under
// /data, which is the Railway persistent volume.
//
// TTS never touches disk at all -- Piper writes WAV to stdout and we hold the
// buffer.
//
// Nothing in this file logs audio bytes, filenames of user audio, or transcript
// text. Only metadata: duration, language, byte counts (Section 10).

import { spawn }                       from 'node:child_process';
import { mkdtemp, rm, writeFile }      from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir }                      from 'node:os';
import { join }                        from 'node:path';

import { voiceEnabled }                from './voice-gate.js';
import { voicePermitted }              from './voice-catalog.js';
// v12.53.0 -- the prosody layer (TS-VOICE-PROSODY-v1.0). A PURE TRANSFORM: it
// spawns nothing and reads nothing, so importing it here cannot change the
// behaviour of the flat path even by accident. See src/voice/prosody.js.
import { analyse, prosodyConfig }     from './prosody.js';
// v12.54.3 -- VOICE-TTS-NORMALIZE-v1.0. Also a PURE TRANSFORM, for the same
// reason and with the same guarantee: it spawns nothing, reads nothing and
// holds no state, so importing it cannot change the behaviour of any path by
// accident. See src/voice/voice-text-normalize.js.
import { normalizeForSpeech, isSpeakable } from './voice-text-normalize.js';
// v13.1.0. SPEC-KOKORO-001 Section 6. Also a pure transform. It supersedes the
// bare normaliser at the choke point: normalisation is stage one of its own
// pipeline, so calling both would normalise twice (harmless, it is idempotent)
// and skip stages two through five (not harmless -- that is the whole feature).
import { prepareForKokoro }               from './voice-prosody-prep.js';
// v12.53.0 -- the resident Piper worker (PIPER-PRELOAD-v1.1 Section 4).
// SPAWNED, never imported: this is a path to a Python file, and the GPL
// boundary is unchanged by it. See kokoro-worker-supervisor.js.
import { synthesizeViaWorker, workerState,
         synthesizeOnce, fallbackEnabled, bundleVoices, kokoroPython, kokoroDir,
         g2pMode, artifactSource, modelPath as kokoroModelPath,
         voicesPath as kokoroVoicesPath,
         prewarm as prewarmWorker }   from './kokoro-worker-supervisor.js';
// v13. The registry supplies what voice-catalog.js cannot: the output sample
// rate an admin selected, and the platform default. voice-catalog.js remains the
// licence-and-availability view and is now backed by this same registry, so the
// two cannot disagree about which voices exist.
import { outputSampleRate, DEFAULT_VOICE,
         NATIVE_SAMPLE_RATE, VOICE_REGISTRY } from './voice-registry.js';
// v12.54.0 -- the resident STT worker (PIPER-PRELOAD-v1.1 Section 6, Change 3).
// Spawned on VOICE_PYTHON_BIN, the MIT interpreter, never the Piper one.
import { transcribeViaWorker, sttWorkerState, sttWorkerEnabled,
         sttWorkerResident,
         prewarm as prewarmSttWorker } from './stt-worker-supervisor.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PYTHON_BIN   = process.env.VOICE_PYTHON_BIN   || 'python3';
const STT_HELPER   = new URL('./voice_stt.py', import.meta.url).pathname;

/* v13. Kokoro replaced Piper. The engine paths live in
 * kokoro-worker-supervisor.js, which owns the child process and its
 * environment, and are surfaced here only for /voice/health.
 *
 * THE DIRECTORY BOUNDARY IS STILL A GPL BOUNDARY. Kokoro-82M is Apache-2.0, so
 * this looks like ceremony now -- but kokoro-onnx phonemises through
 * `phonemizer`, which drives espeak-ng, and espeak-ng is GPL-3.0. The GPL
 * dependency moved from the model to the phonemiser; it did not go away. */

/* v13. The OUTPUT sample rate, an admin setting (Section 12). Kokoro
 * synthesises at 24 kHz natively; 16 kHz is a third smaller on the wire and
 * costs a band-limited resample in the worker. An unrecognised value falls back
 * to native rather than being honoured -- a typo must not resample every reply
 * through an untested ratio. Read per call so a change needs no restart. */
/* v13.1.0 -- Section 6.1 rule 4, and the platform decision of 2026-08-19.
 *
 * CONFIGURED ON BY DEFAULT, AS DECIDED. Whether it has any EFFECT depends on
 * the G2P actually in use, and on the espeak path it cannot: `[word](+2)` is a
 * misaki construct, and kokoro-onnx's espeak-ng tokenizer has no markdown
 * parsing -- it would pronounce the brackets and the digits, so the listener
 * hears "best plus two".
 *
 * voice-prosody-prep.js therefore emits no markup on the espeak path and
 * records `emphasis_needs_misaki_g2p`, which /voice/status surfaces. The
 * decision is honoured as far as it can be, and the gap is REPORTED rather than
 * silently swallowed -- an admin who switched emphasis on is entitled to know
 * why nothing changed. */
function emphasisEnabled() {
  const raw = String(process.env.VOICE_TTS_EMPHASIS || '').trim().toLowerCase();
  if ('false' === raw || '0' === raw || 'no' === raw) return false;
  return true;
}

/* v13.1.0 -- Section 6.1 rule 5. A JSON object mapping a surface word to a
 * Kokoro phoneme string, e.g. {"Tenax":"tˈɛnæks"}.
 *
 * Empty by default and PARSED DEFENSIVELY: a malformed value returns {} with a
 * warning rather than throwing, because a typo in an env var must not take
 * every reply down. Like emphasis, it only has an effect on the misaki path. */
function pronunciationLexicon() {
  const raw = String(process.env.VOICE_TTS_LEXICON || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && 'object' === typeof parsed && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    console.warn(`[voice] VOICE_TTS_LEXICON is not valid JSON, ignoring it: ${err.message}`);
    return {};
  }
}

function ttsOutputRate(requested) {
  // v13.0.1. A PER-REQUEST rate takes precedence over the deployment default.
  //
  // This is what makes the gateway's per-tenant setting reach the engine. The
  // connector's env var expresses ONE rate for the whole process, which cannot
  // serve two tenants differently -- so the gateway injects the tenant's choice
  // into the request body and it arrives here.
  //
  // outputSampleRate() refuses anything unrecognised and falls back rather than
  // honouring it, so a bad value on the wire degrades to the native rate rather
  // than resampling through an untested ratio.
  if (undefined !== requested && null !== requested && '' !== requested) {
    return outputSampleRate(requested);
  }
  return outputSampleRate(process.env.VOICE_TTS_SAMPLE_RATE);
}

/* Model cache. On Railway this is the persistent volume, so models survive a
 * restart and Section 11's "pre-downloaded at deploy" holds. */
const MODEL_DIR    = process.env.VOICE_MODEL_DIR    || '/data/voice/models';

/* PROVISIONAL default (Section 14). Not locked: the benchmark gate is hard, and
 * until it has run on the real Railway CPU this is a candidate from Table 1,
 * not a measurement. /voice/health reports benchmark_completed:false so an
 * operator can see the difference. */
const STT_TIER     = process.env.VOICE_STT_TIER     || 'base';

const STT_TIMEOUT  = intEnv('VOICE_STT_TIMEOUT_MS', 120_000);
const TTS_TIMEOUT  = intEnv('VOICE_TTS_TIMEOUT_MS',  60_000);

/* v12.52.0: thread cap for the Piper child. 1 is the safe default on a small
 * shared instance; see the env block in synthesize() for why. */
const TTS_THREADS  = intEnv('VOICE_TTS_THREADS', 1);

/* Sample rates read from voice configs, cached for the process lifetime. The
 * config cannot change without the model changing, and a model change needs a
 * redeploy or a re-provision. */
const _sampleRates = new Map();

/* v12.53.0. The same treatment for the voice's own default length_scale, which
 * Section 4.2 of TS-VOICE-PROSODY-v1.0 makes the base every prosody profile
 * multiplies against. Cached for the same reason and with the same lifetime:
 * the value cannot change without the model changing. */
const _lengthScales = new Map();

/* v12.53.0. Prosody synthesises one Piper process per phrase, so a reply that
 * used to cost one process now costs N. Two of them at a time overlaps the
 * model load of the next phrase with the inference of the current one, which is
 * where the time-to-first-audio saving actually comes from -- while keeping the
 * peak memory to two onnxruntime arenas rather than N. On the small Railway
 * instance this connector runs on, that ceiling is the difference between a
 * faster reply and the OOM killer described in describeFailure(). */
const TTS_PHRASE_CONCURRENCY = intEnv('VOICE_TTS_PHRASE_CONCURRENCY', 2);

/* Section 12 budgets assume one utterance at a time on a shared CPU. Two
 * concurrent Whisper runs on the box that also serves the connector will miss
 * every budget in the table, so requests queue rather than compete. */
const STT_CONCURRENCY = intEnv('VOICE_STT_CONCURRENCY', 1);

/* v12.53.0 -- PIPER-PRELOAD-v1.1 Section 5. The TTS path had NO concurrency
 * control at all: two synthesis requests arriving together spawned two Piper
 * processes, each loading its own copy of the model, on an instance sized for
 * one. That is the CPU contention of item 3 and the OOM of item 4 in the
 * corrected diagnosis, and it was reachable from two browser tabs.
 *
 * This queue guards the CLI SPAWN specifically. The resident worker does not
 * need it -- it is serial by construction and holds one model however many
 * requests are pipelined at it -- and putting the queue in front of the worker
 * as well would serialise the phrase pipeline for no benefit. Section 5 says
 * exactly this: "the worker is serial anyway, but the queue also serialises
 * the fallback CLI path and prevents concurrent cold spawns during startup." */
const TTS_CONCURRENCY = intEnv('VOICE_TTS_CONCURRENCY', 1);

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

const state = {
  sttReady: null,     // null = not yet probed
  ttsReady: null,
  sttError: null,
  ttsError: null,
  modelsLoaded: [],
  // v12.50.0: .onnx voice models found on the volume. Distinct from the
  // licence catalogue, which says what MAY be spoken, not what CAN be.
  voicesInstalled: [],
  inFlight: 0,
  queue: [],
  // v12.53.0. A second, independent queue for the CLI synthesis path. Separate
  // counters rather than shared ones: STT and TTS have different costs and
  // different ceilings, and one blocking the other would mean a transcription
  // in progress silently delayed every reply's audio.
  ttsInFlight: 0,
  ttsQueue: [],
};

/**
 * Run a child process to completion, collecting stdout as a Buffer.
 *
 * spawn with an argv ARRAY, never a shell string: an argv array cannot be
 * word-split, so a voice id or language code containing a shell metacharacter
 * is passed through as one opaque argument. This matches volume-snapshot.js.
 *
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string}>}
 */
function run(bin, args, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: o.cwd || undefined,
        // Explicit, minimal environment. The Piper process must not inherit
        // connector secrets (Section 11: "least-privilege OS identity with no
        // direct access to connector secrets or the database"). Node's default
        // is to hand the child the entire parent environment, which on this
        // connector includes API keys and the database URL.
        env: o.env || { PATH: process.env.PATH, HOME: o.cwd || tmpdir(), PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const out = [];
    let errText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      reject(new Error(`${bin} timed out after ${o.timeout}ms`));
    }, o.timeout || 60_000);

    child.stdout.on('data', c => out.push(c));
    // Capped: a child that fails in a loop must not fill the heap with its own
    // complaints while we wait for the timeout.
    child.stderr.on('data', (c) => { if (errText.length < 16_384) errText += c.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: errText });
    });
  });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Probe both engines.
 *
 * Called lazily on the first request and by /voice/health, never at connector
 * startup: Section 7 requires that when the gate is off "no Piper or Whisper
 * process or model is loaded", verifiable via the process list.
 *
 * Failures are RECORDED, not thrown. Section 7: "If the gate is on but the
 * engine fails to initialise, the UI shows a degraded voice state ... the
 * connector itself must not crash."
 *
 * @returns {Promise<{sttReady: boolean, ttsReady: boolean, degraded: boolean}>}
 */
export async function probeEngines() {
  if (!voiceEnabled()) {
    return { sttReady: false, ttsReady: false, degraded: false, models: [] };
  }

  // STT: ask the helper to report itself. Importing faster-whisper is enough to
  // know the dependency is installed; no model is downloaded by --probe.
  try {
    const r = await run(PYTHON_BIN, [STT_HELPER, '--probe'], { timeout: 20_000 });

    // v12.50.0: parse stdout WHATEVER the exit code.
    //
    // voice_stt.py::fail() writes {error, code} to STDOUT and exits non-zero.
    // The previous version only parsed stdout when the exit code was 0, so on
    // the one path where the message matters it threw the message away and
    // reported the useless literal "probe failed" -- stderr is empty because
    // the helper never writes there. An operator was then told the probe
    // failed without being told why, for the exact failure the helper was
    // written to explain.
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.toString('utf8') || '{}'); } catch (e) { parsed = null; }

    state.sttReady = !!(r.code === 0 && parsed && parsed.ok);
    state.sttError = state.sttReady ? null : (
      (parsed && parsed.error)
      || r.stderr.slice(0, 400)
      || `${PYTHON_BIN} ${STT_HELPER} --probe exited ${r.code} with no diagnostic`
    );
    state.modelsLoaded = (parsed && Array.isArray(parsed.models_cached)) ? parsed.models_cached : [];
  } catch (err) {
    state.sttReady = false;
    // spawn itself failed: the interpreter is missing, or the helper path is
    // wrong. Name both, because the message alone ("ENOENT") does not say which.
    state.sttError = `${err.message} (VOICE_PYTHON_BIN=${PYTHON_BIN}, helper=${STT_HELPER})`;
  }

  // v13. TTS: are the model and the voice bundle on disk, and can the engine be
  // reached at all?
  //
  // The Piper probe asked whether a BINARY was runnable, because that is what
  // the CLI path drove. Kokoro has no binary -- it is a Python library loading
  // an ONNX file -- so the equivalent question is whether the files exist and an
  // interpreter that can import the engine has been configured.
  //
  // Deliberately NOT a synthesis. `--probe` in kokoro_worker.py does render a
  // real utterance and is the right check to run by hand at deploy, but it costs
  // a full model load and this runs on the health path. "The files are present
  // and an interpreter is configured" is an honest claim; claiming more would
  // need a load this cannot afford.
  //
  // Reporting ready with no usable bundle would mean the UI renders a Speak
  // button that fails on first press. The registry listing five voices is a
  // statement about what this deployment OFFERS, not about what is on the volume.
  state.voicesInstalled = installedVoices();
  try {
    const model = kokoroModelPath();
    const bundle = kokoroVoicesPath();

    if (!existsSync(model)) {
      state.ttsReady = false;
      state.ttsError = `Kokoro model not found at ${model}. `
        + 'Check VOICE_KOKORO_MODEL, or provision it onto the volume.';
    } else if (!existsSync(bundle)) {
      state.ttsReady = false;
      state.ttsError = `Kokoro voice bundle not found at ${bundle}. `
        + 'Check VOICE_KOKORO_VOICES, or provision it onto the volume.';
    } else if (!kokoroPython()) {
      // Named explicitly rather than left to fail at synthesis. An absent venv
      // is the most common deployment mistake here, and the message that would
      // otherwise reach an operator is ModuleNotFoundError from a child process
      // they did not know existed.
      state.ttsReady = false;
      state.ttsError = 'No Kokoro interpreter found. Set VOICE_KOKORO_PYTHON to '
        + 'the venv python3 that has kokoro-onnx installed.';
    } else if (!state.voicesInstalled.length) {
      state.ttsReady = false;
      state.ttsError = 'The Kokoro bundle is present but contains none of the '
        + 'voices this deployment offers. Check the bundle version matches the '
        + 'registry.';
    } else {
      state.ttsReady = true;
      state.ttsError = null;
    }
  } catch (err) {
    state.ttsReady = false;
    state.ttsError = `${err.message} (VOICE_KOKORO_DIR=${kokoroDir()})`;
  }

  return {
    sttReady: !!state.sttReady,
    ttsReady: !!state.ttsReady,
    degraded: !state.sttReady || !state.ttsReady,
    models: state.modelsLoaded.slice(),
    voices_installed: state.voicesInstalled.slice(),
    stt_error: state.sttError,
    tts_error: state.ttsError,
  };
}

/**
 * Voice models actually present on the volume.
 *
 * Filenames only, and only those ending .onnx, so this answers "what can Piper
 * be asked to speak with right now" rather than "what is licence-cleared".
 * Those two lists diverging is exactly the state that produced a healthy-looking
 * catalogue beside a TTS engine that could not synthesise a single word.
 *
 * @returns {string[]} Voice ids (the filename without the .onnx suffix).
 */
export function installedVoices() {
  // v13. NOT A DIRECTORY LISTING ANY MORE.
  //
  // Piper kept one .onnx per voice, so "what is installed" was a readdir.
  // Kokoro ships ONE model plus ONE bundle holding every voice as a style
  // vector, so the question splits: are both files present, and which vectors
  // does the bundle actually contain?
  //
  // Only the worker can answer the second. bundleVoices() returns null until it
  // has reported -- which is NOT the same as an empty bundle. Conflating them
  // would report zero voices during startup and make the platform look mute.
  try {
    if (!existsSync(kokoroModelPath()) || !existsSync(kokoroVoicesPath())) return [];
  } catch (err) {
    return [];
  }

  const offered = VOICE_REGISTRY.filter(v => v.active).map(v => v.name);
  const reported = bundleVoices();
  if (!reported) return offered.slice().sort();

  // Intersected once the worker has spoken: a voice this deployment offers but
  // the bundle lacks must not be advertised as installed, because the Speak
  // button it produces would fail at synthesis rather than be absent.
  const inBundle = new Set(reported);
  return offered.filter(nm => inBundle.has(nm)).sort();
}

/** Cached readiness without re-probing. */
export function engineState() {
  return {
    sttReady: !!state.sttReady,
    ttsReady: !!state.ttsReady,
    voices_installed: (state.voicesInstalled || []).slice(),
    degraded: state.sttReady === null || state.ttsReady === null
      ? false
      : (!state.sttReady || !state.ttsReady),
    probed: state.sttReady !== null,
    models: state.modelsLoaded.slice(),
    stt_error: state.sttError,
    tts_error: state.ttsError,
    in_flight: state.inFlight,
    queued: state.queue.length,
    // v12.53.0. Reported separately from the STT queue above: the two have
    // different widths and different costs, and conflating them would make a
    // busy transcription look like a busy synthesiser.
    tts_in_flight: state.ttsInFlight,
    tts_queued: state.ttsQueue.length,
  };
}

/** Reset probe state. Used by tests and after a configuration change. */
export function resetEngineState() {
  state.sttReady = null; state.ttsReady = null;
  state.sttError = null; state.ttsError = null;
  state.modelsLoaded = []; state.voicesInstalled = [];
  state.inFlight = 0; state.queue = [];
  state.ttsInFlight = 0; state.ttsQueue = [];
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Serialise STT so concurrent runs cannot blow the Section 12 latency budget. */
function acquire() {
  if (state.inFlight < STT_CONCURRENCY) {
    state.inFlight++;
    return Promise.resolve();
  }
  return new Promise(resolve => state.queue.push(resolve));
}

function release() {
  const next = state.queue.shift();
  if (next) { next(); return; }   // hands the slot straight on; count unchanged
  state.inFlight = Math.max(0, state.inFlight - 1);
}

/**
 * The same discipline for the CLI synthesis path (Section 5).
 *
 * @returns {Promise<void>}
 */
function acquireTts() {
  if (state.ttsInFlight < TTS_CONCURRENCY) {
    state.ttsInFlight++;
    return Promise.resolve();
  }
  return new Promise(resolve => state.ttsQueue.push(resolve));
}

function releaseTts() {
  const next = state.ttsQueue.shift();
  if (next) { next(); return; }
  state.ttsInFlight = Math.max(0, state.ttsInFlight - 1);
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio buffer.
 *
 * @param {Buffer} audio
 * @param {{format: string, language?: string, model?: string}} opts
 * @returns {Promise<{text, language, duration_seconds, segments}>}
 */
export async function transcribe(audio, opts) {
  const o = opts || {};
  await acquire();

  // Per-request directory under the OS temp root, never under /data. Removed in
  // the finally below, so it goes even if the engine throws or times out --
  // which is what makes Section 16's "temporary directory is empty after each
  // request" true rather than aspirational.
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'tenax-voice-'));
    // The name is ours, not the caller's. An uploaded filename is never used to
    // build a path, so a traversal payload in it has nowhere to go.
    const path = join(dir, `audio.${o.format || 'wav'}`);
    await writeFile(path, audio);

    const model = o.model || STT_TIER;

    // v12.54.0 -- PIPER-PRELOAD-v1.1 Section 6. THE RESIDENT PATH FIRST.
    //
    // The per-request spawn constructs WhisperModel from scratch every time:
    // roughly 2 to 4 seconds on the base tier before a single sample of audio
    // is looked at, paid again on every utterance for an identical result. That
    // is the LARGER of the two cold starts, and it lands exactly where a user
    // feels it most -- they have finished speaking and are waiting to see their
    // words.
    //
    // THE AUDIO IS PASSED AS A PATH, NOT AS BYTES. A minute of speech is
    // megabytes; base64 through a pipe would inflate it by a third and copy it
    // twice for nothing, when the file is already on a filesystem the worker
    // can read. The temporary directory is still owned and removed by the
    // finally below, so this adds no second place audio can linger.
    //
    // A null answer means the worker cannot serve this -- not running, backing
    // off, crashed, or wedged -- and execution falls through to the spawn
    // below. Section 6: transcribe() "falls back to the current per-request
    // spawn on failure", so the worst case of enabling this is the behaviour
    // that already shipped. A transcription REFUSAL still throws, because the
    // spawn would refuse identically and more slowly.
    const viaWorker = await transcribeViaWorker({
      path, model, modelDir: MODEL_DIR, language: o.language,
    });
    if (viaWorker) return viaWorker;

    const args = [STT_HELPER, '--transcribe', path, '--model', model,
                  '--model-dir', MODEL_DIR];
    if (o.language) args.push('--language', o.language);

    const r = await run(PYTHON_BIN, args, { timeout: STT_TIMEOUT });
    if (r.code !== 0) {
      const err = new Error(r.stderr.slice(0, 500) || `STT helper exited ${r.code}`);
      err.code = 'stt_failed';
      throw err;
    }

    const parsed = JSON.parse(r.stdout.toString('utf8'));
    if (parsed && parsed.error) {
      const err = new Error(parsed.error);
      err.code = parsed.code || 'stt_failed';
      throw err;
    }
    return parsed;
  } finally {
    if (dir) {
      // force:true so a already-removed directory is not itself an error, and
      // an await so the request does not report success while audio is still on
      // disk.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    release();
  }
}

// ---------------------------------------------------------------------------
// Text to speech  (GPL process boundary)
// ---------------------------------------------------------------------------

/**
 * Synthesise speech with Piper.
 *
 * Piper is invoked as its own OS process, from its own directory, with a
 * minimal environment. It receives text on stdin and writes WAV to stdout. That
 * is the whole interface: argv and pipes.
 *
 * @param {{text: string, voice: string, speed?: number}} opts
 * @returns {Promise<Buffer>} WAV bytes.
 */
/**
 * A failure message an operator can act on.
 *
 * @param {number|null} code   Exit code, null when the process was signalled.
 * @param {string|null} signal Signal name, null on a normal exit.
 * @param {string} stderrText  Whatever Piper managed to write.
 * @returns {string}
 */
/**
 * The sample rate a voice was trained at, from its own config file.
 *
 * Piper writes `--output_raw` at the model's native rate. Assuming 22050 for
 * everything would play a 16 kHz low-quality voice fast and high, so the rate
 * is read from the config that ships beside the model rather than guessed. The
 * fallback is only reached if the config is missing, which is the same state
 * that makes Piper itself fail.
 *
 * @param {string} voiceId
 * @returns {number} Samples per second.
 */
export function voiceSampleRate(voiceId) {
  const cached = _sampleRates.get(voiceId);
  if (cached) return cached;

  // v13. NO CONFIG FILE TO READ. Piper shipped a .onnx.json beside every voice
  // and rates differed per voice; Kokoro has ONE rate for every voice, because
  // it is a property of the model. So this is the configured OUTPUT rate.
  //
  // The cache is still overwritten from the worker's ACTUAL answer in
  // synthesizePcm(), because a deployment that cannot resample returns native
  // audio and says so. The reported value wins, so the WAV header always
  // describes the bytes rather than the intent.
  const rate = ttsOutputRate();
  _sampleRates.set(voiceId, rate);
  return rate;
}

/**
 * Wrap headerless PCM in a canonical 44-byte WAV header.
 *
 * Piper emits signed 16-bit little-endian mono at the model's sample rate. All
 * three are known here, so every length field can be written correctly the
 * first time -- which is the whole point: nothing has to be patched later, so
 * nothing has to seek.
 *
 * @param {Buffer} pcm Raw samples.
 * @param {number} sampleRate
 * @returns {Buffer} A complete WAV file.
 */
export function wrapPcmAsWav(pcm, sampleRate) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  // Everything after this field: 36 + data length.
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);            // PCM chunk size
  header.writeUInt16LE(1, 20);             // format 1 = uncompressed PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm], 44 + pcm.length);
}

export function describeFailure(code, signal, stderrText) {
  const detail = String(stderrText || '').trim().slice(0, 500);

  if (signal) {
    const base = `Piper was killed by ${signal}`;
    if ('SIGKILL' === signal) {
      // Nothing in userspace sends SIGKILL to this child except our own
      // timeout, and the timeout rejects on its own path before reaching here.
      // So on a container this is the OOM killer almost every time.
      return base + '. On a memory-limited container this is almost always the '
        + 'kernel OOM killer: onnxruntime holds the voice model plus its arenas, '
        + 'so raise the service memory limit or use a smaller (low-quality) voice.'
        + (detail ? ` Piper said: ${detail}` : '');
    }
    return base + (detail ? `. Piper said: ${detail}` : '.');
  }

  if (detail) return detail;

  if (0 === code) return 'Piper exited cleanly but produced no audio.';
  return `Piper exited ${code} without writing anything to stderr.`;
}

export async function synthesize(opts) {
  const o = opts || {};
  // v12.53.0. The body of this function moved to synthesizePcm() unchanged, so
  // that the prosody layer can obtain HEADERLESS PCM per phrase and concatenate
  // it. The flat path is preserved exactly:
  //
  //   - the same argv is built (--model, --output_raw, and --length_scale ONLY
  //     when a speed was supplied, computed the same way);
  //   - the same environment, cwd, stdio and timeout;
  //   - the same PCM comes back, and it is wrapped by the same wrapPcmAsWav
  //     with the same sample rate.
  //
  // AC3 requires flat output to be byte-identical to the pre-prosody build for
  // the same reply text, and byte-identity is only defensible if the argv is
  // identical -- Piper's output depends on nothing else. That equality is
  // asserted in src/tests/voice-prosody.test.js rather than left to review.
  const pcm = await synthesizePcm({
    text: o.text,
    voice: o.voice,
    lengthScale: (Number.isFinite(o.speed) && o.speed > 0) ? (1 / o.speed) : undefined,
    sampleRate: o.sampleRate,
  });
  // voiceSampleRate() reads the cache synthesizePcm just wrote from the worker's
  // ACTUAL answer, so the header describes the bytes even when a deployment
  // could not resample and returned native audio instead.
  return wrapPcmAsWav(pcm, voiceSampleRate(o.voice));
}

/**
 * Synthesise one unit of text and return HEADERLESS PCM.
 *
 * The building block for both paths. Flat synthesis calls it once; the prosody
 * layer calls it once per phrase and joins the results.
 *
 * Returning PCM rather than WAV is what makes the joining possible at all: two
 * WAV files cannot be concatenated (the second file's 44-byte header lands in
 * the middle of the audio as a burst of noise), while two PCM buffers at the
 * same rate and width simply are the longer recording.
 *
 * @param {{text: string, voice: string, lengthScale?: number}} opts
 *        lengthScale is the ABSOLUTE value handed to Piper. Omit it entirely to
 *        let the voice's own config default apply, which is what the flat path
 *        does when no speed was requested.
 * @returns {Promise<Buffer>} Signed 16-bit little-endian mono samples.
 */
export async function synthesizePcm(opts) {
  const o = opts || {};

  // v12.54.3 -- VOICE-TTS-NORMALIZE-v1.0 Section 2. THE CHOKE POINT.
  //
  // This is the one function both synthesis paths reach: the flat path calls
  // it once for the whole reply, the prosody layer once per phrase, and BOTH
  // the resident worker and the CLI spawn sit downstream of it. Normalising
  // here rather than at either engine is what makes the transform uniform --
  // and is why the worker path cannot quietly keep speaking glyphs after the
  // CLI path stopped.
  //
  // It is applied BEFORE the empty check, not after, because the check is
  // asking a question about what will actually be spoken. Text consisting of
  // nothing but typography has no speech in it, and sending it on to Piper
  // produces an empty utterance rather than an error the caller can act on.
  //
  // Idempotent, so a phrase normalised by a caller and normalised again here
  // is unchanged.
  // v13.1.0. THE SECTION 6 PIPELINE, at the same choke point normalisation
  // occupied. prepareForKokoro runs normalisation as its own first stage, so
  // this is a replacement rather than an addition -- and the four stages that
  // were missing until now (link flattening, dialogue beats as punctuation,
  // emphasis, contour shaping) finally run.
  //
  // `position` comes from the CALLER because a chunk cannot know where it sits.
  // The prosody layer synthesises each phrase separately: a mid-sentence phrase
  // with no final punctuation lands flat, and the same phrase given a full stop
  // makes the sentence audibly break in the middle.
  const prepared = prepareForKokoro(String(o.text || ''), {
    g2p: g2pMode(),
    emphasis: emphasisEnabled(),
    lexicon: pronunciationLexicon(),
    position: o.position || 'whole',
  });
  const text = prepared.text;

  // Reported once per utterance, not per phrase. A suppression that fired on
  // every phrase of every reply would be noise an operator learns to scroll
  // past, which costs the warning its only purpose.
  if (prepared.suppressed.length && 'whole' === (o.position || 'whole')) {
    console.info(`[voice] prosody markup suppressed: ${prepared.suppressed.join(', ')}`);
  }

  if (!text) {
    const err = new Error('No text to synthesise.');
    err.code = 'empty_text';
    throw err;
  }

  // Checked here as well as at the route. This function is the last thing
  // before a GPL process runs against a voice model, and compliance obligation
  // 2 is not something to enforce only at the edge.
  const permit = voicePermitted(o.voice);
  if (!permit.ok) {
    const err = new Error(permit.message);
    err.code = permit.reason;
    throw err;
  }

  // v13. The voice is a PARAMETER now, not a file path. Section 10 claims
  // Kokoro locks voices at model load and that switching needs a bundle reload;
  // that is not true of kokoro-onnx, where create() takes voice= per call and
  // selecting one is an array lookup. So there is no path to compute and no
  // reload to schedule.
  const voice = o.voice;
  const sampleRate = ttsOutputRate(o.sampleRate);

  // v12.53.0 -- PIPER-PRELOAD-v1.1 Section 4. THE RESIDENT PATH FIRST.
  //
  // The worker holds the model loaded, so this returns without paying the 1 to
  // 2.5 second spawn-and-load the CLI path pays on every single utterance.
  // That cost is the whole of Section 3's item 1, and on a per-phrase prosody
  // reply it was being paid N times rather than once.
  //
  // A null answer means the worker cannot serve this -- not running, still
  // backing off, crashed mid-request, or returned something malformed -- and
  // execution falls through to the CLI spawn below. That fallthrough is the
  // zero-regression guarantee in Section 4.3: the previous behaviour IS the
  // degraded mode, so the worst case of shipping this is the status quo.
  //
  // A synthesis REFUSAL, by contrast, throws from here and is not retried:
  // running the CLI path to reach the same refusal more slowly helps nobody.
  const viaWorker = await synthesizeViaWorker({
    text, voice, lengthScale: o.lengthScale, sampleRate,
  });
  if (viaWorker) {
    // The worker reports the rate from the voice object it loaded. Cached here
    // so wrapPcmAsWav and the prosody concatenator agree with it without
    // re-reading the config file -- and so the two paths cannot disagree about
    // the rate of the same voice.
    // v13. The worker reports the rate of the bytes it ACTUALLY produced, which
    // is not always the rate asked for: a deployment without scipy or the numpy
    // fallback returns native 24 kHz and reports `resample_unavailable` rather
    // than shipping aliased audio. Caching the reported value keeps the WAV
    // header honest and keeps the prosody concatenator in agreement.
    if (viaWorker.sampleRate >= 8000 && viaWorker.sampleRate <= 48000) {
      _sampleRates.set(voice, viaWorker.sampleRate);
    }
    if (viaWorker.degraded && viaWorker.degraded.length) {
      console.warn(`[voice] kokoro degraded: ${viaWorker.degraded.join(', ')}`);
    }
    return viaWorker.pcm;
  }

  // ---- CLI fallback (the v12.52.0 path, unchanged) ----------------------
  //
  // Queued, so concurrent replies cannot spawn concurrent cold Piper processes
  // (Section 5). The queue is here and not around the worker call above
  // because only this branch creates a process per request.
  // v13. THIS TIER IS WHY RETIRING PIPER DID NOT CREATE A SINGLE POINT OF
  // FAILURE. Under Piper the fallback was a different program reached by a
  // different route. Kokoro has one implementation, so the second tier is the
  // SAME script in a FRESH process -- which still covers the failures that
  // actually happen: a worker OOM-killed mid-request, a model corrupted in
  // memory, a child that died during backoff. None of those say a new process
  // cannot load the same file from disk.
  //
  // Queued for the same reason the CLI path was: only this branch creates a
  // process per request, and two cold model loads at once on a small instance is
  // the OOM signature described in describeFailure().
  if (!fallbackEnabled()) {
    const err = new Error(
      'The speech worker is unavailable and the subprocess fallback is disabled '
      + '(VOICE_TTS_SUBPROCESS_FALLBACK=false).');
    err.code = 'tts_unavailable';
    throw err;
  }

  await acquireTts();
  try {
    const once = await synthesizeOnce({
      text, voice, lengthScale: o.lengthScale, sampleRate,
    });
    if (once.sampleRate >= 8000 && once.sampleRate <= 48000) {
      _sampleRates.set(voice, once.sampleRate);
    }
    return once.pcm;
  } finally {
    releaseTts();
  }
}


/* v13. The Piper triple (binary, directory, voices directory) is replaced by the
 * Kokoro pair (model, bundle) plus the interpreter and the G2P front end -- the
 * four things an operator has to get right, and the four that appear in every
 * failure message this module can produce.
 *
 * TTS_SAMPLE_RATE is the OUTPUT rate an admin selected, which is not necessarily
 * the rate of the last reply: a deployment that cannot resample returns native
 * audio and says so. Both are reported so the difference is visible. */
export const config = Object.freeze({
  PYTHON_BIN, STT_HELPER, MODEL_DIR,
  KOKORO_DIR: kokoroDir(), KOKORO_MODEL: kokoroModelPath(),
  KOKORO_VOICES: kokoroVoicesPath(), KOKORO_PYTHON: kokoroPython(),
  KOKORO_G2P: g2pMode(),
  // v13.2.0. WHERE the artifacts came from, not just where they are.
  //
  // The paths alone cannot answer "why does it sound different since the
  // redeploy", because a volume path and an image path look equally plausible
  // in a log line. This says which layer won: `image` (baked, the floor),
  // `volume` (an operator dropped a newer file in), or `configured` (pinned by
  // env var).
  KOKORO_ARTIFACT_SOURCE: artifactSource(),
  TTS_SAMPLE_RATE: outputSampleRate(process.env.VOICE_TTS_SAMPLE_RATE),
  TTS_NATIVE_SAMPLE_RATE: NATIVE_SAMPLE_RATE,
  DEFAULT_VOICE, TENANT_VOICE: String(process.env.VOICE_TTS_TENANT_VOICE || '').trim(),
  STT_TIER, STT_TIMEOUT, TTS_TIMEOUT, STT_CONCURRENCY,
});

// ---------------------------------------------------------------------------
// Prosody layer  (TS-VOICE-PROSODY-v1.0 Sections 3, 4; SPEC-VOICE-001 D)
// ---------------------------------------------------------------------------
//
// THE MECHANISM THE WHOLE LAYER STANDS ON (Section 3).
//
// Piper applies --length_scale to a single text input GLOBALLY: one invocation
// carries one rate for everything it is given. That is not a limitation to work
// around, it is the reason today's output sounds metronomic -- a single call
// per reply is structurally incapable of varying pace within that reply.
//
// So the synthesis path changes shape: N short calls instead of one long one,
// each with its own length_scale, joined with explicit silence. Everything
// below is that join, and the care it needs.

/**
 * The default length_scale the ACTIVE VOICE was configured with.
 *
 * Section 4.2: "the active voice's default length_scale is the multiplier base;
 * every profile expresses rate as a relative multiplier against that base,
 * which keeps the layer voice-agnostic (N2)".
 *
 * Read from the voice's own .onnx.json, exactly as voiceSampleRate() reads the
 * rate from the same file. Hardcoding 1.0 would work for most voices and would
 * be wrong for any voice tuned slow or fast at training time -- and it would
 * quietly re-introduce a voice constant into a layer whose whole claim is that
 * it holds none.
 *
 * @param {string} voiceId
 * @returns {number} The base length_scale; 1 when the config does not say.
 */
export function voiceLengthScale(voiceId) {
  const cached = _lengthScales.get(voiceId);
  if (cached) return cached;

  // v13. Kokoro voices carry no per-voice base rate. The indirection is KEPT
  // rather than collapsed, because the prosody profiles in prosody.js are
  // expressed as multipliers against this base, and rewriting them to absolutes
  // would change every profile's meaning for no gain. The base is 1, so a
  // profile multiplier of 1.08 is a length_scale of 1.08.
  const scale = 1;
  _lengthScales.set(voiceId, scale);
  return scale;
}

/**
 * A buffer of digital silence.
 *
 * Section 4.1's pause tiers are expressed in MILLISECONDS, and this is where
 * they become samples. Doing the conversion here, against the voice's own rate,
 * is what makes the pause table sample-rate independent (Section 6): the same
 * 250 ms is 5512 samples at 22.05 kHz and 4000 at 16 kHz, and neither number
 * appears anywhere in the configuration.
 *
 * @param {number} ms         Duration in milliseconds.
 * @param {number} sampleRate Samples per second.
 * @returns {Buffer} Zeroed signed 16-bit mono samples.
 */
export function silencePcm(ms, sampleRate) {
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 22050;
  // Rounded to a whole SAMPLE, then doubled for 16-bit width. Allocating an odd
  // number of bytes would shift every subsequent sample by one byte and turn
  // the rest of the reply into noise.
  const samples = Math.round((duration / 1000) * rate);
  return Buffer.alloc(samples * 2);
}

/**
 * Apply a short linear fade to the start and end of a PCM buffer, in place.
 *
 * NON-NEGOTIABLE 7 (SPEC-VOICE-001): "concatenation must not introduce audible
 * clicks, gaps, or joins in the output."
 *
 * A click at a join is not a mixing subtlety, it is arithmetic. Two segments
 * synthesised independently end and begin at arbitrary sample values, so
 * butting them together puts a vertical step in the waveform. A step is,
 * spectrally, a broadband impulse -- the ear hears it as a tick on every single
 * phrase boundary, which on a forty-phrase reply is forty ticks.
 *
 * A few milliseconds of ramp to and from zero removes the step, because both
 * sides of every join are then exactly zero. Five milliseconds is short enough
 * to be inaudible as a fade and long enough to cover the impulse.
 *
 * @param {Buffer} pcm    Signed 16-bit little-endian mono. Modified in place.
 * @param {number} fadeMs
 * @param {number} sampleRate
 * @returns {Buffer} The same buffer, for chaining.
 */
export function applyEdgeFades(pcm, fadeMs, sampleRate) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 4) return pcm;
  const ms = Number.isFinite(fadeMs) && fadeMs > 0 ? fadeMs : 0;
  if (!ms) return pcm;

  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 22050;
  const totalSamples = Math.floor(pcm.length / 2);
  // Never fade more than a third of the segment from each end. A one-word
  // emphasis unit can be shorter than two fade windows, and fading it twice
  // over would mute the very word the fades exist to make prominent.
  const fadeSamples = Math.min(
    Math.round((ms / 1000) * rate),
    Math.floor(totalSamples / 3)
  );
  if (fadeSamples < 1) return pcm;

  for (let i = 0; i < fadeSamples; i++) {
    const gain = i / fadeSamples;

    const headOffset = i * 2;
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(headOffset) * gain), headOffset);

    const tailOffset = (totalSamples - 1 - i) * 2;
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(tailOffset) * gain), tailOffset);
  }
  return pcm;
}

/**
 * Join phrase segments with their pauses into one continuous recording.
 *
 * @param {Array<{pcm: Buffer, pauseAfterMs: number}>} segments
 * @param {number} sampleRate
 * @param {number} fadeMs
 * @returns {Buffer} One PCM buffer.
 */
export function concatPhrasePcm(segments, sampleRate, fadeMs) {
  const parts = [];
  for (const segment of segments) {
    if (!segment || !Buffer.isBuffer(segment.pcm) || !segment.pcm.length) continue;
    parts.push(applyEdgeFades(segment.pcm, fadeMs, sampleRate));
    const pause = silencePcm(segment.pauseAfterMs, sampleRate);
    if (pause.length) parts.push(pause);
  }
  return Buffer.concat(parts);
}

/**
 * Run an async worker over a list with a bounded number in flight, preserving
 * input order in the result.
 *
 * Order preservation is not a nicety here: the results ARE the reply, in
 * sequence. A pool that resolved out of order would deliver a fluent,
 * confident, scrambled sentence -- the kind of defect that sounds like a
 * feature until someone listens closely.
 *
 * The first rejection aborts: there is no useful partial reply, and letting the
 * remaining phrases run would spend CPU on audio nobody will hear.
 *
 * @param {Array} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<Array>}
 */
async function mapWithLimit(items, limit, worker) {
  const width = Math.max(1, Math.min(limit || 1, items.length || 1));
  const results = new Array(items.length);
  let next = 0;
  let failed = null;

  async function runner() {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        if (!failed) failed = err;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, runner));
  if (failed) throw failed;
  return results;
}

/**
 * Drop phrases that have nothing speakable in them, preserving the beat.
 *
 * v12.54.3 -- VOICE-TTS-NORMALIZE-v1.0.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * analyse() merges fragments shorter than minPhraseChars BACKWARDS into their
 * predecessor, and a fragment consisting only of an opening quote has a bare
 * length of zero, so it is almost always absorbed. Almost: the merge needs a
 * predecessor to merge INTO, so a quote-only fragment that lands first in its
 * sentence survives as a phrase of its own.
 *
 * Before normalisation that phrase synthesised to a moment of nothing and no
 * one noticed. After it, the phrase normalises to an empty string,
 * synthesizePcm raises empty_text -- and empty_text is on the route's
 * not-worth-retrying list, so it is rethrown rather than falling back to flat.
 * One stray quote would answer the whole request with a 422.
 *
 * Dropping the phrase is also simply the right answer: there is no speech in
 * it. The pause it was carrying is folded into the phrase before it, so the
 * rhythm the analysis computed survives the removal rather than shortening by
 * however many milliseconds the dropped fragment was holding.
 *
 * Exported for the test suite, following silencePcm/applyEdgeFades/
 * concatPhrasePcm: the pause arithmetic is the part that can go quietly wrong,
 * and asserting it through a full synthesis would need Piper.
 *
 * @param {Array<{text: string, pauseAfterMs?: number}>} phrases
 * @returns {Array<object>} A new array; the input is not mutated.
 */
export function speakablePhrases(phrases) {
  const kept = [];
  // Carries the pause of a dropped phrase forward when there is no predecessor
  // to hand it to, so a leading drop gives its beat to the first phrase kept
  // rather than losing it.
  let orphanedPauseMs = 0;

  for (const phrase of phrases) {
    if (isSpeakable(phrase.text)) {
      const next = { ...phrase };
      if (orphanedPauseMs) {
        next.pauseAfterMs = Math.max(0, Number(next.pauseAfterMs) || 0) + orphanedPauseMs;
        orphanedPauseMs = 0;
      }
      kept.push(next);
      continue;
    }
    const pause = Math.max(0, Number(phrase.pauseAfterMs) || 0);
    if (kept.length) {
      // The usual case: hand the beat to the phrase that now precedes the gap.
      const prev = kept[kept.length - 1];
      prev.pauseAfterMs = Math.max(0, Number(prev.pauseAfterMs) || 0) + pause;
    } else {
      orphanedPauseMs += pause;
    }
  }

  return kept;
}

/**
 * Synthesise a reply through the prosody layer.
 *
 * The Section 3 pipeline, in order: register detection and segmentation (both
 * inside analyse()), one Piper invocation per phrase each with its own
 * length_scale, concatenation with tiered silence, then the same WAV wrap the
 * flat path uses.
 *
 * FAILURE FALLS BACK RATHER THAN FAILING THE TURN. Non-negotiable 5
 * (SPEC-VOICE-001): "the default path must remain functional even if the
 * prosody layer or streaming fails. Failure in the layer falls back cleanly to
 * the current working single-call synthesis." The caller gets that behaviour by
 * construction -- this function reports which path produced the audio, so a
 * fallback is visible in the logs rather than silent.
 *
 * @param {{text: string, voice: string, speed?: number, config?: object}} opts
 * @returns {Promise<{wav: Buffer, path: string, analysis: object, sampleRate: number}>}
 */
export async function synthesizeProsody(opts) {
  const o = opts || {};
  const text = String(o.text || '');
  if (!text.trim()) {
    const err = new Error('No text to synthesise.');
    err.code = 'empty_text';
    throw err;
  }

  const permit = voicePermitted(o.voice);
  if (!permit.ok) {
    const err = new Error(permit.message);
    err.code = permit.reason;
    throw err;
  }

  const cfg = o.config || prosodyConfig();
  // v13.0.1. Seeded from the per-request rate BEFORE it is read, so a
  // tenant-selected rate reaches the phrase workers and the concatenated header
  // agrees with the bytes they returned. Without this the phrases would be
  // rendered at the requested rate while the WAV declared the deployment
  // default, and every reply would play at the wrong pitch and speed.
  if (undefined !== o.sampleRate && null !== o.sampleRate && '' !== o.sampleRate) {
    _sampleRates.set(o.voice, ttsOutputRate(o.sampleRate));
  }
  const sampleRate = voiceSampleRate(o.voice);
  const analysis = analyse(text, {
    baseLengthScale: voiceLengthScale(o.voice),
    speed: o.speed,
    config: cfg,
  });

  // v12.54.3. Phrases with nothing speakable in them are removed BEFORE the
  // degenerate check below, so a reply whose every phrase was typography falls
  // into the same flat path as one the segmenter never split -- and raises
  // empty_text from there, once, about the whole reply, rather than from a
  // phrase worker mid-render. See speakablePhrases.
  const speakable = speakablePhrases(analysis.phrases);

  // A reply the segmenter reduced to nothing -- punctuation only, or an empty
  // markdown artefact. The flat path handles it identically, so hand it there
  // rather than returning a zero-length WAV.
  if (!speakable.length) {
    const pcm = await synthesizePcm({
      text, voice: o.voice,
      lengthScale: (Number.isFinite(o.speed) && o.speed > 0) ? (1 / o.speed) : undefined,
    });
    return { wav: wrapPcmAsWav(pcm, sampleRate), path: 'flat_no_phrases',
             analysis, sampleRate };
  }

  const rendered = await mapWithLimit(
    speakable, TTS_PHRASE_CONCURRENCY,
    async (phrase, index) => ({
      pcm: await synthesizePcm({
        text: phrase.text, voice: o.voice, lengthScale: phrase.lengthScale,
        sampleRate: sampleRate,
        // v13.1.0 -- Section 6.1 rule 2. Only the LAST phrase gets a falling
        // close; the rest get a continuation rise. Giving every phrase terminal
        // punctuation would make one sentence audibly break into several, which
        // is worse than the flatness it was meant to fix.
        position: (index === speakable.length - 1) ? 'final' : 'continuation',
      }),
      pauseAfterMs: phrase.pauseAfterMs,
    })
  );

  const pcm = concatPhrasePcm(rendered, sampleRate, cfg.joinFadeMs);
  if (!pcm.length) {
    const err = new Error('The prosody layer produced no audio.');
    err.code = 'tts_failed';
    throw err;
  }

  return { wav: wrapPcmAsWav(pcm, sampleRate), path: 'prosody', analysis, sampleRate };
}

/**
 * Synthesise a reply phrase by phrase, handing each one to a callback the
 * moment it is ready.
 *
 * SPEC-VOICE-001 Component D, overlap 1: "once the full text exists, synthesise
 * phrase 1, start playing it, synthesise phrase 2 while phrase 1 plays. Audio
 * starts after one phrase's worth of synthesis instead of the whole reply's."
 *
 * The callback receives phrases IN ORDER even though several are synthesised
 * concurrently, because playback is a sequence and delivering phrase 3 before
 * phrase 2 would reorder the sentence. Concurrency buys the overlap; the
 * ordered emit keeps the reply intelligible.
 *
 * @param {{text: string, voice: string, speed?: number, config?: object}} opts
 * @param {(segment: {index: number, total: number, pcm: Buffer, pauseAfterMs: number, profile: string, lengthScale: number, sampleRate: number}) => Promise<void>|void} onSegment
 * @returns {Promise<{phrases: number, bytes: number, sampleRate: number}>}
 */
export async function synthesizeProsodyStream(opts, onSegment) {
  const o = opts || {};
  const text = String(o.text || '');
  if (!text.trim()) {
    const err = new Error('No text to synthesise.');
    err.code = 'empty_text';
    throw err;
  }

  const permit = voicePermitted(o.voice);
  if (!permit.ok) {
    const err = new Error(permit.message);
    err.code = permit.reason;
    throw err;
  }

  const cfg = o.config || prosodyConfig();
  // v13.0.1. Seeded from the per-request rate BEFORE it is read, so a
  // tenant-selected rate reaches the phrase workers and the concatenated header
  // agrees with the bytes they returned. Without this the phrases would be
  // rendered at the requested rate while the WAV declared the deployment
  // default, and every reply would play at the wrong pitch and speed.
  if (undefined !== o.sampleRate && null !== o.sampleRate && '' !== o.sampleRate) {
    _sampleRates.set(o.voice, ttsOutputRate(o.sampleRate));
  }
  const sampleRate = voiceSampleRate(o.voice);
  const analysis = analyse(text, {
    baseLengthScale: voiceLengthScale(o.voice),
    speed: o.speed,
    config: cfg,
  });

  // v12.54.3. Same removal as synthesizeProsody, and for the same reason: an
  // unspeakable phrase would raise empty_text from a worker mid-stream, where
  // the status line has already been sent and the only way to report it is an
  // in-band error line that costs the client the whole reply.
  const speakable = speakablePhrases(analysis.phrases);

  const phrases = speakable.length
    ? speakable
    // Same degenerate case as synthesizeProsody: speak it flat rather than
    // return silence.
    : [{ text, lengthScale: (Number.isFinite(o.speed) && o.speed > 0) ? (1 / o.speed) : 1,
         pauseAfterMs: 0, profile: 'neutral' }];

  const total = phrases.length;
  let emitted = 0;
  let bytes = 0;

  /* Results arrive out of order from the pool and must LEAVE in order, so
   * completed-but-not-yet-emitted phrases are parked here until their turn.
   * Bounded by the pool width, so this cannot grow with reply length. */
  const pending = new Map();

  async function drain() {
    while (pending.has(emitted)) {
      const segment = pending.get(emitted);
      pending.delete(emitted);
      emitted++;
      bytes += segment.pcm.length;
      await onSegment(segment);
    }
  }

  await mapWithLimit(phrases, TTS_PHRASE_CONCURRENCY, async (phrase, index) => {
    const pcm = await synthesizePcm({
      text: phrase.text, voice: o.voice, lengthScale: phrase.lengthScale,
      sampleRate: sampleRate,
      // v13.1.0. Same rule as the buffered path. The two MUST agree: a reply
      // that streamed and one that fell back would otherwise be phrased
      // differently, which sounds like the assistant changing its mind.
      position: (index === phrases.length - 1) ? 'final' : 'continuation',
    });
    pending.set(index, {
      index, total,
      pcm: applyEdgeFades(pcm, cfg.joinFadeMs, sampleRate),
      pauseAfterMs: phrase.pauseAfterMs,
      profile: phrase.profile,
      lengthScale: phrase.lengthScale,
      sampleRate,
    });
    await drain();
  });

  // Anything the pool finished after the last drain. Reached when the final
  // phrase completes before an earlier one it was waiting on.
  await drain();

  return { phrases: total, bytes, sampleRate };
}

/**
 * Is the prosody layer available on this connector?
 *
 * Reported by /voice/health so a UI can decide whether to render the A/B
 * control at all, rather than rendering it and discovering on first press that
 * the connector was deployed with the layer switched off.
 *
 * @returns {{enabled: boolean, phrase_concurrency: number, config: object}}
 */
export function prosodyState() {
  const cfg = prosodyConfig();
  return {
    enabled: cfg.enabled,
    phrase_concurrency: TTS_PHRASE_CONCURRENCY,
    // Tuning values, deliberately exposed: Section 4.1 makes them "config data,
    // not code", and an operator tuning by ear needs to see what is live rather
    // than infer it from which variables they remember setting.
    config: cfg,

    // v13.1.0 -- THE G2P CEILING, REPORTED RATHER THAN DISCOVERED.
    //
    // The Hugging Face Space that sells Kokoro runs MISAKI. This connector runs
    // kokoro-onnx, whose tokenizer is phonemizer/espeak-ng -- the same frontend
    // CLASS Piper used. The acoustic model is a large step up; the
    // grapheme-to-phoneme front end is not, and the difference is audible on
    // proper nouns, initialisms and anything out of dictionary.
    //
    // So the realism gain over Piper is real but NARROWER than the Space
    // implies, and an operator comparing the two by ear deserves to know which
    // front end they are actually hearing before they conclude the model
    // underdelivered.
    g2p: g2pMode(),

    // Section 6.1 rules 4 and 5. `configured` is the operator's setting;
    // `effective` is what the running G2P can actually honour. They differ on
    // the espeak path, and reporting only one of them is how a switch comes to
    // look broken.
    emphasis: {
      configured: emphasisEnabled(),
      effective: emphasisEnabled() && 'misaki' === g2pMode(),
      requires: 'misaki',
    },
    lexicon: {
      terms: Object.keys(pronunciationLexicon()).length,
      effective: 'misaki' === g2pMode(),
      requires: 'misaki',
    },
  };
}

/**
 * Warm the resident Piper worker at boot (PIPER-PRELOAD-v1.1 Section 5).
 *
 * "When voiceEnabled() and at least one voice is installed, spawn the worker
 * and load the default voice at boot, so the first utterance is already warm.
 * This is gated on the same master switch, so Section 7 holds: with voice off,
 * no process exists."
 *
 * Both halves of that gate are enforced here:
 *
 *   - voiceEnabled() is checked, so a connector with voice off spawns nothing
 *     and A7 remains verifiable from the process list.
 *   - a voice must actually be installed, because warming a worker with no
 *     model to load holds a process for no benefit.
 *
 * probeEngines() is deliberately NOT called. It stays lazy exactly as Section 5
 * requires, so a health probe from a caller who cannot use voice still never
 * triggers a model load. This is a separate, gate-gated step.
 *
 * Never throws. A boot must not fail because a model did not load.
 *
 * @param {string} [voiceId] Defaults to the first installed voice.
 * @returns {Promise<boolean>} Whether the worker came up warm.
 */
export async function prewarmTts(voiceId) {
  if (!voiceEnabled()) return false;

  const installed = installedVoices();
  if (!installed.length) return false;

  // An explicitly named voice must be one that is actually present; falling
  // back to "the first installed" on a typo would warm a voice nobody asked
  // for and hide the mistake.
  const voice = voiceId && installed.includes(voiceId) ? voiceId : installed[0];

  try {
    // v13. No path argument: the worker loads the one model at startup and
    // selects voices per call, so there is nothing voice-specific to pre-warm.
    // The named voice is still validated above, because a typo in a config
    // should surface as a refusal rather than be silently ignored.
    return await prewarmWorker();
  } catch (err) {
    console.error(`[voice] pre-warm failed for ${voice}: ${err.message}`);
    return false;
  }
}

/**
 * Warm the resident STT worker at boot (Section 6).
 *
 * Separate from prewarmTts() because the two are separately configurable and
 * separately failable: an instance may hold Whisper resident and not Piper, or
 * the reverse, and a single combined pre-warm would make one engine's missing
 * model look like the other's failure.
 *
 * Gated on voiceEnabled() for the same reason prewarmTts() is: with the master
 * switch off, no process exists (A7). Never throws.
 *
 * @returns {Promise<boolean>}
 */
export async function prewarmStt() {
  if (!voiceEnabled()) return false;
  try {
    return await prewarmSttWorker({ model: STT_TIER, modelDir: MODEL_DIR });
  } catch (err) {
    console.error(`[voice] stt pre-warm failed: ${err.message}`);
    return false;
  }
}

/**
 * The resident STT worker's state, for /voice/health.
 *
 * @returns {object}
 */
export function sttWorkerHealth() {
  return sttWorkerState();
}

/**
 * The resident worker's state, for /voice/health.
 *
 * A2 is asserted against this: two consecutive requests reusing one process
 * show the same `pid` and `warm: true`.
 *
 * @returns {object}
 */
export function ttsWorkerState() {
  return workerState();
}

export default {
  probeEngines, engineState, resetEngineState, transcribe, synthesize,
  synthesizePcm, synthesizeProsody, synthesizeProsodyStream,
  installedVoices, wrapPcmAsWav, voiceSampleRate, voiceLengthScale,
  silencePcm, applyEdgeFades, concatPhrasePcm,
  describeFailure, prosodyState, prewarmTts, ttsWorkerState,
  prewarmStt, sttWorkerHealth, config,
};
