# Claude Connector — v10.6.0 Changelog

## Changes from v10.5.0

### 1. skill_write_addition now syncs pending queue to WordPress in real time

**Root cause of the bug:** `handleSkillWriteAddition` wrote each staged block to the
Railway Volume (`SKILL_ADDITIONS.md`) but never called `pushToWordPress`. WordPress
therefore never saw any additions, so the Skill Additions tab in the WP plugin always
showed a count of 0 regardless of how many blocks were staged.

**Fix (`src/tools/skill.js`):**
After `writeAdditionsMeta(...)`, a non-blocking `pushToWordPress('additions', ...)` call
is made with the full `SKILL_ADDITIONS.md` content (read fresh after the append).
This mirrors the Railway pending queue to WordPress so the WP admin can see the live
queue immediately after each `skill_write_addition` call.

- Uses the existing `/additions` REST endpoint on the WP plugin (added in v1.2.0).
- Non-blocking: errors are logged at `warn` level but do not fail the tool call.
- Only fires when both `WP_SKILL_URL` and `WP_SKILL_KEY` are set (same guard as
  the canonical write push).
- Payload: `{ content, version_id, line_count, change_summary, timestamp }`.
  The WP endpoint auto-derives `additions_count` and `line_count` from content,
  so the manually-derived values serve as hints only.

### 2. New REST endpoint: POST /restore-skill

Enables the WordPress admin "Push to Railway" button (ts-ava-skill plugin v1.3.0+)
to restore the Railway Volume SKILL.md from the WordPress database backup.
Designed for use after a Railway deployment that caused volume data loss.

**New Railway Variable required:** `RAILWAY_RESTORE_TOKEN`

Set the same value in both:
- Railway Variables: `RAILWAY_RESTORE_TOKEN=<secret>`
- WordPress admin: Ava Skill > Settings > Railway Push > Railway Restore Token

**Endpoint (`src/server-http.js`):**

```
POST /restore-skill
Headers:
  Content-Type: application/json
  X-Railway-Restore-Token: <RAILWAY_RESTORE_TOKEN>

Body:
{
  "content":        "<full SKILL.md text>",
  "version_id":     "v014",
  "line_count":     711,
  "change_summary": "Manual restore push from WordPress admin",
  "timestamp":      "2026-05-25T12:00:00Z",
  "source":         "wordpress-admin-push"
}

Success (200):
{
  "success":    true,
  "version_id": "v015",     // new version after restore
  "line_count": 711,
  "archived_as": "...",
  "wordpress_backup": { ... }
}

Errors:
  503 - SKILL_FILE_PATH not set (Skill Volume disabled)
  503 - RAILWAY_RESTORE_TOKEN not set on connector
  401 - X-Railway-Restore-Token header missing
  403 - X-Railway-Restore-Token header invalid
  400 - content field missing or empty
  500 - write failure (check Railway Volume mount)
```

**Implementation:**
- Gated on `SKILL_ENABLED` (requires `SKILL_FILE_PATH`).
- Validates `X-Railway-Restore-Token` using strict string equality (not `hash_equals`
  — kept simple since this is a server-to-server internal endpoint).
- Delegates to new `handleSkillRestoreFromWp(body)` export in `skill.js`, which calls
  the existing `canonicalWrite()` function. This means the restore:
  - Archives the current Railway Volume SKILL.md before overwriting.
  - Increments the version counter (e.g., `v014` → `v015`).
  - Updates `skill_meta.json` and `skill_history.json`.
  - Sends a non-blocking WP backup echo (so WP reflects the restored version).
- Startup log shows restore endpoint status:
  `ENABLED (POST /restore-skill)` or `disabled (set RAILWAY_RESTORE_TOKEN)`.
- Listed in the 404 endpoint directory.

**New export in skill.js:** `handleSkillRestoreFromWp(body): Promise<object>`

### 3. Version bumped to 10.6.0

- `server-http.js` header comment: `v10.6.0`
- `{ name: "claude-connector", version: "10.6.0" }`
- Startup log: `claude-connector v10.6.0`
- User-Agent string: `claude-connector/10.6.0 (ava-skill-sync)`
- Inline section comments updated from `v10.5.0` to `v10.6.0`

### Railway Variables summary (complete set for skill features)

| Variable                | Required for                          | Value                               |
|-------------------------|---------------------------------------|-------------------------------------|
| `SKILL_FILE_PATH`       | All skill tools                       | `/data/skill/SKILL.md`             |
| `SKILL_VERSION_DIR`     | Version archiving                     | `/data/skill/versions/`            |
| `SKILL_META_PATH`       | Metadata persistence                  | `/data/skill/skill_meta.json`      |
| `WP_SKILL_URL`          | WP backup push (canonical + additions)| `https://yoursite.com/wp-json/ava-skill/v1` |
| `WP_SKILL_KEY`          | WP backup auth                        | Matches WP Settings > Connector API Key |
| `RAILWAY_RESTORE_TOKEN` | POST /restore-skill endpoint          | Matches WP Settings > Railway Restore Token |
