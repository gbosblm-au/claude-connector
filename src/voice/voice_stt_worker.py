#!/usr/bin/env python3
"""src/voice/voice_stt_worker.py

Tenax Voice -- the resident speech-to-text worker.
PIPER-PRELOAD-v1.1 Section 6 (Change 3).

===========================================================================
WHY THIS EXISTS
===========================================================================

Section 2.2 of the diagnosis: the STT helper is spawned per request, and each
spawn constructs WhisperModel from scratch. On the base tier that is roughly
2 to 4 seconds of model load before a single sample of audio is looked at, paid
again on every utterance, for a result that is identical every time.

That is the LARGER of the two cold-start costs -- larger than Piper's -- and it
sits directly in the path a user feels most sharply, because they have just
finished speaking and are waiting to see their words.

This worker loads the model once and serves transcription over stdio.

===========================================================================
THE LICENCE BOUNDARY, FROM THE OTHER SIDE
===========================================================================

voice_stt.py carries a warning that it must never import piper, because it is
the MIT half of the boundary. THE SAME RULE APPLIES HERE, and it is now more
load-bearing rather than less:

    This worker imports faster_whisper (MIT).
    piper_worker.py imports piper (GPL-3.0-or-later).
    They must never be run by the same interpreter.

Both are supervised by the same Node module now (stdio-worker.js), which makes
the separation a matter of which interpreter is passed in rather than of which
file does the spawning. That is a real weakening of a structural guarantee, and
it is compensated for by asserting the separation explicitly in
src/tests/voice-gpl-boundary.test.js.

Concretely: this file runs on VOICE_PYTHON_BIN. piper_worker.py runs on
VOICE_KOKORO_PYTHON. Conflating them puts faster-whisper and the TTS engine
(which reaches GPL-3.0 espeak-ng through phonemizer) in one
site-packages, which is the entanglement the boundary exists to prevent.

===========================================================================
AUDIO IS EPHEMERAL, AND STAYS ON DISK (voice spec Section 10)
===========================================================================

The protocol passes a PATH, not bytes. That is not laziness -- it is the right
design for three reasons:

  1. A minute of audio is megabytes. Base64 through a pipe would inflate it by
     a third and copy it twice for no benefit, when the file is already on the
     same filesystem the worker can read.
  2. voice_stt.py already takes a path, so the two paths behave identically and
     cannot drift on how a file is opened.
  3. The CALLER owns the temporary directory and deletes it in a finally block.
     Passing bytes would make this worker a second place audio could linger.

This worker therefore reads the path it is given and writes nothing, and never
logs audio bytes, file contents or the transcript.

===========================================================================
RESIDENCY IS SEPARATELY CONFIGURABLE (Section 6, Section 10)
===========================================================================

"Because holding Whisper plus Piper resident simultaneously may exceed a small
instance's memory, STT residency is independently configurable
(VOICE_STT_WORKER_RESIDENT)."

There are therefore THREE states, not two, and the middle one is the point:

    worker off              per-request spawn. Pays process start, the
                            faster_whisper import, and the model load.

    worker on, resident off  the process stays alive; the model is released
                            after each request. Saves process start and the
                            import (~1-2s) and holds no model between requests.
                            This is the tight-memory setting.

    worker on, resident on   the model stays loaded. Saves everything. Costs
                            the model's resident footprint continuously.

Without the middle state, an operator on a small instance has to give up the
whole optimisation to control memory. With it, they give up only the part that
actually costs memory.
"""

import argparse
import json
import os
import sys
import time

# The same allowlist voice_stt.py uses, and for the same reason: this value
# reaches a loader that fetches by name from a remote registry, so an arbitrary
# name is an arbitrary fetch. Duplicated deliberately rather than imported --
# importing voice_stt.py would couple a long-lived process to a script written
# to run once and exit.
ALLOWED_MODELS = ("tiny", "base", "small", "medium", "large-v3")

PROTOCOL_VERSION = 1


def _stdout_line(obj):
    """Write one JSON line to stdout and flush it.

    The flush is not optional. Python buffers stdout when it is a pipe, which is
    what it is here, so without this the supervisor waits for a response sitting
    complete in a buffer on this side. That failure looks like a hung
    transcription and is invisible from both ends.
    """
    json.dump(obj, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message):
    """Diagnostics to stderr only.

    stdout is the protocol channel; a stray print there is a corrupt frame, not
    a log line. Never audio and never the transcript (voice spec Section 10).
    """
    sys.stderr.write("[voice_stt_worker] %s\n" % message)
    sys.stderr.flush()


class WorkerState(object):
    """The loaded model, and whether it is allowed to stay loaded."""

    def __init__(self, resident):
        self.model = None
        self.model_tier = None
        self.model_dir = None
        # See the module docstring: this is the middle of three states, and it
        # is what lets an operator keep the process warm while refusing to hold
        # a model.
        self.resident = bool(resident)
        self.whisper_cls = None
        self.version = None

    def ensure_imported(self):
        """Import faster_whisper once.

        Held across requests even when residency is off. The import itself costs
        a second or more (CTranslate2 pulls in a large native extension), and it
        allocates almost nothing that scales with the model -- so releasing it
        would give back no meaningful memory while paying the cost every time.
        """
        if self.whisper_cls is not None:
            return
        from faster_whisper import WhisperModel
        import faster_whisper
        self.whisper_cls = WhisperModel
        self.version = getattr(faster_whisper, "__version__", "unknown")

    def load(self, model_tier, model_dir):
        """Load a model, or return the one already loaded.

        :param model_tier: One of ALLOWED_MODELS.
        :param model_dir: Cache root, pinned to the Railway volume.
        :returns: A WhisperModel.
        """
        if (self.model is not None
                and self.model_tier == model_tier
                and self.model_dir == model_dir):
            return self.model

        self.ensure_imported()

        # A tier change releases the previous model before building the next.
        # Building first would hold BOTH in memory at the moment of transition,
        # which on a small instance is exactly when it cannot afford to.
        if self.model is not None:
            self.unload()

        started = time.time()
        # int8 on CPU per Section 4 Table 1, download_root pinned so a restart
        # does not re-download. Identical to voice_stt.py, on purpose.
        self.model = self.whisper_cls(
            model_tier,
            device="cpu",
            compute_type="int8",
            download_root=model_dir or None,
        )
        self.model_tier = model_tier
        self.model_dir = model_dir
        _log("loaded %s in %dms (resident=%s)"
             % (model_tier, int((time.time() - started) * 1000), self.resident))
        return self.model

    def unload(self):
        """Release the model.

        The reference is dropped and a collection is requested. CTranslate2
        holds its weights in a native allocation owned by the Python object, so
        dropping the last reference is what actually frees it -- but CPython
        will not necessarily run the collector promptly on a process that is
        about to sit idle, which is the precise moment the memory is wanted
        back. Hence the explicit collect.
        """
        if self.model is None:
            return False
        self.model = None
        self.model_tier = None
        self.model_dir = None
        try:
            import gc
            gc.collect()
        except Exception:  # noqa: BLE001 -- a failed collect must not end the worker
            pass
        return True


def _transcribe(state, request):
    """Transcribe one audio file.

    Mirrors voice_stt.py's transcribe() exactly in its faster-whisper call and
    its output shape, so the resident path and the per-request path cannot
    disagree about what a transcription looks like.

    :param state: WorkerState
    :param request: The parsed request object.
    :returns: The response object.
    """
    request_id = request.get("id")

    model_tier = request.get("model") or "base"
    if model_tier not in ALLOWED_MODELS:
        return {"id": request_id, "ok": False, "code": "unsupported_model",
                "error": "Unknown model tier %r. Allowed: %s"
                         % (model_tier, ", ".join(ALLOWED_MODELS))}

    path = request.get("path")
    if not path:
        return {"id": request_id, "ok": False, "code": "bad_request",
                "error": "transcribe requires path"}
    if not os.path.isfile(path):
        # The caller deletes its temporary directory in a finally block, so a
        # missing file here usually means a request that outlived its own
        # cleanup -- worth naming precisely rather than reporting as a generic
        # transcription failure.
        return {"id": request_id, "ok": False, "code": "audio_missing",
                "error": "Audio file not found."}

    language = request.get("language") or None

    try:
        model = state.load(model_tier, request.get("model_dir") or "")
    except Exception as err:  # noqa: BLE001
        return {"id": request_id, "ok": False, "code": "model_load_failed",
                "error": "Could not load the %s model: %s" % (model_tier, err)}

    started = time.time()
    try:
        segments, info = model.transcribe(
            path,
            language=language,
            beam_size=5,
            vad_filter=True,      # drops silence, which cuts real-time factor
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

        response = {
            "id": request_id,
            "ok": True,
            "text": " ".join(p for p in pieces if p).strip(),
            "language": getattr(info, "language", None) or language or "",
            "duration_seconds": round(float(getattr(info, "duration", 0.0)), 3),
            "segments": out_segments,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    except Exception as err:  # noqa: BLE001
        return {"id": request_id, "ok": False, "code": "stt_failed",
                "error": "Transcription failed: %s" % err}
    finally:
        # THE TIGHT-MEMORY PATH. Released inside the finally so a failed
        # transcription does not leave a model resident that the operator
        # explicitly asked not to hold.
        if not state.resident:
            state.unload()

    return response


def _handle(state, request):
    """Process one request and return the response.

    Every failure becomes a response with ok:false rather than an exception, so
    one bad request cannot end the worker and strand everything queued behind
    it. The supervisor restarts on a CRASH; a refusal is not a crash.
    """
    request_id = request.get("id")
    op = request.get("op") or "transcribe"

    if "ping" == op:
        return {"id": request_id, "ok": True, "op": "ping", "pid": os.getpid(),
                "model_loaded": state.model_tier, "resident": state.resident}

    if "unload" == op:
        freed = state.unload()
        return {"id": request_id, "ok": True, "op": "unload", "unloaded": freed}

    if "load" == op:
        tier = request.get("model") or "base"
        if tier not in ALLOWED_MODELS:
            return {"id": request_id, "ok": False, "code": "unsupported_model",
                    "error": "Unknown model tier %r" % tier}
        state.load(tier, request.get("model_dir") or "")
        return {"id": request_id, "ok": True, "op": "load", "model": tier}

    if "transcribe" != op:
        return {"id": request_id, "ok": False, "code": "unknown_op",
                "error": "unrecognised op: %s" % op}

    return _transcribe(state, request)


def serve(state):
    """Read requests from stdin until it closes.

    A closed stdin is the supervisor going away, and the correct response is to
    exit rather than to linger holding a model.
    """
    capabilities = {"resident": state.resident, "models": list(ALLOWED_MODELS)}
    try:
        state.ensure_imported()
        capabilities["faster_whisper"] = state.version
    except Exception as err:  # noqa: BLE001
        # Reported in the ready line rather than by exiting. The supervisor then
        # knows the worker is up but cannot transcribe, and routes to the
        # per-request path -- which will produce the same clear error from
        # voice_stt.py, in the place the caller already handles it.
        capabilities["import_error"] = "%s: %s" % (type(err).__name__, err)

    _stdout_line({"type": "ready", "protocol": PROTOCOL_VERSION,
                  "pid": os.getpid(), "capabilities": capabilities})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except ValueError as err:
            # No id, so this cannot be routed. Reported without one so the
            # supervisor can log it; the stream continues, because a malformed
            # line should cost one request rather than the worker.
            _stdout_line({"id": None, "ok": False, "code": "bad_request",
                          "error": "unparseable request line: %s" % err})
            continue

        if "shutdown" == request.get("op"):
            _stdout_line({"id": request.get("id"), "ok": True, "op": "shutdown"})
            return 0

        try:
            _stdout_line(_handle(state, request))
        except Exception as err:  # noqa: BLE001 -- deliberate catch-all
            # Deliberately broad. Anything escaping here would kill the worker
            # and every request queued behind this one; a failed request must
            # cost only itself.
            _stdout_line({"id": request.get("id"), "ok": False,
                          "code": "stt_failed",
                          "error": "%s: %s" % (type(err).__name__, err)})

    return 0


def probe(state, model_dir):
    """Report whether the engine is importable, without loading a model.

    Deliberately does NOT construct a WhisperModel, for the same reason
    voice_stt.py's probe does not: constructing one downloads several hundred
    megabytes on a cold cache, and a probe must stay cheap enough to run from a
    deploy script.
    """
    result = {"ok": False, "protocol": PROTOCOL_VERSION}
    try:
        state.ensure_imported()
        result["ok"] = True
        result["faster_whisper"] = state.version
        result["resident"] = state.resident
        result["model_dir"] = model_dir or ""
    except Exception as err:  # noqa: BLE001
        result["code"] = "stt_unavailable"
        result["error"] = "faster-whisper is not available: %s: %s" % (
            type(err).__name__, err)
    return result


def main():
    parser = argparse.ArgumentParser(description="Tenax resident speech-to-text worker")
    parser.add_argument("--probe", action="store_true",
                        help="report import health, then exit")
    parser.add_argument("--resident", default="true",
                        help="hold the model between requests (true/false)")
    parser.add_argument("--model", default="",
                        help="model tier to preload at start")
    parser.add_argument("--model-dir", default="",
                        help="model cache root")
    args = parser.parse_args()

    resident = str(args.resident).strip().lower() in ("1", "true", "yes")
    state = WorkerState(resident)

    if args.probe:
        result = probe(state, args.model_dir)
        _stdout_line(result)
        return 0 if result.get("ok") else 1

    if args.model:
        # Pre-warm. A failure here is reported and is NOT fatal: the worker can
        # still serve other tiers, and the supervisor's fallback covers the
        # rest. Exiting would turn a missing model into no transcription at all.
        #
        # Skipped when residency is off, because loading a model we have
        # promised to release after the next request is work with no beneficiary.
        if resident:
            try:
                state.load(args.model, args.model_dir or "")
            except Exception as err:  # noqa: BLE001
                _log("could not preload %s: %s" % (args.model, err))
        else:
            _log("residency off; skipping preload of %s" % args.model)

    return serve(state)


if __name__ == "__main__":
    sys.exit(main())
