// src/utils/unattendedPaths.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-5, TENAX-2026-10-15-01: the fail-closed default for unattended paths,
// stated per surface.
//
// An unattended path runs with no human present to answer: a timer, a cron
// tick, a boot-time catch-up, a process signal handler. Every such site in
// src/ is listed below with its class and its stated default:
//
//   class 'policy'    decides something (sends, deletes, exits). Destructive or
//                     irreversible actions FAIL CLOSED: when the condition the
//                     human relied on cannot be confirmed, the action is not
//                     taken.
//   class 'observer'  records or reports (telemetry, health pings, derived
//                     artefacts). FAILS OPEN: its failure is logged and never
//                     stops or delays the work it observes.
//
// The list is not trusted on its own. src/tests/unattended-paths.test.js scans
// src/ for every timer, cron schedule and process signal handler and compares
// the result with UNATTENDED_PATHS + BOUNDED_TIMERS + TEST_SITES in BOTH
// directions: a new timer that is not classified reddens the walk, and so does
// an entry whose site has gone.
//
// BOUNDED_TIMERS are timers that are not unattended paths: request-scoped
// timeouts and waits that run inside an attended call and end with it. They are
// listed (with the reason) so the walk can tell them apart.
//
// Key: file (relative to src/), callee as the scan reads it, anchor (nearest
// enclosing named function, '(module)' at top level), event (signal handlers).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, file: string, callee: string, anchor: string, event?: string, cls: 'policy'|'observer',
 *             destructive: boolean, default: 'fail_closed'|'fail_open', statement: string, evidence: string,
 *             tests?: string[] }} UnattendedPath
 *
 * `tests` (required on every destructive path) names the test files, relative
 * to the repository root, that hold the stated default as observed behaviour.
 */

/** @type {ReadonlyArray<UnattendedPath>} */
export const UNATTENDED_PATHS = Object.freeze( [
  {
    id: 'scheduler.tick', file: 'utils/scheduler.js', callee: 'cron.schedule', anchor: 'startScheduler',
    cls: 'policy', destructive: true, default: 'fail_closed',
    statement: 'Sends a scheduled email only within SCHEDULE_LATE_GRACE_MINUTES (default 60) of its send_at. Later than that, the send is HELD for a person (email_schedule_release or cancel), never sent late. Overlapping ticks never dispatch the same send twice. A hold nobody releases within SCHEDULE_HOLD_EXPIRY_DAYS (default 7) times out: the send is denied and recorded expired_unconfirmed, which is not counted as a refusal.',
    evidence: 'utils/scheduler.js checkAndFireDueSchedules, fireDue, releaseHeldSchedule, scheduleOutcomes',
    tests: [ 'src/tests/unattended-paths.test.js' ],
  },
  {
    id: 'scheduler.boot_catchup', file: 'utils/scheduler.js', callee: 'setTimeout', anchor: 'startScheduler',
    cls: 'policy', destructive: true, default: 'fail_closed',
    statement: 'The boot-time tick obeys the same rule as scheduler.tick: sends that fell due while the connector was down are held unless they are still inside the late grace. Before v13.39.0 every overdue send went out at boot, however old.',
    evidence: 'utils/scheduler.js startScheduler (calls checkAndFireDueSchedules)',
    tests: [ 'src/tests/unattended-paths.test.js' ],
  },
  {
    id: 'memory.ttl_worker', file: 'tools-memory/ttlExpiry.js', callee: 'setInterval', anchor: 'startTtlWorker',
    cls: 'policy', destructive: true, default: 'fail_closed',
    statement: 'Deletes SQLite memory rows only when the writer set a ttl and it has passed. A re-check date (H-10) is never consulted: a past-due re-check is an obligation to re-verify, never a deletion. A failed tick deletes nothing.',
    evidence: 'tools-memory/ttlExpiry.js tick (ttl IS NOT NULL AND ttl < now)',
    tests: [ 'src/tools-memory/memory.test.js', 'src/tests/memory-write-guard.test.js' ],
  },
  {
    id: 'retention.sweep', file: 'server-http.js', callee: 'setInterval', anchor: '(module)',
    cls: 'policy', destructive: true, default: 'fail_closed',
    statement: 'Deletes uploads and downloads only past their configured TTL, only inside their roots (safeUnlinkUpload containment), never the protected names. A file whose age or path cannot be established is left in place.',
    evidence: 'server-http.js sweepExpiredFiles, safeUnlinkUpload, DOWNLOADS_PROTECTED',
    tests: [ 'tests/upload-retention.test.js' ],
  },
  {
    id: 'service.shutdown', file: 'utils/serviceRuntime.js', callee: 'process.on', anchor: 'installShutdownHandlers', event: 'SIGTERM',
    cls: 'policy', destructive: false, default: 'fail_closed',
    statement: 'On SIGTERM: stop accepting, drain in flight, flush the schedule store, exit. No scheduled send is fired from the shutdown path.',
    evidence: 'utils/serviceRuntime.js shutdown',
  },
  {
    id: 'service.interrupt', file: 'utils/serviceRuntime.js', callee: 'process.on', anchor: 'installShutdownHandlers', event: 'SIGINT',
    cls: 'policy', destructive: false, default: 'fail_closed',
    statement: 'On SIGINT: the same drain as service.shutdown (stop accepting, drain in flight, flush the schedule store, exit). No scheduled send is fired from the shutdown path.',
    evidence: 'utils/serviceRuntime.js shutdown',
  },
  {
    id: 'service.drain_deadline', file: 'utils/serviceRuntime.js', callee: 'setTimeout', anchor: 'shutdown',
    cls: 'policy', destructive: false, default: 'fail_closed',
    statement: 'The drain has a deadline; past it the process exits rather than hanging, so the platform can restart it.',
    evidence: 'utils/serviceRuntime.js shutdown (two deadline timers)',
  },
  {
    id: 'service.uncaught', file: 'utils/serviceRuntime.js', callee: 'process.on', anchor: 'installProcessGuards', event: 'uncaughtException',
    cls: 'policy', destructive: false, default: 'fail_closed',
    statement: 'An uncaught exception exits the process (code 1) for the orchestrator to restart; it does not continue in an unknown state.',
    evidence: 'utils/serviceRuntime.js installProcessGuards',
  },
  {
    id: 'service.unhandled_rejection', file: 'utils/serviceRuntime.js', callee: 'process.on', anchor: 'installProcessGuards', event: 'unhandledRejection',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'An unhandled rejection is logged and the process continues: one failed promise is not a reason to drop every in-flight request.',
    evidence: 'utils/serviceRuntime.js installProcessGuards',
  },
  {
    id: 'tracking.append_loop', file: 'utils/tracking.js', callee: 'setInterval', anchor: 'startAppendLoop',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'Retries buffered tracking-event appends. A failed append is retried and finally dropped with a log line; it never blocks or delays a send.',
    evidence: 'utils/tracking.js processPendingAppends',
  },
  {
    id: 'brain_scan.queued_rerun', file: 'tools/brain-scan-trigger.js', callee: 'setTimeout', anchor: 'finish',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'One coalesced rerun of a manual brain scan requested while one was running. It rebuilds a derived artefact only; a failure is logged.',
    evidence: 'tools/brain-scan-trigger.js runBrainScan finish',
  },
  {
    id: 'voice.stream_heartbeat', file: 'voice/voice-stream-server.js', callee: 'setInterval', anchor: 'attachVoiceStream',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'Pings open voice sockets and closes dead ones. It never touches stored data.',
    evidence: 'voice/voice-stream-server.js attachVoiceStream',
  },
  {
    id: 'voice.worker_reap_exit', file: 'voice/stdio-worker.js', callee: 'process.on', anchor: 'installReaper', event: 'exit',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'On exit, kills only this process\'s own voice workers; a worker already gone is ignored and never delays the exit.',
    evidence: 'voice/stdio-worker.js installReaper reap',
  },
  {
    id: 'voice.worker_reap_signal', file: 'voice/stdio-worker.js', callee: 'process.on', anchor: 'installReaper', event: '(signal variable)',
    cls: 'observer', destructive: false, default: 'fail_open',
    statement: 'On SIGINT/SIGTERM, reaps this process\'s own voice workers, then re-raises the signal on itself so the default disposition still applies.',
    evidence: 'voice/stdio-worker.js installReaper',
  },
] );

/** Timers that run inside an attended call and end with it. */
export const BOUNDED_TIMERS = Object.freeze( [
  { file: 'bundles/bundle-store.js',            callee: 'setTimeout',  anchor: 'searchWithWorker',        reason: 'search worker timeout for the calling request' },
  { file: 'middleware/mcpAuth.js',              callee: 'setTimeout',  anchor: 'mcpAuthMiddleware',       reason: 'per-request authentication delay' },
  { file: 'routes/volume-snapshot.js',          callee: 'setTimeout',  anchor: 'runHelper',               reason: 'helper process timeout for the calling request' },
  { file: 'tools-self-model/recorder.js',       callee: 'setTimeout',  anchor: 'gatewayIngest',           reason: 'fetch timeout for one ingest call' },
  { file: 'tools-self-model/stateVector.js',    callee: 'setTimeout',  anchor: 'dualWriteStateToGateway', reason: 'fetch timeout for one dual-write call' },
  { file: 'tools/brain-scan-trigger.js',        callee: 'setTimeout',  anchor: 'runBrainScan',            reason: 'scan process timeout' },
  { file: 'tools/ti-tools-client.js',           callee: 'setTimeout',  anchor: 'callGateway',             reason: 'fetch timeout for one gateway call' },
  { file: 'tools/wordpress.js',                 callee: 'setTimeout',  anchor: 'wpFetch',                 reason: 'fetch timeout for one WordPress call' },
  { file: 'utils/zipCentralDirectory.js',       callee: 'setImmediate', anchor: 'yieldToLoop',            reason: 'yield to the event loop during one archive read' },
  { file: 'voice/kokoro-worker-supervisor.js',  callee: 'setTimeout',  anchor: 'synthesizeOnce',          reason: 'one-shot synthesis timeout' },
  { file: 'voice/stdio-worker.js',              callee: 'setTimeout',  anchor: 'teardown',                reason: 'kill escalation for a worker being torn down' },
  { file: 'voice/stdio-worker.js',              callee: 'setTimeout',  anchor: 'armIdleTimer',            reason: 'idle shutdown of an on-demand worker' },
  { file: 'voice/stdio-worker.js',              callee: 'setInterval', anchor: 'start',                   reason: 'startup readiness poll, cleared on ready or deadline' },
  { file: 'voice/stdio-worker.js',              callee: 'setTimeout',  anchor: 'request',                 reason: 'per-request worker timeout' },
  { file: 'voice/voice-auth.js',                callee: 'setTimeout',  anchor: 'reject401',               reason: 'delay before an authentication refusal on one upgrade' },
  { file: 'voice/voice-engines.js',             callee: 'setTimeout',  anchor: 'run',                     reason: 'engine process timeout for one synthesis' },
] );

/** Test harness files under src/, never reachable from a tool path. */
export const TEST_SITES = Object.freeze( [ 'test-http.js', 'test.js' ] );

export default { UNATTENDED_PATHS, BOUNDED_TIMERS, TEST_SITES };
