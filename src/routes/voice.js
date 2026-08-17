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
import { allowlistConfigProblems } from '../voice/voice-allowlist.js';
// v12.50.0: the transport credential. MCP_API_KEY (operator) or
// RAILWAY_RESTORE_TOKEN (gateway). See src/voice/voice-auth.js for why the
// gateway could not previously reach these routes at all.
import { voiceCredential }        from '../voice/voice-auth.js';
import { parseMultipart }         from '../voice/multipart.js';
import { validateAudio, maxBytes,
         ACCEPTED_FORMATS }       from '../voice/audio-validate.js';
import { voicePermitted, voicesForLanguage,
         catalogState, TTS_LANGUAGES,
         attributions }           from '../voice/voice-catalog.js';
import { probeEngines, engineState,
         transcribe, synthesize } from '../voice/voice-engines.js';

/* Section 15: "Rate limiting per user on both voice routes." Voice is far more
 * expensive per request than a normal API call -- one transcription can occupy
 * the CPU for seconds -- so the ceiling is low by design. */
const WINDOW_MS = intEnv('VOICE_RATE_WINDOW_MS', 60_000);
const MAX_REQS  = intEnv('VOICE_RATE_MAX', 20);

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

/** Never log audio, filenames or transcripts (Section 10). Metadata only. */
function logMeta(direction, meta) {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[voice] ${direction} ${parts.join(' ')}`);
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
      queue: { in_flight: engineState().in_flight, queued: engineState().queued },
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

      const language = String(body.language || '').trim().toLowerCase();
      let voice = String(body.voice || '').trim();

      // No voice named: take the language's default from the catalogue. This is
      // the path most callers use, and it must fail as clearly as an explicitly
      // bad voice does.
      if (!voice) {
        if (!language) {
          res.status(422).json({
            error: 'no_voice_or_language',
            message: 'Specify a voice, or a language to pick the default voice for.',
          });
          return;
        }
        if (!TTS_LANGUAGES.includes(language)) {
          res.status(422).json({
            error: 'unsupported_language',
            message: `Text-to-speech supports ${TTS_LANGUAGES.join(', ')}. `
              + `Speech-to-text supports many more; the two are not the same set.`,
          });
          return;
        }
        const available = voicesForLanguage(language);
        if (!available.length) {
          // The audit gate, surfaced honestly. Section 6.3 obligation 2 means a
          // voice nobody has checked cannot ship, and saying so beats a 500.
          res.status(422).json({
            error: 'no_voice_available',
            message: `No licence-cleared voice is available for "${language}". `
              + 'Each Piper voice is governed by its own MODEL_CARD and some are '
              + 'non-commercial, so voices are refused until audited.',
          });
          return;
        }
        voice = available[0].voice_id;
      }

      const permit = voicePermitted(voice);
      if (!permit.ok) {
        res.status(422).json({ error: permit.reason, message: permit.message });
        return;
      }

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

      try {
        const wav = await synthesize({
          text, voice, speed: Number.isFinite(speed) ? speed : undefined,
        });

        // Character count and voice only. Never the text (Section 10).
        logMeta('tts', {
          voice, language: permit.voice.language, chars: text.length,
          bytes: wav.length, elapsed_ms: Date.now() - started,
        });

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(wav.length));
        // Synthesised speech is derived from user text; a shared cache must not
        // hold it.
        res.setHeader('Cache-Control', 'no-store');
        res.send(wav);
      } catch (err) {
        const known = {
          unknown_voice: 422, voice_inactive: 422,
          voice_non_commercial: 422, voice_unaudited: 422, empty_text: 422,
        };
        const status = known[err.code] || 500;
        logMeta('tts_error', { code: err.code || 'tts_failed', status,
                               elapsed_ms: Date.now() - started });
        res.status(status).json({
          error: err.code || 'tts_failed',
          message: status === 500 ? 'Speech synthesis failed.' : err.message,
        });
      }
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
  if (voiceEnabled()) {
    const problems = allowlistConfigProblems();
    problems.forEach((p) => console.error('[voice] CONFIGURATION: ' + p));
    if (problems.length) {
      console.error('[voice] Voice is enabled but NO USER CAN REACH IT until the above is fixed. '
        + 'GET /voice/health reports the same under configuration_problems.');
    }
  }
}

export { gateState, ACCEPTED_FORMATS };
export default { registerVoiceRoutes };
