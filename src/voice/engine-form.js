// src/voice/engine-form.js
//
// Tenax Voice -- engine-form text. Work order W7 rev 2.1 (2026-10-06), which
// supersedes rev 1.1. Connector v13.36.0.
//
// ===========================================================================
// WHAT THIS IS
// ===========================================================================
//
// The one formatter that turns reply text into the text an ENGINE receives. It
// never touches what the user sees: every caller hands it a copy that is used
// only for synthesis.
//
// Rev 1.1 stripped every bracket SHAPE. Rev 2.1 corrects that (section 3): a
// token is classified by membership of a CLOSED VOCABULARY, the registry in
// register-grammar.v1.json, and anything not in the registry is content.
//
//   Class A  channel scaffolding ([OUTPUT], panel triggers, control lines):
//            never speech, removed for every engine.
//   Class B  prosody and register cues ([warm], [pause] ...): removed for
//            Kokoro always; for ElevenLabs passed through when the user's tag
//            switch is on, removed otherwise.
//   Class C  content: everything else in brackets, every markdown link and
//            misaki span, everything inside a code span. Never transformed.
//
// Content spans are decided FIRST (section 3.4): a token inside an inline code
// span, a fenced code block or a `[label](target)` link is content whatever it
// says, which is the escape hatch for prose ABOUT a marker (section 3.6).
//
// Unknown bracket tokens are logged, never transformed (section 3.5), so a
// marker the writer emits before it is registered becomes visible in the log
// rather than being silently stripped by an open pattern.
//
// Pure and idempotent: format(format(x)) === format(x) for both profiles, and
// where neither Class A nor Class B is present the text is returned byte for
// byte (section 4.3). Removal deletes the token and one separating space and
// nothing else (section 4.1).
//
// The request-builder guards G1 to G4 (section 8) are here too, so the
// builders and the formatter classify with the same code.

import { readFileSync } from 'node:fs';
import { prepareForKokoro } from './voice-prosody-prep.js';

/** The registry, read from the register grammar file (section 3.2), not duplicated in code. */
const REGISTRY_URL = new URL('./register-grammar.v1.json', import.meta.url);

/**
 * Validate a parsed register grammar and build the registry from it. A
 * registry that is malformed or has an empty class is a deploy fault: the
 * connector refuses to start rather than run a formatter with an empty
 * vocabulary (which would read every marker aloud). Exported so the refusals
 * can be tested without editing the shipped file.
 *
 * @param {object} raw The parsed register-grammar JSON.
 * @returns {object}
 * @throws {Error} When a class is missing or empty, a token is malformed, or
 *                 there is no version.
 */
export function parseRegistry(raw) {
  const out = { version: String(raw.version || ''), entries: [], fixtures: raw.fixtures || {} };
  for (const cls of ['A', 'B']) {
    const tokens = raw.classes && raw.classes[cls] && raw.classes[cls].tokens;
    if (!Array.isArray(tokens) || !tokens.length) {
      throw new Error(`register-grammar.v1.json: class ${cls} has no tokens`);
    }
    for (const t of tokens) {
      if ('string' !== typeof t.token || !/^\[\[?[^\[\]\n]{1,80}\]\]?$/u.test(t.token)) {
        throw new Error(`register-grammar.v1.json: malformed token ${JSON.stringify(t.token)}`);
      }
      const spellings = [t.token, ...(Array.isArray(t.variants) ? t.variants : [])];
      out.entries.push(Object.freeze({
        cls, token: t.token, kind: t.kind || ('B' === cls ? 'cue' : 'scaffolding'),
        scope: 'line' === t.scope ? 'line' : 'token',
        caseInsensitive: true === t.case_insensitive,
        spellings: Object.freeze(spellings.slice()),
        keys: Object.freeze(spellings.map((s) => matchKey(s, true === t.case_insensitive))),
      }));
    }
  }
  if (!out.version) throw new Error('register-grammar.v1.json: no version');
  return Object.freeze({ ...out, entries: Object.freeze(out.entries) });
}

/**
 * Read the shipped register grammar file and build the registry from it.
 *
 * @returns {object}
 */
function loadRegistry() {
  return parseRegistry(JSON.parse(readFileSync(REGISTRY_URL, 'utf8')));
}

/**
 * The comparison key of a token: asterisks and underscores removed (markdown
 * emphasis, and the incremental route's stripping of underscore pairs), lower
 * case when the entry is case-insensitive.
 *
 * @param {string} s
 * @param {boolean} lower
 * @returns {string}
 */
function matchKey(s, lower) {
  const k = String(s).replace(/[*_]/gu, '');
  return lower ? k.toLowerCase() : k;
}

export const REGISTRY = loadRegistry();
export const REGISTRY_VERSION = REGISTRY.version;
/** W7 rev 2.1 section 7.1, from the registry file. */
export const TAG_FIXTURE = String(REGISTRY.fixtures.tag_capability || '');
/** W7 rev 2.1 section 6.2 item 2, from the registry file. */
export const WORD_FIXTURE = String(REGISTRY.fixtures.model_availability || 'Test.');

/** The version of the rule table and classifier. Bump on any change to either. */
export const ENGINE_FORM_VERSION = `engine-form/2 2026-10-06 (pin eleven_multilingual_v2; ${REGISTRY_VERSION})`;

// ===========================================================================
// CLASSIFICATION
// ===========================================================================

/** Content spans, decided before any token is classified (section 3.4). */
const CONTENT_SPANS = [
  { kind: 'code_block', pattern: /```[\s\S]*?(?:```|$)/gu },
  { kind: 'code_span', pattern: /(`+)[^`\n]+?\1/gu },
  // [label](target): markdown links, images and misaki markup ([w](/ipa/), [w](+2)).
  { kind: 'link', pattern: /!?\[[^\]\n]*\]\([^)\n]*\)/gu },
];

/** A bracket token candidate: [[...]] first, then [...], neither spanning a line. */
const CANDIDATE = /\[\[[^\[\]\n]{1,80}\]\]|\[[^\[\]\n]{1,80}\]/gu;

/** Content forms named for the log, in the order they are tried. */
function contentForm(token, before) {
  if (/^\[\^?\d{1,3}\]$/u.test(token)) return 'reference';
  if (/^\[[ xX]?\]$/u.test(token)) return 'checkbox';
  if (before && /[\p{L}\p{N}_)\]]/u.test(before)) return 'indexer';
  return 'unknown';
}

/**
 * Classify every bracket token in a text.
 *
 * @param {string} text
 * @returns {{tokens: Array<{text: string, start: number, end: number, cls: 'A'|'B'|'C',
 *            kind: string, entry: object|null}>, spans: Array<{start: number, end: number, kind: string}>,
 *            counts: {A: number, B: number, C: number, unknown: number, total: number}}}
 */
export function classifyBrackets(text) {
  const s = String(text || '');
  const counts = { A: 0, B: 0, C: 0, unknown: 0, total: 0 };
  if (!s.includes('[')) return { tokens: [], spans: [], counts };

  const spans = [];
  for (const { kind, pattern } of CONTENT_SPANS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(s))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some((x) => start < x.end && end > x.start)) spans.push({ start, end, kind });
      if (m[0].length === 0) pattern.lastIndex += 1;
    }
  }
  const inSpan = (start, end) => spans.some((x) => start >= x.start && end <= x.end);

  const tokens = [];
  CANDIDATE.lastIndex = 0;
  let m;
  while ((m = CANDIDATE.exec(s))) {
    const start = m.index;
    const end = start + m[0].length;
    let cls = 'C';
    let kind;
    let entry = null;
    if (inSpan(start, end)) {
      kind = spans.find((x) => start >= x.start && end <= x.end).kind;
    } else {
      entry = REGISTRY.entries.find((e) => e.keys.includes(matchKey(m[0], e.caseInsensitive))) || null;
      if (entry) {
        cls = entry.cls;
        kind = entry.kind;
      } else {
        kind = contentForm(m[0], start > 0 ? s[start - 1] : '');
      }
    }
    tokens.push({ text: m[0], start, end, cls, kind, entry });
    counts.total += 1;
    counts[cls] += 1;
    if ('unknown' === kind) counts.unknown += 1;
  }
  return { tokens, spans, counts };
}

/**
 * Remove the Class A tokens, and the Class B tokens unless they are kept.
 *
 * A removed token takes one separating space with it and nothing else, so the
 * result equals the input with the marker removed (section 4.1). A line-scoped
 * entry (a control line) removes the rest of its line, not the newline. A kept
 * Class B token that matched through emphasis (`[**warm**]`) is written in its
 * registered spelling, so what reaches the engine is well formed (G3).
 *
 * @param {string} text
 * @param {{keepB?: boolean}} [opts]
 * @returns {string}
 */
export function removeClasses(text, opts) {
  const keepB = Boolean(opts && opts.keepB);
  const source = String(text || '');
  let out = source;
  // Repeated until stable. One pass is enough for any input seen so far; the
  // loop makes idempotence a property of the code rather than of the inputs.
  for (let pass = 0; pass < 4; pass += 1) {
    const { tokens } = classifyBrackets(out);
    const edits = tokens.filter((t) => 'A' === t.cls || ('B' === t.cls && !keepB)
      || ('B' === t.cls && keepB && !t.entry.spellings.includes(t.text)));
    if (!edits.length) break;
    let next = '';
    let at = 0;
    for (const t of edits) {
      if (t.start < at) continue;   // inside a line already removed
      let start = t.start;
      let end = t.end;
      let replacement = '';
      if ('B' === t.cls && keepB) {
        replacement = t.entry.token;
      } else {
        // An emphasis wrapper around the token (`**[warm]**`, `_[pause]_`)
        // goes with it: left behind it would be an empty `****` the Kokoro
        // preparation does not recognise as markup.
        let lead = 0;
        while (start - lead - 1 >= at && /[*_]/u.test(out[start - lead - 1])) lead += 1;
        let trail = 0;
        while (/[*_]/u.test(out[end + trail] || '')) trail += 1;
        if (lead > 0 && lead === trail
            && out.slice(start - lead, start) === out.slice(end, end + trail).split('').reverse().join('')) {
          start -= lead;
          end += trail;
        }
        if ('line' === t.entry.scope) {
          const nl = out.indexOf('\n', end);
          end = -1 === nl ? out.length : nl;
        }
        // One separating space: the one after the token, else the one before.
        if (/[ \t]/u.test(out[end] || '') && (0 === start || /[ \t\n]/u.test(out[start - 1]))) {
          end += 1;
        } else if (start > at && /[ \t]/u.test(out[start - 1] || '')
                   && (end >= out.length || /[\n.,;:!?…]/u.test(out[end]))) {
          start -= 1;
        }
      }
      next += out.slice(at, start) + replacement;
      at = end;
    }
    next += out.slice(at);
    if (next === out) break;
    out = next;
  }
  return out === source ? source : out;
}

// ===========================================================================
// THE GUARDS (section 8)
// ===========================================================================

/**
 * A guard failure. Never carries the text (the words are not logged).
 *
 * @param {string} guard G1 | G2 | G3
 * @param {string} where
 * @param {number} n
 * @param {string} what
 * @returns {Error}
 */
function guardError(guard, where, n, what) {
  const err = new Error(`${where}: ${guard} refused ${n} ${what} token(s) in the engine request.`);
  err.code = 'tagged_text';
  err.guard = guard;
  err.reason = 'error';
  return err;
}

/**
 * The guards for one engine request, run by each request builder.
 *
 *   G1  both builders: no Class A token. Always.
 *   G2  Kokoro builder: no Class B token. Always.
 *   G3  ElevenLabs builder: Class B absent with the tag switch off; with it on,
 *       every Class B token in its registered spelling.
 *   G4  both builders: every bracket token classified, and the classification
 *       count logged when there is one. Unknown tokens are content: logged
 *       by count, never refused.
 *
 * @param {string} text
 * @param {{builder: 'kokoro'|'elevenlabs', tags?: boolean, where: string}} o
 * @returns {{A: number, B: number, C: number, unknown: number, total: number}}
 * @throws {Error} code tagged_text, with `guard`.
 */
export function guardRequest(text, o) {
  const { tokens, counts } = classifyBrackets(text);
  if (counts.A) throw guardError('G1', o.where, counts.A, 'channel');
  if ('kokoro' === o.builder && counts.B) throw guardError('G2', o.where, counts.B, 'prosody');
  if ('elevenlabs' === o.builder) {
    if (!o.tags && counts.B) throw guardError('G3', o.where, counts.B, 'prosody');
    const malformed = tokens.filter((t) => 'B' === t.cls && !t.entry.spellings.includes(t.text));
    if (malformed.length) throw guardError('G3', o.where, malformed.length, 'malformed prosody');
  }
  if (counts.total) {
    console.info(`[voice] engine-form ${o.where}: brackets=${counts.total} A=${counts.A} `
      + `B=${counts.B} content=${counts.C} unknown=${counts.unknown}`);
  }
  return counts;
}

/**
 * Log the unknown bracket tokens of a reply (section 3.5). Only tag-shaped
 * tokens (one to four lower-case words) are named, because those are the
 * shape a not-yet-registered marker takes; any other bracketed content is
 * counted and not quoted, since the words of a reply are not logged.
 *
 * @param {Array<object>} tokens
 * @param {string} where
 * @returns {void}
 */
function logUnknown(tokens, where) {
  const unknown = tokens.filter((t) => 'unknown' === t.kind);
  if (!unknown.length) return;
  const named = unknown.map((t) => t.text)
    .filter((t) => /^\[\p{Ll}[\p{Ll}\p{N}'’-]{0,23}(?: \p{Ll}[\p{Ll}\p{N}'’-]{0,23}){0,3}\]$/u.test(t))
    .slice(0, 5);
  console.info(`[voice] engine-form ${where}: ${unknown.length} unregistered bracket token(s) `
    + `left as content${named.length ? `: ${named.join(' ')}` : ''}`);
}

// ===========================================================================
// THE PUNCTUATION RULE TABLE (elevenlabs profile), unchanged from rev 1.1
// ===========================================================================
//
// Every rule is a CANDIDATE awaiting the by-ear calibration (D2, D3, D4), and
// ships OFF. Turning one on is configuration, not code:
//
//   ELEVENLABS_PUNCTUATION="colon=period,semicolon=period"
//
// BREAK TAGS are a candidate for the colon only, gated on
// ELEVENLABS_BREAK_TAGS_VERIFIED=true (the D3 break-tag verdict), never used
// on eleven_v3 or eleven_v4 (no SSML break support), and at most BREAK_LIMIT
// per generation (the vendor's instability warning).

/** Break tags per generation, at most. */
export const BREAK_LIMIT = 2;
const BREAK_TAG = '<break time="0.5s" />';
const NO_BREAK_MODELS = Object.freeze(['eleven_v3', 'eleven_v4']);

/**
 * The candidate rules. Only marks between words are touched: "10:30",
 * "https:", "3:1", "cost-benefit" and "2019-2024" never match.
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
    find: /[^\S\n]*[\u2014][^\S\n]*|[^\S\n]+[\u2013][^\S\n]+/gu,
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
 * Apply the enabled punctuation rules. Every rule off (the shipped default):
 * the text passes through untouched.
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
// THE PROFILES (section 4)
// ===========================================================================

/**
 * Engine-form text.
 *
 *   kokoro      Class A and Class B removed; nothing else changes.
 *   elevenlabs  Class A removed; Class B kept when `tags` is true, removed
 *               otherwise; then the enabled punctuation rules (all off).
 *
 * @param {string} text Reply text (a copy; the display text is never passed back).
 * @param {'kokoro'|'elevenlabs'} profile
 * @param {{tags?: boolean, modelId?: string, env?: object, where?: string, log?: boolean}} [opts]
 * @returns {string}
 */
export function toEngineForm(text, profile, opts) {
  const o = opts || {};
  const keepB = 'elevenlabs' === profile && true === o.tags;
  const removed = entryForm(text, { keepB, where: o.where || `${profile} text`, log: o.log });
  if ('elevenlabs' !== profile) return removed;
  return applyPunctuationRules(removed, o);
}

/**
 * The classification at a synthesis ENTRY, before analysis: Class A removed,
 * Class B removed unless `keepB`, unknown tokens logged once for the reply.
 * The Kokoro profile is exactly this with keepB false. The stream path uses it
 * with keepB true for a user whose ElevenLabs tag switch is on, so the cues
 * survive analysis; each Kokoro rendering on that path then takes the Kokoro
 * profile of its own phrase.
 *
 * @param {string} text
 * @param {{keepB?: boolean, where?: string, log?: boolean}} [opts]
 * @returns {string}
 */
export function entryForm(text, opts) {
  const o = opts || {};
  const source = String(text || '');
  if (false !== o.log && source.includes('[')) {
    logUnknown(classifyBrackets(source).tokens, o.where || 'entry');
  }
  return removeClasses(source, { keepB: true === o.keepB });
}

/**
 * The speech preparation the ElevenLabs path has used since 13.34.0, minus
 * Kokoro's contour shaping: normalisation, link flattening, bold removal, no
 * G2P markup, no lexicon. Runs BEFORE toEngineForm on that path, so a marker
 * that flattening uncovers (`[**warm**]` becomes `[warm]`) is classified
 * rather than slipping past. A break tag the rules emitted is carried through,
 * because the normaliser removes double quotes.
 *
 * @param {string} text
 * @returns {string}
 */
export function prepareForElevenLabs(text) {
  return String(text || '').split(BREAK_TAG).map((piece) => prepareForKokoro(piece, {
    g2p: 'espeak', emphasis: false, lexicon: {}, position: 'none',
  }).text.trim()).join(` ${BREAK_TAG} `).trim();
}

export default {
  REGISTRY, REGISTRY_VERSION, TAG_FIXTURE, WORD_FIXTURE, ENGINE_FORM_VERSION, RULES,
  BREAK_LIMIT, parseRegistry, classifyBrackets, removeClasses, guardRequest, punctuationChoices,
  applyPunctuationRules, toEngineForm, entryForm, prepareForElevenLabs,
};
