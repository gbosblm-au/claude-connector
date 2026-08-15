/**
 * tests/tool-call-guard.test.js  --  CONN-GUARD-001
 *
 * ── What is actually being prevented ───────────────────────────────────────
 *
 * Observed 2026-08-15: document_render went out TWICE with no spec payload,
 * the renderer never received a body, and the model pivoted to a script
 * fallback instead of retrying the tool.
 *
 * That is a chain of two links, and the tests below cover both:
 *
 *   1. the empty call must not be accepted at the boundary;
 *   2. the rejection must make the corrected retry the obvious next move,
 *      because a model told only "invalid spec" pivots rather than re-fires.
 *
 * The second is easy to under-test. A guard that rejects correctly and returns
 * a bare error has fixed nothing the renderer's own validation was not already
 * doing, so several assertions below are about the SHAPE of the rejection
 * rather than the decision.
 *
 *   node --test tests/tool-call-guard.test.js
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  guardToolCall, buildRejection, isSpeclessMode,
  guardTelemetry, _resetTelemetry, guardedTools,
} from '../src/tools/tool-call-guard.js';

import {
  validateAgainstSchema, registerRenderSchema, getRenderSchema, isGuardedTool,
} from '../src/tools/render-schemas.js';

/** Swallows the deliberate error logging so test output stays readable. */
const quiet = { error: () => {} };

/** A spec that passes the guard, for the "must not reject" cases. */
const GOOD_DOC = { spec: { title: 'Quarterly Report', sections: [ { type: 'heading', text: 'H' } ] } };

beforeEach( () => _resetTelemetry() );

// ---------------------------------------------------------------------------

describe( 'scope (§1)', () => {
  test( 'the four first-class renderers are guarded', () => {
    for ( const t of [ 'document_render', 'pdf_render', 'xlsx_render', 'pptx_render' ] ) {
      assert.ok( isGuardedTool( t ), t );
    }
  } );

  test( 'read-only and unstructured tools are NOT guarded', () => {
    // They carry no structured spec payload, so there is nothing to validate
    // and a guard would only be an obstacle.
    for ( const t of [ 'web_search', 'memory_read', 'google_drive_search', '' ] ) {
      assert.equal( isGuardedTool( t ), false, t );
      assert.equal( guardToolCall( { tool: t, input: {}, logger: quiet } ), null );
    }
  } );

  test( 'a newly registered renderer is guarded with no edit to the guard', () => {
    // §3.1: "must extend automatically to newly registered renderers via
    // shared schema validation, not per-tool hardcoding".
    assert.equal( isGuardedTool( 'csv_render' ), false );
    registerRenderSchema( { tool: 'csv_render', collection: 'rows' } );

    assert.ok( guardedTools().includes( 'csv_render' ) );
    const r = guardToolCall( { tool: 'csv_render', input: {}, logger: quiet } );
    assert.ok( r, 'the new tool is guarded immediately' );
    assert.equal( r.expected_collection, 'rows' );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'the observed failure: an empty call (§2)', () => {
  test( 'a call with no spec is rejected', () => {
    const r = guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );
    assert.ok( r );
    assert.equal( r.faults[ 0 ].reason, 'missing_payload' );
  } );

  test( 'the message says the BODY was missing, not that a field was', () => {
    // This is the distinction the existing pre-check cannot make. Told
    // "spec.title is required" for a call that carried no spec at all, the
    // model reads it as a field problem and adds a title to a body it never
    // sent -- which is the second failed call in the observed incident.
    const r = guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );
    assert.match( r.error, /without its "spec" payload/ );
    assert.match( r.error, /not just a field/ );
  } );

  test( 'no arguments at all is rejected the same way', () => {
    for ( const input of [ undefined, null, 'a string', 42, [] ] ) {
      const r = guardToolCall( { tool: 'document_render', input, logger: quiet } );
      assert.ok( r, String( input ) );
    }
  } );

  test( 'an empty spec object is caught too', () => {
    // The empty call wearing a different shape. It reaches the renderer as a
    // document with nothing in it.
    const r = guardToolCall( { tool: 'document_render', input: { spec: {} }, logger: quiet } );
    assert.equal( r.faults[ 0 ].reason, 'empty_payload' );
  } );
} );

describe( 'the failure table (§2)', () => {
  test( 'missing required field: no sections', () => {
    const r = guardToolCall( {
      tool: 'document_render', input: { spec: { title: 'T' } }, logger: quiet } );
    assert.equal( r.faults[ 0 ].reason, 'missing_field' );
    assert.match( r.faults[ 0 ].field, /sections/ );
  } );

  test( 'malformed spec: wrong types', () => {
    const r = guardToolCall( {
      tool: 'document_render', input: { spec: { title: 'T', sections: 'not an array' } }, logger: quiet } );
    assert.equal( r.faults[ 0 ].reason, 'wrong_type' );
  } );

  test( 'an empty sections array is rejected', () => {
    const r = guardToolCall( {
      tool: 'document_render', input: { spec: { title: 'T', sections: [] } }, logger: quiet } );
    assert.equal( r.faults[ 0 ].reason, 'empty_collection' );
  } );

  test( 'non-object entries in the collection are rejected', () => {
    // A string or a null in a sections array is not something any renderer
    // accepts, so rejecting it cannot produce a false negative.
    const r = guardToolCall( {
      tool: 'document_render',
      input: { spec: { title: 'T', sections: [ { type: 'heading' }, 'oops', null ] } },
      logger: quiet } );
    assert.equal( r.faults[ 0 ].reason, 'wrong_type' );
    assert.match( r.faults[ 0 ].message, /must be an object/ );
  } );

  test( 'payload with no registered tool', () => {
    const v = validateAgainstSchema( 'nonexistent_render', { spec: { title: 'T' } } );
    assert.equal( v.ok, false );
    assert.equal( v.faults[ 0 ].reason, 'unregistered_tool' );
  } );

  test( 'every fault is reported at once, not one per retry', () => {
    const r = guardToolCall( {
      tool: 'document_render', input: { spec: { subtitle: 'x' } }, logger: quiet } );
    assert.ok( r.faults.length >= 2, `expected title AND sections, got ${ r.faults.length }` );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'the rejection is a RETRY directive, not an error (§3.3)', () => {
  const r = () => guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );

  test( 'it is marked retryable', () => {
    assert.equal( r().retry, true );
  } );

  test( 'it tells the model NOT to fall back', () => {
    // The precise failure: the model pivoted to a script instead of re-firing.
    const d = r().directive;
    assert.match( d, /RETRY/ );
    assert.match( d, /Do NOT fall back/ );
    assert.match( d, /never delivered to the renderer/ );
  } );

  test( 'it names the tool, the field, and the fix (§3.3)', () => {
    const rej = r();
    assert.equal( rej.tool, 'document_render' );
    assert.ok( rej.faults[ 0 ].field );
    assert.match( rej.required, /non-empty "sections" array/ );
  } );

  test( 'it identifies the guard, so the source of the rejection is unambiguous', () => {
    assert.equal( r().guard, 'CONN-GUARD-001' );
    assert.equal( r().error_kind, 'guard_rejected' );
  } );

  test( 'buildRejection degrades safely with no schema', () => {
    const b = buildRejection( 'x_render', [ { field: 'spec', reason: 'missing_payload', message: 'm' } ] );
    assert.equal( b.retry, true );
    assert.ok( b.required );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'valid calls pass untouched', () => {
  test( 'a well-formed document spec proceeds', () => {
    assert.equal( guardToolCall( { tool: 'document_render', input: GOOD_DOC, logger: quiet } ), null );
  } );

  test( 'xlsx accepts metadata.title, as the renderer does', () => {
    // The guard must accept everything the renderer accepts, or it rejects
    // working workbooks. xlsx_render.validate_spec takes metadata.title in
    // place of title.
    const input = { spec: { metadata: { title: 'Q3' }, sheets: [ { name: 'S1' } ] } };
    assert.equal( guardToolCall( { tool: 'xlsx_render', input, logger: quiet } ), null );
  } );

  test( 'pptx slides pass with the renderer\'s own element shape', () => {
    // pptx_render models a slide as {elements:[...]}, which the specification
    // tables do not describe. The guard must not impose the table's shape.
    const input = { spec: { title: 'Deck', slides: [ { elements: [ { type: 'title', text: 'A' } ] } ] } };
    assert.equal( guardToolCall( { tool: 'pptx_render', input, logger: quiet } ), null );
  } );

  test( 'section types the tables omit are NOT rejected', () => {
    // The deployed renderer accepts "subheading" and a "success" callout;
    // the specification tables list neither. A guard written from the tables
    // would reject documents that render correctly today, which is a worse
    // failure than the one being fixed.
    const input = { spec: { title: 'T', sections: [
      { type: 'subheading', text: 'S' },
      { type: 'callout', style: 'success', text: 'C' },
      { type: 'text' },
    ] } };
    assert.equal( guardToolCall( { tool: 'document_render', input, logger: quiet } ), null );
  } );
} );

describe( 'pdf_render modes', () => {
  test( 'from_docx carries no spec by design and is exempt', () => {
    // Demanding a spec here would block every PDF made from an existing file,
    // which is the tool's most common use.
    assert.equal( isSpeclessMode( 'pdf_render', { mode: 'from_docx' } ), true );
    const input = { mode: 'from_docx', source_path: 'report.docx' };
    assert.equal( guardToolCall( { tool: 'pdf_render', input, logger: quiet } ), null );
  } );

  test( 'from_spec IS guarded', () => {
    // Leaving pdf_render unregistered would have exempted both modes.
    const r = guardToolCall( { tool: 'pdf_render', input: { mode: 'from_spec' }, logger: quiet } );
    assert.ok( r );
    assert.equal( r.faults[ 0 ].reason, 'missing_payload' );
  } );

  test( 'the exemption is narrow to pdf_render', () => {
    assert.equal( isSpeclessMode( 'document_render', { mode: 'from_docx' } ), false );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'telemetry (§3.4)', () => {
  test( 'rejections are counted by tool, reason and model', () => {
    guardToolCall( { tool: 'document_render', input: {}, modelId: 'qwen3.6-35b-a3b', logger: quiet } );
    guardToolCall( { tool: 'document_render', input: {}, modelId: 'qwen3.6-35b-a3b', logger: quiet } );
    guardToolCall( { tool: 'xlsx_render', input: { spec: { title: 'T' } }, modelId: 'deepseek-v4-pro', logger: quiet } );

    const t = guardTelemetry();
    assert.equal( t.rejections, 3 );
    assert.equal( t.by_tool.document_render, 2 );
    assert.equal( t.by_model[ 'qwen3.6-35b-a3b' ], 2 );
    assert.equal( t.by_model[ 'deepseek-v4-pro' ], 1 );
    assert.equal( t.by_reason.missing_payload, 2 );
  } );

  test( 'a rejection RATE is derivable, which is the point', () => {
    // §3.4 wants a measurable rate per model to confirm or refute the routing
    // decision. A count of rejections alone cannot give one.
    guardToolCall( { tool: 'document_render', input: GOOD_DOC, logger: quiet } );
    guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );
    const t = guardTelemetry();
    assert.equal( t.total_calls, 2 );
    assert.equal( t.rejections, 1 );
  } );

  test( 'unattributed calls are recorded as unknown, never guessed', () => {
    // A wrong attribution is worse than an absent one for telemetry whose
    // whole purpose is to compare models.
    guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );
    assert.equal( guardTelemetry().by_model.unknown, 1 );
  } );

  test( 'one structured log line per rejection', () => {
    const lines = [];
    guardToolCall( {
      tool: 'document_render', input: {}, modelId: 'deepseek-v4-pro',
      logger: { error: ( m ) => lines.push( m ) },
    } );
    assert.equal( lines.length, 1 );
    const payload = JSON.parse( lines[ 0 ].replace( '[tool-call-guard] ', '' ) );
    for ( const k of [ 'guard', 'tool', 'reason', 'model', 'at' ] ) {
      assert.ok( k in payload, `log line carries ${ k }` );
    }
    assert.equal( payload.model, 'deepseek-v4-pro' );
  } );

  test( 'a passing call logs nothing', () => {
    const lines = [];
    guardToolCall( { tool: 'document_render', input: GOOD_DOC, logger: { error: ( m ) => lines.push( m ) } } );
    assert.equal( lines.length, 0 );
  } );
} );

// ---------------------------------------------------------------------------

describe( 'the interception point (§3.1)', () => {
  test( 'the guard runs before the renderer, through the real handler', async () => {
    // Proves placement rather than the pure function: an empty call must come
    // back as a guard rejection without any subprocess having been attempted.
    const { handleDocumentRender } = await import( '../src/tools/render-tools.js' );
    const res = await handleDocumentRender( {} );

    assert.equal( res.isError, true );
    const payload = JSON.parse( res.content[ 0 ].text );
    assert.equal( payload.error_kind, 'guard_rejected' );
    assert.equal( payload.guard, 'CONN-GUARD-001' );
    assert.equal( payload.retry, true );
    // If this had reached the renderer the failure would be a resolver or
    // subprocess error, not a guard rejection.
    assert.ok( ! /renderer|subprocess|ENOENT/i.test( payload.error ) );
  } );

  test( 'every guarded handler intercepts an empty call', async () => {
    const m = await import( '../src/tools/render-tools.js' );
    for ( const [ fn, name ] of [
      [ m.handleDocumentRender, 'document_render' ],
      [ m.handleXlsxRender, 'xlsx_render' ],
      [ m.handlePptxRender, 'pptx_render' ],
      [ m.handlePdfRender, 'pdf_render' ],
    ] ) {
      const res = await fn( {} );
      const payload = JSON.parse( res.content[ 0 ].text );
      assert.equal( payload.ok, false, name );
      assert.equal( payload.tool, name );
    }
  } );
} );

describe( 'REGRESSIONS: paths the guard must NOT intercept', () => {
  // Both of these were introduced by placing the guard too early, ahead of
  // paths that never reach the renderer. Caught by the pre-existing
  // src/tests/render-tools.test.js suite, which is why it is now run too.

  test( 'a dry run returns a VERDICT, not a guard rejection', async () => {
    // A dry run asks "would this spec be accepted?". The honest answer is
    // valid:false, not isError:true -- that is what lets a caller check a spec
    // without treating the check itself as a failure. The failure class the
    // guard prevents cannot occur on a path that never dispatches.
    const { handleDocumentRender } = await import( '../src/tools/render-tools.js' );
    const res = await handleDocumentRender( { dry_run: true, spec: { sections: [] } } );
    const body = JSON.parse( res.content[ 0 ].text );

    assert.equal( res.isError, false, 'a validation verdict is a result, not a tool failure' );
    assert.equal( body.dry_run, true );
    assert.equal( body.valid, false );
    assert.equal( body.error_kind, undefined, 'no guard rejection on a dry run' );
  } );

  test( 'a present-but-incomplete spec keeps error_kind invalid_spec', async () => {
    // The published error shape. Before this guard, an absent payload and an
    // incomplete one both came back as invalid_spec; only the ABSENT case is a
    // genuinely new outcome, so only it takes the new kind. Changing the other
    // would be an undeclared breaking change for no gain -- the caller learns
    // nothing extra from a different string.
    const { handlePdfRender } = await import( '../src/tools/render-tools.js' );
    const res = await handlePdfRender( { mode: 'from_spec', spec: { title: 'No sections' } } );
    const body = JSON.parse( res.content[ 0 ].text );

    assert.equal( res.isError, true );
    assert.equal( body.error_kind, 'invalid_spec' );
    assert.ok( body.errors.some( ( e ) => /sections/.test( e ) ), 'errors[] shape preserved' );
    // The guard's value rides alongside the preserved contract rather than
    // replacing it. The RETRY directive is never the part that gets dropped.
    assert.equal( body.retry, true );
    assert.equal( body.guard, 'CONN-GUARD-001' );
  } );

  test( 'an ABSENT payload does take the new kind', () => {
    const r = guardToolCall( { tool: 'document_render', input: {}, logger: quiet } );
    assert.equal( r.error_kind, 'guard_rejected' );
    assert.equal( r.retry, true );
  } );

  test( 'no unguarded handler is exported', async () => {
    // An exported unwrapped handler beside a guarded one is a trap: the first
    // thing anyone debugging a rejection reaches for is the version without
    // the guard.
    const m = await import( '../src/tools/render-tools.js' );
    const raw = Object.keys( m ).filter( ( k ) => /Raw$|Unguarded$/.test( k ) );
    assert.deepEqual( raw, [] );
  } );
} );

describe( 'CONN-GUARD-001 Amendment 1: validation depth', () => {
  // The amended §3.2. Each of these is a spec the DEPLOYED renderer accepts,
  // verified against spec_render_common.validate_spec. A guard enforcing the
  // original clause would reject every one, turning working documents into
  // validation errors -- a worse failure than the empty call it was written to
  // prevent.

  test( 'a section with NO type is accepted', () => {
    // spec_render_common.py: stype = sec.get("type", "text"). The governing
    // instance, and the one that makes the original clause unimplementable.
    const input = { spec: { title: 'T', sections: [ { text: 'body copy' } ] } };
    assert.equal( guardToolCall( { tool: 'document_render', input, logger: quiet } ), null );
  } );

  test( 'types with no required fields are accepted bare', () => {
    for ( const type of [ 'divider', 'page_break', 'subheading', 'text', 'paragraph' ] ) {
      const input = { spec: { title: 'T', sections: [ { type } ] } };
      assert.equal( guardToolCall( { tool: 'document_render', input, logger: quiet } ), null, type );
    }
  } );

  test( 'xlsx accepts the legacy data array in place of headers/rows', () => {
    const input = { spec: { metadata: { title: 'Q3' }, sheets: [ { data: [ [ 'h' ], [ 1 ] ] } ] } };
    assert.equal( guardToolCall( { tool: 'xlsx_render', input, logger: quiet } ), null );
  } );

  test( 'a pptx slide needs no type, and elements is optional', () => {
    const input = { spec: { title: 'Deck', slides: [ {}, { elements: [ { text: 'x' } ] } ] } };
    assert.equal( guardToolCall( { tool: 'pptx_render', input, logger: quiet } ), null );
  } );

  test( 'the structural rules that DID survive still bite', () => {
    // The amendment narrowed the depth; it did not remove the guard. A
    // non-object entry is not something any renderer accepts, so rejecting it
    // cannot produce a false negative.
    const input = { spec: { title: 'T', sections: [ 'not an object' ] } };
    const r = guardToolCall( { tool: 'document_render', input, logger: quiet } );
    assert.ok( r, 'a string entry is still rejected' );
    assert.equal( r.faults[ 0 ].reason, 'wrong_type' );
  } );
} );

describe( 'schema registry hygiene', () => {
  test( 'registration requires a tool and a collection', () => {
    assert.throws( () => registerRenderSchema( { collection: 'rows' } ), /tool is required/ );
    assert.throws( () => registerRenderSchema( { tool: 'x_render' } ), /collection is required/ );
  } );

  test( 'the payload key defaults to spec', () => {
    assert.equal( getRenderSchema( 'document_render' ).payloadKey, 'spec' );
  } );
} );
