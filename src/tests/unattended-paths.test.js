// src/tests/unattended-paths.test.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01 H-5, connector half: the fail-closed default for
// unattended paths.
//
//   C-UNATT-ENUMERATED          every unattended path is listed with its default;
//                               the list is compared with a scan of src/ in BOTH
//                               directions
//   C-UNATT-CLASS-RECORDED      policy/observer class recorded per surface, the
//                               defaults follow from the class, and every
//                               destructive surface names the test that holds it
//   C-UNATT-FAIL-CLOSED         scheduled work: a late send is held, never sent
//                               late; overlapping ticks never send twice; a send
//                               cancelled mid-tick is not sent
//   C-UNATT-TIMEOUT-NOT-REFUSAL a hold nobody answers times out, the send is
//                               denied, and the timeout is not counted as a
//                               refusal
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsFiles, findCalls, readBlanked } from './helpers/source-scan.js';
import { UNATTENDED_PATHS, BOUNDED_TIMERS, TEST_SITES } from '../utils/unattendedPaths.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const SRC = join( HERE, '..' );
const REPO = join( SRC, '..' );

// The scheduler persists to config.scheduleStorePath, read once at import.
const STORE_DIR = mkdtempSync( join( tmpdir(), 'h5-sched-' ) );
process.env.SCHEDULE_STORE_PATH = join( STORE_DIR, 'schedule_store.json' );
process.env.SCHEDULE_ENABLED = 'true';
delete process.env.SCHEDULE_LATE_GRACE_MINUTES;
delete process.env.SCHEDULE_HOLD_EXPIRY_DAYS;
const S = await import( '../utils/scheduler.js' );
const ES = await import( '../tools/emailSchedule.js' );

const MIN = 60000;
const DAY = 86400000;

// ── The derived enumeration ─────────────────────────────────────────────────

/** Every timer, cron schedule and process handler in src/, as the walk reads it. */
function scanSites() {
  const files = jsFiles( SRC, [ '.' ], ( r ) => ! r.startsWith( 'tests/' ) && ! r.endsWith( '.test.js' ) );
  const re = /(?<![.\w$])(setInterval|setTimeout|setImmediate)\s*\(|\b(cron\.schedule)\s*\(|\b(process\.(?:on|once))\s*\(/g;
  return findCalls( SRC, files, re ).map( ( h ) => {
    let event;
    if ( h.callee.startsWith( 'process.' ) ) {
      // blank() empties string literals, so the event name is read from the raw source.
      const raw = readFileSync( join( SRC, h.file ), 'utf8' ).slice( h.index );
      const m = /^process\.(?:on|once)\s*\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/.exec( raw );
      event = m ? ( m[ 2 ] || '(signal variable)' ) : '(unreadable)';
    }
    return { file: h.file, callee: h.callee, anchor: h.anchor, event };
  } );
}

const keyOf = ( s ) => [ s.file, s.callee, s.anchor, s.event || '' ].join( ' | ' );

describe( 'C-UNATT-ENUMERATED: the registry is the scan', () => {
  const scanned = scanSites();

  test( 'the scan is not vacuous: it finds the scheduler, the TTL worker and the shutdown handlers', () => {
    const keys = new Set( scanned.map( keyOf ) );
    for ( const k of [ 'utils/scheduler.js | cron.schedule | startScheduler | ', 'tools-memory/ttlExpiry.js | setInterval | startTtlWorker | ', 'utils/serviceRuntime.js | process.on | installShutdownHandlers | SIGTERM' ] ) {
      assert.ok( keys.has( k ), k );
    }
  } );

  test( 'every scanned site is classified (scan -> registry)', () => {
    const listed = new Set( [
      ...UNATTENDED_PATHS.map( keyOf ),
      ...BOUNDED_TIMERS.map( keyOf ),
    ] );
    const missing = scanned.filter( ( s ) => ! TEST_SITES.includes( s.file ) && ! listed.has( keyOf( s ) ) ).map( keyOf );
    assert.deepEqual( missing, [], 'a timer, cron schedule or process handler with no stated default' );
  } );

  test( 'every registry entry still exists at source (registry -> scan)', () => {
    const found = new Set( scanned.map( keyOf ) );
    const gone = [ ...UNATTENDED_PATHS, ...BOUNDED_TIMERS ].map( keyOf ).filter( ( k ) => ! found.has( k ) );
    assert.deepEqual( gone, [], 'an entry whose site has gone' );
    for ( const f of TEST_SITES ) assert.ok( scanned.some( ( s ) => s.file === f ), `test site ${ f } still has timers` );
  } );
} );

describe( 'C-UNATT-CLASS-RECORDED: class, default and evidence per surface', () => {
  test( 'ids are unique and every field is from its closed set', () => {
    const ids = UNATTENDED_PATHS.map( ( p ) => p.id );
    assert.equal( new Set( ids ).size, ids.length );
    for ( const p of UNATTENDED_PATHS ) {
      assert.ok( [ 'policy', 'observer' ].includes( p.cls ), `${ p.id }: class` );
      assert.ok( [ 'fail_closed', 'fail_open' ].includes( p.default ), `${ p.id }: default` );
      assert.equal( typeof p.destructive, 'boolean', `${ p.id }: destructive` );
      assert.ok( p.statement.length > 40, `${ p.id }: the default is stated in words` );
    }
  } );

  test( 'the default follows from the class: policy fails closed, observer fails open, and a destructive surface is policy', () => {
    for ( const p of UNATTENDED_PATHS ) {
      assert.equal( p.default, p.cls === 'policy' ? 'fail_closed' : 'fail_open', p.id );
      if ( p.destructive ) assert.equal( p.cls, 'policy', `${ p.id }: destructive surfaces are policy-class` );
    }
  } );

  test( 'every destructive surface names the test that holds its default, and that test exists', () => {
    for ( const p of UNATTENDED_PATHS.filter( ( x ) => x.destructive ) ) {
      assert.ok( Array.isArray( p.tests ) && p.tests.length, `${ p.id }: names its tests` );
      for ( const t of p.tests ) assert.ok( existsSync( join( REPO, t ) ), `${ p.id }: ${ t } exists` );
    }
  } );

  test( 'the scheduler surfaces are recorded as destructive policy (the class the behaviour below holds)', () => {
    for ( const id of [ 'scheduler.tick', 'scheduler.boot_catchup' ] ) {
      const p = UNATTENDED_PATHS.find( ( x ) => x.id === id );
      assert.deepEqual( [ p.cls, p.destructive, p.default ], [ 'policy', true, 'fail_closed' ], id );
    }
    const obs = UNATTENDED_PATHS.find( ( x ) => x.id === 'tracking.append_loop' );
    assert.deepEqual( [ obs.cls, obs.default ], [ 'observer', 'fail_open' ] );
  } );
} );

// ── Scheduled work: observed behaviour matches the statement ────────────────

function pending( id, sendAtMs, extra = {} ) {
  return {
    schedule_id: id, schedule_type: extra.sequence_id ? 'drip' : 'deferred', status: 'pending',
    created_at: new Date( sendAtMs - DAY ).toISOString(), sender_id: 'brian',
    to_address: `${ id }@example.com`, to_name: '', subject: `subject ${ id }`, body_text: 'hello',
    format: 'text', send_at: new Date( sendAtMs ).toISOString(), tracking_id: null, sent_at: null,
    cancelled_at: null, company: 'Acme', sequence_id: null, step_number: null, error_code: null, ...extra,
  };
}

function recordingSend() {
  const sent = [];
  const fn = async ( msg ) => {
    sent.push( msg.schedule_id );
    return { status: 'sent', timestamp: new Date().toISOString(), tracking_id: `t-${ msg.schedule_id }` };
  };
  return { sent, fn };
}

const statusOf = ( id ) => S.listSchedules( { status: 'all', since_days: 0 } ).schedules.find( ( s ) => s.schedule_id === id );

describe( 'C-UNATT-FAIL-CLOSED: the scheduled-send path', () => {
  after( () => rmSync( STORE_DIR, { recursive: true, force: true } ) );
  beforeEach( () => S._setStoreForTests( {} ) );

  test( 'a send that falls due inside the late grace is sent', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_001', now - 5 * MIN ) ] } );
    const { sent, fn } = recordingSend();
    const r = await S.checkAndFireDueSchedules( { send: fn, nowMs: now } );
    assert.deepEqual( sent, [ 'sch_001' ] );
    assert.equal( r.sent, 1 );
    assert.equal( statusOf( 'sch_001' ).status, 'sent' );
  } );

  test( 'a send past the late grace is held for a person, never sent late (the boot catch-up case)', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_002', now - 3 * 60 * MIN ) ] } );
    const { sent, fn } = recordingSend();
    const r = await S.checkAndFireDueSchedules( { send: fn, nowMs: now } );
    assert.deepEqual( sent, [], 'nothing sent' );
    assert.equal( r.held, 1 );
    const s = statusOf( 'sch_002' );
    assert.equal( s.status, 'held_overdue' );
    assert.match( s.held_reason, /180 minutes ago, beyond the 60-minute late grace/ );
    assert.ok( s.held_at );
  } );

  test( 'the late grace is an operator setting with a bounded range', () => {
    try {
      process.env.SCHEDULE_LATE_GRACE_MINUTES = '15';
      assert.equal( S.lateGraceMs(), 15 * MIN );
      process.env.SCHEDULE_LATE_GRACE_MINUTES = '0';
      assert.equal( S.lateGraceMs(), MIN, 'clamped to at least one minute' );
      process.env.SCHEDULE_LATE_GRACE_MINUTES = 'nonsense';
      assert.equal( S.lateGraceMs(), 60 * MIN, 'default' );
    } finally {
      delete process.env.SCHEDULE_LATE_GRACE_MINUTES;
    }
  } );

  test( 'the boot catch-up runs the same tick, so it obeys the same hold', () => {
    const { code } = readBlanked( SRC, 'utils/scheduler.js' );
    const start = code.indexOf( 'function startScheduler' );
    const body = code.slice( start, code.indexOf( '\n}\n', start ) );
    const timer = body.indexOf( 'setTimeout(' );
    assert.ok( timer > 0, 'startScheduler arms a boot-time timer' );
    assert.match( body.slice( timer, timer + 200 ), /checkAndFireDueSchedules\(\)/, 'the boot timer calls the guarded tick, not a send directly' );
    assert.doesNotMatch( body, /sendEmailInternal|fireDue\(/, 'no path around the tick' );
  } );

  test( 'overlapping ticks never dispatch the same send twice', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_003', now - MIN ) ] } );
    let release;
    const gate = new Promise( ( r ) => { release = r; } );
    const sent = [];
    const slowSend = async ( msg ) => { sent.push( msg.schedule_id ); await gate; return { status: 'sent', timestamp: 'x', tracking_id: 't' }; };
    const first = S.checkAndFireDueSchedules( { send: slowSend, nowMs: now } );
    // Started while the first is still dispatching; released only afterwards,
    // so a tick that did NOT stand aside would also reach the send.
    const secondP = S.checkAndFireDueSchedules( { send: slowSend, nowMs: now } );
    await new Promise( ( r ) => setImmediate( r ) );
    release();
    const [ , second ] = await Promise.all( [ first, secondP ] );
    assert.deepEqual( second, { ran: false, reason: 'tick_in_flight' } );
    const third = await S.checkAndFireDueSchedules( { send: slowSend, nowMs: now + MIN } );
    assert.equal( third.sent, 0 );
    assert.deepEqual( sent, [ 'sch_003' ] );
  } );

  test( 'a send cancelled while an earlier send in the same tick is in flight is not dispatched', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_004', now - 2 * MIN ), pending( 'sch_005', now - MIN ) ] } );
    const sent = [];
    const send = async ( msg ) => {
      sent.push( msg.schedule_id );
      if ( msg.schedule_id === 'sch_004' ) S.cancelSchedule( { schedule_id: 'sch_005' } );
      return { status: 'sent', timestamp: 'x', tracking_id: 't' };
    };
    await S.checkAndFireDueSchedules( { send, nowMs: now } );
    assert.deepEqual( sent, [ 'sch_004' ] );
    assert.equal( statusOf( 'sch_005' ).status, 'cancelled' );
  } );

  test( 'a person can release a held send; it goes on the next tick, and only a held send can be released', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_006', now - 5 * 60 * MIN ), pending( 'sch_007', Date.now() + 30 * DAY ) ] } );
    const { sent, fn } = recordingSend();
    await S.checkAndFireDueSchedules( { send: fn, nowMs: now } );
    assert.equal( statusOf( 'sch_006' ).status, 'held_overdue' );
    const rel = JSON.parse( ( await ES.handleEmailScheduleRelease( { schedule_id: 'sch_006', released_by: 'brian' } ) ).content[ 0 ].text );
    assert.equal( rel.status, 'released' );
    await S.checkAndFireDueSchedules( { send: fn, nowMs: Date.now() + MIN } );
    assert.deepEqual( sent, [ 'sch_006' ] );
    const notHeld = await ES.handleEmailScheduleRelease( { schedule_id: 'sch_007' } );
    assert.equal( notHeld.isError, true );
    assert.match( notHeld.content[ 0 ].text, /Only a held send can be released/ );
  } );

  test( 'cancelling a sequence cancels its held steps too', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    const step = pending( 'sch_008', now - 5 * 60 * MIN, { sequence_id: 'seq_001', step_number: 1 } );
    S._setStoreForTests( { schedules: [ step ], sequences: [ { sequence_id: 'seq_001', status: 'active', steps: [ { step_number: 1, schedule_id: 'sch_008', status: 'pending' } ] } ] } );
    await S.checkAndFireDueSchedules( { send: recordingSend().fn, nowMs: now } );
    assert.equal( statusOf( 'sch_008' ).status, 'held_overdue' );
    const r = S.cancelSchedule( { sequence_id: 'seq_001' } );
    assert.equal( r.cancelled_steps, 1 );
    assert.equal( statusOf( 'sch_008' ).status, 'cancelled' );
  } );
} );

describe( 'C-UNATT-TIMEOUT-NOT-REFUSAL: an unanswered hold', () => {
  beforeEach( () => S._setStoreForTests( {} ) );

  test( 'times out after the hold expiry: the send is denied, recorded expired, and not counted as a refusal', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_010', now - 5 * 60 * MIN ), pending( 'sch_011', now + 60 * MIN ) ] } );
    const { sent, fn } = recordingSend();
    await S.checkAndFireDueSchedules( { send: fn, nowMs: now } );
    S.cancelSchedule( { schedule_id: 'sch_011' } );
    // Still held the day before expiry.
    await S.checkAndFireDueSchedules( { send: fn, nowMs: now + 6 * DAY } );
    assert.equal( statusOf( 'sch_010' ).status, 'held_overdue' );
    await S.checkAndFireDueSchedules( { send: fn, nowMs: now + 7 * DAY + MIN } );
    assert.deepEqual( sent, [], 'the timeout denies' );
    const s = statusOf( 'sch_010' );
    assert.equal( s.status, 'expired_unconfirmed' );
    assert.ok( s.expired_at );
    const out = S.scheduleOutcomes();
    assert.equal( out.refusals, 1, 'only the person\'s cancellation is a refusal' );
    assert.equal( out.expired, 1, 'the timeout is reported as expired' );
    assert.deepEqual( S.REFUSAL_STATUSES, [ 'cancelled' ] );
  } );

  test( 'an expired hold cannot be turned into a refusal or released; asking again is a fresh schedule', async () => {
    const now = Date.parse( '2026-10-15T10:00:00Z' );
    S._setStoreForTests( { schedules: [ pending( 'sch_012', now - 5 * 60 * MIN ) ] } );
    await S.checkAndFireDueSchedules( { send: recordingSend().fn, nowMs: now } );
    await S.checkAndFireDueSchedules( { send: recordingSend().fn, nowMs: now + 8 * DAY } );
    const c = S.cancelSchedule( { schedule_id: 'sch_012' } );
    assert.equal( c.code, 'INVALID_STATE' );
    assert.equal( statusOf( 'sch_012' ).status, 'expired_unconfirmed' );
    assert.equal( S.scheduleOutcomes().refusals, 0 );
    const r = S.releaseHeldSchedule( { schedule_id: 'sch_012' } );
    assert.equal( r.code, 'INVALID_STATE' );
    assert.match( r.error, /expired and the send was denied\. Schedule it again/ );
  } );
} );
