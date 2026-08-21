/* voice-stream-split.js  --  incremental sentence-boundary splitting.
 *
 * Kokoro Sentence-Boundary Streaming Spec v1, Sections 6.1, 6.2, 8.
 *
 * ===========================================================================
 * WHAT THIS SOLVES
 * ===========================================================================
 *
 * Section 1: the reply is generated in full, THEN sent for synthesis in one
 * shot. On a long reply the voice trails the finished text by the whole
 * synthesis duration. The pipeline is sequential where it should be parallel.
 *
 * This module is the first stage of the fix: given text that is still growing,
 * decide which parts of it are FINISHED SENTENCES and can be spoken now, and
 * which trailing fragment must wait for more input.
 *
 * ===========================================================================
 * WHY IT IS SEPARATE FROM prosody.js analyse()
 * ===========================================================================
 *
 * analyse() segments a COMPLETE reply. It splits paragraphs, detects register,
 * assigns per-phrase rate and pause profiles, and merges runts backwards -- all
 * of which need the whole text to be correct. Running it on a partial stream
 * would mis-segment on every call and re-decide earlier phrases as more text
 * arrived.
 *
 * This does the one thing that CAN be decided from a prefix: where a sentence
 * has definitely ended. It deliberately does not do prosody. The phrases it
 * emits are then handed to the existing synthesis path, which still applies
 * analyse() per phrase.
 *
 * ===========================================================================
 * THE STATELESS CONTRACT, AND WHY IT IS AN OFFSET RATHER THAN AN INDEX
 * ===========================================================================
 *
 * The caller holds the accumulated text and a character OFFSET marking how much
 * has already been committed to audio. Each call re-splits from that offset and
 * returns the newly-complete phrases plus how many characters were consumed.
 *
 * A phrase INDEX would be the obvious choice and is wrong. Boundaries are not
 * stable under growth: `Dr.` looks like a sentence end until ` Smith` arrives,
 * so phrase 3 in one call can be a different span in the next. Indexing by
 * position in a list that can be re-cut causes a repeat or a skip. A character
 * offset addresses the TEXT, which only ever grows, so it cannot be
 * invalidated by a re-split.
 *
 * That also delivers NFR-4.1 (idempotency) for free: replaying a call with the
 * same offset returns the same phrases and consumes the same characters, so a
 * retry or reconnect cannot double-speak (EC-6).
 */

'use strict';

/* Section 8 -- tuneables, not hardcoded (NFR-5.1). */
const DEFAULTS = Object.freeze({
  /* FR-1.3. A hard ceiling so one pathological run -- a bullet list item, a
   * long clause with no punctuation -- cannot starve the pipeline or create an
   * oversized synthesis job. */
  maxPhraseLength: 300,
  /* FR-3.3. Shorter than this and a fragment is absorbed into its neighbour
   * rather than spoken alone. Three characters is roughly "a word", below which
   * a standalone utterance is a click rather than speech. */
  runtFloor: 3,
  /* EC-2. Strip markdown before synthesis so the engine does not read the
   * syntax aloud. */
  markdownStripping: true,
  /* EC-1. Defer inside fenced code blocks and tables: prose punctuation inside
   * them produces nonsense phrases. */
  deferSynthesisInCodeBlock: true,
});

/** FR-1.1. Primary boundary: terminal punctuation followed by whitespace. */
const TERMINAL = '.!?';

/**
 * Closing characters allowed to trail terminal punctuation before the
 * whitespace that confirms the boundary.
 *
 * FR-1.2. `He said "stop."` ends after the quote, not before it, so a boundary
 * scan that stopped at the full stop would cut mid-quotation and leave a
 * stranded `"` to open the next phrase.
 */
const CLOSERS = '"\'\u201D\u2019)]}';

/**
 * Abbreviations that end in a full stop without ending a sentence.
 *
 * Deliberately short. Every entry is a promise that the word is NEVER
 * sentence-final, and that promise is easy to get wrong: "etc." and "al." do
 * end sentences regularly, so they are absent. A missed boundary costs one
 * phrase of extra latency; a false boundary cuts a sentence in half and speaks
 * the fragments separately, which is audible and wrong.
 */
const ABBREVIATIONS = Object.freeze([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'vs', 'inc', 'ltd', 'co', 'approx', 'dept', 'est',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
]);

/**
 * Resolve options against the defaults.
 *
 * @param {object} [opts]
 * @returns {object}
 */
function config(opts) {
  const o = opts || {};
  return {
    maxPhraseLength: Number.isFinite(o.maxPhraseLength) && o.maxPhraseLength > 0
      ? Math.floor(o.maxPhraseLength) : DEFAULTS.maxPhraseLength,
    runtFloor: Number.isFinite(o.runtFloor) && o.runtFloor >= 0
      ? Math.floor(o.runtFloor) : DEFAULTS.runtFloor,
    markdownStripping: undefined === o.markdownStripping
      ? DEFAULTS.markdownStripping : Boolean(o.markdownStripping),
    deferSynthesisInCodeBlock: undefined === o.deferSynthesisInCodeBlock
      ? DEFAULTS.deferSynthesisInCodeBlock : Boolean(o.deferSynthesisInCodeBlock),
  };
}

/**
 * Is the full stop at `pos` part of an abbreviation rather than a sentence end?
 *
 * @param {string} text
 * @param {number} pos Index of the '.' character.
 * @returns {boolean}
 */
function isAbbreviation(text, pos) {
  if ('.' !== text[pos]) return false;

  // Walk back over the word attached to this stop, allowing internal stops so
  // "e.g." is seen whole rather than as a bare "g".
  let start = pos - 1;
  while (start >= 0 && /[A-Za-z.]/.test(text[start])) start -= 1;
  const word = text.slice(start + 1, pos).toLowerCase();
  if (!word) return false;
  if (ABBREVIATIONS.includes(word)) return true;

  // A single initial: "J. Smith". One letter followed by a stop is a name
  // initial far more often than a one-letter sentence.
  if (1 === word.length) return true;

  return false;
}

/**
 * Ranges of `text` that are inside a fenced code block or a markdown table.
 *
 * EC-1. Prose boundary rules produce nonsense inside these -- a table row is
 * not a sentence, and code is full of stops that end nothing. Returning ranges
 * rather than stripping them keeps every offset in the caller's coordinate
 * space, which is what makes the stateless contract work.
 *
 * An UNCLOSED fence runs to the end of the text, which is the correct reading
 * of a stream that has opened a block and not yet closed it: the block is
 * deferred until the closing fence arrives.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, closed: boolean}>}
 */
function protectedRanges(text) {
  const ranges = [];
  const fence = /^[ \t]*(?:```|~~~)/gm;
  let open = null;
  let m;

  while ((m = fence.exec(text)) !== null) {
    if (null === open) {
      open = m.index;
    } else {
      const lineEnd = text.indexOf('\n', m.index);
      ranges.push({ start: open, end: lineEnd === -1 ? text.length : lineEnd + 1,
                    closed: true });
      open = null;
    }
  }
  if (null !== open) ranges.push({ start: open, end: text.length, closed: false });

  // Markdown tables: consecutive lines beginning with a pipe. Treated as one
  // region so a boundary is never taken between two rows.
  const tableLine = /^[ \t]*\|.*$/gm;
  let run = null;
  let last = -1;
  while ((m = tableLine.exec(text)) !== null) {
    const inFence = ranges.some(r => m.index >= r.start && m.index < r.end);
    if (inFence) continue;
    if (null !== run && m.index === last) {
      run.end = m.index + m[0].length + 1;
    } else {
      if (null !== run) ranges.push(run);
      run = { start: m.index, end: m.index + m[0].length + 1, closed: true };
    }
    last = run.end;
  }
  if (null !== run) ranges.push(run);

  return ranges;
}

/**
 * Is `pos` inside a protected range?
 *
 * @param {Array<{start: number, end: number}>} ranges
 * @param {number} pos
 * @returns {object|null} The range, so the caller can see whether it closed.
 */
function rangeAt(ranges, pos) {
  for (const r of ranges) if (pos >= r.start && pos < r.end) return r;
  return null;
}

/**
 * Strip markdown syntax so the engine does not read it aloud (EC-2).
 *
 * Conservative on purpose. It removes emphasis markers, heading hashes, list
 * bullets and link syntax -- the tokens that are unambiguously formatting. It
 * does NOT try to be a markdown parser: a half-parsed construct that mangles
 * the words is worse than a stray asterisk, and the normaliser downstream
 * already removes typographic artifacts.
 *
 * Link text is kept and the URL dropped, because a URL read aloud character by
 * character is worse than silence about it.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '');
}

/**
 * Find the end of the first complete phrase in `text`, or -1.
 *
 * Returns the index one past the last character of the phrase, INCLUDING the
 * terminal punctuation and any closers, but excluding the whitespace that
 * confirmed it. The caller consumes that whitespace separately so no character
 * is lost from the offset accounting.
 *
 * The caller bounds the window so this never sees inside a protected region --
 * see splitStream, where a code block or table forces its own phrase edges
 * rather than being skipped over mid-phrase.
 *
 * @param {string} text
 * @param {object} cfg
 * @returns {number}
 */
function firstBoundary(text, cfg) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!TERMINAL.includes(ch)) continue;
    if ('.' === ch && isAbbreviation(text, i)) continue;

    // FR-1.2. Absorb an ellipsis run and any closing quotes or brackets.
    let end = i;
    while (end + 1 < text.length && TERMINAL.includes(text[end + 1])) end += 1;
    while (end + 1 < text.length && CLOSERS.includes(text[end + 1])) end += 1;

    // The boundary is only confirmed by whitespace AFTER it. Without this,
    // "3.14" splits after the stop, and a stream that has produced "end." but
    // not yet the following space would be cut at a point the next token may
    // turn out to continue.
    if (end + 1 >= text.length) return -1;
    if (!/\s/.test(text[end + 1])) continue;

    return end + 1;
  }
  return -1;
}

/**
 * Split newly-arrived text into complete phrases.
 *
 * THE CORE OF THE STATELESS CONTRACT. Given the whole accumulated text and how
 * much of it has already been spoken, return the phrases that are now complete
 * and how many characters they consumed.
 *
 * @param {string} text  The full accumulated reply so far.
 * @param {object} [opts]
 * @param {number} [opts.offset=0]  Characters already committed to audio.
 * @param {boolean} [opts.final=false]  The stream has ended (FR-3.2).
 * @param {object} [opts.config]  Section 8 tuneables.
 * @returns {{phrases: Array<{text: string, start: number, end: number}>,
 *            consumed: number, pending: string, deferred: boolean}}
 */
export function splitStream(text, opts) {
  const o = opts || {};
  const cfg = config(o.config);
  const full = 'string' === typeof text ? text : '';
  const offset = Number.isFinite(o.offset) && o.offset > 0
    ? Math.min(Math.floor(o.offset), full.length) : 0;
  const final = Boolean(o.final);

  const ranges = cfg.deferSynthesisInCodeBlock ? protectedRanges(full) : [];
  const phrases = [];
  let cursor = offset;
  let deferred = false;

  for (;;) {
    // Leading whitespace belongs to the gap, not to the phrase. Consuming it
    // here keeps the offset exact without it appearing in spoken text.
    while (cursor < full.length && /\s/.test(full[cursor])) cursor += 1;
    if (cursor >= full.length) break;

    // EC-1. A protected region forces phrase edges at BOTH its boundaries.
    //
    // Skipping over it -- the obvious implementation -- is wrong: the phrase
    // that began before the block then runs past it and swallows the prose
    // after it, so a code block and the sentence following it are spoken as one
    // utterance with the code in the middle.
    const here = rangeAt(ranges, cursor);
    if (here) {
      // An unclosed block has no end yet, so nothing after it can be spoken.
      // Deferring is the spec's answer: wait for the closing fence.
      if (!here.closed && !final) { deferred = true; break; }
      const blockEnd = here.closed ? here.end : full.length;
      const block = full.slice(cursor, blockEnd);
      const spokenBlock = cfg.markdownStripping ? stripMarkdown(block) : block;
      if (spokenBlock.trim().length) {
        phrases.push({ text: spokenBlock.trim(), start: cursor, end: blockEnd });
      }
      cursor = blockEnd;
      continue;
    }

    // Bound the search at the next protected region, so a phrase can end
    // cleanly just before a block starts.
    const next = ranges
      .filter(r => r.start > cursor)
      .reduce((min, r) => (null === min || r.start < min ? r.start : min), null);
    const limit = null === next ? full.length : next;

    const rest = full.slice(cursor, limit);
    let end = firstBoundary(rest, cfg);

    if (-1 === end) {
      // Text sitting between the cursor and a block start, with no terminal
      // punctuation of its own. It is complete -- the block ends it -- so it is
      // emitted rather than held for a boundary that will never come.
      if (null !== next && rest.trim().length) end = rest.length;
    }

    if (-1 === end) {

      // FR-1.3 / EC-4. No punctuation in sight and the buffer has passed the
      // ceiling: force a split rather than let one runaway clause starve the
      // pipeline. Cut at the last space before the ceiling so a word is never
      // broken; if there is no space at all, cut at the ceiling.
      if (rest.length > cfg.maxPhraseLength) {
        const window = rest.slice(0, cfg.maxPhraseLength);
        const space = window.lastIndexOf(' ');
        end = space > cfg.runtFloor ? space : cfg.maxPhraseLength;
      } else if (final) {
        // FR-3.2. The stream ended: flush the trailing partial even though it
        // never met a boundary. This is what guarantees the last sentence of a
        // reply is always spoken.
        end = rest.length;
      } else {
        break;
      }
    }

    // FR-1.3. The ceiling is HARD, so it applies even when a boundary WAS
    // found. A single sentence longer than the ceiling is still an oversized
    // synthesis job, and the point of the limit is to bound the job -- not
    // merely to rescue the case where punctuation never arrives.
    //
    // Split at the last space inside the ceiling so a word is never broken; if
    // the run has no space at all, cut at the ceiling itself.
    if (end > cfg.maxPhraseLength) {
      const window = rest.slice(0, cfg.maxPhraseLength);
      const space = window.lastIndexOf(' ');
      end = space > cfg.runtFloor ? space : cfg.maxPhraseLength;
    }

    const raw = rest.slice(0, end);
    const spoken = cfg.markdownStripping ? stripMarkdown(raw) : raw;

    // FR-3.3. A fragment below the floor is absorbed into the previous phrase
    // rather than spoken alone. Absorbing BACKWARDS keeps the reading order and
    // avoids holding a phrase back to wait for something to attach it to.
    if (spoken.trim().length < cfg.runtFloor && phrases.length) {
      const prev = phrases[phrases.length - 1];
      prev.text = `${prev.text} ${spoken.trim()}`.trim();
      prev.end = cursor + end;
    } else if (spoken.trim().length) {
      phrases.push({ text: spoken.trim(), start: cursor, end: cursor + end });
    }

    cursor += end;
  }

  return {
    phrases,
    // Where the caller should resume next time. Only advanced past text that
    // was actually turned into a phrase, so nothing is skipped.
    consumed: phrases.length ? phrases[phrases.length - 1].end : offset,
    // FR-3.1. The trailing partial, retained and reported rather than dropped.
    pending: full.slice(phrases.length ? phrases[phrases.length - 1].end : offset),
    deferred,
  };
}

/** The Section 8 defaults, for callers that want to report or override them. */
export function splitDefaults() {
  return Object.assign({}, DEFAULTS);
}

export default splitStream;
