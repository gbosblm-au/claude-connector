// src/tests/voice-incremental.test.js
//
// Kokoro Sentence-Boundary Streaming Spec v1 — Sections 3.2, 6.1-6.3, 7, 9.
// Build order step 2 (§10.2): the incremental endpoint.
//
// ===========================================================================
// WHAT IS TESTED HERE, AND WHAT IS NOT
// ===========================================================================
//
// Two layers, deliberately separated:
//
//   THE PROTOCOL. Driven purely through splitStream, with no HTTP and no
//   audio. This is where the real risk lives: the offset contract has to
//   deliver every character of a growing reply exactly once, in order, under
//   arbitrary delta boundaries. A bug here is a repeated or a skipped
//   sentence, which is audible and which no amount of route testing would
//   catch, because the route is a thin shell over this arithmetic.
//
//   THE ROUTE. Mounted for real on express and driven over a live socket, with
//   the SYNTHESISER mocked. Mocking the synthesiser rather than the route is
//   the point: it means the gate, the limiter, the body parsing, the status
//   codes, the NDJSON framing and the cursor accounting are the shipping code
//   and not a re-description of it. What is mocked is the one thing that needs
//   a 300 MB model and a Python process.
//
// Kokoro itself is NOT exercised. That is what scripts/voice-worker-smoke.mjs
// and the benchmark harness are for; a unit suite that spawned a model would
// be too slow to run and would fail for reasons that have nothing to do with
// the code under test.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { mock, after } from 'node:test';

import { splitStream } from '../voice/voice-stream-split.js';

/** The allowlisted caller. Matched verbatim by the gate. */
const TEST_USER = 'voice-incremental-test-user';
const TEST_KEY  = 'test-key-for-voice-incremental';

/** The headers every request in this file sends: credential plus identity. */
const HEADERS = {
  'Content-Type': 'application/json',
  'X-Railway-Restore-Token': TEST_KEY,
  Authorization: `Bearer ${TEST_KEY}`,
  // Without this the gate resolves no identity and answers 404 -- the same
  // 404 it gives when voice is globally off, which is deliberate and which
  // makes a missing header look exactly like a disabled feature.
  'X-Tenax-User-Id': TEST_USER,
};

// The shared server is torn down once, when the whole file has finished.
// Without this the open listener keeps the process alive and the run hangs
// after the last assertion has already passed -- a green suite that never
// exits, which is worse than a red one.
after(async () => { if (_app) await _app.close(); });

// ===========================================================================
// LAYER 1 — the offset protocol
// ===========================================================================

/**
 * Drive a reply through the incremental contract the way a client does.
 *
 * Holds the accumulated text and the cursor, calls splitStream on each delta
 * exactly as the route does, and records what would have been spoken.
 *
 * @param {string[]} deltas Text fragments, in arrival order.
 * @param {object} [config] Splitter tuneables.
 * @returns {{spoken: string[], offsets: number[], calls: number}}
 */
function drive(deltas, config) {
  let text = '';
  let offset = 0;
  const spoken = [];
  const offsets = [offset];
  let calls = 0;

  for (let i = 0; i < deltas.length; i += 1) {
    text += deltas[i];
    const final = (i === deltas.length - 1);
    const r = splitStream(text, { offset, final, config });
    calls += 1;
    for (const p of r.phrases) spoken.push(p.text);
    offset = r.consumed;
    offsets.push(offset);
  }

  return { spoken, offsets, calls };
}

test('AC-4/AC-6: a reply split into deltas is spoken once, in order, in full', () => {
  const reply = 'The report is ready. It covers three regions. '
              + 'Revenue rose in each of them. Ask me for the detail.';

  // Character-by-character is the harshest delta boundary there is: every
  // boundary falls mid-word at some point.
  const perChar = drive(reply.split(''));
  assert.deepEqual(perChar.spoken, [
    'The report is ready.',
    'It covers three regions.',
    'Revenue rose in each of them.',
    'Ask me for the detail.',
  ]);

  // The same reply delivered in two lumps must produce the same speech.
  const twoLumps = drive([reply.slice(0, 37), reply.slice(37)]);
  assert.deepEqual(twoLumps.spoken, perChar.spoken,
    'delta boundaries must not change what is spoken');

  // And in one lump, which is the degenerate non-incremental case.
  assert.deepEqual(drive([reply]).spoken, perChar.spoken);
});

test('AC-6: the cursor only ever advances', () => {
  const reply = 'One. Two. Three. Four. Five.';
  const { offsets } = drive(reply.split(''));
  for (let i = 1; i < offsets.length; i += 1) {
    assert.ok(offsets[i] >= offsets[i - 1],
      `offset went backwards at call ${i}: ${offsets[i - 1]} -> ${offsets[i]}`);
  }
});

test('AC-7/EC-6: replaying a call returns the same phrases and the same cursor', () => {
  const text = 'First sentence here. Second one follows. And a trailing part';

  const once  = splitStream(text, { offset: 0 });
  const twice = splitStream(text, { offset: 0 });

  assert.deepEqual(twice.phrases, once.phrases,
    'a retry must not produce different phrases');
  assert.equal(twice.consumed, once.consumed,
    'a retry must not move the cursor differently');

  // The half that matters most: resuming from the cursor must not re-speak.
  const resumed = splitStream(text, { offset: once.consumed });
  assert.deepEqual(resumed.phrases, [],
    'resuming from the cursor must not repeat a spoken phrase');
});

test('AC-4/FR-3.2: the final flush speaks a tail with no terminal punctuation', () => {
  // EC-7: a reply that never emits terminal punctuation at all.
  const { spoken } = drive(['no punctuation ', 'ever arrives here']);
  assert.deepEqual(spoken, ['no punctuation ever arrives here']);

  // And the normal case: a complete reply whose last sentence has a stop but
  // no trailing whitespace to confirm it.
  const r = drive(['Done. ', 'Last one.']);
  assert.deepEqual(r.spoken, ['Done.', 'Last one.']);
});

test('no text is lost between the cursor and the end of the reply', () => {
  // The strongest property available without comparing against a second
  // implementation: everything the splitter consumed, concatenated, must
  // account for every non-whitespace character of the source.
  const reply = 'Alpha beta. Gamma delta! Epsilon zeta? Eta theta.';
  const { spoken } = drive(reply.split(''), { markdownStripping: false });

  const strip = (s) => s.replace(/\s+/g, '');
  assert.equal(strip(spoken.join('')), strip(reply),
    'characters were dropped or duplicated across the incremental calls');
});

test('EC-1: a code block arriving mid-stream is held, then spoken whole', () => {
  const fence = '`'.repeat(3);
  const deltas = [
    'Here is the fix. ',
    `${fence}\n`,
    'const x = 1;\n',
    'const y = 2;\n',
  ];

  // While the fence is open, nothing after it may be spoken.
  let text = '';
  let offset = 0;
  const before = [];
  for (const d of deltas) {
    text += d;
    const r = splitStream(text, { offset, final: false });
    for (const p of r.phrases) before.push(p.text);
    offset = r.consumed;
  }
  assert.deepEqual(before, ['Here is the fix.'],
    'an unclosed code block must defer, not leak its contents into speech');

  // Closing it releases the block as one phrase.
  text += `${fence}\n`;
  const after = splitStream(text, { offset, final: false });
  assert.ok(after.phrases.length >= 1, 'the closed block should now be released');
  assert.ok(after.phrases[0].text.includes('const x = 1;'),
    'the block should be spoken as a unit once closed');
});

// ===========================================================================
// LAYER 2 — the route, over a real socket, with the synthesiser mocked
// ===========================================================================

/**
 * Boot the real voice routes against a mocked synthesis engine.
 *
 * The mock replaces ONLY synthesizeProsodyStream and the catalogue lookups
 * that would otherwise need an installed model on a mounted volume. Everything
 * the test asserts on -- framing, cursor, status codes, ordering -- is the
 * shipping route.
 *
 * SINGLETON, and it has to be: node:test refuses to mock the same module
 * twice in a process, and mounting the routes a second time would register
 * duplicate handlers on a fresh app anyway. The recorded `calls` array is
 * cleared per test instead, which is the only per-test state there is.
 *
 * @returns {Promise<{base: string, close: () => Promise<void>, calls: object[]}>}
 */
let _app = null;

async function boot() {
  if (_app) { _app.calls.length = 0; return _app; }

  const calls = [];

  // Recorded so the finalPosition assertion below can read what the route
  // actually asked the engine for.
  mock.module('../voice/voice-engines.js', {
    namedExports: {
      probeEngines:   async () => ({ stt: true, tts: true }),
      engineState:    () => ({ stt_ready: true, tts_ready: true, models_loaded: [] }),
      installedVoices: () => ['af_heart'],
      transcribe:     async () => ({ text: '' }),
      synthesize:     async () => ({ wav: Buffer.alloc(0) }),
      synthesizeProsody: async () => ({ wav: Buffer.alloc(0), path: 'prosody' }),
      synthesizeProsodyStream: async (opts, onSegment) => {
        calls.push(opts);
        // Phrases of trivial PCM, delivered in order, so the route's framing
        // and cursor accounting can be observed without a model.
        const phrases = String(opts.text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
        for (let i = 0; i < phrases.length; i += 1) {
          await onSegment({
            index: i, total: phrases.length,
            pcm: Buffer.from([0, 0, 1, 0]),
            pauseAfterMs: 120, profile: 'neutral', lengthScale: 1,
            sampleRate: 24000,
          });
        }
        return { phrases: phrases.length, bytes: phrases.length * 4, sampleRate: 24000 };
      },
      voiceLengthScale: () => 1,
      prosodyState:     () => ({ enabled: true }),
      prewarmTts:       async () => undefined,
      ttsWorkerState:   () => ({ ready: true }),
      prewarmStt:       async () => undefined,
      sttWorkerHealth:  () => ({ ready: true }),
    },
  });

  process.env.VOICE_ENABLED = 'true';
  // The allowlist is verbatim: no wildcards, no case folding, no prefix
  // match. A literal id is the only thing that opens the gate.
  process.env.VOICE_TEST_USERS = TEST_USER;
  process.env.MCP_API_KEY = TEST_KEY;
  process.env.VOICE_PROSODY_ENABLED = 'true';

  const express = (await import('express')).default;
  const { registerVoiceRoutes } = await import('../routes/voice.js');

  const app = express();
  registerVoiceRoutes(app);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  _app = {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  return _app;
}

/**
 * Read an NDJSON response into an array of objects.
 *
 * @param {Response} res
 * @returns {Promise<object[]>}
 */
async function ndjson(res) {
  const body = await res.text();
  return body.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('the route answers a no-new-phrases call with an end line, not a 422', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  // A partial sentence: nothing is complete, so nothing can be spoken yet.
  const res = await fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ text: 'A partial senten', offset: 0, voice: 'af_heart' }),
  });

  assert.equal(res.status, 200, 'nothing-new is a normal outcome, not a caller error');
  const lines = await ndjson(res);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'end');
  assert.equal(lines[0].phrases, 0);
  assert.equal(lines[0].offset, 0, 'the cursor must not move when nothing was spoken');
});

test('the route emits phrase lines then an end line carrying the new cursor', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  const text = 'First sentence. Second sentence. Trailing part';
  const res = await fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ text, offset: 0, sequence: 0, voice: 'af_heart' }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.equal(res.headers.get('x-accel-buffering'), 'no',
    'without this a buffering proxy silently un-does the whole feature');

  const lines = await ndjson(res);
  const phrases = lines.filter((l) => 'phrase' === l.type);
  const end = lines[lines.length - 1];

  assert.equal(phrases.length, 2);
  assert.equal(end.type, 'end');

  // Sequence numbers are absolute and contiguous.
  assert.deepEqual(phrases.map((p) => p.sequence), [0, 1]);
  assert.equal(end.sequence, 2, 'the end line seeds the next call');

  // The cursor stops at the end of the last COMPLETE sentence, leaving the
  // trailing partial for a later call.
  assert.equal(text.slice(0, end.offset), 'First sentence. Second sentence.');

  for (const p of phrases) {
    assert.ok(p.audio_base64.length > 0, 'every phrase line must carry audio');
    assert.equal(p.sample_rate, 24000);
  }
});

test('sequence continues across calls, so a resumed reply does not restart at zero', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  const post = (body) => fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(Object.assign({ voice: 'af_heart' }, body)),
  }).then(ndjson);

  const first = await post({ text: 'One here. Two here. ', offset: 0, sequence: 0 });
  const firstEnd = first[first.length - 1];

  const second = await post({
    text: 'One here. Two here. Three here. ',
    offset: firstEnd.offset,
    sequence: firstEnd.sequence,
  });

  const secondPhrases = second.filter((l) => 'phrase' === l.type);
  assert.equal(secondPhrases.length, 1, 'only the newly-complete sentence is spoken');
  assert.equal(secondPhrases[0].sequence, firstEnd.sequence,
    'the second call continues the sequence rather than restarting it');
});

test('finalPosition is false mid-reply and true on the flush', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  const post = (body) => fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(Object.assign({ voice: 'af_heart' }, body)),
  }).then(ndjson);

  await post({ text: 'Mid reply here. ', offset: 0, final: false });
  assert.equal(app.calls[app.calls.length - 1].finalPosition, false,
    'a mid-reply batch must not close on a falling final contour');

  await post({ text: 'Mid reply here. The end. ', offset: 16, final: true });
  assert.equal(app.calls[app.calls.length - 1].finalPosition, true,
    'the flush batch is the one that actually ends the reply');
});

test('an out-of-range offset is clamped rather than refused', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  // A client that has drifted should re-sync and keep speaking, not lose the
  // rest of the reply to a 422.
  const res = await fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ text: 'Short. ', offset: 99999, voice: 'af_heart' }),
  });

  assert.equal(res.status, 200);
  const lines = await ndjson(res);
  assert.equal(lines[lines.length - 1].type, 'end');
});

test('text over the ceiling is refused with 413 before any synthesis', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  const res = await fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ text: 'x'.repeat(6000), offset: 0, voice: 'af_heart' }),
  });

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'text_too_long');
});

test('an invalid speed is a 422 with a message the UI can render', async () => {
  const app = await boot();
  /* The server is a singleton shared by every test here; it is closed by the
     process exiting, not per test. */

  const res = await fetch(`${app.base}/voice/synthesize/incremental`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ text: 'Fine. ', offset: 0, speed: 9, voice: 'af_heart' }),
  });

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, 'invalid_speed');
  assert.ok(body.message, 'a rejection must carry a human-readable message');
});
