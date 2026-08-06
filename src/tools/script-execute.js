// src/tools/script-execute.js  v1.0.0
// ---------------------------------------------------------------------------
// MCP tool: script_execute
//
// Runs a Python script from the connector's /data/skill/ava/scripts/ directory
// and returns stdout, stderr, exit code, and any requested output files as
// base64-encoded attachments.
//
// Security:
//   - Path traversal protection: resolvedPath must stay under SCRIPTS_BASE
//   - Only .py files are executable
//   - Hard timeout (default 60s, max 300s)
//   - spawnSync with explicit python3 binary -- no shell execution
//   - Temp files always cleaned up in finally block
//
// Integration:
//   1. Import this file in your tool handler dispatcher
//   2. Add the TOOL_DEFINITION export to your ListTools response
//   3. Route 'script_execute' to handleScriptExecute in your CallTool handler
//
// Required Node.js built-ins: fs, path, child_process
// No new npm dependencies.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { rmSync } from 'fs';
import { resolve as resolvePath, extname, dirname as dirnamePath } from 'node:path';
import { spawnSync } from 'node:child_process';
// v12.28.0 (TNX-C-005): boundary-correct containment replaces the two
// String.prototype.startsWith prefix checks that previously guarded this file.
import { resolveContained } from '../utils/pathContainment.js';
// v12.28.0 (TNX-C-004): shared minimal-environment builder. One implementation,
// used by all five modules in this component that spawn a subprocess.
import { buildScriptEnv as sharedBuildScriptEnv } from '../utils/scriptEnv.js';
// v12.37.0: the connector builds document download URLs itself rather than
// handing CONNECTOR_URL and DOCUMENT_DOWNLOAD_TOKEN to the model. See the
// rationale at the top of src/utils/downloadLinks.js.
import { buildDownloadLinks, snapshotDownloads } from '../utils/downloadLinks.js';

const SCRIPTS_BASE = process.env.SCRIPTS_DIR
  ? resolvePath( process.env.SCRIPTS_DIR )
  : resolvePath( '/data/skill/ava/scripts' );

// ---------------------------------------------------------------------------
// Script environment construction  (v12.28.0 -- TNX-C-004)
//
// The implementation lives in src/utils/scriptEnv.js and is shared with the
// four other modules that spawn Python: homeworkTools.js, socraticTools.js,
// nudgeTools.js and brain-scan-trigger.js. All five had the same
// `{ ...process.env, PYTHONUNBUFFERED: '1' }` defect; the audit named only this
// one. Keeping a second copy here is what produced the divergence the audit
// documents in Section 5.2, so this module deliberately holds none.
//
// See src/utils/scriptEnv.js for the full rationale, the SCRIPT_GRANTABLE_ENV /
// SCRIPT_ENV_MANIFEST two-place grant mechanism, and why the environment is
// built from scratch rather than filtered.
// ---------------------------------------------------------------------------

/**
 * Build the minimal environment for a script spawned by this tool.
 *
 * Thin wrapper preserving this module's original call signature so the unit
 * tests and any external caller keep working. The third parameter is additive
 * and optional, so every existing two-argument call site is unaffected.
 *
 * @param {string} outputDir      Temp directory the script writes results into.
 * @param {string} [scriptKey=''] Script path relative to SCRIPTS_BASE.
 * @param {Record<string,string>} [extra={}]
 *        Already-sanitised caller-supplied variables. MUST be the output of
 *        sanitizeCustomEnv(); never pass raw tool input here.
 * @returns {Record<string, string>} Environment for the child process.
 */
function buildScriptEnv( outputDir, scriptKey = '', extra = {} ) {
  return sharedBuildScriptEnv( { outputDir, scriptKey, extra } );
}

// Exported for the unit tests, which assert that no credential name can reach
// a spawned script through this function.
export { buildScriptEnv };

// ---------------------------------------------------------------------------
// custom_env  (v12.37.0)
//
// Callers may pass a small set of non-inherited, caller-supplied variables into
// the sandbox so that a script can call back into the connector (CONNECTOR_URL,
// DOCUMENT_DOWNLOAD_TOKEN) or open the shared database (DATABASE_URL).
//
// WHY THIS IS AN ALLOWLIST AND NOT A PASS-THROUGH
// -----------------------------------------------
// The obvious implementation is `Object.assign(env, input.custom_env)`. That is
// a sandbox escape, not a convenience:
//
//   custom_env: { "PYTHONSTARTUP": "/tmp/x.py" }   -- executes attacker code
//   custom_env: { "PYTHONPATH": "/tmp" }           -- shadows any import
//   custom_env: { "LD_PRELOAD": "/tmp/evil.so" }   -- hijacks the loader
//   custom_env: { "PATH": "/tmp/bin" }             -- hijacks every subprocess
//
// custom_env is attacker-reachable in exactly the same way script_path is: it
// arrives as tool input, and tool input on this connector originates from a
// language model's output, which is influenced by untrusted document content.
// So the same posture applies -- validate the name against a fixed list rather
// than trying to enumerate the dangerous ones.
//
// The names below are the ceiling. SCRIPT_CUSTOM_ENV_KEYS narrows or widens it
// for an operator who needs a different set, but a name still has to be
// explicitly configured; there is no wildcard.
// ---------------------------------------------------------------------------

/**
 * Names accepted in custom_env when SCRIPT_CUSTOM_ENV_KEYS is unset.
 *
 * DOCUMENT_DOWNLOAD_TOKEN is deliberately NOT here. A script has no reason to
 * hold it: the connector builds the download URL after the script exits and
 * returns it in `download_links`, so the token never has to travel through the
 * caller and back.
 *
 * DATABASE_URL is accepted for the Postgres recall scripts, but the preferred
 * route is still the SCRIPT_ENV_MANIFEST grant in utils/scriptEnv.js, which
 * injects it server-side and never routes the DSN through a model context.
 */
const DEFAULT_CUSTOM_ENV_KEYS = [
  'CONNECTOR_URL',
  'DATABASE_URL',
];

/** Maximum accepted length of a single custom_env value, in characters. */
const CUSTOM_ENV_MAX_VALUE_LENGTH = 4096;

/** Maximum number of custom_env entries accepted in one call. */
const CUSTOM_ENV_MAX_KEYS = 16;

/**
 * Valid POSIX-ish environment variable name. Deliberately upper-case only:
 * every name this feature is meant to carry is upper-case, and the narrower
 * pattern removes any question about case-insensitive collisions with the base
 * environment on a case-folding platform.
 */
const CUSTOM_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Resolve the configured custom_env allowlist.
 *
 * Read on each call rather than cached at module load so that a test (or a
 * platform that mutates process.env after import) sees the current value. The
 * list is tiny, so there is no measurable cost.
 *
 * @returns {Set<string>} Permitted custom_env names.
 */
function customEnvAllowlist() {
  const raw = String( process.env.SCRIPT_CUSTOM_ENV_KEYS || '' ).trim();
  const names = raw
    ? raw.split( ',' ).map( ( n ) => n.trim() ).filter( Boolean )
    : DEFAULT_CUSTOM_ENV_KEYS;

  // A configured name that is not a valid variable name is dropped rather than
  // silently widening the filter.
  return new Set( names.filter( ( n ) => CUSTOM_ENV_NAME_PATTERN.test( n ) ) );
}

/**
 * Validate caller-supplied custom_env down to a safe { name: value } map.
 *
 * Rejections are collected and returned rather than thrown, so that a caller
 * passing one bad key still gets a useful execution plus an explicit list of
 * what was dropped. A silent drop would be the worst outcome here: a script
 * would run without the variable it needs and fail somewhere unrelated.
 *
 * @param {unknown} candidate Raw `custom_env` value from tool input.
 * @returns {{ env: Record<string,string>, rejected: string[] }}
 */
export function sanitizeCustomEnv( candidate ) {
  /** @type {Record<string,string>} */
  const env = {};
  /** @type {string[]} */
  const rejected = [];

  if ( candidate === undefined || candidate === null ) return { env, rejected };

  if ( typeof candidate !== 'object' || Array.isArray( candidate ) ) {
    return { env, rejected: [ 'custom_env must be a JSON object of string values.' ] };
  }

  const allowed = customEnvAllowlist();
  const entries = Object.entries( candidate );

  if ( entries.length > CUSTOM_ENV_MAX_KEYS ) {
    return {
      env,
      rejected: [ `custom_env carries ${ entries.length } keys; the maximum is ${ CUSTOM_ENV_MAX_KEYS }.` ],
    };
  }

  for ( const [ key, value ] of entries ) {
    if ( ! CUSTOM_ENV_NAME_PATTERN.test( key ) ) {
      rejected.push( `${ key }: not a valid environment variable name (expected ^[A-Z][A-Z0-9_]{0,63}$).` );
      continue;
    }

    if ( ! allowed.has( key ) ) {
      rejected.push(
        `${ key }: not permitted. Add it to SCRIPT_CUSTOM_ENV_KEYS to allow it. ` +
        `Currently permitted: ${ [ ...allowed ].join( ', ' ) || '(none)' }.`
      );
      continue;
    }

    if ( typeof value !== 'string' ) {
      rejected.push( `${ key }: value must be a string, received ${ Array.isArray( value ) ? 'array' : typeof value }.` );
      continue;
    }

    // A NUL byte truncates the variable at the execve boundary, so a value
    // containing one does not mean in the child what it means here.
    if ( value.includes( '\0' ) ) {
      rejected.push( `${ key }: value contains a NUL byte.` );
      continue;
    }

    if ( value.length > CUSTOM_ENV_MAX_VALUE_LENGTH ) {
      rejected.push( `${ key }: value is ${ value.length } characters; the maximum is ${ CUSTOM_ENV_MAX_VALUE_LENGTH }.` );
      continue;
    }

    env[ key ] = value;
  }

  return { env, rejected };
}

const MIME_MAP = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv':  'text/csv',
  '.html': 'text/html',
  '.md':   'text/markdown',
  '.txt':  'text/plain',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// ---------------------------------------------------------------------------
// Tool definition — add to your ListTools response
// ---------------------------------------------------------------------------

export const TOOL_DEFINITION = {
  name:        'script_execute',
  description: 'Execute a Python script from the scripts directory and return its output. Use to generate documents, run data analysis, or execute any Python tool previously deployed to the scripts volume.',
  input_schema: {
    type:       'object',
    properties: {
      script_path: {
        type:        'string',
        description: 'Relative path to the script (e.g. "document_render.py"). Must be inside the scripts/ directory.',
      },
      args: {
        type:        'array',
        items:       { type: 'string' },
        description: 'Additional command-line arguments passed directly to the script.',
      },
      input_data: {
        description: 'JSON object or string to pass as input. Written to a temp file and passed to the script via --input <path>.',
      },
      timeout_seconds: {
        type:        'number',
        description: 'Maximum execution time in seconds (default 60, max 300).',
      },
      return_files: {
        type:        'array',
        items:       { type: 'string' },
        description: 'List of output file paths relative to the script\'s output directory to return as base64 attachments. E.g. ["output.pdf", "summary.csv"]',
      },
      download_files: {
        type:        'array',
        items:       { type: 'string' },
        description: 'Filenames the script wrote into the downloads directory that should be turned into shareable links, e.g. ["Quarterly_Report.docx"]. Usually unnecessary: any file the script creates or modifies in that directory is linked automatically. The tool returns a ready-made download_url in its result, so never construct a download URL yourself and never ask for the download token.',
      },
      custom_env: {
        type:                 'object',
        additionalProperties: { type: 'string' },
        description:
          'Optional environment variables to inject into the script process. Only an allowlisted set of names is accepted; every other name is refused and reported in custom_env_rejected. Values must be strings. Not needed for download links, which the connector builds server-side.',
      },
    },
    required: [ 'script_path' ],
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleScriptExecute( toolInput ) {
  const {
    script_path,
    args            = [],
    input_data,
    timeout_seconds = 60,
    return_files    = [],
    download_files  = [],
    custom_env,
  } = toolInput || {};

  // v12.37.0: validated before any filesystem work so that a malformed
  // custom_env is reported without side effects.
  const { env: customEnv, rejected: customEnvRejected } = sanitizeCustomEnv( custom_env );

  if ( customEnvRejected.length > 0 ) {
    // Names only. The values are the whole point of the feature being
    // sensitive, so they never reach a log line.
    console.error( `[script_execute] custom_env entries refused: ${ customEnvRejected.join( ' | ' ) }` );
  }

  // ── Validate script_path ────────────────────────────────────────────────
  if ( ! script_path || typeof script_path !== 'string' ) {
    return { error: 'script_path is required and must be a string.' };
  }

  // v12.28.0 (TNX-C-005) -- containment fix.
  //
  // The previous guard was:
  //   const resolvedPath = resolvePath( SCRIPTS_BASE, script_path );
  //   if ( ! resolvedPath.startsWith( SCRIPTS_BASE ) ) reject();
  //
  // startsWith is a character-prefix test, not a directory boundary test. With
  // SCRIPTS_BASE = /data/skill/ava/scripts, the path
  // /data/skill/ava/scripts_evil/payload.py satisfies startsWith and was
  // accepted, because "scripts_evil" shares the prefix "scripts". resolvePath
  // normalises ".." so classic traversal was already blocked, but the
  // sibling-directory escape was not.
  //
  // resolveContained uses path.relative for the boundary test and additionally
  // refuses symbolic links. That second control matters here specifically:
  // path.resolve is a lexical operation that never touches the filesystem, so
  // a symlink placed inside the scripts directory pointing at, say,
  // /usr/lib/python3/site-packages would have passed every lexical check and
  // then been executed.
  const resolvedPath = resolveContained( SCRIPTS_BASE, script_path );

  if ( ! resolvedPath ) {
    return { error: 'script_path traverses outside the scripts directory, or resolves through a symbolic link. Path rejected.' };
  }

  if ( ! resolvedPath.endsWith( '.py' ) ) {
    return { error: 'Only .py scripts can be executed via this tool.' };
  }

  if ( ! existsSync( resolvedPath ) ) {
    return { error: `Script not found: ${ script_path }. Run script_list to see available scripts.` };
  }

  // ── Prepare temp paths ──────────────────────────────────────────────────
  const stamp     = `${ Date.now() }_${ Math.random().toString( 36 ).slice( 2, 7 ) }`;
  const outputDir = `/tmp/script_execute_output_${ stamp }`;
  let   inputFile = null;

  mkdirSync( outputDir, { recursive: true } );

  // ── Write input_data to temp file if provided ───────────────────────────
  if ( input_data !== undefined && input_data !== null ) {
    inputFile = `/tmp/script_execute_input_${ stamp }.json`;
    const inputContent = typeof input_data === 'string'
      ? input_data
      : JSON.stringify( input_data, null, 2 );
    writeFileSync( inputFile, inputContent, 'utf8' );
  }

  const maxTimeout = Math.min( Math.max( parseInt( timeout_seconds, 10 ) || 60, 1 ), 300 );

  // ── Build command arguments ─────────────────────────────────────────────
  const cmdArgs = [ resolvedPath ];
  if ( inputFile )                    cmdArgs.push( '--input',  inputFile );
  cmdArgs.push( '--output', outputDir );
  if ( Array.isArray( args ) )        cmdArgs.push( ...args );

  // ── Snapshot the downloads directory ────────────────────────────────────
  // Taken before execution so that files the script creates or overwrites can
  // be identified afterwards by diff. This requires no cooperation from the
  // script, which matters because the scripts on the volume predate this
  // feature and none of them report what they wrote.
  const downloadsBefore = snapshotDownloads();

  // ── Execute ─────────────────────────────────────────────────────────────
  // start declared before try so it is accessible in the catch / finally blocks
  const start  = Date.now();
  let result;

  try {
    // Resolve python3 location dynamically (mise-managed on Railway)
const PYTHON_BIN = existsSync('/mise/shims/python3')
  ? '/mise/shims/python3'
  : 'python3';

result = spawnSync( PYTHON_BIN, cmdArgs, {
      cwd:       SCRIPTS_BASE,
      timeout:   maxTimeout * 1000,
      maxBuffer: 50 * 1024 * 1024,
      // v12.28.0 (TNX-C-004) -- environment isolation.
      //
      // This was previously `{ ...process.env, PYTHONUNBUFFERED: '1' }`, which
      // handed every spawned script the connector's complete credential set:
      // ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, PERPLEXITY_API_KEY,
      // XAI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, QWEN_API_KEY, BRAVE_API_KEY,
      // TAVILY_API_KEY, SERPER_API_KEY, GOOGLE_CLIENT_SECRET,
      // GOOGLE_REFRESH_TOKEN, SLACK_BOT_TOKEN, WP_APP_PASSWORD,
      // MEMORY_AUTH_TOKEN, RAILWAY_RESTORE_TOKEN, AVA_MEMORY_WP_KEY and any
      // database URL present. A three-line script posting os.environ to an
      // external host exfiltrated the entire organisation's credentials.
      //
      // The file header's claim that spawnSync "with explicit python3 binary --
      // no shell execution" made this safe addressed shell injection only. It
      // said nothing about environment inheritance, which is a separate channel.
      //
      // The replacement is an explicit allowlist built by buildScriptEnv(). It
      // is constructed from scratch rather than filtered from process.env, so a
      // newly added secret is excluded by default rather than included by
      // default.
      //
      // v12.37.0: the third argument carries caller-supplied variables that
      // have already passed sanitizeCustomEnv(). They are applied by
      // scriptEnv.js AFTER the base environment and are still subject to its
      // PROTECTED set, so this is two independent filters rather than one.
      env:       buildScriptEnv( outputDir, String( script_path ), customEnv ),
    } );

    // ✨ NEW: check for spawnSync-level errors (e.g. ENOENT)
    if ( result.error ) {
      return {
        error:             result.error.message || String( result.error ),
        return_code:       -2,
        execution_time_ms: Date.now() - start,
        stderr:            `spawnSync failed: ${ result.error.code || 'unknown' } — binary not found or not executable`,
      };
    }

    const stdout   = result.stdout?.toString()  || '';
    const stderr   = result.stderr?.toString()  || '';
    const exitCode = result.status;
    const signal   = result.signal || null;
    const elapsed  = Date.now() - start;

    // ── Collect requested output files ──────────────────────────────────
    const files = [];
    if ( Array.isArray( return_files ) && return_files.length > 0 ) {
      for ( const relPath of return_files ) {
        // v12.28.0 (TNX-C-005): same containment defect as the script path
        // guard above. A script could write /tmp/script_execute_output_X_evil/
        // and then name it in return_files; the prefix check accepted it.
        // Symlink refusal matters here too: the script controls the contents of
        // its own output directory and could plant a link to /proc/self/environ.
        const fullPath = resolveContained( outputDir, relPath );
        if ( ! fullPath ) continue;                          // traversal guard
        if ( ! existsSync( fullPath ) ) continue;

        const stats = statSync( fullPath );
        const ext   = extname( fullPath ).toLowerCase();
        files.push( {
          filename:       relPath,
          mime_type:      MIME_MAP[ ext ] || 'application/octet-stream',
          size_bytes:     stats.size,
          content_base64: readFileSync( fullPath ).toString( 'base64' ),
        } );
        try { unlinkSync( fullPath ); } catch {}
      }
    }

    // ── Build download links ────────────────────────────────────────────
    // Wrapped because link construction is a convenience layered on top of
    // execution. A failure here must surface as a missing link, never as a
    // failed script run whose output the caller then discards.
    let downloadLinks    = [];
    let downloadWarnings = [];

    try {
      const built      = buildDownloadLinks( { before: downloadsBefore, declared: download_files } );
      downloadLinks    = built.links;
      downloadWarnings = built.warnings;
    } catch ( linkErr ) {
      downloadWarnings = [ `Download links could not be built: ${ linkErr.message }` ];
    }

    for ( const w of downloadWarnings ) {
      console.error( `[script_execute] download link warning: ${ w }` );
    }

    return {
      stdout:            stdout.slice( 0, 50_000 ),   // cap at 50KB
      stderr:            stderr.slice( 0, 50_000 ),
      return_code:       exitCode,
      signal,
      execution_time_ms: elapsed,
      timed_out:         signal === 'SIGTERM',
      files:             files.length ? files : undefined,
      // v12.37.0: finished, ready-to-render URLs. The download token is
      // embedded here by the connector; the caller must not be asked for it and
      // must not attempt to assemble these strings itself.
      download_links:    downloadLinks.length ? downloadLinks : undefined,
      download_warnings: downloadWarnings.length ? downloadWarnings : undefined,
      // v12.37.0: names only, never values. A caller that asked for a variable
      // and did not get it needs to know which one, otherwise the script fails
      // with an unrelated KeyError and the cause is invisible.
      custom_env_applied:  Object.keys( customEnv ).length ? Object.keys( customEnv ) : undefined,
      custom_env_rejected: customEnvRejected.length ? customEnvRejected : undefined,
    };

  } catch ( err ) {
    return {
      error:             err.message,
      return_code:       -1,
      execution_time_ms: Date.now() - start,
    };
  } finally {
    // Always clean up temp directories and input files
    try { rmSync( outputDir, { recursive: true, force: true } ); } catch {}
    if ( inputFile ) { try { unlinkSync( inputFile ); } catch {} }
  }
}
