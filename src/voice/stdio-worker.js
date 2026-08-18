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

/**
 * @typedef {object} StdioWorkerSpec
 * @property {string}   name        For logs.
 * @property {Function} interpreter Resolves the interpreter path.
 * @property {Function} script      Resolves the worker script path.
 * @property {Function} enabled     Whether this worker is switched on.
 * @property {Function} [env]       Extra environment for the child.
 * @property {Function} [args]      Extra argv for the child.
 * @property {Function} [refusals]  Error codes that must NOT fall back --
 *        the ones the per-request path would reject identically, so retrying
 *        there only reaches the same answer more slowly. Everything else falls
 *        back. See call() for why this is a refusal list and not an
 *        infrastructure list.
 */

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
    // Set when the worker diagnosed itself as structurally unable to serve --
    // a missing engine, not a transient crash. Retrying that on a schedule
    // achieves nothing but log noise.
    fatal: false,
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
  /**
   * Keep the event loop alive while this worker has work outstanding.
   *
   * THE OTHER HALF OF THE unref FIX, AND IT IS NOT OPTIONAL.
   *
   * Unreferencing the child stopped an idle worker holding the process open,
   * which was the bug it was written for. But it went too far: with the child
   * and all three pipes unreferenced, NOTHING held the loop while a request was
   * in flight, so node could decide it had run out of work and exit while a
   * synthesis was still being awaited. The caller's promise then simply never
   * settled -- no error, no timeout, no log line.
   *
   * In the server that never happens, because the HTTP listener holds the loop
   * open regardless. It is invisible there and fatal anywhere else, which is
   * the same trap as the original defect wearing the opposite face.
   *
   * So the reference tracks BUSYNESS rather than existence, which is what was
   * meant all along: an idle worker is not a reason to keep running, and a
   * worker mid-request is.
   *
   * @returns {void}
   */
  function holdLoop() {
    const child = state.child;
    if (!child) return;
    try {
      child.ref();
      // Only stdout matters for liveness -- it is the channel a response
      // arrives on -- but stderr carries the diagnosis when a worker dies
      // mid-request, and losing that is how a failure becomes a mystery.
      if (child.stdout) child.stdout.ref();
      if (child.stderr) child.stderr.ref();
    } catch (err) { /* already gone */ }
  }

  /**
   * Let the process exit if this worker is the only thing left.
   *
   * Called when the last outstanding operation settles, and only then: a
   * release while another request is still pending would reintroduce the hang
   * holdLoop() exists to prevent.
   *
   * @returns {void}
   */
  function releaseLoop() {
    const child = state.child;
    if (!child) return;
    if (state.starting || state.pending.size) return;
    try {
      child.unref();
      if (child.stdout) child.stdout.unref();
      if (child.stderr) child.stderr.unref();
      if (child.stdin) child.stdin.unref();
    } catch (err) { /* already gone */ }
  }

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

      // The worker has diagnosed itself as unable to serve and is exiting. Its
    // reason is far more useful than the exit code the close handler would
    // otherwise report, so it is captured before the process goes.
    if ('fatal' === message.type) {
      state.lastError = `${spec.name} worker cannot start: `
        + `${message.error || message.code || 'no reason given'}`;
      console.error(`[voice] ${state.lastError}`);
      state.fatal = true;
      return;
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

    // A FATAL diagnosis goes straight to the ceiling. Exponential backoff is
    // for a worker that might come back -- a crash under load, a transient
    // resource shortage. A worker whose interpreter cannot import its engine
    // will fail identically on every attempt until someone changes the
    // deployment, so climbing 2s, 4s, 8s through that is pure log noise around
    // a fallback that is already working.
    const wait = state.fatal
      ? 120_000
      : Math.min(120_000, 2000 * Math.pow(2, Math.min(state.restarts - 1, 10)));
    state.disabledUntil = Date.now() + wait;

    console.error(`[voice] ${spec.name} worker start failed ${state.restarts} time(s)`
      + `${state.fatal ? ' (fatal: the engine is not installed for this interpreter)' : ''}; `
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

      // An unresolved interpreter is a decline, not a spawn. spawn('') fails
      // asynchronously with a confusing ENOENT, and spawning the WRONG
      // interpreter is worse still: it starts, looks healthy, and fails every
      // request. See piperPython() for how that actually happened.
      if (!interpreter) {
        state.lastError = `no interpreter is configured for the ${spec.name} worker; `
          + 'using the per-request path';
        console.error(`[voice] ${state.lastError}`);
        backOff();
        state.starting = null;
        releaseLoop();
        resolve(false);
        return;
      }

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
        releaseLoop();
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

      // Unreferenced to begin with, then referenced again whenever there is
      // work outstanding. See holdLoop().
      releaseLoop();

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
        releaseLoop();
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
        releaseLoop();
        resolve(false);
      });

      // stdin EPIPEs if the worker dies early. The close handler reports the
      // real reason, so this must not throw over the top of it.
      child.stdin.on('error', () => {});

      // Wait for the ready LINE rather than assuming a spawned process is a
      // working one. A missing import takes a moment to fail and would
      // otherwise be discovered by the first user request.
      const deadline = Date.now() + startMs();
      holdLoop();

      const poll = setInterval(() => {
        if (state.ready) {
          clearInterval(poll);
          state.restarts = 0;
          state.disabledUntil = 0;
          state.lastError = null;
          // Cleared on a SUCCESSFUL start, so a deployment that installs the
          // missing engine recovers on the next attempt instead of staying
          // marked fatal for the life of the process.
          state.fatal = false;
          console.log(`[voice] ${spec.name} worker ready (pid=${state.pid})`);
          armIdleTimer();
          state.starting = null;
          releaseLoop();
          resolve(true);
          return;
        }
        if (!state.child) {          // died while we waited
          clearInterval(poll);
          state.starting = null;
          releaseLoop();
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
          releaseLoop();
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

      // ONE EXIT FOR EVERY OUTCOME.
      //
      // A request can end four ways: a response arrives, the worker dies, the
      // deadline passes, or the write itself fails. Each must delete the
      // pending entry, clear the timer and release the loop reference, and an
      // earlier revision had three of those four doing it by hand -- so two
      // paths deleted the entry but never released the reference, and a single
      // timeout would pin the process open for good.
      //
      // Routing all four through one wrapper means a fifth outcome added later
      // cannot forget a step. `settled` guards against a double settle, which
      // is reachable: a worker can answer a request in the same tick its
      // deadline expires.
      let settled = false;
      let timer = null;
      const settle = (fn) => (value) => {
        if (settled) return;
        settled = true;
        state.pending.delete(id);
        if (timer) clearTimeout(timer);
        releaseLoop();
        fn(value);
      };
      const finish = settle(resolve);
      const fail = settle(reject);

      timer = setTimeout(() => {
        // A worker that missed a deadline is presumed WEDGED, not slow. Leaving
        // it in place would make every subsequent request wait the full timeout
        // too; restarting costs one model load and restores the feature.
        console.error(`[voice] ${spec.name} worker timed out; restarting it`);
        teardown('request timeout');
        const err = new Error(`the ${spec.name} worker did not answer within ${limit}ms`);
        err.code = 'worker_timeout';
        fail(err);
      }, limit);

      // Unreferenced for the same reason the idle child is: the watchdog for a
      // request is not itself a reason to keep the process alive. holdLoop()
      // below is what holds it, and it is released by settle().
      if ('function' === typeof timer.unref) timer.unref();

      state.pending.set(id, { resolve: finish, reject: fail, timer });
      holdLoop();

      try {
        state.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (err) {
        const writeErr = new Error(`could not write to the ${spec.name} worker: ${err.message}`);
        writeErr.code = 'worker_unavailable';
        fail(writeErr);
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
      // FALL BACK BY DEFAULT. REJECT ONLY WHAT THE PER-REQUEST PATH WOULD ALSO
      // REJECT.
      //
      // This was originally the other way round -- an allowlist of three
      // "infrastructure" codes fell back and everything else threw -- and it
      // was wrong in production within a day. A worker whose interpreter could
      // not `import piper` returned the generic `synthesis_failed`, which was
      // not on that list, so it propagated as a 500 and the CLI path was never
      // tried. Voice was down while a working fallback sat one branch away.
      //
      // The asymmetry of the two mistakes is the whole argument:
      //
      //   Fall back when we should have thrown  -> one wasted retry, then the
      //                                            same clear error. Costs a
      //                                            second.
      //   Throw when we should have fallen back -> the feature is down, and
      //                                            the log names a Python
      //                                            module rather than the
      //                                            fallback that did not run.
      //
      // So the default must be to fall back, and every code that skips the
      // fallback has to be named deliberately by the caller. A code nobody
      // anticipated -- which is exactly what a novel failure is -- now degrades
      // instead of failing the turn.
      const refusals = ('function' === typeof spec.refusals ? spec.refusals() : []) || [];
      if (refusals.includes(err.code)) throw err;

      console.error(`[voice] ${spec.name} worker could not serve this (${err.code
        || 'unknown'}); using the per-request path`);
      return null;
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
      // True when the engine is structurally unavailable to this worker's
      // interpreter. Distinguished from last_error because it is the one state
      // an operator must ACT on -- everything else self-heals.
      fatal: state.fatal,
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
    state.fatal = false;
    state.requestsServed = 0;
    state.nextId = 1;
    state.capabilities = null;
    state.protocol = null;
  }

  return { start, call, request, stop, health, reset,
           isWarm: () => !!(state.ready && state.child) };
}

export default { createStdioWorker };
