// src/tests/helpers/compile-volume.js  (claude-connector v13.39.0)
// ---------------------------------------------------------------------------
// A throwaway modular-skill volume for driving the real skill_compile and
// skill_recompile handlers (TENAX-2026-10-15-01 H-7 and H-8 tests).
//
// getModularPaths() reads SKILL_FILE_PATH at call time, so a test points it at
// the volume this builds and the handlers run unmodified against real files.
//
// The manifest:
//   always-meta      always_load, a few lines         -> tier always_load
//   garden           keyword "garden", a few lines    -> tier lexical (score 2)
//   cooking          keyword "cooking", 400 lines     -> lexical; demoted when
//                    the line budget is small (score 2 is not high confidence)
//   meta-self-check  appended last                    -> tier self_check
// ---------------------------------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FILES = {
  'CORE.md': '# Core\nAva is careful and direct.\nShe checks her work.\n',
  'PERSONALITY.md': '# Personality\n\nNotices pauses.\n',
  'modules/meta/always.md': '# Always\nThis module loads on every compile.\n',
  'modules/garden/garden.md': '# Garden\nWater deeply and rarely.\nMulch in spring.\n',
  'modules/cooking/cooking.md': '# Cooking\n' + Array.from( { length: 399 }, ( _, i ) => `Step ${ i }: taste as you go.` ).join( '\n' ) + '\n',
  'modules/meta/self-check.md': '# Self check\nDid I answer the question asked?\n',
};

/**
 * @param {object} [budget]  MANIFEST.json budget overrides.
 * @returns {{ root: string, ava: string, files: object, cleanup: () => void, write: (rel: string, text: string) => void }}
 */
export function buildCompileVolume( budget = {} ) {
  const root = mkdtempSync( join( tmpdir(), 'compile-vol-' ) );
  const ava = join( root, 'skill', 'ava' );
  const write = ( rel, text ) => {
    const full = join( ava, rel );
    mkdirSync( join( full, '..' ), { recursive: true } );
    writeFileSync( full, text );
  };
  for ( const [ rel, text ] of Object.entries( FILES ) ) write( rel, text );
  write( 'MANIFEST.json', JSON.stringify( {
    budget,
    modules: [
      { id: 'always-meta', path: 'modules/meta/always.md', always_load: true, line_count_estimate: 3, triggers: {} },
      { id: 'garden', path: 'modules/garden/garden.md', line_count_estimate: 4, triggers: { keywords: [ 'garden' ] } },
      { id: 'cooking', path: 'modules/cooking/cooking.md', line_count_estimate: 400, triggers: { keywords: [ 'cooking' ] } },
      { id: 'meta-self-check', path: 'modules/meta/self-check.md', line_count_estimate: 2, triggers: {} },
    ],
  }, null, 2 ) );
  write( 'DISPATCH_RULES.json', JSON.stringify( { layer0_mandatory: { rules: [] }, learned_linkages: { rules: [] } } ) );
  process.env.SKILL_FILE_PATH = join( root, 'skill', 'SKILL.md' );
  return { root, ava, files: FILES, write, cleanup: () => rmSync( root, { recursive: true, force: true } ) };
}

/** Module id to its file in FILES. */
export const REL_OF = Object.freeze( {
  'always-meta': 'modules/meta/always.md',
  garden: 'modules/garden/garden.md',
  cooking: 'modules/cooking/cooking.md',
  'meta-self-check': 'modules/meta/self-check.md',
} );

/**
 * The compile body for a list of module ids, assembled the way compileSkill
 * assembles it: CORE, PERSONALITY, then each module in the given order. Pass
 * the compile's own modules_loaded so the order is the dispatcher's, not one
 * the test assumed.
 */
export function expectedBody( moduleIds ) {
  let body = FILES[ 'CORE.md' ] + '\n\n' + FILES[ 'PERSONALITY.md' ].trim();
  for ( const id of moduleIds ) body += '\n\n' + FILES[ REL_OF[ id ] ];
  return body;
}

/** The estimated tokens a text contributes, by the documented method. */
export const tokensOf = ( text ) => Math.ceil( text.length / 4 );
