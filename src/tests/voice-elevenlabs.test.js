// src/tests/voice-elevenlabs.test.js
//
// SPEC-AUDIO-003 W3 -- the per-user ElevenLabs engine in the connector.
// Connector v13.34.0. Falsifiers E1, E4, E5, E6 at unit level, and E8 for the
// connector's half of "a user with nothing configured sees no change".
//
// ===========================================================================
// NO REAL KEY, NO REAL MODEL
// ===========================================================================
//
// ElevenLabs is a local HTTP server that speaks the documented contract
// (POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000, xi-api-key,
// JSON body; 401/402/429/5xx error shapes from the API errors page). The
// adapter reaches it through ELEVENLABS_API_BASE, the same variable an
// operator would never set in production.
//
// Kokoro is fixtures/fake-kokoro-once.mjs behind the real one-shot supervisor,
// as in voice-segmenting.test.js.
//
// The two engines are told apart in the OUTPUT AUDIO: the fake ElevenLabs
// returns a constant level of 3000, the fake Kokoro a 220 Hz tone peaking at
// 8000. So "which engine spoke phrase N" is read from the bytes the client
// would play, not from metadata the route reports about itself.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'tenax-el-test-'));
const ENGINE_LOG = join(WORK, 'engine.log');
const TEST_USER = 'voice-elevenlabs-test-user';
const TEST_KEY = 'test-key-for-voice-elevenlabs';
/** The user's ElevenLabs key. Distinctive, so a leak anywhere is findable. */
const EL_KEY = 'sk_el_SECRET_7f3a9c1e5b2d8f4a6c0e9b7d';
const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2';
const EL_LEVEL = 3000;

const WRAPPER = join(WORK, 'fake-python');
writeFileSync(WRAPPER, `#!/bin/sh\nFAKE_KOKORO_LOG="${ENGINE_LOG}" exec "${process.execPath}" `
  + `"${join(HERE, 'fixtures', 'fake-kokoro-once.mjs')}" "$@"\n`);
chmodSync(WRAPPER, 0o755);

// ---------------------------------------------------------------------------
// Capture everything the process prints, for E1.
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
// The fake ElevenLabs service.
// ---------------------------------------------------------------------------
const el = {
  calls: [],
  /** (call) => {status, body?, delayMs?} | null for success. */
  script: () => null,
};

const elServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    let body = {};
    try { body = JSON.parse(raw); } catch (err) { /* recorded as empty */ }
    const call = {
      method: req.method, path: url.pathname, format: url.searchParams.get('output_format'),
      key: req.headers['xi-api-key'], body, n: el.calls.length,
    };
    el.calls.push(call);

    const outcome = el.script(call) || {};
    if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
    if (outcome.status && outcome.status !== 200) {
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcome.body || { detail: { type: 'x', code: 'some_error', message: 'nope' } }));
      return;
    }
    const m = /^\/v1\/text-to-speech\/([^/]+)$/u.exec(url.pathname);
    if ('POST' !== req.method || !m) { res.writeHead(404); res.end(); return; }
    const rate = Number(String(call.format || '').replace('pcm_', '')) || 24000;
    const letters = String(body.text || '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const samples = Math.max(1, Math.round((letters / 15) * rate));
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(EL_LEVEL, i * 2);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(pcm);
  });
});
await new Promise((r) => elServer.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  VOICE_ENABLED: 'true',
  MCP_API_KEY: TEST_KEY,
  VOICE_KOKORO_PYTHON: WRAPPER,
  VOICE_TTS_WORKER_ENABLED: 'false',
  VOICE_TTS_PREWARM: 'false',
  VOICE_STT_WORKER_ENABLED: 'false',
  VOICE_TTS_SAMPLE_RATE: '24000',
  VOICE_TTS_PHRASE_CONCURRENCY: '2',
  VOICE_INCREMENTAL_RATE_MAX: '1000',
  VOICE_RATE_MAX: '1000',
  ELEVENLABS_API_BASE: `http://127.0.0.1:${elServer.address().port}`,
  ELEVENLABS_TIMEOUT_MS: '5000',
});
delete process.env.VOICE_PROSODY_ENABLED;

const adapter = await import('../voice/elevenlabs.js');
const express = (await import('express')).default;
const { registerVoiceRoutes } = await import('../routes/voice.js');

const app = express();
registerVoiceRoutes(app);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** Everything a client received, for E1. */
const received = [];

after(() => {
  server.close();
  elServer.close();
  rmSync(WORK, { recursive: true, force: true });
});

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Railway-Restore-Token': TEST_KEY,
  Authorization: `Bearer ${TEST_KEY}`,
  'X-Tenax-User-Id': TEST_USER, 'X-Tenax-Voice-Entitlement': 'entitled',
};

const CONFIG = { api_key: EL_KEY, voice_id: VOICE_ID, model_id: 'eleven_multilingual_v2' };

function engineCalls() {
  if (!existsSync(ENGINE_LOG)) return [];
  return readFileSync(ENGINE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
}
function reset(script) {
  writeFileSync(ENGINE_LOG, '');
  el.calls.length = 0;
  el.script = script || (() => null);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries(res.headers.entries());
  received.push(JSON.stringify(headers), buf.toString('latin1'));
  return { status: res.status, headers, buf };
}

function lines(buf) {
  return buf.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Which fake produced this PCM: ElevenLabs is a flat 3000, Kokoro a tone. */
function engineOf(pcm) {
  if (pcm.length < 200) return 'empty';
  const mid = Math.floor(pcm.length / 4) * 2;
  let flat = true;
  for (let i = mid; i < mid + 100; i += 2) {
    if (EL_LEVEL !== pcm.readInt16LE(i)) { flat = false; break; }
  }
  return flat ? 'elevenlabs' : 'kokoro';
}

const REPLY = 'The first sentence is short. The second one carries a little more weight, '
  + 'and it pauses here. The third sentence ends the paragraph.\n\n'
  + 'A new paragraph begins. It has two sentences of its own.';

// ===========================================================================
// The adapter
// ===========================================================================

test('the configuration is validated before any network call', () => {
  assert.equal(adapter.parseElevenLabsConfig(undefined), null, 'absent means not configured');
  assert.equal(adapter.parseElevenLabsConfig(null), null);
  // v13.36.0 (W7 rev 2.1 sections 5.1, 5.2): the configuration also carries
  // who supplied the model id and the tag switch, off unless sent as true.
  assert.deepEqual(adapter.parseElevenLabsConfig(CONFIG),
    { ok: true, config: { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2',
                          modelSource: 'request', tags: false } });
  assert.equal(adapter.parseElevenLabsConfig({ ...CONFIG, model_id: undefined }).config.modelId,
    adapter.ELEVENLABS_DEFAULT_MODEL, 'a missing model takes the platform default');
  assert.equal(adapter.parseElevenLabsConfig({ ...CONFIG, voice_id: '../admin' }).ok, false);
  assert.equal(adapter.parseElevenLabsConfig({ ...CONFIG, api_key: 'has space in it' }).ok, false);
  assert.equal(adapter.parseElevenLabsConfig({ ...CONFIG, api_key: 'a\r\nX-Evil: 1' }).ok, false);
  assert.equal(adapter.parseElevenLabsConfig('string').ok, false);
});

test('error mapping: 401 is invalid_key, 402 and 429 are quota, everything else is error', () => {
  assert.equal(adapter.reasonForStatus(401, 'invalid_api_key'), 'invalid_key');
  assert.equal(adapter.reasonForStatus(401, 'quota_exceeded'), 'quota',
    'a legacy 401 that names quota is not treated as a dead key');
  assert.equal(adapter.reasonForStatus(402, 'insufficient_credits'), 'quota');
  assert.equal(adapter.reasonForStatus(429, 'rate_limit_exceeded'), 'quota');
  assert.equal(adapter.reasonForStatus(404, 'voice_not_found'), 'error');
  assert.equal(adapter.reasonForStatus(500, ''), 'error');
  assert.equal(adapter.severerReason('error', 'invalid_key'), 'invalid_key');
  assert.equal(adapter.severerReason('quota', 'error'), 'quota');
});

test('one request: documented endpoint, key in the header only, continuity text sent', async () => {
  reset();
  const out = await adapter.synthesizeElevenLabsPcm({
    config: { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2' },
    text: 'Hello from the user voice.', previousText: 'Before.', nextText: 'After.', sampleRate: 24000,
  });
  assert.equal(out.sampleRate, 24000);
  assert.ok(out.pcm.length > 0 && 0 === out.pcm.length % 2);
  const call = el.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, `/v1/text-to-speech/${VOICE_ID}`);
  assert.equal(call.format, 'pcm_24000');
  assert.equal(call.key, EL_KEY);
  assert.deepEqual(call.body, { text: 'Hello from the user voice.', model_id: 'eleven_multilingual_v2',
                                previous_text: 'Before.', next_text: 'After.' });
  assert.ok(!JSON.stringify(call.body).includes(EL_KEY), 'the key is never in the body');

  reset();
  await adapter.synthesizeElevenLabsPcm({
    config: { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2' },
    text: 'At sixteen kilohertz.', sampleRate: 16000,
  });
  assert.equal(el.calls[0].format, 'pcm_16000', 'the tenant output rate is requested natively');
});

test('one retry on 5xx, none on 4xx', async () => {
  const cfg = { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2' };
  reset((call) => (0 === call.n ? { status: 503 } : null));
  await adapter.synthesizeElevenLabsPcm({ config: cfg, text: 'Retry me once.', sampleRate: 24000 });
  assert.equal(el.calls.length, 2, 'a 5xx is retried once and the retry succeeds');

  reset(() => ({ status: 500 }));
  await assert.rejects(adapter.synthesizeElevenLabsPcm({ config: cfg, text: 'Fails twice.', sampleRate: 24000 }),
    (err) => 'el_error' === err.code && 'error' === err.reason);
  assert.equal(el.calls.length, 2, 'and not retried a second time');

  reset(() => ({ status: 401, body: { detail: { type: 'authentication_error', code: 'invalid_api_key' } } }));
  await assert.rejects(adapter.synthesizeElevenLabsPcm({ config: cfg, text: 'Dead key.', sampleRate: 24000 }),
    (err) => 'el_invalid_key' === err.code && /401 \(invalid_api_key\)/u.test(err.message)
      && !err.message.includes(EL_KEY));
  assert.equal(el.calls.length, 1, 'a 401 is not retried');
});

// ===========================================================================
// The routes -- E4, E5, E6, E8
// ===========================================================================

test('E4: switch on, /voice/synthesize speaks in the user voice and never calls Kokoro', async () => {
  reset();
  const r = await post('/voice/synthesize', { text: REPLY, voice: 'af_heart', elevenlabs: CONFIG });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'audio/wav');
  assert.equal(r.headers['x-tenax-voice-engine'], 'elevenlabs');
  assert.equal(r.headers['x-tenax-voice-fallback'], undefined);
  assert.ok(el.calls.length >= 1);
  for (const call of el.calls) {
    assert.equal(call.path, `/v1/text-to-speech/${VOICE_ID}`, 'the selected voice is the one rendered');
    assert.equal(call.key, EL_KEY);
  }
  assert.equal(engineCalls().length, 0, 'Kokoro is off for this user');
  assert.equal(engineOf(r.buf.subarray(44)), 'elevenlabs');
});

test('E4/E8: switch off, the same request is Kokoro with zero ElevenLabs calls and baseline headers', async () => {
  reset();
  const r = await post('/voice/synthesize', { text: REPLY, voice: 'af_heart' });
  assert.equal(r.status, 200);
  assert.equal(el.calls.length, 0, 'no ElevenLabs call for a user without it');
  assert.ok(engineCalls().length >= 1, 'Kokoro rendered it');
  assert.equal(r.headers['x-tenax-voice-engine'], undefined, 'no new header (E8)');
  assert.equal(r.headers['x-tenax-voice-fallback'], undefined);
  assert.equal(engineOf(r.buf.subarray(44)), 'kokoro');
});

test('E5: a key that fails later (401) falls the WHOLE reply back to Kokoro and names invalid_key', async () => {
  reset(() => ({ status: 401, body: { detail: { type: 'authentication_error', code: 'invalid_api_key' } } }));
  const r = await post('/voice/synthesize', { text: REPLY, voice: 'af_heart', elevenlabs: CONFIG });
  assert.equal(r.status, 200, 'the reply is still spoken: silence is never the failure mode');
  assert.equal(r.headers['x-tenax-voice-engine'], 'kokoro');
  assert.equal(r.headers['x-tenax-voice-fallback'], 'invalid_key');
  assert.equal(engineOf(r.buf.subarray(44)), 'kokoro', 'one voice throughout');
});

test('E6: quota (429 or 402) falls back and is surfaced as quota', async () => {
  for (const status of [429, 402]) {
    reset(() => ({ status }));
    const r = await post('/voice/synthesize', { text: REPLY, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-tenax-voice-fallback'], 'quota', `status ${status}`);
  }
});

test('a slow ElevenLabs cannot use up the time the Kokoro fallback needs (reply budget)', async () => {
  // Without a budget: 503 at 3 s, retried, 503 again at 6 s, THEN Kokoro. With
  // the minimum budget of 5 s the retry is cut off at 5 s.
  process.env.ELEVENLABS_BUDGET_MS_PER_5000 = '5000';
  try {
    reset(() => ({ status: 503, delayMs: 3000 }));
    const started = Date.now();
    const r = await post('/voice/synthesize', { text: 'One short sentence.', voice: 'af_heart', elevenlabs: CONFIG });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-tenax-voice-fallback'], 'error');
    assert.equal(engineOf(r.buf.subarray(44)), 'kokoro');
    assert.ok(elapsed < 5800, `the ElevenLabs attempt stopped at its budget (${elapsed} ms)`);
  } finally {
    delete process.env.ELEVENLABS_BUDGET_MS_PER_5000;
  }
});

test('a malformed configuration from the gateway is spoken by Kokoro and reported', async () => {
  reset();
  const r = await post('/voice/synthesize', { text: REPLY, voice: 'af_heart',
                                              elevenlabs: { api_key: 'short', voice_id: VOICE_ID } });
  assert.equal(r.status, 200);
  assert.equal(el.calls.length, 0);
  assert.equal(r.headers['x-tenax-voice-fallback'], 'error');
});

test('streamed: ElevenLabs phrases, then ONE switch to Kokoro at the first failure, never back', async () => {
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    // The third sentence fails slowly while the fourth succeeds quickly, so
    // the fourth finishes on ElevenLabs FIRST and must be re-rendered by Kokoro
    // before it is emitted, or the voice would switch back.
    reset((call) => (String(call.body.text).includes('third sentence')
      ? { status: 401, delayMs: 250, body: { detail: { code: 'invalid_api_key' } } } : null));
    const r = await post('/voice/synthesize/stream', { text: REPLY, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    const out = lines(r.buf);
    const phrases = out.filter((l) => 'phrase' === l.type);
    const engines = phrases.map((p) => engineOf(Buffer.from(p.audio_base64, 'base64')))
      .filter((e) => 'empty' !== e);
    const firstKokoro = engines.indexOf('kokoro');
    assert.ok(firstKokoro > 0, `ElevenLabs spoke first: ${engines.join(',')}`);
    assert.ok(engines.slice(firstKokoro).every((e) => 'kokoro' === e),
      `the voice changed once and never back: ${engines.join(',')}`);

    const notice = out.findIndex((l) => 'engine_fallback' === l.type);
    const firstKokoroLine = out.findIndex((l) => 'phrase' === l.type
      && 'kokoro' === engineOf(Buffer.from(l.audio_base64, 'base64')));
    assert.ok(notice >= 0 && notice < firstKokoroLine, 'the switch is announced before it is heard');
    assert.equal(out[notice].reason, 'invalid_key');
    const end = out[out.length - 1];
    assert.equal(end.type, 'end');
    assert.equal(end.engine, 'kokoro');
    assert.equal(end.engine_fallback, 'invalid_key');
    assert.equal(phrases.length, end.phrases, 'no phrase was lost to the switch');
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

test('streamed: a phrase still IN FLIGHT when an earlier one fails is not emitted in the old voice', async () => {
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    // The mirror of the test above: the third sentence fails at once while the
    // fourth is still rendering, and the fourth then SUCCEEDS on ElevenLabs.
    // It completes after the switch, so it must be discarded and re-rendered.
    reset((call) => {
      const text = String(call.body.text);
      if (text.includes('third sentence')) return { status: 401, body: { detail: { code: 'invalid_api_key' } } };
      if (text.includes('new paragraph')) return { delayMs: 300 };
      return null;
    });
    const r = await post('/voice/synthesize/stream', { text: REPLY, voice: 'af_heart', elevenlabs: CONFIG });
    const engines = lines(r.buf).filter((l) => 'phrase' === l.type)
      .map((p) => engineOf(Buffer.from(p.audio_base64, 'base64'))).filter((e) => 'empty' !== e);
    const firstKokoro = engines.indexOf('kokoro');
    assert.ok(firstKokoro > 0, engines.join(','));
    assert.ok(engines.slice(firstKokoro).every((e) => 'kokoro' === e),
      `the voice changed once and never back: ${engines.join(',')}`);
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

test('streamed without ElevenLabs: no engine fields, no fallback lines (E8)', async () => {
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    reset();
    const r = await post('/voice/synthesize/stream', { text: REPLY, voice: 'af_heart' });
    const out = lines(r.buf);
    assert.equal(el.calls.length, 0);
    assert.equal(out.filter((l) => 'engine_fallback' === l.type).length, 0);
    const end = out[out.length - 1];
    assert.deepEqual(Object.keys(end).sort(), ['bytes', 'phrases', 'type'], 'the baseline end line');
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

test('incremental: each batch is spoken by ElevenLabs and says so on its end line', async () => {
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    reset();
    const r = await post('/voice/synthesize/incremental',
      { text: REPLY, offset: 0, sequence: 0, final: true, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    const out = lines(r.buf);
    const end = out[out.length - 1];
    assert.equal(end.type, 'end');
    assert.equal(end.engine, 'elevenlabs');
    assert.equal(end.engine_fallback, null);
    assert.equal(end.offset, REPLY.length);
    assert.equal(engineCalls().length, 0);
    for (const p of out.filter((l) => 'phrase' === l.type)) {
      const e = engineOf(Buffer.from(p.audio_base64, 'base64'));
      assert.ok('elevenlabs' === e || 'empty' === e);
    }

    reset(() => ({ status: 429 }));
    const q = lines((await post('/voice/synthesize/incremental',
      { text: REPLY, offset: 0, sequence: 0, final: true, voice: 'af_heart', elevenlabs: CONFIG })).buf);
    assert.equal(q[q.length - 1].engine_fallback, 'quota');
    assert.equal(q.filter((l) => 'engine_fallback' === l.type).length, 1);
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

// ===========================================================================
// E1 -- LAST, so it reads what every test above produced
// ===========================================================================

test('E1: the API key appears in no log line, response body, header or error string', () => {
  assert.ok(el.calls.some((c) => c.key === EL_KEY), 'the key DID travel, to ElevenLabs only');
  assert.ok(printed.length > 0, 'output was captured');
  for (const line of printed) {
    assert.ok(!line.includes(EL_KEY), `the key leaked into output: ${line.slice(0, 120)}`);
    assert.ok(!line.includes('SECRET_7f3a'), 'not even a fragment');
  }
  for (const body of received) {
    assert.ok(!body.includes(EL_KEY), 'the key leaked into a response');
  }
});
