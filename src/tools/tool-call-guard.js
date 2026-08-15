/**
 * src/tools/tool-call-guard.js  --  CONN-GUARD-001
 *                                   (claude-connector v12.43.0)
 *
 * The mechanical enforcement layer of the Tool-Call Integrity Protocol. Sits
 * at the connector boundary, between the model's tool-call emission and the
 * renderer dispatch, and refuses an empty or under-specified structured-payload
 * call before the renderer does any work (§3.1).
 *
 * ── The failure being prevented (§2) ───────────────────────────────────────
 *
 * Observed 2026-08-15: document_render was called TWICE without its spec
 * payload. The renderer never received a body, and the model -- getting back
 * something that read as a tool failure rather than as a correctable mistake --
 * abandoned the tool and pivoted to a script fallback.
 *
 * There are two links in that chain and the guard breaks the first: an empty
 * call must not be accepted at the boundary. But breaking the first link is
 * only useful if the rejection makes the SECOND link avoidable, which is why
 * §3.3 insists the rejection is "a demand for a corrected re-fire" rather than
 * a generic error. A model told "invalid spec" pivots. A model told "the spec
 * payload was missing entirely; re-fire with spec containing title and a
 * non-empty sections array" retries correctly.
 *
 * ── Why this is not simply the existing pre-check ──────────────────────────
 *
 * render-tools.js already carries a pre-check that runs before dispatch and
 * applies the same two shared rules. That is real overlap and it would be
 * dishonest to present this as filling an empty space. What the pre-check does
 * NOT do, and what this adds:
 *
 *   - It cannot distinguish "no spec was attached" from "the spec is missing a
 *     title". Both come back as `invalid_spec` with a field message, which is
 *     misleading advice for the observed failure: the model reads it as a
 *     field problem and adds a title to a body it never sent.
 *   - Its rejection is an error, not a retry directive. Nothing in it tells
 *     the model that re-firing is the expected next move.
 *   - It has no telemetry. §3.4 wants a measurable rejection rate per model,
 *     which is the evidence base for the routing lockdown; console.error with
 *     no model id gives no such thing.
 *   - Its per-tool validator is passed in by each handler, so a new renderer
 *     inherits nothing automatically. §3.1 requires the guard be
 *     renderer-class-wide.
 *
 * The pre-check is left in place as the second layer §3.1 describes, and the
 * renderer's own validate_spec remains the third. Nothing is removed: a guard
 * that replaced a working check with a new one would be trading a known
 * quantity for an unknown.
 */

'use strict';

import {
  validateAgainstSchema, isGuardedTool, getRenderSchema, isPlainObject,
  isNonEmptyString, registeredRenderTools,
} from './render-schemas.js';

/**
 * Guard rejection telemetry (§3.4).
 *
 * In-memory and per-process, deliberately. A rejection rate is only meaningful
 * over a window, and the connector restarts often enough that persisting it
 * would need a schema, a migration and a retention policy for a number whose
 * whole purpose is to be read as a trend. The log line carries every field, so
 * the durable record is the log aggregator's, where it belongs.
 */
const TELEMETRY = {
  total_calls: 0,
  rejections: 0,
  by_tool: Object.create( null ),
  by_reason: Object.create( null ),
  by_model: Object.create( null ),
};

/** @param {object} bucket @param {string} key */
function bump( bucket, key ) {
  if ( ! key ) return;
  bucket[ key ] = ( bucket[ key ] || 0 ) + 1;
}

/** @returns {object} A snapshot of the counters. */
export function guardTelemetry() {
  return JSON.parse( JSON.stringify( TELEMETRY ) );
}

/** Reset the counters. Tests only. */
export function _resetTelemetry() {
  TELEMETRY.total_calls = 0;
  TELEMETRY.rejections = 0;
  TELEMETRY.by_tool = Object.create( null );
  TELEMETRY.by_reason = Object.create( null );
  TELEMETRY.by_model = Object.create( null );
}

/**
 * Does this call legitimately carry no spec?
 *
 * pdf_render in from_docx mode converts an EXISTING document and has no spec
 * by design. A guard that demanded one would block every PDF made from a file
 * the user already has, which is the tool's most common use.
 *
 * Expressed as a narrow, explicit exemption rather than by leaving pdf_render
 * unregistered, because from_spec mode DOES carry a spec and must be guarded.
 * Leaving the tool out entirely would exempt both modes.
 *
 * @param {string} tool
 * @param {object} input
 * @returns {boolean}
 */
export function isSpeclessMode( tool, input ) {
  if ( tool !== 'pdf_render' ) return false;
  if ( ! isPlainObject( input ) ) return false;
  return input.mode === 'from_docx';
}

/**
 * Build the structured rejection (§3.3).
 *
 * The shape is deliberate. `retry: true` and `directive` are the fields that
 * make this a demand for a corrected re-fire rather than a failure; `faults`
 * names the field and the fix, one entry per problem, so a call with three
 * mistakes is corrected in one retry rather than three.
 *
 * `ok: false` with `isError: true` keeps it a failure at the MCP layer, which
 * is correct: the call did not succeed. The difference from a hard failure is
 * what the payload tells the model to do next.
 *
 * @param {string} tool
 * @param {object[]} faults
 * @param {object} [schema]
 * @returns {object} The MCP result payload.
 */
export function buildRejection( tool, faults, schema = null ) {
  const primary = faults[ 0 ] || {};
  const required = schema
    ? `"${ schema.payloadKey }" must be an object with a non-empty "title" string and a non-empty "${ schema.collection }" array.`
    : 'The call must carry a structured payload matching the tool\'s registered schema.';

  // ── Which error_kind, and why it is not always 'guard_rejected' ──────────
  //
  // An ABSENT or empty payload is a genuinely new outcome: before this guard
  // it did not exist as a distinct class, because the pre-check folded it into
  // 'invalid_spec' along with everything else. Nothing can be keying on it, so
  // it gets the new kind.
  //
  // A payload that is PRESENT but incomplete is not new. The pre-check has
  // rejected those as 'invalid_spec' since v12.x, and src/tests/render-tools.js
  // asserts that contract for pdf_render from_spec. Changing it would be an
  // undeclared breaking change to a published error shape, for no benefit: the
  // caller learns nothing extra from a different string.
  //
  // So the kind is preserved and the guard's value is added ALONGSIDE it --
  // retry, directive and per-field faults ride on both classes. The RETRY
  // directive is the part that changes model behaviour, and it is never the
  // part that gets dropped.
  const absent = [ 'empty_call', 'missing_payload', 'empty_payload', 'malformed_payload' ]
    .includes( primary.reason );

  return {
    ok: false,
    tool,
    error_kind: absent ? 'guard_rejected' : 'invalid_spec',
    guard: 'CONN-GUARD-001',
    // The single most important field: this is correctable, and correcting it
    // is the expected next action.
    retry: true,
    directive:
      `RETRY: re-fire ${ tool } with the payload corrected. Do NOT fall back to ` +
      'another tool or to a script; the call itself was never delivered to the ' +
      'renderer, so nothing has been attempted yet.',
    error: primary.message || `${ tool }: the call was rejected by the integrity guard.`,
    faults,
    // The pre-check's shape. Existing callers and tests read `errors` as an
    // array of strings; `faults` is the richer form this guard adds. Emitting
    // both costs a line and breaks nobody.
    errors: faults.map( ( f ) => f.message ),
    required,
    ...( schema ? { expected_payload_key: schema.payloadKey, expected_collection: schema.collection } : {} ),
  };
}

/**
 * The guard.
 *
 * Called at the top of every renderer-class handler, before any work. Returns
 * null when the call may proceed, or a rejection payload when it may not.
 *
 * @param {object} args
 * @param {string} args.tool
 * @param {unknown} args.input
 * @param {string} [args.modelId] For telemetry (§3.4). Unknown is recorded as such.
 * @param {object} [args.logger]
 * @returns {object|null} Rejection payload, or null to proceed.
 */
export function guardToolCall( { tool, input, modelId, logger = console } = {} ) {
  const name = String( tool || '' );

  // §1: read-only and unstructured tools carry no spec payload and are not
  // guarded. Membership is by REGISTRATION, so this answer stays current as
  // renderers are added.
  if ( ! isGuardedTool( name ) ) return null;

  TELEMETRY.total_calls += 1;

  if ( isSpeclessMode( name, input ) ) return null;

  const { ok, faults, schema } = validateAgainstSchema( name, input );
  if ( ok ) return null;

  const model = isNonEmptyString( modelId ) ? modelId.trim() : 'unknown';
  const reason = faults[ 0 ]?.reason || 'unknown';

  TELEMETRY.rejections += 1;
  bump( TELEMETRY.by_tool, name );
  bump( TELEMETRY.by_reason, reason );
  bump( TELEMETRY.by_model, model );

  // §3.4: one structured line per rejection, carrying everything the routing
  // decision needs to be validated over time. If one model's rejection rate
  // diverges from another's, this is the evidence.
  logger.error( '[tool-call-guard] ' + JSON.stringify( {
    guard: 'CONN-GUARD-001',
    tool: name,
    reason,
    field: faults[ 0 ]?.field || null,
    fault_count: faults.length,
    model,
    at: new Date().toISOString(),
  } ) );

  return buildRejection( name, faults, schema );
}

// NOTE: an earlier revision exported a withGuard() wrapper that decorated each
// handler. It is deleted rather than left unused. Wrapping the four exported
// handlers hit a temporal-dead-zone error -- the tool definition table
// references them above their definition -- and, more importantly, an exported
// unwrapped handler beside a wrapped one is a trap: the first thing anyone
// debugging a guard rejection reaches for is the version without the guard.
//
// The guard is applied at the chokepoint instead, inside handleSpecRender()
// and handlePdfRender(). See the placement note in render-tools.js.

/** @returns {string[]} The tools the guard currently covers. */
export function guardedTools() {
  return registeredRenderTools();
}

export default {
  guardToolCall,
  buildRejection,
  isSpeclessMode,
  guardTelemetry,
  guardedTools,
  getRenderSchema,
};
