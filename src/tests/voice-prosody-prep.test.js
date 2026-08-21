// src/tests/voice-prosody-prep.test.js
//
// SPEC-KOKORO-001 v1.1, Section 6 (Prosody Preprocessor)
//
// Run: node --test src/tests/voice-prosody-prep.test.js
//
// ===========================================================================
// THE PROPERTY THAT MATTERS MOST HERE
// ===========================================================================
//
// Every markup rule in Section 4 is a MISAKI feature, not a Kokoro one.
// kokoro-onnx phonemises through phonemizer/espeak-ng, which has no markdown
// handling: hand it `[best](+2)` and espeak says "plus two" out loud.
//
// So the single most important class of assertion in this file is NEGATIVE --
// that no markup escapes onto the espeak path. A missing emphasis hint is an
// absent improvement. A spoken bracket is a broken voice.

import test   from 'node:test';
import assert from 'node:assert/strict';

import { prepareForKokoro, BEAT_MARKER, kokoroPunctuation }
  from '../voice/voice-prosody-prep.js';
import { normalizeForSpeech } from '../voice/voice-text-normalize.js';

/** Any residue that would be voiced by espeak if it leaked through. */
const MARKUP_RESIDUE = /[[\]]|\(\s*[+-]\d|\*\*|\(\/|\u0001/u;

// ===========================================================================
// Section 6.2 -- the ordering fix
// ===========================================================================

test('Section 6.2: the beat survives normalisation as a marker', () => {
  // The defect this parameter exists for. With the default marker the beat is a
  // plain space by the time the preprocessor sees it, and `word""word` is then
  // indistinguishable from `word word` -- so Section 6.1 rule 3 is unreachable.
  const asSpace = normalizeForSpeech('word\u201D\u201Cword');
  const asMarker = normalizeForSpeech('word\u201D\u201Cword', { beatMarker: BEAT_MARKER });

  assert.equal(asSpace, 'word word', 'the default is unchanged from v12.54.3');
  assert.ok(asMarker.includes(BEAT_MARKER), 'the marker carries the beat forward');
  assert.notEqual(asSpace, asMarker);
});

test('Section 6.2: the default beat marker is still a space', () => {
  // Back-compatibility is the point. Every existing caller, and the Piper path
  // for as long as it exists, must be untouched by this parameter.
  for (const input of ['word\u201D\u201Cword', '\u201CHello,\u201D she said.', "don't"]) {
    assert.equal(normalizeForSpeech(input), normalizeForSpeech(input, {}));
    assert.equal(normalizeForSpeech(input), normalizeForSpeech(input, { beatMarker: '' }),
      'an empty marker falls back to the space rather than deleting the beat');
  }
});

test('no beat marker ever reaches the output', () => {
  for (const input of ['word\u201D\u201Cword', 'a\u201D\u2019\u201Cb', 'audit,\u201D\u201CHonestly']) {
    for (const g2p of ['espeak', 'misaki']) {
      const out = prepareForKokoro(input, { g2p });
      assert.ok(! out.text.includes(BEAT_MARKER),
        `marker leaked for ${ JSON.stringify(input) } on ${ g2p }`);
    }
  }
});

// ===========================================================================
// Section 6.1 rule 3 -- dialogue beats become punctuation
// ===========================================================================

test('Section 6.1 rule 3: a beat becomes punctuation, not a gap', () => {
  const out = prepareForKokoro('word\u201D\u201Cword');
  assert.equal(out.text, 'word, word.');
  assert.equal(out.beats, 1);
});

test("a beat does NOT stack on punctuation the author already wrote", () => {
  // The real dialogue shape: the closing quote follows a comma. Appending our
  // own gives `audit,, Honestly`, which Kokoro reads as two beats -- the reply
  // stumbles exactly where it was meant to breathe.
  assert.equal(prepareForKokoro('audit,\u201D\u201CHonestly, no.').text,
    'audit, Honestly, no.');
  assert.equal(prepareForKokoro('done.\u201D\u201CNext').text, 'done. Next.');
  assert.equal(prepareForKokoro('really?\u201D\u201CYes').text, 'really? Yes.');
});

test('every character the beat can become is one Kokoro interprets', () => {
  // Section 4.4: the punctuation inventory IS the control surface. A beat
  // rendered as a character outside it would be silently dropped by the
  // tokenizer, putting the words back together.
  for (const beat of [',', '…', ';']) {
    const out = prepareForKokoro('word\u201D\u201Cword', { beat });
    assert.ok(kokoroPunctuation().includes(beat));
    assert.ok(out.text.includes(beat), `beat ${ beat } did not survive`);
  }
});

// ===========================================================================
// Section 6.1 rule 4 -- emphasis, and the espeak gate
// ===========================================================================

test('Section 6.1 rule 4: bold becomes a stress hint on the misaki path', () => {
  const out = prepareForKokoro('The **audit** is the real cost', { g2p: 'misaki' });
  assert.equal(out.text, 'The [audit](+2) is the real cost.');
  assert.equal(out.tagged, 1);
  assert.deepEqual(out.suppressed, []);
});

test('CRITICAL: no stress markup reaches the espeak path', () => {
  // If this fails, users hear "plus two" mid-sentence.
  const out = prepareForKokoro('The **audit** is the real cost', { g2p: 'espeak' });
  assert.equal(out.text, 'The audit is the real cost.');
  assert.equal(out.tagged, 0);
  assert.ok(! MARKUP_RESIDUE.test(out.text));
  assert.deepEqual(out.suppressed, ['emphasis_needs_misaki_g2p'],
    'and the suppression is reported rather than hidden');
});

test('the asterisks come off on espeak even with emphasis disabled', () => {
  // espeak reads `**`. Stripping is not part of the emphasis feature; it is
  // unconditional cleanup.
  for (const emphasis of [true, false]) {
    const out = prepareForKokoro('The **audit** is real', { g2p: 'espeak', emphasis });
    assert.ok(! out.text.includes('*'), `asterisks survived with emphasis=${ emphasis }`);
  }
});

test('emphasis defaults to on, per the platform decision', () => {
  assert.equal(prepareForKokoro('a **b** c', { g2p: 'misaki' }).tagged, 1);
  assert.equal(prepareForKokoro('a **b** c', { g2p: 'misaki', emphasis: false }).tagged, 0);
});

test('multi-word bold is NOT tagged', () => {
  // misaki's stress syntax attaches to one token. `[three whole words](+2)`
  // parses as a pronunciation override with "+2" as the phoneme string, which is
  // the spoken-bracket failure by another route.
  const out = prepareForKokoro('the **real cost** rose', { g2p: 'misaki' });
  assert.equal(out.text, 'the real cost rose.');
  assert.equal(out.tagged, 0);
});

test('the default G2P is the safe one', () => {
  // A bare `pip install kokoro-onnx` gives espeak. Guessing misaki by default
  // would emit markup into the phonemiser that speaks it.
  assert.equal(prepareForKokoro('a **b** c').g2p, 'espeak');
  assert.equal(prepareForKokoro('a **b** c', { g2p: 'nonsense' }).g2p, 'espeak');
});

// ===========================================================================
// Section 6.1 rule 5 -- pronunciation lexicon
// ===========================================================================

test('Section 6.1 rule 5: a lexicon term gets an override on misaki', () => {
  const out = prepareForKokoro('Tenax is the platform',
    { g2p: 'misaki', lexicon: { Tenax: 't\u02c8\u025bn\u00e6ks' } });
  assert.equal(out.text, '[Tenax](/t\u02c8\u025bn\u00e6ks/) is the platform.');
  assert.deepEqual(out.overrides, ['Tenax']);
});

test('CRITICAL: no pronunciation markup reaches the espeak path', () => {
  const out = prepareForKokoro('Tenax is the platform',
    { g2p: 'espeak', lexicon: { Tenax: 't\u02c8\u025bn\u00e6ks' } });
  assert.equal(out.text, 'Tenax is the platform.');
  assert.ok(! MARKUP_RESIDUE.test(out.text));
  assert.deepEqual(out.suppressed, ['lexicon_needs_misaki_g2p']);
});

test('the lexicon is empty by default', () => {
  // A wrong phoneme string is a confidently mispronounced brand name, which is
  // worse than the mispronunciation it was meant to fix, and nothing here can
  // validate an IPA string.
  const out = prepareForKokoro('Tenax is the platform', { g2p: 'misaki' });
  assert.equal(out.text, 'Tenax is the platform.');
  assert.deepEqual(out.overrides, []);
});

test('a lexicon entry that would break out of its own markup is refused', () => {
  // `/` closes the phoneme string; brackets close the label. An entry
  // containing either would corrupt everything after it in the utterance.
  for (const bad of [{ 'a/b': 'x' }, { 'a[b': 'x' }, { Tenax: 'a/b' }, { Tenax: '' }]) {
    const out = prepareForKokoro('Tenax a/b a[b here', { g2p: 'misaki', lexicon: bad });
    assert.deepEqual(out.overrides, [], `accepted a dangerous entry: ${ JSON.stringify(bad) }`);
  }
});

test('a lexicon term is tagged once, not on every mention', () => {
  // Repeating the override on every mention in a long reply makes the voice
  // sound like it is spelling the word out.
  const out = prepareForKokoro('Tenax and Tenax and Tenax',
    { g2p: 'misaki', lexicon: { Tenax: 'x' } });
  assert.equal((out.text.match(/\(\/x\//gu) || []).length, 1);
});

test('lexicon matching is whole-word', () => {
  const out = prepareForKokoro('Tenaxial is a different word',
    { g2p: 'misaki', lexicon: { Tenax: 'x' } });
  assert.deepEqual(out.overrides, []);
});

// ===========================================================================
// The markdown-link hazard
// ===========================================================================

test("the assistant's own markdown links are flattened, not read as phonemes", () => {
  // THE HAZARD. On the misaki path `[docs](https://x.io/a)` is indistinguishable
  // from a pronunciation override: misaki reads the parenthesised half as a
  // phoneme string and pronounces a URL as garbage. Assistant replies contain
  // markdown links routinely.
  for (const g2p of ['espeak', 'misaki']) {
    const out = prepareForKokoro('See [the docs](https://x.io/a) now', { g2p });
    assert.equal(out.text, 'See the docs now.', `not flattened on ${ g2p }`);
    assert.ok(! out.text.includes('https'), 'a URL must never be read aloud');
  }
});

test('a link with no label drops rather than reading the URL', () => {
  assert.equal(prepareForKokoro('See [](https://x.io/a) now').text, 'See now.');
});

test('a non-URL link target is kept when there is no label', () => {
  assert.equal(prepareForKokoro('See [](chapter four) now').text, 'See chapter four now.');
});

test('flattening runs BEFORE our own markup is injected', () => {
  // Reversed, the flattener would strip the override this module just added.
  const out = prepareForKokoro('See [the docs](https://x.io) about Tenax',
    { g2p: 'misaki', lexicon: { Tenax: 'x' } });
  assert.ok(out.text.includes('[Tenax](/x/)'), 'our override survived');
  assert.ok(! out.text.includes('https'), 'their link did not');
});

// ===========================================================================
// Section 6.1 rule 2 -- contour shaping
// ===========================================================================

test('Section 6.1 rule 2: a whole utterance gets terminal punctuation', () => {
  assert.equal(prepareForKokoro('The audit is the real cost').text,
    'The audit is the real cost.');
});

test("punctuation the author wrote always wins", () => {
  for (const input of ['Done!', 'Really?', 'Wait\u2026', 'Fine.']) {
    assert.equal(prepareForKokoro(input).text, input);
  }
});

test('a continuation phrase gets a comma, not a full stop', () => {
  // The prosody layer synthesises each phrase separately. A full stop mid
  // sentence makes the sentence audibly break; no punctuation at all makes the
  // phrase land flat.
  const out = prepareForKokoro('The real cost', { position: 'continuation' });
  assert.equal(out.text, 'The real cost,');
});

test('a trailing comma at the end of an utterance becomes an ellipsis', () => {
  // Section 6.1 names the ellipsis for trailing pauses. Replacing rather than
  // appending avoids `word,…`, which reads as two beats.
  assert.equal(prepareForKokoro('and then,', { position: 'final' }).text, 'and then\u2026');
  assert.equal(prepareForKokoro('and then;').text, 'and then\u2026');
});

test('a continuation already ending in punctuation is left alone', () => {
  assert.equal(prepareForKokoro('first,', { position: 'continuation' }).text, 'first,');
  assert.equal(prepareForKokoro('first.', { position: 'continuation' }).text, 'first.');
});

test('contour shaping runs last, after transforms that move the final character', () => {
  // A flattened trailing link changes which character the contour decision
  // reads. Shaping first would punctuate the wrong thing.
  assert.equal(prepareForKokoro('Read [the docs](https://x.io)').text, 'Read the docs.');
});

// ===========================================================================
// Composition and robustness
// ===========================================================================

test('normalisation still happens: no typographic artifact survives', () => {
  const out = prepareForKokoro(
    'She asked, \u201CWhy is the library so quiet?\u201D\u201CBecause,\u201D he said, '
    + '\u201Ceveryone\u2019s overdue.\u201D');
  for (const ch of ['\u2018', '\u2019', '\u201C', '\u201D', '\u200B', '\u00AB']) {
    assert.ok(! out.text.includes(ch), `${ JSON.stringify(ch) } survived`);
  }
  assert.ok(out.text.includes("everyone's"), 'the contraction is intact');
});

test('never throws, whatever it is handed', () => {
  for (const input of [undefined, null, 0, 42, {}, [], true, NaN, '']) {
    const out = prepareForKokoro(input);
    assert.equal(out.text, '');
    assert.equal(out.beats, 0);
  }
});

test('text with nothing speakable in it stays empty', () => {
  // No terminal punctuation is bolted onto nothing -- `.` alone would be an
  // utterance with no speech in it.
  for (const input of ['\u201C', '  ', '\u200B', '**  **']) {
    assert.equal(prepareForKokoro(input).text, '');
  }
});

test('no markup residue on the espeak path, across a broad corpus', () => {
  // The catch-all. Every input, every option combination, one invariant.
  const corpus = [
    'The **audit** is [the cost](https://x.io) for Tenax',
    'audit,\u201D\u201CHonestly, **no**.',
    '**bold** at the start',
    'ends in **bold**',
    'a **b** c **d** e',
    '[](/weird/) and [x](+9)',
  ];
  for (const input of corpus) {
    for (const emphasis of [true, false]) {
      const out = prepareForKokoro(input,
        { g2p: 'espeak', emphasis, lexicon: { Tenax: 'x' } });
      assert.ok(! MARKUP_RESIDUE.test(out.text),
        `residue in ${ JSON.stringify(out.text) } from ${ JSON.stringify(input) }`);
    }
  }
});

test('a suppression notice fires only when something was actually suppressed', () => {
  // A warning that fires on all traffic is one an admin learns to ignore, which
  // costs the warning its only purpose.
  assert.deepEqual(prepareForKokoro('plain text', { g2p: 'espeak' }).suppressed, []);
  assert.deepEqual(
    prepareForKokoro('plain text', { g2p: 'espeak', lexicon: { Absent: 'x' } }).suppressed,
    [], 'a lexicon term that does not appear is not a suppression');
  assert.deepEqual(prepareForKokoro('**bold**', { g2p: 'espeak' }).suppressed,
    ['emphasis_needs_misaki_g2p']);
});

test('no double spaces or space-before-punctuation survive', () => {
  // Kokoro's tokenizer treats runs of space inconsistently, and ` ,` is not the
  // same signal as `,`.
  for (const input of ['a [](https://x.io) b', 'word\u201D\u201Cword', 'a  b']) {
    const out = prepareForKokoro(input).text;
    assert.ok(! /\s\s/u.test(out), `double space in ${ JSON.stringify(out) }`);
    assert.ok(! /\s[,.;:!?\u2026]/u.test(out), `space before punctuation in ${ JSON.stringify(out) }`);
  }
});

// ===========================================================================
// v13.1.0 -- the preprocessor is actually WIRED IN
// ===========================================================================
//
// THE FAILURE THESE EXIST TO PREVENT, which already happened once:
//
// v12.55.0 shipped this module, fully tested, and wired it into nothing. The
// v13.0.0 engine swap did not wire it either. So through v13.0.2 the module had
// 34 passing tests and was DEAD CODE -- Section 6 rules 2 through 5 were inert,
// markdown links were read aloud to API callers, no phrase got a contour, and
// the platform's emphasis decision was neither honoured nor refused.
//
// Every assertion above tests the transform. None of them could see that nobody
// called it. These can.

import { readFileSync as _readFile } from 'node:fs';
import { fileURLToPath as _fileUrl } from 'node:url';
import { dirname as _dirname, join as _joinPath } from 'node:path';

const _HERE_W = _dirname(_fileUrl(import.meta.url));
const _ENGINES = _joinPath(_HERE_W, '..', 'voice', 'voice-engines.js');

/** Engine source with comments stripped: the prose names the very symbols asserted. */
function engineCode() {
  return _readFile(_ENGINES, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the engine actually calls the preprocessor', () => {
  const code = engineCode();
  assert.match(code, /import \{ prepareForKokoro \}\s+from '\.\/voice-prosody-prep\.js';/u,
    'the engine imports it');
  assert.match(code, /const prepared = prepareForKokoro\(String\(o\.text \|\| ''\), \{/u,
    'and calls it at the choke point');
});

test('the bare normaliser is NOT called at the choke point instead', () => {
  // Calling it there would look correct and silently skip stages 2-5, which is
  // exactly the state v13.0.2 shipped in.
  const code = engineCode();
  const pcm = code.slice(code.indexOf('export async function synthesizePcm'));
  const body = pcm.slice(0, pcm.indexOf('\n}'));
  assert.ok(! /normalizeForSpeech\(String\(o\.text/u.test(body),
    'the choke point runs the pipeline, not just stage one');
});

test('both prosody paths supply a phrase position', () => {
  // Without it every phrase defaults to 'whole' and gets a full stop, so one
  // sentence audibly breaks into several -- worse than the flatness Section 6.1
  // rule 2 exists to fix.
  const code = engineCode();

  // v13.5.0. The pattern was pinned to the EXACT expression
  //   position: (index === X.length - 1) ? 'final' : 'continuation'
  // and v13.4.0 added a guard to the streaming worker so a mid-reply
  // incremental batch does not close on a falling contour:
  //   position: (closesReply && index === phrases.length - 1) ? ...
  //
  // That is a correct change, and the old regex counted it as a MISSING
  // position rather than a modified one -- the assertion failed while the
  // property it names ("both paths supply a position") was still true.
  //
  // Widened to allow an optional leading guard, and no further: the ternary,
  // the last-phrase test and both branch values are still pinned, so a path
  // that drops the position or inverts the branches still fails.
  const positions = code.match(
    /position: \((?:\w+ && )?index === \w+\.length - 1\) \? 'final' : 'continuation'/gu) || [];
  assert.equal(positions.length, 2,
    'the buffered and streaming phrase workers both pass position');

  // The guard belongs to the STREAMING worker only. The buffered path handles
  // whole replies, where the last phrase always ends the reply, so a guard
  // appearing there would mean a whole reply could end without a final
  // contour.
  const guarded = code.match(
    /position: \(\w+ && index === \w+\.length - 1\) \? 'final' : 'continuation'/gu) || [];
  assert.equal(guarded.length, 1,
    'exactly one path -- the streaming one -- guards the final position');
});

test('the emphasis decision is honoured as far as the G2P allows', () => {
  const code = engineCode();
  const fn = code.slice(code.indexOf('function emphasisEnabled'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Configured ON by default, per the platform decision of 2026-08-19.
  assert.match(body, /return true;/u, 'the default is on');
  assert.match(body, /'false' === raw \|\| '0' === raw \|\| 'no' === raw/u,
    'and it is switchable');
});

test('status reports configured AND effective emphasis, not just one', () => {
  // Reporting only `configured` makes the switch look broken on espeak;
  // reporting only `effective` hides that an operator asked for something.
  const code = engineCode();
  const fn = code.slice(code.indexOf('export function prosodyState'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /configured: emphasisEnabled\(\)/u);
  assert.match(body, /effective: emphasisEnabled\(\) && 'misaki' === g2pMode\(\)/u);
  assert.match(body, /g2p: g2pMode\(\)/u,
    'and names which front end is actually running');
});

test('a malformed lexicon is ignored, not thrown', () => {
  // A typo in an env var must not take every reply down.
  const code = engineCode();
  const fn = code.slice(code.indexOf('function pronunciationLexicon'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /catch \(err\)/u);
  assert.match(body, /return \{\};/u);
});
