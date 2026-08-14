// src/tools/edit-tools.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-TOOL-001 -- First-class document EDITING and homework rendering.
//
// Registers four first-class gateway tools in the connector tool registry:
//
//     xlsx_edit        (in-place Excel editing, styles preserved)
//     docx_edit        (in-place Word editing, run formatting preserved)
//     pptx_edit        (in-place PowerPoint editing, geometry preserved)
//     homework_render  (homework DOCX + HTML preview from a spec)
//
// WHY THIS MODULE EXISTS
// ----------------------
// SPEC-GTW-DOC-001 registered the four RENDER tools, which create new files
// from a content spec, and explicitly deferred the editors (its section 12).
// This is that deferred work.
//
// The distinction is not cosmetic. A render call is self-contained: the caller
// supplies content and gets a file. An edit call names an EXISTING file and
// mutates it, so three things the render tools never had to do must happen
// here: the source has to be resolved and contained, the action has to select
// which of a dozen CLI flags are meaningful, and the output has to be named so
// that two edits in one session do not overwrite each other.
//
// Reaching these scripts through script_execute meant the calling session had
// to reproduce each script's exact flag spelling from memory. That is a real
// hazard rather than a theoretical one, because the three editors DISAGREE
// about spelling for the same concept:
//
//     concept        xlsx editor        docx editor        pptx editor
//     font size      --font-size        --font_size        (none)
//     bold           --bold (flag)      --bold true|false  (none)
//     slide index    (none)             (none)             --slide-index
//
// `--bold` is the sharpest case. On the xlsx editor it is argparse
// `store_true`, so passing `--bold false` sets bold to TRUE and leaves "false"
// as a stray positional argument. On the docx editor `--bold` takes a string
// and `--bold false` means what it says. One module-level mapping table gets
// this right once instead of every session getting it right every time.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// This module does not import render-tools.js's private helpers, and it does
// not modify that file to export them. The small helpers below (mcp, failure,
// tail, isPlainObject, stageSpec) are near-duplicates of ones in render-tools.js
// and that duplication is chosen on purpose: adding four `export` keywords to a
// working 2,070-line module that four shipped tools depend on is a change to
// the render path, and this spec is additive. The substantial machinery --
// renderer resolution, the argv ladder, contract parsing, injection-key
// detection -- IS imported, because it is already exported and reimplementing
// it would be genuinely dangerous.
//
// SECURITY
// --------
//   - Editor script names are gateway-side constants, never read from tool
//     input. Any input key that names a script or command is ignored and
//     reported in `ignored_parameters` (spec test T13).
//   - The source file must resolve inside the uploads or downloads directory
//     through resolveContained(), which rejects traversal and symlink escape.
//     A caller cannot edit /etc/passwd by naming it.
//   - Image paths passed to add_image are contained the same way. They are a
//     second file input and would otherwise be an unchecked read primitive.
//   - Subprocesses are spawned with an argument array and no shell, through
//     the shared minimal environment. No credential is inherited.
//
// FEATURE FLAG
// ------------
// EDIT_TOOLS_ENABLED=true turns these on. Default off, matching how the render
// tools shipped: the change is additive and verifiable in place before it
// becomes the advertised path. When off the tools are neither advertised nor
// dispatchable, and script_execute plus the editor scripts remain exactly as
// they are today.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve as resolvePath, basename, extname, join as joinPath } from 'node:path';

import { resolveContained } from '../utils/pathContainment.js';
import {
  buildDownloadLinks,
  snapshotDownloads,
  downloadsBase,
} from '../utils/downloadLinks.js';

// Imported rather than reimplemented. Every one of these is already exported by
// render-tools.js and is the same operation here: the editors live in the same
// directory, are run by the same interpreter, and emit the same doc_common
// JSON contract as the renderers.
import {
  scriptsBase,
  uploadsBase,
  stagingBase,
  specMaxBytes,
  renderTimeoutMs,
  resolveRenderer,
  runRenderer,
  parseRendererContract,
  detectInjectionKeys,
  argvFormsFor,
} from './render-tools.js';

// ---------------------------------------------------------------------------
// Configuration
//
// Read through functions rather than captured at import, so a test (or a
// platform that mutates process.env after load) sees the current value. Same
// reasoning as render-tools.js.
// ---------------------------------------------------------------------------

/** Characters of subprocess output kept when reporting a failure. */
const OUTPUT_TAIL_CHARS = 2000;

/**
 * Feature flag.
 *
 * @returns {boolean}
 */
export function editToolsEnabled() {
  return String( process.env.EDIT_TOOLS_ENABLED || '' ).trim().toLowerCase() === 'true';
}

/**
 * Editor script filenames, resolved from gateway-side constants.
 *
 * The env overrides exist for an operator whose volume layout differs. They are
 * still resolved through resolveContained() against the scripts directory, so
 * an override cannot escape it, and they are NOT reachable from tool input.
 *
 * The `document-processing` prefix is not a typo and not a directory: it is
 * part of the filename on the volume, an artefact of how the scripts were
 * uploaded. Spelling it correctly here is precisely the kind of detail this
 * module exists to stop sessions from having to remember.
 *
 * @returns {{xlsx: string, docx: string, pptx: string, homework: string}}
 */
export function editorScripts() {
  return {
    xlsx:     String( process.env.EDIT_SCRIPT_XLSX     || 'document-processingedit_xlsx.py' ).trim(),
    docx:     String( process.env.EDIT_SCRIPT_DOCX     || 'document-processingedit_docx.py' ).trim(),
    pptx:     String( process.env.EDIT_SCRIPT_PPTX     || 'document-processingedit_pptx.py' ).trim(),
    homework: String( process.env.EDIT_SCRIPT_HOMEWORK || 'homework_render.py' ).trim(),
  };
}

/**
 * Argv forms for the editors.
 *
 * The editors declare --output themselves, unlike the spec renderers, so there
 * is no --output ladder here. The mapped argv is complete and is passed as one
 * form; there is nothing to probe.
 *
 * @type {string[][]}
 */
const HOMEWORK_ARGV_FORMS = [
  [ '--input', '{spec}' ],
];

// ---------------------------------------------------------------------------
// Small local helpers
//
// Near-duplicates of render-tools.js internals. See the module header for why
// they are duplicated rather than exported from there.
// ---------------------------------------------------------------------------

/** @param {*} v @returns {boolean} */
function isPlainObject( v ) {
  return typeof v === 'object' && v !== null && ! Array.isArray( v );
}

/** @param {*} v @returns {boolean} */
function isNonEmptyString( v ) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Wrap a payload as an MCP tool result.
 *
 * @param {object} payload
 * @param {boolean} [isError]
 * @returns {{content: Array<object>, isError: boolean}}
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
 * @param {string} kind    Machine-readable classifier.
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
 * The tail rather than the head: a Python traceback puts the exception last.
 *
 * @param {string} text
 * @returns {string}
 */
function tail( text ) {
  const s = String( text || '' );
  if ( s.length <= OUTPUT_TAIL_CHARS ) return s;
  return `...[truncated ${ s.length - OUTPUT_TAIL_CHARS } chars]...\n${ s.slice( -OUTPUT_TAIL_CHARS ) }`;
}

// ---------------------------------------------------------------------------
// Source file resolution  (spec section 5, step 1)
// ---------------------------------------------------------------------------

/**
 * Extensions each tool will accept as a source. The scripts enforce this too
 * (require_existing_file), but rejecting here saves a subprocess and produces a
 * far clearer message than a Python SystemExit.
 */
const SOURCE_EXTENSIONS = {
  xlsx_edit: new Set( [ '.xlsx', '.xlsm' ] ),
  docx_edit: new Set( [ '.docx' ] ),
  pptx_edit: new Set( [ '.pptx' ] ),
};

/** Image extensions the pptx and docx editors accept for add_image. */
const IMAGE_EXTENSIONS = new Set( [ '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff' ] );

/**
 * Resolve the file an edit call names.
 *
 * Spec section 5 step 1: an uploaded path is used directly; a bare filename is
 * resolved against uploads first, then downloads.
 *
 * "Used directly" is implemented as "contained within one of the two known
 * directories", which is stricter than the spec's wording and deliberately so.
 * A path arriving here has passed through model output, and an edit tool that
 * accepts an arbitrary absolute path is an arbitrary-file-write primitive: the
 * editors read the source and write an output derived from it. Containment
 * costs nothing for the real workflow, where the file is always an upload or a
 * previous download.
 *
 * @param {string} raw            Caller-supplied path or filename.
 * @param {Set<string>|null} allowedExt  Permitted extensions, or null for any.
 * @param {string} label          Field name, used in messages.
 * @returns {{ok: true, path: string, filename: string, from: string}
 *          |{ok: false, kind: string, message: string}}
 */
export function resolveSourceFile( raw, allowedExt = null, label = 'source_file' ) {
  if ( ! isNonEmptyString( raw ) ) {
    return {
      ok: false,
      kind: 'invalid_parameters',
      message: `${ label } is required and must be a non-empty string.`,
    };
  }

  const candidate = raw.trim();
  const ext = extname( candidate ).toLowerCase();

  if ( allowedExt && ! allowedExt.has( ext ) ) {
    return {
      ok: false,
      kind: 'wrong_extension',
      message:
        `${ label } "${ basename( candidate ) }" has extension "${ ext || '(none)' }". ` +
        `This tool accepts ${ [ ...allowedExt ].join( ', ' ) }.`,
    };
  }

  // Uploads first, then downloads: the spec's order, and the common case. A
  // user-supplied workbook is an upload; a previously generated one is a
  // download.
  const bases = [
    { dir: uploadsBase(),   from: 'uploads' },
    { dir: downloadsBase(), from: 'downloads' },
  ];

  const tried = [];

  for ( const { dir, from } of bases ) {
    tried.push( dir );

    // An absolute path is only considered against the base it claims to be
    // inside; resolveContained rejects it against the other one anyway, but
    // checking the prefix first keeps the reported `from` honest.
    const full = resolveContained( dir, candidate.startsWith( '/' ) ? relativeTo( dir, candidate ) : candidate );
    if ( full && existsSync( full ) ) {
      return { ok: true, path: full, filename: basename( full ), from };
    }
  }

  return {
    ok: false,
    kind: 'source_not_found',
    message:
      `${ label } "${ basename( candidate ) }" was not found in ${ tried.join( ' or ' ) }. ` +
      'Upload the file first, or name a file this connector has already produced. ' +
      'Paths outside those two directories are not accepted.',
  };
}

/**
 * Reduce an absolute path to a candidate relative to `dir`, or return it
 * unchanged when it is not under `dir` at all.
 *
 * resolveContained() takes a base and a candidate; handing it an absolute path
 * that is genuinely inside the base works, but handing it one that is not
 * produces a null that reads identically to "file missing". Normalising here
 * keeps the two outcomes distinguishable, and an absolute path outside every
 * base still ends as null from resolveContained, which is the correct refusal.
 *
 * @param {string} dir
 * @param {string} abs
 * @returns {string}
 */
function relativeTo( dir, abs ) {
  const base = resolvePath( dir );
  const full = resolvePath( abs );
  if ( full === base ) return '';
  if ( full.startsWith( `${ base }/` ) ) return full.slice( base.length + 1 );
  return abs;
}

/**
 * Output filename for an edit, derived from the source stem.
 *
 * Spec section 5, "Output path defaulting": the editors' own defaults would
 * have every docx edit in a session write to /data/downloads/edited.docx and
 * overwrite the last one. Deriving from the stem makes concurrent edits safe
 * without the caller having to think about it.
 *
 * @param {string} sourceFilename
 * @param {string} ext            Output extension including the dot.
 * @param {string} [override]     Caller-supplied output_name.
 * @returns {string} A bare filename, never a path.
 */
export function editedOutputName( sourceFilename, ext, override = '' ) {
  if ( isNonEmptyString( override ) ) {
    const cleaned = basename( override.trim() );
    return extname( cleaned ).toLowerCase() === ext ? cleaned : `${ cleaned }${ ext }`;
  }
  const stem = basename( sourceFilename, extname( sourceFilename ) );
  return `edited-${ stem }${ ext }`;
}

// ---------------------------------------------------------------------------
// Per-action argv mapping
//
// One table per editor. The value is the list of parameters that action reads;
// anything else the caller sent is not passed on, so a stray `slide_index` on a
// docx call cannot become an argparse rejection.
// ---------------------------------------------------------------------------

/**
 * Required parameters per tool and action.
 *
 * Checked before the subprocess so a missing `old` on replace_text is reported
 * as a parameter error rather than as a silent no-op edit -- the editors treat
 * an empty --old as "replace nothing" and exit 0, which would tell the caller
 * the edit succeeded when nothing changed.
 */
const REQUIRED_BY_ACTION = {
  xlsx_edit: {
    set_cell:     [ 'cell' ],
    add_row:      [ 'values' ],
    rename_sheet: [ 'old', 'new' ],
    add_sheet:    [ 'name' ],
    delete_sheet: [ 'name' ],
    list:         [],
  },
  docx_edit: {
    replace_text:   [ 'old' ],
    add_paragraph:  [ 'text' ],
    add_image:      [ 'image' ],
    add_table:      [],
    set_font:       [],
    add_page_break: [],
    recolour:       [],
    inspect:        [],
  },
  pptx_edit: {
    replace_text: [ 'old' ],
    add_slide:    [ 'title' ],
    add_image:    [ 'image' ],
    set_title:    [ 'title' ],
    list:         [],
  },
};

/**
 * Build the xlsx editor's argv.
 *
 * `--bold` is argparse store_true here, so it is emitted only when the caller
 * asked for bold and NEVER as `--bold false`, which argparse would read as
 * bold-on plus a stray positional.
 *
 * `--values` is a JSON array string: the script parses it with json.loads.
 * Serialising it here means the caller passes a real array and the gateway
 * owns the encoding.
 *
 * @param {object} a  Validated arguments.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {string[]}
 */
function xlsxArgv( a, inputPath, outputPath ) {
  const argv = [ '--input', inputPath, '--output', outputPath, '--action', a.action ];

  if ( isNonEmptyString( a.sheet ) ) argv.push( '--sheet', a.sheet );

  if ( a.action === 'set_cell' ) {
    argv.push( '--cell', String( a.cell ) );
    if ( a.value !== undefined && a.value !== null ) argv.push( '--value', String( a.value ) );
    if ( isNonEmptyString( a.value_type ) ) argv.push( '--value-type', a.value_type );
    if ( isNonEmptyString( a.hyperlink_target ) ) argv.push( '--hyperlink-target', a.hyperlink_target.trim() );
  }

  if ( a.action === 'add_row' ) {
    argv.push( '--values', JSON.stringify( a.values.map( ( v ) => ( v === null || v === undefined ? '' : v ) ) ) );
  }

  if ( a.action === 'rename_sheet' ) argv.push( '--old', String( a.old ), '--new', String( a.new ) );
  if ( a.action === 'add_sheet' || a.action === 'delete_sheet' ) argv.push( '--name', String( a.name ) );

  // Styling applies to set_cell and add_row targets. Emitted for any action
  // that accepts them; the script ignores what it does not use.
  if ( a.bold === true ) argv.push( '--bold' );
  if ( Number.isFinite( a.font_size ) ) argv.push( '--font-size', String( a.font_size ) );
  if ( isNonEmptyString( a.font_color ) ) argv.push( '--font-color', a.font_color.trim() );
  if ( isNonEmptyString( a.bg_color ) ) argv.push( '--bg-color', a.bg_color.trim() );
  if ( isNonEmptyString( a.alignment ) ) argv.push( '--alignment', a.alignment );

  return argv;
}

/**
 * Build the docx editor's argv.
 *
 * Note the underscore flags (--font_name, --font_size, --header_text): this
 * editor spells them differently from the xlsx one, and `--bold` here is a
 * string rather than a flag.
 *
 * @param {object} a
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {string[]}
 */
function docxArgv( a, inputPath, outputPath ) {
  const argv = [ '--input', inputPath, '--action', a.action, '--output', outputPath ];

  if ( a.action === 'replace_text' ) {
    argv.push( '--old', String( a.old ) );
    argv.push( '--new', a.new === undefined || a.new === null ? '' : String( a.new ) );
  }
  if ( a.action === 'add_paragraph' ) argv.push( '--text', String( a.text ) );
  if ( a.action === 'add_image' )     argv.push( '--image', String( a.image ) );
  if ( a.action === 'add_table' ) {
    if ( Number.isFinite( a.rows ) ) argv.push( '--rows', String( Math.trunc( a.rows ) ) );
    if ( Number.isFinite( a.cols ) ) argv.push( '--cols', String( Math.trunc( a.cols ) ) );
  }
  if ( a.action === 'recolour' && isNonEmptyString( a.accent ) ) {
    // The script wants the hex without a leading '#'.
    argv.push( '--accent', a.accent.trim().replace( /^#/, '' ) );
  }

  if ( isNonEmptyString( a.font_name ) )  argv.push( '--font_name', a.font_name );
  if ( Number.isFinite( a.font_size ) )   argv.push( '--font_size', String( a.font_size ) );
  if ( typeof a.bold === 'boolean' )      argv.push( '--bold', a.bold ? 'true' : 'false' );
  if ( isNonEmptyString( a.alignment ) )  argv.push( '--alignment', a.alignment );
  if ( isNonEmptyString( a.header_text ) ) argv.push( '--header_text', a.header_text );
  if ( isNonEmptyString( a.footer_text ) ) argv.push( '--footer_text', a.footer_text );

  return argv;
}

/**
 * Build the pptx editor's argv.
 *
 * @param {object} a
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {string[]}
 */
function pptxArgv( a, inputPath, outputPath ) {
  const argv = [ '--input', inputPath, '--output', outputPath, '--action', a.action ];

  if ( a.action === 'replace_text' ) {
    argv.push( '--old', String( a.old ) );
    argv.push( '--new', a.new === undefined || a.new === null ? '' : String( a.new ) );
  }
  if ( a.action === 'add_slide' ) {
    argv.push( '--title', String( a.title ) );
    if ( isNonEmptyString( a.body ) ) argv.push( '--body', a.body );
  }
  if ( a.action === 'set_title' ) argv.push( '--title', String( a.title ) );
  if ( a.action === 'add_image' ) argv.push( '--image', String( a.image ) );

  if ( ( a.action === 'add_image' || a.action === 'set_title' ) && Number.isFinite( a.slide_index ) ) {
    argv.push( '--slide-index', String( Math.trunc( a.slide_index ) ) );
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

/**
 * Validate an edit call's parameters against the action's requirements.
 *
 * @param {string} tool
 * @param {object} args
 * @returns {string[]} Errors, empty when the call is well formed.
 */
export function validateEditArgs( tool, args ) {
  const errors = [];
  const table = REQUIRED_BY_ACTION[ tool ];
  if ( ! table ) return [ `Unknown tool "${ tool }".` ];

  const action = args.action;
  if ( ! isNonEmptyString( action ) ) {
    errors.push( 'action is required.' );
    return errors;
  }

  if ( ! Object.prototype.hasOwnProperty.call( table, action ) ) {
    // Spec test T11: an unknown action is a clear validation error, listing
    // what is actually available rather than leaving the caller to guess.
    errors.push(
      `Unknown action "${ action }". ${ tool } supports: ${ Object.keys( table ).join( ', ' ) }.`
    );
    return errors;
  }

  for ( const key of table[ action ] ) {
    const v = args[ key ];
    if ( key === 'values' ) {
      if ( ! Array.isArray( v ) || v.length === 0 ) {
        errors.push( `values must be a non-empty array for action "${ action }".` );
      }
      continue;
    }
    if ( ! isNonEmptyString( v ) ) {
      errors.push( `${ key } is required for action "${ action }".` );
    }
  }

  if ( args.font_size !== undefined && ! Number.isFinite( args.font_size ) ) {
    errors.push( 'font_size must be a number.' );
  }
  if ( args.slide_index !== undefined && ! Number.isFinite( args.slide_index ) ) {
    errors.push( 'slide_index must be a number.' );
  }
  for ( const key of [ 'font_color', 'bg_color', 'accent' ] ) {
    const v = args[ key ];
    if ( v === undefined || v === null || v === '' ) continue;
    if ( ! /^#?[0-9a-fA-F]{6}$/.test( String( v ).trim() ) ) {
      errors.push( `${ key } must be a 6-digit hex colour, with or without a leading '#'.` );
    }
  }
  if ( args.hyperlink_target !== undefined && args.hyperlink_target !== null && args.hyperlink_target !== '' ) {
    // The script enforces this too and exits non-zero. Checking here turns a
    // subprocess failure into a parameter message.
    if ( ! /^(https?:\/\/|mailto:)/i.test( String( args.hyperlink_target ).trim() ) ) {
      errors.push( 'hyperlink_target must be an http(s) or mailto URL.' );
    }
  }

  return errors;
}

/**
 * Filenames that exist in the downloads directory right now.
 *
 * WHY THIS EXISTS, and it is not belt-and-braces.
 *
 * buildDownloadLinks() returns nothing when CONNECTOR_URL is unset, because it
 * cannot form an absolute URL without a host. That is a CONFIGURATION state,
 * and it is indistinguishable, at the links array, from the genuinely serious
 * case this module reports as no_output_produced: the script exited 0, claimed
 * success, and wrote nothing.
 *
 * Treating them as one thing tells an operator "nothing can be delivered to
 * the user" while the finished document is sitting in the downloads directory,
 * which sends them looking at the editor script instead of at CONNECTOR_URL.
 * Asking the filesystem separates the two, so each gets the message that
 * actually describes it.
 *
 * @param {string[]} names  Candidate filenames.
 * @returns {Array<{filename: string, size_bytes: number}>}
 */
function filesOnDisk( names ) {
  const out = [];
  for ( const name of names ) {
    if ( ! name ) continue;
    const full = joinPath( downloadsBase(), basename( name ) );
    try {
      if ( existsSync( full ) ) out.push( { filename: basename( name ), size_bytes: statSync( full ).size } );
    } catch { /* unreadable is the same as absent for this purpose */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared edit handler  (spec section 5)
// ---------------------------------------------------------------------------

/**
 * The procedural sequence from spec section 5, shared by the three editors.
 *
 *   1. Report and ignore any executable-selecting input key (T13).
 *   2. Validate parameters against the action (T11).
 *   3. Resolve and contain the source file (T12).
 *   4. Resolve the editor script from a gateway constant.
 *   5. Map the action to argv and invoke.
 *   6. Interpret the JSON contract.
 *   7. Build download links from the downloads diff.
 *
 * @param {object} cfg
 * @param {string} cfg.tool
 * @param {string} cfg.scriptFile
 * @param {string} cfg.ext                  Source and output extension.
 * @param {(a: object, i: string, o: string) => string[]} cfg.buildArgv
 * @param {object} input
 * @returns {Promise<object>} MCP result.
 */
async function handleEdit( cfg, input ) {
  const { tool, scriptFile, ext, buildArgv } = cfg;
  const args = isPlainObject( input ) ? input : {};

  // ---- Step 1: T13. The schemas carry no script path, so any such key is
  // caller noise or an injection attempt. Either way it is ignored, and said.
  const ignored = detectInjectionKeys( args );
  if ( ignored.length > 0 ) {
    console.error(
      `[edit-tools] ${ tool }: ignoring caller-supplied ${ ignored.join( ', ' ) }; ` +
      'the editor path is a gateway constant.'
    );
  }
  const ignoredField = ignored.length ? { ignored_parameters: ignored } : {};

  // ---- Step 2: parameters.
  const errors = validateEditArgs( tool, args );
  if ( errors.length > 0 ) {
    return failure(
      tool,
      'invalid_parameters',
      `The call failed parameter validation with ${ errors.length } error${ errors.length === 1 ? '' : 's' }. Nothing was edited.`,
      { errors, ...ignoredField }
    );
  }

  // ---- Step 3: source containment.
  const source = resolveSourceFile( args.source_file, SOURCE_EXTENSIONS[ tool ], 'source_file' );
  if ( ! source.ok ) {
    return failure( tool, source.kind, source.message, {
      uploads_dir: uploadsBase(),
      downloads_dir: downloadsBase(),
      ...ignoredField,
    } );
  }

  // add_image takes a second file. Contain it exactly as the source is
  // contained; without this it would be an unchecked read of any path.
  let imagePath = '';
  if ( args.action === 'add_image' ) {
    const img = resolveSourceFile( args.image, IMAGE_EXTENSIONS, 'image' );
    if ( ! img.ok ) {
      return failure( tool, img.kind, img.message, {
        uploads_dir: uploadsBase(),
        downloads_dir: downloadsBase(),
        ...ignoredField,
      } );
    }
    imagePath = img.path;
  }

  // ---- Step 4: resolve the editor from a gateway-side constant.
  const resolved = resolveRenderer( scriptFile );
  if ( ! resolved.ok ) {
    return failure( tool, resolved.kind, resolved.message, {
      editor: scriptFile,
      scripts_dir: scriptsBase(),
      ...ignoredField,
    } );
  }

  // ---- Step 5: argv and invoke.
  //
  // `list` and `inspect` are read-only and still write an output file on some
  // editors, so the output name is derived for every action rather than only
  // the mutating ones. Deriving it is what stops two edits in one session from
  // overwriting each other (spec section 5, output path defaulting).
  const outName = editedOutputName( source.filename, ext, args.output_name );
  const outPath = joinPath( downloadsBase(), outName );

  const argv = buildArgv(
    { ...args, ...( imagePath ? { image: imagePath } : {} ) },
    source.path,
    outPath
  );

  const before = snapshotDownloads();

  const run = runRenderer( {
    scriptPath: resolved.path,
    scriptFile,
    forms: [ argv ],
    values: {},
    outputDir: downloadsBase(),
  } );

  if ( run.spawn_error ) {
    return failure( tool, 'interpreter_unavailable',
      `Python could not be started: ${ run.spawn_error }. Check that python3 is installed on the connector service.`,
      { editor: scriptFile, ...ignoredField } );
  }

  if ( run.timed_out ) {
    return failure( tool, 'edit_timeout',
      `${ scriptFile } exceeded the ${ Math.round( renderTimeoutMs() / 1000 ) } second timeout. ` +
      'Raise RENDER_TIMEOUT_SECONDS, or reduce the size of the document.',
      { editor: scriptFile, stderr_tail: tail( run.stderr ), ...ignoredField } );
  }

  // ---- Step 6: the contract decides.
  const envelope = parseRendererContract( run.stdout );

  if ( ! run.ok || ( envelope && envelope.success === false ) ) {
    const msg = ( envelope && ( envelope.error || envelope.message ) )
      || `${ scriptFile } exited with status ${ run.status }.`;
    return failure( tool, 'edit_failed', msg, {
      editor: scriptFile,
      editor_code: envelope?.code,
      action: args.action,
      argv,
      exit_code: run.status,
      stdout_tail: tail( run.stdout ),
      stderr_tail: tail( run.stderr ),
      ...ignoredField,
    } );
  }

  // ---- Step 7: outputs.
  //
  // A read-only action legitimately produces no file, so an empty link set is
  // only a failure for an action that was supposed to write one. Reporting
  // otherwise would make `list` look broken.
  const readOnly = args.action === 'list' || args.action === 'inspect';

  const declared = Array.isArray( envelope?.download_files )
    ? envelope.download_files.filter( ( f ) => typeof f === 'string' && f )
    : [];

  let links = [];
  let warnings = [];
  if ( ! readOnly ) {
    try {
      const built = buildDownloadLinks( { before, declared } );
      links = built.links;
      warnings = built.warnings;
    } catch ( err ) {
      warnings = [ `Download links could not be built: ${ err.message }` ];
    }
    for ( const w of warnings ) console.error( `[edit-tools] download link warning: ${ w }` );
  }

  // Disk truth, consulted only when no link could be built. See filesOnDisk().
  const onDisk = ( ! readOnly && links.length === 0 )
    ? filesOnDisk( [ outName, ...declared, envelope?.filename, envelope?.file ] )
    : [];

  if ( ! readOnly && links.length === 0 && onDisk.length === 0 ) {
    // Exit 0, success contract, nothing on disk. Reported as an error rather
    // than an empty success, for the same reason the render tools do: a
    // silent no-output is the failure mode these tools exist to remove.
    return failure( tool, 'no_output_produced',
      `${ scriptFile } reported success but wrote no file to ${ downloadsBase() }. ` +
      'Nothing can be delivered to the user.',
      {
        editor: scriptFile,
        action: args.action,
        editor_contract: envelope || undefined,
        download_warnings: warnings.length ? warnings : undefined,
        stdout_tail: tail( run.stdout ),
        ...ignoredField,
      } );
  }

  const primary = links.find( ( l ) => extname( l.filename ).toLowerCase() === ext )
    || links[ 0 ]
    || onDisk.find( ( f ) => extname( f.filename ).toLowerCase() === ext )
    || onDisk[ 0 ]
    || null;

  return mcp( {
    ok: true,
    tool,
    action: args.action,
    editor: scriptFile,
    source_file: source.filename,
    source_from: source.from,
    ...( readOnly ? {} : { output_file: primary ? primary.filename : outName } ),
    ...( primary ? {
      size_bytes: primary.size_bytes,
      download_url: primary.download_url,
      preview_url: primary.preview_url || undefined,
    } : {} ),
    ...( links.length ? { download_links: links } : {} ),
    ...( warnings.length ? { download_warnings: warnings } : {} ),
    // The edit completed and the file is on disk, but no URL could be formed.
    // Said plainly, because the caller must not offer the user a link it does
    // not have.
    ...( ! readOnly && links.length === 0 && onDisk.length > 0
      ? { download_url_unavailable: 'The edit completed and the file was written, but no download URL could be built. Set CONNECTOR_URL on the connector service.' }
      : {} ),
    editor_contract: envelope || undefined,
    // The docx editor skips sidebar registration when GATEWAY_URL or
    // GATEWAY_ADMIN_KEY are unset, and the edit still succeeds (spec section
    // 8). Surfacing the outcome means a skipped registration is visible rather
    // than being mistaken for a failed edit.
    sidebar_registration: envelope?.sidebar_registration,
    execution_time_ms: run.elapsed_ms,
    ...ignoredField,
  } );
}

// ---------------------------------------------------------------------------
// homework_render
// ---------------------------------------------------------------------------

/**
 * Cheap pre-check for a homework spec.
 *
 * Deliberately shallow. homework_render.py validates in full and BLOCKS on
 * error (v2.0.0), and that validator is the authority: a gateway
 * reimplementation could drift from it and pass a spec the renderer then
 * rejects. This catches only what would otherwise cost a subprocess to learn.
 *
 * @param {unknown} spec
 * @returns {string[]}
 */
export function precheckHomeworkSpec( spec ) {
  if ( ! isPlainObject( spec ) ) return [ 'spec must be a JSON object.' ];

  const errors = [];
  for ( const field of [ 'title', 'student_name', 'subject', 'session_date', 'due_date', 'instructions' ] ) {
    if ( ! isNonEmptyString( spec[ field ] ) ) errors.push( `spec.${ field } is required.` );
  }
  if ( ! Array.isArray( spec.sections ) || spec.sections.length === 0 ) {
    errors.push( 'spec.sections must be a non-empty array.' );
  }
  return errors;
}

/**
 * Serialize a spec, size-check it, and write it to the staging directory.
 *
 * Local rather than imported: render-tools.js keeps its stageSpec private. See
 * the module header.
 *
 * @param {object} spec
 * @param {string} tool
 * @returns {{ok: true, path: string, bytes: number}
 *          |{ok: false, kind: string, message: string, bytes?: number, limit?: number}}
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
        'Nothing was rendered and nothing was truncated. Split the assignment, or raise RENDER_SPEC_MAX_BYTES.',
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

/** Remove a staged spec file. Never throws. @param {string|null} path @returns {void} */
function cleanupStaged( path ) {
  if ( ! path ) return;
  try { unlinkSync( path ); } catch { /* already gone, or never written */ }
}

/**
 * homework_render handler.
 *
 * Two behaviours the spec calls out explicitly are load-bearing here:
 *
 *   ANSWERS. Every question carries an `answer`, and homework_common
 *   .strip_answers removes them before either builder runs. This handler passes
 *   the spec through untouched and never post-processes the output, so there is
 *   no path by which an answer could be reintroduced. The tests assert the
 *   absence directly.
 *
 *   DRY RUN. The renderer validates and blocks on error. A dry run returns
 *   valid/errors WITHOUT writing files, and those errors are surfaced whole --
 *   never summarised, never truncated -- because a silently trimmed error list
 *   is how a broken spec reaches a student.
 *
 * @param {object} input
 * @returns {Promise<object>} MCP result.
 */
export async function handleHomeworkRender( input = {} ) {
  const tool = 'homework_render';
  const args = isPlainObject( input ) ? input : {};

  const ignored = detectInjectionKeys( args );
  if ( ignored.length > 0 ) {
    console.error(
      `[edit-tools] ${ tool }: ignoring caller-supplied ${ ignored.join( ', ' ) }; ` +
      'the renderer path is a gateway constant.'
    );
  }
  const ignoredField = ignored.length ? { ignored_parameters: ignored } : {};

  // dry_run may arrive as a tool parameter or inside the spec; the renderer
  // honours both. Either sets the flag.
  const spec = isPlainObject( args.spec ) ? { ...args.spec } : args.spec;
  const dryRun = args.dry_run === true || ( isPlainObject( spec ) && spec.dry_run === true );

  // Spec section 8: ttl_days defaults to 3 so the URL, the preview and the
  // retention window move together with the connector's own LINK_EXPIRY.
  // Applied only when the caller said nothing.
  if ( isPlainObject( spec ) && spec.ttl_days === undefined ) spec.ttl_days = 3;

  const preErrors = precheckHomeworkSpec( spec );
  if ( preErrors.length > 0 ) {
    if ( dryRun ) {
      return mcp( {
        ok: true,
        tool,
        dry_run: true,
        valid: false,
        errors: preErrors,
        validated_by: 'gateway_precheck',
        ...ignoredField,
        note: 'Dry run: the spec was rejected by the gateway pre-check and no file was written.',
      } );
    }
    return failure( tool, 'invalid_spec',
      `The homework spec failed the gateway pre-check with ${ preErrors.length } error${ preErrors.length === 1 ? '' : 's' }. Nothing was rendered.`,
      { errors: preErrors, validated_by: 'gateway_precheck', ...ignoredField } );
  }

  const scriptFile = editorScripts().homework;
  const resolved = resolveRenderer( scriptFile );
  if ( ! resolved.ok ) {
    return failure( tool, resolved.kind, resolved.message, {
      renderer: scriptFile,
      scripts_dir: scriptsBase(),
      ...ignoredField,
    } );
  }

  const staged = stageSpec( spec, tool );
  if ( ! staged.ok ) {
    return failure( tool, staged.kind, staged.message, {
      ...( staged.bytes !== undefined ? { spec_bytes: staged.bytes } : {} ),
      ...( staged.limit !== undefined ? { spec_max_bytes: staged.limit } : {} ),
      ...ignoredField,
    } );
  }

  const before = dryRun ? new Map() : snapshotDownloads();

  try {
    const forms = argvFormsFor( scriptFile, HOMEWORK_ARGV_FORMS )
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
        `Python could not be started: ${ run.spawn_error }.`, { renderer: scriptFile, ...ignoredField } );
    }
    if ( run.timed_out ) {
      return failure( tool, 'render_timeout',
        `${ scriptFile } exceeded the ${ Math.round( renderTimeoutMs() / 1000 ) } second render timeout.`,
        { renderer: scriptFile, stderr_tail: tail( run.stderr ), ...ignoredField } );
    }

    const envelope = parseRendererContract( run.stdout );

    // A dry run reports a verdict rather than an error: "this spec is invalid"
    // is the answer the caller asked for, not a tool malfunction. The errors
    // array is passed through whole.
    if ( dryRun ) {
      const valid = ! ( envelope && ( envelope.valid === false || envelope.success === false ) );
      const rendererErrors = Array.isArray( envelope?.errors ) ? envelope.errors : [];
      return mcp( {
        ok: true,
        tool,
        dry_run: true,
        valid,
        errors: rendererErrors,
        validated_by: 'renderer',
        renderer: scriptFile,
        spec_bytes: staged.bytes,
        ...( envelope && envelope.question_count !== undefined ? { question_count: envelope.question_count } : {} ),
        ...ignoredField,
        note: 'Dry run: the renderer validated the spec and wrote no file.',
      } );
    }

    if ( ! run.ok || ( envelope && envelope.success === false ) ) {
      const rendererErrors = Array.isArray( envelope?.errors ) ? envelope.errors : undefined;
      const msg = ( envelope && ( envelope.error || envelope.message ) )
        || `${ scriptFile } exited with status ${ run.status }.`;
      return failure( tool, rendererErrors ? 'invalid_spec' : 'render_failed', msg, {
        renderer: scriptFile,
        renderer_code: envelope?.code,
        ...( rendererErrors ? { errors: rendererErrors, validated_by: 'renderer' } : {} ),
        exit_code: run.status,
        stdout_tail: tail( run.stdout ),
        stderr_tail: tail( run.stderr ),
        ...ignoredField,
      } );
    }

    const declared = Array.isArray( envelope?.download_files )
      ? envelope.download_files.filter( ( f ) => typeof f === 'string' && f )
      : [];

    let links = [];
    let warnings = [];
    try {
      const built = buildDownloadLinks( { before, declared } );
      links = built.links;
      warnings = built.warnings;
    } catch ( err ) {
      warnings = [ `Download links could not be built: ${ err.message }` ];
    }

    const onDisk = links.length === 0
      ? filesOnDisk( [ ...declared, envelope?.filename, envelope?.file, envelope?.preview_file ] )
      : [];

    if ( links.length === 0 && onDisk.length === 0 ) {
      return failure( tool, 'no_output_produced',
        `${ scriptFile } reported success but wrote no file to ${ downloadsBase() }.`,
        {
          renderer: scriptFile,
          renderer_contract: envelope || undefined,
          download_warnings: warnings.length ? warnings : undefined,
          stdout_tail: tail( run.stdout ),
          ...ignoredField,
        } );
    }

    const byExt = ( ext ) => links.find( ( l ) => extname( l.filename ).toLowerCase() === ext )
      || onDisk.find( ( f ) => extname( f.filename ).toLowerCase() === ext )
      || null;
    const primary = byExt( '.docx' ) || links[ 0 ] || onDisk[ 0 ];
    const preview = byExt( '.html' );

    return mcp( {
      ok: true,
      tool,
      renderer: scriptFile,
      spec_bytes: staged.bytes,
      file: primary.filename,
      size_bytes: primary.size_bytes,
      ...( primary.download_url ? { download_url: primary.download_url } : {} ),
      preview_url: primary.preview_url || ( preview && preview.preview_url ) || undefined,
      ...( preview ? { preview_file: preview.filename } : {} ),
      ...( links.length ? { download_links: links } : {} ),
      ...( warnings.length ? { download_warnings: warnings } : {} ),
      ...( links.length === 0 && onDisk.length > 0
        ? { download_url_unavailable: 'The homework rendered and the files were written, but no download URL could be built. Set CONNECTOR_URL on the connector service.' }
        : {} ),
      ...( envelope && envelope.question_count !== undefined ? { question_count: envelope.question_count } : {} ),
      ttl_days: isPlainObject( spec ) ? spec.ttl_days : undefined,
      renderer_contract: envelope || undefined,
      sidebar_registration: envelope?.sidebar_registration,
      execution_time_ms: run.elapsed_ms,
      ...ignoredField,
    } );

  } finally {
    cleanupStaged( staged.path );
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Shared style properties on the xlsx schema. */
const XLSX_STYLE_PROPS = {
  bold:       { type: 'boolean', description: 'Set bold on the target cell.' },
  font_size:  { type: 'number', description: 'Font size in points.' },
  font_color: { type: 'string', description: "Font hex colour, e.g. 'FF0000' or '#FF0000'." },
  bg_color:   { type: 'string', description: "Cell fill hex colour, e.g. 'AEC9F6' or '#AEC9F6'." },
  alignment:  { type: 'string', enum: [ 'left', 'center', 'right' ], description: 'Horizontal alignment.' },
};

export const xlsxEditToolDefinition = {
  name: 'xlsx_edit',
  description:
    'Edit an existing Excel workbook (.xlsx/.xlsm) IN PLACE, retaining formulas, charts, merged cells, ' +
    'column widths and every style you do not explicitly change. Use this instead of xlsx_render when the ' +
    'user has an existing workbook: xlsx_render creates a new file and would lose all of that. ' +
    'set_cell can also attach a hyperlink to the cell while showing a different display value. ' +
    'The source file must be an upload or a file this connector produced; name it by filename. ' +
    'Never construct a download URL yourself: the returned URLs are complete.',
  inputSchema: {
    type: 'object',
    properties: {
      source_file: { type: 'string', description: 'Filename of the workbook to edit, in the uploads or downloads directory.' },
      action: {
        type: 'string',
        enum: [ 'set_cell', 'add_row', 'rename_sheet', 'add_sheet', 'delete_sheet', 'list' ],
        description: 'The edit to perform. "list" is read-only and returns sheet names, max_row and max_column.',
      },
      sheet: { type: 'string', description: 'Target worksheet name. Defaults to the active sheet.' },
      cell: { type: 'string', description: "A1-style coordinate for set_cell, e.g. 'D4'." },
      value: { type: [ 'string', 'number', 'boolean' ], description: 'Value to write for set_cell.' },
      value_type: { type: 'string', enum: [ 'auto', 'text', 'number', 'boolean' ], description: 'How to coerce value. Default auto.' },
      values: { type: 'array', items: { type: [ 'string', 'number', 'boolean', 'null' ] }, description: 'Row values for add_row.' },
      old: { type: 'string', description: 'Current sheet name for rename_sheet.' },
      new: { type: 'string', description: 'New sheet name for rename_sheet.' },
      name: { type: 'string', description: 'Sheet name for add_sheet / delete_sheet.' },
      hyperlink_target: {
        type: 'string',
        description:
          'With set_cell, binds the cell to this http(s) or mailto URL while the cell still displays ' +
          'the value you supply. Use this to show a work-item number that opens the work item.',
      },
      ...XLSX_STYLE_PROPS,
      output_name: { type: 'string', description: 'Override the output filename. Defaults to edited-<source stem>.xlsx.' },
    },
    required: [ 'source_file', 'action' ],
  },
};

export const docxEditToolDefinition = {
  name: 'docx_edit',
  description:
    'Edit an existing Word document (.docx) IN PLACE. replace_text rewrites only the affected runs and ' +
    'searches body paragraphs, headings, tables, headers and footers in one call, so formatting survives. ' +
    'Other actions add paragraphs, images, tables and page breaks, set fonts, or recolour the accent ' +
    'theme. "inspect" is read-only. Use this instead of document_render when the user has an existing ' +
    'document: document_render creates a new file and would lose its content and styling.',
  inputSchema: {
    type: 'object',
    properties: {
      source_file: { type: 'string', description: 'Filename of the document to edit, in the uploads or downloads directory.' },
      action: {
        type: 'string',
        enum: [ 'replace_text', 'add_paragraph', 'add_image', 'add_table', 'set_font', 'add_page_break', 'recolour', 'inspect' ],
        description: 'The edit to perform.',
      },
      old: { type: 'string', description: 'Text to replace, for replace_text.' },
      new: { type: 'string', description: 'Replacement text, for replace_text. May be empty to delete the text.' },
      text: { type: 'string', description: 'Paragraph text, for add_paragraph.' },
      image: { type: 'string', description: 'Image filename in the uploads or downloads directory, for add_image.' },
      rows: { type: 'number', description: 'Table rows for add_table. Default 3.' },
      cols: { type: 'number', description: 'Table columns for add_table. Default 4.' },
      font_name: { type: 'string', description: 'Font name. Default Calibri.' },
      font_size: { type: 'number', description: 'Font size in points. Default 11.' },
      bold: { type: 'boolean', description: 'Bold on or off.' },
      alignment: { type: 'string', enum: [ 'left', 'center', 'right', 'justify' ], description: 'Paragraph alignment.' },
      accent: { type: 'string', description: "Accent hex for recolour, e.g. '1F4E79'. Default 287868." },
      header_text: { type: 'string', description: 'Set the first-section header text.' },
      footer_text: { type: 'string', description: 'Set the first-section footer text.' },
      output_name: { type: 'string', description: 'Override the output filename. Defaults to edited-<source stem>.docx.' },
    },
    required: [ 'source_file', 'action' ],
  },
};

export const pptxEditToolDefinition = {
  name: 'pptx_edit',
  description:
    'Edit an existing PowerPoint deck (.pptx) IN PLACE. replace_text walks grouped shapes and table cells ' +
    'recursively and mutates only the run text, so run-level formatting is preserved. add_slide uses the ' +
    "deck's own layout rather than assuming a slide size, so geometry is preserved. \"list\" is read-only. " +
    'Use this instead of pptx_render when the user has an existing deck.',
  inputSchema: {
    type: 'object',
    properties: {
      source_file: { type: 'string', description: 'Filename of the deck to edit, in the uploads or downloads directory.' },
      action: {
        type: 'string',
        enum: [ 'replace_text', 'add_slide', 'add_image', 'set_title', 'list' ],
        description: 'The edit to perform.',
      },
      old: { type: 'string', description: 'Text to replace, for replace_text.' },
      new: { type: 'string', description: 'Replacement text, for replace_text.' },
      title: { type: 'string', description: 'Slide title, for add_slide and set_title.' },
      body: { type: 'string', description: 'Body text, for add_slide.' },
      image: { type: 'string', description: 'Image filename in the uploads or downloads directory, for add_image.' },
      slide_index: { type: 'number', description: '0-based slide index for add_image and set_title.' },
      output_name: { type: 'string', description: 'Override the output filename. Defaults to edited-<source stem>.pptx.' },
    },
    required: [ 'source_file', 'action' ],
  },
};

/** Question object schema, shared by the homework sections. */
const HOMEWORK_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'number', description: 'Question number within the assignment.' },
    text: { type: 'string', description: 'The question as the student reads it.' },
    answer: { type: 'string', description: 'The expected answer. REQUIRED, and never written to the output: it is stripped before rendering and held for marking at the next session.' },
    points: { type: 'number' },
    time_estimate_seconds: { type: 'number' },
    diagram: { type: 'string', description: 'Optional diagram description.' },
  },
  required: [ 'number', 'text', 'answer' ],
};

export const homeworkRenderToolDefinition = {
  name: 'homework_render',
  description:
    'Create a homework assignment as a downloadable Word document plus a matching HTML preview, from a ' +
    'structured spec. This is the tutoring pipeline render path. Every question must carry its answer: ' +
    'answers are stripped before rendering and NEVER appear in either artefact, and are retained for ' +
    'marking at the next session. Set dry_run to validate a spec and get the full errors array without ' +
    'writing any file. A spec that fails validation is rejected outright rather than rendered partially.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'The homework specification.',
        properties: {
          title: { type: 'string', description: 'Assignment title; also the filename slug.' },
          student_name: { type: 'string' },
          subject: { type: 'string' },
          session_date: { type: 'string', description: 'YYYY-MM-DD.' },
          due_date: { type: 'string', description: 'YYYY-MM-DD.' },
          estimated_minutes: { type: 'number' },
          instructions: { type: 'string', description: 'Top instruction block.' },
          sections: {
            type: 'array',
            description: 'Ordered sections.',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string', description: 'Section heading.' },
                difficulty: { type: 'string', enum: [ 'Core', 'Stretch', 'Extension' ] },
                questions: { type: 'array', items: HOMEWORK_QUESTION_SCHEMA },
              },
              required: [ 'topic', 'questions' ],
            },
          },
          user_id: { type: 'number', description: 'Sidebar registration binding. Default 38.' },
          tenant_id: { type: 'string', description: "Default 'ava'." },
          ttl_days: { type: 'number', description: 'Sidebar link retention in days. Default 3, matching the connector link expiry.' },
        },
        required: [ 'title', 'student_name', 'subject', 'session_date', 'due_date', 'instructions', 'sections' ],
      },
      dry_run: { type: 'boolean', description: 'Validate the spec and return valid plus an errors array without writing any file.' },
    },
    required: [ 'spec' ],
  },
};

export const EDIT_TOOL_DEFINITIONS = [
  xlsxEditToolDefinition,
  docxEditToolDefinition,
  pptxEditToolDefinition,
  homeworkRenderToolDefinition,
];

export const EDIT_TOOL_NAMES = new Set( EDIT_TOOL_DEFINITIONS.map( ( t ) => t.name ) );

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** @param {object} [input] @returns {Promise<object>} */
export async function handleXlsxEdit( input = {} ) {
  return handleEdit( {
    tool: 'xlsx_edit',
    scriptFile: editorScripts().xlsx,
    ext: extname( String( input?.source_file || '' ) ).toLowerCase() === '.xlsm' ? '.xlsm' : '.xlsx',
    buildArgv: xlsxArgv,
  }, input );
}

/** @param {object} [input] @returns {Promise<object>} */
export async function handleDocxEdit( input = {} ) {
  return handleEdit( {
    tool: 'docx_edit',
    scriptFile: editorScripts().docx,
    ext: '.docx',
    buildArgv: docxArgv,
  }, input );
}

/** @param {object} [input] @returns {Promise<object>} */
export async function handlePptxEdit( input = {} ) {
  return handleEdit( {
    tool: 'pptx_edit',
    scriptFile: editorScripts().pptx,
    ext: '.pptx',
    buildArgv: pptxArgv,
  }, input );
}

/**
 * Route an edit tool call.
 *
 * Returns null for any name this module does not own, so the caller's switch
 * can fall through to its own default.
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object|null>}
 */
export async function dispatchEditTool( name, args ) {
  if ( ! EDIT_TOOL_NAMES.has( name ) ) return null;

  if ( ! editToolsEnabled() ) {
    return failure( name, 'feature_disabled',
      'The gateway edit tools are not enabled on this connector. Set EDIT_TOOLS_ENABLED=true to enable ' +
      'them. Until then, document editing remains available through script_execute.' );
  }

  switch ( name ) {
    case 'xlsx_edit':       return handleXlsxEdit( args );
    case 'docx_edit':       return handleDocxEdit( args );
    case 'pptx_edit':       return handlePptxEdit( args );
    case 'homework_render': return handleHomeworkRender( args );
    default:                return null;
  }
}

/**
 * Diagnostic summary of the edit configuration.
 *
 * Paths and limits only. No secret is read by this module.
 *
 * @returns {object}
 */
export function editToolsStatus() {
  const scripts = editorScripts();
  const base = scriptsBase();
  const present = {};

  for ( const file of Object.values( scripts ) ) {
    const r = resolveRenderer( file );
    present[ file ] = r.ok ? 'present' : r.kind;
  }

  return {
    enabled: editToolsEnabled(),
    tools: [ ...EDIT_TOOL_NAMES ],
    scripts_dir: base,
    scripts_dir_present: existsSync( base ),
    editors: present,
    uploads_dir: uploadsBase(),
    downloads_dir: downloadsBase(),
    staging_dir: stagingBase(),
    spec_max_bytes: specMaxBytes(),
    edit_timeout_seconds: Math.round( renderTimeoutMs() / 1000 ),
  };
}

export default {
  EDIT_TOOL_DEFINITIONS,
  EDIT_TOOL_NAMES,
  dispatchEditTool,
  handleXlsxEdit,
  handleDocxEdit,
  handlePptxEdit,
  handleHomeworkRender,
  editToolsEnabled,
  editToolsStatus,
};
