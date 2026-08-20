# v13.0.0 — Kokoro-82M replaces Piper (SPEC-KOKORO-001, the cutover)

**BREAKING.** This is the release that changes what a user hears. Piper is
deleted. Non-English text-to-speech is gone. Deploy behind a listening check.

Requires a rebuilt image: the Dockerfile now installs `kokoro-onnx` and
`espeak-ng` instead of `piper-tts`, and the artifacts on the volume are
different files in a different directory.

## The cutover

| | Before | After |
| --- | --- | --- |
| Engine | Piper (GPL-3.0) | Kokoro-82M (Apache-2.0) |
| Artifacts | one `.onnx` + `.json` per voice | one model + one bundle of style vectors |
| Voice selection | model path per voice | `voice=` parameter per call |
| Voices | 5 Piper voices, 4 languages | af_bella (default), af_nicole, af_heart, bf_emma, af_aoede |
| `TTS_LANGUAGES` | `['en','vi','zh','ja']` | `['en']` |
| Output rate | 22.05 kHz, per-voice | 24 kHz native, 16 kHz selectable |
| Fallback tier | `piper` CLI binary | same worker script, `--once` |

## What you lose, stated plainly

**Vietnamese, Chinese and Japanese speech.** Kokoro has no Vietnamese voice at
any version, and none of the five deployed voices is Japanese or Mandarin.
Accepted on the platform decision of 2026-08-19 that Piper was a proof of
concept whose non-English voices were never in production use.

The loss is visible rather than silent: `speakableLanguages()` narrows,
`/voice/status` reports it, and the client's existing `languageSpeakable()` gate
hides the Speak button for a language it cannot serve. A missing button, not a
button that fails. `POST /voice/synthesize` with `language: 'zh'` now returns
422 `unsupported_language` where it used to return `no_voice_available` — a
different reason, and the honest one.

**There is no pitch or timbre control, and there never was one to add.**
Kokoro's entire parameter set is `create(text, voice=, speed=, lang=)`. Timbre
is determined solely by which voice vector is selected, so the five-voice
selector *is* the timbre control. The only route to intermediate timbres is
blending style vectors, which is the voice-creation work excluded from this
release.

## The GPL boundary did not retire with Piper

Piper was GPL-3.0, and its own venv, own directory and own process existed for
that reason. Kokoro-82M is Apache-2.0, so the separation looks like ceremony
now.

**It is not.** kokoro-onnx phonemises through `phonemizer`, which drives
**espeak-ng, which is GPL-3.0**. The dependency moved from the model to the
phonemiser. So every discipline survives, retargeted: `/opt/kokoro` is its own
venv, `VOICE_KOKORO_PYTHON` is never `VOICE_PYTHON_BIN`, the child gets a
minimal environment, and `voice-gpl-boundary.test.js` asserts all of it against
the new engine.

Choosing the misaki G2P with its espeak fallback disabled would remove the GPL
dependency entirely — at the cost of no pronunciation for out-of-dictionary
words. A licensing option, not a default.

## Design decisions worth knowing

**`voice-catalog.js` was re-pointed, not deleted.** Its *interface* was never
the Piper-specific part — "which voices exist, may this one be used, which
languages can be spoken" are questions any engine answers. Only the contents
were Piper's. Keeping the interface and replacing the contents is what stopped
the swap becoming a rewrite of `routes/voice.js` and `voice-schema.js`.

**The one-shot subprocess is a tier, not an evaluation mode.** Under Piper there
were always two routes to audio, which is why a sick worker cost latency rather
than speech. Retiring Piper deletes the second route, so §7.1's subprocess mode
is kept as tier two: the same script with `--once`, sharing one
`synthesisRequest()` builder so the tiers cannot diverge. Disabling it
(`VOICE_TTS_SUBPROCESS_FALLBACK=false`) is a deliberate choice to accept total
voice loss on worker failure.

**§10's central limitation does not exist.** It states Kokoro locks voices at
model load and that switching needs a bundle reload. `create()` takes `voice=`
per call, so there is no reload machinery and no residency cap.

**The licence audit is retained but no longer load-bearing.** The Piper
catalogue carried a per-voice audit because Piper voices came from many datasets
with divergent terms — and it caught a real problem. Kokoro is one model under
one licence, so every row is `audited:1, commercial_ok:1`. The nullable column
survives for a future engine but cannot hold NULL today, and the schema test now
asserts exactly that.

## Test migration

40 assertions described an architecture that no longer exists. Deleting a test
for deleted code is correct; deleting the *property* it protected is not. So:

- **Removed** (~34): Piper binary resolution, CLI-path fallback, per-voice
  download sources, the three-state licence model, Vietnamese fallback.
- **Rewritten**: the GPL boundary suite, retargeted at `kokoro_worker.py` and
  espeak-ng; the 422 contract, now asserting every Piper voice id gets a clean
  `unknown_voice` refusal rather than a 500 from a style lookup; the Dockerfile
  separation test; the health catalogue shape; the normaliser choke-point test.
- **Added**: `no Piper artifact survives anywhere in the source tree`, which
  scans every JS file and the filesystem.

That last test earned its place immediately — it caught three source files still
naming deleted modules in comments, which would otherwise have shipped as stale
documentation of a GPL dependency that no longer exists.

## Two build defects caught before shipping

**The Dockerfile still built a Piper venv** and set `VOICE_PIPER_BIN`. The image
would have shipped the retired engine and none of the new one.

**`scripts/voice-worker-smoke.mjs` imported the deleted supervisor**, so
`npm run voice:smoke` — the one command an operator runs after deploying — would
have crashed on import. Both scripts are rewritten; the smoke test now drives the
worker's own `--probe`, deliberately the same entry point the supervisor spawns,
because a smoke test that reimplements the invocation can pass while the real
path fails.

The venv install pins are **inline** in the Dockerfile rather than
`-r requirements-kokoro.txt`, because `src/` is not copied until 60 lines later
and a `-r` against an uncopied path fails the build.

## Verification performed

- **Voice suites: 236 passed, 0 failed.**
- **Whole connector: 592 of 593 passed.** The single failure is
  `render-tools.test.js > download contract`, confirmed **pre-existing** by
  running it against the untouched v12.57.0 package: identical result, and
  unrelated to voice.
- Every voice module plus `routes/voice.js` imports cleanly.
- `initVoiceSchema()` syncs all five Kokoro rows into `voice_catalog` with
  correct licence values.
- Zero live Piper identifiers in source; the remaining mentions are historical
  comments explaining what changed.
- `kokoro_worker.py` compiles; the `--once` path was executed for real and
  returns a routable `kokoro_import_failed` rather than crashing.

## NOT verified, and this is the important part

**Nothing here has been run against Kokoro.** There is no model, no
`kokoro-onnx` and no espeak in the build environment. What is proven is that the
wiring is correct, the protocol frames parse, every failure path returns a
routable code, and the resampler numerics are sound.

Whether `Kokoro.create()` behaves as documented against the pinned wheel is a
deploy-time check. **Run `npm run voice:smoke` first** — it loads the model,
lists the bundle's voices, checks all five offered voices are present, and
renders one real utterance. Then listen to a reply before opening it to users.

The `(+2)` stress control remains unproven regardless of G2P.

## Deployment

1. Rebuild the image (new venv, new system package).
2. Provision the artifacts: `npm run voice:provision`, or pre-populate
   `/data/voice/kokoro` with `kokoro-v1.0.onnx` and `voices-v1.0.bin`.
   `VOICE_PROVISION_ON_BOOT` defaults to **false** — the model is ~310 MB and a
   boot-time fetch turns a redeploy into a stall against a health check.
3. `npm run voice:smoke`.
4. Listen to a reply.

Remove from your environment: `VOICE_PIPER_BIN`, `VOICE_PIPER_DIR`,
`VOICE_VOICES_DIR`. Add (or accept the image defaults):
`VOICE_KOKORO_PYTHON`, `VOICE_KOKORO_DIR`, `VOICE_KOKORO_MODEL`,
`VOICE_KOKORO_VOICES`, `VOICE_KOKORO_G2P`. Optional:
`VOICE_TTS_SAMPLE_RATE` (24000 or 16000), `VOICE_TTS_TENANT_VOICE`.

## Rollback

`git revert` to v12.57.0 and rebuild. There is no flag-level rollback: Piper is
deleted, so reverting means restoring the image as well as the code. A stored
client voice preference holding a Piper id is safe in both directions — it
resolves to the default with a log line rather than failing.

## Next

The gateway and client admin surface for per-tenant voice selection.
`VOICE_TTS_TENANT_VOICE` and `resolveVoice()` already exist on the connector
side; what remains is the Client Gateway UI and the route that writes it.
