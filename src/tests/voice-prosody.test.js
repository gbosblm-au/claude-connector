// src/tests/voice-prosody.test.js
//
// TS-VOICE-PROSODY-v1.0 Section 8 (AC1-AC7)
// SPEC-VOICE-001-v1.2.0 acceptance criteria
// PIPER-PRELOAD-v1.1 Section 9 (A1-A10)
//
// Run: node --test src/tests/voice-prosody.test.js
//
// ===========================================================================
// WHY THESE TESTS NEED NO ENGINE
// ===========================================================================
//
// AC7 is explicit: the transform must be verifiable "as a pure text-to-
// annotation transform", asserting per-phrase length_scale, pause durations and
// emphasis targets "with no Piper invocation required".
//
// That is not a convenience. Piper is not installed in CI, and a test suite
// that needed it would either not run or would be quietly skipped -- and a
// skipped acceptance test is worse than an absent one, because the report says
// green. Everything below runs against the pure modules and the source text.
//
// The parts that genuinely need a process (does Piper import? does the model
// load?) are the Section 8 smoke test, which is a DEPLOYMENT gate run by
// scripts/voice-worker-smoke.mjs against the real venv. The two are separate on
// purpose and neither pretends to be the other.

import test           from 'node:test';
import assert         from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  analyse, detectRegister, keyNoun, contrastTerm, emphasisTarget,
  splitParagraphs, splitSentences, splitDwellPoints, splitAroundEmphasis,
  splitWryFinalClause, prosodyConfig, prosodyEnabled, replyHash, summarise,
  PROSODY_DEFAULTS, PROFILES,
} from '../voice/prosody.js';

import {
  silencePcm, applyEdgeFades, concatPhrasePcm, wrapPcmAsWav,
} from '../voice/voice-engines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** Read a source file for the structural assertions. */
function source(relative) {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** Build a constant-amplitude PCM buffer of n samples. */
function tone(samples, amplitude = 10000) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(amplitude, i * 2);
  return buffer;
}

// ===========================================================================
// AC7 -- the transform is pure, and asserts pace, pause and emphasis
// ===========================================================================

test('AC7: prosody.js is a pure transform with no I/O and no imports', () => {
  const src = source('voice/prosody.js');

  // The property AC7 depends on. A layer that imported anything could reach a
  // file, a socket or a process, and the "no Piper invocation required" claim
  // would stop being structurally true.
  assert.ok(!/^\s*import\s/m.test(src),
    'prosody.js must import nothing at all');
  assert.ok(!/require\s*\(/.test(src),
    'prosody.js must not require anything');

  // Process and I/O calls specifically. Deliberately NOT a bare /\bexec\b/:
  // that matches RegExp.prototype.exec, which this module uses heavily and
  // which does no I/O whatsoever. An assertion that fires on correct code
  // teaches people to edit the test, which is how a real control gets lost.
  assert.ok(!/child_process|\bspawn\s*\(|\bexecSync\s*\(|\bexecFile\s*\(|\bexec\s*\(\s*['"`]/.test(src),
    'prosody.js must not spawn a process');
  assert.ok(!/readFile|writeFile|createReadStream|createWriteStream/.test(src),
    'prosody.js must not touch the filesystem');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|node:http|node:net/.test(src),
    'prosody.js must not open a socket');
});

test('AC7: the same text and config always give the same annotation', () => {
  const text = 'Honestly, the migration is late, but the audit is worse.';
  const first = analyse(text, { baseLengthScale: 1 });
  const second = analyse(text, { baseLengthScale: 1 });
  assert.deepEqual(first.phrases, second.phrases, 'the transform is deterministic');
});

test('AC7: every phrase carries a length_scale, a pause and an emphasis field', () => {
  const { phrases } = analyse(
    'Honestly, the deployment pipeline is the bottleneck here.\n\nIt shipped, right.',
    { baseLengthScale: 1 }
  );
  assert.ok(phrases.length >= 2);
  for (const phrase of phrases) {
    assert.equal(typeof phrase.text, 'string');
    assert.ok(phrase.text.length > 0, 'no empty phrase reaches the synthesiser');
    assert.ok(Number.isFinite(phrase.lengthScale) && phrase.lengthScale > 0);
    assert.ok(Number.isInteger(phrase.pauseAfterMs) && phrase.pauseAfterMs >= 0);
    assert.ok(Object.keys(PROFILES).includes(phrase.profile));
    assert.ok('emphasisTarget' in phrase);
    assert.ok(Number.isInteger(phrase.sentenceIndex));
  }
});

// ===========================================================================
// AC1 -- a wry sentence is SLOWER, with a beat before the final clause
// ===========================================================================

test('AC1: a wry sentence is slower than baseline and beats before its final clause', () => {
  const cfg = prosodyConfig({});
  const { phrases } = analyse('The migration finished on Tuesday, right.',
                              { baseLengthScale: 1, config: cfg });

  assert.equal(phrases.length, 2, 'the final clause is carved out to put a beat before it');
  assert.equal(phrases[0].profile, 'wry');

  // SLOWER. length_scale is INVERSE rate, so slower is a LARGER number. This
  // assertion is the one that catches the whole feature being inverted.
  assert.ok(phrases[0].lengthScale > 1,
    `wry must be slower than baseline, got ${phrases[0].lengthScale}`);
  assert.equal(phrases[0].lengthScale, cfg.rateWry);

  // The beat: the pause before the final clause exceeds an ordinary dwell.
  assert.ok(phrases[0].pauseAfterMs > cfg.pauseDwellMs,
    'the pause before the punchline is longer than a plain dwell');
  assert.equal(phrases[0].pauseAfterMs, cfg.pauseDwellMs + cfg.wryBeatMs);
});

test('AC1: a wry sentence with no comma still gets a final-clause beat', () => {
  const { phrases } = analyse('Everyone signed off on the plan of course.',
                              { baseLengthScale: 1 });
  assert.equal(phrases.length, 2);
  assert.equal(phrases[1].text, 'of course.');
  assert.ok(phrases[0].pauseAfterMs > PROSODY_DEFAULTS.pauseDwellMs);
});

test('AC1: wry is deadpan -- it selects no emphasis target', () => {
  assert.equal(emphasisTarget('It shipped on time, right.', 'wry'), null,
    'Section 5 gives wry "none (deadpan)"');
});

// ===========================================================================
// AC2 -- a direct sentence is at or near baseline, with a key noun stressed
// ===========================================================================

test('AC2: a direct declarative is near baseline and stresses a key noun', () => {
  const cfg = prosodyConfig({});
  const { phrases, sentences } = analyse(
    'Honestly, the deployment pipeline is the bottleneck here.',
    { baseLengthScale: 1, config: cfg }
  );

  assert.equal(sentences[0].profile, 'direct');

  // "At or near baseline rate", and slightly quicker: a SMALLER length_scale.
  const carrier = phrases.find(p => !p.isEmphasis);
  assert.equal(carrier.lengthScale, cfg.rateDirect);
  assert.ok(carrier.lengthScale < 1, 'direct is slightly quicker than baseline');
  assert.ok(Math.abs(carrier.lengthScale - 1) < 0.1, 'but stays NEAR baseline');

  // A key noun is selected, and it is not the directness marker itself.
  const target = sentences[0].emphasisTarget;
  assert.ok(target, 'a key noun is selected');
  assert.notEqual(target.toLowerCase(), 'honestly');

  // Section 4.3, three cues applied together.
  const stressed = phrases.find(p => p.isEmphasis);
  assert.ok(stressed, 'the target is synthesised as its own unit');
  assert.equal(stressed.text.toLowerCase().replace(/[^a-z]/g, ''), target.toLowerCase());
  assert.ok(stressed.lengthScale > carrier.lengthScale,
    'the stressed unit dips in rate, which is a RISE in length_scale');
  const before = phrases[phrases.indexOf(stressed) - 1];
  assert.equal(before.pauseAfterMs, cfg.pauseEmphasisMs, 'bracketed by a micro-pause');
  assert.equal(stressed.pauseAfterMs, cfg.pauseEmphasisMs, 'on each side');
});

test('the register table maps to the rates Section 5 and Section 9 specify', () => {
  const cfg = prosodyConfig({});
  assert.equal(cfg.rateDirect, 0.94);
  assert.equal(cfg.rateWry, 1.08);
  assert.equal(cfg.rateContrast, 1.02);
  assert.equal(cfg.rateNeutral, 1.00);
  assert.equal(cfg.pauseParagraphMs, 450);
  assert.equal(cfg.pauseSentenceMs, 250);
  assert.equal(cfg.pauseDwellMs, 120);
  assert.equal(cfg.pauseEmphasisMs, 80);
});

test('the pause tiers are strictly ordered: paragraph > sentence > dwell > emphasis', () => {
  const cfg = prosodyConfig({});
  assert.ok(cfg.pauseParagraphMs > cfg.pauseSentenceMs);
  assert.ok(cfg.pauseSentenceMs > cfg.pauseDwellMs);
  assert.ok(cfg.pauseDwellMs > cfg.pauseEmphasisMs);
});

test('a full reply applies every pause tier at the right boundary', () => {
  const cfg = prosodyConfig({});
  const { phrases } = analyse(
    'First sentence here. Second one, which ran long, ended late.\n\nA new paragraph starts.',
    { baseLengthScale: 1, config: cfg }
  );

  const byBoundary = {};
  for (const phrase of phrases) byBoundary[phrase.boundary] = phrase.pauseAfterMs;

  assert.equal(byBoundary.sentence, cfg.pauseSentenceMs);
  assert.equal(byBoundary.dwell, cfg.pauseDwellMs);
  assert.equal(byBoundary.paragraph, cfg.pauseParagraphMs);
  // Nothing follows the reply, so a trailing pause would be dead air.
  assert.equal(byBoundary.end, 0);
  assert.equal(phrases[phrases.length - 1].pauseAfterMs, 0);
});

// ===========================================================================
// Register detection -- including the false positives that were real defects
// ===========================================================================

test('register detection keys on the markers Section 5 names', () => {
  assert.equal(detectRegister('Honestly, it will not work.'), 'direct');
  assert.equal(detectRegister('The point is that nobody read it.'), 'direct');
  assert.equal(detectRegister('It shipped on time, right.'), 'wry');
  assert.equal(detectRegister("That's the whole game."), 'wry');
  assert.equal(detectRegister('The real cost is not the licence but the audit.'), 'contrast');
  assert.equal(detectRegister('The largest cost is the audit.'), 'contrast');
  assert.equal(detectRegister('The report is due on Friday.'), 'neutral');
});

test('directness markers are positional, not substrings', () => {
  // "I answered honestly" is not a directness cue; the marker has to open the
  // sentence. A substring match here would re-pace a large slice of ordinary
  // prose for no reason.
  assert.equal(detectRegister('I answered honestly and moved on.'), 'neutral');
  assert.equal(detectRegister('Honestly, I moved on.'), 'direct');
});

test('wry markers are final, not substrings', () => {
  assert.equal(detectRegister('The right answer is on page two.'), 'neutral');
  assert.equal(detectRegister('The answer is on page two, right.'), 'wry');
});

test('REGRESSION: -est words that are not superlatives stay neutral', () => {
  // The first implementation matched /\b\w{4,}est\b/, which fires on all of
  // these. The effect was not subtle: ordinary business prose was re-paced as
  // contrast and given a stress bracket around a word carrying no contrast.
  for (const sentence of [
    'The client sent a request.',
    'We should protest the invoice.',
    'It has our interest.',
    'The harvest was late.',
    'Please suggest a date.',
    'They will contest the finding.',
  ]) {
    assert.equal(detectRegister(sentence), 'neutral',
      `"${sentence}" must not read as a superlative contrast`);
  }
});

test('genuine superlatives still read as contrast', () => {
  assert.equal(detectRegister('The largest cost is the audit.'), 'contrast');
  assert.equal(detectRegister('Its hardest part is the migration.'), 'contrast');
  assert.equal(detectRegister('The most expensive part is the licence.'), 'contrast');
});

test('the contrast target is the term the sentence asserts', () => {
  assert.equal(contrastTerm('The real cost is not the licence but the audit.'), 'audit');
  assert.equal(contrastTerm('It is buried in the appendix.'), 'buried');
  assert.equal(contrastTerm('We chose migration rather than replacement.'), 'migration');
});

test('the key noun is never the directness marker', () => {
  const target = keyNoun('Honestly, the schedule slipped.');
  assert.ok(target);
  assert.notEqual(target.toLowerCase(), 'honestly');
});

// ===========================================================================
// Segmentation
// ===========================================================================

test('paragraphs split on blank lines, not on single newlines', () => {
  // A single newline is a wrapped line or a list item. Giving each one the
  // 450 ms paragraph pause would make a bulleted list sound like a eulogy.
  assert.equal(splitParagraphs('one\ntwo').length, 1);
  assert.equal(splitParagraphs('one\n\ntwo').length, 2);
  assert.equal(splitParagraphs('one\n\n\n  \n\ntwo').length, 2);
});

test('sentence splitting survives abbreviations, decimals and initials', () => {
  assert.deepEqual(
    splitSentences('Approx. 40% is hidden. Dr. Smith agreed. Version 3.5 shipped.'),
    ['Approx. 40% is hidden.', 'Dr. Smith agreed.', 'Version 3.5 shipped.']
  );
  assert.equal(splitSentences('It costs 3.5 million and rises.').length, 1);
  assert.equal(splitSentences('J. Smith signed it.').length, 1);
});

test('REGRESSION: "no" ends a sentence unless a number follows', () => {
  // With "no" on the always-suppress abbreviation list, this sentence never
  // ended, and the whole reply synthesised as one phrase with no sentence
  // pause anywhere in it.
  assert.equal(splitSentences('He said "no". Then he left.').length, 2);
  // The genuine abbreviation still works.
  assert.equal(splitSentences('See No. 5 below. It matters.').length, 2);
  assert.equal(splitSentences('See No. 5 below.')[0], 'See No. 5 below.');
});

test('dwell points break after punctuation and before weighted conjunctions', () => {
  assert.deepEqual(
    splitDwellPoints('The report is late, but the numbers are worse than expected.'),
    ['The report is late,', 'but the numbers are worse than expected.']
  );
  assert.deepEqual(
    splitDwellPoints('Second point, which nobody expected, arrived late.'),
    ['Second point,', 'which nobody expected,', 'arrived late.']
  );
});

test('a conjunction inside a short phrase does not split it', () => {
  // "and" is the commonest word in English; breaking at every one would chop
  // the reply into confetti.
  assert.deepEqual(splitDwellPoints('You and I agreed.'), ['You and I agreed.']);
});

test('hyphens and date ranges are not dwell points', () => {
  const parts = splitDwellPoints('It covers 2019-2024 and the cost-benefit case, which nobody read.');
  assert.ok(parts.every(p => !/^\-/.test(p)));
  assert.ok(parts.some(p => p.includes('cost-benefit')), 'the compound stays whole');
  assert.ok(parts.some(p => p.includes('2019-2024')), 'the range stays whole');
});

test('a comma already carrying the breath does not double-break its conjunction', () => {
  const parts = splitDwellPoints('The report is late, but the numbers are worse than expected.');
  assert.equal(parts.length, 2, 'one break, not two');
});

test('emphasis splitting only applies mid-phrase', () => {
  assert.equal(splitAroundEmphasis('audit the numbers now', 'audit'), null,
    'a target at the edge is already bracketed by the phrase boundary');
  assert.equal(splitAroundEmphasis('review the audit now', 'missing'), null);
  const split = splitAroundEmphasis('review the audit now', 'audit');
  assert.deepEqual(split, { before: 'review the', target: 'audit', after: 'now' });
});

test('the wry tail split refuses to leave a one-word head', () => {
  // Pausing after the first word of a sentence is worse than not pausing.
  assert.deepEqual(splitWryFinalClause('Fine of course.'), ['Fine of course.']);
});

// ===========================================================================
// AC6 -- voice-agnostic
// ===========================================================================

test('AC6: an alternate voice config changes the scales but not the shape', () => {
  const text = 'Honestly, the migration is late, right.';
  const a = analyse(text, { baseLengthScale: 1.0 });
  const b = analyse(text, { baseLengthScale: 1.5 });

  assert.equal(a.phrases.length, b.phrases.length, 'segmentation is voice-independent');
  assert.deepEqual(a.phrases.map(p => p.text), b.phrases.map(p => p.text));
  assert.deepEqual(a.phrases.map(p => p.pauseAfterMs), b.phrases.map(p => p.pauseAfterMs),
    'pauses are durations in ms and do not move with the voice');
  assert.deepEqual(a.phrases.map(p => p.profile), b.phrases.map(p => p.profile));

  for (let i = 0; i < a.phrases.length; i++) {
    assert.equal(b.phrases[i].lengthScale,
      Math.round(a.phrases[i].lengthScale * 1.5 * 10000) / 10000,
      'every scale tracks the voice base exactly');
  }
});

test('AC6: the layer names no voice, rate or speaker anywhere', () => {
  const src = source('voice/prosody.js');
  // The values that would make the layer voice-aware. Stripping comments first
  // so the explanatory prose about sample rates is not mistaken for a constant.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/22050|16000|48000/.test(code), 'no sample rate constant in the layer');
  assert.ok(!/kristin|lessac|en_US|onnx/i.test(code), 'no voice id or model path');
});

test('the user speed control composes with the register', () => {
  const cfg = prosodyConfig({});
  const normal = analyse('It shipped on time, right.', { baseLengthScale: 1, config: cfg });
  const fast = analyse('It shipped on time, right.', { baseLengthScale: 1, speed: 2, config: cfg });
  assert.equal(fast.phrases[0].lengthScale,
    Math.round((cfg.rateWry / 2) * 10000) / 10000,
    'speed divides, exactly as the flat path 1/speed does');
});

// ===========================================================================
// Configuration is data, not code (Section 4.1, Section 9)
// ===========================================================================

test('Section 9 environment variables override every default', () => {
  const cfg = prosodyConfig({
    PROSODY_RATE_DIRECT: '0.80',
    PROSODY_RATE_WRY: '1.30',
    PROSODY_RATE_CONTRAST: '1.10',
    PROSODY_PAUSE_PARAGRAPH_MS: '600',
    PROSODY_PAUSE_SENTENCE_MS: '300',
    PROSODY_PAUSE_DWELL_MS: '150',
    PROSODY_PAUSE_EMPHASIS_MS: '90',
  });
  assert.equal(cfg.rateDirect, 0.80);
  assert.equal(cfg.rateWry, 1.30);
  assert.equal(cfg.rateContrast, 1.10);
  assert.equal(cfg.pauseParagraphMs, 600);
  assert.equal(cfg.pauseSentenceMs, 300);
  assert.equal(cfg.pauseDwellMs, 150);
  assert.equal(cfg.pauseEmphasisMs, 90);
});

test('out-of-range configuration falls back rather than reaching Piper', () => {
  // A length_scale of 0 asks for a zero-length utterance and 50 for a
  // fifty-fold one. Both are ways to make the synthesiser fail on a value that
  // came from configuration, which is the hardest kind of failure to diagnose.
  const cfg = prosodyConfig({
    PROSODY_RATE_WRY: '0',
    PROSODY_RATE_DIRECT: '50',
    PROSODY_PAUSE_SENTENCE_MS: '-100',
    PROSODY_PAUSE_DWELL_MS: 'not-a-number',
  });
  assert.equal(cfg.rateWry, PROSODY_DEFAULTS.rateWry);
  assert.equal(cfg.rateDirect, PROSODY_DEFAULTS.rateDirect);
  assert.equal(cfg.pauseSentenceMs, PROSODY_DEFAULTS.pauseSentenceMs);
  assert.equal(cfg.pauseDwellMs, PROSODY_DEFAULTS.pauseDwellMs);
});

test('Section 10: the layer ships OFF, so the rollout is an operator action', () => {
  assert.equal(prosodyEnabled({}), false);
  assert.equal(prosodyEnabled({ VOICE_PROSODY_ENABLED: 'true' }), true);
  assert.equal(prosodyEnabled({ VOICE_PROSODY_ENABLED: 'TRUE' }), true);
  assert.equal(prosodyEnabled({ VOICE_PROSODY_ENABLED: 'false' }), false);
});

// ===========================================================================
// Robustness -- the inputs a real reply actually contains
// ===========================================================================

test('degenerate input produces no phrases rather than an empty one', () => {
  for (const text of ['', '   ', '\n\n', '...', '???']) {
    const { phrases } = analyse(text, { baseLengthScale: 1 });
    assert.ok(phrases.every(p => p.text.trim().length > 0),
      `"${text}" must not yield an empty phrase`);
  }
});

test('a pathological reply is merged, never truncated', () => {
  // Truncating would drop the end of the reply, which the user experiences as
  // the assistant trailing off. Merging costs prosody in the tail instead.
  const text = Array.from({ length: 400 }, (_, i) => `Point ${i} here.`).join(' ');
  const cfg = prosodyConfig({ PROSODY_MAX_PHRASES: '50' });
  const { phrases } = analyse(text, { baseLengthScale: 1, config: cfg });

  assert.ok(phrases.length <= 50, `capped at 50, got ${phrases.length}`);
  const spoken = phrases.map(p => p.text).join(' ');
  assert.ok(spoken.includes('Point 0'), 'the start survives');
  assert.ok(spoken.includes('Point 399'), 'and so does the end');
});

test('regex-special characters in a reply cannot break the transform', () => {
  // The emphasis search interpolates reply text into a RegExp, so a reply
  // containing "(" would throw if it were not escaped.
  for (const text of [
    'The real cost (a) is not the licence but the audit.',
    'Honestly, the [bracket] is the problem.',
    'The real $cost is not a but b.',
    'Honestly, the a+b*c formula is wrong.',
  ]) {
    assert.doesNotThrow(() => analyse(text, { baseLengthScale: 1 }), text);
  }
});

test('Section 10: a summary carries counts, never the words being spoken', () => {
  const analysis = analyse('Honestly, the deployment pipeline is the bottleneck.',
                           { baseLengthScale: 1 });
  const json = JSON.stringify(summarise(analysis));
  assert.ok(!/deployment|pipeline|bottleneck/i.test(json),
    'the log-safe summary must not leak the reply');
  assert.ok(/phrases/.test(json));
});

test('the reply hash pairs the two halves of Compare mode', () => {
  const text = 'Same reply text.';
  assert.equal(replyHash(text), replyHash(text), 'stable, so the UI can pair them');
  assert.notEqual(replyHash(text), replyHash('Same reply text!'));
  assert.match(replyHash(text), /^[0-9a-f]{8}$/);
});

// ===========================================================================
// Audio assembly -- non-negotiable 7, no clicks, gaps or joins
// ===========================================================================

test('silence is a whole number of 16-bit samples at the voice rate', () => {
  // An odd byte count would shift every subsequent sample by one byte and turn
  // the rest of the reply into noise.
  for (const rate of [16000, 22050, 24000, 48000]) {
    for (const ms of [80, 120, 250, 450]) {
      const pcm = silencePcm(ms, rate);
      assert.equal(pcm.length % 2, 0, `even byte count at ${ms}ms/${rate}Hz`);
      assert.equal(pcm.length, Math.round((ms / 1000) * rate) * 2);
      assert.ok(pcm.every(byte => byte === 0), 'silence is silent');
    }
  }
  assert.equal(silencePcm(0, 22050).length, 0);
  assert.equal(silencePcm(-10, 22050).length, 0);
});

test('the same pause is the same DURATION at every sample rate', () => {
  // Section 6: pauses are "durations applied at concatenation, which is
  // sample-rate independent".
  const at16k = silencePcm(250, 16000).length / 2 / 16000;
  const at22k = silencePcm(250, 22050).length / 2 / 22050;
  assert.ok(Math.abs(at16k - at22k) < 0.001, 'both are 250ms of audio');
});

test('non-negotiable 7: joins fade to zero so they cannot click', () => {
  const buffer = tone(2205);
  applyEdgeFades(buffer, 5, 22050);
  assert.equal(buffer.readInt16LE(0), 0, 'the first sample is zero');
  assert.equal(buffer.readInt16LE(2204 * 2), 0, 'and so is the last');
  assert.equal(buffer.readInt16LE(1102 * 2), 10000, 'the middle is untouched');
});

test('a short emphasis unit is not muted by its own fades', () => {
  // A one-word emphasis unit can be shorter than two fade windows; fading it
  // twice over would mute the very word the fades exist to make prominent.
  const buffer = tone(30);
  applyEdgeFades(buffer, 50, 22050);
  assert.ok(buffer.readInt16LE(15 * 2) > 0, 'the middle survives');
});

test('concatenation lays segments and pauses end to end at the right length', () => {
  const pcm = concatPhrasePcm([
    { pcm: tone(2205), pauseAfterMs: 250 },
    { pcm: tone(2205), pauseAfterMs: 0 },
  ], 22050, 5);
  assert.equal(pcm.length, (2205 + Math.round(0.25 * 22050) + 2205) * 2);
  assert.equal(pcm.length % 2, 0);
});

test('empty segments are skipped rather than corrupting the stream', () => {
  const pcm = concatPhrasePcm([
    { pcm: Buffer.alloc(0), pauseAfterMs: 100 },
    { pcm: tone(100), pauseAfterMs: 0 },
    null,
  ], 22050, 5);
  assert.equal(pcm.length, 200, 'only the real segment contributes');
});

test('the WAV header describes the concatenated audio exactly', () => {
  const pcm = concatPhrasePcm([{ pcm: tone(1000), pauseAfterMs: 100 }], 22050, 5);
  const wav = wrapPcmAsWav(pcm, 22050);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF size');
  assert.equal(wav.readUInt32LE(40), pcm.length, 'data size');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 22050, 'sample rate');
  assert.equal(wav.readUInt16LE(34), 16, '16-bit');
  assert.equal(wav.length, 44 + pcm.length);
});

// ===========================================================================
// AC3 / AC5 / N4 -- the flat baseline is genuinely the old path
// ===========================================================================

test('AC3: flat mode builds the pre-prosody argv exactly', () => {
  const src = source('voice/voice-engines.js');

  // The argv is the whole of AC3's byte-identity claim: Piper's output depends
  // on the model and the argv and nothing else.
  assert.ok(src.includes("const args = ['--model', modelPath, '--output_raw'];"),
    'the CLI argv is unchanged');

  // synthesize() must reach the CLI path through the same 1/speed conversion.
  assert.ok(/lengthScale:\s*\(Number\.isFinite\(o\.speed\)\s*&&\s*o\.speed\s*>\s*0\)\s*\?\s*\(1\s*\/\s*o\.speed\)\s*:\s*undefined/.test(src),
    'flat synthesis converts speed to length_scale the way it always did');

  // And the flag is omitted entirely when no speed was asked for, which is
  // what makes a default-speed reply byte-identical rather than merely similar.
  assert.ok(src.includes("if (Number.isFinite(o.lengthScale) && o.lengthScale > 0) {"),
    'the length_scale flag is conditional, not always present');
});

test('AC5/N4: Compare mode renders flat through the untouched synthesize()', () => {
  const src = source('routes/voice.js');
  const compare = src.slice(src.indexOf("if ('both' === effective)"),
                            src.indexOf('reply_hash: replyHash(text)'));
  assert.ok(/const flat = await synthesize\(\{ text, voice, speed: flatSpeed \}\)/.test(compare),
    'the flat half of Compare is the same call Off mode makes');
  assert.ok(/synthesizeProsody\(/.test(compare), 'and the layered half is the layer');
});

test('AC5: Compare returns two audio outputs paired by one hash', () => {
  const src = source('routes/voice.js');
  assert.ok(src.includes('reply_hash: replyHash(text)'));
  assert.ok(/flat:\s*\{/.test(src) && /prosody:\s*\{/.test(src));
  assert.ok(src.includes('audio_base64'));
});

test('an unrecognised prosody mode is refused rather than silently defaulted', () => {
  const src = source('routes/voice.js');
  const parser = src.slice(src.indexOf('function parseProsodyMode'),
                           src.indexOf('/** Never log audio'));
  assert.ok(parser.includes("['on', 'off', 'both'].includes(mode) ? mode : null"),
    'a typo becomes a 422, not silently flat audio');
  assert.ok(parser.includes("return 'off';"),
    'an absent field defaults to off, so an older client is unaffected');
});

test('AC18/N5: a layer failure falls back to single-call synthesis', () => {
  const src = source('routes/voice.js');
  assert.ok(src.includes('flat_fallback'), 'the fallback path exists and is named');
  assert.ok(src.includes('notWorthRetrying'),
    'a refusal the flat path would also produce is not retried');
  for (const code of ['unknown_voice', 'voice_non_commercial', 'empty_text']) {
    assert.ok(src.includes(`'${code}'`), `${code} is classified`);
  }
});

// ===========================================================================
// PIPER-PRELOAD-v1.1 -- the resident worker
// ===========================================================================

test('A5: the CLI path survives intact as the fallback', () => {
  const src = source('voice/voice-engines.js');
  assert.ok(src.includes('function synthesizePcmViaCli'),
    'the per-request spawn is still there and is still reachable');
  assert.ok(/const viaWorker = await synthesizeViaWorker\(/.test(src),
    'the worker is tried first');
  assert.ok(src.includes('if (viaWorker) {'),
    'and a null answer falls through to the CLI path');
});

test('A5: disabling the worker by flag reverts to the CLI path', () => {
  const src = source('voice/piper-worker-supervisor.js');
  assert.ok(src.includes("boolEnv('VOICE_TTS_WORKER_ENABLED', true)"));
  assert.ok(/export async function synthesizeViaWorker[\s\S]{0,400}if \(!workerEnabled\(\)\) return null;/.test(src),
    'the flag short-circuits to null, which routes to the CLI path');
  // The shared lifecycle honours the same flag before spawning anything.
  const shared = source('voice/stdio-worker.js');
  assert.ok(shared.includes('if (!spec.enabled()) return Promise.resolve(false);'),
    'a disabled worker is never spawned');
});

// v12.54.0: the three assertions below used to read
// piper-worker-supervisor.js. Change 3 needed the same lifecycle for Whisper,
// so spawn, framing, routing, timeouts, backoff and health moved to
// stdio-worker.js and BOTH engines use it. The behaviour is unchanged; only
// the file that holds it moved, so these now read the shared module.
//
// That is strictly better coverage: asserting it once covers both workers,
// where before it covered one and the second copy could have drifted.

test('A4: an unavailable worker routes to the CLI path, a refusal does not', () => {
  const src = source('voice/stdio-worker.js');
  assert.ok(src.includes("const infrastructure = ['worker_unavailable', 'worker_gone', 'worker_timeout'];"),
    'infrastructure failures fall back');
  assert.ok(src.includes('throw err;'),
    'request-level refusals propagate rather than being retried slowly');
  // And the Piper side still reads a null answer as "use the CLI path".
  const engines = source('voice/voice-engines.js');
  assert.ok(engines.includes('if (viaWorker) {'),
    'a null answer falls through to the CLI spawn');
});

test('A4: in-flight requests are rejected when the worker dies', () => {
  const src = source('voice/stdio-worker.js');
  assert.ok(src.includes('function failPending'),
    'a caller must not wait on a process that no longer exists');
  assert.ok(src.includes('backOff'), 'and restarts back off exponentially');
  assert.ok(/state\.disabledUntil = Date\.now\(\) \+ wait/.test(src));
});

test('A2: the worker pid and warm flag are surfaced for health', () => {
  const src = source('voice/stdio-worker.js');
  assert.ok(/warm:\s*!!\(state\.ready && state\.child\)/.test(src));
  assert.ok(/pid:\s*state\.pid/.test(src));
  const routes = source('routes/voice.js');
  assert.ok(routes.includes('tts_worker: ttsWorkerState()'),
    '/voice/health reports it');
  // v12.54.0: and the adapter is still published at the path v12.53.0 used.
  const piper = source('voice/piper-worker-supervisor.js');
  assert.ok(piper.includes('adapter:'), 'tts_worker.adapter survives the refactor');
});

test('A7: pre-warm is inside the master-switch guard', () => {
  const engines = source('voice/voice-engines.js');
  const prewarm = engines.slice(engines.indexOf('export async function prewarmTts'));
  assert.ok(prewarm.slice(0, 400).includes('if (!voiceEnabled()) return false;'),
    'with voice off, no Piper process is created');
  assert.ok(prewarm.slice(0, 700).includes('if (!installed.length) return false;'),
    'and no worker is warmed with no model to load');
});

test('A7: pre-warm does not make probeEngines eager', () => {
  const engines = source('voice/voice-engines.js');
  const prewarm = engines.slice(engines.indexOf('export async function prewarmTts'),
                                engines.indexOf('export function ttsWorkerState'));
  assert.ok(!prewarm.includes('probeEngines('),
    'Section 5: probeEngines stays lazy; the pre-warm is a separate gated step');
});

test('Section 5: the TTS queue guards the CLI spawn, not the worker', () => {
  const src = source('voice/voice-engines.js');
  assert.ok(src.includes("const TTS_CONCURRENCY = intEnv('VOICE_TTS_CONCURRENCY', 1);"),
    'the queue exists and defaults to 1');
  assert.ok(src.includes('function acquireTts') && src.includes('function releaseTts'));

  // The queue must wrap the CLI branch only: serialising the worker as well
  // would throttle the phrase pipeline for no benefit, since the worker holds
  // one model however many requests are pipelined at it.
  const synth = src.slice(src.indexOf('export async function synthesizePcm'),
                          src.indexOf('function synthesizePcmViaCli'));
  assert.ok(synth.indexOf('await acquireTts()') > synth.indexOf('if (viaWorker) {'),
    'the queue is acquired only after the worker path has declined');
});

test('the TTS and STT queues are independent', () => {
  const src = source('voice/voice-engines.js');
  // One blocking the other would mean a transcription in progress silently
  // delayed every reply's audio.
  assert.ok(src.includes('ttsInFlight') && src.includes('ttsQueue'));
  assert.ok(/state\.inFlight < STT_CONCURRENCY/.test(src));
  assert.ok(/state\.ttsInFlight < TTS_CONCURRENCY/.test(src));
});

test('Section 10: every new environment variable has a safe default', () => {
  const supervisor = source('voice/piper-worker-supervisor.js');
  const engines = source('voice/voice-engines.js');
  const both = supervisor + engines;
  assert.ok(both.includes("boolEnv('VOICE_TTS_WORKER_ENABLED', true)"));
  assert.ok(both.includes("boolEnv('VOICE_TTS_PREWARM', true)"));
  assert.ok(both.includes("intEnv('VOICE_TTS_CONCURRENCY', 1"));
  assert.ok(both.includes("intEnv('VOICE_TTS_RESIDENT_VOICES', 1"));
  assert.ok(both.includes("intEnv('VOICE_TTS_WORKER_IDLE_MS', 300_000"));
});

test('the worker protocol bounds length_scale on both sides of the pipe', () => {
  const worker = readFileSync(join(SRC, 'voice', 'piper_worker.py'), 'utf8');
  assert.ok(worker.includes('0.1 <= length_scale <= 10.0'),
    'a value from a pipe is input, not state');
  assert.ok(worker.includes('1.0 / float(speed)'),
    'speed converts exactly as the CLI path does, so the two cannot disagree');
});

test('the worker returns raw PCM, never a WAV per phrase', () => {
  const worker = readFileSync(join(SRC, 'voice', 'piper_worker.py'), 'utf8');
  // A 44-byte header in the middle of a join is heard as a burst of noise.
  assert.ok(worker.includes('readframes'),
    'the wav adapter strips the container before returning');
  assert.ok(worker.includes('pcm_b64'));

  const supervisor = source('voice/piper-worker-supervisor.js');
  assert.ok(supervisor.includes('pcm.length % 2 !== 0'),
    'an odd byte count is treated as a fault and falls back');
});
