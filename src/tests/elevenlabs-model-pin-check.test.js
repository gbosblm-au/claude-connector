// src/tests/elevenlabs-model-pin-check.test.js
//
// SPEC-AUDIO-004 falsifier T6: "The pin check fails (non-zero) when a pinned id
// is missing from GET /v1/models." Connector v13.35.0.
//
// scripts/elevenlabs-model-pin-check.mjs is run as an operator would run it, as
// a child process, against a local fake of the two ElevenLabs endpoints it
// calls (GET /v1/models, POST /v1/speech-to-text), reached through
// ELEVENLABS_API_BASE. Each case scripts what the account lists and what the
// transcription endpoint answers, and asserts the exit code and the verdicts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'elevenlabs-model-pin-check.mjs');
const KEY = 'sk_pin_PINSECRET_9a7c5e3b1d';

const TTS_LIST = [
  { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true,
    can_do_voice_conversion: false },
  { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true },
];

const fake = { models: TTS_LIST, modelsStatus: 200, sttStatus: 200, sttBody: null, calls: [] };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const call = { method: req.method, path: req.url, key: req.headers['xi-api-key'], model: null };
    if ('/v1/speech-to-text' === req.url) {
      try {
        const form = await new Response(Buffer.concat(chunks),
          { headers: { 'content-type': req.headers['content-type'] || '' } }).formData();
        call.model = form.get('model_id');
        const file = form.get('file');
        call.fileBytes = file ? (await file.arrayBuffer()).byteLength : 0;
      } catch (err) { call.parseError = err.message; }
    }
    fake.calls.push(call);
    if ('GET' === req.method && '/v1/models' === req.url) {
      res.writeHead(fake.modelsStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(200 === fake.modelsStatus ? fake.models
        : { detail: { code: 401 === fake.modelsStatus ? 'invalid_api_key' : 'some_error' } }));
      return;
    }
    if ('POST' === req.method && '/v1/speech-to-text' === req.url) {
      res.writeHead(fake.sttStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fake.sttBody || (200 === fake.sttStatus
        ? { text: '', language_code: 'en' } : { detail: { code: 'invalid_model_id' } })));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

function reset(over) {
  Object.assign(fake, { models: TTS_LIST, modelsStatus: 200, sttStatus: 200, sttBody: null }, over || {});
  fake.calls.length = 0;
}

function run(argv, envOver) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELEVENLABS_API_BASE: `http://127.0.0.1:${server.address().port}`,
                  ELEVENLABS_API_KEY: KEY, ...(envOver || {}) };
    delete env.ELEVENLABS_DEFAULT_MODEL;
    delete env.ELEVENLABS_STT_MODEL;
    for (const [k, v] of Object.entries(envOver || {})) env[k] = v;
    const child = spawn(process.execPath, [SCRIPT, '--json', ...argv], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(out); } catch (e) { /* asserted by the caller */ }
      resolve({ code, out, err, report });
    });
  });
}

test('T6: both pins present: exit 0; TTS from the list, STT by probe with the pinned id', async () => {
  reset();
  const r = await run([]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.report.tts.model_id, 'eleven_multilingual_v2');
  assert.equal(r.report.tts.verdict, 'ok');
  assert.equal(r.report.stt.model_id, 'scribe_v2');
  assert.equal(r.report.stt.verdict, 'ok');
  assert.equal(r.report.stt.method, 'probe');
  const probe = fake.calls.find((c) => '/v1/speech-to-text' === c.path);
  assert.equal(probe.model, 'scribe_v2');
  assert.ok(probe.fileBytes >= 44 + 1600 * 2, 'at least 100 ms of audio (Section 4 minimum)');
  assert.ok(fake.calls.every((c) => c.key === KEY), 'the key travels in xi-api-key');
  assert.match(r.report.checked_at, /^\d{4}-\d{2}-\d{2}T/u, 'dated, for the changelog');
});

test('T6: a pinned TTS id missing from GET /v1/models fails non-zero and names what is listed', async () => {
  reset({ models: TTS_LIST.filter((m) => 'eleven_multilingual_v2' !== m.model_id) });
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.equal(r.report.tts.verdict, 'fail');
  assert.match(r.report.tts.detail, /not in the account's model list; listed: eleven_flash_v2_5/u);
});

test('T6: a TTS id listed without can_do_text_to_speech fails', async () => {
  reset({ models: [{ model_id: 'eleven_multilingual_v2', can_do_text_to_speech: false }] });
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.report.tts.detail, /can_do_text_to_speech is not true/u);
});

test('T6: an STT id the endpoint rejects fails non-zero, with the status and code', async () => {
  reset({ sttStatus: 422 });
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.equal(r.report.stt.verdict, 'fail');
  assert.match(r.report.stt.detail, /HTTP 422 invalid_model_id/u);
  assert.equal(r.report.tts.verdict, 'ok', 'the TTS verdict is independent');
});

test('T6: an STT id the list does carry is settled by the list, with no probe', async () => {
  reset({ models: [...TTS_LIST, { model_id: 'scribe_v2', name: 'Scribe v2' }] });
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.equal(r.report.stt.method, 'list');
  assert.ok(!fake.calls.some((c) => '/v1/speech-to-text' === c.path), 'nothing was transcribed');
});

test('cannot verify is exit 2, not 0: probe skipped, key refused, quota, no key', async () => {
  reset();
  const skipped = await run(['--no-stt-probe']);
  assert.equal(skipped.code, 2);
  assert.equal(skipped.report.stt.verdict, 'unverified');
  assert.ok(!fake.calls.some((c) => '/v1/speech-to-text' === c.path));

  reset({ modelsStatus: 401, sttStatus: 401 });
  const refused = await run([]);
  assert.equal(refused.code, 2);
  assert.match(refused.report.tts.detail, /key refused: HTTP 401/u);
  assert.match(refused.report.stt.detail, /key refused: HTTP 401/u);

  reset({ sttStatus: 429 });
  const quota = await run([]);
  assert.equal(quota.code, 2);
  assert.match(quota.report.stt.detail, /quota or rate limit/u);

  reset();
  const nokey = await run([], { ELEVENLABS_API_KEY: '' });
  assert.equal(nokey.code, 2);
  assert.equal(fake.calls.length, 0, 'nothing is called without a key');
});

test('pins come from flags, then the environment, then the connector defaults', async () => {
  reset({ models: [...TTS_LIST, { model_id: 'eleven_v3', can_do_text_to_speech: true }] });
  const flagged = await run(['--tts-model', 'eleven_v3', '--stt-model', 'scribe_v3']);
  assert.equal(flagged.report.tts.model_id, 'eleven_v3');
  assert.equal(flagged.report.stt.model_id, 'scribe_v3');
  assert.equal(fake.calls.find((c) => '/v1/speech-to-text' === c.path).model, 'scribe_v3');

  reset();
  const envd = await run([], { ELEVENLABS_DEFAULT_MODEL: 'eleven_flash_v2_5', ELEVENLABS_STT_MODEL: 'scribe_v2' });
  assert.equal(envd.report.tts.model_id, 'eleven_flash_v2_5');
  assert.equal(envd.code, 0);

  reset();
  const bad = await run(['--tts-model', 'Bad Model;']);
  assert.equal(bad.code, 1);
  assert.match(bad.report.tts.detail, /not a model id/u);
});

test('the key is never printed, in either output format', async () => {
  reset({ modelsStatus: 401, sttStatus: 401 });
  const a = await run([]);
  assert.ok(!a.out.includes(KEY) && !a.err.includes(KEY));
  const plain = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env,
      ELEVENLABS_API_BASE: `http://127.0.0.1:${server.address().port}`, ELEVENLABS_API_KEY: KEY } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  assert.match(plain.out, /ElevenLabs model pin check/u);
  assert.ok(!plain.out.includes(KEY));
});
