# Changelog

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

### Deployment Notes

Add the following environment variables in Railway (or your `.env` file for local use):

```
PEXELS_API_KEY=<your-pexels-api-key>
UNSPLASH_ACCESS_KEY=<your-unsplash-access-key>
IMAGE_PROVIDER=auto
```

The `IMAGE_PROVIDER=auto` setting will use Pexels as the primary provider
and Unsplash as a fallback. Set `IMAGE_PROVIDER=both` to draw results from
both providers simultaneously.

### Unchanged

All existing tools (web search, news search, LinkedIn, WordPress) are unmodified.
No existing functionality has been removed or broken.
