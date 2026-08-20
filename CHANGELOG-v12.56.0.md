# v12.56.0 — Kokoro voice registry and resident worker (SPEC-KOKORO-001, part 2)

**This release changes no behaviour.** TTS still runs on Piper, unchanged. Two
more modules land, verified standalone, wired into nothing.

Same reason as v12.55.0: the Piper→Kokoro swap is atomic, and half a swap is a
mute platform. The next release is the swap, and it is the only one that changes
what a user hears.

## What is in this release

**`src/voice/voice-registry.js`** — the deployable voice set: af_bella
(default), af_nicole, af_heart, bf_emma, af_aoede. Voice resolution, the sample
rate switch, and reconciliation against the bundle.

**`src/voice/kokoro_worker.py`** — the resident worker. Holds the model, selects
voices per call, phonemises through espeak or misaki, resamples on request.

**`src/voice/requirements-kokoro.txt`** — pinned dependencies with the licensing
note.

## Corrections to the specification, carried into the code

**Section 8's registry shape does not match the artifact.** It models
`weight_file` as one `.pt` per voice. kokoro-onnx v1.0 ships one model and one
`voices-v1.0.bin` holding every voice as a 256-dimensional style vector. A row
therefore addresses a voice *inside* a bundle: `bundle` plus `name`. A test
asserts no row carries a `weight_file`.

**Section 10's central limitation does not exist.** It states that "Kokoro locks
voices at model load, so rapid switching between assistants mid-conversation
requires a bundle reload". `Kokoro.create()` takes `voice=` per call: the bundle
loads once, and selecting a voice is an array lookup. There is no reload
machinery here and no residency cap, because switching per utterance is free.
Per-tenant and per-assistant selection is considerably simpler than specified.

**Section 7.2 specifies FastAPI; this is a stdio worker.** The requirement it
expresses is "hold the model in memory", which this does. A FastAPI worker would
add a listening socket, an auth surface in front of it, and a second route into
synthesis to secure to the same standard. The connector already has a proven
NDJSON-over-stdio supervisor with backoff, restart and a hard boundary on the
child's environment. The trade-off, stated plainly: stdio is one request at a
time, where HTTP could serve several. That is right for a CPU budget, where
concurrency contends rather than parallelises. **If a GPU budget is approved
later, revisit this** — an HTTP worker with a batch queue is the correct shape
for a GPU.

**`af-bella` is `af_bella`.** The decision was written with a hyphen; Kokoro's
identifier uses an underscore, and a hyphen is an unknown voice. A test asserts
every registered name matches Kokoro's format.

## The GPL boundary moved with the engine; it did not go away

Piper was GPL-3.0, which is why its worker ran as its own process with a minimal
environment. Kokoro-82M is Apache-2.0, so it is easy to assume the boundary is
now unnecessary.

It is not. **kokoro-onnx phonemises through `phonemizer`, which drives espeak-ng,
and espeak-ng is GPL-3.0.** The dependency moved from the model to the
phonemiser. So `kokoro_worker.py` keeps every discipline `piper_worker.py` had,
and `voice-gpl-boundary.test.js` will apply to it unchanged: nothing in the Node
source imports it, and it never shares an interpreter with the MIT STT helper.

The misaki path with its espeak fallback disabled would avoid the GPL dependency
entirely. That is a licensing option rather than a default, because without a
fallback misaki cannot phonemise out-of-dictionary words — brand names,
surnames, product codes — so it trades a licence question for a pronunciation
one. `VOICE_MISAKI_ESPEAK_FALLBACK` controls it.

## English only, recorded rather than implied

`TTS_LANGUAGES` is `['en']`. The Piper catalogue carried Vietnamese, Chinese and
Japanese voices; Kokoro has no Vietnamese voice at any version, and none of the
five deployed voices is Japanese or Mandarin. Accepted on the platform decision
of 2026-08-19 that Piper was a proof of concept whose non-English voices were
never in production use.

The consequence is visible rather than silent: `speakableLanguages()` narrows,
`/voice/status` reports it, and the client's existing `languageSpeakable()` gate
hides the Speak button for a language it cannot serve. A missing button, not a
button that fails. Tests assert no Piper-era voice id resolves, because the
client may still hold one in a stored preference after cutover.

## The 16 kHz switch is real DSP, and it was measured

24 kHz is the default because it is the native rate: no processing, so no
artifact. 16 kHz is a third smaller on the wire.

24k→16k is a ratio of 2/3. Dropping every third sample would alias everything
above 8 kHz down into the speech band as a metallic buzz — worst on exactly the
sibilants that carry intelligibility. `scipy.signal.resample_poly` is the primary
path; a numpy windowed-sinc polyphase implementation is the fallback.

**Both paths verified numerically** against synthesised tones:

| Check | Result |
| --- | --- |
| 200 / 1000 / 3000 / 7000 Hz in-band, scipy | RMS preserved to within 3% |
| 10 kHz out-of-band, scipy | 0.354 → 0.0012 RMS (≈ −50 dB) |
| 10 kHz out-of-band, numpy fallback | 0.354 → 0.0011 RMS |
| Output length | exactly 2/3 of input |
| 24k→24k passthrough | bit-identical, no filter applied |
| Clipping | ±2.0 → ±32767, not wrapped |

An unrecognised rate falls back to native rather than being honoured — a typo in
an env var must not resample every reply through an untested ratio. If neither
resampler is available the worker returns **native-rate audio and reports
`resample_unavailable`**, rather than shipping aliased audio nobody would notice
until they heard it.

## Design decisions worth knowing

**A stale voice name never causes silence.** `resolveVoice()` walks request →
assistant → tenant → default, and an unusable value at any level falls through
to the next while being recorded in `ignored`. A stale name in a tenant setting
is a configuration problem, and the right response is a reply in the default
voice plus a log line an operator can act on. Blank values are skipped rather
than recorded, because an unset tenant setting is the common case and must not
generate a warning.

**The bundle is the only authority on which voices exist.** `reconcile()`
intersects the configured registry with what the worker reports. Offering a voice
the bundle lacks produces a Speak button that fails at synthesis; reporting it
unavailable produces one that is visibly absent. Crucially, an *unknown* bundle
(at boot, or worker disabled) is not treated as an *empty* one — narrowing to
zero would make the platform look mute during startup.

**The worker proves the engine imports before reporting ready.** `piper_worker.py`
learned this the hard way: it reported ready and deferred the import, producing a
log reading "worker ready" followed by ModuleNotFoundError on every synthesis.
Failing at startup instead makes the supervisor treat it as a failed start, which
it already handles correctly.

**PCM is clipped, not normalised.** A resampler's transient overshoot can push a
few samples past unity, and normalising the whole utterance would make its
loudness depend on its worst sample — so consecutive phrases of one reply would
arrive at different volumes.

## Tests

New file `src/tests/voice-registry.test.js`, 24 tests. `npm run test:registry`,
and added to `test:voice-all`.

- **Suite total: 277 passed, 0 failed** (253 before, +24).
- The resampler was verified numerically by direct execution of both paths,
  including with `scipy` import blocked to force the fallback.
- `kokoro_worker.py` compiles clean under `py_compile`.

Also repaired: the `test:prosody-prep` script briefly picked up the registry file
during editing, and `test:voice-all` had not actually gained the registry suite.
Both corrected and re-verified — the aggregate genuinely runs all eight files now.

## Not verified, and cannot be here

**Nothing has been run against Kokoro.** There is no model, no `kokoro-onnx` and
no espeak in this environment. What is verified is the registry logic, the
resampler numerics, and that the worker parses and compiles. Whether
`Kokoro.create()` behaves as documented against the pinned wheel is a deploy-time
check, which is what the worker's `--probe` mode exists for: it loads the model,
lists the bundle's voices, and synthesises one real utterance.

The `(+2)` stress control remains unproven — see v12.55.0.

## Next, and it is the atomic one

`kokoro-worker-supervisor.js`, the `voice-engines.js` swap, `voice-catalog.js`
and `voice-provision.js` replaced, Piper deleted, and the existing voice test
suites updated. That release changes behaviour, and it is the one to deploy
behind a listening check.

Then the gateway and client admin surface for tenant voice selection.

## Rollback

Delete the three new files. Nothing calls any of them.
