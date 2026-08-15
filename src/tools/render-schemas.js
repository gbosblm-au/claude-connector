/**
 * src/tools/render-schemas.js  --  CONN-GUARD-001 §3.2, the schema registry
 *                                  (claude-connector v12.43.0)
 *
 * Each structured-payload renderer registers a capability schema here
 * describing the payload it requires. The guard in tool-call-guard.js
 * validates an incoming call against the registered schema before dispatch,
 * so a new renderer inherits the guard by registering rather than by anyone
 * remembering to edit the guard (§3.1: "renderer-class-wide and must extend
 * automatically to newly registered renderers via shared schema validation,
 * not per-tool hardcoding").
 *
 * ── Why the schemas stop where they do ─────────────────────────────────────
 *
 * §3.2 asks for "section/slide objects must carry a type and required fields
 * per type". This registry deliberately does NOT enforce that, and the reason
 * is recorded at length in render-tools.js above validateDocumentSpec:
 *
 *   The deployed Python renderers accept more than the specification tables
 *   describe. spec_render_common.validate_spec takes a "subheading" section
 *   type, an optional heading level, a "success" callout, a text section with
 *   no "text" key. xlsx_render takes metadata.title in place of title, a sheet
 *   with headers OR rows, and col_widths as an OBJECT. pptx_render models a
 *   slide as {elements:[...]} entirely.
 *
 *   A guard written from the tables therefore REJECTS SPECS THE RENDERER WOULD
 *   HAVE ACCEPTED. That is a worse failure than the one being fixed: it turns
 *   working documents into validation errors, silently, for content that
 *   renders correctly today.
 *
 * So the registry encodes the SHARED rules §3.2 names first -- title required
 * and non-empty, the collection required and non-empty -- which are the two
 * conditions every renderer's own validate_spec checks first and identically,
 * plus the structural checks that cannot produce a false rejection: the spec
 * must be present, must be an object, and its collection entries must be
 * objects rather than strings or nulls.
 *
 * Depth beyond that is delegated to the renderer, which is the source of
 * truth. The guard's job is to stop an EMPTY or STRUCTURALLY IMPOSSIBLE call,
 * which is the failure class §2 actually observed. It is not to become a
 * second, divergent copy of a validator that already exists.
 *
 * ── Adding a renderer ──────────────────────────────────────────────────────
 *
 *   registerRenderSchema( {
 *     tool: 'csv_render',
 *     payloadKey: 'spec',
 *     collection: 'rows',
 *     titleAlternatives: [ 'metadata.title' ],
 *   } );
 *
 * That is the whole obligation. The guard picks it up with no edit.
 */

'use strict';

/**
 * The registered schemas, keyed by tool name.
 * @type {Map<string, object>}
 */
const REGISTRY = new Map();

/**
 * @param {unknown} v
 * @returns {boolean} True for a plain, non-array object.
 */
export function isPlainObject( v ) {
  return Boolean( v ) && typeof v === 'object' && ! Array.isArray( v );
}

/**
 * @param {unknown} v
 * @returns {boolean} True for a string with at least one non-space character.
 */
export function isNonEmptyString( v ) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Read a dotted path out of an object, e.g. "metadata.title".
 *
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
function readPath( obj, path ) {
  return String( path || '' ).split( '.' ).reduce(
    ( acc, key ) => ( isPlainObject( acc ) ? acc[ key ] : undefined ), obj );
}

/**
 * Register a renderer's capability schema.
 *
 * @param {object} schema
 * @param {string} schema.tool         Tool name, e.g. "document_render".
 * @param {string} [schema.payloadKey] Where the spec sits in the tool input. Default "spec".
 * @param {string} schema.collection   The required non-empty array, e.g. "sections".
 * @param {string[]} [schema.titleAlternatives] Extra accepted title paths.
 * @param {string} [schema.describes]  Human phrase for the rejection message.
 * @returns {object} The stored schema.
 */
export function registerRenderSchema( schema ) {
  if ( ! isNonEmptyString( schema?.tool ) ) {
    throw new TypeError( 'registerRenderSchema: tool is required.' );
  }
  if ( ! isNonEmptyString( schema?.collection ) ) {
    throw new TypeError( `registerRenderSchema(${ schema.tool }): collection is required.` );
  }

  const stored = {
    tool: schema.tool,
    payloadKey: isNonEmptyString( schema.payloadKey ) ? schema.payloadKey : 'spec',
    collection: schema.collection,
    titleAlternatives: Array.isArray( schema.titleAlternatives ) ? schema.titleAlternatives : [],
    describes: schema.describes || schema.collection,
  };

  REGISTRY.set( stored.tool, stored );
  return stored;
}

/**
 * @param {string} tool
 * @returns {object|null}
 */
export function getRenderSchema( tool ) {
  return REGISTRY.get( String( tool || '' ) ) || null;
}

/** @returns {string[]} Every registered renderer name. */
export function registeredRenderTools() {
  return [ ...REGISTRY.keys() ];
}

/**
 * Is this tool guarded?
 *
 * §1: the guard applies to structured-payload renderers and NOT to read-only
 * or unstructured tools, which carry no spec payload. Membership is by
 * registration, so the answer is always current.
 *
 * @param {string} tool
 * @returns {boolean}
 */
export function isGuardedTool( tool ) {
  return REGISTRY.has( String( tool || '' ) );
}

/** Reset. Tests only; the registry is otherwise write-once at import. */
export function _resetRegistry() {
  REGISTRY.clear();
}

/**
 * Validate a tool input against a registered schema.
 *
 * Returns FAULTS, each naming the field and what would fix it, because §3.3
 * requires the rejection to say "which field is at fault; what is required to
 * fix it" -- a bare "invalid spec" gives the model nothing to correct and it
 * pivots to a fallback instead of retrying, which is the second link in the
 * observed failure chain.
 *
 * @param {string} tool
 * @param {unknown} input The full tool input.
 * @returns {{ok: boolean, faults: object[], schema: (object|null)}}
 */
export function validateAgainstSchema( tool, input ) {
  const schema = getRenderSchema( tool );
  if ( ! schema ) {
    // §2 table, row 4: a payload with no registered tool. Reported rather than
    // passed through, because routing would otherwise hand the renderer
    // something nothing has described.
    return {
      ok: false,
      schema: null,
      faults: [ {
        field: 'tool',
        reason: 'unregistered_tool',
        message: `No render schema is registered for "${ tool }". The guard cannot validate it, so the call is refused.`,
      } ],
    };
  }

  /** @type {object[]} */
  const faults = [];

  if ( ! isPlainObject( input ) ) {
    faults.push( {
      field: schema.payloadKey,
      reason: 'empty_call',
      message: `${ schema.tool } was called with no arguments. Re-fire the call with a "${ schema.payloadKey }" object.`,
    } );
    return { ok: false, faults, schema };
  }

  const payload = input[ schema.payloadKey ];

  // ── The observed failure (§2): the call went out without its spec ────────
  //
  // Separated from "the spec is malformed" because they are different mistakes
  // and want different corrections. "spec.title is required" is misleading
  // advice when no spec was attached at all: the model reads it as a field
  // problem and adds a title to a body it never sent.
  if ( payload === undefined || payload === null ) {
    faults.push( {
      field: schema.payloadKey,
      reason: 'missing_payload',
      message:
        `${ schema.tool } was called without its "${ schema.payloadKey }" payload. ` +
        `The whole document body was missing, not just a field. ` +
        `Re-fire the call with "${ schema.payloadKey }" containing a title and a non-empty ${ schema.collection } array.`,
    } );
    return { ok: false, faults, schema };
  }

  if ( ! isPlainObject( payload ) ) {
    faults.push( {
      field: schema.payloadKey,
      reason: 'malformed_payload',
      message:
        `${ schema.tool }: "${ schema.payloadKey }" must be a JSON object, got ` +
        `${ Array.isArray( payload ) ? 'an array' : typeof payload }.`,
    } );
    return { ok: false, faults, schema };
  }

  // An object with no keys is the empty call wearing a different shape, and it
  // reaches the renderer as a document with nothing in it.
  if ( Object.keys( payload ).length === 0 ) {
    faults.push( {
      field: schema.payloadKey,
      reason: 'empty_payload',
      message:
        `${ schema.tool }: "${ schema.payloadKey }" is an empty object. ` +
        `Re-fire with a title and a non-empty ${ schema.collection } array.`,
    } );
    return { ok: false, faults, schema };
  }

  // ── Shared rule 1: title (§3.2) ──────────────────────────────────────────
  const titlePaths = [ 'title', ...schema.titleAlternatives ];
  const hasTitle = titlePaths.some( ( p ) => isNonEmptyString( readPath( payload, p ) ) );
  if ( ! hasTitle ) {
    faults.push( {
      field: `${ schema.payloadKey }.title`,
      reason: 'missing_field',
      message:
        `${ schema.tool }: "title" is required and must be a non-empty string` +
        ( schema.titleAlternatives.length ? ` (or ${ schema.titleAlternatives.join( ' / ' ) })` : '' ) +
        '. It becomes the filename slug.',
    } );
  }

  // ── Shared rule 2: the collection (§3.2) ─────────────────────────────────
  const collection = payload[ schema.collection ];
  if ( collection === undefined ) {
    faults.push( {
      field: `${ schema.payloadKey }.${ schema.collection }`,
      reason: 'missing_field',
      message: `${ schema.tool }: "${ schema.collection }" is required and must be a non-empty array.`,
    } );
  } else if ( ! Array.isArray( collection ) ) {
    faults.push( {
      field: `${ schema.payloadKey }.${ schema.collection }`,
      reason: 'wrong_type',
      message: `${ schema.tool }: "${ schema.collection }" must be an array, got ${ typeof collection }.`,
    } );
  } else if ( collection.length === 0 ) {
    faults.push( {
      field: `${ schema.payloadKey }.${ schema.collection }`,
      reason: 'empty_collection',
      message:
        `${ schema.tool }: "${ schema.collection }" is an empty array. ` +
        'A document with no content is not a document; add at least one entry.',
    } );
  } else {
    // Structural only. Each entry must be an OBJECT -- a string or a null in a
    // sections array is not something any renderer accepts, so rejecting it
    // cannot produce a false negative. What the object must CONTAIN is the
    // renderer's judgement; see the header note.
    const badIndexes = collection
      .map( ( entry, i ) => ( isPlainObject( entry ) ? -1 : i ) )
      .filter( ( i ) => i >= 0 );

    if ( badIndexes.length ) {
      faults.push( {
        field: `${ schema.payloadKey }.${ schema.collection }[${ badIndexes[ 0 ] }]`,
        reason: 'wrong_type',
        message:
          `${ schema.tool }: every entry in "${ schema.collection }" must be an object. ` +
          `Entr${ badIndexes.length === 1 ? 'y' : 'ies' } ${ badIndexes.slice( 0, 5 ).join( ', ' ) } ` +
          `${ badIndexes.length === 1 ? 'is' : 'are' } not.`,
      } );
    }
  }

  return { ok: faults.length === 0, faults, schema };
}

// ---------------------------------------------------------------------------
// The deployed renderers
//
// Registered here rather than beside each handler so the whole guarded surface
// is readable in one place, and so importing this module is sufficient to know
// what the guard covers.
//
// pdf_render is registered against its from_spec shape. Its from_docx mode
// carries no spec at all and is handled by the guard's mode-aware exemption --
// see the note in tool-call-guard.js, because a guard that demanded a spec
// from a conversion call would block every PDF made from an existing document.
// ---------------------------------------------------------------------------

registerRenderSchema( {
  tool: 'document_render',
  collection: 'sections',
  describes: 'document sections',
} );

registerRenderSchema( {
  tool: 'xlsx_render',
  collection: 'sheets',
  // xlsx_render.validate_spec accepts metadata.title in place of title. The
  // guard must accept everything the renderer accepts, or it rejects working
  // workbooks.
  titleAlternatives: [ 'metadata.title' ],
  describes: 'worksheets',
} );

registerRenderSchema( {
  tool: 'pptx_render',
  collection: 'slides',
  describes: 'slides',
} );

registerRenderSchema( {
  tool: 'pdf_render',
  collection: 'sections',
  describes: 'document sections',
} );

export default {
  registerRenderSchema,
  getRenderSchema,
  registeredRenderTools,
  isGuardedTool,
  validateAgainstSchema,
  isPlainObject,
  isNonEmptyString,
};
