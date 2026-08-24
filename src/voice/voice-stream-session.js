// src/voice/voice-stream-session.js
//
// Tenax Voice -- one streaming transcription session.
// STREAM-WHISPER-v1.0.0 Sections 4, 5, 7 and 8.
//
// ===========================================================================
// WHAT THIS IS, AND WHY IT HOLDS NO SOCKET
// ===========================================================================
//
// The rolling-window mechanic, and nothing else. Audio goes in as int16
// frames; partial and final transcripts come out through callbacks.
//
// It has no reference to a WebSocket, no reference to Express, and no
// reference to the transcription engine beyond an injected function. That is
// what makes the interesting behaviour -- backpressure under a slow engine,
// the overlap guarantee, the utterance ceiling, finalise racing a partial --
// testable at full speed with a stub engine, in milliseconds, deterministically.
//
// The alternative shape, where the socket handler owns the ring buffer, is the
// one where those paths can only be exercised against a real model over a real
// socket, which means in practice they are exercised by users.
//
// ===========================================================================
// THE TWO BUFFERS, WHICH ARE NOT THE SAME BUFFER
// ===========================================================================
//
// RING (bounded, Section 4). The most recent `window` seconds. Every partial
// transcribes this and only this. It is a fixed allocation written in a circle,
// so sustained speech does not grow it -- acceptance criterion 3.
//
// SEGMENT (accumulating, Section 4). Everything since speech started, used
// once, for the final transcription at beam 5. This one DOES grow, which is
// why `maxUtteranceSeconds` exists: an utterance that never ends must end
// somewhere, and it is better that it ends visibly.
//
// Conflating them is the obvious simplification and it breaks one requirement
// or the other: a single bounded buffer loses the beginning of a long sentence
// from the final transcript, and a single growing buffer makes each partial
// slower than the last until the stream collapses.
//
// ===========================================================================
// AUDIO IS TRANSIENT (Section 7)
// ===========================================================================
//
// Both buffers live in memory and are released on close, cancel and error.
// Nothing here writes audio to disk; the engine adaptor is handed samples and
// owns whatever it does with them. Nothing here logs a transcript or a sample
// value. `debugLog` emits durations and counts only.

import {
  SAMPLE_RATE, FRAME_SAMPLES,
  windowSamples, maxAdvanceSamples, maxPartialMs, maxUtteranceSeconds,
  partialBeam, finalBeam, debugLogEnabled,
} from './voice-stream-config.js';

/** Session lifecycle states. */
export const STATE = {
  IDLE: 'idle',           // constructed, no audio yet
  STREAMING: 'streaming', // audio arriving, partials running
  FINALISING: 'finalising', // finalise requested, final transcription running
  CLOSED: 'closed',       // terminal, buffers released
};

/**
 * A fixed-size ring of int16 samples.
 *
 * Int16Array rather than an array of Buffers: the engine adaptor needs one
 * contiguous run of samples in order, and reassembling that from a list of
 * frames on every partial would allocate a fresh multi-megabyte buffer several
 * times a second. Here the allocation happens once, at construction.
 */
class Ring {
  /** @param {number} capacity Samples. */
  constructor( capacity ) {
    this.capacity = Math.max( 1, capacity | 0 );
    this.data = new Int16Array( this.capacity );
    this.write = 0;
    this.filled = 0;
  }

  /**
   * Append samples, overwriting the oldest when full.
   *
   * @param {Int16Array} samples
   * @returns {void}
   */
  push( samples ) {
    const n = samples.length;
    if ( 0 === n ) return;

    // A frame larger than the whole ring can only contribute its tail. Not a
    // realistic wire frame, but a caller that batches could produce one, and
    // the modulo arithmetic below would otherwise wrap repeatedly and write
    // the same slots several times for no reason.
    if ( n >= this.capacity ) {
      this.data.set( samples.subarray( n - this.capacity ) );
      this.write = 0;
      this.filled = this.capacity;
      return;
    }

    const tail = this.capacity - this.write;
    if ( n <= tail ) {
      this.data.set( samples, this.write );
    } else {
      this.data.set( samples.subarray( 0, tail ), this.write );
      this.data.set( samples.subarray( tail ), 0 );
    }
    this.write = ( this.write + n ) % this.capacity;
    this.filled = Math.min( this.capacity, this.filled + n );
  }

  /**
   * The contents, oldest sample first.
   *
   * Copies. The caller hands this to an engine that may hold it across an
   * await, and returning a view into a buffer that keeps being written would
   * transcribe audio that changed underneath it.
   *
   * @returns {Int16Array}
   */
  read() {
    const out = new Int16Array( this.filled );
    if ( 0 === this.filled ) return out;

    if ( this.filled < this.capacity ) {
      out.set( this.data.subarray( 0, this.filled ) );
      return out;
    }
    const tail = this.capacity - this.write;
    out.set( this.data.subarray( this.write ), 0 );
    out.set( this.data.subarray( 0, this.write ), tail );
    return out;
  }

  /** Release the allocation. Section 7. */
  clear() {
    this.data = new Int16Array( 0 );
    this.capacity = 0;
    this.write = 0;
    this.filled = 0;
  }
}

/**
 * One streaming transcription session.
 */
export class StreamSession {
  /**
   * @param {object} opts
   * @param {Function} opts.transcribe  async ({samples, sampleRate, beam,
   *        condition, language, model, final}) => {text, language,
   *        duration_seconds, segments}
   * @param {Function} [opts.onPartial] ({text, seq, elapsedMs}) => void
   * @param {Function} [opts.onFinal]   (result) => void
   * @param {Function} [opts.onError]   ({code, message}) => void
   * @param {Function} [opts.onMetric]  (metric) => void   Section 7: anonymised.
   * @param {string}   [opts.language]
   * @param {string}   [opts.model]
   * @param {string}   [opts.id]
   */
  constructor( opts ) {
    const o = opts || {};

    this.id = o.id || Math.random().toString( 36 ).slice( 2, 10 );
    this.transcribeFn = o.transcribe;
    this.onPartial = o.onPartial || ( () => {} );
    this.onFinal = o.onFinal || ( () => {} );
    this.onError = o.onError || ( () => {} );
    this.onMetric = o.onMetric || ( () => {} );
    this.language = o.language || '';
    this.model = o.model || '';

    this.state = STATE.IDLE;

    // Geometry is captured ONCE, at construction. Reading it per frame would
    // let a mid-session environment change resize the ring under a partial
    // that is already reading it.
    this.windowSamples = windowSamples();
    this.maxAdvance = maxAdvanceSamples();
    this.maxPartialMs = maxPartialMs();
    this.maxSegmentSamples = maxUtteranceSeconds() * SAMPLE_RATE;

    this.ring = new Ring( this.windowSamples );

    // The accumulating segment, as a list of frames joined once at finalise.
    // Joining on every push would be quadratic in the length of the utterance.
    this.segment = [];
    this.segmentSamples = 0;

    this.partialSeq = 0;
    this.partialInFlight = false;
    this.lastPartialMs = 0;
    this.samplesSincePartial = 0;
    this.pendingPartial = false;

    // Counters, not content. Section 7.
    this.stats = {
      frames: 0, samples: 0, partials: 0, partialsSkipped: 0,
      droppedFrames: 0, slowPartials: 0,
    };

    // v13.19.2. Set by cancel(), and checked by finalise() AFTER its await.
    // `state` alone cannot carry this: finalise's own release() also lands on
    // CLOSED, so a post-await state check cannot tell "the user discarded this"
    // from "this finished normally".
    this.abandoned = false;

    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.closed = false;
  }

  /** @returns {boolean} Is this session accepting audio? */
  get accepting() {
    return STATE.IDLE === this.state || STATE.STREAMING === this.state;
  }

  /**
   * Anonymised diagnostics. Never audio, never a transcript. Section 7.
   *
   * @param {string} event
   * @param {object} [fields]
   * @returns {void}
   */
  debugLog( event, fields ) {
    if ( ! debugLogEnabled() ) return;
    const parts = Object.entries( fields || {} )
      .map( ( [ k, v ] ) => `${ k }=${ v }` ).join( ' ' );
    console.log( `[voice-stream] ${ event } session=${ this.id } ${ parts }` );
  }

  /**
   * Feed one wire frame.
   *
   * ── Why a short frame is dropped rather than buffered ────────────────────
   *
   * The wire contract is whole 40 ms frames. A partial frame means the sender
   * is not following it, and stitching fragments here would hide that while
   * introducing a second place audio can be reordered. Section 3's own answer
   * to a stressed transport is to drop audio, not to queue it.
   *
   * @param {Buffer|Uint8Array} bytes int16 little-endian PCM.
   * @returns {boolean} Whether the frame was accepted.
   */
  pushAudio( bytes ) {
    if ( ! this.accepting ) return false;
    if ( ! bytes || ! bytes.length ) return false;

    // Odd length cannot be int16 samples. One byte of a sample is not a sample.
    if ( bytes.length % 2 ) {
      this.stats.droppedFrames += 1;
      return false;
    }

    const samples = toInt16( bytes );
    if ( ! samples.length ) return false;

    this.lastActivityAt = Date.now();
    if ( STATE.IDLE === this.state ) this.state = STATE.STREAMING;

    this.ring.push( samples );

    // The segment stops accumulating at the ceiling, and the session finalises
    // rather than silently truncating. Truncation would produce a final
    // transcript missing its end with nothing to indicate why.
    if ( this.segmentSamples < this.maxSegmentSamples ) {
      this.segment.push( samples );
      this.segmentSamples += samples.length;
    }

    this.stats.frames += 1;
    this.stats.samples += samples.length;
    this.samplesSincePartial += samples.length;

    if ( this.segmentSamples >= this.maxSegmentSamples ) {
      this.debugLog( 'utterance_ceiling', { seconds: maxUtteranceSeconds() } );
      // Deliberately fire-and-forget: pushAudio is called from a socket data
      // handler that cannot usefully await, and finalise reports through its
      // own callbacks.
      void this.finalise( { reason: 'utterance_ceiling' } );
      return true;
    }

    void this.maybePartial();
    return true;
  }

  /**
   * Run a partial if one is due and the engine is free.
   *
   * ── The scheduling rule, in full ─────────────────────────────────────────
   *
   * At most one partial in flight. A second concurrent transcription would
   * compete with the first for the same worker and make both miss the budget.
   *
   * When one is in flight, a `pendingPartial` flag is set instead of queueing.
   * A flag rather than a queue is the whole of acceptance criterion 3 on this
   * path: however far behind the engine falls, the backlog is one boolean, and
   * the partial that eventually runs describes the CURRENT window rather than
   * a stale one.
   *
   * When the previous partial exceeded `maxPartialMs`, the next is skipped
   * unless the overlap floor forces it. That is the cap doing the only thing a
   * cap can do against a synchronous engine -- reduce the rate rather than
   * abort work in flight.
   *
   * The overlap floor overrides the skip. Section 4's stated purpose for
   * overlap is avoiding boundary word loss, and skipping is exactly what would
   * cause it: a window that advanced past the floor with no partial in between
   * means audio nothing ever transcribed at full context.
   *
   * @returns {Promise<void>}
   */
  async maybePartial() {
    if ( ! this.accepting ) return;

    if ( this.partialInFlight ) { this.pendingPartial = true; return; }

    const overlapForces = this.samplesSincePartial >= this.maxAdvance;

    // Nothing new since the last partial: transcribing identical audio twice
    // produces an identical hypothesis at full cost.
    if ( this.samplesSincePartial < FRAME_SAMPLES ) return;

    if ( this.lastPartialMs > this.maxPartialMs && ! overlapForces ) {
      this.stats.partialsSkipped += 1;
      return;
    }

    await this.runPartial();
  }

  /**
   * Transcribe the ring window once.
   *
   * @returns {Promise<void>}
   */
  async runPartial() {
    const samples = this.ring.read();
    if ( ! samples.length ) return;

    this.partialInFlight = true;
    this.pendingPartial = false;
    this.samplesSincePartial = 0;
    const seq = ++this.partialSeq;
    const started = Date.now();

    try {
      const result = await this.transcribeFn( {
        samples,
        sampleRate: SAMPLE_RATE,
        beam: partialBeam(),
        // Section 4: each ring window is transcribed independently of the last,
        // so a mistake in one partial cannot propagate into every partial after
        // it. Whisper conditioned on its own previous output is the well-known
        // way to turn one misheard word into a paragraph built on it.
        condition: false,
        language: this.language,
        model: this.model,
        final: false,
      } );

      const elapsed = Date.now() - started;
      this.lastPartialMs = elapsed;
      this.stats.partials += 1;
      if ( elapsed > this.maxPartialMs ) this.stats.slowPartials += 1;

      this.debugLog( 'partial', { seq, ms: elapsed,
                                  samples: samples.length,
                                  over_budget: elapsed > this.maxPartialMs } );
      this.onMetric( { type: 'partial', seq, elapsed_ms: elapsed,
                       window_samples: samples.length,
                       over_budget: elapsed > this.maxPartialMs } );

      // A partial that finished after finalise started is stale by definition:
      // the final transcript is authoritative and is already on its way.
      // Emitting it would overwrite the final text in the UI with a worse
      // hypothesis of a subset of the same audio.
      if ( this.accepting ) {
        this.onPartial( { text: String( ( result && result.text ) || '' ),
                          seq, elapsedMs: elapsed } );
      }
    } catch ( err ) {
      // A failed partial is not a failed session. The next window is
      // independent and may well succeed, and the final transcription -- the
      // one the user actually receives -- has not been attempted yet.
      this.debugLog( 'partial_failed', { seq, code: err.code || 'stt_failed' } );
      this.onMetric( { type: 'partial_error', seq, code: err.code || 'stt_failed' } );
    } finally {
      this.partialInFlight = false;
    }

    if ( this.pendingPartial && this.accepting ) {
      this.pendingPartial = false;
      await this.maybePartial();
    }
  }

  /**
   * Finalise the utterance: transcribe the whole segment at beam 5.
   *
   * ── Idempotent on purpose ────────────────────────────────────────────────
   *
   * Section 5 has the VAD fire finalise, and the user may also press stop, and
   * the utterance ceiling may fire, and the socket may close -- potentially
   * within milliseconds of each other. Two finals for one utterance would send
   * the message twice, which is acceptance criterion 4's "phantom message" in
   * its most annoying form.
   *
   * @param {{reason?: string}} [opts]
   * @returns {Promise<object|null>} The final result, or null if not produced.
   */
  async finalise( opts ) {
    const reason = ( opts && opts.reason ) || 'endpoint';

    if ( STATE.FINALISING === this.state || STATE.CLOSED === this.state ) return null;

    // A cancel that arrived before finalise was even called. Without this an
    // idle renewed session could be finalised by a late control frame.
    if ( this.abandoned ) return null;

    this.state = STATE.FINALISING;
    this.lastActivityAt = Date.now();
    const started = Date.now();

    const samples = joinFrames( this.segment, this.segmentSamples );

    // Nothing was ever spoken. Section 5 resumes cleanly from this, and an
    // empty final is the honest answer -- a transcription of silence is where
    // Whisper invents sentences nobody said.
    if ( ! samples.length ) {
      if ( this.abandoned ) { this.release(); return null; }
      this.debugLog( 'final_empty', { reason } );
      const empty = { text: '', language: this.language || '',
                      duration_seconds: 0, segments: [], reason };
      this.onFinal( empty );
      this.release();
      return empty;
    }

    try {
      const result = await this.transcribeFn( {
        samples,
        sampleRate: SAMPLE_RATE,
        beam: finalBeam(),
        // The final transcription sees one continuous utterance rather than a
        // window, so conditioning is left to the engine's own default for a
        // whole-file transcription. This is the same call the non-streaming
        // path makes, which is what acceptance criterion 9 rests on.
        condition: true,
        language: this.language,
        model: this.model,
        final: true,
      } );

      const elapsed = Date.now() - started;
      this.debugLog( 'final', { reason, ms: elapsed,
                                seconds: ( samples.length / SAMPLE_RATE ).toFixed( 2 ) } );
      this.onMetric( { type: 'final', elapsed_ms: elapsed, reason,
                       audio_seconds: samples.length / SAMPLE_RATE,
                       partials: this.stats.partials,
                       partials_skipped: this.stats.partialsSkipped,
                       dropped_frames: this.stats.droppedFrames } );

      const out = {
        text: String( ( result && result.text ) || '' ),
        language: String( ( result && result.language ) || this.language || '' ),
        duration_seconds: Number( result && result.duration_seconds ) || 0,
        segments: Array.isArray( result && result.segments ) ? result.segments : [],
        reason,
      };

      // v13.19.2 -- acceptance criterion 4, the half that only shows under real
      // timing. A beam-5 decode takes seconds, and a user who resumes speaking
      // during one cancels the utterance mid-decode. Emitting the result now
      // would deliver a transcript the user explicitly discarded, AFTER the
      // client has already been told the cancel succeeded.
      //
      // runPartial has always had the equivalent guard (`this.accepting`);
      // finalise did not, because when it was written a cancel closed the
      // socket and nothing could be delivered over it anyway.
      if ( this.abandoned ) {
        this.debugLog( 'final_discarded', { reason } );
        this.release();
        return null;
      }

      this.onFinal( out );
      this.release();
      return out;
    } catch ( err ) {
      this.debugLog( 'final_failed', { reason, code: err.code || 'stt_failed' } );
      this.onError( { code: err.code || 'stt_failed',
                      message: 'Transcription failed.' } );
      this.release();
      return null;
    }
  }

  /**
   * Abandon the utterance without transcribing it. Acceptance criterion 4.
   *
   * The distinction from finalise is the whole of that criterion: cancel must
   * leave no message anywhere, so no final is emitted and no transcription is
   * started. A partial already in flight is allowed to complete and its result
   * is discarded by the `accepting` check in runPartial.
   *
   * @returns {void}
   */
  cancel() {
    // Set before the early return: a session already CLOSED by its own
    // release() may still have a finalise awaiting an engine call, and that
    // decode must not deliver.
    this.abandoned = true;
    if ( STATE.CLOSED === this.state ) return;
    this.debugLog( 'cancel', { frames: this.stats.frames } );
    this.onMetric( { type: 'cancel', frames: this.stats.frames,
                     partials: this.stats.partials } );
    this.state = STATE.CLOSED;
    this.release();
  }

  /**
   * Release every buffer. Section 7: audio is transient.
   *
   * Called on every terminal path -- final, cancel, error, socket close --
   * rather than only on the tidy one, because the untidy paths are the ones
   * that happen under load.
   *
   * @returns {void}
   */
  release() {
    this.state = STATE.CLOSED;
    this.closed = true;
    this.ring.clear();
    this.segment = [];
    this.segmentSamples = 0;
  }

  /**
   * Has this session gone quiet for longer than the idle ceiling?
   *
   * @param {number} nowMs
   * @param {number} idleMs
   * @returns {boolean}
   */
  isIdle( nowMs, idleMs ) {
    return ( nowMs - this.lastActivityAt ) > idleMs;
  }

  /**
   * Counters for the health endpoint. Never content.
   *
   * @returns {object}
   */
  snapshot() {
    return {
      id: this.id,
      state: this.state,
      age_ms: Date.now() - this.startedAt,
      frames: this.stats.frames,
      audio_seconds: Number( ( this.stats.samples / SAMPLE_RATE ).toFixed( 2 ) ),
      partials: this.stats.partials,
      partials_skipped: this.stats.partialsSkipped,
      slow_partials: this.stats.slowPartials,
      dropped_frames: this.stats.droppedFrames,
      last_partial_ms: this.lastPartialMs,
    };
  }
}

/**
 * Reinterpret wire bytes as int16 samples.
 *
 * ── Why this is not a bare Int16Array view ───────────────────────────────
 *
 * Two reasons, and both produce silent corruption rather than an error.
 *
 * Node pools small Buffers, so `buf.byteOffset` is frequently not a multiple
 * of two, and `new Int16Array(buf.buffer, buf.byteOffset, n)` throws on an
 * unaligned offset. Copying sidesteps alignment entirely.
 *
 * A view would also alias memory the socket layer may reuse for the next
 * frame, so a window held across an await could change beneath the engine.
 *
 * Little-endian is read explicitly rather than assumed: every platform this
 * runs on today is little-endian, which is exactly why an assumption here
 * would go unnoticed until it did not.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {Int16Array}
 */
export function toInt16( bytes ) {
  const n = bytes.length >> 1;
  const out = new Int16Array( n );
  for ( let i = 0; i < n; i += 1 ) {
    const lo = bytes[ i * 2 ];
    const hi = bytes[ i * 2 + 1 ];
    const v = lo | ( hi << 8 );
    out[ i ] = v & 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/**
 * Concatenate accumulated frames into one run of samples.
 *
 * @param {Int16Array[]} frames
 * @param {number} total
 * @returns {Int16Array}
 */
export function joinFrames( frames, total ) {
  const out = new Int16Array( total );
  let at = 0;
  for ( const f of frames ) {
    if ( at + f.length > total ) {
      out.set( f.subarray( 0, total - at ), at );
      at = total;
      break;
    }
    out.set( f, at );
    at += f.length;
  }
  return out;
}

export default { StreamSession, STATE, toInt16, joinFrames };
