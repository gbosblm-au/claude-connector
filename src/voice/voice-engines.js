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
import { existsSync, readdirSync }     from 'node:fs';
import { tmpdir }                      from 'node:os';
import { join }                        from 'node:path';

import { voiceEnabled }                from './voice-gate.js';
import { voicePermitted }              from './voice-catalog.js';

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

/* Section 12 budgets assume one utterance at a time on a shared CPU. Two
 * concurrent Whisper runs on the box that also serves the connector will miss
 * every budget in the table, so requests queue rather than compete. */
const STT_CONCURRENCY = intEnv('VOICE_STT_CONCURRENCY', 1);

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
  };
}

/** Reset probe state. Used by tests and after a configuration change. */
export function resetEngineState() {
  state.sttReady = null; state.ttsReady = null;
  state.sttError = null; state.ttsError = null;
  state.modelsLoaded = []; state.voicesInstalled = [];
  state.inFlight = 0; state.queue = [];
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

    const args = [STT_HELPER, '--transcribe', path, '--model', o.model || STT_TIER,
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
export async function synthesize(opts) {
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
  const args = ['--model', modelPath, '--output_file', '-'];

  // Piper expresses speed as length_scale, which is INVERSE: larger is slower.
  // Passing a speed multiplier straight through would make "1.5x speed" play
  // half as fast.
  if (Number.isFinite(o.speed) && o.speed > 0) {
    args.push('--length_scale', String(1 / o.speed));
  }

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PIPER_BIN, args, {
        cwd: existsSync(PIPER_DIR) ? PIPER_DIR : undefined,
        // Section 11: no connector secrets, no database access. An explicit
        // minimal environment is how that is enforced -- the default would hand
        // this GPL process every API key the connector holds.
        env: { PATH: process.env.PATH, HOME: PIPER_DIR, PYTHONDONTWRITEBYTECODE: '1' },
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
      reject(new Error(`Piper timed out after ${TTS_TIMEOUT}ms`));
    }, TTS_TIMEOUT);

    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', (c) => { if (errText.length < 16_384) errText += c.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wav = Buffer.concat(out);
      if (code !== 0 || wav.length === 0) {
        const err = new Error(errText.slice(0, 500) || `Piper exited ${code} with no audio`);
        err.code = 'tts_failed';
        reject(err);
        return;
      }
      resolve(wav);
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

export default {
  probeEngines, engineState, resetEngineState, transcribe, synthesize,
  installedVoices, config,
};
