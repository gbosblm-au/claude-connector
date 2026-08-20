#!/usr/bin/env python3
"""src/voice/kokoro_worker.py

Tenax Voice -- the resident Kokoro-82M TTS worker.
SPEC-KOKORO-001 v1.1, Section 7.2 (Persistent worker).

===========================================================================
WHY THIS IS A STDIO WORKER AND NOT THE FastAPI SERVICE SECTION 7.2 DESCRIBES
===========================================================================

Section 7.2 specifies "a persistent FastAPI worker". The requirement it is
really expressing is "hold the model in memory so the load cost is paid once",
and this file does that. What it does NOT do is open a port.

A FastAPI worker would mean a new listening socket, a new authentication surface
in front of it, a new health check, and a second way into the synthesis path
that has to be secured to the same standard as the first. The connector already
has a proven newline-delimited-JSON-over-stdio supervisor -- the one Piper used,
with backoff, restart, request routing and a hard boundary on the child's
environment. Reusing it costs nothing and inherits all of that.

The trade-off is honest and worth stating: stdio is one request at a time per
worker, where an HTTP worker could serve several. That is the right shape here
because synthesis is CPU-bound and the platform decision is a CPU budget, so
concurrency would contend rather than parallelise. If a GPU budget is approved
later, this decision should be revisited -- an HTTP worker with a batch queue is
the correct shape for a GPU.

===========================================================================
THE PROCESS BOUNDARY DID NOT GO AWAY WITH PIPER
===========================================================================

Piper was GPL-3.0, and that is why this worker's predecessor ran as its own
process with a minimal environment. Kokoro is Apache-2.0, so it is tempting to
conclude the boundary is no longer needed.

It is. kokoro-onnx phonemises through `phonemizer`, which drives espeak-ng, and
ESPEAK-NG IS GPL-3.0. The GPL dependency moved from the model to the
phonemiser; it did not disappear. The same disciplines therefore still apply,
and src/tests/voice-gpl-boundary.test.js still enforces them:

  1. Nothing in the Node source may import or require this file.
  2. This worker and voice_stt.py must never share an interpreter. The STT
     helper is MIT and imports faster-whisper; one site-packages holding both is
     the start of the entanglement the boundary exists to prevent.

Choosing the misaki G2P with its espeak fallback disabled would avoid the GPL
dependency entirely. That is a licensing option, not a default -- misaki without
a fallback cannot phonemise out-of-dictionary words, so it trades a licence
question for a pronunciation one.

===========================================================================
WHY THE VOICE IS A PER-REQUEST PARAMETER
===========================================================================

Section 10 states that "Kokoro locks voices at model load, so rapid switching
between assistants mid-conversation requires a bundle reload", and treats that as
a documented limitation.

That is not true of kokoro-onnx. `Kokoro.create()` takes `voice=` per call: the
bundle of style vectors is loaded once with the model, and selecting a voice is
an array lookup, not a load. Switching per utterance is free.

So there is no bundle-reload machinery here, and no per-voice residency cap of
the kind the Piper worker needed. One model, one bundle, every voice available at
all times. The limitation Section 10 documents does not exist, which makes
per-tenant and per-assistant selection considerably simpler than specified.
"""

import base64
import json
import os
import sys
import time

PROTOCOL_VERSION = 1

# Kokoro's native output rate. A property of the model, not a setting.
NATIVE_SAMPLE_RATE = 24_000

# Output rates an admin may select. Anything else is refused rather than
# resampled through an untested ratio.
SUPPORTED_OUTPUT_RATES = (24_000, 16_000)

# Bounds on length_scale, mirrored from the Node side. This process reads from a
# pipe, and an out-of-range value reaches onnxruntime as a tensor scale where the
# failure is an unhelpful crash rather than a message.
MIN_LENGTH_SCALE = 0.1
MAX_LENGTH_SCALE = 10.0


def _log(message):
    """Diagnostics go to stderr. stdout is the protocol channel and nothing else.

    A stray print() to stdout would be parsed by the supervisor as a response
    line and desynchronise every request after it.
    """
    sys.stderr.write("[kokoro-worker] %s\n" % message)
    sys.stderr.flush()


def _stdout_line(obj):
    """Write one protocol frame."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ===========================================================================
# Resampling
# ===========================================================================

def _resample(samples, np, from_rate, to_rate):
    """Resample float32 audio between two supported rates.

    ── Why this is not a naive decimation ────────────────────────────────────

    24 kHz to 16 kHz is a ratio of 2/3. Dropping every third sample would alias
    everything above 8 kHz back down into the speech band as a metallic buzz --
    audible, and worst on exactly the sibilants that carry intelligibility. A
    band-limiting filter before decimation is not optional.

    scipy.signal.resample_poly is the correct tool: a polyphase FIR that filters
    and decimates in one pass, with a well-tested filter design. It is used when
    available.

    The fallback is a windowed-sinc polyphase implementation in pure numpy, for
    the case where scipy is not installed. It is a real implementation, not a
    placeholder -- but it is the second choice, because scipy's is the one with
    a decade of other people's testing behind it.

    Returns (samples, actual_rate). If neither path is available the ORIGINAL
    audio and rate come back: shipping 24 kHz when 16 kHz was asked for is a
    configuration mismatch an operator can see in the response, whereas shipping
    aliased audio is a quality regression they would have to hear to find.
    """
    if from_rate == to_rate:
        return samples, to_rate

    # Reduce the ratio so the filter is designed for the smallest L and M that
    # express it. For 24k -> 16k this is 2/3.
    from math import gcd
    divisor = gcd(int(from_rate), int(to_rate))
    up = int(to_rate) // divisor
    down = int(from_rate) // divisor

    try:
        from scipy.signal import resample_poly
        return resample_poly(samples, up, down).astype(np.float32), to_rate
    except ImportError:
        pass

    try:
        return _resample_poly_numpy(samples, np, up, down), to_rate
    except Exception as err:  # noqa: BLE001
        _log("resample failed (%s: %s); returning native %d Hz"
             % (type(err).__name__, err, from_rate))
        return samples, from_rate


def _resample_poly_numpy(samples, np, up, down):
    """Windowed-sinc polyphase resampler, numpy only.

    Upsample by `up`, low-pass, decimate by `down`, computed in the polyphase
    form so only the samples that survive decimation are ever calculated.

    The cutoff is 1/max(up, down) of the upsampled Nyquist, which is the
    standard choice: it band-limits below BOTH the original Nyquist and the
    target Nyquist, so the filter is correct whether the operation is an
    interpolation, a decimation, or -- as here -- both.
    """
    samples = np.asarray(samples, dtype=np.float64).ravel()
    if samples.size == 0:
        return samples.astype(np.float32)

    # 16 taps per output sample either side is a conventional quality/cost
    # trade-off for speech; a Kaiser window with beta 8.6 gives roughly -80 dB
    # stopband, which is well below the noise floor of any TTS output.
    half = 16 * max(up, down)
    taps = 2 * half + 1
    n = np.arange(taps) - half
    cutoff = 1.0 / max(up, down)

    # np.sinc(x) is sin(pi x)/(pi x), so the argument is already normalised.
    h = cutoff * np.sinc(cutoff * n) * np.kaiser(taps, 8.6)
    h = h * up  # restore the gain lost to zero-insertion

    upsampled = np.zeros(samples.size * up, dtype=np.float64)
    upsampled[::up] = samples

    filtered = np.convolve(upsampled, h, mode="same")
    return filtered[::down].astype(np.float32)


def _to_int16_pcm(samples, np):
    """Convert float audio in [-1, 1] to signed 16-bit little-endian PCM.

    Clipped rather than scaled. A resampler's transient overshoot can push a few
    samples past unity, and normalising the whole utterance to accommodate them
    would make its loudness depend on its worst sample -- so consecutive phrases
    of one reply would arrive at different volumes.
    """
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


# ===========================================================================
# Engine state
# ===========================================================================

class State(object):
    """Holds the model, the voice bundle, and the chosen G2P."""

    def __init__(self, model_path, voices_path, g2p_mode):
        self.model_path = model_path
        self.voices_path = voices_path
        self.g2p_mode = g2p_mode
        self.kokoro = None
        self.np = None
        self.g2p = None
        self.voices = []
        self.loaded_at = None

    def ensure_imported(self):
        """Import numpy and kokoro_onnx, and construct the engine.

        Called at STARTUP, before the ready frame, deliberately.

        The Piper worker learned this the hard way: it reported ready the moment
        the process started and deferred the import to the first request, which
        produced a log reading "worker ready" followed by ModuleNotFoundError on
        every synthesis -- a worker advertising a capability it did not have.
        Failing here instead makes the supervisor treat it as a failed start,
        which it already handles: back off, stop retrying, report the reason.
        """
        if self.kokoro is not None:
            return

        import numpy
        self.np = numpy

        from kokoro_onnx import Kokoro

        if not self.model_path or not os.path.exists(self.model_path):
            raise RuntimeError("model not found at %s" % self.model_path)
        if not self.voices_path or not os.path.exists(self.voices_path):
            raise RuntimeError("voice bundle not found at %s" % self.voices_path)

        started = time.time()
        self.kokoro = Kokoro(self.model_path, self.voices_path)
        self.loaded_at = time.time()
        _log("model loaded in %dms" % int((self.loaded_at - started) * 1000))

        self.voices = self._read_voice_names()

        if "misaki" == self.g2p_mode:
            self._init_misaki()

    def _read_voice_names(self):
        """List the voices the bundle actually contains.

        THE BUNDLE IS THE ONLY AUTHORITY on which voices exist, and the Node side
        reconciles its configured registry against this list. Offering a voice
        the bundle lacks produces a Speak button that fails at synthesis;
        reporting it unavailable produces one that is visibly absent.

        The accessor has moved across kokoro-onnx versions, so several are tried
        before giving up. An empty list is not fatal -- the Node side treats
        "unknown" and "empty" differently, and narrowing the registry to zero on
        a failed introspection would make the platform look mute.
        """
        for accessor in ("get_voices", "voices"):
            try:
                candidate = getattr(self.kokoro, accessor, None)
                if candidate is None:
                    continue
                value = candidate() if callable(candidate) else candidate
                if isinstance(value, dict):
                    return sorted(str(k) for k in value.keys())
                if isinstance(value, (list, tuple, set)):
                    return sorted(str(v) for v in value)
            except Exception:  # noqa: BLE001
                continue
        _log("could not introspect voice names from the bundle")
        return []

    def _init_misaki(self):
        """Bind the misaki G2P.

        Only reached when the operator selected it. misaki is what makes the
        Section 4 markup real -- `[word](+2)` and `[word](/phonemes/)` are misaki
        features, and kokoro-onnx's own espeak-based tokenizer ignores them,
        which means it PRONOUNCES the brackets.

        A failure to bind is not fatal: the worker falls back to the espeak path
        and reports the degradation. A silent voice is worse than an unemphasised
        one.
        """
        try:
            from misaki import en
            fallback = None
            if _truthy(os.environ.get("VOICE_MISAKI_ESPEAK_FALLBACK", "true")):
                # Reintroduces the GPL dependency this mode could avoid, which is
                # why it is a switch. Without it, out-of-dictionary words -- brand
                # names, surnames, product codes -- have no pronunciation at all.
                from misaki import espeak
                fallback = espeak.EspeakFallback(british=False)
            self.g2p = en.G2P(trf=False, british=False, fallback=fallback)
            _log("misaki G2P bound (espeak fallback=%s)" % (fallback is not None))
        except Exception as err:  # noqa: BLE001
            self.g2p_mode = "espeak"
            self.g2p = None
            _log("misaki unavailable (%s: %s); falling back to the espeak path"
                 % (type(err).__name__, err))

    def capabilities(self):
        return {
            "engine": "kokoro-onnx",
            "model": os.path.basename(self.model_path or ""),
            "bundle": os.path.basename(self.voices_path or ""),
            "g2p": self.g2p_mode,
            "native_sample_rate": NATIVE_SAMPLE_RATE,
            "voices": self.voices,
            "voice_count": len(self.voices),
        }


def _truthy(raw):
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


# ===========================================================================
# Request handling
# ===========================================================================

def _handle(state, request):
    """Route one request frame."""
    request_id = request.get("id")
    op = request.get("op") or "synthesize"

    if "ping" == op:
        return {"id": request_id, "ok": True, "op": "ping", "pid": os.getpid(),
                "capabilities": state.capabilities()}

    if "load" == op:
        # The model is already resident from startup; this reports rather than
        # reloads. Kept because the supervisor's prewarm path calls it, and
        # because an operator wants a way to ask "what is actually loaded".
        state.ensure_imported()
        return {"id": request_id, "ok": True, "op": "load",
                "capabilities": state.capabilities()}

    if "unload" == op:
        # Accepted and refused, rather than silently succeeding. With a single
        # model and per-call voice selection there is nothing to unload, and
        # dropping the model would only guarantee the next request pays a cold
        # load for no benefit.
        return {"id": request_id, "ok": True, "op": "unload", "unloaded": 0,
                "note": "kokoro holds one model and selects voices per call"}

    if "synthesize" != op:
        return {"id": request_id, "ok": False, "code": "unknown_op",
                "error": "unrecognised op: %s" % op}

    return _synthesize(state, request, request_id)


def _synthesize(state, request, request_id):
    """Render one utterance."""
    text = request.get("text") or ""
    if not text.strip():
        return {"id": request_id, "ok": False, "code": "empty_text",
                "error": "no text to synthesise"}

    voice = str(request.get("voice") or "").strip()
    if not voice:
        return {"id": request_id, "ok": False, "code": "no_voice",
                "error": "synthesize requires a voice"}

    # Refused HERE as well as on the Node side. This is the last check before the
    # engine, and kokoro-onnx's own error for an unknown voice is a KeyError deep
    # in a style lookup, which reaches an operator as "synthesis_failed" and
    # tells them nothing.
    if state.voices and voice not in state.voices:
        return {"id": request_id, "ok": False, "code": "unknown_voice",
                "error": "voice %s is not in %s"
                         % (voice, os.path.basename(state.voices_path or ""))}

    # length_scale is the primary control, because the prosody layer varies it
    # per phrase. Kokoro expresses the same thing as `speed`, which is its
    # INVERSE, so the conversion happens once, here, and both callers cannot
    # disagree about what a speed means.
    length_scale = request.get("length_scale")
    if length_scale is None:
        speed = request.get("speed")
        if isinstance(speed, (int, float)) and speed > 0:
            length_scale = 1.0 / float(speed)

    if length_scale is None:
        speed = 1.0
    else:
        try:
            length_scale = float(length_scale)
        except (TypeError, ValueError):
            return {"id": request_id, "ok": False, "code": "invalid_length_scale",
                    "error": "length_scale must be a number"}
        if not (MIN_LENGTH_SCALE <= length_scale <= MAX_LENGTH_SCALE):
            return {"id": request_id, "ok": False, "code": "invalid_length_scale",
                    "error": "length_scale must be between %s and %s"
                             % (MIN_LENGTH_SCALE, MAX_LENGTH_SCALE)}
        speed = 1.0 / length_scale

    wanted_rate = request.get("sample_rate")
    try:
        wanted_rate = int(wanted_rate) if wanted_rate else NATIVE_SAMPLE_RATE
    except (TypeError, ValueError):
        wanted_rate = NATIVE_SAMPLE_RATE
    if wanted_rate not in SUPPORTED_OUTPUT_RATES:
        return {"id": request_id, "ok": False, "code": "invalid_sample_rate",
                "error": "sample_rate must be one of %s"
                         % (list(SUPPORTED_OUTPUT_RATES),)}

    lang = str(request.get("lang") or "en-us").strip() or "en-us"

    started = time.time()
    degraded = []

    # ---- phonemise, if misaki is in use ----------------------------------
    #
    # On the espeak path the text goes to create() as text and kokoro-onnx's own
    # tokenizer phonemises it. On the misaki path it is phonemised HERE and
    # passed with is_phonemes=True, which is what makes the Section 4 markup
    # take effect rather than be spoken aloud.
    payload = text
    is_phonemes = False
    if "misaki" == state.g2p_mode and state.g2p is not None:
        try:
            phonemes, _tokens = state.g2p(text)
            if phonemes and str(phonemes).strip():
                payload = phonemes
                is_phonemes = True
            else:
                degraded.append("misaki_returned_empty")
        except Exception as err:  # noqa: BLE001
            # Fall through to the text path rather than fail. An unemphasised
            # reply is a degraded reply; a failed one is silence.
            degraded.append("misaki_failed:%s" % type(err).__name__)

    try:
        if is_phonemes:
            samples, rate = state.kokoro.create(
                payload, voice=voice, speed=speed, lang=lang, is_phonemes=True)
        else:
            samples, rate = state.kokoro.create(
                payload, voice=voice, speed=speed, lang=lang)
    except TypeError:
        # Older kokoro-onnx builds take the voice positionally and do not accept
        # is_phonemes. Retried rather than failed, because the alternative is
        # losing the voice entirely on a version skew that a redeploy could
        # introduce at any time.
        samples, rate = state.kokoro.create(payload, voice, speed, lang)
        if is_phonemes:
            degraded.append("is_phonemes_unsupported")

    if samples is None or 0 == len(samples):
        return {"id": request_id, "ok": False, "code": "no_audio",
                "error": "kokoro produced no audio for this text"}

    rate = int(rate or NATIVE_SAMPLE_RATE)

    if rate != wanted_rate:
        samples, rate = _resample(samples, state.np, rate, wanted_rate)
        if rate != wanted_rate:
            degraded.append("resample_unavailable")

    pcm = _to_int16_pcm(samples, state.np)

    return {
        "id": request_id,
        "ok": True,
        "sample_rate": rate,
        "pcm_b64": base64.b64encode(pcm).decode("ascii"),
        "bytes": len(pcm),
        "elapsed_ms": int((time.time() - started) * 1000),
        "voice": voice,
        "g2p": "misaki" if is_phonemes else "espeak",
        # Reported, not hidden. A reply that came back at the wrong rate, or
        # without the emphasis an admin switched on, is something an operator
        # needs to see in a log rather than deduce from listening.
        "degraded": degraded,
        "capabilities": {"engine": "kokoro-onnx", "native_sample_rate": NATIVE_SAMPLE_RATE},
    }


# ===========================================================================
# Entry points
# ===========================================================================

def probe(state):
    """Answer the readiness smoke test.

    Resolves, against the interpreter that will really run it, whether
    kokoro_onnx imports, whether the model and bundle load, and which voices the
    bundle holds. Documentation cannot answer any of those.
    """
    result = {"ok": False, "protocol": PROTOCOL_VERSION}
    try:
        state.ensure_imported()
    except Exception as err:  # noqa: BLE001
        result["code"] = "kokoro_import_failed"
        result["error"] = "%s: %s" % (type(err).__name__, err)
        return result

    result["import"] = "ok"
    result["capabilities"] = state.capabilities()

    try:
        # One real utterance. An import that succeeds and a model that loads still
        # prove nothing about whether inference works -- the phonemiser is a
        # separate dependency and its absence surfaces only on first synthesis.
        response = _synthesize(state, {
            "text": "Voice check.",
            "voice": (state.voices[0] if state.voices else "af_bella"),
        }, "probe")
        result["ok"] = bool(response.get("ok"))
        if not result["ok"]:
            result["code"] = response.get("code")
            result["error"] = response.get("error")
        else:
            result["bytes"] = response.get("bytes")
            result["elapsed_ms"] = response.get("elapsed_ms")
    except Exception as err:  # noqa: BLE001
        result["code"] = "synthesis_failed"
        result["error"] = "%s: %s" % (type(err).__name__, err)

    return result


def _argv_value(flag, default=None):
    argv = sys.argv
    if flag in argv:
        index = argv.index(flag)
        if index + 1 < len(argv):
            return argv[index + 1]
    return default


def main():
    model_path = _argv_value("--model", os.environ.get("VOICE_KOKORO_MODEL"))
    voices_path = _argv_value("--voices", os.environ.get("VOICE_KOKORO_VOICES"))
    g2p_mode = (_argv_value("--g2p", os.environ.get("VOICE_KOKORO_G2P", "espeak"))
                or "espeak").strip().lower()
    if g2p_mode not in ("espeak", "misaki"):
        g2p_mode = "espeak"

    state = State(model_path, voices_path, g2p_mode)

    if "--probe" in sys.argv:
        _stdout_line(probe(state))
        return 0

    # ---- one-shot mode (Section 7.1) -------------------------------------
    #
    # WHY THIS EXISTS, AND WHY IT IS NOT MERELY THE "EVALUATION PHASE" MODE
    # SECTION 7.1 CALLS IT.
    #
    # Under Piper there were always two routes to audio: the resident worker,
    # and a fresh `piper` binary per utterance. voice-engines.js is built around
    # that -- a null answer from the worker means "fall back", and the CLI spawn
    # carries the request. That fallback is why a crashed or backing-off worker
    # degraded latency rather than removing speech.
    #
    # Retiring Piper deletes that second route. Left alone, the resident worker
    # would become a single point of failure for ALL speech: one bad model load,
    # one OOM kill, and the platform is mute with no path back until a restart.
    #
    # So the subprocess mode Section 7.1 describes is kept as the fallback tier
    # rather than discarded after evaluation. It is the same code reached the
    # same way -- one request in on stdin, one response out, then exit -- so the
    # two tiers cannot diverge in behaviour the way two implementations would.
    # It pays a full model load per utterance, which is exactly the cost the
    # resident worker exists to avoid; that is the right trade for a degraded
    # path nobody should normally be on.
    if "--once" in sys.argv:
        # Imported HERE, inside the branch, and reported as a structured failure
        # rather than a traceback. Placed before the request is read so a
        # missing dependency is answered with a code the caller can route on,
        # not an AttributeError from a null engine deep inside _synthesize.
        try:
            state.ensure_imported()
        except Exception as err:  # noqa: BLE001
            _log("one-shot cannot start: %s: %s" % (type(err).__name__, err))
            _stdout_line({"id": None, "ok": False, "code": "kokoro_import_failed",
                          "error": "%s: %s" % (type(err).__name__, err)})
            return 1

        line = sys.stdin.readline()
        if not line.strip():
            _stdout_line({"id": None, "ok": False, "code": "bad_request",
                          "error": "no request on stdin"})
            return 1
        try:
            request = json.loads(line)
        except ValueError as err:
            _stdout_line({"id": None, "ok": False, "code": "bad_request",
                          "error": "unparseable request line: %s" % err})
            return 1
        try:
            _stdout_line(_handle(state, request))
            return 0
        except Exception as err:  # noqa: BLE001
            _stdout_line({"id": request.get("id"), "ok": False,
                          "code": "synthesis_failed",
                          "error": "%s: %s" % (type(err).__name__, err)})
            return 1

    try:
        state.ensure_imported()
    except Exception as err:  # noqa: BLE001
        _log("cannot start: %s: %s" % (type(err).__name__, err))
        _stdout_line({"type": "fatal", "code": "kokoro_import_failed",
                      "error": "%s: %s" % (type(err).__name__, err)})
        return 1

    _stdout_line({"type": "ready", "protocol": PROTOCOL_VERSION, "pid": os.getpid(),
                  "capabilities": state.capabilities()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except ValueError as err:
            # No id to reply against, so this cannot be routed. The stream
            # continues: a malformed line costs one request, not the worker.
            _stdout_line({"id": None, "ok": False, "code": "bad_request",
                          "error": "unparseable request line: %s" % err})
            continue

        if "shutdown" == request.get("op"):
            _stdout_line({"id": request.get("id"), "ok": True, "op": "shutdown"})
            return 0

        try:
            _stdout_line(_handle(state, request))
        except Exception as err:  # noqa: BLE001 -- deliberate catch-all
            # Anything escaping here would kill the worker and every request
            # queued behind it. A failed request must cost only itself; the
            # supervisor's restart path exists for the crashes that do not reach
            # this handler.
            _stdout_line({"id": request.get("id"), "ok": False,
                          "code": "synthesis_failed",
                          "error": "%s: %s" % (type(err).__name__, err)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
