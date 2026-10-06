// src/voice/engine-form.js
//
// Tenax Voice -- engine-form text. Work order W7 rev 1.1 (2026-10-06),
// deliverables 1 and 5. Connector v13.35.0.
//
// ===========================================================================
// WHAT THIS IS
// ===========================================================================
//
// The one formatter that turns reply text into the text an ENGINE receives.
// It never touches what the user sees: every caller hands it a copy that is
// used only for synthesis (acceptance criterion 7).
//
// Two profiles:
//
//   kokoro      The strip pass and nothing else. Kokoro's own pipeline
//               (voice-prosody-prep.js) runs afterwards exactly as before, so
//               Kokoro output changes only where a marker used to be read
//               aloud (acceptance criterion 10).
//
//   elevenlabs  The strip pass, then the same preparation this path used in
//               13.34.0 (prepareForKokoro in its espeak mode: speech
//               normalisation, link flattening, bold removal) WITHOUT its
//               contour shaping, the strip pass again for any marker that
//               flattening uncovered (`[**warm**]` -> `[warm]`), and the
//               punctuation rule table below. Appending a comma to a
//               "continuation" phrase is a Kokoro technique; on ElevenLabs a
//               generation that ends on a comma or a colon is a generation that
//               stops there (see the D1 table in docs/W7-ENGINE-FORM.md).
//
// Pure and idempotent: format(format(x)) === format(x), asserted in
// src/tests/voice-engine-form.test.js for every profile.
//
// ===========================================================================
// THE STRIP PASS (D5)
// ===========================================================================
//
// Square-bracket tokens are never spoken. Live use on eleven_multilingual_v2
// confirmed that bracketed tags are read aloud ("warm", "pause", "slowly",
// "softly", "drawn-out"); the model has no audio-tag vocabulary, so there is
// no tag channel to protect (W7 section 1). Kokoro's espeak front end reads the
// word inside the brackets too.
//
// What is stripped is listed in MARKER_REGISTER (the named vocabularies and
// where each comes from) and in TOKEN_CLASSES (the shapes that catch anything
// not yet named). What is deliberately NOT stripped:
//
//   - `[label](target)`: markdown links and our own misaki markup
//     (`[word](/ipa/)`, `[word](+2)`). Links are flattened to their label by the
//     elevenlabs profile and by Kokoro's own pipeline; misaki markup is how the
//     Kokoro pipeline asks for a pronunciation and must reach that engine.
//   - anything not in brackets. No content word is changed.

import { prepareForKokoro } from './voice-prosody-prep.js';

/** The version of the rule table. Bump on any change to RULES or the register. */
export const ENGINE_FORM_VERSION = 'engine-form/1 2026-10-06 (pin eleven_multilingual_v2)';

/**
 * Not glued to a word, a closing bracket or a closing parenthesis, so indexers
 * (`a[i]`, `array[0]`, `m[1][2]`) and subscripts are never taken for markers.
 */
const FREE = '(?<![\\p{L}\\p{N}_\\)\\]])';

/**
 * Every named bracketed vocabulary that can reach a voice route, with its source.
 * Each entry is stripped wherever it appears (asserted token by token).
 */
export const MARKER_REGISTER = Object.freeze({
  // SPEC-OUT-MARK-001: paragraph channel markers the model is instructed to
  // emit. Stripped for display in ts-client-gateway 06b-output-marker.js
  // (OUTPUT_MARKERS) and per delta in 07c-thought-trace.js; the incremental
  // speech path is fed the raw stream on its final flush, so they can arrive.
  channel: Object.freeze(['[OUTPUT]', '[TRACE]', '[RESULT]']),
  // Session directives, same client file (OUTPUT_MARKER_OUT_OF_SCOPE).
  directive: Object.freeze(['[private-conversation]', '[forget]']),
  // Fenceless panel triggers an assistant reply may carry in prose; the client
  // swaps them for a panel at render time (ts-client-gateway 06-markdown.js,
  // "Step 1c"), so they are absent from the rendered text but present in the
  // raw text the incremental speech path is fed.
  panel: Object.freeze(['[[TRAVEL_RESEARCH_FORM]]', '[[RECREATION_PANEL]]']),
  // Audio and register tags confirmed SPOKEN on the live path (W7 section 1).
  // The model writes them; nothing in the code base defines them, which is
  // why the 'tag' class below exists.
  tag: Object.freeze(['[warm]', '[pause]', '[slowly]', '[softly]', '[drawn-out]']),
});

/**
 * Shapes stripped whether or not the vocabulary is named. Each pattern is
 * global and never matches a `[label](target)` span.
 */
export const TOKEN_CLASSES = Object.freeze([
  // [[ANYTHING]] panel or system directive.
  { id: 'double_bracket', pattern: /\[\[[^\[\]\n]{1,80}\]\]/gu },
  // [OUTPUT], [TRACE], [SOME_MARKER]: an all-capitals protocol word of three
  // or more characters. Mixed case ([Enter], [Ctrl]) is a key name or a title
  // and is left alone.
  { id: 'upper_marker',
    pattern: new RegExp(`${FREE}\\[\\p{Lu}[\\p{Lu}\\p{N}_-]{2,39}\\](?![(:])`, 'gu') },
  // [warm], [drawn-out], [private-conversation], [sighs heavily]: one to four
  // LOWER-CASE words, the shape of every audio and register tag heard live.
  // Not followed by "(" (a link or misaki markup) or ":" (a reference
  // definition).
  { id: 'single_bracket_tag',
    pattern: new RegExp(`${FREE}\\[\\p{Ll}[\\p{Ll}\\p{N}_'’-]{0,39}`
      + `(?:[ \\t]{1,4}\\p{Ll}[\\p{Ll}\\p{N}_'’-]{0,39}){0,3}\\](?![(:])`, 'gu') },
  // Citation and footnote references: [1], [12], [^3]. Not a year ([2024]).
  { id: 'reference', pattern: new RegExp(`${FREE}\\[\\^?\\d{1,3}\\](?![(:])`, 'gu') },
  // Task-list boxes at a line start: [ ], [x]. Never a link labelled "x".
  { id: 'checkbox', pattern: /(^|\n)([ \t]*(?:[-*+][ \t]+)?)\[[ xX]\](?![(:])[ \t]?/gu },
  // An empty box anywhere. The incremental route strips list bullets and joins
  // phrases with spaces before synthesis, so "- [ ] item" can arrive as
  // "... [ ] item" in mid line, where the checkbox shape above cannot see it.
  { id: 'empty_box', pattern: new RegExp(`${FREE}\\[[ \\t]?\\](?![(:])`, 'gu') },
]);

/**
 * Remove every bracketed token in the register and every token class.
 *
 * Whitespace left by a removal is collapsed, and a space stranded before
 * punctuation is closed up, so "the cost [warm] is real." becomes "the cost is
 * real." and "[pause], then" becomes ", then" -> "then".
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkers(text) {
  const original = String(text || '');
  // Nothing bracketed, nothing to do: the text is returned as it came, byte for
  // byte, so the Kokoro path is unchanged for every reply without a marker
  // (acceptance criterion 10). The whitespace tidy below runs only when a
  // marker was actually removed.
  if (!original.includes('[')) return original;
  let out = original;
  // Repeated until nothing changes, so a token that only appears once another
  // is gone ("[note [1] here]", "[[]]", "[warm][pause]") is removed too and
  // stripMarkers(stripMarkers(x)) === stripMarkers(x). Every pass removes at
  // least two characters or stops, so the bound is never what ends a real
  // reply; it only caps the work on hostile input.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = out;
    for (const cls of TOKEN_CLASSES) {
      cls.pattern.lastIndex = 0;
      out = 'checkbox' === cls.id
        ? out.replace(cls.pattern, (m, start, lead) => `${start}${lead}`)
        : out.replace(cls.pattern, ' ');
    }
    // The register is covered by the classes (asserted), but is applied by
    // name as well, so a class narrowed in future cannot silently let one
    // through.
    for (const list of Object.values(MARKER_REGISTER)) {
      for (const token of list) out = out.split(token).join(' ');
    }
    if (out === before) break;
  }
  if (out === original) return original;
  return out
    .replace(/[^\S\n]{2,}/gu, ' ')
    .replace(/[^\S\n]+([,.;:!?…])/gu, '$1')
    .replace(/(^|\n)[^\S\n]*[,;:][^\S\n]*/gu, '$1')
    .replace(/^[^\S\n]+|[^\S\n]+$/gmu, '');
}

/**
 * The bracketed tokens still present in a string, ignoring `[label](target)`
 * spans. Used by the request-builder assertions; empty means tagless.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function bracketedTokens(text) {
  const s = String(text || '');
  const found = [];
  for (const cls of TOKEN_CLASSES) {
    cls.pattern.lastIndex = 0;
    let m;
    while ((m = cls.pattern.exec(s))) found.push(m[0].trim());
  }
  return found;
}

/**
 * Refuse text that would put a bracketed token in front of an engine.
 *
 * W7 deliverable 5, "an assertion at the request builder". The formatter runs
 * upstream, so this firing means a path bypassed it; the request is refused
 * with a named error rather than letting a tag be read aloud. Never echoes the
 * text (Section 10 of the voice spec: the words are not logged).
 *
 * @param {string} text
 * @param {string} where Request builder name, for the error.
 * @returns {void}
 * @throws {Error} code `tagged_text`.
 */
export function assertTagless(text, where) {
  const found = bracketedTokens(text);
  if (!found.length) return;
  const err = new Error(`${where}: ${found.length} bracketed token(s) reached the engine `
    + 'request; refused so they are not read aloud.');
  err.code = 'tagged_text';
  err.reason = 'error';
  throw err;
}

// ===========================================================================
// THE PUNCTUATION RULE TABLE (elevenlabs profile)
// ===========================================================================
//
// Every rule is a CANDIDATE awaiting the by-ear calibration W7 section 3 asks
// for (D2, D3, D4), and ships OFF. The work order is explicit that these
// substitutions are "to validate, not pre-judge", and no substitution here has
// been listened to yet. Turning one on is configuration, not code:
//
//   ELEVENLABS_PUNCTUATION="colon=period,semicolon=period"
//
// Each mark accepts only the replacements listed for it. An unknown mark or
// replacement is ignored and named in a warning. The calibration harness
// (scripts/el-punctuation-sweep.mjs) renders every candidate so the choice can
// be made by ear and recorded in docs/W7-ENGINE-FORM.md.
//
// BREAK TAGS are a candidate for the colon only, and are additionally gated on
// ELEVENLABS_BREAK_TAGS_VERIFIED=true (the D3 break-tag verdict) and on the
// model: never on eleven_v3 or eleven_v4, which do not support SSML breaks
// (F8). At most BREAK_LIMIT per generation, because the vendor warns that many
// breaks in one generation cause instability.

/** Break tags per generation, at most. */
export const BREAK_LIMIT = 2;
const BREAK_TAG = '<break time="0.5s" />';
const NO_BREAK_MODELS = Object.freeze(['eleven_v3', 'eleven_v4']);

/**
 * The candidate rules. `find` is applied with replaceAll semantics; `to` maps a
 * replacement name to its text. Only marks between words are touched:
 * "10:30", "https:", "3:1", "cost-benefit" and "2019-2024" never match.
 */
export const RULES = Object.freeze({
  colon: {
    find: /(?<=[\p{L}\p{N}\)"'”’])[^\S\n]*:(?=[^\S\n]+|\n|$)/gu,
    to: { period: '.', comma: ',', dash: ' -', break: 'BREAK' },
    state: 'off', evidence: 'pending D3 (live by ear: a colon stops the utterance, F5)',
  },
  semicolon: {
    find: /(?<=\S)[^\S\n]*;(?=\s|$)/gu,
    to: { period: '.', comma: ',' },
    state: 'off', evidence: 'pending D3',
  },
  emdash: {
    find: /[^\S\n]*[\u2014][^\S\n]*|[^\S\n]+[–][^\S\n]+/gu,
    to: { comma: ', ', space: ' ' },
    state: 'off', evidence: 'pending D3',
  },
  ellipsis: {
    find: /…|\.\s?\.\s?\./gu,
    to: { period: '.', comma: ',' },
    state: 'off', evidence: 'pending D3',
  },
  parentheses: {
    find: /[^\S\n]*\(([^()\n]{1,200})\)/gu,
    to: { comma: ', $1,' },
    state: 'off', evidence: 'pending D3',
  },
});

/**
 * The punctuation choices in force, from ELEVENLABS_PUNCTUATION.
 *
 * @param {object} [env]
 * @returns {{choices: Object<string,string>, ignored: string[]}}
 */
export function punctuationChoices(env) {
  const source = env || process.env;
  const raw = String(source.ELEVENLABS_PUNCTUATION || '').trim();
  const choices = {};
  const ignored = [];
  if (!raw) return { choices, ignored };
  for (const part of raw.split(',')) {
    const [mark, to] = part.split('=').map((x) => String(x || '').trim().toLowerCase());
    if (!mark) continue;
    if (!RULES[mark] || !Object.prototype.hasOwnProperty.call(RULES[mark].to, to)) {
      ignored.push(part.trim());
      continue;
    }
    choices[mark] = to;
  }
  return { choices, ignored };
}

let _warnedPunctuation = '';

/**
 * Apply the enabled punctuation rules.
 *
 * @param {string} text
 * @param {{modelId?: string, env?: object}} [opts]
 * @returns {string}
 */
export function applyPunctuationRules(text, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const { choices, ignored } = punctuationChoices(env);
  if (ignored.length && _warnedPunctuation !== ignored.join(',')) {
    _warnedPunctuation = ignored.join(',');
    console.warn(`[voice] ELEVENLABS_PUNCTUATION entries ignored: ${ignored.join(', ')}`);
  }
  let out = String(text || '');
  // Every rule off (the shipped default): the text passes through untouched.
  if (!Object.keys(choices).length) return out;
  // Tags already present (a second pass over formatted text) count toward the
  // limit, so formatting twice can never exceed it.
  let breaks = out.split(BREAK_TAG).length - 1;
  const breaksAllowed = 'true' === String(env.ELEVENLABS_BREAK_TAGS_VERIFIED || '').toLowerCase()
    && !NO_BREAK_MODELS.includes(String(o.modelId || ''));

  for (const [mark, to] of Object.entries(choices)) {
    const rule = RULES[mark];
    rule.find.lastIndex = 0;
    if ('BREAK' === rule.to[to]) {
      out = out.replace(rule.find, () => {
        if (breaksAllowed && breaks < BREAK_LIMIT) { breaks += 1; return ` ${BREAK_TAG}`; }
        // Not verified, a model without breaks, or over the limit: a full stop,
        // never a tag that could be read aloud.
        return '.';
      });
    } else {
      out = out.replace(rule.find, rule.to[to]);
    }
  }
  return out.replace(/[^\S\n]{2,}/gu, ' ').replace(/,\s*([.,])/gu, '$1');
}

// ===========================================================================
// THE PROFILES
// ===========================================================================

/**
 * Engine-form text.
 *
 * @param {string} text Reply text (a copy; the display text is never passed back).
 * @param {'kokoro'|'elevenlabs'} profile
 * @param {{modelId?: string, env?: object}} [opts]
 * @returns {string}
 */
export function toEngineForm(text, profile, opts) {
  const source = String(text || '');
  if ('elevenlabs' !== profile) return stripMarkers(source);

  // The 13.34.0 preparation for this path (normalisation, link flattening,
  // bold removal; no G2P markup, no lexicon) with contour shaping switched
  // off, between two strip passes, then the enabled punctuation rules. Reused
  // rather than rewritten: a general markdown stripper would also eat
  // underscores and asterisks inside words (`my_var_name`, `**kwargs`).
  //
  // A break tag this formatter emitted is carried through untouched: the
  // normaliser removes double quotes, and running it over `time="0.5s"` would
  // turn the tag into text the model reads aloud. Text is formatted between
  // tags, which is what keeps format(format(x)) === format(x) when the break
  // rule is on.
  const pieces = source.split(BREAK_TAG).map((piece) => stripMarkers(prepareForKokoro(stripMarkers(piece), {
    g2p: 'espeak', emphasis: false, lexicon: {}, position: 'none',
  }).text).trim());
  return applyPunctuationRules(pieces.join(` ${BREAK_TAG} `), opts).trim();
}

export default {
  ENGINE_FORM_VERSION, MARKER_REGISTER, TOKEN_CLASSES, RULES, BREAK_LIMIT,
  stripMarkers, bracketedTokens, assertTagless, punctuationChoices,
  applyPunctuationRules, toEngineForm,
};
