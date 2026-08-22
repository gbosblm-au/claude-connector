// src/homework/homework-extract.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6 (upload
// parsing and the agreement gate), Section 12 (extras, gaps, duplicates).
//
// ===========================================================================
// THE ONE RULE THIS FILE ENFORCES
// ===========================================================================
//
// Section 6: "No question is ever assessed against an answer key unless the
// uploaded question agrees with the registry."
//
// So the output of this module is never "here is what the student wrote".
// It is "here is what the student wrote, AND here is whether we are permitted
// to mark it". Every returned row carries a `match_status`, and a caller that
// dispatches assessment for anything other than `exact_match` has defeated the
// entire feature.
//
// ===========================================================================
// WHY ALIGNMENT IS BY QUESTION NUMBER AND NOT BY ORDER
// ===========================================================================
//
// The obvious approach -- zip the registry's questions against the blocks found
// in the document, in order -- fails on the single most common thing a student
// does: skip one.
//
// A student who omits Question 2 shifts every later block up by one. Zipping
// then pairs the answer to Q3 with the question text of Q2, and because the
// agreement gate compares the UPLOADED question against the registry, the
// mismatch is caught... for every remaining question in the paper. The student
// is told six questions failed the gate when they skipped one.
//
// Aligning on the number the student wrote confines the damage to the question
// actually affected. When the number is absent or unreadable, the row is
// reported `missing` rather than guessed into place.

'use strict';

import { classify, normalise, answersAgree } from './homework-normalise.js';

/**
 * A line that opens a numbered question.
 *
 * Deliberately broad on the separator (`.`, `)`, `:`, or whitespace) and on an
 * optional "Question"/"Q" prefix, because worksheets are typed by students and
 * the renderer's own numbering style has changed at least once.
 *
 * Anchored at the start of a line and capped at three digits: an unanchored
 * pattern matches the `15` in "What is 15% of 240" and would split a question
 * in half.
 *
 * ── The separator must be followed by whitespace, or nothing ─────────────
 *
 * Without that, a decimal answer on its own line is read as numbering: `2.4
 * hours` parses as question 2 with the text "4 hours". Measured on a real
 * worksheet, that turned the student's answer to the final question into a
 * phantom twenty-sixth question, and the real question 25 was reported
 * unanswered.
 *
 * The requirement is safe because every generator emits `"1. "` with a space,
 * and a decimal never has one. It does mean `1.What is...` typed with no space
 * is not recognised -- an acceptable trade, since a missed question is reported
 * as unanswered while a phantom one silently consumes a real answer.
 */
const QUESTION_START = /^\s*(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.)\:](?:\s+(.*))?$/i;

/**
 * A line that explicitly labels an answer.
 *
 * When present this wins outright: a student who writes "Answer:" has told us
 * exactly which text is their answer, and inference is not needed.
 */
const ANSWER_LABEL = /^\s*(?:answer|ans|my answer|working)\s*[:.\-]\s*(.*)$/i;

/**
 * The generator's own per-question meta line: `[2 pts]  ~1m 30s`.
 *
 * ── Why this is here, and what it cost to find ────────────────────────────
 *
 * homework_docx.py writes this line into its own paragraph immediately after
 * every question, before the blank bordered lines the student writes on. It is
 * presentation, not content.
 *
 * Without this rule the parser treats it as the first line of the answer --
 * the question ends in terminal punctuation, so everything after it is answer
 * text -- and every single answer arrives as
 * `"[2 pts]  ~1m 30s 1/2"` instead of `"1/2"`.
 *
 * Measured against a worksheet built by the real builder and filled with the
 * spec's own answer key: 23 of 23 matched questions scored `key_match: false`.
 * A perfect paper marked entirely wrong, by a comparison that cannot be wrong.
 *
 * This was invisible to the round-trip test that preceded it, because that test
 * rendered a worksheet to a convention I had written down rather than to the
 * one the generator actually emits. A pinned convention only proves the reader
 * agrees with the pin.
 *
 * Anchored to the whole line and tight on shape: a student answer that happens
 * to be `[3 pts] ~2m 00s` is not a thing, but a student answer containing
 * brackets or a tilde is, so nothing looser would be safe.
 */
const RENDER_META = /^\[\s*\d+\s*pts?\s*\]\s*~\s*\d+\s*m\s*\d+\s*s\s*$/i;

/**
 * The generator's section heading: `Fractions  [Core]`.
 *
 * Written as `topic` plus a run of `"  [" + difficulty + "]"`, so it extracts
 * as one line with exactly two spaces before the badge.
 *
 * It sits BETWEEN the last answer line of one section and the first question of
 * the next, and it is not numbered -- so without this rule it is absorbed as
 * the tail of the previous question's answer. Measured on a real worksheet:
 * the last question of every section scored `key_match: false` with answers
 * like `"3/4 Number Patterns  [Core]"`.
 *
 * Matched two ways because neither alone is sufficient:
 *
 *   - the five difficulties homework_common.DIFFICULTY_COLORS defines, which is
 *     precise and cannot misfire
 *   - any short bracketed token preceded by TWO spaces, because the renderer
 *     accepts an arbitrary difficulty string (`DIFFICULTY_COLORS.get(d,
 *     default)`) and a worksheet using one outside the five would otherwise
 *     reintroduce the bug for one question per section
 *
 * The two-space requirement is what keeps the second form safe: a student
 * writing an answer that ends in a bracket writes one space before it, not two.
 */
const KNOWN_DIFFICULTY = /\s\[(?:Foundation|Core|Stretch|Extension|Olympiad)\]\s*$/;
const BADGED_HEADING = /\S {2}\[[^\]]{1,24}\]\s*$/;

/**
 * Split extracted document text into numbered blocks.
 *
 * PURE. Takes text, returns structure -- so every layout below is testable
 * without a docx, and a layout that parses wrongly can be reproduced from a
 * string in a bug report.
 *
 * @param {string} text
 * @returns {Array<{ number: number, question: string, answer: string }>}
 */
export function parseBlocks( text ) {
  if ( 'string' !== typeof text || ! text.trim() ) return [];

  const lines = text.split( /\r?\n/ );
  const blocks = [];
  let current = null;
  let sectionIndex = 0;

  for ( const rawLine of lines ) {
    const line = rawLine.replace( /\t/g, ' ' ).trim();
    if ( ! line ) continue;

    // Dropped exactly like a blank line. Both belong to neither the question
    // nor the answer: one is the per-question meta line, the other the section
    // heading that separates one group of questions from the next.
    //
    // Checked BEFORE the question-start pattern, because a heading is not
    // numbered and would otherwise fall through to the answer of whatever
    // question preceded it.
    if ( RENDER_META.test( line ) ) {
      // A RELIABLE BOUNDARY, and better than the punctuation heuristic below.
      //
      // The generator emits this line after every question and before the blank
      // lines the student writes on, so its presence says "the question has
      // ended" with certainty rather than by inference.
      //
      // That matters for a question ending in data rather than punctuation --
      // "What is the rule for this pattern? 2, 6, 18, 54, 162". The wrap
      // heuristic sees no terminal punctuation, treats the next line as a
      // continuation of the question, and swallows the student's answer into
      // it. Measured on a real worksheet: three of twenty-five questions were
      // reported as unanswered when the student had answered every one.
      if ( current ) current.sawMeta = true;
      continue;
    }
    if ( KNOWN_DIFFICULTY.test( line ) || BADGED_HEADING.test( line ) ) {
      // Recorded, not merely skipped. ref-homework-render-spec defines a
      // question's `number` as its position WITHIN the section, so a heading is
      // where numbering may legitimately restart, and knowing which section a
      // block belongs to is what makes that recoverable.
      if ( blocks.length || current ) sectionIndex += 1;
      continue;
    }

    const start = QUESTION_START.exec( line );

    if ( start ) {
      if ( current ) blocks.push( current );
      current = {
        section: sectionIndex,
        number: Number( start[ 1 ] ),
        // `start[2]` is undefined for a bare "1." on its own line, which some
        // layouts use with the question text on the following line.
        question: ( start[ 2 ] || '' ).trim(),
        answerLines: [],
        labelled: false,
        // Set when the generator's meta line is seen, which ends the question
        // definitively. Absent for a hand-typed worksheet, where the
        // punctuation heuristic below still applies.
        sawMeta: false,
      };
      continue;
    }

    if ( ! current ) continue;   // a heading or a name, before any question

    const labelled = ANSWER_LABEL.exec( line );
    if ( labelled ) {
      // An explicit label REPLACES anything inferred so far. A student who
      // writes their working out and then "Answer: 36" means the 36; treating
      // the working as part of the answer would send the marker a paragraph of
      // arithmetic where it expects a value.
      current.answerLines = labelled[ 1 ].trim() ? [ labelled[ 1 ].trim() ] : [];
      current.labelled = true;
      continue;
    }

    if ( current.labelled ) {
      // Continuation lines after an explicit label still belong to the answer.
      current.answerLines.push( line );
      continue;
    }

    // No label yet. A question can wrap across lines, so the first continuation
    // extends the QUESTION when the question does not yet look complete, and
    // becomes the ANSWER otherwise.
    //
    // "Looks complete" is judged on terminal punctuation, which is what a
    // rendered worksheet always carries -- the renderer emits questions ending
    // in ? or . -- and what a wrapped line never does.
    if ( ! current.sawMeta && ! current.answerLines.length
         && ! /[?.!:]$/.test( current.question )
         && current.question.length ) {
      current.question = `${ current.question } ${ line }`.trim();
      continue;
    }

    current.answerLines.push( line );
  }

  if ( current ) blocks.push( current );

  return blocks.map( ( b ) => ( {
    section: b.section,
    number: b.number,
    question: b.question,
    answer: b.answerLines.join( ' ' ).trim(),
  } ) );
}

/**
 * Align parsed blocks to the registry and apply the agreement gate.
 *
 * @param {Array<{position: number, question_text: string, id?: string}>} registry
 * @param {string} uploadedText
 * @returns {{
 *   rows: Array<{ position: number, question_id: string|undefined,
 *                 uploaded_question: string|null, student_answer: string,
 *                 match_status: string, reason: string }>,
 *   extras: Array<{ number: number, question: string }>,
 *   duplicates: number[],
 *   summary: { total: number, matched: number, mismatched: number, missing: number }
 * }}
 */
export function alignToRegistry( registry, uploadedText ) {
  const questions = Array.isArray( registry ) ? registry : [];
  const blocks = parseBlocks( uploadedText );

  // ── Resolving the number the student wrote to a registry position ──────
  //
  // ref-homework-render-spec defines a question's `number` as its position
  // WITHIN its section, while the registry flattens to a running position
  // across the whole set. On a single-section worksheet the two coincide, which
  // is why this went unnoticed: the bundled test spec numbers globally 1..25.
  //
  // On a multi-section worksheet with per-section numbering they do not. Before
  // this, section two's "1" collided with section one's, was flagged a
  // duplicate and dropped -- half a fully answered paper reported unanswered.
  //
  // The document is self-describing enough to resolve it. Numbering that never
  // decreases is global and is used directly. Numbering that restarts is
  // per-section, and a block's position is the number it carries plus the
  // questions in every section before it.
  //
  // The section offset uses the highest number SEEN in each prior section, not
  // the count of blocks found, so a question skipped in the middle of a section
  // still leaves the following section correctly placed -- the number carries
  // the gap. The residual limitation is a question skipped at the very END of a
  // section, which is invisible in the document and shifts what follows; that
  // is reported as a mismatch rather than silently mismarked, because the
  // question text still has to agree.
  const restarts = blocks.some( ( b, i ) => i > 0 && b.number <= blocks[ i - 1 ].number );

  const sectionOffset = new Map();
  if ( restarts ) {
    let running = 0;
    let seen = -1;
    for ( const b of blocks ) {
      if ( b.section !== seen ) {
        sectionOffset.set( b.section, running );
        seen = b.section;
      }
      running = Math.max( running, sectionOffset.get( b.section ) + b.number );
    }
  }

  /**
   * The registry position a parsed block refers to.
   *
   * @param {object} b
   * @returns {number}
   */
  function positionOf( b ) {
    if ( ! restarts ) return b.number;
    return ( sectionOffset.get( b.section ) || 0 ) + b.number;
  }

  // Indexed by the resolved position, so a skipped question shifts nothing.
  // See the header for why order-based zipping is wrong.
  const byNumber = new Map();
  const duplicates = [];

  for ( const b of blocks ) {
    b.position = positionOf( b );
    if ( byNumber.has( b.position ) ) {
      // Section 12. The FIRST occurrence is kept: a student who answers a
      // question twice has usually written the second as working or a
      // correction below, and silently preferring the later one would mark
      // text the student may not have intended as final. Flagged either way,
      // so a human decides.
      duplicates.push( b.number );
      continue;
    }
    byNumber.set( b.position, b );
  }

  // Positions that are the LAST question of their section, where an
  // end-of-section skip is invisible in the document and shifts what follows.
  // See the residual limitation documented in v13.16.0.
  //
  // Only sections that HAVE a following section. A skip at the end of the last
  // section shifts nothing, because there is nothing after it -- so the final
  // question of the paper is an ordinary verified blank, not an ambiguous one.
  // Treating it as ambiguous would send every unanswered final question to a
  // human for no reason, which is how a review queue stops being read.
  const sectionEdges = new Set();
  {
    const last = new Map();
    for ( const b of blocks ) {
      const prior = last.get( b.section );
      if ( ! prior || b.number > prior.number ) last.set( b.section, b );
    }
    const finalSection = Math.max( -1, ...blocks.map( ( b ) => b.section ) );
    for ( const [ section, b ] of last ) {
      if ( section !== finalSection ) sectionEdges.add( b.position );
    }
  }

  const rows = [];
  const summary = { total: questions.length, matched: 0, mismatched: 0, missing: 0 };

  for ( const q of questions ) {
    const found = byNumber.get( q.position ) || null;
    const uploadedQuestion = found ? found.question : null;
    const studentAnswer = found ? found.answer : '';

    const verdict = classify( q.question_text, uploadedQuestion, studentAnswer );

    // ── R2: a writing question is NEVER key-compared ────────────────────
    //
    // Writing-Question Assessment Spec v1.0.0, R1 and R2. Routing keys on the
    // declared TYPE, never on whether a comparison happened to fail.
    //
    // The previous arrangement routed writing questions to a tutor only because
    // comparing a model paragraph against a student paragraph reliably failed.
    // That is a side effect, not a design: a student whose writing happened to
    // resemble the model closely -- or that the normaliser collapsed -- would
    // have received a deterministic binary mark on an essay, with no review.
    // A silent wrong verdict, and exactly the class this whole path exists to
    // remove.
    //
    // Ineligible by STRUCTURE now. `answer` still carries the model paragraph
    // for the assistant's review (homework-render.md §4 requires the field on
    // every question), but it is reference material and never a match target.
    const isWriting = 'writing' === String( q.question_type || 'standard' ).toLowerCase();

    // ── The answer key, compared deterministically (v13.11.0) ────────────
    //
    // When the registry holds a key for this question, whether the student's
    // answer is correct is decided HERE, by exact equality after normalisation,
    // and not by a model.
    //
    // For a question whose answer is "36", a normalised comparison against the
    // key is strictly better than a model's judgement: it cannot be wrong, it
    // cannot vary between runs, and it removes a model from the critical path
    // on exactly the questions where a wrong mark is least defensible. The key
    // was already in the registry -- written at generation time from the spec's
    // own `answer` field -- and was being handed to the marker as "guidance"
    // instead of being used.
    //
    // null means no key exists, which is the free-text and working case. Those
    // are the questions a model is actually for, and they are the only ones it
    // now scores.
    //
    // Only computed for a question that passed the agreement gate. Comparing an
    // answer to the key of a question the student demonstrably did not answer
    // would produce a confident mark for the wrong question.
    let keyMatch = null;
    if ( ! isWriting
         && 'exact_match' === verdict.status
         && 'string' === typeof q.answer_key && q.answer_key.trim() ) {
      keyMatch = answersAgree( q.answer_key, studentAnswer );
    }

    rows.push( {
      position: q.position,
      question_id: q.id,
      // Echoed back so the gateway routes on the same value the connector did,
      // rather than re-deriving it from a second source that could disagree.
      question_type: isWriting ? 'writing' : 'standard',
      // ── R4: is a blank answer VERIFIED, or merely absent? ──────────────
      //
      // A blank is a zero only when it is known to be a real blank. The
      // difference matters because "the student answered nothing" is a verdict,
      // and the extraction layer has produced it wrongly before.
      //
      // Verified: the question was found in the document, its text agrees with
      // the registry, and the answer region under it is empty. The student saw
      // the question and left it.
      //
      // Ambiguous: the question was not found at all, or it sits at a section
      // edge where a skipped predecessor shifts everything after it. Nothing
      // here can distinguish "left blank" from "extraction lost it", so it goes
      // to a human instead of being auto-zeroed.
      blank_state: blankState( found, studentAnswer, sectionEdges ),
      // true = correct against the key, false = incorrect against the key,
      // null = no key, so correctness is a judgement rather than a comparison.
      key_match: keyMatch,
      // Stored even when it matches. It is the evidence behind the gate's
      // decision: without it a disputed mismatch cannot be investigated later.
      uploaded_question: uploadedQuestion,
      student_answer: studentAnswer,
      match_status: verdict.status,
      reason: verdict.reason,
    } );

    if ( 'exact_match' === verdict.status ) summary.matched += 1;
    else if ( 'missing' === verdict.status ) summary.missing += 1;
    else summary.mismatched += 1;
  }

  // Section 12: numbers in the upload that the registry does not have. Usually
  // a student renumbering after inserting their own working, occasionally the
  // wrong worksheet entirely. Reported, never marked -- there is no canonical
  // question to mark them against, which is the whole point.
  const known = new Set( questions.map( ( q ) => q.position ) );
  const extras = blocks
    .filter( ( b ) => ! known.has( b.position ) )
    .map( ( b ) => ( { number: b.number, question: b.question } ) );

  return { rows, extras, duplicates, summary };
}

/**
 * Classify a blank answer as a verified blank or an ambiguous one.
 *
 * R4. Returns null when there is an answer, so the caller can tell "not blank"
 * from "blank, and here is how confident we are".
 *
 * @param {object|null} found The parsed block, if one was located.
 * @param {string} answer
 * @param {Set<number>} sectionEdges Positions where a shift would be invisible.
 * @returns {'verified'|'ambiguous'|null}
 */
function blankState( found, answer, sectionEdges ) {
  if ( answer && answer.trim() ) return null;

  // The question was never located. That is "extraction did not find it", which
  // is not the same claim as "the student left it blank".
  if ( ! found ) return 'ambiguous';

  // Found, but at a section edge, where a skipped predecessor shifts every
  // following question and the document gives no sign of it.
  if ( sectionEdges.has( found.position ) ) return 'ambiguous';

  return 'verified';
}

/**
 * Is this set safe to dispatch for assessment?
 *
 * A convenience the caller is expected to use rather than re-derive: only
 * `exact_match` rows may be marked, and this returns exactly those.
 *
 * @param {Array<object>} rows Output of alignToRegistry().rows
 * @returns {Array<object>}
 */
export function assessable( rows ) {
  return ( Array.isArray( rows ) ? rows : [] )
    .filter( ( r ) => r && 'exact_match' === r.match_status );
}

export default { parseBlocks, alignToRegistry, assessable, normalise };
