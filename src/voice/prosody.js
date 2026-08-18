// src/voice/prosody.js
//
// Tenax Voice -- the prosody transformation layer.
// TS-VOICE-PROSODY-v1.0 Sections 4, 5, 6, 9.
// SPEC-VOICE-001-v1.2.0 Components A, B, C and the Prosody Register Model.
//
// ===========================================================================
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// ===========================================================================
//
// It is a PURE TRANSFORM (N5 / non-negotiable 4). Text in, an annotation
// structure out. It spawns nothing, reads no file, opens no socket, loads no
// model and imports nothing outside node's own standard library -- in fact it
// imports nothing at all. Every function here is deterministic: the same text
// and the same configuration always produce the same annotation.
//
// That property is the whole reason Section 8 (AC7) can require the register
// detector and the prosody mapper to be verified "as a pure text-to-annotation
// transform" with "no Piper invocation required". A layer that reached out to
// anything could not be tested that way, and the acceptance criteria would
// quietly become untestable.
//
// It is NOT the synthesiser. Nothing here knows what a Piper process is. The
// caller (voice-engines.js) takes the annotation and decides how to render it.
//
// ===========================================================================
// THE ONE THING EASIEST TO GET BACKWARDS: length_scale IS INVERSE
// ===========================================================================
//
// Piper's `--length_scale` scales the DURATION of the utterance, not its rate:
//
//     length_scale 1.20  ->  20% LONGER  ->  SLOWER
//     length_scale 0.94  ->   6% SHORTER ->  FASTER
//
// The specification's Section 5 table is headed "Rate (relative)" and gives
// direct = 0.94, wry = 1.08. Read as rates those are backwards (it also says a
// direct statement is "slightly quicker" and a wry one "a beat slower"), and
// read as LENGTH SCALES they are exactly right. So the numbers in the spec are
// length-scale multipliers, and they are named that way throughout this file.
// `PROSODY_RATE_*` is kept as the ENV VARIABLE name because Section 9 fixes it,
// but the value it carries is a length-scale multiplier and the code says so
// everywhere it is touched.
//
// Getting this backwards would make every wry sentence fast and every direct
// sentence slow, which is a defect that still "works" -- it produces audio, it
// just inverts the entire feature. assertions in voice-prosody.test.js pin the
// direction so it cannot regress silently.
//
// ===========================================================================
// VOICE-AGNOSTIC (N2 / non-negotiable 2, AC6)
// ===========================================================================
//
// Nothing here names a voice, a sample rate, a speaker or a model path. Rates
// are RELATIVE MULTIPLIERS applied to whatever base length_scale the active
// voice's own config declares; pauses are DURATIONS IN MILLISECONDS, which the
// caller converts to samples at whatever rate the voice runs at. Change the
// voice and this file does not change.

/* ------------------------------------------------------------------------ *
 * Configuration (Section 9)
 * ------------------------------------------------------------------------ */

/**
 * Defaults, exactly as Section 9 lists them, plus the four values the spec
 * describes in prose but does not name.
 *
 * They are DATA. Section 4.1 is explicit that "all values are defaults, tunable
 * by ear through config; they are expressed as config data, not code", which is
 * why nothing below is written as a literal at its point of use.
 */
export const PROSODY_DEFAULTS = Object.freeze({
  /* Section 9. Length-scale multipliers -- see the header. */
  rateDirect:   0.94,
  rateWry:      1.08,
  rateContrast: 1.02,
  rateNeutral:  1.00,

  /* Section 4.1, the pause tier table. */
  pauseParagraphMs: 450,
  pauseSentenceMs:  250,
  pauseDwellMs:     120,
  pauseEmphasisMs:   80,

  /* Section 4.3, "a slight rate dip on the phrase containing it". A dip in
   * RATE is a rise in length_scale, so this is above 1. Not in the Section 9
   * list because the spec describes it in prose; given a name here so it is
   * tunable like everything else rather than being the one magic number. */
  emphasisDip: 1.06,

  /* Section 5, wry: "beat before final clause". The extra silence inserted
   * ahead of the last phrase of a wry sentence, on top of the dwell pause the
   * phrase boundary already earns. */
  wryBeatMs: 180,

  /* Non-negotiable 7 (SPEC-VOICE-001): "concatenation must not introduce
   * audible clicks, gaps, or joins". A join between two independently
   * synthesised segments is a step discontinuity in the waveform, which is
   * heard as a click. A few milliseconds of fade at each edge removes it. */
  joinFadeMs: 5,

  /* Ceilings. A reply is capped at 5000 characters by the route, but a
   * pathological one (a list of 400 two-word lines) could still explode into
   * hundreds of Piper invocations. Beyond this the tail is merged into fewer,
   * longer phrases rather than refused: degrading the prosody is a far better
   * failure than refusing to speak. */
  maxPhrases: 120,

  /* Below this many characters a fragment is not worth its own synthesis
   * call -- the per-call overhead exceeds the audio, and Piper given "and"
   * alone produces an artefact rather than a word. Merged backwards instead. */
  minPhraseChars: 2,
});

/**
 * Read a floating-point environment variable, falling back when it is absent,
 * unparseable, or outside a sane range.
 *
 * The range check is not decoration. `PROSODY_RATE_WRY=0` would ask Piper for
 * a zero-length utterance and `=50` for a fifty-fold one; both are ways to make
 * the synthesiser fail on a value that came from configuration, which is the
 * hardest kind of failure to diagnose.
 *
 * @param {string} name  Environment variable name.
 * @param {number} fallback
 * @param {number} min   Inclusive lower bound.
 * @param {number} max   Inclusive upper bound.
 * @param {object} [env] Environment to read; defaults to process.env.
 * @returns {number}
 */
function floatEnv(name, fallback, min, max, env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const raw = source[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Read a non-negative integer environment variable.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {object} [env]
 * @returns {number}
 */
function intEnv(name, fallback, min, max, env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const raw = source[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Is the prosody layer switched on?
 *
 * Section 9 lists VOICE_PROSODY_ENABLED as "default true after ship", and
 * Section 10 instructs "ship with the layer present but
 * VOICE_PROSODY_ENABLED=false; flip to true ... after the A/B comparison
 * confirms the tuning". Those describe two different moments, and the code
 * default has to be the FIRST one: shipping with it on would deploy untuned
 * prosody to every user before anyone had listened to it.
 *
 * So the default is false and flipping it is an operator action, which is what
 * Section 10's rollout is.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function prosodyEnabled(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  return String(source.VOICE_PROSODY_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * The active configuration, resolved from the environment over the defaults.
 *
 * Read fresh on each call rather than frozen at import. Tests set the
 * environment and expect the next call to see it, and an operator changing a
 * value should not have to reason about module load order.
 *
 * @param {object} [env] Environment to read; defaults to process.env.
 * @returns {Readonly<typeof PROSODY_DEFAULTS & {enabled: boolean}>}
 */
export function prosodyConfig(env) {
  const d = PROSODY_DEFAULTS;
  return Object.freeze({
    enabled: prosodyEnabled(env),

    // Section 9 names these three. Bounded to a range Piper can render: below
    // 0.5 speech is unintelligibly fast, above 2.0 it is a drawl.
    rateDirect:   floatEnv('PROSODY_RATE_DIRECT',   d.rateDirect,   0.5, 2.0, env),
    rateWry:      floatEnv('PROSODY_RATE_WRY',      d.rateWry,      0.5, 2.0, env),
    rateContrast: floatEnv('PROSODY_RATE_CONTRAST', d.rateContrast, 0.5, 2.0, env),
    rateNeutral:  floatEnv('PROSODY_RATE_NEUTRAL',  d.rateNeutral,  0.5, 2.0, env),

    // Section 9 names these four. Capped at 5 s: a longer "pause" is a hang,
    // and a configuration typo should not silently become one.
    pauseParagraphMs: intEnv('PROSODY_PAUSE_PARAGRAPH_MS', d.pauseParagraphMs, 0, 5000, env),
    pauseSentenceMs:  intEnv('PROSODY_PAUSE_SENTENCE_MS',  d.pauseSentenceMs,  0, 5000, env),
    pauseDwellMs:     intEnv('PROSODY_PAUSE_DWELL_MS',     d.pauseDwellMs,     0, 5000, env),
    pauseEmphasisMs:  intEnv('PROSODY_PAUSE_EMPHASIS_MS',  d.pauseEmphasisMs,  0, 5000, env),

    emphasisDip: floatEnv('PROSODY_EMPHASIS_DIP', d.emphasisDip, 0.5, 2.0, env),
    wryBeatMs:   intEnv('PROSODY_WRY_BEAT_MS',    d.wryBeatMs,    0, 5000, env),
    joinFadeMs:  intEnv('PROSODY_JOIN_FADE_MS',   d.joinFadeMs,   0, 100,  env),

    maxPhrases:     intEnv('PROSODY_MAX_PHRASES',      d.maxPhrases,     1, 1000, env),
    minPhraseChars: intEnv('PROSODY_MIN_PHRASE_CHARS', d.minPhraseChars, 1, 200,  env),
  });
}

/* ------------------------------------------------------------------------ *
 * Register detection (Section 5)
 * ------------------------------------------------------------------------ */

/**
 * The four profiles, keyed by the name Section 5's table uses.
 *
 * `rateKey` names the config field rather than carrying a number, so a profile
 * cannot drift out of step with the environment override that is meant to tune
 * it.
 */
export const PROFILES = Object.freeze({
  direct:   Object.freeze({ name: 'direct',   rateKey: 'rateDirect',   emphasis: 'key_noun' }),
  wry:      Object.freeze({ name: 'wry',      rateKey: 'rateWry',      emphasis: 'none' }),
  contrast: Object.freeze({ name: 'contrast', rateKey: 'rateContrast', emphasis: 'contrast_term' }),
  neutral:  Object.freeze({ name: 'neutral',  rateKey: 'rateNeutral',  emphasis: 'none' }),
});

/**
 * Section 5, "Direct / declarative": sentence-INITIAL markers.
 *
 * Anchored with ^ because position is the signal. "I answered honestly" is not
 * a directness cue; "Honestly, it will not work" is. A substring match would
 * conflate the two and re-pace half the corpus.
 */
const DIRECT_INITIAL = [
  /^honestly\b/i,
  /^straight answer\b/i,
  /^directly\b/i,
  /^the point is\b/i,
  /^plainly\b/i,
  /^to be direct\b/i,
  /^the short answer\b/i,
];

/**
 * Section 5, "Wry / understated": sentence-FINAL markers.
 *
 * Anchored at the end, tolerating terminal punctuation and a closing quote.
 * "right" mid-sentence ("the right answer") is not a wry marker; "right" as the
 * last word ("that is the whole point, right") is.
 */
const WRY_FINAL = [
  /\bright[.!?"'\u2019\u201d]*$/i,
  /\bthat'?s the whole game[.!?"'\u2019\u201d]*$/i,
  /\bthat is the whole game[.!?"'\u2019\u201d]*$/i,
  /\bworth naming[.!?"'\u2019\u201d]*$/i,
  /\bwhich is the point[.!?"'\u2019\u201d]*$/i,
  /\bas you do[.!?"'\u2019\u201d]*$/i,
  /\bof course[.!?"'\u2019\u201d]*$/i,
];

/**
 * Section 5, "Contrast / emphasis". Anywhere in the sentence.
 *
 * The first pattern is the "not X but Y" construction; the rest are the lexical
 * contrast markers the specification names, plus superlatives, which carry
 * contrast by construction ("the LARGEST cost is not the licence").
 */
const CONTRAST_PATTERNS = [
  /\bnot\b[^.!?]{1,80}?\bbut\b/i,
  /\bthe real\b/i,
  /\bburied\b/i,
  /\bthe actual\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
  // Analytic superlative. Unambiguous: "most" and "least" before an adjective
  // have no other reading.
  /\b(?:most|least)\s+\w{3,}\b/i,
];

/**
 * Inflected superlatives ("the largest cost", "the hardest part").
 *
 * SPLIT OUT FROM THE LIST ABOVE BECAUSE THE OBVIOUS PATTERN IS WRONG.
 *
 * The first version of this file matched /\b\w{4,}est\b/, and that fires on
 * "request", "suggest", "interest", "protest", "harvest", "contest" and a
 * dozen more. The effect is not a subtle mis-tuning: "The client sent a
 * request." would be paced as a contrast sentence and would earn a stress
 * bracket around a word carrying no contrast at all. That is a large fraction
 * of ordinary business prose re-paced for no reason.
 *
 * Two guards instead, and both must hold:
 *
 *   1. A determiner immediately before it. English superlatives are
 *      overwhelmingly definite -- "THE largest cost", "ITS hardest part" --
 *      while the -est nouns above take an article of their own ("A request").
 *   2. The word is not on the exception list below.
 *
 * Guard 1 alone still admits "the request"; guard 2 alone still admits "sent
 * requests"; together they are tight.
 */
const SUPERLATIVE_PATTERN = /\b(?:the|its|our|their|his|her|your|my)\s+(\w{4,}est)\b/i;

/**
 * Words ending in -est that are not superlatives.
 *
 * A closed, auditable list, in keeping with the rest of this pass. It does not
 * have to be exhaustive: a word missing from it costs one sentence the wrong
 * register, which is a tuning imperfection rather than a fault.
 */
const NOT_SUPERLATIVES = new Set([
  'request', 'suggest', 'protest', 'harvest', 'interest', 'contest', 'digest',
  'invest', 'arrest', 'forest', 'earnest', 'manifest', 'conquest', 'tempest',
  'behest', 'incest', 'ingest', 'congest', 'attest', 'detest', 'divest',
  'molest', 'bequest', 'midwest', 'inquest', 'unrest', 'backrest', 'headrest',
  'armrest', 'footrest', 'everest', 'pretest', 'retest', 'reinvest',
  'disinterest', 'suggest', 'infest',
]);

/**
 * Does the sentence carry an inflected superlative used as a superlative?
 *
 * @param {string} sentence
 * @returns {boolean}
 */
function hasSuperlative(sentence) {
  const m = SUPERLATIVE_PATTERN.exec(String(sentence || ''));
  if (!m) return false;
  return !NOT_SUPERLATIVES.has(String(m[1]).toLowerCase());
}

/**
 * Words that carry no stress and can never be an emphasis target.
 *
 * Deliberately a closed list rather than a frequency heuristic: a closed list
 * is auditable and behaves identically on every reply, and this whole pass is
 * specified as "deterministic, lexical ... no ML model".
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does',
  'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours',
  'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'yourself', 'yourselves',
]);

/**
 * Strip punctuation from the edges of a token, leaving internal apostrophes and
 * hyphens ("don't", "cost-benefit") intact.
 *
 * @param {string} token
 * @returns {string}
 */
function bareWord(token) {
  return String(token).replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

/**
 * Split a string into whitespace-delimited tokens, dropping empties.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokens(text) {
  return String(text).split(/\s+/).filter(Boolean);
}

/**
 * Which register a sentence is written in.
 *
 * Precedence is CONTRAST, then DIRECT, then WRY, then neutral, and the order is
 * load-bearing rather than arbitrary:
 *
 *   - Contrast first because it is a STRUCTURAL claim about the sentence
 *     ("not X but Y") and it selects an emphasis target the other two would
 *     throw away. "Honestly, the real cost is not the licence but the audit"
 *     is a contrast sentence that happens to open with a directness marker;
 *     pacing it as merely direct loses the bracket around "audit", which is
 *     the thing the sentence is about.
 *   - Direct before wry because a directness marker is anchored at the START
 *     and is therefore a deliberate opening move, while several wry markers
 *     ("right", "of course") are common enough at the end of an ordinary
 *     sentence that they are the weaker signal.
 *
 * @param {string} sentence  One sentence, already trimmed.
 * @returns {string} A key of PROFILES.
 */
export function detectRegister(sentence) {
  const s = String(sentence || '').trim();
  if (!s) return 'neutral';

  if (CONTRAST_PATTERNS.some(re => re.test(s))) return 'contrast';
  if (hasSuperlative(s))                        return 'contrast';
  if (DIRECT_INITIAL.some(re => re.test(s)))    return 'direct';
  if (WRY_FINAL.some(re => re.test(s)))         return 'wry';
  return 'neutral';
}

/* ------------------------------------------------------------------------ *
 * Emphasis target selection (Section 4.3)
 * ------------------------------------------------------------------------ */

/**
 * The word a contrast sentence is actually about.
 *
 * Handled in the order the constructions carry weight:
 *
 *   "not X but Y"   -> Y. The sentence exists to assert Y.
 *   "the real X"    -> X.
 *   "rather than" / "instead of" -> the term BEFORE it, which is the one being
 *                      chosen; the term after is the one being rejected.
 *   superlative     -> the word the superlative modifies, or the superlative
 *                      itself when it ends the clause.
 *
 * @param {string} sentence
 * @returns {string|null} The bare target word, or null when none is found.
 */
export function contrastTerm(sentence) {
  const s = String(sentence || '');

  // "not X but Y" -> the first content word after "but".
  const notBut = /\bnot\b[^.!?]{1,80}?\bbut\b\s+(.{1,60})/i.exec(s);
  if (notBut) {
    const target = firstContentWord(notBut[1]);
    if (target) return target;
  }

  // "the real X" / "the actual X".
  const real = /\bthe (?:real|actual)\s+(.{1,40})/i.exec(s);
  if (real) {
    const target = firstContentWord(real[1]);
    if (target) return target;
  }

  // "X rather than Y" / "X instead of Y" -> the last content word before it.
  const chosen = /(.{1,80})\b(?:rather than|instead of)\b/i.exec(s);
  if (chosen) {
    const target = lastContentWord(chosen[1]);
    if (target) return target;
  }

  // "buried" is itself the marker the specification names.
  if (/\bburied\b/i.test(s)) return 'buried';

  // Analytic superlative ("the most expensive part"): prefer the noun it
  // modifies, falling back to the adjective when it ends the clause.
  const analytic = /\b((?:most|least)\s+\w{3,})\b\s*(\w+)?/i.exec(s);
  if (analytic) {
    const following = analytic[2] ? bareWord(analytic[2]) : '';
    if (following && !STOPWORDS.has(following.toLowerCase())) return following;
    const head = bareWord(String(analytic[1]).split(/\s+/).pop() || '');
    if (head) return head;
  }

  // Inflected superlative, using the same guarded test as detectRegister so
  // the two cannot disagree about what counts as one.
  const inflected = SUPERLATIVE_PATTERN.exec(s);
  if (inflected && !NOT_SUPERLATIVES.has(String(inflected[1]).toLowerCase())) {
    // The noun after "the largest" is the target; "largest" itself is only the
    // target when it ends the clause.
    const after = new RegExp(`${escapeRegExp(inflected[0])}\\s+(\\w+)`, 'i').exec(s);
    const following = after ? bareWord(after[1]) : '';
    if (following && !STOPWORDS.has(following.toLowerCase())) return following;
    return bareWord(inflected[1]);
  }

  return null;
}

/**
 * Escape a string for literal use inside a RegExp.
 *
 * The strings passed here come from the reply text, so they can contain any
 * character at all. Interpolating one unescaped would let ordinary punctuation
 * change the meaning of the pattern, and a reply containing "(" would throw.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first token in a fragment that is not a stopword.
 *
 * @param {string} fragment
 * @returns {string|null}
 */
function firstContentWord(fragment) {
  for (const token of tokens(fragment)) {
    const word = bareWord(token);
    if (word && !STOPWORDS.has(word.toLowerCase())) return word;
  }
  return null;
}

/**
 * The last token in a fragment that is not a stopword.
 *
 * @param {string} fragment
 * @returns {string|null}
 */
function lastContentWord(fragment) {
  const list = tokens(fragment);
  for (let i = list.length - 1; i >= 0; i--) {
    const word = bareWord(list[i]);
    if (word && !STOPWORDS.has(word.toLowerCase())) return word;
  }
  return null;
}

/**
 * The "key noun" of a direct declarative sentence (Section 5, emphasis target).
 *
 * HONEST ABOUT WHAT THIS IS. There is no part-of-speech tagger here and there
 * will not be one: Section 5 specifies a "deterministic, lexical pass ... no ML
 * model", and importing a tagger would also break N5 (no new dependencies).
 *
 * So this is an approximation with a stated rule, not a parser:
 *
 *   1. Discard the directness marker itself. "Honestly" is never the point of
 *      the sentence that opens with it.
 *   2. Discard stopwords and anything under four characters, which removes
 *      nearly all function words and most verb inflections that survived (1).
 *   3. Of what remains, take the LONGEST token, breaking ties by taking the
 *      LATER one.
 *
 * Rule 3 is doing the real work, and it is chosen because English content nouns
 * are on average longer than the verbs and adjectives around them, and because
 * the informational head of a declarative clause tends to land late. It is
 * right often enough to be worth having and it is wrong sometimes. Being wrong
 * costs an 80 ms bracket on a neighbouring word -- an imperfect stress, not a
 * defect -- which is the correct price for not inventing a parser.
 *
 * @param {string} sentence
 * @returns {string|null}
 */
export function keyNoun(sentence) {
  let s = String(sentence || '').trim();
  if (!s) return null;

  // Rule 1: strip a leading directness marker and any comma after it.
  for (const re of DIRECT_INITIAL) {
    const m = re.exec(s);
    if (m) { s = s.slice(m[0].length).replace(/^\s*[,:;-]\s*/, ''); break; }
  }

  let best = null;
  let bestLength = 0;
  for (const token of tokens(s)) {
    const word = bareWord(token);
    if (!word) continue;
    if (word.length < 4) continue;                       // Rule 2
    if (STOPWORDS.has(word.toLowerCase())) continue;     // Rule 2
    if (word.length >= bestLength) {                     // Rule 3, >= keeps the later one
      best = word;
      bestLength = word.length;
    }
  }
  return best;
}

/**
 * The emphasis target for a sentence, given its register.
 *
 * @param {string} sentence
 * @param {string} profileKey A key of PROFILES.
 * @returns {string|null}
 */
export function emphasisTarget(sentence, profileKey) {
  const profile = PROFILES[profileKey] || PROFILES.neutral;
  if ('key_noun' === profile.emphasis)      return keyNoun(sentence);
  if ('contrast_term' === profile.emphasis) return contrastTerm(sentence);
  return null;   // wry is deadpan by specification; neutral has no target.
}

/* ------------------------------------------------------------------------ *
 * Segmentation (Section 4.1)
 * ------------------------------------------------------------------------ */

/**
 * Abbreviations that end in a full stop without ending a sentence.
 *
 * Without this list, "Approx. 40% of the cost" becomes two sentences and picks
 * up a 250 ms pause in the middle of a noun phrase, which is audible and wrong.
 * Kept short and common rather than exhaustive: a missed abbreviation costs one
 * over-long pause, and a list nobody maintains costs more than it saves.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'inc', 'ltd', 'pty', 'co',
  'al', 'ie', 'eg',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec',
]);

/**
 * Abbreviations that are ALSO ordinary words, and so only count as
 * abbreviations when a number follows.
 *
 * "no" is the one that matters and it was a real defect: with "no" in the
 * always-suppress list above, the perfectly ordinary sentence
 *
 *     He said "no". Then he left.
 *
 * never ended, because the word before the stop is "no" once the closing quote
 * is trimmed. The whole reply was then synthesised as one phrase with no
 * sentence pause anywhere in it.
 *
 * "No. 5" is an abbreviation; "the answer is no." is not, and the only reliable
 * difference is what comes next.
 */
const NUMERIC_ABBREVIATIONS = new Set(['no', 'p', 'pp', 'fig', 'vol', 'ch', 'sec', 'para']);

/**
 * Split text into paragraphs on blank lines.
 *
 * A single newline is NOT a paragraph break. Assistant replies wrap mid-thought
 * and use single newlines for list items, and giving each of those the 450 ms
 * paragraph pause would make a bulleted list sound like a eulogy.
 *
 * @param {string} text
 * @returns {string[]} Non-empty paragraphs, trimmed.
 */
export function splitParagraphs(text) {
  return String(text || '')
    .split(/\r?\n[ \t]*\r?\n+/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Split a paragraph into sentences on terminal punctuation.
 *
 * The scan is character-by-character rather than a regex split because the
 * abbreviation guard needs to look BACKWARDS from the full stop at the word
 * that precedes it, and a split cannot do that.
 *
 * A terminal mark ends a sentence when:
 *   - it is ? or !, which are never abbreviation marks; or
 *   - it is a full stop, the preceding word is not a known abbreviation, and
 *     the preceding word is not a single capital letter (an initial: "J. Smith").
 * and in both cases the next non-space character is not a lowercase letter,
 * which catches the decimal and version cases ("3.5", "v1.2") that survive the
 * word test.
 *
 * @param {string} paragraph
 * @returns {string[]} Non-empty sentences, trimmed.
 */
export function splitSentences(paragraph) {
  const text = String(paragraph || '').trim();
  if (!text) return [];

  const out = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('.' !== ch && '!' !== ch && '?' !== ch) continue;

    // Absorb a run of terminal marks and any closing quote or bracket, so
    // '..."' or '?!' ends one sentence rather than several empty ones.
    let end = i;
    while (end + 1 < text.length && /[.!?]/.test(text[end + 1])) end++;
    while (end + 1 < text.length && /["'\u2019\u201d)\]]/.test(text[end + 1])) end++;

    const rest = text.slice(end + 1);
    // Must be followed by end-of-text or whitespace. "3.5" and "e.g.something"
    // fail here without needing the word test at all.
    if (rest && !/^\s/.test(rest)) continue;
    // A lowercase continuation after the space means the mark was not terminal
    // ("etc. and then"), whatever the word before it was.
    if (/^\s+[a-z]/.test(rest)) continue;

    if ('.' === ch) {
      const before = text.slice(start, i);
      const lastWord = bareWord(tokens(before).pop() || '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord)) continue;
      // Ambiguous abbreviation: only when a number follows ("No. 5"), never
      // when it is the ordinary word ('He said "no". Then...').
      if (NUMERIC_ABBREVIATIONS.has(lastWord) && /^\s+\d/.test(rest)) continue;
      // A single letter before the stop is an initial, not a sentence end.
      if (1 === lastWord.length && /[a-z]/i.test(lastWord)) continue;
    }

    const sentence = text.slice(start, end + 1).trim();
    if (sentence) out.push(sentence);
    start = end + 1;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Dwell points inside a sentence (Section 4.1).
 *
 * Two kinds, and they break in opposite places:
 *
 *   AFTER a comma, semicolon, colon or dash -- the punctuation belongs to the
 *   phrase it closes, and the breath comes after it.
 *
 *   BEFORE a rhetorically weighted conjunction -- "but", "and", "which",
 *   "because". The breath comes before the word, which is what gives "and" its
 *   lift. A conjunction that is already preceded by a comma does not earn a
 *   second break; the comma has it.
 *
 * "and" is included because Section 4.1 names it, and it is the riskiest of the
 * four: it is the commonest word in English and breaking at every one would
 * chop the reply into confetti. So it only counts when it joins two clauses of
 * some length, which is what the minimum-length guard below enforces.
 *
 * @param {string} sentence
 * @returns {string[]} Phrases, in order, each non-empty and trimmed.
 */
export function splitDwellPoints(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return [];

  /* TWO THRESHOLDS, NOT ONE, AND THE DIFFERENCE IS DELIBERATE.
   *
   * A comma is the AUTHOR'S OWN mark for a breath, so respecting it is the
   * whole point of Section 4.1 and it earns a low bar: two words either side.
   * With a single bar of three, "Second point, which nobody expected, arrived
   * late." came out as one undifferentiated phrase, because the head and the
   * tail are each two words -- and that sentence is the exact shape the dwell
   * tier exists for.
   *
   * A conjunction is only INFERRED to be a dwell point, and "and" is the
   * commonest word in the language, so it earns a high bar: three words either
   * side. That is the smallest value at which "You and I agreed." survives
   * whole. */
  const MIN_WORDS_PUNCTUATION = 2;
  const MIN_WORDS_CONJUNCTION = 3;

  const parts = [];
  let cursor = 0;

  const wordsBetween = (from, to) => tokens(text.slice(from, to)).length;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // --- break AFTER punctuation ---
    if (',' === ch || ';' === ch || ':' === ch || '\u2014' === ch || '\u2013' === ch) {
      // A dash needs surrounding space to be a dwell point; "cost-benefit" and
      // "2019-2024" must not split.
      if (('\u2014' === ch || '\u2013' === ch)
          && !(/\s/.test(text[i - 1] || ' ') && /\s/.test(text[i + 1] || ' '))) continue;

      const cut = i + 1;
      if (wordsBetween(cursor, cut) < MIN_WORDS_PUNCTUATION) continue;
      if (wordsBetween(cut, text.length) < MIN_WORDS_PUNCTUATION) continue;
      const piece = text.slice(cursor, cut).trim();
      if (piece) { parts.push(piece); cursor = cut; }
      continue;
    }

    // --- break BEFORE a weighted conjunction ---
    // Only at a word boundary, and only when a space precedes it.
    if (i > 0 && /\s/.test(text[i - 1])) {
      const ahead = text.slice(i);
      const m = /^(but|and|which|because|yet|so that|although|though|while)\b/i.exec(ahead);
      if (m) {
        // The comma already gave this conjunction its breath.
        const priorPart = parts.length ? parts[parts.length - 1] : '';
        const sinceCursor = text.slice(cursor, i).trim();
        if (!sinceCursor && /[,;:]$/.test(priorPart)) continue;

        if (wordsBetween(cursor, i) < MIN_WORDS_CONJUNCTION) continue;
        if (wordsBetween(i, text.length) < MIN_WORDS_CONJUNCTION) continue;
        const piece = text.slice(cursor, i).trim();
        if (piece) { parts.push(piece); cursor = i; }
      }
    }
  }

  const tail = text.slice(cursor).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [text];
}

/**
 * Force a break before the final clause of a wry sentence.
 *
 * WHY THIS EXISTS AS A SEPARATE PASS.
 *
 * Section 5 requires a wry sentence to get a "beat before final clause", and
 * AC1 makes that a shipping condition. But the punchline of an understated
 * sentence is usually SHORT -- "..., right", "..., of course" -- and
 * splitDwellPoints deliberately refuses to break off a fragment of fewer than
 * three words, because doing that generally is how a reply turns into confetti.
 *
 * So the general rule stays strict and the wry case gets an explicit exception,
 * applied only to sentences the register detector has already classified as
 * wry. Without this, AC1 is unsatisfiable for exactly the sentences it names:
 * the beat has nowhere to go, because there is no boundary to put it at.
 *
 * The break is placed at the last comma when there is one, and otherwise
 * immediately before the matched wry marker.
 *
 * @param {string} sentence A sentence already classified 'wry'.
 * @returns {string[]} Two phrases, or one when no final clause can be isolated.
 */
export function splitWryFinalClause(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return [];

  // Preferred: the last comma. It is the author's own mark for the beat.
  const comma = text.lastIndexOf(',');
  if (comma > 0 && comma < text.length - 1) {
    const head = text.slice(0, comma + 1).trim();
    const tail = text.slice(comma + 1).trim();
    if (head && tail) return [head, tail];
  }

  // Otherwise, immediately before the wry marker itself.
  for (const re of WRY_FINAL) {
    const m = re.exec(text);
    if (!m || m.index <= 0) continue;
    const head = text.slice(0, m.index).trim();
    const tail = text.slice(m.index).trim();
    // A head of one or two words is not a clause; leaving the sentence whole
    // is better than pausing after its first word.
    if (head && tail && tokens(head).length >= 3) return [head, tail];
  }

  return [text];
}

/**
 * Split a phrase around an emphasis target so the target is its own unit
 * (Section 4.3, third cue).
 *
 * Only when the target is genuinely MID-phrase. A target that is already the
 * first or last word is bracketed by the phrase boundary itself, and cutting
 * there would produce a one-word segment beside an empty one.
 *
 * @param {string} phrase
 * @param {string|null} target Bare target word.
 * @returns {{before: string, target: string, after: string}|null}
 *          null when no mid-phrase split applies.
 */
export function splitAroundEmphasis(phrase, target) {
  if (!target) return null;
  const list = tokens(phrase);
  if (list.length < 3) return null;

  const wanted = String(target).toLowerCase();
  // Search the interior only: index 0 and the last index are already edges.
  for (let i = 1; i < list.length - 1; i++) {
    if (bareWord(list[i]).toLowerCase() !== wanted) continue;
    const before = list.slice(0, i).join(' ').trim();
    const middle = list[i].trim();
    const after  = list.slice(i + 1).join(' ').trim();
    if (!before || !middle || !after) return null;
    return { before, target: middle, after };
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The transform (Sections 4 and 5 together)
 * ------------------------------------------------------------------------ */

/**
 * @typedef {object} ProsodyPhrase
 * @property {string}  text              The words to hand to the synthesiser.
 * @property {number}  lengthScale       Absolute Piper --length_scale for this phrase.
 * @property {number}  lengthScaleMultiplier Relative to the voice base (Section 4.2).
 * @property {number}  pauseAfterMs      Silence to insert AFTER this phrase.
 * @property {string}  profile           Register profile key.
 * @property {string|null} emphasisTarget The stress target of the parent sentence.
 * @property {boolean} isEmphasis        True when this phrase IS the target word.
 * @property {number}  sentenceIndex     Zero-based, across the whole reply.
 * @property {number}  paragraphIndex    Zero-based.
 * @property {string}  boundary          Why the pause after it has the size it has.
 */

/**
 * Transform reply text into an ordered list of annotated phrases.
 *
 * This is the function AC7 is about, and it is the whole layer: everything the
 * synthesiser needs is in the return value, and nothing in the return value
 * required a synthesiser to compute.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.baseLengthScale=1] The ACTIVE VOICE's own default
 *        length_scale, from its .onnx.json `inference.length_scale` (Section
 *        4.2: "the active voice's default length_scale is the multiplier
 *        base"). Passed in rather than read here, because reading a voice file
 *        would make this module voice-aware and stop it being a pure transform.
 * @param {number} [opts.speed=1] The user's speed preference. Applied as a
 *        DIVISOR, matching the flat path's `--length_scale 1/speed`, so the
 *        panel's speed control keeps working identically with prosody on.
 * @param {object} [opts.config] A prosodyConfig() result; read from the
 *        environment when omitted.
 * @returns {{phrases: ProsodyPhrase[], sentences: Array<{text: string, profile: string, emphasisTarget: string|null}>, config: object, baseLengthScale: number}}
 */
export function analyse(text, opts) {
  const o = opts || {};
  const cfg = o.config || prosodyConfig();
  const base = Number.isFinite(o.baseLengthScale) && o.baseLengthScale > 0
    ? o.baseLengthScale : 1;
  const speed = Number.isFinite(o.speed) && o.speed > 0 ? o.speed : 1;

  const paragraphs = splitParagraphs(text);
  /** @type {ProsodyPhrase[]} */
  const phrases = [];
  const sentences = [];

  let sentenceIndex = 0;

  for (let p = 0; p < paragraphs.length; p++) {
    const isLastParagraph = p === paragraphs.length - 1;
    const sentenceList = splitSentences(paragraphs[p]);

    for (let s = 0; s < sentenceList.length; s++) {
      const sentence = sentenceList[s];
      const isLastSentence = s === sentenceList.length - 1;

      const profileKey = detectRegister(sentence);
      const profile = PROFILES[profileKey];
      const target = emphasisTarget(sentence, profileKey);
      const multiplier = cfg[profile.rateKey];

      sentences.push({ text: sentence, profile: profileKey, emphasisTarget: target });

      let rawPhrases = splitDwellPoints(sentence);
      // Section 5 / AC1. A wry sentence must have a final clause to put the
      // beat before, and the general dwell rule will not carve out a two-word
      // punchline. See splitWryFinalClause.
      if ('wry' === profileKey && 1 === rawPhrases.length) {
        rawPhrases = splitWryFinalClause(sentence);
      }
      const units = [];

      for (let f = 0; f < rawPhrases.length; f++) {
        const phrase = rawPhrases[f];
        const isLastPhrase = f === rawPhrases.length - 1;

        // Section 4.3, third cue: hoist a mid-phrase target into its own unit.
        const split = splitAroundEmphasis(phrase, target);
        if (split) {
          units.push({ text: split.before, boundary: 'emphasis', isEmphasis: false,
                       lastOfSentence: false });
          units.push({ text: split.target, boundary: 'emphasis', isEmphasis: true,
                       lastOfSentence: false });
          units.push({ text: split.after, boundary: isLastPhrase ? 'sentence' : 'dwell',
                       isEmphasis: false, lastOfSentence: isLastPhrase });
          continue;
        }

        units.push({
          text: phrase,
          boundary: isLastPhrase ? 'sentence' : 'dwell',
          // The target sitting alone as a whole phrase still earns the rate dip.
          isEmphasis: !!target && bareWord(phrase).toLowerCase() === String(target).toLowerCase(),
          lastOfSentence: isLastPhrase,
        });
      }

      // Merge fragments too short to synthesise on their own (see
      // minPhraseChars). Merging BACKWARDS keeps the boundary metadata of the
      // fragment, which is the one that describes what follows it.
      const merged = [];
      for (const unit of units) {
        const bare = unit.text.replace(/[^\p{L}\p{N}]/gu, '');
        if (bare.length < cfg.minPhraseChars && merged.length) {
          const prev = merged[merged.length - 1];
          prev.text = `${prev.text} ${unit.text}`.trim();
          prev.boundary = unit.boundary;
          prev.lastOfSentence = unit.lastOfSentence;
          prev.isEmphasis = prev.isEmphasis || unit.isEmphasis;
          continue;
        }
        merged.push(unit);
      }
      if (!merged.length) continue;

      for (let u = 0; u < merged.length; u++) {
        const unit = merged[u];
        const last = u === merged.length - 1;

        // ---- pace ----
        // Section 4.2: the profile multiplier applies against the VOICE's base.
        // Section 4.3: the phrase carrying the stress dips in rate, which is a
        // RISE in length_scale.
        let phraseMultiplier = multiplier;
        if (unit.isEmphasis) phraseMultiplier *= cfg.emphasisDip;

        // ---- pause ----
        let pause;
        let boundary;
        if (last && isLastSentence && isLastParagraph) {
          // Nothing follows the reply. A trailing pause is dead air.
          pause = 0;
          boundary = 'end';
        } else if (last && isLastSentence) {
          pause = cfg.pauseParagraphMs;
          boundary = 'paragraph';
        } else if (last) {
          pause = cfg.pauseSentenceMs;
          boundary = 'sentence';
        } else if ('emphasis' === unit.boundary) {
          pause = cfg.pauseEmphasisMs;
          boundary = 'emphasis';
        } else {
          pause = cfg.pauseDwellMs;
          boundary = 'dwell';
        }

        // Section 5, wry: "beat before final clause". Added to the pause
        // BEFORE the last unit of a wry sentence, which is the unit that
        // carries the understatement.
        const nextIsFinalClause = (u === merged.length - 2);
        if ('wry' === profileKey && nextIsFinalClause && merged.length > 1) {
          pause += cfg.wryBeatMs;
        }

        phrases.push({
          text: unit.text,
          lengthScaleMultiplier: round4(phraseMultiplier),
          // The absolute value handed to Piper. Divided by speed so the user's
          // speed control composes with the register rather than fighting it.
          lengthScale: round4((base * phraseMultiplier) / speed),
          pauseAfterMs: pause,
          profile: profileKey,
          emphasisTarget: target,
          isEmphasis: !!unit.isEmphasis,
          sentenceIndex,
          paragraphIndex: p,
          boundary,
        });
      }

      sentenceIndex++;
    }
  }

  return {
    phrases: capPhrases(phrases, cfg.maxPhrases),
    sentences,
    config: cfg,
    baseLengthScale: base,
  };
}

/**
 * Hold the phrase count under the ceiling by MERGING the tail, never by
 * truncating it.
 *
 * Truncating would drop the end of the reply, which is a silent data loss the
 * user experiences as the assistant trailing off. Merging costs some prosody in
 * the tail of a pathologically long reply, which is a cost worth paying and one
 * nobody will notice.
 *
 * The merged phrases inherit the pace of the FIRST phrase in the group. The
 * alternative -- averaging -- would produce a length_scale no profile ever
 * asked for.
 *
 * @param {ProsodyPhrase[]} phrases
 * @param {number} max
 * @returns {ProsodyPhrase[]}
 */
function capPhrases(phrases, max) {
  if (phrases.length <= max) return phrases;

  const groupSize = Math.ceil(phrases.length / max);
  const out = [];
  for (let i = 0; i < phrases.length; i += groupSize) {
    const group = phrases.slice(i, i + groupSize);
    const head = group[0];
    const tail = group[group.length - 1];
    out.push({
      ...head,
      text: group.map(g => g.text).join(' '),
      // The pause that matters is the one after the LAST phrase absorbed.
      pauseAfterMs: tail.pauseAfterMs,
      boundary: tail.boundary,
      // A merged run is no longer a single stressed word.
      isEmphasis: false,
    });
  }
  return out;
}

/**
 * Round to four decimal places.
 *
 * Piper takes length_scale as a command-line string, and an unrounded product
 * of two floats serialises as "1.0092000000000002". That is not wrong, but it
 * makes every log line and every test assertion needlessly fragile.
 *
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * A short, stable identifier for a piece of reply text.
 *
 * Section 7.2: "'both' returns two audio URLs, flat and layered, tagged with a
 * shared reply hash so the UI can pair them." This is that hash.
 *
 * It is FNV-1a, not a cryptographic digest, and that is deliberate: it is a
 * pairing token with no security meaning, and reaching for node:crypto here
 * would import a module into a file whose entire value is that it imports
 * nothing. Collisions are irrelevant -- the two halves of one response are
 * compared with each other, never looked up in a table.
 *
 * @param {string} text
 * @returns {string} Eight lowercase hex characters.
 */
export function replyHash(text) {
  const s = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    // The FNV prime, 16777619, via shifts so the value stays in 32 bits.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A compact, log-safe summary of an analysis.
 *
 * Counts and profile names only. NEVER the phrase text: Section 10 forbids
 * logging the words being spoken, and an "annotation" that carries the reply
 * verbatim is the reply.
 *
 * @param {{phrases: ProsodyPhrase[]}} analysis
 * @returns {{phrases: number, profiles: object, total_pause_ms: number}}
 */
export function summarise(analysis) {
  const phrases = (analysis && analysis.phrases) || [];
  const profiles = {};
  let totalPause = 0;
  for (const phrase of phrases) {
    profiles[phrase.profile] = (profiles[phrase.profile] || 0) + 1;
    totalPause += phrase.pauseAfterMs;
  }
  return { phrases: phrases.length, profiles, total_pause_ms: totalPause };
}

export default {
  PROSODY_DEFAULTS, PROFILES,
  prosodyEnabled, prosodyConfig,
  detectRegister, keyNoun, contrastTerm, emphasisTarget,
  splitParagraphs, splitSentences, splitDwellPoints, splitAroundEmphasis,
  splitWryFinalClause,
  analyse, replyHash, summarise,
};
