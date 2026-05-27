// src/tools/books.js  v10.8.0
// Two tools for Ava BOOKS_READ.md management on Railway persistent volume.
//
// books_read      - Read the full BOOKS_READ.md file on demand. Not loaded at session start.
//                   Call only when a book is being read or discussed.
// books_log_write - Prepend a new formatted entry to BOOKS_READ.md immediately after a
//                   reading session, then push the updated file to the WordPress Books tab.
//
// File location on Railway volume:
//   Same directory as SKILL.md. Path derived by replacing SKILL.md with BOOKS_READ.md
//   in the SKILL_FILE_PATH environment variable.
//   Default: /data/skill/BOOKS_READ.md
//
// File format:
//   # Ava Books Read
//   <header paragraph>
//
//   - *Title* - Author (YYYY-MM-DD) | genre | one-line note
//   - *Title* - Author (YYYY-MM-DD) | genre | one-line note
//   ...
//
// Design decisions (confirmed 2026-05-26):
//   - No versioning. Single file, direct overwrites on every new entry.
//   - On-demand read only. Not included in session-start skill_read response.
//   - WordPress backup: non-blocking push to POST /books after every books_log_write.
//   - Entry format is structured (title, author, date_read, genre, note fields) and
//     formatted internally to the canonical line format before writing.
//   - New entries are prepended (inserted before the first existing "- " line)
//     so the list remains most-recent-first.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function getBooksPaths() {
  const skillPath  = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  const booksPath  = skillPath.replace(/SKILL\.md$/, 'BOOKS_READ.md');
  const wpUrl      = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpKey      = process.env.WP_SKILL_KEY || '';
  return { booksPath, wpUrl, wpKey };
}

function ensureDir(filePath) {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '');
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// BOOKS_READ.md initialisation content
// Used when the file does not yet exist on the Railway volume.
// ---------------------------------------------------------------------------

const BOOKS_READ_HEADER = `# Ava Books Read

All books Ava has read in IFA sessions, most recent first. Memory holds the full reading response and context for each entry (search by title). New entries added via \`books_log_write\` after each reading session.

`;

// ---------------------------------------------------------------------------
// Entry count helper
// ---------------------------------------------------------------------------

function countEntries(content) {
  return (content.match(/^- \*/gm) || []).length;
}

// ---------------------------------------------------------------------------
// Format one entry line from structured fields
// ---------------------------------------------------------------------------

function formatEntry(title, author, dateRead, genre, note) {
  return `- *${title.trim()}* - ${author.trim()} (${dateRead.trim()}) | ${genre.trim()} | ${note.trim()}`;
}

// ---------------------------------------------------------------------------
// WordPress backup (non-blocking)
// Pushes the full updated BOOKS_READ.md content to POST /wp-json/ava-skill/v1/books
// ---------------------------------------------------------------------------

async function pushBooksToWordPress(content, wpUrl, wpKey) {
  if (!wpUrl || !wpKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpUrl}/books`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Ava-Skill-Key': wpKey,
        'User-Agent':     'claude-connector/10.7.0 (ava-books-sync)',
      },
      body: JSON.stringify({
        content,
        entry_count: countEntries(content),
        timestamp:   new Date().toISOString(),
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
  if (r.skipped) return 'not configured';
  if (r.ok)      return 'ok';
  return `failed: ${r.error || String(r.status || 'unknown')}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const booksReadToolDefinition = {
  name: 'books_read',
  description:
    'Read the full BOOKS_READ.md file from the Railway persistent volume. ' +
    'Returns all book entries Ava has read, most recent first. ' +
    'Call on demand only — when a book is being read or discussed. ' +
    'Not loaded at session start. Complement to the Ava skill: the skill holds ' +
    'the reading directives and any earned skill additions; this file holds the log.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const booksLogWriteToolDefinition = {
  name: 'books_log_write',
  description:
    'Prepend a new entry to BOOKS_READ.md on the Railway persistent volume and push ' +
    'the updated file to the WordPress Books Read tab. ' +
    'Call immediately after completing a reading session. ' +
    'The entry is formatted internally from the structured fields provided — ' +
    'do not pre-format the entry string. ' +
    'New entries are inserted at the top of the list (most-recent-first order).',
  inputSchema: {
    type: 'object',
    properties: {
      title:     { type: 'string', description: 'Book title, without surrounding asterisks (e.g. "Reaper Man").' },
      author:    { type: 'string', description: 'Author name(s) as they should appear in the log (e.g. "Pratchett" or "Gaiman & Pratchett").' },
      date_read: { type: 'string', description: 'Date reading was completed in YYYY-MM-DD format.' },
      genre:     { type: 'string', description: 'Genre or category (e.g. "comic fantasy", "philosophy", "fiction").' },
      note:      { type: 'string', description: 'One-line note: key moments, central argument, or honest reaction. Should be substantive, not a cover-blurb summary.' },
    },
    required: ['title', 'author', 'date_read', 'genre', 'note'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleBooksRead(_args) {
  const { booksPath } = getBooksPaths();
  ensureDir(booksPath);

  if (!existsSync(booksPath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content:     '',
          entry_count: 0,
          note:        'BOOKS_READ.md does not exist on the Railway volume. ' +
                       'Seed it by calling books_log_write with the first (or most recent) book entry, ' +
                       'or run the migrate-books.js migration script to transfer the existing list from SKILL.md.',
        }, null, 2),
      }],
    };
  }

  const content     = readFileSync(booksPath, 'utf8');
  const entryCount  = countEntries(content);
  let lastUpdated = null;
  try {
    const { mtimeMs } = statSync(booksPath);
    lastUpdated = new Date(mtimeMs).toISOString();
  } catch { /* non-critical — last_updated omitted if stat fails */ }

  log('info', `books_read: returned ${entryCount} entries`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        content,
        entry_count:  entryCount,
        last_updated: lastUpdated,
      }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// WordPress restore handler (called by POST /restore-books in server-http.js)
// Accepts a parsed request body from the WordPress admin "Push to Railway" action
// for the Books Read tab. Validates content and writes directly to BOOKS_READ.md
// on the Railway Volume. Returns a plain result object.
// ---------------------------------------------------------------------------

export async function handleBooksRestoreFromWp(body) {
  const { booksPath } = getBooksPaths();
  const content       = typeof body.content        === 'string' ? body.content        : '';
  const changeSummary = typeof body.change_summary === 'string' ? body.change_summary : 'WordPress admin books restore push';

  if (!content.trim()) {
    return { success: false, error: 'content is required and must not be empty.' };
  }

  ensureDir(booksPath);

  try {
    writeFileSync(booksPath, content, 'utf8');
    const entryCount = countEntries(content);
    log('info', `restore-books: wrote ${content.split('\n').length} lines, ${entryCount} entries from WordPress push`);
    return { success: true, entry_count: entryCount, change_summary: changeSummary };
  } catch (err) {
    log('error', `restore-books write failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function handleBooksLogWrite(args) {
  const { booksPath, wpUrl, wpKey } = getBooksPaths();
  ensureDir(booksPath);

  const title    = (args.title    || '').trim();
  const author   = (args.author   || '').trim();
  const dateRead = (args.date_read || '').trim();
  const genre    = (args.genre    || '').trim();
  const note     = (args.note     || '').trim();

  if (!title)    return { content: [{ type: 'text', text: JSON.stringify({ error: 'title is required.' }, null, 2) }], isError: true };
  if (!author)   return { content: [{ type: 'text', text: JSON.stringify({ error: 'author is required.' }, null, 2) }], isError: true };
  if (!dateRead) return { content: [{ type: 'text', text: JSON.stringify({ error: 'date_read is required.' }, null, 2) }], isError: true };
  if (!genre)    return { content: [{ type: 'text', text: JSON.stringify({ error: 'genre is required.' }, null, 2) }], isError: true };
  if (!note)     return { content: [{ type: 'text', text: JSON.stringify({ error: 'note is required.' }, null, 2) }], isError: true };

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRead)) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `date_read must be in YYYY-MM-DD format. Received: "${dateRead}"` }, null, 2) }], isError: true };
  }

  const newEntry = formatEntry(title, author, dateRead, genre, note);

  // Read existing file or initialise with header
  const existing = existsSync(booksPath) ? readFileSync(booksPath, 'utf8') : BOOKS_READ_HEADER;

  // Find insertion point: before the first "- " list line
  const lines   = existing.split('\n');
  let insertIdx = lines.findIndex(l => l.startsWith('- '));

  let updatedContent;
  if (insertIdx === -1) {
    // No existing entries yet — append after the header block
    const trimmed = existing.trimEnd();
    updatedContent = trimmed + '\n\n' + newEntry + '\n';
  } else {
    lines.splice(insertIdx, 0, newEntry);
    updatedContent = lines.join('\n');
  }

  writeFileSync(booksPath, updatedContent, 'utf8');

  const newEntryCount = countEntries(updatedContent);

  log('info', `books_log_write: prepended entry for "${title}" (total entries: ${newEntryCount})`);

  // Non-blocking WordPress push
  let wpResult = { skipped: true };
  try {
    wpResult = await pushBooksToWordPress(updatedContent, wpUrl, wpKey);
  } catch (err) {
    wpResult = { ok: false, error: err.message };
    log('warn', `books_log_write: WP push failed: ${err.message}`);
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success:           true,
        entry:             newEntry,
        entry_count_total: newEntryCount,
        wordpress_backup:  formatWpResult(wpResult),
        note:              'Entry prepended to BOOKS_READ.md. Most-recent-first order maintained.',
      }, null, 2),
    }],
  };
}
