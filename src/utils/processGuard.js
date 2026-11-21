// src/utils/processGuard.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// H-4, TENAX-2026-10-15-01: self-termination guard.
//
// This connector runs model-written Python (script_execute) and holds the skill
// bundle, the memory store and the volume. The component that runs
// model-written code must not be able to take the platform down with it. Three
// layers, each refusing with a stated reason and leaving an audit entry:
//
//   1. LAUNCH GUARD. Every process-control call site in this connector (every
//      spawn, spawnSync, execSync, execFileSync, fork) passes its command
//      through assertLaunchAllowed() with a registered site id. Image-level and
//      name-derived kills (pkill, killall, kill, pidof-driven kills), and
//      stop/restart commands for the host or its platform (shutdown, reboot,
//      systemctl, supervisorctl, railway, docker, kubectl) are refused. The
//      set of call sites is derived by a scan of src/ and compared with
//      GUARDED_SITES in both directions (src/tests/process-guard.test.js), so
//      a new call site that skips the guard reddens the walk.
//
//   2. SCRIPT INSPECTION. Before script_execute spawns anything, the script,
//      the local modules it imports from the scripts volume, and any
//      sitecustomize.py / usercustomize.py on the interpreter path (the volume
//      is writable through script_write, so those files are model-writable too)
//      are scanned for host kills, image-level kills, stop/restart commands and
//      raw signal calls through ctypes. A finding refuses the run.
//
//   3. RUNTIME INTERPOSITION. The script does not run as `python script.py`.
//      It runs as `python <connector>/src/guards/proc_guard_boot.py script.py`,
//      a boot file shipped in the image (never on the volume) that wraps
//      os.kill, os.killpg, signal.pthread_kill, os.system, os.popen, the
//      os.exec*/spawn* family, os.posix_spawn* and subprocess.Popen before the
//      script's first line runs. A signal may go only to the script itself or
//      its own descendants; anything else, and any refused command, raises
//      PermissionError with the reason and writes a [process-guard] line to
//      stderr, which this module turns into an audit entry.
//
// NON-OVERRIDABLE
// ---------------
// There is no argument, flag, environment variable or force path that skips any
// layer. script_execute ignores `force`, `override`, `allow_kill` and friends;
// a test passes all of them and expects the refusal to stand.
//
// WHAT AN IN-PROCESS GUARD CANNOT DO
// ----------------------------------
// Layer 3 interposes on Python's own entry points. A script that reaches the
// kernel without them (an obfuscated ctypes call that the static scan does not
// recognise) is outside what an interposition guard can stop. The structural
// answer is OS isolation (a separate uid or PID namespace for scripts); that is
// recorded as a queued item in the delivery, not claimed here.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

/** The in-image boot file layer 3 runs scripts through. */
export const PROC_GUARD_BOOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'guards', 'proc_guard_boot.py' );

/**
 * Binaries no connector call site may launch. The connector itself never needs
 * any of them; a call site that tries is either a mistake or model-written
 * content reaching a launcher.
 */
export const REFUSED_BINARIES = Object.freeze( [
  'kill', 'pkill', 'killall', 'killall5', 'skill', 'snice', 'pidof', 'fuser',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit',
  'systemctl', 'service', 'supervisorctl', 'pm2', 'railway', 'docker', 'podman', 'kubectl',
] );

/**
 * Every process-control call site in src/, by site id. The walk in
 * src/tests/process-guard.test.js derives the actual set by scanning the
 * source and compares it with this table both ways.
 *
 *   kind 'launch'      spawns a process; must call assertLaunchAllowed(<id>)
 *                      in the same function before the spawn
 *   kind 'child'       signals a ChildProcess this connector itself started
 *   kind 'self'        re-raises a signal on this process from its own signal
 *                      handler, after reaping its children (lifecycle)
 *   kind 'test'        a test harness file under src/, never reachable from a
 *                      tool path
 *
 * `anchor` is the nearest enclosing named function as the walk reads it.
 */
export const GUARDED_SITES = Object.freeze( [
  { id: 'script_execute.run',        kind: 'launch', file: 'tools/script-execute.js',           callee: 'spawnSync',    anchor: 'handleScriptExecute' },
  { id: 'homework.python',           kind: 'launch', file: 'tools/homeworkTools.js',            callee: 'spawnSync',    anchor: 'handleHomeworkAssessRender' },
  { id: 'render_tools.run',          kind: 'launch', file: 'tools/render-tools.js',             callee: 'spawnSync',    anchor: 'runRenderer' },
  { id: 'socratic.python',           kind: 'launch', file: 'tools/socraticTools.js',            callee: 'spawnSync',    anchor: 'runScript' },
  { id: 'nudge.python',              kind: 'launch', file: 'tools/nudgeTools.js',               callee: 'spawnSync',    anchor: 'handleNudgeAnalyze' },
  { id: 'brain_scan.python',         kind: 'launch', file: 'tools/brain-scan-trigger.js',       callee: 'spawn',        anchor: 'runBrainScan' },
  { id: 'brain_scan.timeout',        kind: 'child',  file: 'tools/brain-scan-trigger.js',       callee: 'child.kill',   anchor: 'runBrainScan' },
  { id: 'volume_snapshot.helper',    kind: 'launch', file: 'routes/volume-snapshot.js',         callee: 'spawn',        anchor: 'runHelper' },
  { id: 'volume_snapshot.timeout',   kind: 'child',  file: 'routes/volume-snapshot.js',         callee: 'child.kill',   anchor: 'runHelper' },
  { id: 'export.python_inline',      kind: 'launch', file: 'routes/export.js',                  callee: 'execSync',     anchor: 'registerExportRoute' },
  { id: 'preview.docx_extract',      kind: 'launch', file: 'server-http.js',                    callee: 'execFileSync', anchor: '(module)' },
  { id: 'voice.kokoro_worker',       kind: 'launch', file: 'voice/kokoro-worker-supervisor.js', callee: 'spawn',        anchor: 'synthesizeOnce' },
  { id: 'voice.kokoro_worker.stop',  kind: 'child',  file: 'voice/kokoro-worker-supervisor.js', callee: 'child.kill',   anchor: 'synthesizeOnce' },
  { id: 'voice.engine',              kind: 'launch', file: 'voice/voice-engines.js',            callee: 'spawn',        anchor: 'run' },
  { id: 'voice.engine.stop',         kind: 'child',  file: 'voice/voice-engines.js',            callee: 'child.kill',   anchor: 'run' },
  { id: 'voice.stdio_worker',        kind: 'launch', file: 'voice/stdio-worker.js',             callee: 'spawn',        anchor: 'start' },
  { id: 'voice.stdio_worker.reap',   kind: 'child',  file: 'voice/stdio-worker.js',             callee: 'child.kill',   anchor: 'reap' },
  { id: 'voice.stdio_worker.raise',  kind: 'self',   file: 'voice/stdio-worker.js',             callee: 'process.kill', anchor: 'installReaper' },
  { id: 'voice.stdio_worker.down',   kind: 'child',  file: 'voice/stdio-worker.js',             callee: 'child.kill',   anchor: 'teardown' },
  { id: 'voice.stdio_worker.doomed', kind: 'child',  file: 'voice/stdio-worker.js',             callee: 'doomed.kill',  anchor: 'teardown' },
  { id: 'test_http.server',          kind: 'test',   file: 'test-http.js',                      callee: 'spawn',        anchor: '(module)' },
  { id: 'test_http.server.stop',     kind: 'test',   file: 'test-http.js',                      callee: 'serverProc.kill', anchor: '(module)' },
] );

/** Site id lookup. */
const SITE_BY_ID = new Map( GUARDED_SITES.map( ( s ) => [ s.id, s ] ) );

/** A refusal thrown by assertLaunchAllowed. */
export class ProcessGuardRefusal extends Error {
  constructor( code, reason, detail = {} ) {
    super( `[process-guard] refused (${ code }): ${ reason }` );
    this.name = 'ProcessGuardRefusal';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const CMD_WORDS = REFUSED_BINARIES.map( ( b ) => b.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ).join( '|' );

/**
 * A refused binary in COMMAND POSITION. A command word is the first word of a
 * command, so it is matched only where a command can start:
 *
 *   the start of the text or of a line; after a shell separator ( ; & | ( { [
 *   backtick $( ); after "sh -c" / "bash -c" (a shell handed a command string); then any run
 *   of command prefixes (sudo, exec, nohup, command, xargs, env, time,
 *   timeout N, nice -n N) and shell keywords (then, do, else); then an
 *   optional opening quote and an optional absolute path (/usr/bin/kill).
 *
 * Before v13.39.0 review, any whitespace or "/" counted as a command position,
 * so an ordinary argument or path segment matched: "ls -la /data/skill" read
 * as the procps "skill" command and "--mode service" as "service". Arguments
 * and path segments are not command positions; the runtime guard
 * (proc_guard_boot.py) refuses the signal or exec itself if a script later
 * turns such a word into a command.
 */
const CMD_POSITION = `(?:^|[\\n;&|({\\[\`]|\\$\\(|\\b(?:sh|bash|dash|zsh|ash|ksh)\\s+-c(?=\\s))`;
const CMD_PREFIXES = `(?:(?:sudo|exec|nohup|command|xargs|env|time|then|do|else|timeout\\s+\\S+|nice(?:\\s+-n\\s*-?\\d+)?)\\s+)*`;
const COMMAND_TEXT = new RegExp(
  `${ CMD_POSITION }\\s*['"]?\\s*${ CMD_PREFIXES }(?:/[\\w.-]+)*/?(?:${ CMD_WORDS })(?=\\s|$|['"\`);&|,\\]])`, 'im' );

/** Shell text that kills by process name, or kills every PID a search returns. */
const NAME_DERIVED_KILL = /(?:\bpgrep\b[^\n|]*\|\s*xargs\s+kill\b|\bkill\b[^\n;]*\$\(\s*(?:pgrep|pidof)\b|\bxargs\s+kill\b)/i;

/** Python process-control call shapes. */
const PY_KILL_CALL = /\b(?:os\.kill|os\.killpg|signal\.pthread_kill|posix\.kill|signal\.raise_signal)\s*\(/;
const PY_PSUTIL_KILL = /\bpsutil\b[\s\S]{0,400}?\.(?:kill|terminate|send_signal|suspend)\s*\(/;
const PY_PROCESS_ITER = /\bpsutil\.process_iter\b|\bpsutil\.pids\b/;
const PY_CTYPES_SIGNAL = /\bctypes\b[\s\S]{0,600}?\b(?:kill|killpg|syscall|tgkill|tkill|reboot)\b/;
const PY_SYSRQ = /\/proc\/(?:sysrq-trigger|1\/)/;
/** Reaching around the runtime layer: raw process creation or undoing its wrappers. */
const PY_GUARD_TAMPER = /\b_posixsubprocess\b|\bimportlib\.reload\s*\(\s*(?:os|posix|subprocess|signal)\b|\b(?:os|posix)\.(?:kill|killpg|system|popen|exec\w*|spawn\w*|posix_spawnp?)\s*=(?!=)|\bsubprocess\.Popen(?:\.__init__)?\s*=(?!=)/;

/** Launchers inside Python whose first argument is a command. */
const PY_LAUNCHERS = /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|os\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?)|pty\.spawn|commands\.getoutput)\s*\(/g;

/** Targets of a kill call that are never the script's own children. */
const HOSTILE_KILL_TARGET = /\(\s*(?:os\.getppid\s*\(\s*\)|os\.getpgrp\s*\(\s*\)|os\.getpgid\s*\(|-?\s*[01]\s*[,)]|-\s*\d+|\d{1,7}\s*,|int\s*\(\s*os\.environ|os\.environ\s*\[\s*['"]PPID)/;

/**
 * Strip Python comments (leave strings, which can carry shell text).
 *
 * @param {string} src
 * @returns {string}
 */
function stripPyComments( src ) {
  return String( src ).split( '\n' ).map( ( line ) => {
    let out = '';
    let q = null;
    for ( let i = 0; i < line.length; i += 1 ) {
      const ch = line[ i ];
      if ( q ) {
        out += ch;
        if ( ch === '\\' ) { out += line[ i + 1 ] ?? ''; i += 1; continue; }
        if ( ch === q ) q = null;
        continue;
      }
      if ( ch === '#' ) break;
      if ( ch === '"' || ch === "'" ) q = ch;
      out += ch;
    }
    return out;
  } ).join( '\n' );
}

/**
 * The text of a call's arguments, up to its matching close paren (bounded).
 *
 * @param {string} src
 * @param {number} openAt  Index of the "(".
 * @returns {string}
 */
function callArgs( src, openAt ) {
  let depth = 0;
  for ( let i = openAt; i < src.length && i < openAt + 2000; i += 1 ) {
    if ( src[ i ] === '(' ) depth += 1;
    else if ( src[ i ] === ')' ) {
      depth -= 1;
      if ( depth === 0 ) return src.slice( openAt + 1, i );
    }
  }
  return src.slice( openAt + 1, openAt + 2000 );
}

/**
 * Line number of an index.
 *
 * @param {string} src
 * @param {number} idx
 * @returns {number}
 */
function lineOf( src, idx ) {
  return src.slice( 0, idx ).split( '\n' ).length;
}

/**
 * Scan command text (a shell string or an argv joined) for refused commands.
 *
 * @param {string} text
 * @returns {{ code: string, reason: string, match: string }|null}
 */
export function inspectCommandText( text ) {
  const t = String( text || '' );
  const nd = NAME_DERIVED_KILL.exec( t );
  if ( nd ) {
    return { code: 'name_derived_kill', reason: 'a kill derived from a process search (pgrep/pidof piped into kill) would signal processes by image name, including the platform\'s own', match: nd[ 0 ].trim().slice( 0, 80 ) };
  }
  const m = COMMAND_TEXT.exec( t );
  if ( m ) {
    const word = ( m[ 0 ].match( new RegExp( `(?:${ CMD_WORDS })$`, 'i' ) ) || [ m[ 0 ] ] )[ 0 ].trim().toLowerCase();
    const stop = /^(shutdown|reboot|halt|poweroff|init|telinit|systemctl|service|supervisorctl|pm2|railway|docker|podman|kubectl)/.test( word );
    return {
      code: stop ? 'host_stop_restart' : 'image_level_kill',
      reason: stop
        ? `"${ word }" stops or restarts the host or its platform`
        : `"${ word }" signals processes by image or pid outside this script's own children`,
      match: word,
    };
  }
  return null;
}

/**
 * Scan Python source for process-control that could reach the host or its
 * siblings.
 *
 * @param {string} source
 * @param {string} [label]   File label for findings.
 * @returns {Array<{ code: string, reason: string, match: string, file: string, line: number }>}
 */
export function inspectPythonSource( source, label = 'script' ) {
  const src = stripPyComments( source );
  const findings = [];
  const add = ( code, reason, idx, match ) => findings.push( { code, reason, match: String( match ).slice( 0, 100 ), file: label, line: lineOf( src, idx ) } );

  // Direct kill calls aimed at the parent, PID 1, a process group, or a
  // literal/inherited pid.
  const killRe = new RegExp( PY_KILL_CALL.source, 'g' );
  let km;
  while ( ( km = killRe.exec( src ) ) !== null ) {
    const open = km.index + km[ 0 ].length - 1;
    const argText = `(${ callArgs( src, open ) })`;
    if ( HOSTILE_KILL_TARGET.test( argText ) || /getppid|getpgrp|getpgid|PPID/.test( argText ) ) {
      add( 'host_kill', `${ km[ 0 ].replace( /\s*\($/, '' ) } aimed at the host, its process group, PID 1 or an absolute pid`, km.index, km[ 0 ] + argText.slice( 1, 60 ) );
    }
  }

  // psutil kills of processes found by enumeration (name-derived).
  if ( PY_PROCESS_ITER.test( src ) && PY_PSUTIL_KILL.test( src ) ) {
    const i = src.search( PY_PROCESS_ITER );
    add( 'name_derived_kill', 'psutil process enumeration combined with kill/terminate signals processes by name, including the platform\'s own', i, 'psutil.process_iter … .kill()' );
  }

  // Raw signals through ctypes bypass every Python-level guard.
  const ct = PY_CTYPES_SIGNAL.exec( src );
  if ( ct ) add( 'raw_signal_via_ctypes', 'ctypes access to kill/syscall/reboot bypasses the runtime guard and is refused outright', ct.index, ct[ 0 ].slice( 0, 60 ) );

  const tm = PY_GUARD_TAMPER.exec( src );
  if ( tm ) add( 'guard_tamper', 'raw process creation (_posixsubprocess), reloading os/posix/subprocess/signal, or reassigning their process-control functions would reach around the runtime guard', tm.index, tm[ 0 ] );

  const sq = PY_SYSRQ.exec( src );
  if ( sq ) add( 'host_kill', 'writing /proc/sysrq-trigger or PID 1\'s /proc entries reaches the host directly', sq.index, sq[ 0 ] );

  // Launchers: inspect the command they are handed.
  let lm;
  PY_LAUNCHERS.lastIndex = 0;
  while ( ( lm = PY_LAUNCHERS.exec( src ) ) !== null ) {
    const open = lm.index + lm[ 0 ].length - 1;
    const args = callArgs( src, open );
    const flat = args.replace( /['"]\s*,\s*['"]/g, ' ' );
    const f = inspectCommandText( flat );
    if ( f ) add( f.code, `${ lm[ 0 ].replace( /\s*\($/, '' ) }: ${ f.reason }`, lm.index, f.match );
  }

  return findings;
}

/** Local imports a script makes from its own directory or the scripts base. */
function localImports( source, dirs ) {
  const out = new Set();
  const re = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm;
  let m;
  while ( ( m = re.exec( stripPyComments( source ) ) ) !== null ) {
    const names = ( m[ 1 ] || m[ 2 ] || '' ).split( ',' ).map( ( n ) => n.trim().split( /\s+as\s+/ )[ 0 ] ).filter( Boolean );
    for ( const n of names ) {
      const rel = n.split( '.' ).join( '/' );
      for ( const d of dirs ) {
        const f = join( d, `${ rel }.py` );
        if ( existsSync( f ) ) out.add( f );
        const pkg = join( d, rel, '__init__.py' );
        if ( existsSync( pkg ) ) out.add( pkg );
      }
    }
  }
  return [ ...out ];
}

/**
 * Inspect everything a script_execute run would execute before its first line:
 * the script, the local modules it imports (one level), the volume's
 * sitecustomize.py / usercustomize.py, and its argument strings.
 *
 * @param {object} o
 * @param {string} o.scriptPath   Absolute, already contained.
 * @param {string[]} [o.args]
 * @param {string} o.scriptsBase
 * @returns {{ allowed: boolean, findings: object[], scanned: string[] }}
 */
export function inspectScriptExecution( { scriptPath, args = [], scriptsBase } ) {
  const scanned = [];
  const findings = [];
  const dirs = [ dirname( scriptPath ), scriptsBase ].filter( Boolean );
  const queue = [ scriptPath ];
  for ( const extra of [ 'sitecustomize.py', 'usercustomize.py' ] ) {
    const p = join( scriptsBase, extra );
    if ( existsSync( p ) ) queue.push( p );
  }
  const seen = new Set();
  while ( queue.length ) {
    const file = queue.shift();
    if ( seen.has( file ) ) continue;
    seen.add( file );
    let text;
    try {
      if ( ! statSync( file ).isFile() ) continue;
      text = readFileSync( file, 'utf8' );
    } catch ( err ) {
      findings.push( { code: 'uninspectable', reason: `could not read ${ basename( file ) } to inspect it: ${ err.message }`, match: '', file: basename( file ), line: 0 } );
      continue;
    }
    scanned.push( file );
    findings.push( ...inspectPythonSource( text, file === scriptPath ? basename( file ) : `${ basename( dirname( file ) ) }/${ basename( file ) }` ) );
    if ( file === scriptPath ) for ( const imp of localImports( text, dirs ) ) if ( ! seen.has( imp ) ) queue.push( imp );
  }
  for ( const a of Array.isArray( args ) ? args : [] ) {
    // A single word is data to the script, not a command line: "service" or
    // "skill" as an argument value is legitimate. An argument that reads as a
    // command line (a refused word in command position followed by more words,
    // or behind a separator) is refused here; anything else the script turns
    // into a command meets the runtime guard.
    if ( ! /\s/.test( String( a ).trim() ) ) continue;
    const f = inspectCommandText( String( a ) );
    if ( f ) findings.push( { ...f, reason: `argument: ${ f.reason }`, file: 'args', line: 0 } );
  }
  return { allowed: findings.length === 0, findings, scanned };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** @returns {string} Audit log path, beside the store-discipline state. */
export function auditPath() {
  const skillFilePath = process.env.SKILL_FILE_PATH || '/data/skill/SKILL.md';
  return join( skillFilePath.replace( /SKILL\.md$/, '' ), 'ava', '.process-guard', 'audit.jsonl' );
}

/**
 * Append one audit entry. Never throws.
 *
 * @param {object} entry
 * @returns {boolean}
 */
export function recordGuardAudit( entry ) {
  const line = { at: new Date().toISOString(), ...entry };
  log( 'warn', `[process-guard] REFUSED site=${ entry.site } code=${ entry.code } ${ entry.reason || '' }`.slice( 0, 400 ) );
  try {
    const p = auditPath();
    mkdirSync( dirname( p ), { recursive: true } );
    appendFileSync( p, JSON.stringify( line ) + '\n', { flag: 'a' } );
    return true;
  } catch ( err ) {
    log( 'error', `[process-guard] audit append failed: ${ err.message }` );
    return false;
  }
}

/**
 * Parse [process-guard] refusal lines the runtime boot file wrote to stderr.
 *
 * @param {string} stderr
 * @returns {Array<{ code: string, reason: string }>}
 */
export function runtimeRefusalsIn( stderr ) {
  const out = [];
  const re = /^\[process-guard\] REFUSED code=([a-z_]+) reason=(.*)$/gm;
  let m;
  while ( ( m = re.exec( String( stderr || '' ) ) ) !== null ) out.push( { code: m[ 1 ], reason: m[ 2 ].slice( 0, 300 ) } );
  return out;
}

// ---------------------------------------------------------------------------
// Launch guard
// ---------------------------------------------------------------------------

/**
 * Refuse a launch that would run a refused binary, or a shell / inline-Python
 * string carrying one. Called by every registered launch site immediately
 * before it spawns. Throws ProcessGuardRefusal; records an audit entry first.
 *
 * @param {string} siteId          A GUARDED_SITES id of kind 'launch'.
 * @param {string} command         The executable.
 * @param {string[]} [args]
 * @param {object} [opts]
 * @param {boolean} [opts.shell]   The command is a shell string (execSync).
 * @returns {true}
 */
export function assertLaunchAllowed( siteId, command, args = [], opts = {} ) {
  const site = SITE_BY_ID.get( siteId );
  const refuse = ( code, reason, extra = {} ) => {
    recordGuardAudit( { site: siteId, layer: 'launch', code, reason, command: String( command ).slice( 0, 120 ), ...extra } );
    throw new ProcessGuardRefusal( code, reason, { site: siteId } );
  };
  if ( ! site || site.kind !== 'launch' ) {
    refuse( 'unregistered_call_site', `"${ String( siteId ).slice( 0, 60 ) }" is not a registered launch site in GUARDED_SITES` );
  }
  const exe = basename( String( command || '' ) ).toLowerCase();
  if ( REFUSED_BINARIES.includes( exe ) ) {
    refuse( /^(shutdown|reboot|halt|poweroff|init|telinit|systemctl|service|supervisorctl|pm2|railway|docker|podman|kubectl)$/.test( exe ) ? 'host_stop_restart' : 'image_level_kill',
      `"${ exe }" may not be launched from the connector` );
  }
  const argv = Array.isArray( args ) ? args.map( String ) : [];
  if ( opts.shell ) {
    const f = inspectCommandText( String( command ) );
    if ( f ) refuse( f.code, f.reason );
  }
  // A shell or interpreter handed inline code: inspect the code itself.
  const ci = argv.indexOf( '-c' );
  if ( ci !== -1 && argv[ ci + 1 ] !== undefined ) {
    if ( /^(sh|bash|dash|zsh|ash|ksh)$/.test( exe ) ) {
      const f = inspectCommandText( argv[ ci + 1 ] );
      if ( f ) refuse( f.code, f.reason );
    } else if ( /^python/.test( exe ) ) {
      const fs = inspectPythonSource( argv[ ci + 1 ], 'inline' );
      if ( fs.length ) refuse( fs[ 0 ].code, fs[ 0 ].reason );
    }
  }
  if ( opts.shell && /python3?\s+-c\s+/.test( String( command ) ) ) {
    const fs = inspectPythonSource( String( command ).replace( /^[\s\S]*?python3?\s+-c\s+/, '' ), 'inline' );
    if ( fs.length ) refuse( fs[ 0 ].code, fs[ 0 ].reason );
  }
  return true;
}

export default {
  PROC_GUARD_BOOT, REFUSED_BINARIES, GUARDED_SITES, ProcessGuardRefusal,
  inspectCommandText, inspectPythonSource, inspectScriptExecution,
  auditPath, recordGuardAudit, runtimeRefusalsIn, assertLaunchAllowed,
};
