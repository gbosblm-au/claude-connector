# Changelog

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
