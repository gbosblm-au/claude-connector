// src/voice/heteronym-lexicon.js
//
// SPEC-HET-002 §7 and §8 item 2. The Class A table, as data.
//
// ===========================================================================
// WHY THE DATA IS A SEPARATE FILE
// ===========================================================================
//
// §8 asks for it so rules and data stay apart and an operator can inspect or
// extend entries without touching logic. That matters more than usual here:
// every judgement in this table is an ear judgement, and the person best placed
// to correct one is not necessarily the person who should be editing a regex.
//
// ===========================================================================
// WHAT AN ENTRY MEANS
// ===========================================================================
//
//   word        the surface form, lower case. Matching is case-insensitive and
//               word-boundary anchored, so "reader" and "leadership" are never
//               touched.
//   strategy    'A' rewrites to a homophone before phonemisation. 'B' emits a
//               misaki [word](/ipa/) override and is inert on espeak.
//   respell     the homophone, for strategy A.
//   ipa         the intended-sense phonemes, for strategy B.
//   when        the contexts that select the NON-default sense. A word not
//               matching any of them is left alone (§11 item 11): the engine's
//               own dictionary is right for the common sense, and silence is
//               the correct output of a rule that does not apply.
//   confidence  'high' ships enabled. 'low' ships DISABLED (§7, AC6) and needs
//               an ear test before it is turned on.
//
// ===========================================================================
// A NOTE ON THE DEFAULT SENSE
// ===========================================================================
//
// Every rule here fires on the MINORITY sense. "read" is present-tense far more
// often than past; "lead" is the verb far more often than the metal. So a rule
// that never fires leaves the common case to the engine, which already handles
// it. That asymmetry is why a missed match costs nothing and a false match
// costs a wrong word: the rules are written to be narrow rather than complete.

/**
 * Past-tense and participle markers that select the /rɛd/ sense of "read".
 *
 * Deliberately not "any past-tense verb nearby" -- with no POS tagger that is
 * unknowable, and guessing would mispronounce every present-tense sentence
 * that happens to contain a past-tense word elsewhere.
 */
const PAST_MARKERS = [
  'have', 'has', 'had', "i've", "you've", "we've", "they've", "he's", "she's",
  'yesterday', 'already', 'just', 'never', 'ever', 'recently', 'once',
  'last night', 'last week', 'last month', 'last year', 'earlier',
];

export const CLASS_A = [
  {
    word: 'read',
    strategy: 'A',
    respell: 'red',
    senses: { default: '/riːd/ present', resolved: '/rɛd/ past' },
    // "have read", "read it yesterday", "already read".
    when: [
      { before: PAST_MARKERS, within: 3 },
      { after: [ 'yesterday', 'last night', 'last week', 'earlier', 'already' ], within: 4 },
    ],
    confidence: 'high',
  },
  {
    word: 'lead',
    strategy: 'A',
    respell: 'led',
    senses: { default: '/liːd/ to guide', resolved: '/lɛd/ the metal' },
    // The metal is a material noun: "lead pipe", "lead paint", "made of lead".
    when: [
      { after: [ 'pipe', 'pipes', 'paint', 'poisoning', 'shot', 'weight',
                 'weights', 'bullet', 'bullets', 'solder' ], within: 1 },
      { before: [ 'of', 'molten', 'heavy' ], within: 1 },
    ],
    confidence: 'high',
  },
  {
    word: 'bass',
    strategy: 'A',
    respell: 'base',
    senses: { default: '/bæs/ the fish', resolved: '/beɪs/ the instrument' },
    // NOTE the direction. The spec's table lists /beɪs/ as sense A and the fish
    // as sense B, but in running text the instrument is far commoner than the
    // fish, and espeak already says /beɪs/ for the bare word. So the rule fires
    // on musical context only, and leaves everything else to the engine --
    // which means a sentence about fishing keeps whatever the engine does now,
    // rather than being actively made wrong.
    when: [
      { after: [ 'guitar', 'guitars', 'player', 'line', 'lines', 'drum',
                 'clef', 'notes', 'amp' ], within: 1 },
      { before: [ 'play', 'plays', 'playing', 'played', 'electric', 'upright',
                  'double' ], within: 2 },
    ],
    confidence: 'high',
  },
  {
    word: 'sow',
    strategy: 'A',
    respell: 'sew',
    senses: { default: '/saʊ/ female pig', resolved: '/soʊ/ to plant' },
    // Hmm: "sew" is itself /soʊ/, which is what we want, and it is not a
    // heteronym. The verb sense is overwhelmingly the commoner one in prose.
    when: [
      { after: [ 'seeds', 'seed', 'the', 'crops', 'wheat', 'grain' ], within: 2 },
      { before: [ 'to', 'will', 'shall', 'we', 'they', 'and' ], within: 1 },
    ],
    confidence: 'high',
  },
  {
    word: 'tear',
    strategy: 'B',
    ipa: 'tˈɛr',
    senses: { default: '/tɪr/ from crying', resolved: '/tɛr/ to rip' },
    when: [ { after: [ 'up', 'apart', 'down', 'off', 'through', 'into', 'at' ], within: 1 } ],
    confidence: 'medium',
  },
  {
    word: 'live',
    strategy: 'B',
    ipa: 'lˈaɪv',
    senses: { default: '/lɪv/ the verb', resolved: '/laɪv/ adjective' },
    when: [
      { after: [ 'broadcast', 'stream', 'show', 'music', 'performance',
                 'audience', 'coverage', 'television', 'tv', 'radio' ], within: 1 },
      { before: [ 'a', 'the', 'watching', 'watch' ], within: 1, andAfter: true },
    ],
    confidence: 'medium',
  },
  {
    word: 'wind',
    strategy: 'B',
    ipa: 'wˈaɪnd',
    senses: { default: '/wɪnd/ moving air', resolved: '/waɪnd/ to coil' },
    when: [
      { after: [ 'up', 'down', 'the clock', 'back' ], within: 1 },
      { before: [ 'to', 'will', 'must', 'should' ], within: 1 },
    ],
    confidence: 'medium',
  },
  {
    word: 'wound',
    strategy: 'B',
    ipa: 'wˈaʊnd',
    senses: { default: '/wuːnd/ an injury', resolved: '/waʊnd/ coiled' },
    when: [ { after: [ 'around', 'tight', 'tightly', 'up', 'back' ], within: 1 } ],
    confidence: 'medium',
  },
  {
    word: 'dove',
    strategy: 'B',
    ipa: 'dˈoʊv',
    senses: { default: '/dʌv/ the bird', resolved: '/doʊv/ past of dive' },
    when: [ { after: [ 'into', 'in', 'under', 'off', 'down', 'straight' ], within: 1 } ],
    confidence: 'medium',
  },
  {
    word: 'row',
    strategy: 'B',
    ipa: 'rˈaʊ',
    senses: { default: '/roʊ/ a line', resolved: '/raʊ/ an argument' },
    when: [ { before: [ 'a', 'had', 'having', 'the' ], within: 1,
              after: [ 'about', 'over', 'with' ], within2: 3 } ],
    confidence: 'medium',
  },
  {
    word: 'close',
    strategy: 'B',
    ipa: 'klˈoʊs',
    senses: { default: '/kloʊz/ the verb', resolved: '/kloʊs/ near' },
    when: [ { after: [ 'to', 'by', 'enough', 'friend', 'friends', 'call' ], within: 1 } ],
    confidence: 'medium',
  },
  {
    word: 'minute',
    strategy: 'B',
    ipa: 'maɪnˈjuːt',
    senses: { default: '/ˈmɪnɪt/ the time', resolved: '/maɪˈnjuːt/ tiny' },
    when: [ { after: [ 'detail', 'details', 'amount', 'amounts', 'quantity',
                       'differences', 'variations' ], within: 1 } ],
    // §7 marks this low. "a minute detail" is real but rare, and the time sense
    // is extremely common -- a false fire is very audible.
    confidence: 'low',
  },
  {
    word: 'bow',
    strategy: 'B',
    ipa: 'bˈoʊ',
    senses: { default: '/baʊ/ to bend', resolved: '/boʊ/ weapon or knot' },
    when: [ { after: [ 'and arrow', 'tie', 'ties' ], within: 2 },
            { before: [ 'violin', 'cello', 'longbow' ], within: 1 } ],
    confidence: 'low',
  },
  {
    word: 'moped',
    strategy: 'A',
    respell: 'moapt',
    senses: { default: '/ˈmoʊpɛd/ the scooter', resolved: '/moʊpt/ past of mope' },
    when: [ { after: [ 'around', 'about', 'for' ], within: 1 } ],
    // §7 marks the respelling risky and it is: "moapt" is not a word, and what
    // espeak makes of it is a guess. Ships disabled.
    confidence: 'low',
  },
  {
    word: 'does',
    strategy: 'B',
    ipa: 'dˈoʊz',
    senses: { default: '/dʌz/ the verb', resolved: '/doʊz/ female deer' },
    // §7 says default. The deer sense is vanishingly rare and the verb is one
    // of the commonest words in English; any rule here risks far more than it
    // could win. Present so the table is complete and the reasoning recorded.
    when: [ { after: [ 'and fawns', 'and stags' ], within: 2 } ],
    confidence: 'low',
  },
];

export default { CLASS_A };
