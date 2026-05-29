# server-http.js Patch Instructions for v11.0.0

Apply the following changes to server-http.js. All changes are additive - existing functionality is preserved.

## 1. Add import at top (after skill.js import block)

Add this import alongside the other skill imports:

```javascript
import {
  skillCompileToolDefinition,
  skillLoadSpecialistToolDefinition,
  personalityWriteToolDefinition,
  dispatchRuleAddToolDefinition,
  handleSkillCompile,
  handleSkillLoadSpecialist,
  handlePersonalityWrite,
  handleDispatchRuleAdd,
  handleModulesRestoreFromWp,
} from './tools/skill-modular.js';
```

## 2. Add env var flag (after SKILL_ENABLED line)

```javascript
// Modular skill system - enabled when SKILL_MODULAR_ENABLED=true AND SKILL_FILE_PATH is set
const SKILL_MODULAR_ENABLED = SKILL_ENABLED && process.env.SKILL_MODULAR_ENABLED === 'true';
```

## 3. Add tools to TOOLS array (inside the SKILL_ENABLED spread)

Find the block starting `...(SKILL_ENABLED ? [` and add inside it:

```javascript
    ...(SKILL_MODULAR_ENABLED ? [
      skillCompileToolDefinition,
      skillLoadSpecialistToolDefinition,
      personalityWriteToolDefinition,
      dispatchRuleAddToolDefinition,
    ] : []),
```

## 4. Add dispatch cases (in the switch/case or if/else dispatch block)

Find where `case "skill_read":` is dispatched and add alongside it:

```javascript
case "skill_compile":           return await handleSkillCompile(args);
case "skill_load_specialist":   return await handleSkillLoadSpecialist(args);
case "personality_write":       return await handlePersonalityWrite(args);
case "dispatch_rule_add":       return await handleDispatchRuleAdd(args);
```

## 5. Add POST /restore-modules endpoint (after the /restore-skill endpoint)

```javascript
// POST /restore-modules
// Push modular skill files from WordPress to Railway volume.
// Validates RAILWAY_RESTORE_TOKEN. Body: { files: { "relative/path": "content", ... } }
app.post("/restore-modules", async (req, res) => {
  if (!SKILL_MODULAR_ENABLED) {
    return res.status(404).json({ error: "Modular skill system not enabled (set SKILL_MODULAR_ENABLED=true)" });
  }
  const token = req.headers["x-railway-restore-token"] || "";
  if (!RAILWAY_RESTORE_TOKEN || token !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token" });
  }
  try {
    const result = await handleModulesRestoreFromWp(req.body || {});
    if (!result.success) return res.status(500).json(result);
    log("info", `restore-modules: ${result.files_restored} files restored from WordPress push`);
    return res.json(result);
  } catch (err) {
    log("error", `restore-modules exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});
```

## 6. Add to startup log (in the startup logging block)

```javascript
log("info", `Modular skill: ${SKILL_MODULAR_ENABLED ? "ENABLED (skill_compile, personality_write, dispatch_rule_add)" : "disabled (set SKILL_MODULAR_ENABLED=true to enable)"}`);
log("info", `Modules restore endpoint: ${SKILL_MODULAR_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-modules)" : "disabled"}`);
```

## New Railway Environment Variables

| Variable | Value | Required |
|---|---|---|
| `SKILL_MODULAR_ENABLED` | `true` | Only when ready to activate modular mode |

All other env vars unchanged. `SKILL_FILE_PATH` must already be set.

## Rollback

To roll back to canonical mode: set `SKILL_MODULAR_ENABLED=false` (or remove it) and redeploy.
The modular files remain on Railway but are not used. The canonical SKILL.md is unaffected.
