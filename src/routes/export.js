// src/routes/export.js
//
// GET /export-all
//
// Walks /data/skill/ava/ recursively and streams a ZIP back.
// Uses Python's zipfile via child_process (no npm dependencies needed).
// Additive only - does not modify any existing routes or files.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';

const EXPORT_BASE = '/data/skill/ava';

export function registerExportRoute(app) {
  app.get('/export-all', (req, res) => {
    if (!fs.existsSync(EXPORT_BASE)) {
      return res.status(404).json({ error: 'Skill directory not found' });
    }

    const zipPath = `/tmp/ava-export-${Date.now()}.zip`;

    try {
      // Use Python's built-in zipfile - no npm install needed
      const script = `
import os, zipfile, sys
base = '${EXPORT_BASE}'
out = '${zipPath}'
count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(base):
        for f in files:
            full = os.path.join(root, f)
            arcname = os.path.relpath(full, '/data/skill')
            zf.write(full, arcname)
            count += 1
print(f'{count} files')
`;
      execSync(`python3 -c "${script.replace(/\n/g, '; ')}"`, { timeout: 30000 });

      if (!fs.existsSync(zipPath)) {
        return res.status(500).json({ error: 'Failed to create ZIP' });
      }

      const stat = fs.statSync(zipPath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="ava-full-export-${new Date().toISOString().slice(0, 10)}.zip"`);
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);

      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch (_) {}
      });

      log('info', `[export] Streamed ZIP: ${stat.size} bytes`);
    } catch (err) {
      log('error', `[export] Failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  log('info', '[export] GET /export-all route registered');
}