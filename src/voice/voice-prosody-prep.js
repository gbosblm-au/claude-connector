/* voice-prosody-prep.js  --  translate normalised text into Kokoro-ready text.
 *
 * SPEC-KOKORO-001 v1.1, Section 6 (Prosody Preprocessor)
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 *
 * Piper took prosody as FLAGS: --length_scale, --sentence_silence, a per-phrase
 * SSML subset. Kokoro takes it as TEXT. Its control surface is punctuation and
 * markdown-ish markup inside the string you hand it, so the place to express
 * prosodic intent is a text transform, not a parameter.
 *
 * This module is the second half of a two-stage pipeline. voice-text-normalize
 * runs first and removes what must never be spoken; this runs second and adds
 * what Kokoro can interpret. Section 6.2 fixes that order.
 *
 * ===========================================================================
 * THE FINDING THAT SHAPES THIS MODULE
 * ===========================================================================
 *
 * Section 4 of the specification credits Kokoro with pronunciation overrides
 * ([Kokoro](/kˈOkəɹO/)) and stress control ([word](+2)). Those are real, but
 * they are features of MISAKI, the G2P library the Hugging Face Space uses --
 * not of the Kokoro model, and NOT of kokoro-onnx.
 *
 * kokoro-onnx phonemises with its own tokenizer built on phonemizer/espeak-ng,
 * which has no markdown handling whatsoever. Hand it `[best](+2)` and espeak
 * pronounces the brackets and the digits. The markup does not degrade to
 * plain -- it degrades to WORSE THAN PLAIN, because the listener hears "plus
 * two" in the middle of a sentence.
 *
 * So every markup rule in this module is gated on which G2P is actually in use,
 * and the gate defaults to the safe answer. `emphasis: true` with
 * `g2p: 'espeak'` does not emit markup and does not silently pretend to: it
 * records a suppression reason the caller can log and an admin can see.
 *
 * Even on the misaki path, the stress control is weaker than Section 4.2
 * implies -- several independent reports describe (+2) as producing no audible
 * change, one describes a slight effect on kokoro >= 0.9.2. Treat it as a hint,
 * not a lever.
 *
 * ===========================================================================
 * WHY IT IS A PURE FUNCTION
 * ===========================================================================
 *
 * Same reason as voice-text-normalize: it spawns nothing, reads nothing and
 * holds no state, so it is exhaustively testable without a model, a venv, or
 * espeak installed -- none of which exist in CI. It returns a result object
 * rather than a bare string so the decisions it made are inspectable instead of
 * inferred from the output.
 */

'use strict';

import { normalizeForSpeech } from './voice-text-normalize.js';

/**
 * The beat sentinel handed to normalizeForSpeech.
 *
 * U+0001 (START OF HEADING). Chosen because it cannot occur in assistant prose,
 * is not whitespace -- so the normaliser's whitespace collapse cannot eat it --
 * and is not in Kokoro's phoneme vocabulary, so if a bug ever let one reach the
 * engine it would be dropped rather than voiced.
 */
export const BEAT_MARKER = '\u0001';

/** Punctuation Kokoro interprets for phrasing and contour (Section 4.4). */
const KOKORO_PUNCTUATION = ';:,.!?—…"()“”';

/** Characters that already end a sentence, so no terminal mark is needed. */
const TERMINAL = /[.!?…]$/u;

/** Characters that already mark a continuation, so no comma is needed. */
const CONTINUING = /[,;:—]$/u;

/**
 * Markdown link syntax already present in the assistant's own text.
 *
 * THIS IS A HAZARD, NOT A FEATURE. On the misaki path, `[docs](https://x.y)` is
 * indistinguishable from a pronunciation override: misaki reads the parenthesised
 * part as a phoneme string and pronounces the URL as garbage phonemes. Assistant
 * replies contain markdown links routinely.
 *
 * So pre-existing links are flattened to their label BEFORE any override of ours
 * is injected. Doing it in the other order would flatten our own markup.
 */
const PREEXISTING_LINK = /\[([^\]]*)\]\(([^)]*)\)/gu;

/** Bold markdown, which is the only honest signal of intended prominence. */
const BOLD = /\*\*([^*\n]+)\*\*/gu;

/** Emphasis levels misaki accepts. Section 4.2. */
const STRESS_RAISE = '+2';

/**
 * Which G2P will phonemise this text.
 *
 *   'espeak' -- kokoro-onnx's built-in tokenizer (phonemizer/espeak-ng).
 *               Understands punctuation. Understands NO markup.
 *   'misaki' -- hexgrad/misaki, called ahead of the model with is_phonemes=True.
 *               Understands the markdown override and stress syntax.
 *
 * Defaults to 'espeak' because that is what a bare `pip install kokoro-onnx`
 * gives you, and because the failure mode of guessing wrong in that direction
 * is a missing hint rather than a spoken bracket.
 */
const G2P_MODES = Object.freeze(['espeak', 'misaki']);

/**
 * Does this G2P parse markdown-style markup?
 *
 * @param {string} g2p
 * @returns {boolean}
 */
function markupSupported(g2p) {
  return 'misaki' === g2p;
}

/**
 * Flatten a markdown link to its label.
 *
 * @param {string} text
 * @returns {string}
 */
function flattenLinks(text) {
  return text.replace(PREEXISTING_LINK, (match, label, target) => {
    // A bare `[](x)` has no label to keep. An autolink `[x](x)` collapses to one
    // copy. Anything else keeps the human-readable half, which is what a
    // listener would want read out and all a listener could act on anyway.
    const kept = String(label || '').trim();
    if (kept) return kept;
    const fallback = String(target || '').trim();
    // A URL read aloud character by character is worse than silence about it.
    return /^[a-z][a-z0-9+.-]*:\/\//iu.test(fallback) ? '' : fallback;
  });
}

/**
 * Add the punctuation Kokoro needs to give this chunk a contour (Section 6.1,
 * rule 2).
 *
 * ── Why position has to be passed in ──────────────────────────────────────
 *
 * Rule 2 asks for "terminal punctuation for declarative/interrogative contour,
 * commas for continuation rises, ellipsis for trailing pauses". Those are
 * different marks for the same chunk depending on where it sits, and a chunk
 * cannot know that about itself.
 *
 * It matters because the prosody layer synthesises each phrase SEPARATELY. A
 * mid-sentence phrase arriving with no final punctuation gets no contour at all
 * and lands flat; the same phrase given a full stop gets a falling close and
 * the sentence audibly breaks in the middle. So:
 *
 *   'whole'        the entire reply, or the last phrase of it -> terminal mark
 *   'final'        the last phrase of a sentence               -> terminal mark
 *   'continuation' any earlier phrase                          -> comma
 *
 * Nothing is added when the chunk already ends in punctuation of the right
 * kind. Punctuation the author wrote always wins over punctuation we inferred.
 *
 * @param {string} text
 * @param {'whole'|'final'|'continuation'} position
 * @returns {string}
 */
function shapeContour(text, position) {
  if (!text) return text;
  if ('continuation' === position) {
    // Already continuing, or already terminated by the author -- in the second
    // case the author ended a sentence mid-phrase and that is their contour to
    // choose, not ours to overwrite.
    if (CONTINUING.test(text) || TERMINAL.test(text)) return text;
    return `${ text },`;
  }
  if (TERMINAL.test(text)) return text;
  // A chunk ending on a comma or dash and then stopping is a trailing-off, and
  // Section 6.1 names the ellipsis for exactly that. Replacing rather than
  // appending avoids `word,…`, which reads as two beats.
  if (CONTINUING.test(text)) return `${ text.replace(/[,;:—]$/u, '') }…`;
  return `${ text }.`;
}

/**
 * Turn bold markdown into a stress hint, or remove it.
 *
 * `**word**` is the only signal in assistant output that actually means "this
 * word carries weight". Section 6.1 rule 4 says to tag "where the assistant
 * intends prominence" without saying how intent is detected; guessing from
 * sentence position or word class would be inventing intent rather than reading
 * it.
 *
 * On the espeak path the asterisks must come off REGARDLESS of whether emphasis
 * is enabled, because espeak reads them.
 *
 * @param {string} text
 * @param {boolean} emit Whether to emit stress markup.
 * @returns {{text: string, tagged: number}}
 */
function applyEmphasis(text, emit) {
  let tagged = 0;
  const out = text.replace(BOLD, (match, word) => {
    const inner = String(word).trim();
    if (!inner) return '';
    if (!emit) return inner;
    // Only single words are tagged. misaki's stress syntax attaches to one
    // token, and `[three whole words](+2)` is not something it parses -- it
    // would be read as a pronunciation override with "+2" as the phoneme
    // string, which is the spoken-bracket failure again.
    if (/\s/u.test(inner)) return inner;
    tagged += 1;
    return `[${ inner }](${ STRESS_RAISE })`;
  });
  return { text: out, tagged };
}

/**
 * Which lexicon terms actually occur in this text, as whole words?
 *
 * Shared by the override pass and the suppression check so the two cannot
 * disagree about whether a term is present -- a suppression notice for a word
 * that was never there is as misleading as a missing one.
 *
 * @param {string} text
 * @param {Object<string, string>} lexicon
 * @returns {Array<string>}
 */
function lexiconHits(text, lexicon) {
  const hits = [];
  for (const [word, phonemes] of Object.entries(lexicon || {})) {
    const surface = String(word || '').trim();
    const ipa = String(phonemes || '').trim();
    if (!surface || !ipa) continue;
    if (/[[\]()/]/u.test(surface) || ipa.includes('/')) continue;
    const escaped = surface.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${ escaped })(?![\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(text)) hits.push(surface);
  }
  return hits;
}

/**
 * Apply configured pronunciation overrides (Section 6.1, rule 5).
 *
 * The lexicon maps a surface word to a Kokoro phoneme string. It is deliberately
 * empty by default: a wrong phoneme string is a confidently mispronounced brand
 * name, which is worse than the mispronunciation it was meant to fix, and there
 * is no way to validate an IPA string from here.
 *
 * Matching is whole-word and case-insensitive, and the FIRST occurrence in a
 * chunk is tagged rather than every one. Repeating an override on every mention
 * of a product name in a long reply makes the reply sound like it is spelling
 * the word out; once is enough to set the pronunciation for the listener.
 *
 * @param {string} text
 * @param {Object<string, string>} lexicon
 * @returns {{text: string, applied: Array<string>}}
 */
function applyLexicon(text, lexicon) {
  const applied = [];
  let out = text;

  for (const [word, phonemes] of Object.entries(lexicon)) {
    const surface = String(word || '').trim();
    const ipa = String(phonemes || '').trim();
    if (!surface || !ipa) continue;
    // A lexicon entry containing the markup delimiters would break out of its
    // own override and corrupt everything after it.
    if (/[[\]()/]/u.test(surface) || ipa.includes('/')) continue;

    const escaped = surface.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${ escaped })(?![\\p{L}\\p{N}])`, 'iu');
    if (!pattern.test(out)) continue;

    out = out.replace(pattern, (match) => `[${ match }](/${ ipa }/)`);
    applied.push(surface);
  }

  return { text: out, applied };
}

/**
 * Normalise and prepare one chunk of text for Kokoro.
 *
 * Runs the whole Section 6 pipeline in the order Section 6.2 fixes, with the
 * beat marker threaded through so rule 3 is actually reachable.
 *
 * @param {string} input Raw assistant text, or one prosody phrase of it.
 * @param {object} [options]
 * @param {'espeak'|'misaki'} [options.g2p='espeak'] Which phonemiser will run.
 * @param {boolean} [options.emphasis=true] Emit stress markup for bold text.
 * @param {Object<string,string>} [options.lexicon={}] Pronunciation overrides.
 * @param {'whole'|'final'|'continuation'} [options.position='whole']
 * @param {string} [options.beat=','] Punctuation a dialogue beat becomes.
 * @returns {{text: string, beats: number, tagged: number, overrides: Array<string>,
 *            suppressed: Array<string>, g2p: string}}
 */
export function prepareForKokoro(input, options) {
  const o = options || {};
  const g2p = G2P_MODES.includes(o.g2p) ? o.g2p : 'espeak';
  const position = ['whole', 'final', 'continuation'].includes(o.position)
    ? o.position : 'whole';
  const lexicon = (o.lexicon && 'object' === typeof o.lexicon) ? o.lexicon : {};
  const beat = ('string' === typeof o.beat && o.beat) ? o.beat : ',';
  const wantEmphasis = (undefined === o.emphasis) ? true : Boolean(o.emphasis);
  const wantLexicon = Object.keys(lexicon).length > 0;

  const suppressed = [];
  const canMarkup = markupSupported(g2p);

  // Reported only when something was ACTUALLY suppressed -- when the text
  // contains bold, or a lexicon term genuinely appears in it. The first draft
  // reported on capability rather than occurrence, which meant every espeak
  // utterance carried a suppression notice whether or not it had any emphasis
  // in it. A warning that fires on all traffic is one an admin learns to
  // ignore, which costs the warning its only purpose.
  //
  // Recorded rather than silently dropped, though: an admin who switched
  // emphasis on is entitled to know why nothing changed, and the alternative --
  // emitting markup espeak reads aloud -- is a worse voice, not a degraded one.
  const raw = 'string' === typeof input ? input : '';
  if (wantEmphasis && !canMarkup && new RegExp(BOLD.source, 'u').test(raw)) {
    suppressed.push('emphasis_needs_misaki_g2p');
  }
  if (wantLexicon && !canMarkup && lexiconHits(raw, lexicon).length) {
    suppressed.push('lexicon_needs_misaki_g2p');
  }

  // 1. Section 6.1 rule 1. The beat is preserved as a marker rather than a
  //    space so rule 3 below has something to act on.
  let text = normalizeForSpeech(input, { beatMarker: BEAT_MARKER });
  if (!text) {
    return { text: '', beats: 0, tagged: 0, overrides: [], suppressed, g2p };
  }

  // 2. Flatten the assistant's own markdown links before injecting any of ours.
  //    Order matters: reversed, this would strip our own overrides.
  text = flattenLinks(text);

  // 3. Section 6.1 rule 3. The beat becomes punctuation Kokoro reads as a
  //    phrase boundary, not a gap it ignores.
  const beats = (text.match(new RegExp(BEAT_MARKER, 'gu')) || []).length;
  text = text.replace(new RegExp(`\\s*${ BEAT_MARKER }\\s*`, 'gu'), (match, offset) => {
    // The real dialogue shape is `audit,""Honestly` -- the closing quote follows
    // a COMMA the author already wrote. Appending our own would yield
    // `audit,, Honestly`, and Kokoro reads a doubled comma as two beats, so the
    // reply stumbles exactly where it was supposed to breathe.
    //
    // Where the author's punctuation is already there, it IS the beat, and this
    // rule only has to make sure a space survives to separate the clauses.
    const before = offset > 0 ? text[offset - 1] : undefined;
    if (undefined !== before && KOKORO_PUNCTUATION.includes(before)) return ' ';
    return `${ beat } `;
  });

  // 4. Section 6.1 rule 4. Bold becomes a stress hint where the G2P can read
  //    one; the asterisks come off either way, because espeak speaks them.
  const emphasised = applyEmphasis(text, wantEmphasis && canMarkup);
  text = emphasised.text;

  // 5. Section 6.1 rule 5.
  let overrides = [];
  if (wantLexicon && canMarkup) {
    const lexed = applyLexicon(text, lexicon);
    text = lexed.text;
    overrides = lexed.applied;
  }

  // 6. Section 6.1 rule 2, LAST. Contour shaping inspects the final character,
  //    so it has to run after every transform that can change it -- a beat
  //    rewritten to a trailing comma, or a flattened link that removed the last
  //    word, both move the character this decision reads.
  text = shapeContour(text.trim(), position);

  // Whitespace tidy. The beat rewrite and the link flattening can both leave a
  // double space, and Kokoro's tokenizer treats runs of space inconsistently.
  text = text.replace(/[^\S\r\n]+/gu, ' ')
    .replace(/\s+([,.;:!?…])/gu, '$1')
    .trim();

  return { text, beats, tagged: emphasised.tagged, overrides, suppressed, g2p };
}

/**
 * The punctuation inventory Kokoro interprets, for tests and admin display.
 *
 * @returns {string}
 */
export function kokoroPunctuation() {
  return KOKORO_PUNCTUATION;
}

export default prepareForKokoro;
