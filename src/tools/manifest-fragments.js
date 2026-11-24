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
//
// v13.39.x (WO-2026-11-21-02): module_write no longer derives a registration
// from the module body. See "phase P" below: triggers, provides, title and
// version come only from the frontmatter or an explicit manifest_entry, every
// trigger passes a lint or is dropped and reported, and an existing
// registration is updated in place (Q2) instead of a new one being minted.
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

/**
 * A fragment's source (its category): the "source" field, else the file name
 * without its numeric prefix and extension. The one rule for reading a
 * fragment and for choosing which fragment a module_write registration goes
 * to, so a category fragment without a "source" field is still found (Q5).
 *
 * @param {string} name    Fragment file name, e.g. "100-existential.json".
 * @param {object} parsed  The fragment's JSON.
 * @returns {string}
 */
export function fragmentSourceOf(name, parsed) {
  return parsed && typeof parsed.source === 'string' ? parsed.source : String(name).replace(/^\d+-/, '').replace(/\.json$/i, '');
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
      source: fragmentSourceOf(name, parsed),
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
export function inferModulePath(avaDir, entry, exists = existsSync) {
  if (entry.path) return entry.path;
  const id = String(entry.id || '').trim();
  if (!id) return null;
  const candidates = [];
  if (entry.category) candidates.push(`modules/${entry.category}/${id}.md`);
  candidates.push(`modules/${id}.md`);
  for (const rel of candidates) {
    if (exists(join(avaDir, rel))) return rel;
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
 * @param {Function} [exists] v13.38.0: the existence test path inference uses.
 *        Default existsSync. src/tools/module-files.js passes one that treats a
 *        file as already gone, to ask what the compile would load after a
 *        quarantine without moving anything.
 * @returns {{added: string[], skippedExisting: string[], pathInferred: string[], pathMissing: string[]}}
 */
export function mergeFragmentsIntoManifest(manifest, fragments, avaDir, exists = existsSync) {
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
        const inferred = inferModulePath(avaDir, entry, exists);
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
 * @param {object} [options]  v13.38.0 (WO-2026-11-20-03), for
 *        src/tools/module-files.js only; every existing caller passes none and
 *        gets the previous behaviour exactly.
 * @param {Array} [options.fragments]  Use these fragments instead of reading
 *        references/manifest/ (a simulated state: the fragments as they would
 *        be after a de-registration).
 * @param {Function} [options.exists]  The existence test for path inference.
 * @param {boolean} [options.quiet]  Do not log the merge (an audit or a
 *        simulation is not a compile).
 * @returns {{ manifest: object, fragmentLinkages: Array, fragmentStats: object, fragmentsSkipped: Array }}
 */
export function loadMergedManifest(paths, readJsonFile, options = {}) {
  const quiet = options && options.quiet === true;
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
      if (!quiet) log('info', `loadMergedManifest: MANIFEST_APPEND merged ${newModules.length} new modules: ${newModules.map(m => m.id).join(', ')}`);
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
  const { fragments, skipped } = (options && Array.isArray(options.fragments))
    ? { fragments: options.fragments, skipped: [] }
    : loadManifestFragments(paths.avaDir);
  const fragmentStats = mergeFragmentsIntoManifest(manifest, fragments, paths.avaDir,
    (options && typeof options.exists === 'function') ? options.exists : existsSync);
  if (quiet) {
    return { manifest, fragmentLinkages: fragmentDispatchToLinkages(fragments), fragmentStats, fragmentsSkipped: skipped };
  }
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

/**
 * Parse frontmatter from markdown content. Returns a flat object of the fields
 * that matter for manifest derivation: provides, task_class, id, category,
 * always_load, load_priority, load_strategy, depends_on, and triggers.*
 *
 * Uses the same YAML-light parser that brain_scan.py uses: handles scalars,
 * comma-separated lists, inline arrays, and block list items. PyYAML is not
 * available in the connector image, so this is stdlib-only.
 */
export function parseModuleFrontmatter(content) {
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
      } else if (currentKey === 'version') {
        // v13.38.0: read for skill_consistency_audit C-I (version drift).
        // deriveModuleEntry does not use it, so registration is unchanged.
        result.version = cleaned;
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

// ---------------------------------------------------------------------------
// WO-2026-11-21-02 phase P: what module_write may write into a registration
// ---------------------------------------------------------------------------
//
// D1 of the order: the registration used to be derived by scraping the module
// body. Headings became provides and task classes, prose fragments and
// line-break bigrams became phrases ("into the", "attunement the"), path
// segments became keywords ("exist", "existential"), and the tokenizer split
// on anything outside a-z0-9, which is how "Alev Türker" became "alev rker".
// Body derivation is removed, not narrowed (P1). A registration now says only
// what an author said explicitly, in the module's frontmatter or in the
// manifest_entry passed to module_write:
//
//   triggers   frontmatter triggers (non-empty), verbatim; else
//              manifest_entry.triggers, verbatim; else empty, with
//              triggers_source "none" and a warning (P2, P3). Every keyword
//              and phrase, whatever its source, passes the P4 and P5 lint or is
//              dropped, and every drop is reported, never repaired (P4, P5).
//              Every drop is also persisted in the entry's trigger_dropped
//              block, beside triggers, as [{ phrase, reason }] (and
//              { keyword, reason }, { task_class, reason }), so the fragment
//              records what the write refused (WO-2026-11-24-03 R3, option b).
//   provides   frontmatter provides, else manifest_entry.provides, else empty
//              with a warning (P6). Never a heading.
//   title      frontmatter title, else manifest_entry.title, else the module
//              id (P7). Never the body's first # heading.
//   version    frontmatter version, else manifest_entry.version, else absent.
//              Read at every write; never carried forward, never invented (P8).
//   line_count_estimate   counted from the file being written, every write (P8).
//   task_class only as supplied with the triggers (P10).
//   strings    every string must round-trip through UTF-8 unchanged, and a
//              frontmatter value must appear verbatim in the frontmatter it was
//              read from; a failure refuses the write (P9).
//
// An in-place update (Q2) with no explicit trigger or provides source keeps
// the existing registration's triggers and provides exactly as they are,
// triggers_source included, and so for the other fields no source names
// (category, load_priority, load_strategy, always_load, depends_on, and keys
// this module does not manage). Clearing triggers would be a dispatch change,
// and a dispatch change is put to Brian as a question (R3), never made as a
// side effect of a body edit; correcting an auto-derived entry is the repair
// report's job (module-consistency.js). An explicit manifest_entry field,
// including an explicit empty triggers object, always applies.
// ---------------------------------------------------------------------------

/** P5: English function words. A trigger phrase made only of these is refused (WO-2026-11-24-03 R1). Closed list, lower case; unchanged by that order. */
export const REGISTRATION_STOPWORDS = Object.freeze([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'than', 'as', 'because', 'while', 'though', 'although', 'whether',
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'down', 'with',
  'within', 'without', 'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'before', 'behind',
  'below', 'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'inside', 'near', 'outside', 'past', 'since',
  'through', 'throughout', 'toward', 'towards', 'under', 'underneath', 'until', 'upon', 'via',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them',
  'their', 'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'all', 'any', 'each', 'some', 'such', 'own', 'same', 'very', 'too', 'just', 'also',
  'there', 'here', 'when', 'where', 'why', 'how', 'again', 'once', 'only', 'both', 'few', 'more', 'most', 'other',
]);
const STOPWORDS = new Set(REGISTRATION_STOPWORDS);

/** P4: words never valid as a keyword on their own, wherever the module sits. */
export const FORBIDDEN_KEYWORDS = Object.freeze(['module', 'skill', 'note']);

/** P5 thresholds. */
export const PHRASE_MIN_TOKENS = 2;
export const PHRASE_MIN_CHARS = 12;

/** P2, P3: where a registration's triggers came from. "derived" is the legacy value R1 looks for. */
export const TRIGGERS_SOURCE = Object.freeze({ FRONTMATTER: 'frontmatter', MANIFEST_ENTRY: 'manifest_entry', NONE: 'none' });

/** P9: the refusal a registration string that does not survive UTF-8 returns. */
export const REGISTRATION_REFUSAL = Object.freeze({ ENCODING_LOSS: 'registration_encoding_loss' });

/** The marker module_write puts on every registration it writes (read by C-F, S2). */
export const REGISTERED_BY_MODULE_WRITE = 'module_write';

const TRIGGER_KEYS = Object.freeze(['keywords', 'phrases', 'task_class']);
const LIST_FIELDS = new Set(['keywords', 'phrases', 'task_class', 'provides', 'depends_on']);

/** Keys deriveRegistration decides; every other key of an existing entry is kept on an update. */
const MANAGED_KEYS = Object.freeze(['id', 'title', 'version', 'category', 'path', 'load_priority', 'triggers',
  'triggers_source', 'trigger_dropped', 'depends_on', 'provides', 'load_strategy', 'line_count_estimate', 'always_load', 'registered_by']);

/**
 * P8: a file's line count by the compile's own rule (skill-modular.js
 * countLines: content ? content.split('\n').length : 0), which is also how the
 * module scan (module-files.js) and skill_consistency_audit C-I count. The
 * compile's budget arithmetic reads line_count_estimate, so the estimate is
 * stated in the unit the compile measures.
 */
export function lineCountOf(text) {
  const s = String(text ?? '');
  return s ? s.split('\n').length : 0;
}

/**
 * P4: the words a module's own path supplies, lower case: every directory name
 * on the path ("modules" included) and the file name without its extension.
 *
 * @param {string} modulePath  "modules/<...>.md" (either slash).
 * @returns {Set<string>}
 */
export function pathSegmentsOf(modulePath) {
  const parts = String(modulePath || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  const out = new Set(parts.slice(0, -1).map((d) => d.toLowerCase()));
  const last = parts[parts.length - 1];
  if (last) out.add(last.replace(/\.(md|json)$/i, '').toLowerCase());
  return out;
}

/** A word with surrounding punctuation removed, lower case (Unicode letters and digits kept). */
function bareWord(token) {
  return String(token || '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * P4: why a keyword is not valid, or null when it is.
 *
 * @param {*} keyword
 * @param {Set<string>} segments  pathSegmentsOf(the module's path)
 * @returns {string|null}
 */
export function keywordLintReason(keyword, segments) {
  if (typeof keyword !== 'string' || !keyword.trim()) return 'empty';
  const k = keyword.trim().toLowerCase();
  if (FORBIDDEN_KEYWORDS.includes(k)) return `"${k}" is never a valid keyword on its own (P4)`;
  if (segments && segments.has(k)) return `"${k}" is a segment of the module's own path (P4)`;
  return null;
}

/**
 * WO-2026-11-24-03 R1: the reason a phrase made only of stopwords is refused.
 * C-L and the re-derivation read this value; it is not reworded elsewhere.
 */
export const PHRASE_STOPWORDS_ONLY_REASON = 'consists only of stopwords';

/** Condition 4's reason begins with this; the re-derivation tells a substring refusal apart by it. */
export const PHRASE_SUBSTRING_REASON_PREFIX = 'a substring of another phrase on this module';

/**
 * WO-2026-11-24-03 R1: does a phrase consist only of stopwords? A token with
 * no letter or digit (a dash, a lone quote) carries no content either, so
 * "into the -" counts as stopwords only. An empty phrase does too.
 * (C-L's stopword_phrase finding reports exactly this.)
 *
 * @param {*} phrase
 * @returns {boolean}
 */
export function phraseIsStopwordsOnly(phrase) {
  const tokens = String(phrase ?? '').trim().split(/\s+/).filter(Boolean);
  return !tokens.some((t) => {
    const w = bareWord(t);
    return w !== '' && !STOPWORDS.has(w);
  });
}

/**
 * P5, as amended by WO-2026-11-24-03 R1: every reason a phrase fails the lint;
 * empty when it passes. A phrase is kept only if:
 *   1. it has two or more words;
 *   2. it is at least twelve characters long;
 *   3. it is not made only of stopwords (the old "no stopword at either end"
 *      rule is gone: it refused "plan a trip to" and "nobody asked me");
 *   4. it is not a substring of another phrase on the same module.
 * Conditions 1, 2 and 4 and the stopword list are unchanged.
 *
 * @param {*} phrase
 * @param {string[]} [otherPhrases]  The module's other phrases (substring rule).
 * @returns {string[]}
 */
export function phraseLintReasons(phrase, otherPhrases = []) {
  if (typeof phrase !== 'string' || !phrase.trim()) return ['empty'];
  const p = phrase.trim();
  const tokens = p.split(/\s+/).filter(Boolean);
  const reasons = [];
  if (tokens.length < PHRASE_MIN_TOKENS) reasons.push(`fewer than ${PHRASE_MIN_TOKENS} tokens`);
  if (phraseIsStopwordsOnly(p)) reasons.push(`${PHRASE_STOPWORDS_ONLY_REASON} (${tokens.map((t) => `"${bareWord(t) || t}"`).join(', ')})`);
  if ([...p].length < PHRASE_MIN_CHARS) reasons.push(`shorter than ${PHRASE_MIN_CHARS} characters`);
  const lower = p.toLowerCase();
  const container = otherPhrases.find((o) => typeof o === 'string' && o.trim().toLowerCase() !== lower && o.toLowerCase().includes(lower));
  if (container) reasons.push(`${PHRASE_SUBSTRING_REASON_PREFIX} ("${container.trim()}")`);
  return reasons;
}

/**
 * WO-2026-11-24-03 R3 (option b): the trigger_dropped block a registration
 * carries beside triggers. One item per value the lint refused on this write,
 * in the order supplied: { phrase, reason } for a phrase, { keyword, reason }
 * for a keyword, { task_class, reason } for a task class. reason is every
 * failed condition, joined by "; ". It is a record of what was refused, never
 * scored: the compile reads module.triggers only.
 *
 * @param {Array<{field:string, value:string, reasons:string[]}>} dropped  deriveRegistration's dropped list.
 * @returns {object[]}
 */
export function triggerDroppedBlock(dropped) {
  const key = { phrases: 'phrase', keywords: 'keyword', task_class: 'task_class' };
  return (Array.isArray(dropped) ? dropped : [])
    .filter((d) => d && key[d.field] && typeof d.value === 'string')
    .map((d) => ({ [key[d.field]]: d.value, reason: (Array.isArray(d.reasons) ? d.reasons : []).join('; ') }));
}

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) return s.slice(1, -1);
  return s;
}

/** Split on commas outside quotes and brackets: the items of a flow list or the pairs of a flow mapping. */
function splitTopLevel(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * A one-line flow mapping, "{ keywords: [a, b], phrases: [c] }", as
 * { keywords: ['a', 'b'], phrases: ['c'] }; null when it is not one.
 */
function flowMapping(raw) {
  const s = String(raw).trim();
  if (!(s.startsWith('{') && s.endsWith('}'))) return null;
  const out = {};
  for (const pair of splitTopLevel(s.slice(1, -1))) {
    const m = pair.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/s);
    if (!m) return null;
    out[m[1]] = LIST_FIELDS.has(m[1]) ? splitList(m[2]) : unquote(m[2]);
  }
  return out;
}

/** "[a, 'b, c', \"d\"]" -> ['a', 'b, c', 'd'];  "a, b" -> ['a', 'b']. Quote-aware; never changes case. */
function splitList(raw) {
  let s = String(raw).trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && !cur.trim()) { quote = ch; cur = ''; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * The frontmatter as its author wrote it, for registration (P2, P9).
 *
 * parseModuleFrontmatter above lower-cases triggers and drops a nested inline
 * list ("  keywords: a, b" under "triggers:"); it is kept unchanged because
 * skill_consistency_audit (C-I) and the write guard's id reading consume it.
 * This reader changes no character of any value and reads every form the
 * frontmatter uses: scalars, comma lists, inline [arrays] with quoted items,
 * block "- item" lists, a "triggers:" mapping, "triggers.keywords:" keys and
 * the legacy flat top-level keywords/phrases/task_class.
 *
 * @param {string} content
 * A "triggers:" value it cannot read is listed in `unreadable`, so module_write
 * warns instead of registering the module as if it had no triggers in silence.
 *
 * @returns {{ present: boolean, block: string|null, fields: object, triggers: object, has_triggers: boolean, has_provides: boolean, unreadable: object[] }}
 */
export function readRegistrationFrontmatter(content) {
  const out = { present: false, block: null, fields: {}, triggers: {}, has_triggers: false, has_provides: false, unreadable: [] };
  const text = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) return out;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return out;
  const block = text.slice(4, end);
  out.present = true;
  out.block = block;

  const target = (k) => (TRIGGER_KEYS.includes(k) ? out.triggers : out.fields);
  let listKey = null;
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const item = trimmed.match(/^-\s+(.*)$/);
    if (item) {
      if (listKey) {
        const v = unquote(item[1]);
        if (v) (target(listKey)[listKey] = target(listKey)[listKey] || []).push(v);
      }
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z_][\w./-]*):(?:\s+(.*)|\s*)$/);
    if (!kv) continue;
    let k = kv[1];
    const v = (kv[2] || '').trim();
    const dotted = k.match(/^triggers[./](keywords|phrases|task_class)$/);
    if (dotted) k = dotted[1];
    else if (k === 'triggers') {
      listKey = null;
      if (v) {
        // "triggers: { keywords: [a, b], phrases: [c] }" on one line.
        const map = flowMapping(v);
        if (map) for (const t of TRIGGER_KEYS) { if (Array.isArray(map[t])) out.triggers[t] = map[t]; }
        else out.unreadable.push({ key: 'triggers', value: v });
      }
      continue;
    }
    listKey = LIST_FIELDS.has(k) ? k : null;
    if (LIST_FIELDS.has(k)) target(k)[k] = v ? splitList(v) : (target(k)[k] || []);
    else if (v) out.fields[k] = unquote(v);
  }
  out.has_triggers = TRIGGER_KEYS.some((k) => Array.isArray(out.triggers[k]) && out.triggers[k].length > 0);
  out.has_provides = Array.isArray(out.fields.provides) && out.fields.provides.length > 0;
  return out;
}

const isNonEmptyTriggers = (t) => Boolean(t && typeof t === 'object'
  && Object.values(t).some((v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim())));

/**
 * Derive the registration module_write will write (phase P), with what was
 * dropped, what was warned, and a refusal when a string did not survive (P9).
 *
 * @param {string} cleanPath  Path relative to modules/ (e.g. "existential/x.md").
 * @param {string} content    The module file being written.
 * @param {object} [provided] manifest_entry, when the caller passed one.
 * @param {object} [options]
 * @param {object} [options.existing]  The registration being updated in place (Q2).
 * @returns {{ entry: object, triggers_source: string|null, origin: object, warnings: object[], dropped: object[], refusal: object|null, frontmatter_present: boolean }}
 */
export function deriveRegistration(cleanPath, content, provided = {}, options = {}) {
  const body = String(content || '');
  const given = provided && typeof provided === 'object' && !Array.isArray(provided) ? provided : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(given, k) && given[k] !== undefined && given[k] !== null;
  const existing = options && options.existing && typeof options.existing === 'object' ? options.existing : null;
  const fm = readRegistrationFrontmatter(body);
  const f = fm.fields;
  const fmStr = (k) => (typeof f[k] === 'string' && f[k].trim() ? f[k].trim() : null);
  const givenStr = (k) => (has(k) && (typeof given[k] === 'string' || typeof given[k] === 'number') && String(given[k]).trim() ? String(given[k]).trim() : null);
  const fileStem = basename(cleanPath).replace(/\.(md|json)$/i, '');
  const modulePath = `modules/${cleanPath}`;
  const segments = pathSegmentsOf(modulePath);
  const origin = {};
  const warnings = [];
  const dropped = [];

  // id, category: unchanged rules (an explicit manifest_entry value wins).
  const id = givenStr('id') || fmStr('id') || fileStem;
  origin.id = givenStr('id') ? 'manifest_entry' : (fmStr('id') ? 'frontmatter' : 'path');

  const pathCategory = cleanPath.includes('/') ? cleanPath.split('/')[0] : 'general';
  let category;
  if (givenStr('category')) { category = givenStr('category'); origin.category = 'manifest_entry'; }
  else if (fmStr('category')) { category = fmStr('category'); origin.category = 'frontmatter'; }
  else if (existing && typeof existing.category === 'string' && existing.category) { category = existing.category; origin.category = 'retained'; }
  else { category = pathCategory; origin.category = 'path'; }

  // P7 title.
  let title;
  if (fmStr('title')) { title = fmStr('title'); origin.title = 'frontmatter'; }
  else if (givenStr('title')) { title = givenStr('title'); origin.title = 'manifest_entry'; }
  else { title = id; origin.title = 'id'; }

  // P8 version: never carried forward, never invented.
  let version = null;
  if (fmStr('version')) { version = fmStr('version'); origin.version = 'frontmatter'; }
  else if (givenStr('version')) { version = givenStr('version'); origin.version = 'manifest_entry'; }
  else origin.version = 'absent';

  // Fields no phase names: explicit, else the entry being updated, else the default.
  const scalar = (k, parse, fallback) => {
    if (has(k)) { origin[k] = 'manifest_entry'; return given[k]; }
    if (f[k] !== undefined) {
      const v = parse(f[k]);
      if (v !== undefined) { origin[k] = 'frontmatter'; return v; }
    }
    if (existing && existing[k] !== undefined) { origin[k] = 'retained'; return existing[k]; }
    origin[k] = 'default';
    return fallback;
  };
  const loadPriority = scalar('load_priority', (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? undefined : n; }, 5);
  const loadStrategy = scalar('load_strategy', (v) => (typeof v === 'string' && v ? v : undefined), 'on_demand');
  const alwaysLoad = scalar('always_load', (v) => (typeof v === 'string' ? (v.toLowerCase() === 'true' || v.toLowerCase() === 'yes') : undefined), false);
  const dependsOn = scalar('depends_on', (v) => (Array.isArray(v) ? v : undefined), []);

  // P6 provides.
  let provides;
  if (fm.has_provides) { provides = [...f.provides]; origin.provides = 'frontmatter'; }
  else if (has('provides') && Array.isArray(given.provides)) { provides = given.provides.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()); origin.provides = 'manifest_entry'; }
  else if (existing && Array.isArray(existing.provides) && existing.provides.length) {
    provides = [...existing.provides]; origin.provides = 'retained';
    warnings.push({ code: 'provides_retained', module_id: id,
      message: `No provides in the frontmatter or manifest_entry: the existing registration's provides for ${id} are kept unchanged. To change them, add provides: to the frontmatter or pass manifest_entry.provides.` });
  } else {
    provides = []; origin.provides = 'none';
    warnings.push({ code: 'registered_without_provides', module_id: id,
      message: `Module ${id} is registered with no provides: the frontmatter has no provides: field and none was passed. provides is never derived from headings (P6); add provides: to the frontmatter if other modules depend on a capability of this one.` });
  }

  // P2-P5 triggers.
  let triggers;
  let triggersSource;
  let triggersRetained = false;
  let supplied = null;
  if (fm.has_triggers) {
    supplied = { source: TRIGGERS_SOURCE.FRONTMATTER, raw: fm.triggers };
  } else if (has('triggers') && typeof given.triggers === 'object' && !Array.isArray(given.triggers)) {
    supplied = { source: TRIGGERS_SOURCE.MANIFEST_ENTRY, raw: given.triggers };
  }
  if (supplied) {
    const raw = supplied.raw;
    const list = (k) => (Array.isArray(raw[k]) ? raw[k].filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
    const dedupe = (field, items) => {
      const seen = new Set();
      return items.filter((x) => {
        const key = x.toLowerCase();
        if (seen.has(key)) { dropped.push({ field, value: x, reasons: ['a duplicate of another value on this module'] }); return false; }
        seen.add(key);
        return true;
      });
    };
    const keywords = dedupe('keywords', list('keywords')).filter((k) => {
      const why = keywordLintReason(k, segments);
      if (why) { dropped.push({ field: 'keywords', value: k, reasons: [why] }); return false; }
      return true;
    });
    const phraseSet = dedupe('phrases', list('phrases'));
    const phrases = phraseSet.filter((p) => {
      const why = phraseLintReasons(p, phraseSet);
      if (why.length) { dropped.push({ field: 'phrases', value: p, reasons: why }); return false; }
      return true;
    });
    const taskClass = dedupe('task_class', list('task_class'));
    // A manifest_entry may carry other trigger kinds the compile scores (regex,
    // subjects); they are kept verbatim.
    const others = {};
    if (supplied.source === TRIGGERS_SOURCE.MANIFEST_ENTRY) {
      for (const [k, v] of Object.entries(raw)) if (!TRIGGER_KEYS.includes(k)) others[k] = v;
    }
    triggers = { keywords, phrases, task_class: taskClass, ...others };
    triggersSource = isNonEmptyTriggers(triggers) ? supplied.source : TRIGGERS_SOURCE.NONE;
  } else if (existing && isNonEmptyTriggers(existing.triggers)) {
    triggers = JSON.parse(JSON.stringify(existing.triggers));
    triggersSource = typeof existing.triggers_source === 'string' ? existing.triggers_source : null;
    triggersRetained = true;
    warnings.push({ code: 'triggers_retained', module_id: id,
      message: `No triggers in the frontmatter or manifest_entry: the existing registration's triggers for ${id} are kept unchanged. module_write never removes dispatch triggers as a side effect of a write (R3); to change them, add triggers: to the frontmatter or pass manifest_entry.triggers.` });
  } else {
    triggers = { keywords: [], phrases: [], task_class: [] };
    triggersSource = TRIGGERS_SOURCE.NONE;
  }
  // WO-2026-11-24-03 R3 (option b): what this write refused, persisted beside
  // triggers. Retained triggers keep the record that came with them; when that
  // registration has none, none is invented (it is not known what was refused).
  let triggerDropped;
  if (triggersRetained) {
    triggerDropped = Array.isArray(existing.trigger_dropped) ? JSON.parse(JSON.stringify(existing.trigger_dropped)) : undefined;
  } else {
    triggerDropped = triggerDroppedBlock(dropped);
  }
  for (const d of dropped) {
    warnings.push({ code: 'trigger_dropped', module_id: id, field: d.field, value: d.value, reasons: d.reasons,
      message: `Dropped ${d.field === 'keywords' ? 'keyword' : d.field === 'phrases' ? 'phrase' : d.field} "${d.value}": ${d.reasons.join('; ')}. It was not stored and was not changed into anything else.` });
  }
  for (const u of fm.unreadable) {
    warnings.push({ code: 'frontmatter_unreadable', module_id: id, key: u.key, value: u.value,
      message: `The frontmatter ${u.key}: value "${u.value}" could not be read, so it was not used. Write it as a block (keywords: then "- item" lines) or as "keywords: [a, b]".` });
  }
  if (triggersSource === TRIGGERS_SOURCE.NONE) {
    warnings.push({ code: 'registered_without_triggers', module_id: id,
      message: `Module ${id} is registered without dispatch triggers and will not be selected by trigger until they are supplied (frontmatter triggers: or manifest_entry.triggers). It remains reachable by explicit specialist load.` });
  }
  origin.triggers = triggersRetained ? 'retained' : (supplied ? supplied.source : 'none');

  // Keys this module does not manage: an explicit manifest_entry value, else
  // the entry being updated keeps its own.
  const extras = {};
  if (existing) for (const [k, v] of Object.entries(existing)) if (!MANAGED_KEYS.includes(k) && !k.startsWith('_')) extras[k] = v;
  for (const [k, v] of Object.entries(given)) if (!MANAGED_KEYS.includes(k)) extras[k] = v;

  const entry = {
    id,
    title,
    ...(version !== null ? { version } : {}),
    category,
    path: modulePath,
    load_priority: loadPriority,
    triggers,
    ...(triggersSource !== null ? { triggers_source: triggersSource } : {}),
    ...(triggerDropped !== undefined ? { trigger_dropped: triggerDropped } : {}),
    depends_on: dependsOn,
    provides,
    load_strategy: loadStrategy,
    line_count_estimate: lineCountOf(body),
    always_load: alwaysLoad,
    ...extras,
    registered_by: REGISTERED_BY_MODULE_WRITE,
  };

  // P9: every string this write supplies survives UTF-8 unchanged, and a
  // frontmatter value is found verbatim where it was read from.
  const problems = [];
  const check = (field, value, from) => {
    if (typeof value !== 'string') return;
    if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
      problems.push({ field, value, reason: 'does not round-trip through UTF-8 (an unpaired surrogate)' });
    } else if (value.includes('\uFFFD')) {
      problems.push({ field, value, reason: 'contains U+FFFD, the replacement character: a character was lost before this write' });
    } else if (from === 'frontmatter' && fm.block !== null && !fm.block.includes(value)) {
      problems.push({ field, value, reason: 'is not found verbatim in the frontmatter it was read from: a character was changed or lost in reading' });
    }
  };
  const walk = (field, value, from) => {
    if (typeof value === 'string') check(field, value, from);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(`${field}[${i}]`, v, from));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${field}.${k}`, v, from);
  };
  for (const k of ['id', 'title', 'version', 'category', 'load_strategy']) if (entry[k] !== undefined && origin[k] !== 'retained') walk(k, entry[k], origin[k]);
  if (origin.provides !== 'retained') walk('provides', entry.provides, origin.provides);
  if (origin.depends_on !== 'retained') walk('depends_on', entry.depends_on, origin.depends_on);
  if (!triggersRetained) walk('triggers', entry.triggers, origin.triggers);
  // Every supplied trigger string too, including any the lint drops: a name
  // that arrives damaged is refused, not quietly dropped.
  if (supplied) walk('triggers (as supplied)', supplied.raw, supplied.source);
  for (const k of Object.keys(given)) if (!MANAGED_KEYS.includes(k)) walk(k, given[k], 'manifest_entry');

  const refusal = problems.length ? {
    refused: true,
    code: REGISTRATION_REFUSAL.ENCODING_LOSS,
    message: `Refused: ${problems.length} registration string(s) for ${id} did not survive UTF-8 unchanged (${problems.map((p) => `${p.field} ${p.reason}`).join('; ')}). A corrupted name is not written into a register (P9). Nothing was written.`,
    problems,
  } : null;

  return { entry, triggers_source: triggersSource, origin, warnings, dropped, refusal, frontmatter_present: fm.present };
}

/**
 * The registration entry alone, for callers that need only the entry. Throws
 * (err.code = registration_encoding_loss) where deriveRegistration refuses.
 *
 * @param {string} cleanPath
 * @param {string} content
 * @param {object} [provided]
 * @param {object} [options]
 * @returns {object}
 */
export function deriveModuleEntry(cleanPath, content, provided = {}, options = {}) {
  const r = deriveRegistration(cleanPath, content, provided, options);
  if (r.refusal) {
    const err = new Error(r.refusal.message);
    err.code = r.refusal.code;
    err.refusal = r.refusal;
    throw err;
  }
  return r.entry;
}

/**
 * Q5: the existing fragment a new registration of `category` belongs in, or
 * null. Its "source" field, else (for a fragment holding a modules array) its
 * file name, per fragmentSourceOf; never a fragment marked deprecated. The one
 * rule writeModuleFragment and module_write's registration plan both use, so a
 * dry run names the fragment the real call writes.
 *
 * @param {string} avaDir
 * @param {string} category
 * @returns {string|null} The fragment file name.
 */
export function findCategoryFragment(avaDir, category) {
  const dir = fragmentsDirFor(avaDir);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')).sort()) {
    const parsed = readJsonSafe(join(dir, name));
    if (!parsed || parsed.__error || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.deprecated) continue;
    if (parsed.source === category || (Array.isArray(parsed.modules) && fragmentSourceOf(name, parsed) === category)) return name;
  }
  return null;
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
 * per category: the module entry is upserted by id, and an optional dispatch
 * rule is upserted by id alongside it. When no fragment for the category
 * exists, a new {prefix}-{category}.json is created per
 * MANIFEST_DIRECTORY_PROTOCOL.md.
 *
 * v13.39.x (WO-2026-11-21-02):
 *   Q2  options.targetFile names the fragment that already registers this id
 *       at this path; the entry there is replaced in place, whatever that
 *       fragment's category, so a second registration is never minted.
 *   Q5  a category fragment is found by fragmentSourceOf (its "source" field,
 *       else its file name), the rule loadManifestFragments reads by, so an
 *       existing fragment without a "source" field is updated rather than a
 *       new one created beside it. A fragment marked deprecated is never chosen.
 *
 * @param {string} avaDir
 * @param {object} moduleEntry   From deriveRegistration().entry.
 * @param {object} [dispatchRule] Optional fragment-schema dispatch rule.
 * @param {object} [options]
 * @param {string} [options.targetFile]  Fragment file name to update; it must exist and parse.
 * @returns {{file:string, action:'created'|'updated', module_action:'added'|'replaced', path:string}}
 */
export function writeModuleFragment(avaDir, moduleEntry, dispatchRule = null, options = {}) {
  const dir = fragmentsDirFor(avaDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const category = moduleEntry.category || 'general';
  const names = readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')).sort();

  let targetName = null;
  let fragment = null;
  if (options && options.targetFile) {
    const name = basename(String(options.targetFile));
    const parsed = names.includes(name) ? readJsonSafe(join(dir, name)) : null;
    if (!parsed || parsed.__error || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`the fragment ${name} that registers ${moduleEntry.id} is missing or unreadable; nothing was registered`);
    }
    targetName = name;
    fragment = parsed;
  } else {
    // Find an existing fragment for this category (Q5).
    const found = findCategoryFragment(avaDir, category);
    if (found) {
      targetName = found;
      fragment = readJsonSafe(join(dir, found));
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
