// ---------------------------------------------------------------------------
// src/tools/manifest-fragments.js  (v12.21.0)
//
// Manifest fragment registry: the structural fix for the "module written but
// never registered" failure (2026-07-21 transcripts: travel-master-dispatch
// existed on disk, MANIFEST.json never knew, skill_compile could not select
// it, and four rounds of manual archaeology followed).
//
// Per MANIFEST_DIRECTORY_PROTOCOL.md, every module set registers itself as a
// standalone JSON fragment in {avaDir}/references/manifest/. This module makes
// that protocol STRUCTURAL instead of discretionary:
//
//   - module_write calls writeModuleFragment() so the fragment is created in
//     the same tool call that writes the module body. No "remember to update
//     the manifest" note, no manual manifest_rebuild.py step.
//   - skill_compile / skill_recompile / skill_load_specialist call
//     loadMergedManifest() so fragments are live at compile time.
//   - brain_scan.py (v2.1.0) reads the same directory with the same merge
//     semantics, so the visualisation catalogs fragment-registered modules.
//
// Merge semantics mirror compileSkill's existing MANIFEST_APPEND merge
// exactly (new ids only; mandatory_for_triggers union; tag_web add-new), so
// enabling fragments changes nothing for modules already registered the old
// way. First-definition-wins order: MANIFEST.json, then MANIFEST_APPEND.json,
// then fragments in filename order.
// ---------------------------------------------------------------------------

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Paths and low-level IO
// ---------------------------------------------------------------------------

/** Absolute path of the fragment directory for a given ava dir. */
export function fragmentsDirFor(avaDir) {
  return join(avaDir, 'references', 'manifest');
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Reading fragments
// ---------------------------------------------------------------------------

/**
 * Reads every *.json fragment in {avaDir}/references/manifest/ in filename
 * (prefix) order. Non-JSON files, unparseable files, and files that carry no
 * modules/references/dispatch_rules arrays (e.g. deprecated placeholders) are
 * skipped with a record of why — never thrown, so a bad fragment can degrade
 * only itself, not the compile.
 *
 * @param {string} avaDir
 * @returns {{ fragments: Array<{file:string, source:string, modules:object[],
 *             references:object[], dispatch_rules:object[]}>,
 *             skipped: Array<{file:string, reason:string}> }}
 */
export function loadManifestFragments(avaDir) {
  const dir = fragmentsDirFor(avaDir);
  const out = { fragments: [], skipped: [] };
  if (!existsSync(dir)) return out;

  let names = [];
  try {
    names = readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    out.skipped.push({ file: dir, reason: `unreadable directory: ${err.message}` });
    return out;
  }

  for (const name of names) {
    const parsed = readJsonSafe(join(dir, name));
    if (parsed && parsed.__error) {
      out.skipped.push({ file: name, reason: `unparseable JSON: ${parsed.__error}` });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      out.skipped.push({ file: name, reason: 'not a JSON object' });
      continue;
    }
    const modules       = Array.isArray(parsed.modules)        ? parsed.modules.filter(m => m && typeof m === 'object' && m.id) : [];
    const references    = Array.isArray(parsed.references)     ? parsed.references.filter(r => r && typeof r === 'object')      : [];
    const dispatchRules = Array.isArray(parsed.dispatch_rules) ? parsed.dispatch_rules.filter(r => r && typeof r === 'object')  : [];
    if (!modules.length && !references.length && !dispatchRules.length) {
      out.skipped.push({ file: name, reason: 'no modules/references/dispatch_rules arrays (placeholder or deprecated)' });
      continue;
    }
    out.fragments.push({
      file: name,
      source: typeof parsed.source === 'string' ? parsed.source : name.replace(/^\d+-/, '').replace(/\.json$/i, ''),
      modules,
      references,
      dispatch_rules: dispatchRules,
      mandatory_for_triggers: (parsed.mandatory_for_triggers && typeof parsed.mandatory_for_triggers === 'object') ? parsed.mandatory_for_triggers : {},
      tag_web: (parsed.tag_web && typeof parsed.tag_web === 'object') ? parsed.tag_web : {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Infer a module's path when the fragment entry omits it (the shipped
 * 70-travel.json has no path field, which would break skill_load_specialist
 * even after registration). Inference is existence-checked, never guessed:
 * modules/{category}/{id}.md, then modules/{id}.md. Returns the relative
 * path or null.
 */
export function inferModulePath(avaDir, entry) {
  if (entry.path) return entry.path;
  const id = String(entry.id || '').trim();
  if (!id) return null;
  const candidates = [];
  if (entry.category) candidates.push(`modules/${entry.category}/${id}.md`);
  candidates.push(`modules/${id}.md`);
  for (const rel of candidates) {
    if (existsSync(join(avaDir, rel))) return rel;
  }
  return null;
}

/**
 * Merges fragment content into an already MANIFEST+APPEND-merged manifest,
 * in place, with compile-parity semantics (new module ids only; mandatory
 * union; tag_web add-new). Missing module paths are inferred when the file
 * exists on disk.
 *
 * @param {object} manifest  Mutable manifest ({modules, mandatory_for_triggers, tag_web}).
 * @param {Array}  fragments From loadManifestFragments().fragments.
 * @param {string} avaDir    For path inference.
 * @returns {{added: string[], skippedExisting: string[], pathInferred: string[], pathMissing: string[]}}
 */
export function mergeFragmentsIntoManifest(manifest, fragments, avaDir) {
  manifest.modules = manifest.modules || [];
  manifest.mandatory_for_triggers = manifest.mandatory_for_triggers || {};
  manifest.tag_web = manifest.tag_web || {};

  const stats = { added: [], skippedExisting: [], pathInferred: [], pathMissing: [] };
  const existingIds = new Set(manifest.modules.map(m => m.id));

  for (const frag of fragments) {
    for (const raw of frag.modules) {
      const id = String(raw.id);
      if (existingIds.has(id)) { stats.skippedExisting.push(id); continue; }
      const entry = { ...raw, _source_fragment: frag.file };
      if (!entry.path) {
        const inferred = inferModulePath(avaDir, entry);
        if (inferred) { entry.path = inferred; stats.pathInferred.push(id); }
        else { stats.pathMissing.push(id); }
      }
      manifest.modules.push(entry);
      existingIds.add(id);
      stats.added.push(id);
    }
    for (const [trigger, ids] of Object.entries(frag.mandatory_for_triggers || {})) {
      if (!Array.isArray(ids)) continue;
      const existing = manifest.mandatory_for_triggers[trigger] || [];
      manifest.mandatory_for_triggers[trigger] = [...new Set([...existing, ...ids])];
    }
    for (const [tag, keywords] of Object.entries(frag.tag_web || {})) {
      if (!manifest.tag_web[tag] && Array.isArray(keywords)) manifest.tag_web[tag] = keywords;
    }
  }
  return stats;
}

/**
 * Converts fragment dispatch_rules to the learned-linkage shape that
 * applyLearnedLinkages() actually consumes. Fragment rules carry
 * trigger_patterns as an OBJECT ({keywords, phrases, task_class}); the
 * consumer does `(rule.trigger_patterns || []).some(...)` over STRINGS, so an
 * unconverted fragment rule silently never fires. Flattens keywords+phrases
 * into one string array and normalises confidence.
 *
 * @param {Array} fragments From loadManifestFragments().fragments.
 * @returns {Array<{id:string, trigger_patterns:string[], module_to_add:string, confidence:number, _source_fragment:string}>}
 */
export function fragmentDispatchToLinkages(fragments) {
  const rules = [];
  for (const frag of fragments) {
    for (const raw of frag.dispatch_rules) {
      if (!raw.module_to_add) continue;
      let patterns = [];
      const tp = raw.trigger_patterns;
      if (Array.isArray(tp)) {
        patterns = tp.filter(p => typeof p === 'string');
      } else if (tp && typeof tp === 'object') {
        patterns = [
          ...(Array.isArray(tp.keywords) ? tp.keywords : []),
          ...(Array.isArray(tp.phrases)  ? tp.phrases  : []),
        ].filter(p => typeof p === 'string');
      }
      if (!patterns.length) continue;
      rules.push({
        id: raw.id || `frag-${frag.source}-${rules.length}`,
        trigger_patterns: [...new Set(patterns)],
        module_to_add: String(raw.module_to_add),
        confidence: (typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1) ? raw.confidence : 0.7,
        _source_fragment: frag.file,
      });
    }
  }
  return rules;
}

/**
 * The single merged view of module registration, used by skill_compile,
 * skill_recompile, and skill_load_specialist:
 *
 *   MANIFEST.json  ->  MANIFEST_APPEND.json (new ids; mandatory union;
 *   tag_web add-new — byte-for-byte the semantics compileSkill used inline)
 *   ->  references/manifest/*.json fragments (same semantics, filename order).
 *
 * @param {object} paths  Modular paths ({avaDir, manifestFile, manifestAppendFile}).
 * @param {Function} readJsonFile  The caller's JSON reader (path, fallback) => object.
 * @returns {{ manifest: object, fragmentLinkages: Array, fragmentStats: object, fragmentsSkipped: Array }}
 */
export function loadMergedManifest(paths, readJsonFile) {
  const manifest = readJsonFile(paths.manifestFile, { modules: [], mandatory_for_triggers: {}, tag_web: {}, budget: {} });
  manifest.modules = manifest.modules || [];
  manifest.mandatory_for_triggers = manifest.mandatory_for_triggers || {};
  manifest.tag_web = manifest.tag_web || {};

  // --- MANIFEST_APPEND merge (parity with the previous inline block) ---
  const appendManifest = readJsonFile(paths.manifestAppendFile, null);
  if (appendManifest && Array.isArray(appendManifest.modules)) {
    const existingIds = new Set(manifest.modules.map(m => m.id));
    const newModules = appendManifest.modules.filter(m => m && m.id && !existingIds.has(m.id));
    if (newModules.length > 0) {
      manifest.modules = [...manifest.modules, ...newModules];
      log('info', `loadMergedManifest: MANIFEST_APPEND merged ${newModules.length} new modules: ${newModules.map(m => m.id).join(', ')}`);
    }
    if (appendManifest.mandatory_for_triggers) {
      for (const [trigger, moduleIds] of Object.entries(appendManifest.mandatory_for_triggers)) {
        const existing = manifest.mandatory_for_triggers[trigger] || [];
        manifest.mandatory_for_triggers[trigger] = [...new Set([...existing, ...moduleIds])];
      }
    }
    if (appendManifest.tag_web) {
      for (const [tag, keywords] of Object.entries(appendManifest.tag_web)) {
        if (!manifest.tag_web[tag]) manifest.tag_web[tag] = keywords;
      }
    }
  }

  // --- Fragment merge ---
  const { fragments, skipped } = loadManifestFragments(paths.avaDir);
  const fragmentStats = mergeFragmentsIntoManifest(manifest, fragments, paths.avaDir);
  if (fragmentStats.added.length) {
    log('info', `loadMergedManifest: fragments merged ${fragmentStats.added.length} modules from references/manifest/: ${fragmentStats.added.join(', ')}`);
  }
  if (fragmentStats.pathMissing.length) {
    log('warn', `loadMergedManifest: fragment modules with no resolvable path (registered but not loadable): ${fragmentStats.pathMissing.join(', ')}`);
  }
  const fragmentLinkages = fragmentDispatchToLinkages(fragments);

  return { manifest, fragmentLinkages, fragmentStats, fragmentsSkipped: skipped };
}

// ---------------------------------------------------------------------------
// Writing fragments (module_write registration)
// ---------------------------------------------------------------------------

/** Maximum items for each auto-derived trigger category. */
const MAX_AUTO_KEYWORDS = 8;
const MAX_AUTO_PHRASES  = 6;
const MAX_AUTO_PROVIDES = 6;

/**
 * Tokenise text into single-word lexical tokens (3+ chars).
 */
function tokensOf(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2))];
}

/**
 * Parse frontmatter from markdown content. Returns a flat object of the fields
 * that matter for manifest derivation: provides, task_class, id, category,
 * always_load, load_priority, load_strategy, depends_on, and triggers.*
 *
 * Uses the same YAML-light parser that brain_scan.py uses: handles scalars,
 * comma-separated lists, inline arrays, and block list items. PyYAML is not
 * available in the connector image, so this is stdlib-only.
 */
function parseModuleFrontmatter(content) {
  const result = { provides: [], triggers: { keywords: [], phrases: [], task_class: [] } };
  const text = String(content || '');
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalised.startsWith('---\n')) return result;
  const end = normalised.indexOf('\n---', 4);
  if (end < 0) return result;
  const block = normalised.slice(4, end);

  let currentKey = null;
  let currentList = null;

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Block list item under current key
    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (currentList === null) currentList = [];
      const val = listMatch[1].replace(/^["']|["']$/g, '').trim();
      if (val) currentList.push(val);
      continue;
    }

    // Top-level key: value
    const topMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (topMatch) {
      // Flush previous list
      if (currentKey && currentList !== null) {
        const k = currentKey.replace(/^triggers[.\/]?/, '');
        if (k === 'keywords' || k === 'phrases' || k === 'task_class') {
          result.triggers[k] = [...new Set(currentList.map(v => v.toLowerCase()))];
        } else if (k === 'provides') {
          result.provides = currentList;
        }
      }
      currentKey = topMatch[1];
      currentList = null;
      const val = topMatch[2].trim();
      if (!val) { currentList = []; continue; }

      // Scalar value
      const cleaned = val.replace(/^["']|["']$/g, '').trim();
      if (currentKey === 'provides') {
        result.provides = cleaned.split(',').map(s => s.trim()).filter(Boolean);
      } else if (currentKey === 'task_class') {
        result.triggers.task_class = cleaned.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      } else if (currentKey === 'id') {
        result.id = cleaned;
      } else if (currentKey === 'category') {
        result.category = cleaned;
      } else if (currentKey === 'always_load') {
        result.always_load = cleaned.toLowerCase() === 'true' || cleaned === 'yes';
      } else if (currentKey === 'load_priority') {
        const n = parseInt(cleaned, 10);
        if (!isNaN(n)) result.load_priority = n;
      } else if (currentKey === 'load_strategy') {
        result.load_strategy = cleaned;
      } else if (currentKey === 'depends_on') {
        result.depends_on = cleaned.split(',').map(s => s.trim()).filter(Boolean);
      } else if (currentKey === 'line_count_estimate') {
        const n = parseInt(cleaned, 10);
        if (!isNaN(n)) result.line_count_estimate = n;
      }
      continue;
    }

    // Nested key under triggers (indented)
    const nestedMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (nestedMatch && currentKey === 'triggers') {
      const subKey = nestedMatch[1];
      const subVal = nestedMatch[2].trim();
      if (subVal) {
        const cleaned = subVal.replace(/^["']|["']$/g, '').trim();
        if (subKey === 'keywords') {
          result.triggers.keywords = cleaned.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        } else if (subKey === 'phrases') {
          result.triggers.phrases = cleaned.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        } else if (subKey === 'task_class') {
          result.triggers.task_class = cleaned.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        }
      }
    }
  }

  // Flush final list
  if (currentKey && currentList !== null) {
    const k = currentKey.replace(/^triggers[.\/]?/, '');
    if (k === 'keywords' || k === 'phrases' || k === 'task_class') {
      result.triggers[k] = [...new Set(currentList.map(v => v.toLowerCase()))];
    } else if (k === 'provides') {
      result.provides = currentList;
    }
  }

  return result;
}

/**
 * Mine multi-word phrases from markdown body content.
 *
 * Strategy (conservative, never hallucinates):
 *   1. Extract bullet points that read like usage instructions: lines starting
 *      with "- " or "* " that contain action verbs or conditional language
 *      ("use when", "activate when", "call this when", "for cases involving").
 *   2. Mine statistically significant bigrams: any two-word sequence that
 *      appears 2+ times in the body, minimum 5 chars total.
 *   3. Extract ## H2 headings as potential task_class signals.
 *
 * Returns { phrases: string[], taskClasses: string[] }
 */
function mineBodyContent(body) {
  const phrases = [];
  const taskClasses = [];
  const lines = (body || '').split('\n');

  // --- Pattern 1: Instruction-style bullet points ---
  const instructionPattern = /^\s*[-*]\s+(.+)$/;
  const triggerIndicators = /\b(use when|activate when|call this when|trigger when|for cases involving|best for|designed for|handles|manages|processes)\b/i;

  for (const line of lines) {
    const m = line.match(instructionPattern);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length < 12 || text.length > 120) continue;
    if (triggerIndicators.test(text)) {
      phrases.push(text.toLowerCase());
    }
  }

  // --- Pattern 2: Statistical bigrams (2+ occurrences) ---
  const bodyText = lines
    .filter(l => !l.trim().startsWith('---') && !l.trim().startsWith('#'))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = bodyText.split(/\s+/).filter(w => w.length > 2);
  const bigramCounts = {};
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + ' ' + words[i + 1];
    if (bigram.length >= 5 && bigram.length <= 60) {
      bigramCounts[bigram] = (bigramCounts[bigram] || 0) + 1;
    }
  }
  for (const [bigram, count] of Object.entries(bigramCounts)) {
    if (count >= 2) phrases.push(bigram);
  }

  // --- Pattern 3: ## H2 headings as task class candidates ---
  const h2Pattern = /^##\s+(.+)$/m;
  let h2Match;
  while ((h2Match = h2Pattern.exec(body)) !== null) {
    const h2 = h2Match[1].trim().toLowerCase();
    if (h2.length > 2 && h2.length < 60) {
      taskClasses.push(h2.replace(/[^a-z0-9\s-]/g, '').trim());
    }
  }

  return {
    phrases: [...new Set(phrases)].slice(0, MAX_AUTO_PHRASES),
    taskClasses: [...new Set(taskClasses)],
  };
}

/**
 * Derives a rich manifest module entry from a module file path and body content.
 *
 * Derivation sources (in priority order):
 *   - YAML frontmatter (provides, task_class, triggers.keyword/phrases, depends_on)
 *   - Body content mining (instruction bullets, statistical bigrams, H2 headings)
 *   - Filename and category tokens (single keywords from path segments)
 *
 * Caller-supplied manifest_entry fields override every derived field, so an
 * explicit manifest_entry always takes precedence. id and path are structural
 * and never blanked out.
 *
 * @param {string} cleanPath  Path relative to modules/ (e.g. "travel/x.md").
 * @param {string} content    The module body just written.
 * @param {object} [provided] Optional caller manifest_entry overrides.
 * @returns {object} Complete module entry (always includes id + path).
 */
export function deriveModuleEntry(cleanPath, content, provided = {}) {
  const file = basename(cleanPath).replace(/\.(md|json)$/i, '');
  const category = cleanPath.includes('/') ? cleanPath.split('/')[0] : 'general';
  const body = String(content || '');

  // -- Source 1: Frontmatter parsing --
  const fm = parseModuleFrontmatter(body);

  // -- Source 2: Body content mining --
  const mined = mineBodyContent(body);

  // -- Source 3: Heading (first # H1) --
  const heading = (body.match(/^#\s+(.+)$/m) || [])[1];

  // -- Assemble triggers --
  // Keywords: frontmatter keywords first, then heading + filename + category tokens
  const fmKeywords = fm.triggers.keywords || [];
  const derivedKeywords = [
    ...fmKeywords,
    ...tokensOf(heading || ''),
    ...tokensOf(file),
    ...tokensOf(category),
  ];
  const keywords = [...new Set(derivedKeywords)].slice(0, MAX_AUTO_KEYWORDS);

  // Phrases: frontmatter phrases first, then mined body phrases
  const fmPhrases = fm.triggers.phrases || [];
  const phrases = [...new Set([...fmPhrases, ...mined.phrases])].slice(0, MAX_AUTO_PHRASES);

  // Task class: frontmatter task_class first, then mined H2 headings
  const fmTaskClass = fm.triggers.task_class || [];
  const taskClass = [...new Set([...fmTaskClass, ...mined.taskClasses])];

  // -- Assemble provides --
  const provides = (fm.provides && fm.provides.length > 0)
    ? fm.provides.slice(0, MAX_AUTO_PROVIDES)
    : mined.taskClasses.slice(0, MAX_AUTO_PROVIDES);

  const derived = {
    id: fm.id || file,
    title: (heading || file).trim(),
    version: '1.0.0',
    category: fm.category || category,
    path: `modules/${cleanPath}`,
    load_priority: typeof fm.load_priority === 'number' ? fm.load_priority : 5,
    triggers: { keywords, phrases, task_class: taskClass },
    depends_on: fm.depends_on || [],
    provides,
    load_strategy: fm.load_strategy || 'on_demand',
    line_count_estimate: typeof fm.line_count_estimate === 'number' ? fm.line_count_estimate : body.split('\n').length,
    always_load: fm.always_load || false,
  };

  // Merge caller-supplied overrides
  const entry = { ...derived, ...(provided && typeof provided === 'object' ? provided : {}) };
  // id and path are structural: never allow them to be blanked out.
  if (!entry.id) entry.id = derived.id;
  if (!entry.path) entry.path = derived.path;
  // Merge provided triggers over derived rather than replacing wholesale when
  // the caller supplies a partial triggers object.
  if (provided && provided.triggers && typeof provided.triggers === 'object') {
    entry.triggers = { ...derived.triggers, ...provided.triggers };
  }
  return entry;
}

/** Next fragment filename prefix: max existing numeric prefix + 10 (min 10). */
function nextFragmentPrefix(dir) {
  let max = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 10).padStart(2, '0');
}

/**
 * Creates or updates the manifest fragment registering a module. One fragment
 * per category (fragment.source === category): the module entry is upserted
 * by id, and an optional dispatch rule is upserted by id alongside it. When
 * no fragment for the category exists, a new {prefix}-{category}.json is
 * created per MANIFEST_DIRECTORY_PROTOCOL.md.
 *
 * @param {string} avaDir
 * @param {object} moduleEntry   From deriveModuleEntry().
 * @param {object} [dispatchRule] Optional fragment-schema dispatch rule.
 * @returns {{file:string, action:'created'|'updated', module_action:'added'|'replaced', path:string}}
 */
export function writeModuleFragment(avaDir, moduleEntry, dispatchRule = null) {
  const dir = fragmentsDirFor(avaDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const category = moduleEntry.category || 'general';

  // Find an existing fragment for this category.
  let targetName = null;
  let fragment = null;
  for (const name of readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')).sort()) {
    const parsed = readJsonSafe(join(dir, name));
    if (parsed && !parsed.__error && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.source === category) {
      targetName = name;
      fragment = parsed;
      break;
    }
  }

  const action = targetName ? 'updated' : 'created';
  if (!targetName) {
    targetName = `${nextFragmentPrefix(dir)}-${category}.json`;
    fragment = { manifest_append_version: '1.12', source: category, modules: [], references: [], dispatch_rules: [] };
  }
  fragment.modules = Array.isArray(fragment.modules) ? fragment.modules : [];
  fragment.dispatch_rules = Array.isArray(fragment.dispatch_rules) ? fragment.dispatch_rules : [];

  const idx = fragment.modules.findIndex(m => m && m.id === moduleEntry.id);
  const moduleAction = idx === -1 ? 'added' : 'replaced';
  if (idx === -1) fragment.modules.push(moduleEntry);
  else fragment.modules[idx] = moduleEntry;

  if (dispatchRule && typeof dispatchRule === 'object' && dispatchRule.module_to_add) {
    const rid = dispatchRule.id || `rule-${moduleEntry.id}`;
    const ridx = fragment.dispatch_rules.findIndex(r => r && r.id === rid);
    const rule = { id: rid, ...dispatchRule };
    if (ridx === -1) fragment.dispatch_rules.push(rule);
    else fragment.dispatch_rules[ridx] = rule;
  }

  const path = join(dir, targetName);
  writeFileSync(path, JSON.stringify(fragment, null, 2) + '\n', 'utf8');
  log('info', `[manifest-fragments] ${action} ${targetName}: module ${moduleEntry.id} ${moduleAction}`);
  return { file: targetName, action, module_action: moduleAction, path };
}
