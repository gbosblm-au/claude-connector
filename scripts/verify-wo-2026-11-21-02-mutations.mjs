#!/usr/bin/env node
// scripts/verify-wo-2026-11-21-02-mutations.mjs
// ---------------------------------------------------------------------------
// WO-2026-11-21-02: every pin protecting the order, shown able to fail.
//
// For each mutation: copy the tree once into a sandbox, run the named tests on
// the unmutated sandbox (the control must pass with at least one test
// executed), apply the mutation, confirm the mutated file still parses (a
// syntax error is "red for the wrong reason" and is reported INVALID), run the
// same tests, and require at least one failure. The sandbox file is restored
// after each mutation.
//
// Usage: node scripts/verify-wo-2026-11-21-02-mutations.mjs [name filter]
// ---------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TEST = 'src/tests/module-registration-wo-2026-11-21-02.test.js';
const INTAKE_TEST = 'src/tests/module-intake.test.js';
const MF = 'src/tools/manifest-fragments.js';
const MFILES = 'src/tools/module-files.js';
const SC = 'src/tools/skill-content.js';
const MC = 'src/tools/module-consistency.js';
const MI = 'src/tools/module-intake.js';

/** { name, file, find, replace, tests (name pattern), testFile } */
const MUTATIONS = [
  // ── Phase P ──
  { name: 'P1: heading words become keywords again', file: MF, tests: 'P-1:',
    find: "    triggers = { keywords: [], phrases: [], task_class: [] };\n    triggersSource = TRIGGERS_SOURCE.NONE;\n  }",
    replace: "    triggers = { keywords: ((body.match(/^#\\s+(.+)$/m) || ['', ''])[1]).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2), phrases: [], task_class: [] };\n    triggersSource = 'derived';\n  }" },
  { name: 'P3: the no-triggers warning is not returned', file: MF, tests: 'P-1:',
    find: "  if (triggersSource === TRIGGERS_SOURCE.NONE) {\n    warnings.push(", replace: "  if (false) {\n    warnings.push(" },
  { name: 'P3/section 7: the intake refuses an empty trigger set again', file: MI, tests: 'P-1:',
    find: "else checks.push( { name: 'triggers', status: 'warn',", replace: "else checks.push( { name: 'triggers', status: 'fail'," },
  { name: 'P3/section 7: intake test pins the warn status', file: MI, tests: 'triggers: an empty trigger set', testFile: INTAKE_TEST,
    find: "else checks.push( { name: 'triggers', status: 'warn',", replace: "else checks.push( { name: 'triggers', status: 'pass'," },
  { name: 'P5: the phrase lint is skipped', file: MF, tests: 'P-2:',
    find: '      const why = phraseLintReasons(p, phraseSet);', replace: '      const why = [];' },
  { name: 'P5: the drops are not reported', file: MF, tests: 'P-2:',
    find: "  for (const d of dropped) {\n    warnings.push(", replace: "  for (const d of []) {\n    warnings.push(" },
  { name: 'P4: path segments pass the keyword lint', file: MF, tests: 'P-3:',
    find: "  if (segments && segments.has(k)) return", replace: "  if (false && segments.has(k)) return" },
  { name: 'P4: module/skill/note pass the keyword lint', file: MF, tests: 'P-3:',
    find: '  if (FORBIDDEN_KEYWORDS.includes(k)) return', replace: '  if (false) return' },
  { name: 'P6: provides from H2 headings again', file: MF, tests: 'P-4:',
    find: "    provides = []; origin.provides = 'none';",
    replace: "    provides = [...body.matchAll(/^##\\s+(.+)$/gm)].map((m) => m[1].toLowerCase()); origin.provides = 'heading';" },
  { name: 'P7: title from the first # heading again', file: MF, tests: 'P-5:',
    find: "  else { title = id; origin.title = 'id'; }", replace: "  else { title = (body.match(/^#\\s+(.+)$/m) || [null, id])[1]; origin.title = 'heading'; }" },
  { name: 'P2/P9: frontmatter values lower-cased in reading', file: MF, tests: 'P-6:',
    find: "  let s = String(raw).trim();\n  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);",
    replace: "  let s = String(raw).trim().toLowerCase();\n  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);" },
  { name: 'P9: supplied strings not checked before the lint', file: MF, tests: 'P9:',
    find: "  if (supplied) walk('triggers (as supplied)', supplied.raw, supplied.source);", replace: '' },
  { name: 'P9: U+FFFD accepted', file: MF, tests: 'P9:',
    find: "    } else if (value.includes('\\uFFFD')) {", replace: "    } else if (false) {" },
  { name: 'P8: version invented when the frontmatter states none', file: MF, tests: 'P-7:',
    find: "  else origin.version = 'absent';", replace: "  else { version = '1.0.0'; origin.version = 'default'; }" },
  { name: 'P8: the frontmatter version ignored', file: MF, tests: 'P-7:',
    find: "  if (fmStr('version')) { version = fmStr('version');", replace: "  if (false) { version = fmStr('version');" },
  { name: 'P8: line count carried forward', file: MF, tests: 'P-8:',
    find: '    line_count_estimate: lineCountOf(body),', replace: '    line_count_estimate: existing && existing.line_count_estimate ? existing.line_count_estimate : lineCountOf(body),' },
  { name: 'R3: triggers cleared on an update with no source', file: MF, tests: 'P \\(R3\\)',
    find: '  } else if (existing && isNonEmptyTriggers(existing.triggers)) {', replace: '  } else if (false) {' },
  { name: 'Reader: dotted trigger keys not read', file: MF, tests: 'verbatim frontmatter reader',
    find: "    const dotted = k.match(/^triggers[./](keywords|phrases|task_class)$/);", replace: '    const dotted = null;' },

  { name: 'Reader: one-line flow mappings not read', file: MF, tests: 'P2: triggers written as a one-line flow mapping',
    find: '        const map = flowMapping(v);', replace: '        const map = null;' },
  { name: 'Reader: an unreadable triggers value is dropped in silence', file: MF, tests: 'P2: triggers written as a one-line flow mapping',
    find: "  for (const u of fm.unreadable) {\n    warnings.push(", replace: "  for (const u of []) {\n    warnings.push(" },
  { name: 'P9 refuses a skip_manifest body edit', file: SC, tests: 'P9 and the warnings concern registration only',
    find: '    if (derived && willRegister) {\n      if (writeGuard.snapshot) {', replace: '    if (derived && derived.refusal) preRefusals.push(derived.refusal);\n    if (derived && willRegister) {\n      if (writeGuard.snapshot) {' },
  { name: 'Warnings returned for a frozen-manifest id', file: SC, tests: 'P9 and the warnings concern registration only',
    find: "  const registrationWarnings = derived && willRegister && !(regPlan && regPlan.action === 'frozen') ? derived.warnings : [];",
    replace: "  const registrationWarnings = derived ? derived.warnings : [];" },

  // ── Phase Q ──
  { name: 'Q2: no update in place (a new registration in the category fragment)', file: MFILES, tests: 'Q-1 \\(Q2\\)',
    find: '  if (here.length) {\n    return {\n      ...base,\n      action: \'update_in_place\',', replace: '  if (false) {\n    return {\n      ...base,\n      action: \'update_in_place\',' },
  { name: 'Q2: the plan\'s fragment not passed to the write', file: SC, tests: 'Q-1 \\(Q2\\)',
    find: '        fragmentOptions: regPlan && regPlan.target_file ? { targetFile: regPlan.target_file } : {} });', replace: '        fragmentOptions: {} });' },
  { name: 'Q4: a frozen-manifest id gets a fragment registration', file: MFILES, tests: 'Q-2:',
    find: '  if (frozen.length) {\n    const sources', replace: '  if (false) {\n    const sources' },
  { name: 'Q3: a registration elsewhere is not refused', file: MFILES, tests: 'Q3: a shadowed|Q-3:',
    find: '  if (elsewhere.length) {\n    return {', replace: '  if (false) {\n    return {' },
  { name: 'Q3: the registration refusal is not reported first for a registration-only conflict', file: SC, tests: 'Q-3:',
    find: '  const refusals = registrationFirst ? [...preRefusals, ...writeGuard.refusals] : [...writeGuard.refusals, ...preRefusals];',
    replace: '  const refusals = [...writeGuard.refusals, ...preRefusals];' },
  { name: 'Q3 route: R2 does not let the acknowledgement through', file: MFILES, tests: 'Q3 route',
    find: "    if (registrationOnly && ackSource && r.resolved_from", replace: "    if (false && registrationOnly && ackSource && r.resolved_from" },
  { name: 'Q3 route: a wrong acknowledgement is not refused', file: MFILES, tests: 'Q3 route',
    find: '    return {\n      ...base,\n      action: \'refused\',\n      write_fragment: false,\n      refusal: {\n        code: REFUSAL.ACK_REGISTRATION_REJECTED,',
    replace: '    if (false) return {\n      ...base,\n      action: \'refused\',\n      write_fragment: false,\n      refusal: {\n        code: REFUSAL.ACK_REGISTRATION_REJECTED,' },
  { name: 'Q3: R2 lift applies even where a file holds the id', file: MFILES, tests: 'where a file still holds',
    find: '    const registrationOnly = Boolean(target) && !r.resolved_path && occupied.every((p) => p === requested);',
    replace: '    const registrationOnly = Boolean(target);' },
  { name: 'Q5: a category fragment without "source" is not found', file: MF, tests: 'Q-4:',
    find: "    if (parsed.source === category || (Array.isArray(parsed.modules) && fragmentSourceOf(name, parsed) === category)) return name;",
    replace: "    if (parsed.source === category) return name;" },
  { name: 'Dry run: the plan names a different fragment than the write uses', file: MFILES, tests: 'dry run:',
    find: '  const categoryFragment = findCategoryFragment(paths.avaDir, category);', replace: '  const categoryFragment = null;' },
  { name: 'Q-1: the old minting (no update in place, category fragment found by "source" alone)', tests: 'Q-1:',
    edits: [
      { file: MFILES, find: '  if (here.length) {\n    return {\n      ...base,\n      action: \'update_in_place\',', replace: '  if (false) {\n    return {\n      ...base,\n      action: \'update_in_place\',' },
      { file: MF, find: "    if (parsed.source === category || (Array.isArray(parsed.modules) && fragmentSourceOf(name, parsed) === category)) return name;",
        replace: "    if (parsed.source === category) return name;" },
    ] },

  // ── Phase S ──
  { name: 'S1: stopword phrases not reported', file: MC, tests: 'S-1:',
    find: "        if (typeof p === 'string' && phraseIsStopwordsOnly(p)) {", replace: "        if (false) {" },
  { name: 'S1: path-segment keywords not reported', file: MC, tests: 'S-1:',
    find: "        if (why && why !== 'empty') findings.push(", replace: "        if (false) findings.push(" },
  { name: 'S1: stale version not reported', file: MC, tests: 'S-1:',
    find: "        if (m.version !== undefined && m.version !== null && fmVersion && String(m.version) !== String(fmVersion)) {",
    replace: "        if (false) {" },
  { name: 'S1: provides with a space not reported', file: MC, tests: 'S-1:',
    find: "        if (typeof v === 'string' && /\\s/.test(v.trim())) findings.push(", replace: "        if (false) findings.push(" },
  { name: 'S1: C-L placed in the deterministic section', file: MC, tests: 'S-1:',
    find: "  if (on('C-F')) deterministic['C-F'] = checkF(snapshot, resolutions);",
    replace: "  if (on('C-F')) deterministic['C-F'] = checkF(snapshot, resolutions);\n  if (on('C-L')) deterministic['C-L'] = { pass: true };" },
  { name: 'S-2: every phrase read as a stopword phrase', file: MF, tests: 'S-2:',
    find: '  return !tokens.some((t) => {', replace: '  return true || !tokens.some((t) => {' },
  { name: 'S1: U+FFFD in a fragment string not reported', file: MC, tests: 'C-L: U\\+FFFD',
    find: "        if (value.includes('\\uFFFD')) findings.push(", replace: "        if (false) findings.push(" },
  { name: 'S1: line count drift not reported', file: MC, tests: 'C-L: U\\+FFFD',
    find: '        if (typeof m.line_count_estimate === \'number\' && f.lines > 0 && Math.abs(m.line_count_estimate - f.lines) / f.lines > 0.2) {',
    replace: '        if (false) {' },
  { name: 'S2: C-F never judges a defect', file: MC, tests: 'S2: C-F judges',
    find: "    const judgement = byTool > 1 ? 'defect_minted_on_write'", replace: "    const judgement = false ? 'defect_minted_on_write'" },
  { name: 'S2: the registered_by marker not read', file: MC, tests: 'S2: C-F judges',
    find: "  if (e.registered_by === REGISTERED_BY_MODULE_WRITE) return", replace: "  if (false) return" },
  { name: 'S2: the ledger not read', file: MC, tests: 'S2: C-F attributes',
    find: "  if (ledgerRegs.has(`${reg.id}|${file}`)) return", replace: "  if (false) return" },
  { name: 'S2: the old derived-entry shape not recognised', file: MC, tests: 'S2: C-F attributes',
    find: "  if (LEGACY_DERIVED_KEYS.every((k) => keys.includes(k)) && keys.every((k) => LEGACY_DERIVED_KEYS.includes(k))) {",
    replace: "  if (false) {" },
  { name: 'S2: module_write marker not written', file: MF, tests: 'P-1:',
    find: '    registered_by: REGISTERED_BY_MODULE_WRITE,\n  };', replace: '  };' },

  // ── Phase R ──
  { name: 'R4: a clean entry is proposed for change', file: MC, tests: 'R4:',
    find: '    if (!defects) {\n      proposalNote =', replace: '    if (false) {\n      proposalNote =' },
  { name: 'R3: approval not required', file: MC, tests: 'R1-R3:',
    find: '      approval_required: Boolean(defects),', replace: '      approval_required: false,' },
  { name: 'R2: proposal not derived from the frontmatter', file: MC, tests: 'R1-R3:',
    find: "      const d = deriveRegistration(path.replace(/^modules\\//, ''), f.text, {}, {});",
    replace: "      const d = { entry: e, warnings: [], refusal: null };" },
  { name: 'R1: a frozen-manifest id not marked', file: MC, tests: 'R4:',
    find: '      ...(frozen.length ? { frozen_manifest: frozen,', replace: '      ...(false ? { frozen_manifest: frozen,' },
];

function run( dir, testFile, pattern ) {
  const r = spawnSync( process.execPath, [ '--test', `--test-name-pattern=${ pattern }`, testFile ], { cwd: dir, encoding: 'utf8', env: { ...process.env, WP_SKILL_URL: '', WP_SKILL_KEY: '' } } );
  const out = ( r.stdout || '' ) + ( r.stderr || '' );
  const num = ( k ) => { const m = out.match( new RegExp( `^# ${ k } (\\d+)`, 'm' ) ); return m ? Number( m[ 1 ] ) : 0; };
  return { pass: num( 'pass' ), fail: num( 'fail' ), out };
}

const filter = process.argv[ 2 ] ? new RegExp( process.argv[ 2 ], 'i' ) : null;
const box = mkdtempSync( join( tmpdir(), 'wo02-mut-' ) );
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
