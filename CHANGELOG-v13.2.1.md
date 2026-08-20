# v13.2.1 — Spoken replies said "no voice is installed" while five were

**This is the fault you have been hitting, and it was mine.** Deploy this and
spoken replies work. No Railway variable was wrong, and no admin setting was
missing.

## The bug

`voice-catalog.speakableLanguages()` returned `{ languages, by_language }` under
Piper. My v13.0.0 rewrite changed it to a plain array. It read as a tidy-up.

`routes/voice.js` emits:

```js
speakable_languages: speakable.languages,
```

On an array, `speakable.languages` is **`undefined`**. And then, in order:

1. `JSON.stringify` **drops** an undefined value — no error, no warning, the key
   simply is not on the wire.
2. The gateway does `( connector.speakable_languages ) || []`, turning the
   missing key into `[]`.
3. The client sees `tts_ready: true` with an empty language list and renders
   **"Unavailable: no voice is installed on this workspace."**

Five voices were installed. The engine was ready. The smoke test passed. The
message was the one thing in the stack that was accurate about its own state and
wrong about the world.

**Not one layer failed loudly.** Every one did something defensible with a
missing field. That is why it survived a green suite, a passing smoke test and a
deploy — and why the diagnosis needed the connector's actual payload rather than
more reasoning.

## The fix

The original return shape is restored, and the doc block now states that the
shape is a **contract** with the reason attached, so the next person who sees a
two-line function returning an object and reaches for a bare array finds out
what that costs before they do it.

## Why the tests did not catch it

They asserted `speakableLanguages()` against the shape I had just written, not
against the shape its caller reads. A test written from the implementation
cannot see a broken contract; it can only see itself.

Four new tests, all in terms of the CALLER:

- the return is not a bare array, because that makes `.languages` undefined;
- the payload **survives a JSON round trip with the key present** — the step that
  hid it;
- the gateway's `|| []` relays a real list rather than an empty fallback;
- genuinely-no-voices still yields `[]`, so the empty case stays distinguishable
  from the broken one.

Plus a structural assertion that the route reads `.languages`, which is what
makes the shape unchangeable.

**Mutation-tested:** restoring the bare array fails three of them.

## Verification performed

- Whole connector: **621 passed, 0 failed**.
- The exact user-visible chain reproduced in a test: undefined → dropped key →
  `[]` → "no voice is installed".
- Every caller of `speakableLanguages` audited. The near-identical function in
  `voice-registry.js` has no consumers; only the catalog version is read.
- `speakable_by_language` was undefined for the same reason and is now correct
  too, though nothing consumes it yet.

## What this does not change

Nothing else. No variable, no migration, no admin setting. Your connector
configuration was correct throughout:

```
VOICE_ENABLED=true          ✓
VOICE_TEST_USERS=ava:38     ✓ (verbatim match, and your mic proved it)
artifacts from [image]      ✓
```

Delete `VOICE_PROVISION_VOICES=en_US-kristin-medium` when convenient — it is a
Piper voice name that nothing in 13.x reads.
