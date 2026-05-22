# Changelog — claude-connector v10.4.0

## v10.4.0 — 2026-05-22

### New Feature: Ava Skill Volume (four new tools)

Four tools for persistent Ava SKILL.md storage and management on Railway Volume,
implementing the Ava Self-Modifying Skill Architecture specification (pre-PF10).

**New file:** `src/tools/skill.js`

#### `skill_read`
Load the Ava SKILL.md (canonical, pending, or historical version) from Railway
persistent volume. Called at session start after the stub file view to load the
full skill into context. Supports three read modes:
- Default: reads live canonical `/data/skill/SKILL.md`
- `pending=true`: reads `SKILL_PENDING.md` staging file
- `version_id="vNNN"`: reads archived version from `/data/skill/versions/`

#### `skill_write`
Write modified SKILL.md to Railway persistent volume. Two modes:
- Canonical write (`pending=false`): archives current version, increments version
  counter, updates `skill_meta.json` and `skill_history.json`, pushes WordPress backup.
  WordPress backup failure is non-blocking (logged but does not prevent success).
- Pending write (`pending=true`): overwrites `SKILL_PENDING.md` with no versioning.
  Pass empty string as content to clear the staging file after an OSC merge.

#### `skill_history`
List version history headers from `skill_history.json` (up to 50 entries).
Returns version ID, timestamp, line count, line delta, and change summary per entry.
Content is not included in list view; retrieve via `skill_read(version_id=...)`.

#### `skill_rollback`
Restore a previous archived version. Reads the target version from the archive,
executes the full canonical write sequence (archives current, writes restored content,
increments version counter, pushes WordPress backup). The rollback becomes a new
version entry so the complete trail is preserved.

### Volume File Layout

```
/data/skill/
  SKILL.md                              <- live canonical file
  SKILL_PENDING.md                      <- PF session staging (cleared after OSC merge)
  skill_meta.json                       <- current version metadata
  skill_history.json                    <- last 50 version headers
  versions/
    SKILL_20260522_143000_v001.md       <- archived on every canonical write
    SKILL_20260523_091500_v002.md
    ...
```

### New Railway Environment Variables

| Variable | Value | Notes |
|----------|-------|-------|
| `SKILL_FILE_PATH` | `/data/skill/SKILL.md` | Live canonical file |
| `SKILL_VERSION_DIR` | `/data/skill/versions/` | Version archive directory |
| `SKILL_META_PATH` | `/data/skill/skill_meta.json` | Version metadata |
| `WP_SKILL_URL` | `https://truesourceconsulting.com.au/wp-json/ava-skill/v1` | Plugin endpoint |
| `WP_SKILL_KEY` | Generated at plugin install | Matches plugin setting |

Skill tools are only advertised to Claude when `SKILL_FILE_PATH` is explicitly set.

### Companion WordPress Plugin

New plugin: `ts-ava-skill` (separate from `ts-ava-memory`).
- Receives content and metadata from `skill_write` and `skill_rollback` via REST.
- Stores current SKILL.md text and 30-entry version history in `wp_options`.
- Top-level admin menu "Ava Skill" with three tabs: Current Skill, Version History, Settings.
- REST endpoints at `/wp-json/ava-skill/v1/`: `/update`, `/rollback`, `/current`, `/history`, `/health`.
- Auth: single API key (`X-Ava-Skill-Key` header), same pattern as `ts-ava-memory`.

### Other Changes

- `CONNECTOR_USER_AGENT` updated to `claude-connector/10.4.0`
- `package.json` version bumped to `10.4.0`
- Startup log now reports Skill Volume status alongside Memory MCP status

### Upgrade Path from v10.3.0

No breaking changes. All existing tools and behaviour unchanged.
Skill tools are inert until `SKILL_FILE_PATH` is set in Railway Variables.
Follow `DEPLOYMENT_INSTRUCTIONS.md` for the complete go-live sequence.
