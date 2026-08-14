// src/tools/render-tools.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-DOC-001 -- Hardcoded procedural document creation tools.
//
// Registers four first-class gateway tools in the connector tool registry:
//
//     document_render  (DOCX + HTML preview)
//     pdf_render       (PDF, by conversion from DOCX)
//     xlsx_render      (XLSX workbook)
//     pptx_render      (PPTX deck)
//
// WHY THIS MODULE EXISTS
// ----------------------
// Document creation was previously reachable only through script_execute, which
// has three ceilings the calling session had to rediscover every time:
//
//   1. input_data is transported as a single tool parameter and SILENTLY
//      TRUNCATES large spec payloads. The document renders, exits 0, and is
//      short. There is no error to notice. (Spec 4.1.)
//   2. script_write rejects a single write over roughly 500 lines with
//      CHUNK_LIMIT_EXCEEDED, so the decomposed-builder workaround had to be
//      re-derived. (Spec 4.2.)
//   3. The renderer script name, argument flags, input schema and output
//      contract had to be reproduced exactly from memory. (Spec 4.4.)
//
// Every one of those is a property of the CALLER. This module moves all of it
// server-side: the caller supplies a content spec, and the gateway resolves the
// renderer, writes the spec to disk, enforces a documented size ceiling, runs
// the subprocess and returns the standard download contract.
//
// THE --output DEFECT, AND WHY THE ARGV FORM IS NOT A GUESS
// ---------------------------------------------------------
// script_execute unconditionally appends `--output <tmpdir>` to argv whenever
// input_data is supplied. The renderers on the volume do not declare it. The
// Gateway Service records the exact observed failure in
// lib/turn-supervisor.js (REMEDIATIONS -> 'argparse_unrecognised_output') and
// pins it in tests/turn-supervisor.test.js:
//
//     usage: document_render.py [-h] [--input INPUT]
//     error: unrecognized arguments: --output /tmp/x
//
// argparse writes that to stderr and exits 2 BEFORE main() runs, so it starts
// with "usage:", carries no `Error:` prefix, is not JSON, and was for a period
// classified as a SUCCESS. That is the single most expensive failure in the
// record this spec was written from.
//
// So the first argv form this module tries is `--input <specfile>` and nothing
// else. That is the form the working path used, not a guess.
//
// ARGV FALLBACK LADDER
// --------------------
// The renderer scripts live on the Railway volume and are not in this
// repository, so their exact flags cannot be read at build time -- and the
// volume is subject to snapshot reverts (spec 4.5), so they can change under
// us. Rather than hardcode one form and fail opaquely, each renderer has a
// short ordered list of candidate argv forms. A form is abandoned and the next
// tried ONLY when the process exits non-zero AND the output carries an argparse
// rejection signature, which by construction means the script rejected argv
// before doing any work. A runtime error is never retried, because a runtime
// error means the script ran, and re-running it could duplicate an effect.
//
// The form that succeeded is reported back as `argv_form`, so an operator can
// pin it permanently through RENDER_ARGV_FORMS and remove the probe.
//
// SECURITY
// --------
//   - The renderer script name is a gateway-side constant. It is NEVER read
//     from tool input. Any input key that looks like a script or command path
//     is ignored and reported in `ignored_parameters`. (Spec test T10.)
//   - Renderer paths resolve through resolveContained() against the scripts
//     directory, so an operator-supplied override cannot escape it and cannot
//     resolve through a symlink.
//   - pdf_render's source document is restricted to a single-segment filename
//     inside the downloads or uploads directory. A source_url is accepted only
//     when it addresses this connector's own /download/ route; the filename is
//     extracted and resolved the same way. Nothing in this module performs an
//     outbound fetch, so there is no SSRF surface.
//   - Subprocesses are spawned through spawnSync with an argument array and no
//     shell, using the shared minimal environment from utils/scriptEnv.js. No
//     credential is inherited.
//
// FEATURE FLAG
// ------------
// Spec section 9 requires the tools ship behind a flag, default off for one
// release. RENDER_TOOLS_ENABLED=true turns them on. When off they are neither
// advertised in the tool manifest nor dispatchable, and script_execute plus the
// existing renderer scripts remain untouched and fully available.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { resolve as resolvePath, basename, extname, join as joinPath } from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveContained, isSafeFilename } from '../utils/pathContainment.js';
import { buildScriptEnv } from '../utils/scriptEnv.js';
import { buildDownloadLinks, snapshotDownloads, downloadsBase } from '../utils/downloadLinks.js';

// ---------------------------------------------------------------------------
// Configuration
//
// Every value is read through a function rather than captured at module load,
// so that a test (or a platform that mutates process.env after import) sees the
// current value. This mirrors downloadsBase() in utils/downloadLinks.js. The
// values are tiny, so there is no measurable cost to reading them per call.
// ---------------------------------------------------------------------------

/** Default serialized-spec ceiling in bytes. 524288 = 512KB (spec section 7). */
const DEFAULT_SPEC_MAX_BYTES = 512 * 1024;

/** Absolute floor and ceiling for the configured spec size limit. */
const SPEC_MAX_BYTES_FLOOR = 1024;
const SPEC_MAX_BYTES_CEILING = 32 * 1024 * 1024;

/** Default subprocess timeout, and the range an operator may configure. */
const DEFAULT_TIMEOUT_SECONDS = 180;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 900;

/** Cap on stdout/stderr retained in a tool result, in characters. */
const OUTPUT_TAIL_CHARS = 4000;

/** Cap on how many argv forms will ever be attempted for one renderer. */
const MAX_ARGV_FORMS = 6;

/** Maximum bytes captured from a subprocess pipe. */
const SUBPROCESS_MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Is the render tool family enabled?
 *
 * Spec section 9 requires default-off for one release. An operator opts in with
 * RENDER_TOOLS_ENABLED=true. Any other value, including unset, leaves the tools
 * unregistered and undispatchable.
 *
 * @returns {boolean}
 */
export function renderToolsEnabled() {
  return String( process.env.RENDER_TOOLS_ENABLED || '' ).trim().toLowerCase() === 'true';
}

/**
 * Directory the renderer scripts live in.
 *
 * Same resolution as src/tools/script-execute.js so that both paths agree about
 * where a script is. If these ever diverge, a script runnable through
 * script_execute would be invisible here, which would be a confusing failure.
 *
 * @returns {string} Absolute path.
 */
export function scriptsBase() {
  return process.env.SCRIPTS_DIR
    ? resolvePath( process.env.SCRIPTS_DIR )
    : resolvePath( '/data/skill/ava/scripts' );
}

/**
 * Directory user uploads land in, used only to resolve a pdf_render source.
 *
 * Matches USER_DATA_UPLOAD_DIR in src/server-http.js.
 *
 * @returns {string} Absolute path.
 */
export function uploadsBase() {
  return resolvePath( process.env.USER_DATA_UPLOAD_DIR || '/data/uploads' );
}

/**
 * Staging directory the validated spec JSON is written to before the renderer
 * is invoked (spec section 7, step 3).
 *
 * Deliberately not the downloads directory: a spec file appearing there would
 * be picked up by the download-link diff and offered to the user as a
 * deliverable.
 *
 * @returns {string} Absolute path.
 */
export function stagingBase() {
  return resolvePath( process.env.RENDER_STAGING_DIR || '/tmp/tenax_render_staging' );
}

/**
 * Serialized-spec ceiling in bytes.
 *
 * A misconfigured value is clamped rather than honoured: a limit of 0 would
 * reject every call and a limit of 4GB would defeat the control entirely, and
 * neither is a state an operator intends.
 *
 * @returns {number}
 */
export function specMaxBytes() {
  const raw = parseInt( process.env.RENDER_SPEC_MAX_BYTES || '', 10 );
  if ( ! Number.isFinite( raw ) || raw <= 0 ) return DEFAULT_SPEC_MAX_BYTES;
  return Math.min( Math.max( raw, SPEC_MAX_BYTES_FLOOR ), SPEC_MAX_BYTES_CEILING );
}

/**
 * Subprocess timeout in milliseconds.
 *
 * @returns {number}
 */
export function renderTimeoutMs() {
  const raw = parseInt( process.env.RENDER_TIMEOUT_SECONDS || '', 10 );
  const seconds = Number.isFinite( raw ) && raw > 0 ? raw : DEFAULT_TIMEOUT_SECONDS;
  return Math.min( Math.max( seconds, MIN_TIMEOUT_SECONDS ), MAX_TIMEOUT_SECONDS ) * 1000;
}

/**
 * Renderer script filenames, resolved from gateway-side constants.
 *
 * The env overrides exist for an operator whose volume layout differs. They are
 * still resolved through resolveContained() against the scripts directory, so
 * an override cannot escape it. They are NOT reachable from tool input.
 *
 * @returns {{docx: string, xlsx: string, pptx: string, pdf: string, pdfFaithful: string}}
 */
export function rendererScripts() {
  return {
    docx:        String( process.env.RENDER_SCRIPT_DOCX          || 'document_render.py' ).trim(),
    xlsx:        String( process.env.RENDER_SCRIPT_XLSX          || 'xlsx_render.py' ).trim(),
    pptx:        String( process.env.RENDER_SCRIPT_PPTX          || 'pptx_render.py' ).trim(),
    pdf:         String( process.env.RENDER_SCRIPT_PDF           || 'convert_docx_to_pdf.py' ).trim(),
    pdfFaithful: String( process.env.RENDER_SCRIPT_PDF_FAITHFUL  || 'docx_to_pdf_faithful.py' ).trim(),
  };
}

/**
 * Argv forms for a spec-driven renderer (document, xlsx, pptx).
 *
 * VERIFIED against the deployed scripts, not inferred. All three build the
 * same parser:
 *
 *     parser.add_argument("--input", default=None)
 *     parser.add_argument("--dry-run", action="store_true")
 *     add_output_arg(parser)          # --output, nargs="?", SUPPRESSed
 *
 * so `--input <file>` alone is correct and complete. --output is accepted and
 * deliberately discarded by doc_common.add_output_arg, because script_execute
 * appends it unconditionally and it points at the return_files staging area
 * rather than the downloads directory. Passing it would be harmless but
 * meaningless, so it is not passed.
 *
 * Form 2 exists only for a volume snapshot revert to a build that predates
 * add_output_arg AND requires --output. It has never been observed. Form 1
 * works on every build seen, old or new, which is why it leads.
 */
const DEFAULT_SPEC_ARGV_FORMS = [
  [ '--input', '{spec}' ],
  [ '--input', '{spec}', '--output', '{output_dir}' ],
];

/**
 * Argv forms per PDF converter. THE TWO CONVERTERS ARE NOT INTERCHANGEABLE.
 *
 * convert_docx_to_pdf.py (LibreOffice):
 *     --input      required; resolved through doc_common.resolve_upload_path,
 *                  which prepends UPLOADS_DIR to a RELATIVE path. A bare
 *                  filename for a file in downloads therefore fails to
 *                  resolve, so this module always passes an ABSOLUTE path,
 *                  which resolve_upload_path accepts for either approved dir.
 *     --pdf-name   the output slug. THIS is how the output is named.
 *     --output     absorbed and ignored via add_output_arg.
 *
 * docx_to_pdf_faithful.py (reportlab):
 *     --input      required, a raw path with no containment resolution.
 *     --output     a REAL output file path, defaulting to the input with a
 *                  .pdf suffix.
 *
 * Sending `--output <path>` to the LibreOffice converter, as a single shared
 * ladder would, is silently wrong: argparse accepts it, add_output_arg
 * discards it, and the PDF is published under the source stem instead of the
 * requested name. The caller's output_name would be ignored with no error, no
 * warning and a successful-looking result. Hence per-script forms.
 */
const PDF_ARGV_FORMS = {
  librewrite: [
    [ '--input', '{source}', '--pdf-name', '{slug}' ],
    [ '--input', '{source}' ],
  ],
  faithful: [
    [ '--input', '{source}', '--output', '{out_file}' ],
    [ '--input', '{source}' ],
  ],
};

/**
 * Resolve the argv forms for one renderer, honouring an operator pin.
 *
 * RENDER_ARGV_FORMS is a JSON object keyed by script filename:
 *
 *     { "document_render.py": [ ["--input", "{spec}"] ] }
 *
 * A malformed value is logged and ignored rather than throwing. Failing back to
 * the defaults is correct: the defaults work, so a typo in an optimisation
 * should not take document rendering down.
 *
 * @param {string} scriptFile  Renderer filename, e.g. "document_render.py".
 * @param {string[][]} fallback  Default ladder for this renderer class.
 * @returns {string[][]} Ordered argv forms, capped at MAX_ARGV_FORMS.
 */
export function argvFormsFor( scriptFile, fallback ) {
  const raw = String( process.env.RENDER_ARGV_FORMS || '' ).trim();

  if ( raw ) {
    try {
      const parsed = JSON.parse( raw );
      if ( ! parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
        console.error( '[render-tools] RENDER_ARGV_FORMS is not a JSON object. Using built-in argv forms.' );
      } else {
        const pinned = parsed[ scriptFile ];
        if ( Array.isArray( pinned ) && pinned.length > 0 ) {
          const clean = pinned
            .filter( ( form ) => Array.isArray( form ) && form.every( ( a ) => typeof a === 'string' ) )
            .slice( 0, MAX_ARGV_FORMS );
          if ( clean.length > 0 ) return clean;
          console.error(
            `[render-tools] RENDER_ARGV_FORMS["${ scriptFile }"] contains no valid form ` +
            '(each form must be an array of strings). Using built-in argv forms.'
          );
        }
      }
    } catch ( err ) {
      console.error( `[render-tools] RENDER_ARGV_FORMS is not valid JSON (${ err.message }). Using built-in argv forms.` );
    }
  }

  return fallback.slice( 0, MAX_ARGV_FORMS );
}

// ---------------------------------------------------------------------------
// Validation
//
// THE RENDERER IS THE SOURCE OF TRUTH. THIS LAYER IS A FAST PRE-CHECK ONLY.
//
// An earlier revision of this module carried full hand-written validators
// derived from the change specification's schema tables (sections 6.1 to 6.4).
// Checking them against the deployed renderers showed the specification's
// tables do not describe the scripts actually on the volume:
//
//   spec_render_common.validate_spec accepts a "subheading" section type, a
//   heading "level" that is optional and ranges 0-9, a callout style of
//   "success", a "cover" that may be boolean, a text section with no "text"
//   key, and a table with no "headers". The spec tables list none of those.
//
//   xlsx_render.validate_spec accepts "metadata.title" in place of "title",
//   a sheet with no "name", a sheet with headers OR rows rather than both,
//   and "col_widths" as an OBJECT. The spec table describes "column_widths"
//   as an array of numbers.
//
//   pptx_render.validate_spec models a slide as {elements: [...]} with its own
//   element type set. The spec table describes layout/bullets/table/notes.
//
// A gateway validator written from the tables therefore REJECTS SPECS THE
// RENDERER WOULD HAVE ACCEPTED. That is the worst available failure here: it
// turns a working document into a validation error, and it does so for content
// that renders correctly through script_execute today. Anyone migrating from
// script_execute to these tools would see documents start failing.
//
// Duplicating the real validators instead would be correct only until one of
// them changes, and nothing would catch the drift: the gateway would keep
// rejecting a section type the renderer had just learned.
//
// So the functions below check ONLY the two conditions every renderer's
// validate_spec checks first and identically -- the spec is an object, and the
// required top-level collection is a non-empty array. Everything else is
// delegated:
//
//   dry_run          -> the renderer's own --dry-run flag, which runs the
//                       authoritative validator and writes nothing.
//   a real render    -> the renderer validates before writing, and exits with
//                       code VALIDATION_FAILED and an "errors" array, which
//                       this module surfaces as error_kind "invalid_spec".
//
// The pre-check exists so an obviously malformed call fails in microseconds
// without a subprocess, and so the caller gets the same shape of answer either
// way. It must never reject anything the renderer would accept.
// ---------------------------------------------------------------------------

/**
 * Section types the deployed document renderer accepts.
 *
 * Mirrors VALID_SECTION_TYPES in spec_render_common.py. Used ONLY to document
 * the tool schema for the calling model. It is deliberately NOT used to reject
 * a section: the renderer decides, for the reasons in the block above.
 */
export const SECTION_TYPES = new Set( [
  'heading', 'text', 'paragraph', 'subheading',
  'table', 'svg', 'image',
  'bullet_list', 'numbered_list', 'quote', 'callout', 'key_stats',
  'divider', 'page_break',
] );

/**
 * Callout styles the deployed renderer accepts. Documentation only, as above.
 *
 * Mirrors VALID_CALLOUT_STYLES in spec_render_common.py. Note "success", which
 * the change specification's table omits.
 */
export const CALLOUT_STYLES = [ 'info', 'warning', 'success', 'tip', 'error' ];

/** pdf_render modes. This one IS a gateway concept, so the gateway owns it. */
const PDF_MODES = new Set( [ 'from_docx', 'from_spec' ] );

/**
 * Input keys that would, if honoured, let a caller choose what executable runs.
 *
 * None appear in any tool schema, so a well-formed call never carries one. They
 * are enumerated so a call that DOES carry one is reported rather than silently
 * cleaned, which is what spec test T10 asks for.
 */
const INJECTION_KEYS = new Set( [
  'script_path', 'script', 'scriptPath', 'renderer', 'renderer_path', 'rendererPath',
  'command', 'cmd', 'argv', 'args', 'executable', 'binary', 'interpreter',
  'python', 'python_bin', 'shell', 'entrypoint', 'module', 'exec',
] );

/**
 * @param {unknown} v
 * @returns {boolean} True for a plain, non-array object.
 */
function isPlainObject( v ) {
  return Boolean( v ) && typeof v === 'object' && ! Array.isArray( v );
}

/**
 * @param {unknown} v
 * @returns {boolean} True for a string with at least one non-space character.
 */
function isNonEmptyString( v ) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Shared pre-check: an object with a non-empty array under `key`.
 *
 * Mirrors the opening lines of every renderer's validate_spec, which return
 * early on exactly these two conditions. Nothing deeper is checked here.
 *
 * @param {unknown} spec
 * @param {string} key          "sections", "sheets" or "slides".
 * @param {boolean} allowMetaTitle  xlsx_render accepts metadata.title too.
 * @returns {string[]} Errors, empty when the pre-check passes.
 */
function precheckSpec( spec, key, allowMetaTitle = false ) {
  if ( ! isPlainObject( spec ) ) {
    return [ `spec: must be a JSON object, got ${ Array.isArray( spec ) ? 'array' : typeof spec }.` ];
  }

  /** @type {string[]} */
  const errors = [];

  const hasTitle = isNonEmptyString( spec.title )
    || ( allowMetaTitle && isPlainObject( spec.metadata ) && isNonEmptyString( spec.metadata.title ) );

  if ( ! hasTitle ) {
    errors.push(
      allowMetaTitle
        ? "spec.title: required, must be a non-empty string (or metadata.title). It becomes the filename slug."
        : 'spec.title: required, must be a non-empty string. It becomes the filename slug.'
    );
  }

  const collection = spec[ key ];
  if ( ! Array.isArray( collection ) || collection.length === 0 ) {
    errors.push( `spec.${ key }: required, must be a non-empty array.` );
  }

  return errors;
}

/**
 * Pre-check a document_render spec. See the block comment above.
 *
 * @param {unknown} spec
 * @returns {string[]}
 */
export function validateDocumentSpec( spec ) {
  return precheckSpec( spec, 'sections' );
}

/**
 * Pre-check an xlsx_render spec.
 *
 * @param {unknown} spec
 * @returns {string[]}
 */
export function validateSheetsSpec( spec ) {
  return precheckSpec( spec, 'sheets', true );
}

/**
 * Pre-check a pptx_render spec.
 *
 * @param {unknown} spec
 * @returns {string[]}
 */
export function validateSlidesSpec( spec ) {
  return precheckSpec( spec, 'slides' );
}

/**
 * Validate pdf_render input.
 *
 * Unlike the three above, this is NOT a thin pre-check, because `mode`,
 * `source_path`, `source_url` and `output_name` are gateway concepts that no
 * renderer knows about. convert_docx_to_pdf.py receives only a resolved path
 * and a slug. So the gateway owns these rules in full.
 *
 * The embedded document spec in from_spec mode still gets only the pre-check,
 * because that part is the renderer's to judge.
 *
 * @param {unknown} input  The full tool input.
 * @returns {string[]} Errors, empty when valid.
 */
export function validatePdfInput( input ) {
  /** @type {string[]} */
  const errors = [];

  if ( ! isPlainObject( input ) ) return [ 'input: must be a JSON object.' ];

  const mode = input.mode;

  if ( ! isNonEmptyString( mode ) || ! PDF_MODES.has( mode ) ) {
    errors.push( `mode: required, must be one of ${ [ ...PDF_MODES ].join( ', ' ) }.` );
    // Without a mode nothing further is worth checking; every remaining rule
    // branches on it and would only add noise.
    return errors;
  }

  if ( mode === 'from_docx' ) {
    if ( ! isNonEmptyString( input.source_path ) && ! isNonEmptyString( input.source_url ) ) {
      errors.push( 'source_path or source_url: required in from_docx mode, naming the input DOCX.' );
    }
  } else if ( input.spec === undefined ) {
    errors.push( 'spec: required in from_spec mode (the same content spec document_render accepts).' );
  } else {
    errors.push( ...validateDocumentSpec( input.spec ) );
  }

  if ( input.options !== undefined ) {
    if ( ! isPlainObject( input.options ) ) {
      errors.push( 'options: must be an object when present.' );
    } else if ( input.options.faithful !== undefined && typeof input.options.faithful !== 'boolean' ) {
      errors.push( 'options.faithful: must be a boolean when present.' );
    }
  }

  if ( input.output_name !== undefined ) {
    if ( ! isNonEmptyString( input.output_name ) ) {
      errors.push( 'output_name: must be a non-empty string when present.' );
    } else if ( ! isSafeFilename( input.output_name.trim() ) ) {
      errors.push( 'output_name: must be a single filename using only letters, digits, dot, dash and underscore.' );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a payload in the MCP content shape.
 *
 * Every other tool module in src/tools returns this shape; script-execute.js
 * returns a bare object and relies on the JSON.stringify fallback in the
 * /tool-call endpoint. The MCP shape is used here because it is correct on both
 * transports rather than only one.
 *
 * @param {object} payload
 * @param {boolean} [isError=false]
 * @returns {{content: Array<{type: string, text: string}>, isError: boolean}}
 */
function mcp( payload, isError = false ) {
  return {
    content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ],
    isError,
  };
}

/**
 * Build a structured error result.
 *
 * @param {string} tool
 * @param {string} kind   Machine-readable classifier.
 * @param {string} message
 * @param {object} [extra]
 * @returns {{content: Array<object>, isError: boolean}}
 */
function failure( tool, kind, message, extra = {} ) {
  return mcp( { ok: false, tool, error_kind: kind, error: message, ...extra }, true );
}

/**
 * Trim long subprocess output to a readable tail.
 *
 * The tail rather than the head, because a Python traceback puts the actual
 * exception last.
 *
 * @param {string} text
 * @returns {string}
 */
function tail( text ) {
  const s = String( text || '' );
  if ( s.length <= OUTPUT_TAIL_CHARS ) return s;
  return `...[truncated ${ s.length - OUTPUT_TAIL_CHARS } chars]...\n${ s.slice( -OUTPUT_TAIL_CHARS ) }`;
}

/**
 * Report tool-input keys that would have chosen an executable.
 *
 * @param {object} input
 * @returns {string[]} Offending key names, empty when the call is clean.
 */
export function detectInjectionKeys( input ) {
  if ( ! isPlainObject( input ) ) return [];
  return Object.keys( input ).filter( ( k ) => INJECTION_KEYS.has( k ) );
}

/**
 * Map a renderer's own error code to a gateway error_kind.
 *
 * Every renderer routes through doc_common.json_main, which guarantees exactly
 * one JSON object on stdout on every exit path, carrying a "success" boolean
 * and, on failure, an "error" string and a "code". Those codes are far more
 * specific than an exit status, so they are used in preference to it.
 *
 * The distinction that matters most is VALIDATION_FAILED. A spec the gateway
 * pre-check passed but the renderer rejected is a caller problem with a fixable
 * list of errors, not an infrastructure failure, and reporting it as
 * "render_failed" would send the caller looking in the wrong place.
 *
 * @param {string} code  The renderer's code field.
 * @returns {string|null} A gateway error_kind, or null when unrecognised.
 */
function classifyRendererCode( code ) {
  switch ( String( code || '' ).toUpperCase() ) {
    case 'VALIDATION_FAILED':
      return 'invalid_spec';
    case 'LIBREOFFICE_MISSING':
      return 'pdf_pipeline_unavailable';
    case 'FILE_NOT_FOUND':
      return 'source_not_found';
    case 'WRONG_EXTENSION':
      return 'invalid_source';
    case 'EMPTY_OUTPUT':
      return 'no_output_produced';
    case 'SPEC_TOO_LARGE':
      return 'spec_too_large';
    case 'CONVERSION_FAILED':
    case 'UNHANDLED_EXCEPTION':
    case 'INTERRUPTED':
    case 'ERROR':
      return 'render_failed';
    default:
      return null;
  }
}

/**
 * Interpret a renderer run through its JSON envelope.
 *
 * Returns a failure descriptor when the renderer reported one, or null when the
 * run should be treated as successful.
 *
 * The envelope is trusted over the exit status for the FAILURE reason, but not
 * for success: a renderer that claims success while writing nothing is still
 * caught downstream by the downloads diff. Claim and effect are checked
 * separately on purpose.
 *
 * @param {object} run       Result of runRenderer().
 * @param {object|null} envelope  Parsed stdout contract, if any.
 * @returns {{kind: string, message: string, errors?: string[], code?: string}|null}
 */
function interpretRendererFailure( run, envelope ) {
  const reportedFailure = isPlainObject( envelope ) && envelope.success === false;

  if ( ! reportedFailure && run.ok ) return null;

  if ( reportedFailure ) {
    const kind = classifyRendererCode( envelope.code ) || 'render_failed';
    const errors = Array.isArray( envelope.errors ) ? envelope.errors : undefined;

    return {
      kind,
      code: envelope.code ? String( envelope.code ) : undefined,
      errors,
      message: isNonEmptyString( envelope.error )
        ? String( envelope.error )
        : `The renderer reported failure with code ${ envelope.code || 'ERROR' }.`,
    };
  }

  // Non-zero exit with no parseable envelope. json_main should make this
  // impossible, so reaching here means the process died before Python ran its
  // handler: an import error, an OOM kill, or a signal.
  return {
    kind: 'render_failed',
    message:
      `The renderer exited with code ${ run.status }${ run.signal ? ` (signal ${ run.signal })` : '' } ` +
      'without emitting a JSON result. This usually means it failed before its own error handler ran, ' +
      'such as an import error or the process being killed.',
  };
}

// ---------------------------------------------------------------------------
// Subprocess execution
// ---------------------------------------------------------------------------

/**
 * Locate the Python interpreter.
 *
 * Mirrors src/tools/script-execute.js: Railway manages Python through mise,
 * which places shims outside /usr/bin.
 *
 * @returns {string}
 */
function pythonBin() {
  return existsSync( '/mise/shims/python3' ) ? '/mise/shims/python3' : 'python3';
}

/**
 * Argparse rejection signatures.
 *
 * The first pattern is the one that matters and is copied in intent from
 * Gateway Service lib/turn-supervisor.js RAW_FAILURE_MARKERS: argparse prints a
 * usage block followed by an `error:` line and exits before main() runs.
 */
const ARGPARSE_USAGE_BLOCK = /^usage:[\s\S]*?\berror:/im;
const ARGPARSE_ERROR_TOKENS =
  /unrecognized arguments|unrecognised arguments|no such option|invalid choice|the following arguments are required|expected one argument|too few arguments/i;

/**
 * Did the process reject its argv rather than fail during work?
 *
 * This is the ONLY condition under which a different argv form is attempted. A
 * runtime failure means the script ran, so retrying it could duplicate an
 * effect that already landed.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {boolean}
 */
export function isArgvRejection( stdout, stderr ) {
  const text = `${ stderr || '' }\n${ stdout || '' }`;
  return ARGPARSE_USAGE_BLOCK.test( text ) || ARGPARSE_ERROR_TOKENS.test( text );
}

/**
 * Substitute placeholders in one argv form.
 *
 * Values are absolute paths this module computed. They never reach a shell:
 * spawnSync is called with an argument array and no shell option.
 *
 * @param {string[]} form
 * @param {Record<string, string>} values
 * @returns {string[]}
 */
function renderArgv( form, values ) {
  return form.map( ( token ) =>
    token.replace( /\{(\w+)\}/g, ( whole, key ) =>
      Object.prototype.hasOwnProperty.call( values, key ) ? values[ key ] : whole
    )
  );
}

/**
 * Resolve a renderer script to an absolute path inside the scripts directory.
 *
 * Three distinct failures are distinguished, because they call for three
 * different operator actions:
 *
 *   scripts_dir_missing  -- the volume is not mounted, or a snapshot revert
 *                           removed it. This is spec failure mode 4.5.
 *   renderer_rejected    -- the configured name escapes the directory or
 *                           resolves through a symlink.
 *   renderer_missing     -- the directory is there but the script is not.
 *
 * @param {string} scriptFile
 * @returns {{ok: true, path: string} | {ok: false, kind: string, message: string}}
 */
export function resolveRenderer( scriptFile ) {
  const base = scriptsBase();

  if ( ! existsSync( base ) ) {
    return {
      ok: false,
      kind: 'scripts_dir_missing',
      message:
        `The renderer scripts directory ${ base } does not exist. Set SCRIPTS_DIR, or restore the ` +
        'Railway volume. Document rendering cannot run until the renderer scripts are present.',
    };
  }

  if ( ! scriptFile.endsWith( '.py' ) ) {
    return {
      ok: false,
      kind: 'renderer_rejected',
      message: `Configured renderer "${ scriptFile }" is not a .py file. Only Python renderers can be run.`,
    };
  }

  const full = resolveContained( base, scriptFile );

  if ( ! full ) {
    return {
      ok: false,
      kind: 'renderer_rejected',
      message:
        `Configured renderer "${ scriptFile }" resolves outside ${ base }, or through a symbolic link. ` +
        'Check the RENDER_SCRIPT_* environment variables.',
    };
  }

  if ( ! existsSync( full ) ) {
    return {
      ok: false,
      kind: 'renderer_missing',
      message:
        `Renderer ${ scriptFile } was not found in ${ base }. Deploy it to the volume, or restore the ` +
        'volume snapshot. Run script_list to see which scripts are currently present.',
    };
  }

  return { ok: true, path: full };
}

/**
 * Run a renderer, walking the argv ladder on argparse rejection only.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath   Absolute, already contained and verified.
 * @param {string} opts.scriptFile   Filename, used as the scriptEnv manifest key.
 * @param {string[][]} opts.forms    Ordered candidate argv forms.
 * @param {Record<string,string>} opts.values  Placeholder substitutions.
 * @param {string} opts.outputDir    Exposed to the child as SCRIPT_OUTPUT_DIR.
 * @returns {{
 *   ok: boolean, status: number|null, signal: string|null, stdout: string, stderr: string,
 *   argv: string[], form_index: number, attempts: Array<{argv: string[], status: number|null, rejected: boolean}>,
 *   timed_out: boolean, spawn_error: string|null, elapsed_ms: number
 * }}
 */
export function runRenderer( opts ) {
  const { scriptPath, scriptFile, forms, values, outputDir } = opts;
  const timeout = renderTimeoutMs();
  const env = buildScriptEnv( { outputDir, scriptKey: scriptFile } );
  const bin = pythonBin();

  /** @type {Array<{argv: string[], status: number|null, rejected: boolean}>} */
  const attempts = [];
  const started = Date.now();

  let last = null;

  for ( let i = 0; i < forms.length; i += 1 ) {
    const argv = renderArgv( forms[ i ], values );

    const result = spawnSync( bin, [ scriptPath, ...argv ], {
      cwd: scriptsBase(),
      timeout,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      env,
    } );

    if ( result.error ) {
      // A spawn-level failure (ENOENT on the interpreter, EACCES) is not an
      // argv problem, so the ladder stops here.
      return {
        ok: false,
        status: null,
        signal: null,
        stdout: '',
        stderr: `spawn failed: ${ result.error.code || result.error.message }`,
        argv,
        form_index: i,
        attempts,
        timed_out: false,
        spawn_error: result.error.message || String( result.error ),
        elapsed_ms: Date.now() - started,
      };
    }

    const stdout = result.stdout?.toString() || '';
    const stderr = result.stderr?.toString() || '';
    const status = result.status;
    const signal = result.signal || null;

    last = {
      ok: status === 0,
      status,
      signal,
      stdout,
      stderr,
      argv,
      form_index: i,
      attempts,
      timed_out: signal === 'SIGTERM',
      spawn_error: null,
      elapsed_ms: Date.now() - started,
    };

    if ( status === 0 ) {
      attempts.push( { argv, status, rejected: false } );
      return last;
    }

    const rejected = isArgvRejection( stdout, stderr );
    attempts.push( { argv, status, rejected } );

    if ( ! rejected ) {
      // The script ran and failed. Retrying with different flags would not
      // help, and could duplicate a partial effect.
      return last;
    }

    console.error(
      `[render-tools] ${ scriptFile } rejected argv form ${ i + 1 }/${ forms.length } ` +
      `(${ argv.join( ' ' ) }). Trying the next form.`
    );
  }

  return last || {
    ok: false,
    status: null,
    signal: null,
    stdout: '',
    stderr: 'No argv form was attempted; the configured ladder was empty.',
    argv: [],
    form_index: -1,
    attempts,
    timed_out: false,
    spawn_error: null,
    elapsed_ms: Date.now() - started,
  };
}

/**
 * Extract the renderer's JSON contract from its stdout (spec section 7, step 6).
 *
 * Renderers print progress lines before the contract, so a plain JSON.parse of
 * the whole stream is not sufficient. The last balanced top-level object is
 * taken, which is the contract in every observed case.
 *
 * @param {string} stdout
 * @returns {object|null} Parsed contract, or null when none is present.
 */
export function parseRendererContract( stdout ) {
  const text = String( stdout || '' ).trim();
  if ( ! text ) return null;

  // Fast path: the whole stream is the contract.
  if ( text.startsWith( '{' ) && text.endsWith( '}' ) ) {
    try {
      const parsed = JSON.parse( text );
      if ( isPlainObject( parsed ) ) return parsed;
    } catch { /* fall through to the scan */ }
  }

  // Scan backwards for the last balanced top-level object. Brace counting is
  // string-aware so that a brace inside a JSON string value does not unbalance
  // the count.
  for ( let start = text.lastIndexOf( '{' ); start >= 0; start = text.lastIndexOf( '{', start - 1 ) ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for ( let i = start; i < text.length; i += 1 ) {
      const ch = text[ i ];

      if ( inString ) {
        if ( escaped ) escaped = false;
        else if ( ch === '\\' ) escaped = true;
        else if ( ch === '"' ) inString = false;
        continue;
      }

      if ( ch === '"' ) { inString = true; continue; }
      if ( ch === '{' ) { depth += 1; continue; }
      if ( ch === '}' ) {
        depth -= 1;
        if ( depth === 0 ) {
          try {
            const parsed = JSON.parse( text.slice( start, i + 1 ) );
            if ( isPlainObject( parsed ) ) return parsed;
          } catch { /* not the contract; keep scanning */ }
          break;
        }
      }
    }

    if ( start === 0 ) break;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Serialize and size-check a spec, then write it to the staging directory.
 *
 * The size check runs against the SERIALIZED bytes, which is the quantity the
 * spec names, and it happens before any file is created so that an oversized
 * call leaves nothing behind.
 *
 * @param {object} spec
 * @param {string} tool
 * @returns {{ok: true, path: string, bytes: number} | {ok: false, kind: string, message: string, bytes?: number, limit?: number}}
 */
function stageSpec( spec, tool ) {
  let serialized;

  try {
    serialized = JSON.stringify( spec );
  } catch ( err ) {
    return {
      ok: false,
      kind: 'spec_not_serializable',
      message: `The spec could not be serialized to JSON: ${ err.message }. Circular references are not supported.`,
    };
  }

  if ( typeof serialized !== 'string' ) {
    return { ok: false, kind: 'spec_not_serializable', message: 'The spec serialized to undefined. It must be a JSON object.' };
  }

  const bytes = Buffer.byteLength( serialized, 'utf8' );
  const limit = specMaxBytes();

  if ( bytes > limit ) {
    return {
      ok: false,
      kind: 'spec_too_large',
      message:
        `The serialized spec is ${ bytes } bytes, which exceeds the ${ limit } byte limit. ` +
        'Nothing was rendered and nothing was truncated. Either split the content across separate ' +
        'documents, use more concise section types, or raise RENDER_SPEC_MAX_BYTES.',
      bytes,
      limit,
    };
  }

  const dir = stagingBase();

  try {
    mkdirSync( dir, { recursive: true } );
  } catch ( err ) {
    return { ok: false, kind: 'staging_unavailable', message: `Could not create the staging directory ${ dir }: ${ err.message }` };
  }

  const stamp = `${ Date.now() }_${ Math.random().toString( 36 ).slice( 2, 9 ) }`;
  const path = joinPath( dir, `${ tool }_${ stamp }.json` );

  try {
    writeFileSync( path, serialized, 'utf8' );
  } catch ( err ) {
    return { ok: false, kind: 'staging_unavailable', message: `Could not write the spec to ${ path }: ${ err.message }` };
  }

  return { ok: true, path, bytes };
}

/**
 * Remove a staged spec file. Never throws.
 *
 * @param {string|null} path
 * @returns {void}
 */
function cleanupStaged( path ) {
  if ( ! path ) return;
  try { unlinkSync( path ); } catch { /* already gone, or never written */ }
}

// ---------------------------------------------------------------------------
// Download-contract assembly
// ---------------------------------------------------------------------------

/**
 * Files this renderer produced, and the links for them.
 *
 * The connector builds the links itself rather than trusting the renderer's own
 * url fields. See the header of src/utils/downloadLinks.js: the alternative
 * routes a long-lived credential through the model's context.
 *
 * `declared` carries the renderer's own download_files list. Without it,
 * buildDownloadLinks reports only files whose bytes CHANGED since the snapshot,
 * so re-rendering an unchanged document would return an empty link set and the
 * caller would be told nothing was produced. doc_common.declared_download_files
 * exists for exactly this handover.
 *
 * @param {Map<string,string>} before  snapshotDownloads() taken before the run.
 * @param {string} expectedExt         Primary output extension, e.g. ".docx".
 * @param {string[]} [declared]        Filenames the renderer says it published.
 * @returns {{links: object[], warnings: string[], primary: object|null, preview: object|null}}
 */
function collectOutputs( before, expectedExt, declared = [] ) {
  let links = [];
  let warnings = [];

  try {
    const built = buildDownloadLinks( { before, declared } );
    links = built.links;
    warnings = built.warnings;
  } catch ( err ) {
    warnings = [ `Download links could not be built: ${ err.message }` ];
  }

  for ( const w of warnings ) console.error( `[render-tools] download link warning: ${ w }` );

  const primary = links.find( ( l ) => extname( l.filename ).toLowerCase() === expectedExt ) || null;
  const preview = links.find( ( l ) => extname( l.filename ).toLowerCase() === '.html' ) || null;

  return { links, warnings, primary, preview };
}

// ---------------------------------------------------------------------------
// Shared spec-renderer handler
// ---------------------------------------------------------------------------

/**
 * The procedural sequence from spec section 7, shared by the three spec-driven
 * formats. Only the renderer script, pre-check and output extension differ,
 * which is why one handler serves all three.
 *
 * Sequence:
 *   1. Report and ignore any executable-selecting input key (T10).
 *   2. Pre-check the spec cheaply; fail without spawning if it is malformed.
 *   3. Resolve the renderer from a gateway constant.
 *   4. Enforce the serialized-size ceiling, then stage the spec to disk.
 *   5. Run the renderer (with --dry-run when the caller asked for a dry run).
 *   6. Interpret the JSON envelope; classify a renderer-reported failure.
 *   7. Build download links from the downloads diff plus the renderer's own
 *      declared download_files.
 *
 * @param {object} cfg
 * @param {string} cfg.tool        Tool name, e.g. "document_render".
 * @param {string} cfg.scriptFile  Renderer filename from rendererScripts().
 * @param {(spec: unknown) => string[]} cfg.validate  Cheap pre-check.
 * @param {string} cfg.ext         Primary output extension, e.g. ".docx".
 * @param {(spec: object) => object} cfg.counts  Per-format count fields.
 * @param {object} input           Raw tool input.
 * @returns {Promise<object>} MCP result.
 */
async function handleSpecRender( cfg, input ) {
  const { tool, scriptFile, validate, ext, counts } = cfg;
  const args = isPlainObject( input ) ? input : {};

  // ---- Step 1: T10. The schemas carry no script path, so any such key is
  // caller noise or an injection attempt. Either way it is ignored, and said.
  const ignored = detectInjectionKeys( args );
  if ( ignored.length > 0 ) {
    console.error(
      `[render-tools] ${ tool }: ignoring caller-supplied ${ ignored.join( ', ' ) }; ` +
      'the renderer path is a gateway constant.'
    );
  }

  const dryRun = args.dry_run === true;

  // The renderer reads user_id/tenant_id/ttl_days straight out of the spec and
  // uses them to register the document in the user's sidebar
  // (doc_common.register_document). They are passed through untouched; the
  // gateway has no business editing them, and coerce_user_id already handles a
  // string id on the renderer side.
  const spec = args.spec;

  // ---- Step 2: cheap pre-check. Deep validation belongs to the renderer.
  const preErrors = validate( spec );

  if ( preErrors.length > 0 ) {
    // Malformed enough that the renderer would reject it too. Answering here
    // avoids a subprocess and keeps the dry_run/real shapes consistent.
    if ( dryRun ) {
      return mcp( {
        ok: true,
        tool,
        dry_run: true,
        valid: false,
        errors: preErrors,
        validated_by: 'gateway_precheck',
        ...( ignored.length ? { ignored_parameters: ignored } : {} ),
        note: 'Dry run: the spec was rejected by the gateway pre-check and no file was written.',
      } );
    }
    return failure(
      tool,
      'invalid_spec',
      `The spec failed the gateway pre-check with ${ preErrors.length } error${ preErrors.length === 1 ? '' : 's' }. Nothing was rendered.`,
      { errors: preErrors, validated_by: 'gateway_precheck', ...( ignored.length ? { ignored_parameters: ignored } : {} ) }
    );
  }

  // ---- Step 3: resolve the renderer from a gateway-side constant.
  const resolved = resolveRenderer( scriptFile );
  if ( ! resolved.ok ) {
    return failure( tool, resolved.kind, resolved.message, {
      renderer: scriptFile,
      scripts_dir: scriptsBase(),
      ...( ignored.length ? { ignored_parameters: ignored } : {} ),
    } );
  }

  // ---- Step 4: size ceiling, then stage to disk.
  //
  // The ceiling is enforced for a dry run as well. A dry run's purpose is to
  // answer "would this render", and a spec over the limit would not, so
  // reporting it valid would make the dry run actively misleading.
  const staged = stageSpec( spec, tool );
  if ( ! staged.ok ) {
    if ( dryRun && staged.kind === 'spec_too_large' ) {
      return mcp( {
        ok: true,
        tool,
        dry_run: true,
        valid: false,
        errors: [ staged.message ],
        spec_bytes: staged.bytes,
        spec_max_bytes: staged.limit,
        validated_by: 'gateway_precheck',
        ...( ignored.length ? { ignored_parameters: ignored } : {} ),
        note: 'Dry run: the spec exceeds the size ceiling and no file was written.',
      } );
    }
    return failure( tool, staged.kind, staged.message, {
      ...( staged.bytes !== undefined ? { spec_bytes: staged.bytes } : {} ),
      ...( staged.limit !== undefined ? { spec_max_bytes: staged.limit } : {} ),
      ...( ignored.length ? { ignored_parameters: ignored } : {} ),
    } );
  }

  const before = dryRun ? new Map() : snapshotDownloads();

  try {
    // ---- Step 5: invoke.
    //
    // --dry-run is the renderers' own flag. Delegating to it means the verdict
    // comes from the same validate_spec a real render would use, so a dry run
    // that passes cannot be followed by a render that fails validation. A
    // gateway reimplementation could never guarantee that.
    const forms = argvFormsFor( scriptFile, DEFAULT_SPEC_ARGV_FORMS )
      .map( ( form ) => ( dryRun ? [ ...form, '--dry-run' ] : form ) );

    const run = runRenderer( {
      scriptPath: resolved.path,
      scriptFile,
      forms,
      values: { spec: staged.path, output_dir: stagingBase() },
      outputDir: stagingBase(),
    } );

    if ( run.spawn_error ) {
      return failure( tool, 'interpreter_unavailable',
        `Python could not be started: ${ run.spawn_error }. Check that python3 is installed on the connector service.`,
        { renderer: scriptFile } );
    }

    if ( run.timed_out ) {
      return failure( tool, 'render_timeout',
        `${ scriptFile } exceeded the ${ Math.round( renderTimeoutMs() / 1000 ) } second render timeout. ` +
        'Raise RENDER_TIMEOUT_SECONDS, or reduce the size of the document.',
        { renderer: scriptFile, spec_bytes: staged.bytes, stderr_tail: tail( run.stderr ) } );
    }

    // ---- Step 6: the envelope decides why a run failed.
    const envelope = parseRendererContract( run.stdout );
    const problem = interpretRendererFailure( run, envelope );

    // A dry run reports a verdict rather than an error: "this spec is invalid"
    // is the answer the caller asked for, not a tool malfunction.
    if ( dryRun ) {
      if ( problem && problem.kind === 'invalid_spec' ) {
        return mcp( {
          ok: true,
          tool,
          dry_run: true,
          valid: false,
          errors: problem.errors || [ problem.message ],
          validated_by: 'renderer',
          renderer: scriptFile,
          spec_bytes: staged.bytes,
          ...( ignored.length ? { ignored_parameters: ignored } : {} ),
          note: 'Dry run: the renderer validated the spec and wrote no file.',
        } );
      }

      if ( problem ) {
        // A dry run that could not complete is a genuine failure, distinct
        // from a spec that is merely invalid.
        return failure( tool, problem.kind, problem.message, {
          renderer: scriptFile,
          renderer_code: problem.code,
          dry_run: true,
          stdout_tail: tail( run.stdout ),
          stderr_tail: tail( run.stderr ),
        } );
      }

      return mcp( {
        ok: true,
        tool,
        dry_run: true,
        valid: true,
        errors: [],
        validated_by: 'renderer',
        renderer: scriptFile,
        spec_bytes: staged.bytes,
        spec_max_bytes: specMaxBytes(),
        ...counts( spec ),
        ...( envelope && envelope.summary ? { summary: envelope.summary } : {} ),
        ...( ignored.length ? { ignored_parameters: ignored } : {} ),
        note: 'Dry run: the renderer validated the spec and wrote no file.',
      } );
    }

    if ( problem ) {
      const argvExhausted = run.attempts.length > 0 && run.attempts.every( ( a ) => a.rejected );
      return failure(
        tool,
        argvExhausted ? 'renderer_argv_mismatch' : problem.kind,
        argvExhausted
          ? `${ scriptFile } rejected every configured argument form. Its command line has changed. ` +
            'Pin the correct form through RENDER_ARGV_FORMS.'
          : problem.message,
        {
          renderer: scriptFile,
          renderer_code: problem.code,
          spec_bytes: staged.bytes,
          ...( problem.errors ? { errors: problem.errors, validated_by: 'renderer' } : {} ),
          argv_attempts: run.attempts.map( ( a ) => ( { argv: a.argv, exit_code: a.status, argv_rejected: a.rejected } ) ),
          stdout_tail: tail( run.stdout ),
          stderr_tail: tail( run.stderr ),
        }
      );
    }

    // ---- Step 7: register the outputs.
    //
    // The renderer declares exactly which filenames it published, in
    // download_files. Passing them as `declared` matters because
    // buildDownloadLinks otherwise reports only files whose bytes CHANGED: a
    // re-render producing byte-identical output would return no links at all,
    // and the caller would be told nothing was produced.
    const declared = Array.isArray( envelope?.download_files )
      ? envelope.download_files.filter( ( f ) => typeof f === 'string' && f )
      : [];

    const { links, warnings, primary, preview } = collectOutputs( before, ext, declared );

    if ( links.length === 0 ) {
      // Exit 0, success envelope, but no signed links. Distinguish the two
      // causes, because they demand different operator actions:
      //
      //   1. No file at all on disk  -> genuine no_output_produced.
      //   2. A file exists but buildDownloadLinks could not build a URL
      //      (CONNECTOR_URL unset, token missing) -> partial: deliverable
      //      exists locally, only the shareable link is unavailable.
      //
      // The following existence check runs against the same directory the
      // connector diffs, so it cannot disagree about what was produced.
      const dirExists = existsSync( downloadsBase() );
      const produced = dirExists && readdirSync( downloadsBase() ).some( name => name.endsWith(ext) );

      if ( produced ) {
        const urlIssue = ! isNonEmptyString( process.env.CONNECTOR_URL )
          ? 'CONNECTOR_URL_NOT_SET'
          : 'DOWNLOAD_LINK_UNBUILDABLE';

        return mcp( {
          ok: true,
          tool,
          format: ext.replace( '.', '' ),
          renderer: scriptFile,
          spec_bytes: staged.bytes,
          ...counts( spec ),
          partial: true,
          partial_reason: urlIssue,
          message: `${ scriptFile } ran successfully and wrote a ${ ext } file to ${ downloadsBase() }, but a shareable link could not be built (CONNECTOR_URL is ${ process.env.CONNECTOR_URL ? 'set' : 'not set' }). The file is on disk and available through the downloads directory.`,
          download_warnings: warnings.length ? warnings : undefined,
          renderer_contract: envelope || undefined,
          ...( ignored.length ? { ignored_parameters: ignored } : {} ),
          execution_time_ms: run.elapsed_ms,
        } );
      }

      return failure( tool, 'no_output_produced',
        `${ scriptFile } reported success but wrote no file to ${ downloadsBase() }. ` +
        'Nothing can be delivered to the user.',
        {
          renderer: scriptFile,
          spec_bytes: staged.bytes,
          renderer_contract: envelope || undefined,
          download_warnings: warnings.length ? warnings : undefined,
          stdout_tail: tail( run.stdout ),
          stderr_tail: tail( run.stderr ),
        } );
    }

    return mcp( {
      ok: true,
      tool,
      format: ext.replace( '.', '' ),
      renderer: scriptFile,
      argv_form: run.argv,
      spec_bytes: staged.bytes,
      spec_max_bytes: specMaxBytes(),
      ...counts( spec ),
      file: primary ? primary.filename : links[ 0 ].filename,
      size_bytes: primary ? primary.size_bytes : links[ 0 ].size_bytes,
      download_url: primary ? primary.download_url : links[ 0 ].download_url,
      preview_url: ( primary && primary.preview_url ) || ( preview && preview.preview_url ) || undefined,
      download_links: links,
      download_warnings: warnings.length ? warnings : undefined,
      renderer_contract: envelope || undefined,
      // The renderer registers the document in the user's sidebar when the
      // spec carries a user_id. Surfacing the outcome means a silently skipped
      // registration is visible rather than being discovered later.
      sidebar_registration: envelope?.sidebar_registration,
      execution_time_ms: run.elapsed_ms,
      ...( ignored.length ? { ignored_parameters: ignored } : {} ),
      ...( run.form_index > 0
        ? { argv_note: `Argument form ${ run.form_index + 1 } was used after earlier forms were rejected. Pin it with RENDER_ARGV_FORMS to remove the probe.` }
        : {} ),
    } );

  } finally {
    cleanupStaged( staged.path );
  }
}

// ---------------------------------------------------------------------------
// PDF source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the DOCX a pdf_render from_docx call names.
 *
 * Deliberately narrow. `source_path` is treated as a single filename and looked
 * for in the downloads directory, then the uploads directory. `source_url` is
 * accepted only when it addresses this connector's own /download/ route, from
 * which the filename is extracted and resolved the same way.
 *
 * Accepting an arbitrary path would reintroduce the traversal class that
 * utils/pathContainment.js exists to close, and accepting an arbitrary URL
 * would make this tool an SSRF primitive reachable from model output. Neither
 * is needed: the real workflow converts a document this connector just
 * produced.
 *
 * @param {object} input
 * @returns {{ok: true, path: string, filename: string, from: string} | {ok: false, kind: string, message: string}}
 */
export function resolvePdfSource( input ) {
  let candidate = '';
  let origin = '';

  if ( isNonEmptyString( input.source_path ) ) {
    candidate = basename( input.source_path.trim() );
    origin = 'source_path';
  } else if ( isNonEmptyString( input.source_url ) ) {
    const url = input.source_url.trim();
    let parsed;

    try {
      parsed = new URL( url );
    } catch {
      return { ok: false, kind: 'invalid_source', message: `source_url "${ url }" is not a valid URL.` };
    }

    if ( parsed.protocol !== 'https:' && parsed.protocol !== 'http:' ) {
      return { ok: false, kind: 'invalid_source', message: 'source_url must be an http or https URL on this connector.' };
    }

    const match = /\/(?:download|preview)\/([^/?#]+)/.exec( parsed.pathname );

    if ( ! match ) {
      return {
        ok: false,
        kind: 'invalid_source',
        message:
          'source_url must address this connector\'s /download/ route, e.g. https://<connector>/download/Report.docx. ' +
          'Arbitrary URLs are not fetched. To convert a document held elsewhere, upload it first.',
      };
    }

    try {
      candidate = decodeURIComponent( match[ 1 ] );
    } catch {
      candidate = match[ 1 ];
    }
    candidate = basename( candidate );
    origin = 'source_url';
  } else {
    return { ok: false, kind: 'invalid_source', message: 'Neither source_path nor source_url was supplied.' };
  }

  if ( ! isSafeFilename( candidate ) ) {
    return {
      ok: false,
      kind: 'invalid_source',
      message:
        `"${ candidate }" is not a valid single filename. Use only letters, digits, dot, dash and underscore. ` +
        'Directory paths are not accepted.',
    };
  }

  if ( extname( candidate ).toLowerCase() !== '.docx' ) {
    return {
      ok: false,
      kind: 'invalid_source',
      message: `pdf_render converts DOCX files. "${ candidate }" is not a .docx file.`,
    };
  }

  for ( const [ label, dir ] of [ [ 'downloads', downloadsBase() ], [ 'uploads', uploadsBase() ] ] ) {
    if ( ! existsSync( dir ) ) continue;
    const full = resolveContained( dir, candidate );
    if ( full && existsSync( full ) ) {
      return { ok: true, path: full, filename: candidate, from: `${ label } (${ origin })` };
    }
  }

  return {
    ok: false,
    kind: 'source_not_found',
    message:
      `"${ candidate }" was not found in ${ downloadsBase() } or ${ uploadsBase() }. ` +
      'Render or upload the DOCX first, then convert it.',
  };
}

/**
 * Choose the PDF output filename.
 *
 * @param {object} input
 * @param {string} sourceFilename
 * @returns {string} A safe single-segment filename ending in .pdf.
 */
function pdfOutputName( input, sourceFilename ) {
  const requested = isNonEmptyString( input.output_name ) ? input.output_name.trim() : '';
  const base = requested || sourceFilename;
  const withoutExt = base.replace( /\.[^.]+$/, '' );
  return `${ withoutExt }.pdf`;
}

// ---------------------------------------------------------------------------
// Tool definitions
//
// inputSchema (camelCase) is the MCP field name. GET /tools normalises it to
// input_schema for the Anthropic-shaped manifest the Gateway Service consumes.
// ---------------------------------------------------------------------------

/** Shared JSON Schema fragment for a document content spec. */
const DOCUMENT_SPEC_SCHEMA = {
  type: 'object',
  description:
    'Document content specification. title and sections are required. Section types: heading ' +
    '{level 1-4, text}, text or paragraph {text}, bullet_list {items}, numbered_list {items}, ' +
    'table {headers, rows}, callout {style info|warning|tip|error, title, text}, quote {text, ' +
    'attribution}, key_stats {items:[{value,label}]}, divider, page_break, svg {content, caption}, ' +
    'image {src, caption, width}.',
  properties: {
    title:     { type: 'string', description: 'Document title. Used for the filename slug.' },
    sections:  { type: 'array', description: 'Ordered list of section objects. Must be non-empty.', items: { type: 'object' } },
    author:    { type: 'string', description: 'Shown on the cover.' },
    date:      { type: 'string', description: 'Shown on the cover.' },
    theme:     { type: 'object', description: 'Colour overrides for heading, text and table.' },
    cover:     { type: 'object', description: 'Cover fields: subtitle, organisation, reference.' },
    toc:       { type: 'boolean', description: 'Include a table of contents.' },
    logo_svg:  { type: 'string', description: 'Raw SVG XML placed centred on the cover.' },
    user_id:   { type: [ 'number', 'string' ], description: 'Optional admin sidebar registration.' },
    tenant_id: { type: [ 'number', 'string' ], description: 'Optional admin sidebar registration.' },
  },
  required: [ 'title', 'sections' ],
};

export const documentRenderToolDefinition = {
  name: 'document_render',
  description:
    'Create a downloadable Word document (.docx) with a matching HTML preview from a structured content ' +
    'spec, and return ready-to-use download and preview URLs. Use this instead of script_execute for any ' +
    'Word document. The gateway resolves the renderer, writes the spec to disk and enforces the size limit, ' +
    'so large documents are never silently truncated: they either complete in full or fail with an explicit ' +
    'size error. Set dry_run to validate a spec without writing a file. Never construct a download URL ' +
    'yourself and never ask for a download token: the returned URLs are complete.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: DOCUMENT_SPEC_SCHEMA,
      dry_run: {
        type: 'boolean',
        description: 'Validate the spec and return valid plus an errors array without writing any file.',
      },
    },
    required: [ 'spec' ],
  },
};

export const pdfRenderToolDefinition = {
  name: 'pdf_render',
  description:
    'Create a downloadable PDF and return ready-to-use download URLs. PDF on this platform is a conversion ' +
    'from a Word document rather than a native render, so there are two modes. mode "from_spec" renders the ' +
    'supplied content spec to DOCX and converts it. mode "from_docx" converts a DOCX this connector already ' +
    'holds, named by source_path (a filename in the downloads or uploads directory) or source_url (a URL on ' +
    'this connector\'s own /download/ route). Set options.faithful to use the styling-preserving conversion ' +
    'pipeline. Use this instead of script_execute for any PDF.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: [ 'from_docx', 'from_spec' ],
        description: 'from_docx converts an existing DOCX. from_spec renders a spec then converts it.',
      },
      source_path: {
        type: 'string',
        description: 'from_docx mode: the DOCX filename in the downloads or uploads directory. Filename only, no directories.',
      },
      source_url: {
        type: 'string',
        description: 'from_docx mode: a URL on this connector\'s /download/ route naming the DOCX. External URLs are not fetched.',
      },
      spec: DOCUMENT_SPEC_SCHEMA,
      options: {
        type: 'object',
        description: 'Conversion options.',
        properties: {
          faithful: { type: 'boolean', description: 'Use the styling-preserving conversion pipeline.' },
        },
      },
      output_name: {
        type: 'string',
        description: 'Override the output filename. A single filename using letters, digits, dot, dash and underscore.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Validate the input and return valid plus an errors array without writing any file.',
      },
    },
    required: [ 'mode' ],
  },
};

export const xlsxRenderToolDefinition = {
  name: 'xlsx_render',
  description:
    'Create a downloadable Excel workbook (.xlsx) from a structured sheet specification and return ' +
    'ready-to-use download URLs. Each sheet needs a name, headers and rows; column_widths, freeze_header ' +
    'and tab_colour are optional. Cells may be strings, numbers, booleans or null. Use this instead of ' +
    'script_execute for any spreadsheet. Set dry_run to validate without writing a file.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'Workbook specification. title and sheets are required.',
        properties: {
          title:  { type: 'string', description: 'Used for the filename slug.' },
          sheets: {
            type: 'array',
            description: 'Ordered sheet definitions. Must be non-empty.',
            items: {
              type: 'object',
              properties: {
                name:          { type: 'string', description: 'Sheet tab name.' },
                headers:       { type: 'array', items: { type: 'string' }, description: 'Column headers, written to row 1.' },
                rows:          { type: 'array', items: { type: 'array' }, description: 'Data rows as arrays of cells.' },
                column_widths: { type: 'array', items: { type: 'number' }, description: 'Per-column width.' },
                freeze_header: { type: 'boolean', description: 'Freeze the header row.' },
                tab_colour:    { type: 'string', description: 'Sheet tab colour, hex without the hash.' },
              },
              required: [ 'name', 'headers', 'rows' ],
            },
          },
          author: { type: 'string' },
          date:   { type: 'string' },
        },
        required: [ 'title', 'sheets' ],
      },
      dry_run: { type: 'boolean', description: 'Validate the spec without writing any file.' },
    },
    required: [ 'spec' ],
  },
};

export const pptxRenderToolDefinition = {
  name: 'pptx_render',
  description:
    'Create a downloadable PowerPoint deck (.pptx) from a structured slide specification and return ' +
    'ready-to-use download URLs. Each slide needs a title; layout (title_only, title_plus_bullets, ' +
    'title_plus_content, blank), bullets, table and speaker notes are optional. aspect is 16x9 by default. ' +
    'Use this instead of script_execute for any slide deck. Set dry_run to validate without writing a file.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'Deck specification. title and slides are required.',
        properties: {
          title:  { type: 'string', description: 'Used for the filename slug.' },
          slides: {
            type: 'array',
            description: 'Ordered slide definitions. Must be non-empty.',
            items: {
              type: 'object',
              properties: {
                title:   { type: 'string', description: 'Slide title.' },
                layout:  { type: 'string', enum: [ 'title_only', 'title_plus_bullets', 'title_plus_content', 'blank' ] },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet content for bullet layouts.' },
                table:   { type: 'object', description: 'Embedded table as {headers, rows}.' },
                notes:   { type: 'string', description: 'Speaker notes.' },
              },
              required: [ 'title' ],
            },
          },
          theme:  { type: 'object', description: 'Colour overrides.' },
          aspect: { type: 'string', enum: [ '16x9', '4x3' ], description: 'Slide aspect ratio. Defaults to 16x9.' },
        },
        required: [ 'title', 'slides' ],
      },
      dry_run: { type: 'boolean', description: 'Validate the spec without writing any file.' },
    },
    required: [ 'spec' ],
  },
};

/**
 * All four definitions, in registration order.
 *
 * Exported as one array so server-http.js has a single thing to spread into
 * TOOLS. A fifth format added later is then a one-line change here rather than
 * an edit in two files that can drift.
 */
export const RENDER_TOOL_DEFINITIONS = [
  documentRenderToolDefinition,
  pdfRenderToolDefinition,
  xlsxRenderToolDefinition,
  pptxRenderToolDefinition,
];

/** The names, for membership tests in the dispatcher and in the tool manifest. */
export const RENDER_TOOL_NAMES = new Set( RENDER_TOOL_DEFINITIONS.map( ( t ) => t.name ) );

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * document_render: DOCX plus HTML preview.
 *
 * @param {object} [input]
 * @returns {Promise<object>} MCP result.
 */
export async function handleDocumentRender( input = {} ) {
  return handleSpecRender( {
    tool: 'document_render',
    scriptFile: rendererScripts().docx,
    validate: validateDocumentSpec,
    ext: '.docx',
    counts: ( spec ) => ( { section_count: Array.isArray( spec?.sections ) ? spec.sections.length : 0 } ),
  }, input );
}

/**
 * xlsx_render: Excel workbook.
 *
 * @param {object} [input]
 * @returns {Promise<object>} MCP result.
 */
export async function handleXlsxRender( input = {} ) {
  return handleSpecRender( {
    tool: 'xlsx_render',
    scriptFile: rendererScripts().xlsx,
    validate: validateSheetsSpec,
    ext: '.xlsx',
    counts: ( spec ) => ( { sheet_count: Array.isArray( spec?.sheets ) ? spec.sheets.length : 0 } ),
  }, input );
}

/**
 * pptx_render: PowerPoint deck.
 *
 * @param {object} [input]
 * @returns {Promise<object>} MCP result.
 */
export async function handlePptxRender( input = {} ) {
  return handleSpecRender( {
    tool: 'pptx_render',
    scriptFile: rendererScripts().pptx,
    validate: validateSlidesSpec,
    ext: '.pptx',
    counts: ( spec ) => ( { slide_count: Array.isArray( spec?.slides ) ? spec.slides.length : 0 } ),
  }, input );
}

/**
 * pdf_render: PDF by conversion from DOCX.
 *
 * from_spec renders the DOCX first through the shared spec handler, then
 * converts whatever .docx that produced. Reusing handleDocumentRender rather
 * than duplicating the sequence means the size ceiling, validation, staging and
 * injection guard apply identically in both tools.
 *
 * @param {object} [input]
 * @returns {Promise<object>} MCP result.
 */
export async function handlePdfRender( input = {} ) {
  const tool = 'pdf_render';
  const args = isPlainObject( input ) ? input : {};

  const ignored = detectInjectionKeys( args );
  if ( ignored.length > 0 ) {
    console.error( `[render-tools] ${ tool }: ignoring caller-supplied ${ ignored.join( ', ' ) }; the converter path is a gateway constant.` );
  }

  const errors = validatePdfInput( args );
  const dryRun = args.dry_run === true;

  if ( dryRun ) {
    return mcp( {
      ok: true,
      tool,
      dry_run: true,
      valid: errors.length === 0,
      errors,
      mode: isNonEmptyString( args.mode ) ? args.mode : null,
      ...( ignored.length ? { ignored_parameters: ignored } : {} ),
      note: 'Dry run: the input was validated and no file was written.',
    } );
  }

  if ( errors.length > 0 ) {
    return failure( tool, 'invalid_spec',
      `The input failed validation with ${ errors.length } error${ errors.length === 1 ? '' : 's' }. Nothing was rendered.`,
      { errors, ...( ignored.length ? { ignored_parameters: ignored } : {} ) } );
  }

  const scripts = rendererScripts();
  const faithful = Boolean( args.options && args.options.faithful );
  const converterFile = faithful ? scripts.pdfFaithful : scripts.pdf;

  // Resolve the converter BEFORE rendering an intermediate DOCX, so a missing
  // conversion pipeline does not leave a stray document behind.
  const converter = resolveRenderer( converterFile );
  if ( ! converter.ok ) {
    return failure( tool, converter.kind === 'renderer_missing' ? 'pdf_pipeline_unavailable' : converter.kind,
      converter.message, {
        renderer: converterFile,
        faithful,
        scripts_dir: scriptsBase(),
        ...( ignored.length ? { ignored_parameters: ignored } : {} ),
      } );
  }

  // ---- Resolve or produce the source DOCX --------------------------------
  /** @type {{ok: true, path: string, filename: string, from: string} | {ok: false, kind: string, message: string}} */
  let source;
  let intermediate = null;

  if ( args.mode === 'from_spec' ) {
    const docxResult = await handleDocumentRender( { spec: args.spec } );

    let docxPayload = null;
    try {
      docxPayload = JSON.parse( docxResult.content[ 0 ].text );
    } catch {
      docxPayload = null;
    }

    if ( docxResult.isError || ! docxPayload || docxPayload.ok !== true ) {
      return failure( tool, 'source_render_failed',
        'The intermediate DOCX could not be rendered, so there is nothing to convert.',
        { docx_stage: docxPayload || undefined, ...( ignored.length ? { ignored_parameters: ignored } : {} ) } );
    }

    intermediate = docxPayload;
    source = resolvePdfSource( { source_path: docxPayload.file } );

    if ( ! source.ok ) {
      return failure( tool, 'source_not_found',
        `The intermediate DOCX "${ docxPayload.file }" could not be located for conversion: ${ source.message }`,
        { docx_stage: docxPayload } );
    }
  } else {
    source = resolvePdfSource( args );
    if ( ! source.ok ) {
      return failure( tool, source.kind, source.message, {
        ...( ignored.length ? { ignored_parameters: ignored } : {} ),
      } );
    }
  }

  // ---- Convert -----------------------------------------------------------
  const outName = pdfOutputName( args, source.filename );
  const outPath = resolveContained( downloadsBase(), outName );

  if ( ! outPath ) {
    return failure( tool, 'invalid_output_name',
      `The output filename "${ outName }" does not resolve inside ${ downloadsBase() }.` );
  }

  // The LibreOffice converter names its output from --pdf-name, which it then
  // slugifies itself; the reportlab converter takes a full --output path. Both
  // are fed from the same requested name so output_name behaves identically
  // whichever pipeline runs.
  const outSlug = outName.replace( /\.pdf$/i, '' );

  // source.path is ABSOLUTE. doc_common.resolve_upload_path prepends
  // UPLOADS_DIR to a relative value, so a bare filename for a file living in
  // the downloads directory would fail to resolve. An absolute path inside
  // either approved directory resolves correctly.
  const before = snapshotDownloads();

  const run = runRenderer( {
    scriptPath: converter.path,
    scriptFile: converterFile,
    forms: argvFormsFor( converterFile, faithful ? PDF_ARGV_FORMS.faithful : PDF_ARGV_FORMS.librewrite ),
    values: { source: source.path, out_file: outPath, slug: outSlug, output_dir: downloadsBase() },
    outputDir: stagingBase(),
  } );

  if ( run.spawn_error ) {
    return failure( tool, 'interpreter_unavailable',
      `Python could not be started: ${ run.spawn_error }. Check that python3 is installed on the connector service.`,
      { renderer: converterFile } );
  }

  if ( run.timed_out ) {
    return failure( tool, 'render_timeout',
      `${ converterFile } exceeded the ${ Math.round( renderTimeoutMs() / 1000 ) } second render timeout.`,
      { renderer: converterFile, stderr_tail: tail( run.stderr ) } );
  }

  const contract = parseRendererContract( run.stdout );
  const problem = interpretRendererFailure( run, contract );

  if ( problem ) {
    const argvExhausted = run.attempts.length > 0 && run.attempts.every( ( a ) => a.rejected );

    // convert_docx_to_pdf.py emits LIBREOFFICE_MISSING with a message naming
    // the package to install, which classifyRendererCode maps to
    // pdf_pipeline_unavailable. The stderr sniff below is the fallback for
    // docx_to_pdf_faithful.py, which does not route through doc_common and so
    // reports a bare ImportError for reportlab.
    const missingDep = problem.kind === 'render_failed'
      && /libreoffice|soffice|weasyprint|reportlab|No module named|command not found|ENOENT/i.test(
        `${ run.stderr }\n${ run.stdout }`
      );

    return failure(
      tool,
      argvExhausted ? 'renderer_argv_mismatch' : ( missingDep ? 'pdf_pipeline_unavailable' : problem.kind ),
      argvExhausted
        ? `${ converterFile } rejected every configured argument form. Pin the correct form through RENDER_ARGV_FORMS.`
        : ( missingDep
          ? `${ converterFile } could not run because a conversion dependency is unavailable ` +
            '(LibreOffice or reportlab). Install it on the connector service, or render the document as DOCX instead.'
          : problem.message ),
      {
        renderer: converterFile,
        renderer_code: problem.code,
        faithful,
        source_file: source.filename,
        argv_attempts: run.attempts.map( ( a ) => ( { argv: a.argv, exit_code: a.status, argv_rejected: a.rejected } ) ),
        stdout_tail: tail( run.stdout ),
        stderr_tail: tail( run.stderr ),
        ...( intermediate ? { docx_stage: intermediate } : {} ),
      }
    );
  }

  const declaredPdf = Array.isArray( contract?.download_files )
    ? contract.download_files.filter( ( f ) => typeof f === 'string' && f )
    : ( isNonEmptyString( contract?.file ) ? [ contract.file ] : [] );

  const { links, warnings, primary } = collectOutputs( before, '.pdf', declaredPdf );

  if ( ! primary ) {
    return failure( tool, 'no_output_produced',
      `${ converterFile } exited successfully but no PDF appeared in ${ downloadsBase() }. Nothing can be delivered.`,
      {
        renderer: converterFile,
        source_file: source.filename,
        renderer_contract: contract || undefined,
        download_links: links.length ? links : undefined,
        download_warnings: warnings.length ? warnings : undefined,
        stdout_tail: tail( run.stdout ),
        stderr_tail: tail( run.stderr ),
        ...( intermediate ? { docx_stage: intermediate } : {} ),
      } );
  }

  return mcp( {
    ok: true,
    tool,
    format: 'pdf',
    mode: args.mode,
    renderer: converterFile,
    faithful,
    argv_form: run.argv,
    source_file: source.filename,
    source_from: source.from,
    file: primary.filename,
    size_bytes: primary.size_bytes,
    download_url: primary.download_url,
    preview_url: primary.preview_url,
    download_links: links,
    download_warnings: warnings.length ? warnings : undefined,
    renderer_contract: contract || undefined,
    execution_time_ms: run.elapsed_ms,
    ...( intermediate ? { docx_stage: { file: intermediate.file, download_url: intermediate.download_url, section_count: intermediate.section_count } } : {} ),
    ...( ignored.length ? { ignored_parameters: ignored } : {} ),
    ...( run.form_index > 0
      ? { argv_note: `Argument form ${ run.form_index + 1 } was used after earlier forms were rejected. Pin it with RENDER_ARGV_FORMS to remove the probe.` }
      : {} ),
  } );
}

/**
 * Dispatch a render tool by name.
 *
 * Centralised here rather than as four cases in the server switch so that the
 * feature-flag check cannot be applied to three tools and forgotten on the
 * fourth.
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>|null} MCP result, or null when the name is not a render tool.
 */
export async function dispatchRenderTool( name, args ) {
  if ( ! RENDER_TOOL_NAMES.has( name ) ) return null;

  if ( ! renderToolsEnabled() ) {
    return failure( name, 'feature_disabled',
      'The gateway render tools are not enabled on this connector. Set RENDER_TOOLS_ENABLED=true to ' +
      'enable them. Until then, document creation remains available through script_execute.' );
  }

  switch ( name ) {
    case 'document_render': return handleDocumentRender( args );
    case 'pdf_render':      return handlePdfRender( args );
    case 'xlsx_render':     return handleXlsxRender( args );
    case 'pptx_render':     return handlePptxRender( args );
    default:                return null;
  }
}

/**
 * Diagnostic summary of the render configuration.
 *
 * Reports paths and limits only. No secret is read by this module, so there is
 * nothing here that must be withheld.
 *
 * @returns {object}
 */
export function renderToolsStatus() {
  const scripts = rendererScripts();
  const base = scriptsBase();
  const present = {};

  for ( const file of Object.values( scripts ) ) {
    const r = resolveRenderer( file );
    present[ file ] = r.ok ? 'present' : r.kind;
  }

  let downloadsWritable = false;
  try {
    downloadsWritable = existsSync( downloadsBase() ) && statSync( downloadsBase() ).isDirectory();
  } catch { downloadsWritable = false; }

  return {
    enabled: renderToolsEnabled(),
    tools: [ ...RENDER_TOOL_NAMES ],
    scripts_dir: base,
    scripts_dir_present: existsSync( base ),
    renderers: present,
    downloads_dir: downloadsBase(),
    downloads_dir_present: downloadsWritable,
    staging_dir: stagingBase(),
    spec_max_bytes: specMaxBytes(),
    render_timeout_seconds: Math.round( renderTimeoutMs() / 1000 ),
  };
}

export default {
  RENDER_TOOL_DEFINITIONS,
  RENDER_TOOL_NAMES,
  dispatchRenderTool,
  handleDocumentRender,
  handlePdfRender,
  handleXlsxRender,
  handlePptxRender,
  renderToolsEnabled,
  renderToolsStatus,
};
