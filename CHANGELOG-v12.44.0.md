# v12.44.0 — Script audit register (SPEC-AUDIT-REG-001)

## New files

- `scripts/sitecustomize.py` — the write hook
- `scripts/script_audit_register.py` — installer, verifier and read/write contract
- `scripts/script_audit_report.py` — ranked backlog, quarantine and restore

## Why a register

Previous cleanup attempts removed scripts that were still needed, because the
decisions were made from memory. 561 files is well past the point where anyone
holds the dependency set in their head, and the failure is asymmetric: leaving
clutter costs disk, removing a load-bearing script breaks a tool nobody notices
until a user hits it.

## How it stays non-invasive across 561 files

CPython imports a module named `sitecustomize` automatically at interpreter
startup when its directory is on PYTHONPATH. Placing the hook on the scripts
volume therefore records every `python script.py` invocation with **no change
to any script and no change to any spawn site** — and a script added tomorrow
is registered on its first run.

The PYTHONPATH entry is injected by `buildScriptEnv()`, which is the single
environment builder every spawn site already uses (render-tools, homeworkTools,
nudgeTools, brain-scan, script-execute). One hook point covers all of them.

### Security

PYTHONPATH is a code-execution vector and
`src/tests/internal-config-custom-env.test.js` exists to prove a caller cannot
set it. That guard is untouched: the entry added here is SERVER-derived, from
the connector's own scripts base, and is applied before the caller-supplied
block which still refuses PYTHONPATH outright. The scripts base is already a
directory the connector executes from, so putting it on the import path grants
nothing that was not already granted. Verified: with the register enabled, a
caller-supplied `PYTHONPATH: /tmp/attacker` is still refused. 31/31 of the
existing security tests still pass.

The register is OFF unless `TENAX_AUDIT_REGISTER=true`; with it off, no audit
variable is injected and PYTHONPATH is untouched.

## Error paths

`atexit` plus `sys.excepthook`, because there is no try/finally available from
outside the script's own body. atexit covers normal and exception exits;
excepthook records the exception TYPE, which the exit status cannot give —
exit 1 covers a ValueError, a deliberate `sys.exit(1)` and an argparse
rejection equally, and the register is meant to tell debug traces from real
failures. Neither fires on SIGKILL; that gap is documented, and a timeout kill
shows as a start line with no completion line.

## Ranking is by confidence, not recency

Last-accessed alone would rank a monthly load-bearing script above a debug
script that ran twice last week. Order: never invoked → error-path only →
fallback-only → single invocation aged → direct-only. Tool-bound scripts are
never candidates at any frequency, because a registered tool is a contract with
callers the register cannot see.

## Nothing is deletable

There is no deletion primitive in the report tool at all — no `os.remove`, no
`rmtree`. Quarantine is `shutil.move` with a manifest entry carrying the
evidence, so a future reviewer is not left with the guesswork this register
replaces. Restore appends rather than rewrites, so a corrected flag stays
visible in the audit record. Quarantine is dry-run by default and **refuses
outright on an empty register**, since with no observation every script reads
as never-invoked and the tool would quarantine the whole volume.

## Verified against the real volume

Run against the 485-script backup: hook fired with zero script changes,
recorded both a success and a `ValueError` path with the exception type,
classified all five tiers correctly, protected the tool-bound renderers,
quarantined 483 candidates with manifests, and restored cleanly. The audit
machinery excluded itself.

## Tests

- `tests/script-audit-register.test.js`: 17 assertions, the largest block being
  the PYTHONPATH guard.
- Connector suites: 236 green plus the one pre-existing `CONNECTOR_URL` failure
  that reproduces on pristine v12.42.0.
