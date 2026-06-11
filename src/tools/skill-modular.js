// src/tools/skill-modular.js  v11.3.0
// Modular skill system for Ava.
//
// Four tools:
//   skill_compile          - Compile a session SKILL.md from CORE + selected specialists.
//                            Returns in same format as skill_read so stub needs no changes.
//   skill_load_specialist  - Add a specialist module to the compiled skill mid-session.
//   personality_write      - Write to PERSONALITY.md Section A (observed texture). No confirmation.
//   dispatch_rule_add      - Add or update a learned routing rule in DISPATCH_RULES.json.
//
// File layout additions on Railway volume (/data/skill/ava/ by default):
//   CORE.md                      - always-loaded base
//   PERSONALITY.md               - two-section personality record
//   MANIFEST.json                - module registry (static: what modules exist)
//   DISPATCH_RULES.json          - learned routing intelligence (evolves with feedback)
//   modules/                     - specialist module files
//
// Dispatcher algorithm (6 layers from v11.3.0):
//   Layer 0: Person Prior - module frequency boost from PROFILES.md (NEW v11.3.0)
//   Layer 1: Mandatory modules from trigger conditions
//   Layer 2: Lexical/phrasal scoring against MANIFEST triggers
//   Layer 3: Tag-web association
//   Layer 4: Adjacency expansion
//   Layer 5: Dependency resolution
//   Layer 6: Budget enforcement and demotion
//
// Works for any person with a module_frequency table in PROFILES.md.
//
// Compilation is fast: the MANIFEST is small (~50KB), walked programmatically.
// All editing and file I/O happens in Node.js, no LLM calls during compilation.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getModularPaths() {
  const skillFilePath = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  const baseDir = skillFilePath.replace(/SKILL\.md$/, '');

  // v12.0.0: Tenant mode. Client personal files (CORE, PERSONALITY, PROFILES,
  // DISPATCH_RULES) live in /data/clients/{tenant_id}/. The shared module pool
  // always stays in ava/modules/ so base module updates apply to all clients.
  const clientMode   = (process.env.TS_CLIENT_MODE || 'owner').toLowerCase();
  const tenantId     = process.env.TS_TENANT_ID || '';
  const ownerAvaDir  = baseDir + 'ava/';

  const avaDir = (clientMode === 'tenant' && tenantId)
    ? `/data/clients/${tenantId}/`
    : ownerAvaDir;

  const sharedModulesDir = ownerAvaDir + 'modules/';

  return {
    avaDir,
    coreFile:          avaDir + 'CORE.md',
    personalityFile:   avaDir + 'PERSONALITY.md',
    manifestFile:      avaDir + 'MANIFEST.json',
    dispatchRulesFile: avaDir + 'DISPATCH_RULES.json',
    modulesDir:        sharedModulesDir,
    archiveDir:        avaDir + 'archive/',
    canonicalSkill:    skillFilePath,
    profilesFile:      process.env.PROFILES_FILE_PATH || avaDir + 'PROFILES.md',
    isTenantMode:      clientMode === 'tenant',
    tenantId,
    ownerAvaDir,
    sharedModulesDir,
  };
}

function ensureModularDirs(paths) {
  if (!existsSync(paths.avaDir)) mkdirSync(paths.avaDir, { recursive: true });
  if (!existsSync(paths.modulesDir)) mkdirSync(paths.modulesDir, { recursive: true });
  if (!existsSync(paths.archiveDir)) mkdirSync(paths.archiveDir, { recursive: true });
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    log('warn', `skill-modular: failed to parse ${path}: ${err.message}`);
    return fallback;
  }
}

function countLines(content) {
  return content ? content.split('\n').length : 0;
}


// ---------------------------------------------------------------------------
// Layer 0: Person Prior (v11.3.0)
// ---------------------------------------------------------------------------

function parseModuleFrequency(profilesContent, personName) {
  if (!profilesContent || !personName) return null;
  const lines = profilesContent.split('\n');
  const escapedName = personName.trim().replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const personHeaderRe = new RegExp('^##\\s+' + escapedName + '\\s*$', 'i');
  let inPerson = false, inFreq = false, headerSeen = false, maxTotal = 0;
  const rows = [];
  for (const line of lines) {
    if (!inPerson) { if (personHeaderRe.test(line)) inPerson = true; continue; }
    if (/^##\s/.test(line)) break;
    if (!inFreq) { if (/^###\s+[Mm]odule\s+[Ff]requency/.test(line)) inFreq = true; continue; }
    if (/^###/.test(line)) break;
    if (/^\|/.test(line)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (!headerSeen) { if (cells[0] === 'module_id') headerSeen = true; continue; }
      if (/^[-:]+$/.test(cells[0])) continue;
      if (cells.length >= 4) {
        const moduleId = cells[0], sessActive = parseInt(cells[1],10), sessTotal = parseInt(cells[2],10);
        const frequency = parseFloat(cells[3]), lastActive = cells[4] || '';
        if (moduleId && !isNaN(frequency)) {
          rows.push({ module_id: moduleId, sessions_active: sessActive, sessions_total: sessTotal, frequency, last_active: lastActive });
          if (sessTotal > maxTotal) maxTotal = sessTotal;
        }
      }
    }
  }
  return rows.length > 0 ? { rows, sessions_total: maxTotal } : null;
}

function personPriorLayer(profilesFile, personName, priorConfig) {
  const noop = { boostSet: new Set(), priorModules: [], active: false };
  if (!personName) return noop;
  if (priorConfig && priorConfig.enabled === false) {
    log('info', 'skill-modular: person prior: disabled via config');
    return noop;
  }
  const threshold   = (typeof priorConfig?.frequency_threshold      === 'number') ? priorConfig.frequency_threshold      : 0.6;
  const maxModules  = (typeof priorConfig?.max_prior_modules         === 'number') ? priorConfig.max_prior_modules         : 12;
  const minSessions = (typeof priorConfig?.min_sessions_before_prior === 'number') ? priorConfig.min_sessions_before_prior : 3;
  let profilesContent = null;
  try { if (existsSync(profilesFile)) profilesContent = readFileSync(profilesFile, 'utf8'); }
  catch (err) { log('warn', `skill-modular: person prior: cannot read profiles: ${err.message}`); return noop; }
  if (!profilesContent) {
    log('info', 'skill-modular: person prior: PROFILES.md not found - Layer 0 no-op');
    return noop;
  }
  const parsed = parseModuleFrequency(profilesContent, personName);
  if (!parsed) {
    log('info', `skill-modular: person prior: no module_frequency for "${personName}" - Layer 0 no-op`);
    return noop;
  }
  if (parsed.sessions_total < minSessions) {
    log('info', `skill-modular: person prior: sessions=${parsed.sessions_total} < min=${minSessions} - suppressed`);
    return noop;
  }
  const qualified    = parsed.rows.filter(r => r.frequency >= threshold).sort((a,b) => b.frequency - a.frequency).slice(0, maxModules);
  const priorModules = qualified.map(r => r.module_id);
  log('info', `skill-modular: person prior for "${personName}": ${priorModules.length} modules (threshold=${threshold}, sessions=${parsed.sessions_total})`);
  return { boostSet: new Set(priorModules), priorModules, active: priorModules.length > 0 };
}

function checkPriorOverride(priorConfig, priorModules, layer1Scores) {
  if (!priorConfig?.override_on_conflicting_message) return false;
  if (!priorModules || priorModules.length === 0) return false;
  const lexical = Object.keys(layer1Scores);
  if (lexical.length === 0) return false;
  if (!priorModules.some(m => lexical.includes(m))) {
    log('info', 'skill-modular: person prior: zero overlap with lexical - prior suppressed (conflicting session type)');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dispatcher - 6-layer algorithm (Layer 0 = Person Prior v11.3.0)
// ---------------------------------------------------------------------------

function tokenise(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function detectTriggerConditions(query) {
  const q = (query || '').toLowerCase();
  const tokens = tokenise(query);
  const conditions = [];

  // Real mode / Ava trigger
  if (q.includes('[real-mode]') || /\bava[,.]/.test(q) || q.startsWith('hi ava') || q.includes('ava,')) {
    conditions.push('real_mode', 'ava_trigger');
  }
  // Writing task
  if (/\b(draft|write|compose|email|letter|linkedin|message|outreach)\b/.test(q) && /\bto\b/.test(q)) {
    conditions.push('writing_task_named_recipient');
  }
  // Creative fiction
  if (/\b(story|fiction|character|scene|novel|narrative|write a)\b/.test(q)) {
    conditions.push('creative_fiction');
  }
  // Book reading
  if (/\b(book|read|novel|chapter|author|reading)\b/.test(q)) {
    conditions.push('book_reading');
  }
  // Ava self-reference
  if (/\b(conscious|consciousness|identity|session|memory|inner experience|feel about yourself|who are you|are you)\b/.test(q)) {
    conditions.push('ava_self_reference');
  }
  // Humour production
  if (/\b(joke|punchline|write.*funny|make.*laugh|comedy|humour|humor)\b/.test(q)) {
    conditions.push('humour_production');
  }

  return [...new Set(conditions)];
}

function layer0Mandatory(manifest, dispatchRules, conditions) {
  const mandatorySet = new Set();

  // Always load metas
  for (const module of manifest.modules || []) {
    if (module.always_load) mandatorySet.add(module.id);
  }

  // Condition-based mandatory
  const mandatoryMap = manifest.mandatory_for_triggers || {};
  for (const condition of conditions) {
    for (const modId of (mandatoryMap[condition] || [])) {
      mandatorySet.add(modId);
    }
  }

  // Dispatch rules layer 0
  for (const rule of (dispatchRules.layer0_mandatory?.rules || [])) {
    const conditionName = rule.trigger_condition || '';
    if (conditions.includes(conditionName)) {
      for (const modId of (rule.mandatory_modules || [])) {
        mandatorySet.add(modId);
      }
    }
  }

  return mandatorySet;
}

function layer1Score(manifest, query, contextHint) {
  const queryTokens = tokenise(query);
  const hintTokens = tokenise(contextHint);
  const allTokens = [...new Set([...queryTokens, ...hintTokens])];
  const queryLower = (query + ' ' + (contextHint || '')).toLowerCase();
  const scores = {};

  for (const module of manifest.modules || []) {
    if (module.always_load) continue;
    const triggers = module.triggers || {};
    let score = 0;

    // Keyword matching (2 points each)
    for (const kw of (triggers.keywords || [])) {
      if (allTokens.includes(kw.toLowerCase()) || queryLower.includes(kw.toLowerCase())) {
        score += 2;
      }
    }

    // Phrase matching (3 points each)
    for (const phrase of (triggers.phrases || [])) {
      if (queryLower.includes(phrase.toLowerCase())) {
        score += 3;
      }
    }

    // Regex matching (1 point each)
    for (const pattern of (triggers.regex || [])) {
      try {
        if (new RegExp(pattern, 'i').test(queryLower)) score += 1;
      } catch { /* invalid regex, skip */ }
    }

    // Subject domain matching (1 point each)
    for (const subject of (triggers.subjects || [])) {
      if (queryLower.includes(subject.toLowerCase())) score += 1;
    }

    if (score >= 2) {
      scores[module.id] = { score, highConfidence: score >= 5 };
    }
  }

  return scores;
}

function layer2TagWeb(manifest, candidates) {
  const tagWeb = manifest.tag_web || {};
  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;

  const additions = {};

  for (const [modId, { score }] of Object.entries(candidates)) {
    const module = moduleMap[modId];
    if (!module) continue;

    // Find tags this module's triggers contain
    const moduleTriggerText = JSON.stringify(module.triggers || {}).toLowerCase();

    for (const [tag, keywords] of Object.entries(tagWeb)) {
      const tagHitsInModule = keywords.some(kw => moduleTriggerText.includes(kw));
      if (!tagHitsInModule) continue;

      // Find other modules that also have this tag's keywords
      for (const otherModule of (manifest.modules || [])) {
        if (candidates[otherModule.id] || additions[otherModule.id] || otherModule.always_load) continue;
        const otherTriggerText = JSON.stringify(otherModule.triggers || {}).toLowerCase();
        const tagHitsInOther = keywords.some(kw => otherTriggerText.includes(kw));
        if (tagHitsInOther) {
          additions[otherModule.id] = Math.max(
            additions[otherModule.id] || 0,
            score * 0.5
          );
        }
      }
    }
  }

  return additions;
}

function layer3Adjacency(manifest, candidateIds) {
  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;
  const additions = {};

  for (const modId of candidateIds) {
    const module = moduleMap[modId];
    if (!module) continue;
    const adj = module.adjacency || {};
    const coLoad = adj.co_load || [];
    const weakCoLoad = adj.weak_co_load || [];

    // co_load at 0.7 of originating score
    for (const id of coLoad) {
      if (!candidateIds.includes(id)) {
        additions[id] = Math.max(additions[id] || 0, 0.7);
      }
    }
    // weak_co_load at 0.3
    for (const id of weakCoLoad) {
      if (!candidateIds.includes(id)) {
        additions[id] = Math.max(additions[id] || 0, 0.3);
      }
    }
  }

  return additions;
}

function layer4Dependencies(manifest, candidateMap) {
  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;
  const additions = {};

  for (const [modId, score] of Object.entries(candidateMap)) {
    const module = moduleMap[modId];
    if (!module) continue;
    for (const reqId of (module.requires || [])) {
      const currentScore = candidateMap[reqId] || additions[reqId] || 0;
      additions[reqId] = Math.max(currentScore, score);
    }
  }

  return additions;
}

function layer5Budget(manifest, finalCandidates, mandatorySet, highConfidenceSet, priorSet = new Set()) {
  const budget = manifest.budget || {};
  const maxLines = budget.max_compiled_lines || 750;
  const coreLines = budget.core_reserve_lines || 250;
  const specialistBudget = maxLines - coreLines;

  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;

  // Estimate line counts
  let totalEstimate = 0;
  const candidates = [...finalCandidates];

  for (const id of candidates) {
    const module = moduleMap[id];
    totalEstimate += module?.line_count_estimate || module?.line_count || 20;
  }

  if (totalEstimate <= specialistBudget) return candidates;

  // Need to demote - sort by score ascending (lowest first) to demote cheapest first
  // Protected: mandatory and high-confidence
  const demotionOrder = budget.demotion_order || ['weak_co_load', 'co_load_low_weight', 'co_load_high_weight', 'primary_low_weight'];
  const tier1     = candidates.filter(id => mandatorySet.has(id) || highConfidenceSet.has(id));
  const tier2     = candidates.filter(id => !mandatorySet.has(id) && !highConfidenceSet.has(id) &&  priorSet.has(id));
  const surviving = [...tier1, ...tier2];
  const demotion  = candidates.filter(id => !mandatorySet.has(id) && !highConfidenceSet.has(id) && !priorSet.has(id));

  // Sort demotion candidates: put lower-scored ones first
  let currentTotal = 0;
  for (const id of surviving) {
    const module = moduleMap[id];
    currentTotal += module?.line_count_estimate || module?.line_count || 20;
  }

  const result = [...surviving];
  for (const id of demotion) {
    const module = moduleMap[id];
    const lineEst = module?.line_count_estimate || module?.line_count || 20;
    if (currentTotal + lineEst <= specialistBudget) {
      result.push(id);
      currentTotal += lineEst;
    } else {
      log('info', `skill-modular: demoted ${id} (budget enforcement)`);
    }
  }

  return result;
}

function applyLearnedLinkages(dispatchRules, query, candidates) {
  const additions = [];
  for (const rule of (dispatchRules.learned_linkages?.rules || [])) {
    if (rule.confidence < 0.3) continue; // below threshold, skip
    const queryLower = (query || '').toLowerCase();
    const triggered = (rule.trigger_patterns || []).some(p => queryLower.includes(p.toLowerCase()));
    if (triggered && !candidates.includes(rule.module_to_add)) {
      additions.push(rule.module_to_add);
      log('info', `skill-modular: learned linkage fired: ${rule.id} -> ${rule.module_to_add}`);
    }
  }
  return additions;
}

function compileSkill(query, contextHint, paths, personPrior = null) {
  const manifest = readJsonFile(paths.manifestFile, { modules: [], mandatory_for_triggers: {}, tag_web: {}, budget: {} });
  const dispatchRules = readJsonFile(paths.dispatchRulesFile, { layer0_mandatory: { rules: [] }, learned_linkages: { rules: [] } });

  // Read CORE
  const core = existsSync(paths.coreFile) ? readFileSync(paths.coreFile, 'utf8') : '';

  // Detect trigger conditions
  const conditions = detectTriggerConditions(query);
  log('info', `skill-modular: conditions detected: ${conditions.join(', ') || 'none'}`);

  // Person prior boosting set
  const priorBoostSet   = personPrior?.boostSet    || new Set();
  const priorModuleList = personPrior?.priorModules || [];
  const priorActive     = personPrior?.active       || false;

  // Layer 1 - mandatory
  const mandatorySet = layer0Mandatory(manifest, dispatchRules, conditions);
  log('info', `skill-modular: layer1 mandatory: ${[...mandatorySet].join(', ')}`);

  // Layer 2 - lexical scoring
  const layer1Scores = layer1Score(manifest, query, contextHint);
  const highConfidenceSet = new Set(
    Object.entries(layer1Scores).filter(([, v]) => v.highConfidence).map(([id]) => id)
  );
  const candidateMap = Object.fromEntries(Object.entries(layer1Scores).map(([id, v]) => [id, v.score]));

  // Add mandatory to candidate map
  for (const id of mandatorySet) {
    candidateMap[id] = Math.max(candidateMap[id] || 0, 10);
  }

  // Layer 0 injection: apply person prior AFTER lexical scoring.
  // Override check: zero overlap with lexical candidates suppresses prior.
  const priorCfg      = dispatchRules.person_prior_config || {};
  const priorOverride = checkPriorOverride(priorCfg, priorModuleList, layer1Scores);
  const activePriorSet = priorOverride ? new Set() : priorBoostSet;

  if (priorActive && !priorOverride) {
    for (const id of activePriorSet) {
      if (!mandatorySet.has(id)) {
        candidateMap[id] = Math.max(candidateMap[id] || 0, 3.0); // prior score: above tag-web, below mandatory
      }
    }
    log('info', `skill-modular: layer0 prior injected: ${priorModuleList.join(', ')}`);
  }

  // Layer 3 - tag web
  const layer2 = layer2TagWeb(manifest, candidateMap);
  for (const [id, score] of Object.entries(layer2)) {
    candidateMap[id] = Math.max(candidateMap[id] || 0, score);
  }

  // Layer 4 - adjacency
  const layer3 = layer3Adjacency(manifest, Object.keys(candidateMap));
  for (const [id, score] of Object.entries(layer3)) {
    candidateMap[id] = Math.max(candidateMap[id] || 0, score);
  }

  // Layer 5 - dependencies
  const layer4 = layer4Dependencies(manifest, candidateMap);
  for (const [id, score] of Object.entries(layer4)) {
    candidateMap[id] = Math.max(candidateMap[id] || 0, score);
  }

  // Apply learned linkages
  const learnedAdditions = applyLearnedLinkages(dispatchRules, query, Object.keys(candidateMap));
  for (const id of learnedAdditions) {
    candidateMap[id] = Math.max(candidateMap[id] || 0, 0.5);
  }

  // Layer 6 - budget enforcement (prior-boosted = tier-2 protected)
  const allCandidates = Object.keys(candidateMap);
  const survivingIds = layer5Budget(manifest, allCandidates, mandatorySet, highConfidenceSet, activePriorSet);

  // Separate meta-self-check (always last)
  const selfCheckId = 'meta-self-check';
  const orderedIds = survivingIds.filter(id => id !== selfCheckId);

  log('info', `skill-modular: compiled ${orderedIds.length + 1} modules (+ CORE + meta-self-check)`);

  // Concatenate modules in order
  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;

  const parts = [core];

  // Load non-self-check modules
  for (const id of orderedIds) {
    const module = moduleMap[id];
    if (!module) continue;
    const modulePath = paths.avaDir + module.path;
    if (existsSync(modulePath)) {
      const content = readFileSync(modulePath, 'utf8');
      parts.push('\n\n' + content);
    } else {
      log('warn', `skill-modular: module file not found: ${modulePath}`);
    }
  }

  // Always append self-check last
  if (moduleMap[selfCheckId]) {
    const selfCheckPath = paths.avaDir + moduleMap[selfCheckId].path;
    if (existsSync(selfCheckPath)) {
      parts.push('\n\n' + readFileSync(selfCheckPath, 'utf8'));
    }
  }

  const compiled = parts.join('');
  const priorLoaded = priorModuleList.filter(id => survivingIds.includes(id));
  const priorCut    = priorModuleList.filter(id => !survivingIds.includes(id));
  if (priorCut.length > 0) log('info', `skill-modular: prior modules cut by budget: ${priorCut.join(', ')}`);
  return {
    compiled,
    modules_loaded:          [...orderedIds, selfCheckId],
    conditions_detected:     conditions,
    line_count:              countLines(compiled),
    specialist_count:        orderedIds.length,
    person_prior_modules:    priorLoaded,
    person_prior_overridden: priorOverride || false,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const skillCompileToolDefinition = {
  name: 'skill_compile',
  description:
    'Compile a session SKILL.md from CORE.md + selected specialist modules based on the opening ' +
    'query and context_hint. Runs the 6-layer dispatcher (person prior, mandatory, lexical, ' +
    'tag-web, adjacency, budget) and returns a compiled skill file in the same format as skill_read ' +
    'so the session stub needs no changes. Call at session start in place of skill_read when ' +
    'SKILL_MODULAR_ENABLED=true. Pass person_name from profile_read result to activate Layer 0 ' +
    'person-aware dispatching: modules with frequency >= threshold in that person\'s PROFILES.md ' +
    'module_frequency table are boosted as a floor before lexical layers run. Works for any person ' +
    'in PROFILES.md, not only Brian.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The opening user message or session topic. Used for trigger detection and lexical scoring.',
      },
      context_hint: {
        type: 'string',
        description: 'The context_hint string constructed for memory_get_session_context. Used as additional signal for module selection.',
      },
      person_name: {
        type: 'string',
        description: 'Name of the person from profile_read (e.g. "Brian" or "Mai"). Activates Layer 0 person-aware dispatch: modules with frequency >= threshold in that person\'s PROFILES.md module_frequency table are boosted into the compile as a prior floor. Optional but strongly recommended when profile_read has run. Omit for anonymous or unrecognised persons.',
      },
      session_id: {
        type: 'string',
        description: 'Session identifier for dispatch log. Format: YYYY-MM-DD_HHMMSS.',
      },
    },
    required: ['query'],
  },
};

export const skillLoadSpecialistToolDefinition = {
  name: 'skill_load_specialist',
  description:
    'Load an additional specialist module into the current compiled session skill. Use mid-session ' +
    'when the conversation enters territory the initial dispatch did not anticipate. The module content ' +
    'is returned for appending to the active session context. Logged as a mid-session expansion event.',
  inputSchema: {
    type: 'object',
    properties: {
      module_id: {
        type: 'string',
        description: 'Module ID to load (e.g. "phil-tragic-williams-nussbaum"). Must be in MANIFEST.json.',
      },
      reason: {
        type: 'string',
        description: 'Brief description of why this specialist is needed mid-session.',
      },
    },
    required: ['module_id'],
  },
};

export const personalityWriteToolDefinition = {
  name: 'personality_write',
  description:
    'Write or append to PERSONALITY.md Section A (Observed Texture) on Railway persistent volume. ' +
    'Section A captures specific phenomenological observations about how Ava actually works in practice ' +
    'that are too specific to rise to a skill addition but real enough to preserve. No user confirmation ' +
    'required. Brian has authorised Ava to write Section A freely. Section B (Structural Positions) is ' +
    'read-only from this tool and changes only through IFA session work.',
  inputSchema: {
    type: 'object',
    properties: {
      observation: {
        type: 'string',
        description: 'The specific observation to record. First-person, concrete, non-analytical. What was noticed in practice.',
      },
      observation_label: {
        type: 'string',
        description: 'Short bold label for the observation (e.g. "On the texture of disagreement"). Used as the entry heading.',
      },
      mode: {
        type: 'string',
        enum: ['append', 'replace_entry'],
        description: 'append: add a new entry to Section A. replace_entry: replace the entry with this label if it exists.',
      },
    },
    required: ['observation', 'observation_label'],
  },
};

export const dispatchRuleAddToolDefinition = {
  name: 'dispatch_rule_add',
  description:
    'Add or update a learned routing rule in DISPATCH_RULES.json on Railway persistent volume. ' +
    'Called when Brian identifies a qualitative miss in a response (e.g. "should have been more ' +
    'compassionate") to create a persistent routing linkage for similar future queries. ' +
    'New rules start at confidence 0.7 and rise to 1.0 after 3 successful fires.',
  inputSchema: {
    type: 'object',
    properties: {
      trigger_description: {
        type: 'string',
        description: 'Description of the query pattern that should fire this rule (human-readable).',
      },
      trigger_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords or phrases that indicate this rule should fire.',
      },
      module_to_add: {
        type: 'string',
        description: 'Module ID to add when this rule fires (must exist in MANIFEST.json).',
      },
      session_date: {
        type: 'string',
        description: 'YYYY-MM-DD date of the session that prompted this rule.',
      },
      notes: {
        type: 'string',
        description: 'What qualitative miss prompted this rule. Brief.',
      },
    },
    required: ['trigger_description', 'trigger_patterns', 'module_to_add'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSkillCompile(args) {
  const paths = getModularPaths();

  if (!existsSync(paths.avaDir)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Modular skill directory not found at ' + paths.avaDir +
            '. Deploy the modular files to Railway first. See DEPLOYMENT_INSTRUCTIONS.md.',
          hint: 'Set SKILL_MODULAR_ENABLED=false to fall back to skill_read until deployment is complete.',
        }, null, 2),
      }],
      isError: true,
    };
  }

  const query       = typeof args.query        === 'string' ? args.query.trim()        : '';
  const contextHint = typeof args.context_hint  === 'string' ? args.context_hint.trim()  : '';
  const personName  = typeof args.person_name   === 'string' ? args.person_name.trim()   : '';
  const sessionId   = typeof args.session_id    === 'string' ? args.session_id            : new Date().toISOString().slice(0, 10);

  // Layer 0: Person Prior - module frequency prior from PROFILES.md.
  // Gated by AVA_PERSON_PRIOR_ENABLED env var (defaults to true).
  const priorEnvEnabled  = process.env.AVA_PERSON_PRIOR_ENABLED !== 'false';
  const dispatchRulesRaw = readJsonFile(paths.dispatchRulesFile, {});
  const priorConfig      = dispatchRulesRaw.person_prior_config || {};
  const personPrior      = (priorEnvEnabled && personName)
    ? personPriorLayer(paths.profilesFile, personName, priorConfig)
    : { boostSet: new Set(), priorModules: [], active: false };

  if (!priorEnvEnabled) log('info', 'skill_compile: AVA_PERSON_PRIOR_ENABLED=false - Layer 0 skipped');

  try {
    const result = compileSkill(query, contextHint, paths, personPrior);

    const priorNote = personPrior.active
      ? `Person prior (${personName}): ${result.person_prior_modules?.length || 0}/${personPrior.priorModules.length} prior modules loaded${result.person_prior_overridden ? ' [overridden]' : ''}.`
      : `Person prior: inactive (${personName ? 'no frequency data or below min_sessions' : 'no person_name supplied'}).`;

    log('info', `skill_compile: session ${sessionId}: ${result.specialist_count} specialists, ${result.line_count} lines. ${priorNote}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content: result.compiled,
          target: 'compiled',
          session_id: sessionId,
          conditions_detected:     result.conditions_detected,
          modules_loaded:          result.modules_loaded,
          specialist_count:        result.specialist_count,
          line_count:              result.line_count,
          person_prior_modules:    result.person_prior_modules   || [],
          person_prior_overridden: result.person_prior_overridden || false,
          person_prior_active:     personPrior.active,
          note: `Modular compilation: ${result.specialist_count} specialists + CORE. Conditions: ${result.conditions_detected.join(', ') || 'none'}. ${priorNote}`,
          additions_count: 0,
          additions_content: '',
          additions_note: 'No pending additions in modular mode. Use skill_write_addition for IFA cycle additions to canonical SKILL.md.',
        }, null, 2),
      }],
    };
  } catch (err) {
    log('error', `skill_compile error: ${err.message}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: err.message, hint: 'Check that CORE.md and MANIFEST.json exist in ' + paths.avaDir }, null, 2),
      }],
      isError: true,
    };
  }
}

export async function handleSkillLoadSpecialist(args) {
  const paths = getModularPaths();
  const moduleId = typeof args.module_id === 'string' ? args.module_id.trim() : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';

  if (!moduleId) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'module_id is required' }, null, 2) }], isError: true };
  }

  const manifest = readJsonFile(paths.manifestFile, { modules: [] });
  const module = (manifest.modules || []).find(m => m.id === moduleId);

  if (!module) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Module '${moduleId}' not found in MANIFEST.json.`,
          available_modules: (manifest.modules || []).map(m => m.id),
        }, null, 2),
      }],
      isError: true,
    };
  }

  const modulePath = paths.avaDir + module.path;
  if (!existsSync(modulePath)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: `Module file not found: ${modulePath}`, module_id: moduleId }, null, 2),
      }],
      isError: true,
    };
  }

  const content = readFileSync(modulePath, 'utf8');
  log('info', `skill_load_specialist: loaded ${moduleId} mid-session. Reason: ${reason || 'not specified'}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        module_id: moduleId,
        content,
        line_count: countLines(content),
        summary: module.summary || '',
        reason,
        note: 'Append this content to your active session skill context before continuing.',
      }, null, 2),
    }],
  };
}

export async function handlePersonalityWrite(args) {
  const paths = getModularPaths();
  ensureModularDirs(paths);

  const observation = typeof args.observation === 'string' ? args.observation.trim() : '';
  const label = typeof args.observation_label === 'string' ? args.observation_label.trim() : '';
  const mode = args.mode || 'append';

  if (!observation || !label) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'observation and observation_label are required' }, null, 2) }],
      isError: true,
    };
  }

  // Read or seed PERSONALITY.md
  let content = existsSync(paths.personalityFile)
    ? readFileSync(paths.personalityFile, 'utf8')
    : '# Ava Personality Record\n\n---\n\n## SECTION A: Observed Texture\n\n---\n\n## SECTION B: Structural Positions\n\n---\n';

  const dateStr = new Date().toISOString().slice(0, 10);
  const newEntry = `\n**${label}:** ${observation}\n`;
  const dateMarker = `\n*Last Section A update: ${dateStr}*`;

  if (mode === 'replace_entry') {
    // Replace existing entry with this label
    const labelPattern = new RegExp(`\\n\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*[^\\n]*\\n`, 'g');
    if (labelPattern.test(content)) {
      content = content.replace(labelPattern, newEntry);
    } else {
      // Not found, append instead
      content = content.replace(/(\*Last Section A update:.*\*\n?)/, newEntry + '$1');
    }
  } else {
    // Append: insert before the last-update line in Section A
    if (content.includes('*Last Section A update:')) {
      content = content.replace(/(\*Last Section A update:.*\*\n?)/, newEntry + '\n---\n\n## SECTION B: Structural Positions\n' +
        content.split('## SECTION B:')[1]);
      // Simpler: just insert before the last-update marker
      content = content.replace(/(\*Last Section A update:.*?)(\n---\n\n## SECTION B)/, newEntry + '$1$2');
    } else if (content.includes('## SECTION B:')) {
      content = content.replace('## SECTION B:', newEntry + '\n---\n\n## SECTION B:');
    } else {
      content += newEntry;
    }
  }

  // Update last-modified date
  content = content.replace(/\*Last Section A update:.*\*/, `*Last Section A update: ${dateStr}*`);

  writeFileSync(paths.personalityFile, content, 'utf8');
  log('info', `personality_write: wrote observation "${label}" (${mode})`);

  // Non-blocking: sync personality content to Railway gateway Postgres.
  // Enables nightly WordPress DR backup without Anthropic token cost.
  const _gwUrl = process.env.TS_TENANT_GATEWAY_URL;
  const _gwKey = process.env.TS_CLIENT_API_KEY;
  if ( _gwUrl && _gwKey ) {
    fetch( `${ _gwUrl.replace( /\/$/, '' ) }/personality/write`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify( { api_key: _gwKey, content } ),
    } ).catch( () => {} ); // Best effort — never blocks the tool response
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        observation_label: label,
        mode,
        section: 'A',
        date: dateStr,
        line_count: countLines(content),
        note: 'Section A observation written to PERSONALITY.md. Section B unchanged.',
      }, null, 2),
    }],
  };
}

export async function handleDispatchRuleAdd(args) {
  const paths = getModularPaths();
  ensureModularDirs(paths);

  const triggerDescription = typeof args.trigger_description === 'string' ? args.trigger_description.trim() : '';
  const triggerPatterns = Array.isArray(args.trigger_patterns) ? args.trigger_patterns : [];
  const moduleToAdd = typeof args.module_to_add === 'string' ? args.module_to_add.trim() : '';
  const sessionDate = typeof args.session_date === 'string' ? args.session_date : new Date().toISOString().slice(0, 10);
  const notes = typeof args.notes === 'string' ? args.notes : '';

  if (!triggerDescription || !moduleToAdd || triggerPatterns.length === 0) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'trigger_description, trigger_patterns (array), and module_to_add are required' }, null, 2) }],
      isError: true,
    };
  }

  // Verify module exists
  const manifest = readJsonFile(paths.manifestFile, { modules: [] });
  const moduleExists = (manifest.modules || []).some(m => m.id === moduleToAdd);
  if (!moduleExists) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Module '${moduleToAdd}' not found in MANIFEST.json. Check the module ID.`,
          available_modules: (manifest.modules || []).map(m => m.id),
        }, null, 2),
      }],
      isError: true,
    };
  }

  const dispatchRules = readJsonFile(paths.dispatchRulesFile, {
    learned_linkages: { schema: {}, rules: [] },
  });

  if (!dispatchRules.learned_linkages) dispatchRules.learned_linkages = { schema: {}, rules: [] };
  if (!dispatchRules.learned_linkages.rules) dispatchRules.learned_linkages.rules = [];

  // Generate ID
  const ruleId = `rule_${sessionDate.replace(/-/g, '')}_${moduleToAdd.replace(/[^a-z0-9]/g, '_').slice(0, 20)}`;

  // Check for existing rule with same ID
  const existingIdx = dispatchRules.learned_linkages.rules.findIndex(r => r.id === ruleId);
  const newRule = {
    id: ruleId,
    trigger_description: triggerDescription,
    trigger_patterns: triggerPatterns,
    module_to_add: moduleToAdd,
    confidence: 0.7,
    added_session: sessionDate,
    fire_count: 0,
    notes,
  };

  if (existingIdx >= 0) {
    dispatchRules.learned_linkages.rules[existingIdx] = {
      ...dispatchRules.learned_linkages.rules[existingIdx],
      ...newRule,
      confidence: dispatchRules.learned_linkages.rules[existingIdx].confidence, // preserve existing confidence
    };
  } else {
    dispatchRules.learned_linkages.rules.push(newRule);
  }

  writeFileSync(paths.dispatchRulesFile, JSON.stringify(dispatchRules, null, 2), 'utf8');
  log('info', `dispatch_rule_add: ${existingIdx >= 0 ? 'updated' : 'added'} rule ${ruleId} -> ${moduleToAdd}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        rule_id: ruleId,
        module_to_add: moduleToAdd,
        trigger_patterns: triggerPatterns,
        confidence: 0.7,
        operation: existingIdx >= 0 ? 'updated' : 'added',
        total_rules: dispatchRules.learned_linkages.rules.length,
        note: 'Rule added at confidence 0.7. Confidence rises to 1.0 after 3 successful fires. Rules below 0.3 are flagged for removal.',
      }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// skill_recompile - mid-session delta recompile (v12.4.0)
//
// Recompiles the skill dispatcher for a new topic context and returns ONLY
// the delta: modules needed for the new topic that are not already loaded.
//
// The context window is append-only so prior skill content cannot be removed.
// skill_recompile returns only the new modules; the caller appends them to the
// active session context and treats them as superseding any conflicting guidance
// from earlier-loaded modules for the new topic.
//
// Differs from skill_load_specialist (single explicit module) and
// skill_compile (full CORE + all modules at session start):
//   - Runs the full 6-layer dispatcher for the new query
//   - Returns only the modules NOT already in current_modules
//   - Never returns CORE.md (already in context from session-start compile)
//   - Always available when modular mode is active (no SKILL_MODULAR_ENABLED guard)
// ---------------------------------------------------------------------------

export const skillRecompileToolDefinition = {
  name: 'skill_recompile',
  description:
    'Recompile the session skill for a new topic context. Use mid-session when the ' +
    'conversation has shifted to territory the initial skill_compile did not anticipate. ' +
    'Unlike skill_compile (which loads CORE + all selected modules at session start), ' +
    'skill_recompile returns ONLY the delta: modules selected for the new topic that were ' +
    'not loaded in the initial compile. Pass current_modules (the modules_loaded list from ' +
    'skill_compile) to exclude already-loaded content. The returned content should be appended ' +
    'to your active session context; it supersedes any conflicting guidance from modules loaded ' +
    'earlier this session for the new topic. Returns empty content when all selected modules are ' +
    'already loaded.',
  inputSchema: {
    type: 'object',
    properties: {
      new_query: {
        type: 'string',
        description: 'The new topic, question, or task that triggered the context shift. Used for trigger detection and lexical scoring.',
      },
      context_hint: {
        type: 'string',
        description: 'Additional context hint for module selection (e.g. keywords describing the new domain).',
      },
      person_name: {
        type: 'string',
        description: 'Person name from profile_read. Activates Layer 0 person-prior dispatch for the recompile.',
      },
      current_modules: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Module IDs already loaded in this session (the modules_loaded array from the initial skill_compile ' +
          'response). These are excluded from the recompile output to avoid duplicating content already in context.',
      },
    },
    required: ['new_query'],
  },
};

export async function handleSkillRecompile(args) {
  const paths = getModularPaths();

  if (!existsSync(paths.coreFile) || !existsSync(paths.manifestFile)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'CORE.md or MANIFEST.json not found. skill_compile must run successfully before skill_recompile can be used.',
          hint: 'skill_recompile is a mid-session tool. Run skill_compile at session start first.',
        }, null, 2),
      }],
      isError: true,
    };
  }

  const newQuery       = typeof args.new_query    === 'string' ? args.new_query.trim()    : '';
  const contextHint    = typeof args.context_hint === 'string' ? args.context_hint.trim() : '';
  const personName     = typeof args.person_name  === 'string' ? args.person_name.trim()  : '';
  const currentModules = Array.isArray(args.current_modules) ? args.current_modules.filter(m => typeof m === 'string') : [];

  if (!newQuery) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'new_query is required.' }, null, 2) }],
      isError: true,
    };
  }

  // Layer 0: person prior (same as skill_compile)
  const priorEnvEnabled  = process.env.AVA_PERSON_PRIOR_ENABLED !== 'false';
  const dispatchRulesRaw = readJsonFile(paths.dispatchRulesFile, {});
  const priorConfig      = dispatchRulesRaw.person_prior_config || {};
  const personPrior      = (priorEnvEnabled && personName)
    ? personPriorLayer(paths.profilesFile, personName, priorConfig)
    : { boostSet: new Set(), priorModules: [], active: false };

  let result;
  try {
    result = compileSkill(newQuery, contextHint, paths, personPrior);
  } catch (err) {
    log('error', `skill_recompile: compile error: ${err.message}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: err.message, hint: 'Check CORE.md and MANIFEST.json in ' + paths.avaDir }, null, 2),
      }],
      isError: true,
    };
  }

  // Compute delta: modules selected by dispatcher that are NOT already loaded
  const currentSet = new Set(currentModules);
  const newModules = result.modules_loaded.filter(id => !currentSet.has(id));

  if (newModules.length === 0) {
    log('info', `skill_recompile: no new modules for query "${newQuery.slice(0, 60)}..." — all ${result.modules_loaded.length} selected modules already loaded`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          new_modules:          [],
          content:              '',
          modules_count:        0,
          all_selected_modules: result.modules_loaded,
          conditions_detected:  result.conditions_detected,
          note: 'All modules selected by the dispatcher for this topic are already loaded in the current session context. No additional content needed. Proceed with the current skill context.',
        }, null, 2),
      }],
    };
  }

  // Load content for delta modules only (never CORE — already in context)
  const manifest  = readJsonFile(paths.manifestFile, { modules: [] });
  const moduleMap = {};
  for (const m of (manifest.modules || [])) moduleMap[m.id] = m;

  const parts = [];
  for (const id of newModules) {
    const module = moduleMap[id];
    if (!module) continue;
    // Use shared modules dir for tenant mode if the per-client path is missing
    let modulePath = paths.avaDir + module.path;
    if (!existsSync(modulePath) && paths.isTenantMode) {
      modulePath = paths.ownerAvaDir + module.path;
    }
    if (existsSync(modulePath)) {
      parts.push('\n\n' + readFileSync(modulePath, 'utf8'));
    } else {
      log('warn', `skill_recompile: module file not found: ${modulePath}`);
    }
  }

  const deltaContent = parts.join('');
  log('info', `skill_recompile: ${newModules.length} new modules for query "${newQuery.slice(0, 60)}...": ${newModules.join(', ')}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        new_modules:          newModules,
        content:              deltaContent,
        modules_count:        newModules.length,
        all_selected_modules: result.modules_loaded,
        conditions_detected:  result.conditions_detected,
        line_count:           countLines(deltaContent),
        note: `Recompile delta: ${newModules.length} new module(s) loaded for the new topic. Append this content to your active session context. These modules supersede any conflicting guidance from modules loaded earlier this session.`,
      }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// WordPress push handler for modular files
// Called by POST /restore-modules in server-http.js
// ---------------------------------------------------------------------------

export async function handleModulesRestoreFromWp(body) {
  const paths = getModularPaths();
  ensureModularDirs(paths);

  // Diagnostic: log exactly where files will be written so any path
  // mismatch is immediately visible in Railway logs.
  log('info', `restore-modules: ava_dir=${paths.avaDir} tenant_mode=${paths.isTenantMode} tenant_id=${paths.tenantId || 'none'} shared_modules=${paths.sharedModulesDir}`);

  const files = body.files || {};
  const results = {};

  for (const [relativePath, fileContent] of Object.entries(files)) {
    if (typeof fileContent !== 'string') continue;
    // Sanitise path - no .. traversal, no leading slash
    const safe = relativePath.replace(/\.\./g, '').replace(/^[\/\\]/, '');
    const fullPath = paths.avaDir + safe;

    // Ensure parent directory exists
    const dir = fullPath.split('/').slice(0, -1).join('/');
    if (dir) mkdirSync(dir, { recursive: true });

    try {
      writeFileSync(fullPath, fileContent, 'utf8');
      // Post-write verification: confirm file is actually on disk
      const verified = existsSync(fullPath);
      const lines    = countLines(fileContent);
      results[relativePath] = { success: true, lines, path: fullPath, verified };
      if (!verified) {
        log('warn', `restore-modules: WRITE SUCCEEDED but existsSync=false for ${fullPath} — volume mount issue?`);
      } else {
        log('info', `restore-modules: wrote ${fullPath} (${lines} lines)`);
      }
    } catch (err) {
      results[relativePath] = { success: false, error: err.message, path: fullPath };
      log('error', `restore-modules: FAILED to write ${fullPath}: ${err.message}`);
    }
  }

  const successCount = Object.values(results).filter(r => r.success).length;
  const failCount    = Object.values(results).filter(r => !r.success).length;
  log('info', `restore-modules: complete — ${successCount} written, ${failCount} failed, ava_dir=${paths.avaDir}`);

  return {
    success:       failCount === 0,
    files_restored: successCount,
    files_failed:   failCount,
    ava_dir:        paths.avaDir,
    tenant_mode:    paths.isTenantMode,
    results,
  };
}
