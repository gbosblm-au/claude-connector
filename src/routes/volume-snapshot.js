// src/routes/volume-snapshot.js  (claude-connector v12.22.0)
//
// Volume snapshot endpoints for the TrueSource Client Gateway
// "Connector Snapshots" feature.
//
// These replace the manual pre-deployment and post-deployment Railway console
// commands:
//
//   BEFORE:  cd /data/skill && tar czf /tmp/connector-backup-$(date ...).tar.gz \
//              ava/CORE.md ava/MANIFEST.json ... ../downloads/
//   AFTER:   cd /data/skill && tar xzf /tmp/connector-backup-*.tar.gz \
//              && mkdir -p /data/downloads && chmod 777 /data/downloads \
//              && cd /data/skill/ava/scripts && python brain_scan.py
//
// Two defects in that manual pair are fixed here:
//
//   1. GNU tar rewrites '../downloads/' to 'downloads/' on create ("Removing
//      leading `../' from member names"), so 'cd /data/skill && tar xzf'
//      extracted the artefacts to /data/skill/downloads, not /data/downloads.
//      Every restore silently lost them: the reaper, DOWNLOADS_DIR and the
//      GET /download/:filename route all read /data/downloads. This module
//      namespaces members explicitly and maps them to the correct directory.
//
//   2. 'tar xzf /tmp/connector-backup-*.tar.gz' passes multiple -f arguments
//      when more than one backup is present, and only the last one is used.
//      Restores here always name exactly one archive.
//
// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------
//
//   GET  /volume-snapshot          Build and stream a tar.gz of this volume.
//   POST /volume-restore           Accept a tar.gz, extract it, run brain_scan.
//   GET  /volume-snapshot/status   Diagnostics: paths, sizes, tool availability.
//
// All three require the X-Railway-Restore-Token header, compared in constant
// time. The token may also be supplied as ?token= for GET requests, matching
// the existing /brain-data convention.
//
// ---------------------------------------------------------------------------
// ENVIRONMENT
// ---------------------------------------------------------------------------
//
//   SNAPSHOT_ENABLED                 'false' disables all three routes.
//   SNAPSHOT_MAX_MB                  Upload size ceiling. Default 256.
//   SNAPSHOT_MAX_UNCOMPRESSED_MB     Extraction size ceiling. Default 1024.
//   SNAPSHOT_TMP_DIR                 Scratch directory. Default /tmp.
//   SNAPSHOT_TIMEOUT_MS              Python helper timeout. Default 300000.
//   DOWNLOADS_DIR                    Artefact directory. Default /data/downloads.
//
// No npm dependencies are added. Archive work is done by the sibling
// volume_snapshot.py, spawned with an argv array rather than a shell string.

import { spawn }             from 'node:child_process';
import { timingSafeEqual }   from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
}                            from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath }     from 'node:url';

import express               from 'express';

import { log }               from '../utils/logger.js';
import { getModularPaths }   from '../tools/skill-modular.js';
import { runBrainScan, getBrainScanPaths } from '../tools/brain-scan-trigger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE          = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH   = join(HERE, 'volume_snapshot.py');

const RESTORE_TOKEN = process.env.RAILWAY_RESTORE_TOKEN || '';

const MAX_MB              = clampInt(process.env.SNAPSHOT_MAX_MB, 256, 1, 4096);
const MAX_UNCOMPRESSED_MB = clampInt(process.env.SNAPSHOT_MAX_UNCOMPRESSED_MB, 1024, 1, 16384);
const TIMEOUT_MS          = clampInt(process.env.SNAPSHOT_TIMEOUT_MS, 300000, 10000, 1800000);
const TMP_DIR             = process.env.SNAPSHOT_TMP_DIR || '/tmp';

/** Python interpreter, matching the detection used by brain-scan-trigger.js. */
const PYTHON_BIN = existsSync('/mise/shims/python3') ? '/mise/shims/python3' : 'python3';

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isEnabled() {
  return process.env.SNAPSHOT_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the directories this connector should capture and restore.
 *
 * avaDir is taken from getModularPaths() so it is always the directory this
 * connector actually reads from. On an owner-mode connector that is
 * /data/skill/ava; on a tenant-mode connector it is /data/clients/<tenant_id>.
 * The archive is namespaced logically, so the same archive restores correctly
 * onto either layout.
 *
 * @returns {{avaDir: string, downloadsDir: string, tenantId: string, isTenantMode: boolean}}
 */
export function resolveSnapshotPaths() {
  const modular = getModularPaths();

  // getModularPaths() returns a trailing slash. Normalise it away so the
  // Python helper and the log lines agree on one form.
  const avaDir = resolvePath(String(modular.avaDir || '/data/skill/ava/'));

  const downloadsDir = resolvePath(
    String(process.env.DOWNLOADS_DIR || '/data/downloads/'),
  );

  return {
    avaDir,
    downloadsDir,
    tenantId:     modular.tenantId || '',
    isTenantMode: Boolean(modular.isTenantMode),
  };
}

/** This connector's version, read from package.json. */
function connectorVersion() {
  try {
    return String(getBrainScanPaths().connectorVersion || 'unknown');
  } catch (_) {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Constant-time token comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, which would itself
 * leak the token length, so both sides are hashed to a fixed width first by
 * padding to the longer length before comparison. Lengths are compared
 * separately and folded into the result.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');

  if (b.length === 0) return false;

  const width   = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(width, 0);
  const paddedB = Buffer.alloc(width, 0);
  a.copy(paddedA);
  b.copy(paddedB);

  const equalContent = timingSafeEqual(paddedA, paddedB);
  return equalContent && a.length === b.length;
}

/**
 * Enforce token auth on a request. Sends the error response itself.
 *
 * @returns {boolean} true when the caller may proceed.
 */
function authorise(req, res) {
  if (!isEnabled()) {
    res.status(503).json({
      error: 'Volume snapshots are disabled. Unset SNAPSHOT_ENABLED=false to enable them.',
    });
    return false;
  }

  if (!RESTORE_TOKEN) {
    res.status(503).json({
      error: 'RAILWAY_RESTORE_TOKEN is not set in Railway Variables. Snapshot endpoints are unauthenticated and therefore refuse to run.',
    });
    return false;
  }

  const provided = String(
    req.headers['x-railway-restore-token'] || req.query.token || '',
  ).trim();

  if (!tokenMatches(provided, RESTORE_TOKEN)) {
    log('warn', `[volume-snapshot] rejected ${req.method} ${req.path}: bad or missing token`);
    res.status(401).json({ error: 'Invalid or missing X-Railway-Restore-Token.' });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Python helper invocation
// ---------------------------------------------------------------------------

/**
 * Run volume_snapshot.py with an argv array and parse its JSON result.
 *
 * Never uses a shell, so no argument can be interpreted as a command.
 *
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, data: object, stderr: string}>}
 */
function runHelper(args) {
  return new Promise((resolve) => {
    if (!existsSync(HELPER_PATH)) {
      resolve({
        ok:     false,
        data:   { error: `volume_snapshot.py is missing at ${HELPER_PATH}. Redeploy the connector.` },
        stderr: '',
      });
      return;
    }

    let child;
    try {
      child = spawn(PYTHON_BIN, [HELPER_PATH, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, data: { error: `cannot start python: ${err.message}` }, stderr: '' });
      return;
    }

    let stdout   = '';
    let stderr   = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({
        ok:     false,
        data:   { error: `volume_snapshot.py timed out after ${TIMEOUT_MS} ms.` },
        stderr,
      });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      // Cap buffered stdout so a runaway helper cannot exhaust memory.
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, data: { error: `python failed to run: ${err.message}` }, stderr });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim() || '{}');
      } catch (_) {
        parsed = null;
      }

      if (!parsed) {
        resolve({
          ok:   false,
          data: {
            error: `volume_snapshot.py produced unparseable output (exit ${code}).`,
            stdout_preview: stdout.slice(0, 500),
          },
          stderr,
        });
        return;
      }

      resolve({ ok: code === 0 && parsed.error === undefined, data: parsed, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function tempPath(suffix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand  = Math.random().toString(36).slice(2, 10);
  return join(TMP_DIR, `connector-snapshot-${stamp}-${rand}${suffix}`);
}

function safeUnlink(path) {
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    log('warn', `[volume-snapshot] could not remove temp file ${path}: ${err.message}`);
  }
}

function readBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVolumeSnapshotRoutes(app) {
  // -------------------------------------------------------------------------
  // GET /volume-snapshot
  //
  // Builds a tar.gz of the ava directory plus the downloads directory and
  // streams it back. The archive is deleted once the response completes.
  //
  // Query:
  //   include_downloads  '0' to capture the ava directory only. Default '1'.
  //   exclude            Repeatable basename to skip, e.g. ?exclude=versions
  //
  // Response headers carry the metadata WordPress records against the stored
  // archive, so the body itself stays a plain tar.gz:
  //   X-Snapshot-Sha256, X-Snapshot-File-Count, X-Snapshot-Ava-File-Count,
  //   X-Snapshot-Downloads-File-Count, X-Snapshot-Layout-Version,
  //   X-Snapshot-Connector-Version, X-Snapshot-Tenant-Id
  // -------------------------------------------------------------------------
  app.get('/volume-snapshot', async (req, res) => {
    if (!authorise(req, res)) return;

    const paths            = resolveSnapshotPaths();
    const includeDownloads = readBool(req.query.include_downloads, true);

    if (!existsSync(paths.avaDir)) {
      return res.status(503).json({
        error:   `ava content directory not found at ${paths.avaDir}. There is nothing to snapshot.`,
        ava_dir: paths.avaDir,
      });
    }

    const excludes = []
      .concat(req.query.exclude || [])
      .filter((value) => typeof value === 'string' && value.length > 0 && value.length < 128)
      .slice(0, 32);

    const outPath = tempPath('.tar.gz');

    const args = [
      'create',
      '--out',                  outPath,
      '--ava-dir',              paths.avaDir,
      '--downloads-dir',        paths.downloadsDir,
      '--include-downloads',    includeDownloads ? '1' : '0',
      '--max-uncompressed-mb',  String(MAX_UNCOMPRESSED_MB),
      '--connector-version',    connectorVersion(),
      '--tenant-id',            paths.tenantId,
    ];
    for (const name of excludes) args.push('--exclude', name);

    const started = Date.now();
    const result  = await runHelper(args);

    if (!result.ok) {
      safeUnlink(outPath);
      log('error', `[volume-snapshot] create failed: ${result.data.error || 'unknown'} ${result.stderr.slice(0, 300)}`);
      return res.status(500).json({
        error:  result.data.error || 'Snapshot creation failed.',
        stderr: result.stderr.slice(0, 1000) || undefined,
      });
    }

    if (!existsSync(outPath)) {
      return res.status(500).json({ error: 'Snapshot helper reported success but produced no archive.' });
    }

    let size;
    try {
      size = statSync(outPath).size;
    } catch (err) {
      safeUnlink(outPath);
      return res.status(500).json({ error: `Cannot stat the archive: ${err.message}` });
    }

    const filename = `connector-snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.tar.gz`;

    res.setHeader('Content-Type',                    'application/gzip');
    res.setHeader('Content-Length',                  String(size));
    res.setHeader('Content-Disposition',             `attachment; filename="${filename}"`);
    res.setHeader('X-Snapshot-Sha256',               String(result.data.sha256 || ''));
    res.setHeader('X-Snapshot-File-Count',           String(result.data.file_count || 0));
    res.setHeader('X-Snapshot-Ava-File-Count',       String(result.data.ava_file_count || 0));
    res.setHeader('X-Snapshot-Downloads-File-Count', String(result.data.downloads_file_count || 0));
    res.setHeader('X-Snapshot-Uncompressed-Bytes',   String(result.data.uncompressed_bytes || 0));
    res.setHeader('X-Snapshot-Layout-Version',       String(result.data.layout_version || 1));
    res.setHeader('X-Snapshot-Connector-Version',    connectorVersion());
    res.setHeader('X-Snapshot-Tenant-Id',            paths.tenantId);
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Snapshot-Sha256, X-Snapshot-File-Count, X-Snapshot-Ava-File-Count, X-Snapshot-Downloads-File-Count, X-Snapshot-Uncompressed-Bytes, X-Snapshot-Layout-Version, X-Snapshot-Connector-Version, X-Snapshot-Tenant-Id',
    );

    const stream  = createReadStream(outPath);
    let   cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      safeUnlink(outPath);
    };

    stream.on('error', (err) => {
      log('error', `[volume-snapshot] stream error: ${err.message}`);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy();
    });

    // 'close' fires on both success and client abort, so the temp file is
    // removed either way.
    res.on('close', cleanup);
    stream.on('end', cleanup);

    log(
      'info',
      `[volume-snapshot] created ${result.data.file_count} files, ${size} bytes in ${Date.now() - started} ms (downloads=${includeDownloads ? 'yes' : 'no'})`,
    );

    stream.pipe(res);
  });

  // -------------------------------------------------------------------------
  // POST /volume-restore
  //
  // Body: the raw tar.gz, Content-Type application/gzip or
  //       application/octet-stream.
  //
  // Query:
  //   scan               '0' to skip brain_scan.py. Default '1'.
  //   exclude_personal   '1' to skip PERSONALITY.md and PROFILES.md. The
  //                      WordPress plugin sets this for client tenants so a
  //                      restore of the owner connector's archive cannot
  //                      overwrite a client's own personal files.
  //   include_downloads  '0' to skip the downloads namespace. Default '1'.
  // -------------------------------------------------------------------------
  app.post(
    '/volume-restore',
    express.raw({ type: () => true, limit: `${MAX_MB}mb` }),
    async (req, res) => {
      if (!authorise(req, res)) return;

      const body = req.body;

      if (!Buffer.isBuffer(body)) {
        // The global express.json() parser consumed it, which only happens when
        // the caller sent Content-Type: application/json.
        return res.status(415).json({
          error: 'Send the archive as a raw body with Content-Type: application/octet-stream or application/gzip.',
        });
      }

      if (body.length === 0) {
        return res.status(400).json({ error: 'Request body is empty. Send the tar.gz archive as the raw body.' });
      }

      // gzip magic number. Rejects a mistaken JSON or ZIP upload before any
      // file is written to the volume.
      if (body.length < 3 || body[0] !== 0x1f || body[1] !== 0x8b) {
        return res.status(400).json({
          error: 'Body is not a gzip archive (missing 1f 8b magic bytes). Expected a .tar.gz produced by GET /volume-snapshot.',
        });
      }

      const paths            = resolveSnapshotPaths();
      const runScan          = readBool(req.query.scan, true);
      const excludePersonal  = readBool(req.query.exclude_personal, false);
      const includeDownloads = readBool(req.query.include_downloads, true);

      const archivePath = tempPath('.tar.gz');

      try {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(archivePath, body);
      } catch (err) {
        safeUnlink(archivePath);
        log('error', `[volume-restore] cannot buffer upload: ${err.message}`);
        return res.status(500).json({ error: `Cannot write the uploaded archive to ${TMP_DIR}: ${err.message}` });
      }

      const started = Date.now();
      const result  = await runHelper([
        'extract',
        '--archive',              archivePath,
        '--ava-dir',              paths.avaDir,
        '--downloads-dir',        paths.downloadsDir,
        '--include-downloads',    includeDownloads ? '1' : '0',
        '--exclude-personal',     excludePersonal ? '1' : '0',
        '--max-uncompressed-mb',  String(MAX_UNCOMPRESSED_MB),
      ]);

      safeUnlink(archivePath);

      if (!result.ok) {
        log('error', `[volume-restore] extraction failed: ${result.data.error || 'unknown'} ${result.stderr.slice(0, 300)}`);
        return res.status(500).json({
          error:  result.data.error || 'Extraction failed.',
          stderr: result.stderr.slice(0, 1000) || undefined,
        });
      }

      const extractMs = Date.now() - started;

      log(
        'info',
        `[volume-restore] wrote ${result.data.files_written} files (${result.data.ava_files_written} ava, ${result.data.downloads_files_written} downloads), ${result.data.rejected_count} rejected, in ${extractMs} ms`,
      );

      if (result.data.rejected_count > 0) {
        log('warn', `[volume-restore] rejected members: ${(result.data.rejected || []).join(' | ').slice(0, 800)}`);
      }

      // ---- brain_scan -------------------------------------------------------
      // Equivalent to the manual 'cd /data/skill/ava/scripts && python
      // brain_scan.py' step. A scan failure never fails the restore: the files
      // are already on the volume and the scan is an observability artefact.
      //
      // v12.36.0 note on the manual-only trigger policy: this call survives it,
      // and is not an exception to it. A restore is an operator action started
      // by a human pressing Restore, and `scan` defaults to '1' only within
      // that action. Nothing here runs on a timer or at deploy. Pass scan=0 to
      // restore without scanning.
      let scan = { requested: runScan, ran: false, ok: false, message: 'Not requested.' };

      if (runScan) {
        const brainPaths = getBrainScanPaths();
        if (!brainPaths.scannerPresent) {
          scan = {
            requested: true,
            ran:       false,
            ok:        false,
            message:   `brain_scan.py not found at ${brainPaths.scannerPath}. The archive may not have contained scripts/brain_scan.py.`,
          };
          log('warn', `[volume-restore] ${scan.message}`);
        } else {
          try {
            const ok = await runBrainScan({ force: true, trigger: 'POST /volume-restore' });
            scan = {
              requested: true,
              ran:       true,
              ok:        Boolean(ok),
              message:   ok
                ? 'brain_scan.py completed and ava_brain_data.json was refreshed.'
                : 'brain_scan.py ran but reported a failure. Check the connector logs.',
            };
          } catch (err) {
            scan = {
              requested: true,
              ran:       true,
              ok:        false,
              message:   `brain_scan.py threw: ${err.message}`,
            };
            log('warn', `[volume-restore] ${scan.message}`);
          }
        }
      }

      return res.json({
        success:                  true,
        files_written:            result.data.files_written,
        ava_files_written:        result.data.ava_files_written,
        downloads_files_written:  result.data.downloads_files_written,
        skipped:                  result.data.skipped,
        rejected_count:           result.data.rejected_count,
        rejected:                 result.data.rejected,
        ava_dir:                  result.data.ava_dir,
        downloads_dir:            result.data.downloads_dir,
        tenant_mode:              paths.isTenantMode,
        tenant_id:                paths.tenantId,
        exclude_personal:         excludePersonal,
        extract_ms:               extractMs,
        source_manifest:          result.data.source_manifest,
        brain_scan:               scan,
        message: `${result.data.files_written} files restored`
          + (result.data.rejected_count ? `, ${result.data.rejected_count} members rejected` : '')
          + `. ${scan.message}`,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /volume-snapshot/status
  //
  // Cheap diagnostics for the WordPress admin page. Reports which directories
  // exist, whether the helper and the scanner are deployed, and the configured
  // ceilings, so a failed restore can be diagnosed without shell access.
  // -------------------------------------------------------------------------
  app.get('/volume-snapshot/status', (req, res) => {
    if (!authorise(req, res)) return;

    const paths      = resolveSnapshotPaths();
    const brainPaths = getBrainScanPaths();

    return res.json({
      enabled:                    isEnabled(),
      connector_version:          connectorVersion(),
      ava_dir:                    paths.avaDir,
      ava_dir_present:            existsSync(paths.avaDir),
      downloads_dir:              paths.downloadsDir,
      downloads_dir_present:      existsSync(paths.downloadsDir),
      tenant_mode:                paths.isTenantMode,
      tenant_id:                  paths.tenantId,
      helper_path:                HELPER_PATH,
      helper_present:             existsSync(HELPER_PATH),
      python_bin:                 PYTHON_BIN,
      scanner_path:               brainPaths.scannerPath,
      scanner_present:            brainPaths.scannerPresent,
      brain_data_present:         existsSync(brainPaths.dataPath),
      max_upload_mb:              MAX_MB,
      max_uncompressed_mb:        MAX_UNCOMPRESSED_MB,
      helper_timeout_ms:          TIMEOUT_MS,
      tmp_dir:                    TMP_DIR,
      layout_version:             1,
    });
  });

  log(
    'info',
    `[volume-snapshot] routes registered: GET /volume-snapshot, POST /volume-restore, GET /volume-snapshot/status (max upload ${MAX_MB} MB)`,
  );
}
