// src/tests/helpers/source-scan.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// Source walks for the TENAX-2026-10-15-01 derived-set claims.
//
// The order requires every guarded or enumerated set (store write paths,
// process-control call sites, unattended paths) to be PRODUCED BY A SCAN and
// compared with its registry in both directions, never hand-listed. This is the
// scanner those walks share.
//
// blank() replaces comments AND string/template literal contents with spaces,
// keeping every newline and every character offset, so a match's line number
// and enclosing function are those of the real source, and a word that only
// appears in prose or in a log message cannot register as a call. The comment
// handling follows Gateway Service eval-harness/lib/tool-surface.js
// stripComments(), extended to keep offsets and to blank literals.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Blank comments and literal contents, preserving offsets and newlines.
 *
 * Regex literals are recognised after the characters that can precede one
 * (`(,=:[!&|?{};` or a keyword boundary), which is enough for this codebase:
 * a regex containing a quote would otherwise open a phantom string.
 *
 * @param {string} src
 * @returns {string}
 */
export function blank( src ) {
  const out = src.split( '' );
  const n = src.length;
  let i = 0;
  const wipe = ( from, to ) => { for ( let k = from; k < to && k < n; k += 1 ) if ( out[ k ] !== '\n' ) out[ k ] = ' '; };
  let lastSignificant = '';
  while ( i < n ) {
    const ch = src[ i ];
    const nx = src[ i + 1 ];
    if ( ch === '/' && nx === '/' ) {
      const end = src.indexOf( '\n', i );
      const stop = end === -1 ? n : end;
      wipe( i, stop );
      i = stop;
      continue;
    }
    if ( ch === '/' && nx === '*' ) {
      const end = src.indexOf( '*/', i + 2 );
      const stop = end === -1 ? n : end + 2;
      wipe( i, stop );
      i = stop;
      continue;
    }
    if ( ch === '"' || ch === "'" ) {
      let j = i + 1;
      while ( j < n && src[ j ] !== ch && src[ j ] !== '\n' ) { if ( src[ j ] === '\\' ) j += 1; j += 1; }
      wipe( i + 1, j );
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if ( ch === '`' ) {
      // Template literal: blank the text, keep ${ ... } expressions as code.
      let j = i + 1;
      let textFrom = j;
      while ( j < n && src[ j ] !== '`' ) {
        if ( src[ j ] === '\\' ) { j += 2; continue; }
        if ( src[ j ] === '$' && src[ j + 1 ] === '{' ) {
          wipe( textFrom, j );
          let depth = 1;
          j += 2;
          while ( j < n && depth > 0 ) {
            if ( src[ j ] === '{' ) depth += 1;
            else if ( src[ j ] === '}' ) depth -= 1;
            j += 1;
          }
          textFrom = j;
          continue;
        }
        j += 1;
      }
      wipe( textFrom, j );
      i = j + 1;
      lastSignificant = '`';
      continue;
    }
    if ( ch === '/' && /[(,=:[!&|?{};]|^$/.test( lastSignificant ) ) {
      // Regex literal.
      let j = i + 1;
      let inClass = false;
      while ( j < n && src[ j ] !== '\n' ) {
        if ( src[ j ] === '\\' ) { j += 2; continue; }
        if ( src[ j ] === '[' ) inClass = true;
        else if ( src[ j ] === ']' ) inClass = false;
        else if ( src[ j ] === '/' && ! inClass ) break;
        j += 1;
      }
      wipe( i + 1, j );
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    if ( ! /\s/.test( ch ) ) lastSignificant = ch;
    i += 1;
  }
  return out.join( '' );
}

/**
 * Line number (1-based) of an offset.
 *
 * @param {string} src
 * @param {number} idx
 * @returns {number}
 */
export function lineAt( src, idx ) {
  let line = 1;
  for ( let k = 0; k < idx; k += 1 ) if ( src.charCodeAt( k ) === 10 ) line += 1;
  return line;
}

/** Names that look like calls but are control flow. */
const NOT_FUNCTIONS = new Set( [ 'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'else', 'do', 'try', 'with' ] );

/**
 * The nearest enclosing named function for an offset in BLANKED source: the
 * innermost `function name(`, `name = (...) =>`, `name = function`, or method
 * `name(...) {` whose body brace is still open at the offset.
 *
 * @param {string} code   Output of blank().
 * @param {number} idx
 * @returns {string}      '(module)' when at top level.
 */
export function enclosingFunction( code, idx ) {
  const stack = [];
  const header = /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$]*\s*)?\([^)]*\)\s*(?:=>\s*)?\{|\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>\s*\{|^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/gm;
  const headers = [];
  let m;
  while ( ( m = header.exec( code ) ) !== null ) {
    if ( m.index > idx ) break;
    const name = m[ 1 ] || m[ 2 ] || m[ 3 ] || m[ 4 ];
    if ( ! name || NOT_FUNCTIONS.has( name ) ) continue;
    headers.push( { name, open: m.index + m[ 0 ].length - 1 } );
  }
  // Walk braces from the start, tracking which header each open brace belongs to.
  const opens = new Map( headers.map( ( h ) => [ h.open, h.name ] ) );
  for ( let k = 0; k < idx; k += 1 ) {
    const c = code[ k ];
    if ( c === '{' ) stack.push( opens.get( k ) || null );
    else if ( c === '}' ) stack.pop();
  }
  for ( let s = stack.length - 1; s >= 0; s -= 1 ) if ( stack[ s ] ) return stack[ s ];
  return '(module)';
}

/**
 * Every .js file under the given directories, relative to root, sorted.
 *
 * @param {string} root
 * @param {string[]} dirs
 * @param {(rel: string) => boolean} [keep]
 * @returns {string[]}
 */
export function jsFiles( root, dirs, keep = () => true ) {
  const out = [];
  const walk = ( abs ) => {
    for ( const name of readdirSync( abs ) ) {
      if ( name === 'node_modules' || name.startsWith( '.' ) ) continue;
      const p = join( abs, name );
      const st = statSync( p );
      if ( st.isDirectory() ) walk( p );
      else if ( name.endsWith( '.js' ) ) {
        const rel = relative( root, p ).split( '\\' ).join( '/' );
        if ( keep( rel ) ) out.push( rel );
      }
    }
  };
  for ( const d of dirs ) walk( join( root, d ) );
  return out.sort();
}

/**
 * Find call sites by pattern across files.
 *
 * @param {string} root
 * @param {string[]} files     Relative to root.
 * @param {RegExp} pattern     Global; group 1 is the callee label.
 * @returns {Array<{ file: string, callee: string, anchor: string, line: number, index: number }>}
 */
export function findCalls( root, files, pattern ) {
  const out = [];
  for ( const rel of files ) {
    const src = readFileSync( join( root, rel ), 'utf8' );
    const code = blank( src );
    const re = new RegExp( pattern.source, pattern.flags.includes( 'g' ) ? pattern.flags : pattern.flags + 'g' );
    let m;
    while ( ( m = re.exec( code ) ) !== null ) {
      out.push( { file: rel, callee: m.slice( 1 ).find( Boolean ) || m[ 0 ], anchor: enclosingFunction( code, m.index ), line: lineAt( code, m.index ), index: m.index } );
    }
  }
  return out;
}

/**
 * Read a file's blanked text (for guard-before-call checks).
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ src: string, code: string }}
 */
export function readBlanked( root, rel ) {
  const src = readFileSync( join( root, rel ), 'utf8' );
  return { src, code: blank( src ) };
}

export default { blank, lineAt, enclosingFunction, jsFiles, findCalls, readBlanked };
