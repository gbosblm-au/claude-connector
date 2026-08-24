// Manual end-to-end check for the streaming socket.
// Not part of the shipped test suite: it needs `ws` installed and binds a port,
// which the unit suite deliberately does not.
//
// Run:  node scripts/voice-stream-smoke.mjs

import { createServer } from 'node:http';
import { WebSocket } from 'ws';

process.env.VOICE_STREAMING_ENABLED = 'true';
process.env.VOICE_ENABLED = 'true';
process.env.MCP_API_KEY = 'smoke-key-0123456789';
process.env.VOICE_TEST_USERS = 'user-1';
process.env.VOICE_STREAM_DEBUG_LOG = 'true';

const { attachVoiceStream, stopVoiceStream, streamHealth } =
  await import( '../src/voice/voice-stream-server.js' );
const { authenticateUpgrade } = await import( '../src/voice/voice-stream-auth.js' );
const { FRAME_BYTES } = await import( '../src/voice/voice-stream-config.js' );

// A stub engine, so this exercises the transport and the session rather than
// downloading a Whisper model.
const server = await import( '../src/voice/voice-stream-server.js' );
const results = [];

const httpServer = createServer( ( req, res ) => res.end( 'ok' ) );
const ok = await attachVoiceStream( httpServer, { authenticate: authenticateUpgrade } );
console.log( 'attached:', ok );

await new Promise( ( r ) => httpServer.listen( 0, '127.0.0.1', r ) );
const port = httpServer.address().port;

function connect( headers ) {
  return new WebSocket( `ws://127.0.0.1:${ port }/voice/stream?language=en`, { headers } );
}

// ── 1. anonymous upgrade is refused ────────────────────────────────────────
await new Promise( ( resolve ) => {
  const ws = connect( {} );
  ws.on( 'unexpected-response', ( _req, res ) => {
    results.push( [ 'anonymous refused', 401 === res.statusCode, res.statusCode ] );
    resolve();
  } );
  ws.on( 'open', () => { results.push( [ 'anonymous refused', false, 'opened' ] ); resolve(); } );
  ws.on( 'error', () => resolve() );
} );

// ── 2. credential without identity is refused ──────────────────────────────
await new Promise( ( resolve ) => {
  const ws = connect( { authorization: 'Bearer smoke-key-0123456789' } );
  ws.on( 'unexpected-response', ( _req, res ) => {
    results.push( [ 'no identity refused', 401 === res.statusCode, res.statusCode ] );
    resolve();
  } );
  ws.on( 'open', () => { results.push( [ 'no identity refused', false, 'opened' ] ); resolve(); } );
  ws.on( 'error', () => resolve() );
} );

// ── 3. non-entitled user is refused with 403 ───────────────────────────────
await new Promise( ( resolve ) => {
  const ws = connect( { authorization: 'Bearer smoke-key-0123456789',
                        'x-tenax-user-id': 'somebody-else' } );
  ws.on( 'unexpected-response', ( _req, res ) => {
    results.push( [ 'not entitled refused', 403 === res.statusCode, res.statusCode ] );
    resolve();
  } );
  ws.on( 'open', () => { results.push( [ 'not entitled refused', false, 'opened' ] ); resolve(); } );
  ws.on( 'error', () => resolve() );
} );

// ── 4. entitled user streams TWO utterances on ONE socket ─────────────────
//
// v13.19.1. The client now arms the pipeline before the user speaks, which is
// only worth anything if the connection survives the first sentence. A socket
// that closed on `final` would put the whole handshake back on the critical
// path for every sentence after the first.
await new Promise( ( resolve ) => {
  const ws = connect( { authorization: 'Bearer smoke-key-0123456789',
                        'x-tenax-user-id': 'user-1' } );
  const seen = [];
  let terminals = 0;

  const speak = () => {
    for ( let i = 0; i < 40; i += 1 ) {
      const buf = Buffer.alloc( FRAME_BYTES );
      buf.writeInt16LE( 800, 0 );
      ws.send( buf );
    }
    setTimeout( () => ws.send( JSON.stringify( { type: 'finalise' } ) ), 150 );
  };

  ws.on( 'open', speak );

  ws.on( 'message', ( raw ) => {
    const msg = JSON.parse( String( raw ) );
    seen.push( msg.type );

    if ( 'final' === msg.type || 'error' === msg.type ) {
      terminals += 1;
      if ( 1 === terminals ) {
        // The socket must still be open, and a second utterance must work on it.
        results.push( [ 'socket survives the first utterance',
                        1 === ws.readyState, `readyState=${ ws.readyState }` ] );
        setTimeout( speak, 50 );
        return;
      }
      results.push( [ 'a second utterance completes on the same socket',
                      2 === terminals, seen.join( ',' ) ] );
      ws.close();
      resolve();
    }
  } );

  ws.on( 'error', ( err ) => {
    results.push( [ 'two utterances, one socket', false, err.message ] );
    resolve();
  } );

  setTimeout( () => {
    results.push( [ 'two utterances, one socket', false,
                    `timed out; saw ${ seen.join( ',' ) }` ] );
    resolve();
  }, 12000 );
} );

console.log( '\nhealth:', JSON.stringify( streamHealth().config ) );
console.log( '' );
let failed = 0;
for ( const [ name, pass, detail ] of results ) {
  if ( ! pass ) failed += 1;
  console.log( `${ pass ? 'PASS' : 'FAIL' }  ${ name }  (${ detail })` );
}

stopVoiceStream();
httpServer.close();
process.exit( failed ? 1 : 0 );
