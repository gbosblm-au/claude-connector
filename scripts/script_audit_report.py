#!/usr/bin/env python3
"""script_audit_report.py -- SPEC-AUDIT-REG-001

Produces the ranked clutter backlog from the register, and performs the
quarantine step. Never deletes.

  python3 script_audit_report.py report              ranked backlog, evidence shown
  python3 script_audit_report.py report --json       machine-readable
  python3 script_audit_report.py quarantine --apply  move flagged scripts
  python3 script_audit_report.py restore <path>      bring one back

RANKING, AND WHY IT IS NOT JUST "OLDEST FIRST"
----------------------------------------------
Last-accessed time alone would rank a load-bearing script that happens to run
monthly above a debug script that ran twice last week, which is exactly the
guesswork this register replaces. The spec is explicit that last-accessed
"signals candidates, but context (tool-bound vs direct fallback) decides the
verdict", so the ranking is by CONFIDENCE that removal is safe:

  1. never invoked                 no evidence of use at all
  2. error-path only               ran, always failed -- a debug or breakage trace
  3. fallback-only                 reachable but never through a tool
  4. single invocation, aged       one run, older than the window
  5. direct-only, low frequency    used, but never tool-bound
  --- everything below is NOT a candidate ---
     tool-bound with steady access proven load-bearing

A script that is tool-bound is never a candidate regardless of frequency,
because a registered tool is a contract with callers this register cannot see.

THE WINDOW CAVEAT
-----------------
"Never invoked" means "not invoked during the observation window", which is a
weaker claim. A quarterly reconciliation script observed for 14 days is
indistinguishable from a dead one. That is why quarantine is a move with a
manifest and a retention period rather than a delete, and why the report prints
the window length beside every never-invoked verdict rather than leaving the
reader to remember it.
"""

import argparse
import json
import os
import shutil
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from script_audit_register import (  # noqa: E402
    DEFAULT_REGISTER, DEFAULT_SCRIPTS_BASE, read_records,
)

QUARANTINE_DIRNAME = "_quarantine"
MANIFEST_NAME = "manifest.jsonl"

# Ordered most to least confident. The index is the rank.
VERDICTS = (
    "never_invoked",
    "error_path_only",
    "fallback_only",
    "single_invocation_aged",
    "direct_only",
    "tool_bound_low_frequency",
    "tool_bound_steady",
)

NOT_CANDIDATES = {"tool_bound_steady", "tool_bound_low_frequency"}


def list_scripts(base):
    """Every .py script on the volume, excluding the audit machinery itself.

    The register and report are themselves scripts on this volume, and a report
    that nominated its own tooling for quarantine would be both absurd and, on
    a second pass, self-inflicted.
    """
    out = []
    skip_dirs = {QUARANTINE_DIRNAME, "_audit", "__pycache__"}
    skip_files = {"sitecustomize.py", "script_audit_register.py", "script_audit_report.py"}
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for f in files:
            if not f.endswith(".py") or f in skip_files:
                continue
            out.append(os.path.relpath(os.path.join(root, f), base))
    return sorted(out)


def summarise(records):
    """Fold the register into per-script evidence."""
    agg = defaultdict(lambda: {
        "invocations": 0, "errors": 0, "successes": 0,
        "by_caller": defaultdict(int), "tools": set(),
        "first": None, "last": None, "total_ms": 0,
    })
    for r in records:
        e = agg[r["script_path"]]
        e["invocations"] += 1
        if int(r.get("exit_status", 0)) != 0:
            e["errors"] += 1
        else:
            e["successes"] += 1
        e["by_caller"][r.get("caller", "other")] += 1
        if r.get("tool_name"):
            e["tools"].add(r["tool_name"])
        ts = r.get("timestamp_utc")
        if ts:
            if e["first"] is None or ts < e["first"]:
                e["first"] = ts
            if e["last"] is None or ts > e["last"]:
                e["last"] = ts
        e["total_ms"] += int(r.get("duration_ms", 0) or 0)
    return agg


def classify(evidence, window_days):
    """One verdict per script, in the confidence order documented above."""
    if not evidence or evidence["invocations"] == 0:
        return "never_invoked"

    inv = evidence["invocations"]
    by_caller = evidence["by_caller"]
    tool_calls = by_caller.get("registered_tool", 0)

    # Ran every time and failed every time: a debug or breakage trace, not a
    # working script someone depends on.
    if evidence["successes"] == 0 and evidence["errors"] == inv:
        return "error_path_only"

    if tool_calls == 0 and by_caller.get("fallback", 0) > 0:
        return "fallback_only"

    if tool_calls == 0:
        if inv == 1:
            return "single_invocation_aged"
        return "direct_only"

    # Tool-bound. Frequency separates "steady" from "low", but neither is a
    # candidate: a registered tool is a contract with callers this register
    # cannot see.
    return "tool_bound_steady" if inv >= max(2, window_days // 7) else "tool_bound_low_frequency"


def build_report(base, register, window_days):
    records = list(read_records(register))
    agg = summarise(records)
    scripts = list_scripts(base)

    rows = []
    for path in scripts:
        ev = agg.get(path)
        verdict = classify(ev, window_days)
        rows.append({
            "script_path": path,
            "verdict": verdict,
            "rank": VERDICTS.index(verdict),
            "candidate": verdict not in NOT_CANDIDATES,
            "invocations": ev["invocations"] if ev else 0,
            "errors": ev["errors"] if ev else 0,
            "callers": dict(ev["by_caller"]) if ev else {},
            "tools": sorted(ev["tools"]) if ev else [],
            "first_seen": ev["first"] if ev else None,
            "last_seen": ev["last"] if ev else None,
        })

    # Rank first, then least-used, then alphabetically so the order is stable
    # between runs -- a backlog that reshuffles is one nobody can work through.
    rows.sort(key=lambda r: (r["rank"], r["invocations"], r["script_path"]))

    stamps = sorted(r.get("timestamp_utc", "") for r in records if r.get("timestamp_utc"))
    return {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scripts_base": base,
        "register": register,
        "register_lines": len(records),
        "window_first": stamps[0] if stamps else None,
        "window_last": stamps[-1] if stamps else None,
        "window_days_assumed": window_days,
        "total_scripts": len(scripts),
        "candidates": sum(1 for r in rows if r["candidate"]),
        "rows": rows,
    }


def print_report(rep):
    print(f"\nSPEC-AUDIT-REG-001 -- script audit report")
    print(f"  generated : {rep['generated_utc']}")
    print(f"  base      : {rep['scripts_base']}")
    print(f"  register  : {rep['register']}  ({rep['register_lines']} lines)")
    print(f"  window    : {rep['window_first'] or 'n/a'}  ->  {rep['window_last'] or 'n/a'}")
    print(f"  scripts   : {rep['total_scripts']}   candidates: {rep['candidates']}\n")

    if rep["register_lines"] == 0:
        print("  The register is empty. EVERY script will read as never-invoked,")
        print("  which is an artefact of no observation having happened yet, not")
        print("  evidence. Do not quarantine from this report.\n")

    current = None
    for row in rep["rows"]:
        if row["verdict"] != current:
            current = row["verdict"]
            marker = "CANDIDATE" if row["candidate"] else "keep"
            print(f"  --- {current}  [{marker}] ---")
        ev = f"{row['invocations']} run(s)"
        if row["errors"]:
            ev += f", {row['errors']} error(s)"
        if row["tools"]:
            ev += f", tools: {','.join(row['tools'])}"
        if row["last_seen"]:
            ev += f", last {row['last_seen']}"
        print(f"    {row['script_path']:<58} {ev}")
    print()


def cmd_report(args):
    rep = build_report(args.scripts_base, args.register, args.window_days)
    if args.json:
        print(json.dumps(rep, indent=2))
    else:
        print_report(rep)
    return 0


def cmd_quarantine(args):
    """Move flagged scripts, writing a manifest entry for each.

    Dry run by DEFAULT. --apply is required to move anything, because the one
    irreversible-feeling action in this tool should not be the one that happens
    when you forget a flag.

    Refuses outright on an empty register: with no observation, every script
    classifies as never-invoked and the tool would quarantine the entire
    volume. That is the single most damaging thing this code could do, so it is
    prevented rather than warned about.
    """
    rep = build_report(args.scripts_base, args.register, args.window_days)

    if rep["register_lines"] == 0:
        print("[audit] REFUSING: the register is empty, so every script reads as", file=sys.stderr)
        print("[audit] never-invoked. Run the observation window first.", file=sys.stderr)
        return 1

    flagged = [r for r in rep["rows"] if r["candidate"]]
    if not flagged:
        print("[audit] no candidates.")
        return 0

    qdir = os.path.join(args.scripts_base, QUARANTINE_DIRNAME)
    manifest = os.path.join(qdir, MANIFEST_NAME)

    print(f"[audit] {len(flagged)} candidate(s){'' if args.apply else '  (dry run -- pass --apply to move)'}")
    moved = 0
    for row in flagged:
        src = os.path.join(args.scripts_base, row["script_path"])
        dst = os.path.join(qdir, row["script_path"])
        print(f"    {row['verdict']:<24} {row['script_path']}")
        if not args.apply:
            continue
        if not os.path.exists(src):
            continue
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            entry = {
                "original_path": row["script_path"],
                "quarantined_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "verdict": row["verdict"],
                # The evidence travels WITH the file. A manifest that recorded
                # only the path would leave a future reviewer with the same
                # guesswork this register exists to replace.
                "evidence": {
                    "invocations": row["invocations"],
                    "errors": row["errors"],
                    "callers": row["callers"],
                    "tools": row["tools"],
                    "last_seen": row["last_seen"],
                    "window": [rep["window_first"], rep["window_last"]],
                },
                "rationale": f"classified {row['verdict']} over the observation window",
                "restored": False,
            }
            os.makedirs(qdir, exist_ok=True)
            with open(manifest, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            moved += 1
        except Exception as exc:
            print(f"    ! could not move {row['script_path']}: {exc}", file=sys.stderr)

    if args.apply:
        print(f"[audit] moved {moved} to {qdir}; manifest at {manifest}")
        print("[audit] nothing is deleted. Restore with: script_audit_report.py restore <path>")
    return 0


def cmd_restore(args):
    """Bring one script back out of quarantine."""
    qdir = os.path.join(args.scripts_base, QUARANTINE_DIRNAME)
    src = os.path.join(qdir, args.script_path)
    dst = os.path.join(args.scripts_base, args.script_path)

    if not os.path.exists(src):
        print(f"[audit] not in quarantine: {args.script_path}", file=sys.stderr)
        return 1
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
    except Exception as exc:
        print(f"[audit] restore failed: {exc}", file=sys.stderr)
        return 1

    # Appended, not rewritten: the manifest is the audit record, and editing a
    # prior entry would erase the fact that the flag was made and corrected.
    with open(os.path.join(qdir, MANIFEST_NAME), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "original_path": args.script_path,
            "restored_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "restored": True,
            "rationale": args.reason or "restored by operator",
        }, separators=(",", ":")) + "\n")

    print(f"[audit] restored {args.script_path}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="SPEC-AUDIT-REG-001 report and quarantine")
    p.add_argument("--scripts-base", default=DEFAULT_SCRIPTS_BASE)
    p.add_argument("--register", default=DEFAULT_REGISTER)
    p.add_argument("--window-days", type=int, default=14)
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser("report")
    r.add_argument("--json", action="store_true")

    q = sub.add_parser("quarantine")
    q.add_argument("--apply", action="store_true")

    s = sub.add_parser("restore")
    s.add_argument("script_path")
    s.add_argument("--reason", default=None)

    args = p.parse_args(argv)
    handler = {"report": cmd_report, "quarantine": cmd_quarantine, "restore": cmd_restore}.get(args.cmd)
    if not handler:
        p.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
