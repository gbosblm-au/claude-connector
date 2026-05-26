# Claude Connector v10.7.0 — CHANGELOG

## What changed

### New file: `src/tools/books.js`

Introduces two new tools for managing `BOOKS_READ.md` on the Railway persistent volume.
The books reading log is now a standalone file separate from `SKILL.md`, freeing SKILL.md
headroom permanently (books log grows by design with every reading session and has no
ceiling).

**`books_read`**
- Reads the full `BOOKS_READ.md` file from the Railway volume.
- Returns content, entry count, and last-modified timestamp.
- On-demand only. Not called at session start.
- Call when a book is being read or discussed.

**`books_log_write`**
- Accepts structured fields: `title`, `author`, `date_read`, `genre`, `note`.
- Formats and prepends the entry to `BOOKS_READ.md` (most-recent-first order).
- No ADDITIONS staging cycle. Direct write to the file immediately.
- Non-blocking push to WordPress `POST /books` after every write.
- `date_read` is validated for YYYY-MM-DD format.

### Modified: `src/server-http.js`

- Import block: added `booksReadToolDefinition`, `booksLogWriteToolDefinition`,
  `handleBooksRead`, `handleBooksLogWrite` from `./tools/books.js`.
- TOOLS array: `booksReadToolDefinition` and `booksLogWriteToolDefinition` added
  to the `SKILL_ENABLED` conditional spread (both tools gate on `SKILL_FILE_PATH`
  since they resolve the books path from that env var).
- Dispatch switch: added `case "books_read"` and `case "books_log_write"`.
- Version bumped from `10.6.0` to `10.7.0` in all relevant strings.

## What is NOT changing

- `skill_write_addition` — unchanged. Still used for PF Session A paragraphs and
  other structural SKILL.md additions. The `prepend_list` path previously used for
  book log entries is now retired; use `books_log_write` for all book log entries.
- `skill_read` — unchanged. Does not include `BOOKS_READ.md` in its response.
  Books are on-demand only.
- All existing skill tools (`skill_write`, `skill_merge_additions`, `skill_history`,
  `skill_rollback`) — unchanged.
- All memory tools, web search, image search, and all other tools — unchanged.

## Migration required

Run `migrate-books.js` once after deploying the connector and plugin:

```
node migrate-books.js [--dry-run]
```

This extracts the **Books read.** section from `SKILL.md`, writes it to `BOOKS_READ.md`,
and writes the updated `SKILL.md` without the books section. A timestamped backup of
`SKILL.md` is created before any write.

Alternatively, upload `BOOKS_READ_seed.md` directly to the Railway volume at
`/data/skill/BOOKS_READ.md` and push the updated `SKILL.md` via the WordPress plugin
restore functionality.

## WordPress plugin

Requires `ts-ava-skill v1.4.0` (updated plugin included in this release package).
The connector pushes to `POST /books` after every `books_log_write` call.

## Environment variables

No new environment variables required. The connector derives the `BOOKS_READ.md` path
from the existing `SKILL_FILE_PATH` variable (same directory, different filename).
`WP_SKILL_URL` and `WP_SKILL_KEY` are reused for the WordPress books sync push.

## Deployment order

1. Deploy `ts-ava-skill v1.4.0` WordPress plugin.
2. Deploy Claude Connector `v10.7.0`.
3. Run `migrate-books.js` on the Railway volume to move the books section.
4. Confirm `books_read` returns correct entries in a Claude session.
5. Confirm WordPress Books Read tab displays the styled table.
6. In the next reading session, use `books_log_write` (not `skill_write_addition`)
   for all book log entries.
