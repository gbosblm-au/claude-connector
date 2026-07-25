// src/routes/provision.js  v12.1.0
//
// POST /provision
//
// Receives a file payload from the TrueSource Client Gateway WordPress plugin
// and writes each file to the tenant's directory on the Railway volume.
//
// This endpoint is the write side of disaster recovery and initial provisioning.
// It is authenticated via the tenant API key (validated against the gateway).
//
// Request body:
// {
//   api_key: string,       The tenant's plain API key
//   files: [               Array of files to write
//     { path: string, content: string },
//     ...
//   ],
//   base_path?: string     Optional override for the root path.
//                          Defaults to /app/data/clients/{tenant_id}/
//                          Set to /app/data/ to write to the root (for shared files).
// }
//
// Response:
// {
//   files_written: number,
//   skipped:       number,
//   errors:        string[],
//   message:       string
// }
//
// File paths in the payload are relative and are resolved against base_path.
// Path traversal (../) is blocked.

import fs   from 'fs';
import path from 'path';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../utils/logger.js';

const GATEWAY_URL    = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
const CLIENT_MODE    = (process.env.TS_CLIENT_MODE || 'owner').toLowerCase();
const VOLUME_ROOT    = process.env.VOLUME_ROOT || '/app/data';
const RESTORE_TOKEN  = process.env.RAILWAY_RESTORE_TOKEN || '';

/**
 * Constant-time secret comparison.
 *
 * Both operands are padded to a common width before comparison because
 * timingSafeEqual throws on a length mismatch, and letting it throw would
 * itself disclose the expected length. Length equality is folded into the
 * result separately.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');

  if (b.length === 0) return false;

  const width   = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(width, 0);
  const paddedB = Buffer.alloc(width, 0);
  a.copy(paddedA);
  b.copy(paddedB);

  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

/**
 * Register the /provision route on the Express app.
 * Called from server-http.js during startup.
 */
export function registerProvisionRoute(app) {
  app.post('/provision', async (req, res) => {
    const { api_key, files, base_path: requestedBasePath } = req.body || {};

    // ── Validate input ────────────────────────────────────────────────────────
    if (!api_key || typeof api_key !== 'string') {
      return res.status(400).json({ error: 'api_key is required.' });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files must be a non-empty array.' });
    }

    // ── Authenticate via gateway or owner mode ────────────────────────────────
    let tenantId;

    if (CLIENT_MODE === 'owner') {
      // Owner mode: authenticate against RAILWAY_RESTORE_TOKEN, the same shared
      // secret every other administrative endpoint on this connector uses.
      //
      // SECURITY (v12.22.0): this branch previously accepted ANY non-empty
      // api_key string and then wrote caller-supplied paths under VOLUME_ROOT,
      // which is an unauthenticated arbitrary file write. It was never
      // exploitable in practice only because registerProvisionRoute() ran
      // inside the httpServer.listen() callback, after the catch-all 404
      // middleware, so every request to /provision returned 404. That ordering
      // defect is fixed in v12.22.0, so this hole is closed at the same time
      // rather than being activated along with the route.
      if (!RESTORE_TOKEN) {
        log('warn', '[provision] Refused: RAILWAY_RESTORE_TOKEN is not set, so owner-mode provisioning cannot be authenticated.');
        return res.status(503).json({
          error: 'RAILWAY_RESTORE_TOKEN is not set in Railway Variables. Owner-mode provisioning is disabled until it is configured.',
        });
      }

      const providedToken = String(
        req.headers['x-railway-restore-token'] || api_key || '',
      ).trim();

      if (!secretMatches(providedToken, RESTORE_TOKEN)) {
        log('warn', '[provision] Owner mode: rejected request with an invalid token.');
        return res.status(403).json({
          error: 'Authentication failed. Send the connector RAILWAY_RESTORE_TOKEN as api_key or in the X-Railway-Restore-Token header.',
        });
      }

      tenantId = process.env.TS_TENANT_ID || 'owner';
      log('info', `[provision] Owner mode: authenticated, provisioning as tenant=${tenantId}`);
    } else {
      // Tenant mode: validate via gateway
      const authResult = await validateKeyViaGateway(api_key);
      if (!authResult.valid) {
        return res.status(403).json({
          error: authResult.status === 'suspended'
            ? 'Account suspended. Contact TrueSource Consulting.'
            : 'Authentication failed.',
        });
      }
      tenantId = authResult.tenant_id;
      log('info', `[provision] Authenticated: tenant=${tenantId}, tier=${authResult.tier}`);
    }

    // ── Resolve base path ─────────────────────────────────────────────────────
    let basePath;
    if (requestedBasePath) {
      // Validate requested base path is within VOLUME_ROOT.
      //
      // SECURITY (v12.22.0): the previous check was
      // resolved.startsWith(VOLUME_ROOT), which is a prefix match rather than a
      // path-boundary match. With VOLUME_ROOT=/app/data it accepted
      // /app/data-evil. Comparing against VOLUME_ROOT + path.sep, and allowing
      // the root itself, checks the boundary properly.
      const rootAbs  = path.resolve(VOLUME_ROOT);
      const resolved = path.resolve(requestedBasePath);

      if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
        return res.status(400).json({ error: 'base_path must be within the volume root.' });
      }
      basePath = resolved;
    } else {
      basePath = path.join(VOLUME_ROOT, 'clients', tenantId);
    }

    // Resolved once here so every per-file containment check compares against
    // the same normalised absolute path.
    const basePathAbs = path.resolve(basePath);

    // ── Write files ───────────────────────────────────────────────────────────
    let filesWritten = 0;
    let skipped      = 0;
    const errors     = [];

    for (const file of files) {
      const { path: filePath, content } = file;

      if (!filePath || typeof filePath !== 'string') {
        errors.push(`Skipped entry with missing path.`);
        skipped++;
        continue;
      }

      // Block path traversal.
      //
      // SECURITY (v12.22.0): as with base_path above, the previous
      // resolved.startsWith(basePath) was a prefix match, so a sibling
      // directory sharing the base path's name as a prefix passed the check.
      const resolved = path.resolve(basePathAbs, filePath);
      if (resolved !== basePathAbs && !resolved.startsWith(basePathAbs + path.sep)) {
        errors.push(`Blocked path traversal attempt: ${filePath}`);
        skipped++;
        continue;
      }

      if (typeof content !== 'string') {
        errors.push(`${filePath}: content must be a string.`);
        skipped++;
        continue;
      }

      try {
        // Create directory if needed
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });

        // Write file
        fs.writeFileSync(resolved, content, 'utf8');
        filesWritten++;

        log('debug', `[provision] Wrote: ${resolved} (${content.length} bytes)`);
      } catch (err) {
        errors.push(`${filePath}: ${err.message}`);
        log('error', `[provision] Failed to write ${resolved}: ${err.message}`);
      }
    }

    const status = errors.length === 0 ? 'success'
                 : filesWritten === 0   ? 'failed'
                 : 'partial';

    log('info', `[provision] Complete: ${filesWritten} written, ${skipped} skipped, ${errors.length} errors. Status: ${status}`);

    return res.status(200).json({
      files_written: filesWritten,
      skipped,
      errors,
      status,
      tenant_id: tenantId,
      base_path: basePath,
      message: errors.length === 0
        ? `${filesWritten} files written successfully.`
        : `${filesWritten} files written, ${errors.length} error(s): ${errors.slice(0, 3).join('; ')}`,
    });
  });

  log('info', '[provision] POST /provision route registered');
}

// ── Gateway auth for provision endpoint ───────────────────────────────────────

async function validateKeyViaGateway(apiKey) {
  if (!GATEWAY_URL) {
    log('warn', '[provision] TS_TENANT_GATEWAY_URL not set. Cannot validate key.');
    return { valid: false, status: 'invalid' };
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/auth`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ api_key: apiKey }),
      signal:  AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return {
      valid:     data.valid === true,
      status:    data.status || 'invalid',
      tenant_id: data.tenant_id || '',
      tier:      data.tier || '',
    };
  } catch (err) {
    log('error', `[provision] Gateway auth failed: ${err.message}`);
    return { valid: false, status: 'gateway_error' };
  }
}
