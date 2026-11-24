#!/usr/bin/env node
// scripts/verify-wo-2026-11-24-03-mutations.mjs
// ---------------------------------------------------------------------------
// WO-2026-11-24-03: every pin protecting the order, shown able to fail.
//
// The harness is the one verify-wo-2026-11-21-02-mutations.mjs uses: for each
// mutation, copy the tree once into a sandbox, run the named tests on the
// unmutated sandbox (the control must pass with at least one test executed),
// apply the mutation, confirm the mutated file still parses (a syntax error
// is "red for the wrong reason" and is reported INVALID), run the same tests,
// and require at least one failure. The sandbox file is restored after each.
//
// Usage: node scripts/verify-wo-2026-11-24-03-mutations.mjs [name filter]
// ---------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TEST = 'src/tests/trigger-phrases-wo-2026-11-24-03.test.js';
const MF = 'src/tools/manifest-fragments.js';
const MC = 'src/tools/module-consistency.js';

/** { name, file, find, replace, tests (name pattern), testFile } */
const MUTATIONS = [
  // ── R1 / R2 ──
  { name: 'R1: the old edge-stopword condition 3 restored', file: MF, tests: 'R2 row',
    find: '  if (phraseIsStopwordsOnly(p)) reasons.push(',
    replace: '  if (STOPWORDS.has(bareWord(tokens[0])) || STOPWORDS.has(bareWord(tokens[tokens.length - 1]))) reasons.push(' },
  { name: 'R1: condition (b) shipped (fewer than two content tokens refused)', file: MF, tests: 'R1 \\(b\\)',
    find: '  return !tokens.some((t) => {',
    replace: "  return tokens.filter((t) => bareWord(t) !== '' && !STOPWORDS.has(bareWord(t))).length < 2 || !tokens.some((t) => {" },
  { name: 'R1: condition 3 removed entirely (discard condition)', file: MF, tests: 'R2 discard',
    find: '  if (phraseIsStopwordsOnly(p)) reasons.push(', replace: '  if (false) reasons.push(' },
  { name: 'R1: condition 3 removed entirely (R4-2)', file: MF, tests: 'R4-2:',
    find: '  if (phraseIsStopwordsOnly(p)) reasons.push(', replace: '  if (false) reasons.push(' },
  { name: 'R1: a punctuation token counted as content', file: MF, tests: 'R1: the stopword list',
    find: "    return w !== '' && !STOPWORDS.has(w);", replace: '    return !STOPWORDS.has(w);' },
  { name: 'R1: the 12-character floor moved (R4-4)', file: MF, tests: 'R4-4:',
    find: '  if ([...p].length < PHRASE_MIN_CHARS) reasons.push(', replace: '  if ([...p].length <= PHRASE_MIN_CHARS) reasons.push(' },
  { name: 'R1: condition 4 dropped (R4-3)', file: MF, tests: 'R4-3:',
    find: '  if (container) reasons.push(', replace: '  if (false) reasons.push(' },

  // ── R3 persistence ──
  { name: 'R3: trigger_dropped not persisted', file: MF, tests: 'R3-5: refusals',
    find: '    ...(triggerDropped !== undefined ? { trigger_dropped: triggerDropped } : {}),\n', replace: '' },
  { name: 'R3: trigger_dropped not persisted (R4-1)', file: MF, tests: 'R4-1:',
    find: '    ...(triggerDropped !== undefined ? { trigger_dropped: triggerDropped } : {}),\n', replace: '' },
  { name: 'R3: trigger_dropped not a managed key (a manifest_entry can forge it)', file: MF, tests: 'R3-5: a manifest_entry',
    find: "  'triggers_source', 'trigger_dropped', 'depends_on',", replace: "  'triggers_source', 'depends_on'," },
  { name: 'R3: retained triggers lose their record', file: MF, tests: 'R3-5: a manifest_entry',
    find: '    triggerDropped = Array.isArray(existing.trigger_dropped) ? JSON.parse(JSON.stringify(existing.trigger_dropped)) : undefined;',
    replace: '    triggerDropped = undefined;' },
  { name: 'R3: a record invented for retained legacy triggers', file: MF, tests: 'R3-5: retained',
    find: '    triggerDropped = Array.isArray(existing.trigger_dropped) ? JSON.parse(JSON.stringify(existing.trigger_dropped)) : undefined;',
    replace: '    triggerDropped = Array.isArray(existing.trigger_dropped) ? JSON.parse(JSON.stringify(existing.trigger_dropped)) : [];' },
  { name: 'R3: the reason not recorded', file: MF, tests: 'R2 through module_write',
    find: ".map((d) => ({ [key[d.field]]: d.value, reason: (Array.isArray(d.reasons) ? d.reasons : []).join('; ') }));",
    replace: ".map((d) => ({ [key[d.field]]: d.value, reason: '' }));" },
  { name: 'R3: keyword refusals not recorded', file: MF, tests: 'R3-5: refusals',
    find: "  const key = { phrases: 'phrase', keywords: 'keyword', task_class: 'task_class' };",
    replace: "  const key = { phrases: 'phrase', task_class: 'task_class' };" },
  { name: 'R4-6: the block not idempotent (a re-write appends to it)', file: MF, tests: 'R4-6:',
    find: '    triggerDropped = triggerDroppedBlock(dropped);',
    replace: "    triggerDropped = triggerDroppedBlock(dropped).concat(existing ? [{ phrase: 'rewrite', reason: 'second write' }] : []);" },

  // ── R3 C-L ──
  { name: 'R3-6: recorded refusals not read by C-L', file: MC, tests: 'R3-6:',
    find: '      for (const d of (Array.isArray(m.trigger_dropped) ? m.trigger_dropped : [])) {', replace: '      for (const d of []) {' },
  { name: 'R3-6: a stored phrase reported as refused on write', file: MC, tests: 'R3-6:',
    find: "          findings.push({ kind: 'stopword_phrase', state: CL_STATE.WOULD_BE_REFUSED, live_loss: false,",
    replace: "          findings.push({ kind: 'stopword_phrase', state: CL_STATE.REFUSED_ON_WRITE, live_loss: false," },
  { name: 'R3-6: a recorded refusal not marked a live loss', file: MC, tests: 'R3-6:',
    find: "          findings.push({ kind: 'stopword_phrase', state: CL_STATE.REFUSED_ON_WRITE, live_loss: true,",
    replace: "          findings.push({ kind: 'stopword_phrase', state: CL_STATE.REFUSED_ON_WRITE, live_loss: false," },
  { name: 'R3-7: the reconciliation finding not emitted', file: MC, tests: 'R3-7: a module whose',
    find: '        if (rec) {', replace: '        if (false) {' },
  { name: 'R3-7: the comparison made case-sensitive', file: MC, tests: 'R3-7: frontmatter and registration agreeing',
    find: '  const held = new Set(stored.map((x) => x.trim().toLowerCase()));', replace: '  const held = new Set(stored.map((x) => x.trim()));' },
  { name: 'R3-7: recorded refusals not told apart', file: MC, tests: 'R3-7: a module whose',
    find: '    return { phrase: p, now, reasons, recorded: recordedSet.has(k) };', replace: '    return { phrase: p, now, reasons, recorded: false };' },
  { name: 'R3: the repair report counts a recorded refusal as a defect', file: MC, tests: 'R3: the repair report',
    find: ' && x.state !== CL_STATE.REFUSED_ON_WRITE);', replace: ');' },
  { name: 'R3: the repair report proposes no trigger_dropped', file: MC, tests: 'R3: the repair report',
    find: '        ...(d.entry.trigger_dropped !== undefined ? { trigger_dropped: d.entry.trigger_dropped } : {}),\n', replace: '' },

  // ── R6 ──
  { name: 'R6: substring-only refusals folded into still refused', file: MC, tests: 'R3-7: a module whose',
    find: '      : (reasons.length && reasons.every((r) => r.startsWith(PHRASE_SUBSTRING_REASON_PREFIX)) ? \'substring\' : \'refused\');',
    replace: "      : 'refused';" },
  { name: 'R6: newly kept not reported', file: MC, tests: 'R3-7: a module whose',
    find: "            if (x.now === 'kept') rederivation.newly_kept.push(row);", replace: "            if (x.now === 'kept') {}" },

  // ── R5 ──
  { name: 'R5: keyword validation widened (path segments kept)', file: MF, tests: 'R5:',
    find: "  if (segments && segments.has(k)) return", replace: "  if (false) return" },
];

function run( dir, testFile, pattern ) {
  const r = spawnSync( process.execPath, [ '--test', `--test-name-pattern=${ pattern }`, testFile ], { cwd: dir, encoding: 'utf8', env: { ...process.env, WP_SKILL_URL: '', WP_SKILL_KEY: '' } } );
  const out = ( r.stdout || '' ) + ( r.stderr || '' );
  const num = ( k ) => { const m = out.match( new RegExp( `^# ${ k } (\\d+)`, 'm' ) ); return m ? Number( m[ 1 ] ) : 0; };
  return { pass: num( 'pass' ), fail: num( 'fail' ), out };
}

const filter = process.argv[ 2 ] ? new RegExp( process.argv[ 2 ], 'i' ) : null;
const box = mkdtempSync( join( tmpdir(), 'wo2403-mut-' ) );
cpSync( join( ROOT, 'src' ), join( box, 'src' ), { recursive: true } );
cpSync( join( ROOT, 'package.json' ), join( box, 'package.json' ) );
if ( existsSync( join( ROOT, 'node_modules' ) ) ) symlinkSync( realpathSync( join( ROOT, 'node_modules' ) ), join( box, 'node_modules' ) );

let red = 0;
let failures = 0;
const list = MUTATIONS.filter( ( m ) => ! filter || filter.test( m.name ) );
try {
  for ( const mu of list ) {
    const edits = mu.edits || [ { file: mu.file, find: mu.find, replace: mu.replace } ];
    const testFile = mu.testFile || TEST;
    const control = run( box, testFile, mu.tests );
    if ( control.fail || ! control.pass ) { console.log( `FAIL  control  ${ mu.name }  (pass ${ control.pass }, fail ${ control.fail })` ); failures += 1; continue; }
    const originals = new Map();
    let ok = true;
    for ( const ed of edits ) {
      const target = join( box, ed.file );
      const current = readFileSync( target, 'utf8' );
      if ( ! originals.has( target ) ) originals.set( target, current );
      const eol = current.includes( '\r\n' ) ? '\r\n' : '\n';
      const find = ed.find.split( '\n' ).join( eol );
      if ( current.split( find ).length !== 2 ) { console.log( `FAIL  not-applied  ${ mu.name }  (${ ed.file }: the find text does not occur exactly once)` ); ok = false; break; }
      writeFileSync( target, current.replace( find, () => ed.replace.split( '\n' ).join( eol ) ) );
    }
    try {
      if ( ! ok ) { failures += 1; continue; }
      const bad = [ ...originals.keys() ].find( ( t ) => spawnSync( process.execPath, [ '--check', t ], { encoding: 'utf8' } ).status !== 0 );
      if ( bad ) { console.log( `FAIL  INVALID  ${ mu.name }  (the mutated ${ bad } does not parse)` ); failures += 1; continue; }
      const m = run( box, testFile, mu.tests );
      if ( m.fail > 0 ) { red += 1; console.log( `red   ${ mu.name }  (control pass ${ control.pass }; mutated fail ${ m.fail })` ); }
      else { failures += 1; console.log( `FAIL  SURVIVED  ${ mu.name }  (mutated pass ${ m.pass }, fail ${ m.fail })` ); }
    } finally {
      for ( const [ t, text ] of originals ) writeFileSync( t, text );
    }
  }
} finally {
  rmSync( box, { recursive: true, force: true } );
}
console.log( `${ red } of ${ list.length } red` );
process.exit( failures ? 1 : 0 );
