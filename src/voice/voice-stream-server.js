// src/voice/voice-stream-server.js
//
// Tenax Voice -- the streaming transcription WebSocket endpoint.
// STREAM-WHISPER-v1.0.0 Sections 3, 5, 7, 8 and 9.
//
// ===========================================================================
// WHY A WEBSOCKET, AND WHY `ws`
// ===========================================================================
//
// Section 3 settles the transport: one persistent connection for a continuous
// stream, native partial events, no per-frame HTTP overhead.
//
// The library is `ws` (MIT) rather than a hand-rolled RFC 6455 implementation.
// Node ships a WebSocket CLIENT and no server, so the alternative is writing
// the handshake, the frame parser, the masking, fragmentation reassembly, the
// close handshake and the ping/pong keepalive by hand -- a security-relevant
// protocol implementation with a long history of parser bugs in exactly the
// places a hand-rolled version gets wrong.
//
// MIT also matters more here than it usually would. This connector runs a
// documented licence boundary between the MIT transcription stack and the
// GPL-3.0 synthesis stack (see stt-worker-supervisor.js). A copyleft transport
// dependency in the request path would be a new obligation on the whole
// service, so the licence was checked before the dependency was chosen.
//
// ===========================================================================
// AUTHENTICATION HAPPENS AT UPGRADE, AND NOWHERE ELSE
// ===========================================================================
//
// Section 7: "reject anonymous connections; the gateway's existing voice
// entitlement check applies at upgrade time."
//
// The upgrade is the only moment a WebSocket can be refused with an HTTP
// status the browser will surface. After it, the only tool left is a close
// frame, which arrives as a generic disconnection. So every check -- the
// feature flag, the transport credential, the identity headers, the voice
// entitlement, the session ceiling -- runs BEFORE the socket exists.
//
// The socket is not created and then closed on failure. It is never created.
// A refused upgrade allocates no session, no ring buffer and no worker slot,
// which is what makes the ceiling a real defence rather than a counter.
//
// ===========================================================================
// AUDIO IS TRANSIENT (Section 7)
// ===========================================================================
//
// Each partial writes its window to a private temporary directory, hands the
// path to the worker, and deletes the file in a finally block. The directory
// is created with mkdtemp under the OS temp root -- /dev/shm when the platform
// provides it, so a window of somebody's speech never reaches a physical disk.
//
// Nothing here logs audio, a sample value, or a transcript. The debug log
// carries durations and counts.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { StreamSession } from './voice-stream-session.js';
import { transcribeWindowViaWorker } from './stt-worker-supervisor.js';
import {
  STREAM_PATH, FRAME_BYTES,
  streamingEnabled, debugLogEnabled, defaultLanguage, idleTimeoutMs,
  maxSessions, streamConfig,
} from './voice-stream-config.js';

/**
 * Live sessions, keyed by socket.
 *
 * Module scope rather than per-server: there is one HTTP server in this
 * process, and the ceiling must count every session regardless of which
 * request created it.
 */
const sessions = new Map();

/** Set once attach() runs, so the health endpoint can report honestly. */
let attached = false;

/** The interval that reaps idle sessions. Held so tests can stop it. */
let reaper = null;

/**
 * Where transcription windows are staged.
 *
 * /dev/shm is a tmpfs on Linux, so a window never touches a disk. Falling back
 * to the OS temp directory rather than refusing: on a platform without
 * /dev/shm the feature should still work, and Section 7's requirement is that
 * audio is not PERSISTED, which a file deleted in a finally block satisfies
 * either way.
 *
 * @returns {string}
 */
function stageRoot() {
  if ( process.env.VOICE_STREAM_TMPDIR ) return process.env.VOICE_STREAM_TMPDIR;
  return existsSync( '/dev/shm' ) ? '/dev/shm' : tmpdir();
}

/**
 * Transcribe one window of samples through the resident worker.
 *
 * The adaptor between the session, which holds samples in memory and knows
 * nothing about processes, and the worker, whose protocol takes a path.
 *
 * @param {{samples: Int16Array, beam: number, condition: boolean,
 *          language: string, model: string}} req
 * @returns {Promise<object>}
 */
async function transcribeWindow( req ) {
  const dir = await mkdtemp( join( stageRoot(), 'tenax-stream-' ) );
  const path = join( dir, 'window.pcm' );

  try {
    // Int16Array -> bytes without copying the samples again. The underlying
    // buffer is already exactly the little-endian layout the worker reads.
    await writeFile( path, Buffer.from( req.samples.buffer,
                                        req.samples.byteOffset,
                                        req.samples.byteLength ) );

    return await transcribeWindowViaWorker( {
      path,
      model: req.model || process.env.VOICE_STT_MODEL || 'base',
      modelDir: process.env.VOICE_MODEL_DIR || '/data/voice/models',
      // v13.19.1. Pinned rather than detected: language ID is a separate
      // forward pass, and on a six-second window starting and ending mid-speech
      // it is both slow and unreliable. defaultLanguage() returns '' only when
      // an operator has explicitly opted back into detection.
      language: ( req.language || defaultLanguage() ) || undefined,
      beam: req.beam,
      condition: req.condition,
      // Silence trimming is wrong for a rolling window; see the worker.
      vadFilter: !! req.final,
    } );
  } finally {
    // Section 7. In a finally so a failed transcription cannot leave a window
    // of speech on the filesystem, which is the case where it would linger
    // longest because nothing is watching.
    await rm( dir, { recursive: true, force: true } ).catch( () => {} );
  }
}

/**
 * Send a JSON control frame, tolerating a socket that has already gone.
 *
 * A closed socket is the normal end of every session, and it can close between
 * the check and the send. Throwing there would turn an ordinary disconnection
 * into an unhandled rejection inside a transcription callback.
 *
 * @param {object} ws
 * @param {object} payload
 * @returns {void}
 */
function send( ws, payload ) {
  try {
    if ( 1 !== ws.readyState ) return; // 1 === OPEN
    ws.send( JSON.stringify( payload ) );
  } catch ( err ) {
    // Deliberately swallowed. See above.
  }
}

/**
 * Anonymised diagnostics. Never audio, never a transcript. Section 7.
 *
 * @param {string} message
 * @returns {void}
 */
function debugLog( message ) {
  if ( ! debugLogEnabled() ) return;
  console.log( `[voice-stream] ${ message }` );
}

/**
 * Refuse an upgrade with an HTTP response.
 *
 * ── Why the status is written by hand ────────────────────────────────────
 *
 * An upgrade request has no Express response object; it arrives on the raw
 * socket before any router sees it. This is the one moment a WebSocket client
 * can be told WHY it was refused in a form the browser reports, so the reason
 * is spelled out rather than collapsed into a silent socket destroy.
 *
 * @param {object} socket
 * @param {number} status
 * @param {string} reason
 * @returns {void}
 */
function refuse( socket, status, reason ) {
  const text = `HTTP/1.1 ${ status } ${ reason }\r\n`
    + 'Connection: close\r\n'
    + 'Content-Length: 0\r\n'
    + `X-Tenax-Voice-Stream: ${ reason }\r\n\r\n`;
  try {
    socket.write( text );
  } catch ( err ) {
    // The peer went away mid-refusal. Nothing further to do.
  }
  try { socket.destroy(); } catch ( err ) { /* already destroyed */ }
}

/**
 * Attach the streaming endpoint to an HTTP server.
 *
 * ── Why this is called conditionally ─────────────────────────────────────
 *
 * Section 9 requires that with the flag off the pipeline reverts "with zero
 * code-path changes". A route that exists and refuses is still a code path: it
 * can throw, it can leak a socket, it changes what an upgrade to an unknown
 * path does. So with the flag off nothing is attached at all, and an upgrade
 * gets whatever the server already did with one.
 *
 * @param {object} httpServer A node:http Server.
 * @param {object} deps
 * @param {Function} deps.authenticate  (req) => Promise<{ok, status?, reason?,
 *        userId?, tenantId?}>  Runs before the socket exists.
 * @param {Function} [deps.WebSocketServer] Injected for tests.
 * @returns {boolean} Whether the endpoint was attached.
 */
export async function attachVoiceStream( httpServer, deps ) {
  const d = deps || {};

  if ( ! streamingEnabled() ) {
    console.log( '[voice-stream] VOICE_STREAMING_ENABLED is off; '
      + 'the streaming endpoint is not attached' );
    return false;
  }

  let WSS = d.WebSocketServer;
  if ( ! WSS ) {
    try {
      ( { WebSocketServer: WSS } = await import( 'ws' ) );
    } catch ( err ) {
      // A missing optional dependency must not stop the connector booting. The
      // non-streaming path is untouched and still serves every user; what is
      // lost is a flagged-off feature, and saying so precisely is more useful
      // than a stack trace at startup.
      console.error( '[voice-stream] the `ws` package is not installed, so '
        + 'streaming transcription is unavailable. Run `npm install` on the '
        + 'connector, or set VOICE_STREAMING_ENABLED=false to silence this.' );
      return false;
    }
  }

  // noServer: the upgrade is handled here so authentication can refuse it
  // BEFORE a socket exists. `new WebSocketServer({ server })` would complete
  // the handshake first and leave only a close frame to refuse with.
  const wss = new WSS( { noServer: true, maxPayload: 4 * FRAME_BYTES * 25 } );

  httpServer.on( 'upgrade', async ( req, socket, head ) => {
    let url;
    try {
      url = new URL( req.url, 'http://localhost' );
    } catch ( err ) {
      refuse( socket, 400, 'bad_request' );
      return;
    }

    // Not our path. Left entirely alone: another upgrade handler may own it,
    // and destroying the socket here would break it.
    if ( url.pathname !== STREAM_PATH ) return;

    if ( sessions.size >= maxSessions() ) {
      debugLog( `upgrade refused: ${ sessions.size } sessions already open` );
      refuse( socket, 503, 'too_many_sessions' );
      return;
    }

    let auth;
    try {
      auth = await d.authenticate( req );
    } catch ( err ) {
      // An authenticator that threw has not said yes. Treated as a refusal
      // rather than allowed through, and reported as ours rather than theirs.
      console.error( `[voice-stream] upgrade auth failed: ${ err.message }` );
      refuse( socket, 500, 'auth_error' );
      return;
    }

    if ( ! auth || ! auth.ok ) {
      refuse( socket, ( auth && auth.status ) || 401,
              ( auth && auth.reason ) || 'unauthorised' );
      return;
    }

    wss.handleUpgrade( req, socket, head, ( ws ) => {
      openSession( ws, {
        userId: auth.userId || '',
        tenantId: auth.tenantId || '',
        language: url.searchParams.get( 'language' ) || '',
        model: url.searchParams.get( 'model' ) || '',
      } );
    } );
  } );

  if ( ! reaper ) {
    reaper = setInterval( reapIdle, 5000 );
    // The reaper must never be the reason the process stays alive.
    if ( 'function' === typeof reaper.unref ) reaper.unref();
  }

  attached = true;
  console.log( `[voice-stream] streaming transcription attached at ${ STREAM_PATH }` );
  return true;
}

/**
 * Wire one authenticated socket to a session.
 *
 * @param {object} ws
 * @param {{userId: string, tenantId: string, language: string, model: string}} ctx
 * @returns {object} The session.
 */
function openSession( ws, ctx ) {
  const id = randomUUID().slice( 0, 8 );
  const session = buildSession( ws, ctx, id );
  sessions.set( ws, { session, ctx, id } );
  debugLog( `session ${ id } open (${ sessions.size } live)` );

  send( ws, {
    type: 'ready',
    session: id,
    // Echoed so the client can assert the geometry it is about to stream into
    // rather than assume it. A browser sending 20 ms frames into a server
    // expecting 40 ms is not an error anywhere; it is just worse.
    frame_bytes: FRAME_BYTES,
    sample_rate: streamConfig().sample_rate,
    format: 's16le',
    language: streamConfig().language,
  } );

  ws.on( 'message', ( data, isBinary ) => {
    const record = sessions.get( ws );
    if ( ! record ) return;

    if ( isBinary ) {
      record.session.pushAudio( data );
      return;
    }

    let msg;
    try {
      msg = JSON.parse( String( data ) );
    } catch ( err ) {
      send( ws, { type: 'error', code: 'bad_control',
                  message: 'Control frames must be JSON.' } );
      return;
    }

    handleControl( ws, record.session, msg );
  } );

  ws.on( 'close', () => {
    // Section 7 and acceptance criterion 4. A socket that closed without
    // finalising is a user who walked away or a connection that dropped, and
    // neither should produce a message. Cancel releases the buffers without
    // transcribing.
    const record = sessions.get( ws );
    if ( record && ! record.session.closed ) record.session.cancel();
    sessions.delete( ws );
    debugLog( `session ${ id } closed (${ sessions.size } live)` );
  } );

  ws.on( 'error', ( err ) => {
    debugLog( `session ${ id } socket error: ${ err.message }` );
    const record = sessions.get( ws );
    if ( record && ! record.session.closed ) record.session.cancel();
    sessions.delete( ws );
  } );

  return session;
}

/**
 * Build one utterance's session, wired to this socket.
 *
 * ── Why a factory, and why the socket outlives the session ───────────────
 *
 * v13.19.1. Until now a final closed the socket, so every utterance paid for a
 * TCP connection, a TLS handshake, an HTTP upgrade and an authorisation query.
 * That was affordable while the browser opened its microphone on speech onset
 * anyway -- the handshake hid inside a delay that was already too long.
 *
 * The client now arms the whole pipeline BEFORE the user speaks, which only
 * helps if the connection survives the first sentence. So the socket is
 * long-lived and the session is per-utterance: on a final or a cancel the
 * session object is replaced rather than resurrected.
 *
 * Replaced, specifically, rather than reset. StreamSession's states are
 * terminal by design -- `closed` means the buffers are gone and nothing can
 * deliver a transcript -- and adding a path back out of a terminal state would
 * put the guarantee behind acceptance criterion 4 at risk to save one
 * allocation per sentence.
 *
 * @param {object} ws
 * @param {object} ctx
 * @param {string} id
 * @returns {StreamSession}
 */
function buildSession( ws, ctx, id ) {
  return new StreamSession( {
    id,
    transcribe: transcribeWindow,
    language: ctx.language,
    model: ctx.model,
    onPartial: ( p ) => send( ws, { type: 'partial', text: p.text, seq: p.seq } ),
    onFinal: ( f ) => {
      send( ws, {
        type: 'final',
        text: f.text,
        language: f.language,
        duration_seconds: f.duration_seconds,
        segments: f.segments,
        reason: f.reason,
      } );
      // v13.19.1. The SESSION is spent; the SOCKET is not. Closing here would
      // make every sentence after the first pay for a new TCP connection, TLS
      // handshake, HTTP upgrade and authorisation query -- the exact cost the
      // client now arms early to avoid.
      renewSession( ws );
    },
    onError: ( e ) => {
      send( ws, { type: 'error', code: e.code, message: e.message } );
      // v13.19.1. A failed transcription ends the UTTERANCE, not the
      // connection. Without this the session stays terminal and every
      // subsequent sentence on an armed socket is silently refused -- one
      // transient engine failure would deaden the microphone for the rest of
      // the listening session, with no error to explain it.
      renewSession( ws );
    },
    onMetric: ( m ) => {
      if ( ! debugLogEnabled() ) return;
      // Section 7: latency and drop rate, never raw audio.
      console.log( `[voice-stream] metric session=${ id } `
        + Object.entries( m ).map( ( [ k, v ] ) => `${ k }=${ v }` ).join( ' ' ) );
    },
  } );
}

/**
 * Replace a spent session with a fresh one, keeping the socket.
 *
 * @param {object} ws
 * @returns {void}
 */
function renewSession( ws ) {
  const record = sessions.get( ws );
  if ( ! record ) return;   // the socket closed while a final was in flight
  record.session = buildSession( ws, record.ctx, record.id );
}

/**
 * Handle one JSON control frame.
 *
 * @param {object} ws
 * @param {StreamSession} session
 * @param {object} msg
 * @returns {void}
 */
function handleControl( ws, session, msg ) {
  const type = String( ( msg && msg.type ) || '' );

  if ( 'finalise' === type || 'finalize' === type ) {
    // Section 5: the VAD endpoint fires this. Fire-and-forget because the
    // result is delivered through onFinal, and awaiting here would block the
    // socket's message loop against a beam-5 transcription.
    void session.finalise( { reason: 'endpoint' } );
    return;
  }

  if ( 'cancel' === type ) {
    // Acceptance criterion 4: the partial is discarded and no message appears
    // anywhere. No final is emitted, and nothing is transcribed.
    session.cancel();
    send( ws, { type: 'cancelled' } );
    // Renewed, not closed. A cancel is usually the user pausing or the VAD
    // retracting a false start, and both are followed by more speech on the
    // same armed connection.
    renewSession( ws );
    return;
  }

  if ( 'close' === type ) {
    // Explicit teardown, for a client releasing the microphone. Distinct from
    // `cancel`, which discards an utterance and keeps the connection armed.
    session.cancel();
    closeSocket( ws, 1000, 'client_closed' );
    return;
  }

  if ( 'ping' === type ) {
    // An application-level keepalive, distinct from the protocol ping. A
    // mobile browser that has been throttled sends this on resume to learn
    // whether the session survived; the protocol ping is answered by the
    // socket layer and tells the PAGE nothing.
    send( ws, { type: 'pong', state: session.state } );
    return;
  }

  send( ws, { type: 'error', code: 'unknown_control',
              message: `Unrecognised control message: ${ type || '(none)' }` } );
}

/**
 * Close a socket without letting a dead one throw.
 *
 * @param {object} ws
 * @param {number} code
 * @param {string} reason
 * @returns {void}
 */
function closeSocket( ws, code, reason ) {
  try { ws.close( code, reason ); } catch ( err ) { /* already closing */ }
}

/**
 * Close sessions that have gone quiet.
 *
 * A closed tab, a killed process and a phone that locked all stop sending
 * without sending a close frame. Without this their buffers stay resident
 * until TCP notices, which can be minutes -- and acceptance criterion 7 asks
 * specifically that a backgrounded tab simply stops.
 *
 * @returns {void}
 */
export function reapIdle() {
  const now = Date.now();
  const limit = idleTimeoutMs();

  for ( const [ ws, record ] of sessions ) {
    if ( ! record.session.isIdle( now, limit ) ) continue;
    debugLog( `session ${ record.id } idle for ${ limit }ms; closing` );
    if ( ! record.session.closed ) record.session.cancel();
    sessions.delete( ws );
    closeSocket( ws, 1001, 'idle' );
  }
}

/**
 * Streaming state for /voice/health.
 *
 * Reports the EFFECTIVE configuration rather than the raw environment, so a
 * setting that was rejected for being out of bounds is visible as the default
 * it fell back to.
 *
 * @returns {object}
 */
export function streamHealth() {
  return {
    attached,
    sessions: sessions.size,
    config: streamConfig(),
    live: Array.from( sessions.values() ).map( ( r ) => r.session.snapshot() ),
  };
}

/** Close every session. For shutdown and for tests. */
export function stopVoiceStream() {
  for ( const [ ws, record ] of sessions ) {
    if ( ! record.session.closed ) record.session.cancel();
    closeSocket( ws, 1001, 'shutdown' );
  }
  sessions.clear();
  if ( reaper ) { clearInterval( reaper ); reaper = null; }
  attached = false;
}

/** Test seam: the live session map. */
export function __sessions() { return sessions; }

export default {
  attachVoiceStream, streamHealth, stopVoiceStream, reapIdle,
  transcribeWindow,
};
