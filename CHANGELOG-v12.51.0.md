# v12.51.0 -- speakable_languages: what can be spoken, not what is licensed

## The problem this fixes

`/voice/health` reported two language lists and neither answered the question a
UI actually needs to ask.

| Field | Answers | Why it is wrong to gate a UI on |
|---|---|---|
| `tts_languages` | the four launch languages | fixed at build time; knows nothing about this deployment |
| `catalogue.usable_by_language` | which voices are **licence-cleared** | knows nothing about whether a model file exists |

On the live connector both advertised English, Vietnamese, Chinese and
Japanese, while the volume held exactly one voice. A client offering a language
picker from either field would have offered four languages and delivered one,
with the other three failing at the engine.

## What is new

**`speakable_languages`** and **`speakable_by_language`** in `/voice/health`.
A language appears only when it has at least one voice that is BOTH permitted by
the catalogue AND present on the volume. That intersection is the only safe
basis for a language picker, and it is computed where both facts are known.

```
"tts_languages":        ["en","vi","zh","ja"],   the launch set
"speakable_languages":  ["en"],                  what this connector can do today
"speakable_by_language": { "en": ["en_US-kristin-medium"] }
```

The three states stay distinguishable, which is the point: a voice that is
licence-refused, one that is unaudited, and one that is simply not downloaded
are different problems with different fixes.

## Synthesis picks an installed voice

`voicesForLanguage()` returns catalogue order, defaults first, and the route
took the first entry blindly. On a language whose default voice was cleared but
never downloaded, that reached Piper and came back as a **500** -- an engine
failure reported for what is really a missing file.

`bestVoiceForLanguage()` now prefers a voice that is installed. When none is,
the route answers **422 `voice_not_installed`** naming the language and the
number of cleared-but-absent voices, instead of a 500 saying nothing.

## Files

| File | Change |
|---|---|
| `src/voice/voice-catalog.js` | `speakableLanguages()`, `bestVoiceForLanguage()`. The installed list is passed in, so the module still knows nothing about the filesystem and stays testable without one. |
| `src/routes/voice.js` | Health reports both new fields; synthesis prefers an installed voice and 422s cleanly. |
| `src/tests/voice-auth.test.js` | 29 tests (4 added). |

## Verification

| Check | Result |
|---|---|
| `voice-auth.test.js` | 29 / 29 pass |
| `voice.test.js` | 47 / 47 pass |
| `phase0-security.test.js` | 61 / 61 pass |
| Live health payload | `speakable_languages: ["en"]` against `tts_languages` of four |
| A licence-refused voice on disk | unlocks nothing |
| An unaudited voice on disk, audit enforced | unlocks nothing |
| Synthesis for an uninstalled language | 422, not 500 |
