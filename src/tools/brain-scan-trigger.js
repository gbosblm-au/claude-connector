/**
 * brain-scan-trigger.js  (connector v12.36.0)
 *
 * Runs brain_scan.py on demand, and records what the last compile loaded.
 *
 * TRIGGER POLICY (v12.36.0): MANUAL ONLY.
 * ---------------------------------------------------------------------------
 * A scan runs when, and only when, a human asks for one. There is no boot
 * scan, no timer, no debounce queue, and no tool-completion hook that starts a
 * scan. The complete set of paths that can start brain_scan.py is:
 *
 *   · POST /brain-scan                        operator or admin button
 *   · GET  /brain-data?rescan=1               the gateway's Refresh button
 *   · POST /volume-restore  (scan=1, default) part of an operator-run restore
 *   · script_execute on brain_scan.py         run it directly
 *
 * Everything else reads whatever ava_brain_data.json is already on the volume,
 * or reports honestly that no scan exists yet.
 *
 * What was removed in v12.36.0, and why
 * ---------------------------------------------------------------------------
 *   · bootScanIfMissing()  - spawned Python ~15s after every deploy or restart
 *                            whenever the volume had no scan. That is a
 *                            deployment-time trigger, which this policy forbids.
 *   · scheduleBrainScan()  - a 20s debounced rescan timer, plus the
 *     RESCAN_TRIGGERS set    RESCAN_TRIGGERS allowlist it fired for. Both were
 *                            already unreachable in v12.35.0 (nothing called
 *                            scheduleBrainScan), so removing them changes no
 *                            observable behaviour. They are deleted rather than
 *                            left dormant so a future edit to onToolCompleted
 *                            cannot silently reintroduce an automatic trigger.
 *
 * Jobs this module still does:
 *
 *   1. runBrainScan({ force, trigger })
 *      Spawns brain_scan.py, never more than one at a time. Callers may await
 *      the returned promise; a second caller arriving mid-scan joins the
 *      in-flight one rather than starting a competing process.
 *
 *   2. writeToolCatalog(tools)
 *      Writes the connector's own live tool registry to the volume at boot, so
 *      the scanner reads a catalogue that cannot disagree with the connector
 *      that produced it. This writes ONE small JSON file. It spawns nothing and
 *      is not a scan; it only makes the catalogue correct for whenever a manual
 *      scan is next requested. The scanner makes no network calls.
 *
 *   3. onToolCompleted(name, args, result)
 *      Called after every successful tool dispatch. It records the module set
 *      loaded by skill_compile so the visualiser can light up what is live this
 *      session. It NEVER starts a scan.
 *
 * Failure policy: a scan failure is logged and dropped. The Neural Core is an
 * observability surface. It must never be able to fail a module write.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildScriptEnv } from '../utils/scriptEnv.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AVA_DIR = process.env.AVA_MODULAR_DIR
  ? resolvePath(process.env.AVA_MODULAR_DIR)
  : '/data/skill/ava';

const SCRIPTS_DIR = process.env.SCRIPTS_DIR
  ? resolvePath(process.env.SCRIPTS_DIR)
  : join(AVA_DIR, 'scripts');

const SCANNER_PATH = join(SCRIPTS_DIR, 'brain_scan.py');
const DOWNLOADS_DIR = join(AVA_DIR, 'downloads');
const LAST_COMPILE_PATH = join(DOWNLOADS_DIR, 'last_compile.json');
const BRAIN_DATA_PATH = join(DOWNLOADS_DIR, 'ava_brain_data.json');
const TOOL_CATALOG_PATH = join(SCRIPTS_DIR, 'brain_tools_catalog.json');

const PYTHON_BIN = existsSync('/mise/shims/python3') ? '/mise/shims/python3' : 'python3';

/**
 * This connector's version, read from package.json rather than hardcoded.
 *
 * The catalogue records which connector produced it, and a hand-maintained
 * string here would be one more thing to forget: server-http.js already carries
 * two stale copies of the version. package.json is the one that is always right.
 */
const CONNECTOR_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));       // src/tools
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    return String(pkg.version || 'unknown');
  } catch (_) {
    return 'unknown';
  }
})();

// v12.36.0: RESCAN_TRIGGERS (the tool-name allowlist that invalidated the scan)
// and DEBOUNCE_MS (the 20s coalescing window) are deleted along with
// scheduleBrainScan(). They existed only to serve automatic rescans. Nothing
// referenced them once scheduleBrainScan() was removed, and leaving an unused
// allowlist behind is an invitation to wire it back up by accident.

/** Hard ceiling on scanner runtime. */
const SCAN_TIMEOUT_MS = 120000;

/**
 * The trigger policy this module implements, surfaced through
 * getBrainScanPaths() so /brain-data/status can state it rather than leaving
 * an operator to infer it from the absence of log lines.
 */
const TRIGGER_POLICY = 'manual-only';

/**
 * Every path permitted to start a scan, for diagnostics. Kept beside
 * TRIGGER_POLICY so the documented list and the reported list are one thing.
 */
const MANUAL_TRIGGERS = Object.freeze([
  'POST /brain-scan',
  'GET /brain-data?rescan=1',
  'POST /volume-restore (scan=1)',
  'script_execute brain_scan.py',
]);

/**
 * Enabled unless explicitly switched off.
 *
 * BRAIN_SCAN_ENABLED=false is a hard kill switch: it disables even the manual
 * triggers, which is what you want while debugging a scanner that is wedging
 * the volume. It is NOT the control for automatic scanning, because as of
 * v12.36.0 there is no automatic scanning to control.
 *
 * @returns {boolean}
 */
function isEnabled() {
  return process.env.BRAIN_SCAN_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scanRunning = false;
let scanQueued = false;
/** Label of the trigger that queued a rerun, carried into that rerun. */
let queuedTrigger = null;
/** The in-flight scan, so a second caller can wait on it instead of being told no. */
let inFlight = null;
let lastScanStarted = 0;
let lastScanFinished = 0;
/** Who asked for the current or most recent scan. Null until one is requested. */
let lastScanTrigger = null;
/** Outcome of the most recent completed scan: true, false, or null if none. */
let lastScanOk = null;
/** Total scans started since boot. Zero on a healthy idle instance. */
let scanCount = 0;
let logFn = () => {};

/**
 * Supply the connector's logger. Called once at startup.
 * @param {(level: string, message: string) => void} fn
 */
export function setBrainScanLogger(fn) {
  if (typeof fn === 'function') logFn = fn;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Run brain_scan.py once.
 *
 * This is the ONLY function in the connector that starts the scanner, and as of
 * v12.36.0 every one of its callers is a manual action: POST /brain-scan,
 * GET /brain-data?rescan=1, and the operator-run POST /volume-restore. Nothing
 * calls it on a timer, at boot, or from a tool-completion hook. Adding such a
 * caller would defeat the manual-only policy, so any new call site needs the
 * same scrutiny as adding a cron job.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] Rescan even when the output looks fresh.
 * @param {string} [options.trigger] Short label naming who asked, recorded for
 *   diagnostics and logged. Defaults to 'unspecified'.
 * @returns {Promise<boolean>} true when the scan exited 0.
 */
export async function runBrainScan(options = {}) {
  const trigger = (typeof options.trigger === 'string' && options.trigger.trim())
    ? options.trigger.trim().slice(0, 120)
    : 'unspecified';

  if (!isEnabled()) {
    logFn('info', `brain_scan: disabled by BRAIN_SCAN_ENABLED=false (requested by ${trigger})`);
    return false;
  }
  if (!existsSync(SCANNER_PATH)) {
    logFn('warn', `brain_scan: scanner not found at ${SCANNER_PATH} - skipping (requested by ${trigger})`);
    return false;
  }
  if (scanRunning) {
    // A scan is already up. A reader (GET /brain-data?rescan=1 arriving while an
    // operator's POST /brain-scan is still running) should wait for it rather
    // than be told the scan failed; a caller that needs a guaranteed-fresh pass
    // queues one rerun so its request is not lost inside the current pass.
    if (options.force) {
      scanQueued = true;
      queuedTrigger = trigger;
    }
    logFn('info', `brain_scan: already running (requested by ${trigger}) - joining the in-flight scan`);
    return inFlight || false;
  }

  scanRunning = true;
  scanCount += 1;
  lastScanStarted = Date.now();
  lastScanTrigger = trigger;
  logFn('info', `brain_scan: starting (trigger: ${trigger}${options.force ? ', forced' : ''})`);

  const args = [SCANNER_PATH, '--ava-dir', AVA_DIR];
  if (options.force) args.push('--force');

  inFlight = new Promise((resolveScan) => {
    let settled = false;
    let child;

    const finish = (ok, note) => {
      if (settled) return;
      settled = true;
      scanRunning = false;
      inFlight = null;
      lastScanFinished = Date.now();
      lastScanOk = ok;
      if (note) logFn(ok ? 'info' : 'warn', `brain_scan: ${note}`);
      if (scanQueued) {
        // One coalesced rerun for the request that arrived mid-scan. This is a
        // continuation of a manual request that was already made, not a new
        // automatic trigger: it cannot fire unless a caller asked while a scan
        // was in flight.
        scanQueued = false;
        const rerunTrigger = `${queuedTrigger || 'unspecified'} (queued rerun)`;
        queuedTrigger = null;
        const rerunTimer = setTimeout(() => {
          runBrainScan({ force: true, trigger: rerunTrigger }).catch((err) => {
            logFn('warn', `brain_scan: queued rerun failed: ${err.message}`);
          });
        }, 500);
        if (typeof rerunTimer.unref === 'function') rerunTimer.unref();
      }
      resolveScan(ok);
    };

    try {
      child = spawn(PYTHON_BIN, args, {
        cwd: SCRIPTS_DIR,
        // v12.28.0 (TNX-C-004): this module spawned Python with the connector's
// COMPLETE process environment. The audit cited only script-execute.js, but a
// verification sweep for the `...process.env` idiom found this site too. Every
// script run from here inherited ANTHROPIC_API_KEY, GOOGLE_REFRESH_TOKEN,
// SLACK_BOT_TOKEN, WP_APP_PASSWORD, RAILWAY_RESTORE_TOKEN, MCP_API_KEY and the
// rest. Replaced by the shared allowlist builder, which constructs the child
// environment from scratch rather than filtering process.env.
        env: buildScriptEnv({ scriptKey: 'brain_scan.py' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(false, `spawn failed: ${err.message}`);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString().slice(0, 4000); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 4000); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      finish(false, `timed out after ${SCAN_TIMEOUT_MS}ms`);
    }, SCAN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(false, `failed to start: ${err.message}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - lastScanStarted;
      if (code === 0) {
        let summary = 'completed';
        try {
          // stdout is a single pretty-printed JSON summary object.
          const parsed = JSON.parse(stdout.trim());
          summary = parsed.skipped
            ? 'no changes since last scan'
            : `${parsed.nodes || 0} nodes, ${parsed.links || 0} links`;
        } catch (_) {
          summary = 'completed (summary unparsed)';
        }
        finish(true, `${summary} in ${elapsed}ms`);
      } else {
        finish(false, `exited ${code} after ${elapsed}ms: ${stderr.trim().slice(-400)}`);
      }
    });
  });

  return inFlight;
}

// ---------------------------------------------------------------------------
// REMOVED in v12.36.0: bootScanIfMissing()
//
// It ran a catch-up scan 15 seconds after every boot whenever the volume had no
// ava_brain_data.json, or had an empty one. On Railway, where a redeploy is a
// fresh container, that made "deploy" a scan trigger, which is exactly what
// this change exists to stop.
//
// The behaviour it provided is not lost, only made explicit: a volume with no
// scan now reports that honestly through GET /brain-data and /brain-data/status,
// and one click of Refresh in the gateway (or POST /brain-scan) produces the
// scan. An operator decides when Python runs.
//
// describeScanState() below gives callers the same "is there a usable scan on
// disk" answer that bootScanIfMissing() used to act on, without acting on it.
// ---------------------------------------------------------------------------

/**
 * Report whether a usable scan exists on the volume, without starting one.
 *
 * @returns {{present: boolean, size: number, empty: boolean, error: string|null}}
 */
export function describeScanState() {
  try {
    if (!existsSync(BRAIN_DATA_PATH)) {
      return { present: false, size: 0, empty: false, error: null };
    }
    const { size } = statSync(BRAIN_DATA_PATH);
    return { present: true, size, empty: size === 0, error: null };
  } catch (err) {
    return { present: false, size: 0, empty: false, error: err.message };
  }
}

/**
 * Write the connector's live tool registry to the volume for the scanner.
 *
 * This is what keeps the catalogue and the connector in lockstep: the running
 * connector overwrites the file with its own definitions at every boot, so the
 * two cannot drift. The scanner never asks the network what tools exist.
 *
 * @param {Array<{name: string, description: string}>} tools Live tool definitions.
 * @param {string} [version] Connector version. Defaults to package.json's.
 * @returns {boolean} true when the catalogue was written.
 */
export function writeToolCatalog(tools, version) {
  if (!Array.isArray(tools) || !tools.length) {
    logFn('warn', 'brain_scan: no tools to write to the catalogue');
    return false;
  }

  const entries = tools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => {
      let description = String(tool.description || '').replace(/\s+/g, ' ').trim();
      if (description.length > 200) description = `${description.slice(0, 197).trimEnd()}...`;
      return { name: tool.name, description };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    _comment: 'Tool catalogue for brain_scan.py. Written by the connector at boot from its own live registry. Do not edit by hand: it is overwritten on every restart.',
    connector_version: version || CONNECTOR_VERSION,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tool_count: entries.length,
    tools: entries,
  };

  try {
    if (!existsSync(SCRIPTS_DIR)) mkdirSync(SCRIPTS_DIR, { recursive: true });
    const next = JSON.stringify(payload, null, 1);

    // Skip the write when only the timestamp would change: a pointless write is
    // a pointless mtime bump, and the scanner keys its early exit on mtimes.
    if (existsSync(TOOL_CATALOG_PATH)) {
      try {
        const current = JSON.parse(readFileSync(TOOL_CATALOG_PATH, 'utf8'));
        if (JSON.stringify(current.tools) === JSON.stringify(entries)
          && current.connector_version === payload.connector_version) {
          logFn('info', `brain_scan: tool catalogue already current (${entries.length} tools)`);
          return true;
        }
      } catch (_) {
        // Unreadable or not ours: overwrite it.
      }
    }

    const temp = `${TOOL_CATALOG_PATH}.tmp`;
    writeFileSync(temp, `${next}\n`, 'utf8');
    renameSync(temp, TOOL_CATALOG_PATH);
    logFn('info', `brain_scan: tool catalogue written (${entries.length} tools) -> ${TOOL_CATALOG_PATH}`);
    return true;
  } catch (err) {
    // Not fatal: the scanner degrades to an empty tool belt and says so.
    logFn('warn', `brain_scan: could not write the tool catalogue: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// REMOVED in v12.36.0: scheduleBrainScan()
//
// It set a 20-second debounced timer that called runBrainScan({ force: true }).
// No caller remained in v12.35.0 -- onToolCompleted() had already stopped
// invoking it -- so this deletion changes no observable behaviour today. It is
// removed rather than left in place because a dormant "schedule a scan"
// function is the single easiest way for an automatic trigger to return: one
// well-meaning line in onToolCompleted() and the policy is silently undone.
//
// If a future change genuinely needs a scan after a specific event, call
// runBrainScan({ force: true, trigger: '<name>' }) directly and deliberately, so
// the new trigger shows up in a diff and in /brain-data/status.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compile record
// ---------------------------------------------------------------------------

/**
 * Record what skill_compile loaded, so the visualiser can mark those modules
 * live. Written atomically: brain_scan.py may read it at any moment.
 *
 * @param {object} payload Parsed skill_compile result.
 * @returns {void}
 */
function writeCompileRecord(payload) {
  const modules = Array.isArray(payload.modules_loaded) ? payload.modules_loaded : [];
  if (!modules.length) return;

  const record = {
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    modules_loaded: modules.map(String),
    specialist_count: Number(payload.specialist_count) || modules.length,
    line_count: Number(payload.line_count) || 0,
    conditions_detected: Array.isArray(payload.conditions_detected) ? payload.conditions_detected : [],
  };

  try {
    if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });
    const temp = `${LAST_COMPILE_PATH}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(temp, LAST_COMPILE_PATH);
  } catch (err) {
    logFn('warn', `brain_scan: could not write last_compile.json: ${err.message}`);
  }
}

/**
 * Pull the JSON body out of an MCP tool result.
 *
 * @param {object} result MCP-format result.
 * @returns {object|null}
 */
function parseToolResult(result) {
  if (!result || result.isError || !Array.isArray(result.content)) return null;
  const block = result.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
  if (!block) return null;
  try {
    const parsed = JSON.parse(block.text);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Post-dispatch hook. Wrapped in its own try/catch by the caller, and again
 * here, because nothing in this file is allowed to fail a tool call.
 *
 * This hook is RECORD-ONLY and must stay that way. It writes last_compile.json
 * after skill_compile so the visualiser can mark loaded modules live. It does
 * not start a scan, and it must not be changed to start one: a tool call is not
 * a manual trigger, and a hook that scans turns ordinary use of the connector
 * back into an automatic scan schedule.
 *
 * @param {string} name   Tool name.
 * @param {object} args   Tool input. Unused; kept for hook-signature stability.
 * @param {object} result MCP-format result.
 * @returns {void}
 */
export function onToolCompleted(name, args, result) {
  if (!isEnabled()) return;

  try {
    if (name === 'skill_compile') {
      const payload = parseToolResult(result);
      if (payload) writeCompileRecord(payload);
    }

  } catch (err) {
    logFn('warn', `brain_scan: hook error after ${name}: ${err.message}`);
  }
}

/**
 * Paths and state, for GET /brain-data and diagnostics.
 *
 * @returns {object}
 */
export function getBrainScanPaths() {
  return {
    avaDir: AVA_DIR,
    scriptsDir: SCRIPTS_DIR,
    scannerPath: SCANNER_PATH,
    dataPath: BRAIN_DATA_PATH,
    lastCompilePath: LAST_COMPILE_PATH,
    toolCatalogPath: TOOL_CATALOG_PATH,
    scannerPresent: existsSync(SCANNER_PATH),
    toolCatalogPresent: existsSync(TOOL_CATALOG_PATH),
    scanRunning,
    lastScanStarted: lastScanStarted || null,
    connectorVersion: CONNECTOR_VERSION,
    enabled: isEnabled(),
    // v12.36.0 trigger policy and provenance.
    triggerPolicy: TRIGGER_POLICY,
    manualTriggers: MANUAL_TRIGGERS,
    automaticTriggers: [],
    bootScanEnabled: false,
    scheduledScanEnabled: false,
    lastScanTrigger,
    lastScanFinished: lastScanFinished || null,
    lastScanOk,
    scanCount,
  };
}
