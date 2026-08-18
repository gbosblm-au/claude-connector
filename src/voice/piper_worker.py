#!/usr/bin/env python3
"""src/voice/piper_worker.py

Tenax Voice -- the resident Piper TTS worker.
PIPER-PRELOAD-v1.1 Sections 4.1, 4.2.

===========================================================================
THE GPL BOUNDARY IS WHY THIS IS A FILE AND NOT A FUNCTION
===========================================================================

This module imports `piper`, which is GPL-3.0-or-later. That is allowed here
and nowhere else in this repository, because this file is never imported by
anything -- not by Node, which cannot import Python at all, and not by
voice_stt.py, which is MIT and must stay unentangled.

It is EXECUTED, as its own OS process, by the Piper virtual environment's own
interpreter, from the Piper directory. Communication is newline-delimited JSON
on stdin and stdout. There is no shared memory, no FFI, no dynamic linking, and
no shared import graph.

Two disciplines this file must never relax, both asserted by
src/tests/voice-gpl-boundary.test.js:

  1. Nothing in the Node source may `import` or `require` this file.
  2. This worker and voice_stt.py must never be run by the same interpreter.
     The STT helper is MIT and imports faster-whisper; putting the two in one
     site-packages is the beginning of exactly the entanglement the boundary
     exists to prevent.

===========================================================================
WHY A RESIDENT WORKER AT ALL (Section 2.1, Section 3)
===========================================================================

The CLI path spawns a fresh Piper for every utterance, and each spawn loads the
ONNX model from scratch. That is roughly 1 to 2.5 seconds of work repeated on
every single reply, and it is pure waste: the model is identical each time.

Loading once and holding it removes that cost entirely. What it costs in return
is resident memory, which is why VOICE_TTS_RESIDENT_VOICES exists and defaults
to 1: the footprint stays exactly what one CLI spawn already needed at its peak,
rather than growing with the number of voices anyone happens to request.

===========================================================================
WHY THE API IS DETECTED RATHER THAN ASSUMED (Section 4.1, Section 8 item 1)
===========================================================================

There are two incompatible generations of the Piper Python API in the wild:

  rhasspy/piper 1.2.x   voice.synthesize_stream_raw(text, length_scale=...)
                        yields int16 PCM bytes directly.

  OHF-Voice/piper1-gpl  voice.synthesize(text, syn_config=SynthesisConfig(
  1.3.0 and later       length_scale=...)) yields AudioChunk objects, and
                        synthesize_wav writes a wave file.

The connector pins piper-tts==1.2.0, so synthesize_stream_raw is the expected
path. But a redeploy that picks up a newer wheel must not turn into a silent
loss of voice, and the specification is explicit that "the version-specific
shape is absorbed inside the worker, not in the Node caller".

So the worker probes for each API in turn at load time, records which one it
bound to, and reports that in its ready line. The Node side never learns there
was a question. `--probe` prints the same information, which is what makes the
Section 8 smoke test a real gate rather than a hopeful one.
"""

import argparse
import base64
import io
import json
import os
import sys
import time
import wave
from collections import OrderedDict

# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------
#
# One JSON object per line, both directions. Line-delimited rather than
# length-prefixed because both sides already have line readers, and because a
# malformed frame then costs one request rather than desynchronising the stream
# forever.
#
# Request:   {"id": 1, "text": "...", "model_path": "...", "length_scale": 1.08}
# Success:   {"id": 1, "ok": true, "sample_rate": 22050, "pcm_b64": "..."}
# Failure:   {"id": 1, "ok": false, "code": "...", "error": "..."}
#
# Control requests carry "op": "ping" | "unload" | "shutdown" | "load".

PROTOCOL_VERSION = 1


def _stdout_line(obj):
    """Write one JSON line to stdout and flush it.

    The flush is not optional. Python buffers stdout when it is a pipe, which is
    exactly what it is here, so without this the supervisor waits for a response
    that is sitting complete in a buffer on this side. That failure looks like a
    hung synthesis and is invisible from both ends.
    """
    sys.stdout.write(json.dumps(obj, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message):
    """Diagnostics to stderr only.

    stdout is the protocol channel. A stray print there is not a log line, it is
    a corrupt frame, and the supervisor would try to parse it as a response.

    Never the text being synthesised (voice specification Section 10).
    """
    sys.stderr.write("[piper_worker] %s\n" % message)
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Piper API adaptation
# ---------------------------------------------------------------------------


def _import_piper():
    """Import PiperVoice, tolerating both package layouts.

    1.2.0 exposes it at `piper.voice`; some builds re-export it at `piper`.
    Section 4.1 names this uncertainty explicitly and defers it to the smoke
    test, so both are tried and the one that works is used.

    :returns: (PiperVoice, SynthesisConfig or None)
    :raises ImportError: when neither layout provides the class.
    """
    piper_voice = None
    synthesis_config = None

    try:
        import piper  # noqa: F401
        piper_voice = getattr(piper, "PiperVoice", None)
        synthesis_config = getattr(piper, "SynthesisConfig", None)
    except ImportError:
        pass

    if piper_voice is None:
        # The 1.2.0 layout. Imported second because the package-level export,
        # where it exists, is the documented entry point.
        from piper.voice import PiperVoice as _PV
        piper_voice = _PV

    if synthesis_config is None:
        try:
            from piper import SynthesisConfig as _SC
            synthesis_config = _SC
        except (ImportError, AttributeError):
            synthesis_config = None

    return piper_voice, synthesis_config


def _flatten_audio(result):
    """Reduce whatever a synthesis call returned to int16 little-endian bytes.

    The shapes seen across versions and call styles:

      - bytes / bytearray            -- already PCM (1.2.x stream API)
      - an iterable of the above     -- chunked PCM
      - an iterable of AudioChunk    -- 1.3+; each has .audio_int16_bytes
      - a numpy array of int16       -- some builds return the array directly
      - a numpy array of float32     -- normalised audio needing scaling

    Handled here rather than in the Node caller for the reason the
    specification gives: the caller should not have to know which Piper it is
    talking to. numpy is imported lazily and only if an array actually turns
    up, so the worker does not require it.

    :param result: The return value of a Piper synthesis call.
    :returns: bytes -- signed 16-bit little-endian mono PCM.
    """
    if isinstance(result, (bytes, bytearray)):
        return bytes(result)

    # A numpy array, without importing numpy unless we have one.
    if hasattr(result, "dtype") and hasattr(result, "tobytes"):
        return _array_to_pcm(result)

    chunks = []
    for item in result:
        if isinstance(item, (bytes, bytearray)):
            chunks.append(bytes(item))
            continue

        # 1.3+ AudioChunk. Preferred accessor first; the raw array is the
        # fallback for builds where the convenience property is absent.
        raw = getattr(item, "audio_int16_bytes", None)
        if isinstance(raw, (bytes, bytearray)):
            chunks.append(bytes(raw))
            continue

        array = getattr(item, "audio_int16_array", None)
        if array is None:
            array = getattr(item, "audio_float_array", None)
        if array is not None:
            chunks.append(_array_to_pcm(array))
            continue

        if hasattr(item, "dtype") and hasattr(item, "tobytes"):
            chunks.append(_array_to_pcm(item))
            continue

        raise TypeError("unrecognised audio chunk type: %s" % type(item).__name__)

    return b"".join(chunks)


def _array_to_pcm(array):
    """Convert a numpy array to int16 little-endian PCM bytes.

    Float arrays are clamped before scaling. Piper's normalised output can
    exceed +/-1.0, and letting that wrap around in the int16 cast produces a
    loud click that is audible as a consonant -- the same reason the browser
    side clamps in 39-voice-autosend.js.

    :param array: A numpy ndarray.
    :returns: bytes
    """
    import numpy as np

    data = np.asarray(array)
    if data.dtype == np.int16:
        return data.astype("<i2", copy=False).tobytes()

    if data.dtype.kind == "f":
        clipped = np.clip(data, -1.0, 1.0)
        return (clipped * 32767.0).astype("<i2").tobytes()

    return data.astype("<i2").tobytes()


class VoiceHandle(object):
    """One loaded voice, plus the synthesis adapter chosen for it."""

    def __init__(self, voice, sample_rate, adapter, synthesis_config_cls):
        self.voice = voice
        self.sample_rate = sample_rate
        self.adapter = adapter
        self.synthesis_config_cls = synthesis_config_cls
        self.loaded_at = time.time()

    def synthesize(self, text, length_scale):
        """Produce PCM for one unit of text.

        :param text: The words to speak.
        :param length_scale: Absolute Piper length_scale, or None for the
            voice's own configured default. INVERSE of rate: larger is slower.
        :returns: bytes -- signed 16-bit little-endian mono PCM.
        """
        if "stream_raw" == self.adapter:
            kwargs = {}
            if length_scale is not None:
                kwargs["length_scale"] = length_scale
            return _flatten_audio(self.voice.synthesize_stream_raw(text, **kwargs))

        if "syn_config" == self.adapter:
            syn_config = None
            if self.synthesis_config_cls is not None and length_scale is not None:
                syn_config = self.synthesis_config_cls(length_scale=length_scale)
            if syn_config is None:
                return _flatten_audio(self.voice.synthesize(text))
            return _flatten_audio(self.voice.synthesize(text, syn_config=syn_config))

        if "wav" == self.adapter:
            # Last resort: write a WAV into memory and strip the container.
            #
            # The header is DISCARDED rather than returned, because the Node
            # side wraps the concatenated PCM itself. Returning a WAV per phrase
            # would put a 44-byte header in the middle of every join, which is
            # heard as a burst of noise rather than as a header.
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as wav_file:
                kwargs = {}
                if self.synthesis_config_cls is not None and length_scale is not None:
                    kwargs["syn_config"] = self.synthesis_config_cls(length_scale=length_scale)
                self.voice.synthesize_wav(text, wav_file, **kwargs)
            buffer.seek(0)
            with wave.open(buffer, "rb") as wav_file:
                return wav_file.readframes(wav_file.getnframes())

        raise RuntimeError("no synthesis adapter bound")


class WorkerState(object):
    """The loaded voices, bounded by an LRU (Section 4.2)."""

    def __init__(self, resident_voices):
        self.piper_voice_cls = None
        self.synthesis_config_cls = None
        # OrderedDict as an LRU: move_to_end on use, popitem(last=False) to
        # evict. Bounded on purpose -- an unbounded cache on a shared instance
        # is a slow walk into the OOM killer described in describeFailure().
        self.voices = OrderedDict()
        self.resident_voices = max(1, int(resident_voices or 1))
        self.adapter = None

    def ensure_imported(self):
        if self.piper_voice_cls is None:
            self.piper_voice_cls, self.synthesis_config_cls = _import_piper()

    def _choose_adapter(self, voice):
        """Bind to whichever synthesis API this build of Piper offers.

        Order is deliberate. synthesize_stream_raw is the 1.2.x path and the
        pinned one, and it yields raw PCM with no container to unwrap, so it is
        both expected and cheapest. synthesize_wav is last because it is the
        only one that pays for a WAV encode and decode per phrase.
        """
        if hasattr(voice, "synthesize_stream_raw"):
            return "stream_raw"
        if hasattr(voice, "synthesize") and self.synthesis_config_cls is not None:
            return "syn_config"
        if hasattr(voice, "synthesize_wav"):
            return "wav"
        if hasattr(voice, "synthesize"):
            return "syn_config"
        raise RuntimeError("this build of piper exposes no recognised synthesis method")

    def load(self, model_path):
        """Load a voice, or return it if it is already resident.

        :param model_path: Absolute path to the .onnx model.
        :returns: VoiceHandle
        """
        if model_path in self.voices:
            self.voices.move_to_end(model_path)
            return self.voices[model_path]

        self.ensure_imported()

        if not os.path.isfile(model_path):
            raise FileNotFoundError("no voice model at %s" % model_path)

        started = time.time()
        voice = self.piper_voice_cls.load(model_path)
        adapter = self._choose_adapter(voice)
        self.adapter = adapter

        # The rate the voice was trained at, from the voice's own config object.
        # Not assumed to be 22050: a 16 kHz low-quality voice played at 22050 is
        # fast and high, and the Node side builds its WAV header from whatever
        # number comes back here.
        sample_rate = 22050
        config = getattr(voice, "config", None)
        if config is not None:
            candidate = getattr(config, "sample_rate", None)
            if isinstance(candidate, int) and 8000 <= candidate <= 48000:
                sample_rate = candidate

        handle = VoiceHandle(voice, sample_rate, adapter, self.synthesis_config_cls)
        self.voices[model_path] = handle
        self.voices.move_to_end(model_path)

        while len(self.voices) > self.resident_voices:
            evicted, _ = self.voices.popitem(last=False)
            _log("evicted %s (resident cap %d)" % (os.path.basename(evicted),
                                                   self.resident_voices))

        _log("loaded %s via %s in %dms (rate %d)" % (
            os.path.basename(model_path), adapter,
            int((time.time() - started) * 1000), sample_rate))
        return handle

    def unload_all(self):
        count = len(self.voices)
        self.voices.clear()
        return count


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------


def _handle(state, request):
    """Process one request object and return the response object.

    Every failure becomes a response with ok:false rather than an exception, so
    one bad request cannot end the worker and strand every request queued behind
    it. The supervisor restarts on a CRASH; a refusal is not a crash.
    """
    request_id = request.get("id")
    op = request.get("op") or "synthesize"

    if "ping" == op:
        return {"id": request_id, "ok": True, "op": "ping", "pid": os.getpid(),
                "voices_resident": len(state.voices)}

    if "unload" == op:
        freed = state.unload_all()
        return {"id": request_id, "ok": True, "op": "unload", "unloaded": freed}

    if "load" == op:
        model_path = request.get("model_path")
        if not model_path:
            return {"id": request_id, "ok": False, "code": "no_model_path",
                    "error": "load requires model_path"}
        handle = state.load(model_path)
        return {"id": request_id, "ok": True, "op": "load",
                "sample_rate": handle.sample_rate, "adapter": handle.adapter,
                # Surfaced under `capabilities` as well so the shared supervisor
                # (stdio-worker.js) can report the bound Piper API generation in
                # /voice/health without knowing anything about Piper.
                "capabilities": {"adapter": handle.adapter,
                                 "sample_rate": handle.sample_rate,
                                 "resident_voices": state.resident_voices}}

    if "synthesize" != op:
        return {"id": request_id, "ok": False, "code": "unknown_op",
                "error": "unrecognised op: %s" % op}

    text = request.get("text") or ""
    if not text.strip():
        return {"id": request_id, "ok": False, "code": "empty_text",
                "error": "no text to synthesise"}

    model_path = request.get("model_path")
    if not model_path:
        return {"id": request_id, "ok": False, "code": "no_model_path",
                "error": "synthesize requires model_path"}

    # length_scale is the primary control and is what the prosody layer varies
    # per phrase. `speed` is accepted as well, for parity with the CLI path's
    # own `--length_scale 1/speed`, and converted the same way so the two paths
    # cannot disagree about what a speed means.
    length_scale = request.get("length_scale")
    if length_scale is None:
        speed = request.get("speed")
        if isinstance(speed, (int, float)) and speed > 0:
            length_scale = 1.0 / float(speed)

    if length_scale is not None:
        try:
            length_scale = float(length_scale)
        except (TypeError, ValueError):
            return {"id": request_id, "ok": False, "code": "invalid_length_scale",
                    "error": "length_scale must be a number"}
        # Bounded here as well as on the Node side. This process takes input
        # from a pipe, and a value of zero or a million reaches onnxruntime as
        # a tensor scale, where the failure is an unhelpful crash rather than
        # a message.
        if not (0.1 <= length_scale <= 10.0):
            return {"id": request_id, "ok": False, "code": "invalid_length_scale",
                    "error": "length_scale must be between 0.1 and 10"}

    handle = state.load(model_path)
    started = time.time()
    pcm = handle.synthesize(text, length_scale)

    if not pcm:
        return {"id": request_id, "ok": False, "code": "no_audio",
                "error": "piper produced no audio for this text"}

    return {
        "id": request_id,
        "ok": True,
        "sample_rate": handle.sample_rate,
        "pcm_b64": base64.b64encode(pcm).decode("ascii"),
        "bytes": len(pcm),
        "elapsed_ms": int((time.time() - started) * 1000),
        "capabilities": {"adapter": handle.adapter,
                         "sample_rate": handle.sample_rate},
    }


def serve(state):
    """Read requests from stdin until it closes.

    A closed stdin is the supervisor going away, and the correct response is to
    exit rather than to linger holding a model.
    """
    # PROVE THE ENGINE IS IMPORTABLE BEFORE CLAIMING READY.
    #
    # This used to report ready the moment the process started, deferring the
    # import to the first request. The result in production was a log reading
    # "piper worker ready (pid=123)" followed immediately by ModuleNotFoundError
    # on every synthesis -- a worker advertising a capability it did not have,
    # and a supervisor with no reason to doubt it.
    #
    # Failing here instead makes the supervisor treat it as a failed START,
    # which is a state it already handles correctly: back off, stop retrying,
    # and let synthesis use the CLI path. One clear failure at startup beats an
    # unbounded series of 500s that each look like a synthesis bug.
    try:
        state.ensure_imported()
    except Exception as err:  # noqa: BLE001
        _log("cannot import piper: %s: %s" % (type(err).__name__, err))
        _stdout_line({"type": "fatal", "code": "piper_import_failed",
                      "error": "%s: %s" % (type(err).__name__, err)})
        return 1

    _stdout_line({"type": "ready", "protocol": PROTOCOL_VERSION, "pid": os.getpid(),
                  # The adapter is not known until a voice is loaded, so at this
                  # point capabilities carries only what is knowable. It is
                  # updated from later responses.
                  "capabilities": {"resident_voices": state.resident_voices,
                                   "adapter": state.adapter}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except ValueError as err:
            # No id to reply against, so this cannot be routed. Reported without
            # one so the supervisor can log it, and the stream continues: a
            # malformed line costs one request, not the worker.
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
            # cost only itself. The supervisor's restart path exists for real
            # crashes, which are the ones that do not reach this handler.
            _stdout_line({"id": request.get("id"), "ok": False,
                          "code": "synthesis_failed",
                          "error": "%s: %s" % (type(err).__name__, err)})

    return 0


def probe(state, model_path):
    """Answer the Section 8 smoke test.

    Reports, as one JSON object: whether piper imports, which class layout
    provided PiperVoice, which synthesis adapter was bound, and -- when a model
    path is given -- whether that model actually loads and produces audio.

    This is the hard gate the specification puts before any other work: it is
    the only thing that resolves the 1.2.0-versus-1.3.0 API question against the
    interpreter that will really run it, rather than against documentation.
    """
    result = {"ok": False, "protocol": PROTOCOL_VERSION}

    try:
        state.ensure_imported()
        result["import"] = "ok"
        result["synthesis_config"] = state.synthesis_config_cls is not None
    except Exception as err:  # noqa: BLE001
        result["error"] = "could not import piper: %s: %s" % (type(err).__name__, err)
        result["code"] = "piper_import_failed"
        return result

    if not model_path:
        # Import alone proves the venv is right, which is the cheaper half of
        # the gate and is worth being able to run on its own.
        result["ok"] = True
        result["note"] = "piper imported; pass --model to also load and synthesise"
        return result

    try:
        handle = state.load(model_path)
        result["adapter"] = handle.adapter
        result["sample_rate"] = handle.sample_rate

        started = time.time()
        pcm = handle.synthesize("Voice check.", None)
        result["synthesis_ms"] = int((time.time() - started) * 1000)
        result["pcm_bytes"] = len(pcm)
        # Audio, at the right width, or it is not a pass. A zero-length or
        # odd-length buffer means the adapter bound to something that does not
        # produce 16-bit PCM, which would have shipped as silence.
        result["ok"] = len(pcm) > 0 and 0 == len(pcm) % 2
        if not result["ok"]:
            result["code"] = "no_audio"
            result["error"] = "synthesis returned %d bytes" % len(pcm)
    except Exception as err:  # noqa: BLE001
        result["code"] = "load_or_synthesis_failed"
        result["error"] = "%s: %s" % (type(err).__name__, err)

    return result


def main():
    parser = argparse.ArgumentParser(description="Tenax resident Piper TTS worker")
    parser.add_argument("--probe", action="store_true",
                        help="report import, adapter and synthesis health, then exit")
    parser.add_argument("--model", default="",
                        help="voice model to preload (and to test under --probe)")
    parser.add_argument("--resident-voices", type=int, default=1,
                        help="how many voices to hold loaded before evicting LRU")
    args = parser.parse_args()

    state = WorkerState(args.resident_voices)

    if args.probe:
        result = probe(state, args.model)
        _stdout_line(result)
        return 0 if result.get("ok") else 1

    if args.model:
        # Pre-warm at start (Section 5). A failure here is reported and is NOT
        # fatal: the worker still serves other voices, and the supervisor's
        # fallback covers the rest. Exiting would turn a missing default voice
        # into no voice at all.
        try:
            state.load(args.model)
        except Exception as err:  # noqa: BLE001
            _log("could not preload %s: %s" % (args.model, err))

    return serve(state)


if __name__ == "__main__":
    sys.exit(main())
