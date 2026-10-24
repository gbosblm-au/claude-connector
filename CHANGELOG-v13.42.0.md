# claude-connector v13.42.0

TENAX-2026-10-24-02, "Reserved budget allocation, measured sizing, and the
ordering defect behind the refusal", the connector half: the compile holds
`MANIFEST.json budget.frame_lane_lines` back from its specialist allowance,
so the one module the gateway's `skill_load_random` may draw per session has
lines no compiled module can take. Built on 13.41.0. Ships with Gateway
Service 2.279.0. **Deploy this connector before setting the key** (order
below).

## Why

The fourth live draw (2026-10-24) selected a module and was then refused:
the session sat at 895 specialist lines against an allowance of 650 before
the draw asked for anything. Brian's ruling of 2026-10-24: raise the ceiling
and add a reserved lane of about 350 lines, outside the ordinary budget so
other modules cannot consume it.

The order assumed `specialist_lines` was a setting of its own. It is not:
the budget block has two keys, and the compile's allowance is computed as
`max_compiled_lines - core_reserve_lines` (layer5Budget). Raising the ceiling
alone would therefore have enlarged every compile by the lane, which is a
selection change on the frozen surface, and compiled modules could have
filled the lane. The account holder decided (2026-10-25) that the connector
subtracts the lane.

## Changes

- **`src/tools/skill-modular.js`**: `resolveLineBudget( budget )` (new,
  exported) returns the ceiling, the core reserve, the lane and the allowance
  `max - core - lane`. `layer5Budget` takes its allowance from it; nothing
  else in the dispatcher changed (no trigger, tier, scoring, always_load,
  load_priority, load_strategy or core-reserve rule). max and core keep their
  existing `|| default` reading.
  - Lane absent, null or 0: the allowance is `max - core` as before, and the
    response is the 13.41.0 response byte for byte (0 is not judged against
    the ceiling, so even a ceiling below the core reserve reports no lane
    problem; the independent review found the first cut did).
  - Lane not a whole number of lines, or more than the ceiling can hold
    (`max - core - lane` below 0): **not applied**. The compile runs as if
    no lane were set, so a bad edit never shrinks or empties a compile, and
    the problem is named (a `warn` log line, `occupancy.line_budget
    .frame_lane_problem`, and a marker). The gateway's draw refuses on the
    same two conditions, so a lane is never charged that the compile did not
    reserve.
  - The compile result's `line_budget` gains `frame_lane_lines` and
    `specialist_lines` only when a lane is applied, and `frame_lane_problem`
    only when one is refused.
- **`src/tools/skill-occupancy.js`**: `occupancy.line_budget` carries the same
  optional fields; the demotion marker says how much of the ceiling the lane
  holds back ("(1250 lines, 350 reserved for the frame lane)"), and a refused
  lane adds its own marker.

**The consequence to know before editing the manifest.** The lane comes out
of the ceiling. Raise `max_compiled_lines` by exactly the lane in the same
edit (900 / 250 / none and 1,250 / 250 / 350 both allow 650, and compile
byte-identically). A lane added without raising the ceiling is a valid,
smaller budget, not an error: 900 / 250 / 350 allows 300, and modules that
loaded before are demoted. Gateway 2.279.0 `scripts/measure-draw-pool.mjs`
prints the ceiling that keeps the allowance.

## Deploy

1. This connector.
2. Gateway 2.279.0 (either order with this connector; the gateway reads the
   lane on its own, and with no lane set neither changes anything).
3. Measure the pool (Gateway `scripts/measure-draw-pool.mjs`), then set
   `frame_lane_lines` and raise `max_compiled_lines` by the same number, in
   one edit of MANIFEST.json.

Against 13.41.0 a lane set in the manifest is not reserved by the compile:
the raised ceiling would enlarge every compile instead. Do not set the key
before this connector is live.

Rollback: `frame_lane_lines: 0` (or remove it), and lower
`max_compiled_lines` by the lane in the same edit (with no lane a raised
ceiling enlarges every compile).

## Tests and verification

Same per-file runner on both trees (Node v22.22.0): 13.41.0 75 files, 1435
tests, 1432 pass, 2 fail, 1 skipped; 13.42.0 76 files, 1439 tests, 1436
pass, 2 fail, 1 skipped. The only per-file difference is the new
`src/tests/frame-lane.test.js` (4/4); the 2 failures are the carried voice
ones. `npm test` 30 passed, 0 failed on both. An independent review compared
216 compile and recompile cases with 13.41.0 (lane absent, null or 0): no
difference.

- `src/tests/frame-lane.test.js` (new, 4 tests) drives the real
  `skill_compile` handler against a volume (helpers/compile-volume.js):
  C-FLANE-NO-COMPILE-DELTA (the ceiling raised by exactly the lane compiles
  byte-identically, on a budget that binds and on the order's 900 / 1,250
  figures), C-FLANE-ZERO-DISABLES (lane absent, null and 0 give byte-identical
  responses, with no new keys), C-FLANE-CEILING-FLOOR (a lane the ceiling
  cannot hold, or a malformed one, is not applied and is named), and the
  arithmetic of `resolveLineBudget`.
- `npm run tenax-2026-10-24-02:mutations`: five named mutations over the
  three claims, each shown red with its control green.
- Gateway 2.279.0's C-FLANE-PARITY imports this release's
  `resolveLineBudget` (through `TENAX_CONNECTOR_ROOT`) and compares it with
  the draw's `resolveFrameLane` over 2,940 budgets: the lane the draw charges
  is the lane this compile reserves, in every case.

No existing test was changed.
