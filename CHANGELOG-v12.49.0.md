# v12.49.0 — Fix: the engines were never installed, and a misconfiguration was silent

Reported as: no mic button, no audio, with `VOICE_ENABLED=true` on the connector.

## Two blockers, both mine

### 1. Neither engine was in the image

v12.46.0 shipped `requirements-voice.txt` and `requirements-piper.txt` and
documented the pip commands, and **never touched the Dockerfile**. So
faster-whisper and Piper were not installed. Nothing could transcribe however
the gates were set.

The Dockerfile now installs both, in **two separate Python environments**,
because the separation is the licence boundary and not tidiness:

| | Licence | Where |
|---|---|---|
| faster-whisper | MIT | system site-packages, imported by `voice_stt.py` |
| piper-tts | GPL-3.0 | its own venv at `/opt/piper`, never on our import path |

Installing them together would put GPL code in the interpreter our MIT helper
imports from, which is where the entanglement SPEC §6.2 exists to prevent
begins. Tests assert neither install line mentions the other.

Also adds `ffmpeg` and `espeak-ng`, and defaults `VOICE_PIPER_BIN` and the cache
paths to match the layout, so a deployment only has to set `VOICE_ENABLED` and
the allowlist.

**Build cost is real**: CTranslate2 and onnxruntime are a few hundred MB. That is
the price of local speech, and why the feature is behind a flag.

### 2. A correct refusal was indistinguishable from "off"

The reported configuration was:

```
VOICE_ENABLED=true
VOICE_ALLOWLIST_SOURCE=gateway
VOICE_TEST_USERS=ava:38
```

with no `VOICE_ALLOWLIST_URL`. In gateway mode the env allowlist is **ignored**,
the fetch cannot be attempted, so the allowlist is empty and every user is
denied.

That is correct fail-closed behaviour. It is also invisible: no mic, no error,
and `VOICE_TEST_USERS` sitting in the variable list looking like it should be
doing something. There was no way to tell a misconfiguration from a working
"off" — which makes the safe default a support call.

`allowlistConfigProblems()` now detects and names these, reported in two places:

- **at boot**, at error level, once
- **`GET /voice/health`** under `configuration_problems`

Reported to a *denied* caller too, but only when `VOICE_ENABLED` is true. The
operator who needs the message is by definition the person being denied, so
withholding it means the only way to see the fault is to already be past it. With
the master switch off nothing is said, because the routes must stay
indistinguishable from routes that do not exist.

Against the reported variables it produces:

1. `VOICE_ALLOWLIST_URL is not set, so the allowlist cannot be fetched and every user is denied`
2. `neither VOICE_ALLOWLIST_KEY nor GATEWAY_ADMIN_KEY is set`
3. `VOICE_TEST_USERS is set but IGNORED, because VOICE_ALLOWLIST_SOURCE=gateway`

The third is the one that would have saved the most time.

## Verification

- `src/tests/voice.test.js` — 47 passed (5 new, including the reported
  configuration reproduced exactly and the Dockerfile boundary).
- Full sweep: only the pre-existing `render-tools.test.js` failure.
