#!/usr/bin/env python3
"""scripts/verify-kokoro-artifacts.py

Build-time proof that the baked Kokoro artifacts actually load.

v13.2.0. Run once during `docker build`, in the venv that will run them at
runtime, and deleted afterwards.

WHY THIS IS A FILE AND NOT AN INLINE `python3 -c`. A multi-line `-c` inside a
Dockerfile depends on backslash continuations surviving Docker's line joining
and the shell's quoting intact. It works, until someone edits it and it silently
becomes a different program. A file has none of that ambiguity and can be linted.

WHY IT RUNS AT ALL. The import check before it proves `kokoro_onnx` RESOLVES.
It does not prove the WEIGHTS load: a truncated or corrupt ONNX passes a size
floor, imports nothing, and fails at first synthesis with an opaque protobuf
parse error -- in production, hours after the build that caused it.
"""

import sys

MODEL = "/opt/kokoro/models/kokoro-v1.0.onnx"
VOICES = "/opt/kokoro/models/voices-v1.0.bin"


def main():
    try:
        from kokoro_onnx import Kokoro
    except Exception as err:  # noqa: BLE001
        sys.stderr.write("FATAL: kokoro_onnx does not import: %s: %s\n"
                         % (type(err).__name__, err))
        return 1

    try:
        kokoro = Kokoro(MODEL, VOICES)
    except Exception as err:  # noqa: BLE001
        sys.stderr.write("FATAL: the baked artifacts do not load: %s: %s\n"
                         % (type(err).__name__, err))
        return 1

    # The bundle is the authority on which voices exist, and the registry is
    # reconciled against it at runtime. A bundle that loads but carries nothing
    # would leave every voice reporting unavailable, which is a mute platform
    # with a healthy-looking engine.
    try:
        voices = kokoro.get_voices()
        names = sorted(str(v) for v in (voices.keys() if isinstance(voices, dict) else voices))
    except Exception as err:  # noqa: BLE001
        sys.stderr.write("FATAL: the bundle loaded but its voices could not be "
                         "listed: %s: %s\n" % (type(err).__name__, err))
        return 1

    if not names:
        sys.stderr.write("FATAL: the voice bundle contains no voices.\n")
        return 1

    # The five this deployment offers. Checked HERE rather than only at runtime,
    # because a bundle version that dropped one of them should fail the build
    # rather than produce a Speak button that works for some voices and not
    # others -- which is far harder to diagnose than a red build.
    required = ["af_bella", "af_nicole", "af_heart", "bf_emma", "af_aoede"]
    missing = [v for v in required if v not in names]
    if missing:
        sys.stderr.write(
            "FATAL: the bundle is missing voices this deployment offers: %s\n"
            "       It contains %d voices. Check the bundle version matches "
            "src/voice/voice-registry.js.\n" % (", ".join(missing), len(names)))
        return 1

    sys.stdout.write("kokoro artifacts verified: %d voices in the bundle, "
                     "all %d offered voices present\n" % (len(names), len(required)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
