/* voice-text-normalize.js  --  strip typographic artifacts from TTS input.
 *
 * VOICE-TTS-NORMALIZE-v1.0 (Voice TTS Text Normalization Specification)
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 *
 * Piper's phonemiser is handed raw text. Typographic quote characters are not
 * punctuation to it -- depending on the voice and the surrounding context they
 * are either voiced as a glyph name or absorbed into the neighbouring word and
 * mis-stressed. Section 1: no typographic glyph is ever read aloud, and a
 * spoken beat survives where two quoted clauses meet.
 *
 * ===========================================================================
 * WHY IT IS A PURE FUNCTION IN ITS OWN FILE
 * ===========================================================================
 *
 * voice-engines.js spawns processes. This spawns nothing, reads nothing and
 * holds no state, so it can be tested exhaustively without Piper, a model, or
 * a venv -- which matters because Piper is not installed in CI, and a test
 * that needs it is a test that gets skipped. Every rule below is asserted in
 * src/tests/voice-text-normalize.test.js against string inputs.
 *
 * It is also why importing it into voice-engines.js cannot change the
 * behaviour of anything else: there is nothing here to go wrong at load.
 *
 * ===========================================================================
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ===========================================================================
 *
 *   1. Delete zero-width and format controls.
 *   2. Repair intra-word typographic apostrophes to ASCII.   <-- see below
 *   3. Replace runs of delimiter quotes: space if that would otherwise weld
 *      two words together, nothing otherwise.
 *   4. Resolve the ASCII apostrophe, which is the one quote character that is
 *      sometimes a letter.
 *   5. Collapse horizontal whitespace and trim.
 *
 * Step 2 MUST precede steps 3 and 4. Reversing them turns "don’t" into "don t"
 * or "dont", both of which the phonemiser reads as something that is not the
 * word.
 *
 * ===========================================================================
 * A DEVIATION FROM THE SPECIFICATION, STATED PLAINLY
 * ===========================================================================
 *
 * Section 3 lists U+2019 under "smart quotes -- stripped (the confirmed
 * culprit)". Section 5 protects the ASCII apostrophe in "it's", "don't",
 * "Brian's", because stripping it "produces misspelled words the phonemiser
 * then mis-reads".
 *
 * Taken literally those two rules contradict each other on the single most
 * common case in the corpus. U+2019 is the RIGHT SINGLE QUOTATION MARK, and it
 * is also the character Word, iOS, macOS and essentially every language model
 * emit for an apostrophe. "don’t" is far more common in this pipeline than
 * "don't". Stripping U+2019 unconditionally yields "dont", "its", "Brians" --
 * exactly the misspellings Section 5 exists to prevent, reached by obeying
 * Section 3.
 *
 * So U+2018 and U+2019 are resolved by POSITION rather than by identity:
 *
 *   - Between two letters, it is an apostrophe. Converted to ASCII "'", which
 *     is the form Section 5 states the phonemiser handles correctly.
 *   - Anywhere else, it is a delimiter. Stripped, as Section 3 requires.
 *
 * This satisfies the intent of both sections. It is flagged here, and in the
 * changelog, because it is a judgement about the specification rather than an
 * implementation of it.
 *
 * ===========================================================================
 * TWO MORE JUDGEMENTS WORTH KNOWING ABOUT
 * ===========================================================================
 *
 * MERGING BEATS THE LETTER OF RULE 4. Section 4 says a lone quote boundary is
 * deleted, and an adjacent closing/opening PAIR becomes one space. It also
 * says, as an invariant, that "consecutive quote deletions must not merge two
 * adjacent words into one". For the input `word"word` those two rules
 * disagree: the first deletes and produces `wordword`, the second forbids it.
 *
 * The invariant wins, and it is generalised: ANY run of delimiter quotes with
 * a word character on both sides becomes one space. The specification's pair
 * case is the common instance of that rule rather than an exception to it, and
 * phrasing it this way means a run of three, or a guillemet meeting a smart
 * quote, needs no further special case.
 *
 * WHITESPACE COLLAPSE IS HORIZONTAL ONLY. Section 6 defaults to a global
 * collapse of two or more spaces to one. Done globally over ALL whitespace
 * that would fold newlines away too, and prosody.js splits paragraphs on blank
 * lines -- so on the flat path, where the whole reply passes through here in
 * one piece, a global collapse would silently change how a multi-paragraph
 * reply is segmented. Runs of spaces and tabs collapse to one space; line
 * structure is left exactly as it was. This meets Section 6's stated purpose
 * (no double space where a quote was removed) without reaching outside it.
 */

'use strict';

/**
 * Zero-width and format controls (Section 3, row 4).
 *
 * Deleted outright with NO replacement, which is the one class where deletion
 * cannot weld two words together: these characters are already invisible, so
 * the text either side of them was never visually separated by them either.
 *
 * U+00AD is the soft hyphen. It is in this class rather than treated as
 * punctuation because it is a rendering hint, not a character anyone intends
 * to be spoken or to break a word at.
 */
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/gu;

/**
 * The single quotes that can also be apostrophes (Section 5's real scope).
 *
 * U+2018 is included alongside U+2019 because OCR, some editors and a few
 * older templates emit the opening form mid-word. Between two letters it can
 * only be an apostrophe, whichever direction it points.
 */
const APOSTROPHE_LIKE = /(\p{L})[\u2018\u2019](?=\p{L})/gu;

/**
 * Delimiter quotes: every quote class in Section 3 except the ASCII
 * apostrophe, which is resolved separately because it is sometimes a letter.
 *
 *   U+2018 U+2019 U+201C U+201D    smart quotes
 *   U+201A U+201B U+201E U+201F    low-9 and single-high
 *   U+00AB U+00BB U+2039 U+203A    guillemets
 *   "                              ASCII double, never intra-word
 *
 * Any U+2018/U+2019 still present at this point has already failed the
 * intra-word test above, so it is genuinely a delimiter.
 */
const DELIMITER_QUOTES =
  /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A"]+/gu;

/** A character that carries sound: deleting a quote between two of these welds words. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Horizontal whitespace only. Newlines are deliberately not in this class. */
const HORIZONTAL_WS = /[^\S\r\n]+/g;

/**
 * Is this character one that a quote must not be allowed to weld to its
 * neighbour?
 *
 * @param {string|undefined} ch
 * @returns {boolean}
 */
function isWordChar(ch) {
  return 'string' === typeof ch && ch.length > 0 && WORD_CHAR.test(ch);
}

/**
 * Normalise text for the synthesis engine.
 *
 * Idempotent: normalising already-normalised text returns it unchanged, which
 * matters because the flat path and the prosody path both reach the choke
 * point and a phrase could otherwise be transformed twice.
 *
 * Never throws. A non-string, null or undefined input returns an empty string,
 * because the caller's next move on empty text is already defined (it raises
 * empty_text) and a type error raised from here would surface to a user as a
 * 500 on a request that merely had nothing in it.
 *
 * ── options.beatMarker (v13, SPEC-KOKORO-001 Section 6.2) ─────────────────
 *
 * Section 6.2 mandates that normalisation runs FIRST and the prosody
 * preprocessor SECOND. Taken literally that ordering makes Section 6.1's third
 * rule -- inject dialogue beats as commas or ellipses rather than spaces --
 * impossible to implement, because by the time the preprocessor runs this
 * function has already replaced the quote pair with a PLAIN SPACE. `word""word`
 * and `word word` are then indistinguishable, and the beat is gone.
 *
 * So the beat replacement is a parameter. The Kokoro path passes a sentinel,
 * and voice-prosody-prep.js rewrites it to punctuation Kokoro interprets. The
 * DEFAULT IS UNCHANGED -- a single space, exactly as v12.54.3 behaved -- so
 * every existing caller, and the Piper path for as long as it exists, is
 * unaffected.
 *
 * A caller passing a sentinel is opting into a two-stage pipeline: the output
 * is NOT safe to hand to an engine until the preprocessor has resolved the
 * marker. That is the caller's contract to keep, and it is why the default is
 * the safe value rather than the useful one.
 *
 * @param {string} input Raw reply text, or one prosody phrase of it.
 * @param {{beatMarker?: string}} [options]
 * @returns {string} Text safe to hand to the phonemiser, unless a beatMarker
 *   was supplied, in which case text for voice-prosody-prep.js.
 */
export function normalizeForSpeech(input, options) {
  if ('string' !== typeof input || '' === input) return '';

  const opts = options || {};
  // A non-string or empty marker would silently delete the beat, which is the
  // failure this parameter exists to prevent, so it falls back to the space
  // rather than honouring a marker that cannot carry the information.
  const beatMarker = ('string' === typeof opts.beatMarker && '' !== opts.beatMarker)
    ? opts.beatMarker
    : ' ';

  // 1. Invisible controls. No replacement: see ZERO_WIDTH.
  let out = input.replace(ZERO_WIDTH, '');

  // 2. Intra-word typographic apostrophe -> ASCII. The lookahead means the
  //    following letter is NOT consumed, so "o’clock’s" resolves both marks
  //    rather than only the first.
  out = out.replace(APOSTROPHE_LIKE, "$1'");

  // 3. Delimiter quote runs. The replacer inspects the characters either side
  //    of the whole run, so `,”“H` is one decision rather than two deletions
  //    that each look harmless alone.
  out = out.replace(DELIMITER_QUOTES, (match, offset, whole) => {
    const before = offset > 0 ? whole[offset - 1] : undefined;
    const after = whole[offset + match.length];
    // A SPACE when the run is followed by a word and preceded by anything
    // that is not whitespace.
    //
    // Both halves of that test earn their place:
    //
    //   "after is a word" is what makes the space necessary. If what follows
    //   is punctuation or whitespace, the gap is already there and inserting
    //   another produces `hi .` out of `hi".`.
    //
    //   "before is not whitespace" is what makes it safe. When a space already
    //   precedes the quote, as in `word" "word`, each run is deleted and the
    //   existing space keeps the words apart; adding one would double it.
    //
    // Together they cover both of Section 4's cases in one rule. `word"word`
    // has a letter on each side. `audit,""Honestly` -- the real shape of the
    // dialogue beat, where the closing quote follows a comma -- has
    // punctuation before and a letter after, and it is the case a
    // word-character-on-both-sides test silently gets wrong, welding the
    // clauses into `audit,Honestly`.
    const beat = undefined !== before && ! /\s/u.test(before) && isWordChar(after);
    return beat ? beatMarker : '';
  });

  // 4. The ASCII apostrophe, last, and by position.
  //
  //    Between two letters it is part of the word ("it's", "don't") and is
  //    KEPT untouched -- Section 5 is explicit that removing it is what breaks
  //    the phonemiser. Everywhere else it is a delimiter and goes.
  //
  //    Deleting rather than spacing is safe here precisely BECAUSE the
  //    both-sides-letters case has already been excluded: a surviving
  //    apostrophe has a non-letter on at least one side, so removing it cannot
  //    weld two words. Possessive plurals ("students'") lose a mark that was
  //    never voiced; leading elisions ("'em", "'90s") lose one too, which is
  //    the Section 6 default of stripping ASCII delimiters.
  out = out.replace(/'/gu, (match, offset, whole) => {
    const before = offset > 0 ? whole[offset - 1] : undefined;
    const after = whole[offset + 1];
    const letter = /\p{L}/u;
    const inWord = 'string' === typeof before && letter.test(before)
                && 'string' === typeof after && letter.test(after);
    return inWord ? "'" : '';
  });

  // 5. Collapse the gaps the deletions left. Horizontal only -- see the header
  //    note on why newlines are preserved.
  // The marker is deliberately not whitespace when a caller supplies one, so
  // this collapse cannot eat it. With the default marker it IS a space, and
  // collapsing is exactly the intent: a beat next to an existing space must not
  // double it.
  out = out.replace(HORIZONTAL_WS, ' ');
  // A line that is now only spaces, or one left with a trailing space by a
  // removed closing quote, would otherwise reach the engine as an empty
  // utterance.
  out = out.replace(/[^\S\r\n]*(\r?\n)[^\S\r\n]*/g, '$1');

  return out.trim();
}

/**
 * Would this text produce any speech at all?
 *
 * Used by the prosody layer to drop a phrase that was nothing but typography
 * BEFORE it is sent for synthesis. Without this, a fragment consisting only of
 * an opening quote normalises to nothing, raises empty_text from
 * synthesizePcm, and -- because empty_text is on the not-worth-retrying list
 * -- fails the whole reply with a 422 rather than the one phrase that had
 * nothing in it.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isSpeakable(input) {
  return normalizeForSpeech(input).length > 0;
}

export default normalizeForSpeech;
