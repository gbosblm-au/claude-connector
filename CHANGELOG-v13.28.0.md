# claude-connector v13.28.0

**BOOKS-READ AUTHORITY CUTOVER, connector half.** `books_read` and
`books_log_write` now read and write the gateway's `reading_log`, scoped to the
calling account. Requires Gateway v2.234.0, deployed first.

## Unchanged

Tool names, input schemas, and both JSON response shapes:
`{content, entry_count, last_updated}` and
`{success, entry, entry_count_total, wordpress_backup, note}`. The line format
and header are rendered by the same `formatEntry` and `BOOKS_READ_HEADER`.

## Changed

- `src/tools/books.js`: storage moved to `POST /ti-tools/books-read` and
  `POST /ti-tools/books-log-write`. The account comes from
  `resolveSessionIdentity(context, null)`: the gateway's per-call context, then
  the session context. Tool args are never consulted for identity.
- **No fallback to the file.** With no resolvable account the tools refuse
  with `account_unresolved`; with no gateway configured, `gateway_not_configured`.
- `books_log_write` refuses a book the vault does not hold
  (`book_not_in_vault`, with any held same-title books so the caller can retry
  with the stored author). The WordPress Books Read push is now rendered from
  Postgres.
- Reconciliation (`reconcileBooksFile`): on every call to either tool, if
  BOOKS_READ.md is still on the volume it is compared entry by entry with
  Postgres and the result is logged. It never changes a response. The file is
  safe to delete only when the log line reports `safe_to_delete_file=true`
  (no file-only entries, no unparseable lines).
- `src/tools/ti-tools-client.js`: `booksReadRemote`, `booksLogWriteRemote`.
- `src/server-http.js`: both books tools receive `context`.

## Removed

- `POST /restore-books`, `handleBooksRestoreFromWp`, its MCP auth exemption in
  `src/middleware/mcpAuth.js`, and its entry in the phase0 security test. An
  inbound POST can no longer overwrite the reading record.
- `BOOKS_READ.md` from `skill_audit`'s canonical-mode list.

## Known consequence

The ts-ava-skill WordPress plugin's "Push to Railway" action for the Books
Read tab targets the removed route and will now be refused. That button should
be removed from the plugin.

## Tests

New: `src/tests/books-cutover.test.js` (14).
