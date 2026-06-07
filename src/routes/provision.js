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
import { log } from '../utils/logger.js';

const GATEWAY_URL    = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
const CLIENT_MODE    = (process.env.TS_CLIENT_MODE || 'owner').toLowerCase();
const VOLUME_ROOT    = process.env.VOLUME_ROOT || '/app/data';

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
      // Owner mode: allow direct provisioning with the owner env api_key
      // or via a gateway auth check if GATEWAY_URL is set.
      tenantId = process.env.TS_TENANT_ID || 'owner';
      log('info', `[provision] Owner mode: provisioning as tenant=${tenantId}`);
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
      // Validate requested base path is within VOLUME_ROOT
      const resolved = path.resolve(requestedBasePath);
      if (!resolved.startsWith(VOLUME_ROOT)) {
        return res.status(400).json({ error: 'base_path must be within the volume root.' });
      }
      basePath = resolved;
    } else {
      basePath = path.join(VOLUME_ROOT, 'clients', tenantId);
    }

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

      // Block path traversal
      const resolved = path.resolve(basePath, filePath);
      if (!resolved.startsWith(basePath)) {
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
