# CHANGELOG

## v8.0.0 (2026-05-02)

### New Tools

**Google Calendar** (`src/tools/googleCalendar.js`)
- `calendar_list_events` - List events in a time window with attendees, location, and links
- `calendar_create_event` - Create timed or all-day events with optional attendee invites
- `calendar_update_event` - Patch any field on an existing event by event ID
- `calendar_delete_event` - Delete/cancel an event with optional attendee notification
- Requires `https://www.googleapis.com/auth/calendar` added to `GOOGLE_DRIVE_SCOPES`

**Google Sheets** (`src/tools/googleSheets.js`)
- `sheets_get_metadata` - Return spreadsheet title, all sheet names, and grid sizes
- `sheets_read_range` - Read cells by A1 notation with formatted, raw, or formula values
- `sheets_write_range` - Overwrite a range with a 2D array of values (PUT semantics)
- `sheets_append_rows` - Append rows after the last data row without overwriting
- Requires `https://www.googleapis.com/auth/spreadsheets` added to `GOOGLE_DRIVE_SCOPES`
- Set `GOOGLE_SHEETS_ID` as the default spreadsheet

**Inbound Webhook Receiver** (`src/tools/webhook.js`)
- `webhook_poll_events` - Retrieve pending events from the inbound queue
- `webhook_clear_events` - Acknowledge and remove events by event_id or clear all
- `webhook_queue_status` - Summary of queue depth and server configuration
- `POST /webhook` HTTP endpoint registered in `server-http.js`
- Configurable via `WEBHOOK_SECRET`, `WEBHOOK_QUEUE_SIZE`, `WEBHOOK_PERSIST_PATH`

**Slack / Teams Messaging** (`src/tools/messaging.js`)
- `slack_send_message` - Send plain text or mrkdwn to a Slack channel or DM, supports threading
- `teams_send_message` - Send an Adaptive Card to a Teams channel via Incoming Webhook
- Configure via `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`, `TEAMS_WEBHOOK_URL`

**Full Page Web Fetch** (`src/tools/webFetch.js`)
- `web_fetch_page` - Fetch a URL and return full extracted plain text, heading structure, and links
- Strips scripts, styles, navigation, and ads using cheerio (already a project dependency)
- Configurable `max_chars` (default 50,000, max 200,000) and `timeout_ms`

**WordPress Get Content** (appended to `src/tools/wordpress.js`)
- `wordpress_get_content` - Fetch full post or page content by numeric ID
- Returns raw content, title, slug, status, categories, tags, excerpt, and featured media ID

**Email Reply Check** (appended to `src/tools/emailTracking.js`)
- `email_reply_check` - Per-recipient engagement summary with open/click counts and engagement signal
- Returns `engagement` level: none / low / medium / high / replied
- `reply_detected` will activate when IMAP polling is configured

**Google Drive Overwrite by Name** (appended to `src/tools/googleDrive.js`)
- `google_drive_overwrite_file` - Search folder for existing file by exact name, resolve its ID, PATCH content
- If no match found, creates new file in the target folder
- `getAccessToken` exported from `googleDrive.js` for Calendar and Sheets reuse

### Removed Tools

- `google_drive_upload` - Removed from tool registry (POST-only, always created new files)
  - Replaced by `google_drive_create_file` and `google_drive_overwrite_file`

### Configuration Changes (new env vars)

- `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEETS_ID`, `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`
- `TEAMS_WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_QUEUE_SIZE`, `WEBHOOK_PERSIST_PATH`

Updated `GOOGLE_DRIVE_SCOPES` example for all features:
`https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets`

---

# Changelog

## v7.0.1 - User-Agent Hardening

### Changed
- Added `CONNECTOR_USER_AGENT` constant to `src/config.js` - a single source of
  truth for the User-Agent string sent on all outbound HTTP requests.
  Value: `claude-connector/7.0.1 (TrueSource Consulting; WordPress automation; +https://truesourceconsulting.com.au)`
- `src/tools/wordpress.js`: `wpFetch()` now sends `User-Agent: CONNECTOR_USER_AGENT`
  on every WordPress REST API call (GET and POST).
- `src/tools/wordpressMedia.js`: All four `fetch()` calls (image download,
  media upload, metadata update, featured image set) now send the correct UA.
- `src/tools/leadSearch.js`: Replaced hardcoded `claude-connector/6.1 lead-research`
  UA string with `CONNECTOR_USER_AGENT`.

### Why
SiteGround's Antibot AI was blocking requests due to an outdated or
unrecognised User-Agent string (HeadlessChrome/Chrome 120). A descriptive,
honest UA that clearly identifies the connector resolves the block without
requiring IP whitelisting.

---

## v7.0.0 - TrueSource Outreach Email Pipeline (SCOPE-01 / 03 / 04 / 05)

### Added

- **SCOPE-01 - SMTP send** with three named senders sharing one SMTP account
  (`team@truesourceconsulting.com.au`). Per-sender Reply-To and signature.
  Four new MCP tools:
  - `email_send` -- send a single outreach email (HTML + plain-text alt).
  - `email_get_config` -- non-secret config for a single sender (signature
    preview, smtp_configured flag, html_enabled, tracking_enabled,
    schedule_enabled).
  - `email_get_sender_profiles` -- list all configured senders for the
    skill UI to build a sender selector.
  - `email_validate_address` -- format-only validation, no SMTP handshake.

  Server-side rate limit: 20 sends per rolling hour across all senders.
  Master kill-switch: `EMAIL_SEND_ENABLED=false`.

- **SCOPE-03 - HTML email templating**. Branded TrueSource template
  (teal #123F4B header, gold #D4AF37 links). All inline CSS, table-based
  layout for Outlook compatibility. Plain-text alternative is always
  generated. Logo URL via `EMAIL_LOGO_URL`; falls back to text wordmark
  when not set. New per-sender env vars:
  `SENDER_[NAME]_TITLE`, `SENDER_[NAME]_PHONE`, `SENDER_[NAME]_LINKEDIN`.

- **SCOPE-04 - Open + click tracking** persisted to a Google Drive CSV
  (`TrueSource_Email_Tracking.csv`). New HTTP endpoints (NOT MCP tools):
  - `GET /track/open?id=...` -- returns 1x1 PNG, logs an open event.
  - `GET /track/click?id=...&url=...` -- 302 redirect to the original
    `https://` URL, logs a click event.

  Two new MCP tools for querying:
  - `email_get_tracking` -- filter events by tracking_id / to_address /
    company.
  - `email_tracking_summary` -- aggregate stats with documented caveats.

  User-Agent classification: `bot`, `mobile_email`, `webmail`,
  `desktop_email`, `unknown`. Bot opens are excluded from rate calculations.
  IPs are SHA-256 hashed (never stored raw). `EMAIL_TRACKING_ENABLED=false`
  disables pixel injection and link rewriting cleanly.

- **SCOPE-05 - Deferred & drip scheduling**. In-process node-cron loop runs
  every 60 seconds; schedule store persisted to `/data/schedule_store.json`
  on the Railway volume. Three new MCP tools:
  - `email_schedule` -- queue a deferred send OR a drip sequence.
  - `email_schedule_cancel` -- cancel by `schedule_id` or `sequence_id`.
  - `email_schedule_list` -- list pending and recent schedules.

  Drip sequences (max 10 steps) auto-stop on the first open or click.
  All times in AEST/AEDT (Australia/Melbourne) via luxon. UTC offsets
  rejected with a clear error message.

- **New runtime dependencies:** `nodemailer`, `node-cron`, `luxon`.

- **Health endpoint** now reports email-pipeline state
  (`emailSend`, `emailHtml`, `emailTracking`, `emailScheduler`,
  `smtpConfigured`).

### Changed

- Server version bumped to `7.0.0` in both stdio and HTTP transports.
- HTTP server now boots the in-process scheduler at startup
  (loads `schedule_store.json`, registers the cron tick).

### Notes

- Per SCOPE-04 the tracking CSV is auto-created on first run if
  `TRACKING_GDRIVE_FILE_ID` is unset; the operator must then pin the
  returned id via env var so it survives restarts. A warning is logged
  with the exact env var value to set.
- Per SCOPE-05 the Railway service requires a persistent volume mounted
  at `/data` so the schedule store survives redeployments.
- The signature block placeholder (`[Signature: Your name | ...]`) must
  NOT be present in `body_text` -- the signature is appended server-side
  from per-sender env vars.

---

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
