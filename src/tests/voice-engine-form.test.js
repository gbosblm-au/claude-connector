// src/tests/voice-engine-form.test.js
//
// Work order W7 rev 1.1 (2026-10-06): engine-form text for both synthesis
// engines, and tagless renders at the current pin. Connector v13.35.0.
//
// What this file proves, in the work order's terms:
//
//   Deliverable 1   the formatter: profiles, idempotence, Unicode safety,
//                   Kokoro markup untouched, punctuation rules off until the
//                   by-ear calibration turns them on, break tags gated.
//   Deliverable 2   the call-site fixes D1 found: one ElevenLabs generation per
//                   sentence (no generation ends on a comma or a colon that the
//                   prosody analysis cut at), neighbours on every generation,
//                   and context across incremental batch seams.
//   Deliverable 5   the tagless guarantee: the full marker vocabulary, a
//                   non-empty floor asserted before the scan, the set checked in
//                   both directions, and the request-builder assertions.
//   Criterion 10    Kokoro unchanged except marker stripping, including when it
//                   renders a reply ElevenLabs could not.
//
// ElevenLabs is a local fake that records each request body; Kokoro is
// fixtures/fake-kokoro-once.mjs behind the real one-shot supervisor, which logs
// the exact text each Kokoro call received. Same arrangement as
// voice-elevenlabs.test.js.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'tenax-engine-form-test-'));
const ENGINE_LOG = join(WORK, 'engine.log');
const TEST_USER = 'voice-engine-form-test-user';
const TEST_KEY = 'test-key-for-voice-engine-form';
const EL_KEY = 'sk_el_ENGINEFORM_1a2b3c4d5e6f7a8b9c0d';
const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2';
const EL_LEVEL = 3000;

const WRAPPER = join(WORK, 'fake-python');
writeFileSync(WRAPPER, `#!/bin/sh\nFAKE_KOKORO_LOG="${ENGINE_LOG}" exec "${process.execPath}" `
  + `"${join(HERE, 'fixtures', 'fake-kokoro-once.mjs')}" "$@"\n`);
chmodSync(WRAPPER, 0o755);

// ---------------------------------------------------------------------------
// The fake ElevenLabs service: records every body, answers with flat PCM.
// ---------------------------------------------------------------------------
const el = { calls: [], script: () => null };
const elServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (err) { /* recorded as empty */ }
    const call = { body, n: el.calls.length };
    el.calls.push(call);
    const outcome = el.script(call) || {};
    if (outcome.status && 200 !== outcome.status) {
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcome.body || { detail: { code: 'some_error' } }));
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
  VOICE_TEST_USERS: TEST_USER,
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
delete process.env.ELEVENLABS_PUNCTUATION;
delete process.env.ELEVENLABS_BREAK_TAGS_VERIFIED;
delete process.env.ELEVENLABS_SEGMENT_UNIT;

const form = await import('../voice/engine-form.js');
const adapter = await import('../voice/elevenlabs.js');
const engines = await import('../voice/voice-engines.js');
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

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Railway-Restore-Token': TEST_KEY,
  Authorization: `Bearer ${TEST_KEY}`,
  'X-Tenax-User-Id': TEST_USER,
};
const CONFIG = { api_key: EL_KEY, voice_id: VOICE_ID, model_id: 'eleven_multilingual_v2' };
const EL_CFG = { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2' };

function kokoroTexts() {
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
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()),
           buf: Buffer.from(await res.arrayBuffer()) };
}
function lines(buf) {
  return buf.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (undefined === v) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (undefined === v) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ===========================================================================
// THE VOCABULARY (D5). Derived from the register; floor before the scan.
// ===========================================================================

/**
 * The vocabulary as the client and the live path define it, read from source
 * on 2026-10-06 (docs/W7-ENGINE-FORM.md, D5 table): ts-client-gateway
 * 06b-output-marker.js lines 36 and 43, 06-markdown.js lines 414 and 423, and
 * the tags heard spoken on eleven_multilingual_v2 (W7 section 1). The register
 * in engine-form.js must equal this set, in both directions.
 */
const EXPECTED_VOCABULARY = Object.freeze([
  '[OUTPUT]', '[TRACE]', '[RESULT]',
  '[private-conversation]', '[forget]',
  '[[TRAVEL_RESEARCH_FORM]]', '[[RECREATION_PANEL]]',
  '[warm]', '[pause]', '[slowly]', '[softly]', '[drawn-out]',
]);

/** One example per token CLASS that no register entry exercises. */
const CLASS_EXAMPLES = Object.freeze({
  reference: ['[1]', '[12]', '[^3]'],
  checkbox: ['- [ ] ', '[x] '],
  empty_box: ['[ ]', '[]'],
  double_bracket: ['[[SOME_FUTURE_PANEL]]'],
  upper_marker: ['[NOTE]', '[SOME_MARKER]'],
  single_bracket_tag: ['[whispers]', '[sighs heavily]', '[l’air]', '[ému]'],
});

const REGISTER = Object.values(form.MARKER_REGISTER).flat();

test('D5 floor: the register is non-empty and equals the source vocabulary, both ways', () => {
  // The floor comes first, so a register emptied by mistake cannot make every
  // scan below vacuously pass.
  assert.ok(REGISTER.length >= EXPECTED_VOCABULARY.length && REGISTER.length > 0,
    `the register holds ${REGISTER.length} tokens`);
  for (const t of EXPECTED_VOCABULARY) assert.ok(REGISTER.includes(t), `register lacks ${t}`);
  for (const t of REGISTER) assert.ok(EXPECTED_VOCABULARY.includes(t), `register has unlisted ${t}`);
  assert.equal(new Set(REGISTER).size, REGISTER.length, 'no duplicates');
});

test('D5 coverage, both ways: every register token is caught by a class, every class is exercised', () => {
  assert.ok(form.TOKEN_CLASSES.length >= 5, 'the class floor');
  const exercised = new Set();
  for (const token of REGISTER) {
    const hits = form.TOKEN_CLASSES.filter((cls) => {
      cls.pattern.lastIndex = 0;
      return cls.pattern.test(token);
    }).map((cls) => cls.id);
    // Register -> classes: stripped by SHAPE, not only by name, so the by-name
    // pass is a second net rather than the only one.
    assert.ok(hits.length > 0, `${token} is matched by a token class`);
    for (const id of hits) exercised.add(id);
  }
  for (const [id, examples] of Object.entries(CLASS_EXAMPLES)) {
    assert.ok(examples.length > 0, `${id} has examples`);
    for (const ex of examples) {
      const cls = form.TOKEN_CLASSES.find((c) => c.id === id);
      assert.ok(cls, `class ${id} exists`);
      cls.pattern.lastIndex = 0;
      assert.ok(cls.pattern.test(ex), `${id} matches ${JSON.stringify(ex)}`);
      exercised.add(id);
    }
  }
  // Classes -> examples: a class added later without a test fails here.
  for (const cls of form.TOKEN_CLASSES) assert.ok(exercised.has(cls.id), `class ${cls.id} is exercised`);
});

test('D5 scan: every token, every position, both profiles: stripped, and the result is tagless', () => {
  const tokens = [...REGISTER, ...Object.values(CLASS_EXAMPLES).flat().map((t) => t.trim())
    .filter((t) => t.startsWith('['))];
  assert.ok(tokens.length >= REGISTER.length + 8, 'the scan floor');
  const frames = [
    (t) => `${t} The answer is ready.`,
    (t) => `The answer ${t} is ready.`,
    (t) => `The answer is ready. ${t}`,
    (t) => `The answer is ready.${t}`,
    (t) => `First line.\n${t}\nSecond line.`,
    (t) => `${t}${t} Twice.`,
  ];
  let checked = 0;
  for (const token of tokens) {
    for (const frame of frames) {
      const input = frame(token);
      for (const profile of ['kokoro', 'elevenlabs']) {
        const out = form.toEngineForm(input, profile);
        assert.deepEqual(form.bracketedTokens(out), [], `${profile}: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
        assert.doesNotThrow(() => form.assertTagless(out, 'test'));
        // The word inside the brackets is not spoken either. Checked for the
        // words long enough to be findable (not "x", "1", "^3").
        const inner = token.replace(/^\[+|\]+$/gu, '').trim();
        if (inner.length >= 3 && /\p{L}/u.test(inner)) {
          assert.ok(!out.includes(inner), `${profile}: "${inner}" is not spoken: ${JSON.stringify(out)}`);
        }
        checked += 1;
      }
    }
  }
  assert.equal(checked, tokens.length * frames.length * 2);
});

test('assertTagless refuses by name and never echoes the text', () => {
  for (const token of REGISTER) {
    assert.throws(() => form.assertTagless(`Before ${token} after.`, 'builder'),
      (err) => 'tagged_text' === err.code && 'error' === err.reason
        && !err.message.includes(token) && /^builder: \d+ bracketed/u.test(err.message));
  }
  assert.doesNotThrow(() => form.assertTagless('Say [tomato](/təˈmɑːtoʊ/) and [read](+2).', 'kokoro'),
    'misaki markup is not a token');
  assert.doesNotThrow(() => form.assertTagless('Read [the guide](https://example.com) now.', 'x'),
    'a markdown link is not a token');
});

// ===========================================================================
// THE PROFILES (deliverable 1)
// ===========================================================================

const CORPUS = [
  'Here is the plan: first, we test; then we ship \u2014 carefully.',
  'Café naïve \u2014 l’été, it’s “quoted”, señor.',
  'Time 10:30, ratio 3:1, https://example.com/a:b, cost-benefit 2019–2024.',
  'Wait… or wait... and (an aside) here.',
  '**Bold** and `code` and a [link](https://x.y) and [tomato](/təˈmɑːtoʊ/).',
  '- first item\n- second item\n\n1. numbered',
  'Plain sentence with nothing special in it.',
  'Unicode: 你好, مرحبا, 😀 emoji, ß and Å.',
];

test('Kokoro profile: marker-free text is returned byte for byte (criterion 10)', () => {
  for (const text of CORPUS) {
    assert.equal(form.toEngineForm(text, 'kokoro'), text, JSON.stringify(text));
  }
});

test('Kokoro profile: misaki markup and links reach Kokoro untouched', () => {
  const t = 'Say [tomato](/təˈmɑːtoʊ/), [read](+2) and [the guide](https://x.y). [warm]';
  assert.equal(form.toEngineForm(t, 'kokoro'),
    'Say [tomato](/təˈmɑːtoʊ/), [read](+2) and [the guide](https://x.y).');
});

test('both profiles are idempotent, with every rule off and with every rule on', () => {
  const allOn = { ELEVENLABS_PUNCTUATION: 'colon=period,semicolon=period,emdash=comma,ellipsis=comma,parentheses=comma' };
  const breaks = { ELEVENLABS_PUNCTUATION: 'colon=break', ELEVENLABS_BREAK_TAGS_VERIFIED: 'true' };
  const inputs = [...CORPUS, ...REGISTER.map((t) => `A ${t} b: c; d \u2014 e… (f).`)];
  for (const text of inputs) {
    for (const [profile, env] of [['kokoro', {}], ['elevenlabs', {}], ['elevenlabs', allOn], ['elevenlabs', breaks]]) {
      const once = form.toEngineForm(text, profile, { env, modelId: 'eleven_multilingual_v2' });
      const twice = form.toEngineForm(once, profile, { env, modelId: 'eleven_multilingual_v2' });
      assert.equal(twice, once, `${profile} ${JSON.stringify(env)}: ${JSON.stringify(text)}`);
    }
  }
});

test('Unicode safety: accents, apostrophes and non-Latin scripts survive both profiles', () => {
  const text = 'Café naïve l’été it’s señor ß Å 你好 مرحبا [warm]';
  for (const profile of ['kokoro', 'elevenlabs']) {
    const out = form.toEngineForm(text, profile);
    for (const word of ['Café', 'naïve', 'été', 'señor', 'ß', 'Å', '你好', 'مرحبا']) {
      assert.ok(out.includes(word), `${profile} keeps ${word}: ${out}`);
    }
    // The apostrophe is kept as an apostrophe (the ElevenLabs profile's
    // normaliser straightens typographic quotes, which is not a word change).
    assert.match(out, /l['’]été it['’]s/u, profile);
  }
});

test('ElevenLabs profile: markdown flattened, links keep their label, no contour is added', () => {
  // The 13.34.0 preparation without its contour step: bold and links
  // flattened, inline code left as written (as 13.34.0 sent it).
  const out = form.toEngineForm('**Bold** move, then [read this](https://x.y) and `run it`', 'elevenlabs');
  assert.equal(out, 'Bold move, then read this and `run it`');
  // Underscores and asterisks inside words are content, not emphasis.
  assert.equal(form.toEngineForm('Set my_var_name, use *args and **kwargs.', 'elevenlabs'),
    'Set my_var_name, use *args and **kwargs.');
  // The pre-W7 path appended a comma to a non-final phrase. Nothing is added now.
  assert.equal(form.toEngineForm('The first part', 'elevenlabs'), 'The first part');
  assert.equal(form.toEngineForm('A phrase that ends here', 'elevenlabs', { modelId: 'eleven_v3' }),
    'A phrase that ends here');
});

test('punctuation rules ship OFF: the ElevenLabs profile keeps every mark', () => {
  const text = 'Note: this; that \u2014 other… (aside) end.';
  assert.deepEqual(form.punctuationChoices({}).choices, {});
  for (const rule of Object.values(form.RULES)) assert.equal(rule.state, 'off');
  assert.equal(form.toEngineForm(text, 'elevenlabs', { env: {} }), text);
  assert.equal(form.applyPunctuationRules(text, { env: {} }), text);
});

test('each rule, when switched on, changes only its own mark and never a content word', () => {
  const cases = [
    ['colon=period', 'Note: this stays. At 10:30 and 3:1.', 'Note. this stays. At 10:30 and 3:1.'],
    ['colon=comma', 'Note: this.', 'Note, this.'],
    ['semicolon=period', 'One; two.', 'One. two.'],
    ['emdash=comma', 'One \u2014 two, cost-benefit 2019-2024.', 'One, two, cost-benefit 2019-2024.'],
    ['ellipsis=period', 'Wait… or wait... done', 'Wait. or wait. done'],
    ['parentheses=comma', 'It works (mostly) well.', 'It works, mostly, well.'],
  ];
  for (const [setting, input, expected] of cases) {
    assert.equal(form.toEngineForm(input, 'elevenlabs', { env: { ELEVENLABS_PUNCTUATION: setting } }),
      expected, setting);
  }
});

test('break tags: only when verified, never on v3 or v4, at most BREAK_LIMIT per generation', () => {
  const text = 'A: b. C: d. E: f.';
  const on = { ELEVENLABS_PUNCTUATION: 'colon=break', ELEVENLABS_BREAK_TAGS_VERIFIED: 'true' };
  const v2 = form.toEngineForm(text, 'elevenlabs', { env: on, modelId: 'eleven_multilingual_v2' });
  assert.equal((v2.match(/<break time="0\.5s" \/>/gu) || []).length, form.BREAK_LIMIT, v2);
  assert.equal(form.BREAK_LIMIT, 2);
  assert.ok(v2.endsWith('E. f.'), 'over the limit falls back to a full stop');
  for (const model of ['eleven_v3', 'eleven_v4']) {
    assert.ok(!form.toEngineForm(text, 'elevenlabs', { env: on, modelId: model }).includes('<break'), model);
  }
  const unverified = form.toEngineForm(text, 'elevenlabs',
    { env: { ELEVENLABS_PUNCTUATION: 'colon=break' }, modelId: 'eleven_multilingual_v2' });
  assert.equal(unverified, 'A. b. C. d. E. f.', 'not verified: a full stop, never a tag');
  // A break tag is not a bracketed token, so the builder assertion allows it.
  assert.doesNotThrow(() => form.assertTagless(v2, 'x'));
});

test('unknown punctuation entries are ignored and named once', () => {
  const { choices, ignored } = form.punctuationChoices({ ELEVENLABS_PUNCTUATION: 'colon=period,comma=period,colon2=x,semicolon=dash' });
  assert.deepEqual(choices, { colon: 'period' });
  assert.deepEqual(ignored, ['comma=period', 'colon2=x', 'semicolon=dash'],
    'prose comma stripping is not a rule (W7 section 6)');
});

// ===========================================================================
// THE REQUEST BUILDERS (deliverable 5)
// ===========================================================================

test('ElevenLabs builder: a tag in text, previous_text or next_text is refused before any request', async () => {
  for (const field of ['text', 'previousText', 'nextText']) {
    reset();
    const o = { config: EL_CFG, text: 'A clean sentence.', sampleRate: 24000, [field]: 'Has a [warm] tag.' };
    await assert.rejects(adapter.synthesizeElevenLabsPcm(o),
      (err) => 'tagged_text' === err.code && 'error' === err.reason && !err.message.includes('warm'), field);
    assert.equal(el.calls.length, 0, `${field}: nothing was sent`);
  }
  reset();
  await adapter.synthesizeElevenLabsPcm({ config: EL_CFG, text: 'A clean sentence.', sampleRate: 24000 });
  assert.equal(el.calls.length, 1, 'a clean request goes out');
});

test('Kokoro builder: no token reaches Kokoro, including one that preparation uncovers', async () => {
  // Called directly (bypassing the entry strip) and through the entries, with
  // markers that only appear once preparation has flattened links and bold.
  // Each renders, and Kokoro never receives a bracketed token.
  const cases = [
    '[warm] Hello there.',
    '[**warm**] Hello there.',
    'See [[a tag](https://x.y)] for more.',
    'A [note [1] here] in brackets.',
    'Use grid = [[]] to start.',
  ];
  for (const text of cases) {
    reset();
    await engines.synthesizePcm({ text, voice: 'af_heart' });
    await engines.synthesize({ text, voice: 'af_heart' });
    await engines.synthesizeProsody({ text, voice: 'af_heart' });
    const sent = kokoroTexts();
    assert.ok(sent.length >= 3, text);
    for (const t of sent) assert.deepEqual(form.bracketedTokens(t), [], `${text} -> ${t}`);
  }
  // In espeak mode preparation flattens misaki-shaped spans to their label,
  // as it did before this release; the builder strip does not touch them.
  reset();
  await engines.synthesizePcm({ text: 'Say [tomato](/təˈmɑːtoʊ/) now.', voice: 'af_heart' });
  assert.equal(kokoroTexts()[0], 'Say tomato now.');
});

test('Kokoro builder: misaki emphasis markup survives the builder strip', async () => {
  await withEnv({ VOICE_KOKORO_G2P: 'misaki' }, async () => {
    reset();
    await engines.synthesizePcm({ text: '**X** marks the spot.', voice: 'af_heart' });
    const sent = kokoroTexts();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /\[X\]\(/u, `emphasis markup kept: ${sent[0]}`);
  });
});

test('content in brackets that is not a marker is kept: keys, indexers, years, link labels', () => {
  const keep = [
    'Press [Enter] to continue.',
    'Use [Ctrl] + [C] to copy.',
    'Call f(a[i]) now, then m[1][2] and array[0].',
    'In [2024] we shipped.',
  ];
  for (const text of keep) {
    assert.equal(form.toEngineForm(text, 'kokoro'), text, text);
    assert.deepEqual(form.bracketedTokens(text), [], text);
  }
  // A link whose label is a box letter keeps its label (checkbox guard).
  assert.equal(form.toEngineForm('[X](https://x.com) posts daily.', 'kokoro'), '[X](https://x.com) posts daily.');
  assert.equal(form.toEngineForm('- [x](https://x.com) posts', 'kokoro'), '- [x](https://x.com) posts');
  assert.equal(form.toEngineForm('[X](https://x.com) posts daily.', 'elevenlabs'), 'X posts daily.');
});

test('stripMarkers and both profiles are idempotent on nested and adjacent markers', () => {
  for (const text of ['A [note [1] here] end.', '[warm][pause] x', 'grid = [[]] y', '[[[warm]]] z',
                      'See [[a tag](https://x.y)] for more.', '[**warm**] hi']) {
    const once = form.stripMarkers(text);
    assert.equal(form.stripMarkers(once), once, text);
    for (const profile of ['kokoro', 'elevenlabs']) {
      const f = form.toEngineForm(text, profile);
      assert.equal(form.toEngineForm(f, profile), f, `${profile}: ${text}`);
    }
  }
  assert.deepEqual(form.bracketedTokens(form.toEngineForm('[**warm**] hi', 'elevenlabs')), [],
    'a marker uncovered by flattening is stripped on the ElevenLabs path too');
});

// ===========================================================================
// THE PATHS (deliverable 2, criteria 8 and 10)
// ===========================================================================

const COMMA_DENSE = 'First, we read the specification carefully; then, we test it: slowly, '
  + 'deliberately, and well. The second sentence follows it, briefly.';

test('stream: one ElevenLabs generation per sentence, none ending on a comma, colon or semicolon', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset();
    const r = await post('/voice/synthesize/stream', { text: COMMA_DENSE, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    const texts = el.calls.map((c) => c.body.text);
    assert.equal(texts.length, 2, `one generation per sentence: ${JSON.stringify(texts)}`);
    for (const t of texts) assert.match(t, /[.!?]$/u, `ends on a terminator: ${t}`);
    assert.ok(texts[0].includes('we read the specification carefully; then, we test it: slowly,'),
      'the marks inside the sentence reach the model as punctuation, not as generation ends');
    assert.equal(el.calls[0].body.next_text, texts[1], 'the neighbour is sent');
    assert.equal(el.calls[1].body.previous_text, texts[0]);
    assert.deepEqual(kokoroTexts(), [], 'Kokoro did not speak');

    // The A/B switch: phrase-level generations, as before this release.
    await withEnv({ ELEVENLABS_SEGMENT_UNIT: 'phrase' }, async () => {
      reset();
      await post('/voice/synthesize/stream', { text: COMMA_DENSE, voice: 'af_heart', elevenlabs: CONFIG });
      assert.ok(el.calls.length > 2, `the analysis does cut inside sentences: ${el.calls.length}`);
      // Each generation is the author's own words and marks: the pre-W7
      // contour comma ("carefully;" sent as "carefully;," or "First" as
      // "First,") would make a generation that is not a substring.
      for (const c of el.calls) {
        assert.ok(COMMA_DENSE.includes(c.body.text), `verbatim, nothing appended: ${c.body.text}`);
      }
    });
  });
});

test('buffered prosody and flat: same rule, one generation per sentence, tags stripped', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset();
    const r = await post('/voice/synthesize',
      { text: `[warm] ${COMMA_DENSE} [pause]`, voice: 'af_heart', prosody: 'on', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-tenax-voice-engine'], 'elevenlabs');
    assert.equal(el.calls.length, 2, JSON.stringify(el.calls.map((c) => c.body.text)));
    for (const c of el.calls) {
      assert.deepEqual(form.bracketedTokens(JSON.stringify(c.body)), [], 'no tag in any field');
      assert.match(c.body.text, /[.!?]$/u);
    }
  });
  await withEnv({ VOICE_PROSODY_ENABLED: 'false' }, async () => {
    // Flat mode: sentence-bounded segments of up to ELEVENLABS_SEGMENT_CHARS,
    // so this short reply is ONE generation (no seam at all).
    reset();
    const r = await post('/voice/synthesize', { text: `[OUTPUT] ${COMMA_DENSE}`, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    assert.equal(el.calls.length, 1);
    assert.equal(el.calls[0].body.text, COMMA_DENSE);
    for (const c of el.calls) assert.ok(!c.body.text.includes('OUTPUT'), c.body.text);
  });
});

test('Kokoro: a reply with markers is spoken exactly as the same reply without them (criterion 10)', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const clean = 'The plan is ready. We start tomorrow, early.\n\nThen we review it.';
    const marked = '[OUTPUT] The plan is ready. [warm] We start tomorrow, early. [[RECREATION_PANEL]]\n\n'
      + '[pause] Then we review it. [1]';
    reset();
    await post('/voice/synthesize/stream', { text: clean, voice: 'af_heart' });
    const a = kokoroTexts().sort();
    reset();
    await post('/voice/synthesize/stream', { text: marked, voice: 'af_heart' });
    const b = kokoroTexts().sort();
    assert.ok(a.length > 0);
    assert.deepEqual(b, a, 'identical Kokoro requests');
    for (const t of b) assert.deepEqual(form.bracketedTokens(t), [], t);
  });
});

test('Kokoro fallback for a merged sentence renders the original phrases, as Kokoro-only would', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset();
    await post('/voice/synthesize/stream', { text: COMMA_DENSE, voice: 'af_heart' });
    const kokoroOnly = kokoroTexts().sort();
    assert.ok(kokoroOnly.length > 2, `the Kokoro reply is phrased: ${kokoroOnly.length}`);

    reset(() => ({ status: 401, body: { detail: { code: 'invalid_api_key' } } }));
    const r = await post('/voice/synthesize/stream', { text: COMMA_DENSE, voice: 'af_heart', elevenlabs: CONFIG });
    const out = lines(r.buf);
    assert.equal(out[out.length - 1].engine_fallback, 'invalid_key');
    assert.deepEqual(kokoroTexts().sort(), kokoroOnly,
      'the same Kokoro requests (text, contour) as a Kokoro-only reply');
  });
});

test('incremental: a batch seam is not a cold start (previous_text and next_text across batches)', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const first = 'The first batch ends here with a full sentence.';
    const second = 'The second batch begins after the seam.';
    const tail = ' And more text is still arriving';

    // Second batch of a finished reply: the text before the offset is context.
    reset();
    const text = `${first} ${second}`;
    const r = await post('/voice/synthesize/incremental',
      { text, offset: first.length + 1, sequence: 1, final: true, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    assert.equal(el.calls.length, 1);
    assert.equal(el.calls[0].body.text, second);
    assert.equal(el.calls[0].body.previous_text, first, 'the seam carries the text before it');
    assert.equal(el.calls[0].body.next_text, undefined, 'a final batch has nothing after it');

    // A mid-reply batch: the unfinished text after it is context too.
    reset();
    const r2 = await post('/voice/synthesize/incremental',
      { text: `${first}${tail}`, offset: 0, sequence: 0, final: false, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r2.status, 200);
    assert.equal(el.calls.length, 1);
    assert.equal(el.calls[0].body.text, first);
    assert.equal(el.calls[0].body.previous_text, undefined);
    assert.equal(el.calls[0].body.next_text, tail.trim());

    // The context is engine form as well: a marker before the seam is not sent.
    reset();
    const marked = `[OUTPUT] ${first} [warm]`;
    await post('/voice/synthesize/incremental',
      { text: `${marked} ${second}`, offset: marked.length + 1, sequence: 1, final: true, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(el.calls[0].body.previous_text, first);

    // Kokoro-only incremental requests carry no context and are unchanged.
    reset();
    await post('/voice/synthesize/incremental',
      { text, offset: first.length + 1, sequence: 1, final: true, voice: 'af_heart' });
    assert.equal(el.calls.length, 0);
    assert.ok(kokoroTexts().length > 0);
    for (const t of kokoroTexts()) assert.ok(!t.includes('first batch'), `no context reached Kokoro: ${t}`);
  });
});

test('incremental: raw stream text with markers reaches neither engine (D5 survival path)', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const raw = '[OUTPUT] Here it is. [warm] The plan works.\n\n- [ ] first task\n- [x] second task\n\n'
      + '[[TRAVEL_RESEARCH_FORM]] See the notes [1]. [private-conversation]';
    for (const elevenlabs of [undefined, CONFIG]) {
      reset();
      const r = await post('/voice/synthesize/incremental',
        { text: raw, offset: 0, sequence: 0, final: true, voice: 'af_heart', elevenlabs });
      assert.equal(r.status, 200);
      const end = lines(r.buf).pop();
      assert.equal(end.type, 'end', JSON.stringify(end));
      const sent = elevenlabs ? el.calls.map((c) => JSON.stringify(c.body)) : kokoroTexts();
      assert.ok(sent.length > 0);
      for (const t of sent) {
        assert.deepEqual(form.bracketedTokens(t), [], t);
        assert.ok(!/OUTPUT|warm|TRAVEL|private-conversation/u.test(t), t);
      }
    }
  });
});

// ===========================================================================
// THE CALIBRATION HARNESS (deliverable 3)
// ===========================================================================

test('the sweep renders every case through the production adapter, one command, key never written', async () => {
  const { spawn } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const out = join(WORK, 'sweep');
  const script = join(HERE, '..', '..', 'scripts', 'el-punctuation-sweep.mjs');
  const run = (argv, env) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...argv], { env: { ...process.env, ...env } });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', (code) => resolveRun({ code, text }));
  });

  reset();
  const r = await run(['--out', out], { ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_VOICE_ID: VOICE_ID });
  assert.equal(r.code, 0, r.text);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.ok(manifest.cases.length >= 30, `the sweep floor: ${manifest.cases.length}`);
  for (const group of ['D2', 'D3', 'D4']) {
    assert.ok(manifest.cases.some((c) => c.group === group), group);
  }
  const wavs = readdirSync(out).filter((f) => f.endsWith('.wav'));
  assert.equal(wavs.length, manifest.cases.length, 'one WAV per case');
  for (const f of wavs) {
    const wav = readFileSync(join(out, f));
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', f);
    assert.equal(wav.readUInt32LE(24), 24000, `${f} is 24 kHz`);
  }
  // The decisive break case went out raw; the D4 context case sent neighbours.
  assert.ok(el.calls.some((c) => String(c.body.text).includes('<break time="0.5s" />')));
  assert.ok(el.calls.some((c) => c.body.previous_text === 'When the test finished,'));
  for (const c of el.calls) assert.deepEqual(form.bracketedTokens(JSON.stringify(c.body)), []);
  // Key custody: nowhere in what the harness wrote or printed.
  const written = readdirSync(out).filter((f) => !f.endsWith('.wav'))
    .map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
  assert.ok(written.includes('RESULTS-TEMPLATE') || written.includes('# W7 calibration results'));
  assert.ok(!written.includes(EL_KEY) && !r.text.includes(EL_KEY), 'the key is never written');

  // A failing render is named by reason, and the exit code says so.
  reset(() => ({ status: 401, body: { detail: { code: 'invalid_api_key' } } }));
  const bad = await run(['--out', join(WORK, 'sweep-bad'), '--only', 'd4'],
    { ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_VOICE_ID: VOICE_ID });
  assert.equal(bad.code, 1, bad.text);
  assert.match(bad.text, /FAILED d4-sentence-seam-cold \(invalid_key 401\)/u);
  assert.ok(!bad.text.includes(EL_KEY));

  // Usage errors exit 2 and send nothing.
  reset();
  const usage = await run(['--out', join(WORK, 'x')], { ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' });
  assert.equal(usage.code, 2);
  assert.equal(el.calls.length, 0);
});
