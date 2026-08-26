// src/voice/heteronym-resolver.js
//
// SPEC-HET-002. Contextual heteronym resolution for the voice pipeline.
// Connector v13.22.0.
//
// ===========================================================================
// THE ONE RULE EVERYTHING ELSE SERVES
// ===========================================================================
//
// §1 and §4.1: the written text is the primary artifact and is never rewritten
// for the reader. Only what the ENGINE phonemises changes.
//
// So this returns a new string for synthesis and never touches the caller's
// copy. The transcript, the message the user reads and anything persisted keep
// the author's words exactly. AC3 -- byte-identical displayed text -- is a
// property of where this is called, not of what it returns, and the call sites
// in voice-engines.js pass the result to the engine only.
//
// ===========================================================================
// WHY IT IS PURE
// ===========================================================================
//
// §4.3: spawns nothing, reads nothing, holds no state. That makes the whole
// table exhaustively testable with no model, no venv and no espeak -- AC4 --
// and it makes the failure mode trivial: a pure function that throws can be
// caught and its input used instead, which is exactly what §11 asks for.
//
// ===========================================================================
// WHY IT RUNS ON THE WHOLE REPLY
// ===========================================================================
//
// §3.4 and §4.4. The obvious hook, prepareForKokoro, is wrong: the prosody path
// calls synthesizePcm once per phrase, so it sees fragments. "I read it" and
// "yesterday" can land in different phrases, and the marker that decides the
// pronunciation is then in a different call from the word it governs.
//
// Resolution therefore runs once, before segmentation, where the sentence is
// still whole.

import { CLASS_A } from './heteronym-lexicon.js';

/** Confidence levels that are enabled without an explicit opt-in. §7, AC6. */
const SHIP_ENABLED = new Set( [ 'high', 'medium' ] );

/**
 * Is the resolver switched on? §10, default true.
 *
 * @returns {boolean}
 */
export function heteronymResolveEnabled() {
  return 'false' !== String( process.env.VOICE_HETERONYM_RESOLVE || '' )
    .trim().toLowerCase();
}

/**
 * Is phoneme injection switched on? §10, default FALSE.
 *
 * Off by default because OD-1 and OD-2 are unresolved: the exact IPA subset
 * misaki accepts has not been validated, and an unaccepted symbol is worse
 * than no override -- it can be read aloud rather than interpreted.
 *
 * @returns {boolean}
 */
export function strategyBEnabled() {
  return 'true' === String( process.env.VOICE_HETERONYM_STRATEGY_B || '' )
    .trim().toLowerCase();
}

/**
 * Operator additions and overrides. §10, VOICE_HETERONYM_LEXICON.
 *
 * Merged by word, so an operator can flip one entry's confidence or correct a
 * respelling without restating the table. Malformed JSON is ignored with a
 * warning rather than throwing: a typo in an environment variable must not
 * take the voice pipeline down (§4.2).
 *
 * @returns {Array}
 */
export function lexicon() {
  const raw = String( process.env.VOICE_HETERONYM_LEXICON || '' ).trim();
  if ( ! raw ) return CLASS_A;

  let overrides;
  try {
    overrides = JSON.parse( raw );
  } catch ( err ) {
    console.warn( '[heteronym] VOICE_HETERONYM_LEXICON is not valid JSON; '
      + `using the built-in table only: ${ err.message }` );
    return CLASS_A;
  }
  if ( ! overrides || 'object' !== typeof overrides ) return CLASS_A;

  const byWord = new Map( CLASS_A.map( ( e ) => [ e.word, { ...e } ] ) );
  for ( const [ word, patch ] of Object.entries( overrides ) ) {
    if ( ! patch || 'object' !== typeof patch ) continue;
    const key = String( word ).toLowerCase();
    byWord.set( key, { ...( byWord.get( key ) || { word: key } ), ...patch } );
  }
  return [ ...byWord.values() ];
}

/**
 * Split text into word tokens with their offsets.
 *
 * Offsets are kept because the rewrite must be positional: replacing by regex
 * over the whole string would rewrite EVERY occurrence of a word once one
 * occurrence matched its rule, and "I read every day, but I read that book
 * yesterday" needs opposite answers in one sentence.
 *
 * The pattern keeps apostrophes inside words so "I've" is one token and can be
 * matched as a past marker.
 *
 * @param {string} text
 * @returns {Array<{word: string, lower: string, start: number, end: number}>}
 */
export function tokenise( text ) {
  const tokens = [];
  const pattern = /[A-Za-z\u00C0-\u024F]+(?:['\u2019][A-Za-z]+)?/g;
  let match;
  while ( null !== ( match = pattern.exec( text ) ) ) {
    tokens.push( {
      word: match[ 0 ],
      lower: match[ 0 ].toLowerCase().replace( '\u2019', "'" ),
      start: match.index,
      end: match.index + match[ 0 ].length,
    } );
  }
  return tokens;
}

/**
 * Does a multi-word phrase sit at this token position?
 *
 * @param {Array} tokens
 * @param {number} index
 * @param {string} phrase
 * @returns {boolean}
 */
function phraseAt( tokens, index, phrase ) {
  const parts = phrase.split( /\s+/ );
  for ( let i = 0; i < parts.length; i += 1 ) {
    const token = tokens[ index + i ];
    if ( ! token || token.lower !== parts[ i ] ) return false;
  }
  return true;
}

/**
 * Does any listed phrase appear within `within` tokens before `index`?
 *
 * @param {Array} tokens
 * @param {number} index
 * @param {string[]} phrases
 * @param {number} within
 * @returns {boolean}
 */
function lookBehind( tokens, index, phrases, within ) {
  for ( let back = 1; back <= within; back += 1 ) {
    const at = index - back;
    if ( at < 0 ) break;
    for ( const phrase of phrases ) {
      const parts = phrase.split( /\s+/ );
      if ( phraseAt( tokens, at - parts.length + 1, phrase ) ) return true;
    }
  }
  return false;
}

/**
 * Does any listed phrase appear within `within` tokens after `index`?
 *
 * @param {Array} tokens
 * @param {number} index
 * @param {string[]} phrases
 * @param {number} within
 * @returns {boolean}
 */
function lookAhead( tokens, index, phrases, within ) {
  for ( let forward = 1; forward <= within; forward += 1 ) {
    for ( const phrase of phrases ) {
      if ( phraseAt( tokens, index + forward, phrase ) ) return true;
    }
  }
  return false;
}

/**
 * Does the context select the resolved (non-default) sense?
 *
 * ── Why a miss is silent ─────────────────────────────────────────────────
 *
 * §11 item 11: when no rule matches, the word is left alone and the engine's
 * dictionary decides. Every rule here fires on the MINORITY sense -- "read" is
 * usually present tense, "lead" is usually the verb -- so a miss leaves the
 * common case with the pronunciation the engine already gets right, and only a
 * FALSE match produces an audibly wrong word. That asymmetry is why the rules
 * are written narrow rather than complete.
 *
 * @param {object} entry
 * @param {Array} tokens
 * @param {number} index
 * @returns {boolean}
 */
export function contextSelects( entry, tokens, index ) {
  const rules = Array.isArray( entry.when ) ? entry.when : [];

  for ( const rule of rules ) {
    const before = Array.isArray( rule.before )
      ? lookBehind( tokens, index, rule.before, rule.within || 2 ) : null;
    const after = Array.isArray( rule.after )
      ? lookAhead( tokens, index, rule.after, rule.within2 || rule.within || 2 ) : null;

    // A rule naming both sides requires both. One naming a single side
    // requires that side. `andAfter` is the flag that says "this rule's
    // `before` list must be joined by anything at all after it", used by
    // pre-nominal cases such as "a live broadcast".
    if ( null !== before && null !== after ) {
      if ( before && after ) return true;
      continue;
    }
    if ( null !== before && before ) return true;
    if ( null !== after && after ) return true;
  }
  return false;
}

/**
 * Preserve the original capitalisation on a replacement.
 *
 * "Read the manual" must not become "red the manual" at the start of a
 * sentence. Only the shape is copied, never the letters.
 *
 * @param {string} original
 * @param {string} replacement
 * @returns {string}
 */
function matchCase( original, replacement ) {
  if ( original === original.toUpperCase() && original.length > 1 ) {
    return replacement.toUpperCase();
  }
  if ( original[ 0 ] === original[ 0 ].toUpperCase() ) {
    return replacement[ 0 ].toUpperCase() + replacement.slice( 1 );
  }
  return replacement;
}

/**
 * Resolve heteronyms in a whole reply.
 *
 * ── Total by construction ────────────────────────────────────────────────
 *
 * §4.2: every error path lands on today's behaviour, so the feature physically
 * cannot make audio worse. Non-string input, an empty string, a malformed
 * lexicon entry and an unexpected throw all return the input unchanged.
 *
 * @param {string} text The whole reply, before segmentation.
 * @param {{markupSupported?: boolean}} [options] `markupSupported` reports
 *        whether the live g2p accepts misaki markup. False suppresses strategy
 *        B rather than emitting brackets espeak would read aloud (§11 item 12).
 * @returns {{text: string, changed: Array, suppressed: Array}}
 */
export function resolveHeteronyms( text, options ) {
  const original = 'string' === typeof text ? text : '';
  const result = { text: original, changed: [], suppressed: [] };

  if ( ! original || ! heteronymResolveEnabled() ) return result;

  const o = options || {};
  const markupOk = !! o.markupSupported;

  try {
    const entries = lexicon().filter( ( e ) => (
      e && e.word && SHIP_ENABLED.has( e.confidence || 'low' )
    ) );
    if ( ! entries.length ) return result;

    const byWord = new Map( entries.map( ( e ) => [ String( e.word ).toLowerCase(), e ] ) );
    const tokens = tokenise( original );

    // Edits are collected and applied back-to-front, so an earlier edit cannot
    // shift the offsets of a later one.
    const edits = [];

    for ( let i = 0; i < tokens.length; i += 1 ) {
      const entry = byWord.get( tokens[ i ].lower );
      if ( ! entry ) continue;
      if ( ! contextSelects( entry, tokens, i ) ) continue;

      if ( 'A' === entry.strategy && entry.respell ) {
        edits.push( { start: tokens[ i ].start, end: tokens[ i ].end,
                      text: matchCase( tokens[ i ].word, entry.respell ) } );
        result.changed.push( { word: entry.word, strategy: 'A',
                               to: entry.respell, at: tokens[ i ].start } );
        continue;
      }

      if ( 'B' === entry.strategy && entry.ipa ) {
        if ( ! strategyBEnabled() ) {
          result.suppressed.push( { word: entry.word, reason: 'strategy_b_disabled' } );
          continue;
        }
        if ( ! markupOk ) {
          // §11 item 12 and §5.2: on espeak the override cannot be expressed,
          // and emitting it anyway would have the engine SPEAK the brackets.
          // Recorded, exactly as the existing emphasis and lexicon suppression
          // behaves, so the reason is visible rather than the feature merely
          // seeming not to work.
          result.suppressed.push( { word: entry.word, reason: 'heteronym_needs_misaki_g2p' } );
          continue;
        }
        edits.push( { start: tokens[ i ].start, end: tokens[ i ].end,
                      text: `[${ tokens[ i ].word }](/${ entry.ipa }/)` } );
        result.changed.push( { word: entry.word, strategy: 'B',
                               to: entry.ipa, at: tokens[ i ].start } );
      }
    }

    if ( ! edits.length ) return result;

    let out = original;
    for ( const edit of edits.sort( ( a, b ) => b.start - a.start ) ) {
      out = out.slice( 0, edit.start ) + edit.text + out.slice( edit.end );
    }
    result.text = out;
    return result;
  } catch ( err ) {
    // §4.2 and §11 item 10. The caller catches too; this is the inner guard so
    // a fault in one entry cannot cost the whole reply its audio.
    console.warn( `[heteronym] resolver fault, synthesising unmodified text: ${ err.message }` );
    return { text: original, changed: [], suppressed: [ { reason: 'resolver_error' } ] };
  }
}

export default {
  resolveHeteronyms, heteronymResolveEnabled, strategyBEnabled, lexicon,
  tokenise, contextSelects,
};
