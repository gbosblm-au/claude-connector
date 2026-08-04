// src/utils/pathContainment.js  v1.0.0
// ---------------------------------------------------------------------------
// Boundary-correct filesystem containment checks.
//
// Remediates TNX-C-005 (audit TNX-AUDIT-2026-08).
//
// The pattern this module replaces:
//
//   const full = path.resolve( base, candidate );
//   if ( ! full.startsWith( base ) ) reject();
//
// `String.prototype.startsWith` is a character-prefix test, not a directory
// boundary test. With base = "/data/skill/ava/scripts", the resolved path
// "/data/skill/ava/scripts_evil/payload.py" satisfies startsWith and is
// accepted, because "scripts_evil" shares the prefix "scripts". `path.resolve`
// normalises ".." segments so classic traversal is already blocked, but the
// sibling-directory escape is not.
//
// `path.relative` gives the correct test: the candidate is inside the base if
// and only if the relative path from base to candidate is non-empty, is not
// absolute, and does not begin with a ".." segment.
//
// A second, independent problem: path.resolve is a purely lexical operation.
// It does not consult the filesystem, so a symbolic link that lives inside the
// base directory but points outside it passes every lexical check. Callers that
// are about to read or execute the target must therefore also refuse symlinks;
// `resolveContained` does this with lstat when the target exists.
// ---------------------------------------------------------------------------

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { lstatSync, realpathSync, existsSync } from 'node:fs';

/**
 * Test whether `candidate` resolves to a location inside `baseDir`.
 *
 * The base directory itself is deliberately NOT considered "contained". A
 * candidate that resolves exactly onto the base is almost always a caller
 * error (an empty or "." path), and treating it as valid would let a caller
 * pass "" and receive a directory where a file was expected.
 *
 * This is a lexical test only. It does not touch the filesystem and therefore
 * does not follow symbolic links. Use `resolveContained` when the result will
 * be read, written or executed.
 *
 * @param {string} baseDir   Absolute or relative base directory.
 * @param {string} candidate Path to test, resolved relative to baseDir.
 * @returns {boolean} True when candidate is strictly inside baseDir.
 */
export function containedWithin( baseDir, candidate ) {
  if ( typeof baseDir !== 'string' || baseDir === '' ) return false;
  if ( typeof candidate !== 'string' || candidate === '' ) return false;

  // A NUL byte truncates the path at the syscall boundary on some platforms,
  // so "safe.txt\0../../etc/passwd" can pass a JavaScript-level check and then
  // resolve differently in libc. Reject outright.
  if ( baseDir.includes( '\0' ) || candidate.includes( '\0' ) ) return false;

  const base = resolve( baseDir );
  const full = resolve( base, candidate );
  const rel  = relative( base, full );

  if ( rel === '' )                       return false;  // candidate IS the base
  if ( isAbsolute( rel ) )                return false;  // different root/drive
  if ( rel === '..' )                     return false;  // exactly the parent
  if ( rel.startsWith( '..' + sep ) )     return false;  // escapes upward
  return true;
}

/**
 * Resolve `candidate` against `baseDir`, enforcing containment and refusing
 * symbolic links anywhere along the resolved path.
 *
 * Returns the absolute resolved path on success, or null when the candidate
 * is not contained, or when it (or any existing ancestor inside the base)
 * is a symbolic link.
 *
 * Symlink policy: `path.resolve` is lexical, so a symlink placed inside the
 * base that targets "/etc" would produce a lexically contained path that
 * physically escapes. We therefore compare the real path of the deepest
 * existing ancestor against the real path of the base.
 *
 * @param {string} baseDir   Base directory that must contain the result.
 * @param {string} candidate Path relative to baseDir.
 * @param {object} [opts]
 * @param {boolean} [opts.allowSymlinks=false] Skip the symlink refusal.
 * @returns {string|null} Absolute contained path, or null if rejected.
 */
export function resolveContained( baseDir, candidate, opts = {} ) {
  const { allowSymlinks = false } = opts;

  if ( ! containedWithin( baseDir, candidate ) ) return null;

  const base = resolve( baseDir );
  const full = resolve( base, candidate );

  if ( allowSymlinks ) return full;

  try {
    // If the target itself exists and is a symlink, refuse immediately.
    if ( existsSync( full ) && lstatSync( full ).isSymbolicLink() ) return null;

    // Verify physically, not just lexically. realpathSync resolves every
    // symlink in the chain. Compare against the base's own real path so a
    // base that is itself reached through a symlink (a common container
    // volume arrangement) does not produce a false rejection.
    const realBase = existsSync( base ) ? realpathSync( base ) : base;

    if ( existsSync( full ) ) {
      const realFull = realpathSync( full );
      const rel      = relative( realBase, realFull );
      if ( rel === '' || isAbsolute( rel ) || rel === '..' || rel.startsWith( '..' + sep ) ) {
        return null;
      }
      return full;
    }

    // The target does not exist yet (a write). Walk up to the deepest existing
    // ancestor and verify that it is physically inside the base, so a symlinked
    // intermediate directory cannot be used to place the new file outside.
    let ancestor = full;
    for ( let guard = 0; guard < 4096; guard += 1 ) {
      const parent = resolve( ancestor, '..' );
      if ( parent === ancestor ) break;      // reached the filesystem root
      ancestor = parent;
      if ( ! existsSync( ancestor ) ) continue;

      const realAncestor = realpathSync( ancestor );
      const rel          = relative( realBase, realAncestor );
      // The deepest existing ancestor may legitimately BE the base directory,
      // which relative() reports as "". That is the expected case.
      if ( isAbsolute( rel ) || rel === '..' || rel.startsWith( '..' + sep ) ) return null;
      return full;
    }

    return null;
  } catch {
    // Any filesystem error during verification is treated as a rejection.
    // Failing closed is the correct posture for a containment check.
    return null;
  }
}

/**
 * Strict single-segment filename validator.
 *
 * Used where a caller-supplied name is interpolated into a filesystem path or
 * passed to a subprocess. `path.basename` alone is insufficient: it removes
 * directory separators but preserves quotes, semicolons, backticks, `$`,
 * pipes, ampersands and whitespace, all of which are shell metacharacters.
 *
 * @param {string} name Candidate filename.
 * @returns {boolean} True when the name is a safe single path segment.
 */
export function isSafeFilename( name ) {
  if ( typeof name !== 'string' ) return false;
  if ( name.length === 0 || name.length > 255 ) return false;
  if ( name === '.' || name === '..' ) return false;
  return /^[A-Za-z0-9._-]+$/.test( name );
}

export default { containedWithin, resolveContained, isSafeFilename };
