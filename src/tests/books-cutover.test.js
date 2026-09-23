// src/tests/books-cutover.test.js  (connector v13.28.0)
//
// BOOKS-READ AUTHORITY CUTOVER, connector half. books_read and books_log_write
// now read and write the gateway's reading_log. The gateway is simulated by
// mocking global.fetch, the same idiom profiles-postgres.test.js uses;
// BOOKS_READ.md is a real temp file so "the file is never written" is checked
// against real bytes.
//
// WRITES: one temp directory under os.tmpdir(), removed in after().

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const DIR = join(tmpdir(), `books-cutover-${randomUUID()}`);
mkdirSync(DIR, { recursive: true });
const BOOKS_PATH = join(DIR, 'BOOKS_READ.md');

// Env must be set BEFORE importing the modules under test.
process.env.SKILL_FILE_PATH = join(DIR, 'SKILL.md');
process.env.WP_SKILL_URL = '';
process.env.SELF_MODEL_ENABLED = 'false';
process.env.GATEWAY_URL = 'http://gateway.test.local';
process.env.GATEWAY_ADMIN_KEY = 'test-admin-key';
delete process.env.TS_TENANT_ID;

const books = await import('../tools/books.js');
const { setCurrentUser, _resetSessionContext } = await import('../tools-self-model/sessionContext.js');

const FILE = `# Ava Books Read

header

- *Night Watch* - Pratchett (2026-09-20) | comic fantasy | Sharp.
`;
const CTX = { tenant_id: 'ava', user_id: '38' };

let calls = [];
let responder = null;
const realFetch = global.fetch;

before(() => {
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: init && init.headers });
    const out = responder(String(url), body);
    return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'Content-Type': 'application/json' } });
  };
});
beforeEach(() => {
  calls = [];
  writeFileSync(BOOKS_PATH, FILE, 'utf8');
  responder = (url) => url.endsWith('/books-read')
    ? { status: 200, json: { ok: true, last_updated: '2026-09-21T00:00:00.000Z', entries: [
        { title: 'Night Watch', author: 'Terry Pratchett', date_read: '2026-09-20', genre: 'comic fantasy', note: 'Sharp.' } ] } }
    : { status: 200, json: { ok: true, entry: { title: 'Night Watch', author: 'Terry Pratchett',
        date_read: '2026-09-21', genre: 'comic fantasy', note: 'Again.', user_id: 38 } } };
});
after(() => { global.fetch = realFetch; rmSync(DIR, { recursive: true, force: true }); });

const parse = (r) => JSON.parse(r.content[0].text);

// ── rendering and reconciliation (pure) ────────────────────────────────────

test('rendering reproduces the file format with the unchanged formatter', () => {
  assert.equal(books.renderBooksContent([]), books.BOOKS_READ_HEADER);
  const c = books.renderBooksContent([{ title: 'A', author: null, date_read: '2026-01-02', genre: null, note: 'n' }]);
  assert.equal(c, `${books.BOOKS_READ_HEADER}- *A* -  (2026-01-02) |  | n\n`);
  assert.equal(books.countEntries(c), 1);
});

test('reconciliation matches entries by title and date, and reports every direction', () => {
  const file = FILE + '- *Reaper Man* - Pratchett (2026-05-01) | fantasy | Death.\n- not an entry line\n';
  const r = books.reconcileBooksFile(file, [
    { title: 'night watch', author: 'Terry Pratchett', date_read: '2026-09-20', genre: 'comic fantasy', note: 'Sharp.' },
    { title: 'Mort', author: 'Terry Pratchett', date_read: '2026-09-22', genre: 'fantasy', note: 'x' },
  ]);
  assert.equal(r.file_entries, 2);
  assert.equal(r.matched, 1);
  assert.deepEqual(r.file_only.map((f) => f.title), ['Reaper Man']);
  assert.deepEqual(r.db_only.map((d) => d.title), ['Mort']);
  assert.deepEqual(r.field_mismatches[0].fields, ['author']);
  assert.equal(r.unparseable.length, 1);
  assert.equal(r.safe_to_delete_file, false, 'a file-only entry means deleting the file loses data');
});

test('reconciliation is a multiset: a second reading of one book is a second entry', () => {
  const file = FILE + '- *Night Watch* - Pratchett (2026-09-20) | comic fantasy | Sharp.\n';
  const one = [{ title: 'Night Watch', author: 'Pratchett', date_read: '2026-09-20', genre: 'comic fantasy', note: 'Sharp.' }];
  const r = books.reconcileBooksFile(file, one);
  assert.equal(r.matched, 1);
  assert.equal(r.file_only.length, 1);
  assert.equal(books.reconcileBooksFile(FILE, one).safe_to_delete_file, true);
});

test('an unparseable entry line alone makes the file unsafe to delete', () => {
  // A line the parser cannot read is an entry the comparison could not check,
  // so it must block deletion even when every parsed entry matched.
  const one = [{ title: 'Night Watch', author: 'Pratchett', date_read: '2026-09-20', genre: 'comic fantasy', note: 'Sharp.' }];
  const r = books.reconcileBooksFile(FILE + '- *Broken entry without a date\n', one);
  assert.equal(r.file_only.length, 0);
  assert.equal(r.unparseable.length, 1);
  assert.equal(r.safe_to_delete_file, false);
});

// ── books_read ─────────────────────────────────────────────────────────────

test('books_read returns the unchanged shape, rendered from the gateway, for the context account', async () => {
  const r = await books.handleBooksRead({ user_id: '999', tenant_id: 'evil' }, CTX);
  assert.equal(r.isError, undefined);
  const p = parse(r);
  assert.deepEqual(Object.keys(p), ['content', 'entry_count', 'last_updated']);
  assert.equal(p.entry_count, 1);
  assert.match(p.content, /^- \*Night Watch\* - Terry Pratchett \(2026-09-20\)/m);
  assert.equal(p.last_updated, '2026-09-21T00:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gateway.test.local/ti-tools/books-read');
  assert.deepEqual(calls[0].body, { tenant_id: 'ava', user_id: '38' },
    'the account comes from the per-call context, never from tool args');
});

test('books_read with no resolvable account is refused and never falls back to the file', async () => {
  const r = await books.handleBooksRead({ user_id: '38', tenant_id: 'ava' }, null);
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'account_unresolved');
  assert.equal(calls.length, 0);
  assert.equal(/Night Watch/.test(r.content[0].text), false, 'the file content must not be served');
});

test('v13.28.1: a direct MCP call is refused even when the process-global session context names an account', async () => {
  // The fallback this release removes: before it, resolveSessionIdentity fell
  // through to getCurrentUser(), set by whichever account last ran
  // ts_gateway_session_init, and the call would have been served as that account.
  setCurrentUser('ava', '38');
  try {
    for (const run of [
      () => books.handleBooksRead({}, null),
      () => books.handleBooksLogWrite({ title: 't', author: 'a', date_read: '2026-09-21', genre: 'g', note: 'n' }, null),
    ]) {
      const r = await run();
      assert.equal(r.isError, true);
      const p = parse(r);
      assert.equal(p.code, 'account_unresolved');
      assert.match(p.error, /start a gateway session/);
    }
    assert.equal(calls.length, 0, 'nothing may reach the gateway without a per-call account');
  } finally {
    _resetSessionContext();
  }
});

test('v13.28.1: both context fields must come from the call; neither may be filled from elsewhere', async () => {
  process.env.TS_TENANT_ID = 'ava';
  setCurrentUser('ava', '38');
  try {
    for (const ctx of [{ user_id: '38' }, { tenant_id: 'ava' }, { tenant_id: '  ', user_id: '38' },
                       { tenant_id: 'ava', user_id: '' }, { tenant_id: null, user_id: null }, {}]) {
      const r = await books.handleBooksRead({}, ctx);
      assert.equal(parse(r).code, 'account_unresolved', `context ${JSON.stringify(ctx)} must be refused`);
    }
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.TS_TENANT_ID;
    _resetSessionContext();
  }
});

test('v13.28.1: a camelCase per-call context is accepted and trimmed, as the resolver normalises it', async () => {
  const r = await books.handleBooksRead({}, { tenantId: ' ava ', userId: 38 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls[0].body, { tenant_id: 'ava', user_id: '38' });
});

test('books_read surfaces a gateway refusal as an error, not as file content', async () => {
  responder = () => ({ status: 404, json: { error: 'account_not_found', message: 'No account 38 in tenant ava.' } });
  const r = await books.handleBooksRead({}, CTX);
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'account_not_found');
});

// ── books_log_write ────────────────────────────────────────────────────────

test('books_log_write keeps the five-field validation messages', async () => {
  const full = { title: 't', author: 'a', date_read: '2026-09-21', genre: 'g', note: 'n' };
  for (const k of ['title', 'author', 'date_read', 'genre', 'note']) {
    const r = await books.handleBooksLogWrite({ ...full, [k]: '' }, CTX);
    assert.equal(r.isError, true);
    assert.equal(parse(r).error, `${k} is required.`);
  }
  const bad = await books.handleBooksLogWrite({ ...full, date_read: '21/09/2026' }, CTX);
  assert.match(parse(bad).error, /YYYY-MM-DD/);
  assert.equal(calls.length, 0);
});

test('books_log_write writes to the gateway as the context account, keeps its response shape, and never touches the file', async () => {
  const beforeBytes = readFileSync(BOOKS_PATH, 'utf8');
  const r = await books.handleBooksLogWrite({ title: 'Night Watch', author: 'Pratchett',
    date_read: '2026-09-21', genre: 'comic fantasy', note: 'Again.', user_id: '999' }, CTX);
  assert.equal(r.isError, undefined);
  const p = parse(r);
  assert.deepEqual(Object.keys(p), ['success', 'entry', 'entry_count_total', 'wordpress_backup', 'note']);
  assert.equal(p.success, true);
  assert.equal(p.entry, '- *Night Watch* - Terry Pratchett (2026-09-21) | comic fantasy | Again.');
  assert.equal(p.entry_count_total, 1);
  assert.equal(p.wordpress_backup, 'not configured');

  const write = calls.find((c) => c.url.endsWith('/books-log-write'));
  assert.equal(write.body.user_id, '38', 'a user_id in the tool args must not redirect the write');
  assert.equal(write.body.date_read, '2026-09-21');
  assert.equal(readFileSync(BOOKS_PATH, 'utf8'), beforeBytes, 'BOOKS_READ.md must not be written');
});

test('books_log_write reports book_not_in_vault with the held same-title books', async () => {
  responder = () => ({ status: 422, json: { error: 'book_not_in_vault', message: 'not held',
    detail: { same_title_held: [{ id: 'b1', title: 'Night Watch', author: 'Terry Pratchett' }] } } });
  const r = await books.handleBooksLogWrite({ title: 'Night Watch', author: 'Pratchett',
    date_read: '2026-09-21', genre: 'g', note: 'n' }, CTX);
  assert.equal(r.isError, true);
  const p = parse(r);
  assert.equal(p.code, 'book_not_in_vault');
  assert.equal(p.same_title_held[0].author, 'Terry Pratchett');
});

test('with the gateway unconfigured both tools refuse by name', () => {
  // GATEWAY_URL is read at module load, so this runs in a fresh process.
  const script = `
    const b = await import(${JSON.stringify(join(SRC, 'tools', 'books.js'))});
    const r1 = await b.handleBooksRead({}, { tenant_id: 'ava', user_id: '38' });
    const r2 = await b.handleBooksLogWrite({ title:'t', author:'a', date_read:'2026-09-21', genre:'g', note:'n' }, { tenant_id: 'ava', user_id: '38' });
    console.log(JSON.parse(r1.content[0].text).code, JSON.parse(r2.content[0].text).code);`;
  const env = { ...process.env, GATEWAY_URL: '', TS_TENANT_GATEWAY_URL: '', GATEWAY_ADMIN_KEY: '' };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'gateway_not_configured gateway_not_configured', r.stderr);
});

// ── the removed inbound path (structural, comment-free) ────────────────────

function codeOf(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('no inbound route or handler can overwrite the reading record', () => {
  const server = codeOf(readFileSync(join(SRC, 'server-http.js'), 'utf8'));
  assert.equal(/app\.(post|put|patch)\(\s*["'`]\/restore-books/.test(server), false, '/restore-books must not be registered');
  assert.equal(/handleBooksRestoreFromWp/.test(server), false);
  const booksSrc = codeOf(readFileSync(join(SRC, 'tools', 'books.js'), 'utf8'));
  assert.equal(/writeFileSync|appendFileSync|createWriteStream/.test(booksSrc), false, 'books.js must not write files');
  const auth = codeOf(readFileSync(join(SRC, 'middleware', 'mcpAuth.js'), 'utf8'));
  assert.equal(/\/restore-books/.test(auth), false);
});

test('the dispatch passes the per-call context to both books tools', () => {
  const server = codeOf(readFileSync(join(SRC, 'server-http.js'), 'utf8'));
  assert.match(server, /case "books_read":\s*return await handleBooksRead\(args, context\);/);
  assert.match(server, /case "books_log_write":\s*return await handleBooksLogWrite\(args, context\);/);
});

test('skill_audit no longer lists BOOKS_READ.md in canonical mode', () => {
  const skill = codeOf(readFileSync(join(SRC, 'tools', 'skill.js'), 'utf8'));
  assert.equal(/BOOKS_READ\.md/.test(skill), false);
});
