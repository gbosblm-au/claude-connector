/**
 * src/tests/reachability.test.js
 *
 * Does anything actually CALL the code we ship?
 *
 * ── The defect this exists to catch ──────────────────────────────────────
 *
 * The same failure has now shipped four times on this platform, with the same
 * signature every time: the code is right, its own tests pass because they read
 * the source, and nothing checks that anything reaches it.
 *
 *   26 SVG template families      diagramFor() had no callers outside its tests
 *   TIVoicePreference             a complete module, mounted by nothing
 *   The Reading Vault             dispatch and storage wired, manifest empty
 *   The plugin bundle             src/ rebuilt, dist/ six versions behind
 *
 * Each was found by a person noticing an absence, days later. None was found by
 * a test, because every test in the repository reads the same source the broken
 * code lives in. A module that works and is unreachable tests identically to a
 * module that works.
 *
 * ── What this checks, and what it deliberately does not ──────────────────
 *
 * For each module under audit it asks one question: does the name appear
 * anywhere outside its own file and its own tests? That is a weak property, and
 * weak is the point. Anything stronger -- a call graph, dynamic dispatch
 * analysis -- would need a parser, would drift, and would eventually be
 * disabled for being noisy. This is grep with an argument attached, and it
 * would have caught all four.
 *
 * It cannot prove a function is invoked at runtime. It proves the far cheaper
 * thing that all four failures violated: that somebody, somewhere, wrote the
 * name down outside the file that defines it.
 *
 * ── Why the list is explicit ─────────────────────────────────────────────
 *
 * Auditing every export in the repository would flag genuinely unused
 * helpers, error constants and test seams, and a check that cries wolf is a
 * check that gets deleted. AUDITED names the entry points that MATTER --- the
 * ones whose silent absence changes behaviour without breaking anything --- and
 * adding to it is the deliberate act of saying "this must stay reachable".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );

/**
 * Entry points that must have a caller.
 *
 * `name` is the identifier to look for. `definedIn` is the file that owns it,
 * excluded from the search. `why` is printed on failure so the next person
 * reads the reason rather than the rule.
 */
const AUDITED = [
  {
    name: 'resolveHeteronyms',
    definedIn: 'src/voice/heteronym-resolver.js',
    why: 'SPEC-HET-002 §9 places three calls in voice-engines.js. Unreached, '
      + 'every reply is synthesised with the engine\'s default pronunciations '
      + 'and the resolver\'s tests still pass.',
    expect: [ 'src/voice/voice-engines.js' ],
  },
  {
    name: 'checkHeapBeforeTool',
    definedIn: 'src/utils/heap-guard.js',
    why: 'The containment for the module_write OOM. Unreached, an unbounded '
      + 'allocation in any tool takes the whole process down and every caller '
      + 'gets a bare 502 -- which is the incident, not a hypothetical.',
    expect: [ 'src/server-http.js' ],
  },
  {
    name: 'transcribeWindowViaWorker',
    definedIn: 'src/voice/stt-worker-supervisor.js',
    why: 'Streaming transcription reaches the Whisper worker through this. '
      + 'Unreached, every partial fails and the session silently falls back.',
    expect: [ 'src/voice/voice-stream-server.js' ],
  },
  {
    name: 'attachVoiceStream',
    definedIn: 'src/voice/voice-stream-server.js',
    why: 'The streaming endpoint is attached at boot. Unreached, the socket '
      + 'route does not exist and the client degrades with no error.',
    expect: [ 'src/server-http.js' ],
  },
  {
    name: 'authenticateUpgrade',
    definedIn: 'src/voice/voice-stream-auth.js',
    why: 'Upgrade-time authentication. Unreached, the socket would accept '
      + 'anonymous connections -- a security property, not a feature.',
    expect: [ 'src/server-http.js' ],
  },
  {
    name: 'cachedReadFile',
    definedIn: 'src/tools/skill-file-cache.js',
    why: 'The skill compile cache. Unreached, every compile re-reads the whole '
      + 'module set from the volume and the gateway times out.',
    expect: [ 'src/tools/skill-modular.js' ],
  },
];

/** Directories searched for callers. */
const SEARCH_DIRS = [ 'src', 'scripts' ];

/**
 * Every file that could hold a caller, excluding tests.
 *
 * Tests are excluded ON PURPOSE and it is the whole design: a module called
 * only by its own tests is exactly the failure being hunted. Counting them as
 * callers would make this check pass on all four historical defects.
 *
 * @returns {string[]} Paths relative to the repository root.
 */
function sourceFiles() {
  const found = [];

  const walk = ( dir ) => {
    if ( ! existsSync( dir ) ) return;
    for ( const entry of readdirSync( dir ) ) {
      if ( 'node_modules' === entry || entry.startsWith( '.' ) ) continue;
      const full = join( dir, entry );
      if ( statSync( full ).isDirectory() ) {
        if ( 'tests' === entry ) continue;
        walk( full );
        continue;
      }
      if ( /\.(js|mjs|py)$/.test( entry ) ) found.push( relative( ROOT, full ) );
    }
  };

  for ( const dir of SEARCH_DIRS ) walk( join( ROOT, dir ) );
  return found;
}

const FILES = sourceFiles();

/**
 * A file's code with its import statements removed.
 *
 * ── Why imports do not count as callers ──────────────────────────────────
 *
 * An import is not a use. The gateway's copy of this guard PASSED with its
 * events router unmounted and its hub never started, because the import line
 * still contained the name. That is the defect being hunted, one level up: a
 * module imported and never called is as unreachable as one never imported,
 * and the import makes it look wired.
 *
 * Found only by deliberately breaking the wiring to check the guard could fail.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutImports( text ) {
  return text
    .replace( /^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '' )
    .replace( /^\s*import\s+['"][^'"]+['"];?/gm, '' )
    // Python's equivalent, since scripts/ is searched too.
    .replace( /^\s*(from\s+\S+\s+)?import\s+.*$/gm, '' );
}

/**
 * Files mentioning a name, excluding the file that defines it.
 *
 * @param {string} name
 * @param {string} definedIn
 * @returns {string[]}
 */
function callersOf( name, definedIn ) {
  const pattern = new RegExp( `\\b${ name }\\b` );
  return FILES.filter( ( file ) => (
    file !== definedIn
      && pattern.test( withoutImports( readFileSync( join( ROOT, file ), 'utf8' ) ) )
  ) );
}

test( 'the audit list points at files that exist', () => {
  // A typo in `definedIn` would silently exclude nothing and make every entry
  // pass for the wrong reason.
  for ( const entry of AUDITED ) {
    assert.ok( existsSync( join( ROOT, entry.definedIn ) ),
      `${ entry.definedIn } does not exist; the audit entry for `
      + `${ entry.name } is stale` );
  }
} );

test( 'the search found source files to search', () => {
  // If the walk broke, every reachability test below would pass vacuously --
  // which is the exact shape of failure this file exists to prevent, applied
  // to itself.
  assert.ok( FILES.length > 20, `only ${ FILES.length } source files found` );
  assert.ok( FILES.some( ( f ) => f.includes( 'voice-engines' ) ) );
  assert.ok( ! FILES.some( ( f ) => f.includes( '/tests/' ) ),
    'tests must be excluded, or a module called only by its own tests passes' );
} );

for ( const entry of AUDITED ) {
  test( `${ entry.name } is reachable from production code`, () => {
    const callers = callersOf( entry.name, entry.definedIn );

    assert.ok( callers.length > 0,
      `${ entry.name } is defined in ${ entry.definedIn } and referenced by no `
      + `other source file.\n\n${ entry.why }\n\n`
      + 'Its own tests will keep passing. Wire it up, or remove it.' );

    // Where the spec names the call site, check THAT file specifically. A
    // reference from somewhere unexpected is not the same as being wired in
    // where it belongs.
    for ( const expected of entry.expect || [] ) {
      assert.ok( callers.includes( expected ),
        `${ entry.name } is referenced somewhere (${ callers.join( ', ' ) }) `
        + `but not in ${ expected }, which is where it is specified to be `
        + `called.\n\n${ entry.why }` );
    }
  } );
}
