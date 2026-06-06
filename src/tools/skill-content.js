// src/tools/skill-content.js  v1.0.0
// Content management tools for the Ava modular skill system.
//
// Ten tools across four content sections:
//   module_write      - Write or overwrite a module file by its relative path within modules/.
//                       Does NOT update MANIFEST.json (caller handles that separately).
//   archive_list      - List all files in /data/skill/ava/archive/
//   archive_read      - Read a single archive file.
//   archive_write     - Write/update an archive file and push a backup to WordPress.
//   reference_list    - List all files in /data/skill/ava/references/
//   reference_read    - Read a single reference file.
//   reference_write   - Write/update a reference file and push a backup to WordPress.
//   script_list       - List all files in /data/skill/ava/scripts/
//   script_read       - Read a single script file.
//   script_write      - Write/update a script file and push a backup to WordPress.
//
// All paths are derived from SKILL_FILE_PATH env var (same base as skill-modular.js).
// Railway volume layout additions:
//   /data/skill/ava/archive/      - IFA session archives, conversation logs, OSC records
//   /data/skill/ava/references/   - Reference materials, skill guides, research docs
//   /data/skill/ava/scripts/      - Python and shell scripts (extract_somatic.py, etc.)
//
// WordPress backup:
//   archive_write  -> POST {WP_SKILL_URL}/archive
//   reference_write -> POST {WP_SKILL_URL}/references
//   script_write   -> POST {WP_SKILL_URL}/scripts
//   module_write   -> POST {WP_SKILL_URL}/modules (uses existing modules endpoint)
//
// Restore handlers (called by server-http.js restore endpoints):
//   handleArchiveRestoreFromWp(body)    - POST /restore-archive
//   handleReferenceRestoreFromWp(body)  - POST /restore-references
//   handleScriptRestoreFromWp(body)     - POST /restore-scripts

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getContentPaths() {
  const skillFilePath = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  const baseDir       = skillFilePath.replace(/SKILL\.md$/, '');
  const avaDir        = baseDir + 'ava/';
  return {
    avaDir,
    archiveDir:    avaDir + 'archive/',
    referencesDir: avaDir + 'references/',
    scriptsDir:    avaDir + 'scripts/',
    modulesDir:    avaDir + 'modules/',
  };
}

function ensureContentDirs(paths) {
  for (const dir of [paths.avaDir, paths.archiveDir, paths.referencesDir, paths.scriptsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// Validate a filename (basename only — no directory components, no traversal).
// Returns cleaned name or throws.
function validateFilename(name) {
  if (!name || typeof name !== 'string') throw new Error('filename is required');
  const clean = basename(name.trim());
  if (!clean) throw new Error('filename resolves to empty after normalisation');
  if (clean.startsWith('.') && clean !== '.gitkeep') throw new Error('hidden filenames not permitted');
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) throw new Error(`Invalid characters in filename "${clean}". Use a-z, A-Z, 0-9, hyphens, underscores, dots.`);
  if (clean.length > 120) throw new Error('filename exceeds 120 characters');
  return clean;
}

// Validate a module-relative path (e.g. "music-analysis/music-analysis-somatic.md").
// Allows one level of category subdirectory.
function validateModulePath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('file path is required');
  const clean = filePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) throw new Error('Path traversal not permitted');
  if (clean.includes('//')) throw new Error('Double slashes not permitted');
  if (!/^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-\.]+)?$/.test(clean)) {
    throw new Error(`Invalid module path "${clean}". Use: category/filename.md or filename.md`);
  }
  if (!clean.endsWith('.md') && !clean.endsWith('.json')) {
    throw new Error('Module files must have .md or .json extension');
  }
  return clean;
}

// ---------------------------------------------------------------------------
// WordPress backup helper
// ---------------------------------------------------------------------------

async function pushContentToWp(section, filename, content, changeNote) {
  const wpSkillUrl = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey = process.env.WP_SKILL_KEY || '';
  if (!wpSkillUrl || !wpSkillKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpSkillUrl}/${section}`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Ava-Skill-Key': wpSkillKey,
        'User-Agent':      'claude-connector/11.4.0 (ava-skill-content-sync)',
      },
      body: JSON.stringify({
        filename,
        content,
        change_note: changeNote || '',
        timestamp:   new Date().toISOString(),
        line_count:  content.split('\n').length,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatWpResult(r) {
  if (r.skipped) return 'WP backup skipped: not configured';
  if (r.ok)      return 'WP backup ok';
  return `WP backup failed: ${r.error || String(r.status || 'unknown')}`;
}

// ---------------------------------------------------------------------------
// Generic list / read / write for a content directory
// ---------------------------------------------------------------------------

function listContentDir(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter(f => {
      try {
        return statSync(join(dirPath, f)).isFile();
      } catch { return false; }
    })
    .map(f => {
      const full  = join(dirPath, f);
      const stats = statSync(full);
      return {
        filename:     f,
        size_bytes:   stats.size,
        line_count:   readFileSync(full, 'utf8').split('\n').length,
        last_modified: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

function readContentFile(dirPath, filename) {
  const filePath = join(dirPath, filename);
  if (!existsSync(filePath)) throw new Error(`File not found: ${filename}`);
  return readFileSync(filePath, 'utf8');
}

async function writeContentFile(dirPath, section, filename, content, changeNote) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  const filePath    = join(dirPath, filename);
  const isNew       = !existsSync(filePath);
  writeFileSync(filePath, content, 'utf8');
  const wpResult    = await pushContentToWp(section, filename, content, changeNote);
  const lineCount   = content.split('\n').length;
  return {
    success:    true,
    filename,
    line_count: lineCount,
    action:     isNew ? 'created' : 'updated',
    wp_backup:  formatWpResult(wpResult),
    path:       filePath,
  };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const moduleWriteToolDefinition = {
  name: 'module_write',
  description: 'Write or overwrite a module file on the Railway volume by its relative path within modules/ ' +
    '(e.g. "music-analysis/music-analysis-somatic.md" or "philosophy/new-topic.md"). ' +
    'Use this to directly edit or create modular skill files without leaving Claude. ' +
    'Does NOT automatically update MANIFEST.json — run skill_audit or update the manifest separately after creating a new module. ' +
    'Backs up the updated file to WordPress.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Relative path within modules/ directory, e.g. "music-analysis/music-analysis-somatic.md". ' +
          'Must be category/filename.md or filename.md. No leading slash.',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file. Overwrites existing content if the file exists.',
      },
      change_note: {
        type: 'string',
        description: 'Brief description of the change (used for WP backup metadata). Optional.',
      },
    },
    required: ['file', 'content'],
  },
};

export const archiveListToolDefinition = {
  name: 'archive_list',
  description: 'List all files stored in the Ava archive directory on the Railway volume (/data/skill/ava/archive/). ' +
    'Returns filename, size, line count, and last modified date for each file. ' +
    'The archive holds IFA session records, OSC documents, and long-form conversation archives.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const archiveReadToolDefinition = {
  name: 'archive_read',
  description: 'Read a specific file from the Ava archive directory on the Railway volume.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the archive directory (e.g. "PF37-OSC-record.md"). No path separators.',
      },
    },
    required: ['filename'],
  },
};

export const archiveWriteToolDefinition = {
  name: 'archive_write',
  description: 'Write or update a file in the Ava archive directory on the Railway volume. ' +
    'Immediately backs up to WordPress. The archive is for IFA session records, OSC documents, ' +
    'and long-form conversation archives that need to persist outside the memory store.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the archive directory. Must end with .md or .txt. No path separators.',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file.',
      },
      change_note: {
        type: 'string',
        description: 'Brief description of the change for metadata. Optional.',
      },
    },
    required: ['filename', 'content'],
  },
};

export const referenceListToolDefinition = {
  name: 'reference_list',
  description: 'List all files stored in the Ava references directory on the Railway volume (/data/skill/ava/references/). ' +
    'Returns filename, size, line count, and last modified date for each file. ' +
    'References hold skill guides, research documents, and reference materials used during sessions.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const referenceReadToolDefinition = {
  name: 'reference_read',
  description: 'Read a specific file from the Ava references directory on the Railway volume.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the references directory (e.g. "music-analysis-skill-guide.md"). No path separators.',
      },
    },
    required: ['filename'],
  },
};

export const referenceWriteToolDefinition = {
  name: 'reference_write',
  description: 'Write or update a file in the Ava references directory on the Railway volume. ' +
    'Immediately backs up to WordPress. Use for skill guides, research documents, and ' +
    'reference materials that should persist on Railway and be available during sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the references directory. No path separators.',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file.',
      },
      change_note: {
        type: 'string',
        description: 'Brief description of the change. Optional.',
      },
    },
    required: ['filename', 'content'],
  },
};

export const scriptListToolDefinition = {
  name: 'script_list',
  description: 'List all files stored in the Ava scripts directory on the Railway volume (/data/skill/ava/scripts/). ' +
    'Returns filename, size, line count, and last modified date for each file. ' +
    'Scripts holds Python and shell scripts used in sessions (e.g. extract_somatic.py, extract_audio.py).',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const scriptReadToolDefinition = {
  name: 'script_read',
  description: 'Read a specific file from the Ava scripts directory on the Railway volume.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the scripts directory (e.g. "extract_somatic.py"). No path separators.',
      },
    },
    required: ['filename'],
  },
};

export const scriptWriteToolDefinition = {
  name: 'script_write',
  description: 'Write or update a script file in the Ava scripts directory on the Railway volume. ' +
    'Immediately backs up to WordPress. Accepts .py, .sh, .js, .ts, and .txt files. ' +
    'Use for Python extraction scripts, shell utilities, and other executable content.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename within the scripts directory. No path separators.',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file.',
      },
      change_note: {
        type: 'string',
        description: 'Brief description of the change. Optional.',
      },
    },
    required: ['filename', 'content'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleModuleWrite(args) {
  const { file, content, change_note } = args;
  if (!content || typeof content !== 'string') throw new Error('content is required');

  const cleanPath    = validateModulePath(file);
  const paths        = getContentPaths();
  const fullPath     = join(paths.modulesDir, cleanPath);
  const dir          = fullPath.replace(/[/\\][^/\\]+$/, '');
  const wpSkillUrl   = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey   = process.env.WP_SKILL_KEY || '';

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const isNew = !existsSync(fullPath);
  writeFileSync(fullPath, content, 'utf8');

  // WP backup via existing modules endpoint (sends individual file payload)
  let wpResult = { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  if (wpSkillUrl && wpSkillKey) {
    try {
      const res = await fetch(`${wpSkillUrl}/modules`, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Ava-Skill-Key': wpSkillKey,
          'User-Agent':      'claude-connector/11.4.0 (ava-module-write)',
        },
        body: JSON.stringify({
          file:         cleanPath,
          content,
          change_note:  change_note || '',
          timestamp:    new Date().toISOString(),
          line_count:   content.split('\n').length,
        }),
      });
      wpResult = res.ok ? { ok: true } : { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
    } catch (err) {
      wpResult = { ok: false, error: err.message };
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success:    true,
        file:       cleanPath,
        action:     isNew ? 'created' : 'updated',
        line_count: content.split('\n').length,
        path:       fullPath,
        wp_backup:  formatWpResult(wpResult),
        note:       isNew
          ? 'Module file created. Remember to add an entry to MANIFEST.json if this is a new module for the dispatcher.'
          : 'Module file updated.',
      }, null, 2),
    }],
  };
}

export function handleArchiveList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDir(paths.archiveDir);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:     'archive',
        path:        paths.archiveDir,
        file_count:  files.length,
        files,
      }, null, 2),
    }],
  };
}

export function handleArchiveRead(args) {
  const { filename } = args;
  const clean        = validateFilename(filename);
  const paths        = getContentPaths();
  const content      = readContentFile(paths.archiveDir, clean);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:    'archive',
        filename:   clean,
        line_count: content.split('\n').length,
        content,
      }, null, 2),
    }],
  };
}

export async function handleArchiveWrite(args) {
  const { filename, content, change_note } = args;
  const clean  = validateFilename(filename);
  const paths  = getContentPaths();
  const result = await writeContentFile(paths.archiveDir, 'archive', clean, content, change_note);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function handleReferenceList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDir(paths.referencesDir);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:     'references',
        path:        paths.referencesDir,
        file_count:  files.length,
        files,
      }, null, 2),
    }],
  };
}

export function handleReferenceRead(args) {
  const { filename } = args;
  const clean        = validateFilename(filename);
  const paths        = getContentPaths();
  const content      = readContentFile(paths.referencesDir, clean);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:    'references',
        filename:   clean,
        line_count: content.split('\n').length,
        content,
      }, null, 2),
    }],
  };
}

export async function handleReferenceWrite(args) {
  const { filename, content, change_note } = args;
  const clean  = validateFilename(filename);
  const paths  = getContentPaths();
  const result = await writeContentFile(paths.referencesDir, 'references', clean, content, change_note);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function handleScriptList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDir(paths.scriptsDir);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:     'scripts',
        path:        paths.scriptsDir,
        file_count:  files.length,
        files,
      }, null, 2),
    }],
  };
}

export function handleScriptRead(args) {
  const { filename } = args;
  const clean        = validateFilename(filename);
  const paths        = getContentPaths();
  const content      = readContentFile(paths.scriptsDir, clean);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        section:    'scripts',
        filename:   clean,
        line_count: content.split('\n').length,
        content,
      }, null, 2),
    }],
  };
}

export async function handleScriptWrite(args) {
  const { filename, content, change_note } = args;
  const clean  = validateFilename(filename);
  const paths  = getContentPaths();
  const result = await writeContentFile(paths.scriptsDir, 'scripts', clean, content, change_note);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Restore handlers — called by server-http.js restore endpoints
// Body shape: { files: { "filename.ext": "content" }, change_summary?, source? }
// ---------------------------------------------------------------------------

function buildRestoreHandler(sectionLabel, getDirFn) {
  return async function restoreFromWp(body) {
    const files = body.files || {};
    if (typeof files !== 'object' || Array.isArray(files)) {
      return { success: false, error: 'files must be an object mapping filename to content' };
    }
    const fileEntries = Object.entries(files);
    if (fileEntries.length === 0) {
      return { success: false, error: 'files object is empty' };
    }

    const paths = getContentPaths();
    ensureContentDirs(paths);
    const dir   = getDirFn(paths);

    const results  = {};
    let   success  = 0;
    let   failures = 0;

    for (const [rawName, content] of fileEntries) {
      try {
        const clean    = validateFilename(rawName);
        const filePath = join(dir, clean);
        writeFileSync(filePath, typeof content === 'string' ? content : String(content), 'utf8');
        results[rawName] = { ok: true };
        success++;
      } catch (err) {
        results[rawName] = { ok: false, error: err.message };
        failures++;
        log('warn', `restore-${sectionLabel}: failed to write "${rawName}": ${err.message}`);
      }
    }

    return {
      success:         true,
      section:         sectionLabel,
      files_restored:  success,
      files_failed:    failures,
      results,
      source:          body.source || 'wordpress-push',
      timestamp:       new Date().toISOString(),
    };
  };
}

export const handleArchiveRestoreFromWp   = buildRestoreHandler('archive',    p => p.archiveDir);
export const handleReferenceRestoreFromWp = buildRestoreHandler('references', p => p.referencesDir);
export const handleScriptRestoreFromWp    = buildRestoreHandler('scripts',    p => p.scriptsDir);
