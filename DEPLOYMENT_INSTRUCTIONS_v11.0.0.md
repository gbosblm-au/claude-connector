# Claude Connector v11.0.0 Deployment Instructions

## What changed from v10.8.0

New files:
- `src/tools/skill-modular.js` — Four new tools: skill_compile, skill_load_specialist,
  personality_write, dispatch_rule_add.

Updated files:
- `src/server-http.js` — Three new restore endpoints (/restore-modules, /restore-personality,
  /restore-dispatch-rules), new SKILL_MODULAR_ENABLED flag, four new tool dispatch cases,
  updated startup log. All v10.8.0 functionality preserved unchanged.

Unchanged files:
- `src/tools/skill.js`, `src/tools/books.js`, `src/tools/profiles.js`

## Deployment steps

1. Copy all files in `src/` to your connector source on Railway, preserving paths.
2. Redeploy the Railway service.
3. Verify startup log shows:
   ```
   claude-connector v11.0.0 on http://...
   Modular skill: disabled (set SKILL_MODULAR_ENABLED=true + SKILL_FILE_PATH to enable)
   Module restore endpoints: ENABLED (POST /restore-modules, /restore-personality, /restore-dispatch-rules)
   ```
4. The three restore endpoints are now live. Test by clicking "Push All 64 Module Files
   to Railway" in the WordPress Ava Skill > Modules tab.

## New Railway Variables (all optional)

| Variable | Value | Effect |
|---|---|---|
| `SKILL_MODULAR_ENABLED` | `true` | Activates skill_compile and related tools. Set only after modular files are on the volume. |

All existing variables (SKILL_FILE_PATH, RAILWAY_RESTORE_TOKEN, etc.) unchanged.

## Rollback

To roll back to v10.8.0: redeploy with the previous server-http.js.
The /restore-modules endpoint can be called at any time after v11.0.0 is deployed,
regardless of SKILL_MODULAR_ENABLED value.
