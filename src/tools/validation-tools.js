// src/tools/validation-tools.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-TOOL-003 -- First-class CODE and ERP CONFIG validation.
//
// Registers three first-class gateway tools in the connector tool registry:
//
//     code_syntax          (structure and parseability, per language)
//     code_integrity       (safety, completeness, WordPress and SQL injection)
//     erp_config_validator (ERP config docs vs template and hallucination lists)
//
// WHY THIS MODULE EXISTS
// ----------------------
// SPEC-GTW-DOC-001 registered the render tools and SPEC-GTW-TOOL-001 the
// editors. Those two produce and modify documents. These three assess them,
// which completes the toolchain from the other end: the model can validate the
// code it just wrote and the ERP configuration document it just produced,
// without hand-building a script_execute call.
//
// THE SPEC-CONVENTION CONTRACT, AND WHY IT IS THE WHOLE DESIGN
// ------------------------------------------------------------
// All three scripts take exactly one argument, `--input <path>`, and that path
// is NOT the file to check. It is a temp file containing a JSON spec:
//
//     { "filename": "...", "content": "...", "language": "...", "platform": "..." }
//
// The scripts read that spec, pull out filename/content/language, and then
// validate the real target. Appendix A of the spec records that the first
// build got this backwards and treated --input as the target directly. The
// gateway's job here is to construct that spec correctly every time, which is
// the whole reason these are tools rather than remembered CLI incantations.
//
// The scripts parse argv with a hand-rolled loop that SKIPS unrecognised
// arguments rather than rejecting them, so there is no argparse ladder to walk
// and no --output hazard: one argv form is correct by construction.
//
// EXIT CODE IS NOT THE VERDICT
// ----------------------------
// A validator that finds problems has done its job. All three print their JSON
// report and exit 0 whether the verdict is pass, warnings or fail; a non-zero
// exit means the validator itself could not run. So this module reads `status`
// from the contract and never infers a verdict from the exit code. Conflating
// the two would report every failing file as a broken tool.
//
// STYLE FINDINGS NEVER FAIL A BUILD
// ---------------------------------
// The class taxonomy is load-bearing (spec 4.1): class_a is structure, class_c
// is security, class_d is style. The scripts already compute status so that
// class_d alone yields "warnings" rather than "fail". This module surfaces the
// class counts explicitly so a caller can act on that distinction rather than
// re-deriving it from the issues array.
//
// SECURITY
// --------
//   - Validator script names are gateway-side constants, never read from tool
//     input; any input key naming a script is ignored and reported.
//   - `filename` is contained to the uploads, downloads or scripts directory
//     through resolveContained(). Without that, a validator that reads any
//     path it is given is an arbitrary-file-read primitive: its findings quote
//     matched source text, so /etc/shadow would come back as a "hardcoded
//     credential" finding with the line in it.
//   - Subprocesses are spawned with an argument array and no shell, using the
//     shared minimal environment. No credential is inherited.
//
// FEATURE FLAG
// ------------
// VALIDATION_TOOLS_ENABLED=true turns these on. Default off, matching how the
// render and edit tools shipped.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join as joinPath } from 'node:path';

import { resolveContained } from '../utils/pathContainment.js';
import { downloadsBase } from '../utils/downloadLinks.js';

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
} from './render-tools.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Characters of subprocess output kept when reporting a failure. */
const OUTPUT_TAIL_CHARS = 2000;

/** Bytes of a file read for platform sniffing. The header block is at the top. */
const PLATFORM_SNIFF_BYTES = 4096;

/**
 * Feature flag.
 *
 * @returns {boolean}
 */
export function validationToolsEnabled() {
  return String( process.env.VALIDATION_TOOLS_ENABLED || '' ).trim().toLowerCase() === 'true';
}

/**
 * Validator script paths, resolved from gateway-side constants.
 *
 * NOTE THE NESTED DIRECTORY. These three live in a `scripts/` subdirectory of
 * the scripts base -- /data/skill/ava/scripts/scripts/code-syntax-check.py --
 * unlike every renderer, which sits directly in the base. A bare filename here
 * resolves to a path that does not exist and the tool reports renderer_missing,
 * which is a confusing way to learn about a directory layout.
 *
 * resolveContained() handles the nested candidate correctly: it checks lexical
 * containment and then verifies physically with realpath, so the subdirectory
 * is permitted while traversal and symlink escape still are not.
 *
 * @returns {{syntax: string, integrity: string, erp: string}}
 */
export function validatorScripts() {
  return {
    syntax:    String( process.env.VALIDATE_SCRIPT_SYNTAX    || 'scripts/code-syntax-check.py' ).trim(),
    integrity: String( process.env.VALIDATE_SCRIPT_INTEGRITY || 'scripts/code-integrity-check.py' ).trim(),
    erp:       String( process.env.VALIDATE_SCRIPT_ERP       || 'scripts/erp-config-validator.py' ).trim(),
  };
}

// ---------------------------------------------------------------------------
// Small local helpers
//
// Near-duplicates of render-tools.js internals, duplicated rather than exported
// from there for the reason given in the header of edit-tools.js: that module
// is 2,070 lines with four shipped tools depending on it, and this change is
// additive.
// ---------------------------------------------------------------------------

/** @param {*} v @returns {boolean} */
function isPlainObject( v ) {
  return typeof v === 'object' && v !== null && ! Array.isArray( v );
}

/** @param {*} v @returns {boolean} */
function isNonEmptyString( v ) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** @param {object} payload @param {boolean} [isError] @returns {object} */
function mcp( payload, isError = false ) {
  return { content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ], isError };
}

/** @param {string} tool @param {string} kind @param {string} message @param {object} [extra] @returns {object} */
function failure( tool, kind, message, extra = {} ) {
  return mcp( { ok: false, tool, error_kind: kind, error: message, ...extra }, true );
}

/** @param {string} text @returns {string} */
function tail( text ) {
  const s = String( text || '' );
  if ( s.length <= OUTPUT_TAIL_CHARS ) return s;
  return `...[truncated ${ s.length - OUTPUT_TAIL_CHARS } chars]...\n${ s.slice( -OUTPUT_TAIL_CHARS ) }`;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Directories a `filename` target may live in.
 *
 * The scripts directory is included deliberately, and it is the one addition
 * over the edit tools' uploads-and-downloads pair: spec test T1 validates
 * code_syntax_lib.py, a file on the volume, and reviewing a script before
 * running it is the point of a syntax checker. script_read already exposes the
 * same directory, so no new reach is granted.
 *
 * @returns {Array<{dir: string, from: string}>}
 */
function targetBases() {
  return [
    { dir: uploadsBase(),   from: 'uploads' },
    { dir: downloadsBase(), from: 'downloads' },
    { dir: scriptsBase(),   from: 'scripts' },
  ];
}

/**
 * Resolve and contain a `filename` target.
 *
 * @param {string} raw
 * @returns {{ok: true, path: string, filename: string, from: string}
 *          |{ok: false, kind: string, message: string}}
 */
export function resolveTargetFile( raw ) {
  if ( ! isNonEmptyString( raw ) ) {
    return { ok: false, kind: 'invalid_parameters', message: 'filename must be a non-empty string.' };
  }

  const candidate = raw.trim();
  const tried = [];

  for ( const { dir, from } of targetBases() ) {
    tried.push( dir );
    let rel = candidate;
    if ( candidate.startsWith( '/' ) ) {
      // Reduce an absolute path against this base so that a path genuinely
      // inside it is accepted, while one outside every base still ends as a
      // refusal rather than as a confusing "not found".
      if ( candidate === dir ) rel = '';
      else if ( candidate.startsWith( `${ dir }/` ) ) rel = candidate.slice( dir.length + 1 );
      else continue;
    }
    const full = resolveContained( dir, rel );
    if ( full && existsSync( full ) ) return { ok: true, path: full, filename: basename( full ), from };
  }

  return {
    ok: false,
    kind: 'target_not_found',
    message:
      `filename "${ basename( candidate ) }" was not found in ${ tried.join( ', ' ) }. ` +
      'Upload the file, name a file this connector produced, name a script on the volume, ' +
      'or pass the code inline as `content` instead. Paths outside those directories are not accepted.',
  };
}

// ---------------------------------------------------------------------------
// Platform detection for erp_config_validator
// ---------------------------------------------------------------------------

/**
 * Platform keys the validator's own pattern table is keyed by.
 *
 * These strings are matched by the script with `key.lower() in platform.lower()`,
 * so the value handed over must CONTAIN the key. "sap" does not match
 * "SAP S/4HANA Cloud" and silently disables every platform check.
 */
const PLATFORM_KEYS = [
  'SAP S/4HANA Cloud',
  'D365 F&O',
  'Oracle',
  'Workday',
];

/**
 * Aliases a caller or a document is likely to use, mapped to the exact key.
 *
 * Ordered longest-intent first: 's/4hana' must be tested before a bare 'sap'
 * so a document saying "SAP S/4HANA Cloud" resolves to the S/4HANA entry.
 */
const PLATFORM_ALIASES = [
  [ /s\/?4\s*hana|s4hana/i,                    'SAP S/4HANA Cloud' ],
  [ /\bsap\b/i,                                'SAP S/4HANA Cloud' ],
  [ /d365|dynamics\s*365|f&o|finance\s*(and|&)\s*operations/i, 'D365 F&O' ],
  [ /\boracle\b|fusion/i,                      'Oracle' ],
  [ /\bworkday\b/i,                            'Workday' ],
];

/**
 * Resolve a caller-supplied or document-declared platform to an exact key.
 *
 * WHY THE GATEWAY DOES THIS RATHER THAN THE SCRIPT.
 *
 * The validator applies its forbidden-pattern set only when `platform`
 * contains one of its literal keys. Given platform "sap" it reports
 * "No platform-specific pattern set" and PASSES that check -- so a document
 * full of T-codes, IMG and SPRO paths comes back clean. A validator that
 * quietly skips its most important check on a plausible input is worse than no
 * validator, because the caller reads the pass as evidence.
 *
 * Requiring the session to know the exact key string is precisely the
 * remembered-incantation problem these tools exist to remove, so the mapping
 * lives here. The document's own "Platform Version:" header is used when the
 * caller says nothing, which is spec test T9: the fixture is an S/4HANA Cloud
 * document and the T-code must be caught without anyone naming the platform.
 *
 * @param {string} declared  Caller-supplied platform, may be empty.
 * @param {string} content   Document text used for sniffing, may be empty.
 * @returns {{platform: string|null, source: string}}
 */
export function resolvePlatform( declared, content = '' ) {
  const exact = ( s ) => PLATFORM_KEYS.find( ( k ) => String( s ).toLowerCase().includes( k.toLowerCase() ) );

  if ( isNonEmptyString( declared ) ) {
    const hit = exact( declared ) || ( PLATFORM_ALIASES.find( ( [ re ] ) => re.test( declared ) ) || [] )[ 1 ];
    if ( hit ) return { platform: hit, source: 'caller' };
    // Unrecognised but supplied: pass it through untouched rather than
    // overriding it. The caller may be targeting a pattern set added to the
    // script after this module was written.
    return { platform: declared.trim(), source: 'caller_verbatim' };
  }

  const head = String( content || '' ).slice( 0, PLATFORM_SNIFF_BYTES );
  if ( ! head ) return { platform: null, source: 'none' };

  // Prefer the declared header line; fall back to the body.
  const header = ( head.match( /^\s*Platform\s*Version\s*:\s*(.+)$/im ) || [] )[ 1 ] || '';
  for ( const scope of [ header, head ] ) {
    if ( ! scope ) continue;
    const hit = exact( scope ) || ( PLATFORM_ALIASES.find( ( [ re ] ) => re.test( scope ) ) || [] )[ 1 ];
    if ( hit ) return { platform: hit, source: scope === header ? 'document_header' : 'document_body' };
  }

  return { platform: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Write the JSON spec the script expects to the staging directory.
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
    return { ok: false, kind: 'spec_not_serializable', message: `The spec could not be serialized to JSON: ${ err.message }.` };
  }
  if ( typeof serialized !== 'string' ) {
    return { ok: false, kind: 'spec_not_serializable', message: 'The spec serialized to undefined.' };
  }

  const bytes = Buffer.byteLength( serialized, 'utf8' );
  const limit = specMaxBytes();
  if ( bytes > limit ) {
    return {
      ok: false,
      kind: 'content_too_large',
      message:
        `The serialized spec is ${ bytes } bytes, which exceeds the ${ limit } byte limit. ` +
        'Nothing was validated and nothing was truncated. Pass the file by name instead of inline, ' +
        'validate it in parts, or raise RENDER_SPEC_MAX_BYTES.',
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

/** @param {string|null} path @returns {void} */
function cleanupStaged( path ) {
  if ( ! path ) return;
  try { unlinkSync( path ); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Shared validator handler  (spec section 5)
// ---------------------------------------------------------------------------

/**
 * Summarise a report for the caller, without discarding anything.
 *
 * The full report is always returned as `report`. These fields sit beside it
 * so a caller can branch on the verdict without walking the issues array, and
 * so the class distinction that decides whether a build fails is explicit
 * rather than implied.
 *
 * @param {object|null} report
 * @returns {object}
 */
function summarise( report ) {
  if ( ! isPlainObject( report ) ) return {};

  const s = isPlainObject( report.summary ) ? report.summary : {};
  const issues = Array.isArray( report.issues ) ? report.issues : [];
  const errors = Array.isArray( report.errors ) ? report.errors : [];
  const warnings = Array.isArray( report.warnings ) ? report.warnings : [];

  return {
    status: report.status,
    ...( report.language ? { language: report.language } : {} ),
    ...( report.platform ? { platform: report.platform } : {} ),
    ...( report.file_path ? { file_path: report.file_path } : {} ),
    issue_count: issues.length || ( errors.length + warnings.length ),
    error_count: errors.length,
    warning_count: warnings.length,
    ...( Object.keys( s ).length ? { class_counts: {
      class_a_structure: s.class_a_errors,
      class_b: s.class_b_errors,
      class_c_security: s.class_c_security,
      class_d_style: s.class_d_style,
      class_e_compat: s.class_e_compat,
    } } : {} ),
    ...( Array.isArray( report.checks_run ) ? { checks_run: report.checks_run } : {} ),
    ...( Array.isArray( report.missing_sections ) ? { missing_sections: report.missing_sections } : {} ),
  };
}

/**
 * The procedural sequence, shared by all three validators.
 *
 *   1. Report and ignore any executable-selecting input key.
 *   2. Require exactly one of filename or content.
 *   3. Resolve and contain a filename target.
 *   4. Resolve the validator from a gateway constant.
 *   5. Build the JSON spec, size-check it, stage it.
 *   6. Invoke with the single documented argv form.
 *   7. Return the report. `status` is the verdict; the exit code is not.
 *
 * @param {object} cfg
 * @param {string} cfg.tool
 * @param {string} cfg.scriptFile
 * @param {(args: object, target: object|null, content: string) => object} cfg.buildSpec
 * @param {object} input
 * @returns {Promise<object>}
 */
async function handleValidate( cfg, input ) {
  const { tool, scriptFile, buildSpec } = cfg;
  const args = isPlainObject( input ) ? input : {};

  // ---- Step 1.
  const ignored = detectInjectionKeys( args );
  if ( ignored.length > 0 ) {
    console.error(
      `[validation-tools] ${ tool }: ignoring caller-supplied ${ ignored.join( ', ' ) }; ` +
      'the validator path is a gateway constant.'
    );
  }
  const ignoredField = ignored.length ? { ignored_parameters: ignored } : {};

  // ---- Step 2.
  const hasFilename = isNonEmptyString( args.filename );
  const hasContent  = typeof args.content === 'string' && args.content.length > 0;

  if ( ! hasFilename && ! hasContent ) {
    return failure( tool, 'invalid_parameters',
      'Supply either filename (a file in the uploads, downloads or scripts directory) or content ' +
      '(the code or document text inline). Nothing was validated.',
      ignoredField );
  }

  // ---- Step 3.
  let target = null;
  if ( hasFilename ) {
    target = resolveTargetFile( args.filename );
    if ( ! target.ok ) {
      return failure( tool, target.kind, target.message, {
        uploads_dir: uploadsBase(),
        downloads_dir: downloadsBase(),
        scripts_dir: scriptsBase(),
        ...ignoredField,
      } );
    }
  }

  // Content used for platform sniffing. Inline content is already in hand; a
  // named file is read only at the head, which is where the header block is.
  let sniff = hasContent ? args.content : '';
  if ( ! sniff && target ) {
    try {
      const size = statSync( target.path ).size;
      const buf = readFileSync( target.path );
      sniff = buf.subarray( 0, Math.min( size, PLATFORM_SNIFF_BYTES ) ).toString( 'utf8' );
    } catch { sniff = ''; }
  }

  // ---- Step 4.
  const resolved = resolveRenderer( scriptFile );
  if ( ! resolved.ok ) {
    return failure( tool, resolved.kind, resolved.message, {
      validator: scriptFile,
      scripts_dir: scriptsBase(),
      ...ignoredField,
    } );
  }

  // ---- Step 5.
  const { spec, meta } = buildSpec( args, target, sniff );
  const staged = stageSpec( spec, tool );
  if ( ! staged.ok ) {
    return failure( tool, staged.kind, staged.message, {
      ...( staged.bytes !== undefined ? { content_bytes: staged.bytes } : {} ),
      ...( staged.limit !== undefined ? { content_max_bytes: staged.limit } : {} ),
      ...ignoredField,
    } );
  }

  try {
    // ---- Step 6. One form: the scripts skip unrecognised argv rather than
    // rejecting it, so there is nothing to probe and no --output hazard.
    const run = runRenderer( {
      scriptPath: resolved.path,
      scriptFile,
      forms: [ [ '--input', staged.path ] ],
      values: {},
      outputDir: stagingBase(),
    } );

    if ( run.spawn_error ) {
      return failure( tool, 'interpreter_unavailable',
        `Python could not be started: ${ run.spawn_error }.`, { validator: scriptFile, ...ignoredField } );
    }
    if ( run.timed_out ) {
      return failure( tool, 'validation_timeout',
        `${ scriptFile } exceeded the ${ Math.round( renderTimeoutMs() / 1000 ) } second timeout. ` +
        'Validate a smaller file, or raise RENDER_TIMEOUT_SECONDS.',
        { validator: scriptFile, stderr_tail: tail( run.stderr ), ...ignoredField } );
    }

    const report = parseRendererContract( run.stdout );

    // ---- Step 7. A report with a status is the answer, whatever the exit
    // code. The scripts exit 0 for pass, warnings AND fail; a non-zero exit or
    // an `error` key means the validator itself could not run, and only that
    // is a tool failure.
    if ( ! report || report.error ) {
      return failure( tool, 'validation_failed',
        ( report && report.error )
          || `${ scriptFile } produced no report (exit ${ run.status }).`,
        {
          validator: scriptFile,
          exit_code: run.status,
          stdout_tail: tail( run.stdout ),
          stderr_tail: tail( run.stderr ),
          ...ignoredField,
        } );
    }

    return mcp( {
      ok: true,
      tool,
      validator: scriptFile,
      target: target ? target.filename : '<inline>',
      target_from: target ? target.from : 'inline',
      ...summarise( report ),
      ...meta,
      // The whole report, never trimmed. A caller acting on findings needs the
      // line numbers and messages, and a summary that dropped them would send
      // them back to script_execute.
      report,
      execution_time_ms: run.elapsed_ms,
      ...ignoredField,
    } );

  } finally {
    cleanupStaged( staged.path );
  }
}

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

/**
 * Spec for the two code validators.
 *
 * `language` is passed only when the caller supplied it; the scripts detect it
 * from the filename extension or a content signature otherwise, and their
 * detection is the authority (spec 4.1).
 *
 * @param {object} args
 * @param {object|null} target
 * @returns {{spec: object, meta: object}}
 */
function buildCodeSpec( args, target ) {
  const spec = {};
  if ( target ) spec.filename = target.path;
  else spec.filename = isNonEmptyString( args.filename ) ? args.filename.trim() : '<inline>';
  if ( typeof args.content === 'string' && args.content.length > 0 ) spec.content = args.content;
  if ( isNonEmptyString( args.language ) ) spec.language = args.language.trim().toLowerCase();
  return { spec, meta: {} };
}

/**
 * Spec for the ERP config validator.
 *
 * The platform is resolved to the exact key the script's pattern table uses,
 * from the caller or from the document's own header. See resolvePlatform().
 *
 * @param {object} args
 * @param {object|null} target
 * @param {string} sniff
 * @returns {{spec: object, meta: object}}
 */
function buildErpSpec( args, target, sniff ) {
  const spec = {};
  if ( target ) spec.filename = target.path;
  if ( typeof args.content === 'string' && args.content.length > 0 ) spec.content = args.content;

  const { platform, source } = resolvePlatform( args.platform, sniff );
  if ( platform ) spec.platform = platform;

  return {
    spec,
    meta: {
      platform_resolved: platform || null,
      platform_source: source,
      ...( platform ? {} : {
        platform_note:
          'No platform was supplied and none could be read from the document header, so ' +
          'platform-specific forbidden patterns (SAP T-codes, IMG, SPRO; D365 AX 2012 conflation) ' +
          'were NOT applied. Pass platform explicitly to enable them.',
      } ),
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Shared properties for the two code validators. */
const CODE_PROPS = {
  filename: {
    type: 'string',
    description: 'File to validate, in the uploads, downloads or scripts directory. Either this or content.',
  },
  content: {
    type: 'string',
    description: 'Code to validate inline. Either this or filename. Use this for code you just wrote.',
  },
  language: {
    type: 'string',
    description:
      'Override the language. Detected from the file extension or a content signature when omitted. ' +
      'Supported: python, javascript, typescript, php, css, html, sql, json, shell.',
  },
};

export const codeSyntaxToolDefinition = {
  name: 'code_syntax',
  description:
    'Check that code is structurally sound and parseable, and report problems with line numbers. ' +
    'Python is checked with the real parser (ast), so a verdict on Python is authoritative rather than ' +
    'heuristic; JavaScript, TypeScript, PHP, CSS, HTML, SQL, JSON and shell are checked for bracket, ' +
    'quote, tag and heredoc balance. Also scans for hardcoded credentials and placeholder/TODO markers. ' +
    'Use this before handing code to a user or writing it to a file. Style findings are reported as ' +
    'warnings and never make the status fail.',
  inputSchema: {
    type: 'object',
    properties: { ...CODE_PROPS },
  },
};

export const codeIntegrityToolDefinition = {
  name: 'code_integrity',
  description:
    'Check that code is safe, complete and consistent: incomplete function bodies and placeholder stubs, ' +
    'references to undefined symbols, unreachable code, SQL injection through string-concatenated ' +
    'queries, WordPress security (raw $_GET/$_POST/$_REQUEST access, missing nonce verification, missing ' +
    'capability checks), and hardcoded credentials or API keys. Complements code_syntax, which answers ' +
    '"does it parse"; this answers "is it safe and finished". Every category runs even on code that does ' +
    'not parse.',
  inputSchema: {
    type: 'object',
    properties: { ...CODE_PROPS },
  },
};

export const erpConfigValidatorToolDefinition = {
  name: 'erp_config_validator',
  description:
    'Validate an ERP configuration instructions document against the 18-section template and the ' +
    'anti-hallucination checklists. Checks required sections and header fields, that every step names a ' +
    'source with an authority level, step sequencing, example markers on customer-specific values, and ' +
    'the absence of em dashes and truncation markers. Applies platform-specific forbidden patterns: SAP ' +
    'S/4HANA Cloud must not reference transaction codes, IMG or SPRO, and Dynamics 365 must not conflate ' +
    'AX 2012 navigation. The platform is read from the document header when you do not supply it.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Document to validate, in the uploads, downloads or scripts directory. Either this or content.',
      },
      content: {
        type: 'string',
        description: 'Document text inline (markdown or plain text). Either this or filename.',
      },
      platform: {
        type: 'string',
        description:
          'Target platform, e.g. "SAP S/4HANA Cloud", "D365 F&O", "Oracle", "Workday". Read from the ' +
          "document's Platform Version header when omitted. Platform-specific checks are skipped " +
          'entirely if neither is available.',
      },
    },
  },
};

export const VALIDATION_TOOL_DEFINITIONS = [
  codeSyntaxToolDefinition,
  codeIntegrityToolDefinition,
  erpConfigValidatorToolDefinition,
];

export const VALIDATION_TOOL_NAMES = new Set( VALIDATION_TOOL_DEFINITIONS.map( ( t ) => t.name ) );

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** @param {object} [input] @returns {Promise<object>} */
export async function handleCodeSyntax( input = {} ) {
  return handleValidate( {
    tool: 'code_syntax',
    scriptFile: validatorScripts().syntax,
    buildSpec: buildCodeSpec,
  }, input );
}

/** @param {object} [input] @returns {Promise<object>} */
export async function handleCodeIntegrity( input = {} ) {
  return handleValidate( {
    tool: 'code_integrity',
    scriptFile: validatorScripts().integrity,
    buildSpec: buildCodeSpec,
  }, input );
}

/** @param {object} [input] @returns {Promise<object>} */
export async function handleErpConfigValidator( input = {} ) {
  return handleValidate( {
    tool: 'erp_config_validator',
    scriptFile: validatorScripts().erp,
    buildSpec: buildErpSpec,
  }, input );
}

/**
 * Route a validation tool call. Returns null for a name this module does not own.
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object|null>}
 */
export async function dispatchValidationTool( name, args ) {
  if ( ! VALIDATION_TOOL_NAMES.has( name ) ) return null;

  if ( ! validationToolsEnabled() ) {
    return failure( name, 'feature_disabled',
      'The gateway validation tools are not enabled on this connector. Set ' +
      'VALIDATION_TOOLS_ENABLED=true to enable them. Until then, validation remains available ' +
      'through script_execute.' );
  }

  switch ( name ) {
    case 'code_syntax':          return handleCodeSyntax( args );
    case 'code_integrity':       return handleCodeIntegrity( args );
    case 'erp_config_validator': return handleErpConfigValidator( args );
    default:                     return null;
  }
}

/**
 * Diagnostic summary of the validation configuration.
 *
 * @returns {object}
 */
export function validationToolsStatus() {
  const scripts = validatorScripts();
  const present = {};
  for ( const file of Object.values( scripts ) ) {
    const r = resolveRenderer( file );
    present[ file ] = r.ok ? 'present' : r.kind;
  }

  return {
    enabled: validationToolsEnabled(),
    tools: [ ...VALIDATION_TOOL_NAMES ],
    scripts_dir: scriptsBase(),
    scripts_dir_present: existsSync( scriptsBase() ),
    validators: present,
    staging_dir: stagingBase(),
    content_max_bytes: specMaxBytes(),
    validation_timeout_seconds: Math.round( renderTimeoutMs() / 1000 ),
  };
}

export default {
  VALIDATION_TOOL_DEFINITIONS,
  VALIDATION_TOOL_NAMES,
  dispatchValidationTool,
  handleCodeSyntax,
  handleCodeIntegrity,
  handleErpConfigValidator,
  validationToolsEnabled,
  validationToolsStatus,
};
