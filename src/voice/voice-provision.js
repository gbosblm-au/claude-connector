// src/voice/voice-provision.js
//
// Tenax Voice -- getting Piper voice models onto the volume. (v12.50.0)
//
// ===========================================================================
// WHY THIS IS RUNTIME WORK AND NOT A DOCKERFILE LINE
// ===========================================================================
//
// Specification Section 11 asks for models "pre-downloaded at deploy", and the
// Dockerfile does create /data/voice/piper/voices at build time. It cannot fill
// it. The Railway volume is mounted OVER /data when the container starts, so
// anything the image wrote underneath that path is masked the moment it runs.
// A `RUN wget` in the Dockerfile would download several hundred megabytes into
// a directory nothing will ever read.
//
// So the download has to happen at runtime, against the mounted volume, exactly
// once, and it has to survive restarts -- which it does, because the volume is
// persistent. This module is that step.
//
// ===========================================================================
// WHY NOT LET PIPER DOWNLOAD ITS OWN VOICES
// ===========================================================================
//
// piper-tts can fetch a missing voice: __main__.py calls ensure_voice_exists()
// when the model path does not exist. It looks the voice up BY NAME in its
// voices.json index, and voice-engines.js passes an absolute PATH
// (<VOICES_DIR>/<voice>.onnx), which is not a name in that index. The lookup
// raises and the request fails.
//
// Passing a bare name instead would hand the GPL process a network egress path
// and a download directory chosen by its own defaults, on a request path, while
// a user waits. Downloading deliberately, ahead of time, from a pinned
// repository is the better trade in every direction.
//
// ===========================================================================
// PINNED SOURCE
// ===========================================================================
//
// Section 15 pins model downloads to HuggingFace. Voices come from
// rhasspy/piper-voices, the repository Piper itself indexes, at a fixed layout:
//
//   <lang_family>/<locale>/<name>/<quality>/<voice_id>.onnx
//   <lang_family>/<locale>/<name>/<quality>/<voice_id>.onnx.json
//
// Both files are required. Piper reads the .onnx.json for the sample rate,
// phoneme map and inference defaults; the .onnx alone produces an immediate
// failure that reads like a corrupt model rather than a missing config.

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { existsSync }                     from 'node:fs';
import { join }                           from 'node:path';

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** Where the voice files live, matching voice-engines.js. */
export function voicesDir() {
  const dir = process.env.VOICE_VOICES_DIR;
  if (dir) return dir;
  const piperDir = process.env.VOICE_PIPER_DIR || '/data/voice/piper';
  return join(piperDir, 'voices');
}

/**
 * Repository path for each voice the catalogue names.
 *
 * Verified against the live repository tree rather than inferred from the voice
 * id, because the id and the path do not always agree -- see the Japanese entry
 * below, where they disagree in a way that cannot be derived.
 */
export const VOICE_SOURCES = Object.freeze({
  // The English default from v12.50.0: public-domain LibriVox source.
  'en_US-kristin-medium':      'en/en_US/kristin/medium',
  // Retained so an existing deployment can still fetch it, though
  // voice-catalog.js refuses to synthesise with it: non-commercial licence.
  'en_US-lessac-medium':       'en/en_US/lessac/medium',
  'zh_CN-huayan-medium':       'zh/zh_CN/huayan/medium',
  'vi_VN-vais1000-medium':     'vi/vi_VN/vais1000/medium',
  'vi_VN-25hours_single-low':  'vi/vi_VN/25hours_single/low',
  // The only Japanese voice the repository publishes. Note the locale
  // directory: ja_JA, not ja_JP. That is upstream's spelling, not a typo here.
  'ja_JA-hi_fi_captain-medium': 'ja/ja_JA/hi_fi_captain/medium',
});

/**
 * Voice ids the catalogue lists that DO NOT EXIST upstream.
 *
 * `ja_JP-ryoko-medium` is in VOICE_CATALOG as the Japanese default. There is no
 * such voice in rhasspy/piper-voices: the repository has exactly one Japanese
 * voice, ja_JA-hi_fi_captain-medium. A request for Japanese TTS therefore
 * cannot succeed no matter what is downloaded.
 *
 * Named here rather than silently substituted. VOICE_CATALOG is a LICENCE
 * record -- every entry carries audited/licence/model_card fields that a
 * compliance review reads -- and quietly swapping an id in it would put an
 * unreviewed voice behind a reviewed name. The substitution is a decision for
 * whoever owns that record, so this module reports the problem precisely and
 * changes nothing.
 */
export const MISSING_UPSTREAM = Object.freeze({
  'ja_JP-ryoko-medium':
    'not published by rhasspy/piper-voices. The only Japanese voice available is '
    + 'ja_JA-hi_fi_captain-medium. Japanese TTS cannot work until VOICE_CATALOG in '
    + 'src/voice/voice-catalog.js is updated, which is a licence-record change and '
    + 'needs the same audit as any other entry.',
});

/**
 * Download one file to a temporary name and move it into place.
 *
 * The rename is the point: a download interrupted halfway leaves
 * `<voice>.onnx.partial`, which installedVoices() ignores, rather than a
 * truncated `<voice>.onnx` that looks installed and fails at synthesis. Rename
 * within one directory is atomic on the volume's filesystem.
 *
 * @param {string} url
 * @param {string} destination
 * @param {number} timeoutMs
 * @returns {Promise<number>} Bytes written.
 */
async function download(url, destination, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'claude-connector/12.50.0 (tenax-voice provisioner)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error(`empty response for ${url}`);

  const partial = `${destination}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, destination);
  return bytes.length;
}

/**
 * Install one voice, unless it is already present.
 *
 * @param {string} voiceId
 * @param {{force?: boolean, timeoutMs?: number, log?: Function}} [opts]
 * @returns {Promise<{voice: string, status: string, bytes?: number, error?: string}>}
 */
export async function installVoice(voiceId, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const timeoutMs = o.timeoutMs || 300_000;

  if (MISSING_UPSTREAM[voiceId]) {
    return { voice: voiceId, status: 'unavailable', error: MISSING_UPSTREAM[voiceId] };
  }

  const path = VOICE_SOURCES[voiceId];
  if (!path) {
    return {
      voice: voiceId,
      status: 'unknown',
      error: `No source is recorded for "${voiceId}". Known voices: `
        + `${Object.keys(VOICE_SOURCES).join(', ')}.`,
    };
  }

  const dir = voicesDir();
  await mkdir(dir, { recursive: true });

  const model  = join(dir, `${voiceId}.onnx`);
  const config = join(dir, `${voiceId}.onnx.json`);

  // Both files, or it is not installed. A model without its config is the
  // failure that reads like a corrupt download.
  if (!o.force && existsSync(model) && existsSync(config)) {
    const s = await stat(model).catch(() => null);
    return { voice: voiceId, status: 'present', bytes: s ? s.size : undefined };
  }

  try {
    // Config first: it is small, so a wrong path or a network fault costs a few
    // kilobytes instead of sixty megabytes before it is discovered.
    log(`[voice-provision] ${voiceId}: fetching config`);
    await download(`${HF_BASE}/${path}/${voiceId}.onnx.json`, config, timeoutMs);

    log(`[voice-provision] ${voiceId}: fetching model (this is tens of MB)`);
    const bytes = await download(`${HF_BASE}/${path}/${voiceId}.onnx`, model, timeoutMs);

    log(`[voice-provision] ${voiceId}: installed (${Math.round(bytes / 1048576)} MB)`);
    return { voice: voiceId, status: 'installed', bytes };
  } catch (err) {
    log(`[voice-provision] ${voiceId}: FAILED -- ${err.message}`);
    return { voice: voiceId, status: 'failed', error: err.message };
  }
}

/**
 * Install several voices, one at a time.
 *
 * Serial, not parallel. These are tens of megabytes each onto a small shared
 * box that is also serving the connector, and the whole point of Section 12's
 * budgets is that voice does not get to monopolise it.
 *
 * @param {string[]} voiceIds
 * @param {object} [opts]
 * @returns {Promise<Array>}
 */
export async function installVoices(voiceIds, opts) {
  const results = [];
  for (const voiceId of voiceIds) {
    results.push(await installVoice(voiceId, opts));
  }
  return results;
}

/**
 * The boot hook. Reads VOICE_PROVISION_VOICES and installs what it names.
 *
 * DELIBERATELY OPT-IN, and deliberately does not block the boot:
 *
 *   - Opt-in, because a connector that downloads hundreds of megabytes on first
 *     start because a variable was left unset is the same class of surprise the
 *     VOICE_ENABLED default exists to avoid.
 *   - Non-blocking, because Railway's health check has a deadline and a slow
 *     model download must not fail a deploy. Voice reports itself degraded
 *     until the files land, which is exactly what degraded is for.
 *   - Gated on voiceEnabled(), because Section 7 requires that nothing voice
 *     related runs when the master switch is off.
 *
 * @param {Function} [log]
 * @returns {Promise<Array>|null} Null when nothing was requested.
 */
export function provisionFromEnv(log) {
  const raw = String(process.env.VOICE_PROVISION_VOICES || '').trim();
  if (!raw) return null;

  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!wanted.length) return null;

  const say = log || ((m) => console.log(m));
  say(`[voice-provision] requested: ${wanted.join(', ')}`);

  return installVoices(wanted, { log: say }).then((results) => {
    const failed = results.filter(r => r.status === 'failed' || r.status === 'unavailable'
                                    || r.status === 'unknown');
    failed.forEach(r => console.error(`[voice-provision] ${r.voice}: ${r.error}`));
    const ok = results.filter(r => r.status === 'installed' || r.status === 'present');
    say(`[voice-provision] done: ${ok.length} available, ${failed.length} unresolved`);
    return results;
  }).catch((err) => {
    // Never allowed to take the connector down. A failed voice download is a
    // degraded feature, not a dead service.
    console.error(`[voice-provision] aborted: ${err.message}`);
    return [];
  });
}

export default {
  installVoice, installVoices, provisionFromEnv, voicesDir,
  VOICE_SOURCES, MISSING_UPSTREAM,
};
