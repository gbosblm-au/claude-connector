# claude-connector v13.4.0

Kokoro Sentence-Boundary Streaming Spec v1 — build order step 2 (§10.2):
the incremental synthesis endpoint. Plus two defect fixes that had to come
first, because the new route sits directly on top of both of them.

---

## 1. DEFECT: `/voice/synthesize/stream` threw on every request

**Severity: the streamed playback feature has never worked in production.**

`src/routes/voice.js` line 1081 passed `sampleRate: streamRate` to
`synthesizeProsodyStream`. The only `streamRate` in the file was a `const`
declared inside the `/voice/prosody/analyse` handler — a different function
scope. Reading it from the stream route raised `ReferenceError: streamRate is
not defined` on every streamed request.

### Why nobody noticed

The throw landed inside the route's own `try` block, which is there to report
mid-stream faults in band because the status line has already been sent. So the
`ReferenceError` was caught and written out as
`{"type":"error","error":"tts_failed"}`. The client's documented contract on
seeing that line is to fall back to `POST /voice/synthesize` — which works.

The result: streamed playback degraded silently and correctly into exactly the
single-shot behaviour the feature was built to replace. No 500, no crash, no
log line naming the cause.

### Verification

Proved statically before and after, with an AST scope walk over the file rather
than by reading it:

```
before:  streamRate declared in an enclosing scope? false
after:   streamRate declared in an enclosing scope? true
```

### Fix

`streamRate` is now resolved in the stream route via `parseSampleRate()`, the
same way `/voice/synthesize` resolves it, so the two routes cannot answer a
per-tenant sample rate differently.

---

## 2. DEFECT: `/voice/synthesize/stream` was unreachable by the gateway

**Severity: independent of defect 1, and equally fatal.**

`SELF_AUTHENTICATED_ROUTES` in `src/middleware/mcpAuth.js` listed
`/voice/health`, `/voice/transcribe` and `/voice/synthesize` as `exact`
entries. `/voice/synthesize/stream` shipped in v12.53.0 and was never added.

The production caller is the Gateway Service, which holds the per-tenant
`RAILWAY_RESTORE_TOKEN` and not `MCP_API_KEY`. `mcpAuthMiddleware` is mounted at
`server-http.js:1818`, long before `registerVoiceRoutes(app)` at line 4438, so
every streamed request was answered **401 before any voice code ran**.

Verified at runtime against the real middleware:

```
/voice/synthesize          selfAuth= true
/voice/synthesize/stream   selfAuth= false     <-- the defect
```

### Fix

`/voice/synthesize/stream` and `/voice/synthesize/incremental` are both added as
`exact` entries.

The `exact` policy is deliberately retained rather than replaced with a
`/voice/` prefix. A prefix would exempt every future voice route from
authentication by default, which is the failure mode TNX-C-001 was about. The
cost of that correctness is that each new voice route must be added
deliberately. Confirmed no prefix leak was introduced:

```
/voice/synthesize/evil     selfAuth= false
/voice/anything            selfAuth= false
```

---

## 3. NEW: `POST /voice/synthesize/incremental`

### What it is for

`/voice/synthesize/stream` already streams per-phrase audio, but it takes the
**whole reply** as input. The client therefore cannot call it until generation
has finished, which is spec §1 exactly: the overlap it buys is real and it is
entirely inside the connector. The sync offset the user hears is untouched.

This route accepts a reply that is **still growing**, so synthesis of sentence N
overlaps *generation* of sentence N+1 (FR-2.1).

### Contract

```
POST /voice/synthesize/incremental
  { text, offset, sequence, final, voice, language, speed, sample_rate }

  -> 200 application/x-ndjson
     {"type":"phrase","sequence":0,"index":0,"sample_rate":24000,
      "pause_after_ms":120,"profile":"neutral","length_scale":1,
      "audio_base64":"..."}
     {"type":"end","offset":42,"sequence":3,"phrases":3,"bytes":12345,
      "deferred":false,"final":false}
```

The client holds the accumulated text and `offset`; the response's
`end.offset` is what it sends next time.

### Why stateless, and why an offset rather than an index

Holding the cursor server-side would need a session store keyed by reply, with
an eviction policy for abandoned replies, and it would not survive the
reconnect it most needs to survive.

Statelessness makes EC-6 (duplicate stream events from a retry or reconnect) a
non-problem rather than a case to handle: replaying a call with the same offset
returns the same phrases and the same new offset. That is **NFR-4.1 obtained
structurally instead of by a dedup table**.

An offset rather than a phrase index because boundaries are not stable under
growth. `Dr.` looks sentence-final until ` Smith` arrives, so phrase 3 in one
call can be a different span in the next; indexing a list that can be re-cut
skips or repeats. The offset addresses the text, which only grows.

### Behaviours worth knowing

- **An empty result is a 200, not a 422.** The client fires on a cheap local
  trigger and this route is the authority on whether a phrase is complete, so
  "nothing new yet" is an ordinary outcome. Answered as an `end` line with
  `phrases: 0` so the client has one response shape to parse. Deliberately not
  a 204, which cannot carry the cursor.
- **An out-of-range offset is clamped, not refused.** A client that has drifted
  should re-sync and keep speaking, not lose the rest of the reply to a 422.
- **The cursor advances only for phrases actually written.** An abort halfway
  through a batch leaves the cursor at the last delivered phrase, so the
  undelivered text is re-split next call rather than skipped.
- **The error line carries the cursor.** Without it a client that got three
  phrases and then a fault could not tell whether to resume at phrase 4 or
  replay from the start, and replaying speaks the same sentence twice.

### Rate limiting

A dedicated `incrementalLimiter` rather than the shared `voiceLimiter`, which is
20/minute and sized for one call per reply. This route is called once per batch
of complete phrases, so one long reply can legitimately spend a dozen requests
and two replies would exhaust the shared bucket — the user would hear one reply
and then silence.

The work per reply is unchanged; only the number of requests it is divided into
has changed. Synthesis concurrency is bounded independently in the phrase pool
(FR-2.2), which is the limit that actually protects the CPU.

`VOICE_INCREMENTAL_RATE_MAX`, default 240. Keyed identically to `voiceLimiter`
so a caller cannot get a second budget by moving between routes.

---

## 4. NEW: `finalPosition` option on `synthesizeProsodyStream`

The last phrase of a call is normally given `position: 'final'`, which shapes a
falling, sentence-ending contour. That is correct for a whole reply and wrong
for one slice of a reply still being generated: every slice would land on a
closing cadence and the reply would sound like a run of unrelated
announcements.

**Defaults to `true`**, which is what every existing caller already gets, so
this cannot change what `/voice/synthesize/stream` produces.

---

## Configuration added

| Key | Default | Purpose |
|---|---|---|
| `VOICE_INCREMENTAL_RATE_MAX` | 240 | Requests/minute for the incremental route |
| `VOICE_MAX_PHRASE_LENGTH` | 300 | Hard phrase ceiling (FR-1.3) |
| `VOICE_RUNT_FLOOR` | 3 | Absorb shorter fragments (FR-3.3) |
| `VOICE_MARKDOWN_STRIPPING` | on | Strip markdown before synthesis (EC-2) |
| `VOICE_DEFER_IN_CODE_BLOCK` | on | Defer inside fenced blocks (EC-1) |

---

## Tests

`src/tests/voice-incremental.test.js` — 13 tests, run with
`npm run test:incremental`.

Two layers, deliberately separated:

- **The protocol**, driven purely through `splitStream` with no HTTP and no
  audio. This is where the real risk lives: the offset contract must deliver
  every character of a growing reply exactly once under arbitrary delta
  boundaries. Includes a character-by-character drive, which is the harshest
  boundary case there is.
- **The route**, mounted on express and driven over a live socket with only the
  synthesiser mocked. The gate, limiter, body parsing, status codes, NDJSON
  framing and cursor accounting are all shipping code, not a re-description of
  it.

Mutation-tested three ways — forcing `finalPosition` true, over-advancing the
cursor, dropping the sequence offset. Each mutation failed exactly one test.

`test:incremental` is deliberately **not** added to `test:voice-all`: this file
needs `--experimental-test-module-mocks` and the aggregate script does not pass
it. Verified that without the flag the file fails, which is why it gets its own
entry.

### Regression

`npm run test:stream-split` — 22/22 unchanged.
