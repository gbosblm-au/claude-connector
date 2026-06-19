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

const SCRIPTS_BASE = process.env.SCRIPTS_DIR
  ? resolvePath( process.env.SCRIPTS_DIR )
  : resolvePath( '/data/skill/ava/scripts' );

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
  } = toolInput || {};

  // ── Validate script_path ────────────────────────────────────────────────
  if ( ! script_path || typeof script_path !== 'string' ) {
    return { error: 'script_path is required and must be a string.' };
  }

  const resolvedPath = resolvePath( SCRIPTS_BASE, script_path );

  if ( ! resolvedPath.startsWith( SCRIPTS_BASE ) ) {
    return { error: 'script_path traverses outside the scripts directory. Path rejected.' };
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

  // ── Execute ─────────────────────────────────────────────────────────────
  // start declared before try so it is accessible in the catch / finally blocks
  const start  = Date.now();
  let result;

  try {
    result = spawnSync( '/mise/shims/python3', cmdArgs, {
      cwd:       SCRIPTS_BASE,
      timeout:   maxTimeout * 1000,
      maxBuffer: 50 * 1024 * 1024,   // 50 MB stdout/stderr ceiling
      env:       { ...process.env, PYTHONUNBUFFERED: '1' },
    } );

    const stdout   = result.stdout?.toString()  || '';
    const stderr   = result.stderr?.toString()  || '';
    const exitCode = result.status;
    const signal   = result.signal || null;
    const elapsed  = Date.now() - start;

    // ── Collect requested output files ──────────────────────────────────
    const files = [];
    if ( Array.isArray( return_files ) && return_files.length > 0 ) {
      for ( const relPath of return_files ) {
        const fullPath = resolvePath( outputDir, relPath );
        if ( ! fullPath.startsWith( outputDir ) ) continue;  // traversal guard
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

    return {
      stdout:            stdout.slice( 0, 50_000 ),   // cap at 50KB
      stderr:            stderr.slice( 0, 50_000 ),
      return_code:       exitCode,
      signal,
      execution_time_ms: elapsed,
      timed_out:         signal === 'SIGTERM',
      files:             files.length ? files : undefined,
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
