// src/homework/homework-normalise.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6, the
// normalisation rules behind the agreement gate.
//
// ===========================================================================
// WHAT THIS IS FOR
// ===========================================================================
//
// Before a student's answer is marked, the question it was written under has to
// be confirmed as the question the registry holds. Section 6:
//
//   "No question is ever assessed against an answer key unless the uploaded
//    question agrees with the registry."
//
// The upload is a docx a student has typed into, printed, re-typed or pasted.
// The registry text came from a JSON spec. The two are the same question and
// almost never the same string: one has a curly apostrophe, the other straight;
// one says "$1,200.00", the other "$1200"; one ends with a full stop the
// student did not copy.
//
// This module makes both sides comparable WITHOUT making unrelated questions
// look alike.
//
// ===========================================================================
// THE PROPERTY THAT MATTERS, AND IT IS NOT "CORRECTNESS"
// ===========================================================================
//
// Every rule below is applied to BOTH sides of the comparison. That changes
// what a rule has to get right.
//
// A rule that transforms text in a way a linguist would dispute is harmless so
// long as it transforms both sides IDENTICALLY -- the two strings still match
// when they should. What breaks the gate is an ASYMMETRIC rule: one that
// depends on something only one side has (its source, its length, its
// surrounding context), because then the same question normalises two ways.
//
// So the rules here are deliberately blunt and total. `1,234` is read as a
// thousands separator rather than a European decimal comma, not because that is
// always right, but because it is always THE SAME, and both sides get it.
// Guessing per-string would be the asymmetric failure.
//
// The one thing a rule must never do is erase a distinction that separates two
// DIFFERENT questions. That is the real ceiling on how aggressive normalisation
// can be, and it is why digits, operators and fraction slashes survive while
// decorative punctuation does not: "What is 15% of 240?" and
// "What is 15% of 260?" must stay different, while "Question 3. Simplify 18/24"
// and "Simplify 18/24." must not.
//
// ===========================================================================
// TWO INDEPENDENT DEFENCES AROUND NUMBERS
// ===========================================================================
//
// `1,234.50` must never normalise to `123450`. That would be a hundredfold
// error, and it would make two genuinely different money amounts compare equal
// with nothing looking wrong.
//
// Two mechanisms prevent it, and it is worth being precise about which does the
// work, because an earlier version of this comment claimed the ordering was
// load-bearing and mutation testing showed it is not:
//
//   1. ORDER. Numbers are canonicalised before punctuation is stripped, so the
//      separators are already gone by the time the punctuation rules run.
//
//   2. LOOKAROUND. The punctuation rules are written as `\.(?!\d)` and
//      `(?<!\d),` -- they decline to touch a separator that sits between
//      digits, whenever they run.
//
// Either alone is sufficient. Reversing the order does NOT break the output,
// because the lookarounds still refuse to eat the separators; removing the
// lookarounds does not break it either, because the ordering has already
// consumed them. That is defence in depth rather than one fragile step, and no
// single mutation to either mechanism will reveal itself in the tests.
//
// Both are kept deliberately. The cost is one redundant guarantee; the cost of
// keeping only one is that a later refactor moves a line and silently removes
// the only protection a hundredfold error had.

'use strict';

// ===========================================================================
// INVARIANT: TWO COMPARISONS, OPPOSITE STRICTNESS. DO NOT UNIFY THEM.
// ===========================================================================
//
// This module exports two comparison functions and they are not
// interchangeable. Anyone tempted to collapse them into one should read this
// first, because that collapse has already happened once and it marked a
// flawless student paper one out of nine.
//
//   agrees( a, b )        compares QUESTIONS. Maximum strictness. Every
//                         distinction must survive, because two questions
//                         differing by a currency symbol, a digit or an
//                         operator are DIFFERENT QUESTIONS. Erasing a
//                         difference here lets an answer be marked against a
//                         question the student never answered.
//
//   answersAgree( k, a )  compares ANSWERS against a marking key. Deliberately
//                         looser. `160` and `$160` are the SAME ANSWER, and a
//                         student who omits a unit has still given the right
//                         number. Strictness here does not protect anyone; it
//                         just marks correct work wrong.
//
// The two failure directions are also opposite, which is why one rule cannot
// serve both:
//
//   On a QUESTION, a false match is the catastrophe -- it marks the wrong
//   question and the result looks plausible.
//   On an ANSWER, a false MISS is the common harm -- the student was right and
//   is told otherwise, over the tutor's choice of formatting.
//
// `answersAgree` is built on `agrees` and can only ever be more permissive, so
// tightening the question rule automatically tightens both. The reverse is not
// true and must never be assumed.
// ===========================================================================

/**
 * Currency symbols, all folded to a single marker.
 *
 * The gate compares whether two strings describe the same question, not which
 * currency it is denominated in. A worksheet typed with `$` and a registry
 * entry carrying `AUD $` are the same question; treating them as different
 * would quarantine a correct answer.
 *
 * Folded to a WORD rather than deleted, so `$5` and `5` stay distinguishable:
 * "spend $5" and "spend 5" are not obviously the same question, and deleting
 * the symbol would assert that they are.
 */
const CURRENCY = {
  '$': ' curusd ',
  '\u00A3': ' curgbp ',
  '\u20AC': ' cureur ',
  '\u00A5': ' curjpy ',
  '\u20B9': ' curinr ',
  '\u00A2': ' curcent ',
  '\u20A9': ' curkrw ',
  '\u20BD': ' currub ',
  '\u20BA': ' curtry ',
};

const CURRENCY_CHARS = /[$\u00A3\u20AC\u00A5\u20B9\u00A2\u20A9\u20BD\u20BA]/g;

/**
 * Currency WORDS, folded to the same tokens as the symbols.
 *
 * Without this a student who writes the currency out has given a different
 * answer from the key that used the symbol, which is a false miss on work that
 * is correct.
 *
 * `pounds` is DELIBERATELY ABSENT. It is mass as well as currency and nothing
 * in an answer string resolves which, so mapping it would make "5 pounds" of
 * flour match "\u00A35" -- a false match, the silent direction. Left as its own
 * unit, "\u00A35" against "5 pounds" is a false MISS instead, which the
 * tutor-review routing exists to catch. Erring toward the visible failure is
 * the whole discipline of this module.
 */
const CURRENCY_WORDS = [
  [ /\bdollars?\b/gi, ' curusd ' ],
  [ /\beuros?\b/gi, ' cureur ' ],
  [ /\byen\b/gi, ' curjpy ' ],
  [ /\brupees?\b/gi, ' curinr ' ],
  [ /\bcents?\b/gi, ' curcent ' ],
];

/**
 * Punctuation with no bearing on which question this is.
 *
 * Everything NOT in this set survives. The exclusions are the point:
 *
 *   .  survives -- it is a decimal point (handled by the number rules first)
 *   ,  survives -- thousands separator (same)
 *   /  survives -- fractions and dates: 18/24 is not 1824
 *   -  survives -- negatives and ranges: -5 is not 5
 *   %  survives -- 15% is not 15
 *   =  < >  ^  survive -- they carry the mathematics
 *   ( )  survive -- they group it
 *
 * Removed: sentence punctuation and quoting, which a student re-typing a
 * question drops or adds freely.
 *
 * The straight apostrophe is in this set alongside the curly ones, and that
 * pairing is not cosmetic. An earlier version listed only the curly forms, so
 * `What\u2019s 15% of 240?` normalised to `what s ...` while the straight-quoted
 * `What's 15% of 240?` kept its apostrophe and normalised to `what's ...`. The
 * same question, typed two ways, stopped matching itself.
 *
 * That is precisely the ASYMMETRIC rule this module's header warns against, and
 * it is the failure mode to watch for whenever a character is added here: a
 * character and every variant a word processor can substitute for it must be
 * treated alike, or the gate quarantines correct work.
 */
const DECORATIVE = /[?!;:"'`\u2018\u2019\u201C\u201D\u00AB\u00BB\u2039\u203A*_~#@\u2022\u00B7\[\]{}]/g;

/**
 * Dash-like characters folded to ASCII hyphen.
 *
 * A docx pipeline turns a typed hyphen into an en dash without asking. The
 * minus sign in `-5` must survive as SOMETHING, but it does not matter which,
 * so long as both sides agree.
 */
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;

/**
 * Whitespace, including the non-breaking and zero-width kinds a docx emits.
 *
 * `\u00A0` is the one that matters most: Word inserts it between a currency
 * symbol and its amount, and it is invisible in every diff a human would run
 * while trying to work out why two identical-looking strings did not match.
 */
const WHITESPACE = /[\s\u00A0\u2000-\u200B\u202F\u205F\u3000]+/g;

/**
 * A number, with optional grouping and decimals.
 *
 * Anchored on a digit at both ends so it cannot swallow a trailing separator:
 * in "pay 1,200, then stop", the second comma is punctuation, not grouping.
 */
const NUMBER = /\d[\d,\u00A0\u202F ]*(?:\.\d+)?/g;

/**
 * Collapse one numeric token to a canonical form.
 *
 * Three transformations, all from Section 6:
 *
 *   thousands separators removed   1,234 -> 1234
 *   decimal point normalised        already `.` by this stage
 *   trailing zeros dropped          36.00 -> 36,  0.50 -> 0.5
 *
 * ── Why `1,234` is read as grouping and never as a European decimal ───────
 *
 * `1,234` is genuinely ambiguous: 1234 in Australia, 1.234 in Germany. Nothing
 * in the string resolves it, and the registry does not record a locale.
 *
 * Guessing per-token would be the asymmetric failure this module exists to
 * avoid -- the same value could resolve one way in the registry text and the
 * other in the upload, and a question would stop matching itself. A fixed
 * reading is applied to both sides, so the two agree even when the reading is
 * wrong for a German worksheet. What is lost in that case is a distinction
 * between two numbers that differ only by a factor of a thousand AND appear in
 * otherwise identical questions, which is a far narrower loss than a gate that
 * quarantines correct work.
 *
 * @param {string} token
 * @returns {string}
 */
function canonicaliseNumber( token ) {
  // Separators out. Space and NBSP are grouping characters in several locales
  // and Word inserts them unprompted.
  const stripped = token.replace( /[,\u00A0\u202F ]/g, '' );

  if ( ! /^\d+(?:\.\d+)?$/.test( stripped ) ) return stripped;
  if ( ! stripped.includes( '.' ) ) return stripped;

  // Trailing zeros, then a bare trailing point. `36.` and `36.000` are the
  // same mark as `36` on any worksheet.
  let out = stripped.replace( /0+$/, '' );
  if ( out.endsWith( '.' ) ) out = out.slice( 0, -1 );
  return out;
}

/**
 * Normalise a question or answer for comparison.
 *
 * Pure and total: no clock, no locale lookup, no state. The same input always
 * yields the same output, which is what lets the registry side be normalised at
 * one time and the upload side at another and still agree.
 *
 * @param {string} input
 * @returns {string} '' for anything unusable.
 */
export function normalise( input ) {
  if ( 'string' !== typeof input ) return '';

  // NFKC first. It folds the full-width digits and ligatures a copy-paste out
  // of a PDF can carry, so `１５％` and `15%` reach the later rules as the same
  // characters rather than being declared different questions.
  let s = input.normalize( 'NFKC' );

  s = s.replace( DASHES, '-' );
  s = s.replace( CURRENCY_CHARS, ( c ) => CURRENCY[ c ] || ' ' );

  // Defence 1 of 2 (see the header). The lookarounds in the punctuation rules
  // below are the other; either alone would hold.
  // BEFORE the number rule, which is not obvious and cost a debugging pass.
  //
  // NUMBER's character class includes a space, so "160 dollars" canonicalises
  // to "160dollars" -- and the \b in front of `dollars` then has no boundary to
  // anchor to, because "0" and "d" are both word characters. Run afterwards,
  // the lexicon silently never fires.
  //
  // Case-insensitive because this runs before the lowercase fold.
  for ( const [ pattern, token ] of CURRENCY_WORDS ) s = s.replace( pattern, token );

  s = s.replace( NUMBER, canonicaliseNumber );

  s = s.toLowerCase();
  s = s.replace( DECORATIVE, ' ' );

  // Defence 2 of 2. The lookarounds are what make these rules safe to run in
  // any order relative to the number canonicalisation above: neither will touch
  // a separator sitting between digits.
  //
  // A student re-typing "Simplify 18/24." drops the trailing stop as often as
  // not, and "Question 3." is numbering rather than identity, so both have to
  // go -- but only when they are not part of a number.
  s = s.replace( /\.(?!\d)/g, ' ' );
  // Between DIGITS, not merely after one. An earlier version used `(?<!\d),`,
  // which checks only the left side -- so the list comma in "1,234.50, then
  // stop" survived, because it happened to follow a digit. A student who typed
  // the same sentence without that comma produced a different normalised
  // string, which is the asymmetry this module exists to avoid.
  s = s.replace( /(?<!\d),|,(?!\d)/g, ' ' );

  s = s.replace( WHITESPACE, ' ' );
  return s.trim();
}

/**
 * Do two texts describe the same question?
 *
 * Exact equality AFTER normalisation, deliberately. Section 6 defines the
 * passing outcome as `exact_match`, and the alternative -- a similarity score
 * with a threshold -- would put a tunable number between a student's work and
 * whether it gets marked correctly. A gate that is 92% sure is a gate that
 * marks the wrong question sometimes, and the failure would be invisible: the
 * mark comes back plausible either way. That is precisely the class of failure
 * this whole feature exists to remove.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function agrees( a, b ) {
  const na = normalise( a );
  const nb = normalise( b );
  if ( ! na || ! nb ) return false;
  return na === nb;
}

/**
 * Do a student's answer and the marking key agree?
 *
 * ── Why this is NOT `agrees` ──────────────────────────────────────────────
 *
 * `agrees` compares QUESTIONS, where every distinction must survive: two
 * questions differing by a currency symbol are different questions, so the
 * symbol is preserved as a marker rather than deleted.
 *
 * This compares ANSWERS, where the opposite is true. `160` and `$160` are the
 * same answer. So are `92` and `92 m²`, and `8` and `x = 8`. A student who
 * omits the unit has still given the right number.
 *
 * Measured on a real submitted worksheet: with keys written the way a tutor
 * actually writes them -- `$160`, `92 m²`, `x = 8` -- strict comparison scored
 * 1 of 9 correct answers as right. Every other question on a correct paper was
 * marked wrong. Reusing the question rule for answers was the defect.
 *
 * ── Why this is still not a similarity threshold ─────────────────────────
 *
 * The fallback is exact NUMERIC equality, not fuzzy matching. Both sides must
 * reduce to exactly one number, those numbers must be equal, and any units
 * present on both sides must match. Nothing here is tunable and nothing is
 * scored by degree, so the objection to a threshold -- that it marks the wrong
 * thing sometimes, invisibly -- does not apply.
 *
 * @param {string} key The marking key from the registry.
 * @param {string} answer The student's answer as extracted.
 * @returns {boolean}
 */
export function answersAgree( key, answer ) {
  if ( agrees( key, answer ) ) return true;

  const a = numericForm( key );
  const b = numericForm( answer );
  if ( ! a || ! b ) return false;

  if ( a.value !== b.value ) return false;

  // Units must not CONTRADICT. Absent on one side is a presentation omission
  // and the number is still right; `m` against `km` is a different answer, and
  // treating those as equal would be the false match this whole feature exists
  // to prevent.
  if ( a.unit && b.unit && a.unit !== b.unit ) return false;

  return true;
}

/**
 * Reduce a value to a single number plus an optional unit.
 *
 * Returns null unless the text contains exactly ONE number. Two numbers means
 * the answer is a range, a coordinate, a working-out or a sentence, and none of
 * those may be compared this way -- "between 5 and 10" must not match "5".
 *
 * @param {string} text
 * @returns {{ value: number, unit: string }|null}
 */
function numericForm( text ) {
  if ( 'string' !== typeof text ) return null;

  // The question normaliser first, so separators, currency and case are already
  // canonical and the two sides are being read the same way.
  const n = normalise( text );
  if ( ! n ) return null;

  // Unit exponents, removed before the number count.
  //
  // NFKC folds `m²` to `m2`, so an area answer carries a second "number" that
  // is part of the unit rather than part of the value. Left in place, `92 m²`
  // looks like two numbers and is refused -- which marked a correct area answer
  // wrong on a real submitted worksheet.
  //
  // Keyed on the preceding letter: a digit immediately after a letter is an
  // exponent or a unit suffix, never a value, because a value is always
  // preceded by a space, an operator or the start of the string.
  const withoutExponents = n.replace( /(?<=[a-z])\d+/g, '' );

  const numbers = withoutExponents.match( /-?\d+(?:\.\d+)?/g );
  if ( ! numbers || 1 !== numbers.length ) return null;

  const value = Number( numbers[ 0 ] );
  if ( ! Number.isFinite( value ) ) return null;

  // Whatever is left once the number, the currency marker and the algebraic
  // `x =` preamble are removed. An answer written `x = 8` is the same answer as
  // `8`; the student restated the variable.
  //
  // Taken from the ORIGINAL normalised form, not the exponent-stripped one, so
  // `m²` and `m³` remain different units.
  // The currency token is KEPT, because it IS the unit. Stripping it -- which
  // an earlier version did -- made every symbol-prefixed amount unit-less, so
  // the absent-unit rule then matched it against any other currency.
  const unit = n
    .replace( numbers[ 0 ], ' ' )
    // A LABEL of any length, not just a single letter. The reference spec's own
    // example key is "Area = 12 cm2", and stripping only `x =` left the unit as
    // "areacm2" -- so a student writing "12" was marked correct while one
    // writing "12 cm2", the more complete answer, was marked wrong.
    .replace( /^[a-z\s]*=\s*/, ' ' )
    .replace( /[^a-z0-9]/g, '' )
    .trim();

  return { value, unit };
}

/**
 * Classify one registry question against what the upload carried.
 *
 * Returns the `match_status` vocabulary from Section 4 verbatim, so the caller
 * writes the value straight to the column and no second mapping can drift from
 * this one.
 *
 * @param {string} registryQuestion Canonical text from homework_questions.
 * @param {string|null} uploadedQuestion Question text as it appeared, if found.
 * @param {string|null} studentAnswer The answer that followed it, if found.
 * @returns {{ status: 'exact_match'|'mismatch'|'missing', reason: string }}
 */
export function classify( registryQuestion, uploadedQuestion, studentAnswer ) {
  const answer = 'string' === typeof studentAnswer ? studentAnswer.trim() : '';

  // `missing` outranks `mismatch`. Section 6 treats them as different
  // outcomes with different handling -- a missing answer is written with an
  // empty answer and flagged, while a mismatch is quarantined for the tutor.
  // Reporting a blank answer as a mismatch would send the tutor hunting for a
  // wording discrepancy that does not exist, when the student simply skipped
  // the question.
  if ( ! answer ) {
    return { status: 'missing', reason: 'no answer was found for this question' };
  }

  if ( ! uploadedQuestion || ! normalise( uploadedQuestion ) ) {
    return {
      status: 'mismatch',
      reason: 'the upload carried an answer but no question text to confirm it against',
    };
  }

  if ( agrees( registryQuestion, uploadedQuestion ) ) {
    return { status: 'exact_match', reason: '' };
  }

  return {
    status: 'mismatch',
    reason: 'the uploaded question text does not agree with the registry',
  };
}

export default { normalise, agrees, answersAgree, classify };
