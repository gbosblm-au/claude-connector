// src/tests/voice-segmenting.test.js
//
// SPEC-AUDIO-003 W1 -- Kokoro segmenting as a base function, no dropped audio.
// Connector v13.34.0. Falsifiers S1 to S5.
//
// ===========================================================================
// HOW THIS RUNS THE REAL CODE WITHOUT A MODEL
// ===========================================================================
//
// The synthesis path is exercised for real: routes/voice.js, synthesizePcm,
// the segmenter, the duration check, the prosody paths and the one-shot
// supervisor with its protocol parsing. Only the interpreter at the far end is
// replaced, by pointing VOICE_KOKORO_PYTHON at a wrapper around
// fixtures/fake-kokoro-once.mjs. That fake reproduces the one kokoro-onnx 0.4.9
// behaviour this release exists to defeat: a stretch with none of . , ! ? ;
// in it is cut to 510 characters and the call still succeeds.
//
// The fake logs every engine call (FAKE_KOKORO_LOG), so "every phrase is
// present" is asserted against what the engine was actually asked to say, not
// against the route's own account of itself.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'tenax-seg-test-'));
const ENGINE_LOG = join(WORK, 'engine.log');
const TEST_USER = 'voice-segmenting-test-user';
const TEST_KEY = 'test-key-for-voice-segmenting';

// The interpreter the supervisor spawns. A wrapper rather than the .mjs
// itself, so the test does not depend on an archive having kept an exec bit.
const WRAPPER = join(WORK, 'fake-python');
// The supervisor gives its child a minimal environment, so the wrapper sets the
// fake's log path itself.
writeFileSync(WRAPPER, `#!/bin/sh\nFAKE_KOKORO_LOG="${ENGINE_LOG}" exec "${process.execPath}" `
  + `"${join(HERE, 'fixtures', 'fake-kokoro-once.mjs')}" "$@"\n`);
chmodSync(WRAPPER, 0o755);

Object.assign(process.env, {
  VOICE_ENABLED: 'true',
  VOICE_TEST_USERS: TEST_USER,
  MCP_API_KEY: TEST_KEY,
  VOICE_KOKORO_PYTHON: WRAPPER,
  VOICE_TTS_WORKER_ENABLED: 'false',
  VOICE_TTS_PREWARM: 'false',
  VOICE_STT_WORKER_ENABLED: 'false',
  VOICE_TTS_SAMPLE_RATE: '24000',
  VOICE_INCREMENTAL_RATE_MAX: '1000',
  VOICE_RATE_MAX: '1000',
});
delete process.env.VOICE_PROSODY_ENABLED;
delete process.env.VOICE_TTS_SEGMENT_CHARS;
delete process.env.VOICE_TTS_MAX_RUN_CHARS;
delete process.env.VOICE_MAX_TTS_CHARS;

const engines = await import('../voice/voice-engines.js');
const { segmentForSynthesis, assertFullRender, speakableCharCount, synthesizePcm,
        synthesizeProsodyStream } = engines;
const { prepareForKokoro } = await import('../voice/voice-prosody-prep.js');
const { g2pMode } = await import('../voice/kokoro-worker-supervisor.js');

after(() => {
  if (_server) _server.close();
  rmSync(WORK, { recursive: true, force: true });
});

/** Engine calls since the last reset, as the texts the engine received. */
function engineCalls() {
  if (!existsSync(ENGINE_LOG)) return [];
  return readFileSync(ENGINE_LOG, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l).text);
}
function resetEngineLog() { writeFileSync(ENGINE_LOG, ''); }

/** The longest stretch between kokoro-onnx split characters. */
function longestRun(text) {
  return Math.max(0, ...String(text).split(/[.,!?;]/u).map((p) => p.trim().length));
}

/** Non-whitespace characters, in order. */
function squash(text) { return String(text).replace(/\s+/gu, ''); }

/** A run of words with no kokoro split character in it. */
function unpunctuated(words, prefix = 'word') {
  return Array.from({ length: words }, (_, i) => `${prefix}${i}`).join(' ');
}

/** What the engine would be handed for `text` before this release. */
function prepared(text, position = 'whole') {
  return prepareForKokoro(text, { g2p: g2pMode(), emphasis: true, lexicon: {}, position }).text;
}

// ===========================================================================
// LAYER 1 -- the segmenter and the duration check, as pure functions
// ===========================================================================

test('S4: text inside both bounds is returned unchanged, as one piece', () => {
  const samples = [
    'Hello there.',
    'The real cost is not the licence, it is the audit. That one is ours.',
    `${'A sentence of ordinary length, with commas, and a full stop. '.repeat(70)}`.trim(),
  ];
  for (const text of samples) {
    assert.ok(text.length <= 5000);
    assert.deepEqual(segmentForSynthesis(text), [text],
      'an input the baseline rendered correctly keeps its exact single-call shape');
  }
});

test('S1: an unpunctuated stretch is cut so no piece can reach the truncating branch', () => {
  const text = `Intro sentence here. ${unpunctuated(400)}. Closing words.`;
  const pieces = segmentForSynthesis(text);
  assert.ok(pieces.length > 1, 'the long stretch is cut');
  for (const piece of pieces) {
    assert.ok(longestRun(piece) <= 350, `a piece kept a stretch of ${longestRun(piece)}`);
  }
  assert.equal(squash(pieces.join(' ')), squash(text),
    'every non-whitespace character survives, in order');
});

// Found in the independent review of this release: line breaks end an atom
// WITHOUT a Kokoro split character, so packing unpunctuated lines back together
// rebuilt the long run. A markdown bullet list is exactly that shape.
test('S1: a bullet list (unpunctuated lines) is never packed back into one long run', () => {
  const list = Array.from({ length: 20 },
    (_, i) => `- item number ${i} with some words and more words here`).join('\n');
  const pieces = segmentForSynthesis(list);
  for (const piece of pieces) {
    assert.ok(longestRun(piece) <= 350, `a piece rebuilt a run of ${longestRun(piece)}`);
  }
  assert.equal(squash(pieces.join(' ')), squash(list));
});

test('S1: a bullet list renders in full through the real path', async () => {
  resetEngineLog();
  const list = Array.from({ length: 20 },
    (_, i) => `- item number ${i} with some words and more words here`).join('\n');
  const pcm = await synthesizePcm({ text: list, voice: 'af_heart' });
  const calls = engineCalls();
  for (const sent of calls) assert.ok(longestRun(sent) <= 510, 'no call could be truncated');
  const expectedSeconds = calls.reduce((s, t) => s + t.split(/[.,!?;]/u)
    .reduce((a, p) => a + p.trim().length, 0) / 15, 0);
  const seconds = pcm.length / 2 / 24000;
  assert.ok(Math.abs(seconds - expectedSeconds) < 0.01 * calls.length,
    `audio ${seconds.toFixed(2)} s vs ${expectedSeconds.toFixed(2)} s expected`);
  assert.ok(seconds > 40, `the whole list was spoken (${seconds.toFixed(1)} s)`);
});

test('S1: a reply far past the old 5,000-character limit is cut at sentences, losing nothing', () => {
  const sentence = 'This sentence is punctuated normally, so it is safe to render. ';
  const text = sentence.repeat(400).trim();          // ~25,000 characters
  assert.ok(text.length > 20000);
  const pieces = segmentForSynthesis(text);
  assert.ok(pieces.length >= 5);
  for (const piece of pieces) {
    assert.ok(piece.length <= 5000, 'no piece exceeds the segment bound');
    assert.match(piece, /[.!?;]$/u, 'segments end at a sentence boundary');
  }
  assert.equal(squash(pieces.join(' ')), squash(text));
});

test('the segmenter never cuts inside misaki markup', () => {
  const markup = '[Kokoro](/kˈOkəɹO/)';
  const text = `${unpunctuated(70)} ${markup} ${unpunctuated(70, 'more')}`;
  const pieces = segmentForSynthesis(text, { maxRunChars: 100, maxSegmentChars: 5000 });
  assert.ok(pieces.length > 1);
  assert.equal(pieces.filter((p) => p.includes(markup)).length, 1,
    'the markup span lands whole in exactly one piece');
  for (const piece of pieces) {
    const opens = (piece.match(/\[/gu) || []).length;
    const closes = (piece.match(/\)/gu) || []).length;
    assert.equal(opens, closes, `a piece holds half a markup span: ${piece.slice(0, 40)}`);
  }
});

test('pieces cut from one stretch are never packed back together', () => {
  const text = unpunctuated(300);
  const pieces = segmentForSynthesis(text, { maxRunChars: 100, maxSegmentChars: 5000 });
  for (const piece of pieces) assert.ok(piece.length <= 100);
});

test('a single token longer than the bound is cut hard rather than truncated', () => {
  const token = 'x'.repeat(900);
  const pieces = segmentForSynthesis(`Before. ${token} after`, { maxRunChars: 300 });
  for (const piece of pieces) assert.ok(longestRun(piece) <= 300);
  assert.equal(squash(pieces.join('')), squash(`Before. ${token} after`));
});

test('property: random text keeps every character and every bound', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const vocab = ['alpha', 'beta,', 'gamma.', 'delta', '[word](+2)', 'epsilon;', 'zeta\n', 'eta!',
                 'theta', 'iota?', 'kappa', '[Tenax](/tˈɛnæks/)', 'lambda'];
  for (let round = 0; round < 200; round += 1) {
    const n = 20 + Math.floor(rnd() * 600);
    const words = [];
    for (let i = 0; i < n; i += 1) {
      words.push(rnd() < 0.7 ? `w${Math.floor(rnd() * 1000)}` : vocab[Math.floor(rnd() * vocab.length)]);
    }
    const text = words.join(' ');
    const limits = { maxRunChars: 80 + Math.floor(rnd() * 300), maxSegmentChars: 200 + Math.floor(rnd() * 3000) };
    const pieces = segmentForSynthesis(text, limits);
    assert.equal(squash(pieces.join('')), squash(text), `round ${round} lost characters`);
    for (const piece of pieces) {
      // No exemption for pieces holding markup: the first version of this test
      // exempted them, and since most random pieces hold some, it could not see
      // the packing defect the review found.
      assert.ok(longestRun(piece) <= limits.maxRunChars,
        `round ${round}: run ${longestRun(piece)} > ${limits.maxRunChars}`);
    }
  }
});

test('S2: the duration check refuses a short render and names its segment', () => {
  const text = unpunctuated(60);            // ~350 letters
  const letters = speakableCharCount(text);
  const full = Buffer.alloc(Math.round((letters / 15) * 24000) * 2);
  assert.doesNotThrow(() => assertFullRender({ pcm: full, sampleRate: 24000, text, index: 0, total: 1 }));

  const short = Buffer.alloc(24000 * 2);    // one second
  assert.throws(
    () => assertFullRender({ pcm: short, sampleRate: 24000, text, index: 2, total: 5 }),
    (err) => {
      assert.equal(err.code, 'tts_short_render');
      assert.equal(err.segmentIndex, 2);
      assert.match(err.message, /^Segment 3 of 5 rendered 1\.00 s/u);
      assert.ok(!err.message.includes('word1'), 'the message never carries the text');
      return true;
    });
});

test('the duration check scales with speed and skips fragments too short to judge', () => {
  const text = unpunctuated(60);
  const letters = speakableCharCount(text);
  // At length_scale 0.5 (twice as fast) half the floor is enough.
  const atFloor = Buffer.alloc(Math.ceil((letters / 40) * 0.5 * 24000) * 2);
  assert.doesNotThrow(() => assertFullRender({ pcm: atFloor, sampleRate: 24000, text, lengthScale: 0.5 }));
  assert.throws(() => assertFullRender({ pcm: atFloor, sampleRate: 24000, text, lengthScale: 1 }));
  assert.doesNotThrow(() => assertFullRender({ pcm: Buffer.alloc(2), sampleRate: 24000, text: 'Yes, quite.' }),
    'under the minimum character count the check does not run');
  assert.equal(speakableCharCount('[Kokoro](/kˈOkəɹO/) speaks.'), 'Kokorospeaks'.length,
    'misaki payloads are not counted as speech');
});

// ===========================================================================
// LAYER 2 -- the real synthesis path, against the fake engine
// ===========================================================================

test('S4: an ordinary reply makes exactly one engine call with the pre-change text', async () => {
  resetEngineLog();
  const text = 'The real cost is not the licence. It is the audit, and that one is ours.';
  const pcm = await synthesizePcm({ text, voice: 'af_heart' });
  const calls = engineCalls();
  assert.equal(calls.length, 1, 'one call, as before');
  assert.equal(calls[0], prepared(text), 'the engine receives exactly what it received before');
  assert.ok(pcm.length > 0);
});

test('S1: an unpunctuated stretch reaches the engine whole, and the audio is not truncated', async () => {
  resetEngineLog();
  const text = `Here is the list. ${unpunctuated(300)}`;
  const pcm = await synthesizePcm({ text, voice: 'af_heart' });
  const calls = engineCalls();

  assert.ok(calls.length > 1, 'the stretch was cut into several engine calls');
  for (const sent of calls) {
    assert.ok(longestRun(sent) <= 510, 'no call could reach kokoro-onnx truncation');
  }
  assert.equal(squash(calls.join(' ')), squash(prepared(text)),
    'the engine was asked to say every word, in order');

  // The fake yields CHARS_PER_SECOND=15 characters a second of every character
  // it did not truncate. Nothing truncated means the audio covers them all.
  const expectedSeconds = calls.reduce((s, t) => s + t.split(/[.,!?;]/u)
    .reduce((a, p) => a + p.trim().length, 0) / 15, 0);
  const seconds = pcm.length / 2 / 24000;
  assert.ok(Math.abs(seconds - expectedSeconds) < 0.01 * calls.length,
    `audio ${seconds.toFixed(2)} s vs ${expectedSeconds.toFixed(2)} s expected`);
});

test('S5: a join between two pieces is faded to zero on both sides', async () => {
  resetEngineLog();
  const text = unpunctuated(200);
  const pcm = await synthesizePcm({ text, voice: 'af_heart' });
  const calls = engineCalls();
  assert.ok(calls.length >= 2);
  // The fake's sample count for the first piece locates the join exactly.
  const first = Math.round((calls[0].length / 15) * 24000);
  assert.equal(pcm.readInt16LE((first - 1) * 2), 0, 'the last sample before the join is silent');
  assert.equal(pcm.readInt16LE(first * 2), 0, 'the first sample after the join is silent');
  assert.notEqual(pcm.readInt16LE((first - 400) * 2), 0, 'and the audio either side is not');
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

let _server = null;
let _base = '';

async function routes() {
  if (_base) return _base;
  const express = (await import('express')).default;
  const { registerVoiceRoutes } = await import('../routes/voice.js');
  const app = express();
  registerVoiceRoutes(app);
  _server = app.listen(0);
  await new Promise((r) => _server.once('listening', r));
  _base = `http://127.0.0.1:${_server.address().port}`;
  return _base;
}

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Railway-Restore-Token': TEST_KEY,
  Authorization: `Bearer ${TEST_KEY}`,
  'X-Tenax-User-Id': TEST_USER,
};

async function ndjson(res) {
  return (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('S1: /voice/synthesize speaks a 12,000-character reply in full (was 413)', async () => {
  const base = await routes();
  resetEngineLog();
  const sentence = 'Every sentence of this long reply must be heard, without exception. ';
  const text = sentence.repeat(180).trim();
  assert.ok(text.length > 12000);

  const res = await fetch(`${base}/voice/synthesize`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ text, voice: 'af_heart' }),
  });
  assert.equal(res.status, 200, 'no refusal');
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  const wav = Buffer.from(await res.arrayBuffer());
  const calls = engineCalls();
  assert.ok(calls.length >= 3, 'cut at sentence boundaries into several calls');
  assert.equal(squash(calls.join(' ')), squash(prepared(text)), 'every phrase reached the engine');
  assert.equal(res.headers.get('x-tenax-voice-engine'), null,
    'no engine header without ElevenLabs (E8)');
  assert.ok(wav.length > 44 + 24000 * 2 * 60, 'over a minute of audio');
});

test('S2: a short render is an error that names the segment, never silence', async () => {
  const base = await routes();
  // The engine now reports success with a fifth of the audio it was asked for.
  writeFileSync(`${ENGINE_LOG}.fraction`, '0.2');
  try {
    const text = `${unpunctuated(60)}.`;

    const flat = await fetch(`${base}/voice/synthesize`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ text, voice: 'af_heart' }),
    });
    assert.equal(flat.status, 500, 'an error status, not a short WAV');
    const body = await flat.json();
    assert.equal(body.error, 'tts_short_render');
    assert.match(body.message, /^Segment 1 of \d+ came back shorter than its text/u);

    process.env.VOICE_PROSODY_ENABLED = 'true';
    const streamed = await fetch(`${base}/voice/synthesize/stream`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ text, voice: 'af_heart' }),
    });
    const lines = await ndjson(streamed);
    assert.equal(lines.filter((l) => 'phrase' === l.type).length, 0,
      'no phrase of short audio was emitted in place of the error');
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'error');
    assert.equal(last.error, 'tts_short_render');
    assert.match(last.message, /^Segment 1 of \d+ came back shorter/u, 'the phrase is named');
  } finally {
    rmSync(`${ENGINE_LOG}.fraction`, { force: true });
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

/** A long reply with ordinary sentences and one unpunctuated list. */
function longReply() {
  const para = 'This paragraph is ordinary prose, and it has commas and full stops. '
    + 'Each sentence must be heard in the order it was written. ';
  const list = Array.from({ length: 90 }, (_, i) => `- item number ${i} in the list`).join('\n');
  return `${para.repeat(40)}\n\nHere is the list:\n${list}\n\n${para.repeat(20)}That is the end.`;
}

test('S3: the streamed path renders every phrase of a long reply, no missing tail', async () => {
  const base = await routes();
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    resetEngineLog();
    const text = longReply();
    assert.ok(text.length > 9000);
    const res = await fetch(`${base}/voice/synthesize/stream`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ text, voice: 'af_heart' }),
    });
    assert.equal(res.status, 200);
    const lines = await ndjson(res);
    const phrases = lines.filter((l) => 'phrase' === l.type);
    const end = lines[lines.length - 1];
    assert.equal(end.type, 'end', 'the stream ended normally');
    assert.equal(phrases.length, end.phrases, 'every phrase was delivered');
    assert.deepEqual(phrases.map((p) => p.index), phrases.map((_, i) => i), 'in order');

    const said = squash(engineCalls().join(' ')).toLowerCase();
    for (const marker of ['itemnumber0', 'itemnumber45', 'itemnumber89', 'thatistheend']) {
      assert.ok(said.includes(marker), `the engine was never asked to say "${marker}"`);
    }
    for (const sent of engineCalls()) assert.ok(longestRun(sent) <= 510);
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});

test('S3: the incremental path renders every phrase of a long reply, no missing tail', async () => {
  const base = await routes();
  process.env.VOICE_PROSODY_ENABLED = 'true';
  try {
    resetEngineLog();
    const full = longReply();
    // Grow the reply the way a client receives it, in uneven deltas.
    let shown = 0;
    let offset = 0;
    let sequence = 0;
    let lastEnd = null;
    const step = 700;
    while (true) {
      shown = Math.min(full.length, shown + step);
      const final = shown === full.length;
      const res = await fetch(`${base}/voice/synthesize/incremental`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: full.slice(0, shown), offset, sequence, final, voice: 'af_heart' }),
      });
      assert.equal(res.status, 200);
      const lines = await ndjson(res);
      lastEnd = lines[lines.length - 1];
      assert.equal(lastEnd.type, 'end', `batch at ${shown} ended in ${lastEnd.type}`);
      offset = lastEnd.offset;
      sequence = lastEnd.sequence;
      if (final) break;
    }
    assert.equal(offset, full.length, 'the cursor reached the end of the reply');
    const said = squash(engineCalls().join(' ')).toLowerCase();
    for (const marker of ['itemnumber0', 'itemnumber45', 'itemnumber89', 'thatistheend']) {
      assert.ok(said.includes(marker), `the engine was never asked to say "${marker}"`);
    }
  } finally {
    delete process.env.VOICE_PROSODY_ENABLED;
  }
});
