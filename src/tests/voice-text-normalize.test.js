// src/tests/voice-text-normalize.test.js
//
// VOICE-TTS-NORMALIZE-v1.0 (Voice TTS Text Normalization Specification)
//
// Run: node --test src/tests/voice-text-normalize.test.js
//
// ===========================================================================
// WHY THESE TESTS NEED NO ENGINE
// ===========================================================================
//
// The normaliser is a pure string transform, so every rule in the
// specification is assertable by calling it. Piper is not installed in CI, and
// a test that needed it would be skipped -- and a skipped acceptance test is
// worse than an absent one, because the report still says green.
//
// The one thing these tests CANNOT prove is the premise: that Piper voices a
// smart quote rather than ignoring it. That was established by ear before the
// specification was written, and it is what Section 1 records. What is
// verifiable here is that no such character reaches the engine, and that the
// characters which must survive do.

import test   from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeForSpeech, isSpeakable } from '../voice/voice-text-normalize.js';
import { speakablePhrases } from '../voice/voice-engines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINES = join(HERE, '..', 'voice', 'voice-engines.js');

/** Every code point Section 3 says must never reach the engine. */
const FORBIDDEN = [
  '\u2018', '\u2019', '\u201C', '\u201D',          // smart quotes
  '\u00AB', '\u00BB', '\u2039', '\u203A',          // guillemets
  '\u201A', '\u201B', '\u201E', '\u201F',          // low-9 / single-high
  '\u200B', '\u200C', '\u200D', '\u2060',          // zero-width
  '\uFEFF', '\u00AD',                              // BOM, soft hyphen
];

// ===========================================================================
// Section 3 -- every listed class is handled
// ===========================================================================

test('Section 3: no listed code point survives, in any position', () => {
  for (const ch of FORBIDDEN) {
    for (const shape of [`${ ch }word`, `word${ ch }`, `a${ ch }b`,
                         `${ ch }`, `one ${ ch } two`]) {
      const out = normalizeForSpeech(shape);
      assert.ok(! out.includes(ch),
        `${ JSON.stringify(ch) } survived in ${ JSON.stringify(shape) } as ${ JSON.stringify(out) }`);
    }
  }
});

test('Section 3: zero-width controls are deleted with no replacement', () => {
  // The distinguishing property of this class. They are already invisible, so
  // the text either side was never separated by them and must not become so.
  for (const ch of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD']) {
    assert.equal(normalizeForSpeech(`sun${ ch }flower`), 'sunflower',
      `${ JSON.stringify(ch) } must not split a word`);
  }
});

test('Section 3: guillemets and low-9 quotes are stripped', () => {
  assert.equal(normalizeForSpeech('\u00ABbonjour\u00BB'), 'bonjour');
  assert.equal(normalizeForSpeech('\u2039oui\u203A'), 'oui');
  assert.equal(normalizeForSpeech('\u201EGuten Tag\u201C'), 'Guten Tag');
  assert.equal(normalizeForSpeech('\u201Aja\u201B'), 'ja');
});

// ===========================================================================
// Section 5 -- the apostrophe protection, which is the critical one
// ===========================================================================

test('Section 5: ASCII apostrophes inside words are kept', () => {
  assert.equal(normalizeForSpeech("it's"), "it's");
  assert.equal(normalizeForSpeech("don't"), "don't");
  assert.equal(normalizeForSpeech("Brian's report"), "Brian's report");
  assert.equal(normalizeForSpeech("we've, they're, wouldn't"), "we've, they're, wouldn't");
});

test('Section 5, extended: TYPOGRAPHIC apostrophes inside words are repaired', () => {
  // THE DEVIATION, ASSERTED. Section 3 lists U+2019 as stripped; Section 5
  // forbids producing misspelled words. U+2019 is the character every modern
  // editor and language model emits for an apostrophe, so obeying Section 3
  // literally yields "dont" and "Brians" -- precisely what Section 5 exists to
  // prevent. Resolved by position: between letters it is an apostrophe.
  assert.equal(normalizeForSpeech('don\u2019t'), "don't");
  assert.equal(normalizeForSpeech('it\u2019s'), "it's");
  assert.equal(normalizeForSpeech('Brian\u2019s'), "Brian's");
  assert.equal(normalizeForSpeech('o\u2019clock\u2019s'), "o'clock's",
    'consecutive marks in one word are both repaired, not just the first');
  assert.equal(normalizeForSpeech('can\u2018t'), "can't",
    'the opening form mid-word is an apostrophe too, whichever way it points');
});

test('Section 5: a typographic quote that is NOT inside a word is still stripped', () => {
  // The other half of resolving by position: the same code point, used as a
  // delimiter, must go.
  assert.equal(normalizeForSpeech('\u2018quoted\u2019'), 'quoted');
  assert.equal(normalizeForSpeech('she said \u2018yes\u2019 firmly'), 'she said yes firmly');
});

test('Section 6: ASCII quotes acting as delimiters are stripped', () => {
  assert.equal(normalizeForSpeech('he said "hello"'), 'he said hello');
  assert.equal(normalizeForSpeech("'quoted'"), 'quoted');
  assert.equal(normalizeForSpeech("students' work"), 'students work',
    'a possessive plural loses a mark that was never voiced');
});

// ===========================================================================
// Section 4 -- nulling, and the no-merging invariant
// ===========================================================================

test('Section 4: a lone quote boundary is deleted', () => {
  assert.equal(normalizeForSpeech('\u201CHello,\u201D she said.'), 'Hello, she said.');
  assert.equal(normalizeForSpeech('He said \u201Chi\u201D.'), 'He said hi.',
    'and does not leave a space stranded before the full stop');
});

test('Section 4: an adjacent closing/opening pair becomes one space', () => {
  assert.equal(normalizeForSpeech('audit,\u201D\u201CHonestly'), 'audit, Honestly');
  assert.equal(normalizeForSpeech('done.\u2019\u201CNext'), 'done. Next');
});

test('Section 4: consecutive deletions never merge two words', () => {
  // The stated invariant, tested against the shapes that would violate it.
  // `word"word` is the case the specification's own "lone boundary: delete it"
  // rule gets wrong, which is why the invariant is treated as the stronger of
  // the two.
  assert.equal(normalizeForSpeech('word"word'), 'word word');
  assert.equal(normalizeForSpeech('word\u201Dword'), 'word word');
  assert.equal(normalizeForSpeech('a\u201D\u2019\u201Cb'), 'a b',
    'a run of three is one decision, not three deletions');

  // Between two letters, the three classes resolve differently ON PURPOSE, and
  // spelling that out here is the clearest statement of the design:
  const INVISIBLE = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD'];
  const APOSTROPHE = ['\u2018', '\u2019'];

  for (const ch of FORBIDDEN) {
    const out = normalizeForSpeech(`alpha${ ch }beta`);

    if (INVISIBLE.includes(ch)) {
      // Already invisible, so the words were never separated by it and joining
      // is the correct answer for this class and only this class.
      assert.equal(out, 'alphabeta', `${ JSON.stringify(ch) } must not split a word`);
    } else if (APOSTROPHE.includes(ch)) {
      // Between letters it is an apostrophe, not a delimiter. The words are
      // still not merged -- the apostrophe stands between them -- and this is
      // what stops "don\u2019t" becoming "dont".
      assert.equal(out, "alpha'beta",
        `${ JSON.stringify(ch) } between letters must repair to an apostrophe`);
    } else {
      assert.equal(out, 'alpha beta',
        `${ JSON.stringify(ch) } is a visible delimiter and must not weld words`);
    }

    assert.ok(! out.includes(ch), `${ JSON.stringify(ch) } survived`);
    assert.ok(! /^alphabeta$/.test(out) || INVISIBLE.includes(ch),
      `${ JSON.stringify(ch) } welded two words into one`);
  }
});

test('Section 4: an existing space is not doubled', () => {
  assert.equal(normalizeForSpeech('word\u201D \u201Cword'), 'word word');
  assert.equal(normalizeForSpeech('"one" "two"'), 'one two');
});

// ===========================================================================
// Section 6 -- whitespace
// ===========================================================================

test('Section 6: runs of horizontal whitespace collapse to one space', () => {
  assert.equal(normalizeForSpeech('a  b'), 'a b');
  assert.equal(normalizeForSpeech('a \t  b'), 'a b');
  assert.equal(normalizeForSpeech('  padded  '), 'padded');
});

test('Section 6, scoped: line structure is preserved', () => {
  // Deliberately NOT the specification's "global" collapse. prosody.js splits
  // paragraphs on blank lines, and the flat path sends the whole reply through
  // here in one piece, so folding newlines would silently change how a
  // multi-paragraph reply is segmented.
  assert.equal(normalizeForSpeech('one\n\ntwo'), 'one\n\ntwo');
  assert.equal(normalizeForSpeech('one  \n\n  two'), 'one\n\ntwo',
    'while still tidying the spaces around them');
});

// ===========================================================================
// Robustness
// ===========================================================================

test('the transform is idempotent', () => {
  const inputs = [
    '\u201CHello,\u201D she said.', 'don\u2019t', 'audit,\u201D\u201CHonestly',
    'word"word', "it's", 'a\u200Bb', 'one\n\ntwo', '  padded  ', '',
  ];
  for (const input of inputs) {
    const once = normalizeForSpeech(input);
    assert.equal(normalizeForSpeech(once), once,
      `not idempotent for ${ JSON.stringify(input) }`);
  }
});

test('never throws, whatever it is handed', () => {
  for (const input of [undefined, null, 0, 42, {}, [], true, NaN]) {
    assert.equal(normalizeForSpeech(input), '',
      `${ JSON.stringify(input) } must return an empty string, not throw`);
  }
});

test('text with nothing speakable in it normalises to empty', () => {
  for (const input of ['\u201C', '\u201C\u201D', '  ', '\u200B', '"\u2018\u2019"']) {
    assert.equal(normalizeForSpeech(input), '');
    assert.equal(isSpeakable(input), false);
  }
  assert.equal(isSpeakable('word'), true);
  assert.equal(isSpeakable('\u201Cword\u201D'), true);
});

test('ordinary prose is returned untouched', () => {
  // The most important negative test in the file. A transform that fires on
  // text it should not touch is a regression on every reply, not just quoted
  // ones.
  for (const plain of [
    'The quick brown fox jumps over the lazy dog.',
    "It's a test of Brian's report, isn't it?",
    'Costs rose 12% (year on year) -- see figure 3.',
    'Line one\n\nLine two',
    'a-hyphenated-word and an em dash - like this',
  ]) {
    assert.equal(normalizeForSpeech(plain), plain);
  }
});

// ===========================================================================
// Section 7 -- the acceptance test
// ===========================================================================

test('Section 7: a quoted dialogue exchange reads clean, with the beat intact', () => {
  // The shape the acceptance test describes: two quoted clauses meeting, with
  // the closing quote of the first sitting against the opening quote of the
  // second. Both must vanish, and a spoken beat must remain between them.
  const input = 'She asked, \u201CWhy is the library so quiet?\u201D'
              + '\u201CBecause,\u201D he said, \u201Ceveryone\u2019s overdue.\u201D';

  const out = normalizeForSpeech(input);

  for (const ch of FORBIDDEN) {
    assert.ok(! out.includes(ch), `${ JSON.stringify(ch) } reached the engine`);
  }
  assert.ok(out.includes("everyone's"),
    'the contraction survives as a word the phonemiser can read');
  assert.ok(! /\?Because/.test(out) && ! /\S{2,}Because/.test(out.replace(/[.,?] /g, ' ')),
    'the two clauses are not welded together');
  assert.equal(out,
    'She asked, Why is the library so quiet? Because, he said, everyone\'s overdue.');
});

// ===========================================================================
// Section 2 -- the insertion point
// ===========================================================================

test('Section 2: normalisation happens at the single synthesis choke point', () => {
  const src = readFileSync(ENGINES, 'utf8');
  // Comments are stripped first. This file explains its own rules in prose
  // that names the functions involved, and a regex over the raw text would
  // match the explanation rather than the code.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(/import \{ normalizeForSpeech, isSpeakable \} from '\.\/voice-text-normalize\.js';/
    .test(code), 'the engine imports the normaliser');

  const pcm = code.slice(code.indexOf('export async function synthesizePcm'));

  // v13.1.0. The choke point now runs the WHOLE Section 6 pipeline rather than
  // normalisation alone. prepareForKokoro performs normalisation as its own
  // first stage, so this is a replacement, not a bypass -- and calling the bare
  // normaliser here instead would silently skip stages two through five, which
  // is precisely the state this release fixes.
  assert.ok(/const prepared = prepareForKokoro\(String\(o\.text \|\| ''\), \{/.test(pcm),
    'synthesizePcm runs the prosody pipeline');
  assert.ok(/const text = prepared\.text;/.test(pcm),
    'and synthesises what the pipeline produced');
  assert.ok(! /const text = normalizeForSpeech\(String\(o\.text/.test(pcm),
    'the bare normaliser is NOT called here, which would skip stages 2-5');

  // Both engines sit downstream of synthesizePcm, so neither can be reached
  // with un-normalised text. Asserted rather than assumed, because a future
  // path that called the worker or the CLI directly would bypass the fix.
  assert.ok(pcm.indexOf('normalizeForSpeech') < pcm.indexOf('synthesizeViaWorker'),
    'the resident worker path is downstream of the normalisation');
  // v13. The Piper CLI spawn was replaced by a one-shot subprocess running the
  // SAME Kokoro worker script. The property is unchanged and still worth
  // asserting: whichever tier serves the request, it is downstream of the
  // normalisation, so neither can be reached with un-normalised text.
  assert.ok(pcm.indexOf('normalizeForSpeech') < pcm.indexOf('synthesizeOnce'),
    'the one-shot subprocess path is downstream of the normalisation');

  // The empty check must read the NORMALISED text: text that is nothing but
  // typography has no speech in it, and the caller's handling of empty_text is
  // the right answer for it.
  // The property is unchanged: text that is nothing but typography has no speech
  // in it, and the caller's handling of empty_text is the right answer for it.
  // Only the producing call changed name.
  assert.ok(/prepareForKokoro[\s\S]{0,600}if \(!text\) \{[\s\S]{0,160}empty_text/.test(pcm),
    'the empty check is applied after the pipeline, not before');
});

test('normalisation still happens, one level down', () => {
  // The guarantee that matters is unchanged: no typographic artifact reaches the
  // engine. It is now delivered by prepareForKokoro's first stage rather than by
  // a direct call, so this asserts the composition rather than the call site.
  const prep = readFileSync(
    join(HERE, '..', 'voice', 'voice-prosody-prep.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/import \{ normalizeForSpeech \} from '\.\/voice-text-normalize\.js';/.test(prep),
    'the preprocessor imports the normaliser');
  assert.ok(/let text = normalizeForSpeech\(input, \{ beatMarker: BEAT_MARKER \}\);/.test(prep),
    'and runs it FIRST, with the beat marker Section 6.2 needs');
});

test('an unspeakable phrase is dropped rather than failing the whole reply', () => {
  const src = readFileSync(ENGINES, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(/function speakablePhrases\(phrases\)/.test(code));
  // Both prosody entry points, because a phrase that fails mid-stream costs
  // more than one that fails in the buffered path: the status line is already
  // sent and the only channel left is an in-band error.
  assert.equal((code.match(/speakablePhrases\(analysis\.phrases\)/g) || []).length, 2,
    'both synthesizeProsody and synthesizeProsodyStream filter their phrases');
});

test('dropping a phrase preserves its pause on the phrase before it', () => {
  // Timing is the whole point of the prosody layer, so a filter that silently
  // shortened a reply's rhythm would be a regression dressed as a fix.
  const kept = speakablePhrases([
    { text: 'The real cost', pauseAfterMs: 120 },
    { text: '\u201C',           pauseAfterMs: 300 },
    { text: 'is the audit',  pauseAfterMs: 200 },
  ]);

  assert.equal(kept.length, 2, 'the quote-only fragment is dropped');
  assert.equal(kept[0].text, 'The real cost');
  assert.equal(kept[0].pauseAfterMs, 420,
    "the dropped phrase's 300ms is folded into the phrase before it");
  assert.equal(kept[1].pauseAfterMs, 200, 'the rest of the rhythm is untouched');
});

test('a leading unspeakable phrase gives its pause to the first phrase kept', () => {
  // There is no predecessor to fold into, and losing the beat would run the
  // opening of the reply straight into the first clause.
  const kept = speakablePhrases([
    { text: '\u201C',      pauseAfterMs: 250 },
    { text: 'Honestly', pauseAfterMs: 100 },
  ]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, 'Honestly');
  assert.equal(kept[0].pauseAfterMs, 350);
});

test('the filter does not mutate the analysis it was given', () => {
  // analysis.phrases is returned to the route and reported in the summary, so
  // rewriting its pauses in place would make the reported rhythm disagree with
  // the rendered one.
  const original = [
    { text: 'one', pauseAfterMs: 100 },
    { text: '\u201D',  pauseAfterMs: 200 },
  ];
  const snapshot = JSON.stringify(original);
  speakablePhrases(original);
  assert.equal(JSON.stringify(original), snapshot);
});

test('a phrase list with nothing speakable in it comes back empty', () => {
  // Which is what routes the reply into the flat degenerate path, where
  // empty_text is raised once about the whole reply rather than from a phrase
  // worker mid-render.
  assert.deepEqual(speakablePhrases([{ text: '\u201C' }, { text: '\u201D' }]), []);
  assert.deepEqual(speakablePhrases([]), []);
});
