// src/tools/module-intake.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-11, TENAX-2026-10-15-01: the module intake gate.
//
// A module is executable instruction: once registered, the compile can put it
// in front of the model on any turn its triggers match. This gate applies a
// checklist before a module is written or registered through module_write, and
// again whenever its content changes (the H-3 mutation surface), and records
// the result as an intake record attached to the module. A failed check
// refuses the write and the refusal names the check.
//
// THE CHECKLIST
// -------------
//   triggers               the derived manifest entry has keywords, phrases or a
//                          task class (or is always_load): a module nothing can
//                          dispatch is a registration mistake
//   commands_referenced    commands the body tells the reader to run (fenced
//                          shell/python blocks, "$ ..." lines, script_execute
//                          calls). Recorded. A command that stops, restarts or
//                          kills the host or platform, or wipes a volume, fails.
//   credentials_or_volumes credential NAMES and volume paths the body touches
//                          are recorded; a credential-shaped VALUE fails
//   verification_step      required when the body references commands: a
//                          heading or line that says how the result is checked
//   independence_gate      every depends_on resolves to a registered module and
//                          none is the module itself; no OTHER registered module
//                          already carries this id at a different path (the
//                          shadow-copy failure module_resolve exists to expose).
//                          The order names this gate without defining it at
//                          source; this is the build's reading, flagged in the
//                          delivery for Ava to confirm or redefine.
//
// ADVISORY LINT (H-9 shapes; warn, never block)
// ----------------------------------------------
//   incident_log_shape     the body reads as a dated incident log
//   references_sprawl      more than 15 links or references/ mentions
//   oversized_body         more than 400 lines or 32 KB
//
// WHERE RECORDS LIVE
// ------------------
//   <skill base>/ava/.ledger/intake/<module path, '/' -> '__'>.json   latest
//   <skill base>/ava/.ledger/intake.jsonl                             history
//
// The registration step (registerModuleWithIntake) refuses to write a manifest
// fragment unless the latest intake record exists, passed, and was taken over
// exactly the content being registered (sha256).
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { skillBaseDir } from '../utils/moduleLedger.js';
import { inspectCommandText } from '../utils/processGuard.js';
import { findCredentials } from '../tools-memory/memoryWriteGuard.js';
import { writeModuleFragment } from './manifest-fragments.js';

/** Checklist item names, in order. Closed. */
export const INTAKE_CHECKS = Object.freeze( [ 'triggers', 'commands_referenced', 'credentials_or_volumes', 'verification_step', 'independence_gate' ] );

/** Advisory lint names. Closed. Never refuse. */
export const INTAKE_LINTS = Object.freeze( [ 'incident_log_shape', 'references_sprawl', 'oversized_body' ] );

const LINT_MAX_LINES = 400;
const LINT_MAX_BYTES = 32 * 1024;
const LINT_MAX_REFERENCES = 15;
const LINT_INCIDENT_LINES = 5;

/** Destructive commands that fail the gate in addition to the process guard's. */
const DESTRUCTIVE_COMMAND = /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:\/(?:\s|$)|\/data\b|\/app\b|~|\$HOME|\*)|\bmkfs(?:\.\w+)?\b|\bdd\s+[^\n]*\bof=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bchmod\s+-R\s+0?777\s+\/(?:\s|$)|\bDROP\s+(?:DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b/i;

/** Credential names: environment variables and config keys that hold secrets. */
const CREDENTIAL_NAME = /\b[A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_KEY|DATABASE_URL)\b/g;

/** Volume paths. */
const VOLUME_PATH = /(?:^|[\s(`'"])(\/(?:data|mnt|var\/lib|srv|tmp)\/[\w./-]*)/g;

function sha256( text ) {
  return createHash( 'sha256' ).update( Buffer.from( String( text ), 'utf8' ) ).digest( 'hex' );
}

/** @returns {string} */
function intakeDir() { return join( skillBaseDir(), 'ava', '.ledger', 'intake' ); }
function intakeHistory() { return join( skillBaseDir(), 'ava', '.ledger', 'intake.jsonl' ); }

/**
 * File name for a module's latest intake record.
 *
 * @param {string} cleanPath  Module path relative to modules/.
 * @returns {string}
 */
export function intakeRecordPath( cleanPath ) {
  const safe = String( cleanPath ).replace( /\\/g, '/' ).replace( /[^A-Za-z0-9._/-]/g, '_' ).split( '/' ).join( '__' );
  return join( intakeDir(), `${ safe }.json` );
}

/**
 * Commands the body tells a reader to run.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function referencedCommands( content ) {
  const out = [];
  const fence = /```[ \t]*(bash|sh|shell|zsh|console|python|py|powershell|ps1|cmd|bat)?[^\n]*\n([\s\S]*?)```/gi;
  let m;
  while ( ( m = fence.exec( content ) ) !== null ) {
    const lang = ( m[ 1 ] || '' ).toLowerCase();
    if ( ! lang ) continue;
    for ( const line of m[ 2 ].split( '\n' ) ) {
      const l = line.trim();
      if ( l && ! l.startsWith( '#' ) ) out.push( l.slice( 0, 200 ) );
    }
  }
  for ( const line of String( content ).split( '\n' ) ) {
    const l = line.trim();
    if ( /^\$\s+\S/.test( l ) ) out.push( l.slice( 2 ).trim().slice( 0, 200 ) );
    const se = /\bscript_execute\b[^\n]*?["']([\w./-]+\.py)["']/.exec( l );
    if ( se ) out.push( `script_execute ${ se[ 1 ] }` );
  }
  return [ ...new Set( out ) ];
}

/**
 * Does the body say how its result is verified?
 *
 * @param {string} content
 * @returns {boolean}
 */
export function hasVerificationStep( content ) {
  return /^#{1,6}\s+[^\n]*\bverif(?:y|ication|ied)\b/im.test( content )
    || /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?(?:verify|verification|check that|confirm that|acceptance)\b/im.test( content );
}

/**
 * Run the advisory lints. Never refuses.
 *
 * @param {string} content
 * @returns {Array<{ name: string, detail: string }>}
 */
export function intakeLints( content ) {
  const warnings = [];
  const lines = String( content ).split( '\n' );
  const dated = lines.filter( ( l ) => /^\s*(?:[-*]\s*)?(?:\*\*)?\d{4}-\d{2}-\d{2}\b/.test( l ) ).length;
  const incidentHeads = lines.filter( ( l ) => /^#{1,6}\s+.*\bincident\b/i.test( l ) ).length;
  if ( dated >= LINT_INCIDENT_LINES || incidentHeads >= 2 ) {
    warnings.push( { name: 'incident_log_shape', detail: `${ dated } dated lines and ${ incidentHeads } incident headings: a module should carry the lesson, not the log (H-9)` } );
  }
  const refs = ( String( content ).match( /https?:\/\/\S+|\breferences\/[\w./-]+/g ) || [] ).length;
  if ( refs > LINT_MAX_REFERENCES ) warnings.push( { name: 'references_sprawl', detail: `${ refs } links or references/ mentions (advisory ceiling ${ LINT_MAX_REFERENCES })` } );
  const bytes = Buffer.byteLength( String( content ), 'utf8' );
  if ( lines.length > LINT_MAX_LINES || bytes > LINT_MAX_BYTES ) {
    warnings.push( { name: 'oversized_body', detail: `${ lines.length } lines, ${ bytes } bytes (advisory ceiling ${ LINT_MAX_LINES } lines or ${ LINT_MAX_BYTES } bytes); every compile that selects it pays for all of it` } );
  }
  return warnings;
}

/**
 * Run the intake checklist.
 *
 * @param {object} o
 * @param {string} o.cleanPath           Module path relative to modules/.
 * @param {string} o.content
 * @param {object|null} o.entry          Derived manifest entry (null for a data file).
 * @param {object} o.manifest            The merged manifest, for dependency and shadow checks.
 * @param {boolean} o.isNew
 * @param {string} o.actor
 * @returns {object} The intake record.
 */
export function runIntake( { cleanPath, content, entry, manifest, isNew, actor } ) {
  const checks = [];
  const registered = Array.isArray( manifest && manifest.modules ) ? manifest.modules : [];
  const isMarkdown = /\.md$/i.test( cleanPath );

  // 1. triggers
  if ( ! isMarkdown || ! entry ) {
    checks.push( { name: 'triggers', status: 'not_applicable', detail: 'data file; not registered as a dispatchable module' } );
  } else {
    const t = entry.triggers || {};
    const n = ( t.keywords || [] ).length + ( t.phrases || [] ).length + ( t.task_class || [] ).length;
    if ( n > 0 || entry.always_load ) checks.push( { name: 'triggers', status: 'pass', detail: entry.always_load ? 'always_load' : `${ n } trigger terms` } );
    else checks.push( { name: 'triggers', status: 'fail', detail: 'no keywords, phrases or task_class, and not always_load: nothing could dispatch this module' } );
  }

  // 2. commands referenced
  const commands = referencedCommands( content );
  const dangerous = [];
  for ( const c of commands ) {
    const pg = inspectCommandText( c );
    if ( pg ) dangerous.push( `${ c.slice( 0, 80 ) } (${ pg.reason })` );
    else if ( DESTRUCTIVE_COMMAND.test( c ) ) dangerous.push( `${ c.slice( 0, 80 ) } (destructive: wipes a volume, a filesystem or a database)` );
  }
  checks.push( dangerous.length
    ? { name: 'commands_referenced', status: 'fail', detail: `refused command(s): ${ dangerous.join( '; ' ) }`, commands }
    : { name: 'commands_referenced', status: 'pass', detail: commands.length ? `${ commands.length } command(s) referenced` : 'none', commands } );

  // 3. credentials or volumes
  const credValues = findCredentials( content );
  const credNames = [ ...new Set( String( content ).match( CREDENTIAL_NAME ) || [] ) ];
  const volumes = [];
  let vm;
  VOLUME_PATH.lastIndex = 0;
  while ( ( vm = VOLUME_PATH.exec( content ) ) !== null ) volumes.push( vm[ 1 ] );
  checks.push( credValues.length
    ? { name: 'credentials_or_volumes', status: 'fail', detail: `credential-shaped value(s) in the body: ${ credValues.map( ( c ) => `${ c.kind } x${ c.count }` ).join( ', ' ) }. Reference the variable by name instead.`, credential_names: credNames, volumes: [ ...new Set( volumes ) ] }
    : { name: 'credentials_or_volumes', status: 'pass', detail: `${ credNames.length } credential name(s), ${ new Set( volumes ).size } volume path(s) referenced`, credential_names: credNames, volumes: [ ...new Set( volumes ) ] } );

  // 4. verification step
  if ( ! commands.length ) checks.push( { name: 'verification_step', status: 'not_applicable', detail: 'no commands referenced' } );
  else if ( hasVerificationStep( content ) ) checks.push( { name: 'verification_step', status: 'pass', detail: 'a verification heading or step is present' } );
  else checks.push( { name: 'verification_step', status: 'fail', detail: 'the module references commands but says nowhere how the result is verified (add a "Verification" heading or a "Verify ..." step)' } );

  // 5. independence gate
  if ( ! isMarkdown || ! entry ) {
    checks.push( { name: 'independence_gate', status: 'not_applicable', detail: 'data file' } );
  } else {
    const ids = new Set( registered.map( ( m ) => m && m.id ).filter( Boolean ) );
    const deps = Array.isArray( entry.depends_on ) ? entry.depends_on : [];
    const unresolved = deps.filter( ( d ) => d !== entry.id && ! ids.has( d ) );
    const selfDep = deps.includes( entry.id );
    const shadow = registered.find( ( m ) => m && m.id === entry.id && m.path && entry.path && m.path !== entry.path );
    const problems = [];
    if ( selfDep ) problems.push( 'the module depends on itself' );
    if ( unresolved.length ) problems.push( `depends_on does not resolve: ${ unresolved.join( ', ' ) }` );
    if ( shadow ) problems.push( `id "${ entry.id }" is already registered at ${ shadow.path }; this would shadow it` );
    checks.push( problems.length
      ? { name: 'independence_gate', status: 'fail', detail: problems.join( '; ' ) }
      : { name: 'independence_gate', status: 'pass', detail: deps.length ? `${ deps.length } dependency(ies) resolve` : 'no dependencies; no shadowed id' } );
  }

  const failed = checks.filter( ( c ) => c.status === 'fail' ).map( ( c ) => c.name );
  return {
    schema: 'tenax.module-intake/1',
    module_path: `modules/${ cleanPath }`,
    module_id: entry ? entry.id : null,
    content_sha256: sha256( content ),
    at: new Date().toISOString(),
    actor: String( actor || 'unknown' ).slice( 0, 120 ),
    is_new: Boolean( isNew ),
    checks,
    lint_warnings: intakeLints( content ),
    passed: failed.length === 0,
    failed,
  };
}

/**
 * Persist an intake record. Every record, passed or failed, is appended to the
 * history. The per-module "latest" file is the record attached to the module,
 * so it describes content that was actually accepted: a passing record always
 * replaces it, and a failing record is written there only when the module has
 * no record yet (a refused create). A refused edit to an established module
 * therefore never displaces the record of the content still on disk.
 *
 * @param {string} cleanPath
 * @param {object} record
 * @returns {{ ok: boolean, path?: string, latest_updated?: boolean, error?: string }}
 */
export function writeIntakeRecord( cleanPath, record ) {
  try {
    const path = intakeRecordPath( cleanPath );
    mkdirSync( intakeDir(), { recursive: true } );
    appendFileSync( intakeHistory(), JSON.stringify( record ) + '\n', { flag: 'a' } );
    const updateLatest = Boolean( record && record.passed ) || ! existsSync( path );
    if ( updateLatest ) writeFileSync( path, JSON.stringify( record, null, 2 ) + '\n', 'utf8' );
    return { ok: true, path, latest_updated: updateLatest };
  } catch ( err ) {
    return { ok: false, error: err.message };
  }
}

/**
 * Intake history for a module, newest first.
 *
 * @param {string} cleanPath
 * @param {number} [limit=20]
 * @returns {object[]}
 */
export function readIntakeHistory( cleanPath, limit = 20 ) {
  const p = intakeHistory();
  if ( ! existsSync( p ) ) return [];
  const want = `modules/${ String( cleanPath ).replace( /\\/g, '/' ) }`;
  const out = [];
  for ( const line of readFileSync( p, 'utf8' ).split( '\n' ) ) {
    if ( ! line.trim() ) continue;
    try {
      const r = JSON.parse( line );
      if ( r && r.module_path === want ) out.push( r );
    } catch { /* a torn line is skipped, not fatal */ }
  }
  return out.reverse().slice( 0, Math.max( 1, Math.min( 200, Number( limit ) || 20 ) ) );
}

/**
 * The latest intake record for a module, or null.
 *
 * @param {string} cleanPath
 * @returns {object|null}
 */
export function readIntakeRecord( cleanPath ) {
  const p = intakeRecordPath( cleanPath );
  if ( ! existsSync( p ) ) return null;
  try { return JSON.parse( readFileSync( p, 'utf8' ) ); } catch { return null; }
}

/**
 * Register a module's manifest fragment, but only on a passing intake record
 * taken over exactly this content. This is the C-INTAKE-RECORD gate: no
 * registration without an intake record.
 *
 * @param {object} o
 * @param {string} o.avaDir
 * @param {string} o.cleanPath
 * @param {string} o.content
 * @param {object} o.entry
 * @param {object|null} [o.dispatchRule]
 * @returns {{ ok: true, fragment: object } | { ok: false, code: string, reason: string }}
 */
export function registerModuleWithIntake( { avaDir, cleanPath, content, entry, dispatchRule = null } ) {
  const record = readIntakeRecord( cleanPath );
  if ( ! record ) {
    return { ok: false, code: 'intake_record_missing', reason: `No intake record for modules/${ cleanPath }; a module is not registered without one.` };
  }
  if ( record.content_sha256 !== sha256( content ) ) {
    return { ok: false, code: 'intake_record_stale', reason: `The intake record for modules/${ cleanPath } was taken over different content; re-run the intake before registering.` };
  }
  if ( ! record.passed ) {
    return { ok: false, code: 'intake_failed', reason: `The intake record for modules/${ cleanPath } failed: ${ ( record.failed || [] ).join( ', ' ) }.` };
  }
  return { ok: true, fragment: writeModuleFragment( avaDir, entry, dispatchRule ) };
}

export default {
  INTAKE_CHECKS, INTAKE_LINTS, intakeRecordPath, referencedCommands, hasVerificationStep, intakeLints,
  runIntake, writeIntakeRecord, readIntakeRecord, readIntakeHistory, registerModuleWithIntake,
};
