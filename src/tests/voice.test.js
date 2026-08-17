// src/tests/voice.test.js
//
// Tenax Voice -- gate, GPL boundary, validation, catalogue, schema and the
// Section 16 behavioural acceptance criteria.
//
// Run: node --test src/tests/voice.test.js
//
// These tests need no engines. faster-whisper and Piper are not installed here
// and are not required: every assertion below is about the gate, the boundary,
// the contract and the compliance controls -- the parts that must be right
// BEFORE an engine is wired, and the parts that stay right when one fails.
//
// The GPL boundary block is the one Section 6.3 calls for: "maintain the
// separate-process boundary for GPL Piper (documented, verifiable in CI)".

import test           from 'node:test';
import assert         from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express        from 'express';
import Database       from 'better-sqlite3';

import { voiceEnabled, benchmarkState, gateState, requireVoiceEnabled,
         requireVoiceForUser, testUsers, resolveIdentity, userAllowed,
         voiceAvailableFor, USER_ID_HEADER, TENANT_ID_HEADER }
                      from '../voice/voice-gate.js';
import { parseMultipart, parseBoundary } from '../voice/multipart.js';
import { validateAudio, sniffFormat, wavDurationSeconds }
                      from '../voice/audio-validate.js';
import { voicePermitted, voicesForLanguage, catalogState, attributions,
         VOICE_CATALOG, TTS_LANGUAGES } from '../voice/voice-catalog.js';
import { initVoiceSchema, setVoiceSettings, getVoiceSettings, logVoiceUsage }
                      from '../voice/voice-schema.js';
import { voiceAvailableForAsync } from '../voice/voice-gate.js';
import { allowlistSource, parseAllowlist, currentAllowlist,
         ensureAllowlistFresh, allowlistState, resetAllowlistCache,
         allowlistConfigProblems }
                      from '../voice/voice-allowlist.js';
import { registerVoiceRoutes } from '../routes/voice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = join(HERE, '..', 'voice');

/** A real, minimal WAV. Silence, but structurally valid. */
function wav(seconds = 1, rate = 16000) {
  const data = Buffer.alloc(Math.round(rate * 2 * seconds));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A request object carrying the per-call identity the gate reads. */
function reqWith(userId, tenantId) {
  const headers = {};
  if (userId !== undefined && userId !== null) headers[USER_ID_HEADER] = userId;
  if (tenantId) headers[TENANT_ID_HEADER] = tenantId;
  return { headers };
}

/** Fetch headers for an identified caller. */
function asUser(userId, tenantId, extra) {
  const h = { ...(extra || {}) };
  if (userId) h['X-Tenax-User-Id'] = userId;
  if (tenantId) h['X-Tenax-Tenant-Id'] = tenantId;
  return h;
}

/**
 * Save and restore the voice environment around a test.
 *
 * ASYNC-AWARE, and it has to be. A plain try/finally restores the environment
 * when fn() RETURNS, which for an async function is immediately -- before a
 * single line of its body has run. The body then executes against the restored
 * environment, so a test that set VOICE_ENABLED=true would actually run with
 * voice off.
 *
 * That is not hypothetical: it silently turned "a non-allowlisted user gets a
 * 404" into a test that passed because voice was off entirely, which is a
 * different fact and a much weaker one. A false pass on a security gate is
 * worse than no test.
 */
function withEnv(vars, fn) {
  const prior = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];

  const restore = () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  let out;
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }

  // Restore only once the promise settles, so an async body runs inside the
  // environment it asked for.
  if (out && typeof out.then === 'function') {
    return out.then(
      (v) => { restore(); return v; },
      (e) => { restore(); throw e; },
    );
  }
  restore();
  return out;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

function makeApp() {
  const app = express();
  // Stand-in for the connector's authentication, which has already run by the
  // time these routes are reached in production.
  app.use((req, res, next) => { req.userId = 'test-user'; next(); });
  registerVoiceRoutes(app);
  return app;
}

// ===========================================================================
test('the gate defaults to OFF and only an explicit affirmative enables it', () => {
  const prior = process.env.VOICE_ENABLED;
  try {
    delete process.env.VOICE_ENABLED;
    assert.equal(voiceEnabled(), false, 'unset is off');

    // Inverted from the house style deliberately: SNAPSHOT_ENABLED and the
    // other fifteen flags read `!== "false"` and default ON. Voice ships with
    // an unresolved legal item and an unrun benchmark, so it must not enable
    // itself because a variable was forgotten.
    // Whitespace IS trimmed, deliberately: a trailing space in a Railway
    // variable is a common accident and "TRUE " plainly means true. The
    // strictness that matters is that a MISSPELLING does not enable voice.
    for (const v of ['', 'false', '0', 'no', 'off', 'ture', 'ture ', 'enabled', 'yes please']) {
      process.env.VOICE_ENABLED = v;
      assert.equal(voiceEnabled(), false, `"${v}" must not enable voice`);
    }
    for (const v of ['true', 'TRUE', 'TRUE ', ' true ', '1', 'yes', 'on']) {
      process.env.VOICE_ENABLED = v;
      assert.equal(voiceEnabled(), true, `"${v}" enables voice`);
    }
  } finally {
    if (prior === undefined) delete process.env.VOICE_ENABLED;
    else process.env.VOICE_ENABLED = prior;
  }
});

test('the benchmark gate does not accept an unparseable date', () => {
  const prior = process.env.VOICE_BENCHMARK_COMPLETED;
  try {
    delete process.env.VOICE_BENCHMARK_COMPLETED;
    assert.equal(benchmarkState().completed, false);

    // Section 14 calls the gate hard, so "soon" must not satisfy it.
    process.env.VOICE_BENCHMARK_COMPLETED = 'soon';
    assert.equal(benchmarkState().completed, false, 'a non-date does not complete the gate');

    process.env.VOICE_BENCHMARK_COMPLETED = '2026-08-17';
    assert.equal(benchmarkState().completed, true);
    assert.match(benchmarkState().at, /^2026-08-17/);
  } finally {
    if (prior === undefined) delete process.env.VOICE_BENCHMARK_COMPLETED;
    else process.env.VOICE_BENCHMARK_COMPLETED = prior;
  }
});

test('gateState reports per user, not globally', () => {
  withEnv({ VOICE_ENABLED: undefined, VOICE_TEST_USERS: '8' }, () => {
    const off = gateState({ sttReady: true, ttsReady: true }, reqWith('8'));
    assert.equal(off.enabled, false);
    assert.equal(off.voice_enabled_for_this_user, false, 'the kill switch wins');
    assert.equal(off.render_voice_ui, false, 'no voice UI in the DOM at all');
    assert.equal(off.stt_ready, false);
    assert.equal(off.tts_ready, false);
    assert.equal(off.degraded, false, 'off is not degraded -- they are different states');
  });

  withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: '8' }, () => {
    // The allowlisted operator.
    const mine = gateState({ sttReady: false, ttsReady: false, degraded: true }, reqWith('8'));
    assert.equal(mine.voice_enabled_for_this_user, true);
    assert.equal(mine.render_voice_ui, true);
    assert.equal(mine.degraded, true, 'gate on + engine down renders a degraded state');

    // Everyone else on the same connector, while the master switch is ON. This
    // is the leak the per-user gate exists to close: a UI handed a global
    // `enabled` would render a mic button for this user too.
    const theirs = gateState({ sttReady: true, ttsReady: true }, reqWith('9'));
    assert.equal(theirs.enabled, true, 'the global fact is still reported');
    assert.equal(theirs.voice_enabled_for_this_user, false, 'but availability is per user');
    assert.equal(theirs.render_voice_ui, false, 'so this user emits no voice elements');
    assert.equal(theirs.stt_ready, false,
      'and sees no readiness, which would otherwise be grounds to render something');
    assert.equal(theirs.tts_ready, false);

    // No identity at all.
    const anon = gateState({ sttReady: true, ttsReady: true }, reqWith(null));
    assert.equal(anon.voice_enabled_for_this_user, false, 'absent identity fails closed');
  });
});

// ===========================================================================
// The GPL boundary. Section 6.3, compliance obligation 1.
// ===========================================================================
test('GPL boundary: the STT helper never imports or executes Piper', () => {
  const py = readFileSync(join(VOICE_DIR, 'voice_stt.py'), 'utf8');

  // Our MIT helper must not share a process with GPL code. Collapsing the two
  // engines into one helper would be the easy refactor and would destroy the
  // boundary Section 6.2 locks, so it is asserted rather than trusted.
  const code = py.replace(/^\s*#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');
  assert.ok(!/\bimport\s+piper/.test(code), 'voice_stt.py must not import piper');
  assert.ok(!/\bfrom\s+piper/.test(code), 'voice_stt.py must not import from piper');
  assert.ok(!/piper_phonemize|espeak/.test(code), 'nor the GPL phonemizer');
  assert.ok(!/subprocess|os\.system|os\.exec/.test(code),
    'voice_stt.py must not spawn anything, least of all Piper');

  // And it must genuinely be the STT engine, or the assertions above are
  // trivially satisfied by an empty file.
  assert.ok(/faster_whisper/.test(code), 'voice_stt.py does use faster-whisper');
});

test('GPL boundary: Piper runs as its own process, from its own directory', () => {
  const js = readFileSync(join(VOICE_DIR, 'voice-engines.js'), 'utf8');

  assert.ok(/spawn\(\s*PIPER_BIN/.test(js), 'Piper is spawned as a separate OS process');
  assert.ok(/VOICE_PIPER_DIR/.test(js), 'from its own directory');

  // Section 11: least privilege, no connector secrets. Node hands a child the
  // entire parent environment by default, which here includes API keys and the
  // database URL, so the environment must be built explicitly.
  const piperCall = js.slice(js.indexOf('export async function synthesize'));
  assert.ok(/env:\s*\{\s*PATH/.test(piperCall),
    'Piper gets an explicit minimal environment, not the connector\'s');
  assert.ok(!/env:\s*process\.env/.test(piperCall),
    'Piper must never inherit process.env wholesale');

  // argv array, never a shell string: a voice id cannot be word-split.
  assert.ok(!/spawn\([^)]*shell:\s*true/.test(js), 'no shell invocation');
});

test('GPL boundary: nothing GPL is a declared dependency of the connector', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...(pkg.devDependencies || {}) });
  for (const name of declared) {
    assert.ok(!/piper/i.test(name),
      `${name} must not be a declared dependency -- Piper stays outside the import graph`);
  }
});

// ===========================================================================
test('audio validation refuses anything that is not really audio', () => {
  const good = validateAudio(wav(1), { declaredType: 'audio/wav' });
  assert.equal(good.ok, true);
  assert.equal(good.format, 'wav');
  assert.ok(Math.abs(good.duration_seconds - 1) < 0.01, 'WAV duration is exact');
  assert.equal(good.duration_exact, true);

  // The declared Content-Type is caller-supplied and means nothing on its own.
  assert.equal(validateAudio(Buffer.from('#!/bin/sh\nrm -rf /'),
    { declaredType: 'audio/wav' }).reason, 'unsupported_format');

  assert.equal(validateAudio(wav(1), { declaredType: 'audio/mpeg' }).reason,
    'format_mismatch', 'bytes and label must agree');

  assert.equal(validateAudio(Buffer.alloc(0)).reason, 'empty_audio');
  assert.equal(validateAudio(null).reason, 'empty_audio');

  // Status codes are part of the contract (Section 8.2).
  assert.equal(validateAudio(Buffer.from('nope')).status, 415);
  assert.equal(validateAudio(Buffer.alloc(0)).status, 422);
});

test('audio validation bounds duration without decoding', () => {
  const prior = process.env.VOICE_MAX_AUDIO_SECONDS;
  try {
    process.env.VOICE_MAX_AUDIO_SECONDS = '2';
    const long = validateAudio(wav(10), { declaredType: 'audio/wav' });
    assert.equal(long.ok, false);
    assert.equal(long.status, 413);
    assert.equal(long.reason, 'audio_too_long');
  } finally {
    if (prior === undefined) delete process.env.VOICE_MAX_AUDIO_SECONDS;
    else process.env.VOICE_MAX_AUDIO_SECONDS = prior;
  }
});

test('WAV duration is read from the chunk list, not a fixed offset', () => {
  // Recorders emit LIST and fact chunks before data. Assuming the canonical
  // 44-byte header reads the wrong length for those files.
  const base = wav(1);
  const list = Buffer.alloc(8 + 10);
  list.write('LIST', 0); list.writeUInt32LE(10, 4);
  const withList = Buffer.concat([base.slice(0, 36), list, base.slice(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);

  const secs = wavDurationSeconds(withList);
  assert.ok(secs !== null && Math.abs(secs - 1) < 0.01,
    `an extra chunk must not break duration (got ${secs})`);
});

test('format sniffing recognises each accepted container', () => {
  assert.equal(sniffFormat(wav(0.1)), 'wav');
  assert.equal(sniffFormat(Buffer.from('fLaC\0\0\0\0\0\0\0\0')), 'flac');
  assert.equal(sniffFormat(Buffer.from('OggS\0\0\0\0\0\0\0\0')), 'ogg');
  assert.equal(sniffFormat(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)])), 'webm');
  assert.equal(sniffFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(4)])), 'm4a');
  assert.equal(sniffFormat(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12)])), 'mp3');
  assert.equal(sniffFormat(Buffer.from('plain text, definitely')), null);
});

// ===========================================================================
test('multipart reads one file and its fields, and refuses the rest', () => {
  const b = 'X-BOUND';
  const audio = wav(0.5);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);

  const r = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(r.ok, true);
  assert.equal(r.fields.language, 'en');
  assert.equal(r.file.filename, 'a.wav');
  assert.ok(r.file.data.equals(audio), 'the file survives byte-for-byte');

  assert.equal(parseMultipart(body, 'application/json').reason, 'not_multipart');
  assert.equal(parseBoundary('multipart/form-data; boundary="quoted-one"'), 'quoted-one');

  // base64 parts are refused rather than passed through undecoded, which would
  // hand the decoder something that is not audio.
  const b64 = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="a"; filename="a.wav"\r\n`
    + `Content-Transfer-Encoding: base64\r\n\r\nAAAA\r\n--${b}--\r\n`);
  assert.equal(parseMultipart(b64, `multipart/form-data; boundary=${b}`).reason,
    'unsupported_transfer_encoding');
});

// ===========================================================================
// Compliance obligation 2: the per-voice licence audit.
// ===========================================================================
test('a voice is refused until its MODEL_CARD has been audited', () => {
  // UPDATED v12.50.0. This test previously asserted that NOTHING was usable,
  // which was the honest state when no MODEL_CARD had been read. Two have now
  // been read, so the assertion moves from "nothing ships" to the invariant it
  // was always really protecting: nothing ships that has not been checked, and
  // being checked is not the same as being allowed.
  const state = catalogState();
  assert.equal(state.audit_required, true, 'the audit is required by default');

  const audited   = VOICE_CATALOG.filter(v => v.audited);
  const unaudited = VOICE_CATALOG.filter(v => !v.audited);
  assert.ok(audited.length > 0, 'the audit has actually been carried out on something');
  assert.ok(unaudited.length > 0, 'and unread MODEL_CARDs are still recorded as unread');
  assert.equal(state.unaudited.length, unaudited.length);

  for (const v of unaudited) {
    const p = voicePermitted(v.voice_id);
    assert.equal(p.ok, false, `${v.voice_id} is unaudited and must be refused`);
    assert.equal(p.reason, 'voice_unaudited');
    assert.ok(/MODEL_CARD/.test(p.message), 'and the refusal explains why');
  }

  for (const v of audited) {
    const p = voicePermitted(v.voice_id);
    // An audited voice is permitted only if the audit came back clean. This is
    // the distinction the table exists to express.
    assert.equal(p.ok, v.commercial_ok === true, `${v.voice_id} follows its audit result`);
    if (!p.ok) assert.equal(p.reason, 'voice_non_commercial');
  }

  assert.equal(voicePermitted('made-up-voice').reason, 'unknown_voice');
  assert.equal(voicePermitted('').reason, 'unknown_voice');

  // An allowlist, not a blocklist: a voice added to rhasspy/piper-voices
  // tomorrow is refused by default rather than used by default.
  assert.equal(state.usable, VOICE_CATALOG.filter(v => voicePermitted(v.voice_id).ok).length);
  assert.deepEqual(voicesForLanguage('en').map(v => v.voice_id), ['en_US-kristin-medium'],
    'English resolves to the audited, public-domain voice and to nothing else');

  // Attribution lists only voices whose MODEL_CARD actually asks for it. Both
  // audited entries are public domain or refused, so the page stays empty --
  // which is correct, not incomplete.
  assert.deepEqual(attributions(), []);
});

test('the four launch languages are represented, Vietnamese with a fallback', () => {
  assert.deepEqual([...TTS_LANGUAGES].sort(), ['en', 'ja', 'vi', 'zh']);
  for (const lang of TTS_LANGUAGES) {
    assert.ok(VOICE_CATALOG.some(v => v.language === lang && v.role === 'default'),
      `${lang} has a default voice`);
  }
  // Section 5: Vietnamese is the constraint language, and Table 2 names a
  // fallback for exactly that reason.
  assert.ok(VOICE_CATALOG.some(v => v.language === 'vi' && v.role === 'fallback'),
    'Vietnamese carries a documented fallback voice');
  assert.equal(VOICE_CATALOG.find(v => v.language === 'vi').quality_tier, 'weak');
});

test('an explicitly non-commercial voice is refused even with the audit off', () => {
  const prior = process.env.VOICE_AUDIT_REQUIRED;
  try {
    process.env.VOICE_AUDIT_REQUIRED = 'false';

    // With the audit relaxed, an UNAUDITED voice becomes usable. That is what
    // the switch is for: it says "I accept the risk on licences nobody has read".
    assert.equal(voicePermitted('zh_CN-huayan-medium').ok, true);

    // It does NOT say "I accept a licence somebody has read and rejected".
    // en_US-lessac-medium is the real case (v12.50.0): the CSTR Blizzard 2013
    // Lessac corpus is released for non-commercial use only. A known-bad answer
    // is different from a missing one and stays refused either way.
    const verdict = voicePermitted('en_US-lessac-medium');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'voice_non_commercial');
  } finally {
    if (prior === undefined) delete process.env.VOICE_AUDIT_REQUIRED;
    else process.env.VOICE_AUDIT_REQUIRED = prior;
  }
});

// ===========================================================================
// Section 16 behavioural acceptance criteria, over real HTTP.
// ===========================================================================
test('AC: gate off -- the two routes 404, health answers enabled:false', async () => {
  const prior = process.env.VOICE_ENABLED;
  delete process.env.VOICE_ENABLED;
  const { base, close } = await listen(makeApp());
  try {
    const t = await fetch(`${base}/voice/transcribe`, { method: 'POST', body: wav(1) });
    assert.equal(t.status, 404, 'transcribe is indistinguishable from a route that does not exist');

    const s = await fetch(`${base}/voice/synthesize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', language: 'en' }),
    });
    assert.equal(s.status, 404);

    // 404 and not 403: a 403 would confirm the feature exists and is switched
    // off, which is a different statement.
    assert.deepEqual(await t.json(), { error: 'not_found' });

    const h = await fetch(`${base}/voice/health`);
    assert.equal(h.status, 200, 'health is the one voice route that always answers');
    const body = await h.json();
    assert.equal(body.enabled, false);
    assert.equal(body.stt_ready, false);
    assert.equal(body.tts_ready, false);
    assert.deepEqual(body.models_loaded, []);
  } finally {
    await close();
    if (prior === undefined) delete process.env.VOICE_ENABLED;
    else process.env.VOICE_ENABLED = prior;
  }
});

test('AC: an unsupported language or voice is a clear 422, never a 500', async () => {
  const prior = { e: process.env.VOICE_ENABLED, u: process.env.VOICE_TEST_USERS };
  process.env.VOICE_ENABLED = 'true';
  process.env.VOICE_TEST_USERS = 'op-1';
  const { base, close } = await listen(makeApp());
  const post = (body) => fetch(`${base}/voice/synthesize`, {
    method: 'POST',
    headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  try {
    // Section 16 names this case explicitly.
    const lang = await post({ text: 'hello', language: 'de' });
    assert.equal(lang.status, 422);
    const lj = await lang.json();
    assert.equal(lj.error, 'unsupported_language');
    assert.ok(lj.message.length > 0, 'the UI has something to render');
    // Section 13: the two engines cover different language sets and the UI must
    // not be allowed to imply otherwise.
    assert.ok(/not the same set/i.test(lj.message));

    const voice = await post({ text: 'hello', voice: 'nonexistent-voice' });
    assert.equal(voice.status, 422);
    assert.equal((await voice.json()).error, 'unknown_voice');

    // The audit gate reaching the caller, honestly, as a 422. Chinese, not
    // English: from v12.50.0 English resolves to an audited voice and would go
    // on to the engine, so it no longer demonstrates the audit refusing anyone.
    const unaudited = await post({ text: 'hello', language: 'zh' });
    assert.equal(unaudited.status, 422);
    assert.equal((await unaudited.json()).error, 'no_voice_available');

    // A licence verdict is also a 422 with a renderable message, not a 500.
    const nonCommercial = await post({ text: 'hello', voice: 'en_US-lessac-medium' });
    assert.equal(nonCommercial.status, 422);
    assert.equal((await nonCommercial.json()).error, 'voice_non_commercial');

    assert.equal((await post({ text: '' })).status, 422);
    assert.equal((await post({ text: 'hi', voice: 'en_US-kristin-medium', format: 'mp3' })).status, 422);
    assert.equal((await post({ text: 'hi', voice: 'en_US-kristin-medium', speed: 9 })).status, 422);
  } finally {
    await close();
    if (prior.e === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = prior.e;
    if (prior.u === undefined) delete process.env.VOICE_TEST_USERS; else process.env.VOICE_TEST_USERS = prior.u;
  }
});

test('AC: bad audio is rejected at the edge with the right status', async () => {
  const prior = { e: process.env.VOICE_ENABLED, u: process.env.VOICE_TEST_USERS };
  process.env.VOICE_ENABLED = 'true';
  process.env.VOICE_TEST_USERS = 'op-1';
  const { base, close } = await listen(makeApp());
  try {
    const bad = await fetch(`${base}/voice/transcribe`, {
      method: 'POST',
      headers: asUser('op-1', null, { 'Content-Type': 'audio/wav' }),
      body: Buffer.from('this is not audio'),
    });
    assert.equal(bad.status, 415, 'not audio, and no engine was ever invoked');
    assert.equal((await bad.json()).error, 'unsupported_format');

    const empty = await fetch(`${base}/voice/transcribe`, {
      method: 'POST',
      headers: asUser('op-1', null, { 'Content-Type': 'audio/wav' }),
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 422);
  } finally {
    await close();
    if (prior.e === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = prior.e;
    if (prior.u === undefined) delete process.env.VOICE_TEST_USERS; else process.env.VOICE_TEST_USERS = prior.u;
  }
});

test('AC: health reports that the benchmark gate has not been passed', async () => {
  const priorV = process.env.VOICE_ENABLED;
  const priorB = process.env.VOICE_BENCHMARK_COMPLETED;
  const priorU = process.env.VOICE_TEST_USERS;
  process.env.VOICE_ENABLED = 'true';
  process.env.VOICE_TEST_USERS = 'op-1';
  delete process.env.VOICE_BENCHMARK_COMPLETED;
  const { base, close } = await listen(makeApp());
  try {
    const body = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
    assert.equal(body.enabled, true);
    assert.equal(body.voice_enabled_for_this_user, true);
    // Section 14's gate is hard. An operator must be able to see that voice is
    // answering on provisional defaults rather than measured ones.
    assert.equal(body.benchmark_completed, false);
    assert.equal(body.catalogue.usable, 1,
      'exactly one voice has cleared its audit: the public-domain English default');
    assert.deepEqual(body.catalogue.usable_by_language.en, ['en_US-kristin-medium']);
    assert.deepEqual(body.tts_languages.sort(), ['en', 'ja', 'vi', 'zh']);
    assert.equal(body.stt_languages, 'auto', 'STT coverage is reported separately');
  } finally {
    await close();
    if (priorV === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = priorV;
    if (priorU === undefined) delete process.env.VOICE_TEST_USERS; else process.env.VOICE_TEST_USERS = priorU;
    if (priorB !== undefined) process.env.VOICE_BENCHMARK_COMPLETED = priorB;
  }
});

test('AC: an unauthenticated request is refused', async () => {
  const prior = { e: process.env.VOICE_ENABLED, u: process.env.VOICE_TEST_USERS };
  process.env.VOICE_ENABLED = 'true';
  process.env.VOICE_TEST_USERS = 'op-1';
  const app = express();
  registerVoiceRoutes(app);          // no auth middleware at all
  const { base, close } = await listen(app);
  try {
    // Allowlisted, so the gate passes -- and the AUTH layer still refuses. The
    // per-user gate is a testing keyhole, not an authentication mechanism, and
    // must not become a way to skip authentication by naming yourself.
    const r = await fetch(`${base}/voice/synthesize`, {
      method: 'POST',
      headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: 'hello', language: 'en' }),
    });
    assert.equal(r.status, 401);
  } finally {
    await close();
    if (prior.e === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = prior.e;
    if (prior.u === undefined) delete process.env.VOICE_TEST_USERS; else process.env.VOICE_TEST_USERS = prior.u;
  }
});

// ===========================================================================
test('the schema stores preferences and metadata, and cannot store content', () => {
  const db = new Database(':memory:');
  try {
    initVoiceSchema(db);

    const cols = db.prepare('PRAGMA table_info(voice_usage_log)').all().map(c => c.name);
    // Section 10: duration, language, character count. Nothing capable of
    // holding a transcript, and no free-text column for someone to add one to.
    assert.deepEqual(cols.sort(),
      ['char_count', 'created_at', 'direction', 'duration_ms', 'id', 'language', 'user_id']);
    for (const banned of ['text', 'transcript', 'audio', 'content', 'filename', 'path']) {
      assert.ok(!cols.includes(banned), `voice_usage_log must not have a ${banned} column`);
    }

    setVoiceSettings(db, 'u1', { preferred_voice: 'en_US-lessac-medium', speed: 1.25, language: 'en' });
    assert.equal(getVoiceSettings(db, 'u1').speed, 1.25);

    // Out-of-range speed is clamped to the default rather than stored.
    setVoiceSettings(db, 'u2', { speed: 99 });
    assert.equal(getVoiceSettings(db, 'u2').speed, 1.0);

    logVoiceUsage(db, { user_id: 'u1', direction: 'stt', language: 'en', duration_ms: 1200 });
    logVoiceUsage(db, { user_id: 'u1', direction: 'nonsense', language: 'en' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM voice_usage_log').get().c, 1,
      'an unknown direction is dropped, not stored');

    // The catalogue table mirrors the code, and the three states must stay
    // distinguishable in SQL as well as in JS. This is the whole reason
    // commercial_ok is nullable.
    const unread = db.prepare('SELECT * FROM voice_catalog WHERE voice_id = ?')
      .get('zh_CN-huayan-medium');
    assert.equal(unread.audited, 0);
    assert.equal(unread.commercial_ok, null,
      'unverified is NULL, which is not the same claim as "audited and refused"');

    const refused = db.prepare('SELECT * FROM voice_catalog WHERE voice_id = ?')
      .get('en_US-lessac-medium');
    assert.equal(refused.audited, 1, 'read in v12.50.0');
    assert.equal(refused.commercial_ok, 0,
      'audited and refused: 0, distinct from the NULL above');
    assert.match(refused.licence, /non-commercial/i);

    const cleared = db.prepare('SELECT * FROM voice_catalog WHERE voice_id = ?')
      .get('en_US-kristin-medium');
    assert.equal(cleared.audited, 1);
    assert.equal(cleared.commercial_ok, 1);
    assert.ok(cleared.model_card, 'an audit result records where it came from');
  } finally {
    db.close();
  }
});

test('requireVoiceEnabled sends 404 and reports that it did', () => {
  const prior = process.env.VOICE_ENABLED;
  try {
    delete process.env.VOICE_ENABLED;
    let status = null; let payload = null;
    const res = { status(s) { status = s; return this; }, json(p) { payload = p; return this; } };
    assert.equal(requireVoiceEnabled(res), false);
    assert.equal(status, 404);
    assert.deepEqual(payload, { error: 'not_found' });

    process.env.VOICE_ENABLED = 'true';
    assert.equal(requireVoiceEnabled(res), true);
  } finally {
    if (prior === undefined) delete process.env.VOICE_ENABLED;
    else process.env.VOICE_ENABLED = prior;
  }
});

// ===========================================================================
// PER-USER FEATURE GATE  (Tenax Voice -- Per-User Feature Gate Spec)
//
// Section 3's truth table, plus the six cases Section 6.3 names. The property
// under test throughout is that every refusal is INDISTINGUISHABLE from the
// feature not existing.
// ===========================================================================

test('the allowlist is parsed exactly, and an empty one opens nothing', () => {
  withEnv({ VOICE_TEST_USERS: undefined }, () => {
    assert.deepEqual(testUsers(), [], 'empty by default -- voice unreachable');
  });
  withEnv({ VOICE_TEST_USERS: '' }, () => assert.deepEqual(testUsers(), []));

  withEnv({ VOICE_TEST_USERS: ' 8 , op-1,ts_50f3be57:8 ' }, () => {
    assert.deepEqual(testUsers(), ['8', 'op-1', 'ts_50f3be57:8'], 'trimmed, order kept');
  });

  // A trailing comma must not leave an empty entry: an empty string would match
  // a caller who sent no identity at all, turning a typo into an open door.
  withEnv({ VOICE_TEST_USERS: 'op-1,,' }, () => {
    assert.deepEqual(testUsers(), ['op-1']);
    assert.equal(userAllowed({ userId: null }), false, 'no identity is still refused');
    assert.equal(userAllowed({ userId: '' }), false);
  });
});

test('matching is exact: no substring, no case folding, no prefix', () => {
  withEnv({ VOICE_TEST_USERS: 'op-1,8' }, () => {
    assert.equal(userAllowed({ userId: 'op-1' }), true);
    assert.equal(userAllowed({ userId: '8' }), true);

    // Section 2.2: "no substring match, no case folding". Every one of these is
    // a different person from an allowlisted one.
    assert.equal(userAllowed({ userId: 'OP-1' }), false, 'case is not folded');
    assert.equal(userAllowed({ userId: 'op-10' }), false, 'no prefix match');
    assert.equal(userAllowed({ userId: 'xop-1' }), false, 'no suffix match');
    assert.equal(userAllowed({ userId: 'op-1 extra' }), false);
    assert.equal(userAllowed({ userId: '80' }), false, '"8" must not admit "80"');
    assert.equal(userAllowed({ userId: '8-guest' }), false);
    assert.equal(userAllowed({ userId: 'op' }), false);
  });
});

test('a tenant-qualified entry narrows the grant rather than widening it', () => {
  // Observed user_id values are small integers, so user 8 of tenant A is a
  // different person from user 8 of tenant B. A bare "8" would admit both.
  withEnv({ VOICE_TEST_USERS: 'ts_aaa:8' }, () => {
    assert.equal(userAllowed({ userId: '8', tenantId: 'ts_aaa' }), true);
    assert.equal(userAllowed({ userId: '8', tenantId: 'ts_bbb' }), false,
      'the same user id in another tenant is a different person');
    assert.equal(userAllowed({ userId: '8', tenantId: null }), false,
      'a qualified entry needs the tenant, so an unqualified caller is refused');
    assert.equal(userAllowed({ userId: '9', tenantId: 'ts_aaa' }), false);
  });

  // A malformed entry must not degrade into a wildcard.
  withEnv({ VOICE_TEST_USERS: ':8,ts_aaa:' }, () => {
    assert.equal(userAllowed({ userId: '8', tenantId: 'ts_aaa' }), false,
      'half-written entries grant nothing');
    assert.equal(userAllowed({ userId: '8' }), false);
  });
});

test('identity is read per request, never from the process singleton', () => {
  const id = resolveIdentity(reqWith('op-1', 'ts_aaa'));
  assert.equal(id.userId, 'op-1');
  assert.equal(id.tenantId, 'ts_aaa');
  assert.equal(id.source, 'header');

  assert.equal(resolveIdentity(reqWith(null)).userId, null);
  assert.equal(resolveIdentity(reqWith('   ')).userId, null, 'whitespace is not an identity');
  assert.equal(resolveIdentity(null).userId, null, 'a missing request is safe');
  assert.equal(resolveIdentity({}).userId, null);

  // A header sent twice with different values is ambiguous, and Section 6.4
  // says fail closed on any ambiguity.
  assert.equal(resolveIdentity({ headers: { [USER_ID_HEADER]: ['a', 'b'] } }).userId, null);

  // The tenant falls back to whatever tenantAuth resolved, so a qualified
  // allowlist entry works without the caller restating the tenant.
  const viaAuth = resolveIdentity({ headers: { [USER_ID_HEADER]: '8' }, tsTenantId: 'ts_aaa' });
  assert.equal(viaAuth.tenantId, 'ts_aaa');

  // The gate must NOT consult getCurrentUser(). That singleton is seeded by
  // whoever last ran session-init, so a gate built on it would judge one user's
  // request against another's identity -- failing open under exactly the shared
  // conditions this gate was written for.
  const src = readFileSync(join(VOICE_DIR, 'voice-gate.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/getCurrentUser/.test(code),
    'voice-gate.js must not read the process-level session context');
});

test('Section 3 truth table: both layers are required, in every combination', () => {
  const allowed = reqWith('op-1');
  const other = reqWith('op-2');
  const anon = reqWith(null);

  // Row 1: master off -- nothing opens, whatever the allowlist says.
  withEnv({ VOICE_ENABLED: undefined, VOICE_TEST_USERS: 'op-1' }, () => {
    assert.equal(voiceAvailableFor(allowed), false, 'the kill switch overrides the allowlist');
    assert.equal(voiceAvailableFor(other), false);
  });
  withEnv({ VOICE_ENABLED: 'ture', VOICE_TEST_USERS: 'op-1' }, () => {
    assert.equal(voiceAvailableFor(allowed), false, 'and a typo is still off');
  });

  // Row 2: master on, not allowlisted -- refused.
  withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: 'op-1' }, () => {
    assert.equal(voiceAvailableFor(other), false);
    assert.equal(voiceAvailableFor(anon), false, 'absent identity fails closed');

    // Row 3: master on and allowlisted -- the only combination that opens.
    assert.equal(voiceAvailableFor(allowed), true);
  });

  // The allowlist alone can never open voice, and neither can the master
  // switch alone. Two independent failures must both happen.
  withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: undefined }, () => {
    assert.equal(voiceAvailableFor(allowed), false, 'empty allowlist -- nobody gets in');
  });
});

test('AC: a non-allowlisted user gets the identical 404, on every route', async () => {
  await withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: 'op-1' }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      // The reference: what the world looks like when voice is globally off.
      const offBody = { enabled: false, voice_enabled_for_this_user: false,
                        stt_ready: false, tts_ready: false, models_loaded: [] };

      for (const [label, headers] of [
        ['not allowlisted', asUser('op-2')],
        ['no identity',     {}],
        ['near miss',       asUser('op-10')],
        ['case variant',    asUser('OP-1')],
      ]) {
        const t = await fetch(`${base}/voice/transcribe`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: wav(1),
        });
        assert.equal(t.status, 404, `${label}: transcribe 404s`);
        assert.deepEqual(await t.json(), { error: 'not_found' },
          `${label}: and says only "not found" -- never "you are not allowed"`);

        const s = await fetch(`${base}/voice/synthesize`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hello', language: 'en' }),
        });
        assert.equal(s.status, 404, `${label}: synthesize 404s`);

        // Health answers, but must be byte-identical to the globally-off body.
        // Reporting enabled:true here would tell this caller the feature exists
        // and that they are merely excluded.
        const h = await fetch(`${base}/voice/health`, { headers });
        assert.equal(h.status, 200);
        assert.deepEqual(await h.json(), offBody,
          `${label}: health is indistinguishable from voice being off`);
      }
    } finally { await close(); }
  });
});

test('AC: the allowlisted operator reaches the routes', async () => {
  await withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: 'op-1' }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      // Past the gate: these fail on their own merits (unaudited voice, bad
      // audio) rather than with the gate's 404. That distinction is the whole
      // test -- a 404 here would mean the operator is locked out of their own
      // testing, which the specification names as the risk of scoping the gate
      // to the wrong field.
      const s = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'en' }),
      });
      assert.notEqual(s.status, 404, 'the operator is not gated out');
      // From v12.50.0 English clears the catalogue, so this now reaches the
      // ENGINE and fails there (no Piper in the test image). The distinction
      // the test protects is unchanged: whatever refuses the operator, it must
      // not be the per-user gate.
      assert.ok([422, 500].includes(s.status), `expected an engine or catalogue answer, got ${s.status}`);

      // An unaudited language still stops at the catalogue, which proves the
      // request got that far rather than being turned away at the gate.
      const zh = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'zh' }),
      });
      assert.equal(zh.status, 422);
      assert.equal((await zh.json()).error, 'no_voice_available');

      const t = await fetch(`${base}/voice/transcribe`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'audio/wav' }),
        body: Buffer.from('not audio'),
      });
      assert.notEqual(t.status, 404);
      assert.equal(t.status, 415, 'and reaches the real validator');

      const h = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
      assert.equal(h.enabled, true);
      assert.equal(h.voice_enabled_for_this_user, true);
    } finally { await close(); }
  });
});

test('AC: the kill switch shuts the allowlisted operator out too', async () => {
  await withEnv({ VOICE_ENABLED: undefined, VOICE_TEST_USERS: 'op-1' }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      const s = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'en' }),
      });
      assert.equal(s.status, 404, 'VOICE_ENABLED unset overrides the allowlist entirely');

      const h = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
      assert.equal(h.enabled, false);
      assert.equal(h.voice_enabled_for_this_user, false);
    } finally { await close(); }
  });
});

test('AC: with the allowlist empty, behaviour is identical to the old global gate', async () => {
  // Section 7's upgrade-order claim: "it degrades safely: with the allowlist
  // empty and VOICE_ENABLED off, behaviour is byte-for-byte identical to
  // today's gate". Asserted rather than assumed, because it is what makes
  // deploying the connector ahead of the UI safe.
  await withEnv({ VOICE_ENABLED: undefined, VOICE_TEST_USERS: undefined }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      const t = await fetch(`${base}/voice/transcribe`, { method: 'POST', body: wav(1) });
      assert.equal(t.status, 404);
      assert.deepEqual(await t.json(), { error: 'not_found' });

      const h = await fetch(`${base}/voice/health`);
      assert.equal(h.status, 200, 'health still always answers');
      const body = await h.json();
      assert.equal(body.enabled, false);
      assert.equal(body.stt_ready, false);
      assert.equal(body.tts_ready, false);
      assert.deepEqual(body.models_loaded, []);
    } finally { await close(); }
  });
});

test('requireVoiceForUser refuses with the same 404 as the global guard', () => {
  const mk = () => {
    const r = { _status: null, _payload: null };
    r.status = (s) => { r._status = s; return r; };
    r.json = (p) => { r._payload = p; return r; };
    return r;
  };

  withEnv({ VOICE_ENABLED: 'true', VOICE_TEST_USERS: 'op-1' }, () => {
    const ok = mk();
    assert.equal(requireVoiceForUser(reqWith('op-1'), ok), true);
    assert.equal(ok._status, null, 'an allowed caller gets no response written');

    const refused = mk();
    assert.equal(requireVoiceForUser(reqWith('op-2'), refused), false);
    assert.equal(refused._status, 404);
    assert.deepEqual(refused._payload, { error: 'not_found' });
  });

  // The global guard, for comparison. Identical status and identical body, so
  // the two refusals cannot be told apart from outside.
  withEnv({ VOICE_ENABLED: undefined }, () => {
    const global = mk();
    assert.equal(requireVoiceEnabled(global), false);
    assert.equal(global._status, 404);
    assert.deepEqual(global._payload, { error: 'not_found' });
  });
});

test('the allowlist contents never reach the logs', () => {
  // Identities are operator account ids. The registration line reports the
  // COUNT so an operator can see the keyhole is configured, never the values.
  const src = readFileSync(join(HERE, '..', 'routes', 'voice.js'), 'utf8');
  const logLine = src.slice(src.indexOf('routes registered'), src.indexOf('routes registered') + 200);
  assert.ok(/allowlisted_users=\$\{allowlisted\}/.test(logLine), 'the count is logged');
  assert.ok(!/testUsers\(\)\.join|VOICE_TEST_USERS\}/.test(src),
    'the identities themselves are never interpolated into a log line');
});

// ===========================================================================
// ALLOWLIST SOURCE  (v12.48.0 -- the revoke-drift fix)
//
// The failure being closed: with the allowlist in VOICE_TEST_USERS and grants
// recorded in the gateway, a REVOKE that is not manually pasted back leaves the
// user with voice while the admin screen says they do not have it. Grant-drift
// is safe (the user simply has no voice); revoke-drift is a security-relevant
// lie. These tests pin the fix and the failure behaviour around it.
// ===========================================================================

test('env mode is the default and is unchanged', () => {
  withEnv({ VOICE_ALLOWLIST_SOURCE: undefined, VOICE_TEST_USERS: 'op-1,op-2' }, () => {
    assert.equal(allowlistSource(), 'env', 'switching a security gate to a network read is opt-in');
    assert.deepEqual(currentAllowlist(), ['op-1', 'op-2']);
  });
  // Only the exact string switches over, matching VOICE_ENABLED's strictness.
  for (const v of ['Gateway ', 'gatewy', 'remote', 'true']) {
    withEnv({ VOICE_ALLOWLIST_SOURCE: v }, () => {
      assert.equal(allowlistSource(), v.trim().toLowerCase() === 'gateway' ? 'gateway' : 'env',
        `"${v}" must not silently change the source`);
    });
  }
  withEnv({ VOICE_ALLOWLIST_SOURCE: 'gateway' }, () => {
    assert.equal(allowlistSource(), 'gateway');
  });
});

test('both sources parse an entry identically', () => {
  // The two modes must not disagree about who is allowed, so they share the
  // parser. The string is the same one the admin screen shows for pasting.
  const raw = ' ts_aaa:8 , ts_bbb:12 ,, ';
  assert.deepEqual(parseAllowlist(raw), ['ts_aaa:8', 'ts_bbb:12']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(null), []);
  assert.deepEqual(parseAllowlist('a,,b'), ['a', 'b'], 'no empty entry survives');
});

test('gateway mode denies everyone until a fetch has succeeded', async () => {
  await withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_ALLOWLIST_URL: 'http://127.0.0.1:1', VOICE_ALLOWLIST_KEY: 'k',
    VOICE_ALLOWLIST_TIMEOUT_MS: '300',
  }, async () => {
    resetAllowlistCache();
    // A gate that fails open on startup is not a gate.
    assert.deepEqual(currentAllowlist(), [], 'no snapshot means deny');
    await ensureAllowlistFresh();
    assert.deepEqual(currentAllowlist(), [], 'and a failed first fetch still denies');
    assert.equal(await voiceAvailableForAsync(reqWith('op-1')), false);
  });
  resetAllowlistCache();
});

test('gateway mode reads the live allowlist, and a revoke takes effect', async () => {
  // The whole point. A revoke at the gateway propagates without anyone pasting
  // anything into Railway.
  let current = 'ts_aaa:8,ts_aaa:9';
  let hits = 0;

  const app = express();
  app.get('/admin/ti-users/voice-access/allowlist', (req, res) => {
    hits++;
    if (req.headers.authorization !== 'Bearer test-key') { res.status(403).json({}); return; }
    res.json({ voice_test_users: current, granted_count: current.split(',').filter(Boolean).length });
  });
  const { base, close } = await listen(app);

  try {
    await withEnv({
      VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
      VOICE_ALLOWLIST_URL: base, VOICE_ALLOWLIST_KEY: 'test-key',
      VOICE_ALLOWLIST_TTL_MS: '1',
    }, async () => {
      resetAllowlistCache();

      await ensureAllowlistFresh();
      assert.deepEqual(currentAllowlist(), ['ts_aaa:8', 'ts_aaa:9']);
      assert.equal(await voiceAvailableForAsync(reqWith('8', 'ts_aaa')), true);
      assert.equal(await voiceAvailableForAsync(reqWith('9', 'ts_aaa')), true);

      // The operator revokes user 9 in the admin screen. Nothing is pasted
      // anywhere and nothing is redeployed.
      current = 'ts_aaa:8';
      await new Promise(r => setTimeout(r, 5));   // let the 1ms TTL lapse

      assert.equal(await voiceAvailableForAsync(reqWith('9', 'ts_aaa')), false,
        'the revoke is live -- this is the drift the fix removes');
      assert.equal(await voiceAvailableForAsync(reqWith('8', 'ts_aaa')), true,
        'and the still-granted user is unaffected');
    });
  } finally {
    await close();
    resetAllowlistCache();
  }
  assert.ok(hits > 0, 'the gateway was actually consulted');
});

test('a burst of requests produces one gateway call, not one per request', async () => {
  let hits = 0;
  const app = express();
  app.get('/admin/ti-users/voice-access/allowlist', (req, res) => {
    hits++;
    setTimeout(() => res.json({ voice_test_users: 'ts_aaa:8' }), 20);
  });
  const { base, close } = await listen(app);

  try {
    await withEnv({
      VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
      VOICE_ALLOWLIST_URL: base, VOICE_ALLOWLIST_KEY: 'k',
      VOICE_ALLOWLIST_TTL_MS: '60000',
    }, async () => {
      resetAllowlistCache();
      // Ten concurrent voice requests arriving on a cold cache must share one
      // fetch, or a busy moment becomes a stampede against the gateway.
      await Promise.all(Array.from({ length: 10 }, () => voiceAvailableForAsync(reqWith('8', 'ts_aaa'))));
      assert.equal(hits, 1, `concurrent refreshes are shared (got ${hits} calls)`);
    });
  } finally {
    await close();
    resetAllowlistCache();
  }
});

test('a gateway outage serves the last good answer, but only for a bounded time', async () => {
  let up = true;
  const app = express();
  app.get('/admin/ti-users/voice-access/allowlist', (req, res) => {
    if (!up) { res.status(503).json({}); return; }
    res.json({ voice_test_users: 'ts_aaa:8' });
  });
  const { base, close } = await listen(app);

  try {
    await withEnv({
      VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
      VOICE_ALLOWLIST_URL: base, VOICE_ALLOWLIST_KEY: 'k',
      VOICE_ALLOWLIST_TTL_MS: '1', VOICE_ALLOWLIST_MAX_STALE_MS: '120',
    }, async () => {
      resetAllowlistCache();
      await ensureAllowlistFresh();
      assert.deepEqual(currentAllowlist(), ['ts_aaa:8']);

      up = false;
      await new Promise(r => setTimeout(r, 5));
      await ensureAllowlistFresh();
      // A brief blip must not cut voice off mid-sentence.
      assert.deepEqual(currentAllowlist(), ['ts_aaa:8'], 'the last good answer survives an outage');
      assert.equal(allowlistState().last_error !== null, true, 'and the failure is recorded');

      // But staleness is CAPPED. Unbounded "last known good" would reinvent the
      // very drift this module removes, only invisibly.
      await new Promise(r => setTimeout(r, 150));
      assert.deepEqual(currentAllowlist(), [],
        'past the stale cap it denies everyone rather than trusting an old answer');
      assert.equal(allowlistState().stale, true);
    });
  } finally {
    await close();
    resetAllowlistCache();
  }
});

test('a malformed gateway response is an error, not an empty allowlist', async () => {
  const app = express();
  app.get('/admin/ti-users/voice-access/allowlist', (req, res) => res.json({ granted_count: 0 }));
  const { base, close } = await listen(app);

  try {
    await withEnv({
      VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
      VOICE_ALLOWLIST_URL: base, VOICE_ALLOWLIST_KEY: 'k',
    }, async () => {
      resetAllowlistCache();
      await ensureAllowlistFresh();
      // A missing field is a contract change. Reading it as "nobody is granted"
      // would silently revoke everyone; treating it as an error keeps the last
      // good snapshot until the stale cap, which is the safer failure.
      assert.equal(allowlistState().last_error !== null, true,
        'a response with no voice_test_users string is rejected');
      assert.deepEqual(currentAllowlist(), [], 'and with no prior snapshot, denies');
    });
  } finally {
    await close();
    resetAllowlistCache();
  }
});

test('the kill switch never waits on the gateway', async () => {
  // VOICE_ENABLED must work when the gateway is unreachable, compromised, or
  // serving nonsense. An emergency stop that depends on a network call to the
  // system it might be stopping is not an emergency stop.
  await withEnv({
    VOICE_ENABLED: undefined, VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_ALLOWLIST_URL: 'http://127.0.0.1:1', VOICE_ALLOWLIST_KEY: 'k',
    VOICE_ALLOWLIST_TIMEOUT_MS: '5000',
  }, async () => {
    resetAllowlistCache();
    const t0 = Date.now();
    assert.equal(await voiceAvailableForAsync(reqWith('op-1')), false);
    assert.ok(Date.now() - t0 < 200,
      'the master switch short-circuits before any network call');
  });
  resetAllowlistCache();
});

test('health names the drift risk in env mode and the staleness in gateway mode', () => {
  withEnv({ VOICE_ALLOWLIST_SOURCE: undefined, VOICE_TEST_USERS: 'a,b' }, () => {
    const s = allowlistState();
    assert.equal(s.source, 'env');
    assert.equal(s.count, 2);
    // The drift is surfaced by the system, not only by documentation, so an
    // operator can see from health alone that a revoke needs a manual paste.
    assert.ok(/revoke/i.test(s.drift_risk), 'env mode states the revoke risk');
    assert.ok(/VOICE_TEST_USERS/.test(s.drift_risk));
  });

  withEnv({ VOICE_ALLOWLIST_SOURCE: 'gateway' }, () => {
    resetAllowlistCache();
    const s = allowlistState();
    assert.equal(s.source, 'gateway');
    assert.equal(s.drift_risk, null, 'gateway mode has no drift to warn about');
    assert.equal(s.fetched, false);
    assert.ok('max_stale_seconds' in s);
  });
  resetAllowlistCache();
});

test('the allowlist entries never reach the logs or /voice/health', () => {
  const src = readFileSync(join(VOICE_DIR, 'voice-allowlist.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Counts and errors, never identities.
  assert.ok(!/console\.\w+\([^)]*cache\.entries/.test(code),
    'the cached entries are never logged');
  assert.ok(!/entries:\s*cache\.entries/.test(code.slice(code.indexOf('allowlistState'))),
    'and are not returned by the diagnostics');
});

// ===========================================================================
// v12.49.0 -- configuration faults must not be silent
// ===========================================================================

test('gateway mode without a URL denies everyone, and says so', () => {
  // THE REPORTED FAILURE. VOICE_ENABLED=true, VOICE_ALLOWLIST_SOURCE=gateway,
  // VOICE_TEST_USERS=ava:38, no VOICE_ALLOWLIST_URL. Every user denied, no mic
  // button, no error -- indistinguishable from voice being switched off, with
  // VOICE_TEST_USERS sitting in the variable list looking operative.
  withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_TEST_USERS: 'ava:38',
    VOICE_ALLOWLIST_URL: undefined, VOICE_ALLOWLIST_KEY: undefined,
    GATEWAY_ADMIN_KEY: undefined,
  }, () => {
    resetAllowlistCache();
    assert.deepEqual(currentAllowlist(), [], 'nobody is allowed');

    const problems = allowlistConfigProblems();
    assert.ok(problems.length >= 2, 'the faults are detected');
    assert.ok(problems.some(p => /VOICE_ALLOWLIST_URL is not set/.test(p)),
      'the missing URL is named');
    assert.ok(problems.some(p => /GATEWAY_ADMIN_KEY/.test(p)),
      'as is the missing key');

    // The most confusing part of the report: a variable that is set and ignored.
    assert.ok(problems.some(p => /VOICE_TEST_USERS is set but IGNORED/.test(p)),
      'and the fact that VOICE_TEST_USERS is ignored in this mode is stated');

    // Each message must name what to change, not merely what is wrong.
    for (const p of problems) {
      assert.ok(/VOICE_[A-Z_]+|GATEWAY_ADMIN_KEY/.test(p),
        'every message names a variable: ' + p.slice(0, 50));
    }
  });
  resetAllowlistCache();
});

test('an empty env allowlist is reported too', () => {
  withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'env', VOICE_TEST_USERS: undefined,
  }, () => {
    const problems = allowlistConfigProblems();
    assert.ok(problems.some(p => /VOICE_TEST_USERS is empty/.test(p)));
    // Points at the tool that generates the correct value, rather than leaving
    // the operator to work out the entry format.
    assert.ok(problems.some(p => /Voice Access admin screen/.test(p)),
      'and names where the correct value comes from');
  });
});

test('a coherent configuration reports no faults', () => {
  withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'env', VOICE_TEST_USERS: 'ts_aaa:38',
  }, () => {
    assert.deepEqual(allowlistConfigProblems(), [], 'env mode with entries is clean');
  });
  withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_ALLOWLIST_URL: 'https://gw.test', VOICE_ALLOWLIST_KEY: 'k',
    VOICE_TEST_USERS: undefined,
  }, () => {
    assert.deepEqual(allowlistConfigProblems(), [], 'gateway mode with url and key is clean');
  });
});

test('health reports the faults to a denied caller, but only when enabled', async () => {
  // The operator who needs this message is the person being denied. Withholding
  // it means the only way to see a misconfiguration is to already be past it.
  await withEnv({
    VOICE_ENABLED: 'true', VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_TEST_USERS: 'ava:38', VOICE_ALLOWLIST_URL: undefined,
  }, async () => {
    resetAllowlistCache();
    const { base, close } = await listen(makeApp());
    try {
      const body = await (await fetch(`${base}/voice/health`, { headers: asUser('ava:38') })).json();
      assert.equal(body.enabled, false, 'this caller cannot use voice');
      assert.ok(Array.isArray(body.configuration_problems),
        'and health tells them why the deployment is broken');
      assert.ok(body.configuration_problems.some(p => /VOICE_ALLOWLIST_URL/.test(p)));
    } finally { await close(); }
  });
  resetAllowlistCache();

  // Master switch off: say nothing. The routes must stay indistinguishable from
  // routes that do not exist.
  await withEnv({
    VOICE_ENABLED: undefined, VOICE_ALLOWLIST_SOURCE: 'gateway',
    VOICE_ALLOWLIST_URL: undefined,
  }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      const body = await (await fetch(`${base}/voice/health`)).json();
      assert.equal(body.configuration_problems, undefined,
        'a disabled deployment leaks no configuration detail');
    } finally { await close(); }
  });
});

test('the engines are installed in the image, in separate environments', () => {
  // v12.46.0 shipped requirements files and documented the pip commands but
  // never touched the Dockerfile, so neither engine was present and nothing
  // could transcribe however the gates were set.
  const df = readFileSync(join(HERE, '..', '..', 'Dockerfile'), 'utf8');

  assert.ok(/faster-whisper==/.test(df), 'faster-whisper is installed');
  assert.ok(/piper-tts==/.test(df), 'piper-tts is installed');

  // The licence boundary, in the build. Piper into its own venv; faster-whisper
  // into system packages. Installing them together would put GPL code in the
  // interpreter our MIT helper imports from.
  assert.ok(/python3 -m venv \/opt\/piper/.test(df), 'Piper gets its own venv');
  const piperLine = df.slice(df.indexOf('/opt/piper/bin/pip install'), df.indexOf('/opt/piper/bin/pip install') + 200);
  assert.ok(!/faster-whisper/.test(piperLine),
    'and faster-whisper is NOT installed into it');

  const whisperLine = df.slice(df.indexOf('faster-whisper=='), df.indexOf('faster-whisper==') + 120);
  assert.ok(!/piper/.test(whisperLine), 'nor Piper into system packages');

  assert.ok(/VOICE_PIPER_BIN=\/opt\/piper\/bin\/piper/.test(df),
    'and the binary path is defaulted to match the venv');
  // A browser sends WebM or MP4; the decoder needs the system codecs.
  assert.ok(/ffmpeg/.test(df), 'ffmpeg is present for browser audio containers');
});
