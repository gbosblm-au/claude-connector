// src/tools/hermes-admin-tools.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// TENAX-2026-10-15-01: the readable and operable surfaces for H-2 and H-3.
//
//   store_discipline   declare / release / list store claims, list forensic
//                      captures, and detach-and-rebuild a derived index (H-2).
//                      A write tool: it is in SYSTEM_WRITE_TOOLS, so a
//                      non-owner tenant never sees it.
//   module_ledger      the last N mutations of a module or skill file, with
//                      before/after sha256, actor and reason, the chain check,
//                      and the module's latest intake record (H-3, H-11).
//                      Read-only.
//
// skill_selection_report (H-8) lives with its data in selection-telemetry.js.
// ---------------------------------------------------------------------------

import {
  CONNECTOR_STORE_FAMILIES,
  declareClaim,
  releaseClaim,
  listClaims,
  listForensics,
  MAX_CLAIM_TTL_MS,
} from '../utils/storeWriteDiscipline.js';
import { DERIVED_INDEXES, detachAndRebuild } from '../utils/derivedIndexes.js';
import { readLedgerFor, verifyLedgerChain, normaliseLedgerQuery } from '../utils/moduleLedger.js';
import { readIntakeRecord } from './module-intake.js';

export const storeDisciplineToolDefinition = {
  name: 'store_discipline',
  description:
    'Store-write discipline (operator tool). declare: claim a store family (references, modules, archive, scripts) before rewriting it; ' +
    'while the claim is active every write by anyone else is refused, names you as the holder, and is captured to forensics. ' +
    'release: release your claim by claim_id. list: active claims and recent forensic captures. ' +
    'forensics: recent captures, each with a manifest. rebuild_derived: detach a derived index (brain_tools_catalog, merged_manifest) and rebuild it, proving no canonical file changed.',
  inputSchema: {
    type: 'object',
    properties: {
      action:      { type: 'string', enum: [ 'declare', 'release', 'list', 'forensics', 'rebuild_derived' ], description: 'What to do.' },
      family:      { type: 'string', enum: [ ...CONNECTOR_STORE_FAMILIES ], description: 'Store family, for declare and release.' },
      purpose:     { type: 'string', description: 'Why the store is claimed (declare). Required: the purpose is shown to every writer the claim refuses.' },
      label:       { type: 'string', description: 'Who holds it (declare), e.g. "brian". Default "operator".' },
      ttl_minutes: { type: 'number', description: `How long the claim lasts (declare). Default 15, max ${ MAX_CLAIM_TTL_MS / 60000 }.` },
      claim_id:    { type: 'string', description: 'The claim to release (release).' },
      id:          { type: 'string', enum: DERIVED_INDEXES.map( ( d ) => d.id ), description: 'Derived index to rebuild (rebuild_derived).' },
      limit:       { type: 'number', description: 'How many forensic captures to list (default 20).' },
    },
    required: [ 'action' ],
  },
};

export const moduleLedgerToolDefinition = {
  name: 'module_ledger',
  description:
    'READ-ONLY audit ledger for skill files: the last N mutations of a module (or SKILL.md, PERSONALITY.md, DISPATCH_RULES.json, a manifest fragment), ' +
    'each with before/after sha256, actor, reason (the change_note), tool and time, plus the ledger chain check and the module\'s latest intake record. ' +
    'Accepts "meta/x.md", "modules/meta/x.md" or "ava/modules/meta/x.md".',
  inputSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', description: 'Module path (any accepted spelling) or skill file name.' },
      limit:  { type: 'number', description: 'How many mutations to return, newest first (1-200, default 10).' },
    },
    required: [ 'module' ],
  },
};

const asText = ( payload, isError = false ) => ( {
  content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ],
  ...( isError ? { isError: true } : {} ),
} );

/**
 * store_discipline handler.
 *
 * @param {object} args
 * @param {object} [deps]
 * @param {Record<string, () => unknown>} [deps.rebuilders]  Rebuild functions by derived-index id,
 *        supplied by the server, which owns the live tool registry the catalogue is built from.
 * @returns {object}
 */
export function handleStoreDiscipline( args = {}, { rebuilders = {} } = {} ) {
  const action = String( args.action || '' );
  switch ( action ) {
    case 'declare': {
      const ttl = Number.isFinite( Number( args.ttl_minutes ) ) && Number( args.ttl_minutes ) > 0 ? Number( args.ttl_minutes ) * 60000 : undefined;
      const r = declareClaim( args.family, { kind: 'operator', label: args.label || 'operator', purpose: args.purpose || '', ttlMs: ttl } );
      return r.ok ? asText( { declared: true, claim: r.claim, note: 'Pass this claim_id to archive_write, reference_write, script_write or module_write to write the claimed store; release it when done.' } ) : asText( r, true );
    }
    case 'release': {
      const r = releaseClaim( args.family, String( args.claim_id || '' ) );
      return r.ok ? asText( { released: true, ...r } ) : asText( r, true );
    }
    case 'list':
      return asText( { claims: listClaims(), forensics: listForensics( 10 ) } );
    case 'forensics':
      return asText( { forensics: listForensics( Number.parseInt( args.limit, 10 ) || 20 ) } );
    case 'rebuild_derived': {
      const id = String( args.id || '' );
      const rebuild = rebuilders[ id ];
      if ( typeof rebuild !== 'function' ) {
        return asText( { ok: false, code: 'no_rebuilder', message: `No rebuild function is wired for "${ id }". Declared derived indexes: ${ DERIVED_INDEXES.map( ( d ) => d.id ).join( ', ' ) }.` }, true );
      }
      const r = detachAndRebuild( { id, rebuild } );
      return asText( r, ! r.ok );
    }
    default:
      return asText( { ok: false, code: 'unknown_action', message: 'action must be one of declare, release, list, forensics, rebuild_derived.' }, true );
  }
}

/**
 * module_ledger handler. Read-only.
 *
 * @param {object} args
 * @returns {object}
 */
export function handleModuleLedger( args = {} ) {
  const query = String( args.module || '' ).trim();
  if ( ! query ) return asText( { ok: false, code: 'module_required', message: 'module is required.' }, true );
  const limit = Math.max( 1, Math.min( 200, Number.parseInt( args.limit, 10 ) || 10 ) );
  const name = normaliseLedgerQuery( query );
  const entries = readLedgerFor( query, limit );
  const modulePath = name.startsWith( 'ava/modules/' ) ? name.slice( 'ava/modules/'.length ) : null;
  return asText( {
    module: name,
    mutations: entries.map( ( e ) => ( {
      at: e.at, action: e.action, kind: e.kind, actor: e.actor, reason: e.reason, tool: e.tool,
      before_sha256: e.before_sha256, after_sha256: e.after_sha256, bytes_before: e.bytes_before, bytes_after: e.bytes_after,
      extra: e.extra,
    } ) ),
    count: entries.length,
    chain: verifyLedgerChain(),
    intake: modulePath ? readIntakeRecord( modulePath ) : null,
  } );
}

export default { storeDisciplineToolDefinition, moduleLedgerToolDefinition, handleStoreDiscipline, handleModuleLedger };
