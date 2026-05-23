// src/tools/skill.js  v10.5.0
// Six tools for Ava SKILL.md management on Railway persistent volume.
//
// skill_read            - Load SKILL.md (current, pending, additions, or historical).
//                         Canonical read also returns additions_content + additions_count
//                         so session start requires only one call.
// skill_write           - Full canonical rewrite with versioning and WP backup.
//                         For SGA, structural amendments, and initial seeding only.
//                         NOT for incremental PF-session additions (use skill_write_addition).
// skill_write_addition  - Append a single ADDITION block to SKILL_ADDITIONS.md.
//                         Tiny write. No canonical transmission. Used every PF Session A,
//                         every book log entry, and any approved minor addition.
// skill_merge_additions - Apply every block in SKILL_ADDITIONS.md to the canonical SKILL.md,
//                         write the merged result as a new canonical version, clear the
//                         additions file. Called at OSC pre-step.
// skill_history         - List version history from the local history manifest.
// skill_rollback        - Restore a previous version (creates a new version in the trail).
//
// File layout on Railway volume (/data/skill/ by default):
//   SKILL.md                         - live canonical file
//   SKILL_PENDING.md                 - structural amendment staging file
//   SKILL_ADDITIONS.md               - append-only incremental additions log
//   skill_meta.json                  - current version metadata
//   additions_meta.json              - additions metadata (count, last session)
//   skill_history.json               - last 50 version headers (no content)
//   versions/
//     SKILL_YYYYMMDD_HHMMSS_vNNN.md  - archived version content
//
// ADDITION block format in SKILL_ADDITIONS.md:
//   ## ADDITION: {session_id} {ISO_timestamp}
//   Change-summary: {text}
//   Location-type: insert_after | prepend_list
//   Location-anchor: {distinctive text on the insertion-point line}
//
//   {content to insert}
//
//   ---
//
// Location types:
//   insert_after  - insert after the line containing location_anchor.
//                   For PF Session A paragraph additions.
//   prepend_list  - find anchor line, then first "- " list item after it,
//                   insert new content immediately before that list item.
//                   For book log entries.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getSkillPaths() {
  const filePath    = process.env.SKILL_FILE_PATH   || '/data/skill/SKILL.md';
  const versionDir  = process.env.SKILL_VERSION_DIR || '/data/skill/versions/';
  const metaPath    = process.env.SKILL_META_PATH   || '/data/skill/skill_meta.json';
  const pendingPath       = filePath.replace(/SKILL\.md$/, 'SKILL_PENDING.md');
  const additionsPath     = filePath.replace(/SKILL\.md$/, 'SKILL_ADDITIONS.md');
  const additionsMetaPath = filePath.replace(/SKILL\.md$/, 'additions_meta.json');
  const historyPath       = filePath.replace(/SKILL\.md$/, 'skill_history.json');
  const wpSkillUrl  = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpSkillKey  = process.env.WP_SKILL_KEY || '';
  return { filePath, versionDir, metaPath, pendingPath, additionsPath, additionsMetaPath, historyPath, wpSkillUrl, wpSkillKey };
}

function ensureDirs(filePath, versionDir) {
  const skillDir = versionDir.replace(/[/\\]?versions[/\\]?$/, '');
  if (skillDir && !existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  if (!existsSync(versionDir)) mkdirSync(versionDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// JSON manifest helpers
// ---------------------------------------------------------------------------

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readMeta(metaPath) {
  return readJsonFile(metaPath, { version_id: 'v000', version_number: 0, timestamp: null, line_count: 0, change_summary: 'initial', previous_version_id: null });
}

function readHistory(historyPath) {
  return readJsonFile(historyPath, { versions: [] });
}

function readAdditionsMeta(additionsMetaPath) {
  return readJsonFile(additionsMetaPath, { count: 0, last_updated: null, last_session_id: null });
}

function writeMeta(metaPath, meta)           { writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8'); }
function writeHistory(historyPath, obj)      { writeFileSync(historyPath, JSON.stringify(obj, null, 2), 'utf8'); }
function writeAdditionsMeta(path, meta)      { writeFileSync(path, JSON.stringify(meta, null, 2), 'utf8'); }

// ---------------------------------------------------------------------------
// Versioning utilities
// ---------------------------------------------------------------------------

function padVersion(n)  { return 'v' + String(n).padStart(3, '0'); }

function utcTimestampForFilename() {
  const n = new Date();
  const p = (x, w=2) => String(x).padStart(w,'0');
  return `${n.getUTCFullYear()}${p(n.getUTCMonth()+1)}${p(n.getUTCDate())}_${p(n.getUTCHours())}${p(n.getUTCMinutes())}${p(n.getUTCSeconds())}`;
}

function countLines(content) { return content ? content.split('\n').length : 0; }

function archiveCurrent(filePath, versionDir, currentVersionId) {
  if (!existsSync(filePath)) return null;
  const archiveFilename = `SKILL_${utcTimestampForFilename()}_${currentVersionId || 'v000'}.md`;
  writeFileSync(`${versionDir}${archiveFilename}`, readFileSync(filePath, 'utf8'), 'utf8');
  return archiveFilename;
}

// ---------------------------------------------------------------------------
// WordPress backup (non-blocking)
// ---------------------------------------------------------------------------

async function pushToWordPress(endpoint, content, meta, wpSkillUrl, wpSkillKey) {
  if (!wpSkillUrl || !wpSkillKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpSkillUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ava-Skill-Key': wpSkillKey, 'User-Agent': 'claude-connector/10.5.0 (ava-skill-sync)' },
      body: JSON.stringify({ content, version_id: meta.version_id, line_count: meta.line_count, change_summary: meta.change_summary, timestamp: meta.timestamp }),
    });
    if (!res.ok) { const t = await res.text().catch(()=>''); return { ok: false, status: res.status, error: t.slice(0,200) }; }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function formatWpResult(r) {
  if (r.skipped) return 'not configured';
  if (r.ok)      return 'ok';
  return `failed: ${r.error || String(r.status || 'unknown')}`;
}

// ---------------------------------------------------------------------------
// Canonical write (shared by skill_write, skill_rollback, skill_merge_additions)
// ---------------------------------------------------------------------------

async function canonicalWrite(content, changeSummary, paths) {
  const { filePath, versionDir, metaPath, historyPath, wpSkillUrl, wpSkillKey } = paths;
  const meta             = readMeta(metaPath);
  const prevLineCount    = meta.line_count || 0;
  const prevVersionId    = meta.version_id || 'v000';
  const newVersionNumber = (meta.version_number || 0) + 1;
  const newVersionId     = padVersion(newVersionNumber);
  const ts               = new Date().toISOString();
  const newLineCount     = countLines(content);
  const lineDelta        = newLineCount - prevLineCount;
  const archivedAs       = archiveCurrent(filePath, versionDir, prevVersionId);

  writeFileSync(filePath, content, 'utf8');

  const newMeta = { version_id: newVersionId, version_number: newVersionNumber, timestamp: ts, line_count: newLineCount, change_summary: changeSummary, previous_version_id: prevVersionId };
  writeMeta(metaPath, newMeta);

  const historyObj = readHistory(historyPath);
  historyObj.versions = [{ version_id: newVersionId, timestamp: ts, line_count: newLineCount, line_delta: lineDelta, change_summary: changeSummary }, ...(historyObj.versions || [])].slice(0, 50);
  writeHistory(historyPath, historyObj);

  let wpResult = { skipped: true };
  try { wpResult = await pushToWordPress('update', content, newMeta, wpSkillUrl, wpSkillKey); }
  catch (err) { wpResult = { ok: false, error: err.message }; log('warn', `skill canonical write WP backup failed: ${err.message}`); }

  log('info', `skill canonical write: ${newVersionId} (${newLineCount} lines, delta ${lineDelta >= 0 ? '+' : ''}${lineDelta}) - ${changeSummary}`);

  return { success: true, target: 'current', version_id: newVersionId, line_count: newLineCount, previous_line_count: prevLineCount, line_delta: lineDelta, wordpress_backup: formatWpResult(wpResult), archived_as: archivedAs, change_summary: changeSummary, timestamp: ts };
}

// ---------------------------------------------------------------------------
// ADDITION block format and parse/apply helpers
// ---------------------------------------------------------------------------

function formatAdditionBlock(sessionId, content, locationType, locationAnchor, changeSummary) {
  const ts = new Date().toISOString();
  return `## ADDITION: ${sessionId} ${ts}\nChange-summary: ${changeSummary}\nLocation-type: ${locationType}\nLocation-anchor: ${locationAnchor}\n\n${content.trim()}\n\n---\n\n`;
}

function parseAdditionBlocks(additionsContent) {
  if (!additionsContent || !additionsContent.trim()) return [];
  const blocks = [];
  const rawSections = additionsContent.split(/(?=^## ADDITION:)/m);

  for (const section of rawSections) {
    const trimmed = section.trim();
    if (!trimmed.startsWith('## ADDITION:')) continue;

    const lines      = trimmed.split('\n');
    const headerLine = lines[0].replace(/^## ADDITION:\s*/, '').trim();
    const sessionId  = headerLine.split(' ')[0] || 'unknown';

    let changeSummary = '', locationType = 'insert_after', locationAnchor = '', contentStart = -1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('Change-summary: '))   changeSummary  = line.slice('Change-summary: '.length).trim();
      else if (line.startsWith('Location-type: '))  locationType   = line.slice('Location-type: '.length).trim();
      else if (line.startsWith('Location-anchor: ')) locationAnchor = line.slice('Location-anchor: '.length).trim();
      else if (line.trim() === '' && locationAnchor && contentStart === -1) { contentStart = i + 1; break; }
    }

    if (contentStart < 0 || !locationAnchor) continue;

    let contentLines = lines.slice(contentStart);
    while (contentLines.length > 0 && (contentLines[contentLines.length-1].trim() === '---' || contentLines[contentLines.length-1].trim() === '')) contentLines.pop();
    const content = contentLines.join('\n').trimEnd();
    if (!content) continue;

    blocks.push({ sessionId, changeSummary, locationType, locationAnchor, content });
  }
  return blocks;
}

function applyAdditionBlock(skillContent, block) {
  const { locationType, locationAnchor, content } = block;
  const skillLines    = skillContent.split('\n');
  const contentLines  = content.split('\n');
  const anchorIdx     = skillLines.findIndex(line => line.includes(locationAnchor));

  if (anchorIdx === -1) {
    const warning = `Anchor not found: "${locationAnchor.slice(0,60)}" - content appended at end of file`;
    log('warn', `skill_merge_additions: ${warning}`);
    return { content: skillContent.trimEnd() + `\n\n<!-- ADDITION UNPLACED: ${warning} -->\n${content}\n`, placed: false, warning };
  }

  let insertAt;
  if (locationType === 'prepend_list') {
    insertAt = anchorIdx + 1;
    while (insertAt < skillLines.length && !skillLines[insertAt].startsWith('- ')) insertAt++;
    // insertAt points to first "- " line; we insert before it (no adjustment needed)
  } else {
    // insert_after
    insertAt = anchorIdx + 1;
  }

  const insertLines = [];
  const prevEmpty   = insertAt > 0 && skillLines[insertAt - 1].trim() === '';
  const nextEmpty   = insertAt < skillLines.length && skillLines[insertAt].trim() === '';

  if (locationType !== 'prepend_list') {
    if (!prevEmpty) insertLines.push('');
    insertLines.push(...contentLines);
    if (!nextEmpty) insertLines.push('');
  } else {
    insertLines.push(...contentLines);
  }

  skillLines.splice(insertAt, 0, ...insertLines);
  return { content: skillLines.join('\n'), placed: true, warning: null };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const skillReadToolDefinition = {
  name: 'skill_read',
  description:
    'Load the Ava SKILL.md (or pending staging file, additions log, or historical version) ' +
    'from Railway persistent volume. Call this at session start after viewing the SKILL.md stub. ' +
    'Canonical read (default) also returns additions_content and additions_count so Ava can ' +
    'compose the full working skill from a single call.',
  inputSchema: {
    type: 'object',
    properties: {
      pending:    { type: 'boolean', description: 'If true, reads SKILL_PENDING.md instead of canonical. Default false.' },
      additions:  { type: 'boolean', description: 'If true, reads SKILL_ADDITIONS.md explicitly. Not needed at session start — additions already included in canonical read response.' },
      version_id: { type: 'string',  description: 'Version ID (e.g. "v038") to read a historical archived version.' },
    },
    required: [],
  },
};

export const skillWriteToolDefinition = {
  name: 'skill_write',
  description:
    'Full canonical rewrite of SKILL.md (or SKILL_PENDING.md) to Railway persistent volume. ' +
    'Use for SGA compression, structural paragraph amendments, and initial seeding only. ' +
    'Do NOT use for incremental PF Session A additions or book log entries — ' +
    'use skill_write_addition (avoids transmitting 600+ lines per entry). ' +
    'Canonical writes archive the prior version, increment version counter, update manifests, push WP backup.',
  inputSchema: {
    type: 'object',
    properties: {
      content:        { type: 'string',  description: 'Full new file content.' },
      change_summary: { type: 'string',  description: 'Max 200 characters. What changed and why.' },
      pending:        { type: 'boolean', description: 'If true, writes to SKILL_PENDING.md instead. Default false.' },
    },
    required: ['content', 'change_summary'],
  },
};

export const skillWriteAdditionToolDefinition = {
  name: 'skill_write_addition',
  description:
    'Append a single ADDITION block to SKILL_ADDITIONS.md on Railway persistent volume. ' +
    'Tiny append-only write — the full canonical SKILL.md is NOT transmitted. ' +
    'Use after every PF Session A (Type 7 paragraph), every book log entry, and any approved minor addition. ' +
    'Additions accumulate across a PF queue and are merged into the canonical at OSC pre-step via skill_merge_additions. ' +
    'location_type "insert_after" inserts after the anchor line (for paragraphs). ' +
    'location_type "prepend_list" inserts before the first "- " list item after the anchor (for book log entries).',
  inputSchema: {
    type: 'object',
    properties: {
      content:         { type: 'string', description: 'Text to insert. Full paragraph for session A additions. Single "- *Title* - Author (date) | genre | note" line for book log.' },
      location_type:   { type: 'string', enum: ['insert_after', 'prepend_list'], description: '"insert_after": insert after anchor line. "prepend_list": insert before first list item after anchor.' },
      location_anchor: { type: 'string', description: 'Distinctive text present on the insertion-point line. For insert_after: last unique phrase of preceding paragraph. For prepend_list: header line of the list (e.g. "**Books read.**").' },
      session_id:      { type: 'string', description: 'Identifier for this addition, e.g. "PF10-1A", "book-ZAMM", "book-log".' },
      change_summary:  { type: 'string', description: 'Max 200 characters. What this addition is.' },
    },
    required: ['content', 'location_type', 'location_anchor', 'session_id', 'change_summary'],
  },
};

export const skillMergeAdditionsToolDefinition = {
  name: 'skill_merge_additions',
  description:
    'Apply every ADDITION block in SKILL_ADDITIONS.md to the canonical SKILL.md, ' +
    'write the merged result as a new canonical version (with full versioning and WP backup), ' +
    'and clear SKILL_ADDITIONS.md. ' +
    'Called at OSC pre-step. Also callable on request mid-queue. ' +
    'Returns version ID, line count, blocks applied count, and any placement warnings.',
  inputSchema: {
    type: 'object',
    properties: {
      change_summary: { type: 'string', description: 'Max 200 characters. Summary for the new canonical version record.' },
    },
    required: ['change_summary'],
  },
};

export const skillHistoryToolDefinition = {
  name: 'skill_history',
  description:
    'List version history for Ava SKILL.md on Railway persistent volume. ' +
    'Returns version headers (id, timestamp, line count, line delta, change summary). ' +
    'Content not included. To read a specific version call skill_read with version_id.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Number of versions to return. Default 10, max 50.' },
    },
    required: [],
  },
};

export const skillRollbackToolDefinition = {
  name: 'skill_rollback',
  description:
    'Restore a previous version of Ava SKILL.md from the Railway archive. ' +
    'Reads the specified archived version, executes the full canonical write sequence. ' +
    'The rollback becomes a new version entry so the complete trail is preserved.',
  inputSchema: {
    type: 'object',
    properties: {
      version_id:     { type: 'string', description: 'Version ID to restore (e.g. "v038").' },
      change_summary: { type: 'string', description: 'Reason for rollback. Max 200 characters.' },
    },
    required: ['version_id', 'change_summary'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSkillRead(args) {
  const paths     = getSkillPaths();
  const { filePath, versionDir, metaPath, pendingPath, additionsPath, additionsMetaPath } = paths;
  const pending   = args.pending   === true;
  const additions = args.additions === true;
  const versionId = (args.version_id || '').trim();

  ensureDirs(filePath, versionDir);

  // Historical version read
  if (!pending && !additions && versionId) {
    let found = null;
    if (existsSync(versionDir)) {
      for (const f of readdirSync(versionDir)) {
        const m = f.match(/_v(\d{3})\.md$/);
        if (m && `v${m[1]}` === versionId) { found = f; break; }
      }
    }
    if (!found) return { content: [{ type: 'text', text: JSON.stringify({ error: `Version ${versionId} not found in archive.`, hint: 'Call skill_history to list available versions.' }, null, 2) }], isError: true };
    const content = readFileSync(`${versionDir}${found}`, 'utf8');
    return { content: [{ type: 'text', text: JSON.stringify({ content, target: 'history', version_id: versionId, line_count: countLines(content), filename: found }, null, 2) }] };
  }

  // Pending read
  if (pending) {
    if (!existsSync(pendingPath)) return { content: [{ type: 'text', text: JSON.stringify({ content: '', target: 'pending', line_count: 0, note: 'SKILL_PENDING.md does not exist.' }, null, 2) }] };
    const content = readFileSync(pendingPath, 'utf8');
    return { content: [{ type: 'text', text: JSON.stringify({ content, target: 'pending', line_count: countLines(content) }, null, 2) }] };
  }

  // Explicit additions read
  if (additions) {
    if (!existsSync(additionsPath)) return { content: [{ type: 'text', text: JSON.stringify({ content: '', target: 'additions', additions_count: 0, note: 'SKILL_ADDITIONS.md does not exist — no pending additions.' }, null, 2) }] };
    const content       = readFileSync(additionsPath, 'utf8');
    const additionsMeta = readAdditionsMeta(additionsMetaPath);
    return { content: [{ type: 'text', text: JSON.stringify({ content, target: 'additions', additions_count: additionsMeta.count || 0, last_updated: additionsMeta.last_updated, last_session_id: additionsMeta.last_session_id, line_count: countLines(content) }, null, 2) }] };
  }

  // Canonical read (default) — also returns additions summary for one-call session start
  if (!existsSync(filePath)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'SKILL.md not found on Railway volume. Use skill_write to seed the initial version.', path: filePath, hint: 'Brian: upload the current SKILL.md in chat and call skill_write to initialise.' }, null, 2) }], isError: true };

  const content          = readFileSync(filePath, 'utf8');
  const meta             = readMeta(metaPath);
  const additionsMeta    = readAdditionsMeta(additionsMetaPath);
  const additionsContent = existsSync(additionsPath) ? readFileSync(additionsPath, 'utf8') : '';

  return {
    content: [{ type: 'text', text: JSON.stringify({
      content,
      target:            'current',
      version_id:        meta.version_id,
      line_count:        countLines(content),
      last_modified:     meta.timestamp,
      change_summary:    meta.change_summary,
      additions_count:   additionsMeta.count || 0,
      additions_content: additionsContent,
      additions_note:    (additionsMeta.count || 0) > 0
        ? `${additionsMeta.count} pending addition(s) from session ${additionsMeta.last_session_id}. Compose with canonical for full working skill.`
        : 'No pending additions.',
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

  if (pending) {
    writeFileSync(pendingPath, content, 'utf8');
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, target: 'pending', line_count: countLines(content), note: content === '' ? 'SKILL_PENDING.md cleared.' : 'SKILL_PENDING.md updated.' }, null, 2) }] };
  }

  const result = await canonicalWrite(content, changeSummary, paths);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export async function handleSkillWriteAddition(args) {
  const paths              = getSkillPaths();
  const { filePath, versionDir, additionsPath, additionsMetaPath } = paths;
  const content            = typeof args.content         === 'string' ? args.content.trim()  : '';
  const locationType       = (args.location_type   || 'insert_after').trim();
  const locationAnchor     = (args.location_anchor  || '').trim();
  const sessionId          = (args.session_id       || 'unknown').trim();
  const changeSummary      = (args.change_summary   || '').slice(0, 200);

  ensureDirs(filePath, versionDir);

  if (!content)        return { content: [{ type: 'text', text: JSON.stringify({ error: 'content is required and must not be empty.' }, null, 2) }], isError: true };
  if (!locationAnchor) return { content: [{ type: 'text', text: JSON.stringify({ error: 'location_anchor is required.' }, null, 2) }], isError: true };
  if (!['insert_after', 'prepend_list'].includes(locationType)) return { content: [{ type: 'text', text: JSON.stringify({ error: `Invalid location_type "${locationType}". Must be "insert_after" or "prepend_list".` }, null, 2) }], isError: true };

  const newBlock       = formatAdditionBlock(sessionId, content, locationType, locationAnchor, changeSummary);
  const existingContent = existsSync(additionsPath) ? readFileSync(additionsPath, 'utf8') : '';
  writeFileSync(additionsPath, existingContent + newBlock, 'utf8');

  const meta      = readAdditionsMeta(additionsMetaPath);
  const newCount  = (meta.count || 0) + 1;
  writeAdditionsMeta(additionsMetaPath, { count: newCount, last_updated: new Date().toISOString(), last_session_id: sessionId });

  log('info', `skill_write_addition: staged block for ${sessionId} (total pending: ${newCount})`);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      success:         true,
      session_id:      sessionId,
      location_type:   locationType,
      location_anchor: locationAnchor.slice(0, 60),
      additions_total: newCount,
      note:            'Addition staged in SKILL_ADDITIONS.md. Merged into canonical at OSC pre-step or on skill_merge_additions call.',
    }, null, 2) }],
  };
}

export async function handleSkillMergeAdditions(args) {
  const paths              = getSkillPaths();
  const { filePath, versionDir, additionsPath, additionsMetaPath } = paths;
  const changeSummary      = (args.change_summary || 'OSC pre-step: merge pending additions into canonical').slice(0, 200);

  ensureDirs(filePath, versionDir);

  if (!existsSync(additionsPath)) return { content: [{ type: 'text', text: JSON.stringify({ success: true, blocks_applied: 0, note: 'SKILL_ADDITIONS.md not found. Nothing to merge.' }, null, 2) }] };

  const additionsContent = readFileSync(additionsPath, 'utf8');
  const blocks           = parseAdditionBlocks(additionsContent);

  if (blocks.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: true, blocks_applied: 0, note: 'SKILL_ADDITIONS.md exists but contains no parseable blocks.' }, null, 2) }] };

  if (!existsSync(filePath)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'SKILL.md not found. Cannot merge additions into non-existent canonical.' }, null, 2) }], isError: true };

  let mergedContent = readFileSync(filePath, 'utf8');
  const warnings    = [];
  let appliedCount  = 0;

  for (const block of blocks) {
    const result  = applyAdditionBlock(mergedContent, block);
    mergedContent = result.content;
    if (result.placed) {
      appliedCount++;
      log('info', `skill_merge_additions: placed block from ${block.sessionId}`);
    } else {
      warnings.push(`[${block.sessionId}] ${result.warning}`);
    }
  }

  const mergeChangeSummary = `${changeSummary} (${appliedCount}/${blocks.length} additions applied)`;
  const canonicalResult    = await canonicalWrite(mergedContent, mergeChangeSummary, paths);

  // Clear SKILL_ADDITIONS.md and reset metadata
  writeFileSync(additionsPath, '', 'utf8');
  writeAdditionsMeta(additionsMetaPath, { count: 0, last_updated: new Date().toISOString(), last_session_id: null });

  log('info', `skill_merge_additions complete: ${appliedCount}/${blocks.length} blocks, canonical now ${canonicalResult.version_id}`);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      success:               true,
      blocks_found:          blocks.length,
      blocks_applied:        appliedCount,
      blocks_with_warnings:  warnings.length,
      placement_warnings:    warnings,
      canonical:             canonicalResult,
      additions_cleared:     true,
    }, null, 2) }],
  };
}

export async function handleSkillHistory(args) {
  const paths   = getSkillPaths();
  const { versionDir, filePath, metaPath, historyPath } = paths;
  const limit   = Math.min(50, Math.max(1, parseInt(args.limit || '10', 10)));

  ensureDirs(filePath, versionDir);

  const historyObj  = readHistory(historyPath);
  const allVersions = historyObj.versions || [];
  const currentMeta = readMeta(metaPath);
  const currentVersion = (currentMeta.version_id && currentMeta.version_id !== 'v000')
    ? { version_id: currentMeta.version_id, timestamp: currentMeta.timestamp, line_count: currentMeta.line_count, change_summary: currentMeta.change_summary, is_current: true }
    : null;

  return { content: [{ type: 'text', text: JSON.stringify({ current_version: currentVersion, versions: allVersions.slice(0, limit), total_versions: allVersions.length, limit_applied: limit }, null, 2) }] };
}

export async function handleSkillRollback(args) {
  const paths         = getSkillPaths();
  const { filePath, versionDir } = paths;
  const versionId     = (args.version_id || '').trim();
  const changeSummary = (args.change_summary || `Rollback to ${versionId}`).slice(0, 170);

  if (!versionId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'version_id is required.' }, null, 2) }], isError: true };

  ensureDirs(filePath, versionDir);

  let targetFile = null;
  if (existsSync(versionDir)) {
    for (const f of readdirSync(versionDir)) {
      const m = f.match(/_v(\d{3})\.md$/);
      if (m && `v${m[1]}` === versionId) { targetFile = f; break; }
    }
  }

  if (!targetFile) return { content: [{ type: 'text', text: JSON.stringify({ error: `Version ${versionId} not found in archive.` }, null, 2) }], isError: true };

  const restoredContent = readFileSync(`${versionDir}${targetFile}`, 'utf8');
  const result = await canonicalWrite(restoredContent, `Rollback to ${versionId}: ${changeSummary}`, paths);
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, rolled_back_from: versionId, source_file: targetFile }, null, 2) }] };
}
