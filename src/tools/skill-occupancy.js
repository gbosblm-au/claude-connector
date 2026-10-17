// src/tools/skill-occupancy.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-7, TENAX-2026-10-15-01: compile occupancy reporting and body-size listing.
//
// THE CAP, AND WHERE IT IS DOCUMENTED
// -----------------------------------
// The compile has two budgets and this file is where both are written down:
//
//   1. The LINE budget compileSkill enforces (layer5Budget): MANIFEST.json
//      budget.max_compiled_lines (default 750) of which budget.core_reserve_lines
//      (default 250) are reserved for CORE. This is the only budget the
//      dispatcher acts on, and it acts by demoting whole modules.
//
//   2. The TOKEN cap: MANIFEST.json budget.max_compiled_tokens when the
//      manifest carries it, otherwise COMPILE_TOKEN_CAP_DEFAULT = 40,000. The
//      work order describes a 40,000-token cap "documented in one line and
//      measured nowhere"; that line was not found in the connector, gateway or
//      client source (the volume's CORE.md / MANIFEST.json are not in the
//      artefacts), so the default is taken from the order and the response
//      says which source supplied the number. Nothing enforces it: it is
//      measured and reported, which is the order's correction (the gap is
//      instrumentation, not headroom).
//
// COUNTING METHOD
// ---------------
// Counted at assembly, labelled as such: every part concatenated into the
// compile (CORE, PERSONALITY, each module, the self-check) is measured as it is
// read, in characters, lines and estimated tokens (ceil(chars / 4)). This is an
// assembly estimate, not a provider count. The live-context figure (what the
// model actually received) is the provider's own count, which the gateway
// already records per model call (token_usage, logTokenUsage); the gateway logs
// this compile figure beside it where the compile result lands.
//
// TRUNCATION POLICY (written next to the cap; the behaviour matches it)
// ----------------------------------------------------------------------
// The compile never cuts text. When the line budget is exceeded, whole modules
// are demoted in the dispatcher's own order, and every demoted module is named
// in occupancy.truncation.demoted with a visible marker line. When the
// assembled body exceeds the token cap, the body is still returned whole and
// occupancy.over_cap is true with a marker naming the overrun. There is no
// silent loss at either budget.
// ---------------------------------------------------------------------------

/** The token cap when the manifest does not carry one. */
export const COMPILE_TOKEN_CAP_DEFAULT = 40000;

/** The method label every occupancy figure carries. */
export const OCCUPANCY_METHOD = 'assembly_estimate: ceil(chars / 4) per assembled part, summed; counted as the compile read each part, not a provider count';

/** The written policy, returned with every occupancy object. */
export const TRUNCATION_POLICY = 'The compile never cuts text. Over the line budget, whole modules are demoted and named in truncation.demoted; over the token cap, the body is returned whole and over_cap is true. No silent loss.';

/**
 * Size one assembled part.
 *
 * @param {string} id
 * @param {'core'|'personality'|'module'|'self_check'} role
 * @param {string} text   The exact text appended to the compile.
 * @param {string|null} [path]
 * @returns {{ id: string, role: string, path: string|null, chars: number, lines: number, tokens_est: number }}
 */
export function measurePart( id, role, text, path = null ) {
  const t = String( text ?? '' );
  return {
    id,
    role,
    path,
    chars: t.length,
    lines: t ? t.split( '\n' ).length : 0,
    tokens_est: Math.ceil( t.length / 4 ),
  };
}

/**
 * The token cap in force and where it came from.
 *
 * @param {object} manifest   The merged manifest.
 * @returns {{ cap: number, source: string }}
 */
export function compileTokenCap( manifest ) {
  const raw = manifest && manifest.budget ? Number( manifest.budget.max_compiled_tokens ) : NaN;
  if ( Number.isFinite( raw ) && raw > 0 ) return { cap: Math.floor( raw ), source: 'MANIFEST.json budget.max_compiled_tokens' };
  return { cap: COMPILE_TOKEN_CAP_DEFAULT, source: 'default (40,000 per TENAX-2026-10-15-01 H-7; no budget.max_compiled_tokens in the manifest)' };
}

/**
 * Build the occupancy report for one compile.
 *
 * @param {object} o
 * @param {Array<ReturnType<typeof measurePart>>} o.parts   Every assembled part, in order.
 * @param {{ cap: number, source: string }} o.tokenCap
 * @param {{ max_lines: number, core_reserve_lines: number }} o.lineBudget
 * @param {number} o.lineCount     Lines in the returned body.
 * @param {string[]} [o.demoted]   Modules demoted by the line budget.
 * @param {string[]} [o.filtered]  Modules removed by the access-level filter.
 * @param {'compile'|'recompile'} o.path
 * @returns {object}
 */
export function buildOccupancy( { parts, tokenCap, lineBudget, lineCount, demoted = [], filtered = [], path } ) {
  const tokensUsed = parts.reduce( ( n, p ) => n + p.tokens_est, 0 );
  const overCap = tokensUsed > tokenCap.cap;
  const markers = [];
  if ( demoted.length ) markers.push( `[compile] ${ demoted.length } module(s) demoted by the line budget (${ lineBudget.max_lines } lines): ${ demoted.join( ', ' ) }` );
  if ( overCap ) markers.push( `[compile] ${ tokensUsed } estimated tokens exceeds the ${ tokenCap.cap }-token cap by ${ tokensUsed - tokenCap.cap }; returned whole, not truncated` );
  return {
    path,
    tokens_used: tokensUsed,
    cap: tokenCap.cap,
    cap_source: tokenCap.source,
    pct_of_cap: tokenCap.cap ? Math.round( ( tokensUsed / tokenCap.cap ) * 1000 ) / 10 : null,
    over_cap: overCap,
    method: OCCUPANCY_METHOD,
    line_budget: {
      max_lines: lineBudget.max_lines,
      core_reserve_lines: lineBudget.core_reserve_lines,
      lines_returned: lineCount,
    },
    modules: [ ...parts ].sort( ( a, b ) => b.tokens_est - a.tokens_est || a.id.localeCompare( b.id ) ),
    truncation: {
      policy: TRUNCATION_POLICY,
      text_truncated: false,
      demoted: [ ...demoted ],
      filtered_by_access: [ ...filtered ],
      markers,
    },
  };
}

export default { COMPILE_TOKEN_CAP_DEFAULT, OCCUPANCY_METHOD, TRUNCATION_POLICY, measurePart, compileTokenCap, buildOccupancy };
