// src/tests/voice-stream-split.test.js
//
// Kokoro Sentence-Boundary Streaming Spec v1 — Sections 6.1, 6.2, 7, 8.
// Build order step 1 (§10.2): the splitter, with no audio.

import test   from 'node:test';
import assert from 'node:assert/strict';

import { splitStream, splitDefaults } from '../voice/voice-stream-split.js';

const FENCE = '`'.repeat(3);
const texts = (r) => r.phrases.map(p => p.text);

// ===========================================================================
// FR-1 — boundary detection
// ===========================================================================

test('FR-1.1: splits at terminal punctuation followed by whitespace', () => {
  assert.deepEqual(texts(splitStream('Hello there. How are you? Fine! ')),
    ['Hello there.', 'How are you?', 'Fine!']);
});

test('FR-1.1: a boundary is not taken until whitespace CONFIRMS it', () => {
  // Without this, "3.14" splits after the stop, and a stream that has produced
  // "end." but not the following space is cut at a point the next token may
  // turn out to continue.
  assert.deepEqual(texts(splitStream('It costs 3.14 dollars. ')),
    ['It costs 3.14 dollars.']);
  assert.deepEqual(texts(splitStream('Done.')), [],
    'a terminal with nothing after it is not yet a boundary');
});

test('FR-1.2: closing quotes and brackets stay with their phrase', () => {
  // Cutting at the stop would strand the quote to open the next phrase.
  assert.deepEqual(texts(splitStream('He said "stop." Then left. ')),
    ['He said "stop."', 'Then left.']);
  assert.deepEqual(texts(splitStream('(See below.) Next. ')),
    ['(See below.)', 'Next.']);
});

test('FR-1.2: an ellipsis is one boundary, not three', () => {
  assert.deepEqual(texts(splitStream('Wait... really? ')), ['Wait...', 'really?']);
});

test('abbreviations do not end a sentence', () => {
  // A missed boundary costs one phrase of latency. A FALSE boundary cuts a
  // sentence in half and speaks the halves separately, which is audible.
  assert.deepEqual(texts(splitStream('Dr. Smith arrived. ')), ['Dr. Smith arrived.']);
  assert.deepEqual(texts(splitStream('Ring Mr. Le Mon today. ')), ['Ring Mr. Le Mon today.']);
  assert.deepEqual(texts(splitStream('J. Smith called. ')), ['J. Smith called.'],
    'a single initial is a name far more often than a one-letter sentence');
});

test('FR-1.3 / EC-4: a runaway clause is force-split at the ceiling', () => {
  const long = 'word '.repeat(200);
  const r = splitStream(long, { final: true });
  assert.ok(r.phrases.length > 1, 'the ceiling forced a split');
  for (const p of r.phrases) {
    assert.ok(p.text.length <= splitDefaults().maxPhraseLength,
      'no phrase exceeds the ceiling');
    assert.ok(!/^ord|wor$/.test(p.text), 'and no word was broken');
  }
});

// ===========================================================================
// FR-3 — runts and the trailing partial
// ===========================================================================

test('FR-3.1: a trailing partial is held, never dropped', () => {
  const r = splitStream('Done. And then I');
  assert.deepEqual(texts(r), ['Done.']);
  assert.equal(r.pending.trim(), 'And then I', 'the partial is reported, not lost');
});

test('FR-3.2: the final flush always speaks the last sentence', () => {
  // The guarantee that a reply never ends mid-thought because the last clause
  // had no full stop.
  const r = splitStream('Done. And then I', { final: true });
  assert.deepEqual(texts(r), ['Done.', 'And then I']);
});

test('FR-3.3: a fragment below the floor is absorbed, not spoken alone', () => {
  const r = splitStream('The audit matters. A. Then more text here. ', { final: true });
  assert.ok(!texts(r).includes('A.'), 'a two-character fragment is not its own utterance');
});

// ===========================================================================
// The stateless offset contract
// ===========================================================================

test('incremental growth speaks each sentence exactly once', () => {
  const deltas = [
    'The real cost is not', ' the licence but the audit.',
    ' Most teams budget for', ' the software.', ' Then they discover the rest',
  ];
  let text = '';
  let offset = 0;
  const spoken = [];

  for (const d of deltas) {
    text += d;
    const r = splitStream(text, { offset });
    spoken.push(...texts(r));
    offset = r.consumed;
  }
  spoken.push(...texts(splitStream(text, { offset, final: true })));

  assert.deepEqual(spoken, [
    'The real cost is not the licence but the audit.',
    'Most teams budget for the software.',
    'Then they discover the rest',
  ]);
  // Every character of the reply is accounted for, none spoken twice.
  assert.equal(spoken.join(' ').replace(/\s+/g, ' '),
    text.replace(/\s+/g, ' ').trim());
});

test('the offset addresses TEXT, not a phrase index', () => {
  // A phrase index would be wrong: boundaries are not stable under growth.
  // "Dr." looks like a sentence end until " Smith" arrives, so phrase 3 in one
  // call can be a different span in the next, and indexing into a list that can
  // be re-cut causes a repeat or a skip.
  const partial = 'Ring Dr.';
  const grown = 'Ring Dr. Smith today. ';
  assert.deepEqual(texts(splitStream(partial)), [],
    'the abbreviation is not spoken early');
  assert.deepEqual(texts(splitStream(grown)), ['Ring Dr. Smith today.'],
    'and the grown text yields one correct phrase');
});

test('NFR-4.1 / EC-6: replaying a call is idempotent', () => {
  const text = 'One. Two. Three. ';
  const a = splitStream(text, { offset: 0 });
  const b = splitStream(text, { offset: 0 });
  assert.deepEqual(a.phrases, b.phrases);
  assert.equal(a.consumed, b.consumed,
    'a retry or reconnect cannot double-speak');
});

test('consumed never runs ahead of what was actually spoken', () => {
  // If it did, the trailing partial would be skipped and a sentence lost.
  const r = splitStream('First. Second. And a partial', { offset: 0 });
  assert.equal(r.consumed, 'First. Second.'.length);
  assert.equal(r.pending.trim(), 'And a partial');
});

// ===========================================================================
// EC-1 — code blocks and tables
// ===========================================================================

test('EC-1: an UNCLOSED fence defers everything after it', () => {
  const t = 'Here is code.\n' + FENCE + 'js\nconst x = 1. Not a sentence.\n';
  const r = splitStream(t);
  assert.deepEqual(texts(r), ['Here is code.']);
  assert.equal(r.deferred, true, 'and says it deferred, rather than going quiet');
});

test('EC-1: a closed fence is ONE phrase, and does not swallow its neighbours', () => {
  // The bug this caught: skipping over a protected region lets the phrase that
  // began before it run past it, so the code and the sentence after it are
  // spoken as a single utterance with the code in the middle.
  const t = 'Here is code.\n' + FENCE + 'js\nconst x = 1.\n' + FENCE + '\nAnd after. ';
  const out = texts(splitStream(t));
  assert.equal(out.length, 3, 'before, block, after -- three phrases');
  assert.equal(out[0], 'Here is code.');
  assert.equal(out[2], 'And after.');
  assert.ok(out[1].includes('const x = 1'), 'the block is intact and separate');
});

test('EC-1: a markdown table is one phrase, not one per row', () => {
  const out = texts(splitStream('Intro here.\n| a | b |\n| - | - |\nAfter. '));
  assert.equal(out.length, 3);
  assert.equal(out[0], 'Intro here.');
  assert.equal(out[2], 'After.');
});

// ===========================================================================
// EC-2 — markdown stripping
// ===========================================================================

test('EC-2: markdown syntax is stripped before synthesis', () => {
  assert.deepEqual(texts(splitStream('The **audit** is the _real_ cost. ')),
    ['The audit is the real cost.']);
  assert.deepEqual(texts(splitStream('## Heading here. ')), ['Heading here.']);
  assert.deepEqual(texts(splitStream('- A bullet point. ')), ['A bullet point.']);
});

test('EC-2: a link keeps its text and loses its URL', () => {
  // A URL read aloud character by character is worse than silence about it.
  const out = texts(splitStream('See [the docs](https://tenax.io/a/b) now. '));
  assert.deepEqual(out, ['See the docs now.']);
  assert.ok(!out[0].includes('https'));
});

// ===========================================================================
// Robustness
// ===========================================================================

test('never throws, whatever it is handed', () => {
  for (const input of [undefined, null, 0, 42, {}, [], true, NaN, '']) {
    const r = splitStream(input);
    assert.deepEqual(r.phrases, []);
    assert.equal(r.consumed, 0);
  }
});

test('an offset past the end is clamped rather than trusted', () => {
  const r = splitStream('Short. ', { offset: 9999 });
  assert.deepEqual(r.phrases, []);
  assert.ok(r.consumed <= 'Short. '.length);
});

test('NFR-5.1: the tuneables are configurable, not hardcoded', () => {
  const d = splitDefaults();
  assert.equal(d.maxPhraseLength, 300);
  assert.equal(d.runtFloor, 3);
  assert.equal(d.markdownStripping, true);
  assert.equal(d.deferSynthesisInCodeBlock, true);

  const tight = splitStream('a'.repeat(120) + ' more text here. ',
    { final: true, config: { maxPhraseLength: 50 } });
  assert.ok(tight.phrases.length > 1, 'a lower ceiling splits sooner');
});

test('whitespace between phrases is consumed, never spoken', () => {
  const r = splitStream('One.\n\n   Two. ');
  assert.deepEqual(texts(r), ['One.', 'Two.']);
  for (const p of r.phrases) {
    assert.equal(p.text, p.text.trim(), 'no phrase carries leading or trailing space');
  }
});
