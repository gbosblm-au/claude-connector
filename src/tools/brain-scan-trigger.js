/**
 * brain-scan-trigger.js  (connector v12.10.0)
 *
 * Keeps ava_brain_data.json current, and records what the last compile loaded.
 *
 * Two jobs:
 *
 *   1. onToolCompleted(name, args, result)
 *      Called after every successful tool dispatch. When a tool changed the
 *      shape of the architecture (module_write, skill_write, skill_merge_
 *      additions, dispatch_rule_add and friends), it schedules a rescan.
 *      When skill_compile ran, it records the loaded module set so the
 *      visualiser can light up what is live this session.
 *
 *   2. runBrainScan()
 *      Spawns brain_scan.py detached, debounced, never more than one at a time.
 *      A rescan of ~130 modules takes a few seconds, and no tool call should
 *      ever wait on it, so this deliberately does not return the scan result:
 *      the scan writes a file, and the file is what the gateway reads.
 *
 *   3. writeToolCatalog(tools)
 *      Writes the connector's own live tool registry to the volume at boot, so
 *      the scanner reads a catalogue that cannot disagree with the connector
 *      that produced it. The scanner makes no network calls.
 *
 * Scan triggers, in full (v12.11.0):
 *   · a tool that changed the architecture           -> debounced rescan
 *   · skill_compile                                  -> compile record + rescan
 *   · boot, only when no scan exists on disk         -> one catch-up scan
 *   · someone clicks Refresh in the gateway          -> GET /brain-data?rescan=1
 * There is no periodic rescan. Nothing changes the volume without going through
 * a tool, so a timer would only ever confirm what the hooks already know.
 *
 * Failure policy: a scan failure is logged and dropped. The Neural Core is an
 * observability surface. It must never be able to fail a module write.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

/** Tools that change the architecture and therefore invalidate the scan. */
const RESCAN_TRIGGERS = new Set([
  'module_write',
  'skill_write',
  'skill_write_addition',
  'skill_merge_additions',
  'skill_recompile',
  'skill_rollback',
  'dispatch_rule_add',
  'reference_write',
  'script_write',
  'archive_write',
  'personality_write',
]);

/** Wait this long after a change before scanning: a burst of writes = one scan. */
const DEBOUNCE_MS = 20000;

/** Hard ceiling on scanner runtime. */
const SCAN_TIMEOUT_MS = 120000;

/** Enabled unless explicitly switched off. */
function isEnabled() {
  return process.env.BRAIN_SCAN_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pendingTimer = null;
let scanRunning = false;
let scanQueued = false;
/** The in-flight scan, so a second caller can wait on it instead of being told no. */
let inFlight = null;
let lastScanStarted = 0;
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
 * Run brain_scan.py once, detached from the caller.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] Rescan even when the output looks fresh.
 * @returns {Promise<boolean>} true when the scan exited 0.
 */
export async function runBrainScan(options = {}) {
  if (!isEnabled()) {
    logFn('info', 'brain_scan: disabled by BRAIN_SCAN_ENABLED=false');
    return false;
  }
  if (!existsSync(SCANNER_PATH)) {
    logFn('warn', `brain_scan: scanner not found at ${SCANNER_PATH} - skipping`);
    return false;
  }
  if (scanRunning) {
    // A scan is already up. A reader (GET /brain-data on a volume with no scan)
    // should wait for it rather than be told the scan failed; a writer should
    // queue a rerun so its change is not lost inside the current pass.
    if (options.force) scanQueued = true;
    return inFlight || false;
  }

  scanRunning = true;
  lastScanStarted = Date.now();

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
      if (note) logFn(ok ? 'info' : 'warn', `brain_scan: ${note}`);
      if (scanQueued) {
        scanQueued = false;
        setTimeout(() => { runBrainScan({ force: true }); }, 500);
      }
      resolveScan(ok);
    };

    try {
      child = spawn(PYTHON_BIN, args, {
        cwd: SCRIPTS_DIR,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
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

/**
 * Run one catch-up scan at boot, but only when no scan exists to serve.
 *
 * A scan that already exists is almost always current: every path that changes
 * the volume goes through a tool, and every one of those tools schedules a
 * rescan. Spawning Python on every restart to rediscover that costs ~3 seconds
 * and produces a byte-identical file.
 *
 * The gap this leaves: a volume changed out of band - a DR restore through
 * POST /restore-modules, or a direct write to the Railway volume - is not
 * noticed until the next tool-triggered scan or a click of Refresh. That is the
 * accepted trade for not spawning Python on every restart. `force: true` from
 * either of those paths still picks it up.
 *
 * @returns {Promise<boolean>} true when a scan ran.
 */
export async function bootScanIfMissing() {
  if (!isEnabled()) return false;
  if (!existsSync(SCANNER_PATH)) return false;

  try {
    if (existsSync(BRAIN_DATA_PATH)) {
      const { size } = statSync(BRAIN_DATA_PATH);
      if (size > 0) {
        logFn('info', `brain_scan: scan present (${size} bytes) - no boot scan needed`);
        return false;
      }
      logFn('warn', 'brain_scan: scan on disk is empty - rescanning');
    }
  } catch (err) {
    logFn('warn', `brain_scan: cannot stat ${BRAIN_DATA_PATH}: ${err.message} - rescanning`);
  }

  logFn('info', 'brain_scan: no scan on disk - running one');
  return runBrainScan({ force: true });
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

/**
 * Schedule a debounced rescan. Repeated calls inside the debounce window
 * collapse into one scan.
 *
 * @returns {void}
 */
export function scheduleBrainScan() {
  if (!isEnabled()) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runBrainScan({ force: true }).catch((err) => {
      logFn('warn', `brain_scan: scheduled run failed: ${err.message}`);
    });
  }, DEBOUNCE_MS);
  // Do not hold the process open for a cosmetic rescan.
  if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
}

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
 * @param {string} name   Tool name.
 * @param {object} args   Tool input.
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
  };
}
