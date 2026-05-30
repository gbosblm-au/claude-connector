# Claude Connector v11.1.0 Deployment Instructions

## What changed from v11.0.0

New tool: `skill_audit`

Updated files:
- `src/tools/skill.js` - added statSync import, skillAuditToolDefinition, handleSkillAudit
- `src/server-http.js` - import, TOOLS entry, dispatch case, startup log, version 11.1.0
- `package.json` - version bumped to 11.1.0

No new environment variables. No database changes. No new endpoints.
All v11.0.0 functionality preserved unchanged.

## Deployment steps

1. Copy the two updated source files to your connector on Railway:
   - src/tools/skill.js
   - src/server-http.js

   (package.json version bump is cosmetic; redeploy will pick up the file changes regardless.)

2. Trigger a Railway redeploy.

3. Verify the startup log shows version 11.1.0:
   ```
   Skill Volume: ENABLED (/data/skill/SKILL.md) - skill_read, skill_write, skill_write_addition,
   skill_merge_additions, skill_history, skill_rollback, skill_audit
   ```

4. Verify skill_audit appears in the Claude tool list in a new session.

## Confirming skill_compile is active (if needed)

If skill_compile is not appearing as an available tool after deploying v11.0.0/v11.1.0:

Step 1 - Check Railway Variables for SKILL_MODULAR_ENABLED=true (exact string, case-sensitive).
Step 2 - Check that modular files are on the volume. Click Push All 64 Module Files in the
         WordPress Ava Skill > Modules tab if not already done.
Step 3 - Trigger a Railway redeploy after confirming the variable is set.
Step 4 - Confirm startup log shows "Modular skill: ENABLED (skill_compile, personality_write,
         dispatch_rule_add, skill_load_specialist)".

skill_compile is in the code. It is gated on the env variable only.

## Rollback

Redeploy with the previous src/server-http.js and src/tools/skill.js from v11.0.0.
