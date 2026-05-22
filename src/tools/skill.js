// src/tools/skill.js  v10.4.0
// Four tools for Ava SKILL.md management on Railway persistent volume.
//
// skill_read     - Load SKILL.md (current, pending, or historical version) from volume.
// skill_write    - Write to SKILL.md or SKILL_PENDING.md with versioning and WP backup.
// skill_history  - List version history from the local history manifest.
// skill_rollback - Restore a previous version (creates a new version in the trail).
//
// File layout on Railway volume (/data/skill/ by default):
//   SKILL.md                         - live canonical file
//   SKILL_PENDING.md                 - PF session staging file
//   skill_meta.json                  - current version metadata
//   skill_history.json               - last 50 version headers (no content)
//   versions/
//     SKILL_YYYYMMDD_HHMMSS_vNNN.md  - archived version content
//
// Canonical writes archive the prior version, increment the version counter,
// update both JSON manifest files, and push a backup to the WordPress
// ts-ava-skill plugin.  WordPress backup failure is logged but non-blocking.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSkillPaths() {
  const filePath    = process.env.SKILL_FILE_PATH   || '/data/skill/SKILL.md';
  const versionDir  = process.env.SKILL_VERSION_DIR || '/data/skill/versions/';
  const metaPath    = process.env.SKILL_META_PATH   || '/data/skill/skill_meta.json';
  const pendingPath = filePath.replace(/SKILL\.md$/, 'SKILL_PENDING.md');
  const historyPath = filePath.replace(/SKILL\.md$/, 'skill_history.json');
  const wpSkillUrl  = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey  = process.env.WP_SKILL_KEY || '';
  return { filePath, versionDir, metaPath, pendingPath, historyPath, wpSkillUrl, wpSkillKey };
}

function ensureDirs(filePath, versionDir) {
  // Ensure /data/skill/ exists
  const skillDir = versionDir.replace(/[/\\]?versions[/\\]?$/, '');
  if (skillDir && !existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }
  // Ensure /data/skill/versions/ exists
  if (!existsSync(versionDir)) {
    mkdirSync(versionDir, { recursive: true });
  }
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readMeta(metaPath) {
  return readJsonFile(metaPath, {
    version_id:          'v000',
    version_number:      0,
    timestamp:           null,
    line_count:          0,
    change_summary:      'initial',
    previous_version_id: null,
  });
}

function readHistory(historyPath) {
  return readJsonFile(historyPath, { versions: [] });
}

function writeMeta(metaPath, meta) {
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function writeHistory(historyPath, historyObj) {
  writeFileSync(historyPath, JSON.stringify(historyObj, null, 2), 'utf8');
}

function padVersion(n) {
  return 'v' + String(n).padStart(3, '0');
}

function utcTimestampForFilename() {
  const now = new Date();
  const Y   = now.getUTCFullYear();
  const Mo  = String(now.getUTCMonth() + 1).padStart(2, '0');
  const D   = String(now.getUTCDate()).padStart(2, '0');
  const h   = String(now.getUTCHours()).padStart(2, '0');
  const m   = String(now.getUTCMinutes()).padStart(2, '0');
  const s   = String(now.getUTCSeconds()).padStart(2, '0');
  return `${Y}${Mo}${D}_${h}${m}${s}`;
}

function countLines(content) {
  if (!content) return 0;
  return content.split('\n').length;
}

/**
 * Archive the current canonical SKILL.md and return the archive filename.
 * Returns null when the file does not exist.
 */
function archiveCurrent(filePath, versionDir, currentVersionId) {
  if (!existsSync(filePath)) return null;
  const currentContent  = readFileSync(filePath, 'utf8');
  const tsFile          = utcTimestampForFilename();
  const archiveFilename = `SKILL_${tsFile}_${currentVersionId || 'v000'}.md`;
  writeFileSync(`${versionDir}${archiveFilename}`, currentContent, 'utf8');
  return archiveFilename;
}

/**
 * Push content + metadata to the WordPress ts-ava-skill plugin.
 * Non-blocking: errors are caught and returned as structured values.
 */
async function pushToWordPress(endpoint, content, meta, wpSkillUrl, wpSkillKey) {
  if (!wpSkillUrl || !wpSkillKey) {
    return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  }
  try {
    const body = JSON.stringify({
      content,
      version_id:     meta.version_id,
      line_count:     meta.line_count,
      change_summary: meta.change_summary,
      timestamp:      meta.timestamp,
    });
    const res = await fetch(`${wpSkillUrl}/${endpoint}`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Ava-Skill-Key': wpSkillKey,
        'User-Agent':      'claude-connector/10.4.0 (ava-skill-sync)',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatWpResult(wpResult) {
  if (wpResult.skipped)  return 'not configured';
  if (wpResult.ok)       return 'ok';
  return `failed: ${wpResult.error || String(wpResult.status || 'unknown')}`;
}

/**
 * Execute a full canonical write sequence shared by skill_write and skill_rollback.
 * Returns the structured result object ready to be returned to the caller.
 */
async function canonicalWrite(content, changeSummary, paths) {
  const { filePath, versionDir, metaPath, historyPath, wpSkillUrl, wpSkillKey } = paths;

  const meta          = readMeta(metaPath);
  const prevLineCount = meta.line_count || 0;
  const prevVersionId = meta.version_id || 'v000';

  const newVersionNumber = (meta.version_number || 0) + 1;
  const newVersionId     = padVersion(newVersionNumber);
  const ts               = new Date().toISOString();
  const newLineCount     = countLines(content);
  const lineDelta        = newLineCount - prevLineCount;

  // Archive current file
  const archivedAs = archiveCurrent(filePath, versionDir, prevVersionId);

  // Write new content
  writeFileSync(filePath, content, 'utf8');

  // Build and write new meta
  const newMeta = {
    version_id:          newVersionId,
    version_number:      newVersionNumber,
    timestamp:           ts,
    line_count:          newLineCount,
    change_summary:      changeSummary,
    previous_version_id: prevVersionId,
  };
  writeMeta(metaPath, newMeta);

  // Update history manifest (prepend, keep last 50)
  const historyObj = readHistory(historyPath);
  const newEntry   = {
    version_id:     newVersionId,
    timestamp:      ts,
    line_count:     newLineCount,
    line_delta:     lineDelta,
    change_summary: changeSummary,
  };
  historyObj.versions = [newEntry, ...(historyObj.versions || [])].slice(0, 50);
  writeHistory(historyPath, historyObj);

  // WordPress backup — non-blocking
  let wpResult = { skipped: true };
  try {
    wpResult = await pushToWordPress('update', content, newMeta, wpSkillUrl, wpSkillKey);
  } catch (err) {
    wpResult = { ok: false, error: err.message };
    log('warn', `skill canonical write WP backup failed: ${err.message}`);
  }

  log('info', `skill_write: ${newVersionId} (${newLineCount} lines, delta ${lineDelta > 0 ? '+' : ''}${lineDelta}) - ${changeSummary}`);

  return {
    success:             true,
    target:              'current',
    version_id:          newVersionId,
    line_count:          newLineCount,
    previous_line_count: prevLineCount,
    line_delta:          lineDelta,
    wordpress_backup:    formatWpResult(wpResult),
    archived_as:         archivedAs,
    change_summary:      changeSummary,
    timestamp:           ts,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const skillReadToolDefinition = {
  name: 'skill_read',
  description:
    'Load the Ava SKILL.md (or pending staging file, or a historical version) from ' +
    'Railway persistent volume. Call this at session start immediately after viewing ' +
    'the SKILL.md stub — this loads the full canonical skill. Returns full file content, ' +
    'version ID, line count, last modified timestamp, and change summary.',
  inputSchema: {
    type: 'object',
    properties: {
      pending: {
        type: 'boolean',
        description:
          'If true, reads SKILL_PENDING.md (PF session staging file) instead of ' +
          'the canonical SKILL.md. Default false.',
      },
      version_id: {
        type: 'string',
        description:
          'Version ID (e.g. "v038") to read a historical version from the archive. ' +
          'Only applies when pending is false. Omit to read the current canonical file.',
      },
    },
    required: [],
  },
};

export const skillWriteToolDefinition = {
  name: 'skill_write',
  description:
    'Write modified SKILL.md (or pending staging file) to Railway persistent volume. ' +
    'Canonical writes (pending=false) archive the prior version, increment the version ' +
    'counter, update both JSON manifests, and push a backup to WordPress. ' +
    'WordPress backup failure is logged but does not block success. ' +
    'Pending writes (pending=true) overwrite SKILL_PENDING.md with no versioning or ' +
    'backup. Pass empty string as content with pending=true to clear the staging file ' +
    'after an OSC merge.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Full new file content.',
      },
      change_summary: {
        type: 'string',
        description: 'Max 200 characters. What changed and why.',
      },
      pending: {
        type: 'boolean',
        description:
          'If true, writes to SKILL_PENDING.md instead of the canonical SKILL.md. ' +
          'Default false.',
      },
    },
    required: ['content', 'change_summary'],
  },
};

export const skillHistoryToolDefinition = {
  name: 'skill_history',
  description:
    'List version history for Ava SKILL.md on Railway persistent volume. ' +
    'Returns version headers (id, timestamp, line count, line delta, change summary). ' +
    'Content is not included in list view. To read a specific version\'s full content, ' +
    'call skill_read with the version_id.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Number of versions to return. Default 10, max 50.',
      },
    },
    required: [],
  },
};

export const skillRollbackToolDefinition = {
  name: 'skill_rollback',
  description:
    'Restore a previous version of Ava SKILL.md from the Railway archive. ' +
    'Reads the specified archived version, executes the full canonical write sequence ' +
    '(archives current file, writes restored content, increments version counter, ' +
    'pushes backup to WordPress). The rollback itself becomes a new version entry ' +
    'so the complete version trail is preserved.',
  inputSchema: {
    type: 'object',
    properties: {
      version_id: {
        type: 'string',
        description: 'Version ID to restore (e.g. "v038").',
      },
      change_summary: {
        type: 'string',
        description:
          'Reason for rollback. Becomes the change summary on the new version record. ' +
          'Max 200 characters.',
      },
    },
    required: ['version_id', 'change_summary'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSkillRead(args) {
  const paths     = getSkillPaths();
  const { filePath, versionDir, metaPath, pendingPath } = paths;
  const pending   = args.pending === true;
  const versionId = (args.version_id || '').trim();

  ensureDirs(filePath, versionDir);

  // ---- Historical version read ----
  if (!pending && versionId) {
    let found = null;
    if (existsSync(versionDir)) {
      const files = readdirSync(versionDir);
      for (const f of files) {
        const match = f.match(/_v(\d{3})\.md$/);
        if (match && `v${match[1]}` === versionId) {
          found = f;
          break;
        }
      }
    }
    if (!found) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error:      `Version ${versionId} not found in archive.`,
          hint:       'Call skill_history to list available versions.',
        }, null, 2) }],
        isError: true,
      };
    }
    const content = readFileSync(`${versionDir}${found}`, 'utf8');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        content,
        target:     'history',
        version_id: versionId,
        line_count: countLines(content),
        filename:   found,
      }, null, 2) }],
    };
  }

  // ---- Pending read ----
  if (pending) {
    if (!existsSync(pendingPath)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          content:    '',
          target:     'pending',
          line_count: 0,
          note:       'SKILL_PENDING.md does not exist — no pending additions.',
        }, null, 2) }],
      };
    }
    const content = readFileSync(pendingPath, 'utf8');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        content,
        target:     'pending',
        line_count: countLines(content),
      }, null, 2) }],
    };
  }

  // ---- Current canonical read ----
  if (!existsSync(filePath)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'SKILL.md not found on Railway volume. Use skill_write to seed the initial version.',
        path:  filePath,
        hint:  'Brian: upload the current SKILL.md in chat and call skill_write to initialise.',
      }, null, 2) }],
      isError: true,
    };
  }
  const content = readFileSync(filePath, 'utf8');
  const meta    = readMeta(metaPath);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      content,
      target:         'current',
      version_id:     meta.version_id,
      line_count:     countLines(content),
      last_modified:  meta.timestamp,
      change_summary: meta.change_summary,
    }, null, 2) }],
  };
}

export async function handleSkillWrite(args) {
  const paths         = getSkillPaths();
  const { versionDir, filePath, pendingPath } = paths;
  const content       = typeof args.content === 'string' ? args.content : '';
  const changeSummary = (args.change_summary || '').slice(0, 200);
  const pending       = args.pending === true;

  ensureDirs(filePath, versionDir);

  // ---- Pending write ----
  if (pending) {
    writeFileSync(pendingPath, content, 'utf8');
    const cleared = content === '';
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success:    true,
        target:     'pending',
        line_count: countLines(content),
        note:       cleared ? 'SKILL_PENDING.md cleared.' : 'SKILL_PENDING.md updated.',
      }, null, 2) }],
    };
  }

  // ---- Canonical write ----
  const result = await canonicalWrite(content, changeSummary, paths);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export async function handleSkillHistory(args) {
  const paths     = getSkillPaths();
  const { versionDir, filePath, metaPath, historyPath } = paths;
  const limit     = Math.min(50, Math.max(1, parseInt(args.limit || '10', 10)));

  ensureDirs(filePath, versionDir);

  const historyObj    = readHistory(historyPath);
  const allVersions   = historyObj.versions || [];
  const sliced        = allVersions.slice(0, limit);
  const currentMeta   = readMeta(metaPath);

  // Determine the current version entry (most recent canonical write)
  const currentVersion = currentMeta.version_id && currentMeta.version_id !== 'v000'
    ? {
        version_id:     currentMeta.version_id,
        timestamp:      currentMeta.timestamp,
        line_count:     currentMeta.line_count,
        change_summary: currentMeta.change_summary,
        is_current:     true,
      }
    : null;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      current_version: currentVersion,
      versions:        sliced,
      total_versions:  allVersions.length + (currentVersion ? 0 : 0), // history includes current
      limit_applied:   limit,
    }, null, 2) }],
  };
}

export async function handleSkillRollback(args) {
  const paths         = getSkillPaths();
  const { filePath, versionDir } = paths;
  const versionId     = (args.version_id || '').trim();
  const changeSummary = (args.change_summary || `Rollback to ${versionId}`).slice(0, 170);

  if (!versionId) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'version_id is required.',
      }, null, 2) }],
      isError: true,
    };
  }

  ensureDirs(filePath, versionDir);

  // Find the archived version file
  let targetFile = null;
  if (existsSync(versionDir)) {
    const files = readdirSync(versionDir);
    for (const f of files) {
      const match = f.match(/_v(\d{3})\.md$/);
      if (match && `v${match[1]}` === versionId) {
        targetFile = f;
        break;
      }
    }
  }

  if (!targetFile) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `Version ${versionId} not found in archive. Call skill_history to list available versions.`,
      }, null, 2) }],
      isError: true,
    };
  }

  // Read the target version content
  const restoredContent = readFileSync(`${versionDir}${targetFile}`, 'utf8');
  const rollbackSummary = `Rollback to ${versionId}: ${changeSummary}`;

  // Execute canonical write with the restored content
  const result = await canonicalWrite(restoredContent, rollbackSummary, paths);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      ...result,
      rolled_back_from: versionId,
      source_file:      targetFile,
    }, null, 2) }],
  };
}
