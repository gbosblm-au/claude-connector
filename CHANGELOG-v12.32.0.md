# claude-connector v12.32.0

**Implements SPEC-TNX-150BLOCK-2026-08-05** — automated large-build hard-block
rule.

---

## BREAKING CHANGE — enforcement is ON by default

Any single `script_write`, `reference_write` or `module_write` whose content
exceeds **150 lines** is now **rejected**. The payload is not written and not
backed up.

Per spec section 13 the rollout is staged. To run in observation mode first, set
all three to `false`, watch the `chunk-guard: BLOCKED` log lines to see what
would have been refused, then enable:

```
CHUNK_ENFORCE_SCRIPTS=false
CHUNK_ENFORCE_REFS=false
CHUNK_ENFORCE_MODULES=false
```

---

## What the rule enforces

The Build Robustness Protocol's chunking rule was **advisory**, and advice
depends on the author remembering to follow it. Large single writes of 300 to
900 lines repeatedly exceeded assistant output limits, dropping out mid-write
and truncating or losing the deliverable.

The worst part was that the failure was **silent**: it surfaced later, when a
dependent step failed on a file that had never been fully written. Nothing
intercepted the oversized write at the point it was attempted.

Enforcing at the connector guarantees the rule holds regardless of which client
is calling, and converts a silent late failure into a loud immediate one
carrying the information needed to fix it.

## Configuration (spec section 6)

| Key | Default | Meaning |
|---|---|---|
| `CHUNK_LIMIT_LINES` | `150` | Max lines in a single interactive write |
| `CHUNK_ENFORCE_SCRIPTS` | `true` | Apply to `script_write` |
| `CHUNK_ENFORCE_REFS` | `true` | Apply to `reference_write` |
| `CHUNK_ENFORCE_MODULES` | `true` | Apply to `module_write` |
| `CHUNK_EXEMPT_ARCHIVE` | `true` | Exempt `archive_write` |
| `CHUNK_SUGGEST_SPLIT` | `true` | Return a decomposition on rejection |

Per spec section 6, enforcement is disabled **only** by an explicit `false`. An
unrecognised value such as a typo leaves enforcement **on**: a misconfiguration
must fail toward the guard, not away from it. There is deliberately **no
per-call bypass flag**, which is what preserves the hard-block property.

## The placement decision, and why it matters

The guard is applied in the three interactive tool **handlers** —
`handleScriptWrite`, `handleReferenceWrite`, `handleModuleWrite` — and
deliberately **not** in `writeContentFile()`.

`writeContentFile` is also the write path used by `handleScriptRestoreFromWp`
and its siblings behind the `/restore-*` endpoints. Putting the block there
would fail **every snapshot restore containing a file over 150 lines** — the
same class of regression as the v12.28.0 auth-gate gap that broke connector
snapshot push, and for the same reason: a control applied one layer too deep.

Restore is bulk recovery, not interactive authoring. A dedicated regression test
writes a 600-line file through the restore path and asserts it lands intact.

## Rejection payload (spec 5.3, 5.4)

```json
{
  "error": "chunk_limit_exceeded",
  "code": "CHUNK_LIMIT_EXCEEDED",
  "tool": "script_write",
  "target": "journey_data.py",
  "line_count": 400,
  "limit": 150,
  "retryable": false,
  "suggested_decomposition": {
    "parts": 3,
    "part_files": ["journey_data_part01.py", "journey_data_part02.py", "journey_data_part03.py"],
    "lines_per_part": 134,
    "builder": "journey_data_build.py"
  }
}
```

`retryable: false` is deliberate. Per spec section 9 this is a **deterministic**
failure: retrying with identical arguments fails identically. The correct
response is to apply the decomposition and re-issue as separate smaller writes,
then verify each landed.

Line counting follows spec 5.2 exactly: split on newline, a trailing newline
does not add a line, and content of exactly 150 lines is permitted. That matters
because the number reported to the caller must match what they see when they
open the file to check.

## Verification — all eight acceptance criteria

```
1. script_write with 151 lines rejected, not written, not backed up   PASS
2. script_write with exactly 150 lines permitted and lands intact     PASS
3. reference_write >150 rejected with a decomposition suggestion      PASS
4. module_write >150 rejected                                         PASS
5. archive_write of 900 lines permitted (exempt)                      PASS
6. script_execute of an on-disk file of any size permitted            PASS (not in scope of the guard)
7. post-rejection decomposition into <=150-line parts succeeds        PASS
8. rejection includes target, line count, limit and suggested split   PASS

REGRESSION GUARD: bulk restore of a 600-line file permitted           PASS
```

61 connector tests passing, 0 failing. Every rejection is logged with target
and line count for auditing (spec section 12), and counted in `chunkStats`.

## Not in this release

Spec section 8 notes the write-then-verify guard (`verify_script_landing.py`) as
the second line of defence: re-read the file after a permitted write and confirm
line count before running a dependent builder. The hard block prevents bad
writes; verification catches silently-lost ones. That remains a protocol-level
practice rather than connector-enforced, since the connector cannot know which
writes have a dependency chain.
