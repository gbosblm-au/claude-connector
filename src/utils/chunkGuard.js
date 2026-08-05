// src/utils/chunkGuard.js  v1.0.0
// ---------------------------------------------------------------------------
// Automated large-build hard-block rule.
//
// Implements SPEC-TNX-150BLOCK-2026-08-05.
//
// ── What this enforces ─────────────────────────────────────────────────────
//
// Any single interactive write -- script_write, reference_write, module_write
// -- whose content exceeds CHUNK_LIMIT_LINES (default 150) is BLOCKED. It must
// be decomposed into data modules of at most 150 lines each plus a thin
// builder, and only then written.
//
// ── Why the block is here and not in the client ────────────────────────────
//
// The rule already existed in the Build Robustness Protocol as advice, and
// advice depends on the author remembering to follow it. Large single writes of
// 300 to 900 lines repeatedly exceeded assistant output limits, dropping out
// mid-write and truncating or losing the deliverable. Worse, the failure was
// silent: it surfaced later, when a dependent step failed on a file that was
// never fully written.
//
// Enforcing at the connector guarantees the rule holds regardless of which
// client is calling, and converts a silent late failure into a loud immediate
// one carrying the information needed to fix it.
//
// ── Where the block sits, and one thing it must NOT touch ──────────────────
//
// The check is applied in the interactive tool HANDLERS -- handleScriptWrite,
// handleReferenceWrite, handleModuleWrite -- and deliberately NOT in
// writeContentFile().
//
// That distinction matters. writeContentFile is also the write path used by
// handleScriptRestoreFromWp and the sibling restore handlers behind the
// /restore-* endpoints. Putting the block there would cause every snapshot
// restore containing a file over 150 lines to fail, which is precisely the
// kind of regression that broke connector snapshot push in v12.28.0. Restore
// is a bulk recovery operation, not an interactive authoring session, and the
// spec exempts it by scoping the rule to the three interactive tools.
//
// Also exempt per the spec: archive_write (long-form records), memory_write
// (structured KV), skill_write_addition (append-only), and script_execute,
// which may run an arbitrarily large script that is already on disk.
// ---------------------------------------------------------------------------

/**
 * Parse a boolean environment variable.
 *
 * The spec is explicit that enforcement is disabled ONLY when a CHUNK_ENFORCE_*
 * value is explicitly false, so anything unset or unrecognised means enabled.
 * A typo must fail safe toward enforcement, not away from it.
 *
 * @param {string|undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function envBool( value, fallback ) {
  if ( value === undefined || value === null || value === '' ) return fallback;
  const v = String( value ).trim().toLowerCase();
  if ( v === 'false' || v === '0' || v === 'no' || v === 'off' ) return false;
  return true;
}

/**
 * Current configuration.
 *
 * Read on every call rather than cached at module load so a deployment can
 * change enforcement without a code change, and so tests can vary it.
 *
 * @returns {{ limit: number, scripts: boolean, refs: boolean, modules: boolean,
 *             exemptArchive: boolean, suggest: boolean }}
 */
export function chunkConfig() {
  const parsedLimit = parseInt( process.env.CHUNK_LIMIT_LINES || '150', 10 );

  return {
    // A non-numeric or absurd override falls back to the specified default
    // rather than disabling the block through a configuration mistake.
    limit:         Number.isInteger( parsedLimit ) && parsedLimit > 0 ? parsedLimit : 150,
    scripts:       envBool( process.env.CHUNK_ENFORCE_SCRIPTS, true ),
    refs:          envBool( process.env.CHUNK_ENFORCE_REFS,    true ),
    modules:       envBool( process.env.CHUNK_ENFORCE_MODULES, true ),
    exemptArchive: envBool( process.env.CHUNK_EXEMPT_ARCHIVE,  true ),
    suggest:       envBool( process.env.CHUNK_SUGGEST_SPLIT,   true ),
  };
}

/**
 * Count lines in a payload.
 *
 * Per spec section 5.2: split on newline; a trailing newline does not add a
 * line. So "a\nb" and "a\nb\n" are both two lines, which matches what an editor
 * reports and what a developer will see when they open the file to check.
 *
 * @param {string} content
 * @returns {number}
 */
export function countLines( content ) {
  if ( typeof content !== 'string' || content.length === 0 ) return 0;
  const normalised = content.replace( /\r\n/g, '\n' );
  const withoutTrailing = normalised.endsWith( '\n' )
    ? normalised.slice( 0, -1 )
    : normalised;
  return withoutTrailing.split( '\n' ).length;
}

/**
 * Build a proposed decomposition.
 *
 * Parts are split on line boundaries, never mid-line, and each part is at or
 * below the limit. Naming follows the DATA_PART_NAMING convention from spec
 * section 7: <base>_part<NN><ext>.
 *
 * The split is returned as a suggestion, not applied. The caller may have a
 * better decomposition -- a natural boundary between logical sections is
 * usually preferable to an even one -- and the spec says the caller may
 * substitute its own.
 *
 * @param {string} filename Target filename, used to derive part names.
 * @param {number} lineCount
 * @param {number} limit
 * @returns {{ parts: number, part_files: string[], lines_per_part: number, builder: string }}
 */
export function suggestDecomposition( filename, lineCount, limit ) {
  const name = String( filename || 'module' );
  const dot  = name.lastIndexOf( '.' );
  const base = dot > 0 ? name.slice( 0, dot ) : name;
  const ext  = dot > 0 ? name.slice( dot )    : '';

  const parts = Math.max( 2, Math.ceil( lineCount / limit ) );
  const perPart = Math.ceil( lineCount / parts );

  const partFiles = [];
  for ( let i = 1; i <= parts; i += 1 ) {
    partFiles.push( `${ base }_part${ String( i ).padStart( 2, '0' ) }${ ext }` );
  }

  return {
    parts,
    part_files:     partFiles,
    lines_per_part: perPart,
    // The thin builder is the second half of the pattern that actually worked:
    // small data modules plus something that assembles them.
    builder:        `${ base }_build${ ext }`,
  };
}

/**
 * Rejection payload for an oversized write.
 *
 * Per spec section 5.3 this is returned as a normal tool error, never a crash,
 * and carries the target file, the line count, the limit and a suggested split
 * so the caller has everything needed to fix it without a second round trip.
 *
 * @param {string} tool
 * @param {string} filename
 * @param {number} lineCount
 * @param {object} cfg
 * @returns {object}
 */
function buildRejection( tool, filename, lineCount, cfg ) {
  /** @type {Record<string, unknown>} */
  const body = {
    error:      'chunk_limit_exceeded',
    code:       'CHUNK_LIMIT_EXCEEDED',
    tool,
    target:     filename,
    line_count: lineCount,
    limit:      cfg.limit,
    // Deterministic, not transient. Spec section 9: this must not be retried
    // with identical arguments; the caller must decompose and re-issue.
    retryable:  false,
    message:
      `Refusing to write ${ filename }: ${ lineCount } lines exceeds the ` +
      `${ cfg.limit }-line limit for a single ${ tool }. Decompose it into data ` +
      'modules of at most ' + cfg.limit + ' lines each plus a thin builder, write ' +
      'each part separately, then verify each landed before running the builder.',
  };

  if ( cfg.suggest ) {
    body.suggested_decomposition = suggestDecomposition( filename, lineCount, cfg.limit );
  }

  return body;
}

/** Rejection counters, exposed for the metrics surface (spec section 12). */
export const chunkStats = {
  checked: 0,
  rejected: 0,
  byTool: { script_write: 0, reference_write: 0, module_write: 0 },
};

/**
 * Evaluate a write against the hard-block rule.
 *
 * @param {object} args
 * @param {'script_write'|'reference_write'|'module_write'} args.tool
 * @param {string} args.filename Target path, for the error and the part names.
 * @param {string} args.content  The exact payload about to be written.
 * @param {Function} [args.log]  Logger, signature (level, message).
 * @returns {{ allowed: true } | { allowed: false, rejection: object }}
 */
export function checkChunkLimit( { tool, filename, content, log } ) {
  const cfg = chunkConfig();
  chunkStats.checked += 1;

  const enforced =
    ( tool === 'script_write'    && cfg.scripts ) ||
    ( tool === 'reference_write' && cfg.refs    ) ||
    ( tool === 'module_write'    && cfg.modules );

  if ( ! enforced ) return { allowed: true };

  // The estimate must be computed on the exact payload prior to any write
  // (spec 5.2). Not on a normalised, trimmed or re-serialised copy, or the
  // number reported to the caller would not match the file they inspect.
  const lineCount = countLines( content );

  // Strictly greater than. Exactly at the limit is permitted (spec 5.2).
  if ( lineCount <= cfg.limit ) return { allowed: true };

  chunkStats.rejected += 1;
  if ( chunkStats.byTool[ tool ] !== undefined ) chunkStats.byTool[ tool ] += 1;

  // Spec section 12: log every rejection with target and line count for
  // auditing. This is also the signal that tells an operator whether the limit
  // is set sensibly for how the platform is actually used.
  if ( typeof log === 'function' ) {
    log( 'warn', `chunk-guard: BLOCKED ${ tool } ${ filename } -- ${ lineCount } lines ` +
                 `exceeds limit ${ cfg.limit }` );
  }

  return { allowed: false, rejection: buildRejection( tool, filename, lineCount, cfg ) };
}

export default { checkChunkLimit, countLines, suggestDecomposition, chunkConfig, chunkStats };
