// src/tools/skill-content.js  v2.1.0
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
// v12.28.0: `resolve` and `sep` were imported for the inline FIX 8 traversal
// guard. That guard now delegates to resolveContained, so both are orphaned
// and are removed rather than left as dead imports.
import { join, basename, dirname } from 'node:path';
// v12.28.0 (TNX-C-005): shared boundary-correct containment helper. See
// src/utils/pathContainment.js for why String.prototype.startsWith is not a
// directory boundary test and why symlink refusal is a separate, necessary
// control on top of any lexical check.
import { resolveContained } from '../utils/pathContainment.js';
import { log } from '../utils/logger.js';
import { deriveModuleEntry, writeModuleFragment } from './manifest-fragments.js';

// ---------------------------------------------------------------------------
// Typed validation error
//
// FIX 2: Validation failures (missing/wrong argument key, bad extension, path
// traversal) are client-class errors, not server faults. Throwing a plain
// Error caused them to escape uncaught to the dispatcher and surface as HTTP
// 500. This typed error lets each handler recognise a validation failure and
// convert it into a clean 400-shaped { error, code } result, while genuine
// internal failures still propagate and surface as 500.
// ---------------------------------------------------------------------------
class ToolValidationError extends Error {
  constructor(message, code = 'validation_error') {
    super(message);
    this.name = 'ToolValidationError';
    this.code = code;
    this.status = 400;
  }
}

// FIX 1: Argument-key aliasing.
//
// The gateway /tools manifest historically advertised `path` for the write
// tools before a rename to `filename`, so different call paths send `path`,
// `filename`, or (for module_write) `file` for the same logical argument. A
// single-key destructure receives `undefined` when the caller uses the other
// key, the validator then throws "filename is required" / "path is required",
// and the request fails. Resolving the first present string-valued key makes
// the handlers accept whichever key the caller sends.
function firstStringKey(args, ...keys) {
  if (!args || typeof args !== 'object') return undefined;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

// FIX 3: Content guard.
//
// The write handlers validated the path but never the body. Passing
// `undefined` (another key-drift symptom, or an omitted argument) to
// writeFileSync writes the literal string "undefined" as the entire file
// content, silent data corruption that is worse than an error. This guard
// rejects a missing, null, non-string, or empty body before any write. An
// empty string is rejected to preserve module_write's original `!content`
// behaviour and to keep the error message truthful.
function requireContent(content) {
  if (content === undefined || content === null || typeof content !== 'string' || content.length === 0) {
    throw new ToolValidationError('content is required and must be a non-empty string');
  }
  return content;
}

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
  if (!name || typeof name !== 'string') throw new ToolValidationError('filename is required');
  const clean = basename(name.trim());
  if (!clean) throw new ToolValidationError('filename resolves to empty after normalisation');
  if (clean.startsWith('.')) throw new ToolValidationError('hidden filenames not permitted');
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) throw new ToolValidationError(`Invalid characters in filename "${clean}"`);
  if (clean.length > 120) throw new ToolValidationError('filename exceeds 120 characters');
  return clean;
}

// Validate a content path that may include subdirectories.
// Supports up to 3 levels: "filename.ext", "subdir/filename.ext",
// "subdir/subdir2/filename.ext", "subdir/subdir2/subdir3/filename.ext".
// No leading slash. No .. traversal. Alphanumeric + hyphens + underscores + dots only.
function validateContentPath(rawPath, allowedExtensions) {
  if (!rawPath || typeof rawPath !== 'string') throw new ToolValidationError('path is required');
  const clean = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) throw new ToolValidationError('path is empty');
  if (clean.includes('..'))  throw new ToolValidationError('Path traversal (..) not permitted');
  if (clean.includes('//'))  throw new ToolValidationError('Double slashes not permitted');
  const parts = clean.split('/');
  if (parts.length > 4) throw new ToolValidationError(`Path is too deep (max 3 subdirectory levels): "${clean}"`);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) throw new ToolValidationError(`Empty path component in "${clean}"`);
    const validChars = i === parts.length - 1
      ? /^[a-zA-Z0-9_\-\.]+$/.test(part)  // filename: dots allowed
      : /^[a-zA-Z0-9_\-]+$/.test(part);    // directory: no dots
    if (!validChars) throw new ToolValidationError(`Invalid characters in path component "${part}" of "${clean}"`);
    if (part.length > 120) throw new ToolValidationError(`Path component "${part}" exceeds 120 characters`);
  }
  if (allowedExtensions && allowedExtensions.length > 0) {
    const ext = clean.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new ToolValidationError(`Extension ".${ext}" not permitted. Allowed: ${allowedExtensions.join(', ')}`);
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// WordPress backup helper
// ---------------------------------------------------------------------------

// FIX 5: The WordPress backup is a best-effort side effect and must never
// determine whether a write succeeds. Previously this call was awaited with no
// timeout, so a slow or hanging WordPress endpoint blocked the whole tool call
// up to the gateway request timeout and could itself surface as a 500/408. The
// request is now bounded by WP_SKILL_TIMEOUT_MS (default 8000ms); on timeout it
// returns a failed-but-non-fatal result and the write still completes.
function wpTimeoutMs() {
  const raw = Number(process.env.WP_SKILL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

async function pushContentToWp(section, filePath, content, changeNote) {
  const wpSkillUrl = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey = process.env.WP_SKILL_KEY || '';
  if (!wpSkillUrl || !wpSkillKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  const timeoutMs = wpTimeoutMs();
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      return { ok: false, error: `WP backup timed out after ${timeoutMs}ms` };
    }
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
  // FIX 8: Defensive traversal guard. Not every present or future call path is
  // guaranteed to run validateContentPath/validateFilename first, so re-verify
  // at the read boundary that the resolved target stays inside its section
  // directory before touching the filesystem.
  //
  // v12.28.0 (TNX-C-005): the original FIX 8 guard was
  //   resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + sep)
  // which IS boundary-correct -- the `+ sep` is what distinguishes it from the
  // defective bare-prefix idiom found elsewhere in this codebase, and it
  // correctly rejects the sibling-directory escape.
  //
  // It is replaced by the shared helper for two reasons. First, containment
  // logic in one audited place cannot drift between call sites, which is the
  // systemic problem the audit records in Section 5.1. Second, and materially,
  // resolve() is a purely lexical operation that never touches the filesystem,
  // so a symbolic link placed inside a section directory and pointing at, say,
  // /data or /app satisfied the old check and was then read. resolveContained
  // verifies physically with realpath and refuses symlinks.
  const fullPath = resolveContained(dirPath, filePath);
  if (!fullPath) {
    throw new ToolValidationError(`Path escapes content directory, or resolves through a symbolic link: ${filePath}`);
  }
  if (!existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
  return readFileSync(fullPath, 'utf8');
}

async function writeContentFile(dirPath, section, filePath, content, changeNote) {
  // v12.28.0 (TNX-C-005): the read path carried a traversal guard (FIX 8) but
  // the WRITE path carried none, which is the more consequential of the two.
  // Applying the same containment check here closes the asymmetry.
  //
  // resolveContained handles a target that does not exist yet -- the normal
  // case for a create -- by walking to the deepest existing ancestor and
  // verifying that IT is physically inside the base, so a symlinked
  // intermediate directory cannot be used to place a new file outside the
  // section directory.
  const fullPath = resolveContained(dirPath, filePath);
  if (!fullPath) {
    throw new ToolValidationError(`Path escapes content directory, or resolves through a symbolic link: ${filePath}`);
  }
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
  description:
    'Write or overwrite a module file on the Railway volume by its relative path within modules/ ' +
    '(e.g. "music-analysis/music-analysis-somatic.md" or "philosophy/new-topic.md"). ' +
    'Use this to directly edit or create modular skill files without leaving Claude. ' +
    'v12.21.0: writing a .md module AUTOMATICALLY registers it in a manifest fragment under ' +
    'references/manifest/ (per MANIFEST_DIRECTORY_PROTOCOL.md), so skill_compile, skill_recompile, ' +
    'skill_load_specialist, and brain_scan catalog it immediately — no manual MANIFEST.json edit and ' +
    'no manifest_rebuild.py run is required. Pass manifest_entry to control triggers/metadata; ' +
    'otherwise a dispatchable entry is derived from the path and content. ' +
    'Only .md module files are registered as dispatchable modules; a .json module file is written as data ' +
    'and is intentionally NOT registered, so skill_compile / skill_load_specialist will not dispatch it. ' +
    'Backs up the updated file to WordPress after a successful write.\n\n' +
    'SAFETY GUARDRAIL — OVERWRITE PROTECTION:\n' +
    'If the target file already exists, the write is BLOCKED and the existing file stats are returned. ' +
    'To proceed with an intentional overwrite you MUST:\n' +
    '  1. Read the existing file content (e.g. via skill_read or skill_load_specialist) so you know what you are replacing.\n' +
    '  2. Explicitly notify Brian that you intend to overwrite this specific file and explain why.\n' +
    '  3. Set force: true ONLY after Brian has confirmed the overwrite.\n' +
    'New files (paths that do not yet exist) are created immediately — force: true is not required for new files.',
  inputSchema: {
    type: 'object',
    properties: {
      file:        { type: 'string', description: 'Relative path within modules/ directory, e.g. "music-analysis/music-analysis-somatic.md". Must be category/filename.md or filename.md. No leading slash.' },
      content:     { type: 'string', description: 'Full content to write to the file.' },
      change_note: { type: 'string', description: 'Brief description of the change (used for WP backup metadata). Optional.' },
      force:       { type: 'boolean', description: 'Set to true to confirm overwrite of an EXISTING file. Only accepted after Brian has been notified and has explicitly confirmed the overwrite. Do NOT pass true speculatively. Default: false.' },
      manifest_entry: { type: 'object', description: 'Optional manifest module entry (MANIFEST_APPEND schema: id, title, category, triggers{keywords,phrases,task_class}, provides, depends_on, load_priority, load_strategy, always_load). Fields you supply override the derived defaults; id and path are always ensured. Omit to auto-derive from the file path and content.' },
      dispatch_rule:  { type: 'object', description: 'Optional dispatch rule to register alongside the module in the same fragment (fragment schema: id, trigger_description, trigger_patterns{keywords,phrases,task_class}, module_to_add, confidence). Omit to register the module without a routing rule.' },
      skip_manifest:  { type: 'boolean', description: 'Set true to write the module file WITHOUT registering a manifest fragment (e.g. editing a body whose registration already exists and should not be touched). Default: false — registration is automatic.' },
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
      filename:    { type: 'string', description: 'Relative path within scripts/ including subdirectory (e.g. "music-analysis/new_script.py"). Accepted extensions: .py, .sh, .js, .mjs, .cjs, .ts, .txt, .md, .json.' },
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
  const { content, change_note, force = false, manifest_entry = null, dispatch_rule = null, skip_manifest = false } = args;
  // FIX 1: accept file / filename / path interchangeably (gateway key drift).
  const file = firstStringKey(args, 'file', 'filename', 'path');

  // FIX 2/3: validation failures return a clean 400-shape instead of escaping
  // as a 500. Genuine internal failures below still propagate normally.
  let cleanPath;
  try {
    requireContent(content);
    cleanPath = validateContentPath(file, ['md', 'json']);
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }

  const paths      = getContentPaths();
  const fullPath   = join(paths.modulesDir, cleanPath);
  const dir        = dirname(fullPath);
  const wpSkillUrl = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey = process.env.WP_SKILL_KEY || '';

  const isNew = !existsSync(fullPath);

  // -------------------------------------------------------------------------
  // SAFETY GUARDRAIL: block overwrite of an existing file unless force=true.
  //
  // This prevents accidental truncation of established module content.
  // Required workflow before force=true:
  //   1. Read existing file (skill_read / skill_load_specialist).
  //   2. Notify Brian of the intended overwrite and reason.
  //   3. Receive explicit confirmation from Brian.
  //   4. Then call again with force: true.
  // -------------------------------------------------------------------------
  if (!isNew && !force) {
    let lineCount    = 0;
    let sizeKb       = '0';
    let lastModified = '';
    try {
      const existing = readFileSync(fullPath, 'utf8');
      lineCount = existing.split('\n').length;
    } catch { /* ignore read errors — stats still informative */ }
    try {
      const st   = statSync(fullPath);
      sizeKb       = (st.size / 1024).toFixed(1);
      lastModified = st.mtime.toISOString();
    } catch { /* ignore */ }

    log('warn', `[module_write] BLOCKED overwrite attempt on existing file: modules/${cleanPath} (${lineCount} lines)`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          blocked:      true,
          reason:       `File already exists at modules/${cleanPath} (${lineCount} lines, ${sizeKb}KB). Overwrite blocked by safety guardrail.`,
          existing_file: {
            path:          `modules/${cleanPath}`,
            line_count:    lineCount,
            size_kb:       parseFloat(sizeKb) || 0,
            last_modified: lastModified,
          },
          required_action: [
            '1. Read the existing file first so you know what you are replacing.',
            '2. Explicitly notify Brian: state which file, how many lines you are replacing, and why.',
            '3. Wait for Brian\'s explicit confirmation.',
            '4. Then call module_write again with force: true.',
          ],
          diagnostics: { resolved_file: file ?? null, force_requested: force },
          note: 'New files (non-existing paths) are created immediately without force: true.',
        }, null, 2),
      }],
    };
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!isNew) log('warn', `[module_write] Overwriting existing file (force=true confirmed): modules/${cleanPath}`);
  writeFileSync(fullPath, content, 'utf8');

  // -------------------------------------------------------------------------
  // v12.21.0: STRUCTURAL MANIFEST REGISTRATION.
  //
  // The previous behaviour ended with a note — "Remember to add an entry to
  // MANIFEST.json" — and the 2026-07-21 travel-module failure is what
  // discretionary registration produces: a module on disk that skill_compile
  // cannot see. Registration now happens in the same tool call: a manifest
  // fragment is created/updated in references/manifest/ per
  // MANIFEST_DIRECTORY_PROTOCOL.md, which skill_compile, skill_recompile,
  // skill_load_specialist, and brain_scan all read directly.
  //
  // Only .md module bodies are registered (a .json module file is data, not a
  // dispatchable module). skip_manifest opts out for body-only edits.
  // -------------------------------------------------------------------------
  let manifestResult = { registered: false, reason: 'skipped' };
  const isMarkdownModule = /\.md$/i.test(cleanPath);
  if (skip_manifest) {
    manifestResult = { registered: false, reason: 'skip_manifest=true — existing registration left untouched' };
  } else if (!isMarkdownModule) {
    manifestResult = { registered: false, reason: 'non-.md module file — data files are not registered as dispatchable modules' };
  } else {
    try {
      const entry = deriveModuleEntry(cleanPath, content, manifest_entry || {});
      const frag  = writeModuleFragment(paths.avaDir, entry, dispatch_rule);
      manifestResult = {
        registered:      true,
        fragment_file:   `references/manifest/${frag.file}`,
        fragment_action: frag.action,
        module_action:   frag.module_action,
        module_id:       entry.id,
        module_path:     entry.path,
        dispatch_rule:   dispatch_rule ? 'registered' : 'none',
      };
    } catch (err) {
      // A registration failure must never lose the module body write, but it
      // must also never pass silently — that silence is the original bug.
      log('error', `[module_write] manifest fragment registration FAILED for modules/${cleanPath}: ${err.message}`);
      manifestResult = {
        registered: false,
        error:      err.message,
        required_action: 'Registration failed. Create the fragment manually in references/manifest/ or re-run module_write.',
      };
    }
  }

  let wpResult = { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  if (wpSkillUrl && wpSkillKey) {
    const timeoutMs = wpTimeoutMs();
    try {
      const res = await fetch(`${wpSkillUrl}/modules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ava-Skill-Key': wpSkillKey, 'User-Agent': 'claude-connector/12.8.0 (ava-module-write)' },
        body: JSON.stringify({ file: cleanPath, content, change_note: change_note || '', timestamp: new Date().toISOString(), line_count: content.split('\n').length }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      wpResult = res.ok ? { ok: true } : { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
    } catch (err) {
      wpResult = (err && err.name === 'TimeoutError')
        ? { ok: false, error: `WP backup timed out after ${timeoutMs}ms` }
        : { ok: false, error: err.message };
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success:    true,
        file:       cleanPath,
        action:     isNew ? 'created' : 'overwritten',
        line_count: content.split('\n').length,
        path:       fullPath,
        manifest_registration: manifestResult,
        wp_backup:  formatWpResult(wpResult),
        note: manifestResult.registered
          ? `Module ${isNew ? 'created' : 'overwritten'} AND registered in ${manifestResult.fragment_file}. skill_compile, skill_recompile, skill_load_specialist, and brain_scan catalog it automatically — no MANIFEST.json edit or manifest_rebuild.py run is needed.`
          : `Module ${isNew ? 'created' : 'overwritten'}. Manifest registration: ${manifestResult.reason || manifestResult.error || 'not performed'}.`,
      }, null, 2),
    }],
  };
}

export function handleArchiveList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDirRecursive(paths.archiveDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'archive', path: paths.archiveDir, file_count: files.length, files }, null, 2) }] };
}

export function handleArchiveRead(args) {
  try {
    const filename = firstStringKey(args, 'filename', 'path');
    const clean   = validateFilename(filename);
    const paths   = getContentPaths();
    const content = readContentFile(paths.archiveDir, clean);
    return { content: [{ type: 'text', text: JSON.stringify({ section: 'archive', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
}

export async function handleArchiveWrite(args) {
  try {
    const { content, change_note } = args;
    const filename = firstStringKey(args, 'filename', 'path');
    requireContent(content);
    const clean  = validateFilename(filename);
    const paths  = getContentPaths();
    const result = await writeContentFile(paths.archiveDir, 'archive', clean, content, change_note);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
}

export function handleReferenceList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDirRecursive(paths.referencesDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'references', path: paths.referencesDir, file_count: files.length, files }, null, 2) }] };
}

export function handleReferenceRead(args) {
  try {
    const filename = firstStringKey(args, 'filename', 'path');
    const clean   = validateContentPath(filename, ['md', 'txt', 'json']);
    const paths   = getContentPaths();
    const content = readContentFile(paths.referencesDir, clean);
    return { content: [{ type: 'text', text: JSON.stringify({ section: 'references', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
}

export async function handleReferenceWrite(args) {
  try {
    const { content, change_note } = args;
    const filename = firstStringKey(args, 'filename', 'path');
    requireContent(content);
    const clean  = validateContentPath(filename, ['md', 'txt', 'json']);
    const paths  = getContentPaths();
    const result = await writeContentFile(paths.referencesDir, 'references', clean, content, change_note);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
}

export function handleScriptList(_args) {
  const paths = getContentPaths();
  ensureContentDirs(paths);
  const files = listContentDirRecursive(paths.scriptsDir);
  return { content: [{ type: 'text', text: JSON.stringify({ section: 'scripts', path: paths.scriptsDir, file_count: files.length, files }, null, 2) }] };
}

export function handleScriptRead(args) {
  try {
    const filename = firstStringKey(args, 'filename', 'path');
    const clean   = validateContentPath(filename, ['py', 'sh', 'js', 'mjs', 'cjs', 'ts', 'txt', 'md', 'json']);
    const paths   = getContentPaths();
    const content = readContentFile(paths.scriptsDir, clean);
    return { content: [{ type: 'text', text: JSON.stringify({ section: 'scripts', filename: clean, line_count: content.split('\n').length, content }, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
}

export async function handleScriptWrite(args) {
  try {
    const { content, change_note } = args;
    const filename = firstStringKey(args, 'filename', 'path');
    requireContent(content);
    const clean  = validateContentPath(filename, ['py', 'sh', 'js', 'mjs', 'cjs', 'ts', 'txt', 'md', 'json']);
    const paths  = getContentPaths();
    const result = await writeContentFile(paths.scriptsDir, 'scripts', clean, content, change_note);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolValidationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }], isError: true };
    }
    throw err;
  }
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
export const handleScriptRestoreFromWp    = buildRestoreHandler('scripts',    p => p.scriptsDir,    p => validateContentPath(p, ['py', 'sh', 'js', 'mjs', 'cjs', 'ts', 'txt', 'md', 'json']));
