// src/tools/personalChef.js  v12.40.0
// ---------------------------------------------------------------------------
// Tenax UI Tools bridge: Personal Chef and My Weight Loss Coach.
//
//   personal_chef_find    Hand the UI intake to the recipe-scout modules.
//   weight_loss_adapt     Hand the weekly adaptation inputs to the same.
//
// ── These tools are deliberately thin ──────────────────────────────────────
//
// The recipe-scout engine is ALREADY DEPLOYED on the Railway volume as two
// dispatcher modules:
//
//   /data/skill/ava/modules/recipe-scout/recipe-scout-core.md    Phases 0-6
//   /data/skill/ava/modules/recipe-scout/recipe-scout-output.md  Phase 7
//
// MANIFEST.json marks recipe-scout-output as `mandatory_for: ["recipe_request"]`
// and co-loads recipe-scout-core, so both are already in context whenever the
// dispatcher classifies a turn as a recipe request. The protocol, the Phase 3
// ranking weights, the specialist-equipment rule, the output card format, the
// reference-file index and the script index all live there and are maintained
// there.
//
// An earlier draft of this file restated all of that in a large "research
// brief": the weights, the equipment list, the output schema, the blocklist
// rule. Every one of those was a second copy of something the modules already
// say, and a second copy is strictly worse than none -- it cannot be better
// than the original, and it goes stale silently the moment a module is edited.
//
// So these tools supply ONLY the four things the modules cannot know, because
// they live outside the model's context:
//
//   1. The UI intake. The form has already asked Phase 0's questions, so the
//      assistant must not ask them again.
//   2. The blocklist from Postgres. Module Phase 6.2 says to build this by
//      reading recipe_history.csv; under spec 8 Postgres is authoritative, and
//      the gateway has already computed it.
//   3. The browser-resolved location, which is better than the locale guess
//      Phase 1 would otherwise fall back to.
//   4. Where the result must be persisted, which has moved from CSV to
//      Postgres.
//
// Everything else is a pointer: "you already have the protocol, use it."
// ---------------------------------------------------------------------------

import { log } from '../utils/logger.js';

// Canonical module ids, as they appear in MANIFEST.json. Named rather than
// pasted so the assistant loads the deployed copy, whatever version it is at.
export const RECIPE_SCOUT_MODULES = Object.freeze( [
  'recipe-scout-core',
  'recipe-scout-output',
] );

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a multi-select-plus-free-text field into a clean string list.
 * Accepts an array, a comma-separated string, or null.
 * @param {*} v
 * @returns {string[]}
 */
export function toStringList( v ) {
  if ( v == null ) return [];
  const raw = Array.isArray( v ) ? v : String( v ).split( ',' );
  const seen = new Set();
  const out = [];
  for ( const item of raw ) {
    const s = String( item == null ? '' : item ).trim();
    if ( ! s ) continue;
    const k = s.toLowerCase();
    if ( seen.has( k ) ) continue;
    seen.add( k );
    out.push( s );
    if ( out.length >= 60 ) break;
  }
  return out;
}

/** @param {*} v @param {number} lo @param {number} hi @param {number} d @returns {number} */
function clampInt( v, lo, hi, d ) {
  const n = Number( v );
  if ( ! Number.isFinite( n ) ) return d;
  return Math.max( lo, Math.min( hi, Math.round( n ) ) );
}

// ---------------------------------------------------------------------------
// Location  (spec 8)
// ---------------------------------------------------------------------------

/**
 * Country names for the locales the platform actually sees.
 *
 * Deliberately short. This exists only to turn a browser locale into something
 * Phase 1 can use; the module's retailers.md reference is what actually knows
 * about supermarkets. A 200-entry table here would be mostly untested guesses.
 */
const LOCALE_COUNTRY = {
  AU: 'Australia', NZ: 'New Zealand', GB: 'United Kingdom', UK: 'United Kingdom',
  US: 'United States', CA: 'Canada', IE: 'Ireland', ZA: 'South Africa',
  IN: 'India', SG: 'Singapore', MY: 'Malaysia', HK: 'Hong Kong',
  FR: 'France', DE: 'Germany', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
  JP: 'Japan', CN: 'China', KR: 'South Korea', AE: 'United Arab Emirates',
};

/**
 * Resolve the user's location for Phase 1.
 *
 * Spec 8: the UI passes a resolved location, and the module's own locale-based
 * resolution is the fallback when it is absent, so the tool still works from
 * chat with no location input at all.
 *
 * An unresolvable location is reported as unresolved rather than defaulted to a
 * country. Phase 1 can then ask, which is better than a shopping list naming
 * Australian supermarkets to someone in Toronto.
 *
 * @param {string} location Free text, e.g. "Melbourne, Australia".
 * @param {string} locale   BCP-47 tag, e.g. "en-AU".
 * @returns {{user_city: string, user_country: string, resolved_from: string}}
 */
export function resolveLocation( location, locale ) {
  const loc = String( location || '' ).trim();

  if ( loc ) {
    const parts = loc.split( ',' ).map( p => p.trim() ).filter( Boolean );
    if ( parts.length >= 2 ) {
      return { user_city: parts[ 0 ], user_country: parts[ parts.length - 1 ], resolved_from: 'ui' };
    }
    // A bare "Australia" is a country with no city, not a city called Australia.
    const known = Object.values( LOCALE_COUNTRY ).find(
      c => c.toLowerCase() === parts[ 0 ].toLowerCase() );
    return known
      ? { user_city: '', user_country: known, resolved_from: 'ui' }
      : { user_city: parts[ 0 ], user_country: '', resolved_from: 'ui' };
  }

  const region = /-([A-Za-z]{2})\b/.exec( String( locale || '' ).trim() );
  if ( region ) {
    const code = region[ 1 ].toUpperCase();
    if ( LOCALE_COUNTRY[ code ] ) {
      return { user_city: '', user_country: LOCALE_COUNTRY[ code ], resolved_from: 'locale' };
    }
  }

  return { user_city: '', user_country: '', resolved_from: 'unresolved' };
}

// ---------------------------------------------------------------------------
// Tool 1: personal_chef_find
// ---------------------------------------------------------------------------

export const personalChefFindToolDefinition = {
  name: 'personal_chef_find',
  description:
    'Start a Personal Chef recipe search from the Tenax UI intake form. ' +
    'Returns the completed Phase 0 intake, the ratings blocklist from Postgres, and the ' +
    'resolved location. ' +
    'Phase 0 is already answered by the form -- do not re-ask any of it. Load the ' +
    'recipe-scout modules and run the protocol from Phase 1 onward exactly as they specify. ' +
    'Call this once, at the start of a Personal Chef request.',
  inputSchema: {
    type: 'object',
    properties: {
      recipe_name: { type: 'string', description: 'The dish the user wants to cook. Required.' },
      serves: {
        type: 'number', minimum: 1, maximum: 20,
        description: 'Number of servings (1-20). Required.',
      },
      allergies: {
        type: 'array', items: { type: 'string' },
        description:
          'Allergies and foods to avoid, as hard exclusions. ' +
          'Send an empty array for none: an empty array means the user answered "none", ' +
          'whereas omitting the field means nobody asked, and those are different states.',
        default: [],
      },
      bottled_sauces_ok: {
        type: 'boolean',
        description: 'Whether shop-bought sauces and pastes are acceptable. Required.',
      },
      location: { type: 'string', description: 'e.g. "Melbourne, Australia".' },
      locale: { type: 'string', description: 'BCP-47 tag, e.g. "en-AU". Used only if location is absent.' },
      dietary_preferences: {
        type: 'array', items: { type: 'string' },
        description: 'e.g. ["low-carb"]. Matched against the dietary_preferences reference.',
        default: [],
      },
      blocklist: {
        type: 'array', items: { type: 'string' },
        description:
          'Dish names the user rated 1-4. Computed by the gateway from Postgres, which ' +
          'replaces the recipe_history.csv read described in module Phase 6.2.',
        default: [],
      },
      budget_preference: { type: 'string', description: 'e.g. "budget", "mid-range", "premium".' },
      prep_time_limit: { type: 'string', description: 'e.g. "30 minutes".' },
      preferred_retailers: {
        type: 'array', items: { type: 'string' },
        description: 'Retailers to list first, ahead of the retailers.md defaults.',
        default: [],
      },
    },
    required: [ 'recipe_name', 'serves' ],
  },
};

/**
 * @param {object} args
 * @returns {Promise<object>} MCP tool result.
 */
export async function handlePersonalChefFind( args ) {
  const a = args && typeof args === 'object' && ! Array.isArray( args ) ? args : {};

  const recipeName = String( a.recipe_name || '' ).trim();
  const errors = [];
  if ( ! recipeName ) errors.push( 'recipe_name is required.' );
  if ( recipeName.length > 200 ) errors.push( 'recipe_name is too long (200 characters maximum).' );

  const servesRaw = Number( a.serves );
  if ( ! Number.isFinite( servesRaw ) || servesRaw < 1 || servesRaw > 20 ) {
    errors.push( 'serves must be a whole number between 1 and 20.' );
  }
  // Spec 3.2 makes both of these required fields. The distinction between
  // "answered none" and "not asked" is the whole point: if the form did not
  // collect them, Phase 0 is not actually complete and the assistant must ask.
  if ( a.allergies === undefined ) {
    errors.push( 'allergies must be answered (send an empty array for none).' );
  }
  if ( a.bottled_sauces_ok === undefined || a.bottled_sauces_ok === null ) {
    errors.push( 'bottled_sauces_ok must be answered.' );
  }

  if ( errors.length ) {
    return {
      isError: true,
      content: [ { type: 'text', text: JSON.stringify(
        { error: 'invalid_intake', messages: errors }, null, 2 ) } ],
    };
  }

  const location = resolveLocation( a.location, a.locale );
  const blocklist = toStringList( a.blocklist );

  log( 'info', `[personal_chef_find] "${ recipeName }" serves=${ servesRaw } blocklist=${ blocklist.length }` );

  const payload = {
    task_class: 'recipe_request',
    mode: 'single-recipe',
    load_modules: RECIPE_SCOUT_MODULES,

    instruction:
      'Phase 0 is COMPLETE -- the Tenax intake form has already collected it. Do not re-ask ' +
      'any intake question. Load the recipe-scout modules and run the protocol from Phase 1 ' +
      'onward exactly as they specify, including the Phase 3 ranking weights and the Phase 4.1 ' +
      'specialist-equipment check. Produce the Phase 7.1 single-recipe output.',

    // Phase 0 answers, in the module's own field names.
    intake: {
      meal_name: recipeName,
      servings: clampInt( servesRaw, 1, 20, 1 ),
      foods_to_avoid: toStringList( a.allergies ),
      dietary_preferences: toStringList( a.dietary_preferences ),
      bottled_sauce_ok: a.bottled_sauces_ok ? 'yes' : 'no',
      budget_friendly: /budget|cheap/i.test( String( a.budget_preference || '' ) ) ? 'yes' : '',
      budget_preference: String( a.budget_preference || '' ).trim(),
      time_friendly: String( a.prep_time_limit || '' ).trim() ? 'yes' : '',
      prep_time_limit: String( a.prep_time_limit || '' ).trim(),
      preferred_retailers: toStringList( a.preferred_retailers ),
    },

    // Phase 1 input. The module's locale fallback still applies when this is
    // unresolved, which is why the state is reported rather than hidden.
    location,

    // Phase 6.2 input, pre-computed. The module says to build this by reading
    // recipe_history.csv; spec 8 moves the source of truth to Postgres.
    blocklist,
    blocklist_source: 'postgres',
    blocklist_note:
      'Already built from Postgres, covering both cookbook ratings and weight-loss meal ' +
      'ratings. Use it directly for the Phase 2 hard constraint; do not read ' +
      'recipe_history.csv for this. Dishes rated 0 are unrated and are correctly absent.',

    // Phase 6 changes destination, not behaviour.
    persistence: {
      store: 'postgres',
      note:
        'The Tenax UI saves the finished recipe to Postgres via the gateway when the user taps ' +
        'Save to Cookbook. Do not write recipe_history.csv for this request. Google Drive and ' +
        'CSV export remain available as explicit user-invoked exports.',
    },
  };

  return { content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ] };
}

// ---------------------------------------------------------------------------
// Tool 2: weight_loss_adapt
// ---------------------------------------------------------------------------

export const weightLossAdaptToolDefinition = {
  name: 'weight_loss_adapt',
  description:
    'Start a My Weight Loss Coach weekly adaptation. Returns the current program, the ' +
    'gateway-recalculated targets, the ratings blocklist and repeat list, and compliance ' +
    'figures. ' +
    'The intake is already complete -- do not re-ask it. Load the recipe-scout modules and ' +
    'follow the weight_loss.md weekly-adaptation workflow. The recalculated targets are ' +
    'authoritative: do not recompute BMR, TDEE, the calorie target or macros.',
  inputSchema: {
    type: 'object',
    properties: {
      program: {
        type: 'object',
        description:
          'Current program: methodology, daily_calorie_target_kcal, macros, eating_window, ' +
          'flags, week_number, biometrics.',
      },
      proposal: {
        type: 'object',
        description:
          'Gateway-computed proposal: next_week_number, start_from_weight_kg, blocklist, ' +
          'repeat_list, recalculated targets, compliance.',
      },
    },
    required: [ 'program', 'proposal' ],
  },
};

/**
 * @param {object} args
 * @returns {Promise<object>} MCP tool result.
 */
export async function handleWeightLossAdapt( args ) {
  const a = args && typeof args === 'object' && ! Array.isArray( args ) ? args : {};
  const program = a.program && typeof a.program === 'object' ? a.program : null;
  const proposal = a.proposal && typeof a.proposal === 'object' ? a.proposal : null;

  if ( ! program || ! proposal ) {
    return {
      isError: true,
      content: [ { type: 'text', text: JSON.stringify( {
        error: 'invalid_input',
        messages: [ 'Both program and proposal are required.' ],
      }, null, 2 ) } ],
    };
  }

  const flags = program.flags && typeof program.flags === 'object' ? program.flags : {};

  const payload = {
    task_class: 'recipe_request',
    mode: 'weight-loss',
    phase: 'weekly-adaptation',
    load_modules: RECIPE_SCOUT_MODULES,

    instruction:
      'This is a continuing program, not a new one. The intake is complete -- do not re-ask ' +
      'it. Load the recipe-scout modules and follow the weekly-adaptation workflow in the ' +
      'weight_loss.md reference: continue the existing methodology unless the user asked to ' +
      'change it, start from the last logged weight, carry the blocklist forward, and pre-fill ' +
      'the personalisation flags. Produce the Phase 7.3 week 2+ output.',

    program: {
      methodology: program.methodology || '',
      week_number: proposal.next_week_number,
      eating_window: program.eating_window || '',
      biometrics: program.biometrics || {},
      flags,
    },

    // The gateway's calculator is a verified port of weight_loss_calculator.py.
    // Recomputing here would reintroduce exactly the divergence that
    // verification exists to prevent, so the numbers are marked authoritative.
    targets: {
      daily_calorie_target_kcal: proposal.recalculated?.daily_calorie_target_kcal
        ?? program.daily_calorie_target_kcal,
      macros: proposal.recalculated?.macros ?? program.macros ?? {},
      bmr_kcal: proposal.recalculated?.bmr_kcal ?? null,
      tdee_kcal: proposal.recalculated?.tdee_kcal ?? null,
      start_from_weight_kg: proposal.start_from_weight_kg,
      warnings: proposal.recalculated?.warnings ?? [],
    },
    targets_note:
      'Authoritative. Computed by the gateway from a port of weight_loss_calculator.py that is ' +
      'verified field-for-field against the script across 120 randomly generated profiles. ' +
      'Do not run the calculator again; plan meals and exercise to hit these numbers.',

    ratings: {
      blocklist: Array.isArray( proposal.blocklist ) ? proposal.blocklist : [],
      repeat_list: Array.isArray( proposal.repeat_list ) ? proposal.repeat_list : [],
      source: 'postgres',
      note:
        'Built from the Postgres meal-ratings history rather than the exported meal ratings ' +
        'JSON. A dish appearing in both lists is blocked: repeating something the user ' +
        'disliked is a worse failure than omitting something they liked.',
    },

    compliance: proposal.compliance || {},
    compliance_note:
      'Use these to tune difficulty, not to lecture. Low meal adherence usually means the plan ' +
      'was too complex or too unfamiliar, so simplify before cutting calories further.',

    persistence: {
      store: 'postgres',
      note:
        'The user confirms the proposed week before anything is saved. The Tenax UI then ' +
        'persists it via the gateway. Do not write tracking.csv or the Google Drive copies ' +
        'for this request; those remain available as explicit exports.',
    },
  };

  return { content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ] };
}

export default {
  personalChefFindToolDefinition,
  handlePersonalChefFind,
  weightLossAdaptToolDefinition,
  handleWeightLossAdapt,
  resolveLocation,
  toStringList,
  RECIPE_SCOUT_MODULES,
};
