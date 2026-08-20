# v13.2.1 — Spoken replies said "no voice is installed" while five were

THE PRODUCTION FAULT. voice-catalog.speakableLanguages() returned
{ languages, by_language } under Piper; the v13.0.0 rewrite made it a plain array.
routes/voice.js emits `speakable_languages: speakable.languages`, which on an
array is undefined — JSON.stringify DROPS it, the gateway turns the missing key
into [] via `|| []`, and the client renders "Unavailable: no voice is installed"
with tts_ready TRUE and five voices installed.

Not one layer failed loudly. Every one did something defensible with a missing
field, which is why it survived a green suite, a passing smoke test and a deploy.

The tests missed it because they asserted the shape I had just written rather than
the shape the caller reads. The four new ones are written in terms of the CALLER,
including a JSON round trip — the step that hid it. Mutation-tested: restoring the
bare array fails three.

621/621. No variable, migration or admin setting changes.

Full detail in `CHANGELOG-v13.2.1.md`.

# v13.2.0 — The engine artifacts survive a redeploy

The model and voice bundle are BAKED INTO THE IMAGE. A fresh deploy speaks
immediately: no manual provisioning, no boot-time download, no network at start.

THE BUG UNDERNEATH THE BUG. v13.0.0 ran `mkdir -p /data/voice/kokoro` and pointed
the engine there. On a platform that mounts a volume at /data, THE MOUNT SHADOWS
EVERYTHING THE IMAGE PUT THERE — so baking to that path would have produced files
that exist in the layer and are unreachable at runtime, failing exactly like the
problem being fixed. The artifacts go to /opt/kokoro/models instead.

Resolution is layered: explicit env -> volume, if present -> the image copy. So
the baked copy is a FLOOR, not a ceiling: a fresh deploy works immediately, and an
operator can drop a newer model on the volume without rebuilding.
VOICE_KOKORO_MODEL/VOICES are deliberately no longer set in the image, because
pinning them defeats the mechanism; the test asserting they WERE set is inverted.

The build proves what it ships: curl -f catches an HTTP error, size floors catch
a truncated transfer that arrived with a 200, and a real Kokoro() load catches
weights that download cleanly and fail to parse. It also asserts all five offered
voices are in the bundle. The &&/|| chain was EXECUTED against truncated and valid
artifacts rather than reasoned about — `exit 1` in a subshell exits the subshell,
not the build.

Costs ~330 MB of image and a build dependency on GitHub releases. Both deliberate.

/voice/health and the smoke test now report WHICH layer supplied each artifact.

Full detail in `CHANGELOG-v13.2.0.md`.

# v13.1.1 — Four review findings, including two more pieces of dead scaffolding

THE WHOLE CONNECTOR SUITE IS GREEN FOR THE FIRST TIME: 611 passed, 0 failed. The
`render-tools > download contract` failure called "pre-existing" in three
consecutive releases is FIXED, not re-categorised.

1. THE EMPTY DOCUMENT BUG. With CONNECTOR_URL unset, document rendering returned
   `ok: true, partial: true` — so every consumer checking `ok` and `download_url`
   saw a SUCCESS with no link and presented an unopenable document. The old shape
   assumed an operator standing next to the box; on a hosted connector the
   downloads directory is unreachable to the user. Now a failure naming the
   variable. Reproduce: unset CONNECTOR_URL and render. FLAGGED: edit-tools has
   the same condition and the opposite contract, with a passing test defending
   it. That needs an owner.

2. VOICE_TTS_TENANT_VOICE was reported in /voice/health and read by NOTHING — an
   operator could set it, see it echoed back as confirmation, and get no change.
   Now wired, scoped so it cannot override the installed-voice check.

3. PER-ASSISTANT VOICE DID NOT SHIP and cannot as specified: there is no
   assistant-profile entity in this platform. Per-request and per-tenant shipped,
   which is what was asked for.

4. THE 16 kHz CONTROL IS NOT BROKEN. Verified end to end; the 422 fires only for
   rates not on the offered list.

The smoke test now renders a realistic PARAGRAPH and reports a realtime factor,
so the CPU decision rests on a measured number rather than an assumption. I still
have no number — it needs your hardware.

The model is NOT in the image: `npm run voice:provision` is a required step.

Full detail in `CHANGELOG-v13.1.1.md`.

# v13.1.0 — The prosody preprocessor was never wired in

A DEFECT RELEASE. v12.55.0 built the Section 6 preprocessor and wired it into
nothing; the v13.0.0 swap never wired it either. Through v13.0.2 it had 34
passing tests and was DEAD CODE. Rules 2-5 were inert: no contour shaping, no
dialogue beats, no emphasis, no lexicon — and markdown links reached the engine
intact, so a direct API caller would have had URLs read aloud. Browser traffic
was protected only by accident, because the client sends innerText from rendered
HTML.

Every test tested the transform. NONE could see that nobody called it. Six new
assertions now can; restoring the v13.0.2 wiring fails three of them.

YOUR EMPHASIS DECISION, RESOLVED. Configured ON as decided, ineffective on the
espeak path, and REPORTED as such: /voice/status returns
`emphasis: {configured, effective, requires}`. Reporting only the first makes the
switch look broken; only the second hides that an operator asked for something.

THE G2P CEILING, STATED. The HF Space that demos Kokoro runs misaki. This
connector runs espeak-ng — the same phonemiser CLASS Piper used. The acoustic
model is a large step up; the front end is not, and the difference is audible on
proper nouns and initialisms. The realism gain is real but NARROWER than the
Space implies. /voice/status now names the running front end so this is read off
a health endpoint rather than discovered on first listen.

Audio WILL change: replies now get terminal punctuation and phrases are
contoured. Listen before opening it up.

Full detail in `CHANGELOG-v13.1.0.md`.

# v13.0.2 — The Compare/Off equivalence made structural, and a deploy audit

Supersedes v13.0.1.

The AC5/N4 assertion kept failing on CORRECT code. It protects a real property —
Compare's flat half must be the same call Off mode makes — but it was asserted
first as a regex pinning an exact argument list, then as a string comparison of
two extracted call sites. Adding `sampleRate` to BOTH sides preserved the
equivalence and still failed the first; the second was fragile in the same
direction.

The problem was in the CODE. Three separate synthesize() call sites each carried
their own copy of the same argument list, and three copies cannot be kept equal
by review. They now share one `renderFlat()` closure, so the equivalence is a
property of the code rather than a claim about it. Mutation-tested three ways,
including the benign case the old assertion got wrong twice.

DEPLOY AUDIT: removed a redundant espeak-ng Docker layer (it was already
installed since the Piper era) and annotated the real one, because a reviewer
pruning Piper leftovers would reasonably assume it was one — it is not, since
phonemizer SHELLS OUT to the espeak-ng binary. Confirmed all Kokoro artifacts
land in the runtime stage rather than a discarded build stage. Retargeted three
stale VOICE_PIPER_* comment references. Verified the gateway/connector status
contract in both directions, including the legacy fallback.

Note before deploying: an admin must have voice enabled on their own account
before they can configure the tenant default.

Full detail in `CHANGELOG-v13.0.2.md`.

# v13.0.1 — The sample rate actually reaches the engine

Closes an integration gap in v13.0.0 that no single package's tests could see.

The registry could express an output rate, the gateway stored a per-tenant rate
and injected it, the client offered a control to set it -- and the connector's
route NEVER READ `body.sample_rate`. Three green suites and a feature that did
nothing.

parseSampleRate() now runs on both synthesis routes, returning three distinct
things: undefined (nothing asked for), a number, or false (refused, 422 already
sent). Collapsing the first and last would let an unsupported rate silently
produce audio at some other rate -- the one failure an admin cannot diagnose by
listening.

Threaded to EVERY engine call, not just the common one: Compare, the prosody
fallback and the flat path are three separate calls, and a rate applied to two of
them yields a reply whose halves are at different rates. Threaded down to each
phrase worker too, or the WAV would declare one rate and contain another.

Also: /voice/status gains a labelled `voices` array so an admin picks between
"Bella (US, female)" and "Emma (UK, female)" rather than af_bella and bf_emma.
voices_installed is unchanged; clients gate on it.

A test failed on CORRECT code: the Compare/Off equivalence was asserted against a
literal argument list, so adding sampleRate to both sides preserved the property
and still failed. Rewritten as an equivalence between the two call sites.

No gateway or client change required. Full detail in `CHANGELOG-v13.0.1.md`.

# v13.0.0 — Kokoro-82M replaces Piper (SPEC-KOKORO-001, the cutover)

BREAKING. Piper is deleted. This is the release that changes what a user hears;
deploy behind a listening check and rebuild the image.

Kokoro-82M (Apache-2.0) replaces Piper (GPL-3.0). One model plus one bundle of
style vectors instead of one .onnx per voice, so voice selection is a per-call
parameter rather than a model path. Five voices: af_bella (default), af_nicole,
af_heart, bf_emma, af_aoede. Output 24 kHz native, 16 kHz selectable.

WHAT YOU LOSE: Vietnamese, Chinese and Japanese speech. Kokoro has no Vietnamese
voice at any version and none of the five deployed voices is ja or zh.
TTS_LANGUAGES drops to ['en']. The loss is visible — the client's existing
languageSpeakable() gate hides the Speak button rather than letting it fail.

THE GPL BOUNDARY DID NOT RETIRE WITH PIPER. kokoro-onnx phonemises via
phonemizer/espeak-ng, and espeak-ng is GPL-3.0. The dependency moved from model
to phonemiser, so /opt/kokoro is still its own venv and every boundary test was
retargeted rather than removed.

Caught before shipping: the Dockerfile still built a Piper venv, and
`npm run voice:smoke` imported a deleted module — the one command an operator
runs after deploying would have crashed on import.

Voice suites 236/236. Whole connector 592/593, the one failure pre-existing and
unrelated. NOTHING has been run against a real Kokoro model — run
`npm run voice:smoke` before opening it to users.

Full detail in `CHANGELOG-v13.0.0.md`.

# v12.57.0 — Kokoro worker supervisor and the two-tier fallback (part 3)

CHANGES NO BEHAVIOUR. Adds `kokoro-worker-supervisor.js` and a `--once` mode on
the worker, wired into nothing. Last of the additive releases.

THE FINDING. Under Piper there were always TWO routes to audio: the resident
worker and a fresh binary per utterance, which is why a sick worker cost latency
rather than speech. Retiring Piper deletes the second route, so the resident
worker would become a single point of failure for ALL speech. Section 7.1's
subprocess mode is therefore kept as tier two rather than discarded after
evaluation — the same script with `--once`, sharing one `synthesisRequest()` so
the tiers cannot diverge.

The refusal list is where the tiers are reasoned about: `synthesis_failed`,
`kokoro_import_failed` and `no_audio` are deliberately absent, because all three
can be true of a sick worker while a fresh process works perfectly.

Carried over rather than relearned: an interpreter guess that is wrong by
construction is worse than no guess, so `kokoroPython()` returns EMPTY rather
than `python3`. And a SIGKILL is named as the likely OOM killer rather than
reported as "exited null".

Full detail in `CHANGELOG-v12.57.0.md`.

# v12.56.0 — Kokoro voice registry and resident worker (SPEC-KOKORO-001, part 2)

CHANGES NO BEHAVIOUR. Adds `voice-registry.js`, `kokoro_worker.py` and
`requirements-kokoro.txt`, wired into nothing. TTS still runs on Piper. The swap
is atomic, so the provable parts land first.

Registry: af_bella (default), af_nicole, af_heart, bf_emma, af_aoede. Note the
UNDERSCORE — the decision was written `af-bella`, and a hyphen is an unknown voice.

SPEC CORRECTIONS IN CODE. Section 8 models one `.pt` per voice; kokoro-onnx ships
one bundle of style vectors, so a row is bundle+name. Section 10's "Kokoro locks
voices at model load" is false for kokoro-onnx — `create()` takes `voice=` per
call, so switching is free and the reload machinery it describes is unnecessary.
Section 7.2 asks for FastAPI; this reuses the proven stdio supervisor instead, to
avoid a second authenticated route into synthesis. Revisit if a GPU budget lands.

THE GPL BOUNDARY DID NOT RETIRE WITH PIPER. kokoro-onnx phonemises via
phonemizer/espeak-ng, and espeak-ng is GPL-3.0. The dependency moved from model to
phonemiser, so every boundary discipline still applies.

TTS_LANGUAGES drops to ['en']. Kokoro has no Vietnamese voice at any version.
Accepted per the 2026-08-19 decision that Piper was a POC.

16 kHz admin switch verified numerically: a 10 kHz tone is suppressed to ≈ −50 dB
rather than aliasing into the speech band, on both the scipy and numpy paths.

Full detail in `CHANGELOG-v12.56.0.md`.

# v12.55.0 — Kokoro prosody preprocessor (SPEC-KOKORO-001 Phase 2, part 1)

CHANGES NO BEHAVIOUR. Adds `src/voice/voice-prosody-prep.js` and a `beatMarker`
option on the normaliser, and wires neither into the synthesis path. TTS still
runs on Piper, unchanged. The Piper→Kokoro swap is atomic — half a swap is a mute
platform — so the parts provable without a model land first, separately.

THE FINDING. Section 4's markup (`[word](+2)`, `[Kokoro](/kˈOkəɹO/)`) is a MISAKI
feature, not a Kokoro one. kokoro-onnx phonemises via phonemizer/espeak-ng, which
has no markdown handling: hand espeak `[best](+2)` and it says "plus two" out
loud. Markup does not degrade to plain, it degrades to WORSE than plain. Every
markup rule is therefore gated on the G2P actually in use, defaulting to espeak
(what a bare `pip install kokoro-onnx` gives you), with suppression reported
rather than hidden.

Section 6.2 could not be implemented as written: normalise-then-prep means the
beat is already a plain space by the time the preprocessor runs, so rule 3 was
unreachable. The beat replacement is now a parameter; the default is unchanged, so
existing callers and the Piper path are untouched.

Three defects found in implementation: a doubled comma on `audit,”“Honestly` (the
author's comma IS the beat); a markdown-link hazard where `[docs](https://x.io)`
would be read as phonemes and the URL spoken aloud; and a suppression notice that
fired on all traffic rather than on actual occurrence.

Full detail, including the three mutation tests and what is NOT verified, in
`CHANGELOG-v12.55.0.md`.

# v12.54.3 — Strip typographic artifacts from TTS input

Implements VOICE-TTS-NORMALIZE-v1.0. Connector only; no gateway, plugin or UI
change, no migration, no new environment variable.

Smart quotes, guillemets, low-9 quotes and zero-width controls were reaching
Piper's phonemiser, which either voices them as a glyph or absorbs them into the
neighbouring word and mis-stresses it. New pure transform
`src/voice/voice-text-normalize.js`, applied in `synthesizePcm()` — the one
choke point both the flat path and the prosody layer reach, and which sits
upstream of BOTH the resident worker and the CLI spawn.

DEVIATION, STATED PLAINLY. Section 3 lists U+2019 as stripped; Section 5 forbids
producing misspelled words. U+2019 is what every modern editor and language
model emits for an apostrophe, so obeying Section 3 literally turns `don’t` into
`dont` — exactly what Section 5 exists to prevent. U+2018 and U+2019 are
therefore resolved BY POSITION: between two letters they are an apostrophe and
become ASCII `'`; anywhere else they are a delimiter and are stripped.

Also: Section 4's no-merging invariant is treated as stronger than its
lone-boundary rule, so `word"word` becomes `word word` rather than `wordword`,
and the real dialogue shape `audit,”“Honestly` becomes `audit, Honestly` rather
than welding the clauses. Whitespace collapse is horizontal only, so paragraph
splitting in `prosody.js` is unaffected.

Also: a quote-only phrase that survives segmentation would have normalised to
nothing and failed the WHOLE reply with a 422, because `empty_text` is on the
not-worth-retrying list. `speakablePhrases()` drops such phrases in both prosody
entry points, folding their pause into the phrase before them.

Full detail, including the three mutation tests and what is not covered, in
`CHANGELOG-v12.54.3.md`.

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

---

# Claude Connector - Changelog

## v12.36.0 - 2026-08-06

### Neural Core scans are manual trigger only

The boot scan is removed, so a deployment no longer spawns brain_scan.py. The
dormant debounce scheduler (scheduleBrainScan) and its RESCAN_TRIGGERS allowlist
are deleted so automatic scanning cannot return by accident. GET /brain-data no
longer scans implicitly when the data file is absent; only ?rescan=1 does.

Scans now run from POST /brain-scan, GET /brain-data?rescan=1, an operator-run
POST /volume-restore, or script_execute. /brain-data/status reports the policy
and the provenance of the last scan.

Also fixes an authentication bypass in POST /brain-scan: the token guard failed
OPEN when neither DOCUMENT_DOWNLOAD_TOKEN nor RAILWAY_RESTORE_TOKEN was set, so
any unauthenticated caller could spawn Python on the volume. It now fails closed,
compares in constant time, and no longer 500s on a duplicated query parameter.

Pairs with ts-client-gateway v5.81.0, which removes the 15-minute cron. Full
detail: CHANGELOG-v12.36.0.md.

## v12.22.0 - 2026-07-24

### Volume snapshot and restore endpoints

GET /volume-snapshot, POST /volume-restore and GET /volume-snapshot/status
replace the manual pre/post-deployment Railway console tar commands, and are
driven from the WordPress Connector Snapshots screen.

Also fixes three defects found while wiring them in: route modules were
registered after the catch-all 404 so POST /provision and GET /export-all were
unreachable; owner-mode /provision accepted any api_key, which was an
unauthenticated arbitrary file write once the route became reachable; and both
/provision path containment checks used prefix matching rather than a path
boundary. Full detail: CHANGELOG-v12.22.0.md.

## v12.21.0 - 2026-07-21

### Structural manifest fragment registration

module_write now auto-registers every .md module as a manifest fragment in
references/manifest/; skill_compile, skill_recompile, and skill_load_specialist
read the merged MANIFEST + MANIFEST_APPEND + fragment view live; brain_scan.py
v2.1.0 catalogs fragment-registered modules with provenance and inferred paths.
Full detail: CHANGELOG-v12.21.0.md.

## v12.4.0 - 2026-06-09

### Add skill_recompile MCP tool (mid-session delta recompile)

**Problem:** When a conversation's topic shifts significantly mid-session, the initial
`skill_compile` selection becomes stale. `skill_load_specialist` requires knowing the
exact module ID. `skill_compile` cannot safely be re-called mid-session (designed for
session-start only). The context window is append-only so prior skill content cannot
be removed. The result: Claude operates on the wrong module selection for the new topic.

**Solution:** `skill_recompile` — a mid-session delta recompiler.

**Behaviour:**
- Accepts `new_query` (required), `context_hint`, `person_name`, and `current_modules`.
- Runs the full 6-layer dispatcher (person prior, mandatory, lexical, tag-web, adjacency,
  budget) for the new query.
- Computes the delta: modules selected for the new topic that are NOT in `current_modules`.
- Returns ONLY the delta module content (never CORE — already in context) plus metadata.
- When the delta is empty (all selected modules already loaded), returns a no-op with a note.
- The caller appends the returned content to the active session context; it supersedes
  conflicting guidance from earlier-loaded modules for the new topic.

**Design rationale (append-only context window):**
The fundamental constraint is that prior context cannot be purged. `skill_recompile`
works within this constraint: it does not attempt to replace prior skill content but
adds the correct new content for the shifted topic. The response note explicitly states
that returned modules supersede earlier conflicting guidance for the new topic.

**Changes:**

`src/tools/skill-modular.js`
- Added `skillRecompileToolDefinition` and `handleSkillRecompile` (exported).
- Uses the shared `compileSkill()` and `personPriorLayer()` functions — no dispatcher
  duplication.
- Falls back to `ownerAvaDir` for module files in tenant mode when per-client path
  is missing (handles shared module pool architecture).

`src/server-http.js`
- Imports `skillRecompileToolDefinition` and `handleSkillRecompile`.
- Added to static TOOLS array (under `SKILL_MODULAR_ENABLED` guard).
- Added `"skill_recompile"` to `MODULAR_TOOL_NAMES` set in ListToolsRequestSchema handler.
- Added to dynamic modular tools list.
- Added `case "skill_recompile"` to CallToolRequestSchema switch.
- Version comment updated to v12.4.0.

`package.json`
- Version bumped to 12.4.0.

**No new environment variables required.**
**No Railway redeploy changes beyond the version update.**




### Add ts_gateway_session_init MCP tool (tenant mode)

**Problem:** The `ts_gateway_session_init` MCP tool was referenced in system prompts
generated by the TrueSource Client Gateway WP plugin but did not exist in the
connector's tool list. Claude called it at session start, received a tool-not-found
error, and aborted the entire init sequence. The consequence was that `skill_compile`
was never called and client sessions fell back to default Claude behaviour without
any specialist modules loaded.

**Changes:**

`src/tools/gatewaySessionInit.js` (new file)
- Implements `ts_gateway_session_init` MCP tool.
- Advertised only when `TS_CLIENT_MODE=tenant`.
- Calls `POST {gateway_url}/session-init` with `api_key` and `tenant_id`.
- On success: returns `session_authenticated: true`, `tenant_id`, `display_name`,
  `tier`, `session_id`, and a `next_steps` array that explicitly names
  `skill_compile` as required and non-deferrable. Claude receives the correct
  instruction twice: once from the system prompt and once from this tool response.
- On gateway unavailable: returns a degraded result with instructions to continue
  using the connector tools directly. Non-fatal: session proceeds with reduced
  capability rather than hard-failing.

`src/server-http.js`
- Imports `tsGatewaySessionInitToolDefinition` and `handleTsGatewaySessionInit`.
- Tool added to TOOLS array behind `isTenantMode()` guard (owner mode unaffected).
- Switch case added: `case "ts_gateway_session_init"`.
- Version header updated to v12.3.0.

`package.json`
- Version bumped to 12.3.0.

**WP plugin requirement:** Gateway plugin v2.5.0 must be deployed. That version adds
the `/wp-json/ts-gateway/v1/session-init` REST endpoint this tool calls, and fixes
the generated system prompt to include `profile_read` and `skill_compile`.

**Deployment:** Standard Railway redeploy. No new environment variables required.
Existing `TS_CLIENT_MODE`, `TS_TENANT_GATEWAY_URL`, `TS_CLIENT_API_KEY`, and
`TS_TENANT_ID` env vars are all that is needed.


## v10.0.3 - Conversations category and context-aware session retrieval

**Release date**: 15 May 2026

### Added

* **`conversations` category** added to the memory schema. Stores per-conversation episodic records as individually addressable entries with unique timestamp-based keys (`conv_{YYYY-MM-DD}_{HH-MM-SS}`). Unlike the `session` category (named slots with upsert semantics), `conversations` entries are append-only by design: each conversation writes a new key.

* **`context_hint` parameter on `memory_get_session_context`**. Optional string (max 512 chars). When supplied, triggers an FTS5 relevance search over the `conversations` category and returns the top-N most topically relevant prior conversations instead of the most-recent-N recency sort. This enables ambient surfacing of prior work without requiring the caller to know which keys exist.

* **`conversations_limit` parameter on `memory_get_session_context`**. Optional integer (1-20, default 5). Controls how many conversation entries are returned in either relevance or recency mode.

* **`conversations_mode` field in `memory_get_session_context` response**. Returns `"relevance"` when `context_hint` was used, `"recency"` otherwise. Allows callers to audit which retrieval path was active.

* **`context_hint` and `conversations_limit` in the session context tool definition** (`definitions.js`). Full input schema and description updated so Claude reliably passes `context_hint` based on the current topic.

* **`conversations` added to all six tool category enums** in `definitions.js` and `schemas/index.js`. All existing tools (write, read, search, delete, list, session context) now accept and validate `conversations` as a valid category value.

* **FTS5 fallback in `memory_get_session_context`**. If the FTS query is rejected by SQLite (e.g. malformed tokens after sanitisation), the handler transparently falls back to recency ordering rather than throwing.

* **6 new unit tests** in `memory.test.js` covering: write/read to conversations category, array shape in session context, context_hint relevance ranking, conversations_limit cap, empty-hint fallback, and entry_count isolation.

### Changed

* `memory_get_session_context` response shape: `context.conversations` is now an **array** of entry objects (not a key-value object). Each entry includes the full row metadata and value.
* `memorySessionContextSchema` now accepts `context_hint` (string, max 512) and `conversations_limit` (integer 1-20, default 5).
* `CATEGORY_CAPS` in `memory-get-session-context.js` no longer lists `conversations`; that category is handled by a dedicated retrieval block with context-hint branching logic.

### No other files modified.

### Migration notes

No schema migration required. The `conversations` category is a new value in an existing TEXT column; existing rows are unaffected. Skills and workflows that do not supply `context_hint` continue to work exactly as before. Skills that wish to surface relevant prior conversations should pass `context_hint` with 3-6 topic keywords extracted from the current user message.

---

## v10.0.0 - Persistent Memory MCP integration

**Release date**: 15 May 2026

### Added

* **Six new MCP tools** implementing the TrueSource Persistent Memory MCP TDD v1.0:
  * `memory_write` - upsert by `(category, key)` with optional `ttl_days`, `tags`, `confidence`, `source_session`.
  * `memory_read` - filter by category, key, or tags (at least one required).
  * `memory_search` - SQLite FTS5 full-text search ranked by BM25, supports prefix and phrase queries.
  * `memory_delete` - hard delete by `(category, key)`.
  * `memory_list` - metadata summary with `by_category` counts, optional `include_value`.
  * `memory_get_session_context` - curated session bundle with category caps (skills ≤ 20, contacts ≤ 10, session ≤ 5).
* **SQLite storage** with WAL mode, FTS5 virtual table, three sync triggers, and three secondary indexes - all maintained in `/data/memory.db` on the Railway persistent volume.
* **TTL expiry worker** (`setInterval`, default 1-hour cadence, configurable via `TTL_WORKER_INTERVAL_MS`).
* **Bearer-token auth gating** via the new `MEMORY_AUTH_TOKEN` environment variable. When unset, the six memory tools are omitted from the advertised tool list and the rest of the connector functions unchanged.
* **`GET /memory/admin/dump`** endpoint - full corpus JSON export protected by `MEMORY_AUTH_TOKEN`.
* **`memory` block in `/health` response** showing entry count and per-category breakdown.
* **13 new unit tests** (`src/tools-memory/memory.test.js`) covering upsert semantics, validation, FTS, TTL exclusion, and category caps. Run with `npm run test:memory`.

### Changed

* `railway.toml` now declares a persistent volume named `claude-connector-data` mounted at `/data`. Existing deployments need to attach a volume; ephemeral installs are unaffected.
* `/health` payload now reports `version: "10.0.0"` and includes the `memory` snapshot.
* Node engine bumped to `>=20.0.0` to match `better-sqlite3` requirements.

### Dependencies added

* `better-sqlite3 ^11.3.0`
* `express-rate-limit ^7.4.0`
* `uuid ^10.0.0`
* `zod ^3.23.8`

### Migration notes

Set `MEMORY_AUTH_TOKEN` in Railway Variables (`npm run gen-memory-token` produces one). Existing deployments without the variable continue to operate exactly as v9.0.0 with the six memory tools silently disabled. No backward-incompatible API changes.

---

## v9.0.0 - Statistical analysis & ML toolkit (previous release)

(unchanged content)

## v8.0.0 - Google Calendar, Sheets, Slack, Teams, Webhook receiver

(unchanged content)

## v7.0.0 - TrueSource outreach direct send

(unchanged content)
