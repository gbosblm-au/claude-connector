// src/tests/homework-normalise.test.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6.
//
// ===========================================================================
// WHAT THIS SUITE IS SHAPED AROUND
// ===========================================================================
//
// The gate has two failure directions and they are not equally bad, so they are
// tested differently.
//
//   FALSE MISMATCH -- the same question, typed two ways, stops matching itself.
//   The student's correct work is quarantined and a tutor is sent looking for a
//   wording discrepancy that does not exist. Noisy, visible, wastes time.
//
//   FALSE MATCH -- two DIFFERENT questions normalise alike. The student's
//   answer is marked against the wrong answer key, and the mark that comes back
//   is plausible either way. Silent, and the exact class of failure this whole
//   feature exists to remove.
//
// So the false-match tests are the important half, and they are written as
// near-miss pairs: strings that differ by one digit, one operator, one sign.
// Anything that erases such a difference is a defect no matter how convenient
// it looks.
//
// The suite also tests SYMMETRY directly. Every rule is applied to both sides,
// so a rule that treats a character and its word-processor substitute
// differently breaks the gate — which is how the straight-vs-curly apostrophe
// bug was found while writing this file.

import test   from 'node:test';
import assert from 'node:assert/strict';

import { normalise, agrees, answersAgree, classify } from '../homework/homework-normalise.js';

// ===========================================================================
// The Section 6 rules, one at a time
// ===========================================================================

test( 'whitespace is trimmed and collapsed', () => {
  assert.equal( normalise( '   Simplify   18/24   ' ), 'simplify 18/24' );
  assert.equal( normalise( 'line\nbreak\tand\ttabs' ), 'line break and tabs' );

  // The invisible ones a docx emits. NBSP is the one that matters most: Word
  // inserts it between a currency symbol and its amount, and it survives every
  // diff a human would run while wondering why two identical-looking strings
  // did not match.
  assert.equal( normalise( 'a\u00A0b\u2009c\u202Fd' ), 'a b c d' );
} );

test( 'case is folded', () => {
  assert.equal( normalise( 'WHAT IS 15% OF 240' ), 'what is 15% of 240' );
  assert.ok( agrees( 'Simplify The Fraction', 'simplify the fraction' ) );
} );

test( 'thousands separators go and decimals are canonical', () => {
  assert.equal( normalise( '1,234' ), '1234' );
  assert.equal( normalise( '1,234,567' ), '1234567' );
  assert.equal( normalise( '1,234.50' ), '1234.5' );

  // Space and NBSP are grouping characters in several locales, and Word
  // inserts them unprompted.
  assert.equal( normalise( '1\u00A0234' ), '1234' );
} );

test( 'trailing zeros are dropped', () => {
  assert.equal( normalise( '36.00' ), '36' );
  assert.equal( normalise( '36.' ), '36' );
  assert.equal( normalise( '0.50' ), '0.5' );
  assert.equal( normalise( '0.500' ), '0.5' );

  // But a zero that carries value stays.
  assert.equal( normalise( '10' ), '10' );
  assert.equal( normalise( '100' ), '100' );
  assert.equal( normalise( '0.05' ), '0.05' );
} );

test( 'a currency symbol becomes a marker naming WHICH currency', () => {
  // REWRITTEN. This test previously asserted that all currency symbols fold to
  // one marker, and so encoded a defect as intended behaviour: "Pay $5" and
  // "Pay \u00A35" compared equal, which is a false match in the question gate --
  // the direction where an answer gets marked against a question the student
  // never answered.
  //
  // The original insight was right and is kept: the symbol must become a
  // marker rather than vanish, or "$5" and "5" become the same question. It was
  // only the collapsing of different currencies that was wrong.
  assert.ok( ! agrees( 'Pay $5', 'Pay \u00A35' ) );
  assert.ok( ! agrees( 'Pay \u20AC5', 'Pay \u00A55' ) );

  assert.ok( agrees( 'Pay $5', 'Pay $5' ), 'the same currency still matches' );
  assert.ok( ! agrees( 'spend $5', 'spend 5' ),
    'and a symbol is still not the same as no symbol' );
} );

test( 'decorative punctuation goes and meaningful punctuation stays', () => {
  assert.equal( normalise( 'What is 15% of 240?' ), 'what is 15% of 240' );
  assert.equal( normalise( 'Simplify 18/24.' ), 'simplify 18/24' );
  assert.equal( normalise( 'Answer: 36!' ), 'answer 36' );

  // The survivors carry the mathematics. Losing any of them would merge
  // questions that are genuinely different.
  assert.match( normalise( '18/24' ), /\// );
  assert.match( normalise( '15%' ), /%/ );
  assert.match( normalise( '-5' ), /-/ );
  assert.match( normalise( 'x = 5' ), /=/ );
  assert.match( normalise( '(a + b)' ), /\(/ );
} );

// ===========================================================================
// FALSE MATCH — the silent failure. The important half.
// ===========================================================================

test( 'near-miss questions never normalise alike', () => {
  const mustDiffer = [
    [ 'What is 15% of 240?', 'What is 15% of 260?', 'one digit' ],
    [ 'What is 15% of 240?', 'What is 51% of 240?', 'transposed digits' ],
    [ 'Simplify 18/24', 'Simplify 18/42', 'transposed denominator' ],
    [ 'Calculate 5 - 3', 'Calculate 5 + 3', 'operator' ],
    [ 'The temperature is -5', 'The temperature is 5', 'sign' ],
    [ 'Increase 80 by 25%', 'Decrease 80 by 25%', 'one word' ],
    [ 'Round to 2 decimal places', 'Round to 3 decimal places', 'precision' ],
    [ '1.5', '15', 'the decimal point itself' ],
    [ '0.5', '0.05', 'magnitude' ],
    [ 'a/b', 'a b', 'the fraction slash' ],
  ];

  for ( const [ a, b, why ] of mustDiffer ) {
    assert.ok( ! agrees( a, b ),
      `${ why }: "${ a }" must not match "${ b }" (both -> "${ normalise( a ) }")` );
  }
} );

test( 'stripping punctuation does not merge distinct numbers', () => {
  assert.equal( normalise( '1,234.50' ), '1234.5' );
  assert.notEqual( normalise( '1,234.50' ), normalise( '123450' ) );
  assert.ok( ! agrees( 'Pay $1,234.50', 'Pay $123450' ) );
} );

test( 'the punctuation rules refuse to eat a separator between digits', () => {
  // WHY THIS IS TESTED SEPARATELY. Two independent mechanisms protect numbers:
  // the canonicalisation runs before the punctuation strip, AND the punctuation
  // rules use lookarounds that decline to touch a separator between digits.
  //
  // Either alone is sufficient, which means neither shows up under mutation --
  // reversing the order still passes, because the lookarounds hold. An earlier
  // version of this file claimed the ordering was load-bearing; mutation
  // testing showed it was not, and the claim was corrected rather than the
  // redundancy removed.
  //
  // This asserts the second mechanism directly, on inputs where the first has
  // nothing left to do: a period or comma that is NOT part of a number must be
  // stripped, and one that IS must survive to reach the number rules.
  assert.equal( normalise( 'end. Start' ), 'end start',
    'a sentence period goes' );
  assert.equal( normalise( 'a, b, c' ), 'a b c',
    'a list comma goes' );
  assert.equal( normalise( '3.5' ), '3.5',
    'a decimal point stays' );
  assert.equal( normalise( '3,500' ), '3500',
    'a grouping comma is consumed by the number rule, not the punctuation rule' );

  // The mixed case: both kinds in one string.
  assert.equal( normalise( 'Pay 1,234.50, then stop.' ), 'pay 1234.5 then stop' );
} );

// ===========================================================================
// FALSE MISMATCH — the noisy failure
// ===========================================================================

test( 'the same question typed two ways still matches itself', () => {
  const mustAgree = [
    [ 'What\u2019s 15% of 240?', "What's 15% of 240?", 'curly vs straight apostrophe' ],
    [ 'Read \u201Cthe book\u201D', 'Read "the book"', 'curly vs straight quotes' ],
    [ 'pages 10\u201320', 'pages 10-20', 'en dash vs hyphen' ],
    [ 'minus \u22125', 'minus -5', 'unicode minus vs hyphen' ],
    [ 'Pay $\u00A01 200', 'Pay $1200', 'NBSP grouping' ],
    [ '\uFF11\uFF15\uFF05 of 240', '15% of 240', 'full-width digits' ],
    [ 'Simplify 18/24.', 'Simplify 18/24', 'trailing full stop' ],
    [ '  Simplify 18/24  ', 'Simplify 18/24', 'surrounding whitespace' ],
    [ 'Total: $36.00', 'Total: $36', 'trailing zeros' ],
  ];

  for ( const [ a, b, why ] of mustAgree ) {
    assert.ok( agrees( a, b ),
      `${ why }: "${ a }" -> "${ normalise( a ) }" vs "${ b }" -> "${ normalise( b ) }"` );
  }
} );

test( 'every rule is symmetric across word-processor substitutions', () => {
  // The bug this test found while it was being written: an earlier version
  // stripped the curly apostrophe but not the straight one, so the same
  // question typed two ways normalised two ways.
  //
  // Any character added to the decorative set must have every substitute a word
  // processor can produce for it added alongside, or the gate quarantines
  // correct work. Checked as a property rather than case by case.
  const substitutions = [
    [ "'", '\u2018' ], [ "'", '\u2019' ],
    [ '"', '\u201C' ], [ '"', '\u201D' ],
    [ '-', '\u2013' ], [ '-', '\u2014' ], [ '-', '\u2212' ],
    [ ' ', '\u00A0' ],
  ];

  for ( const [ plain, fancy ] of substitutions ) {
    const a = `the${ plain }word 5`;
    const b = `the${ fancy }word 5`;
    assert.equal( normalise( a ), normalise( b ),
      `${ JSON.stringify( plain ) } and ${ JSON.stringify( fancy ) } must normalise alike` );
  }
} );

test( 'normalisation is idempotent and total', () => {
  const samples = [ 'What is 15% of 240?', '$1,234.50', '', '   ', '18/24.',
                    'a\u00A0b', '\u2019quoted\u2019', '-5 \u2212 3' ];

  for ( const s of samples ) {
    const once = normalise( s );
    assert.equal( normalise( once ), once,
      `normalising twice must not change the result for ${ JSON.stringify( s ) }` );
  }

  // Total: no input throws, and anything unusable becomes ''.
  for ( const bad of [ null, undefined, 42, {}, [], NaN ] ) {
    assert.equal( normalise( bad ), '' );
  }
} );

test( 'blank text never agrees with anything, including other blanks', () => {
  // Two unreadable questions are not evidence that they are the same question.
  // Returning true here would let an extraction failure pass the gate and be
  // marked against a key it was never checked against.
  assert.ok( ! agrees( '', '' ) );
  assert.ok( ! agrees( '   ', '' ) );
  assert.ok( ! agrees( '???', '!!!' ),
    'two strings of pure punctuation both normalise to empty and must not match' );
} );

// ===========================================================================
// classify — the Section 4 vocabulary
// ===========================================================================

test( 'a matching question with an answer is exact_match', () => {
  const r = classify( 'What is 15% of 240?', 'what is 15% of 240', '36' );
  assert.equal( r.status, 'exact_match' );
} );

test( 'a blank answer is missing, not mismatch, even when the question agrees', () => {
  // Section 6 treats them as different outcomes with different handling. A
  // missing answer is written with an empty answer and flagged; a mismatch is
  // quarantined for the tutor. Reporting a skipped question as a mismatch sends
  // the tutor hunting for a wording discrepancy that does not exist.
  for ( const blank of [ '', '   ', null, undefined ] ) {
    const r = classify( 'What is 15% of 240?', 'What is 15% of 240?', blank );
    assert.equal( r.status, 'missing', `answer ${ JSON.stringify( blank ) }` );
  }
} );

test( 'missing outranks mismatch when both would apply', () => {
  // No answer AND no question text. The student skipped it; the tutor does not
  // need a wording investigation.
  assert.equal( classify( 'What is 15% of 240?', null, '' ).status, 'missing' );
} );

test( 'a differing question is quarantined as mismatch and carries a reason', () => {
  const r = classify( 'What is 15% of 240?', 'What is 15% of 260?', '39' );
  assert.equal( r.status, 'mismatch' );
  assert.ok( r.reason.length > 10, 'the reason is surfaced to the tutor in session' );
} );

test( 'an answer with no question text to confirm it is a mismatch, never a match', () => {
  // Section 6: "No question is ever assessed against an answer key unless the
  // uploaded question agrees with the registry." An answer that arrived with
  // nothing to confirm it against has not met that bar, however plausible it
  // looks.
  const r = classify( 'What is 15% of 240?', null, '36' );
  assert.equal( r.status, 'mismatch' );

  const blank = classify( 'What is 15% of 240?', '   ', '36' );
  assert.equal( blank.status, 'mismatch' );
} );

test( 'classify only ever returns the Section 4 vocabulary', () => {
  const allowed = new Set( [ 'exact_match', 'mismatch', 'missing' ] );
  const inputs = [
    [ 'q', 'q', 'a' ], [ 'q', 'other', 'a' ], [ 'q', null, '' ],
    [ '', '', '' ], [ 'q', 'q', null ], [ null, null, null ],
  ];
  for ( const [ a, b, c ] of inputs ) {
    assert.ok( allowed.has( classify( a, b, c ).status ),
      `status must be one of the three the column allows` );
  }
} );

// ===========================================================================
// answersAgree — the answer rule, which is NOT the question rule
// ===========================================================================

test( 'a bare number matches a key written with units or a variable', () => {
  // Measured on a real submitted worksheet: strict comparison scored 1 of 9
  // correct answers as right, because the tutor wrote `$160` and the student
  // wrote `160`. Every other question on a correct paper was marked wrong.
  assert.equal( answersAgree( '$160', '160' ), true );
  assert.equal( answersAgree( '92 m\u00B2', '92' ), true );
  assert.equal( answersAgree( 'x = 8', '8' ), true );
  assert.equal( answersAgree( '10 m', '10' ), true );
  assert.equal( answersAgree( '2.4 hours', '2.4' ), true );
  assert.equal( answersAgree( '$1,234.50', '1234.5' ), true );
} );

test( 'the answer rule is looser than the question rule, and only for answers', () => {
  // `agrees` compares QUESTIONS, where a currency symbol distinguishes two
  // different questions and must survive. `answersAgree` compares ANSWERS,
  // where the same symbol is the tutor's formatting.
  assert.equal( agrees( 'spend $5', 'spend 5' ), false, 'questions stay strict' );
  assert.equal( answersAgree( '$5', '5' ), true, 'answers do not' );
} );

test( 'contradicting units are never a match', () => {
  // THE FALSE MATCH THIS PREVENTS, and the reason the rule is not simply
  // "compare the numbers". A length in metres is not the same answer as the
  // same number of kilometres, and marking it correct would be the silent
  // failure the whole feature exists to remove.
  assert.equal( answersAgree( '5 m', '5 km' ), false );
  assert.equal( answersAgree( '92 m\u00B2', '92 m\u00B3' ), false );
  assert.equal( answersAgree( '10 kg', '10 g' ), false );

  // Absent on one side is a presentation omission, not a contradiction: the
  // student gave the right number and left the unit off.
  assert.equal( answersAgree( '5 km', '5' ), true );
  assert.equal( answersAgree( '5', '5 km' ), true );
} );

test( 'an answer holding more than one number is never compared numerically', () => {
  // A range, a coordinate, a date or a line of working is not a single value,
  // and reducing it to its first number would match things that are not equal.
  assert.equal( answersAgree( '5', 'between 5 and 10' ), false );
  assert.equal( answersAgree( 'between 5 and 10', '5' ), false );
  assert.equal( answersAgree( '(3, 4)', '3' ), false );
  assert.equal( answersAgree( '12', '12 x 1 = 12' ), false );

  // Two multi-number answers still match when they are genuinely identical,
  // because the strict comparison runs first.
  assert.equal( answersAgree( '(3, 4)', '(3, 4)' ), true );
} );

test( 'a wrong number is still wrong, however it is dressed', () => {
  assert.equal( answersAgree( '$160', '$170' ), false );
  assert.equal( answersAgree( '160', '170' ), false );
  assert.equal( answersAgree( 'x = 8', 'x = 9' ), false );
  assert.equal( answersAgree( '0.5', '0.05' ), false );
  assert.equal( answersAgree( '5', '-5' ), false );
} );

test( 'text answers fall back to the strict rule', () => {
  // No number on either side, so nothing is reduced and the question rule
  // applies unchanged.
  assert.equal( answersAgree( 'Multiply by 3', 'multiply by 3.' ), true );
  assert.equal( answersAgree( 'Multiply by 3', 'divide by 3' ), false );
  assert.equal( answersAgree( '', '' ), false );
} );

test( 'the false-match cases a formatting normaliser is most likely to erase', () => {
  // These three are the hard ones. "5 m never matches 5 km" is easy because the
  // units are different words; a normaliser has no reason to touch them. These
  // differ by a superscript, a sign, or a trailing zero -- exactly the marks a
  // formatting normaliser exists to erase, which is why each is tested against
  // the real implementation rather than reasoned about.

  // A superscript unit is a DIFFERENT unit. If the normaliser strips the ² as
  // punctuation, an area answer matches a length answer.
  assert.equal( answersAgree( '92 m\u00B2', '92 m' ), false );
  assert.equal( answersAgree( '92 m', '92 m\u00B2' ), false );

  // A sign is part of the value. If the minus is erased before extraction, a
  // negative answer matches its positive.
  assert.equal( answersAgree( '8', '-8' ), false );
  assert.equal( answersAgree( '-8', '8' ), false );
  assert.equal( answersAgree( '-8', '-8' ), true );

  // A trailing zero is not part of the value, and must fail in the OTHER
  // direction: string equality would call these different.
  assert.equal( answersAgree( '2.4', '2.40' ), true );
  assert.equal( answersAgree( '2.40', '2.4' ), true );
} );

test( 'the known false misses are recorded, not silently tolerated', () => {
  // The numeric fallback shrinks the surface; it does not close it. These are
  // the cases it cannot reach, and they are the reason a key miss routes to a
  // tutor when the model says the answer looks right, rather than publishing a
  // zero.
  //
  // Asserted as CURRENT BEHAVIOUR so that a future change which fixes one of
  // them fails here and gets noticed, rather than quietly widening the
  // comparison.
  assert.equal( answersAgree( 'thirty-six', '36' ), false,
    'words for digits: reduces to no numbers, so no fallback applies' );
  assert.equal( answersAgree( '2 hours 24 minutes', '2.4' ), false,
    'alternate representation: two numbers against one' );

  // This one DOES rescue, via the absent-unit rule, and is pinned so it is not
  // lost by a later tightening.
  assert.equal( answersAgree( '160 dollars', '$160' ), true,
    'a unit written out in full still matches a symbol' );
} );

test( 'the two comparisons remain distinct functions', () => {
  // A NAMED INVARIANT, asserted rather than left in a changelog.
  //
  // Collapsing the question rule and the answer rule into one has already
  // happened once, and it marked a flawless paper 1 of 9. The next person to
  // touch this will otherwise re-unify them and reintroduce exactly that.
  assert.equal( typeof agrees, 'function' );
  assert.equal( typeof answersAgree, 'function' );
  assert.notEqual( agrees, answersAgree, 'they are not the same function' );

  // And they must still DISAGREE on the case that separates them, or one has
  // silently become the other.
  assert.equal( agrees( 'spend $5', 'spend 5' ), false );
  assert.equal( answersAgree( '$5', '5' ), true );
} );

// ===========================================================================
// Currency: symbols must distinguish, exactly as words already do
// ===========================================================================

test( 'different currencies are different answers, symbol or word', () => {
  // THE ASYMMETRY THIS CLOSES. Currency WORDS were preserved and distinguished
  // correctly -- "160 dollars" never matched "160 pounds". Currency SYMBOLS
  // were all folded to a single marker, so "$160" matched "£160", and because
  // the marker was then stripped from the unit, "160 dollars" matched "£160"
  // too via the absent-unit rule.
  //
  // Symbol recognised but flattened, word preserved: the same asymmetric
  // normalisation this suite has caught repeatedly, and a false match in the
  // silent direction.
  assert.equal( answersAgree( '$160', '\u00A3160' ), false );
  assert.equal( answersAgree( '160 dollars', '160 pounds' ), false );
  assert.equal( answersAgree( '160 dollars', '\u00A3160' ), false );
  assert.equal( answersAgree( '\u20AC160', '$160' ), false );
} );

test( 'a currency word matches its own symbol', () => {
  // The rescue that made this worth having: a student who writes the currency
  // out has given the same answer as the key that used the symbol.
  assert.equal( answersAgree( '160 dollars', '$160' ), true );
  assert.equal( answersAgree( '$160', '160 dollars' ), true );
  assert.equal( answersAgree( '160 euros', '\u20AC160' ), true );

  // And omitting the currency entirely is still a presentation omission.
  assert.equal( answersAgree( '$160', '160' ), true );
} );

test( 'the question gate distinguishes currencies too', () => {
  // A false match HERE is the catastrophic direction: "pay $5" and "pay £5" are
  // different questions, and treating them as the same lets an answer be marked
  // against a question the student never answered.
  //
  // An earlier test in this file asserted the opposite -- that all currency
  // symbols fold together -- and so encoded the defect as intended behaviour.
  assert.equal( agrees( 'Pay $5', 'Pay \u00A35' ), false );
  assert.equal( agrees( 'Pay $5', 'Pay $5' ), true );

  // The original reason for a marker rather than deletion still holds: "$5" and
  // "5" must remain distinguishable.
  assert.equal( agrees( 'spend $5', 'spend 5' ), false );
} );

test( 'pounds is left ambiguous on purpose', () => {
  // "pounds" is mass as well as currency, and nothing in an answer string
  // resolves which. Mapping it to the currency would make "5 pounds" of flour
  // match "£5" -- a false match, the silent direction.
  //
  // So it stays its own unit. "£5" against "5 pounds" is therefore a false
  // MISS, which the tutor-review routing exists to catch, rather than a false
  // match nobody sees.
  assert.equal( answersAgree( '\u00A35', '5 pounds' ), false );
  assert.equal( answersAgree( '5 pounds', '5 pounds' ), true );
} );

test( 'a labelled key matches the value the student wrote', () => {
  // The reference spec's OWN example key is "Area = 12 cm2". Only a
  // single-letter label was stripped, so `x = 8` worked and `Area = 12 cm2`
  // did not.
  //
  // The result was perverse: a student writing "12" was marked correct, and a
  // student writing "12 cm2" -- the more complete answer -- was marked wrong,
  // because the key's unit was "areacm2" and theirs was "cm2".
  assert.equal( answersAgree( 'Area = 12 cm2', '12 cm2' ), true );
  assert.equal( answersAgree( 'Area = 12 cm2', '12' ), true );
  assert.equal( answersAgree( 'Area = 12 cm2', '12 cm\u00B2' ), true );
  assert.equal( answersAgree( 'Perimeter = 30 m', '30 m' ), true );
  assert.equal( answersAgree( 'x = 8', '8' ), true );

  // The label does not become a licence to ignore the value or the unit.
  assert.equal( answersAgree( 'Area = 12 cm2', '14 cm2' ), false );
  assert.equal( answersAgree( 'Area = 12 cm2', '12 m2' ), false );
} );
