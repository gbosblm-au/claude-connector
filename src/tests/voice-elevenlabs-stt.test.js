// src/tests/voice-elevenlabs-stt.test.js
//
// SPEC-AUDIO-004 W6 -- ElevenLabs speech-to-text in the connector, with the
// user's own key forwarded by the gateway. Connector v13.35.0.
// Falsifiers T1 (guard), T2, T3, the connector half of T4, and T5 (guard).
//
// ElevenLabs is a local HTTP server that speaks the documented contract
// (POST /v1/speech-to-text, multipart/form-data, xi-api-key; 401/402/422/429/
// 5xx). The adapter reaches it through ELEVENLABS_API_BASE. Whisper is
// fixtures/fake-whisper-once.mjs behind the real per-request spawn in
// transcribe() (the resident worker is off), so "who transcribed" is read from
// the fixture's call log and from the transcript text, not from what the route
// says about itself.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'tenax-el-stt-test-'));
const WHISPER_LOG = join(WORK, 'whisper.log');
const TEST_USER = 'voice-el-stt-test-user';
const TEST_KEY = 'test-key-for-voice-el-stt';
/** The user's ElevenLabs key. Distinctive, so a leak anywhere is findable. */
const EL_KEY = 'sk_el_STTSECRET_4c2e8a6b0d9f1e3a5c7b';

const WRAPPER = join(WORK, 'fake-python');
writeFileSync(WRAPPER, `#!/bin/sh\nshift\nFAKE_WHISPER_LOG="${WHISPER_LOG}" exec "${process.execPath}" `
  + `"${join(HERE, 'fixtures', 'fake-whisper-once.mjs')}" "$@"\n`);
chmodSync(WRAPPER, 0o755);

// ---------------------------------------------------------------------------
// Capture everything the process prints, for T5.
// ---------------------------------------------------------------------------
const printed = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
    original(...args);
  };
}
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return originalStderr(chunk, ...rest); };
const originalStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return originalStdout(chunk, ...rest); };

// ---------------------------------------------------------------------------
// The fake ElevenLabs speech-to-text service.
// ---------------------------------------------------------------------------
const el = {
  calls: [],
  /** (call) => {status?, body?, raw?, delayMs?} | null for a normal transcript. */
  script: () => null,
};

const elServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const call = { method: req.method, path: url.pathname, query: url.search,
                   key: req.headers['xi-api-key'], contentType: req.headers['content-type'],
                   fields: {}, file: null, n: el.calls.length };
    try {
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] || '' } })
        .formData();
      for (const [name, value] of form.entries()) {
        if ('string' === typeof value) call.fields[name] = value;
        else call.file = { field: name, name: value.name, type: value.type,
                           bytes: Buffer.from(await value.arrayBuffer()) };
      }
    } catch (err) { call.parseError = err.message; }
    el.calls.push(call);

    const outcome = el.script(call) || {};
    if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
    if (undefined !== outcome.raw) {
      res.writeHead(outcome.status || 200, { 'Content-Type': 'application/json' });
      res.end(outcome.raw);
      return;
    }
    if (outcome.status && 200 !== outcome.status) {
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcome.body || { detail: { type: 'x', code: 'some_error', message: 'nope' } }));
      return;
    }
    if ('POST' !== req.method || '/v1/speech-to-text' !== url.pathname) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outcome.body || {
      language_code: 'vi', language_probability: 0.98, text: ' ElevenLabs heard this. ', words: [],
    }));
  });
});
await new Promise((r) => elServer.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  VOICE_ENABLED: 'true',
  VOICE_TEST_USERS: TEST_USER,
  MCP_API_KEY: TEST_KEY,
  VOICE_PYTHON_BIN: WRAPPER,
  VOICE_STT_WORKER_ENABLED: 'false',
  VOICE_TTS_WORKER_ENABLED: 'false',
  VOICE_TTS_PREWARM: 'false',
  VOICE_RATE_MAX: '1000',
  ELEVENLABS_API_BASE: `http://127.0.0.1:${elServer.address().port}`,
});
delete process.env.ELEVENLABS_STT_MODEL;
delete process.env.ELEVENLABS_STT_TIMEOUT_MS;

const stt = await import('../voice/elevenlabs-stt.js');
const express = (await import('express')).default;
const { registerVoiceRoutes } = await import('../routes/voice.js');

const app = express();
registerVoiceRoutes(app);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** Everything a client received, for T5. */
const received = [];

after(() => {
  server.close();
  elServer.close();
  rmSync(WORK, { recursive: true, force: true });
});

function wav(seconds = 1, rate = 16000) {
  const data = Buffer.alloc(Math.round(rate * 2 * seconds));
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE((i * 37) % 2000 - 1000, i);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const AUDIO = wav(1);

function whisperCalls() {
  if (!existsSync(WHISPER_LOG)) return [];
  return readFileSync(WHISPER_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function reset(script, { whisperFails = false } = {}) {
  writeFileSync(WHISPER_LOG, '');
  if (whisperFails) writeFileSync(`${WHISPER_LOG}.fail`, '1');
  else rmSync(`${WHISPER_LOG}.fail`, { force: true });
  el.calls.length = 0;
  el.script = script || (() => null);
}

async function transcribeRoute({ key, query = '', audio = AUDIO, contentType = 'audio/wav' } = {}) {
  const headers = {
    'Content-Type': contentType,
    'X-Railway-Restore-Token': TEST_KEY,
    Authorization: `Bearer ${TEST_KEY}`,
    'X-Tenax-User-Id': TEST_USER,
  };
  if (undefined !== key) headers['X-Tenax-ElevenLabs-Key'] = key;
  const res = await fetch(`${BASE}/voice/transcribe${query}`, { method: 'POST', headers, body: audio });
  const text = await res.text();
  const out = { status: res.status, headers: Object.fromEntries(res.headers.entries()), text };
  received.push(JSON.stringify(out.headers), text);
  try { out.body = JSON.parse(text); } catch (err) { out.body = null; }
  return out;
}

const WHISPER_BODY = {
  text: 'whisper heard this', language: 'en', duration_seconds: 1,
  segments: [{ start: 0, end: 1, text: 'whisper heard this' }],
};

// ===========================================================================
// T1 (guard): no key forwarded, nothing differs
// ===========================================================================

test('T1: without the key header the route is Whisper, with the baseline body and headers', async () => {
  reset();
  const r = await transcribeRoute();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, WHISPER_BODY, 'the Whisper answer, unchanged');
  assert.equal(el.calls.length, 0, 'ElevenLabs is never contacted');
  assert.equal(whisperCalls().length, 1);
  assert.equal(r.headers['x-tenax-stt-engine'], undefined, 'no engine header for a user who is off');
  assert.equal(r.headers['x-tenax-stt-fallback'], undefined);
  assert.ok(!printed.some((l) => /engine=|el_fallback=/u.test(l) && l.includes('[voice] stt ')),
    'and no new log fields');
});

// ===========================================================================
// T2: the key forwarded, ElevenLabs transcribes
// ===========================================================================

test('T2: with the key, the recording goes to /v1/speech-to-text with the key and scribe_v2', async () => {
  reset();
  const r = await transcribeRoute({ key: EL_KEY, query: '?language=vi' });
  assert.equal(r.status, 200);
  assert.equal(el.calls.length, 1);
  const call = el.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/speech-to-text');
  assert.equal(call.query, '', 'nothing in the URL: no key, no enable_logging');
  assert.equal(call.key, EL_KEY, 'the key travels in xi-api-key');
  assert.match(call.contentType, /^multipart\/form-data; boundary=/u);
  assert.equal(call.fields.model_id, 'scribe_v2', 'the pinned model');
  assert.equal(call.fields.tag_audio_events, 'false');
  assert.equal(call.fields.timestamps_granularity, 'none');
  assert.equal(call.fields.language_code, 'vi', 'the caller\'s language hint');
  assert.equal(call.fields.file_format, undefined, 'the default container handling');
  assert.equal(call.fields.enable_logging, undefined);
  assert.ok(call.file, 'a file part');
  assert.equal(call.file.field, 'file');
  assert.equal(call.file.type, 'audio/wav');
  assert.ok(call.file.bytes.equals(AUDIO), 'the exact recording, byte for byte');
  assert.ok(!JSON.stringify(call.fields).includes(EL_KEY), 'the key is in no form field');

  // Normalised to the route's existing shape.
  assert.deepEqual(r.body, { text: 'ElevenLabs heard this.', language: 'vi', duration_seconds: 1, segments: [] });
  assert.deepEqual(Object.keys(r.body), Object.keys(WHISPER_BODY), 'the same four fields, same order');
  assert.equal(whisperCalls().length, 0, 'Whisper did not run');
  assert.equal(r.headers['x-tenax-stt-engine'], 'elevenlabs');
  assert.equal(r.headers['x-tenax-stt-fallback'], undefined);
});

test('T2: no language hint means auto-detect; the reported duration wins over the estimate', async () => {
  reset(() => ({ body: { text: 'Hello.', language_code: 'en', audio_duration_secs: 7.25 } }));
  const r = await transcribeRoute({ key: EL_KEY });
  assert.equal(el.calls[0].fields.language_code, undefined);
  assert.equal(r.body.duration_seconds, 7.25);

  reset(() => ({ body: { text: '', language_code: 'en' } }));
  const silent = await transcribeRoute({ key: EL_KEY });
  assert.equal(silent.status, 200);
  assert.equal(silent.body.text, '', 'an empty transcript is an answer, not a failure');
  assert.equal(silent.headers['x-tenax-stt-engine'], 'elevenlabs');
  assert.equal(whisperCalls().length, 0);
});

test('T2: ELEVENLABS_STT_MODEL changes the pin; a value that is not a model id is not sent', async () => {
  try {
    process.env.ELEVENLABS_STT_MODEL = 'scribe_v3';
    reset();
    await transcribeRoute({ key: EL_KEY });
    assert.equal(el.calls[0].fields.model_id, 'scribe_v3');
    process.env.ELEVENLABS_STT_MODEL = 'scribe v2; drop';
    reset();
    await transcribeRoute({ key: EL_KEY });
    assert.equal(el.calls[0].fields.model_id, stt.ELEVENLABS_STT_DEFAULT_MODEL);
    assert.equal(stt.ELEVENLABS_STT_DEFAULT_MODEL, 'scribe_v2');
  } finally {
    delete process.env.ELEVENLABS_STT_MODEL;
  }
});

// ===========================================================================
// T3: every ElevenLabs failure falls back to Whisper ONCE and is named
// ===========================================================================

test('T3: 5xx, 422, a non-transcript answer and an unreachable service fall back once, named', async () => {
  const cases = [
    ['500', () => ({ status: 500 }), 'error'],
    ['503', () => ({ status: 503 }), 'error'],
    ['422', () => ({ status: 422, body: { detail: [{ msg: 'bad file' }] } }), 'error'],
    ['not JSON', () => ({ raw: '<html>oops</html>' }), 'error'],
    ['no text', () => ({ body: { language_code: 'en' } }), 'error'],
  ];
  for (const [label, script, reason] of cases) {
    reset(script);
    const r = await transcribeRoute({ key: EL_KEY });
    assert.equal(r.status, 200, label);
    assert.deepEqual(r.body, WHISPER_BODY, `${label}: Whisper's transcript`);
    assert.equal(el.calls.length, 1, `${label}: ElevenLabs tried once, not retried`);
    assert.equal(whisperCalls().length, 1, `${label}: Whisper once`);
    assert.equal(r.headers['x-tenax-stt-engine'], 'whisper', label);
    assert.equal(r.headers['x-tenax-stt-fallback'], reason, label);
  }
  assert.ok(printed.some((l) => l.includes('elevenlabs transcription failed (error 500)')),
    'named in the log');
  assert.ok(printed.some((l) => /\[voice\] stt .*engine=whisper el_fallback=error/u.test(l)),
    'and on the stt log line');

  // Unreachable: a base with nothing listening.
  const prior = process.env.ELEVENLABS_API_BASE;
  try {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    process.env.ELEVENLABS_API_BASE = `http://127.0.0.1:${port}`;
    reset();
    const r = await transcribeRoute({ key: EL_KEY });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, WHISPER_BODY);
    assert.equal(r.headers['x-tenax-stt-fallback'], 'error');
  } finally {
    process.env.ELEVENLABS_API_BASE = prior;
  }
});

test('T3: a malformed key header is a named fallback with no ElevenLabs call', async () => {
  reset();
  const r = await transcribeRoute({ key: 'short' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, WHISPER_BODY);
  assert.equal(el.calls.length, 0);
  assert.equal(r.headers['x-tenax-stt-engine'], 'whisper');
  assert.equal(r.headers['x-tenax-stt-fallback'], 'error');
});

test('T3: a slow ElevenLabs is abandoned at ELEVENLABS_STT_TIMEOUT_MS and Whisper answers', async () => {
  try {
    process.env.ELEVENLABS_STT_TIMEOUT_MS = '5000';
    assert.equal(stt.elevenLabsSttTimeoutMs(), 5000);
    reset(() => ({ delayMs: 6500 }));
    const started = Date.now();
    const r = await transcribeRoute({ key: EL_KEY });
    assert.ok(Date.now() - started < 6400, 'the route did not wait for the slow answer');
    assert.deepEqual(r.body, WHISPER_BODY);
    assert.equal(r.headers['x-tenax-stt-fallback'], 'error');
  } finally {
    delete process.env.ELEVENLABS_STT_TIMEOUT_MS;
  }
});

// ===========================================================================
// T4 (connector half): the reason the gateway acts on
// ===========================================================================

test('T4: 401 is reported as invalid_key; 402 and 429 as quota; Whisper answers each', async () => {
  for (const [status, code, reason] of [
    [401, 'invalid_api_key', 'invalid_key'],
    [402, 'insufficient_credits', 'quota'],
    [429, 'rate_limit_exceeded', 'quota'],
  ]) {
    reset(() => ({ status, body: { detail: { type: 'x', code } } }));
    const r = await transcribeRoute({ key: EL_KEY });
    assert.equal(r.status, 200, String(status));
    assert.deepEqual(r.body, WHISPER_BODY);
    assert.equal(r.headers['x-tenax-stt-engine'], 'whisper');
    assert.equal(r.headers['x-tenax-stt-fallback'], reason, String(status));
  }
});

test('T4: a 401 followed by a Whisper failure still reports invalid_key on the error answer', async () => {
  reset(() => ({ status: 401, body: { detail: { code: 'invalid_api_key' } } }), { whisperFails: true });
  const r = await transcribeRoute({ key: EL_KEY });
  assert.notEqual(r.status, 200);
  assert.equal(r.headers['x-tenax-stt-fallback'], 'invalid_key',
    'the gateway can switch the dead key off even though the request failed');
  assert.ok(printed.some((l) => /\[voice\] stt_error .*el_fallback=invalid_key/u.test(l)));
  reset();
});

// ===========================================================================
// The adapter on its own
// ===========================================================================

test('adapter: the key header is read only in the documented shape', () => {
  assert.equal(stt.elevenLabsSttFrom({ headers: {} }), null, 'absent means not requested');
  assert.deepEqual(stt.elevenLabsSttFrom({ headers: { 'x-tenax-elevenlabs-key': ` ${EL_KEY} ` } }),
    { ok: true, apiKey: EL_KEY });
  assert.equal(stt.elevenLabsSttFrom({ headers: { 'x-tenax-elevenlabs-key': 'has space in it' } }).ok, false);
  assert.equal(stt.elevenLabsSttFrom({ headers: { 'x-tenax-elevenlabs-key': '' } }).ok, false);
  assert.equal(stt.elevenLabsSttFrom({ headers: { 'x-tenax-elevenlabs-key': ['a', 'b'] } }).ok, false);
});

test('adapter: failures carry a reason and a status, never the key', async () => {
  reset(() => ({ status: 401, body: { detail: { code: 'invalid_api_key' } } }));
  await assert.rejects(stt.transcribeElevenLabs({ apiKey: EL_KEY, audio: AUDIO, format: 'wav' }),
    (err) => 'el_invalid_key' === err.code && 'invalid_key' === err.reason && 401 === err.status
      && !err.message.includes(EL_KEY) && !String(err.stack).includes(EL_KEY));
  await assert.rejects(stt.transcribeElevenLabs({ apiKey: EL_KEY, audio: Buffer.alloc(0), format: 'wav' }),
    (err) => 'el_error' === err.code);
  await assert.rejects(stt.transcribeElevenLabs({ apiKey: '', audio: AUDIO, format: 'wav' }),
    (err) => 'el_error' === err.code);
});

// ===========================================================================
// T5 (guard) -- LAST, so it reads what every test above produced
// ===========================================================================

test('T5: the planted key appears in no log line, response body, header or error string', () => {
  assert.ok(el.calls.some((c) => c.key === EL_KEY), 'the key DID travel, to ElevenLabs only');
  assert.ok(printed.length > 0 && received.length > 0, 'output was captured');
  for (const line of printed) assert.ok(!line.includes(EL_KEY), `log line carries the key: ${line.slice(0, 120)}`);
  for (const body of received) assert.ok(!body.includes(EL_KEY), 'a response carries the key');
  // Not even a fragment longer than the last four, which is all settings show.
  const fragment = EL_KEY.slice(4, 16);
  for (const line of [...printed, ...received]) assert.ok(!line.includes(fragment));
});
