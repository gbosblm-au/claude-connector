#!/usr/bin/env node
// scripts/elevenlabs-model-pin-check.mjs
//
// SPEC-AUDIO-004 Section 5, step 4, and falsifier T6: assert the pinned
// ElevenLabs model ids against the live account. Connector v13.35.0.
//
//   TTS  The pinned id must be listed by GET /v1/models AND carry
//        can_do_text_to_speech: true.
//   STT  GET /v1/models documents text-to-speech and voice-conversion models
//        (its capability flags are can_do_text_to_speech,
//        can_do_voice_conversion and the like; read 2026-10-06), so a Scribe
//        id is not expected in it. If the list does carry the STT id, that
//        settles it. Otherwise the id is PROBED: one request to
//        POST /v1/speech-to-text with 0.5 s of silence and the pinned
//        model_id. That costs the account a fraction of a second of
//        transcription; --no-stt-probe skips it, and the STT pin is then
//        reported as unverified.
//
// Usage (the key is read from the environment and never printed):
//
//   ELEVENLABS_API_KEY=... node scripts/elevenlabs-model-pin-check.mjs
//       [--tts-model eleven_multilingual_v2] [--stt-model scribe_v2]
//       [--no-stt-probe] [--json]
//
// Pins, in order of precedence: the flag; ELEVENLABS_DEFAULT_MODEL /
// ELEVENLABS_STT_MODEL; the connector's own defaults (src/voice/elevenlabs.js
// and src/voice/elevenlabs-stt.js).
//
// Exit codes:
//   0  both pins verified
//   1  a pinned id is missing, lacks the capability, or the endpoint rejected it
//   2  could not verify (no key, key refused, quota, unreachable, or the STT
//      probe skipped); nothing is known to be wrong, and nothing is proven
//
// Record the ids and the date printed here in the changelog of the release
// that pins them (Section 5, step 3).

import { argv, env, exit, stdout, stderr } from 'node:process';

const args = argv.slice(2);
const KNOWN = new Set(['--tts-model', '--stt-model', '--no-stt-probe', '--json']);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--') && !KNOWN.has(args[i])) {
    stderr.write(`unknown option ${args[i]}\n`);
    exit(2);
  }
}
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
}

const { ELEVENLABS_DEFAULT_MODEL, elevenLabsBaseUrl, reasonForStatus, errorCode } =
  await import('../src/voice/elevenlabs.js');
const { ELEVENLABS_STT_DEFAULT_MODEL } = await import('../src/voice/elevenlabs-stt.js');

const MODEL_ID = /^[a-z0-9_]{1,64}$/u;
const ttsModel = flag('--tts-model') || String(env.ELEVENLABS_DEFAULT_MODEL || '').trim() || ELEVENLABS_DEFAULT_MODEL;
const sttModel = flag('--stt-model') || String(env.ELEVENLABS_STT_MODEL || '').trim() || ELEVENLABS_STT_DEFAULT_MODEL;
const probe = !args.includes('--no-stt-probe');
const asJson = args.includes('--json');
const apiKey = String(env.ELEVENLABS_API_KEY || '').trim();
const TIMEOUT_MS = 20_000;

const report = {
  checked_at: new Date().toISOString(),
  base: elevenLabsBaseUrl(),
  tts: { model_id: ttsModel, verdict: 'unverified', detail: '' },
  stt: { model_id: sttModel, verdict: 'unverified', detail: '', method: null },
};

function finish() {
  const verdicts = [report.tts.verdict, report.stt.verdict];
  const code = verdicts.includes('fail') ? 1 : (verdicts.every((v) => 'ok' === v) ? 0 : 2);
  report.exit_code = code;
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(`ElevenLabs model pin check, ${report.checked_at}\n`);
    stdout.write(`  TTS ${report.tts.model_id}: ${report.tts.verdict.toUpperCase()} ${report.tts.detail}\n`);
    stdout.write(`  STT ${report.stt.model_id}: ${report.stt.verdict.toUpperCase()} ${report.stt.detail}\n`);
  }
  exit(code);
}

for (const [side, id] of [['tts', ttsModel], ['stt', sttModel]]) {
  if (!MODEL_ID.test(id)) {
    report[side].verdict = 'fail';
    report[side].detail = '(not a model id)';
  }
}
if (!apiKey) {
  for (const side of ['tts', 'stt']) {
    if ('fail' !== report[side].verdict) report[side].detail = '(ELEVENLABS_API_KEY is not set)';
  }
  finish();
}

/**
 * Why a request could not answer the question, in words, without the key.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function cannotVerify(res) {
  const code = await errorCode(res);
  const reason = reasonForStatus(res.status, code);
  const what = 'invalid_key' === reason ? 'key refused' : ('quota' === reason ? 'quota or rate limit' : 'error');
  return `(${what}: HTTP ${res.status}${code ? ` ${code}` : ''})`;
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
let models = null;
if ('fail' !== report.tts.verdict || 'fail' !== report.stt.verdict) {
  try {
    const res = await fetch(`${elevenLabsBaseUrl()}/v1/models`, {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      models = Array.isArray(body) ? body : (body && Array.isArray(body.models) ? body.models : null);
      if (!models) report.tts.detail = '(GET /v1/models did not return a list)';
    } else {
      report.tts.detail = await cannotVerify(res);
    }
  } catch (err) {
    report.tts.detail = '(GET /v1/models could not be reached)';
  }
}

if (models && 'fail' !== report.tts.verdict) {
  const entry = models.find((m) => m && m.model_id === ttsModel);
  if (!entry) {
    report.tts.verdict = 'fail';
    report.tts.detail = `(not in the account's model list; listed: ${models.map((m) => m && m.model_id).filter(Boolean).join(', ') || 'none'})`;
  } else if (true !== entry.can_do_text_to_speech) {
    report.tts.verdict = 'fail';
    report.tts.detail = '(listed, but can_do_text_to_speech is not true)';
  } else {
    report.tts.verdict = 'ok';
    report.tts.detail = `(listed${entry.name ? `: ${String(entry.name).slice(0, 80)}` : ''}, can_do_text_to_speech)`;
  }
}

// ---------------------------------------------------------------------------
// The STT pin: the list if it carries the id, otherwise a probe
// ---------------------------------------------------------------------------
if ('fail' !== report.stt.verdict) {
  const listed = models ? models.find((m) => m && m.model_id === sttModel) : null;
  if (listed) {
    report.stt.verdict = 'ok';
    report.stt.method = 'list';
    report.stt.detail = '(listed by GET /v1/models)';
  } else if (!probe) {
    report.stt.method = 'none';
    report.stt.detail = '(not in GET /v1/models, which lists TTS models; probe skipped by --no-stt-probe)';
  } else {
    report.stt.method = 'probe';
    // 0.5 s of 16 kHz mono silence in a WAV container (Section 4: 100 ms minimum).
    const samples = 8000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii'); wav.writeUInt32LE(samples * 2, 40);
    const form = new FormData();
    form.append('model_id', sttModel);
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'pin-check.wav');
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'none');
    try {
      const res = await fetch(`${elevenLabsBaseUrl()}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        report.stt.verdict = 'ok';
        report.stt.detail = '(accepted by POST /v1/speech-to-text)';
      } else if ([401, 402, 429].includes(res.status) || res.status >= 500) {
        report.stt.detail = await cannotVerify(res);
      } else {
        // 400, 404, 422: the endpoint refused the request it was given, whose
        // only variable is the model id. Reported with its code so a retired
        // id can be told from anything else by reading it.
        const code = await errorCode(res);
        report.stt.verdict = 'fail';
        report.stt.detail = `(rejected by POST /v1/speech-to-text: HTTP ${res.status}${code ? ` ${code}` : ''})`;
      }
    } catch (err) {
      report.stt.detail = '(POST /v1/speech-to-text could not be reached)';
    }
  }
}

finish();
