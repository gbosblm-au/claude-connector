// src/tests/voice-registry.test.js
//
// SPEC-KOKORO-001 v1.1, Section 8 (Voice Library and Registry)
//                       Section 10 (Per-Assistant / Per-Tenant Voice Selection)
//
// Run: node --test src/tests/voice-registry.test.js

import test   from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_REGISTRY, TTS_LANGUAGES, DEFAULT_VOICE, SAMPLE_RATES, NATIVE_SAMPLE_RATE,
  outputSampleRate, findVoice, voicePermitted, resolveVoice, reconcile,
  speakableLanguages, attributions, registryState,
} from '../voice/voice-registry.js';

/** The set this deployment was asked to ship. Platform decision, 2026-08-19. */
const DEPLOYED = ['af_bella', 'af_nicole', 'af_heart', 'bf_emma', 'af_aoede'];

// ===========================================================================
// The deployed set
// ===========================================================================

test('exactly the five approved voices are registered', () => {
  assert.deepEqual(VOICE_REGISTRY.map(v => v.name).sort(), [...DEPLOYED].sort());
});

test('af_bella is the platform default', () => {
  assert.equal(DEFAULT_VOICE, 'af_bella');
  assert.equal(findVoice(DEFAULT_VOICE).role, 'default');
  assert.equal(VOICE_REGISTRY.filter(v => 'default' === v.role).length, 1,
    'exactly one voice is the default');
});

test('voice names use underscores, as Kokoro names them', () => {
  // The decision was written "af-bella". Kokoro's own identifier is af_bella,
  // and a hyphen would be an unknown voice.
  for (const v of VOICE_REGISTRY) {
    assert.match(v.name, /^[a-z]{2}_[a-z]+$/u, `${ v.name } is not a Kokoro voice id`);
    assert.ok(! v.name.includes('-'), `${ v.name } uses a hyphen`);
  }
});

test('every voice carries a resolved commercial licence', () => {
  // Unlike the Piper catalogue, there is no unverified state here: one model,
  // Apache-2.0, every voice a vector inside it. A null licence would be a
  // regression in what an operator can answer.
  for (const v of VOICE_REGISTRY) {
    assert.match(v.licence, /Apache-2\.0/u, `${ v.name } has no licence`);
    assert.equal(v.commercial_ok, true, `${ v.name } is not cleared`);
    assert.equal(v.attribution_required, false);
  }
});

test('a voice addresses a vector inside a bundle, not a file of its own', () => {
  // Section 8 models `weight_file` as one .pt per voice. kokoro-onnx v1.0 ships
  // one model and one voices bin holding every voice as a style vector, so a row
  // is bundle + name.
  for (const v of VOICE_REGISTRY) {
    assert.equal(v.bundle, 'voices-v1.0.bin');
    assert.ok(! ('weight_file' in v), `${ v.name } still models a per-voice file`);
  }
});

// ===========================================================================
// Languages -- the deliberate loss
// ===========================================================================

test('TTS is English only, and that is recorded rather than implied', () => {
  // Kokoro has no Vietnamese voice at any version, and none of the five
  // deployed voices is Japanese or Mandarin. Accepted on the platform decision
  // of 2026-08-19: Piper was a proof of concept.
  assert.deepEqual([...TTS_LANGUAGES], ['en']);
  for (const v of VOICE_REGISTRY) assert.equal(v.language, 'en');
});

test('no Piper-era voice id resolves', () => {
  // The client may still hold one of these in a stored preference or a tenant
  // setting after the cutover.
  for (const stale of ['en_US-kristin-medium', 'vi_VN-vais1000-medium',
                       'zh_CN-huayan-medium', 'ja_JP-ryoko-medium']) {
    assert.equal(findVoice(stale), null);
    assert.equal(voicePermitted(stale).reason, 'unknown_voice');
  }
});

test('a refusal names the available set rather than saying "invalid"', () => {
  // The caller is usually a stale setting, and the fix is to pick from the list.
  const refusal = voicePermitted('vi_VN-vais1000-medium');
  assert.ok(refusal.message.includes('af_bella'), 'the message lists the options');
});

// ===========================================================================
// Section 10 -- voice resolution
// ===========================================================================

test('Section 10: resolution follows request, assistant, tenant, default', () => {
  assert.equal(resolveVoice({ requested: 'bf_emma', assistant: 'af_heart',
                              tenant: 'af_nicole' }).voice, 'bf_emma');
  assert.equal(resolveVoice({ assistant: 'af_heart', tenant: 'af_nicole' }).voice,
    'af_heart');
  assert.equal(resolveVoice({ tenant: 'af_nicole' }).voice, 'af_nicole');
  assert.equal(resolveVoice({}).voice, DEFAULT_VOICE);
  assert.equal(resolveVoice().voice, DEFAULT_VOICE);
});

test('resolution reports which level answered', () => {
  assert.equal(resolveVoice({ tenant: 'af_nicole' }).source, 'tenant');
  assert.equal(resolveVoice({}).source, 'default');
});

test('a stale value falls through instead of failing, and is reported', () => {
  // A stale voice name in a tenant setting is a configuration problem. The right
  // response is a reply in the default voice plus a log line an operator can
  // act on -- not silence.
  const out = resolveVoice({ tenant: 'vi_VN-vais1000-medium' });
  assert.equal(out.voice, DEFAULT_VOICE);
  assert.equal(out.source, 'default');
  assert.deepEqual(out.ignored, [{ level: 'tenant', value: 'vi_VN-vais1000-medium' }]);
});

test('a stale value at one level does not block a good one below it', () => {
  const out = resolveVoice({ requested: 'nonsense', tenant: 'bf_emma' });
  assert.equal(out.voice, 'bf_emma');
  assert.equal(out.ignored.length, 1);
});

test('blank and whitespace values are skipped, not treated as stale', () => {
  // An unset tenant setting is the common case and must not generate a warning.
  const out = resolveVoice({ requested: '', assistant: '   ', tenant: null });
  assert.equal(out.voice, DEFAULT_VOICE);
  assert.deepEqual(out.ignored, []);
});

// ===========================================================================
// Sample rate -- the admin switch
// ===========================================================================

test('24 kHz is the default because it is the native rate', () => {
  // The native rate involves no processing and so cannot introduce an artifact.
  assert.equal(NATIVE_SAMPLE_RATE, 24_000);
  assert.equal(outputSampleRate(undefined), 24_000);
  assert.equal(outputSampleRate(''), 24_000);
  assert.equal(outputSampleRate(null), 24_000);
});

test('16 kHz is selectable', () => {
  assert.equal(outputSampleRate('16000'), 16_000);
  assert.equal(outputSampleRate(16_000), 16_000);
  assert.equal(outputSampleRate(' 16000 '), 16_000);
});

test('an unrecognised rate falls back rather than being honoured', () => {
  // A typo in an env var must not resample every reply through an untested
  // ratio.
  for (const bad of ['44100', '8000', '0', '-1', 'fast', '24000.5']) {
    assert.equal(outputSampleRate(bad), NATIVE_SAMPLE_RATE, `honoured ${ bad }`);
  }
});

test('every selectable rate includes the native one', () => {
  assert.ok(SAMPLE_RATES.includes(NATIVE_SAMPLE_RATE));
});

// ===========================================================================
// Reconciliation against the bundle
// ===========================================================================

test('the bundle is the authority on which voices exist', () => {
  const out = reconcile(['af_bella', 'bf_emma', 'am_adam', 'jf_alpha']);
  assert.deepEqual(out.available.map(v => v.name), ['af_bella', 'bf_emma']);
  assert.deepEqual(out.missing.sort(), ['af_aoede', 'af_heart', 'af_nicole']);
  assert.deepEqual(out.extra, ['am_adam', 'jf_alpha'],
    'voices the bundle has but this deployment does not offer');
  assert.equal(out.reconciled, true);
});

test('an unknown bundle is NOT the same as an empty one', () => {
  // At boot, or with the worker disabled, nothing has reported yet. Narrowing
  // the registry to zero would make the platform look mute during startup.
  for (const unknown of [null, undefined, []]) {
    const out = reconcile(unknown);
    assert.equal(out.available.length, DEPLOYED.length);
    assert.equal(out.reconciled, false, 'and it says so');
    assert.deepEqual(out.missing, []);
  }
});

test('speakableLanguages narrows only when the bundle genuinely lacks voices', () => {
  assert.deepEqual(speakableLanguages(null), ['en'], 'unknown bundle: assume ready');
  assert.deepEqual(speakableLanguages(['af_bella']), ['en']);
  assert.deepEqual(speakableLanguages(['zz_nobody']), [],
    'a bundle with none of our voices can speak nothing');
});

test('a missing voice is named, not buried in a count', () => {
  // It is the one state an operator has to act on.
  const state = registryState(['af_bella']);
  assert.deepEqual(state.unavailable.sort(),
    ['af_aoede', 'af_heart', 'af_nicole', 'bf_emma']);
});

// ===========================================================================
// Reported state
// ===========================================================================

test('registryState reports what the admin surface needs', () => {
  const state = registryState(null);
  assert.equal(state.engine, 'kokoro');
  assert.equal(state.licence, 'Apache-2.0');
  assert.equal(state.default_voice, 'af_bella');
  assert.deepEqual(state.languages, ['en']);
  assert.equal(state.native_sample_rate, 24_000);
  assert.deepEqual(state.selectable_sample_rates, [24_000, 16_000]);
  assert.equal(state.voices.length, DEPLOYED.length);
  for (const v of state.voices) {
    assert.ok(v.name && v.label && v.accent, 'each voice is presentable in a UI');
  }
});

test('attributions cover every active voice', () => {
  const notices = attributions();
  assert.equal(notices.length, DEPLOYED.length);
  for (const n of notices) assert.match(n.licence, /Apache-2\.0/u);
});

test('the registry is immutable', () => {
  // It is read on every synthesis; a caller mutating it would change the
  // offered set for the process lifetime.
  assert.throws(() => { VOICE_REGISTRY.push({ name: 'x' }); });
  assert.throws(() => { TTS_LANGUAGES.push('vi'); });
});

// ===========================================================================
// v13.0.1 -- the per-request sample rate reaches the engine
// ===========================================================================
//
// The gap this closes: v13.0.0 shipped a registry that could express a rate, a
// gateway that injected one, and a connector route that never read it. Each
// piece was correct alone and the feature did nothing -- the 16 kHz setting was
// accepted, stored, sent, and silently discarded at the last hop.
//
// Structural, against comment-free source, because the whole point is that a
// value threads through several call sites and a gap at any one of them is
// invisible from the others.

import { speakableLanguages as catalogSpeakable } from '../voice/voice-catalog.js';
import { readFileSync as _read } from 'node:fs';
import { fileURLToPath as _url } from 'node:url';
import { dirname as _dir, join as _join } from 'node:path';

const _HERE = _dir(_url(import.meta.url));
const _SRC = _join(_HERE, '..');

function _code(rel) {
  return _read(_join(_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the route refuses an unsupported rate rather than ignoring it', () => {
  const routes = _code('routes/voice.js');
  assert.match(routes, /function parseSampleRate\( ?body, res ?\)/u);
  assert.match(routes, /'unsupported_sample_rate'/u);
  // The three-way return is the design: "nothing asked for" and "asked for
  // something invalid" are different outcomes, and collapsing them would let an
  // unsupported rate silently produce audio at some other rate -- the one
  // failure an admin cannot diagnose by listening.
  assert.match(routes, /if \(undefined === raw \|\| null === raw \|\| '' === raw\) return undefined;/u);
  assert.match(routes, /return false;/u);
});

test('every route that accepts a sample rate parses it before doing any work', () => {
  const routes = _code('routes/voice.js');

  // v13.5.0. REWRITTEN, because the previous version of this test passed for
  // the wrong reason and hid a live defect.
  //
  // It counted `= parseSampleRate(body, res)` and asserted exactly 2, with the
  // message "the single-call and stream routes both parse it". The two matches
  // were actually /voice/synthesize and /voice/prosody/analyse. The STREAM
  // route never parsed it -- it referenced a `streamRate` declared inside the
  // analyse handler, a different function scope, and threw ReferenceError on
  // every streamed request. The test was green throughout.
  //
  // A global count cannot express "each of these routes does X"; it only
  // expresses "X appears N times somewhere". Checked per route now, so a route
  // that skips the parse fails whatever the total happens to be, and adding a
  // fifth route that parses correctly does not turn a correct extension red.
  const handlers = ['/voice/synthesize', '/voice/synthesize/stream',
                    '/voice/synthesize/incremental', '/voice/prosody/analyse'];

  /**
   * The body of one route handler, from its declaration to the next one.
   *
   * @param {string} path
   * @returns {string}
   */
  function handlerFor(path) {
    const at = routes.indexOf(`app.post('${path}'`);
    assert.notEqual(at, -1, `the ${path} route must exist`);
    const rest = routes.slice(at + 1);
    const next = rest.search(/app\.(post|get)\('/u);
    return next === -1 ? rest : rest.slice(0, next);
  }

  for (const path of handlers) {
    const body = handlerFor(path);
    assert.match(body, /= parseSampleRate\(body, res\)/u,
      `${path} parses the requested sample rate`);
    assert.match(body, /if \(false === \w+Rate\) return;/u,
      `${path} stops on a refusal instead of continuing with an invalid value`);
  }

  // The declaration and the refusal check must be in the SAME handler, which
  // is the property whose absence caused the stream-route defect. Comparing
  // the two totals catches a declaration that has drifted out of the scope
  // that reads it.
  assert.equal((routes.match(/= parseSampleRate\(body, res\)/gu) || []).length,
               (routes.match(/if \(false === \w+Rate\) return;/gu) || []).length,
    'every parse is paired with its own refusal check');
});

test('the rate reaches EVERY engine call, not just the common one', () => {
  // The failure this guards: Compare, the prosody fallback and the flat path
  // are three separate calls. A rate threaded into two of them produces a reply
  // whose halves are at different rates, which sounds like a fault in the voice.
  const routes = _code('routes/voice.js');
  const synthCalls = (routes.match(/await synthesize\(\{/gu) || []).length;
  const withRate = (routes.match(/sampleRate: requestedRate/gu) || []).length;
  assert.ok(withRate >= synthCalls,
    `${synthCalls} synthesize call(s) but only ${withRate} carry the rate`);
});

test('the engine threads the rate down to each phrase worker', () => {
  // The prosody layer renders phrase by phrase and concatenates. A rate applied
  // to the header but not to the phrases produces a WAV that declares one rate
  // and contains another -- which plays at the wrong pitch and speed, for the
  // whole reply.
  const engines = _code('voice/voice-engines.js');
  assert.equal((engines.match(/sampleRate: sampleRate,/gu) || []).length, 2,
    'both the buffered and streaming phrase workers carry the rate');
  assert.match(engines, /_sampleRates\.set\(o\.voice, ttsOutputRate\(o\.sampleRate\)\)/u,
    'and the cache is seeded before the header rate is read from it');
});

test('a per-request rate wins over the deployment default', () => {
  const engines = _code('voice/voice-engines.js');
  const fn = engines.slice(engines.indexOf('function ttsOutputRate'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(undefined !== requested/u,
    'the request is consulted first');
  assert.match(body, /process\.env\.VOICE_TTS_SAMPLE_RATE/u,
    'and the env var remains the fallback for a single-tenant install');
});

test('status offers labelled voices as well as bare ids', () => {
  // voices_installed stays exactly as it is, because clients gate on it. The
  // labelled list is additive: without it an admin picking a voice for their
  // whole workspace can only read `af_bella`.
  const routes = _code('routes/voice.js');
  assert.match(routes, /voices_installed: engines\.voices_installed \|\| \[\],/u,
    'the id list is unchanged');
  assert.match(routes, /voices: registryState\(engines\.voices_installed \|\| \[\]\)\.voices,/u,
    'and is narrowed to what is installed, not to what the registry offers');
});

// ===========================================================================
// v13.1.1 -- VOICE_TTS_TENANT_VOICE is read, not just reported
// ===========================================================================

test('the tenant voice env var is actually used for resolution', () => {
  // THE DEFECT THIS PREVENTS. VOICE_TTS_TENANT_VOICE was reported in
  // /voice/health as though it were a setting and was read by NOTHING. An
  // operator could set it, see it echoed back in the health payload, and get no
  // change in the voice -- the worst shape a configuration bug can take,
  // because the system appears to confirm the setting.
  const routes = _code('routes/voice.js');
  assert.match(routes,
    /resolveVoice as resolveFromRegistry/u,
    'the route imports the registry resolver');
  assert.match(routes,
    /tenant: process\.env\.VOICE_TTS_TENANT_VOICE/u,
    'and feeds the env var into it');
});

test('an explicit request still outranks the tenant default', () => {
  // The gateway injects a per-tenant voice into body.voice for a multi-tenant
  // install, so that level must win over this single-tenant fallback.
  assert.equal(resolveVoice({ requested: 'af_heart', tenant: 'bf_emma' }).voice,
    'af_heart');
  assert.equal(resolveVoice({ requested: '', tenant: 'bf_emma' }).voice, 'bf_emma');
});

test('a stale tenant env value costs a log line, not every reply', () => {
  const out = resolveVoice({ tenant: 'en_US-kristin-medium' });
  assert.equal(out.voice, DEFAULT_VOICE);
  assert.deepEqual(out.ignored, [{ level: 'tenant', value: 'en_US-kristin-medium' }]);

  const routes = _code('routes/voice.js');
  assert.match(routes, /for \(const ignored of fromRegistry\.ignored\)/u,
    'and the route reports what it ignored');
});

test('the per-request voice never loses to a language default', () => {
  // The registry value is adopted ONLY when the caller named neither a voice
  // nor a language. With a language present, bestVoiceForLanguage is more
  // specific because it checks what is actually installed -- overriding it here
  // would reintroduce the "registered but not in the bundle" 500 it prevents.
  const routes = _code('routes/voice.js');
  assert.match(routes,
    /if \(!voice && !language && 'default' !== fromRegistry\.source\)/u,
    'the registry default is scoped to the no-voice, no-language case');
});

test('no user-facing message describes the retired Piper licence model', () => {
  // A message telling an operator that "each Piper voice is governed by its own
  // MODEL_CARD and some are non-commercial" sends them hunting a licence
  // problem that cannot exist under one Apache-2.0 model.
  const routes = _code('routes/voice.js');
  assert.ok(! /Piper voice is governed/u.test(routes));
  assert.ok(! /non-commercial, so voices are refused until audited/u.test(routes));
});

// ===========================================================================
// v13.2.0 -- artifacts survive a redeploy
// ===========================================================================

test('the baked artifact directory is NOT under the volume mount', () => {
  // THE MISTAKE THIS PREVENTS. v13.0.0's Dockerfile ran
  // `mkdir -p /data/voice/kokoro` and pointed the engine there. On a platform
  // that mounts a persistent volume at /data, THE MOUNT SHADOWS EVERYTHING THE
  // IMAGE PUT THERE -- so baking to that path would have produced files that
  // exist in the layer and are unreachable at runtime.
  const sup = _code('voice/kokoro-worker-supervisor.js');
  assert.match(sup, /const BAKED_DIR = '\/opt\/kokoro\/models';/u);
  assert.ok(! /BAKED_DIR = '\/data/u.test(sup),
    'the baked path must not sit under a mount point');
});

test('artifact resolution is layered: env, then volume, then image', () => {
  const sup = _code('voice/kokoro-worker-supervisor.js');
  const fn = sup.slice(sup.indexOf('function resolveArtifact'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  // Order matters and is asserted by position, because a resolver that checked
  // the image first would ignore an operator's newer model on the volume.
  assert.ok(body.indexOf('const explicit') < body.indexOf('onVolume'),
    'an explicit env var is consulted first');
  assert.ok(body.indexOf('onVolume') < body.indexOf('BAKED_DIR'),
    'the volume override outranks the baked copy');
  // An explicit path is honoured even when absent, so the failure names what
  // the operator configured rather than silently running different weights.
  assert.match(body, /if \(explicit\) return explicit;/u);
});

test('the Dockerfile bakes the artifacts and proves they load', () => {
  const df = _read(_join(_SRC, '..', 'Dockerfile'), 'utf8');
  assert.match(df, /mkdir -p \/opt\/kokoro\/models/u, 'baked into the image');
  assert.match(df, /kokoro-v1\.0\.onnx/u);
  assert.match(df, /voices-v1\.0\.bin/u);

  // Size floors, in the build. curl -f rejects an HTTP error, but a truncated
  // transfer can arrive with a 200 -- and onnxruntime's message for a short
  // model is an opaque parse failure at FIRST SYNTHESIS.
  assert.match(df, /-ge 104857600/u, 'the model has a size floor');
  assert.match(df, /-ge 1048576/u, 'the bundle has a size floor');

  // And a real load, because a size floor does not prove the weights parse.
  assert.match(df, /verify-kokoro-artifacts\.py/u);
});

test('the Dockerfile does NOT pin the artifact paths', () => {
  // Setting VOICE_KOKORO_MODEL would defeat the layered resolution entirely and
  // make the image copy a ceiling rather than a floor.
  const df = _read(_join(_SRC, '..', 'Dockerfile'), 'utf8');
  assert.ok(! /ENV[\s\S]{0,400}VOICE_KOKORO_MODEL=/u.test(df),
    'VOICE_KOKORO_MODEL must not be set in the image');
  assert.ok(! /VOICE_KOKORO_VOICES=/u.test(df),
    'nor VOICE_KOKORO_VOICES');
  assert.match(df, /VOICE_KOKORO_DIR=/u,
    'but the volume override location is still named');
});

test('health reports which layer supplied the artifacts', () => {
  // The paths alone cannot answer "why does it sound different since the
  // redeploy": a volume path and an image path look equally plausible in a log.
  const eng = _code('voice/voice-engines.js');
  assert.match(eng, /KOKORO_ARTIFACT_SOURCE: artifactSource\(\)/u);
  const sup = _code('voice/kokoro-worker-supervisor.js');
  assert.match(sup, /return resolved\.startsWith\(BAKED_DIR\) \? 'image' : 'volume';/u);
});

test('boot provisioning stays off and no longer warns about a normal deploy', () => {
  // With the artifacts baked in, absent-from-the-volume is the EXPECTED state.
  // Warning on every boot would train an operator to ignore the log line that
  // matters -- which is the one saying neither layer has them.
  const prov = _code('voice/voice-provision.js');
  assert.match(prov, /const bakedMissing = missingFromVolume/u,
    'the warning is gated on the baked copy being absent too');
  assert.match(prov, /on NEITHER the volume/u,
    'and says so plainly when the image was built without them');
});

// ===========================================================================
// v13.2.1 -- the speakable_languages contract
// ===========================================================================
//
// THE PRODUCTION FAULT THIS PREVENTS, reproduced end to end.
//
// v13.0.0 rewrote voice-catalog.speakableLanguages() to return a plain array.
// It read as a tidy-up. routes/voice.js emits
// `speakable_languages: speakable.languages`, so on an array that expression is
// `undefined`; JSON.stringify DROPS an undefined value; the gateway's
// `( connector.speakable_languages ) || []` turns the missing key into `[]`;
// and the browser renders "Unavailable: no voice is installed on this
// workspace" -- with tts_ready TRUE and five voices genuinely installed.
//
// Not one layer failed loudly. Every one did something defensible with a
// missing field, which is exactly why it survived a green test suite, a passing
// smoke test, and a deploy.

test('speakableLanguages returns the SHAPE the route emits, not a bare array', () => {
  const out = catalogSpeakable([ 'af_bella', 'bf_emma' ]);

  assert.ok(! Array.isArray(out),
    'a bare array makes speakable.languages undefined at the call site');
  assert.deepEqual(out.languages, [ 'en' ]);
  assert.deepEqual(out.by_language, { en: [ 'af_bella', 'bf_emma' ] });
});

test('the emitted payload survives a JSON round trip with the field intact', () => {
  // The step that hid it. An undefined value does not throw and does not warn:
  // the key simply is not there on the other side.
  const speakable = catalogSpeakable([ 'af_bella' ]);
  const wire = JSON.parse(JSON.stringify({
    tts_ready: true,
    voices_installed: [ 'af_bella' ],
    speakable_languages: speakable.languages,
    speakable_by_language: speakable.by_language,
  }));

  assert.ok('speakable_languages' in wire,
    'the key must reach the wire -- undefined would be dropped silently');
  assert.deepEqual(wire.speakable_languages, [ 'en' ]);

  // And the gateway's own defaulting, which turned the missing key into [].
  const relayed = (wire && wire.speakable_languages) || [];
  assert.deepEqual(relayed, [ 'en' ],
    'the gateway relays a real language list, not an empty fallback');
});

test('no voices installed still yields an empty list, not a missing key', () => {
  // The genuinely-empty case must stay distinguishable from the broken one.
  const out = catalogSpeakable([]);
  assert.deepEqual(out.languages, []);
  assert.deepEqual(out.by_language, {});
});

test('the route reads .languages, which is why the shape cannot change', () => {
  const routes = _code('routes/voice.js');
  assert.match(routes, /speakable_languages: speakable\.languages/u);
  assert.match(routes, /speakable_by_language: speakable\.by_language/u);
});
