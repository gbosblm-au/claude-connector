// src/tests/voice-stream.test.js
//
// Tenax Voice -- streaming chunked transcription.
// STREAM-WHISPER-v1.0.0 Sections 3, 4, 5, 7, 8 and 9.
//
// ===========================================================================
// WHAT THESE TESTS ARE FOR
// ===========================================================================
//
// The acceptance criteria that can be decided by inspection, decided by
// inspection. Criteria 1, 2, 6 and 9 are latency and accuracy measurements
// against a real model on real hardware and belong in the benchmark harness,
// not here -- asserting a 400 ms budget against a stub engine would prove
// nothing except that the stub is fast.
//
// What IS here is every criterion that is a property of the code:
//
//   AC3  no unbounded growth under sustained speech
//   AC4  cancellation leaves no message anywhere
//   AC5  a resumed pause does not produce a split final
//   AC7  a backgrounded tab stops rather than buffering
//   AC8  the flag off means the streaming path does not exist
//
// The engine is a stub with a controllable delay, so "the engine is slower
// than real time" -- the condition the whole backpressure design exists for,
// and the one that is hardest to produce on demand against a real model -- is
// one line of test setup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StreamSession, STATE, toInt16, joinFrames,
} from '../voice/voice-stream-session.js';
import {
  SAMPLE_RATE, FRAME_SAMPLES, FRAME_BYTES, FRAME_MS,
  streamingEnabled, windowSeconds, overlapSeconds, maxAdvanceSamples,
  partialBeam, finalBeam, streamConfig,
} from '../voice/voice-stream-config.js';
import { authenticateUpgrade } from '../voice/voice-stream-auth.js';
import { defaultLanguage } from '../voice/voice-stream-config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One 40 ms frame of non-silent audio, as wire bytes. */
function frame( value ) {
  const buf = Buffer.alloc( FRAME_BYTES );
  for ( let i = 0; i < FRAME_SAMPLES; i += 1 ) {
    buf.writeInt16LE( value === undefined ? 1000 : value, i * 2 );
  }
  return buf;
}

/**
 * A stub engine that records every call.
 *
 * @param {{delayMs?: number, fail?: boolean}} [opts]
 */
function stubEngine( opts ) {
  const o = opts || {};
  const calls = [];
  const fn = async ( req ) => {
    calls.push( {
      samples: req.samples.length, beam: req.beam,
      condition: req.condition, final: req.final,
    } );
    if ( o.delayMs ) await new Promise( ( r ) => setTimeout( r, o.delayMs ) );
    if ( o.fail ) {
      const err = new Error( 'engine down' );
      err.code = 'stt_unavailable';
      throw err;
    }
    return { text: `t${ calls.length }`, language: 'en',
             duration_seconds: req.samples.length / SAMPLE_RATE, segments: [] };
  };
  fn.calls = calls;
  return fn;
}

/** Build a session with collected outputs. */
function makeSession( engine, extra ) {
  const out = { partials: [], finals: [], errors: [], metrics: [] };
  const session = new StreamSession( {
    transcribe: engine,
    onPartial: ( p ) => out.partials.push( p ),
    onFinal: ( f ) => out.finals.push( f ),
    onError: ( e ) => out.errors.push( e ),
    onMetric: ( m ) => out.metrics.push( m ),
    ...( extra || {} ),
  } );
  return { session, out };
}

/** Let queued microtasks and timers settle. */
const settle = ( ms ) => new Promise( ( r ) => setTimeout( r, ms || 5 ) );

/** Run a body with environment overrides, restoring afterwards. */
async function withEnv( vars, body ) {
  const saved = {};
  for ( const [ k, v ] of Object.entries( vars ) ) {
    saved[ k ] = process.env[ k ];
    if ( undefined === v ) delete process.env[ k ];
    else process.env[ k ] = String( v );
  }
  try { return await body(); }
  finally {
    for ( const [ k, v ] of Object.entries( saved ) ) {
      if ( undefined === v ) delete process.env[ k ];
      else process.env[ k ] = v;
    }
  }
}

// ===========================================================================
// Wire format (Section 3)
// ===========================================================================

test( 'the frame geometry is exactly 40ms at 16kHz', () => {
  // Section 3: "640 samples = 40ms per frame". Asserted rather than assumed
  // because the browser computes its buffer size from the same arithmetic, and
  // a mismatch is not an error anywhere -- it is just a ring buffer whose
  // seconds are not seconds.
  assert.equal( SAMPLE_RATE, 16000 );
  assert.equal( FRAME_SAMPLES, 640 );
  assert.equal( FRAME_MS, 40 );
  assert.equal( FRAME_BYTES, 1280, 'int16, so two bytes a sample' );
} );

test( 'the wire rate is the 32KBps the specification states', () => {
  // Section 3 gave the format twice and the two disagreed: "f32" and "32KBps".
  // int16 is the one that matches the stated bitrate, and this is the
  // arithmetic that settled it.
  const bytesPerSecond = SAMPLE_RATE * ( FRAME_BYTES / FRAME_SAMPLES );
  assert.equal( bytesPerSecond, 32000 );
} );

test( 'wire bytes are read as little-endian signed samples', () => {
  const buf = Buffer.alloc( 8 );
  buf.writeInt16LE( 0, 0 );
  buf.writeInt16LE( 32767, 2 );
  buf.writeInt16LE( -32768, 4 );
  buf.writeInt16LE( -1, 6 );

  assert.deepEqual( Array.from( toInt16( buf ) ), [ 0, 32767, -32768, -1 ] );
} );

test( 'an unaligned buffer is still read correctly', () => {
  // Node pools small Buffers, so byteOffset is routinely odd. An Int16Array
  // view over one throws; this is why toInt16 copies.
  const pool = Buffer.alloc( 9 );
  pool.writeInt16LE( 1234, 1 );
  const slice = pool.subarray( 1, 3 );
  assert.deepEqual( Array.from( toInt16( slice ) ), [ 1234 ] );
} );

// ===========================================================================
// AC3 -- no unbounded growth
// ===========================================================================

test( 'the ring buffer does not grow under sustained speech', async () => {
  // Acceptance criterion 3. Twelve seconds of audio into a six-second window.
  const engine = stubEngine();
  const { session } = makeSession( engine );

  const framesPerSecond = 1000 / FRAME_MS;
  for ( let i = 0; i < framesPerSecond * 12; i += 1 ) {
    session.pushAudio( frame() );
  }
  await settle( 20 );

  const cap = windowSeconds() * SAMPLE_RATE;
  assert.equal( session.ring.capacity, cap, 'the allocation is fixed' );
  assert.equal( session.ring.filled, cap, 'and full, not growing' );

  for ( const call of engine.calls ) {
    assert.ok( call.samples <= cap,
      `a partial saw ${ call.samples } samples, more than the window` );
  }
} );

test( 'the ring keeps the MOST RECENT audio, in order', () => {
  const { session } = makeSession( stubEngine() );
  session.ring = new session.ring.constructor( 4 );

  session.ring.push( Int16Array.from( [ 1, 2, 3 ] ) );
  session.ring.push( Int16Array.from( [ 4, 5, 6 ] ) );

  // Oldest first, oldest dropped. A ring that returned its contents in write
  // order rather than time order would transcribe a sentence with its middle
  // moved to the front, which reads as a plausible transcription of something
  // nobody said.
  assert.deepEqual( Array.from( session.ring.read() ), [ 3, 4, 5, 6 ] );
} );

test( 'a push larger than the whole ring keeps only its tail', () => {
  const { session } = makeSession( stubEngine() );
  session.ring = new session.ring.constructor( 3 );
  session.ring.push( Int16Array.from( [ 1, 2, 3, 4, 5 ] ) );
  assert.deepEqual( Array.from( session.ring.read() ), [ 3, 4, 5 ] );
} );

test( 'at most one partial is ever in flight', async () => {
  // The backlog under a slow engine is one boolean, not a queue. This is the
  // other half of acceptance criterion 3: the ring bounds memory, and this
  // bounds the work queued against it.
  let concurrent = 0;
  let peak = 0;
  const engine = async ( req ) => {
    concurrent += 1;
    peak = Math.max( peak, concurrent );
    await settle( 15 );
    concurrent -= 1;
    return { text: 'x', language: 'en',
             duration_seconds: req.samples.length / SAMPLE_RATE, segments: [] };
  };

  const { session } = makeSession( engine );
  for ( let i = 0; i < 60; i += 1 ) session.pushAudio( frame() );
  await settle( 120 );

  assert.equal( peak, 1, `${ peak } partials ran at once` );
} );

test( 'a slow engine reduces the partial rate rather than queueing', async () => {
  // VOICE_STREAM_MAX_PARTIAL_MS as backpressure. faster-whisper's transcribe()
  // cannot be cancelled mid-call, so the only thing a cap can do is schedule
  // fewer of them -- which is also the right thing, because a queued partial
  // describes audio the speaker has already moved past.
  //
  // 60 is used rather than a smaller number because the setting has a floor of
  // 50: below it the value is rejected and the default applies, which would
  // make this test pass while measuring nothing. That is exactly how it failed
  // the first time it was written.
  await withEnv( { VOICE_STREAM_MAX_PARTIAL_MS: 60 }, async () => {
    const engine = stubEngine( { delayMs: 120 } );
    const { session } = makeSession( engine );

    // Enough to start one partial.
    session.pushAudio( frame() );
    await settle( 5 );

    // A little more audio -- well under the overlap floor, so nothing forces a
    // partial and the cap is the only thing deciding.
    for ( let i = 0; i < 10; i += 1 ) session.pushAudio( frame() );
    await settle( 200 );

    assert.ok( session.lastPartialMs > 60,
      `the stub ran in ${ session.lastPartialMs }ms, which is not over the cap` );
    assert.ok( session.stats.partialsSkipped > 0,
      'the cap skipped nothing' );
    assert.equal( engine.calls.length, 1,
      `ran ${ engine.calls.length } partials; the cap did not hold the rate down` );
  } );
} );

// ===========================================================================
// The overlap guarantee (Section 4)
// ===========================================================================

test( 'the overlap floor overrides the latency cap', async () => {
  // Section 4's stated purpose for overlap is avoiding boundary word loss, and
  // skipping partials is precisely what causes it. So when the window has
  // advanced by more than window-minus-overlap, a partial runs even though the
  // cap would otherwise skip it -- otherwise a stretch of audio would be
  // transcribed at full context by nothing at all.
  await withEnv( {
    VOICE_STREAM_MAX_PARTIAL_MS: 60,
    VOICE_STREAM_WINDOW_SECONDS: 6,
    VOICE_STREAM_OVERLAP_SECONDS: 2,
  }, async () => {
    const engine = stubEngine( { delayMs: 120 } );
    const { session } = makeSession( engine );

    session.pushAudio( frame() );
    await settle( 5 );

    // Five seconds of audio while that partial is still running. The floor is
    // four seconds, so the window has advanced past it and a partial is owed
    // regardless of the cap.
    const frames = Math.ceil( ( 5 * 1000 ) / FRAME_MS );
    for ( let i = 0; i < frames; i += 1 ) session.pushAudio( frame() );
    await settle( 300 );

    assert.ok( session.lastPartialMs > 60, 'the stub should be over the cap' );
    assert.ok( engine.calls.length >= 2,
      `only ${ engine.calls.length } partial(s); the overlap floor never fired` );
  } );
} );

test( 'overlap can never exceed the window', async () => {
  // A misconfiguration that would demand a partial per frame forever.
  await withEnv( { VOICE_STREAM_WINDOW_SECONDS: 3,
                   VOICE_STREAM_OVERLAP_SECONDS: 10 }, () => {
    assert.ok( overlapSeconds() < windowSeconds() );
    assert.ok( maxAdvanceSamples() >= FRAME_SAMPLES );
  } );
} );

test( 'out-of-range settings fall back rather than being clamped silently', async () => {
  await withEnv( { VOICE_STREAM_WINDOW_SECONDS: 6000 }, () => {
    assert.equal( windowSeconds(), 6,
      'an absurd window should report the default, which is diagnosable' );
  } );
} );

// ===========================================================================
// Beams and conditioning (Section 4)
// ===========================================================================

test( 'partials run at beam 1 and finals at beam 5', async () => {
  const engine = stubEngine();
  const { session } = makeSession( engine );

  for ( let i = 0; i < 5; i += 1 ) session.pushAudio( frame() );
  await settle( 20 );
  await session.finalise();

  const partials = engine.calls.filter( ( c ) => ! c.final );
  const finals = engine.calls.filter( ( c ) => c.final );

  assert.ok( partials.length >= 1 );
  assert.equal( finals.length, 1 );
  assert.ok( partials.every( ( c ) => c.beam === partialBeam() ) );
  assert.equal( finals[ 0 ].beam, finalBeam() );
  assert.equal( partialBeam(), 1 );
  assert.equal( finalBeam(), 5 );
} );

test( 'partials are not conditioned on previous text', async () => {
  // Section 4. Whisper conditioned on its own previous output is the standard
  // way one misheard word becomes a paragraph built on it, and a partial is
  // discarded the moment the next arrives -- so there is nothing to gain and a
  // compounding error to lose.
  const engine = stubEngine();
  const { session } = makeSession( engine );
  for ( let i = 0; i < 5; i += 1 ) session.pushAudio( frame() );
  await settle( 20 );

  assert.ok( engine.calls.length >= 1 );
  assert.ok( engine.calls.every( ( c ) => false === c.condition ) );
} );

// ===========================================================================
// AC4 -- cancellation
// ===========================================================================

test( 'cancel produces no final and no message', async () => {
  const engine = stubEngine();
  const { session, out } = makeSession( engine );

  for ( let i = 0; i < 10; i += 1 ) session.pushAudio( frame() );
  await settle( 20 );
  session.cancel();
  await settle( 20 );

  assert.equal( out.finals.length, 0, 'a cancelled utterance produced a final' );
  assert.equal( session.state, STATE.CLOSED );
  assert.ok( engine.calls.every( ( c ) => ! c.final ),
    'a cancelled utterance was transcribed at beam 5' );
} );

test( 'cancel releases every buffer', () => {
  // Section 7: audio is transient.
  const { session } = makeSession( stubEngine() );
  for ( let i = 0; i < 10; i += 1 ) session.pushAudio( frame() );

  session.cancel();

  assert.equal( session.ring.capacity, 0 );
  assert.equal( session.segment.length, 0 );
  assert.equal( session.segmentSamples, 0 );
} );

test( 'a partial that lands after cancel is discarded', async () => {
  // The race acceptance criterion 4 calls a phantom message: the user pressed
  // stop while a partial was in flight, and the hypothesis must not surface
  // afterwards.
  const engine = stubEngine( { delayMs: 30 } );
  const { session, out } = makeSession( engine );

  for ( let i = 0; i < 3; i += 1 ) session.pushAudio( frame() );
  await settle( 5 );
  session.cancel();
  await settle( 60 );

  assert.equal( out.partials.length, 0 );
} );

test( 'audio pushed after cancel is refused', () => {
  const { session } = makeSession( stubEngine() );
  session.pushAudio( frame() );
  session.cancel();
  assert.equal( session.pushAudio( frame() ), false );
} );

// ===========================================================================
// AC5 -- finalise, and not twice
// ===========================================================================

test( 'finalise is idempotent, so a pause that resumes cannot split the final',
  async () => {
    // Acceptance criterion 5. The VAD, a user pressing stop, the utterance
    // ceiling and a socket close can all fire within milliseconds of each
    // other. Two finals for one utterance is the same message sent twice.
    const engine = stubEngine();
    const { session, out } = makeSession( engine );

    for ( let i = 0; i < 10; i += 1 ) session.pushAudio( frame() );
    await settle( 10 );

    const [ a, b ] = await Promise.all( [ session.finalise(), session.finalise() ] );

    assert.equal( out.finals.length, 1, 'two finals for one utterance' );
    assert.ok( a || b );
    assert.equal( engine.calls.filter( ( c ) => c.final ).length, 1 );
  } );

test( 'the final sees the WHOLE utterance, not just the ring window', async () => {
  // The reason there are two buffers. A final built from the ring would lose
  // the beginning of any sentence longer than the window, which is most of
  // them.
  const engine = stubEngine();
  const { session } = makeSession( engine );

  const frames = Math.ceil( ( ( windowSeconds() + 4 ) * 1000 ) / FRAME_MS );
  for ( let i = 0; i < frames; i += 1 ) session.pushAudio( frame() );
  await settle( 30 );
  await session.finalise();

  const final = engine.calls.find( ( c ) => c.final );
  assert.ok( final.samples > windowSeconds() * SAMPLE_RATE,
    'the final transcribed only a window, so the start of the utterance is lost' );
  assert.equal( final.samples, frames * FRAME_SAMPLES );
} );

test( 'finalising an empty session yields an empty transcript, not silence fed to Whisper',
  async () => {
    // A hard recording of a silent room is the condition under which Whisper
    // invents sentences. The existing autosend design rests on never doing it,
    // and streaming must not reintroduce it at the endpoint.
    const engine = stubEngine();
    const { session, out } = makeSession( engine );

    const result = await session.finalise();

    assert.equal( result.text, '' );
    assert.equal( out.finals.length, 1 );
    assert.equal( engine.calls.length, 0, 'silence was sent to the engine' );
  } );

test( 'the utterance ceiling finalises rather than truncating silently', async () => {
  await withEnv( { VOICE_STREAM_MAX_UTTERANCE_SECONDS: 5 }, async () => {
    const engine = stubEngine();
    const { session, out } = makeSession( engine );

    const frames = Math.ceil( ( 8 * 1000 ) / FRAME_MS );
    for ( let i = 0; i < frames; i += 1 ) session.pushAudio( frame() );
    await settle( 40 );

    assert.equal( out.finals.length, 1 );
    assert.equal( out.finals[ 0 ].reason, 'utterance_ceiling' );
    assert.ok( session.segmentSamples <= 5 * SAMPLE_RATE + FRAME_SAMPLES );
  } );
} );

test( 'a failed final reports an error and still releases the buffers', async () => {
  const { session, out } = makeSession( stubEngine( { fail: true } ) );
  for ( let i = 0; i < 5; i += 1 ) session.pushAudio( frame() );
  await settle( 10 );

  const result = await session.finalise();

  assert.equal( result, null );
  assert.equal( out.errors.length, 1 );
  assert.equal( session.ring.capacity, 0, 'buffers survived a failed final' );
} );

test( 'a failed partial does not end the session', async () => {
  // The next window is independent and may succeed, and the final -- the
  // transcript the user actually receives -- has not been attempted yet.
  let calls = 0;
  const engine = async ( req ) => {
    calls += 1;
    if ( ! req.final && calls < 3 ) throw new Error( 'transient' );
    return { text: 'ok', language: 'en', duration_seconds: 1, segments: [] };
  };

  const { session, out } = makeSession( engine );
  for ( let i = 0; i < 10; i += 1 ) { session.pushAudio( frame() ); await settle( 1 ); }
  await settle( 20 );

  assert.ok( session.accepting, 'a failed partial closed the session' );
  const result = await session.finalise();
  assert.equal( result.text, 'ok' );
  assert.equal( out.finals.length, 1 );
} );

// ===========================================================================
// Malformed input (Section 3 backpressure, AC7)
// ===========================================================================

test( 'a frame with an odd byte count is dropped and counted', () => {
  const { session } = makeSession( stubEngine() );
  assert.equal( session.pushAudio( Buffer.alloc( 641 ) ), false );
  assert.equal( session.stats.droppedFrames, 1 );
  assert.equal( session.stats.frames, 0 );
} );

test( 'empty and absent frames are not errors', () => {
  const { session } = makeSession( stubEngine() );
  assert.doesNotThrow( () => {
    session.pushAudio( Buffer.alloc( 0 ) );
    session.pushAudio( null );
    session.pushAudio( undefined );
  } );
} );

test( 'a session that goes quiet is reported idle', () => {
  // Acceptance criterion 7: a locked or backgrounded tab stops. It frequently
  // stops WITHOUT a close frame, so the server has to notice on its own.
  const { session } = makeSession( stubEngine() );
  session.pushAudio( frame() );
  session.lastActivityAt = Date.now() - 60_000;

  assert.equal( session.isIdle( Date.now(), 30_000 ), true );
  assert.equal( session.isIdle( Date.now(), 120_000 ), false );
} );

test( 'the snapshot carries counters and never content', () => {
  // Section 7: anonymised metrics, never raw audio and never a transcript.
  const { session } = makeSession( stubEngine() );
  session.pushAudio( frame() );

  const snap = session.snapshot();
  const serialised = JSON.stringify( snap );

  assert.equal( typeof snap.audio_seconds, 'number' );
  assert.ok( ! ( 'text' in snap ) );
  assert.ok( ! ( 'samples' in snap ) );
  assert.doesNotMatch( serialised, /transcript|audio_data|pcm/i );
} );

test( 'joinFrames respects its declared total', () => {
  const out = joinFrames( [ Int16Array.from( [ 1, 2 ] ),
                            Int16Array.from( [ 3, 4 ] ) ], 3 );
  assert.deepEqual( Array.from( out ), [ 1, 2, 3 ] );
} );

// ===========================================================================
// AC8 and Section 9 -- the feature flag
// ===========================================================================

test( 'streaming is off by default', async () => {
  await withEnv( { VOICE_STREAMING_ENABLED: undefined }, () => {
    assert.equal( streamingEnabled(), false,
      'Section 9 requires opt-in until benchmarked' );
  } );
} );

test( 'the flag off refuses an upgrade before any other check runs', async () => {
  await withEnv( { VOICE_STREAMING_ENABLED: 'false' }, async () => {
    const verdict = await authenticateUpgrade( { headers: {} } );
    assert.equal( verdict.ok, false );
    assert.equal( verdict.status, 404 );
    assert.equal( verdict.reason, 'streaming_disabled' );
  } );
} );

test( 'an anonymous upgrade is refused even with the flag on', async () => {
  // Section 7: no anonymous streams.
  await withEnv( {
    VOICE_STREAMING_ENABLED: 'true',
    VOICE_ENABLED: 'true',
    MCP_API_KEY: 'test-key-0123456789',
  }, async () => {
    const verdict = await authenticateUpgrade( { headers: {} } );
    assert.equal( verdict.ok, false );
    assert.equal( verdict.status, 401 );
  } );
} );

test( 'a valid credential with no user identity is still refused', async () => {
  // A transport credential proves the GATEWAY is calling. It says nothing
  // about which user, and Section 7 requires both.
  await withEnv( {
    VOICE_STREAMING_ENABLED: 'true',
    VOICE_ENABLED: 'true',
    MCP_API_KEY: 'test-key-0123456789',
  }, async () => {
    const verdict = await authenticateUpgrade( {
      headers: { authorization: 'Bearer test-key-0123456789' } } );
    assert.equal( verdict.ok, false );
    assert.equal( verdict.status, 401 );
    assert.equal( verdict.reason, 'unauthorised',
      'the reason must not reveal that the credential was accepted' );
  } );
} );

test( 'the refusal reason never distinguishes a good credential from a bad one', async () => {
  await withEnv( {
    VOICE_STREAMING_ENABLED: 'true',
    VOICE_ENABLED: 'true',
    MCP_API_KEY: 'test-key-0123456789',
  }, async () => {
    const bad = await authenticateUpgrade( {
      headers: { authorization: 'Bearer wrong-key-9876543210' } } );
    const goodNoUser = await authenticateUpgrade( {
      headers: { authorization: 'Bearer test-key-0123456789' } } );

    assert.equal( bad.reason, goodNoUser.reason );
    assert.equal( bad.status, goodNoUser.status );
  } );
} );

test( 'voice disabled refuses regardless of the streaming flag', async () => {
  await withEnv( {
    VOICE_STREAMING_ENABLED: 'true',
    VOICE_ENABLED: 'false',
  }, async () => {
    const verdict = await authenticateUpgrade( { headers: {} } );
    assert.equal( verdict.ok, false );
    assert.equal( verdict.status, 404 );
    assert.equal( verdict.reason, 'voice_disabled' );
  } );
} );

// ===========================================================================
// Language pinning (v13.19.1)
// ===========================================================================

test( 'the language is pinned to English by default', async () => {
  // Whisper's language identification is a separate forward pass, and on a
  // six-second window that starts and ends mid-speech it is both a real slice
  // of the latency budget and unreliable. A misdetection does not degrade the
  // transcript, it replaces it with confident text in the wrong language.
  await withEnv( { VOICE_STREAM_LANGUAGE: undefined }, () => {
    assert.equal( defaultLanguage(), 'en' );
  } );
} );

test( 'an explicit language is honoured', async () => {
  for ( const code of [ 'fr', 'de', 'cmn', 'pt-BR' ] ) {
    await withEnv( { VOICE_STREAM_LANGUAGE: code }, () => {
      assert.equal( defaultLanguage(), code );
    } );
  }
} );

test( 'an EMPTY language opts back into auto-detection', async () => {
  // Unset and empty are different answers. `env || 'en'` collapses them, which
  // would mean the documented escape hatch silently did not exist -- and that
  // is exactly how this was first written.
  await withEnv( { VOICE_STREAM_LANGUAGE: '' }, () => {
    assert.equal( defaultLanguage(), '',
      'an operator who asked for detection must get it' );
  } );
} );

test( 'a malformed language code falls back to detection, not to a bad code', async () => {
  // Passing junk through would make faster-whisper raise, failing every
  // partial in the session for a typo in an environment variable.
  await withEnv( { VOICE_STREAM_LANGUAGE: 'not a code' }, () => {
    assert.equal( defaultLanguage(), '' );
  } );
} );

test( 'a cancel during an in-flight final discards the result', async () => {
  // v13.19.2, acceptance criterion 4, the half that only appears under real
  // timing. A beam-5 decode takes seconds; a user who resumes speaking during
  // one cancels the utterance mid-decode. Emitting afterwards would deliver a
  // transcript the user explicitly discarded, AFTER the client had already
  // been told the cancel succeeded.
  //
  // runPartial always had this guard (`this.accepting`). finalise did not,
  // because when it was written a cancel closed the socket and nothing could
  // be delivered over it anyway. Keeping the socket alive across utterances
  // is what exposed it.
  const engine = stubEngine( { delayMs: 40 } );
  const { session, out } = makeSession( engine );

  for ( let i = 0; i < 5; i += 1 ) session.pushAudio( frame() );
  await settle( 10 );

  const pending = session.finalise();
  await settle( 5 );
  session.cancel();          // lands mid-decode
  const result = await pending;

  assert.equal( result, null, 'the discarded final must not resolve to a transcript' );
  assert.equal( out.finals.length, 0, 'and must not be delivered' );
} );

test( 'a cancel before finalise prevents it entirely', async () => {
  const engine = stubEngine();
  const { session, out } = makeSession( engine );

  for ( let i = 0; i < 5; i += 1 ) session.pushAudio( frame() );
  await settle( 10 );

  session.cancel();
  const result = await session.finalise();

  assert.equal( result, null );
  assert.equal( out.finals.length, 0 );
  assert.equal( engine.calls.filter( ( c ) => c.final ).length, 0,
    'a discarded utterance must not be transcribed at all' );
} );

test( 'a failed transcription ends the utterance, not the connection', () => {
  // v13.19.1, found by the smoke check rather than by reasoning. The final and
  // error paths both retire a session; only the final renewed it, so a single
  // transient engine failure left an armed socket permanently deaf -- every
  // later sentence refused, with no error to explain why.
  //
  // Asserted against the source because renewSession is internal to the socket
  // wiring and has no reachable seam. The shape IS the fix.
  const src = readFileSync(
    join( dirname( fileURLToPath( import.meta.url ) ), '..', 'voice',
          'voice-stream-server.js' ), 'utf8' );

  const onError = src.slice( src.indexOf( 'onError: ( e ) =>' ),
                             src.indexOf( 'onMetric:' ) );
  assert.match( onError, /renewSession\( ws \)/,
    'the error path must renew the session' );

  const onFinal = src.slice( src.indexOf( 'onFinal: ( f ) =>' ),
                             src.indexOf( 'onError:' ) );
  assert.match( onFinal, /renewSession\( ws \)/ );
  assert.doesNotMatch( onFinal, /closeSocket/,
    'a final must not close the socket the client armed early' );
} );

test( 'the reported configuration is the effective one', () => {
  const cfg = streamConfig();
  assert.equal( cfg.format, 's16le' );
  assert.equal( cfg.frame_samples, FRAME_SAMPLES );
  assert.equal( cfg.partial_beam, 1 );
  assert.equal( cfg.final_beam, 5 );
  assert.equal( cfg.path, '/voice/stream' );
  assert.equal( typeof cfg.language, 'string' );
} );
