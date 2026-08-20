/* voice-provision.js  --  get the Kokoro model and voice bundle onto the volume.
 *
 * SPEC-KOKORO-001 v1.1, Section 7.
 *
 * ===========================================================================
 * WHAT PROVISIONING MEANS NOW
 * ===========================================================================
 *
 * Under Piper this module downloaded ONE FILE PAIR PER VOICE (`<voice>.onnx`
 * plus `<voice>.onnx.json`) from huggingface.co/rhasspy/piper-voices, and
 * "install a voice" was a meaningful operation.
 *
 * Kokoro is two files TOTAL: the model, and a bundle holding every voice as a
 * 256-dimensional style vector. Adding a voice to the offered set is a registry
 * edit, not a download. So the surface shrinks to "are the two artifacts here,
 * and fetch them if not".
 *
 * The exported names are unchanged -- routes/voice.js calls provisionFromEnv()
 * and the test suite calls installVoice() and voicesDir(). Keeping the interface
 * is what stopped the engine swap becoming a rewrite of every caller.
 *
 * ===========================================================================
 * WHY DOWNLOADS ARE OPT-IN
 * ===========================================================================
 *
 * The model is ~310 MB. A boot path that fetches it by default turns a redeploy
 * into a multi-minute stall against a health check with a deadline, and turns a
 * network blip into a failed deploy. VOICE_PROVISION_ON_BOOT therefore defaults
 * to FALSE and the intended path is a pre-populated volume or an image layer.
 *
 * When it is off and the files are absent, probeEngines() reports tts_ready
 * false with a message naming the missing path. That is a visible, actionable
 * failure rather than a silent one.
 */

'use strict';

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { writeFile }                                              from 'node:fs/promises';
import { dirname, join }                                          from 'node:path';

/* v13.2.0. Mirrors kokoro-worker-supervisor.js. Duplicated rather than imported
 * so that provisioning -- which runs at boot, before the worker exists -- does
 * not pull in the supervisor and its process machinery just to read a constant. */
const BAKED_DIR = '/opt/kokoro/models';

/* The upstream the pinned kokoro-onnx release is built against. Both files come
 * from the same tagged release, and that matters: a model from one release with
 * a bundle from another produces either a load failure or, worse, voices whose
 * vectors no longer line up with the names. */
const RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';

/** Where the engine artifacts live. Mirrors kokoro-worker-supervisor.js. */
export function voicesDir() {
  return process.env.VOICE_KOKORO_DIR || '/data/voice/kokoro';
}

/**
 * The two artifacts, with the checks that make a partial download detectable.
 *
 * `minBytes` is a floor, not a checksum. A truncated download -- the common
 * failure on a flaky connection or a full volume -- leaves a file that exists
 * and is far too small, and onnxruntime's error for that is an opaque protobuf
 * parse failure. A size floor turns it into a message that says what happened.
 *
 * It is deliberately not a hash: pinning one would mean this file has to change
 * whenever upstream re-cuts a release, and a stale hash refusing a good download
 * is a worse failure than a size floor accepting a rare corrupt one.
 */
export const VOICE_SOURCES = Object.freeze({
  model: Object.freeze({
    file: 'kokoro-v1.0.onnx',
    url: `${RELEASE}/kokoro-v1.0.onnx`,
    minBytes: 100 * 1024 * 1024,
  }),
  voices: Object.freeze({
    file: 'voices-v1.0.bin',
    url: `${RELEASE}/voices-v1.0.bin`,
    minBytes: 1024 * 1024,
  }),
});

/**
 * Retained for interface compatibility.
 *
 * Under Piper this listed voices whose upstream had disappeared. Kokoro has no
 * per-voice upstream, so nothing can go missing individually -- either the
 * bundle is there or it is not.
 */
export const MISSING_UPSTREAM = Object.freeze({});

/**
 * Is an artifact present and plausibly complete?
 *
 * @param {{file: string, minBytes: number}} source
 * @returns {{path: string, present: boolean, bytes: number, truncated: boolean}}
 */
function inspect(source) {
  const path = join(voicesDir(), source.file);
  try {
    const bytes = statSync(path).size;
    return { path, present: true, bytes, truncated: bytes < source.minBytes };
  } catch (err) {
    return { path, present: false, bytes: 0, truncated: false };
  }
}

/**
 * Fetch one artifact.
 *
 * Downloaded to a `.part` file and RENAMED on success, so an interrupted
 * download can never be mistaken for a complete one. A rename within a
 * directory is atomic, which a write-in-place is not -- and the failure mode it
 * prevents is the expensive one: a half-written model that exists, passes an
 * existence check, and fails at load with an opaque parse error.
 *
 * @param {{file: string, url: string, minBytes: number}} source
 * @param {(msg: string) => void} log
 * @returns {Promise<boolean>}
 */
async function fetchArtifact(source, log) {
  const dir = voicesDir();
  const target = join(dir, source.file);
  const partial = `${target}.part`;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log(`[voice] cannot create ${dir}: ${err.message}`);
    return false;
  }

  log(`[voice] fetching ${source.file} (this is a large file; it runs once)`);

  try {
    const response = await fetch(source.url, { redirect: 'follow' });
    if (!response.ok) {
      log(`[voice] ${source.file} download failed: HTTP ${response.status}`);
      return false;
    }
    const bytes = Buffer.from(await response.arrayBuffer());

    // Checked BEFORE the rename. A short body that arrived with a 200 -- a proxy
    // error page, a truncated transfer -- must never be promoted to the real
    // filename, because from then on every check would say the artifact is
    // present.
    if (bytes.length < source.minBytes) {
      log(`[voice] ${source.file} download was truncated `
        + `(${bytes.length} bytes, expected at least ${source.minBytes}); discarding`);
      return false;
    }

    await writeFile(partial, bytes);
    renameSync(partial, target);
    log(`[voice] ${source.file} installed (${bytes.length} bytes)`);
    return true;
  } catch (err) {
    log(`[voice] ${source.file} download failed: ${err.message}`);
    try { if (existsSync(partial)) unlinkSync(partial); } catch (e) { /* best effort */ }
    return false;
  }
}

/**
 * Ensure one named artifact is present.
 *
 * The name is 'model' or 'voices'. A VOICE name is accepted and answered
 * honestly rather than rejected: under Kokoro a voice is a vector inside the
 * bundle, so "install af_bella" means "make sure the bundle is here". Rejecting
 * it would be technically correct and useless to a caller carrying a voice id.
 *
 * @param {string} what
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, path: string|null, reason?: string}>}
 */
export async function installVoice(what, opts) {
  const o = opts || {};
  const log = o.log || (msg => console.log(msg));
  const wanted = String(what ?? '').trim();

  const source = VOICE_SOURCES[wanted]
    // Any other name is treated as a voice id, which the bundle carries.
    || (wanted ? VOICE_SOURCES.voices : null);

  if (!source) {
    return { ok: false, path: null, reason: 'unknown_artifact' };
  }

  const found = inspect(source);
  if (found.present && !found.truncated) return { ok: true, path: found.path };

  if (found.truncated) {
    log(`[voice] ${source.file} is present but only ${found.bytes} bytes; refetching`);
    try { unlinkSync(found.path); } catch (err) { /* best effort */ }
  }

  const ok = await fetchArtifact(source, log);
  return ok
    ? { ok: true, path: found.path }
    : { ok: false, path: null, reason: 'download_failed' };
}

/**
 * Ensure everything the engine needs is present.
 *
 * @param {Array<string>} [names]
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, installed: Array<string>, failed: Array<string>}>}
 */
export async function installVoices(names, opts) {
  const wanted = (Array.isArray(names) && names.length) ? names : ['model', 'voices'];
  const installed = [];
  const failed = [];

  // Sequential, not parallel. Two concurrent multi-hundred-megabyte downloads on
  // a small instance compete for the same bandwidth and the same disk, and the
  // failure they produce -- a full volume midway through both -- leaves two
  // truncated files instead of one good one.
  for (const name of wanted) {
    const result = await installVoice(name, opts);
    (result.ok ? installed : failed).push(name);
  }

  return { ok: 0 === failed.length, installed, failed };
}

/**
 * Provision at boot, if asked.
 *
 * v13.2.0. LARGELY REDUNDANT NOW, and kept deliberately.
 *
 * The artifacts are baked into the image at /opt/kokoro/models, so a fresh
 * deploy works with no network and no manual step. This path remains for the
 * two cases the image copy cannot serve:
 *
 *   1. Upgrading the model without rebuilding -- fetch a newer file onto the
 *      volume, which the runtime prefers over the baked copy.
 *   2. A deployment that strips the image layers, or runs the source outside
 *      the container.
 *
 * Still OFF by default: with the artifacts baked in, a boot-time fetch would be
 * pure cost -- a redeploy stalling against a health check deadline to download
 * something already present.
 *
 * DEFAULTS TO OFF. See the header: the model is ~310 MB, and a boot path that
 * fetches it turns a redeploy into a stall against a health check with a
 * deadline. Never throws and never blocks -- it returns a promise the caller is
 * free to ignore, and a failure here surfaces as tts_ready:false with a message
 * naming the missing path.
 *
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ok: boolean, skipped?: boolean, installed?: Array<string>,
 *                    failed?: Array<string>}>}
 */
export function provisionFromEnv(log) {
  const write = log || (msg => console.log(msg));
  const raw = String(process.env.VOICE_PROVISION_ON_BOOT || '').trim().toLowerCase();
  const enabled = 'true' === raw || '1' === raw || 'yes' === raw;

  if (!enabled) {
    // v13.2.0. Absent from the VOLUME is no longer a problem worth a warning:
    // the runtime falls back to the copy baked into the image, which is the
    // normal and expected state. Warning about it on every boot would train an
    // operator to ignore the log line that matters.
    //
    // It is only worth saying something when NEITHER layer has the artifacts,
    // which means the image was built without them -- and that is a broken
    // image rather than a missing volume.
    const missingFromVolume = ['model', 'voices']
      .filter(k => !inspect(VOICE_SOURCES[k]).present)
      .map(k => VOICE_SOURCES[k].file);

    if (missingFromVolume.length) {
      const bakedMissing = missingFromVolume
        .filter(f => !existsSync(join(BAKED_DIR, f)));
      if (bakedMissing.length) {
        write(`[voice] Kokoro artifacts are on NEITHER the volume (${voicesDir()}) `
          + `nor in the image (${BAKED_DIR}): ${bakedMissing.join(', ')}. `
          + 'The image was built without them. Rebuild, or set '
          + 'VOICE_PROVISION_ON_BOOT=true to fetch them onto the volume.');
      }
    }
    return Promise.resolve({ ok: true, skipped: true });
  }

  return installVoices(['model', 'voices'], { log: write })
    .catch(err => {
      write(`[voice] provisioning failed: ${err.message}`);
      return { ok: false, installed: [], failed: ['model', 'voices'] };
    });
}

export default {
  voicesDir, VOICE_SOURCES, MISSING_UPSTREAM, installVoice, installVoices,
  provisionFromEnv,
};
