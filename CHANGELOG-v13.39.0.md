# claude-connector v13.39.0

TENAX-2026-10-15-01, "Hermes adoption" (rev 2, Addendum 1 included): the
connector half. Ships with Gateway Service 2.262.0 and ts-client-gateway
5.235.0. Built on 13.38.0.

The dispatch layer is untouched. That covers `CORE.md`, `MANIFEST.json`,
`DISPATCH_RULES.json` and `modules/` as compile inputs, trigger-tiered
selection, `always_load`, `load_priority`, the per-turn recompile, Layer 0 and
provenance binding. Everything here is additive. H-7 and H-8 measure and
report; neither gains any action on selection data.

## Deploy order

Gateway Service 2.262.0 (with its migrations), then this connector, then the
client. The connector has no hard dependency on the gateway release:

- An older gateway ignores the new `occupancy` field on `/ti-skill-compile`.
- Memory writes and reads behave the same whichever gateway is in front.

## H-2: store-write discipline (connector stores)

**`src/utils/storeWriteDiscipline.js` (new).** A declared-writer claim for
each store family. The families are a closed set: `references`, `modules`,
`archive`, `scripts`. `vault` is also in the set, but a claim on it is refused
here with a pointer to the gateway, where the vault lives.

- **Claims.** A claim names its holder, a purpose and an expiry (default 15
  minutes, maximum 24 hours). It is declared atomically: two writers racing
  cannot both win.
- **Refusals.** While a claim stands, a write by anyone else is refused and
  not applied, and the refusal names the holder (`store_claimed`).
- **Forensics.** The refused content, and the content it would have replaced,
  are captured with a manifest under
  `ava/.store-discipline/forensics/<stamp>-<family>-<id>/`.
- **Guarded writes.** `archive_write`, `reference_write`, `script_write` and
  `module_write` take `claim_id`, so the holder's own writes go through.
- **Restores claim for their duration.** The WordPress restores (`restore-*`
  and the modular push) and `POST /volume-restore` claim every family they
  touch. If another holder already has one, nothing is written and the whole
  payload is captured.

**`src/utils/derivedIndexes.js` (new).** Canonical data and derived indexes
are separable. The derived indexes are `brain_tools_catalog` and
`merged_manifest`. `detachAndRebuild()` sets an index aside, rebuilds it, and
proves by digest that no canonical file changed.

**`store_discipline` tool (`src/tools/hermes-admin-tools.js`, new).** Actions:
`declare`, `release`, `list`, `forensics`, `rebuild_derived`. It is a system
write tool, so non-owner tenants never see it.

The protocol this implements is `references/protocol/store-write-discipline.md`.
It is drafted for Ava in the delivery record.

## H-3: module write audit ledger

**`src/utils/moduleLedger.js` (new).** One append-only line per mutation of a
skill file, at `ava/.ledger/mutations.jsonl`. That covers module bodies,
manifest fragment registrations, `SKILL.md` and its additions, and the
personal files the compile reads. Each line carries:

- the file, the actor, the reason (the caller's `change_note`) and the time;
- the sha256 of the file before and after;
- `prev`, the hash of the previous line, so an edit in place breaks the chain.

**`module_ledger` tool (read-only).** Returns the last N mutations of a module,
the chain check, and the module's latest intake record.

## H-4: self-termination guard

**`src/utils/processGuard.js` and `src/guards/proc_guard_boot.py` (new).**
Three layers:

1. **Launch guard.** Every process launch passes through `assertLaunchAllowed()`
   with a registered site id. The set of launch sites is derived by a scan and
   compared with the registry in both directions. Host and platform stop or
   restart commands, and name-derived or image-level kills, are refused. Since
   this release, command words are matched only in command position, so a path
   such as `/data/skill` or an argument value no longer matches by accident.
2. **Script inspection.** Before `script_execute` runs anything, it scans the
   script, the local modules it imports and any `sitecustomize` or
   `usercustomize` file.
3. **Runtime interposition.** Scripts run under a boot file shipped in the
   image. It wraps `os.kill`, the `exec`/`spawn` family and
   `subprocess.Popen`, so a signal may go only to the script's own processes.
   No input field overrides it.

## H-5: unattended paths fail closed

**`src/utils/unattendedPaths.js` (new).** Every timer, cron schedule and
signal handler is classified as policy (destructive actions fail closed) or
observer (fails open), with its stated default. The set is derived by scan and
compared both ways.

**Scheduled sends (`src/utils/scheduler.js`, `src/tools/emailSchedule.js`):**

- A send due more than `SCHEDULE_LATE_GRACE_MINUTES` (default 60) ago is
  **held** for a person. It is never sent late.
- Each send's status is re-checked immediately before dispatch, so
  overlapping ticks never dispatch it twice.
- A hold nobody releases within `SCHEDULE_HOLD_EXPIRY_DAYS` (default 7) is
  recorded `expired_unconfirmed`. That is not counted as a refusal.
- An expired send cannot be cancelled. A sequence cancel includes held steps.

Both variables are in `.env.example`.

## H-6 (write half) and H-10: memory guard and re-check dates

**`src/tools-memory/memoryWriteGuard.js` (new).** It is byte-identical to the
gateway's `lib/memory-write-guard.js`, and both repos pin its sha256 and that
of the shared fixture. On every write path (SQLite and the WordPress tenant
store):

- injection, exfiltration and invisible-Unicode content is refused with the
  reason;
- credential-shaped text is redacted before it is stored;
- the same value under another key is refused, naming the existing entry;
- at capacity, a new key is refused with the oldest entries offered as
  consolidation candidates. Nothing is truncated.

Reads, search, list and session context redact before injection, including
rows stored before this release. **Capacity (1000 entries per visible scope)
is provisional**; the gateway delivery ships the query that measures
production.

**H-10.** Entries recording an artefact, a deployment or a version carry a
re-check class and date (inferred when not given). `memory_recheck_due` (new)
lists past-due entries, and session context returns `recheck_due`. Nothing is
dropped automatically.

## H-7: compile occupancy

**`src/tools/skill-occupancy.js` (new).** Every compile, and every recompile,
reports:

- the tokens used against the cap (`budget.max_compiled_tokens`, default
  40,000), with the counting method named (an assembly estimate,
  `ceil(chars / 4)` per part);
- every part's size, including `always_load` members;
- the truncation markers.

The policy is written next to the cap. **The compile never cuts text.** Over
the line budget, whole modules are demoted and named. Over the token cap, the
body is returned whole and flagged `over_cap`.

The shape on the wire to the gateway is pinned by a fixture shared
byte-for-byte with the gateway
(`src/tests/fixtures/compile-occupancy-wire.json`).

## H-8: module selection telemetry (read-only)

**`src/tools/selection-telemetry.js` (new).** One appended line per compile,
written under `ava/telemetry/selection/`, recording:

- which modules the compile received;
- the tier that admitted each, with the always-load members;
- the person-prior outcome;
- the recompile `delta`.

`skill_selection_report` presents the data, and its constraint travels with
every report. No code path consumes this log to alter selection: the dispatch
layer does not import the reader, and a static guard holds that.

## H-11: module intake gate

**`src/tools/module-intake.js` (new).** `module_write` applies a checklist
before a module is written or registered, and again whenever its content
changes:

- it has triggers;
- the commands it references are recorded, and destructive ones fail;
- credential names and volume paths are recorded, and credential values fail;
- a verification step is present when commands are referenced;
- an independence gate passes.

The result is kept as an intake record with history. A failed check refuses
the write and names the check. The lint notes warn and never block.

**The independence gate is not defined at source.** The work order names it
without defining it, so this build's reading is flagged in the delivery
record for Ava to confirm or redefine.

## Other files

`src/server-http.js`, `src/routes/export.js`, `src/routes/volume-snapshot.js`
and the voice workers pass every process launch through the H-4 guard.
`.env.example` documents the two scheduler variables.

## Mutations

Run with `npm run tenax-2026-10-15:mutations`: 47 named mutations across 35
claims, each red with a green control (`scripts/mutation-verifier.mjs`, a copy
of the gateway's verifier with `nodeArgs` added). The credential file
`data/google-service-account.json` is excluded from the scratch copies.
