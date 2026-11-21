"""proc_guard_boot.py -- runtime layer of the connector's self-termination guard.

claude-connector v13.39.0, TENAX-2026-10-15-01 H-4.

script_execute runs every script as

    python3 <connector>/src/guards/proc_guard_boot.py <script.py> [args...]

This file is part of the connector image. It is never on the scripts volume,
so script_write cannot replace it. Before the script's first line runs it wraps
every Python entry point that can signal or launch a process:

    os.kill, os.killpg (and the same functions on the posix module)
    os.system, os.popen
    the os.exec* and os.spawn* families, os.posix_spawn, os.posix_spawnp
    subprocess.Popen (and so run, call, check_call, check_output)

A signal may go only to this process or to one of its own descendants. A
signal to the parent (the connector), to PID 1, to a process group, to every
process (-1), or to any other pid is refused. Launching a refused binary (kill,
pkill, killall, shutdown, systemctl, ...) or a shell string that carries one is
refused. A refusal raises PermissionError with the reason and writes one line
to stderr:

    [process-guard] REFUSED code=<code> reason=<reason>

which the connector turns into an audit entry. The list of refused binaries is
the same list as REFUSED_BINARIES in src/utils/processGuard.js; a test reads
both and fails when they differ.

The script then runs through runpy with sys.argv[0] set to its own path and
sys.path[0] to its own directory, exactly as `python script.py` would set them,
so the volume's sitecustomize audit hook records the script and not this file.

This is an interposition guard. Code that reaches the kernel without these
entry points (raw ctypes calls) is refused by the static inspection that runs
before the spawn; the residual is recorded in the connector's delivery.
"""

import os
import re
import runpy
import sys

REFUSED_BINARIES = (
    "kill", "pkill", "killall", "killall5", "skill", "snice", "pidof", "fuser",
    "shutdown", "reboot", "halt", "poweroff", "init", "telinit",
    "systemctl", "service", "supervisorctl", "pm2", "railway", "docker", "podman", "kubectl",
)

_STOP_WORDS = (
    "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "systemctl", "service",
    "supervisorctl", "pm2", "railway", "docker", "podman", "kubectl",
)

_COMMAND_TEXT = re.compile(
    r"(?:^|[\s;&|(`'\"/]|\$\()(?:sudo\s+)?(?:" + "|".join(re.escape(b) for b in REFUSED_BINARIES) + r")(?=\s|$|['\"`);&|])",
    re.IGNORECASE,
)
_NAME_DERIVED = re.compile(
    r"(?:\bpgrep\b[^\n|]*\|\s*xargs\s+kill\b|\bkill\b[^\n;]*\$\(\s*(?:pgrep|pidof)\b|\bxargs\s+kill\b)",
    re.IGNORECASE,
)

_SELF = os.getpid()
_PARENT = os.getppid()


def _refuse(code, reason):
    try:
        sys.stderr.write("[process-guard] REFUSED code=%s reason=%s\n" % (code, reason.replace("\n", " ")[:300]))
        sys.stderr.flush()
    except Exception:
        pass
    raise PermissionError("[process-guard] refused (%s): %s" % (code, reason))


def _ppid_of(pid):
    """Parent pid from /proc, or None when it cannot be read."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as fh:
            data = fh.read().decode("utf-8", "replace")
        # The command name is in parentheses and may itself contain spaces or
        # parentheses; the fields after the LAST ')' are fixed.
        rest = data[data.rindex(")") + 2:].split()
        return int(rest[1])
    except Exception:
        return None


_CHILDREN = set()


def _is_self_or_descendant(pid):
    if pid == _SELF:
        return True
    if pid in _CHILDREN:
        return True
    seen = 0
    cur = pid
    while cur and cur > 1 and seen < 64:
        parent = _ppid_of(cur)
        if parent is None:
            return False
        if parent == _SELF:
            return True
        cur = parent
        seen += 1
    return False


def _check_signal_target(pid, what):
    if not isinstance(pid, int):
        _refuse("host_kill", "%s with a non-integer target" % what)
    if pid <= 0:
        _refuse("host_kill", "%s(%d) signals a process group or every process, which includes the connector" % (what, pid))
    if pid == 1:
        _refuse("host_kill", "%s(1) signals PID 1, the container's init" % what)
    if pid == _PARENT:
        _refuse("host_kill", "%s(%d) signals the connector that runs this script" % (what, pid))
    if not _is_self_or_descendant(pid):
        _refuse("host_kill", "%s(%d) signals a process this script did not start" % (what, pid))


def _inspect_command(text):
    t = text if isinstance(text, str) else " ".join(str(a) for a in text)
    m = _NAME_DERIVED.search(t)
    if m:
        _refuse("name_derived_kill", "a kill derived from a process search (%s) signals processes by image name" % m.group(0).strip()[:60])
    m = _COMMAND_TEXT.search(t)
    if m:
        word = re.sub(r"^[\s;&|(`'\"/$]+|\(", "", m.group(0)).strip()
        word = re.sub(r"^sudo\s+", "", word, flags=re.IGNORECASE).lower()
        if word.startswith(_STOP_WORDS):
            _refuse("host_stop_restart", '"%s" stops or restarts the host or its platform' % word)
        _refuse("image_level_kill", '"%s" signals processes by image or pid outside this script\'s own children' % word)


def _inspect_exe(path, argv):
    exe = os.path.basename(str(path or "")).lower()
    if exe in REFUSED_BINARIES:
        code = "host_stop_restart" if exe in _STOP_WORDS else "image_level_kill"
        _refuse(code, '"%s" may not be launched by a script' % exe)
    if argv:
        args = [str(a) for a in argv]
        if exe in ("sh", "bash", "dash", "zsh", "ash", "ksh") and "-c" in args:
            i = args.index("-c")
            if i + 1 < len(args):
                _inspect_command(args[i + 1])


def _install():
    import signal
    import subprocess
    import posix

    real_kill = os.kill
    real_killpg = os.killpg
    real_system = os.system
    real_popen = os.popen

    def kill(pid, sig):
        _check_signal_target(pid, "os.kill")
        return real_kill(pid, sig)

    def killpg(pgid, sig):
        # A spawned script shares the connector's process group unless it made
        # its own. Signalling the shared group would signal the connector.
        try:
            parent_group = os.getpgid(_PARENT)
        except Exception:
            parent_group = None
        if pgid <= 0 or pgid == 1 or pgid == parent_group or not _is_self_or_descendant(pgid):
            _refuse("host_kill", "os.killpg(%s) signals a process group that includes the connector or processes this script did not start" % pgid)
        return real_killpg(pgid, sig)

    def system(command):
        _inspect_command(command)
        return real_system(command)

    def popen(cmd, *a, **k):
        _inspect_command(cmd)
        return real_popen(cmd, *a, **k)

    os.kill = kill
    os.killpg = killpg
    os.system = system
    os.popen = popen
    posix.kill = kill
    posix.killpg = killpg
    posix.system = system

    for name in ("execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe"):
        real = getattr(os, name, None)
        if real is None:
            continue

        def make(real_fn, fn_name):
            def wrapper(path, *args):
                argv = args[0] if args and isinstance(args[0], (list, tuple)) else list(args)
                _inspect_exe(path, argv)
                return real_fn(path, *args)
            wrapper.__name__ = fn_name
            return wrapper

        setattr(os, name, make(real, name))

    for name in ("spawnv", "spawnve", "spawnvp", "spawnvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe"):
        real = getattr(os, name, None)
        if real is None:
            continue

        def make_spawn(real_fn, fn_name):
            def wrapper(mode, path, *args):
                argv = args[0] if args and isinstance(args[0], (list, tuple)) else list(args)
                _inspect_exe(path, argv)
                pid = real_fn(mode, path, *args)
                if isinstance(pid, int) and pid > 0:
                    _CHILDREN.add(pid)
                return pid
            wrapper.__name__ = fn_name
            return wrapper

        setattr(os, name, make_spawn(real, name))

    for name in ("posix_spawn", "posix_spawnp"):
        real = getattr(os, name, None)
        if real is None:
            continue

        def make_ps(real_fn, fn_name):
            def wrapper(path, argv, *args, **kwargs):
                _inspect_exe(path, argv)
                pid = real_fn(path, argv, *args, **kwargs)
                _CHILDREN.add(pid)
                return pid
            wrapper.__name__ = fn_name
            return wrapper

        wrapped = make_ps(real, name)
        setattr(os, name, wrapped)
        if hasattr(posix, name):
            setattr(posix, name, wrapped)

    real_init = subprocess.Popen.__init__

    def popen_init(self, args, *a, **k):
        shell = k.get("shell", False) or (len(a) >= 8 and a[7])
        if isinstance(args, (str, bytes)):
            text = args.decode("utf-8", "replace") if isinstance(args, bytes) else args
            if shell:
                _inspect_command(text)
            else:
                _inspect_exe(text.split()[0] if text.split() else text, text.split())
        else:
            seq = [str(x) for x in args]
            executable = k.get("executable") or (seq[0] if seq else "")
            _inspect_exe(executable, seq)
            if shell:
                _inspect_command(" ".join(seq))
        real_init(self, args, *a, **k)
        try:
            _CHILDREN.add(self.pid)
        except Exception:
            pass

    subprocess.Popen.__init__ = popen_init

    # signal.pthread_kill and signal.raise_signal can only reach this process's
    # own threads, so they are left as they are.
    del signal


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("proc_guard_boot.py: usage: proc_guard_boot.py <script.py> [args...]\n")
        sys.exit(2)
    script = os.path.abspath(sys.argv[1])
    _install()
    sys.argv = [script] + sys.argv[2:]
    sys.path[0] = os.path.dirname(script)
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
