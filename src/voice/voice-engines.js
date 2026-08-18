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
//   - Piper runs from its OWN directory (VOICE_PIPER_DIR) via its OWN
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
// v12.53.0 -- the resident Piper worker (PIPER-PRELOAD-v1.1 Section 4).
// SPAWNED, never imported: this is a path to a Python file, and the GPL
// boundary is unchanged by it. See piper-worker-supervisor.js.
import { synthesizeViaWorker, workerState,
         prewarm as prewarmWorker }   from './piper-worker-supervisor.js';
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

/* Piper lives in its own directory with its own binary. Separate variables
 * rather than one, because the GPL boundary is a directory boundary as much as
 * a process one -- keeping the models beside the engine makes it obvious at a
 * glance which tree is GPL. */
const PIPER_BIN    = process.env.VOICE_PIPER_BIN    || 'piper';
const PIPER_DIR    = process.env.VOICE_PIPER_DIR    || '/data/voice/piper';
const VOICES_DIR   = process.env.VOICE_VOICES_DIR   || join(PIPER_DIR, 'voices');

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

  // TTS: is the Piper binary present, runnable, and does it have a voice model
  // to run against? Run from PIPER_DIR so even the probe respects the directory
  // boundary.
  //
  // v12.50.0: the probe was `piper --version`, which the pinned engine does not
  // support. piper-tts 1.2.0 is an argparse CLI whose --model argument is
  // REQUIRED, so any invocation without it exits 2 with a usage message:
  //
  //   piper: error: the following arguments are required: -m/--model
  //
  // The old probe therefore reported tts_ready:false on a perfectly healthy
  // installation, and the connector reported itself degraded forever. --help is
  // used instead: argparse answers it and exits 0 BEFORE required-argument
  // validation runs, so it is a true "is this binary runnable" question.
  state.voicesInstalled = installedVoices();
  try {
    const cwd = existsSync(PIPER_DIR) ? PIPER_DIR : undefined;

    // An absolute path that does not exist gives a far clearer answer than
    // waiting for ENOENT from spawn, which cannot say which variable was wrong.
    if (PIPER_BIN.startsWith('/') && !existsSync(PIPER_BIN)) {
      state.ttsReady = false;
      state.ttsError = `Piper binary not found at ${PIPER_BIN}. Check VOICE_PIPER_BIN.`;
    } else {
      const r = await run(PIPER_BIN, ['--help'], { timeout: 15_000, cwd });
      const output = `${r.stdout.toString('utf8')}${r.stderr}`;
      // Exit 0 is the expected answer. A usage banner on a non-zero exit still
      // proves the binary exists and executes, which is all this probe claims
      // to establish, so it is accepted rather than reported as a fault.
      const runnable = r.code === 0 || /usage:\s*piper/i.test(output);

      if (!runnable) {
        state.ttsReady = false;
        state.ttsError = r.stderr.slice(0, 400) || `${PIPER_BIN} --help exited ${r.code}`;
      } else if (!state.voicesInstalled.length) {
        // Runnable but useless. Reporting ready here would mean the UI renders
        // a speak button that 500s on first press, because synthesize() needs
        // <VOICES_DIR>/<voice>.onnx and there is no such file. The voice
        // CATALOGUE listing five licence-cleared voices is a statement about
        // licensing, not about what has been downloaded onto the volume.
        state.ttsReady = false;
        state.ttsError = `Piper runs, but no .onnx voice model is installed in ${VOICES_DIR}. `
          + 'Download at least one voice (with its .onnx.json config) onto the volume.';
      } else {
        state.ttsReady = true;
        state.ttsError = null;
      }
    }
  } catch (err) {
    state.ttsReady = false;
    state.ttsError = `${err.message} (VOICE_PIPER_BIN=${PIPER_BIN})`;
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
  try {
    if (!VOICES_DIR || !existsSync(VOICES_DIR)) return [];
    return readdirSync(VOICES_DIR)
      .filter(f => f.endsWith('.onnx'))
      .map(f => f.slice(0, -'.onnx'.length))
      .sort();
  } catch (err) {
    return [];
  }
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

  let rate = 22050;
  try {
    const cfg = JSON.parse(readFileSync(join(VOICES_DIR, `${voiceId}.onnx.json`), 'utf8'));
    const parsed = Number(cfg && cfg.audio && cfg.audio.sample_rate);
    if (Number.isFinite(parsed) && parsed >= 8000 && parsed <= 48000) rate = parsed;
  } catch (err) {
    console.warn(`[voice] could not read the sample rate for ${voiceId}, `
      + `assuming ${rate}: ${err.message}`);
  }

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
  });
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
  const text = String(o.text || '');
  if (!text.trim()) {
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

  const modelPath = join(VOICES_DIR, `${o.voice}.onnx`);

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
    text, modelPath, lengthScale: o.lengthScale,
  });
  if (viaWorker) {
    // The worker reports the rate from the voice object it loaded. Cached here
    // so wrapPcmAsWav and the prosody concatenator agree with it without
    // re-reading the config file -- and so the two paths cannot disagree about
    // the rate of the same voice.
    if (viaWorker.sampleRate >= 8000 && viaWorker.sampleRate <= 48000) {
      _sampleRates.set(o.voice, viaWorker.sampleRate);
    }
    return viaWorker.pcm;
  }

  // ---- CLI fallback (the v12.52.0 path, unchanged) ----------------------
  //
  // Queued, so concurrent replies cannot spawn concurrent cold Piper processes
  // (Section 5). The queue is here and not around the worker call above
  // because only this branch creates a process per request.
  await acquireTts();
  try {
    return await synthesizePcmViaCli({ text, modelPath, lengthScale: o.lengthScale });
  } finally {
    releaseTts();
  }
}

/**
 * The per-request Piper CLI spawn.
 *
 * v12.53.0: extracted from synthesizePcm() so the resident worker can sit in
 * front of it without either path acquiring a comment about the other. The
 * body below is byte-for-byte the v12.52.0 implementation -- same argv, same
 * environment, same cwd, same timeout, same error handling -- because A5
 * requires that "with the worker disabled by flag, behaviour is byte-identical
 * to the current CLI path".
 *
 * @param {{text: string, modelPath: string, lengthScale?: number}} opts
 * @returns {Promise<Buffer>} Signed 16-bit little-endian mono PCM.
 */
function synthesizePcmViaCli(opts) {
  const o = opts || {};
  const text = o.text;
  const modelPath = o.modelPath;

  // v12.52.0 -- THE PRODUCTION 500.
  //
  // This used to be ['--output_file', '-'], asking Piper to write a WAV to
  // stdout. Piper does that with Python's `wave` module, and `wave` patches the
  // RIFF header on close by SEEKING back to byte 4 to write the final length.
  //
  // A pipe cannot seek. The connector spawns Piper with stdio: 'pipe', so once
  // enough audio has been written for the buffer to flush to the real file
  // descriptor, the next header patch calls tell()/seek() on the pipe and the
  // process dies:
  //
  //   File ".../piper/voice.py", line 103, in synthesize
  //     wav_file.writeframes(audio_bytes)
  //   File ".../wave.py", line 560, in writeframes
  //     self._patchheader()
  //   OSError: [Errno 29] Illegal seek
  //
  // Exit 1, after several seconds of successful synthesis and hundreds of
  // kilobytes of correct audio -- which is exactly what production showed: a
  // 500 at 2.7 s for a 283-character request. It is SIZE DEPENDENT, which is
  // why a short probe or a quick manual test passes: a small utterance never
  // fills the buffer, so no flush happens and no seek is ever attempted. The
  // same command redirected to a file works perfectly, because files seek.
  //
  // So we no longer ask Piper for a container it cannot write to a pipe.
  // --output_raw streams headerless PCM, which needs no seeking at all, and
  // the 44-byte WAV header is assembled here from the voice's own config. We
  // know the sample rate, the channel count and the sample width exactly, so
  // there is nothing to patch afterwards.
  const args = ['--model', modelPath, '--output_raw'];

  // v12.53.0. The caller now supplies the ABSOLUTE length_scale rather than a
  // speed, because the prosody layer needs to vary it per phrase and cannot
  // express "the voice's own base times 1.08" as a speed multiplier.
  //
  // The flat path preserves the previous behaviour exactly: synthesize() passes
  // `1 / speed` when a speed was given and `undefined` otherwise, so the argv
  // built here is byte-for-byte what v12.52.0 built. Piper's output depends on
  // nothing but the model and the argv, which is what makes AC3's byte-identity
  // claim checkable rather than hopeful.
  //
  // Piper expresses speed as length_scale, which is INVERSE: larger is slower.
  if (Number.isFinite(o.lengthScale) && o.lengthScale > 0) {
    args.push('--length_scale', String(o.lengthScale));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PIPER_BIN, args, {
        cwd: existsSync(PIPER_DIR) ? PIPER_DIR : undefined,
        // Section 11: no connector secrets, no database access. An explicit
        // minimal environment is how that is enforced -- the default would hand
        // this GPL process every API key the connector holds.
        env: {
          PATH: process.env.PATH, HOME: PIPER_DIR, PYTHONDONTWRITEBYTECODE: '1',
          // v12.52.0. onnxruntime and OpenMP size their thread pools from the
          // CPU count they can SEE, which on a container is the host's count,
          // not the share this service is entitled to. On a small Railway
          // instance that means a dozen threads fighting over a fraction of a
          // core, each with its own arena, which is both slower and heavier
          // than running single-threaded.
          //
          // Overridable, because the right number depends on the plan, and
          // Section 14's benchmark is what should eventually set it.
          OMP_NUM_THREADS: String(TTS_THREADS),
          ORT_NUM_THREADS: String(TTS_THREADS),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) { reject(err); return; }

    const out = [];
    let errText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      const err = new Error(`Piper timed out after ${TTS_TIMEOUT}ms`);
      // Given a code so the route can report a timeout as a timeout rather
      // than as a generic failure.
      err.code = 'tts_timeout';
      reject(err);
    }, TTS_TIMEOUT);

    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', (c) => { if (errText.length < 16_384) errText += c.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pcm = Buffer.concat(out);
      // v12.53.0. The WAV header is no longer built here. This function returns
      // headerless PCM and the CALLER wraps it -- once, around the whole reply
      // -- because a prosody reply is many of these buffers joined end to end
      // and a header in the middle of one is a burst of noise, not a header.
      if (code !== 0 || pcm.length === 0) {
        // v12.52.0. The old message was `errText || "Piper exited <code>"`, and
        // on the failure that matters most -- the process being KILLED -- both
        // halves are useless: stderr is empty because nothing got to write it,
        // and `code` is null because the process did not exit, it was
        // terminated. The operator was left with "Piper exited null with no
        // audio", which names neither the cause nor where to look.
        //
        // A signal is now reported by name, and SIGKILL is called what it
        // almost always is on a small container: the kernel's OOM killer.
        // onnxruntime holds the 61 MB model plus its arenas, so a synthesis
        // that runs for seconds and then dies without a word is the signature.
        const err = new Error(describeFailure(code, signal, errText));
        err.code = 'tts_failed';
        // Structured fields for the route to log. Deliberately separate from
        // the message so the log can carry them without the client ever seeing
        // any of it.
        err.exitCode = code;
        err.signal = signal;
        err.stderr = errText.slice(0, 2000);
        err.bytes = pcm.length;
        reject(err);
        return;
      }
      resolve(pcm);
    });

    // stdin can EPIPE if Piper dies early. The close handler already reports
    // that failure with the real reason, so this must not reject over the top
    // of it with a less useful one.
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}

export const config = Object.freeze({
  PYTHON_BIN, STT_HELPER, PIPER_BIN, PIPER_DIR, VOICES_DIR, MODEL_DIR,
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

  let scale = 1;
  try {
    const cfg = JSON.parse(readFileSync(join(VOICES_DIR, `${voiceId}.onnx.json`), 'utf8'));
    const parsed = Number(cfg && cfg.inference && cfg.inference.length_scale);
    // Bounded for the same reason the sample rate is: a config value outside
    // this range is a corrupt file, and passing it to Piper produces either
    // silence or a minutes-long drawl from a one-line reply.
    if (Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 10) scale = parsed;
  } catch (err) {
    // Not a warning. Piper falls back to 1.0 itself when the field is absent,
    // and most voice configs simply do not carry an inference block, so a
    // console line here would fire on every healthy synthesis.
    scale = 1;
  }

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
  const sampleRate = voiceSampleRate(o.voice);
  const analysis = analyse(text, {
    baseLengthScale: voiceLengthScale(o.voice),
    speed: o.speed,
    config: cfg,
  });

  // A reply the segmenter reduced to nothing -- punctuation only, or an empty
  // markdown artefact. The flat path handles it identically, so hand it there
  // rather than returning a zero-length WAV.
  if (!analysis.phrases.length) {
    const pcm = await synthesizePcm({
      text, voice: o.voice,
      lengthScale: (Number.isFinite(o.speed) && o.speed > 0) ? (1 / o.speed) : undefined,
    });
    return { wav: wrapPcmAsWav(pcm, sampleRate), path: 'flat_no_phrases',
             analysis, sampleRate };
  }

  const rendered = await mapWithLimit(
    analysis.phrases, TTS_PHRASE_CONCURRENCY,
    async (phrase) => ({
      pcm: await synthesizePcm({
        text: phrase.text, voice: o.voice, lengthScale: phrase.lengthScale,
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
  const sampleRate = voiceSampleRate(o.voice);
  const analysis = analyse(text, {
    baseLengthScale: voiceLengthScale(o.voice),
    speed: o.speed,
    config: cfg,
  });

  const phrases = analysis.phrases.length
    ? analysis.phrases
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
    return await prewarmWorker(join(VOICES_DIR, `${voice}.onnx`));
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
