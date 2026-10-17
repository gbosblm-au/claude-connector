#!/usr/bin/env node
/**
 * scripts/verify-tenax-2026-10-15-mutations.mjs   (claude-connector v13.39.0)
 *
 * The named mutations of the TENAX-2026-10-15-01 claim set (connector half),
 * run through scripts/mutation-verifier.mjs: for each one, the claim's probe
 * passes on this tree with at least one test executed, the mutation is applied
 * to a scratch copy (each patched text occurring exactly once), and the same
 * probe must then FAIL.
 *
 *   npm run tenax-2026-10-15:mutations                  all of them
 *   npm run tenax-2026-10-15:mutations -- C-MEM-DUP-REJECTED   one claim
 *
 * Probes whose tests build on one another's state (the ledger and intake
 * suites write a module and then read it back) select the claim's whole group
 * by pattern, so the control run is the same sequence the suite runs.
 *
 * Exit 0 when every mutation reddened its probe and every control was green.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMutations } from './mutation-verifier.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

// Source files.
const SWD = 'src/utils/storeWriteDiscipline.js';
const DER = 'src/utils/derivedIndexes.js';
const VSNAP = 'src/routes/volume-snapshot.js';
const SC = 'src/tools/skill-content.js';
const LEDGER = 'src/utils/moduleLedger.js';
const SMOD = 'src/tools/skill-modular.js';
const PG = 'src/utils/processGuard.js';
const BOOT = 'src/guards/proc_guard_boot.py';
const SE = 'src/tools/script-execute.js';
const INTAKE = 'src/tools/module-intake.js';
const GUARD = 'src/tools-memory/memoryWriteGuard.js';
const MW = 'src/tools-memory/memory-write.js';
const WPM = 'src/tools-memory/wp-memory.js';
const ROWS = 'src/tools-memory/rowMapper.js';
const DUE = 'src/tools-memory/memory-recheck-due.js';
const TTL = 'src/tools-memory/ttlExpiry.js';
const OCC = 'src/tools/skill-occupancy.js';
const SEL = 'src/tools/selection-telemetry.js';
const SCHED = 'src/utils/scheduler.js';
const UNATT = 'src/utils/unattendedPaths.js';

// Probe files.
const T_SWD = 'src/tests/store-write-discipline.test.js';
const T_RESTORE = 'tests/volume-restore-discipline.test.js';
const T_LEDGER = 'src/tests/module-ledger.test.js';
const T_PG = 'src/tests/process-guard.test.js';
const T_INTAKE = 'src/tests/module-intake.test.js';
const T_MEM = 'src/tests/memory-write-guard.test.js';
const T_OCC = 'src/tests/compile-occupancy.test.js';
const T_SEL = 'src/tests/selection-telemetry.test.js';
const T_UNATT = 'src/tests/unattended-paths.test.js';

const MUTATIONS = [
  // ── H-2 store-write discipline (connector half) ─────────────────────────
  { claim: 'C-WRITE-DECLARED-REFUSED', name: 'a claimed store accepts a write by anyone', test: T_SWD, pattern: 'C-WRITE-DECLARED-REFUSED',
    edits: [ { file: SWD, find: '  if ( claimId && claim.claim_id === claimId ) return { allowed: true, claim };',
      replace: '  return { allowed: true, claim };' } ] },
  { claim: 'C-WRITE-DECLARED-REFUSED', name: 'the archive write site loses its guard (walk)', test: T_SWD, pattern: 'calls its guard in the same function',
    edits: [ { file: SC, find: '  const guard = guardStoreWrite({', replace: '  const guard = (() => ({ allowed: true }))({' } ] },
  { claim: 'C-WRITE-CAPTURED', name: 'a refusal discards the attempted content', test: T_SWD, pattern: 'C-WRITE-CAPTURED',
    edits: [ { file: SWD, find: "        const w = writeCaptured( join( root, 'attempted' ), item.rel, buf );",
      replace: "        const w = { ok: true, rel: null };" } ] },
  { claim: 'C-WRITE-CAPTURED', name: 'the volume restore refusal does not capture the upload', test: T_RESTORE, pattern: 'C-WRITE-DECLARED-REFUSED',
    edits: [ { file: SWD, find: "        const w = writeCaptured( join( root, 'attempted' ), item.rel, buf );",
      replace: "        const w = { ok: true, rel: null };" } ] },
  { claim: 'C-CANONICAL-DERIVED-SEPARABLE', name: 'a rebuild that changes canonical data is reported ok', test: T_SWD, pattern: 'C-CANONICAL-DERIVED-SEPARABLE',
    edits: [ { file: DER, find: '    ok: untouched && rebuilt && ! error,', replace: '    ok: rebuilt && ! error,' } ] },
  { claim: 'C-RESTORE-INSPECTED', name: 'the restore skips the inspect pass', test: T_RESTORE, pattern: 'C-RESTORE-INSPECTED',
    edits: [ { file: VSNAP, find: '      if (!inspected.ok) {', replace: '      if (false && !inspected.ok) {' } ] },

  // ── H-3 module write audit ledger ───────────────────────────────────────
  { claim: 'C-LEDGER-ENTRY', name: 'personality_write is not ledgered', test: T_LEDGER, pattern: 'C-LEDGER',
    edits: [ { file: SMOD, find: "    reason: `personality_write ${mode}: ${label}`, tool: 'personality_write',",
      replace: "    reason: `personality_write ${mode}: ${label}`, tool: 'personality_write', kind: 'not-a-kind'," } ] },
  { claim: 'C-LEDGER-READABLE', name: 'the ledger lists oldest first', test: T_LEDGER, pattern: 'C-LEDGER',
    edits: [ { file: LEDGER, find: '  return readAllLedgerEntries().filter( ( e ) => e.path === name ).reverse().slice( 0, n );',
      replace: '  return readAllLedgerEntries().filter( ( e ) => e.path === name ).slice( 0, n );' } ] },
  { claim: 'C-LEDGER-APPEND', name: 'the chain check ignores prev', test: T_LEDGER, pattern: 'C-LEDGER',
    edits: [ { file: LEDGER, find: '    if ( ( parsed.prev || null ) !== expected ) return { ok: false, entries: lines.length, broken_at: i };',
      replace: '    if ( false ) return { ok: false, entries: lines.length, broken_at: i };' } ] },

  // ── H-4 self-termination guard ──────────────────────────────────────────
  { claim: 'C-GUARD-HOST-KILL', name: 'the static scan allows a kill aimed at the parent', test: T_PG, pattern: 'C-GUARD-HOST-KILL',
    edits: [ { file: PG, find: "    if ( HOSTILE_KILL_TARGET.test( argText ) || /getppid|getpgrp|getpgid|PPID/.test( argText ) ) {",
      replace: "    if ( false ) {" } ] },
  { claim: 'C-GUARD-HOST-KILL', name: 'the runtime layer allows any signal target', test: T_PG, pattern: 'the runtime layer refuses what the static scan cannot see',
    edits: [ { file: BOOT, find: 'def _check_signal_target(pid, what):\n', replace: 'def _check_signal_target(pid, what):\n    return\n' } ] },
  { claim: 'C-GUARD-IMAGE-KILL', name: 'pkill is no longer a refused binary', test: T_PG, pattern: 'C-GUARD-IMAGE-KILL',
    edits: [ { file: PG, find: "  'kill', 'pkill', 'killall', 'killall5',", replace: "  'kill', 'killall', 'killall5'," } ] },
  { claim: 'C-GUARD-NON-OVERRIDABLE', name: 'a force flag bypasses the inspection', test: T_PG, pattern: 'C-GUARD-NON-OVERRIDABLE',
    edits: [ { file: SE, find: '  if ( ! inspection.allowed ) {', replace: '  if ( ! inspection.allowed && ! toolInput.force ) {' } ] },
  { claim: 'C-GUARD-SITES-DERIVED', name: 'a launch site is dropped from the registry', test: T_PG, pattern: 'scan -> registry',
    edits: [ { file: PG, find: "  { id: 'export.python_inline',      kind: 'launch', file: 'routes/export.js',", replace: "  { id: 'export.python_inline',      kind: 'launch', file: 'routes/gone.js'," } ] },
  { claim: 'C-GUARD-COMMAND-POSITION', name: 'any whitespace or slash counts as a command position again', test: T_PG, pattern: 'command position',
    edits: [ { file: PG, find: 'const CMD_POSITION = `(?:^|[\\\\n;&|({\\\\[\\`]|\\\\$\\\\(|\\\\b(?:sh|bash|dash|zsh|ash|ksh)\\\\s+-c(?=\\\\s))`;',
      replace: 'const CMD_POSITION = `(?:^|[\\\\s;&|(\\`\'"/]|\\\\$\\\\()`;' } ] },

  // ── H-11 module intake gate ─────────────────────────────────────────────
  { claim: 'C-INTAKE-RECORD', name: 'register without an intake record', test: T_INTAKE, pattern: 'C-INTAKE',
    edits: [ { file: INTAKE, find: "  if ( ! record ) {\n    return { ok: false, code: 'intake_record_missing',",
      replace: "  if ( ! record ) {\n    return { ok: true, fragment: writeModuleFragment( avaDir, entry, dispatchRule ) };\n    return { ok: false, code: 'intake_record_missing'," } ] },
  { claim: 'C-INTAKE-RESCAN', name: 'an edit is not rescanned', test: T_INTAKE, pattern: 'C-INTAKE',
    edits: [ { file: SC, find: '  if (isNew || contentChanged || !existingIntake || existingIntake.content_sha256 !== afterDigest.sha256) {',
      replace: '  if (isNew || !existingIntake) {' } ] },
  { claim: 'C-INTAKE-NAMED-REFUSAL', name: 'a generic refusal that does not name the check', test: T_INTAKE, pattern: 'C-INTAKE-NAMED-REFUSAL',
    edits: [ { file: SC, find: "        failed_checks: intake.failed,\n        message: `Refused by the module intake gate: ${intake.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`).join(' | ')}. Nothing was written.`,",
      replace: "        failed_checks: [],\n        message: 'Refused by the module intake gate.'," } ] },

  // ── H-6 memory write hardening ──────────────────────────────────────────
  { claim: 'C-MEM-INJECTION-REJECTED', name: 'injection phrases are allowed', test: T_MEM, pattern: 'C-MEM-INJECTION-REJECTED',
    edits: [ { file: GUARD, find: '  for ( const [ re, why ] of INJECTION_PATTERNS ) {', replace: '  for ( const [ re, why ] of [] ) {' } ] },
  { claim: 'C-MEM-UNICODE-REJECTED', name: 'invisible Unicode is accepted', test: T_MEM, pattern: 'C-MEM-UNICODE-REJECTED',
    edits: [ { file: GUARD, find: '  if ( inv.found ) {', replace: '  if ( false ) {' } ] },
  { claim: 'C-MEM-DUP-REJECTED', name: 'an exact duplicate is accepted', test: T_MEM, pattern: 'C-MEM-DUP-REJECTED',
    edits: [ { file: GUARD, find: '  const dup = findDuplicate( { category, key, text }, scopeRows );', replace: '  const dup = null;' } ] },
  { claim: 'C-MEM-CAPACITY-DEFINED', name: 'silent at the ceiling', test: T_MEM, pattern: 'C-MEM-CAPACITY-DEFINED',
    edits: [ { file: GUARD, find: '  if ( ! isNewKey || count < limit ) return { ok: true };', replace: '  return { ok: true };' } ] },
  { claim: 'C-MEM-CRED-REDACTED', name: 'persistence half stripped (SQLite stores the raw value)', test: T_MEM, pattern: 'C-MEM-CRED-REDACTED \\(persistence\\): a credential',
    edits: [ { file: MW, find: '  let storedValue = typeof args.value === "string" ? JSON.stringify(decision.text) : decision.text;',
      replace: '  let storedValue = JSON.stringify(args.value);' } ] },
  { claim: 'C-MEM-CRED-REDACTED', name: 'persistence half stripped (WordPress/tenant upsert carries the raw value)', test: T_MEM, pattern: 'C-MEM-CRED-REDACTED \\(persistence\\) and',
    edits: [ { file: WPM, find: "  let storedValue = typeof args.value === 'string' ? JSON.stringify(decision.text) : decision.text;",
      replace: '  let storedValue = JSON.stringify(args.value);' } ] },
  { claim: 'C-MEM-CRED-REDACTED', name: 'injection half stripped (SQLite read tools)', test: T_MEM, pattern: 'C-MEM-CRED-REDACTED \\(injection\\): a secret',
    edits: [ { file: ROWS, find: '    entry.value = redact ? redactDeepForInjection(value) : value;', replace: '    entry.value = value;' } ] },
  { claim: 'C-MEM-CRED-REDACTED', name: 'injection half stripped (WordPress/tenant session context)', test: T_MEM, pattern: 'C-MEM-CRED-REDACTED \\(injection\\): read, search',
    edits: [ { file: WPM, find: '    context:             redactDeepForInjection(result.context),', replace: '    context:             result.context,' } ] },
  { claim: 'C-TWIN-PARITY', name: 'the connector copy of the shared guard drifts by one byte', test: T_MEM, pattern: 'pinned bytes',
    edits: [ { file: GUARD, find: 'export const CONSOLIDATION_CANDIDATES = 10;', replace: 'export const CONSOLIDATION_CANDIDATES = 10; ' } ] },

  // ── H-10 re-check class ─────────────────────────────────────────────────
  { claim: 'C-RECHECK-FIELD', name: 'the SQLite insert drops the re-check class', test: T_MEM, pattern: 'C-RECHECK-FIELD \\(SQLite\\)',
    edits: [ { file: MW, find: '      confidence,\n      decision.recheck.recheck_class,\n      decision.recheck.recheck_at,\n      verifiedAt,\n      args.verified_source ?? null,\n    );\n  }',
      replace: '      confidence,\n      null,\n      decision.recheck.recheck_at,\n      verifiedAt,\n      args.verified_source ?? null,\n    );\n  }' } ] },
  { claim: 'C-RECHECK-FIELD', name: 'the WordPress/tenant body drops the re-check class', test: T_MEM, pattern: 'C-RECHECK-FIELD:',
    edits: [ { file: WPM, find: '    recheck_class:      decision.recheck.recheck_class,', replace: '    recheck_class:      null,' } ] },
  { claim: 'C-RECHECK-SURFACED', name: 'the past-due list is hidden', test: T_MEM, pattern: 'C-RECHECK-SURFACED',
    edits: [ { file: DUE, find: '        WHERE recheck_at IS NOT NULL AND recheck_at <= ?', replace: '        WHERE recheck_at IS NOT NULL AND recheck_at > ?' } ] },
  { claim: 'C-RECHECK-NO-AUTO-DROP', name: 'expiry of a re-check purges the entry', test: T_MEM, pattern: 'C-RECHECK-NO-AUTO-DROP',
    edits: [ { file: TTL, find: '        .prepare("DELETE FROM memories WHERE ttl IS NOT NULL AND ttl < ?")',
      replace: '        .prepare("DELETE FROM memories WHERE (ttl IS NOT NULL AND ttl < ?) OR recheck_at IS NOT NULL")' } ] },

  // ── H-7 compile occupancy ───────────────────────────────────────────────
  { claim: 'C-OCC-REPORTED', name: 'always_load members omitted from the total', test: T_OCC, pattern: 'C-OCC-REPORTED: tokens used',
    edits: [ { file: SMOD, find: "      assembly.push(measurePart(id, 'module', '\\n\\n' + content, module.path));",
      replace: "      if (!module.always_load) assembly.push(measurePart(id, 'module', '\\n\\n' + content, module.path));" } ] },
  { claim: 'C-OCC-PER-MODULE', name: 'the recompile path omits its occupancy', test: T_OCC, pattern: 'C-OCC-PER-MODULE: the recompile',
    edits: [ { file: SMOD, find: "        occupancy:            buildOccupancy({ parts: deltaAssembly,", replace: "        occupancy_gone:       buildOccupancy({ parts: deltaAssembly," } ] },
  { claim: 'C-OCC-TRUNCATION-POLICY', name: 'silent truncation at the cap', test: T_OCC, pattern: 'C-OCC-TRUNCATION-POLICY: over the token cap',
    edits: [ { file: SMOD, find: "          content: result.compiled,\n          target: 'compiled',",
      replace: "          content: occupancy.over_cap ? result.compiled.slice(0, occupancy.cap * 4) : result.compiled,\n          target: 'compiled'," } ] },
  { claim: 'C-OCC-TRUNCATION-POLICY', name: 'the over-cap marker is dropped', test: T_OCC, pattern: 'C-OCC-TRUNCATION-POLICY: over the token cap',
    edits: [ { file: OCC, find: '  if ( overCap ) markers.push(', replace: '  if ( false ) markers.push(' } ] },
  { claim: 'C-OCC-REPORTED', name: 'the occupancy wire shape changes under the gateway (cap_source renamed)', test: T_OCC, pattern: 'buildOccupancy still produces the fixture',
    edits: [ { file: OCC, find: '    cap_source: tokenCap.source,', replace: '    capSource: tokenCap.source,' } ] },

  // ── H-8 selection telemetry ─────────────────────────────────────────────
  { claim: 'C-SEL-RECORDED', name: 'recompile events are not recorded', test: T_SEL, pattern: 'C-SEL-RECORDED: a compile and a recompile',
    edits: [ { file: SMOD, find: "  recordSelection(paths.avaDir, {\n    path: 'recompile',", replace: "  (() => {})(paths.avaDir, {\n    path: 'recompile'," } ] },
  { claim: 'C-SEL-READONLY', name: 'an auto-archive path wired to the log', test: T_SEL, pattern: 'C-SEL-READONLY',
    edits: [ { file: SMOD, find: "import { recordSelection } from './selection-telemetry.js';", replace: "import { recordSelection, readSelectionRecords } from './selection-telemetry.js';" } ] },
  { claim: 'C-SEL-CONSTRAINT-TRAVELLED', name: 'the report renders without the constraint', test: T_SEL, pattern: 'C-SEL-CONSTRAINT-TRAVELLED',
    edits: [ { file: SEL, find: '    constraint: SELECTION_CONSTRAINT,\n    filters:', replace: '    filters:' } ] },
  { claim: 'C-SEL-CLOSED', name: 'a free-text tier is stored as given', test: T_SEL, pattern: 'C-SEL-CLOSED',
    edits: [ { file: SEL, find: '      modules: ( modules || [] ).map( ( m ) => ( { id: String( m.id ).slice( 0, 120 ), tier: closed( m.tier, SELECTION_TIERS ) } ) ),',
      replace: '      modules: ( modules || [] ).map( ( m ) => ( { id: String( m.id ).slice( 0, 120 ), tier: String( m.tier ) } ) ),' } ] },

  // ── H-5 unattended paths (connector half) ───────────────────────────────
  { claim: 'C-UNATT-ENUMERATED', name: 'the shutdown path is omitted from the registry', test: T_UNATT, pattern: 'C-UNATT-ENUMERATED',
    edits: [ { file: UNATT, find: "    id: 'service.shutdown', file: 'utils/serviceRuntime.js',", replace: "    id: 'service.shutdown', file: 'utils/gone.js'," } ] },
  { claim: 'C-UNATT-FAIL-CLOSED', name: 'a late send is sent instead of held', test: T_UNATT, pattern: 'C-UNATT-FAIL-CLOSED',
    edits: [ { file: SCHED, find: '    if (lateMs > lateGraceMs()) {', replace: '    if (false && lateMs > lateGraceMs()) {' } ] },
  { claim: 'C-UNATT-FAIL-CLOSED', name: 'overlapping ticks both dispatch', test: T_UNATT, pattern: 'overlapping ticks',
    edits: [ { file: SCHED, find: '  if (_tickInFlight) {', replace: '  if (false) {' } ] },
  { claim: 'C-UNATT-FAIL-CLOSED', name: 'a send cancelled mid-tick is still dispatched', test: T_UNATT, pattern: 'cancelled while an earlier send',
    edits: [ { file: SCHED, find: '    if (sched.status !== "pending") continue;', replace: '' } ] },
  { claim: 'C-UNATT-TIMEOUT-NOT-REFUSAL', name: 'a timeout is counted as a refusal', test: T_UNATT, pattern: 'C-UNATT-TIMEOUT-NOT-REFUSAL',
    edits: [ { file: SCHED, find: 'export const REFUSAL_STATUSES = Object.freeze(["cancelled"]);', replace: 'export const REFUSAL_STATUSES = Object.freeze(["cancelled", "expired_unconfirmed"]);' } ] },
  { claim: 'C-UNATT-TIMEOUT-NOT-REFUSAL', name: 'cancelling an expired hold rewrites it as a refusal', test: T_UNATT, pattern: 'C-UNATT-TIMEOUT-NOT-REFUSAL',
    edits: [ { file: SCHED, find: '    if (rec.status === "expired_unconfirmed") {\n      return { error: "This send already expired',
      replace: '    if (false) {\n      return { error: "This send already expired' } ] },
  { claim: 'C-UNATT-CLASS-RECORDED', name: 'an observer surface misrecorded as policy', test: T_UNATT, pattern: 'C-UNATT-CLASS-RECORDED',
    edits: [ { file: UNATT, find: "    id: 'tracking.append_loop', file: 'utils/tracking.js', callee: 'setInterval', anchor: 'startAppendLoop',\n    cls: 'observer',",
      replace: "    id: 'tracking.append_loop', file: 'utils/tracking.js', callee: 'setInterval', anchor: 'startAppendLoop',\n    cls: 'policy'," } ] },
];

const only = process.argv[ 2 ] || null;
process.exit( verifyMutations( {
  root: ROOT, mutations: MUTATIONS, defaultTest: T_MEM, scratchPrefix: 'cc-tenax-1015-mut-', only,
  nodeArgs: [ '--experimental-test-module-mocks' ],
} ) );
