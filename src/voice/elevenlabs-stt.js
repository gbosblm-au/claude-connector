// src/voice/elevenlabs-stt.js
//
// Tenax Voice -- the ElevenLabs speech-to-text adapter. SPEC-AUDIO-004 rev 1,
// build W6 step 7. Connector v13.35.0.
//
// ===========================================================================
// WHAT THIS IS
// ===========================================================================
//
// The one place the connector sends a RECORDING to ElevenLabs. It transcribes
// one upload with the user's own key and the pinned model, and normalises the
// answer to the shape POST /voice/transcribe already returns:
//
//   { text, language, duration_seconds, segments: [] }
//
// Clients read `text` only (ts-client-gateway 38-voice.js and
// 39-voice-autosend.js); `segments` is returned empty because the request asks
// for no timestamps (below), and an empty list is a value the route already
// returns when Whisper produces none.
//
// Failures carry the three reasons the TTS adapter uses (elevenlabs.js):
//
//   invalid_key  HTTP 401. The gateway switches speech-to-text off for the
//                user (SPEC-AUDIO-004 D5); TTS is untouched.
//   quota        HTTP 402 or 429, or a body that names quota. The gateway
//                records it and holds the user on Whisper briefly.
//   error        Anything else: 422 validation, 5xx, a timeout, a network
//                failure, an answer that is not a transcript.
//
// None is retried here (Section 6: "fall back to Whisper once per request").
// The route renders the recording with Whisper instead and names the reason.
//
// ===========================================================================
// THE VENDOR CONTRACT (read 2026-10-05 and re-read 2026-10-06)
// ===========================================================================
//
// POST {base}/v1/speech-to-text, multipart/form-data, header xi-api-key.
//   model_id                required; ELEVENLABS_STT_MODEL, default scribe_v2
//                           (SPEC-AUDIO-004 Section 5; scribe_v1 is deprecated)
//   file                    the recording, in its own container
//   language_code           sent only when the caller named a language
//                           (ISO-639-1 or -3); otherwise auto-detect
//   tag_audio_events=false  dictation must not gain "(laughter)" in the
//                           text a user sends to the assistant
//   timestamps_granularity=none   only `text` is consumed (Section 4)
// Not sent: enable_logging (zero retention is enterprise-only, Section 3; the
// D7 label tells the user), file_format (the default `other` is right for the
// browser's webm/ogg; pcm_s16le_16 is for raw PCM only), keyterms (an open item
// with a surcharge, Section 10).
// Response consumed: `text`, `language_code`, and `audio_duration_secs` when
// present (SPEC-AUDIO-004 Section 4 names it; the reference page's example does
// not show it, so it is optional here).
//
// ===========================================================================
// KEY CUSTODY (SPEC-AUDIO-004 D6)
// ===========================================================================
//
// The key arrives from the gateway in the X-Tenax-ElevenLabs-Key request
// header, lives in this module's arguments for one HTTP call, and is never
// logged, placed in an error message, or returned. The connector logs no
// request headers. src/tests/voice-elevenlabs-stt.test.js plants a key and
// asserts it appears in no output (T5).

import {
  elevenLabsBaseUrl, reasonForStatus, elError, errorCode, headersOfInterest,
} from './elevenlabs.js';

/** The pinned speech-to-text model (SPEC-AUDIO-004 Section 5, 2026-10-05). */
export const ELEVENLABS_STT_DEFAULT_MODEL = 'scribe_v2';

/** The request header the gateway forwards the user's key in. Lower case, as Node reads it. */
export const STT_KEY_HEADER = 'x-tenax-elevenlabs-key';

/** Container -> MIME type for the multipart file part. */
const FORMAT_MIME = Object.freeze({
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', webm: 'audio/webm',
  flac: 'audio/flac', m4a: 'audio/mp4',
});

/**
 * An integer environment variable inside a range, or the fallback.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intEnv(name, fallback, min, max) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

let _warnedModel = '';

/**
 * The pinned model id. ELEVENLABS_STT_MODEL overrides it; a value that cannot
 * be a model id is ignored with a warning rather than sent.
 *
 * @returns {string}
 */
export function elevenLabsSttModel() {
  const raw = String(process.env.ELEVENLABS_STT_MODEL || '').trim();
  if (!raw) return ELEVENLABS_STT_DEFAULT_MODEL;
  if (/^[a-z0-9_]{1,64}$/u.test(raw)) return raw;
  if (_warnedModel !== raw) {
    _warnedModel = raw;
    console.warn(`[voice] ELEVENLABS_STT_MODEL is not a model id; using ${ELEVENLABS_STT_DEFAULT_MODEL}`);
  }
  return ELEVENLABS_STT_DEFAULT_MODEL;
}

/**
 * How long one transcription may take before Whisper renders it instead.
 * The gateway allows twice its Whisper deadline when it forwards a key, so
 * this plus a Whisper run fits inside it.
 *
 * @returns {number} Milliseconds.
 */
export function elevenLabsSttTimeoutMs() {
  return intEnv('ELEVENLABS_STT_TIMEOUT_MS', 60_000, 5_000, 110_000);
}

/**
 * Read the forwarded key from a request.
 *
 * Null when the header is absent, which is every request from a user who has
 * not turned speech-to-text on: the route then behaves exactly as before (D3).
 * { ok: false } when it is present but cannot be a key; the route treats that
 * as an ElevenLabs failure and Whisper transcribes.
 *
 * @param {object} req
 * @returns {null|{ok: true, apiKey: string}|{ok: false, reason: string}}
 */
export function elevenLabsSttFrom(req) {
  const headers = (req && req.headers) || {};
  const raw = headers[STT_KEY_HEADER];
  if (undefined === raw) return null;
  const value = Array.isArray(raw) ? '' : String(raw).trim();
  // The shape of every ElevenLabs key, and the shape parseElevenLabsConfig
  // accepts for TTS: printable ASCII, no whitespace.
  if (!/^[\x21-\x7e]{8,256}$/u.test(value)) return { ok: false, reason: 'api_key' };
  return { ok: true, apiKey: value };
}

/**
 * A language hint ElevenLabs accepts, or empty for auto-detect.
 *
 * @param {string} [language]
 * @returns {string}
 */
function languageCode(language) {
  const v = String(language || '').trim().toLowerCase();
  return /^[a-z]{2,3}$/u.test(v) ? v : '';
}

/**
 * Transcribe one recording with the user's ElevenLabs account.
 *
 * @param {object} o
 * @param {string} o.apiKey
 * @param {Buffer} o.audio The validated upload.
 * @param {string} o.format Container from validateAudio (wav, mp3, ogg, webm, flac, m4a).
 * @param {string} [o.language] Caller's language hint.
 * @param {number} [o.durationHint] Seconds, from validateAudio, used when the answer has none.
 * @param {Function} [o.fetchImpl] Injected in tests; global fetch otherwise.
 * @param {string} [o.modelId] v13.36.0: a model id for this one request (the
 *   probe route); the pin from ELEVENLABS_STT_MODEL otherwise.
 * @param {Function} [o.observe] v13.36.0: called with { status, ok, code,
 *   headers } for the response (the probe route).
 * @returns {Promise<{text: string, language: string, duration_seconds: number, segments: Array}>}
 * @throws {Error} code el_invalid_key | el_quota | el_error, with `reason`.
 */
export async function transcribeElevenLabs(o) {
  const opts = o || {};
  if (!opts.apiKey) throw elError('error', 'ElevenLabs is not configured for this request.');
  if (!Buffer.isBuffer(opts.audio) || !opts.audio.length) {
    throw elError('error', 'No audio to send to ElevenLabs.');
  }

  const format = FORMAT_MIME[opts.format] ? opts.format : 'webm';
  const form = new FormData();
  const modelId = ('string' === typeof opts.modelId && /^[a-z0-9_]{1,64}$/u.test(opts.modelId))
    ? opts.modelId : elevenLabsSttModel();
  form.append('model_id', modelId);
  form.append('file', new Blob([opts.audio], { type: FORMAT_MIME[format] }), `recording.${format}`);
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'none');
  const lang = languageCode(opts.language);
  if (lang) form.append('language_code', lang);

  const doFetch = 'function' === typeof opts.fetchImpl ? opts.fetchImpl : fetch;
  let res;
  try {
    res = await doFetch(`${elevenLabsBaseUrl()}/v1/speech-to-text`, {
      method: 'POST',
      // Content-Type is set by fetch from the FormData, with its boundary.
      headers: { 'xi-api-key': opts.apiKey, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(elevenLabsSttTimeoutMs()),
    });
  } catch (err) {
    const timedOut = err && ('TimeoutError' === err.name || 'AbortError' === err.name);
    throw elError('error', timedOut ? 'ElevenLabs did not transcribe in time.'
      : 'ElevenLabs could not be reached.');
  }

  const observe = 'function' === typeof opts.observe ? opts.observe : null;
  if (!res.ok) {
    const code = await errorCode(res);
    if (observe) observe({ status: res.status, ok: false, code, headers: headersOfInterest(res) });
    const reason = reasonForStatus(res.status, code);
    throw elError(reason, `ElevenLabs answered ${res.status}${code ? ` (${code})` : ''}.`, res.status);
  }

  if (observe) observe({ status: res.status, ok: true, code: '', headers: headersOfInterest(res) });
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw elError('error', 'ElevenLabs returned a transcript that is not JSON.', res.status);
  }
  if (!body || 'object' !== typeof body || 'string' !== typeof body.text) {
    throw elError('error', 'ElevenLabs returned no transcript text.', res.status);
  }

  const reported = Number(body.audio_duration_secs);
  const hinted = Number(opts.durationHint);
  return {
    // An empty string is a real answer (a silent recording), as it is from
    // Whisper; only a missing `text` is a failure.
    text: body.text.trim(),
    language: 'string' === typeof body.language_code ? body.language_code : '',
    duration_seconds: Number.isFinite(reported) && reported > 0 ? reported
      : (Number.isFinite(hinted) && hinted > 0 ? hinted : 0),
    segments: [],
  };
}

export default {
  ELEVENLABS_STT_DEFAULT_MODEL, STT_KEY_HEADER, elevenLabsSttModel, elevenLabsSttTimeoutMs,
  elevenLabsSttFrom, transcribeElevenLabs,
};
