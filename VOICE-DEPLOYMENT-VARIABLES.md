# Voice deployment — Railway variables

For **claude-connector v13.2.0**, **ts-gateway-service v2.111.0**,
**ts-client-gateway v5.139.0**.

Derived from the code, not from memory: every `process.env` read on the voice
path was enumerated and cross-referenced against what the image already sets.

---

## Short answer

On the **connector**, two variables decide whether this works at all:

| Variable | Value | Why |
| --- | --- | --- |
| `VOICE_ENABLED` | `true` | Master switch. Defaults to **false** and is **not** set in the image. Without it there is no mic button and no Speak button. |
| `CONNECTOR_URL` | `https://<your-connector>.up.railway.app` | Without it **no download link can be built for anything** — this is the variable behind the empty documents. |

Everything the Kokoro engine itself needs is already defaulted in the image.
**You do not need to set any `VOICE_KOKORO_*` variable.**

On the **gateway**, run the migration:

```
npm run migrate:up
```

---

## Connector — required

### `VOICE_ENABLED=true`

`voiceEnabled()` returns false for an unset value, and the whole feature is
behind it: no worker is spawned, no route answers, and `/voice/health` reports
`enabled: false`. That is indistinguishable from a broken deployment from the
outside, which is why it is first on this list.

### `CONNECTOR_URL=https://<service>.up.railway.app`

Not a voice variable, and listed as required because its absence caused the
worst bug in this system: documents that rendered successfully and came back
with no way to open them.

As of v13.1.1 that render **fails** rather than returning an unusable success,
and as of v13.2.0 the connector logs a named warning at boot and reports it under
`deployment_problems` in `/voice/health`. But the fix for the fault is still this
variable.

No trailing slash.

---

## Connector — required only if you want speech-to-text

### `VOICE_ALLOWLIST_SOURCE` and friends

Voice is gated per user as well as globally. Two modes:

**Environment mode (default, simplest):**

```
VOICE_ALLOWLIST_SOURCE=env          # or leave unset
VOICE_TEST_USERS=<user-id>,<user-id>
```

**Gateway mode (the allowlist is managed centrally):**

```
VOICE_ALLOWLIST_SOURCE=gateway
VOICE_ALLOWLIST_URL=https://<your-gateway>.up.railway.app
VOICE_ALLOWLIST_KEY=<same value as GATEWAY_ADMIN_KEY>
```

**The failure mode worth knowing:** setting
`VOICE_ALLOWLIST_SOURCE=gateway` without `VOICE_ALLOWLIST_URL` means the
allowlist cannot be fetched, `VOICE_TEST_USERS` is ignored, and **every user is
denied**. That is correct fail-closed behaviour and it is indistinguishable from
voice simply being off. The connector names this specific fault in
`/voice/health` under `configuration_problems` — it is one of the few messages
deliberately shown to a *denied* caller, because the operator who needs it is by
definition the person being denied.

---

## Connector — optional, all safely defaulted

| Variable | Default | Set it when |
| --- | --- | --- |
| `VOICE_TTS_SAMPLE_RATE` | `24000` | You want 16 kHz output for every tenant. Per-tenant is better set from the gateway UI. |
| `VOICE_TTS_TENANT_VOICE` | *(unset → af_bella)* | Single-tenant install and you want a different default voice. Multi-tenant installs should use the gateway setting, which outranks this. |
| `VOICE_TTS_EMPHASIS` | `true` | You want `**bold**` stress tagging off. **Has no effect on the espeak G2P** — see below. |
| `VOICE_TTS_LEXICON` | `{}` | You have pronunciation overrides. JSON object, misaki only. |
| `VOICE_KOKORO_G2P` | `espeak` | You have installed misaki and want the markup features to work. |
| `VOICE_TTS_THREADS` | `1` | You have more than one CPU to give the engine. |
| `VOICE_TTS_SUBPROCESS_FALLBACK` | `true` | **Leave it on.** Off means a sick worker takes all speech with it. |
| `VOICE_PROVISION_ON_BOOT` | `false` | **Leave it off.** The artifacts are baked into the image. |
| `VOICE_STT_TIER` | `base` | You want a different Whisper size. |
| `VOICE_MAX_UPLOAD_BYTES` / `VOICE_MAX_AUDIO_SECONDS` | see code | You need different upload limits. |

### Do not set these

| Variable | Why not |
| --- | --- |
| `VOICE_KOKORO_MODEL` | Pinning it **defeats the layered resolution** and stops the image copy being used. Only set it to force one exact file. |
| `VOICE_KOKORO_VOICES` | Same. |
| `VOICE_KOKORO_PYTHON` | The image sets `/opt/kokoro/bin/python3`. Overriding it with an interpreter that lacks `kokoro-onnx` stops TTS entirely. |
| `VOICE_KOKORO_DIR` | The image sets it. It names where a **volume override** is looked for, not where the engine lives. |

If you set any of the four to a path that does not exist, the connector says so
by name in `/voice/health` under `deployment_problems`, and at boot.

### Retired — remove these if present

`VOICE_PIPER_BIN`, `VOICE_PIPER_DIR`, `VOICE_VOICES_DIR`. Piper was deleted in
v13.0.0. They are read by nothing and will mislead whoever reads the variable
list next.

---

## Gateway (`ts-gateway-service` v2.111.0)

**Run the migration.** `npm run migrate:up` applies
`0008_tenant_voice_defaults.sql`, which adds the per-tenant voice columns.

Before it runs, `PUT /ti-voice/settings` returns 503
`voice_settings_schema_missing` naming the command, and synthesis is unaffected.

No new environment variables. `GATEWAY_ADMIN_KEY` and `JWT_SECRET` are already
required by the service.

---

## Client (`ts-client-gateway` v5.139.0)

No variables. The voice picker renders from `/ti-voice/settings`.

**One thing to know:** an admin must have voice enabled **on their own account**
before they can configure the tenant default — both settings routes run the same
`resolveVoiceContext` gate. The refusal is clear (`voice_not_enabled`), but it
looks like a permissions bug if you hit it cold.

---

## Verifying it worked

In order, because each step's failure has a different cause:

**1. Is voice on and can the engine load?**

```
curl -s https://<connector>/voice/health | jq '{enabled, tts_ready, tts_error, deployment_problems, configuration_problems}'
```

`tts_error` names the specific missing thing. `deployment_problems` and
`configuration_problems` are absent when the configuration is coherent — their
presence is itself the signal.

**2. Does it actually synthesise, and fast enough?**

```
npm run voice:smoke
```

This loads the model, checks all five offered voices are in the bundle, renders a
real paragraph, and reports a **realtime factor**. Below 1.0x the audio arrives
slower than it plays and the streaming path will stutter; below 2.0x a long reply
on a loaded host may approach the gateway's 120s ceiling.

It also prints which layer each artifact came from:

```
model : /opt/kokoro/models/kokoro-v1.0.onnx  [image]
bundle: /opt/kokoro/models/voices-v1.0.bin   [image]
```

`[image]` is the expected fresh-deploy state. `[volume]` means someone left a
file on the volume and the engine is running that instead.

**3. Listen to a reply.** Nothing above proves the audio is good, only that it
exists.

---

## One expectation to set before you listen

The Hugging Face Space that demonstrates Kokoro runs **misaki**. This connector
runs **espeak-ng**, which is the same grapheme-to-phoneme class Piper used.

The acoustic model is a large step up. The front end is not, and the difference
is audible on proper nouns, initialisms and brand names — the words a business
assistant says most. The gain over Piper is real but **narrower than the Space
implies**.

`/voice/health` reports `prosody.g2p` so you can read which front end is running,
and `prosody.emphasis` reports `configured` and `effective` separately — on the
espeak path emphasis is configured on and effective false, by design, because
emitting the markup would have the assistant read the brackets aloud.

---

## v13.34.0 additions (SPEC-AUDIO-003)

None of these needs to be set. Every one has a working default; they exist so
the bounds are data, not code.

### Segmenting (W1)

| Variable | Default | Range | What it does |
| --- | --- | --- | --- |
| `VOICE_MAX_TTS_CHARS` | `100000` | 5000..500000 | Anti-abuse ceiling on text submitted for speech. Above it the request is refused with a NAMED `text_too_long`. **Was 5000**, which refused long replies outright; a value below 5000 is now ignored so an old setting cannot reinstate that drop. |
| `VOICE_TTS_MAX_RUN_CHARS` | `350` | 80..480 | Longest stretch of text between `. , ! ? ;` handed to Kokoro in one call. kokoro-onnx 0.4.9 truncates anything over 510 phonemes in such a stretch and still reports success. |
| `VOICE_TTS_SEGMENT_CHARS` | `5000` | 200..20000 | Longest text handed to one engine call. Longer replies are cut at sentence boundaries. |
| `VOICE_SHORT_RENDER_MAX_CPS` | `40` | 10..200 | Duration floor for the short-render check, in letters a second at length_scale 1. |
| `VOICE_SHORT_RENDER_MIN_CHARS` | `60` | 1..10000 | Below this many letters the short-render check does not run. |

### ElevenLabs, per user (W3)

There is no platform ElevenLabs key and none should be set: each user's own key
arrives from the gateway in the request that needs it.

| Variable | Default | What it does |
| --- | --- | --- |
| `ELEVENLABS_API_BASE` | `https://api.elevenlabs.io` | Test-only override. Leave unset in production. |
| `ELEVENLABS_TIMEOUT_MS` | `30000` | Per-request timeout (1000..120000). |
| `ELEVENLABS_CONCURRENCY` | `2` | Phrases in flight at once against one user's account (1..8). |
| `ELEVENLABS_SEGMENT_CHARS` | `2500` | Longest segment the non-prosody ElevenLabs path sends in one call (200..9000). |
