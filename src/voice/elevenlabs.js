// src/voice/elevenlabs.js
//
// Tenax Voice -- the ElevenLabs engine adapter. SPEC-AUDIO-003 Sections 5.3,
// 5.5 and 6. Connector v13.34.0; W7 additions in v13.35.0.
//
// ===========================================================================
// WHAT THIS IS
// ===========================================================================
//
// The one place the connector talks to ElevenLabs. It renders ONE piece of
// text (a phrase, or a sentence-bounded segment) to headerless PCM and maps
// every failure onto the three reasons the rest of the system understands:
//
//   invalid_key  HTTP 401 (authentication_error). The gateway auto-disables the
//                user's switch and shows the state in settings (Section 5.3).
//   quota        HTTP 402 (insufficient_credits) or 429 (rate_limit_error), or
//                a legacy 401 whose detail names quota_exceeded. The reply
//                falls back to Kokoro and the switch stays on (E6).
//   error        Anything else, including a timeout, a network failure, an
//                empty body, and a 5xx that failed its one retry.
//
// Endpoint and parameter facts, from the ElevenLabs API reference fetched
// 2026-10-05 (text-to-speech convert, errors):
//
//   POST {base}/v1/text-to-speech/{voice_id}?output_format=pcm_24000
//   header  xi-api-key
//   body    { text, model_id, previous_text?, next_text? }
//   pcm_16000 and pcm_24000 are both listed output formats; raw signed 16-bit
//   little-endian mono, which is what the Kokoro path produces, so the two
//   engines' samples can share one concatenator.
//
// ===========================================================================
// KEY CUSTODY (Section 6)
// ===========================================================================
//
// The key arrives in the request body from the gateway, lives in this
// function's arguments for the length of one HTTP call, and is never:
//   - written to a log line (no console call in this file takes the config);
//   - placed in an error message (messages are built from status codes and
//     ElevenLabs' own machine-readable error code only);
//   - returned to the caller (the result is PCM bytes).
// src/tests/voice-elevenlabs.test.js drives success and every failure path and
// asserts the key appears in none of the captured output (E1).
//
// No npm dependency is added: global fetch (Node 18+) and AbortSignal.timeout.
//
// v13.35.0 (work order W7): every text field of the request body is checked
// for bracketed tokens before the call (deliverable 5), and the unit of one
// generation became a sentence by default (ELEVENLABS_SEGMENT_UNIT).
//
// v13.36.0 (W7 rev 2.1): the check is the split guards G1, G3 and G4
// (engine-form.js guardRequest), the configuration carries the user's tag
// switch and the source of the model id, and a caller may observe each
// response (status, vendor code, headers) for the probe route.

import { guardRequest } from './engine-form.js';

/** The documented API default model, used when the gateway names none. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

/** The output rates this adapter requests. Both are documented ElevenLabs formats. */
const PCM_FORMATS = Object.freeze({ 16000: 'pcm_16000', 24000: 'pcm_24000' });

/** The longest neighbour text sent as previous_text / next_text. */
const CONTEXT_CHARS = 500;

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

/**
 * The API base. Overridable so the test suite can point the adapter at a fake
 * service and no real key is ever needed to verify it (SPEC-AUDIO-003 W3).
 *
 * @returns {string}
 */
export function elevenLabsBaseUrl() {
  const raw = String(process.env.ELEVENLABS_API_BASE || '').trim().replace(/\/+$/u, '');
  if (/^https?:\/\/[^\s]+$/u.test(raw)) return raw;
  return 'https://api.elevenlabs.io';
}

/** Per-request timeout. */
export function elevenLabsTimeoutMs() {
  return intEnv('ELEVENLABS_TIMEOUT_MS', 30_000, 1000, 120_000);
}

/** Phrases in flight at once against the user's account. */
export function elevenLabsConcurrency() {
  return intEnv('ELEVENLABS_CONCURRENCY', 2, 1, 8);
}

/**
 * The time the buffered route gives ElevenLabs for a whole reply before it
 * gives up and renders the reply with Kokoro instead: 45 seconds for each
 * 5,000 characters or part of them.
 *
 * Deliberately smaller than the gateway's synthesis deadline (60 seconds per
 * 5,000 characters, doubled for an ElevenLabs user), so a slow or retrying
 * ElevenLabs can never use up the time the Kokoro fallback needs. Without it,
 * two 30-second attempts on one segment already exceeded the gateway's 60
 * seconds, and the user got a 504 and silence (found in the independent review
 * of this release).
 *
 * @param {number} chars
 * @returns {number} Milliseconds.
 */
export function elevenLabsReplyBudgetMs(chars) {
  const per = intEnv('ELEVENLABS_BUDGET_MS_PER_5000', 45_000, 5_000, 600_000);
  const n = Number(chars);
  const blocks = Number.isFinite(n) && n > 0 ? Math.ceil(n / 5000) : 1;
  return per * blocks;
}

/**
 * The longest segment the flat (non-prosody) ElevenLabs path sends in one call.
 * eleven_multilingual_v2 accepts 10,000 characters per request; 2,500 keeps a
 * single call well inside the timeout.
 *
 * @returns {number}
 */
export function elevenLabsSegmentChars() {
  return intEnv('ELEVENLABS_SEGMENT_CHARS', 2500, 200, 9000);
}

/**
 * The unit of one ElevenLabs generation on the prosody paths.
 *
 * v13.35.0, work order W7 finding D1. Until this release every prosody phrase
 * was its own generation, and prosody cuts phrases after commas, semicolons,
 * colons and dashes, so most generations ended on one of those marks. A
 * generation that ends on a comma or a colon has nothing after it to resolve
 * into; that is the "comma jump" and "colon stop" the work order reports.
 * 'sentence' (the default) joins the phrases of one sentence into one
 * generation, so the model reads the punctuation inside it as punctuation.
 * 'phrase' restores the previous behaviour for an A/B listen.
 *
 * @returns {'sentence'|'phrase'}
 */
export function elevenLabsSegmentUnit() {
  const raw = String(process.env.ELEVENLABS_SEGMENT_UNIT || '').trim().toLowerCase();
  return 'phrase' === raw ? 'phrase' : 'sentence';
}

/**
 * Validate the configuration the gateway forwarded.
 *
 * Returns null when nothing was sent, which is the state of every user who has
 * not configured ElevenLabs: their request carries no `elevenlabs` field and
 * this is the only line of new code it touches (D7).
 *
 * Returns { ok: false } for a malformed value. That is a gateway fault, not a
 * user one, and the reply still speaks: the route treats it as an ElevenLabs
 * failure and renders the whole reply with Kokoro.
 *
 * v13.36.0 (W7 rev 2.1 sections 5.1 and 5.2): `tags` is true only when the
 * gateway sent `tags: true` (the user's switch, default off). `modelSource`
 * names who supplied the model id: the gateway's `model_id_source` ('user' or
 * 'gateway_default') when it sends one, 'request' for an id with no source,
 * 'connector_default' when the id arrived empty and the constant above is used.
 *
 * @param {*} raw The body's `elevenlabs` field.
 * @returns {null|{ok: true, config: {apiKey: string, voiceId: string, modelId: string,
 *           modelSource: string, tags: boolean}}|{ok: false, reason: string}}
 */
export function parseElevenLabsConfig(raw) {
  if (undefined === raw || null === raw) return null;
  if ('object' !== typeof raw || Array.isArray(raw)) return { ok: false, reason: 'not_an_object' };

  const apiKey = 'string' === typeof raw.api_key ? raw.api_key.trim() : '';
  const voiceId = 'string' === typeof raw.voice_id ? raw.voice_id.trim() : '';
  const modelRaw = 'string' === typeof raw.model_id ? raw.model_id.trim() : '';

  // Printable ASCII with no whitespace: the shape of every ElevenLabs key, and
  // the shape that cannot break out of an HTTP header.
  if (!/^[\x21-\x7e]{8,256}$/u.test(apiKey)) return { ok: false, reason: 'api_key' };
  // Voice ids are short alphanumerics. Anything else could not be a valid path
  // segment and is refused rather than escaped into one.
  if (!/^[A-Za-z0-9]{1,64}$/u.test(voiceId)) return { ok: false, reason: 'voice_id' };
  if (modelRaw && !/^[a-z0-9_]{1,64}$/u.test(modelRaw)) return { ok: false, reason: 'model_id' };

  const sourceRaw = 'string' === typeof raw.model_id_source ? raw.model_id_source : '';
  const modelSource = !modelRaw ? 'connector_default'
    : (MODEL_SOURCES.includes(sourceRaw) ? sourceRaw : 'request');
  return {
    ok: true,
    config: { apiKey, voiceId, modelId: modelRaw || ELEVENLABS_DEFAULT_MODEL, modelSource,
              tags: true === raw.tags },
  };
}

/** The model-id sources the gateway may name (W7 rev 2.1 section 5.1). */
const MODEL_SOURCES = Object.freeze(['user', 'gateway_default']);

/**
 * The response headers a probe reports, for one response. Every header except
 * cookies, bounded in count and length; the key is a REQUEST header and is
 * never among them.
 *
 * @param {Response} res
 * @returns {Object<string,string>}
 */
export function headersOfInterest(res) {
  const out = {};
  if (!res || !res.headers || 'function' !== typeof res.headers.forEach) return out;
  let n = 0;
  res.headers.forEach((value, name) => {
    const key = String(name).toLowerCase();
    if ('set-cookie' === key || n >= 40) return;
    out[key] = String(value).slice(0, 200);
    n += 1;
  });
  return out;
}

/**
 * The output format for a sample rate. The Kokoro path decides the rate (the
 * tenant setting, or the engine's native 24 kHz); ElevenLabs is asked for the
 * same one so both engines' samples can be joined without resampling.
 *
 * @param {number} sampleRate
 * @returns {{format: string, sampleRate: number}}
 */
export function elevenLabsOutputFormat(sampleRate) {
  const rate = Number(sampleRate);
  if (PCM_FORMATS[rate]) return { format: PCM_FORMATS[rate], sampleRate: rate };
  return { format: PCM_FORMATS[24000], sampleRate: 24000 };
}

/**
 * Remove misaki markup the Kokoro pipeline may have added.
 *
 * `[label](/ipa/)` and `[label](+2)` are instructions to Kokoro's G2P. Sent to
 * ElevenLabs they would be read aloud as brackets and slashes, so only the
 * label is kept.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMisakiMarkup(text) {
  return String(text || '').replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1');
}

/**
 * A named ElevenLabs failure.
 *
 * Exported in v13.35.0 so the speech-to-text adapter (elevenlabs-stt.js) names
 * its failures with the same three reasons and the same message discipline.
 *
 * @param {'invalid_key'|'quota'|'error'} reason
 * @param {string} message Built from status codes only; never from the key.
 * @param {number} [status]
 * @returns {Error}
 */
export function elError(reason, message, status) {
  const err = new Error(message);
  err.code = `el_${reason}`;
  err.reason = reason;
  if (Number.isInteger(status)) err.status = status;
  return err;
}

/**
 * ElevenLabs' machine-readable error code from a response body, if it has one
 * of a safe shape. Only `detail.code` (and the legacy `detail.status`) are
 * read, and only when they look like an identifier, so free text from the
 * response can never reach a log line.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
export async function errorCode(res) {
  try {
    const body = await res.json();
    const detail = body && 'object' === typeof body.detail && body.detail ? body.detail : {};
    for (const candidate of [detail.code, detail.status]) {
      if ('string' === typeof candidate && /^[a-z_]{1,64}$/u.test(candidate)) return candidate;
    }
  } catch (err) { /* not JSON; the status code is enough */ }
  return '';
}

/**
 * Map an HTTP status (and ElevenLabs' own code) to a reason.
 *
 * @param {number} status
 * @param {string} code
 * @returns {'invalid_key'|'quota'|'error'}
 */
export function reasonForStatus(status, code) {
  if ('quota_exceeded' === code || 'insufficient_credits' === code) return 'quota';
  if (401 === status) return 'invalid_key';
  if (402 === status || 429 === status) return 'quota';
  return 'error';
}

/**
 * Render one piece of text with the user's own ElevenLabs voice.
 *
 * @param {object} o
 * @param {{apiKey: string, voiceId: string, modelId: string}} o.config
 * @param {string} o.text
 * @param {string} [o.previousText]
 * @param {string} [o.nextText]
 * @param {number} [o.sampleRate] 16000 or 24000.
 * @param {Function} [o.fetchImpl] Injected in tests; global fetch otherwise.
 * @param {Function} [o.observe] Called once per response with
 *   { attempt, status, ok, code, headers } (v13.36.0, for the probe route).
 * @returns {Promise<{pcm: Buffer, sampleRate: number}>}
 * @throws {Error} code el_invalid_key | el_quota | el_error, with `reason`.
 */
export async function synthesizeElevenLabsPcm(o) {
  const cfg = o && o.config;
  if (!cfg || !cfg.apiKey || !cfg.voiceId) {
    throw elError('error', 'ElevenLabs is not configured for this request.');
  }
  const text = String(o.text || '').trim();
  if (!text) throw elError('error', 'No text to send to ElevenLabs.');

  const { format, sampleRate } = elevenLabsOutputFormat(o.sampleRate);
  const url = `${elevenLabsBaseUrl()}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}`
    + `?output_format=${format}`;

  const body = { text, model_id: cfg.modelId || ELEVENLABS_DEFAULT_MODEL };
  // Documented continuity mechanism for concatenated generations. Bounded so a
  // long reply does not resend most of itself with every phrase.
  const prev = String(o.previousText || '').trim();
  const next = String(o.nextText || '').trim();
  if (prev) body.previous_text = prev.slice(-CONTEXT_CHARS);
  if (next) body.next_text = next.slice(0, CONTEXT_CHARS);
  // W7 rev 2.1 section 8: G1 (no channel scaffolding), G3 (prosody cues only
  // with the tag switch on, and then only in their registered spelling) and G4
  // (the classification count logged) on every field the model reads. A
  // context field is read for prosody, so a cue there shapes the delivery even
  // though it is not spoken. Text from the formatter cannot trip G1 or G3; a
  // caller that bypasses it is refused with reason 'error', which falls the
  // reply back to Kokoro and is recorded by the gateway like any other
  // ElevenLabs error.
  const tags = true === cfg.tags;
  guardRequest(body.text, { builder: 'elevenlabs', tags, where: 'elevenlabs text' });
  if (body.previous_text) {
    guardRequest(body.previous_text, { builder: 'elevenlabs', tags, where: 'elevenlabs previous_text' });
  }
  if (body.next_text) {
    guardRequest(body.next_text, { builder: 'elevenlabs', tags, where: 'elevenlabs next_text' });
  }
  const observe = 'function' === typeof o.observe ? o.observe : null;

  const doFetch = 'function' === typeof o.fetchImpl ? o.fetchImpl : fetch;
  const payload = JSON.stringify(body);
  // An absolute deadline for this piece, when the caller has a reply budget.
  const deadlineAt = Number.isFinite(o.deadlineAt) ? o.deadlineAt : Infinity;

  // One retry on 5xx (Section 5.5). Nothing else is retried: 401 and 402/429
  // will not change in the next second, and a timeout already spent its budget.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw elError('error', 'ElevenLabs ran out of time for this reply.');
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': cfg.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/octet-stream',
        },
        body: payload,
        signal: AbortSignal.timeout(Math.max(1, Math.min(elevenLabsTimeoutMs(), remaining))),
      });
    } catch (err) {
      const timedOut = err && ('TimeoutError' === err.name || 'AbortError' === err.name);
      throw elError('error', timedOut ? 'ElevenLabs did not answer in time.'
        : 'ElevenLabs could not be reached.');
    }

    if (res.ok) {
      if (observe) observe({ attempt, status: res.status, ok: true, code: '', headers: headersOfInterest(res) });
      const pcm = Buffer.from(await res.arrayBuffer());
      if (!pcm.length) throw elError('error', 'ElevenLabs returned no audio.', res.status);
      // 16-bit samples come in pairs of bytes. An odd count would shift every
      // sample after it and play as noise, so the stray byte is a fault.
      if (0 !== pcm.length % 2) {
        throw elError('error', 'ElevenLabs returned an odd byte count for 16-bit PCM.', res.status);
      }
      return { pcm, sampleRate };
    }

    const code = await errorCode(res);
    if (observe) observe({ attempt, status: res.status, ok: false, code, headers: headersOfInterest(res) });
    if (res.status >= 500 && attempt < 2) continue;
    const reason = reasonForStatus(res.status, code);
    throw elError(reason, `ElevenLabs answered ${res.status}${code ? ` (${code})` : ''}.`, res.status);
  }
  // Unreachable: the loop either returns or throws on its second pass.
  throw elError('error', 'ElevenLabs request did not complete.');
}

/**
 * Pick the more severe of two reasons. invalid_key outranks quota outranks
 * error, because invalid_key is the one the gateway must act on (it disables the
 * switch) and reporting a lesser reason would leave a dead key enabled.
 *
 * @param {string|null} a
 * @param {string|null} b
 * @returns {string|null}
 */
export function severerReason(a, b) {
  const rank = { invalid_key: 3, quota: 2, error: 1 };
  if (!a) return b || null;
  if (!b) return a;
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

export default {
  ELEVENLABS_DEFAULT_MODEL, elevenLabsBaseUrl, elevenLabsTimeoutMs,
  elevenLabsConcurrency, elevenLabsSegmentChars, elevenLabsReplyBudgetMs, elevenLabsSegmentUnit,
  parseElevenLabsConfig,
  elevenLabsOutputFormat, stripMisakiMarkup, reasonForStatus, headersOfInterest,
  synthesizeElevenLabsPcm, severerReason,
};
