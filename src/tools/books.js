// src/tools/books.js  v13.28.1
// Ava's reading record: books_read and books_log_write.
//
// ── BOOKS-READ AUTHORITY CUTOVER (v13.28.0) ─────────────────────────────────
//
// The reading record lives in Postgres (gateway table reading_log), scoped to
// the owning account. BOOKS_READ.md on the Railway volume is no longer read or
// written by either tool. Tool names, input schemas and JSON response shapes
// are unchanged; only storage moved.
//
//   books_read      - POST /ti-tools/books-read, rendered here with the same
//                     formatEntry the file always used, into the same
//                     { content, entry_count, last_updated } shape.
//   books_log_write - POST /ti-tools/books-log-write. Refuses a book the vault
//                     does not hold (book_not_in_vault). Then re-renders the
//                     list from Postgres and pushes it to the WordPress Books
//                     Read tab, so that tab is now rendered from reading_log.
//
// ── No fallback (directive s1.4) ────────────────────────────────────────────
//
// When the calling account cannot be resolved, or the gateway is not
// configured, both tools refuse with a named error. Falling back to the file
// would recreate a second source of truth one request at a time.
//
// The account comes ONLY from the gateway's per-call context (v13.28.1). The
// connector session context is not used: it is process-global and can name
// another account. Tool ARGS are never consulted either, so a model-supplied
// user_id cannot redirect a read or a write. Direct MCP calls, which carry no
// per-call context, are refused with account_unresolved.
//
// ── Reconciliation (directive s7.1) ─────────────────────────────────────────
//
// BOOKS_READ.md stays on the volume, frozen at cutover, until the
// reconciliation shows every entry it holds is present in reading_log. That
// comparison runs on every call to either tool, not once, and is logged. It
// never changes a tool response. reconcileBooksFile is the pure comparison.
//
// The inbound POST /restore-books route and handleBooksRestoreFromWp were
// removed in v13.28.0 (s6.3): a request body must not be able to overwrite the
// source of truth.

import { readFileSync, existsSync } from 'node:fs';
import { log } from '../utils/logger.js';
import {
  resolveSessionIdentity,
  gatewayConfigured,
  booksReadRemote,
  booksLogWriteRemote,
} from './ti-tools-client.js';

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

// ---------------------------------------------------------------------------
// Rendering. The header and line format are unchanged from the file era, so
// the rendered content is what the file would have held.
// ---------------------------------------------------------------------------

export const BOOKS_READ_HEADER = `# Ava Books Read

All books Ava has read in IFA sessions, most recent first. Memory holds the full reading response and context for each entry (search by title). New entries added via \`books_log_write\` after each reading session.

`;

export function countEntries(content) {
  return (content.match(/^- \*/gm) || []).length;
}

export function formatEntry(title, author, dateRead, genre, note) {
  return `- *${title.trim()}* - ${author.trim()} (${dateRead.trim()}) | ${genre.trim()} | ${note.trim()}`;
}

/**
 * Render gateway entries into BOOKS_READ.md-format content.
 * @param {Array<{title?:string, author?:string|null, date_read?:string,
 *                genre?:string|null, note?:string|null}>} entries  Most recent first.
 * @returns {string}
 */
export function renderBooksContent(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return BOOKS_READ_HEADER;
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  const lines = list.map((e) => formatEntry(s(e.title), s(e.author), s(e.date_read), s(e.genre), s(e.note)));
  return BOOKS_READ_HEADER + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// WordPress backup (non-blocking)
// Pushes the content rendered from reading_log to POST /wp-json/ava-skill/v1/books
// ---------------------------------------------------------------------------

async function pushBooksToWordPress(content, wpUrl, wpKey) {
  if (!wpUrl || !wpKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpUrl}/books`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Ava-Skill-Key': wpKey,
        'User-Agent':     'claude-connector/13.28.1 (ava-books-sync)',
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
// Reconciliation (s7.1)
// ---------------------------------------------------------------------------

const ENTRY_LINE = /^- \*(.+?)\* - (.*?) \((\d{4}-\d{2}-\d{2})\) \| (.*?) \| (.*)$/;

function norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Compare BOOKS_READ.md, entry by entry, against the entries rendered from
 * reading_log. Pure: no I/O.
 *
 * Entries are matched on title and date read (case- and whitespace-
 * insensitive), as a multiset, so the same book read twice on different days
 * is two entries. Author, genre and note are then compared on each matched
 * pair and reported as field mismatches, because the vault's stored author can
 * legitimately be fuller than what the file recorded.
 *
 * The direction that matters is file_only: an entry the file holds and
 * Postgres does not. The file can only be deleted safely when that list and
 * the unparseable list are both empty. db_only entries are expected after
 * cutover, because new readings are no longer written to the file.
 *
 * @param {string} fileContent
 * @param {Array<object>} dbEntries
 * @returns {{file_entries:number, db_entries:number, matched:number,
 *            file_only:Array<object>, db_only:Array<object>,
 *            field_mismatches:Array<object>, unparseable:string[],
 *            safe_to_delete_file:boolean}}
 */
export function reconcileBooksFile(fileContent, dbEntries) {
  const fileRows = [];
  const unparseable = [];
  for (const line of String(fileContent || '').split('\n')) {
    if (!line.startsWith('- ')) continue;
    const m = ENTRY_LINE.exec(line.replace(/\r$/, ''));
    if (!m) { unparseable.push(line); continue; }
    fileRows.push({ title: m[1], author: m[2], date_read: m[3], genre: m[4], note: m[5] });
  }

  const buckets = new Map();
  const db = Array.isArray(dbEntries) ? dbEntries : [];
  for (const e of db) {
    const k = `${norm(e.title)}|${norm(e.date_read)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }

  const fileOnly = [];
  const mismatches = [];
  let matched = 0;
  for (const f of fileRows) {
    const k = `${norm(f.title)}|${norm(f.date_read)}`;
    const bucket = buckets.get(k);
    if (!bucket || !bucket.length) { fileOnly.push(f); continue; }
    const d = bucket.shift();
    matched += 1;
    const diffs = ['author', 'genre', 'note'].filter((field) => norm(f[field]) !== norm(d[field]));
    if (diffs.length) {
      mismatches.push({ title: f.title, date_read: f.date_read, fields: diffs,
        file: Object.fromEntries(diffs.map((x) => [x, f[x]])),
        db: Object.fromEntries(diffs.map((x) => [x, d[x] ?? null])) });
    }
  }
  const dbOnly = [...buckets.values()].flat().map((d) => ({ title: d.title, date_read: d.date_read }));

  return {
    file_entries: fileRows.length,
    db_entries: db.length,
    matched,
    file_only: fileOnly,
    db_only: dbOnly,
    field_mismatches: mismatches,
    unparseable,
    safe_to_delete_file: fileOnly.length === 0 && unparseable.length === 0,
  };
}

/**
 * Run the reconciliation against the volume file, if it is still there, and
 * log the outcome. Never throws and never alters a tool response.
 * @param {Array<object>} dbEntries
 * @returns {object|null} The reconciliation, or null when no file exists.
 */
export function reconcileAgainstVolume(dbEntries) {
  try {
    const { booksPath } = getBooksPaths();
    if (!existsSync(booksPath)) return null;
    const r = reconcileBooksFile(readFileSync(booksPath, 'utf8'), dbEntries);
    const summary = `books reconcile: file=${r.file_entries} db=${r.db_entries} matched=${r.matched} ` +
      `file_only=${r.file_only.length} db_only=${r.db_only.length} mismatched=${r.field_mismatches.length} ` +
      `unparseable=${r.unparseable.length} safe_to_delete_file=${r.safe_to_delete_file}`;
    if (r.safe_to_delete_file) {
      log('info', summary);
    } else {
      log('warn', `${summary}; file-only: ${r.file_only.map((f) => `${f.title} (${f.date_read})`).join('; ').slice(0, 800)}`);
    }
    return r;
  } catch (err) {
    log('warn', `books reconcile could not run: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Account resolution (s1.4: no fallback)
// ---------------------------------------------------------------------------

/**
 * @param {object|null} context  Per-call { tenant_id, user_id } from the gateway.
 * @returns {{ok:true, tenantId:string, userId:string}|{ok:false, code:string, message:string}}
 */
function resolveBooksAccount(context) {
  if (!gatewayConfigured()) {
    return { ok: false, code: 'gateway_not_configured',
      message: 'The reading record is stored in the gateway, and GATEWAY_URL / GATEWAY_ADMIN_KEY are not set. Refusing rather than using BOOKS_READ.md.' };
  }
  // v13.28.1: the per-call context is REQUIRED. The session context is one
  // process-global value, set by whichever account last ran
  // ts_gateway_session_init, so on a connector serving more than one account it
  // can name the wrong reader. Both fields must come from the call itself; a
  // context with a user but no tenant would otherwise take TS_TENANT_ID.
  const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  if (!context || !present(context.tenant_id ?? context.tenantId) || !present(context.user_id ?? context.userId)) {
    return { ok: false, code: 'account_unresolved',
      message: 'The reading record is per account and this call carries no account. ' +
               'Direct MCP calls are refused: start a gateway session and call books_read / books_log_write through the gateway, which supplies the account on every call.' };
  }
  // With both fields present they win resolveSessionIdentity's first priority,
  // so this only applies its normalisation; no fallback is reachable.
  const { tenantId, userId } = resolveSessionIdentity(context, null);
  return { ok: true, tenantId, userId };
}

function errorResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions (names and input schemas unchanged)
// ---------------------------------------------------------------------------

export const booksReadToolDefinition = {
  name: 'books_read',
  description:
    'Read the full reading log for this account, rendered as the BOOKS_READ list. ' +
    'Returns every book this account has read, most recent first. ' +
    'Call on demand only, when a book is being read or discussed. ' +
    'Not loaded at session start. Complement to the Ava skill: the skill holds ' +
    'the reading directives and any earned skill additions; this holds the log.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const booksLogWriteToolDefinition = {
  name: 'books_log_write',
  description:
    'Record a completed reading in this account\'s reading log and push the updated ' +
    'list to the WordPress Books Read tab. ' +
    'Call immediately after completing a reading session. ' +
    'The book must already be in the reading vault under this title and author; ' +
    'if it is not, the call is refused with book_not_in_vault and lists any held ' +
    'books with the same title. ' +
    'The entry is formatted internally from the structured fields provided, ' +
    'so do not pre-format the entry string. ' +
    'The list is returned most recent first.',
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

/**
 * books_read. Response shape unchanged: { content, entry_count, last_updated }.
 * @param {object} _args
 * @param {object|null} [context]
 */
export async function handleBooksRead(_args, context = null) {
  const account = resolveBooksAccount(context);
  if (!account.ok) return errorResult({ error: account.message, code: account.code });

  let remote;
  try {
    remote = await booksReadRemote(account.tenantId, account.userId);
  } catch (err) {
    log('warn', `books_read: gateway read failed: ${err.message}`);
    return errorResult({ error: `Reading log unavailable: ${err.message}`, code: err.code || 'gateway_error' });
  }

  const content = renderBooksContent(remote.entries);
  const entryCount = countEntries(content);
  reconcileAgainstVolume(remote.entries);

  log('info', `books_read: returned ${entryCount} entries for tenant=${account.tenantId} user=${account.userId}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        content,
        entry_count:  entryCount,
        last_updated: remote.last_updated,
      }, null, 2),
    }],
  };
}

/**
 * books_log_write. Same five-field validation and the same success object.
 * @param {object} args
 * @param {object|null} [context]
 */
export async function handleBooksLogWrite(args, context = null) {
  const { wpUrl, wpKey } = getBooksPaths();
  const a = args || {};

  const title    = (a.title    || '').trim();
  const author   = (a.author   || '').trim();
  const dateRead = (a.date_read || '').trim();
  const genre    = (a.genre    || '').trim();
  const note     = (a.note     || '').trim();

  if (!title)    return errorResult({ error: 'title is required.' });
  if (!author)   return errorResult({ error: 'author is required.' });
  if (!dateRead) return errorResult({ error: 'date_read is required.' });
  if (!genre)    return errorResult({ error: 'genre is required.' });
  if (!note)     return errorResult({ error: 'note is required.' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRead)) {
    return errorResult({ error: `date_read must be in YYYY-MM-DD format. Received: "${dateRead}"` });
  }

  const account = resolveBooksAccount(context);
  if (!account.ok) return errorResult({ error: account.message, code: account.code });

  let written;
  try {
    written = await booksLogWriteRemote({
      tenantId: account.tenantId, userId: account.userId,
      title, author, dateRead, genre, note,
    });
  } catch (err) {
    log('warn', `books_log_write: gateway write refused or failed: ${err.code || ''} ${err.message}`);
    return errorResult({
      error: err.message,
      code: err.code || 'gateway_error',
      ...(err.detail && err.detail.same_title_held ? { same_title_held: err.detail.same_title_held } : {}),
    });
  }

  const newEntry = formatEntry(
    String(written.title || title), String(written.author || author),
    String(written.date_read || dateRead), String(written.genre || genre), String(written.note || note));

  // The written row is committed. Re-reading the list is for the total and the
  // WordPress render; a failure here is reported, never turned into a failed write.
  let entryCountTotal = null;
  let wpResult = { skipped: true };
  try {
    const remote = await booksReadRemote(account.tenantId, account.userId);
    const content = renderBooksContent(remote.entries);
    entryCountTotal = countEntries(content);
    reconcileAgainstVolume(remote.entries);
    try {
      wpResult = await pushBooksToWordPress(content, wpUrl, wpKey);
    } catch (err) {
      wpResult = { ok: false, error: err.message };
    }
  } catch (err) {
    wpResult = { ok: false, error: `list re-read failed: ${err.message}` };
    log('warn', `books_log_write: post-write list read failed: ${err.message}`);
  }
  if (wpResult.ok === false) log('warn', `books_log_write: WP push failed: ${wpResult.error}`);

  log('info', `books_log_write: recorded "${title}" for tenant=${account.tenantId} user=${account.userId} (total entries: ${entryCountTotal})`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success:           true,
        entry:             newEntry,
        entry_count_total: entryCountTotal,
        wordpress_backup:  formatWpResult(wpResult),
        note:              'Entry recorded in the reading log (Postgres). Most-recent-first order maintained.',
      }, null, 2),
    }],
  };
}
