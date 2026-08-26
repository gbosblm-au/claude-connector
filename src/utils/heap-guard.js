// src/utils/heap-guard.js
//
// Keep a tool call from taking the process with it. Connector v13.23.0.
//
// ===========================================================================
// WHAT HAPPENED
// ===========================================================================
//
// A module_write force-overwrite ran the heap to 4.9 GB in roughly 95 seconds
// and V8 aborted the process. Railway restarted it, the caller retried the same
// call, and it happened again -- four crashes in six minutes. From the caller's
// side every attempt was a 502, because the process serving it had died.
//
// From the logs, with the timestamps that make it certain:
//
//     07:34:26  process start
//     07:34:32  [/tool-call] dispatching: module_write
//     07:34:32  [module_write] Overwriting existing file (force=true confirmed)
//     07:36:07  FATAL ERROR: Reached heap limit          (uptime 100,404 ms)
//
// No other tool call ran in that window.
//
// ===========================================================================
// WHY THIS IS NOT A FIX FOR THAT BUG
// ===========================================================================
//
// It is deliberately not. The allocation site has not been identified: the
// module write, the manifest fragment merge and the frontmatter parser are all
// bounded on inspection, and the JS stack in the crash output was empty, so the
// log cannot name it either.
//
// What this file addresses is the thing that turned one bug into an outage. A
// process that dies takes every OTHER request with it, returns a 502 that says
// nothing, loses its logs mid-write, and comes back to a caller that retries
// immediately. Any single allocation bug, present or future, becomes a crash
// loop.
//
// So: refuse the call, name the reason, stay alive. A tool that returns
// "declined, memory pressure" is diagnosable and recoverable. A dead process is
// neither.
//
// The companion change is the one that will actually find the bug:
// --heapsnapshot-near-heap-limit=1 in the start command, which writes a heap
// snapshot naming the retaining object the next time this happens.

import { getHeapStatistics } from 'node:v8';

import { log } from './logger.js';

/**
 * Fraction of the heap limit above which tool calls are refused.
 *
 * 0.85 leaves headroom to serve the refusal, write the log line and run a GC.
 * Set it at 0.95 and the guard fires so close to the ceiling that the refusal
 * itself can be the allocation that dies.
 */
function refuseAbove() {
  return Number( process.env.HEAP_GUARD_REFUSE_ABOVE || '0.85' );
}

/** Fraction above which a warning is logged but the call proceeds. */
function warnAbove() {
  return Number( process.env.HEAP_GUARD_WARN_ABOVE || '0.70' );
}

/** Set false to disable entirely. */
function enabled() {
  return 'false' !== String( process.env.HEAP_GUARD_ENABLED || '' )
    .trim().toLowerCase();
}

// Read at CALL time, not at import. A threshold captured at module load cannot
// be changed without a restart -- which is exactly when an operator is least
// able to restart, since the reason they are reaching for it is a process
// under memory pressure. It also makes the guard untestable, and an untested
// guard is one nobody finds out is inverted until it matters.

/**
 * Tools permitted to run under memory pressure.
 *
 * Read-only diagnostics, so an operator can still ask what is happening while
 * the guard is refusing everything else. A guard that blocks the tools used to
 * diagnose it is a guard that gets turned off.
 */
const ALWAYS_ALLOWED = new Set( [
  'self_state_read', 'skill_read', 'memory_search', 'nudge_check',
] );

export const heapGuardStats = {
  checks: 0, warnings: 0, refusals: 0, peakFraction: 0,
};

/**
 * Current heap usage as a fraction of the limit.
 *
 * `heap_size_limit` is what V8 will actually enforce, which is the number that
 * matters: the container may have more memory than V8 is willing to use, and
 * comparing against the container's limit would let the process die while this
 * reported plenty of room.
 *
 * @returns {{used: number, limit: number, fraction: number}}
 */
export function heapUsage() {
  const stats = getHeapStatistics();
  const used = stats.used_heap_size;
  const limit = stats.heap_size_limit || 1;
  return { used, limit, fraction: used / limit };
}

/**
 * May this tool call proceed?
 *
 * ── Why refusal is by TOOL and not by request ────────────────────────────
 *
 * Every route could be guarded, but a tool call is where the unbounded work
 * happens: it is the one place an assistant can hand the process an arbitrary
 * payload and an arbitrary amount of work to do with it. Guarding HTTP
 * generally would refuse health checks and the diagnostics needed to
 * understand the refusal.
 *
 * @param {string} toolName
 * @returns {{allow: boolean, reason?: string, usage: object}}
 */
export function checkHeapBeforeTool( toolName ) {
  const usage = heapUsage();
  heapGuardStats.checks += 1;
  if ( usage.fraction > heapGuardStats.peakFraction ) {
    heapGuardStats.peakFraction = usage.fraction;
  }

  if ( ! enabled() ) return { allow: true, usage };
  if ( ALWAYS_ALLOWED.has( toolName ) ) return { allow: true, usage };

  const pct = Math.round( usage.fraction * 100 );
  const mb = Math.round( usage.used / 1048576 );
  const limitMb = Math.round( usage.limit / 1048576 );

  if ( usage.fraction >= refuseAbove() ) {
    heapGuardStats.refusals += 1;
    log( 'error', `[heap-guard] REFUSING ${ toolName }: heap at ${ pct }% `
      + `(${ mb }MB of ${ limitMb }MB). The process is close to the limit V8 `
      + 'will abort at; declining the call keeps it alive and every other '
      + 'request served.' );
    return {
      allow: false,
      reason: 'memory_pressure',
      usage,
      message: `Declined: the connector is at ${ pct }% of its memory limit `
        + `(${ mb }MB of ${ limitMb }MB). This call was refused rather than `
        + 'risking the process. Retrying immediately will be refused again -- '
        + 'the connector needs a restart, or the payload is too large.',
    };
  }

  if ( usage.fraction >= warnAbove() ) {
    heapGuardStats.warnings += 1;
    log( 'warn', `[heap-guard] ${ toolName } proceeding at ${ pct }% heap `
      + `(${ mb }MB of ${ limitMb }MB)` );
  }

  return { allow: true, usage };
}

/**
 * A refusal shaped like a tool result.
 *
 * Returned rather than thrown so the caller receives an ANSWER. A throw becomes
 * a 500, which is only marginally more informative than the 502 this exists to
 * prevent, and the assistant cannot tell a refusal from a crash.
 *
 * @param {string} toolName
 * @param {object} verdict
 * @returns {object}
 */
export function heapRefusalResult( toolName, verdict ) {
  return {
    content: [ {
      type: 'text',
      text: JSON.stringify( {
        ok: false,
        error: 'memory_pressure',
        tool: toolName,
        message: verdict.message,
        heap_used_mb: Math.round( verdict.usage.used / 1048576 ),
        heap_limit_mb: Math.round( verdict.usage.limit / 1048576 ),
        retry: 'not_immediately',
      }, null, 2 ),
    } ],
    isError: true,
  };
}

/** Counters for /health. Never payloads. */
export function heapGuardHealth() {
  const usage = heapUsage();
  return {
    enabled: enabled(),
    refuse_above: refuseAbove(),
    warn_above: warnAbove(),
    heap_used_mb: Math.round( usage.used / 1048576 ),
    heap_limit_mb: Math.round( usage.limit / 1048576 ),
    heap_fraction: Number( usage.fraction.toFixed( 3 ) ),
    stats: { ...heapGuardStats },
  };
}

export default { checkHeapBeforeTool, heapRefusalResult, heapGuardHealth, heapUsage };
