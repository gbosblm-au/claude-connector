// src/tests/voice-elevenlabs-race.test.js
//
// SPEC-AUDIO-003 Section 5.3, the "voice changes at most once" rule, under a
// WIDER phrase pool than voice-elevenlabs.test.js runs. Connector v13.34.0.
//
// VOICE_TTS_PHRASE_CONCURRENCY is read once at import, so a second width needs
// its own process, which is why this is its own file. With four runners an
// earlier phrase can fail while a later one is between finishing on ElevenLabs
// and being parked; the later phrase then has to notice on its own that it now
// belongs to Kokoro. Found in the independent review of this release.
//
// Same fakes as voice-elevenlabs.test.js: ElevenLabs is a local HTTP server
// returning a flat level of 3000, Kokoro is fixtures/fake-kokoro-once.mjs
// returning a tone, and the engine of each phrase is read from its audio.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'tenax-el-race-'));
const TEST_USER = 'voice-elevenlabs-race-user';
const TEST_KEY = 'test-key-for-voice-elevenlabs-race';
const EL_LEVEL = 3000;

const WRAPPER = join(WORK, 'fake-python');
writeFileSync(WRAPPER, `#!/bin/sh\nFAKE_KOKORO_LOG="${join(WORK, 'engine.log')}" exec "${process.execPath}" `
  + `"${join(HERE, 'fixtures', 'fake-kokoro-once.mjs')}" "$@"\n`);
chmodSync(WRAPPER, 0o755);

let script = () => null;
const elServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (err) { body = {}; }
    const outcome = script(String(body.text || '')) || {};
    if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
    if (outcome.status) {
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: { code: 'rate_limit_exceeded' } }));
      return;
    }
    const letters = String(body.text || '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const samples = Math.max(1, Math.round((letters / 15) * 24000));
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
  VOICE_TTS_PHRASE_CONCURRENCY: '4',
  VOICE_PROSODY_ENABLED: 'true',
  VOICE_RATE_MAX: '1000',
  ELEVENLABS_API_BASE: `http://127.0.0.1:${elServer.address().port}`,
  ELEVENLABS_TIMEOUT_MS: '5000',
});

const express = (await import('express')).default;
const { registerVoiceRoutes } = await import('../routes/voice.js');
const app = express();
registerVoiceRoutes(app);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  elServer.close();
  rmSync(WORK, { recursive: true, force: true });
});

function engineOf(pcm) {
  if (pcm.length < 200) return 'empty';
  const mid = Math.floor(pcm.length / 4) * 2;
  for (let i = mid; i < mid + 100; i += 2) {
    if (EL_LEVEL !== pcm.readInt16LE(i)) return 'kokoro';
  }
  return 'elevenlabs';
}

const REPLY = 'Alpha one is the opening sentence here. Bravo two follows with more words now. '
  + 'Charlie three is the one that fails. Delta four finishes quickly on time. '
  + 'Echo five closes it out. Foxtrot six ends.';

/**
 * Timings that put a later phrase between "finished on ElevenLabs" and
 * "parked" when an earlier phrase fails. Several spacings are tried, because
 * which one opens the window depends on how long the fake Kokoro takes.
 */
const SCENARIOS = [
  { alpha: 400, bravo: 270, charlie: 250 },
  { alpha: 330, bravo: 270, charlie: 250 },
  { alpha: 300, bravo: 200, charlie: 150 },
  { alpha: 450, bravo: 300, charlie: 200 },
];

for (const s of SCENARIOS) {
  test(`four runners: the voice changes once and never back (${JSON.stringify(s)})`, async () => {
    script = (text) => {
      if (text.includes('Alpha')) return { status: 429, delayMs: s.alpha };
      if (text.includes('Bravo')) return { delayMs: s.bravo };
      if (text.includes('Charlie')) return { status: 429, delayMs: s.charlie };
      return null;
    };
    const res = await fetch(`${BASE}/voice/synthesize/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Railway-Restore-Token': TEST_KEY,
        Authorization: `Bearer ${TEST_KEY}`, 'X-Tenax-User-Id': TEST_USER, 'X-Tenax-Voice-Entitlement': 'entitled',
      },
      body: JSON.stringify({ text: REPLY, voice: 'af_heart',
                             elevenlabs: { api_key: 'sk_race_000000000000', voice_id: 'RaceVoice1' } }),
    });
    const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const engines = lines.filter((l) => 'phrase' === l.type)
      .map((l) => engineOf(Buffer.from(l.audio_base64, 'base64'))).filter((e) => 'empty' !== e);
    const firstKokoro = engines.indexOf('kokoro');
    assert.ok(firstKokoro >= 0, engines.join(','));
    assert.ok(engines.slice(firstKokoro).every((e) => 'kokoro' === e),
      `the voice switched back: ${engines.join(',')}`);
    assert.equal(lines[lines.length - 1].type, 'end');
  });
}
