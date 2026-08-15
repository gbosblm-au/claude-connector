#!/usr/bin/env python3
"""script_audit_register.py -- SPEC-AUDIT-REG-001

Installs and verifies the script invocation register on the Tenax scripts
volume, and provides the shared read/write contract the report generator uses.

  python3 script_audit_register.py install    place the hook, print the env to set
  python3 script_audit_register.py verify     confirm the hook fires end to end
  python3 script_audit_register.py status     window, line count, distinct scripts
  python3 script_audit_register.py record ... append a line by hand (fallback)

WHY A REGISTER AT ALL
---------------------
Previous cleanup attempts removed scripts that were still needed, because the
decisions were made from memory. 561 files is well past the point where anyone
can hold the dependency set in their head, and the failure mode of guessing
wrong is asymmetric: leaving clutter costs disk, removing a load-bearing script
breaks a tool nobody notices until a user hits it.

So this records evidence and decides nothing. The verdict is a human one taken
after the observation window, from the report, with quarantine as the action
rather than deletion.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
It does not delete, and it exposes no code path that could. The spec is
explicit -- "no script is deletable by the tooling" -- and the way to make that
true is for the capability not to exist here at all, rather than to be guarded.
Quarantine is a move, performed by the report tool, and the manifest it writes
is what makes a mistaken flag recoverable.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

DEFAULT_SCRIPTS_BASE = os.environ.get("TENAX_SCRIPTS_BASE") or "/data/skill/ava/scripts"
DEFAULT_REGISTER = os.environ.get("TENAX_AUDIT_REGISTER_PATH") or os.path.join(
    DEFAULT_SCRIPTS_BASE, "_audit", "register.jsonl"
)

# The record shape (spec: Register Schema). Kept here as the single definition
# so the hook, this tool and the report cannot disagree about field names.
FIELDS = (
    "script_path",
    "timestamp_utc",
    "caller",
    "tool_name",
    "exit_status",
    "session_id",
    "duration_ms",
)

CALLERS = ("registered_tool", "direct", "fallback", "other")


# ---------------------------------------------------------------------------
# Read/write contract
# ---------------------------------------------------------------------------

def append_record(register_path, record):
    """Append one record. Returns True on success.

    Append-only by construction: there is no update or rewrite path in this
    module, which is what makes "do not rewrite or compact it during the
    observation window" a property of the code rather than a rule someone has
    to remember.
    """
    try:
        os.makedirs(os.path.dirname(register_path), exist_ok=True)
        with open(register_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        return True
    except Exception as exc:  # pragma: no cover - filesystem failure
        print(f"[audit] could not append: {exc}", file=sys.stderr)
        return False


def read_records(register_path):
    """Yield every well-formed record, skipping corrupt lines.

    A truncated final line is expected rather than exceptional: the register is
    written by short-lived processes and one may be killed mid-write. Skipping
    it silently is correct -- the alternative is a report that refuses to run
    because of a single partial line, which would make the register useless at
    exactly the moment it matters.
    """
    if not os.path.exists(register_path):
        return
    with open(register_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if isinstance(rec, dict) and rec.get("script_path"):
                yield rec


def make_record(script_path, caller="direct", tool_name=None, exit_status=0,
                session_id=None, duration_ms=0):
    """Build a schema-conformant record."""
    return {
        "script_path": script_path,
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "caller": caller if caller in CALLERS else "other",
        "tool_name": tool_name,
        "exit_status": int(exit_status),
        "session_id": session_id,
        "duration_ms": int(duration_ms),
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_install(args):
    """Report what must be set for the hook to fire.

    This prints rather than mutates the environment, because the environment
    belongs to the connector deployment and a script that edited it would be
    changing configuration nobody asked it to change. The hook file itself is
    already on the volume beside this one.
    """
    base = args.scripts_base
    hook = os.path.join(base, "sitecustomize.py")

    print("SPEC-AUDIT-REG-001 -- register installation\n")
    print(f"  scripts base   : {base}")
    print(f"  hook file      : {hook}  {'[present]' if os.path.exists(hook) else '[MISSING]'}")
    print(f"  register path  : {args.register}\n")

    if not os.path.exists(hook):
        print("  The hook is missing. Copy sitecustomize.py to the scripts base.")
        return 1

    print("  Set these on the connector so spawned scripts inherit them:\n")
    print(f"    TENAX_AUDIT_REGISTER=true")
    print(f"    TENAX_AUDIT_REGISTER_PATH={args.register}")
    print(f"    TENAX_SCRIPTS_BASE={base}")
    print(f"    PYTHONPATH={base}   (so CPython finds sitecustomize)\n")
    print("  Then run:  python3 script_audit_register.py verify")
    return 0


def cmd_verify(args):
    """Prove the hook fires, end to end, on both a success and an error path.

    Runs a throwaway script rather than asserting on configuration, because
    every part of this can be configured correctly and still not work: a
    PYTHONPATH the interpreter does not see, a read-only register directory, a
    sitecustomize shadowed by another one earlier on the path. The only
    trustworthy check is a line appearing in the register.
    """
    base = args.scripts_base
    if not os.path.exists(os.path.join(base, "sitecustomize.py")):
        print("[audit] sitecustomize.py is not on the scripts base; run install first.", file=sys.stderr)
        return 1

    before = sum(1 for _ in read_records(args.register))

    env = dict(os.environ)
    env.update({
        "TENAX_AUDIT_REGISTER": "true",
        "TENAX_AUDIT_REGISTER_PATH": args.register,
        "TENAX_SCRIPTS_BASE": base,
        "TENAX_AUDIT_CALLER": "direct",
        "PYTHONPATH": base + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""),
    })

    results = []
    for name, body, expect_status in (
        ("_audit_verify_ok.py", "print('ok')\n", 0),
        # The error path matters more than the success one: the spec requires a
        # register line WITH a non-zero status even when the script raises, and
        # that is the case a naive implementation drops.
        ("_audit_verify_fail.py", "raise ValueError('deliberate')\n", 1),
    ):
        path = os.path.join(base, name)
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
            subprocess.run([sys.executable, path], env=env, capture_output=True, timeout=30)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        results.append((name, expect_status))

    after = list(read_records(args.register))
    written = len(after) - before

    print(f"[audit] register lines before={before} after={len(after)} written={written}")
    if written < 2:
        print("[audit] FAIL: expected 2 lines (one success, one error path).", file=sys.stderr)
        return 1

    recent = after[-2:]
    ok_line = next((r for r in recent if r["script_path"].endswith("_audit_verify_ok.py")), None)
    fail_line = next((r for r in recent if r["script_path"].endswith("_audit_verify_fail.py")), None)

    if not ok_line or ok_line["exit_status"] != 0:
        print("[audit] FAIL: success path did not record exit_status 0.", file=sys.stderr)
        return 1
    if not fail_line or fail_line["exit_status"] == 0:
        print("[audit] FAIL: error path did not record a non-zero exit status.", file=sys.stderr)
        return 1

    print("[audit] PASS: success and error paths both recorded.")
    return 0


def cmd_status(args):
    """Window, line count, distinct scripts."""
    records = list(read_records(args.register))
    if not records:
        print(f"[audit] register is empty or absent: {args.register}")
        return 0

    stamps = sorted(r.get("timestamp_utc", "") for r in records if r.get("timestamp_utc"))
    distinct = {r["script_path"] for r in records}
    callers = {}
    for r in records:
        callers[r.get("caller", "other")] = callers.get(r.get("caller", "other"), 0) + 1

    print(f"[audit] register   : {args.register}")
    print(f"[audit] lines      : {len(records)}")
    print(f"[audit] scripts    : {len(distinct)} distinct")
    if stamps:
        print(f"[audit] window     : {stamps[0]}  ->  {stamps[-1]}")
    print(f"[audit] callers    : " + ", ".join(f"{k}={v}" for k, v in sorted(callers.items())))
    return 0


def cmd_record(args):
    """Append a line by hand.

    The fallback for a caller that cannot inherit the hook -- a shell wrapper,
    a cron entry, a non-Python tool. Present so those invocations are visible
    in the register rather than looking like the script was never used, which
    is the misreading that gets a load-bearing script quarantined.
    """
    rec = make_record(
        args.script_path, caller=args.caller, tool_name=args.tool,
        exit_status=args.exit_status, session_id=args.session,
        duration_ms=args.duration_ms,
    )
    return 0 if append_record(args.register, rec) else 1


def main(argv=None):
    p = argparse.ArgumentParser(description="SPEC-AUDIT-REG-001 script invocation register")
    p.add_argument("--scripts-base", default=DEFAULT_SCRIPTS_BASE)
    p.add_argument("--register", default=DEFAULT_REGISTER)
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("install")
    sub.add_parser("verify")
    sub.add_parser("status")

    rec = sub.add_parser("record")
    rec.add_argument("script_path")
    rec.add_argument("--caller", default="direct", choices=list(CALLERS))
    rec.add_argument("--tool", default=None)
    rec.add_argument("--exit-status", type=int, default=0)
    rec.add_argument("--session", default=None)
    rec.add_argument("--duration-ms", type=int, default=0)

    args = p.parse_args(argv)
    handler = {
        "install": cmd_install, "verify": cmd_verify,
        "status": cmd_status, "record": cmd_record,
    }.get(args.cmd)

    if not handler:
        p.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
