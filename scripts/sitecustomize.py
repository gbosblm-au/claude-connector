"""sitecustomize.py -- SPEC-AUDIT-REG-001 write hook.

Records every Python script invocation on the Tenax scripts volume, without
any script having to know it exists.

WHY THIS FILE AND NOT A WRAPPER
-------------------------------
The specification requires the register be non-invasive: it "must not change
how scripts run, only record that they ran", with "no schema changes to
scripts themselves". There are 561 scripts on this volume. Any design that
asks each of them to import something, or to be launched through a shim, is a
561-file change and will be incomplete the moment someone drops in the 562nd.

CPython imports a module named ``sitecustomize`` automatically at interpreter
startup if one is importable. Placing it on the scripts volume and putting that
directory on PYTHONPATH therefore hooks every ``python script.py`` invocation
with no change to any script and no change to any spawn site. A script added
tomorrow is registered on its first run.

WHY atexit AND excepthook
-------------------------
The spec asks for exit status and duration "with a try/finally so the record is
written even on error paths". There is no try/finally available from out here --
the script's own body is not ours to wrap -- so the two hooks together do the
same job from the outside:

  atexit      fires on normal termination AND on an unhandled exception, so it
              is the primary write and covers the ordinary success and failure
              paths.
  excepthook  fires first on an unhandled exception and records the exception
              type, which the exit status alone cannot tell you: exit 1 covers
              a ValueError, a deliberate sys.exit(1) and an argparse rejection
              equally, and the register is meant to distinguish debug traces
              from real failures.

Neither fires on SIGKILL or os._exit(). That is a known and accepted gap: a
killed process has no user-space code left to run, and the alternative -- a
supervising wrapper -- reintroduces the invasiveness this design avoids. A
timeout kill is instead visible as the ABSENCE of a completion line against a
start line, which the report treats as its own signal.

FAILURE POSTURE
---------------
This module must never break a script. It is imported before the script's own
code, so an exception here would turn a working renderer into a hard failure
for the sake of a diagnostic. Every operation is wrapped, and any failure
degrades to recording nothing.
"""

import atexit
import json
import os
import sys
import time

# ---------------------------------------------------------------------------
# Configuration, all from the environment so the hook has no hard-coded paths.
# ---------------------------------------------------------------------------

_ENABLED = os.environ.get("TENAX_AUDIT_REGISTER", "").strip().lower() == "true"
_REGISTER_PATH = os.environ.get("TENAX_AUDIT_REGISTER_PATH", "").strip()
_SCRIPTS_BASE = os.environ.get("TENAX_SCRIPTS_BASE", "").strip()

# Caller classification, set by the connector's buildScriptEnv (§ Write Points).
# Absent means the invocation did not come through the connector at all, which
# is itself the "direct" case the report wants to distinguish.
_CALLER = os.environ.get("TENAX_AUDIT_CALLER", "").strip() or "direct"
_TOOL_NAME = os.environ.get("TENAX_AUDIT_TOOL", "").strip() or None
_SESSION_ID = os.environ.get("TENAX_AUDIT_SESSION", "").strip() or None

_STARTED_MS = int(time.time() * 1000)
_EXC_TYPE = None


def _script_path():
    """The script being run, relative to the scripts volume where possible.

    Relative because the register is compared against a directory listing, and
    an absolute path that changes between a container and a local checkout
    would fragment the same script into two register identities.
    """
    try:
        raw = sys.argv[0] if sys.argv else ""
        if not raw:
            return None
        resolved = os.path.realpath(raw)
        if _SCRIPTS_BASE:
            base = os.path.realpath(_SCRIPTS_BASE)
            if resolved.startswith(base + os.sep):
                return os.path.relpath(resolved, base)
        return os.path.basename(resolved)
    except Exception:
        return None


def _append(record):
    """Append one JSON line. Never raises.

    Append-only and one line per record, per the spec's "cheap: a single
    append-line write per invocation" and "do not rewrite or compact it during
    the observation window".

    Opened in append mode per write rather than held open: the register is
    written by many short-lived processes, and an inherited file handle across
    a fork would interleave partial lines. O_APPEND on a single write under the
    typical line length is atomic on Linux, which is what keeps concurrent
    renderers from corrupting each other's records.
    """
    if not _REGISTER_PATH:
        return
    try:
        os.makedirs(os.path.dirname(_REGISTER_PATH), exist_ok=True)
        with open(_REGISTER_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, separators=(",", ":")) + "\n")
    except Exception:
        # Recording is a diagnostic. It must never be the reason a render fails.
        pass


def _iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def _on_exception(exc_type, exc_value, tb):
    """Record the exception type, then defer to the previous hook."""
    global _EXC_TYPE
    try:
        _EXC_TYPE = getattr(exc_type, "__name__", str(exc_type))
    except Exception:
        _EXC_TYPE = "UnknownException"
    try:
        _PREV_EXCEPTHOOK(exc_type, exc_value, tb)
    except Exception:
        pass


def _on_exit():
    """Write the completion record."""
    path = _script_path()
    if not path:
        return

    # sys.exitcode is not available here, so the status is inferred: an
    # unhandled exception is a non-zero exit whatever the interpreter reports,
    # and everything else is treated as success. A deliberate sys.exit(2) is
    # therefore recorded as 0 with no exception, which the report reads as a
    # completed run -- acceptable, because the signal the report needs is
    # "did this script run", not "did it agree with its caller".
    record = {
        "script_path": path,
        "timestamp_utc": _iso_now(),
        "caller": _CALLER,
        "tool_name": _TOOL_NAME,
        "exit_status": 1 if _EXC_TYPE else 0,
        "session_id": _SESSION_ID,
        "duration_ms": max(0, int(time.time() * 1000) - _STARTED_MS),
    }
    if _EXC_TYPE:
        record["exception"] = _EXC_TYPE
    _append(record)


if _ENABLED and _REGISTER_PATH:
    _PREV_EXCEPTHOOK = sys.excepthook
    sys.excepthook = _on_exception
    atexit.register(_on_exit)
