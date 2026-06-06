// src/tools/skill-content.js  v2.0.0
// Content management tools for the Ava modular skill system.
//
// Ten tools across four content sections:
//   module_write      - Write or overwrite a module file by its relative path within modules/.
//                       Does NOT update MANIFEST.json (caller handles that separately).
//   archive_list      - List all files in /data/skill/ava/archive/  (flat directory)
//   archive_read      - Read a single archive file.
//   archive_write     - Write/update an archive file and push a backup to WordPress.
//   reference_list    - List all files in /data/skill/ava/references/ (recursive, subdirs supported)
//   reference_read    - Read a single reference file. Path may include subdir: "erp/config.md"
//   reference_write   - Write/update a reference file. Creates subdirs as needed.
//   script_list       - List all files in /data/skill/ava/scripts/ (recursive, subdirs supported)
//   script_read       - Read a single script file. Path may include subdir: "music-analysis/extract_audio.py"
//   script_write      - Write/update a script file. Creates subdirs as needed.
//
// Path support:
//   archive    - flat filenames only (filename.ext)
//   references - up to 3 levels deep (subdir/subdir2/filename.ext)
//   scripts    - up to 3 levels deep (subdir/subdir2/filename.ext)
//
// Railway volume layout:
//   /data/skill/ava/archive/
//   /data/skill/ava/references/
//   /data/skill/ava/references/erp/
//   /data/skill/ava/references/erp/platform-specific/
//   /data/skill/ava/references/music-analysis/
//   /data/skill/ava/references/recipe-scout/
//   /data/skill/ava/references/toolkit/
//   /data/skill/ava/scripts/
//   /data/skill/ava/scripts/music-analysis/
//   /data/skill/ava/scripts/recipe-scout/

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
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

// Validate a flat filename (archive only — no directory components).
function validateFilename(name) {
  if (!name || typeof name !== 'string') throw new Error('filename is required');
  const clean = basename(name.trim());
  if (!clean) throw new Error('filename resolves to empty after normalisation');
  if (clean.startsWith('.')) throw new Error('hidden filenames not permitted');
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) throw new Error(`Invalid characters in filename "${clean}"`);
  if (clean.length > 120) throw new Error('filename exceeds 120 characters');
  return clean;
}

// Validate a content path that may include subdirectories.
// Supports up to 3 levels: "filename.ext", "subdir/filename.ext",
// "subdir/subdir2/filename.ext", "subdir/subdir2/subdir3/filename.ext".
// No leading slash. No .. traversal. Alphanumeric + hyphens + underscores + dots only.
function validateContentPath(rawPath, allowedExtensions) {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('path is required');
  const clean = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) throw new Error('path is empty');
  if (clean.includes('..'))  throw new Error('Path traversal (..) not permitted');
  if (clean.includes('//'))  throw new Error('Double slashes not permitted');
  const parts = clean.split('/');
  if (parts.length > 4) throw new Error(`Path is too deep (max 3 subdirectory levels): "${clean}"`);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) throw new Error(`Empty path component in "${clean}"`);
    const validChars = i === parts.length - 1
      ? /^[a-zA-Z0-9_\-\.]+$/.test(part)  // filename: dots allowed
      : /^[a-zA-Z0-9_\-]+$/.test(part);    // directory: no dots
    if (!validChars) throw new Error(`Invalid characters in path component "${part}" of "${clean}"`);
    if (part.length > 120) throw new Error(`Path component "${part}" exceeds 120 characters`);
  }
  if (allowedExtensions && allowedExtensions.length > 0) {
    const ext = clean.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Extension ".${ext}" not permitted. Allowed: ${allowedExtensions.join(', ')}`);
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// WordPress backup helper
// ---------------------------------------------------------------------------

async function pushContentToWp(section, filePath, content, changeNote) {
  const wpSkillUrl = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey = process.env.WP_SKILL_KEY || '';
  if (!wpSkillUrl || !wpSkillKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpSkillUrl}/${section}`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Ava-Skill-Key': wpSkillKey,
        'User-Agent':      'claude-connector/11.5.0 (ava-skill-content-sync)',
      },
      body: JSON.stringify({
        filename:    filePath,   // may include subdirectory path
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
// Supports flat (archive) and recursive (references, scripts) layouts.
// ---------------------------------------------------------------------------

function listContentDirRecursive(baseDir, subPath) {
  const fullDir = subPath ? join(baseDir, subPath) : baseDir;
  if (!existsSync(fullDir)) return [];
  const results = [];
  for (const entry of readdirSync(fullDir)) {
    const entryPath = join(fullDir, entry);
    const relPath   = subPath ? `${subPath}/${entry}` : entry;
    try {
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        results.push(...listContentDirRecursive(baseDir, relPath));
      } else {
        results.push({
          filename:     relPath,
          size_bytes:   stats.size,
          line_count:   readFileSync(entryPath, 'utf8').split('\n').length,
          last_modified: stats.mtime.toISOString(),
        });
      }
    } catch { /* skip unreadable entries */ }
  }
  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}

function readContentFile(dirPath, filePath) {
  const fullPath = join(dirPath, filePath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
  return readFileSync(fullPath, 'utf8');
}

async function writeContentFile(dirPath, section, filePath, content, changeNote) {
  const fullPath = join(dirPath, filePath);
  const fileDir  = dirname(fullPath);
  if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
  const isNew = !existsSync(fullPath);
  writeFileSync(fullPath, content, 'utf8');
  const wpResult  = await pushContentToWp(section, filePath, content, changeNote);
  const lineCount = content.split('\n').length;
  return {
    success:    true,
    filename:   filePath,
    line_count: lineCount,
    action:     isNew ? 'created' : 'updated',
    wp_backup:  formatWpResult(wpResult),
    path:       fullPath,
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
      file:        { type: 'string', description: 'Relative path within modules/ directory, e.g. "music-analysis/music-analysis-somatic.md". Must be category/filename.md or filename.md. No leading slash.' },
      content:     { type: 'string', description: 'Full content to write to the file. Overwrites existing content if the file exists.' },
      change_note: { type: 'string', description: 'Brief description of the change (used for WP backup metadata). Optional.' },
    },
    required: ['file', 'content'],
  },
};

export const archiveListToolDefinition = {
  name: 'archive_list',
  description: 'List all files stored in the Ava archive directory on the Railway volume (/data/skill/ava/archive/). ' +
    'Returns filename, size, line count, and last modified date for each file. ' +
    'The archive holds IFA session records, OSC documents, and long-form conversation archives. Archive is flat (no subdirectories).',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const archiveReadToolDefinition = {
  name: 'archive_read',
  description: 'Read a specific file from the Ava archive directory on the Railway volume. Archive is flat — filename only, no path separators.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Filename within the archive directory (e.g. "INSTALLATION_PF37-OSC.md"). No path separators.' },
    },
    required: ['filename'],
  },
};

export const archiveWriteToolDefinition = {
  name: 'archive_write',
  description: 'Write or update a file in the Ava archive directory on the Railway volume. Immediately backs up to WordPress. Archive is flat — filename only, no subdirectories.',
  inputSchema: {
    type: 'object',
    properties: {
      filename:    { type: 'string', description: 'Filename within the archive directory. Must end with .md or .txt. No path separators.' },
      content:     { type: 'string', description: 'Full content to write to the file.' },
      change_note: { type: 'string', description: 'Brief description of the change. Optional.' },
    },
    required: ['filename', 'content'],
  },
};

export const referenceListToolDefinition = {
  name: 'reference_list',
  description: 'List all files stored in the Ava references directory on the Railway volume (/data/skill/ava/references/). ' +
    'Returns relative paths including subdirectories (e.g. "erp/configuration-instructions-template.md", ' +
    '"recipe-scout/dietary_preferences.md"). Subdirectory structure: erp/, erp/platform-specific/, ' +
    'music-analysis/, recipe-scout/, toolkit/.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const referenceReadToolDefinition = {
  name: 'reference_read',
  description: 'Read a specific file from the Ava references directory on the Railway volume. ' +
    'Path may include subdirectory: "erp/configuration-instructions-template.md", ' +
    '"erp/platform-specific/dynamics365-fo-config-patterns.md", "music-analysis/music-analysis-skill-guide.md".',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Relative path within references/ (e.g. "erp/hallucination-checklists.md" or "recipe-scout/nutrition.md"). May include one or two subdirectory levels.' },
    },
    required: ['filename'],
  },
};

export const referenceWriteToolDefinition = {
  name: 'reference_write',
  description: 'Write or update a file in the Ava references directory on the Railway volume. ' +
    'Creates subdirectories as needed. Immediately backs up to WordPress. ' +
    'Path may include subdirectory: "erp/new-guide.md", "recipe-scout/new-file.md".',
  inputSchema: {
    type: 'object',
    properties: {
      filename:    { type: 'string', description: 'Relative path within references/. May include up to 3 subdirectory levels. E.g. "erp/new-guide.md" or "erp/platform-specific/new-platform.md".' },
      content:     { type: 'string', description: 'Full content to write to the file.' },
      change_note: { type: 'string', description: 'Brief description of the change. Optional.' },
    },
    required: ['filename', 'content'],
  },
};

export const scriptListToolDefinition = {
  name: 'script_list',
  description: 'List all files stored in the Ava scripts directory on the Railway volume (/data/skill/ava/scripts/). ' +
    'Returns relative paths including subdirectories. Current structure: ' +
    'music-analysis/ (extract_somatic.py, extract_audio.py, extract_midi.py) and ' +
    'recipe-scout/ (recipe_card.py, meal_plan_card.py, weight_loss_calculator.py, etc.).',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const scriptReadToolDefinition = {
  name: 'script_read',
  description: 'Read a specific file from the Ava scripts directory on the Railway volume. ' +
    'Path must include subdirectory: "music-analysis/extract_somatic.py", "music-analysis/extract_audio.py", ' +
    '"recipe-scout/recipe_card.py".',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Relative path within scripts/ including subdirectory (e.g. "music-analysis/extract_somatic.py" or "recipe-scout/weight_loss_calculator.py").' },
    },
    required: ['filename'],
  },
};

export const scriptWriteToolDefinition = {
  name: 'script_write',
  description: 'Write or update a script file in the Ava scripts directory on the Railway volume. ' +
    'Creates subdirectories as needed. Immediately backs up to WordPress. ' +
    'Path must include subdirectory: "music-analysis/new_script.py".',
  inputSchema: {
    type: 'object',
    properties: {
      filename:    { type: 'string', description: 'Relative path within scripts/ including subdirectory (e.g. "music-analysis/new_script.py"). Accepted extensions: .py, .sh, .js, .ts, .txt, .md.' },
      content:     { type: 'string', description: 'Full content to write to the file.' },
      change_note: { type: 'string', description: 'Brief description of the change. Optional.' },
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
  const cleanPath  = validateContentPath(file, ['md', 'json']);
  const paths      = getContentPaths();
  const fullPath   = join(paths.modulesDir, cleanPath);
  const dir        = dirname(fullPath);
  const wpSkillUrl = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey = process.env.WP_SKILL_KEY || '';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const isNew = !existsSync(fullPath);
  writeFileSync(fullPath, content, 'utf8');
  let wpResult = { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  if (wpSkillUrl && wpSkillKey) {
    try {
      const res = await fetch(`${wpSkillUrl}/modules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ava-Skill-Key': wpSkillKey, 'User-Agent': 'claude-connector/11.5.0 (ava-module-write)' },
        body: JSON.stringify({ file: cleanPath, content, change_note: change_note || '', timestamp: new Date().toISOString(), line_count: content.split('\n').length }),
      });
      wpResult = res.ok ? { ok: true } : { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
    } catch (err) { wpResult = { ok: false, error: err.message }; }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, file: cleanPath, action: isNew ? 'created' : 'updated', line_count: content.split('\n').length, path: fullPath, wp_backup: formatWpResult(wpResult), note: isNew ? 'Module file created. Remember to add an entry to MANIFEST.json if this is a new module for the dispatcher.' : 'Module file updated.' }, null, 2) }] };
}

export function handleArchiveList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDirRecursive(paths.archiveDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'archive', path: paths.archiveDir, file_count: files.length, files }, null, 2) }] };
}

export function handleArchiveRead(args) {
  const { filename } = args;
  const clean   = validateFilename(filename);
  const paths   = getContentPaths();
  const content = readContentFile(paths.archiveDir, clean);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'archive', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
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
  const files = listContentDirRecursive(paths.referencesDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'references', path: paths.referencesDir, file_count: files.length, files }, null, 2) }] };
}

export function handleReferenceRead(args) {
  const { filename } = args;
  const clean   = validateContentPath(filename, ['md', 'txt', 'json']);
  const paths   = getContentPaths();
  const content = readContentFile(paths.referencesDir, clean);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'references', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
}

export async function handleReferenceWrite(args) {
  const { filename, content, change_note } = args;
  const clean  = validateContentPath(filename, ['md', 'txt', 'json']);
  const paths  = getContentPaths();
  const result = await writeContentFile(paths.referencesDir, 'references', clean, content, change_note);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function handleScriptList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDirRecursive(paths.scriptsDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'scripts', path: paths.scriptsDir, file_count: files.length, files }, null, 2) }] };
}

export function handleScriptRead(args) {
  const { filename } = args;
  const clean   = validateContentPath(filename, ['py', 'sh', 'js', 'ts', 'txt', 'md', 'json']);
  const paths   = getContentPaths();
  const content = readContentFile(paths.scriptsDir, clean);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'scripts', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
}

export async function handleScriptWrite(args) {
  const { filename, content, change_note } = args;
  const clean  = validateContentPath(filename, ['py', 'sh', 'js', 'ts', 'txt', 'md', 'json']);
  const paths  = getContentPaths();
  const result = await writeContentFile(paths.scriptsDir, 'scripts', clean, content, change_note);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Restore handlers — called by server-http.js restore endpoints.
// Body: { files: { "relative/path.ext": "content" }, change_summary?, source? }
// Supports subdirectory paths for references and scripts.
// ---------------------------------------------------------------------------

function buildRestoreHandler(sectionLabel, getDirFn, validateFn) {
  return async function restoreFromWp(body) {
    const files = body.files || {};
    if (typeof files !== 'object' || Array.isArray(files)) {
      return { success: false, error: 'files must be an object mapping path to content' };
    }
    const fileEntries = Object.entries(files);
    if (fileEntries.length === 0) {
      return { success: false, error: 'files object is empty' };
    }
    const paths    = getContentPaths();
    const baseDir  = getDirFn(paths);
    const results  = {};
    let   success  = 0;
    let   failures = 0;
    for (const [rawName, content] of fileEntries) {
      try {
        const clean    = validateFn(rawName);
        const fullPath = join(baseDir, clean);
        const fileDir  = dirname(fullPath);
        if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
        writeFileSync(fullPath, typeof content === 'string' ? content : String(content), 'utf8');
        results[rawName] = { ok: true };
        success++;
      } catch (err) {
        results[rawName] = { ok: false, error: err.message };
        failures++;
        log('warn', `restore-${sectionLabel}: failed to write "${rawName}": ${err.message}`);
      }
    }
    return { success: true, section: sectionLabel, files_restored: success, files_failed: failures, results, source: body.source || 'wordpress-push', timestamp: new Date().toISOString() };
  };
}

export const handleArchiveRestoreFromWp   = buildRestoreHandler('archive',    p => p.archiveDir,    validateFilename);
export const handleReferenceRestoreFromWp = buildRestoreHandler('references', p => p.referencesDir, p => validateContentPath(p, ['md', 'txt', 'json']));
export const handleScriptRestoreFromWp    = buildRestoreHandler('scripts',    p => p.scriptsDir,    p => validateContentPath(p, ['py', 'sh', 'js', 'ts', 'txt', 'md', 'json']));
