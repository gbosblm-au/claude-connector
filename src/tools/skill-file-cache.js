// src/tools/skill-file-cache.js
//
// A read-through cache for the modular skill files, validated by mtime.
// v13.20.0.
//
// ===========================================================================
// WHY THIS EXISTS, AND WHY IT IS NOT A COMPILED-SKILL CACHE
// ===========================================================================
//
// The observed failure: /ti-skill-compile takes longer than the gateway's
// timeout, the gateway falls back to the static skill, and the modular set --
// every specialist module -- never loads for that session.
//
// The obvious fix is to cache the compiled skill per tenant. It is also wrong.
// compileSkill() chooses which modules to include from the QUERY, the context
// hint and the person prior: detectTriggerConditions(query), layer1Score(
// manifest, query, contextHint), and resolvePersonPrior(personName). Two
// sessions whose first messages differ get different module sets, correctly.
// A tenant-keyed cache of the output would serve one session's modules to a
// session that asked about something else, and the symptom would be a
// specialist module silently missing -- far harder to diagnose than a timeout.
//
// So what is cached is the INPUT, not the output. Module selection stays
// per-query and exact; the filesystem reads that feed it are what get reused.
//
// ===========================================================================
// WHERE THE TIME ACTUALLY GOES
// ===========================================================================
//
// hydrateLineCounts() walks every module in the manifest and, for any entry
// without a declared line count, reads the whole file to count its lines. That
// is a full read of the module set on EVERY compile, before a single module has
// been selected, purely to feed the budget calculation.
//
// On a Railway bind mount those reads dominate. Then the selected module bodies
// are read again, along with CORE, PERSONALITY, the manifest fragments, the
// dispatch rules and PROFILES.
//
// Caching by path removes the repetition without changing a single decision the
// compiler makes.
//
// ===========================================================================
// WHY MTIME AND NOT A TTL
// ===========================================================================
//
// A TTL would serve stale modules for its duration after module_write, which is
// the one moment correctness matters most: an author who writes a module and
// immediately asks a question expects to see it. mtime plus size is exact, and
// a stat is orders of magnitude cheaper than a read of the same file.
//
// The stat is NOT skipped. A revalidation window would make this a TTL cache
// wearing a different name, with the same staleness after a write.

import { readFileSync, statSync, existsSync } from 'fs';

/**
 * path -> { mtimeMs, size, text, lines, json, jsonFallbackUsed }
 *
 * Module scope: one connector process serves one tenant's volume, and the cache
 * must survive across requests to be worth anything.
 */
const entries = new Map();

const stats = {
  hits: 0, misses: 0, invalidations: 0, statFailures: 0, reads: 0, bytes: 0,
};

/**
 * Is the cache switched on?
 *
 * Default on. An escape hatch rather than an opt-in: the cache is exact, and a
 * deployment that hits a problem with it needs to be able to turn it off
 * without a rollback.
 *
 * @returns {boolean}
 */
function enabled() {
  return 'false' !== String( process.env.SKILL_FILE_CACHE_ENABLED || '' ).trim().toLowerCase();
}

/**
 * The identity of a file's current contents, or null if it is not there.
 *
 * @param {string} path
 * @returns {{mtimeMs: number, size: number}|null}
 */
function identity( path ) {
  try {
    const st = statSync( path );
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch ( err ) {
    // A missing file is a normal state here -- most callers guard with
    // existsSync and fall back to a default. A permissions failure lands in
    // the same branch, which is correct: neither yields readable content.
    stats.statFailures += 1;
    return null;
  }
}

/**
 * The cached entry for a path, if it is still valid.
 *
 * @param {string} path
 * @returns {object|null}
 */
function validEntry( path ) {
  const entry = entries.get( path );
  if ( ! entry ) return null;

  const id = identity( path );
  if ( ! id ) {
    // The file has gone. Dropped rather than kept: serving the contents of a
    // deleted module would resurrect it into every later compile.
    entries.delete( path );
    stats.invalidations += 1;
    return null;
  }

  if ( id.mtimeMs !== entry.mtimeMs || id.size !== entry.size ) {
    entries.delete( path );
    stats.invalidations += 1;
    return null;
  }

  return entry;
}

/**
 * Read a file as UTF-8, through the cache.
 *
 * Throws exactly what readFileSync throws, so a caller that already handles a
 * read failure keeps handling it the same way. Callers here treat an
 * unreadable module as unmeasured rather than fatal, and that must not change.
 *
 * @param {string} path
 * @returns {string}
 */
export function cachedReadFile( path ) {
  if ( ! enabled() ) return readFileSync( path, 'utf8' );

  const hit = validEntry( path );
  if ( hit && undefined !== hit.text ) {
    stats.hits += 1;
    return hit.text;
  }

  const id = identity( path );
  const text = readFileSync( path, 'utf8' );
  stats.misses += 1;
  stats.reads += 1;
  stats.bytes += text.length;

  // Only cached when the stat succeeded. Without an identity there is nothing
  // to validate against later, and an entry that can never be invalidated is
  // worse than no entry at all.
  if ( id ) {
    entries.set( path, { ...( hit || {} ), mtimeMs: id.mtimeMs, size: id.size, text } );
  }
  return text;
}

/**
 * Read and parse a JSON file, through the cache.
 *
 * The PARSED object is cached, not just its text. Parsing MANIFEST.json on
 * every compile is not free either, and the manifest is the largest JSON here.
 *
 * ── The returned object is a deep copy ───────────────────────────────────
 *
 * compileSkill mutates what readJsonFile returns: hydrateLineCounts writes
 * `m.line_count` onto manifest entries, and fragment dispatch rules are merged
 * into `dispatchRules.learned_linkages.rules` in memory. Handing out the cached
 * object itself would let one compile's mutations leak into the next -- line
 * counts would look measured when they were not, and fragment rules would
 * accumulate on every call until they were applied many times over.
 *
 * A copy per call is the cost of making this safe, and it is still far cheaper
 * than a bind-mount read plus a parse.
 *
 * @param {string} path
 * @param {*} fallback Returned when the file is absent or unparseable.
 * @returns {*}
 */
export function cachedReadJson( path, fallback ) {
  if ( ! enabled() ) return uncachedJson( path, fallback );

  const hit = validEntry( path );
  if ( hit && undefined !== hit.json ) {
    stats.hits += 1;
    return hit.json === null ? fallback : deepCopy( hit.json );
  }

  if ( ! existsSync( path ) ) return fallback;

  const id = identity( path );
  let parsed = null;
  try {
    const text = readFileSync( path, 'utf8' );
    stats.reads += 1;
    stats.bytes += text.length;
    parsed = JSON.parse( text );
  } catch ( err ) {
    // Cached as a null parse, deliberately. A malformed manifest would
    // otherwise be re-read and re-parsed on every compile for as long as it
    // stayed broken, which is exactly when the volume is least worth hammering.
    parsed = null;
  }

  stats.misses += 1;
  if ( id ) {
    entries.set( path, { ...( hit || {} ), mtimeMs: id.mtimeMs, size: id.size, json: parsed } );
  }
  return null === parsed ? fallback : deepCopy( parsed );
}

/**
 * Count the lines in a file, through the cache.
 *
 * The count is memoised alongside the text, because hydrateLineCounts asks for
 * exactly this and nothing else for most modules. Re-counting a cached string
 * is cheap but not free, and there is no reason to do it twice for one mtime.
 *
 * @param {string} path
 * @param {Function} counter Line-counting function, injected so this module
 *        does not need to agree with the caller about what a line is.
 * @returns {number}
 */
export function cachedLineCount( path, counter ) {
  if ( ! enabled() ) return counter( readFileSync( path, 'utf8' ) );

  const hit = validEntry( path );
  if ( hit && 'number' === typeof hit.lines ) {
    stats.hits += 1;
    return hit.lines;
  }

  const text = cachedReadFile( path );
  const lines = counter( text );

  const entry = entries.get( path );
  if ( entry ) entry.lines = lines;
  return lines;
}

/**
 * Drop cached state for a path, or for everything.
 *
 * Called by the write paths (module_write, personality_write,
 * modules_restore_from_wp) so a freshly written module is visible to the very
 * next compile without waiting on stat granularity. mtime validation would
 * catch it anyway on most filesystems; this removes the dependence on that.
 *
 * @param {string} [path] Omit to clear the whole cache.
 * @returns {void}
 */
export function invalidateSkillFile( path ) {
  if ( path ) {
    if ( entries.delete( path ) ) stats.invalidations += 1;
    return;
  }
  stats.invalidations += entries.size;
  entries.clear();
}

/**
 * Counters for diagnostics. Never file contents.
 *
 * @returns {object}
 */
export function skillFileCacheStats() {
  return { ...stats, entries: entries.size, enabled: enabled() };
}

/**
 * @param {string} path
 * @param {*} fallback
 * @returns {*}
 */
function uncachedJson( path, fallback ) {
  if ( ! existsSync( path ) ) return fallback;
  try {
    return JSON.parse( readFileSync( path, 'utf8' ) );
  } catch ( err ) {
    return fallback;
  }
}

/**
 * A structural copy of parsed JSON.
 *
 * structuredClone where available -- it is native and handles nesting without
 * a serialise round trip. JSON round trip otherwise, which is exact for
 * anything that came out of JSON.parse in the first place.
 *
 * @param {*} value
 * @returns {*}
 */
function deepCopy( value ) {
  if ( 'function' === typeof structuredClone ) return structuredClone( value );
  return JSON.parse( JSON.stringify( value ) );
}

export default {
  cachedReadFile, cachedReadJson, cachedLineCount,
  invalidateSkillFile, skillFileCacheStats,
};
