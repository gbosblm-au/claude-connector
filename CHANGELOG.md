# Changelog

## v6.1.0 - Full Google Drive CRUD Toolkit

### Added

- **Eight new Google Drive MCP tools** covering the full read / download /
  upload / write / overwrite / metadata / permissions surface:
  - `google_drive_check_connection` -- diagnostic for credentials + quota
  - `google_drive_search_files` -- search by name, full-text, mimeType,
    parent folder, owner, modified-time window, or raw Drive query
  - `google_drive_read_file_content` -- read text of a file, with automatic
    export of Google Docs / Sheets / Slides / Drawings
  - `google_drive_download_file_content` -- base64 binary download with
    optional local save path
  - `google_drive_create_file` -- create a new file OR overwrite an
    existing one (by id, or by filename-in-folder)
  - `google_drive_get_file_metadata` -- rich metadata including owners,
    MIME type, parents, links and capabilities
  - `google_drive_list_recent_files` -- recently-modified files
  - `google_drive_get_file_permissions` -- who can read/edit the file

- **Default OAuth scope widened** to `https://www.googleapis.com/auth/drive`
  so the new tools can discover and modify pre-existing files. Override via
  `GOOGLE_DRIVE_SCOPES` to tighten (e.g. `drive.readonly`, `drive.file`).

- **Workspace domain-wide delegation support** via
  `GOOGLE_IMPERSONATE_SUBJECT` (service-account `sub` JWT claim).

- **Shared Drive support** -- every Drive API call now passes
  `supportsAllDrives=true` and `includeItemsFromAllDrives=true`.

- **`GOOGLE-DRIVE-SETUP.md`** -- step-by-step guide for Service Account and
  OAuth2 refresh-token auth, scope cheatsheet, typical flows, troubleshooting.

### Changed

- `src/tools/googleDrive.js` rewritten to add the new tools while preserving
  the exact request/response shapes of the existing `google_drive_upload`
  and `google_drive_list` tools.
- Both `src/index.js` (stdio) and `src/server-http.js` (HTTP) now register
  and route all 10 Drive tools.
- `src/config.js` now resolves bundled project data paths correctly, fixing the
  default LinkedIn CSV and profile locations so existing functionality keeps
  working when environment overrides are not supplied.
- `src/config.js` now auto-loads `./data/google-service-account.json` when it
  exists, while still allowing `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to override it.
- `.env.example` documents `GOOGLE_DRIVE_SCOPES`,
  `GOOGLE_IMPERSONATE_SUBJECT`, and bundled key auto-loading.

### Backwards compatibility

- The existing `google_drive_upload` and `google_drive_list` handlers keep
  their original input schemas and output text. Existing Claude skills and
  automations continue to work unchanged.

## v6.0.1 - Fix: Restore WP Publishing + Security Cleanup

### Fixed

- **Restored `SKILL.md` and `SKILL-market-intelligence-publisher.md`** — These Claude skill
  definition files were accidentally omitted from the v6.0.0 package. They provide the
  article-writing and market-intelligence publishing workflows that Claude uses when
  creating WordPress content. Without them, Claude may not know the correct publishing
  workflow.

- **Removed hardcoded API keys from `.env.example`** — The Pexels and Unsplash API keys
  were previously embedded as real values in the `.env.example` template file. They are
  now replaced with placeholder strings (`your_pexels_api_key_here`,
  `your_unsplash_access_key_here`) consistent with how other keys are handled.
  **Set real keys in Railway Variables, not in `.env.example`.**

- **Added WordPress credential documentation to `.env.example`** — Added a dedicated
  `WORDPRESS` section documenting `WP_URL`, `WP_USERNAME`, and `WP_APP_PASSWORD`
  environment variables for clarity. These can also be set at runtime via the
  `set_wordpress_credentials` MCP tool.

- **Aligned version numbers** — All version references (`package.json`, `index.js`,
  `server-http.js` health endpoint, and MCP server declaration) now consistently
  report `6.0.1`.

### Railway Deployment Checklist

Ensure these environment variables are set in your Railway service Variables tab:

**Required for WP publishing:**
```
WP_URL=https://yoursite.com
WP_USERNAME=your_wordpress_username
WP_APP_PASSWORD=your_application_password
```

**Required for image search:**
```
PEXELS_API_KEY=<your-pexels-api-key>
UNSPLASH_ACCESS_KEY=<your-unsplash-access-key>
IMAGE_PROVIDER=auto
```

**Required for web/news search:**
```
BRAVE_API_KEY=<your-brave-api-key>
SEARCH_PROVIDER=brave
NEWS_PROVIDER=brave
```

---

## v6.0.0 - Image Search Integration

### Added

- **`src/tools/imageSearch.js`** - New `image_search` MCP tool with dual-provider support for
  Pexels and Unsplash.

  Features:
  - `provider` parameter: `"pexels"`, `"unsplash"`, `"both"`, or `"auto"` (default).
    - `"auto"` prefers Pexels when `PEXELS_API_KEY` is set, falls back to Unsplash.
    - `"both"` queries both APIs concurrently and interleaves results.
  - `orientation` filter: `"landscape"`, `"portrait"`, or `"square"`.
    Unsplash's `"squarish"` value is handled automatically.
  - `size` filter (Pexels only): `"small"`, `"medium"`, or `"large"`.
  - `color` filter: colour name (e.g. `"blue"`) or hex value for Unsplash.
  - Configurable result count via `num_results` (default 5, max 20).
  - Normalised result shape across both providers: `imageUrl`, `thumbnailUrl`,
    `photographer`, `photographerUrl`, `pageUrl`, `width`, `height`.
  - Unsplash attribution URLs include `utm_source=claude_connector&utm_medium=referral`
    as required by the Unsplash API guidelines.
  - When `"both"` is used and one provider fails, the tool gracefully continues
    with the available provider rather than throwing a hard error.

- **`src/config.js`** - New config keys and validation helpers:
  - `config.imageProvider` - reads `IMAGE_PROVIDER` env var (default `"auto"`).
  - `config.pexelsApiKey` - reads `PEXELS_API_KEY` env var.
  - `config.unsplashAccessKey` - reads `UNSPLASH_ACCESS_KEY` env var.
  - `config.defaultImageResults` - reads `DEFAULT_IMAGE_RESULTS` env var (default `5`).
  - `config.maxImageResults` - reads `MAX_IMAGE_RESULTS` env var (default `20`).
  - `requirePexelsKey()` - lazy validation helper, throws a clear error if key is absent.
  - `requireUnsplashKey()` - lazy validation helper, throws a clear error if key is absent.

- **`src/index.js`** - Registered `image_search` tool in the stdio MCP server
  (used by Claude Desktop).

- **`src/server-http.js`** - Registered `image_search` tool in the HTTP MCP server
  (used by claude.ai browser connector on Railway).

- **`.env.example`** - Documented `IMAGE_PROVIDER`, `PEXELS_API_KEY`,
  `UNSPLASH_ACCESS_KEY`, `DEFAULT_IMAGE_RESULTS`, and `MAX_IMAGE_RESULTS`.

### Unchanged

All existing tools (web search, news search, LinkedIn, WordPress) are unmodified.
No existing functionality has been removed or broken.
