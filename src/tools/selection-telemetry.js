// src/tools/selection-telemetry.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-8, TENAX-2026-10-15-01: module selection telemetry, READ-ONLY.
//
// Records, per compile, which modules the compile received and why (the tier
// that admitted each), the always_load members, the person-prior outcome and
// the time. The question this answers is whether selection behaves as
// intended, not which modules look unused: counts are a proxy for usefulness,
// not a measure of it.
//
// THE CONSTRAINT (travels with every presentation)
// ------------------------------------------------
// SELECTION_CONSTRAINT below is included in every report output, success or
// empty. No code path consumes this log to alter selection: the dispatch layer
// (tools/skill-modular.js compileSkill and its layers) does not import the
// reader, and src/tests/selection-telemetry.test.js holds that as a static
// guard. A lifecycle action on selection data (archive, demote, retire) is a
// dispatch change, which is raised with Brian as a question and never built.
//
// CLOSED VOCABULARY
// -----------------
// Every enumerated field reads from a closed set; anything outside it is
// recorded as 'other', so the vocabulary cannot drift silently.
//
// STORAGE
// -------
// Local-first and immutable: one JSON line per compile, appended (O_APPEND) to
// <ava dir>/telemetry/selection/selection-YYYY-MM.jsonl on the volume, so the
// record survives redeploys. Nothing rewrites or compacts a line. If any
// aggregate ever leaves the machine, the relay-shared-metrics consent
// architecture is the reference; that is not built here.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../utils/logger.js';

/** The constraint every presentation carries. */
export const SELECTION_CONSTRAINT = 'Low selection is not a problem. Selection counts are a proxy for usefulness, not a measure of it. No automatic action may be derived from this report, ever: archiving, demoting or retiring a module on this data is a dispatch change, raised with Brian as a question and never built.';

/** Tiers, in the precedence the record assigns them. */
export const SELECTION_TIERS = Object.freeze( [
  'always_load', 'mandatory', 'high_confidence', 'person_prior', 'lexical',
  'tag_web', 'adjacency', 'dependency', 'learned_linkage', 'self_check', 'other',
] );

/** Trigger conditions detectTriggerConditions() can report. */
export const SELECTION_CONDITIONS = Object.freeze( [
  'real_mode', 'ava_trigger', 'writing_task_named_recipient', 'creative_fiction',
  'book_reading', 'ava_self_reference', 'humour_production', 'other',
] );

/** Task classes, derived from the conditions. */
export const SELECTION_TASK_CLASSES = Object.freeze( [
  'writing', 'creative', 'reading', 'self_reference', 'humour', 'real_mode', 'general', 'other',
] );

/** Person-prior outcomes. */
export const PRIOR_OUTCOMES = Object.freeze( [
  'no_person', 'disabled', 'no_data', 'active', 'overridden', 'active_partly_cut', 'other',
] );

/** Compile paths. */
export const SELECTION_PATHS = Object.freeze( [ 'compile', 'recompile', 'other' ] );

const CONDITION_TO_TASK = Object.freeze( {
  writing_task_named_recipient: 'writing',
  creative_fiction: 'creative',
  book_reading: 'reading',
  ava_self_reference: 'self_reference',
  humour_production: 'humour',
  real_mode: 'real_mode',
  ava_trigger: 'real_mode',
} );

/**
 * Map a value onto a closed set.
 *
 * @param {unknown} value
 * @param {readonly string[]} set
 * @returns {string}
 */
export function closed( value, set ) {
  return typeof value === 'string' && set.includes( value ) ? value : 'other';
}

/**
 * Task class for a compile: the first condition with a task, else general.
 *
 * @param {string[]} conditions
 * @returns {string}
 */
export function taskClassFor( conditions ) {
  for ( const c of conditions || [] ) if ( CONDITION_TO_TASK[ c ] ) return CONDITION_TO_TASK[ c ];
  return 'general';
}

/** @param {string} avaDir @returns {string} */
export function selectionDir( avaDir ) {
  return join( avaDir, 'telemetry', 'selection' );
}

/**
 * Append one selection record. Never throws: telemetry must not cost a compile.
 *
 * @param {string} avaDir
 * @param {object} r
 * @param {'compile'|'recompile'} r.path
 * @param {string} [r.sessionId]
 * @param {string} [r.person]
 * @param {string[]} r.conditions
 * @param {Array<{ id: string, tier: string }>} r.modules
 * @param {string[]} r.alwaysLoad
 * @param {string} r.prior        A PRIOR_OUTCOMES value.
 * @param {string[]|null} [r.delta]  Recompile only: the modules the call actually
 *                                    returned (selected and not already loaded).
 * @param {Date} [r.now]
 * @returns {{ ok: boolean, record?: object, error?: string }}
 */
export function recordSelection( avaDir, { path, sessionId = null, person = null, conditions = [], modules = [], alwaysLoad = [], prior = 'no_person', delta = null, now = new Date() } ) {
  try {
    const conds = [ ...new Set( ( conditions || [] ).map( ( c ) => closed( c, SELECTION_CONDITIONS ) ) ) ];
    const record = {
      schema: 'tenax.selection/1',
      at: now.toISOString(),
      path: closed( path, SELECTION_PATHS ),
      session_id: sessionId ? String( sessionId ).slice( 0, 80 ) : null,
      person: person ? String( person ).trim().toLowerCase().slice( 0, 80 ) : null,
      task_class: closed( taskClassFor( conditions ), SELECTION_TASK_CLASSES ),
      conditions: conds,
      modules: ( modules || [] ).map( ( m ) => ( { id: String( m.id ).slice( 0, 120 ), tier: closed( m.tier, SELECTION_TIERS ) } ) ),
      always_load: ( alwaysLoad || [] ).map( ( id ) => String( id ).slice( 0, 120 ) ),
      person_prior: closed( prior, PRIOR_OUTCOMES ),
      delta: Array.isArray( delta ) ? delta.map( ( id ) => String( id ).slice( 0, 120 ) ) : null,
    };
    const dir = selectionDir( avaDir );
    mkdirSync( dir, { recursive: true } );
    const file = join( dir, `selection-${ record.at.slice( 0, 7 ) }.jsonl` );
    appendFileSync( file, JSON.stringify( record ) + '\n', { flag: 'a' } );
    return { ok: true, record };
  } catch ( err ) {
    log( 'warn', `[selection-telemetry] record not written: ${ err.message }` );
    return { ok: false, error: err.message };
  }
}

/**
 * Every record in a time window. Read-only.
 *
 * @param {string} avaDir
 * @param {{ since?: Date|null, until?: Date|null }} [w]
 * @returns {object[]}
 */
export function readSelectionRecords( avaDir, { since = null, until = null } = {} ) {
  const dir = selectionDir( avaDir );
  if ( ! existsSync( dir ) ) return [];
  const out = [];
  for ( const name of readdirSync( dir ).filter( ( n ) => /^selection-\d{4}-\d{2}\.jsonl$/.test( n ) ).sort() ) {
    for ( const line of readFileSync( join( dir, name ), 'utf8' ).split( '\n' ) ) {
      if ( ! line ) continue;
      let r;
      try { r = JSON.parse( line ); } catch { continue; }
      const t = Date.parse( r.at );
      if ( since && t < since.getTime() ) continue;
      if ( until && t > until.getTime() ) continue;
      out.push( r );
    }
  }
  return out;
}

/** Bucket start for a window. */
function bucketOf( iso, window ) {
  const d = new Date( iso );
  if ( window === 'month' ) return iso.slice( 0, 7 );
  if ( window === 'week' ) {
    const day = ( d.getUTCDay() + 6 ) % 7;
    const monday = new Date( Date.UTC( d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day ) );
    return `week of ${ monday.toISOString().slice( 0, 10 ) }`;
  }
  return iso.slice( 0, 10 );
}

/**
 * The read-only report.
 *
 * @param {string} avaDir
 * @param {object} q
 * @param {string} [q.module]
 * @param {string} [q.task_class]
 * @param {string} [q.person]
 * @param {string} [q.since]   ISO date.
 * @param {string} [q.until]   ISO date.
 * @param {'day'|'week'|'month'} [q.window]
 * @param {number} [q.limit]   How many recent compiles to list.
 * @returns {object}
 */
export function selectionReport( avaDir, q = {} ) {
  const since = q.since ? new Date( q.since ) : null;
  const until = q.until ? new Date( q.until ) : null;
  const window = [ 'day', 'week', 'month' ].includes( q.window ) ? q.window : 'day';
  const limit = Math.max( 1, Math.min( 200, Number.parseInt( q.limit, 10 ) || 20 ) );
  let rows = readSelectionRecords( avaDir, {
    since: since && ! Number.isNaN( since.getTime() ) ? since : null,
    until: until && ! Number.isNaN( until.getTime() ) ? until : null,
  } );
  if ( q.task_class ) rows = rows.filter( ( r ) => r.task_class === closed( q.task_class, SELECTION_TASK_CLASSES ) );
  if ( q.person ) rows = rows.filter( ( r ) => r.person === String( q.person ).trim().toLowerCase() );
  if ( q.module ) rows = rows.filter( ( r ) => ( r.modules || [] ).some( ( m ) => m.id === q.module ) );

  const byModule = {};
  const byWindow = {};
  for ( const r of rows ) {
    const b = bucketOf( r.at, window );
    byWindow[ b ] = ( byWindow[ b ] || 0 ) + 1;
    for ( const m of r.modules || [] ) {
      if ( q.module && m.id !== q.module ) continue;
      const e = byModule[ m.id ] || ( byModule[ m.id ] = { compiles: 0, by_tier: {} } );
      e.compiles += 1;
      e.by_tier[ m.tier ] = ( e.by_tier[ m.tier ] || 0 ) + 1;
    }
  }
  return {
    constraint: SELECTION_CONSTRAINT,
    filters: { module: q.module || null, task_class: q.task_class || null, person: q.person || null, since: q.since || null, until: q.until || null, window },
    compiles: rows.length,
    by_window: byWindow,
    by_module: byModule,
    recent: rows.slice( -limit ).reverse().map( ( r ) => ( {
      at: r.at, path: r.path, session_id: r.session_id, person: r.person, task_class: r.task_class,
      conditions: r.conditions, person_prior: r.person_prior, always_load: r.always_load, modules: r.modules,
      delta: r.delta ?? null,
    } ) ),
  };
}

export const skillSelectionReportToolDefinition = {
  name: 'skill_selection_report',
  description:
    'READ-ONLY report of module selection: for each compile, which modules the compile received and the tier that admitted each ' +
    '(always_load, mandatory, high_confidence, person_prior, lexical, tag_web, adjacency, dependency, learned_linkage, self_check), ' +
    'with distributions over time and filters by module, task class and person. It answers whether selection behaves as intended. ' +
    'Low selection is not a problem, and no automatic action may be derived from this report.',
  inputSchema: {
    type: 'object',
    properties: {
      module:     { type: 'string', description: 'Only compiles that selected this module id.' },
      task_class: { type: 'string', enum: [ ...SELECTION_TASK_CLASSES ], description: 'Only compiles of this task class.' },
      person:     { type: 'string', description: 'Only compiles for this person (as passed to skill_compile).' },
      since:      { type: 'string', description: 'ISO date or instant; inclusive.' },
      until:      { type: 'string', description: 'ISO date or instant; inclusive.' },
      window:     { type: 'string', enum: [ 'day', 'week', 'month' ], description: 'Bucket size for by_window. Default day.' },
      limit:      { type: 'number', description: 'How many recent compiles to list (1-200, default 20).' },
    },
    required: [],
  },
};

/**
 * Tool handler. Read-only.
 *
 * @param {object} args
 * @param {string} avaDir
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
export function handleSkillSelectionReport( args, avaDir ) {
  try {
    return { content: [ { type: 'text', text: JSON.stringify( selectionReport( avaDir, args || {} ), null, 2 ) } ] };
  } catch ( err ) {
    return { content: [ { type: 'text', text: JSON.stringify( { constraint: SELECTION_CONSTRAINT, error: err.message }, null, 2 ) } ], isError: true };
  }
}

export default {
  SELECTION_CONSTRAINT, SELECTION_TIERS, SELECTION_CONDITIONS, SELECTION_TASK_CLASSES, PRIOR_OUTCOMES, SELECTION_PATHS,
  closed, taskClassFor, selectionDir, recordSelection, readSelectionRecords, selectionReport,
  skillSelectionReportToolDefinition, handleSkillSelectionReport,
};
