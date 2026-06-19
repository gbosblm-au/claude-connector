# Claude Connector v11.1.0 Changelog

## New tool: skill_audit

Adds `skill_audit` to the connector skill toolset. Returns a structured audit of all Ava
skill files on the Railway persistent volume, automatically detecting whether the connector
is running in canonical or modular mode.

### What it returns

**Canonical mode** (SKILL_MODULAR_ENABLED not set or false):
- SKILL.md
- PROFILES.md
- PERSONALITY.md
- BOOKS_READ.md

**Modular mode** (SKILL_MODULAR_ENABLED=true):
- CORE.md
- PERSONALITY.md
- MANIFEST.json
- DISPATCH_RULES.json
- All specialist module files in the modules/ directory (recursive, alphabetically sorted)

For every file it returns: label, relative file path, exists (bool), line count,
last_modified (ISO timestamp), and size_bytes. Missing files are listed in the summary.

### Why it exists

Provides a single-call health check for the skill volume after any deployment, Railway
redeploy, or WordPress push. Replaces manual inspection and makes it easy to confirm:
- Whether modular mode is active as expected
- Which module files are present after a Push All to Railway
- Line counts on SKILL.md and CORE.md to verify no truncation occurred
- Last-modified timestamps to confirm a push landed correctly

### Availability

skill_audit is advertised whenever SKILL_FILE_PATH is configured (same gate as skill_read,
skill_write, etc.). It is available in both canonical and modular modes.

### Files changed

- `src/tools/skill.js` — added `statSync` import, `skillAuditToolDefinition`, `handleSkillAudit`
- `src/server-http.js` — added import, TOOLS array entry, dispatch case, startup log update
- `package.json` — version bumped to 11.1.0

### Note on skill_compile availability

`skill_compile` was correctly built into v11.0.0 and is present in the connector. It is only
advertised to Claude when SKILL_MODULAR_ENABLED=true in Railway Variables. If skill_compile
is not surfacing as a tool, the cause is one of:
1. SKILL_MODULAR_ENABLED is not set to the string "true" in Railway Variables.
2. The Railway service was not redeployed after the variable was set.
3. The modular files (CORE.md, MANIFEST.json, modules/) are not yet on the volume.
Set the variable, trigger a Railway redeploy, and confirm the startup log shows
"Modular skill: ENABLED".

