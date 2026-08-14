// src/utils/scriptEnv.js  v1.0.0
// ---------------------------------------------------------------------------
// Minimal environment construction for spawned subprocesses.
//
// Remediates TNX-C-004 (audit TNX-AUDIT-2026-08).
//
// The audit cited src/tools/script-execute.js as the site where the connector
// handed every spawned Python script the complete process environment:
//
//     env: { ...process.env, PYTHONUNBUFFERED: '1' }
//
// A verification sweep for that idiom during the Phase 0 remediation found FOUR
// more modules doing exactly the same thing, none of which appear in the audit:
//
//     src/tools/homeworkTools.js:99
//     src/tools/socraticTools.js:54
//     src/tools/nudgeTools.js:86
//     src/tools/brain-scan-trigger.js:180
//
// Every one of them inherited ANTHROPIC_API_KEY, OPENAI_API_KEY,
// GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, SLACK_BOT_TOKEN, WP_APP_PASSWORD,
// MEMORY_AUTH_TOKEN, RAILWAY_RESTORE_TOKEN, MCP_API_KEY and any database URL
// present. Fixing only the one module the audit named would have left four
// equivalent holes open, which is precisely the "good primitives with near-zero
// adoption" pattern the audit records in Section 5.2.
//
// This module is therefore the single implementation. It is placed in utils/
// rather than left inside script-execute.js so that adopting it is an import
// rather than a copy, and so a future spawn site has an obvious correct default.
//
// DESIGN NOTE, and the reason this is durable: the environment is built FROM
// SCRATCH, never by filtering process.env. A secret added to the connector's
// environment in future is therefore excluded by default rather than included
// by default, and no change to this file is needed when that happens. A
// denylist would have to be updated forever; an allowlist does not.
// ---------------------------------------------------------------------------

/**
 * Environment variable names that MAY be granted to a subprocess through a
 * manifest. A name absent from this list cannot be granted at all, so editing a
 * manifest alone is never sufficient to leak a credential.
 *
 * Empty by default. Populate via SCRIPT_GRANTABLE_ENV only when a script has a
 * demonstrated need.
 */
function grantableNames() {
  return String( process.env.SCRIPT_GRANTABLE_ENV || '' )
    .split( ',' )
    .map( ( n ) => n.trim() )
    .filter( Boolean );
}

/**
 * Per-script secret manifest, supplied as JSON via SCRIPT_ENV_MANIFEST:
 *
 *   { "report_render.py": ["SOME_API_KEY"] }
 *
 * A malformed manifest is treated as empty and logged. Failing closed is
 * correct here: a script losing a variable it expected produces a clear,
 * debuggable failure, whereas a script silently receiving every variable does
 * not.
 *
 * @returns {Record<string, string[]>}
 */
function loadManifest() {
  const raw = ( process.env.SCRIPT_ENV_MANIFEST || '' ).trim();
  if ( ! raw ) return {};
  try {
    const parsed = JSON.parse( raw );
    if ( ! parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
      console.error( '[scriptEnv] SCRIPT_ENV_MANIFEST is not a JSON object. Ignoring it; no secrets will be granted.' );
      return {};
    }
    return parsed;
  } catch ( err ) {
    console.error( `[scriptEnv] SCRIPT_ENV_MANIFEST is not valid JSON (${ err.message }). Ignoring it; no secrets will be granted.` );
    return {};
  }
}

/**
 * Build the environment handed to a spawned subprocess.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.outputDir]  Directory the script writes results into,
 *                                    exposed as SCRIPT_OUTPUT_DIR.
 * @param {string}  [opts.scriptKey]  Script identifier used to look up a
 *                                    manifest grant. Usually the script's path
 *                                    or filename.
 * @param {Record<string,string>} [opts.extra]
 *                                    Non-secret variables the caller needs to
 *                                    pass, such as SELF_MODEL_DB_PATH. These are
 *                                    caller-computed values, not inherited
 *                                    environment, and are applied after the base
 *                                    so a caller cannot accidentally clobber PATH.
 * @returns {Record<string, string>} Complete environment for the child process.
 */
export function buildScriptEnv( opts = {} ) {
  const { outputDir = '', scriptKey = '', extra = {} } = opts;

  /** Base environment. Nothing here is sensitive. */
  const env = {
    PATH:                    '/usr/local/bin:/usr/bin:/bin',
    HOME:                    '/tmp',
    LANG:                    'C.UTF-8',
    LC_ALL:                  'C.UTF-8',
    TMPDIR:                  '/tmp',
    PYTHONUNBUFFERED:        '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  if ( outputDir ) env.SCRIPT_OUTPUT_DIR = String( outputDir );

  // Preserve interpreter search configuration. These are paths, not credentials.
  // Railway installs Python through mise, which places shims outside /usr/bin,
  // so dropping these would break script execution on that platform.
  if ( process.env.MISE_DATA_DIR ) env.MISE_DATA_DIR = process.env.MISE_DATA_DIR;
  if ( process.env.PYTHONPATH )    env.PYTHONPATH    = process.env.PYTHONPATH;

  // Preserve document directory configuration. These are operator-controlled
  // host settings, not secrets. Without them a connector deployment that
  // overrides /data/downloads or /data/uploads silently reverts every spawned
  // script to the compiled-in default, and the connector then diffs a
  // different directory than the script wrote to -- producing an empty
  // download set and a "no file produced" report for work that completed.
  if ( process.env.DOCUMENT_DOWNLOADS_DIR ) env.DOCUMENT_DOWNLOADS_DIR = process.env.DOCUMENT_DOWNLOADS_DIR;
  if ( process.env.DOCUMENT_UPLOADS_DIR )   env.DOCUMENT_UPLOADS_DIR   = process.env.DOCUMENT_UPLOADS_DIR;

  // Caller-supplied non-secret values (database paths, output locations).
  // Applied before manifest grants and validated so they cannot overwrite the
  // base entries that keep the child's execution environment predictable.
  // v12.37.0: the original set covered the loader and Node hijack vectors but
  // omitted the Python ones, which matters now that script_execute forwards
  // caller-supplied values through `extra` (the custom_env feature).
  //
  // PYTHONPATH, PYTHONHOME and PYTHONEXECUTABLE relocate the interpreter's
  // module search; PYTHONSTARTUP is executed verbatim by an interactive
  // interpreter; PYTHONUSERBASE moves the user site directory. Any of them
  // lets a caller who can set an environment variable execute code of their
  // choosing inside the sandbox, which is the same class of defect as
  // LD_PRELOAD. BASH_ENV and ENV are the shell equivalents, included because a
  // spawned script may itself shell out.
  //
  // Note that PYTHONPATH is still propagated from process.env above. That path
  // is operator-controlled (Railway/mise sets it) and is a different trust
  // source from a caller-supplied value, so protecting it here blocks the
  // override without breaking interpreter discovery.
  const PROTECTED = new Set( [
    'PATH', 'HOME',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
    'NODE_OPTIONS',
    'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONEXECUTABLE', 'PYTHONUSERBASE',
    'BASH_ENV', 'ENV', 'IFS',
  ] );
  for ( const [ key, value ] of Object.entries( extra || {} ) ) {
    if ( PROTECTED.has( key ) ) {
      console.error( `[scriptEnv] Refusing to let a caller override ${ key }.` );
      continue;
    }
    if ( typeof value === 'string' ) env[ key ] = value;
  }

  // Explicitly declared, explicitly grantable secrets for this script.
  const manifest  = loadManifest();
  const grantable = grantableNames();
  const requested = Array.isArray( manifest[ scriptKey ] ) ? manifest[ scriptKey ] : [];

  for ( const name of requested ) {
    if ( typeof name !== 'string' || ! name ) continue;
    if ( ! grantable.includes( name ) ) {
      console.error(
        `[scriptEnv] Manifest for "${ scriptKey }" requests ${ name }, which is not listed ` +
        'in SCRIPT_GRANTABLE_ENV. Grant refused.'
      );
      continue;
    }
    if ( name in env || PROTECTED.has( name ) ) continue;
    const value = process.env[ name ];
    if ( typeof value === 'string' ) env[ name ] = value;
  }

  return env;
}

export default { buildScriptEnv };
