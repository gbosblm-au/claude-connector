# claude-connector v10.0.1 - WordPress REST API Restoration

## Why this release

v10.0.0 shipped two architectural changes that, in combination, caused the
WordPress GET / POST tools (and in fact every tool) to silently fail on hosts
that had not yet provisioned the `/data` SQLite volume:

1. `package.json` `start` script was switched from `node src/index.js` (stdio)
   to `node src/server-http.js` (HTTP).
2. `server-http.js` *eagerly* imported `tools-memory/index.js`, which
   transitively imports `better-sqlite3` (native module) at module load time.

When `better-sqlite3` failed to load (missing native binary, no `/data` volume,
old Node version, etc.), the entire MCP server died on boot and `wordpress_*`
tools returned `fetch failed` or never reached Claude at all.

The WordPress tool code itself was functionally identical to v8.1.0 (only
em-dash to hyphen cosmetic substitutions in comments/strings); the regression
was in the boot path.

## Fixes applied

1. **Memory subsystem is now lazy-loaded.**
   `tools-memory/index.js` and `tools-memory/admin.js` are only resolved via
   `await import()` *after* `MEMORY_AUTH_TOKEN` is confirmed present.
   If the dynamic import fails, the connector logs the error and continues
   running with memory disabled - WordPress and every other tool stay live.

2. **`wpFetch` hardened.**
   Added an explicit `AbortController` with `WP_FETCH_TIMEOUT_MS` (default
   30 s), reads the body once and includes a snippet for non-JSON 4xx/5xx
   pages (Cloudflare blocks, Wordfence rejects, etc.), distinguishes timeouts
   from network errors, and surfaces the WP `code` field when present.

3. **New `wordpress_health` MCP tool.**
   One-call end-to-end diagnostic: reports configured URL, REST root,
   username, performs an authenticated `GET /users/me?context=edit`, prints
   round-trip time, user roles, and `can post` / `can page` capabilities.

4. **`leadSearch.js` regex bug fixed.**
   v10.0.0 had `/\s+[|\--]\s+/g` which is a degenerate character-class range
   (`\-` to `-`). v10.0.1 uses `/\s+[|\-]\s+/g`.

5. **`package.json` scripts expanded.**
   - `start`           - HTTP server (v10 default, unchanged)
   - `start:http`      - explicit HTTP server alias
   - `start:stdio`     - stdio MCP transport (was v8 default)
   - `start:v8compat`  - v8.1.0-style stdio invocation

6. **All em-dashes verified absent** from every source, doc, config, and
   shell file in the package.

## How to install / upgrade

1. Download `claude-connector-v10.0.1.zip` (link in chat).
2. Unzip into your deployment directory:
   ```
   unzip claude-connector-v10.0.1.zip
   cd claude-connector-v10.0.1
   npm install
   ```
3. Choose your transport:
   ```
   npm start              # HTTP MCP server (port 3000)
   npm run start:stdio    # stdio MCP transport (v8 default)
   ```
4. To verify WordPress connectivity:
   ```
   curl -s http://localhost:3000/health | jq
   ```
   and from Claude call: `wordpress_health`

## Backward compatibility

All v10.0.0 tools, schemas, and endpoints are preserved unchanged.
Memory MCP behaves identically when `MEMORY_AUTH_TOKEN` is set; when unset,
the previously-fatal eager import is replaced with a graceful skip.
