// src/tests/voice-engine-form.test.js
//
// Work order W7 rev 2.1 (2026-10-06), which supersedes rev 1.1: the three-class
// partition, the closed-vocabulary registry, the divergent engine profiles, the
// tag switch, the split guards G1 to G4, and the probe. Connector v13.36.0.
//
// What this file proves, in the work order's terms (section 12):
//
//   T1  Class C forms survive verbatim: [**Note**], a[i], [Enter], [1],
//       [label](url), and a [warm] inside a code span.
//   T2  Class A and Class B handled per profile and per switch state.
//   T3  Idempotence, both profiles, both switch states.
//   T4  Byte-equality: with no Class A or B present the payload is the input;
//       with a marker present it is the input with that marker removed.
//   T5  Breaking G2 fails a test (the Kokoro builder refuses a cue that
//       bypassed the formatter; the old builder-side strip is gone).
//   T6  Floor: G4's classification count is non-zero on a bracket fixture.
//   D6  The registry is read from the register grammar file, both ways.
//
// Plus the paths: one ElevenLabs generation per sentence, context across
// incremental batches, the Kokoro fallback, the tag switch end to end, model
// attribution in the log, the probe route (section 6), and the per-model
// calibration harness (deliverable 10).
//
// ElevenLabs is a local fake that records each request; Kokoro is
// fixtures/fake-kokoro-once.mjs behind the real one-shot supervisor, which logs
// the exact text each Kokoro call received.

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
// Everything printed, for the log assertions and key custody.
// ---------------------------------------------------------------------------
const printed = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { printed.push(args.map(String).join(' ')); original(...args); };
}

// ---------------------------------------------------------------------------
// The fake ElevenLabs service: text-to-speech and speech-to-text.
// ---------------------------------------------------------------------------
const el = { calls: [], script: () => null };
const elServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let body = {};
    try { body = JSON.parse(raw.toString('utf8')); } catch (err) { /* multipart or empty */ }
    const call = { path: req.url, body, key: req.headers['xi-api-key'], n: el.calls.length };
    el.calls.push(call);
    const outcome = el.script(call) || {};
    const extra = outcome.headers || {};
    if (outcome.status && 200 !== outcome.status) {
      res.writeHead(outcome.status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(outcome.body || { detail: { code: 'some_error' } }));
      return;
    }
    if (String(req.url).startsWith('/v1/speech-to-text')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify({ text: '', language_code: 'en' }));
      return;
    }
    const letters = String(body.text || '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const samples = Math.max(1, Math.round((letters / 15) * 24000));
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(EL_LEVEL, i * 2);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'request-id': 'req-123', ...extra });
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
delete process.env.ELEVENLABS_STT_MODEL;

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
const CONFIG = { api_key: EL_KEY, voice_id: VOICE_ID, model_id: 'eleven_multilingual_v2',
                 model_id_source: 'user' };
const CONFIG_TAGS = { ...CONFIG, tags: true };
const EL_CFG = { apiKey: EL_KEY, voiceId: VOICE_ID, modelId: 'eleven_multilingual_v2' };

function kokoroTexts() {
  if (!existsSync(ENGINE_LOG)) return [];
  return readFileSync(ENGINE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
}
function ttsCalls() { return el.calls.filter((c) => String(c.path).startsWith('/v1/text-to-speech')); }
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
const quiet = { log: false };
const K = (t) => form.toEngineForm(t, 'kokoro', quiet);
const ELoff = (t, env) => form.toEngineForm(t, 'elevenlabs', { ...quiet, env: env || {} });
const ELon = (t, env) => form.toEngineForm(t, 'elevenlabs', { ...quiet, tags: true, env: env || {} });

// ===========================================================================
// THE REGISTRY (sections 3.2, 3.7; D6). Read from the file, not code.
// ===========================================================================

const GRAMMAR = JSON.parse(readFileSync(join(HERE, '..', 'voice', 'register-grammar.v1.json'), 'utf8'));
const FILE_TOKENS = ['A', 'B'].flatMap((c) => GRAMMAR.classes[c].tokens.map((t) => `${c} ${t.token}`));

test('D6 floor: the registry is the register grammar file, both ways, A and B non-empty', () => {
  // The floor first: an emptied file cannot make the comparisons pass.
  assert.ok(GRAMMAR.classes.A.tokens.length > 0, 'Class A has tokens');
  assert.ok(GRAMMAR.classes.B.tokens.length > 0, 'Class B has tokens');
  assert.equal(form.REGISTRY_VERSION, GRAMMAR.version);
  const loaded = form.REGISTRY.entries.map((e) => `${e.cls} ${e.token}`);
  for (const t of FILE_TOKENS) assert.ok(loaded.includes(t), `the formatter lacks ${t}`);
  for (const t of loaded) assert.ok(FILE_TOKENS.includes(t), `the formatter has ${t}, absent from the file`);
  assert.equal(form.TAG_FIXTURE, GRAMMAR.fixtures.tag_capability, 'the section 7.1 fixture comes from the file');
  // Every spelling of every entry classifies as its own class.
  for (const e of form.REGISTRY.entries) {
    for (const spelling of e.spellings) {
      const { tokens } = form.classifyBrackets(`x ${spelling} y`);
      assert.equal(tokens.length, 1, spelling);
      assert.equal(tokens[0].cls, e.cls, spelling);
    }
  }
});

test('D6 floor: a malformed or emptied registry refuses to load rather than strip nothing', () => {
  const good = JSON.parse(JSON.stringify(GRAMMAR));
  assert.equal(form.parseRegistry(good).entries.length, form.REGISTRY.entries.length, 'the shipped file parses');
  const emptyA = JSON.parse(JSON.stringify(GRAMMAR));
  emptyA.classes.A.tokens = [];
  assert.throws(() => form.parseRegistry(emptyA), /class A has no tokens/u);
  const noB = JSON.parse(JSON.stringify(GRAMMAR));
  delete noB.classes.B;
  assert.throws(() => form.parseRegistry(noB), /class B has no tokens/u);
  const malformed = JSON.parse(JSON.stringify(GRAMMAR));
  malformed.classes.B.tokens.push({ token: 'warm' });
  assert.throws(() => form.parseRegistry(malformed), /malformed token "warm"/u);
  const noVersion = JSON.parse(JSON.stringify(GRAMMAR));
  delete noVersion.version;
  assert.throws(() => form.parseRegistry(noVersion), /no version/u);
});

test('the source names Class A and B only through the registry (no vocabulary in code)', () => {
  const src = readFileSync(join(HERE, '..', 'voice', 'engine-form.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  for (const e of form.REGISTRY.entries) {
    assert.ok(!src.includes(`'${e.token}'`) && !src.includes(`"${e.token}"`),
      `${e.token} is written in the code, not only in the registry`);
  }
});

// ===========================================================================
// T1 to T4: the profiles (sections 2, 4)
// ===========================================================================

const T1_FIXTURE = '[**Note**] check a[i], press [Enter], see [1] and [label](https://x.y/z), '
  + 'and write `[warm]` to ask for warmth.';

test('T1: Class C forms survive verbatim, in both profiles and both switch states', () => {
  for (const [name, f] of [['kokoro', K], ['elevenlabs off', ELoff], ['elevenlabs on', ELon]]) {
    assert.equal(f(T1_FIXTURE), T1_FIXTURE, name);
  }
  // More content forms: indexers, footnotes, years, key names, links whose
  // label is a registry word, misaki markup, a fenced block quoting a cue,
  // unregistered tag-shaped words, capitalised cue words.
  const more = [
    'm[1][2] and array[0] and f(a[i]).',
    'See note [^3] from [2024].',
    'Use [Ctrl] + [C].',
    'The [warm](https://example.com/warm) link and [tomato](/təˈmɑːtoʊ/).',
    '```\n[OUTPUT] [pause]\n```\nafter the block.',
    '[whispers] and [sighs heavily] and [Warm] and [PAUSE].',
    '- [ ] a task and - [x] a done task',
  ];
  for (const t of more) {
    assert.equal(K(t), t, `kokoro: ${t}`);
    assert.equal(ELon(t), t, `elevenlabs on: ${t}`);
  }
});

test('T2: Class A always removed; Class B removed for Kokoro and with the switch off, kept with it on', () => {
  const t = '[OUTPUT] The answer is [warm] ready. [pause] Next [[RECREATION_PANEL]] step.';
  assert.equal(K(t), 'The answer is ready. Next step.');
  assert.equal(ELoff(t), 'The answer is ready. Next step.');
  assert.equal(ELon(t), 'The answer is [warm] ready. [pause] Next step.');
  // Emphasis-wrapped cues are registry members, written in their registered
  // spelling when kept, removed otherwise.
  assert.equal(ELon('[**warm**] Hello.'), '[warm] Hello.');
  assert.equal(K('[**warm**] Hello.'), 'Hello.');
  assert.equal(K('[_pause_] Hello.'), 'Hello.');
  // The incremental route's stripper turns underscore pairs into nothing.
  assert.equal(K('[[TRAVELRESEARCH_FORM]] then [[RECREATIONPANEL]] go.'), 'then go.');
  // Both registered spellings of one cue.
  assert.equal(ELon('A [drawn-out] b [drawn out] c.'), 'A [drawn-out] b [drawn out] c.');
  assert.equal(K('A [drawn-out] b [drawn out] c.'), 'A b c.');
  // A control line goes with its line; the newline stays.
  assert.equal(K('Question.\n[exam-state] phase=questions discipline=Organic chemistry q=1 of 5\nWhat is it?'),
    'Question.\n\nWhat is it?');
  assert.equal(K('[EXAM-STATE] phase=review'), '', 'the exam-state entry is case-insensitive, as its consumer is');
  // Case-sensitive entries stay content in another case, as the client does.
  assert.equal(K('[output] is what I typed'), '[output] is what I typed');
});

test('T3: idempotent, both profiles, both switch states, rules off and on', () => {
  const allOn = { ELEVENLABS_PUNCTUATION: 'colon=period,semicolon=period,emdash=comma,ellipsis=comma,parentheses=comma' };
  const inputs = [
    T1_FIXTURE,
    '[OUTPUT] The answer is [warm] ready. [pause] Next [[RECREATION_PANEL]] step.',
    '[warm][pause] x', 'a [pause]. b', 'ready.[warm] next', '[**warm**] hi [_softly_]',
    'Question.\n[exam-state] phase=q\nWhat?', 'Note: this; that \u2014 other… (aside) end.',
  ];
  for (const text of inputs) {
    for (const [name, f] of [['kokoro', K], ['off', (x) => ELoff(x)], ['on', (x) => ELon(x)],
                             ['on+rules', (x) => ELon(x, allOn)]]) {
      const once = f(text);
      assert.equal(f(once), once, `${name}: ${JSON.stringify(text)}`);
    }
  }
});

test('T4: with no Class A or B present the payload is the input, byte for byte', () => {
  const corpus = [
    'Here is the plan: first, we test; then we ship \u2014 carefully.',
    'Café naïve \u2014 l’été, it’s “quoted”, señor.',
    'Time 10:30, ratio 3:1, https://example.com/a:b, cost-benefit 2019\u20132024.',
    'Wait… or wait... and (an aside) here.',
    '**Bold** and `code` and a [link](https://x.y) and [Enter] and a[i].',
    '- first item\n- second item\n\n1. numbered',
    'Unicode: 你好, مرحبا, 😀 emoji, ß and Å.',
    T1_FIXTURE,
  ];
  for (const text of corpus) {
    assert.equal(K(text), text, `kokoro: ${text}`);
    assert.equal(ELoff(text), text, `elevenlabs: ${text}`);
  }
});

test('section 4.1: a removed marker takes one separating space and no other byte', () => {
  const cases = [
    ['The cost [warm] is real.', 'The cost is real.'],
    ['[OUTPUT] Here it is.', 'Here it is.'],
    ['It is fine [pause].', 'It is fine.'],
    ['It is ready. [softly]', 'It is ready.'],
    ['ready.[warm] next', 'ready. next'],
    ['line one\n[TRACE] line two', 'line one\nline two'],
  ];
  for (const [input, expected] of cases) assert.equal(K(input), expected, input);
  // A removal that brings a token together ("[pa" + "use]") is removed on the
  // next pass, so the result is a fixed point (T3) rather than one pass deep.
  assert.equal(K('[pa[pause]use] x'), 'x');
  // An emphasis wrapper goes with its token, rather than leaving `****`.
  assert.equal(K('A **[warm]** b'), 'A b');
  assert.equal(K('A _[pause]_ b.'), 'A b.');
  assert.equal(K('x **[OUTPUT]** y'), 'x y');
  assert.equal(K('A **bold** [warm] b'), 'A **bold** b', 'emphasis that does not wrap the token is kept');
  assert.equal(form.removeClasses('[OUT[TRACE]PUT] y'), 'y');
});

test('the Kokoro profile never keeps a cue, whatever tags says (no tag channel for Kokoro)', () => {
  assert.equal(form.toEngineForm('[warm] Hello [pause] there.', 'kokoro', { ...quiet, tags: true }), 'Hello there.');
});

test('Unicode: accents, apostrophes and non-Latin scripts survive both profiles', () => {
  const text = 'Café naïve l’été it’s señor ß Å 你好 [warm] مرحبا';
  assert.equal(K(text), 'Café naïve l’été it’s señor ß Å 你好 مرحبا');
  assert.equal(ELon(text), text);
});

test('section 3.5: unknown bracket tokens are logged, never transformed', () => {
  const before = printed.length;
  const t = 'A [whispers] cue, a [sighs heavily] cue, and [Enter].';
  assert.equal(form.toEngineForm(t, 'kokoro', { where: 'unit test' }), t);
  const logged = printed.slice(before).join('\n');
  assert.match(logged, /engine-form unit test: 3 unregistered bracket token\(s\) left as content: \[whispers\] \[sighs heavily\]/u);
  assert.ok(!logged.includes('[Enter]'), 'non-tag content is counted, not quoted');
  const quietBefore = printed.length;
  form.toEngineForm('No brackets at all.', 'kokoro', { where: 'unit test' });
  assert.equal(printed.length, quietBefore, 'nothing is logged for a reply without brackets');
});

test('section 3.4 and 3.6: a code span is content; prose about a marker outside one is the marker', () => {
  assert.equal(K('Write `[pause]` for a pause.'), 'Write `[pause]` for a pause.');
  assert.equal(K('Write [pause] for a pause.'), 'Write for a pause.',
    'the stated limitation (3.6): unquoted, the marker is the marker');
});

// ===========================================================================
// THE GUARDS (section 8), T5, T6
// ===========================================================================

test('T6 floor: G4 classifies and counts every bracket token of a bracket fixture', () => {
  const fixture = `${T1_FIXTURE} [OUTPUT] [warm] [whispers]`;
  const { counts } = form.classifyBrackets(fixture);
  assert.ok(counts.total > 0, 'the scan saw the brackets');
  assert.equal(counts.total, counts.A + counts.B + counts.C);
  assert.deepEqual({ A: counts.A, B: counts.B }, { A: 1, B: 1 });
  const before = printed.length;
  form.guardRequest(T1_FIXTURE, { builder: 'kokoro', where: 'g4 test' });
  assert.match(printed.slice(before).join('\n'), /engine-form g4 test: brackets=\d+ A=0 B=0 content=\d+ unknown=\d+/u);
});

test('G1: a channel token in any field is refused by both builders, the text never echoed', async () => {
  await assert.rejects(engines.synthesizePcm({ text: '[OUTPUT] Hello there.', voice: 'af_heart' }),
    (err) => 'tagged_text' === err.code && 'G1' === err.guard && !err.message.includes('OUTPUT'));
  for (const field of ['text', 'previousText', 'nextText']) {
    reset();
    await assert.rejects(adapter.synthesizeElevenLabsPcm({ config: { ...EL_CFG, tags: true },
      text: 'Clean.', sampleRate: 24000, [field]: 'A [TRACE] marker.' }),
    (err) => 'G1' === err.guard, field);
    assert.equal(el.calls.length, 0, `${field}: nothing was sent`);
  }
});

test('T5 / G2: the Kokoro builder refuses a prosody cue that bypassed the formatter', async () => {
  reset();
  await assert.rejects(engines.synthesizePcm({ text: '[warm] Hello there.', voice: 'af_heart' }),
    (err) => 'tagged_text' === err.code && 'G2' === err.guard && !err.message.includes('warm'));
  assert.deepEqual(kokoroTexts(), [], 'Kokoro was not called');
  // Content in brackets passes the Kokoro builder.
  await engines.synthesizePcm({ text: 'Press [Enter] and see [1] or a[i].', voice: 'af_heart' });
  assert.equal(kokoroTexts().length, 1);
  // The entries remove cues before analysis, so a reply reaches Kokoro clean,
  // including a cue wrapped in emphasis that preparation would uncover.
  reset();
  await engines.synthesize({ text: '[**warm**] Hello there. [pause] Bye.', voice: 'af_heart' });
  await engines.synthesizeProsody({ text: '[**warm**] Hello there. [pause] Bye.', voice: 'af_heart' });
  for (const t of kokoroTexts()) assert.equal(form.classifyBrackets(t).counts.B, 0, t);
  // A link whose LABEL is a registry token is content where it is classified;
  // flattening uncovers the bare token. Never a refusal (Kokoro has no
  // fallback), and removed the same way the ElevenLabs path removes it.
  reset();
  await engines.synthesizePcm({ text: 'See [[warm](https://x.y)] now and [[OUTPUT](z)] here.', voice: 'af_heart' });
  assert.equal(kokoroTexts().length, 1, 'rendered, not refused');
  assert.equal(form.classifyBrackets(kokoroTexts()[0]).counts.A + form.classifyBrackets(kokoroTexts()[0]).counts.B, 0,
    kokoroTexts()[0]);
  assert.equal(engines.elevenLabsEngineText('See [[warm](https://x.y)] now and [[OUTPUT](z)] here.'),
    'See now and here.', 'the two engines agree');
});

test('G3: the ElevenLabs builder admits cues only with the switch on, and only well formed', async () => {
  reset();
  await assert.rejects(adapter.synthesizeElevenLabsPcm({ config: EL_CFG, text: 'Hi [warm] there.', sampleRate: 24000 }),
    (err) => 'G3' === err.guard);
  await assert.rejects(adapter.synthesizeElevenLabsPcm({ config: { ...EL_CFG, tags: true },
    text: 'Hi [**warm**] there.', sampleRate: 24000 }), (err) => 'G3' === err.guard, 'malformed cue');
  assert.equal(el.calls.length, 0);
  await adapter.synthesizeElevenLabsPcm({ config: { ...EL_CFG, tags: true }, text: 'Hi [warm] there.', sampleRate: 24000 });
  assert.equal(el.calls.length, 1);
  assert.equal(el.calls[0].body.text, 'Hi [warm] there.');
  // Content passes either way.
  reset();
  await adapter.synthesizeElevenLabsPcm({ config: EL_CFG, text: 'Press [Enter] now.', sampleRate: 24000 });
  assert.equal(el.calls[0].body.text, 'Press [Enter] now.');
});

// ===========================================================================
// THE PUNCTUATION RULES, unchanged from rev 1.1 (still OFF, D2 to D4 gate)
// ===========================================================================

test('punctuation rules ship OFF: the ElevenLabs profile keeps every mark', () => {
  const text = 'Note: this; that \u2014 other… (aside) end.';
  assert.deepEqual(form.punctuationChoices({}).choices, {});
  for (const rule of Object.values(form.RULES)) assert.equal(rule.state, 'off');
  assert.equal(ELoff(text), text);
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
    assert.equal(ELoff(input, { ELEVENLABS_PUNCTUATION: setting }), expected, setting);
  }
});

test('break tags: only when verified, never on v3 or v4, at most BREAK_LIMIT per generation', () => {
  const text = 'A: b. C: d. E: f.';
  const on = { ELEVENLABS_PUNCTUATION: 'colon=break', ELEVENLABS_BREAK_TAGS_VERIFIED: 'true' };
  const v2 = form.toEngineForm(text, 'elevenlabs', { ...quiet, env: on, modelId: 'eleven_multilingual_v2' });
  assert.equal((v2.match(/<break time="0\.5s" \/>/gu) || []).length, form.BREAK_LIMIT, v2);
  assert.equal(form.BREAK_LIMIT, 2);
  for (const model of ['eleven_v3', 'eleven_v4']) {
    assert.ok(!form.toEngineForm(text, 'elevenlabs', { ...quiet, env: on, modelId: model }).includes('<break'), model);
  }
  assert.equal(form.toEngineForm(text, 'elevenlabs',
    { ...quiet, env: { ELEVENLABS_PUNCTUATION: 'colon=break' }, modelId: 'eleven_multilingual_v2' }),
  'A. b. C. d. E. f.', 'not verified: a full stop, never a tag');
  // A break tag survives the ElevenLabs preparation unchanged.
  assert.equal(form.prepareForElevenLabs(v2), v2);
});

test('unknown punctuation entries are ignored; prose comma stripping is not a rule', () => {
  const { choices, ignored } = form.punctuationChoices({ ELEVENLABS_PUNCTUATION: 'colon=period,comma=period,colon2=x' });
  assert.deepEqual(choices, { colon: 'period' });
  assert.deepEqual(ignored, ['comma=period', 'colon2=x']);
});

test('the ElevenLabs preparation: links and bold flattened, words kept, no contour comma', () => {
  assert.equal(form.prepareForElevenLabs('**Bold** move, then [read this](https://x.y) and `run it`'),
    'Bold move, then read this and `run it`');
  assert.equal(form.prepareForElevenLabs('Set my_var_name, use *args and **kwargs.'),
    'Set my_var_name, use *args and **kwargs.');
  assert.equal(form.prepareForElevenLabs('The first part'), 'The first part');
  // The synthesis paths run this preparation BEFORE classification, so the
  // engine text is flattened, not just classified.
  assert.equal(engines.elevenLabsEngineText('**Bold** move, then [read this](https://x.y) [warm] now.'),
    'Bold move, then read this now.');
  assert.equal(engines.elevenLabsEngineText('**Bold** move [warm] now.', { tags: true }), 'Bold move [warm] now.');
});

// ===========================================================================
// THE PATHS
// ===========================================================================

const COMMA_DENSE = 'First, we read the specification carefully; then, we test it: slowly, '
  + 'deliberately, and well. The second sentence follows it, briefly.';

test('stream: one ElevenLabs generation per sentence, none ending on a comma, colon or semicolon', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset();
    const r = await post('/voice/synthesize/stream', { text: COMMA_DENSE, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(r.status, 200);
    const texts = ttsCalls().map((c) => c.body.text);
    assert.equal(texts.length, 2, `one generation per sentence: ${JSON.stringify(texts)}`);
    for (const t of texts) assert.match(t, /[.!?]$/u, `ends on a terminator: ${t}`);
    assert.equal(ttsCalls()[0].body.next_text, texts[1], 'the neighbour is sent');
    assert.equal(ttsCalls()[1].body.previous_text, texts[0]);
    assert.deepEqual(kokoroTexts(), [], 'Kokoro did not speak');
  });
});

test('the tag switch end to end: off strips cues, on sends them, Class A always stripped', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const reply = '[OUTPUT] The plan is ready. [warm] We start tomorrow. [pause] Then we review it.';
    for (const [path, extra] of [['/voice/synthesize', { prosody: 'on' }], ['/voice/synthesize/stream', {}],
                                 ['/voice/synthesize/incremental', { offset: 0, sequence: 0, final: true }]]) {
      reset();
      await post(path, { text: reply, voice: 'af_heart', elevenlabs: CONFIG, ...extra });
      const off = ttsCalls().map((c) => JSON.stringify(c.body)).join('\n');
      assert.ok(off.length > 0, path);
      assert.ok(!/\[warm\]|\[pause\]|OUTPUT/u.test(off), `${path} switch off: ${off}`);
      reset();
      await post(path, { text: reply, voice: 'af_heart', elevenlabs: CONFIG_TAGS, ...extra });
      const on = ttsCalls().map((c) => c.body.text).join(' ');
      assert.ok(on.includes('[warm]') && on.includes('[pause]'), `${path} switch on: ${on}`);
      assert.ok(!on.includes('OUTPUT'), `${path}: Class A never sent`);
      assert.deepEqual(kokoroTexts(), [], `${path}: Kokoro did not speak`);
    }
  });
});

test('tag switch on, ElevenLabs failing: Kokoro renders the reply with no cue and no empty-text fault', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset(() => ({ status: 401, body: { detail: { code: 'invalid_api_key' } } }));
    const r = await post('/voice/synthesize/stream',
      { text: 'We start now. [pause] Then, [warm] we review it, slowly.', voice: 'af_heart', elevenlabs: CONFIG_TAGS });
    const out = lines(r.buf);
    const end = out[out.length - 1];
    assert.equal(end.type, 'end', JSON.stringify(end));
    assert.equal(end.engine_fallback, 'invalid_key');
    assert.ok(kokoroTexts().length > 0);
    for (const t of kokoroTexts()) assert.equal(form.classifyBrackets(t).counts.B, 0, `Kokoro got a cue: ${t}`);
  });
});

test('Kokoro: a reply with markers is spoken exactly as the same reply without them', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const clean = 'The plan is ready. We start tomorrow, early.\n\nThen we review it.';
    const marked = '[OUTPUT] The plan is ready. [warm] We start tomorrow, early. [[RECREATION_PANEL]]\n\n'
      + '[pause] Then we review it.';
    reset();
    await post('/voice/synthesize/stream', { text: clean, voice: 'af_heart' });
    const a = kokoroTexts().sort();
    reset();
    await post('/voice/synthesize/stream', { text: marked, voice: 'af_heart' });
    const b = kokoroTexts().sort();
    assert.ok(a.length > 0);
    assert.deepEqual(b, a, 'identical Kokoro requests');
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
    assert.equal(lines(r.buf).pop().engine_fallback, 'invalid_key');
    assert.deepEqual(kokoroTexts().sort(), kokoroOnly);
  });
});

test('incremental: a batch seam is not a cold start, and its context is engine form', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const first = 'The first batch ends here with a full sentence.';
    const second = 'The second batch begins after the seam.';
    reset();
    await post('/voice/synthesize/incremental',
      { text: `${first} ${second}`, offset: first.length + 1, sequence: 1, final: true, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(ttsCalls()[0].body.text, second);
    assert.equal(ttsCalls()[0].body.previous_text, first);
    reset();
    const marked = `[OUTPUT] ${first} [warm]`;
    await post('/voice/synthesize/incremental',
      { text: `${marked} ${second}`, offset: marked.length + 1, sequence: 1, final: true, voice: 'af_heart', elevenlabs: CONFIG });
    assert.equal(ttsCalls()[0].body.previous_text, first);
    reset();
    await post('/voice/synthesize/incremental',
      { text: `${marked} ${second}`, offset: marked.length + 1, sequence: 1, final: true, voice: 'af_heart', elevenlabs: CONFIG_TAGS });
    assert.equal(ttsCalls()[0].body.previous_text, `${first} [warm]`, 'with the switch on the context keeps its cue');
  });
});

test('incremental: raw stream text, every class, both engines', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    const raw = '[OUTPUT] Here it is. [warm] The plan works.\n\n[[TRAVEL_RESEARCH_FORM]] See note [1] and press '
      + '[Enter]. [private-conversation]\n[exam-state] phase=questions q=1 of 5\nNext question.';
    for (const elevenlabs of [undefined, CONFIG, CONFIG_TAGS]) {
      reset();
      const r = await post('/voice/synthesize/incremental',
        { text: raw, offset: 0, sequence: 0, final: true, voice: 'af_heart', elevenlabs });
      assert.equal(lines(r.buf).pop().type, 'end');
      const sent = elevenlabs ? ttsCalls().map((c) => c.body.text) : kokoroTexts();
      const all = sent.join('\n');
      assert.ok(sent.length > 0);
      assert.ok(!/OUTPUT|TRAVEL|private-conversation|exam-state|phase=/u.test(all), all);
      assert.ok(all.includes('[1]') && all.includes('[Enter]'), `content kept: ${all}`);
      assert.equal(all.includes('[warm]'), elevenlabs === CONFIG_TAGS, `cue only with the switch on: ${all}`);
    }
  });
});

test('model attribution: the id in force and its source are on the ElevenLabs log line', async () => {
  await withEnv({ VOICE_PROSODY_ENABLED: 'true' }, async () => {
    reset();
    const before = printed.length;
    await post('/voice/synthesize', { text: 'Hello there.', voice: 'af_heart', prosody: 'on', elevenlabs: CONFIG });
    await post('/voice/synthesize', { text: 'Hello there.', voice: 'af_heart', prosody: 'on',
      elevenlabs: { api_key: EL_KEY, voice_id: VOICE_ID } });
    const logged = printed.slice(before).join('\n');
    assert.match(logged, /\[voice\] tts voice=elevenlabs .*el_model=eleven_multilingual_v2 el_model_source=user/u);
    assert.match(logged, /el_model=eleven_multilingual_v2 el_model_source=connector_default/u);
    assert.deepEqual(adapter.parseElevenLabsConfig({ ...CONFIG, model_id_source: 'gateway_default' }).config.modelSource,
      'gateway_default');
    assert.equal(adapter.parseElevenLabsConfig({ api_key: EL_KEY, voice_id: VOICE_ID, model_id: 'eleven_v3' }).config.modelSource,
      'request');
    assert.equal(adapter.parseElevenLabsConfig({ ...CONFIG, tags: 'yes' }).config.tags, false, 'only true is on');
  });
});

// ===========================================================================
// THE PROBE (section 6)
// ===========================================================================

test('probe tts: the real adapter and engine-text path, verdict, headers, attribution, audio', async () => {
  reset();
  const r = await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG, capability: 'tts' });
  assert.equal(r.status, 200);
  const a = JSON.parse(r.buf.toString('utf8'));
  assert.equal(a.verdict, 'accepted');
  assert.equal(a.http_status, 200);
  assert.equal(a.text_sent, form.WORD_FIXTURE, 'the one-word fixture by default');
  assert.equal(a.model_id_in_force, 'eleven_multilingual_v2');
  assert.equal(a.model_id_source, 'user');
  assert.equal(a.response_headers_of_interest['request-id'], 'req-123');
  assert.equal(a.model_echo, null, 'no header names a model, and none is claimed');
  assert.ok(a.audio_bytes > 0 && a.sample_rate === 24000);
  assert.equal(Buffer.from(a.audio_wav_base64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(!r.buf.toString('utf8').includes(EL_KEY), 'the key is never returned');

  reset(() => ({ headers: { 'x-served-model': 'eleven_v3' } }));
  const echoed = JSON.parse((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG })).buf.toString('utf8'));
  assert.equal(echoed.model_echo, 'eleven_v3', 'a model the response states is reported as stated');
});

test('probe tts: the tag fixture, with the switch on and off', async () => {
  reset();
  const on = JSON.parse((await post('/voice/elevenlabs/probe',
    { elevenlabs: CONFIG_TAGS, fixture: 'tags' })).buf.toString('utf8'));
  assert.equal(on.text_sent, form.TAG_FIXTURE, 'the section 7.1 fixture, cues intact');
  assert.equal(ttsCalls()[0].body.text, form.TAG_FIXTURE);
  assert.equal(on.tags, true);
  reset();
  const off = JSON.parse((await post('/voice/elevenlabs/probe',
    { elevenlabs: CONFIG, fixture: 'tags' })).buf.toString('utf8'));
  assert.equal(form.classifyBrackets(off.text_sent).counts.B, 0, 'switch off: the cues are removed');
});

test('probe verdicts: rejected for 400/404/422, unverified for 401/402/429/5xx and no answer', async () => {
  for (const [status, verdict] of [[422, 'rejected'], [400, 'rejected'], [404, 'rejected'],
                                   [401, 'unverified'], [402, 'unverified'], [429, 'unverified'], [503, 'unverified']]) {
    reset(() => ({ status, body: { detail: { code: 'model_not_found' } } }));
    const a = JSON.parse((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG })).buf.toString('utf8'));
    assert.equal(a.verdict, verdict, String(status));
    assert.equal(a.http_status, status);
    assert.equal(a.vendor_error, 'model_not_found');
  }
  const prior = process.env.ELEVENLABS_API_BASE;
  try {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    process.env.ELEVENLABS_API_BASE = `http://127.0.0.1:${port}`;
    const a = JSON.parse((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG })).buf.toString('utf8'));
    assert.equal(a.verdict, 'unverified');
    assert.equal(a.http_status, null);
    assert.equal(a.local_error, 'unreachable');
  } finally {
    process.env.ELEVENLABS_API_BASE = prior;
  }
});

test('probe stt: the pinned model by default, a named one on request, verdict mapping', async () => {
  reset();
  const a = JSON.parse((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG, capability: 'stt' })).buf.toString('utf8'));
  assert.equal(a.verdict, 'accepted');
  assert.equal(a.model_id_in_force, 'scribe_v2');
  assert.equal(a.model_id_source, 'connector_stt_pin');
  assert.ok(el.calls.some((c) => String(c.path).startsWith('/v1/speech-to-text')));
  reset(() => ({ status: 422, body: { detail: { code: 'invalid_model' } } }));
  const b = JSON.parse((await post('/voice/elevenlabs/probe',
    { elevenlabs: CONFIG, capability: 'stt', stt_model_id: 'scribe_v9' })).buf.toString('utf8'));
  assert.equal(b.verdict, 'rejected');
  assert.equal(b.model_id_in_force, 'scribe_v9');
  assert.equal(b.model_id_source, 'request');
});

test('probe input validation: configuration, capability, fixture and text length', async () => {
  assert.equal((await post('/voice/elevenlabs/probe', {})).status, 422);
  assert.equal((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG, capability: 'tags' })).status, 422);
  assert.equal((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG, fixture: 'poem' })).status, 422);
  assert.equal((await post('/voice/elevenlabs/probe', { elevenlabs: CONFIG, text: 'x'.repeat(501) })).status, 422);
  assert.equal((await post('/voice/elevenlabs/probe',
    { elevenlabs: CONFIG, capability: 'stt', stt_model_id: 'Bad Id' })).status, 422);
});

// ===========================================================================
// THE CALIBRATION HARNESS (deliverable 10): one command, per model
// ===========================================================================

test('the sweep renders every case per model, the tag fixture included, key never written', async () => {
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
  const dir = join(out, 'eleven_multilingual_v2');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.model, 'eleven_multilingual_v2');
  assert.equal(manifest.registry, form.REGISTRY_VERSION);
  for (const group of ['D2', 'D3', 'D4', 'TAGS']) assert.ok(manifest.cases.some((c) => c.group === group), group);
  const wavs = readdirSync(dir).filter((f) => f.endsWith('.wav'));
  assert.equal(wavs.length, manifest.cases.length, 'one WAV per case');
  assert.ok(ttsCalls().some((c) => c.body.text === form.TAG_FIXTURE), 'the tag fixture went out with its cues');
  assert.ok(ttsCalls().some((c) => String(c.body.text).includes('<break time="0.5s" />')), 'the raw break case');
  const written = readdirSync(dir).filter((f) => !f.endsWith('.wav'))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.ok(!written.includes(EL_KEY) && !r.text.includes(EL_KEY), 'the key is never written');

  const other = await run(['--out', out, '--model', 'eleven_flash_v2_5', '--only', 'tags'],
    { ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_VOICE_ID: VOICE_ID });
  assert.equal(other.code, 0, other.text);
  assert.ok(existsSync(join(out, 'eleven_flash_v2_5', 'manifest.json')), 'a second model gets its own directory');
  assert.ok(existsSync(join(dir, 'manifest.json')), 'and the first is kept');

  reset();
  // A punctuation rule set in the operator's shell does not relabel the WAVs:
  // every case renders with the rules off, and candidates set their own.
  const clean = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const shellOut = join(WORK, 'sweep-shell');
  const shell = await run(['--out', shellOut, '--dry-run'], { ELEVENLABS_PUNCTUATION: 'colon=period,semicolon=period' });
  assert.equal(shell.code, 0, shell.text);
  assert.match(shell.text, /ELEVENLABS_PUNCTUATION is set in this shell; ignored for the sweep/u);
  const shellManifest = JSON.parse(readFileSync(join(shellOut, 'eleven_multilingual_v2', 'manifest.json'), 'utf8'));
  assert.deepEqual(shellManifest.cases.map((c) => c.sent), clean.cases.map((c) => c.sent));

  const usage = await run(['--out', join(WORK, 'x')], { ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' });
  assert.equal(usage.code, 2);
  assert.equal(el.calls.length, 0);
});

test('key custody: the user key appears in no log line', () => {
  assert.ok(el.calls.length >= 0);
  for (const line of printed) assert.ok(!line.includes(EL_KEY), line.slice(0, 120));
});
