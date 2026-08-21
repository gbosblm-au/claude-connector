# v13.3.0 - Sentence-boundary splitter (streaming spec, build step 1)

Implements Sections 6.1, 6.2 and 8 of the Kokoro Sentence-Boundary Streaming
spec. **Nothing is wired yet and no behaviour changes** - Section 10.2 puts the
splitter first, with no audio, precisely so phrase emission can be proven before
anything depends on it.

## Section 10.1 and 10.3 answered from the code, before building

The spec requires the hook point be confirmed first. It is, and the answers
narrow the work considerably:

| | Question | Answer |
| --- | --- | --- |
| **Q1** | Shape of the current streaming emission | The client calls `speakRow()` **after the reply completes**. This is the whole bug. |
| **Q2** | How Kokoro is invoked | `synthesizeProsodyStream` **already** does bounded parallel synthesis (`mapWithLimit`) with **ordered commit** via a pending map. |
| **Q3** | Who owns playback | The browser. `speakStreamed` already schedules per-phrase audio through Web Audio. |

**So Sections 6.3 and 6.4 largely exist one level down.** FR-2.2 (bounded pool)
and NFR-4.2 (ordered commit) are satisfied by code shipped in v12.53.0. What is
missing is that the pipeline does not *start* until the reply is finished.

That is worth stating plainly, because Section 6 reads as a greenfield build and
building it as written would duplicate a working worker pool.

## The stateless contract, and why it is an offset

The caller holds the accumulated text and a character **offset** marking how much
has been committed to audio. Each call re-splits from that offset and returns the
newly-complete phrases plus how many characters they consumed.

A phrase **index** is the obvious choice and is wrong. Boundaries are not stable
under growth: `Dr.` looks like a sentence end until ` Smith` arrives, so phrase 3
in one call can be a different span in the next. Indexing into a list that can be
re-cut causes a repeat or a skip. A character offset addresses the *text*, which
only ever grows.

That gives NFR-4.1 (idempotency) for free - replaying a call returns the same
phrases and consumes the same characters, so a retry or reconnect cannot
double-speak (EC-6). Asserted, not assumed.

## Two bugs found by testing, not by reading

**A protected region must force phrase edges at BOTH its boundaries.** The first
implementation *skipped over* code blocks and tables, which is the obvious
reading - and it let the phrase that began before the block run straight past it,
so a code block and the sentence after it were spoken as **one utterance with the
code in the middle**. Now: text before the block, the block, and text after are
three separate phrases.

**The ceiling was not hard.** FR-1.3 calls `maxPhraseLength` a hard ceiling, but
it only applied when no boundary was found. A 136-character sentence sailed
through a 50-character limit, because a boundary *had* been found and the ceiling
check sat in the other branch. The point of the limit is to bound the synthesis
job, not merely to rescue the case where punctuation never arrives.

## Deliberate restraint on abbreviations

The list is short, and every entry is a promise that the word is **never**
sentence-final. `etc.` and `al.` are absent because they end sentences regularly.

A missed boundary costs one phrase of extra latency. A false boundary cuts a
sentence in half and speaks the halves separately, which is audible and wrong.
The asymmetry sets the bias.

## Why this is separate from prosody.js analyse()

`analyse()` segments a **complete** reply: paragraphs, register detection,
per-phrase rate and pause profiles, backwards runt merging - all of which need the
whole text to be correct. Run on a partial stream it would re-decide earlier
phrases as more text arrived.

This does the one thing decidable from a prefix: where a sentence has definitely
ended. Emitted phrases still go through the existing synthesis path, which applies
`analyse()` per phrase.

## Tests

`src/tests/voice-stream-split.test.js`, 22 tests, registered as
`npm run test:stream-split` and added to `test:voice-all`.

Covers FR-1.1 through FR-3.3, the offset contract, idempotency, EC-1 (code blocks
and tables), EC-2 (markdown), EC-4 (the ceiling), EC-6 (replay), and robustness
against non-string input.

**Mutation-tested**, three ways - skip protected regions instead of bounding them,
remove the final flush, remove abbreviation handling. Each fails two tests.

## Verification performed

- New suite: **22 passed, 0 failed**.
- `npm run test:voice-all`: **286 passed** (264 before).
- Whole connector: **643 passed, 0 failed**.

## Next, and the decision it rests on

Build step 2 is the incremental endpoint - approved as the cleaner shape over one
request per sentence. Shape:

```
POST /voice/synthesize/incremental
  { text, offset, final }  ->  NDJSON: phrase audio + new offset
```

Stateless, so it needs no session storage on the connector and survives a
reconnect. Then the gateway proxy, then the client aggregator that feeds it while
the LLM streams.

**Nothing in this release affects the running system.** The splitter is imported
by nothing.
