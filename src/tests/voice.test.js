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
         requireVoiceForUser, resolveIdentity, identityPresent, entitlementClaimed,
         voiceAvailableFor, voiceRenderableFor, USER_ID_HEADER, TENANT_ID_HEADER,
         ENTITLEMENT_HEADER }
                      from '../voice/voice-gate.js';
import { parseMultipart, parseBoundary } from '../voice/multipart.js';
import { validateAudio, sniffFormat, wavDurationSeconds }
                      from '../voice/audio-validate.js';
import { voicePermitted, voicesForLanguage, catalogState, attributions,
         VOICE_CATALOG, TTS_LANGUAGES } from '../voice/voice-catalog.js';
import { initVoiceSchema, setVoiceSettings, getVoiceSettings, logVoiceUsage }
                      from '../voice/voice-schema.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
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

/**
 * A request object carrying the per-call identity the gate reads, and (v13.37.0)
 * the gateway's entitlement claim when `entitled` is given.
 */
function reqWith(userId, tenantId, entitled) {
  const headers = {};
  if (userId !== undefined && userId !== null) headers[USER_ID_HEADER] = userId;
  if (tenantId) headers[TENANT_ID_HEADER] = tenantId;
  if (entitled !== undefined) headers[ENTITLEMENT_HEADER] = entitled;
  return { headers };
}

/**
 * Fetch headers for an identified caller, as the Gateway Service sends them for
 * a user its entitlement predicate allowed: the identity and the claim.
 */
function asUser(userId, tenantId, extra) {
  const h = { ...(extra || {}) };
  if (userId) {
    h['X-Tenax-User-Id'] = userId;
    h['X-Tenax-Voice-Entitlement'] = 'entitled';
  }
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

test('gateState reports per user, not globally, rendering from the gateway claim', () => {
  withEnv({ VOICE_ENABLED: undefined }, () => {
    const off = gateState({ sttReady: true, ttsReady: true }, reqWith('8', null, 'entitled'));
    assert.equal(off.enabled, false);
    assert.equal(off.voice_enabled_for_this_user, false, 'the kill switch wins');
    assert.equal(off.render_voice_ui, false, 'no voice UI in the DOM at all');
    assert.equal(off.stt_ready, false);
    assert.equal(off.tts_ready, false);
    assert.equal(off.degraded, false, 'off is not degraded -- they are different states');
  });

  withEnv({ VOICE_ENABLED: 'true' }, () => {
    // A user the gateway entitled.
    const mine = gateState({ sttReady: false, ttsReady: false, degraded: true }, reqWith('8', null, 'entitled'));
    assert.equal(mine.voice_enabled_for_this_user, true);
    assert.equal(mine.render_voice_ui, true);
    assert.equal(mine.degraded, true, 'gate on + engine down renders a degraded state');

    // A user the gateway did not entitle (a student without an override), while
    // the master switch is ON. A UI handed a global `enabled` would render a mic
    // button for this user too.
    const theirs = gateState({ sttReady: true, ttsReady: true }, reqWith('9', null, 'denied'));
    assert.equal(theirs.enabled, true, 'the global fact is still reported');
    assert.equal(theirs.voice_enabled_for_this_user, false, 'but availability is per user');
    assert.equal(theirs.render_voice_ui, false, 'so this user emits no voice elements');
    assert.equal(theirs.stt_ready, false,
      'and sees no readiness, which would otherwise be grounds to render something');
    assert.equal(theirs.tts_ready, false);

    // No claim at all renders as not entitled; no identity likewise.
    assert.equal(gateState({}, reqWith('9')).render_voice_ui, false, 'no claim, no surface');
    const anon = gateState({ sttReady: true, ttsReady: true }, reqWith(null, null, 'entitled'));
    assert.equal(anon.voice_enabled_for_this_user, false, 'absent identity fails closed');
  });
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
  const prior = { e: process.env.VOICE_ENABLED };
  process.env.VOICE_ENABLED = 'true';
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

    // v13. Chinese was a supported language under Piper and is refused for a
    // DIFFERENT reason now: Kokoro's inventory has no Vietnamese voice at all
    // and none of the five voices this platform deploys is Japanese or
    // Mandarin, so TTS_LANGUAGES narrowed to English alone. The refusal moved
    // from "no audited voice for that language" to "that language is not
    // spoken here", which is the honest answer and still a 422.
    const dropped = await post({ text: 'hello', language: 'zh' });
    assert.equal(dropped.status, 422);
    assert.equal((await dropped.json()).error, 'unsupported_language');

    // Every Piper voice id is now an unknown voice. Worth asserting rather than
    // deleting: a client that stored a preference before the cutover will send
    // one of these, and it must get a clean refusal naming the alternatives
    // instead of a 500 from a style lookup deep in the engine.
    for (const stale of ['en_US-lessac-medium', 'en_US-kristin-medium',
                         'vi_VN-vais1000-medium']) {
      const res = await post({ text: 'hello', voice: stale });
      assert.equal(res.status, 422, `${stale} should be a clean refusal`);
      assert.equal((await res.json()).error, 'unknown_voice');
    }

    assert.equal((await post({ text: '' })).status, 422);
    assert.equal((await post({ text: 'hi', voice: 'af_bella', format: 'mp3' })).status, 422);
    assert.equal((await post({ text: 'hi', voice: 'af_bella', speed: 9 })).status, 422);
  } finally {
    await close();
    if (prior.e === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = prior.e;
  }
});

test('AC: bad audio is rejected at the edge with the right status', async () => {
  const prior = { e: process.env.VOICE_ENABLED };
  process.env.VOICE_ENABLED = 'true';
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
  }
});

test('AC: health reports that the benchmark gate has not been passed', async () => {
  const priorV = process.env.VOICE_ENABLED;
  const priorB = process.env.VOICE_BENCHMARK_COMPLETED;
  process.env.VOICE_ENABLED = 'true';
  delete process.env.VOICE_BENCHMARK_COMPLETED;
  const { base, close } = await listen(makeApp());
  try {
    const body = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
    assert.equal(body.enabled, true);
    assert.equal(body.voice_enabled_for_this_user, true);
    // Section 14's gate is hard. An operator must be able to see that voice is
    // answering on provisional defaults rather than measured ones.
    assert.equal(body.benchmark_completed, false);
    // v13. Kokoro is ONE Apache-2.0 model whose voices are style vectors inside
    // one bundle, so there is no per-voice licence to diverge and every voice is
    // usable. The Piper-era "exactly one has cleared its audit" is not a weaker
    // claim now, it is a meaningless one.
    assert.equal(body.catalogue.active, 5, 'the five deployed voices');
    assert.equal(body.catalogue.unverified, 0,
      'no voice can be in the unverified state under a single read licence');
    assert.equal(body.catalogue.licence, 'Apache-2.0');
    // v13. English only. Kokoro has no Vietnamese voice at any version, and none
    // of the five deployed voices is Japanese or Mandarin. A recorded loss.
    assert.deepEqual(body.tts_languages.sort(), ['en']);
    assert.equal(body.stt_languages, 'auto', 'STT coverage is reported separately');
  } finally {
    await close();
    if (priorV === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = priorV;
    if (priorB !== undefined) process.env.VOICE_BENCHMARK_COMPLETED = priorB;
  }
});

test('AC: an unauthenticated request is refused', async () => {
  const prior = { e: process.env.VOICE_ENABLED };
  process.env.VOICE_ENABLED = 'true';
  const app = express();
  registerVoiceRoutes(app);          // no auth middleware at all
  const { base, close } = await listen(app);
  try {
    // Identified and entitled, so the gate passes -- and the AUTH layer still
    // refuses. Naming yourself in a header is not a way to skip authentication.
    const r = await fetch(`${base}/voice/synthesize`, {
      method: 'POST',
      headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: 'hello', language: 'en' }),
    });
    assert.equal(r.status, 401);
  } finally {
    await close();
    if (prior.e === undefined) delete process.env.VOICE_ENABLED; else process.env.VOICE_ENABLED = prior.e;
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

    setVoiceSettings(db, 'u1', { preferred_voice: 'af_bella', speed: 1.25, language: 'en' });
    assert.equal(getVoiceSettings(db, 'u1').speed, 1.25);

    // Out-of-range speed is clamped to the default rather than stored.
    setVoiceSettings(db, 'u2', { speed: 99 });
    assert.equal(getVoiceSettings(db, 'u2').speed, 1.0);

    logVoiceUsage(db, { user_id: 'u1', direction: 'stt', language: 'en', duration_ms: 1200 });
    logVoiceUsage(db, { user_id: 'u1', direction: 'nonsense', language: 'en' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM voice_usage_log').get().c, 1,
      'an unknown direction is dropped, not stored');

    // v13. THE THREE-STATE LICENCE MODEL IS GONE, AND THAT IS THE POINT.
    //
    // Under Piper this asserted that unverified (NULL), audited-and-refused (0)
    // and audited-and-cleared (1) stayed distinguishable in SQL -- because Piper
    // voices came from many datasets with divergent terms, and one of them was
    // non-commercial-only.
    //
    // Kokoro is one Apache-2.0 model. Every row is audited and cleared, so the
    // nullable column survives for a future engine but cannot hold NULL today.
    // Asserting that is the honest replacement: the schema still DISTINGUISHES
    // the states, and no current row occupies the dangerous ones.
    for (const voiceId of ['af_bella', 'af_nicole', 'af_heart', 'bf_emma', 'af_aoede']) {
      const row = db.prepare('SELECT * FROM voice_catalog WHERE voice_id = ?').get(voiceId);
      assert.ok(row, `${voiceId} is mirrored into the table`);
      assert.equal(row.audited, 1, `${voiceId} is audited`);
      assert.equal(row.commercial_ok, 1, `${voiceId} is cleared for commercial use`);
      assert.match(row.licence, /Apache-2\.0/);
      assert.ok(row.model_card, 'a licence verdict records where it came from');
    }

    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM voice_catalog WHERE commercial_ok IS NULL').get().c,
      0, 'no row is in the unverified state');
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM voice_catalog WHERE voice_id LIKE '%piper%' "
        + "OR voice_id LIKE 'en_US-%' OR voice_id LIKE 'vi_VN-%'").get().c,
      0, 'no Piper-era row survives the sync');
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
// PER-USER GATE, v13.37.0  (TENAX-VOICE-2026-10-07-02)
//
// The allowlist is retired, not repaired. The connector checks the master
// switch and that an identity was sent; who is ENTITLED is the gateway's
// per-request answer, which /voice/health renders from and nothing enforces
// with. Every refusal is still INDISTINGUISHABLE from the feature not existing.
// ===========================================================================

/** Source of every non-test .js file under src/, comments removed. */
function connectorCodeFiles() {
  const root = join(HERE, '..');
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (name === 'tests' || name === 'node_modules') continue;
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!/\.(m?js)$/.test(name) || /\.test\.m?js$/.test(name)) continue;
      const src = readFileSync(abs, 'utf8');
      out.push({ file: abs.slice(root.length + 1),
        code: src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1') });
    }
  };
  walk(root);
  return out;
}

test('C-10: no connector path reads VOICE_TEST_USERS or any VOICE_ALLOWLIST_* variable', () => {
  assert.equal(existsSync(join(VOICE_DIR, 'voice-allowlist.js')), false, 'the allowlist module is deleted');
  const retired = ['VOICE_TEST_USERS', 'VOICE_ALLOWLIST_SOURCE', 'VOICE_ALLOWLIST_URL', 'VOICE_ALLOWLIST_KEY',
    'VOICE_ALLOWLIST_TTL_MS', 'VOICE_ALLOWLIST_MAX_STALE_MS', 'VOICE_ALLOWLIST_TIMEOUT_MS'];
  const files = connectorCodeFiles();
  assert.ok(files.length > 50, 'the walk found the connector source');
  const readers = [];
  for (const { file, code } of files) {
    for (const name of retired) if (code.includes(name)) readers.push(`${file}: ${name}`);
    if (/voice-allowlist/.test(code)) readers.push(`${file}: imports voice-allowlist`);
  }
  assert.deepEqual(readers, [], 'a retired allowlist variable is read in code');
});

test('C-11: VOICE_PROSODY_ENABLED is read in one place only, prosody.js', () => {
  const readers = connectorCodeFiles().filter(({ code }) => code.includes('VOICE_PROSODY_ENABLED')).map(({ file }) => file);
  assert.deepEqual(readers, [join('voice', 'prosody.js')]);
});

test('identity presence is an explicit predicate, and the entitlement claim is read exactly', () => {
  assert.equal(identityPresent({ userId: '38' }), true);
  for (const bad of [null, undefined, {}, { userId: null }, { userId: '' }, { userId: '   ' }, { userId: 38 }]) {
    assert.equal(identityPresent(bad), false, JSON.stringify(bad));
  }
  assert.equal(entitlementClaimed(reqWith('8', null, 'entitled')), true);
  assert.equal(entitlementClaimed(reqWith('8', null, ' Entitled ')), true, 'case and spacing as HTTP may carry them');
  for (const v of ['denied', 'yes', 'true', '1', '', 'entitled,entitled']) {
    assert.equal(entitlementClaimed(reqWith('8', null, v)), false, `"${v}" is not the claim`);
  }
  assert.equal(entitlementClaimed(reqWith('8')), false, 'no header, no claim');
  assert.equal(entitlementClaimed({ headers: { [ENTITLEMENT_HEADER]: ['entitled', 'entitled'] } }), false,
    'a header sent twice is ambiguous and reads as no claim');
  assert.equal(entitlementClaimed(null), false);
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

  const viaAuth = resolveIdentity({ headers: { [USER_ID_HEADER]: '8' }, tsTenantId: 'ts_aaa' });
  assert.equal(viaAuth.tenantId, 'ts_aaa');

  // The gate must NOT consult getCurrentUser(): that singleton is seeded by
  // whoever last ran session-init, so a gate built on it would judge one user's
  // request against another's identity.
  const src = readFileSync(join(VOICE_DIR, 'voice-gate.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/getCurrentUser/.test(code),
    'voice-gate.js must not read the process-level session context');
});

test('truth table: the routes need the master switch and an identity; the surface needs the claim too', () => {
  const entitled = reqWith('op-1', null, 'entitled');
  const notClaimed = reqWith('op-2');
  const denied = reqWith('op-3', null, 'denied');
  const anon = reqWith(null, null, 'entitled');

  // Master off: nothing opens and nothing renders, whatever the claim says.
  for (const v of [undefined, 'ture', 'false']) {
    withEnv({ VOICE_ENABLED: v }, () => {
      for (const r of [entitled, notClaimed, denied, anon]) {
        assert.equal(voiceAvailableFor(r), false, `master ${v}`);
        assert.equal(voiceRenderableFor(r), false, `master ${v}`);
      }
    });
  }
  withEnv({ VOICE_ENABLED: 'true' }, () => {
    // The routes: identity is required, the claim is not read (the gateway
    // enforced it before forwarding; a header is a claim, not an authority).
    assert.equal(voiceAvailableFor(entitled), true);
    assert.equal(voiceAvailableFor(notClaimed), true);
    assert.equal(voiceAvailableFor(denied), true);
    assert.equal(voiceAvailableFor(anon), false, 'absent identity fails closed');
    // The surface: only an entitled claim renders it.
    assert.equal(voiceRenderableFor(entitled), true);
    assert.equal(voiceRenderableFor(notClaimed), false);
    assert.equal(voiceRenderableFor(denied), false);
    assert.equal(voiceRenderableFor(anon), false);
  });
});

test('C-08: VOICE_ENABLED=false refuses everyone with no network call, an entitled caller included', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('the kill switch must not call out'); };
  try {
    await withEnv({ VOICE_ENABLED: 'false' }, async () => {
      assert.equal(voiceAvailableFor(reqWith('op-1', 'ts_a', 'entitled')), false);
      assert.equal(voiceRenderableFor(reqWith('op-1', 'ts_a', 'entitled')), false);
      const res = { s: null, status(v) { this.s = v; return this; }, json() { return this; } };
      assert.equal(requireVoiceForUser(reqWith('op-1', 'ts_a', 'entitled'), res), false);
      assert.equal(res.s, 404);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, 'no network call was made');
});

test('AC: a caller with no identity, or one the gateway did not entitle, sees voice as absent', async () => {
  await withEnv({ VOICE_ENABLED: 'true' }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      // The reference: what the world looks like when voice is globally off.
      const offBody = { enabled: false, voice_enabled_for_this_user: false,
                        stt_ready: false, tts_ready: false, models_loaded: [] };

      // No identity: refused on every route with the indistinguishable 404.
      const t = await fetch(`${base}/voice/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(1),
      });
      assert.equal(t.status, 404);
      assert.deepEqual(await t.json(), { error: 'not_found' }, 'only "not found" -- never "you are not allowed"');
      const s = await fetch(`${base}/voice/synthesize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', language: 'en' }),
      });
      assert.equal(s.status, 404);

      // Health: byte-identical to voice being off for a stranger with no
      // identity and for a user the gateway did not entitle (a student).
      const bodies = [];
      for (const [label, headers] of [
        ['no identity', {}],
        ['identity, no claim', { 'X-Tenax-User-Id': 'op-2' }],
        ['identity, denied', { 'X-Tenax-User-Id': 'op-3', 'X-Tenax-Voice-Entitlement': 'denied' }],
      ]) {
        const h = await fetch(`${base}/voice/health`, { headers });
        assert.equal(h.status, 200, label);
        const text = await h.text();
        assert.deepEqual(JSON.parse(text), offBody, `${label}: indistinguishable from voice being off`);
        bodies.push(text);
      }
      assert.equal(new Set(bodies).size, 1, 'the three refusals are byte-identical');
    } finally { await close(); }
  });
});

test('AC: an entitled caller reaches the routes and the surface with no list of any kind', async () => {
  // The negative row carried from the retired suite: an entitled non-student
  // speaks with no grant and nothing configured on the connector for them.
  await withEnv({ VOICE_ENABLED: 'true' }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      const s = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'en' }),
      });
      assert.notEqual(s.status, 404, 'not gated out');
      assert.ok([422, 500].includes(s.status), `expected an engine or catalogue answer, got ${s.status}`);

      const zh = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'zh' }),
      });
      assert.equal(zh.status, 422);
      assert.equal((await zh.json()).error, 'unsupported_language');

      const t = await fetch(`${base}/voice/transcribe`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'audio/wav' }),
        body: Buffer.from('not audio'),
      });
      assert.equal(t.status, 415, 'and reaches the real validator');

      const h = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
      assert.equal(h.enabled, true);
      assert.equal(h.voice_enabled_for_this_user, true);
      assert.equal(h.allowlist, undefined, 'there is no allowlist to describe');
    } finally { await close(); }
  });
});

test('AC: the kill switch shuts an entitled caller out too', async () => {
  await withEnv({ VOICE_ENABLED: undefined }, async () => {
    const { base, close } = await listen(makeApp());
    try {
      const s = await fetch(`${base}/voice/synthesize`, {
        method: 'POST',
        headers: asUser('op-1', null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'hello', language: 'en' }),
      });
      assert.equal(s.status, 404, 'VOICE_ENABLED unset overrides the claim entirely');

      const h = await (await fetch(`${base}/voice/health`, { headers: asUser('op-1') })).json();
      assert.equal(h.enabled, false);
      assert.equal(h.voice_enabled_for_this_user, false);
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

  withEnv({ VOICE_ENABLED: 'true' }, () => {
    const ok = mk();
    assert.equal(requireVoiceForUser(reqWith('op-1'), ok), true);
    assert.equal(ok._status, null, 'an identified caller gets no response written');

    const refused = mk();
    assert.equal(requireVoiceForUser(reqWith(null), refused), false);
    assert.equal(refused._status, 404);
    assert.deepEqual(refused._payload, { error: 'not_found' });
  });

  // The global guard, for comparison. Identical status and identical body.
  withEnv({ VOICE_ENABLED: undefined }, () => {
    const global = mk();
    assert.equal(requireVoiceEnabled(global), false);
    assert.equal(global._status, 404);
    assert.deepEqual(global._payload, { error: 'not_found' });
  });
});

test('the engines are installed in the image, in separate environments', () => {
  // v12.46.0 shipped requirements files and documented the pip commands but
  // never touched the Dockerfile, so neither engine was present and nothing
  // could transcribe however the gates were set.
  const df = readFileSync(join(HERE, '..', '..', 'Dockerfile'), 'utf8');

  assert.ok(/faster-whisper==/.test(df), 'faster-whisper is installed');
  assert.ok(/kokoro-onnx==/.test(df), 'kokoro-onnx is installed');
  assert.ok(/piper-tts/.test(df) === false, 'and no Piper install survives');

  // v13. THE LICENCE BOUNDARY SURVIVED THE ENGINE SWAP, and this is where the
  // build has to prove it.
  //
  // Kokoro-82M is Apache-2.0, so the separate venv looks like ceremony now. It
  // is not: kokoro-onnx phonemises through `phonemizer`, which drives espeak-ng,
  // and espeak-ng is GPL-3.0. The dependency moved from the model to the
  // phonemiser. Installing the two together would still put GPL code in the
  // interpreter our MIT helper imports from.
  assert.ok(/python3 -m venv \/opt\/kokoro/.test(df), 'Kokoro gets its own venv');
  assert.ok(/espeak-ng/.test(df),
    'espeak-ng is installed as a system package, since phonemizer shells out to it');

  const kokoroInstall = df.slice(df.indexOf('/opt/kokoro/bin/pip install'),
                                 df.indexOf('/opt/kokoro/bin/pip install') + 320);
  assert.ok(!/faster-whisper/.test(kokoroInstall),
    'and faster-whisper is NOT installed into it');

  const whisperLine = df.slice(df.indexOf('faster-whisper=='), df.indexOf('faster-whisper==') + 120);
  assert.ok(!/kokoro/.test(whisperLine), 'nor Kokoro into system packages');

  assert.ok(/VOICE_KOKORO_PYTHON=\/opt\/kokoro\/bin\/python3/.test(df),
    'and the interpreter path is defaulted to match the venv');
  // v13.2.0. INVERTED, deliberately. This asserted that both artifact paths were
  // pinned by ENV. They no longer are, and must not be: pinning them defeats the
  // layered resolution in kokoro-worker-supervisor.js
  //
  //     explicit env  ->  volume, if present  ->  the copy baked into the image
  //
  // which is what makes the baked copy a FLOOR rather than a ceiling. With the
  // paths unset a fresh deploy runs the image copy and works immediately, while
  // an operator who drops a newer model onto the volume gets it picked up on the
  // next restart with no rebuild.
  assert.ok(! /VOICE_KOKORO_MODEL=/.test(df),
    'the model path must NOT be pinned in the image');
  assert.ok(! /VOICE_KOKORO_VOICES=/.test(df),
    'nor the bundle path');
  assert.ok(/VOICE_KOKORO_DIR=/.test(df),
    'but the volume override location is still named');
  assert.ok(/mkdir -p \/opt\/kokoro\/models/.test(df),
    'and the artifacts are baked into the image, outside the volume mount');

  // The build proves the engine IMPORTS in the venv that will run it. A build
  // that ships an unimportable engine produces a worker which starts, reports
  // ready, and fails every request.
  assert.ok(/import kokoro_onnx/.test(df),
    'the build verifies the engine imports rather than assuming it');
  // A browser sends WebM or MP4; the decoder needs the system codecs.
  assert.ok(/ffmpeg/.test(df), 'ffmpeg is present for browser audio containers');
});
