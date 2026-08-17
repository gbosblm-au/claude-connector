#!/usr/bin/env python3
"""
src/voice/voice_stt.py

Tenax Voice -- speech-to-text helper. Specification Section 4.

WHY THIS IS A SUBPROCESS AND NOT A LIBRARY CALL
-----------------------------------------------
Specification Section 3 assumed the connector was a Python service, where
faster-whisper could be imported in-process because it is MIT-licensed. The
connector is Node.js, so nothing Python can be imported into it at all. This
helper is the boundary, invoked with an argv array by voice-engines.js exactly
as volume_snapshot.py is invoked by volume-snapshot.js.

THE GPL BOUNDARY (Section 6.2)
------------------------------
This file MUST NOT import piper, piper_tts, piper_phonemize or espeak-ng, and
must not exec the Piper binary. faster-whisper is MIT and may live here; Piper
is GPL-3.0 and runs in its own process, from its own directory, spawned
separately by Node.

Putting both engines in this one helper would collapse the boundary the
specification locks -- our MIT helper would share a process with GPL code. It is
asserted in tests/voice-gpl-boundary.test.js so the separation is verifiable in
CI, which Section 6.3 (compliance obligation 1) requires.

AUDIO IS EPHEMERAL (Section 10)
-------------------------------
This helper reads the path it is given and writes nothing. The caller owns the
temporary directory and removes it. Nothing here logs audio bytes, the file's
contents, or the transcript -- stdout carries the result to the parent and
stderr carries errors only.

I/O CONTRACT
------------
    --probe
        {"ok": true, "faster_whisper": "<version>", "models_cached": [...]}
    --transcribe <path> --model <tier> --model-dir <dir> [--language <iso639-1>]
        {"text", "language", "duration_seconds", "segments": [...]}
Errors: {"error": "<message>", "code": "<machine code>"} and a non-zero exit.
"""

import argparse
import json
import os
import sys

# Model tiers offered. Section 4 Table 1 lists base/small/medium; the default is
# NOT locked here because Section 14 makes the benchmark gate hard -- the tier is
# supplied by the caller, which reads it from VOICE_STT_TIER.
ALLOWED_MODELS = ("tiny", "base", "small", "medium", "large-v3")


def fail(message, code="stt_failed", status=1):
    """Report a structured error on stdout and exit non-zero."""
    json.dump({"error": str(message), "code": code}, sys.stdout)
    sys.stdout.flush()
    sys.exit(status)


def cached_models(model_dir):
    """
    Model tiers already present in the cache.

    Reported so /voice/health can answer models_loaded (Section 8.1) without the
    parent guessing, and so an operator can see whether a first request will pay
    the download cost.
    """
    if not model_dir or not os.path.isdir(model_dir):
        return []
    found = []
    try:
        for entry in sorted(os.listdir(model_dir)):
            for tier in ALLOWED_MODELS:
                if tier in entry and tier not in found:
                    found.append(tier)
    except OSError:
        return []
    return found


def probe(model_dir):
    """
    Report whether the engine is importable.

    Deliberately does NOT instantiate a model: constructing WhisperModel
    downloads several hundred megabytes on a cold cache, and /voice/health is
    called on every UI load. Section 7 wants lazy loading, so the probe answers
    "is the dependency installed" and nothing more.
    """
    try:
        import faster_whisper  # noqa: F401  (imported for its presence, not its API)
    except Exception as exc:                      # ImportError, or a broken CTranslate2 build
        fail("faster-whisper is not available: %s" % exc, code="stt_unavailable")

    version = getattr(faster_whisper, "__version__", "unknown")
    json.dump({
        "ok": True,
        "faster_whisper": version,
        "models_cached": cached_models(model_dir),
    }, sys.stdout)
    sys.stdout.flush()


def transcribe(path, model_tier, model_dir, language):
    if model_tier not in ALLOWED_MODELS:
        # An allowlist, not a passthrough. This value reaches a loader that will
        # fetch by name from a remote registry, and Section 15 pins downloads to
        # HuggingFace only -- an arbitrary name is an arbitrary fetch.
        fail("Unknown model tier %r. Allowed: %s" % (model_tier, ", ".join(ALLOWED_MODELS)),
             code="unsupported_model")

    if not os.path.isfile(path):
        fail("Audio file not found.", code="audio_missing")

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        fail("faster-whisper is not available: %s" % exc, code="stt_unavailable")

    try:
        # int8 on CPU, per Section 4 Table 1. download_root pins the cache to the
        # Railway volume so a restart does not re-download.
        model = WhisperModel(
            model_tier,
            device="cpu",
            compute_type="int8",
            download_root=model_dir or None,
        )
    except Exception as exc:
        fail("Could not load the %s model: %s" % (model_tier, exc), code="model_load_failed")

    try:
        # language=None lets Whisper detect it, which is what an omitted
        # language parameter should mean (Section 8.2 makes it optional).
        segments, info = model.transcribe(
            path,
            language=language or None,
            beam_size=5,
            vad_filter=True,          # drops silence, which cuts real-time factor
        )

        # segments is a generator; it must be drained before info is complete.
        out_segments = []
        pieces = []
        for seg in segments:
            text = (seg.text or "").strip()
            out_segments.append({
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": text,
            })
            pieces.append(text)

        json.dump({
            "text": " ".join(p for p in pieces if p).strip(),
            "language": getattr(info, "language", None) or language or "",
            "duration_seconds": round(float(getattr(info, "duration", 0.0)), 3),
            "segments": out_segments,
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.flush()

    except Exception as exc:
        fail("Transcription failed: %s" % exc, code="stt_failed")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--transcribe", metavar="PATH")
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--language", default="")
    args = parser.parse_args()

    if args.probe:
        probe(args.model_dir)
        return
    if args.transcribe:
        transcribe(args.transcribe, args.model, args.model_dir, args.language)
        return
    fail("Nothing to do: pass --probe or --transcribe.", code="bad_invocation", status=2)


if __name__ == "__main__":
    main()
