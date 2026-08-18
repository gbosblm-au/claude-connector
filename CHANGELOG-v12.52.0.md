# v12.52.0 -- the synthesis 500: Piper cannot write a WAV to a pipe

## The report

```
POST /ti-voice/synthesize 500   duration_ms 2751.9
[ti-voice] tts user=38 chars=283 status=500
```

## Root cause, reproduced

Not memory, not the model, not configuration. The connector asked Piper to
write a WAV file to **stdout**, and stdout is a pipe.

Piper writes WAV through Python's `wave` module, which patches the RIFF header
on close by **seeking** back to byte 4 to write the final length. A pipe cannot
seek. Once enough audio has been produced for Python's buffer to flush to the
real file descriptor, the next header patch fails:

```
File ".../piper/voice.py", line 103, in synthesize
  wav_file.writeframes(audio_bytes)
File ".../wave.py", line 560, in writeframes
  self._patchheader()
OSError: [Errno 29] Illegal seek
```

Piper exits 1 **after** several seconds of correct synthesis and hundreds of
kilobytes of correct audio, which is exactly the 2.75 s / 500 the gateway saw.

**It is size dependent**, which is why it survived review and testing: a short
utterance never fills the buffer, so no flush happens, no seek is attempted, and
everything works. The same command redirected to a *file* also works perfectly,
because files seek. It only fails on a real pipe, with real-length text -- a
283-character message.

Reproduced here on a matching Python 3.11 + piper-tts 1.2.0 environment with the
same `en_US-kristin-medium` model, spawned exactly as the connector spawns it.

## The fix

Stop asking Piper for a container it cannot write to a pipe.

`--output_raw` streams headerless PCM, which never seeks, and the 44-byte WAV
header is assembled in Node from the voice's own config. Sample rate, channel
count and sample width are all known before a byte is written, so every length
field is correct the first time and there is nothing to patch afterwards.

The sample rate is read from `<voice>.onnx.json` rather than assumed: hardcoding
22050 would play a 16 kHz low-quality voice fast and high.

## Also fixed, because the 500 said nothing

A `tts_failed` produced the log line `code=tts_failed status=500` and nothing
else. Whatever Piper said was discarded, so an OOM kill, a corrupt model and a
bad argument were indistinguishable.

- Piper's exit code, terminating signal and stderr are now written to the
  connector log. Never to the client -- stderr can carry paths and model
  internals -- and never the text being spoken.
- A signal is reported by name, and `SIGKILL` is called what it almost always
  is on a small container: the OOM killer, with the remedy stated.
- A timeout is now `504 tts_timeout` rather than a generic 500, so "too slow" is
  distinguishable from "broken".
- The child process gets `OMP_NUM_THREADS=1` / `ORT_NUM_THREADS=1`
  (`VOICE_TTS_THREADS` overrides). onnxruntime sizes its thread pools from the
  CPU count it can *see*, which on a container is the host's, not this
  service's share -- a dozen threads fighting over a fraction of a core, each
  with its own arena.

## Verification

Against the real engine, not a mock:

| Check | Result |
|---|---|
| The 283-character request that returned 500 | succeeds, 629,804 bytes |
| A 1,452-character passage | succeeds, 3.8 MB |
| RIFF/WAVE/data structure and both length fields | correct |
| Format block vs Piper's own file writer | byte-for-byte identical |
| Sample rate | 22050, read from the model config |
| Speed 0.75 / 1.0 / 1.5 | audio length changes as expected |
| `voice.test.js`, `voice-auth.test.js`, `phase0-security.test.js` | 47 / 29 / 61 pass |

One note on comparing output: Piper is a VITS model and samples noise per run,
so two syntheses of the same text are never byte-identical. Only the container
was compared, which is the part this change owns.
