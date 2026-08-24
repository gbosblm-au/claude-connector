// src/voice/voice-stream-config.js
//
// Tenax Voice -- configuration for streaming chunked transcription.
// STREAM-WHISPER-v1.0.0 Sections 4, 7 and 9.
//
// ===========================================================================
// WHY THE CONFIG IS ITS OWN MODULE
// ===========================================================================
//
// Three components read these values: the WebSocket server (frame sizing,
// auth), the session (ring buffer geometry, scheduling) and the supervisor
// (beam widths). If each read process.env directly they would drift -- one
// clamping, one not; one defaulting to 6, another to 5 -- and the symptom
// would be a ring buffer whose geometry disagreed with the frames being fed
// into it, which is silent and produces garbled partials rather than an error.
//
// Every value is read at CALL TIME, never cached at import. The test suite
// changes environment between cases, and a cached read would make the first
// test to run decide the configuration for all of them.
//
// ===========================================================================
// THE AUDIO FORMAT IS FIXED, AND THAT IS DELIBERATE
// ===========================================================================
//
// 16 kHz, mono, signed 16-bit little-endian PCM. Not configurable.
//
// Section 3 of the specification described the wire format twice and the two
// descriptions disagreed: "PCM chunks (f32, 16kHz mono)" and "PCM at 32KBps".
// Those are different formats --
//
//     float32 at 16 kHz mono = 16000 x 4 = 64,000 B/s
//     int16   at 16 kHz mono = 16000 x 2 = 32,000 B/s
//
// -- and the stated bitrate matches int16 exactly. int16 is what shipped, on
// that reading, and it halves the wire cost for no measurable accuracy change:
// Whisper's own front end resamples to 16 kHz float internally regardless, and
// the quantisation floor of int16 sits far below the noise floor of any
// microphone this will ever see.
//
// Making it configurable would mean the browser and the worker could disagree
// about how to interpret a byte, and a stream misread as the wrong format is
// not an error -- it is noise that transcribes to plausible nonsense.

/** Samples per second. Whisper's native rate; resampling anywhere else is waste. */
export const SAMPLE_RATE = 16000;

/** Bytes per sample. int16. See the header for why this is not a setting. */
export const BYTES_PER_SAMPLE = 2;

/** Samples in one wire frame. 640 at 16 kHz is exactly 40 ms (Section 3). */
export const FRAME_SAMPLES = 640;

/** Bytes in one wire frame. 1280. */
export const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE;

/** Milliseconds of audio in one wire frame. 40. */
export const FRAME_MS = ( FRAME_SAMPLES / SAMPLE_RATE ) * 1000;

/**
 * Read a bounded integer from the environment.
 *
 * Out-of-range is treated as absent rather than clamped. A deployment that
 * sets a window of 600 seconds has made a mistake, and silently running with
 * 600 would exhaust memory while looking configured; silently running with the
 * default is the behaviour an operator can actually diagnose from the health
 * endpoint, which reports the effective value.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intEnv( name, fallback, min, max ) {
  const n = parseInt( process.env[ name ] || '', 10 );
  if ( ! Number.isFinite( n ) || n < min || n > max ) return fallback;
  return n;
}

/**
 * Read a boolean from the environment.
 *
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolEnv( name, fallback ) {
  const raw = String( process.env[ name ] || '' ).trim().toLowerCase();
  if ( '' === raw ) return fallback;
  return 'true' === raw || '1' === raw || 'yes' === raw;
}

/**
 * The language Whisper is told to expect. v13.19.1.
 *
 * ── Why this is pinned rather than detected ──────────────────────────────
 *
 * Whisper's language identification is a separate forward pass, and on a
 * six-second rolling window it is both a real slice of the latency budget and
 * unreliable: the window starts and ends mid-speech, often on a fragment, and
 * a misdetection does not degrade the transcript so much as replace it with
 * confident text in the wrong language.
 *
 * It is also the one setting where detection buys nothing. A tutoring session
 * is conducted in one language, the client already knows which, and the
 * non-streaming path has always passed it explicitly.
 *
 * An empty value restores auto-detection, for a deployment that genuinely
 * needs it and is willing to pay for it.
 *
 * @returns {string}
 */
export function defaultLanguage() {
  // UNSET and EMPTY are different answers, so `|| 'en'` is wrong here: it
  // collapses "the operator asked for auto-detection" into "the operator said
  // nothing", and the escape hatch documented above would silently not exist.
  const set = Object.prototype.hasOwnProperty.call( process.env, 'VOICE_STREAM_LANGUAGE' );
  if ( ! set ) return 'en';

  const raw = String( process.env.VOICE_STREAM_LANGUAGE ).trim();
  if ( ! raw ) return '';   // explicit opt-in to auto-detection
  // Loose on purpose: ISO 639-1, and Whisper also accepts a handful of longer
  // codes. Validating against a list here would mean keeping that list in step
  // with the engine, and the failure mode of a bad code is an engine error
  // rather than silent nonsense.
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test( raw ) ? raw : '';
}

/**
 * Section 9: the master switch. Default FALSE, opt-in until benchmarked.
 *
 * When off, the WebSocket route is not registered at all -- not registered and
 * refusing, but absent, so an upgrade gets the same rejection as any unknown
 * path. Section 9 requires "zero code-path changes" to the existing
 * send-on-endpoint behaviour, and a route that exists and refuses is still a
 * code path that can fail in a new way.
 *
 * @returns {boolean}
 */
export function streamingEnabled() {
  return boolEnv( 'VOICE_STREAMING_ENABLED', false );
}

/**
 * Section 7: anonymised metrics only, default off, never raw audio.
 *
 * @returns {boolean}
 */
export function debugLogEnabled() {
  return boolEnv( 'VOICE_STREAM_DEBUG_LOG', false );
}

/**
 * Seconds of audio held in the ring buffer. Section 4, default 6.
 *
 * This is the amount of context each partial transcription sees. Larger is
 * more accurate at boundaries and slower per partial, and the per-partial cost
 * is the thing the latency budget is spent on.
 *
 * @returns {number}
 */
export function windowSeconds() {
  return intEnv( 'VOICE_STREAM_WINDOW_SECONDS', 6, 1, 30 );
}

/**
 * Minimum seconds of audio two consecutive transcribed windows must share.
 * Section 4, default 2.
 *
 * ── What this setting means, and why it needed deciding ──────────────────
 *
 * Section 4 called it "overlap between ring-buffer fills to avoid boundary
 * word loss" while also specifying that every arrival triggers a partial of
 * the whole ring buffer. Under that description consecutive windows already
 * share window-minus-arrival seconds, so a separate overlap setting would have
 * no effect on anything.
 *
 * It is implemented as a FLOOR on shared audio, which is what "to avoid
 * boundary word loss" asks for and what the arrival-triggered reading cannot
 * deliver on its own.
 *
 * When the engine keeps up, consecutive windows overlap almost entirely and
 * this never binds. When the engine falls behind -- which is the case the
 * setting exists for -- it bounds how far the window may advance before a
 * partial is forced, so a word straddling the boundary appears whole in at
 * least one window instead of being cut in both.
 *
 * Concretely: with a 6 s window and 2 s overlap, the window may never advance
 * more than 4 s between partials.
 *
 * @returns {number}
 */
export function overlapSeconds() {
  const overlap = intEnv( 'VOICE_STREAM_OVERLAP_SECONDS', 2, 0, 29 );
  const window = windowSeconds();
  // An overlap at or above the window would mean the window may never advance,
  // which is a request for infinite partials of identical audio. Held one
  // second below, so the guarantee stays satisfiable.
  return Math.min( overlap, Math.max( 0, window - 1 ) );
}

/**
 * Beam width for partial transcription. Section 4: fixed at 1.
 *
 * Not configurable, and the specification says so. Beam search is off for
 * partials because they are discarded the moment the next one arrives; paying
 * five times the compute for a hypothesis with a lifetime of 400 ms would
 * spend the entire latency budget on text nobody reads to the end.
 *
 * @returns {number}
 */
export function partialBeam() {
  return 1;
}

/**
 * Beam width for the final transcription. Section 4: fixed at 5.
 *
 * The same value the non-streaming path uses, which is what makes acceptance
 * criterion 9 -- no measurable accuracy loss against the current build --
 * a property of the design rather than something to hope for. The final
 * transcript is produced by the same engine, at the same beam width, over the
 * same audio.
 *
 * @returns {number}
 */
export function finalBeam() {
  return 5;
}

/**
 * Hard cap on partial latency, in milliseconds. Section 4, default 400.
 *
 * ── What a cap can and cannot mean here ──────────────────────────────────
 *
 * faster-whisper's transcribe() is synchronous and offers no cancellation, so
 * this cannot abort work in flight. Implemented as BACKPRESSURE instead: when
 * a partial takes longer than this, the next one is skipped rather than queued.
 *
 * That is the behaviour the cap is actually for. Without it, an engine running
 * slower than real time accumulates a queue of partials, each describing audio
 * further in the past, and the displayed hypothesis drifts steadily behind the
 * speaker -- which is worse than fewer, current partials. Acceptance criterion
 * 3 (zero unbounded growth) is a property of this and of the ring buffer
 * together.
 *
 * @returns {number}
 */
export function maxPartialMs() {
  return intEnv( 'VOICE_STREAM_MAX_PARTIAL_MS', 400, 50, 10_000 );
}

/**
 * Ceiling on one utterance, in seconds.
 *
 * Not in the specification, and required by it: Section 7 says audio is
 * transient and Section 8 requires no unbounded growth, but the FINAL
 * transcription accumulates the whole segment rather than a fixed window. A
 * session that never endpoints -- a stuck VAD, a hot mic in a noisy room --
 * would otherwise grow that accumulation without limit.
 *
 * At the ceiling the session finalises what it has and closes, which is a
 * visible outcome the user can act on, rather than a silent memory climb.
 *
 * @returns {number}
 */
export function maxUtteranceSeconds() {
  return intEnv( 'VOICE_STREAM_MAX_UTTERANCE_SECONDS', 120, 5, 900 );
}

/**
 * How long a session may sit with no audio and no control message.
 *
 * A browser tab that is closed mid-stream does not always produce a close
 * frame -- a killed process, a dropped mobile connection and a locked phone
 * all just stop. Without this the session and its buffers stay resident until
 * the TCP connection is reaped, which can be minutes.
 *
 * @returns {number}
 */
export function idleTimeoutMs() {
  return intEnv( 'VOICE_STREAM_IDLE_MS', 30_000, 1000, 600_000 );
}

/**
 * Concurrent streaming sessions the connector will hold open.
 *
 * Each session holds a ring buffer and competes for one Whisper worker. Past a
 * small number they do not degrade gracefully; they all get slower together
 * until every partial misses its budget. Refusing the eleventh upgrade is a
 * clear answer; admitting it and making ten sessions worse is not.
 *
 * @returns {number}
 */
export function maxSessions() {
  return intEnv( 'VOICE_STREAM_MAX_SESSIONS', 10, 1, 500 );
}

/**
 * The WebSocket path. One value, read by the connector and named in the docs.
 */
export const STREAM_PATH = '/voice/stream';

/**
 * Samples held in the ring buffer, derived from the window.
 *
 * @returns {number}
 */
export function windowSamples() {
  return windowSeconds() * SAMPLE_RATE;
}

/**
 * Maximum samples the window may advance between partials.
 *
 * @returns {number}
 */
export function maxAdvanceSamples() {
  return Math.max( FRAME_SAMPLES,
                   ( windowSeconds() - overlapSeconds() ) * SAMPLE_RATE );
}

/**
 * The effective configuration, for the health endpoint and the debug log.
 *
 * Reported rather than inferred: an operator who set a value outside its
 * bounds sees the default here, which is the only way to tell that a setting
 * was rejected rather than applied.
 *
 * @returns {object}
 */
export function streamConfig() {
  return {
    enabled: streamingEnabled(),
    path: STREAM_PATH,
    sample_rate: SAMPLE_RATE,
    frame_samples: FRAME_SAMPLES,
    frame_ms: FRAME_MS,
    format: 's16le',
    window_seconds: windowSeconds(),
    overlap_seconds: overlapSeconds(),
    partial_beam: partialBeam(),
    final_beam: finalBeam(),
    max_partial_ms: maxPartialMs(),
    max_utterance_seconds: maxUtteranceSeconds(),
    language: defaultLanguage(),
    idle_timeout_ms: idleTimeoutMs(),
    max_sessions: maxSessions(),
    debug_log: debugLogEnabled(),
  };
}

export default {
  SAMPLE_RATE, BYTES_PER_SAMPLE, FRAME_SAMPLES, FRAME_BYTES, FRAME_MS,
  STREAM_PATH,
  streamingEnabled, debugLogEnabled, defaultLanguage,
  windowSeconds, overlapSeconds,
  partialBeam, finalBeam, maxPartialMs, maxUtteranceSeconds, idleTimeoutMs,
  maxSessions, windowSamples, maxAdvanceSamples, streamConfig,
};
