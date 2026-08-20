// src/routes/voice.js
//
// Tenax Voice -- HTTP routes. Specification Section 8 (API contract),
// Section 7 (gating), Section 15 (security).
//
// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
//
//   GET  /voice/health       Always answers, even when the gate is off.
//   POST /voice/transcribe   Gated. 404 when off.
//   POST /voice/synthesize   Gated. 404 when off.
//
// /voice/health is the one voice route that is never 404 (Section 8.1), so the
// UI can learn in one cheap call that the feature is unavailable instead of
// probing a route that does not answer.
//
// ---------------------------------------------------------------------------
// STATUS CODES ARE THE CONTRACT (Section 8.2, 8.3)
// ---------------------------------------------------------------------------
//
//   200  result returned            413  audio too large / too long
//   404  feature gate off           415  unsupported audio format
//   422  unsupported voice/language 429  rate limit exceeded
//   500  engine error
//
// Section 16 is specific that an unsupported voice or language must be "a clear
// 422 with a message the UI can render, not a 500". So every rejection here
// carries a human-readable `message` alongside a machine-readable `error`, and
// 500 is reserved for a genuinely unexpected engine failure.
//
// ---------------------------------------------------------------------------
// NO npm DEPENDENCIES ADDED
// ---------------------------------------------------------------------------
//
// Matching volume-snapshot.js. Multipart is read by src/voice/multipart.js from
// a body express.raw() has already size-limited; rate limiting uses
// express-rate-limit, already a dependency.

import express                    from 'express';
import rateLimit                  from 'express-rate-limit';

import { voiceEnabled, gateState, benchmarkState,
         voiceAvailableFor, voiceAvailableForAsync,
         allowlistDiagnostics, currentAllowlistSource,
         resolveIdentity, testUsers } from '../voice/voice-gate.js';
import { allowlistConfigProblems,
         deploymentConfigProblems } from '../voice/voice-allowlist.js';
// v12.50.0: the transport credential. MCP_API_KEY (operator) or
// RAILWAY_RESTORE_TOKEN (gateway). See src/voice/voice-auth.js for why the
// gateway could not previously reach these routes at all.
import { voiceCredential }        from '../voice/voice-auth.js';
// v12.50.0: optional background download of Piper voice models onto the volume.
// The image cannot ship them -- the Railway volume is mounted over /data at
// runtime, masking anything the build wrote there.
import { provisionFromEnv }       from '../voice/voice-provision.js';
import { parseMultipart }         from '../voice/multipart.js';
import { validateAudio, maxBytes,
         ACCEPTED_FORMATS }       from '../voice/audio-validate.js';
import { voicePermitted, voicesForLanguage,
         catalogState, TTS_LANGUAGES,
         // v12.51.0: a language is only offerable when a permitted voice is
         // also INSTALLED. The catalogue answers the licence question; these
         // two answer "would it actually speak".
         speakableLanguages, bestVoiceForLanguage,
         attributions }           from '../voice/voice-catalog.js';
// v13.0.1. SAMPLE_RATES and registryState come from the registry rather than
// being restated here: the offered rates are a property of the model, and a
// second list would be a second answer to the same question.
import { SAMPLE_RATES, registryState, resolveVoice as resolveFromRegistry }
                                 from '../voice/voice-registry.js';
import { probeEngines, engineState, installedVoices,
         transcribe, synthesize,
         // v12.53.0 -- the prosody layer (TS-VOICE-PROSODY-v1.0).
         synthesizeProsody, synthesizeProsodyStream,
         voiceLengthScale, prosodyState,
         // v12.53.0 -- PIPER-PRELOAD-v1.1 Sections 4.3, 5.
         prewarmTts, ttsWorkerState,
         // v12.54.0 -- PIPER-PRELOAD-v1.1 Section 6 (Change 3).
         prewarmStt, sttWorkerHealth } from '../voice/voice-engines.js';
import { analyse, prosodyConfig, replyHash,
         summarise }                 from '../voice/prosody.js';

/* Section 15: "Rate limiting per user on both voice routes." Voice is far more
 * expensive per request than a normal API call -- one transcription can occupy
 * the CPU for seconds -- so the ceiling is low by design. */
const WINDOW_MS = intEnv('VOICE_RATE_WINDOW_MS', 60_000);
const MAX_REQS  = intEnv('VOICE_RATE_MAX', 20);

/**
 * The output sample rate this request asked for, if any.
 *
 * v13.0.1 -- SPEC-KOKORO-001 Section 12.
 *
 * Returns `undefined` when nothing was asked for (the deployment default then
 * applies), a number when a valid rate was, and `false` when the request was
 * REFUSED -- in which case this has already sent the response.
 *
 * The three-way return is deliberate. "Nothing asked for" and "asked for
 * something invalid" are genuinely different outcomes, and collapsing them
 * would mean an unsupported rate silently produced audio at some other rate --
 * which is the one failure an admin cannot diagnose by listening.
 *
 * @param {object} body
 * @param {object} res
 * @returns {number|undefined|false}
 */
function parseSampleRate(body, res) {
  const raw = body ? body.sample_rate : undefined;
  if (undefined === raw || null === raw || '' === raw) return undefined;

  const wanted = Number(raw);
  if (!Number.isFinite(wanted) || !SAMPLE_RATES.includes(wanted)) {
    res.status(422).json({
      error: 'unsupported_sample_rate',
      // Names what IS offered. The caller is usually the gateway relaying a
      // tenant setting, and the operator reading this needs the valid set.
      message: `Sample rate must be one of ${SAMPLE_RATES.join(', ')}.`,
    });
    return false;
  }
  return wanted;
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-user limiter.
 *
 * Keyed on the authenticated identity where there is one, falling back to IP.
 * Keying on IP alone would let one user behind a shared address exhaust the
 * budget for everyone behind it, and would let one user with several addresses
 * bypass it entirely.
 */
const voiceLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = req.tsTenantId || (req.user && req.user.id) || req.userId;
    return id ? `voice:${id}` : `voice:ip:${req.ip}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'rate_limited',
      message: 'Too many voice requests. Wait a moment and try again.',
      retry_after_seconds: Math.ceil(WINDOW_MS / 1000),
    });
  },
});

/**
 * Section 7 layer 2, now two-layer (Per-User Feature Gate Spec Section 4.1).
 *
 * Both must hold: the master switch AND the per-user allowlist. Every refusal
 * produces the byte-identical 404 -- master switch off, identity absent,
 * identity unknown, identity not allowlisted. There is deliberately no separate
 * status or message for "you are not allowlisted": that would confirm the
 * feature exists and that the caller is merely on the wrong side of it, which
 * Section 4.1 forbids.
 *
 * The master switch short-circuits first, so when voice is globally off no
 * identity is read at all.
 */
async function gate(req, res, next) {
  // Async so gateway mode can refresh the allowlist before answering. In env
  // mode this resolves without touching the network, so the cost is a
  // microtask.
  //
  // Errors are swallowed into a 404 rather than surfaced: a refusal must look
  // identical whatever caused it, and a 500 here would tell an unauthorised
  // caller that the feature exists and that something went wrong reaching its
  // allowlist.
  let ok = false;
  try { ok = await voiceAvailableForAsync(req); } catch (e) { ok = false; }
  if (!ok) { res.status(404).json({ error: 'not_found' }); return; }
  next();
}

/**
 * Section 15: "/voice/* routes require an authenticated session, same as the
 * rest of the connector."
 *
 * The check is delegated to whatever the host application already put on the
 * request, rather than reimplemented here. If no authentication layer has run,
 * this FAILS CLOSED -- an unauthenticated deployment must not get free
 * transcription because the middleware order changed.
 */
function requireAuth(req, res, next) {
  // v12.50.0: `req.authenticated` was never set by anything in this connector.
  // mcpAuthMiddleware sets `req.mcpAuthenticated`, and tenantAuthMiddleware --
  // the only thing that sets `req.tsTenantId` -- is mounted on /mcp alone, so
  // it never runs for a voice request. The effect was that a correctly
  // credentialled, correctly allowlisted operator still got
  // 401 unauthenticated from POST /voice/transcribe and /voice/synthesize, and
  // the only way past it was VOICE_ALLOW_UNAUTHENTICATED=true, which reads like
  // switching authentication off to make a feature work.
  //
  // The list now names the flags that actually exist. voiceCredential runs
  // ahead of this handler and sets req.voiceAuthenticated only when a
  // configured credential matched, so this stays a real check rather than a
  // formality: an anonymous caller on a connector with no credential
  // configured at all still lands on the 401 below.
  const authed = !!(req.voiceAuthenticated || req.mcpAuthenticated || req.tsTenantId
                    || req.user || req.userId || req.authenticated);
  if (authed) { next(); return; }

  // The owner-mode connector is single-operator and already sits behind its own
  // MCP authentication; there is no per-user session object to inspect. Opting
  // out is therefore explicit and logged in configuration, never inferred.
  if (String(process.env.VOICE_ALLOW_UNAUTHENTICATED || '').toLowerCase() === 'true') {
    next();
    return;
  }

  res.status(401).json({
    error: 'unauthenticated',
    message: 'Voice requires an authenticated session.',
  });
}

/**
 * Validate the Section 7.2 prosody mode.
 *
 * Returns null for anything unrecognised rather than quietly defaulting. A
 * typo ("prosdy": "on") that silently produced flat audio would look exactly
 * like the layer being broken, and the person debugging it would have no way
 * to tell the two apart.
 *
 * @param {*} raw
 * @returns {string|null} 'on' | 'off' | 'both', or null when invalid.
 */
function parseProsodyMode(raw) {
  if (raw === undefined || raw === null || '' === raw) return 'off';
  const mode = String(raw).trim().toLowerCase();
  return ['on', 'off', 'both'].includes(mode) ? mode : null;
}

/** Never log audio, filenames or transcripts (Section 10). Metadata only. */
function logMeta(direction, meta) {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[voice] ${direction} ${parts.join(' ')}`);
}

/**
 * Resolve and licence-check the voice for a synthesis request.
 *
 * v12.53.0: extracted so /voice/synthesize and /voice/synthesize/stream cannot
 * drift apart on which voices they accept. Two copies of a LICENCE CHECK is
 * exactly the duplication worth removing -- compliance obligation 2 is not
 * something to enforce differently on two routes that reach the same engine.
 *
 * Answers the response itself on every refusal and returns null, so the caller
 * needs only `if (!resolved) return;`.
 *
 * @param {object} body Parsed JSON request body.
 * @param {object} res  Express response.
 * @returns {Promise<{voice: string, permit: object}|null>}
 */
async function resolveVoice(body, res) {
  const language = String(body.language || '').trim().toLowerCase();

  // v13.1.1 -- SPEC-KOKORO-001 Section 10, precedence made real.
  //
  // THE DEFECT THIS FIXES. VOICE_TTS_TENANT_VOICE was reported in
  // /voice/health as though it were a setting and was read by NOTHING. An
  // operator could set it, see it echoed back in the health payload, and get no
  // change in the voice -- which is the worst shape a configuration bug can
  // take, because the system appears to confirm the setting.
  //
  // Precedence is: an explicit per-request voice, then the deployment-wide
  // tenant default, then the platform default. The gateway injects a
  // per-TENANT voice into body.voice, which is why that level wins here -- a
  // multi-tenant install resolves above this function, and this env var is the
  // single-tenant fallback it was always documented to be.
  //
  // A stale or unknown value at either level falls through to the next rather
  // than failing, and is reported. A bad env var should cost a log line, not
  // every reply.
  const fromRegistry = resolveFromRegistry({
    requested: body.voice,
    tenant: process.env.VOICE_TTS_TENANT_VOICE,
  });
  for (const ignored of fromRegistry.ignored) {
    console.warn(`[voice] ignoring unusable ${ignored.level} voice `
      + `"${ignored.value}"; falling back`);
  }

  // Only adopted when the caller named nothing AND no language was given. With
  // a language present the catalogue's own selection below is more specific --
  // it checks what is actually installed -- and overriding it here would
  // reintroduce the "licence-cleared but never downloaded" 500 that
  // bestVoiceForLanguage exists to prevent.
  let voice = String(body.voice || '').trim();
  if (!voice && !language && 'default' !== fromRegistry.source) {
    voice = fromRegistry.voice;
  }

  // No voice named: take the language's default from the catalogue. This is
  // the path most callers use, and it must fail as clearly as an explicitly
  // bad voice does.
  if (!voice) {
    if (!language) {
      res.status(422).json({
        error: 'no_voice_or_language',
        message: 'Specify a voice, or a language to pick the default voice for.',
      });
      return null;
    }
    if (!TTS_LANGUAGES.includes(language)) {
      res.status(422).json({
        error: 'unsupported_language',
        message: `Text-to-speech supports ${TTS_LANGUAGES.join(', ')}. `
          + 'Speech-to-text supports many more; the two are not the same set.',
      });
      return null;
    }
    const available = voicesForLanguage(language);
    if (!available.length) {
      // The audit gate, surfaced honestly. Section 6.3 obligation 2 means a
      // voice nobody has checked cannot ship, and saying so beats a 500.
      res.status(422).json({
        error: 'no_voice_available',
        // v13.1.1. Was written for Piper's per-voice licence model, where each
        // voice carried its own MODEL_CARD and some were non-commercial. Kokoro
        // is one Apache-2.0 model, so a language with no voice means no voice
        // is REGISTERED for it -- not that one is awaiting an audit. The old
        // wording would send an operator hunting a licence problem that cannot
        // exist.
        message: `No voice is registered for "${language}" on this connector. `
          + `Text-to-speech supports ${TTS_LANGUAGES.join(', ')}.`,
      });
      return null;
    }
    // v12.51.0: prefer a voice whose model is actually on the volume. Taking
    // catalogue order blindly can select a registered voice that is not in the
    // installed bundle, which reaches the engine and comes back as a 500 -- an
    // engine failure reported for what is really a missing artifact.
    const best = bestVoiceForLanguage(language, installedVoices());
    if (!best.installed) {
      res.status(422).json({
        error: 'voice_not_installed',
        message: `No voice model for "${language}" is installed on this connector. `
          + `${best.candidates} voice(s) are licence-cleared for it, but none has been `
          + 'downloaded onto the volume.',
      });
      return null;
    }
    voice = best.voice_id;
  }

  const permit = voicePermitted(voice);
  if (!permit.ok) {
    res.status(422).json({ error: permit.reason, message: permit.message });
    return null;
  }

  return { voice, permit };
}

export function registerVoiceRoutes(app) {
  // -------------------------------------------------------------------------
  // GET /voice/health   (Section 8.1)
  // -------------------------------------------------------------------------
  app.get('/voice/health', voiceCredential, async (req, res) => {
    // Health remains the one voice route that is never 404 (Section 8.1), so
    // the UI can learn in one cheap call that the feature is unavailable.
    //
    // But it now answers PER USER. A non-allowlisted caller gets the exact same
    // body as a caller on a connector where voice is globally off -- same keys,
    // same values. Reporting enabled:true to someone who cannot use the feature
    // would tell them it exists and that they are merely excluded, which is
    // precisely what Section 4.1 forbids the routes from revealing. It would
    // also give their UI grounds to render a control that 404s.
    //
    // No engine is probed on this path either, so a non-allowlisted caller
    // cannot use health to trigger a model load.
    if (!(await voiceAvailableForAsync(req).catch(() => false))) {
      const body = {
        enabled: false,
        voice_enabled_for_this_user: false,
        stt_ready: false, tts_ready: false, models_loaded: [],
      };

      // Configuration faults are reported even to a denied caller, but ONLY when
      // the master switch is on. Rationale for each half:
      //
      //   Master off  -> say nothing. Voice is deliberately absent and the
      //                  routes must be indistinguishable from routes that do
      //                  not exist.
      //   Master on   -> the operator who needs this message is, by definition,
      //                  the person being denied. Withholding it means the only
      //                  way to see a misconfiguration is to already be past it,
      //                  which is the state they cannot reach.
      //
      // The messages name variables and modes, never identities.
      if (voiceEnabled()) {
        // v13.2.0. ALLOWLIST PROBLEMS ONLY, deliberately.
        //
        // deploymentConfigProblems() is NOT included here, and the distinction
        // is the one the comment above turns on. An allowlist fault EXPLAINS
        // THIS REFUSAL -- the person being denied is the person who needs it.
        // CONNECTOR_URL being unset explains nothing about why they were
        // denied; it is unrelated infrastructure detail that helps them not at
        // all and helps someone mapping the deployment quite a lot.
        //
        // Deployment faults go to /voice/health, which is operator-gated, and
        // to the boot log. See the health route below.
        const problems = allowlistConfigProblems();
        if (problems.length) body.configuration_problems = problems;
      }

      // v12.50.0. The masking above is right for an end user and actively
      // misleading for the operator debugging it: `enabled:false` is returned
      // whether the master switch is off or the caller simply is not
      // allowlisted, so VOICE_ENABLED=true looks like a variable being ignored.
      // That misdiagnosis cost real hours.
      //
      // So a caller presenting MCP_API_KEY -- the connector's own key, which
      // already grants remote code execution here -- is told which of the two
      // it was. The gateway holds the restore token, not this key, so nothing
      // added here can reach a browser and the /ti-voice contract is unchanged.
      if (req.voiceOperator) {
        const identity = resolveIdentity(req);
        body.operator_diagnostics = {
          note: 'enabled:false above reports YOUR access, not the value of '
            + 'VOICE_ENABLED. master_switch below is the variable.',
          master_switch: voiceEnabled(),
          denied_reason: !voiceEnabled() ? 'master_switch_off'
            : (!identity.userId ? 'no_identity_header' : 'identity_not_allowlisted'),
          identity_seen: {
            user_id: identity.userId,
            tenant_id: identity.tenantId,
            source: identity.source,
          },
          // Counts and modes only. The entries themselves are account
          // identifiers and never appear in a response or a log.
          allowlist: allowlistDiagnostics(),
          hint: 'A VOICE_TEST_USERS entry written <tenant_id>:<user_id> matches only '
            + 'when BOTH headers are sent: X-Tenax-User-Id and X-Tenax-Tenant-Id. '
            + 'The Gateway Service sends both from the verified JWT; a manual curl '
            + 'must send both too.',
        };
      }

      res.json(body);
      return;
    }

    let engines;
    try {
      engines = await probeEngines();
    } catch (err) {
      // Section 7: a failed engine must not take the connector down.
      engines = { sttReady: false, ttsReady: false, degraded: true, models: [],
                  voices_installed: [],
                  stt_error: err.message, tts_error: null };
    }

    const bench = benchmarkState();
    const speakable = speakableLanguages(engines.voices_installed || []);
    res.json({
      // The four fields Section 8.1 specifies, at the top level and named
      // exactly as written, so a client coded to the specification works.
      enabled: true,
      // Per-User Feature Gate Spec Section 4.2. True here by construction --
      // a non-allowlisted caller never reaches this branch -- but stated
      // explicitly so the UI branches on one flag in both responses rather than
      // inferring availability from the absence of a key.
      voice_enabled_for_this_user: true,
      stt_ready: !!engines.sttReady,
      tts_ready: !!engines.ttsReady,
      models_loaded: engines.models || [],
      // v12.50.0. Which .onnx voices are actually on the volume, as opposed to
      // which are licence-cleared in `catalogue` below. An empty list beside a
      // populated catalogue is the state where TTS looks configured and cannot
      // speak, so the two are reported side by side rather than conflated.
      voices_installed: engines.voices_installed || [],

      // v13.2.0. Deployment faults, on the ALLOWLISTED branch only.
      //
      // Not on the refusal branch above, and the distinction matters: an
      // allowlist fault explains why THAT caller was denied, so the person
      // being denied is the person who needs it. CONNECTOR_URL being unset
      // explains nothing about a denial -- it is infrastructure detail that
      // helps a denied caller not at all and helps someone mapping the
      // deployment quite a lot.
      //
      // Omitted entirely when the configuration is coherent, so its presence is
      // itself the signal rather than an empty array an operator has to inspect.
      ...( (() => {
        const faults = deploymentConfigProblems();
        return faults.length ? { deployment_problems: faults } : {};
      })() ),

      // v13.0.1. The SAME list, with the labels and accents a picker needs.
      //
      // voices_installed is a bare array of ids and stays exactly as it is,
      // because clients gate on it. This is additive: without it the gateway's
      // settings screen can only offer raw ids like `af_bella`, and an admin
      // choosing a voice for their whole workspace deserves to read
      // "Bella (US, female)".
      //
      // Narrowed to what is ACTUALLY installed rather than to what the registry
      // offers, so the picker cannot present a voice the engine would refuse.
      voices: registryState(engines.voices_installed || []).voices,

      // v12.51.0. THE field a client should gate its voice UI on.
      //
      // tts_languages below is the launch set, and catalogue.usable_by_language
      // is the licence answer; neither knows whether a model file exists. Only
      // this is the intersection of "licence-cleared" and "actually installed",
      // and only this is safe to build a language picker from. A UI built on
      // either of the others offers languages that fail on first use, which is
      // exactly what Vietnamese, Chinese and Japanese would do today on a
      // volume holding one English voice.
      speakable_languages: speakable.languages,
      speakable_by_language: speakable.by_language,

      // Everything below is additional diagnostics.
      degraded: !!engines.degraded,
      // Section 14's gate is hard, so an operator must be able to see at a
      // glance whether voice is answering on measured defaults or provisional
      // ones. Silence here would let a benchmark-pending deployment look
      // production-ready.
      benchmark_completed: bench.completed,
      benchmark_at: bench.at,
      catalogue: catalogState(),
      // Where the allowlist is read from, and -- in env mode -- the standing
      // warning that a revoke in the admin screen is not live until this
      // connector is updated. Reported so the drift is visible from the
      // system itself rather than only from documentation.
      allowlist: allowlistDiagnostics(),
      // Section 13: TTS covers four languages; STT covers ~99. Reported as two
      // separate facts so the UI cannot imply symmetric coverage.
      tts_languages: TTS_LANGUAGES.slice(),
      stt_languages: 'auto',
      attributions: attributions(),
      errors: { stt: engines.stt_error || null, tts: engines.tts_error || null },
      queue: {
        in_flight: engineState().in_flight, queued: engineState().queued,
        tts_in_flight: engineState().tts_in_flight,
        tts_queued: engineState().tts_queued,
      },

      // v12.53.0 -- TS-VOICE-PROSODY-v1.0. THE field a client gates its A/B
      // control on. A UI that renders On|Off|Compare against a connector
      // deployed with the layer off would offer three buttons that all produce
      // the same audio, which reads as a broken feature rather than a
      // disabled one.
      prosody: prosodyState(),

      // v12.53.0 -- PIPER-PRELOAD-v1.1 A2. `warm` and `pid` are what make
      // "two consecutive requests reused the same process" an observable fact
      // rather than an inference from a stopwatch.
      tts_worker: ttsWorkerState(),

      // v12.54.0 -- Change 3. Reported alongside tts_worker rather than merged
      // into it: the two are separately configurable, separately failable, and
      // an operator diagnosing memory needs to see which of them is actually
      // holding a model. `resident` is the field that answers that.
      stt_worker: sttWorkerHealth(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /voice/transcribe   (Section 8.2)
  // -------------------------------------------------------------------------
  app.post('/voice/transcribe',
    // v12.50.0: the transport credential runs FIRST, ahead of the body
    // parsers, so an unauthenticated caller cannot make the connector buffer a
    // 25 MB audio body before being refused.
    voiceCredential,
    gate,
    requireAuth,
    voiceLimiter,
    // type: () => true so the raw reader accepts multipart as well as a bare
    // audio body. The limit is applied here, before a byte is buffered, so the
    // 413 in validateAudio is a second line of defence rather than the first.
    express.raw({ type: () => true, limit: maxBytes() }),
    async (req, res) => {
      const started = Date.now();
      const contentType = req.headers['content-type'] || '';

      let audio = null;
      let declaredType = null;
      let language = '';
      let model = '';

      if (/^multipart\/form-data/i.test(contentType)) {
        const parsed = parseMultipart(req.body, contentType);
        if (!parsed.ok) {
          res.status(415).json({ error: parsed.reason, message: parsed.message });
          return;
        }
        if (!parsed.file) {
          res.status(422).json({
            error: 'no_audio_file',
            message: 'Attach the recording as a file part in the multipart body.',
          });
          return;
        }
        audio = parsed.file.data;
        declaredType = parsed.file.contentType;
        language = parsed.fields.language || '';
        model = parsed.fields.model || '';
      } else {
        // A raw audio body. Not in Section 8.2, which specifies multipart, but
        // accepted because the Phase 0 benchmark harness and any curl-based
        // check are far simpler without multipart framing -- and Section 14
        // makes that benchmark mandatory.
        audio = Buffer.isBuffer(req.body) ? req.body : null;
        declaredType = contentType;
        language = String(req.query.language || '');
        model = String(req.query.model || '');
      }

      const check = validateAudio(audio, { declaredType });
      if (!check.ok) {
        res.status(check.status).json({ error: check.reason, message: check.message });
        return;
      }

      try {
        const result = await transcribe(audio, {
          format: check.format,
          language: language.trim().toLowerCase().slice(0, 8) || undefined,
          model: model.trim() || undefined,
        });

        logMeta('stt', {
          format: check.format,
          bytes: audio.length,
          audio_seconds: (result.duration_seconds || 0).toFixed(2),
          language: result.language || 'auto',
          elapsed_ms: Date.now() - started,
        });

        res.json({
          text: result.text || '',
          language: result.language || '',
          duration_seconds: result.duration_seconds || 0,
          segments: Array.isArray(result.segments) ? result.segments : [],
        });
      } catch (err) {
        // A rejection the engine can explain is the caller's problem (422); a
        // rejection it cannot is ours (500). Section 16 forbids collapsing the
        // first case into the second.
        const known = { unsupported_model: 422, audio_missing: 422, stt_unavailable: 503 };
        const status = known[err.code] || 500;
        logMeta('stt_error', { code: err.code || 'stt_failed', status,
                               elapsed_ms: Date.now() - started });
        res.status(status).json({
          error: err.code || 'stt_failed',
          message: status === 500 ? 'Transcription failed.' : err.message,
        });
      }
    });

  // -------------------------------------------------------------------------
  // v13.0.1 -- SPEC-KOKORO-001 Section 12. See parseSampleRate below.
  // POST /voice/synthesize   (Section 8.3)
  // -------------------------------------------------------------------------
  app.post('/voice/synthesize',
    // v12.50.0: the transport credential runs FIRST, ahead of the body
    // parsers, so an unauthenticated caller cannot make the connector buffer a
    // 25 MB audio body before being refused.
    voiceCredential,
    gate,
    requireAuth,
    voiceLimiter,
    express.json({ limit: '256kb' }),
    async (req, res) => {
      const started = Date.now();
      const body = (req.body && typeof req.body === 'object') ? req.body : {};

      const text = String(body.text || '');
      if (!text.trim()) {
        res.status(422).json({
          error: 'empty_text', message: 'Provide text to synthesise.',
        });
        return;
      }

      const MAX_CHARS = intEnv('VOICE_MAX_TTS_CHARS', 5000);
      if (text.length > MAX_CHARS) {
        res.status(413).json({
          error: 'text_too_long',
          message: `Text is ${text.length} characters; the limit is ${MAX_CHARS}.`,
        });
        return;
      }

      // v13.0.1 -- SPEC-KOKORO-001 Section 12, per-tenant output rate.
      //
      // The gateway injects the TENANT'S rate here, because the connector's env
      // var expresses one rate for the whole process and cannot serve two
      // tenants differently.
      //
      // REFUSED rather than silently ignored when it is not one of the offered
      // rates. An admin who set a rate and heard no difference would have no
      // way to tell whether the setting was wrong, unsupported, or simply not
      // plumbed through -- which is exactly the failure this release fixes.
      const requestedRate = parseSampleRate(body, res);
      if (false === requestedRate) return;   // parseSampleRate has answered.

      const resolved = await resolveVoice(body, res);
      if (!resolved) return;   // resolveVoice has already answered.
      const { voice, permit } = resolved;

      // Section 8.3 allows a format parameter. Only WAV is produced here: Piper
      // emits WAV natively and Table 2 puts Opus/MP3 transcoding at the gateway,
      // which is not built. Claiming a format we do not produce would be worse
      // than refusing it.
      const format = String(body.format || 'wav').trim().toLowerCase();
      if (format !== 'wav') {
        res.status(422).json({
          error: 'unsupported_format',
          message: `Only WAV is produced at present; "${format}" would require the `
            + 'gateway transcode step, which is not yet implemented.',
        });
        return;
      }

      const speed = Number(body.speed);
      if (body.speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
        res.status(422).json({
          error: 'invalid_speed', message: 'Speed must be between 0.5 and 2.',
        });
        return;
      }

      // v12.53.0 -- Section 7.2. The A/B mode. Defaults to "off", which is the
      // pre-prosody behaviour, so an OLDER CLIENT THAT SENDS NOTHING GETS
      // EXACTLY WHAT IT GOT BEFORE. Defaulting to "on" here would silently
      // change the output of every existing caller, including the benchmark
      // harness Section 14 depends on.
      const mode = parseProsodyMode(body.prosody);
      if (!mode) {
        res.status(422).json({
          error: 'invalid_prosody',
          message: 'prosody must be "on", "off" or "both".',
        });
        return;
      }

      const prosodyCfg = prosodyConfig();
      // The master switch wins over the request. A connector deployed with the
      // layer off must behave as though it does not have one (Section 10's
      // rollout depends on exactly that), and refusing loudly would break a
      // client that legitimately asked for a feature the operator has not
      // enabled yet. So it degrades to flat and SAYS SO in the response header,
      // which is how the UI can explain a Compare button that produced two
      // identical recordings.
      const effective = prosodyCfg.enabled ? mode : 'off';
      if (effective !== mode) res.setHeader('X-Tenax-Prosody-Degraded', 'layer_disabled');

      const flatSpeed = Number.isFinite(speed) ? speed : undefined;

      /**
       * The flat rendering. ONE definition, three call sites.
       *
       * v13.0.1 -- AC3/AC5/N4 made structural instead of asserted.
       *
       * AC3 requires the flat output to be byte-identical to the pre-prosody
       * build for the same text, and AC5 requires Compare's flat half to match
       * what Off mode produces. Both are equivalence properties between call
       * sites that used to be written out three times: once for Compare, once
       * for the prosody fallback, once for the true flat path.
       *
       * Three copies of an argument list cannot be kept equal by review, and a
       * test that compares them can only report drift AFTER someone has shipped
       * it. Worse, the test that did compare them pinned a literal argument
       * list -- so adding `sampleRate` to all three, which PRESERVED the
       * equivalence exactly, still failed it. A test that fails on correct code
       * invites weakening, which is how the control gets lost.
       *
       * A closure removes the class of bug rather than detecting it. There is
       * now no way for the three paths to disagree, because there is nothing to
       * keep in step: the equivalence is a property of the code, not a claim
       * about it.
       *
       * @returns {Promise<Buffer>} WAV bytes.
       */
      const renderFlat = () => synthesize({
        text, voice, speed: flatSpeed, sampleRate: requestedRate,
      });

      try {
        // ---- Compare mode (Section 7.2, AC5) -------------------------------
        //
        // Returns BOTH renderings of the same text in one JSON body, paired by
        // a shared reply hash.
        //
        // DEVIATION FROM THE SPECIFICATION, STATED PLAINLY. Section 7.2 says
        // "both" returns two audio URLs. URLs would require the connector to
        // STORE the two recordings somewhere a later request could fetch them,
        // and Section 10 of the voice specification forbids exactly that:
        // "audio is processed in memory or in temporary files deleted
        // immediately after the request completes. No recording is written to
        // persistent storage." Inventing an audio store to satisfy a wording
        // choice would trade a real privacy control for a cosmetic one.
        //
        // Two base64 payloads in one response satisfy what AC5 actually
        // requires -- "compare mode returns two audio outputs for one reply,
        // and the flat output matches the Off-mode output for that text" --
        // and the pairing the UI needs is the shared hash, not the transport.
        if ('both' === effective) {
          const flat = await renderFlat();
          const layered = await synthesizeProsody({
            text, voice, speed: flatSpeed, config: prosodyCfg,
            sampleRate: requestedRate,
          });

          logMeta('tts', {
            voice, language: permit.voice.language, chars: text.length,
            prosody: 'both',
            bytes: flat.length + layered.wav.length,
            phrases: layered.analysis.phrases.length,
            elapsed_ms: Date.now() - started,
          });

          res.setHeader('Cache-Control', 'no-store');
          res.json({
            // Section 7.2: "tagged with a shared reply hash so the UI can pair
            // them". Both halves carry the same one because both are the same
            // text.
            reply_hash: replyHash(text),
            format: 'wav',
            sample_rate: layered.sampleRate,
            flat: {
              // Byte-identical to what prosody:"off" returns for this text,
              // because it IS the same call (AC5, N4).
              audio_base64: flat.toString('base64'),
              bytes: flat.length,
            },
            prosody: {
              audio_base64: layered.wav.toString('base64'),
              bytes: layered.wav.length,
              // Counts and profile names only, never the phrase text
              // (Section 10). Enough for the panel to show what the layer did.
              summary: summarise(layered.analysis),
            },
          });
          return;
        }

        // ---- Layered, or the true flat baseline ----------------------------
        let wav;
        let path = 'flat';
        let phrases = 0;

        if ('on' === effective) {
          try {
            const layered = await synthesizeProsody({
              text, voice, speed: flatSpeed, config: prosodyCfg,
              sampleRate: requestedRate,
            });
            wav = layered.wav;
            path = layered.path;
            phrases = layered.analysis.phrases.length;
          } catch (layerErr) {
            // NON-NEGOTIABLE 5 (SPEC-VOICE-001): "failure in the layer falls
            // back cleanly to the current working single-call synthesis."
            //
            // Only for failures that are ABOUT THE LAYER. A refusal the flat
            // path would also produce -- an unlicensed voice, empty text -- is
            // rethrown, because retrying it would spend another Piper run to
            // arrive at the same 422 with a worse message.
            const notWorthRetrying = ['unknown_voice', 'voice_inactive',
              'voice_non_commercial', 'voice_unaudited', 'empty_text'];
            if (notWorthRetrying.includes(layerErr.code)) throw layerErr;

            console.error('[voice] prosody layer failed, falling back to flat:',
                          layerErr.message);
            logMeta('tts_prosody_fallback', {
              code: layerErr.code || 'tts_failed', chars: text.length,
            });
            wav = await renderFlat();
            path = 'flat_fallback';
            res.setHeader('X-Tenax-Prosody-Degraded', 'layer_failed');
          }
        } else {
          // N4, the TRUE flat baseline: the untouched v12.52.0 call. Not a
          // prosody run with the features turned off -- the same function, the
          // same argv, the same bytes -- so the comparison always has a genuine
          // reference (AC3).
          wav = await renderFlat();
        }

        // Character count and voice only. Never the text (Section 10).
        logMeta('tts', {
          voice, language: permit.voice.language, chars: text.length,
          prosody: effective, path, phrases: phrases || undefined,
          bytes: wav.length, elapsed_ms: Date.now() - started,
        });

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(wav.length));
        // So a client can tell a layered rendering from a fallback without
        // parsing the audio. Metadata about the PATH, never about the content.
        res.setHeader('X-Tenax-Prosody-Path', path);
        // Synthesised speech is derived from user text; a shared cache must not
        // hold it.
        res.setHeader('Cache-Control', 'no-store');
        res.send(wav);
      } catch (err) {
        const known = {
          unknown_voice: 422, voice_inactive: 422,
          voice_non_commercial: 422, voice_unaudited: 422, empty_text: 422,
          // v12.52.0: a timeout is the engine being too slow, not the caller
          // being wrong. 504 says which, and says it to the gateway in the
          // vocabulary it already uses for its own timeout.
          tts_timeout: 504,
        };
        const status = known[err.code] || 500;

        // v12.52.0. THE FIX FOR "500 and nothing else".
        //
        // The client is still told only "Speech synthesis failed" -- Piper's
        // stderr can carry file paths and model internals, and none of that
        // belongs in a browser. But the SERVER kept nothing either, so a 500
        // here produced a log line reading `code=tts_failed status=500` and
        // that was the entire record of the failure. There was no way to tell
        // an OOM kill from a corrupt model from a bad argument.
        //
        // Now the real reason is written to the connector's own log, where an
        // operator reading Railway logs will find it. Still never the text
        // being spoken (Section 10) -- only the engine's own diagnostics.
        if (status >= 500) {
          console.error('[voice] tts_failed:', err.message);
          if (err.exitCode !== undefined || err.signal) {
            console.error(`[voice] tts_failed detail: exit=${err.exitCode} `
              + `signal=${err.signal || 'none'} audio_bytes=${err.bytes || 0}`);
          }
          if (err.stderr) console.error('[voice] piper stderr:', err.stderr);
        }

        logMeta('tts_error', { code: err.code || 'tts_failed', status,
                               signal: err.signal || undefined,
                               exit: err.exitCode === undefined ? undefined : err.exitCode,
                               elapsed_ms: Date.now() - started });
        res.status(status).json({
          error: err.code || 'tts_failed',
          // 5xx keeps a generic message: Piper's stderr can name paths and
          // model internals. The operator gets the real reason from the
          // connector log above. 504 is the one exception worth naming,
          // because "it was too slow" is actionable by the user (shorter text)
          // and reveals nothing.
          message: status === 504
            ? 'Speech synthesis took too long. Try a shorter passage.'
            : (status >= 500 ? 'Speech synthesis failed. The connector log has the reason.'
                             : err.message),
        });
      }
    });

  // -------------------------------------------------------------------------
  // POST /voice/synthesize/stream   (SPEC-VOICE-001 Component D)
  // -------------------------------------------------------------------------
  //
  // Streamed playback. The same per-phrase segmentation that drives prosody
  // drives this: "early playback is not a bolt-on; it falls out of the
  // per-phrase architecture."
  //
  // ── Why NDJSON and not a media container ─────────────────────────────────
  //
  // The client needs three things per phrase: the audio, the pause that
  // follows it, and the knowledge that a phrase boundary has arrived. A raw
  // PCM stream carries the first and neither of the others -- the pauses would
  // have to be baked in, which forfeits the client's ability to schedule them
  // on an audio clock, and there would be no framing to tell one phrase from
  // the next.
  //
  // So: one JSON object per line, flushed as each phrase finishes. Base64
  // costs a third more bytes over the wire and buys framing, metadata, and an
  // error channel that still works after the response has started -- which
  // matters, because by then the status code has been sent and cannot be
  // changed.
  //
  // ── Time to first audio ──────────────────────────────────────────────────
  //
  // The first line goes out after ONE phrase has been synthesised rather than
  // after the whole reply, which is the entire point (AC15). Nothing is
  // buffered: the response is chunked and each line is written the moment it
  // exists.
  app.post('/voice/synthesize/stream',
    voiceCredential,
    gate,
    requireAuth,
    voiceLimiter,
    express.json({ limit: '256kb' }),
    async (req, res) => {
      const started = Date.now();
      const body = (req.body && typeof req.body === 'object') ? req.body : {};

      const text = String(body.text || '');
      if (!text.trim()) {
        res.status(422).json({ error: 'empty_text', message: 'Provide text to synthesise.' });
        return;
      }

      const MAX_CHARS = intEnv('VOICE_MAX_TTS_CHARS', 5000);
      if (text.length > MAX_CHARS) {
        res.status(413).json({
          error: 'text_too_long',
          message: `Text is ${text.length} characters; the limit is ${MAX_CHARS}.`,
        });
        return;
      }

      const resolved = await resolveVoice(body, res);
      if (!resolved) return;   // resolveVoice has already answered.

      const speed = Number(body.speed);
      if (body.speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
        res.status(422).json({ error: 'invalid_speed', message: 'Speed must be between 0.5 and 2.' });
        return;
      }

      const prosodyCfg = prosodyConfig();
      if (!prosodyCfg.enabled) {
        // Streaming exists to deliver per-phrase audio, and per-phrase audio is
        // the prosody layer. With the layer off there is nothing to stream, and
        // pretending otherwise (one "phrase" containing the whole reply) would
        // give the client a stream that never overlaps anything while looking
        // like it does. 409 so the client falls back to /voice/synthesize,
        // which is the correct behaviour and the one it already has.
        res.status(409).json({
          error: 'prosody_disabled',
          message: 'Streamed playback needs the prosody layer, which is switched off '
            + 'on this connector. Use POST /voice/synthesize instead.',
        });
        return;
      }

      // Committed to 200 from here on. Everything after this point reports
      // failure INSIDE the stream, because the status line has been sent.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // Nginx and several Railway-style proxies buffer a response by default,
      // which would hold every line until the last one and silently undo the
      // whole feature. The header is advisory and harmless where it is not
      // understood.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      /**
       * Write one NDJSON line, respecting backpressure.
       *
       * A phrase of audio is tens of kilobytes and a slow client can fill the
       * socket buffer. Ignoring a false return from write() would let the
       * connector queue the whole reply in memory for a client that is not
       * reading it, which is how one bad connection becomes a heap problem.
       *
       * @param {object} obj
       * @returns {Promise<void>}
       */
      function writeLine(obj) {
        return new Promise((resolve) => {
          const ok = res.write(`${JSON.stringify(obj)}\n`);
          if (ok) { resolve(); return; }
          res.once('drain', resolve);
        });
      }

      let aborted = false;
      req.on('aborted', () => { aborted = true; });
      res.on('close', () => { aborted = true; });

      try {
        const result = await synthesizeProsodyStream(
          { text, voice: resolved.voice, speed: Number.isFinite(speed) ? speed : undefined,
            config: prosodyCfg, sampleRate: streamRate },
          async (segment) => {
            // The user navigated away or stopped playback. Throwing here
            // unwinds the phrase pool, so no further Piper process is spawned
            // for audio nobody will hear.
            if (aborted) {
              const stop = new Error('client went away');
              stop.code = 'client_aborted';
              throw stop;
            }
            await writeLine({
              type: 'phrase',
              index: segment.index,
              total: segment.total,
              sample_rate: segment.sampleRate,
              pause_after_ms: segment.pauseAfterMs,
              profile: segment.profile,
              length_scale: segment.lengthScale,
              // Headerless PCM, signed 16-bit little-endian mono. The client
              // builds AudioBuffers from it directly -- no per-phrase WAV
              // header, because the client is not writing files.
              audio_base64: segment.pcm.toString('base64'),
            });
          }
        );

        if (!aborted) {
          await writeLine({ type: 'end', phrases: result.phrases, bytes: result.bytes });
        }

        logMeta('tts_stream', {
          voice: resolved.voice, language: resolved.permit.voice.language,
          chars: text.length, phrases: result.phrases, bytes: result.bytes,
          aborted: aborted || undefined,
          elapsed_ms: Date.now() - started,
        });
      } catch (err) {
        if ('client_aborted' === err.code) {
          logMeta('tts_stream', { voice: resolved.voice, chars: text.length,
                                  aborted: true, elapsed_ms: Date.now() - started });
          res.end();
          return;
        }

        // The status line is long gone, so the only way to report this is in
        // band. The client's contract is that it falls back to the single-call
        // route when it sees this (non-negotiable 5, AC18).
        console.error('[voice] tts stream failed:', err.message);
        logMeta('tts_stream_error', { code: err.code || 'tts_failed',
                                      elapsed_ms: Date.now() - started });
        try {
          await writeLine({
            type: 'error',
            error: err.code || 'tts_failed',
            // The same discretion the non-streaming route applies: Piper's
            // stderr names paths and model internals and does not go to a
            // browser. The connector log above has the real reason.
            message: 'Speech synthesis failed. The connector log has the reason.',
          });
        } catch (writeErr) { /* the socket is gone; nothing left to say */ }
      } finally {
        res.end();
      }
    });

  // -------------------------------------------------------------------------
  // POST /voice/prosody/analyse   (Section 4.1, "tuning is data, not code")
  // -------------------------------------------------------------------------
  //
  // The annotation with no audio. Section 4.1 requires the pause tiers and
  // rates to be "expressed as config data, not code" and tunable by ear, and
  // Section 9 ends with "all overridable so tuning is data, not code" -- which
  // only helps if an operator can see what the current values actually do to a
  // sentence without spawning Piper and listening to the result.
  //
  // Costs nothing: prosody.js is a pure transform, so this route reads no file,
  // spawns no process and loads no model. It is gated exactly like the others
  // regardless, because the register table is a description of how the
  // assistant is written and is not owed to an anonymous caller.
  app.post('/voice/prosody/analyse',
    voiceCredential,
    gate,
    requireAuth,
    voiceLimiter,
    express.json({ limit: '256kb' }),
    (req, res) => {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const text = String(body.text || '');
      if (!text.trim()) {
        res.status(422).json({ error: 'empty_text', message: 'Provide text to analyse.' });
        return;
      }

      const MAX_CHARS = intEnv('VOICE_MAX_TTS_CHARS', 5000);
      if (text.length > MAX_CHARS) {
        res.status(413).json({
          error: 'text_too_long',
          message: `Text is ${text.length} characters; the limit is ${MAX_CHARS}.`,
        });
        return;
      }

      const speed = Number(body.speed);
      if (body.speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
        res.status(422).json({ error: 'invalid_speed', message: 'Speed must be between 0.5 and 2.' });
        return;
      }

      // A voice is OPTIONAL here. Without one the base length_scale is 1, which
      // makes every returned lengthScale a pure multiplier -- the right answer
      // for inspecting the register table itself. With one, the numbers are
      // what that voice would actually be given (Section 4.2).
      const streamRate = parseSampleRate(body, res);
      if (false === streamRate) return;   // parseSampleRate has answered.

      const voice = String(body.voice || '').trim();
      let base = 1;
      if (voice) {
        const permit = voicePermitted(voice);
        if (!permit.ok) {
          res.status(422).json({ error: permit.reason, message: permit.message });
          return;
        }
        base = voiceLengthScale(voice);
      }

      const analysis = analyse(text, {
        baseLengthScale: base,
        speed: Number.isFinite(speed) ? speed : undefined,
      });

      // Logged as counts. The phrase text is in the RESPONSE, because the
      // caller sent it and is asking what was done to it, but it never reaches
      // the log (Section 10).
      logMeta('prosody_analyse', {
        chars: text.length, phrases: analysis.phrases.length,
        voice: voice || undefined,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        reply_hash: replyHash(text),
        base_length_scale: base,
        phrases: analysis.phrases,
        sentences: analysis.sentences,
        summary: summarise(analysis),
        config: analysis.config,
      });
    });

  // Reports the master switch and the SIZE of the allowlist, never its
  // contents: the identities are operator account ids and do not belong in
  // logs.
  const allowlisted = testUsers().length;
  console.log(`[voice] routes registered (master=${voiceEnabled()}, `
    + `source=${currentAllowlistSource()}, allowlisted_users=${allowlisted})`);
  // Said at boot, once, at error level. A correct-but-silent refusal is
  // indistinguishable from a working "off", and the deployment that hit this had
  // no way to tell the two apart from the outside.
  // v12.50.0. Fires only when VOICE_PROVISION_VOICES names something, only
  // when the master switch is on, and never blocks the boot: Railway's health
  // check has a deadline and a model download must not fail a deploy. Voice
  // reports itself degraded until the files land, which is what degraded is for.
  if (voiceEnabled()) {
    const provisioning = provisionFromEnv();
    // Errors are handled inside provisionFromEnv; this guard exists so an
    // unexpected rejection can never become an unhandled promise and take the
    // process down with it.
    if (provisioning && typeof provisioning.catch === 'function') {
      provisioning.catch(() => {});
    }

    // v12.53.0 -- PIPER-PRELOAD-v1.1 Section 5, boot pre-warm.
    //
    // Inside the voiceEnabled() guard, so Section 7's guarantee is untouched:
    // with the master switch off, no Piper process is created and A7 stays
    // verifiable from the process list.
    //
    // Deliberately NOT awaited. Railway's health check has a deadline and
    // loading a 61 MB ONNX model can take seconds; blocking the boot on it
    // would turn a latency optimisation into a failed deploy. Voice reports
    // itself warm or cold under tts_worker in /voice/health, which is what
    // that field is for.
    //
    // Ordered after provisionFromEnv because on a first boot the model may not
    // be on the volume yet. The pre-warm will find nothing installed and
    // decline, and the first real request warms the worker instead -- one cold
    // utterance, once, rather than a failure.
    // v12.54.0. The STT worker is warmed alongside the TTS one, and separately,
    // so a missing voice model cannot suppress the Whisper warm or the reverse.
    // Also not awaited, and for a stronger reason: a cold Whisper cache
    // DOWNLOADS several hundred megabytes, which is far past any health-check
    // deadline. It declines quietly when residency is off.
    const warmingStt = prewarmStt();
    if (warmingStt && typeof warmingStt.catch === 'function') {
      warmingStt.catch(() => {});
    }

    const warming = prewarmTts();
    if (warming && typeof warming.catch === 'function') {
      // prewarmTts already swallows its own errors; this guard exists so an
      // unexpected rejection can never become an unhandled promise and take
      // the process down with it.
      warming.catch(() => {});
    }
  }

  if (voiceEnabled()) {
    const problems = [ ...allowlistConfigProblems(), ...deploymentConfigProblems() ];
    problems.forEach((p) => console.error('[voice] CONFIGURATION: ' + p));
    if (problems.length) {
      console.error('[voice] Voice is enabled but NO USER CAN REACH IT until the above is fixed. '
        + 'GET /voice/health reports the same under configuration_problems.');
    }
  }
}

export { gateState, ACCEPTED_FORMATS };
export default { registerVoiceRoutes };
