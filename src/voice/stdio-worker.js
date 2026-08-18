// src/voice/stdio-worker.js
//
// Tenax Voice -- the shared lifecycle for a resident Python worker.
// PIPER-PRELOAD-v1.1 Sections 4.3 and 6.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
//
// v12.53.0 added a resident Piper worker. v12.54.0 adds a resident Whisper
// worker (Change 3). The two engines have nothing in common -- different
// licences, different interpreters, different request shapes, different memory
// profiles -- but their SUPERVISION is the same problem twice:
//
//   spawn a long-lived child with a minimal environment
//   frame NDJSON over stdio and route responses by id
//   time out a wedged request and restart the child
//   back off exponentially when the child will not start
//   reject in-flight requests when the child dies
//   release the model after an idle period
//   report health
//
// That is roughly four hundred lines. Written twice it becomes four hundred
// lines that drift: a backpressure fix applied to one, a leak fixed in the
// other, and eventually two supervisors that behave differently under load for
// reasons nobody remembers. So it is written once, here, and parameterised.
//
// ===========================================================================
// WHAT THIS FILE DELIBERATELY DOES NOT DECIDE
// ===========================================================================
//
// THE INTERPRETER. It is supplied by the caller as a function, and that is the
// single most important boundary in the voice subsystem: the Piper worker
// imports GPL code and the Whisper worker imports MIT code, and the licence
// separation rests on those two never sharing a site-packages.
//
// Sharing a spawner between them makes that separation a matter of WHAT IS
// PASSED IN rather than of which file does the spawning, which is a real
// weakening of a structural guarantee -- so it is compensated for by asserting,
// in src/tests/voice-gpl-boundary.test.js, that each supervisor supplies a
// different resolver and that the Piper one never reads VOICE_PYTHON_BIN.
//
// Nothing about Piper, Whisper, audio or licences appears below. This file
// supervises a process that speaks JSON lines.

import { spawn }      from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * @typedef {object} WorkerSpec
 * @property {string}   name          For logs, e.g. 'piper' or 'stt'.
 * @property {string}   script        Absolute path to the Python file to run.
 * @property {() => string} interpreter  Resolves the interpreter path. A
 *           FUNCTION, not a string, so it is read at spawn time and a test or
 *           an operator can change the environment after import.
 * @property {() => string} cwd       Resolves the working directory.
 * @property {() => object} [env]     Extra environment for the child, merged
 *           over the minimal base. Never the parent environment.
 * @property {() => string[]} [args]  Extra argv after the script path.
 * @property {() => boolean} enabled  Whether the worker may run at all.
 * @property {() => number} [idleMs]  Idle before releasing the model; 0 disables.
 * @property {() => number} [timeoutMs]  Per-request ceiling.
 * @property {() => number} [startMs] How long to wait for the ready line.
 * @property {object} [meta]          Extra fields merged into health output.
 */

/**
 * Build a supervisor for one resident worker.
 *
 * @param {WorkerSpec} spec
 * @returns {object} The supervisor API.
 */
/**
 * Every live worker, so the parent can reap them on the way out.
 *
 * THE OTHER HALF OF unref(). Unreferencing the child stops it holding the event
 * loop open, which is correct -- but it also means node will happily exit while
 * the worker is still running, ORPHANING a process that is holding a
 * multi-hundred-megabyte model. On a container that is merely wasteful; on a
 * host where the connector restarts in a loop it is an accumulating memory leak
 * made of abandoned Python processes.
 *
 * A Set rather than a list because workers register once and deregister on
 * teardown, and double-registration after a restart would leave a stale entry
 * pointing at a dead pid.
 */
const LIVE_WORKERS = new Set();

/**
 * Kill everything still running. Registered ONCE, however many workers exist.
 *
 * Per-worker listeners would trip node's MaxListeners warning at eleven
 * workers and, more to the point, would make the number of handlers depend on
 * how many times a worker had restarted.
 */
let reaperInstalled = false;
function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;

  const reap = () => {
    for (const child of LIVE_WORKERS) {
      // SIGKILL, not SIGTERM. This runs on the way out, and 'exit' handlers may
      // not perform asynchronous work -- there is no later in which to escalate
      // from a polite signal the child ignored.
      try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
    }
    LIVE_WORKERS.clear();
  };

  process.on('exit', reap);
  // Signals are not covered by 'exit'. Re-raised after reaping so the exit code
  // still reflects the signal, and the default disposition is not swallowed.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      reap();
      process.kill(process.pid, signal);
    });
  }
  // Listeners must not themselves prevent the exit they are waiting for.
  if ('function' === typeof process.setMaxListeners) process.setMaxListeners(0);
}

export function createStdioWorker(spec) {
  const state = {
    child: null,
    ready: false,
    starting: null,
    pid: null,
    protocol: null,
    capabilities: null,   // whatever the worker put in its ready line
    nextId: 1,
    pending: new Map(),
    stdoutBuffer: '',
    stderrText: '',
    lastUsedAt: 0,
    idleTimer: null,
    restarts: 0,
    lastError: null,
    disabledUntil: 0,
    startedAt: null,
    requestsServed: 0,
  };

  const num = (fn, fallback) => {
    if ('function' !== typeof fn) return fallback;
    const value = fn();
    return Number.isFinite(value) ? value : fallback;
  };

  const timeoutMs = () => num(spec.timeoutMs, 60_000);
  const startMs = () => num(spec.startMs, 45_000);
  const idleMs = () => num(spec.idleMs, 300_000);

  /**
   * Reject every in-flight request and clear the routing table.
   *
   * Without this, a caller waiting on a response from a process that no longer
   * exists waits until its own timeout -- which on a transcription is a full
   * minute of a user watching a spinner for a result that can never arrive.
   *
   * @param {string} reason
   */
  function failPending(reason) {
    const err = new Error(`the ${spec.name} worker went away: ${reason}`);
    err.code = 'worker_gone';
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    state.pending.clear();
  }

  /**
   * Tear down the child and reset the state describing it.
   *
   * @param {string} reason
   */
  function teardown(reason) {
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }

    const child = state.child;
    state.child = null;
    state.ready = false;
    state.pid = null;
    state.startedAt = null;
    state.stdoutBuffer = '';

    if (child) {
      try { child.stdin.end(); } catch (err) { /* already closed */ }
      try { child.kill('SIGTERM'); } catch (err) { /* already gone */ }
      // SIGKILL after a grace period. A worker mid-inference does not always
      // notice SIGTERM promptly, and leaving it holding a model would mean the
      // replacement and the corpse are resident together -- which on a small
      // instance is precisely the OOM this whole design is bounded to avoid.
      const doomed = child;
      setTimeout(() => {
        try { doomed.kill('SIGKILL'); } catch (err) { /* gone */ }
        // Deregistered only after the escalation, so a child that ignored
        // SIGTERM is still reachable by the exit reaper in the meantime.
        LIVE_WORKERS.delete(doomed);
      }, 2000).unref();
    }

    failPending(reason);
  }

  /**
   * Handle one complete line of worker stdout.
   *
   * @param {string} line
   */
  function onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      // The worker writes diagnostics to stderr, so an unparseable line on
      // stdout is a protocol violation rather than noise. Dropped, which keeps
      // the stream in sync -- that is what matters.
      console.error(`[voice] ${spec.name} worker sent an unparseable line`);
      return;
    }

    // Capabilities may arrive with the ready line, or later: some facts are not
    // knowable until a model is loaded (Piper cannot report which synthesis API
    // it bound to before it has a voice). Merged from ANY message so health
    // reports the current truth rather than what was knowable at second zero.
    if (message.capabilities && 'object' === typeof message.capabilities) {
      state.capabilities = Object.assign({}, state.capabilities, message.capabilities);
    }

    if ('ready' === message.type) {
      state.ready = true;
      state.protocol = message.protocol;
      state.pid = message.pid;
      state.startedAt = Date.now();
      return;
    }

    const entry = state.pending.get(message.id);
    if (!entry) return;   // a response to a request that already timed out
    state.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok) { entry.resolve(message); return; }

    const err = new Error(message.error || `the ${spec.name} worker refused the request`);
    err.code = message.code || 'worker_failed';
    entry.reject(err);
  }

  /**
   * Exponential backoff after a failed start.
   *
   * Without this, a connector whose venv is missing would spawn a doomed
   * process on every request forever -- a CPU cost and a log nobody can read.
   * The cap keeps a transient failure from disabling the worker permanently.
   */
  function backOff() {
    state.restarts++;
    const wait = Math.min(120_000, 2000 * Math.pow(2, Math.min(state.restarts - 1, 10)));
    state.disabledUntil = Date.now() + wait;
    console.error(`[voice] ${spec.name} worker start failed ${state.restarts} time(s); `
      + `next attempt in ${Math.round(wait / 1000)}s (the per-request path is serving)`);
  }

  /**
   * Release the model after inactivity.
   *
   * Unloaded rather than killed, so the next request pays a model load but not
   * a process spawn, and the pipe stays up. On an instance shared between two
   * engines, holding a model through a long idle period is memory taken from
   * whichever one needs it next.
   */
  function armIdleTimer() {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    const idle = idleMs();
    if (!idle) return;

    state.idleTimer = setTimeout(() => {
      if (!state.ready || state.pending.size) { armIdleTimer(); return; }
      if (Date.now() - state.lastUsedAt < idle) { armIdleTimer(); return; }
      console.log(`[voice] ${spec.name} worker idle; releasing its model`);
      request({ op: 'unload' }, 10_000).catch(() => {});
    }, idle);
    state.idleTimer.unref();
  }

  /**
   * Start the worker, or return the start already in flight.
   *
   * @param {string[]} [extraArgs]
   * @returns {Promise<boolean>}
   */
  function start(extraArgs) {
    if (!spec.enabled()) return Promise.resolve(false);
    if (state.ready && state.child) return Promise.resolve(true);
    if (state.starting) return state.starting;
    if (Date.now() < state.disabledUntil) return Promise.resolve(false);

    state.starting = new Promise((resolve) => {
      const interpreter = spec.interpreter();
      const cwd = spec.cwd();

      const args = [spec.script]
        .concat('function' === typeof spec.args ? spec.args() : [])
        .concat(extraArgs || []);

      let child;
      try {
        child = spawn(interpreter, args, {
          cwd: existsSync(cwd) ? cwd : undefined,
          // A MINIMAL environment, assembled here rather than inherited. Node's
          // default is to hand a child the entire parent environment, which on
          // this connector includes API keys, the database URL and the session
          // secret. A transcription worker has no business holding any of them.
          env: Object.assign({
            PATH: process.env.PATH,
            HOME: cwd,
            PYTHONDONTWRITEBYTECODE: '1',
            // Unbuffered, so a response is not sitting complete in a pipe
            // buffer while the supervisor waits for it. The workers flush
            // explicitly as well; this is the belt to that pair of braces.
            PYTHONUNBUFFERED: '1',
          }, 'function' === typeof spec.env ? spec.env() : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        state.lastError = `could not spawn the ${spec.name} worker: ${err.message}`;
        console.error(`[voice] ${state.lastError}`);
        backOff();
        state.starting = null;
        resolve(false);
        return;
      }

      state.child = child;
      state.ready = false;
      state.stdoutBuffer = '';
      state.stderrText = '';

      // A RESIDENT WORKER MUST NEVER BE THE REASON THE PARENT STAYS ALIVE.
      //
      // This was a real defect, and it presented as a test suite that passed
      // every assertion and then hung forever. A spawned child and each of its
      // three stdio pipes are referenced libuv handles, so node keeps the event
      // loop open while any of them exist. A worker that is doing its job
      // correctly -- sitting idle, holding a model, waiting on stdin -- is
      // therefore indistinguishable from unfinished work.
      //
      // In the server that is harmless, because the HTTP listener holds the
      // loop open anyway. Everywhere else (tests, scripts, a one-shot CLI) it
      // means the process never exits. Unreferencing says what is actually
      // true: this worker is useful while something else is running, and is not
      // itself a reason to keep running.
      //
      // The pipes are unreferenced individually because unref() on the child
      // releases only the process handle; the three stream handles are separate
      // and each holds the loop on its own.
      installReaper();
      LIVE_WORKERS.add(child);

      child.unref();
      if (child.stdout) child.stdout.unref();
      if (child.stderr) child.stderr.unref();
      if (child.stdin) child.stdin.unref();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        state.stdoutBuffer += chunk;

        // A response can legitimately be large, but it is still ONE line. This
        // ceiling exists so a worker emitting unbounded garbage cannot grow the
        // heap without limit: far above any real response, far below a problem.
        if (state.stdoutBuffer.length > 64 * 1024 * 1024) {
          console.error(`[voice] ${spec.name} worker overflowed the line buffer; restarting`);
          teardown('line buffer overflow');
          return;
        }

        let index = state.stdoutBuffer.indexOf('\n');
        while (index !== -1) {
          const line = state.stdoutBuffer.slice(0, index).trim();
          state.stdoutBuffer = state.stdoutBuffer.slice(index + 1);
          if (line) onLine(line);
          index = state.stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk) => {
        // Capped for the same reason the buffer above is: a child failing in a
        // loop must not fill the heap with its own complaints.
        if (state.stderrText.length < 16_384) state.stderrText += chunk.toString();
      });

      child.on('error', (err) => {
        state.lastError = `${spec.name} worker error: ${err.message}`;
        console.error(`[voice] ${state.lastError}`);
        teardown(err.message);
        backOff();
        state.starting = null;
        resolve(false);
      });

      child.on('close', (code, signal) => {
        const wasReady = state.ready;
        const detail = state.stderrText.trim().slice(0, 500);
        state.lastError = `${spec.name} worker exited (code=${code} signal=${signal || 'none'})`
          + (detail ? `: ${detail}` : '');
        // Only noisy when the worker had been working. A failure to start is
        // reported on the start path, and reporting it twice makes one fault
        // look like two.
        if (wasReady) console.error(`[voice] ${state.lastError}`);
        teardown(`exit ${code}`);
        if (!wasReady) backOff();
        state.starting = null;
        resolve(false);
      });

      // stdin EPIPEs if the worker dies early. The close handler reports the
      // real reason, so this must not throw over the top of it.
      child.stdin.on('error', () => {});

      // Wait for the ready LINE rather than assuming a spawned process is a
      // working one. A missing import takes a moment to fail and would
      // otherwise be discovered by the first user request.
      const deadline = Date.now() + startMs();
      const poll = setInterval(() => {
        if (state.ready) {
          clearInterval(poll);
          state.restarts = 0;
          state.disabledUntil = 0;
          state.lastError = null;
          console.log(`[voice] ${spec.name} worker ready (pid=${state.pid})`);
          armIdleTimer();
          state.starting = null;
          resolve(true);
          return;
        }
        if (!state.child) {          // died while we waited
          clearInterval(poll);
          state.starting = null;
          resolve(false);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(poll);
          state.lastError = `the ${spec.name} worker did not report ready in time`
            + (state.stderrText.trim() ? `: ${state.stderrText.trim().slice(0, 300)}` : '');
          console.error(`[voice] ${state.lastError}`);
          teardown('ready timeout');
          backOff();
          state.starting = null;
          resolve(false);
        }
      }, 100);
      poll.unref();
    });

    return state.starting;
  }

  /**
   * Send one request and await its response.
   *
   * @param {object} payload
   * @param {number} [limitMs]
   * @returns {Promise<object>}
   */
  function request(payload, limitMs) {
    return new Promise((resolve, reject) => {
      if (!state.child || !state.ready) {
        const err = new Error(`the ${spec.name} worker is not running`);
        err.code = 'worker_unavailable';
        reject(err);
        return;
      }

      const id = state.nextId++;
      const limit = limitMs || timeoutMs();

      // Unreferenced for the same reason as the child itself: a request in
      // flight is work the CALLER is awaiting, and the caller's own lifetime is
      // what should hold the loop open, not our watchdog.
      const timer = setTimeout(() => {
        state.pending.delete(id);
        // A worker that missed a deadline is presumed WEDGED, not slow. Leaving
        // it in place would make every subsequent request wait the full timeout
        // too; restarting costs one model load and restores the feature.
        console.error(`[voice] ${spec.name} worker timed out; restarting it`);
        teardown('request timeout');
        const err = new Error(`the ${spec.name} worker did not answer within ${limit}ms`);
        err.code = 'worker_timeout';
        reject(err);
      }, limit);

      if ('function' === typeof timer.unref) timer.unref();

      state.pending.set(id, { resolve, reject, timer });

      try {
        state.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (err) {
        state.pending.delete(id);
        clearTimeout(timer);
        const writeErr = new Error(`could not write to the ${spec.name} worker: ${err.message}`);
        writeErr.code = 'worker_unavailable';
        reject(writeErr);
      }
    });
  }

  /**
   * Run one request, starting the worker if needed.
   *
   * RESOLVES TO NULL WHEN THE WORKER CANNOT SERVE IT, rather than rejecting.
   * That distinction is the fallback contract: null means "the resident path is
   * unavailable, use the per-request spawn", and the caller treats it as a
   * routing answer rather than an error.
   *
   * A genuine REFUSAL still rejects, because retrying it on the per-request
   * path would reach the same refusal more slowly.
   *
   * @param {object} payload
   * @param {{startArgs?: string[], timeoutMs?: number}} [opts]
   * @returns {Promise<object|null>}
   */
  async function call(payload, opts) {
    const o = opts || {};
    if (!spec.enabled()) return null;

    const started = await start(o.startArgs);
    if (!started) return null;

    state.lastUsedAt = Date.now();

    let response;
    try {
      response = await request(payload, o.timeoutMs);
    } catch (err) {
      const infrastructure = ['worker_unavailable', 'worker_gone', 'worker_timeout'];
      if (infrastructure.includes(err.code)) {
        console.error(`[voice] ${spec.name} worker unavailable (${err.code}); `
          + 'using the per-request path');
        return null;
      }
      throw err;
    }

    state.lastUsedAt = Date.now();
    state.requestsServed++;
    armIdleTimer();
    return response;
  }

  /**
   * Stop the worker.
   *
   * @returns {Promise<void>}
   */
  async function stop() {
    if (state.child && state.ready) {
      try { await request({ op: 'shutdown' }, 2000); } catch (err) { /* going anyway */ }
    }
    teardown('stopped');
    state.restarts = 0;
    state.disabledUntil = 0;
  }

  /**
   * Health, for /voice/health.
   *
   * `pid` and `warm` are what make "consecutive requests reused one process" an
   * observable fact rather than an inference from a stopwatch.
   *
   * @returns {object}
   */
  function health() {
    return Object.assign({
      enabled: spec.enabled(),
      warm: !!(state.ready && state.child),
      pid: state.pid,
      protocol: state.protocol,
      capabilities: state.capabilities,
      idle_ms: idleMs(),
      requests_served: state.requestsServed,
      restarts: state.restarts,
      in_flight: state.pending.size,
      uptime_ms: state.startedAt ? Date.now() - state.startedAt : 0,
      last_error: state.lastError,
      interpreter: spec.interpreter(),
      worker_script: spec.script,
    }, 'function' === typeof spec.meta ? spec.meta() : (spec.meta || {}));
  }

  /** Reset for tests. */
  function reset() {
    teardown('reset');
    state.restarts = 0;
    state.disabledUntil = 0;
    state.lastError = null;
    state.requestsServed = 0;
    state.nextId = 1;
    state.capabilities = null;
    state.protocol = null;
  }

  return { start, call, request, stop, health, reset,
           isWarm: () => !!(state.ready && state.child) };
}

export default { createStdioWorker };
