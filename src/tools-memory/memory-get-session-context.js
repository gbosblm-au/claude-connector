// src/tools-memory/memory-get-session-context.js
// Tool handler for memory_get_session_context (TDD Section 6.6).
//
// Assembles a curated context bundle:
//   - projects, preferences, facts: all entries (full inclusion)
//   - skills:         20 most recently updated
//   - contacts:       10 most recently updated
//   - session:         5 most recent
//   - conversations:   up to conversations_limit entries (default 5),
//                      selected via three-tier associative retrieval when
//                      context_hint is provided, otherwise by recency.
//
// THREE-TIER ASSOCIATIVE RETRIEVAL (v10.0.5)
// ============================================
// Human memory retrieval is associative, not a direct lookup. A question
// about topic X should surface conversations about X (exact), conversations
// that partially overlap with X (related), and conversations about things
// thematically connected to X even if they share no vocabulary with the
// query (associative). The three tiers emulate this:
//
//   Tier 1 - EXACT:       FTS5 AND match. All context_hint tokens must
//                         appear in the document. Highest confidence.
//
//   Tier 2 - RELATED:     FTS5 OR match. Any context_hint token surfaces
//                         a document. Semantic proximity.
//
//   Tier 3 - ASSOCIATIVE: Tag-web search. Extracts meaningful tags from
//                         Tier 1+2 results and searches for OTHER
//                         conversations sharing any of those tags. Finds
//                         thematically connected conversations that share
//                         zero vocabulary with the original query.
//
// Each returned conversation entry is annotated with retrieval_tier
// ("exact", "related", "associative", or "recency") so the caller can
// weight context appropriately. Exact matches are highest confidence;
// associative matches are useful background context.
//
// Zero-results fallback: if all three tiers return nothing, recency is
// used so the caller always receives useful prior context.
//
// v10.0.4 changes (preserved):
//   - safeFtsQuery OR mode for context_hint path.
//   - Zero-results fallback added.
//
// v10.0.5 changes:
//   - Full three-tier associative retrieval replacing single-tier OR search.
//   - extractTagTerms() helper filters generic/noise tags from tier seeds.
//   - retrieval_tier field added to each conversation entry in response.
//   - conversations_tiers summary added to response for audit.

import { getDb } from "./db.js";
import { memorySessionContextSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";
import { rowToEntry, nowIso } from "./rowMapper.js";

// Category caps for the standard recency-based retrieval path.
// null = unbounded (all entries returned).
// "conversations" is handled separately via the context_hint branch
// but still needs a recency cap for the no-hint fallback.
const CATEGORY_CAPS = {
  projects:      null,
  preferences:   null,
  facts:         null,
  skills:        20,
  contacts:      10,
  session:       5,
  // conversations is not listed here; handled by its own block below.
};

// Tags that carry no useful associative signal for Tier 3.
// These appear in almost every conversation and would flood results
// with false positives if used as Tier 3 seeds.
const NOISE_TAG_PATTERNS = [
  /^[a-z]+-\d{4}$/,   // month-year slugs: may-2026, june-2026, etc.
  /^real-?mode$/,
  /^ava$/,
];

function isNoiseTag(tag) {
  return NOISE_TAG_PATTERNS.some((re) => re.test(tag));
}

/**
 * Sanitise a natural-language string into a safe FTS5 match expression.
 * Preserves explicit FTS5 operators when already present; otherwise wraps
 * each whitespace-separated token in double quotes for exact-token matching.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {boolean} [opts.useOr=false] - When true, joins tokens with OR so
 *   that any matching token surfaces a document (Tier 2 and Tier 3 mode).
 *   When false (default), implicit AND requires all tokens to be present
 *   (Tier 1 exact mode and memory_search).
 */
function safeFtsQuery(raw, { useOr = false } = {}) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  // Pass through if the caller is using explicit FTS5 syntax.
  if (/["*]|\b(AND|OR|NOT|NEAR)\b/.test(trimmed)) {
    return trimmed.replace(/'/g, "''");
  }

  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);

  return useOr ? tokens.join(" OR ") : tokens.join(" ");
}

/**
 * Extract meaningful (non-noise) tag terms from a set of DB rows.
 * Used to seed the Tier 3 associative search.
 *
 * @param {Array} rows - Raw DB rows with a JSON `tags` column.
 * @returns {string[]} Deduplicated array of meaningful tag strings.
 */
function extractTagTerms(rows) {
  const terms = new Set();
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.tags || "[]");
      for (const tag of tags) {
        if (typeof tag === "string" && tag.trim() && !isNoiseTag(tag.trim())) {
          terms.add(tag.trim().toLowerCase());
        }
      }
    } catch (_) {
      // malformed tags JSON - skip row
    }
  }
  return [...terms];
}

/**
 * Run an FTS5 conversation search, returning up to maxResults rows.
 * Errors are caught and an empty array is returned so tiers degrade
 * gracefully rather than throwing.
 *
 * @param {object} db      - better-sqlite3 Database instance.
 * @param {string} matchExpr - FTS5 MATCH expression.
 * @param {string} now     - ISO timestamp for TTL filtering.
 * @param {number} maxResults - Maximum rows to return.
 * @param {Set<string>} [excludeIds] - Row IDs to exclude (already found).
 * @returns {Array} Raw DB rows.
 */
function runConvFts(db, matchExpr, now, maxResults, excludeIds = new Set()) {
  if (!matchExpr) return [];
  try {
    const sql = `
      SELECT m.*, bm25(memories_fts) AS rank
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND m.category = 'conversations'
         AND (m.ttl IS NULL OR m.ttl > ?)
       ORDER BY rank
       LIMIT ?
    `;
    // Overfetch to absorb excludeId filtering in JS.
    const overfetch = maxResults + excludeIds.size + 5;
    const rows = db.prepare(sql).all(matchExpr, now, overfetch);
    return excludeIds.size > 0
      ? rows.filter((r) => !excludeIds.has(r.id)).slice(0, maxResults)
      : rows.slice(0, maxResults);
  } catch (_ftsErr) {
    return [];
  }
}

export async function handleMemoryGetSessionContext(rawArgs) {
  const parsed = memorySessionContextSchema.safeParse(rawArgs || {});
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_get_session_context.",
      400,
      parsed.error.flatten(),
    );
  }

  const { context_hint, conversations_limit = 5 } = parsed.data;
  const db   = getDb();
  const now  = nowIso();

  const context = {
    projects:      {},
    skills:        {},
    preferences:   {},
    contacts:      {},
    facts:         {},
    session:       {},
    conversations: [],   // array: entries are episodic records, not named slots
  };

  let entryCount = 0;

  // -----------------------------------------------------------------------
  // Standard categories: recency-based retrieval with per-category caps.
  // -----------------------------------------------------------------------
  for (const [category, cap] of Object.entries(CATEGORY_CAPS)) {
    const params = [now, category];
    let sql = `
      SELECT * FROM memories
       WHERE (ttl IS NULL OR ttl > ?)
         AND category = ?
       ORDER BY updated_at DESC
    `;
    if (cap !== null) {
      sql += " LIMIT ?";
      params.push(cap);
    }
    const rows = db.prepare(sql).all(...params);
    for (const row of rows) {
      const entry = rowToEntry(row, { includeValue: true });
      context[category][entry.key] = entry.value;
      entryCount += 1;
    }
  }

  // -----------------------------------------------------------------------
  // Conversations category.
  // -----------------------------------------------------------------------
  const convLimit = Math.max(1, Math.min(conversations_limit ?? 5, 20));

  // Recency query: fallback path and no-hint path.
  const recencySql = `
    SELECT * FROM memories
      WHERE (ttl IS NULL OR ttl > ?)
        AND category = 'conversations'
      ORDER BY updated_at DESC
      LIMIT ?
  `;

  if (!context_hint) {
    // No hint supplied: plain recency.
    const recencyRows = db.prepare(recencySql).all(now, convLimit);
    for (const row of recencyRows) {
      const entry = rowToEntry(row, { includeValue: true });
      entry.retrieval_tier = "recency";
      context.conversations.push(entry);
      entryCount += 1;
    }
  } else {
    // -------------------------------------------------------------------
    // Three-tier associative retrieval.
    // -------------------------------------------------------------------

    // --- Tier 1: EXACT ---------------------------------------------------
    // All context_hint tokens must appear in the document (AND logic).
    // Highest confidence; direct vocabulary overlap with the query.
    const exactQuery = safeFtsQuery(context_hint, { useOr: false });
    const tier1Rows = runConvFts(db, exactQuery, now, convLimit);
    const tier1Ids = new Set(tier1Rows.map((r) => r.id));

    // --- Tier 2: RELATED -------------------------------------------------
    // Any context_hint token matches (OR logic).
    // Surfaces conversations with partial vocabulary overlap.
    // Tier 1 results are excluded to avoid duplication.
    const relatedQuery = safeFtsQuery(context_hint, { useOr: true });
    const tier2Rows = runConvFts(db, relatedQuery, now, convLimit, tier1Ids);
    const tier2Ids = new Set(tier2Rows.map((r) => r.id));

    // --- Tier 3: ASSOCIATIVE ---------------------------------------------
    // Extract meaningful tags from Tier 1+2 results and find OTHER
    // conversations that share any of those tags.
    // This surfaces thematically connected conversations that share zero
    // vocabulary with the original context_hint - the web-of-memory layer.
    const foundSoFar = new Set([...tier1Ids, ...tier2Ids]);
    let tier3Rows = [];
    const seedTags = extractTagTerms([...tier1Rows, ...tier2Rows]);
    if (seedTags.length > 0) {
      // Build an OR query from the seed tags. Each tag is quoted for
      // exact-token matching so "change-management" doesn't match
      // "management" alone.
      const tagQuery = seedTags
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(" OR ");
      tier3Rows = runConvFts(db, tagQuery, now, convLimit, foundSoFar);
    }

    // --- Merge in tier-priority order ------------------------------------
    // Fill up to convLimit total. Tier 1 entries have first claim,
    // then Tier 2, then Tier 3. Each tier's allocation is the remainder
    // after higher tiers have claimed their slots.
    const remaining = (tier) => Math.max(0, convLimit - tier);
    const t1 = tier1Rows.slice(0, convLimit);
    const t2 = tier2Rows.slice(0, remaining(t1.length));
    const t3 = tier3Rows.slice(0, remaining(t1.length + t2.length));

    const merged = [
      ...t1.map((r) => ({ row: r, tier: "exact" })),
      ...t2.map((r) => ({ row: r, tier: "related" })),
      ...t3.map((r) => ({ row: r, tier: "associative" })),
    ];

    // --- Zero-results fallback -------------------------------------------
    // If all three tiers returned nothing (brand-new topic, empty DB),
    // fall back to recency so the caller always gets useful context.
    if (merged.length === 0) {
      const recencyRows = db.prepare(recencySql).all(now, convLimit);
      for (const row of recencyRows) {
        merged.push({ row, tier: "recency" });
      }
    }

    // --- Build context entries -------------------------------------------
    const tierCounts = { exact: 0, related: 0, associative: 0, recency: 0 };
    for (const { row, tier } of merged) {
      const entry = rowToEntry(row, { includeValue: true });
      entry.retrieval_tier = tier;
      context.conversations.push(entry);
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
      entryCount += 1;
    }
  }

  return {
    context,
    assembled_at:        now,
    entry_count:         entryCount,
    context_hint:        context_hint ?? null,
    conversations_mode:  context_hint ? "associative" : "recency",
    conversations_tiers: context_hint
      ? {
          exact:       context.conversations.filter((e) => e.retrieval_tier === "exact").length,
          related:     context.conversations.filter((e) => e.retrieval_tier === "related").length,
          associative: context.conversations.filter((e) => e.retrieval_tier === "associative").length,
          recency:     context.conversations.filter((e) => e.retrieval_tier === "recency").length,
        }
      : null,
  };
}
