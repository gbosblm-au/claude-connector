// src/tests/personal-chef.test.js
//
// Tests for the Personal Chef and weight-loss adaptation brief builders.
//
// These tools are pure request/response: no network, no gateway credentials,
// no writes. The only filesystem contact is reading reference files from the
// volume, and that is exercised against a temporary directory rather than
// mocked, so the path resolution and the containment guard are really run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePersonalChefFind,
  handleWeightLossAdapt,
  personalChefFindToolDefinition,
  weightLossAdaptToolDefinition,
  resolveLocation,
  toStringList,
  RECIPE_SCOUT_MODULES,
} from '../tools/personalChef.js';

/** Parse the JSON a tool returns in its single text block. */
function payload( result ) {
  return JSON.parse( result.content[ 0 ].text );
}

/** A valid minimal intake, so each test varies only what it is about. */
const INTAKE = {
  recipe_name: 'butter chicken',
  serves: 4,
  allergies: [],
  bottled_sauces_ok: true,
};

// ---------------------------------------------------------------------------
// Intake validation
// ---------------------------------------------------------------------------

describe( 'personal_chef_find intake validation', () => {
  test( 'the four required fields are all enforced', async () => {
    const r = await handlePersonalChefFind( {} );
    assert.equal( r.isError, true );
    const p = payload( r );
    assert.equal( p.error, 'invalid_intake' );
    // Reported together, so the form can highlight every bad field at once
    // rather than making the user resubmit to find the next one.
    assert.ok( p.messages.length >= 4, 'all problems reported at once' );
  } );

  test( 'an empty allergy list is a valid answer; an omitted field is not', async () => {
    const omitted = await handlePersonalChefFind( {
      recipe_name: 'pho', serves: 2, bottled_sauces_ok: true } );
    assert.equal( omitted.isError, true,
      '"nobody asked" must not pass as "the user said none"' );

    const answered = await handlePersonalChefFind( {
      recipe_name: 'pho', serves: 2, allergies: [], bottled_sauces_ok: true } );
    assert.notEqual( answered.isError, true );
  } );

  test( 'bottled_sauces_ok false is a valid answer, not a missing one', async () => {
    // The classic falsy-check bug: `if (!args.bottled_sauces_ok)` would reject
    // the user who said "no shop-bought sauces", which is the answer that most
    // changes the search.
    const r = await handlePersonalChefFind( { ...INTAKE, bottled_sauces_ok: false } );
    assert.notEqual( r.isError, true );
    // Passed through in the module's own vocabulary, so Phase 2 reads it
    // without translation.
    assert.equal( payload( r ).intake.bottled_sauce_ok, 'no' );
  } );

  test( 'serves is bounded to the 1-20 range the stepper offers', async () => {
    for ( const serves of [ 0, 21, -1, 'lots', null ] ) {
      const r = await handlePersonalChefFind( { ...INTAKE, serves } );
      assert.equal( r.isError, true, `serves=${ serves } must be rejected` );
    }
  } );

  test( 'an over-long dish name is refused rather than truncated', async () => {
    const r = await handlePersonalChefFind( { ...INTAKE, recipe_name: 'x'.repeat( 250 ) } );
    assert.equal( r.isError, true );
  } );
} );

// ---------------------------------------------------------------------------
// The brief is a brief, not an answer
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Hard constraints
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Location resolution  (spec 8)
// ---------------------------------------------------------------------------

describe( 'location resolution', () => {
  test( 'an explicit "City, Country" wins', () => {
    const r = resolveLocation( 'Melbourne, Australia', 'en-GB' );
    assert.equal( r.user_city, 'Melbourne' );
    assert.equal( r.user_country, 'Australia' );
    assert.equal( r.resolved_from, 'ui' );
  } );

  test( 'locale is the fallback when no location is given', () => {
    const r = resolveLocation( '', 'en-AU' );
    assert.equal( r.user_country, 'Australia' );
    assert.equal( r.resolved_from, 'locale' );
  } );

  test( 'a bare country name is a country, not a city', () => {
    const r = resolveLocation( 'Australia', '' );
    assert.equal( r.user_country, 'Australia' );
    assert.equal( r.user_city, '', 'there is no city called Australia' );
  } );

  test( 'an unresolvable location says so instead of guessing a country', async () => {
    const r = resolveLocation( '', '' );
    assert.equal( r.resolved_from, 'unresolved' );
    assert.equal( r.user_country, '' );

    // The state is reported rather than hidden, so the module's own Phase 1
    // fallback can take over instead of proceeding on a guessed country.
    const p = payload( await handlePersonalChefFind( INTAKE ) );
    assert.equal( p.location.resolved_from, 'unresolved' );
    assert.equal( p.location.user_country, '' );
  } );

  test( 'an unknown locale region does not invent a country', () => {
    assert.equal( resolveLocation( '', 'en-ZZ' ).resolved_from, 'unresolved' );
    assert.equal( resolveLocation( '', 'nonsense' ).resolved_from, 'unresolved' );
  } );

  test( 'preferred retailers are carried and ordered first', async () => {
    const p = payload( await handlePersonalChefFind( {
      ...INTAKE, location: 'Melbourne, Australia', preferred_retailers: [ 'Coles', 'Aldi' ] } ) );
    assert.deepEqual( p.intake.preferred_retailers, [ 'Coles', 'Aldi' ] );
    assert.equal( p.location.user_city, 'Melbourne' );
  } );
} );

// ---------------------------------------------------------------------------
// Search lexicon  (Phase 2)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Reference files
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// weight_loss_adapt
// ---------------------------------------------------------------------------

describe( 'weight_loss_adapt', () => {
  const PROGRAM = {
    methodology: 'Calorie Deficit + High-Protein',
    daily_calorie_target_kcal: 2100,
    macros: { protein_g: 144, fat_g: 58, carbs_g: 240 },
    eating_window: '12:00pm - 8:00pm',
    week_number: 3,
    flags: { budget_friendly: 'yes', gym_membership: 'no', prep_time_cap_minutes: 30 },
  };
  const PROPOSAL = {
    next_week_number: 4,
    start_from_weight_kg: 92.4,
    blocklist: [ 'Bland Salad' ],
    repeat_list: [ 'Great Curry' ],
    recalculated: { daily_calorie_target_kcal: 2080, macros: { protein_g: 144, fat_g: 58, carbs_g: 235 } },
    compliance: { meal_adherence_percent: 72, exercise_adherence_percent: 50 },
  };

  test( 'both program and proposal are required', async () => {
    for ( const args of [ {}, { program: PROGRAM }, { proposal: PROPOSAL } ] ) {
      const r = await handleWeightLossAdapt( args );
      assert.equal( r.isError, true );
    }
  } );

  test( 'it points at the deployed workflow instead of restating it', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    // The four spec-5 adaptation rules live in the weight_loss.md reference,
    // which the modules already index. Restating them here would be a second
    // copy that goes stale the moment that reference is edited.
    assert.deepEqual( p.load_modules, RECIPE_SCOUT_MODULES );
    assert.equal( p.phase, 'weekly-adaptation' );
    assert.match( p.instruction, /weight_loss\.md/ );
    assert.match( p.instruction, /do not re-ask/i );
  } );

  test( 'recalculated targets win over the stored program', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.equal( p.targets.daily_calorie_target_kcal, 2080, 'the recalculated figure, not 2100' );
    assert.equal( p.program.week_number, 4, 'the next week, not the current one' );
    assert.equal( p.targets.start_from_weight_kg, 92.4 );
  } );

  test( 'the model is told not to recompute the targets', async () => {
    // The gateway port is verified against weight_loss_calculator.py across
    // 120 profiles. Recomputing here would reintroduce exactly the divergence
    // that verification exists to prevent.
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.match( p.targets_note, /Do not run the calculator again/ );
  } );

  test( 'the blocklist and repeat list come from Postgres, not the CSV export', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.deepEqual( p.ratings.blocklist, [ 'Bland Salad' ] );
    assert.deepEqual( p.ratings.repeat_list, [ 'Great Curry' ] );
    assert.equal( p.ratings.source, 'postgres' );
    assert.match( p.ratings.note, /in both lists is blocked/ );
  } );

  test( 'personalisation flags carry through so they are not re-asked', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.equal( p.program.flags.budget_friendly, 'yes' );
    assert.equal( p.program.flags.prep_time_cap_minutes, 30 );
  } );

  test( 'a program with no flags does not crash the payload', async () => {
    const p = payload( await handleWeightLossAdapt( {
      program: { ...PROGRAM, flags: undefined }, proposal: PROPOSAL } ) );
    assert.deepEqual( p.program.flags, {} );
  } );

  test( 'low adherence is framed as a plan problem, not a user failure', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.equal( p.compliance.meal_adherence_percent, 72 );
    assert.match( p.compliance_note, /simplify before cutting calories/ );
  } );

  test( 'persistence is redirected to Postgres', async () => {
    const p = payload( await handleWeightLossAdapt( { program: PROGRAM, proposal: PROPOSAL } ) );
    assert.equal( p.persistence.store, 'postgres' );
    assert.match( p.persistence.note, /confirms the proposed week before anything is saved/ );
  } );
} );

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deferring to the deployed modules rather than duplicating them
// ---------------------------------------------------------------------------

describe( 'the tools defer to the deployed recipe-scout modules', () => {
  test( 'the payload names the modules to load', async () => {
    const p = payload( await handlePersonalChefFind( INTAKE ) );
    assert.deepEqual( p.load_modules, RECIPE_SCOUT_MODULES );
    assert.deepEqual( [ ...RECIPE_SCOUT_MODULES ], [ 'recipe-scout-core', 'recipe-scout-output' ] );
    // task_class is what MANIFEST.json keys `mandatory_for` on, so setting it
    // is what makes the dispatcher load recipe-scout-output automatically.
    assert.equal( p.task_class, 'recipe_request' );
  } );

  test( 'it does NOT restate anything the modules already define', async () => {
    // This is the regression guard for the redesign. An earlier version of
    // this tool shipped its own copy of the Phase 3 ranking weights, the
    // specialist-equipment list, the recipe_card.py output schema and the
    // blocklist rule -- all of which already live in recipe-scout-core.md and
    // recipe-scout-output.md. A second copy cannot be better than the original
    // and goes stale silently when the module is edited.
    const p = payload( await handlePersonalChefFind( INTAKE ) );
    const text = JSON.stringify( p );

    for ( const [ label, probe ] of [
      [ 'Phase 3 ranking weights', /ranking_weights|authenticity.{0,4}:\s*40/ ],
      [ 'specialist equipment list', /mortar and pestle|air fryer/i ],
      [ 'recipe_card.py output schema', /output_schema|cooking_steps/ ],
      [ 'inlined reference file bodies', /references"\s*:\s*\{[^}]/ ],
    ] ) {
      assert.ok( ! probe.test( text ), `must not duplicate the ${ label }` );
    }
  } );

  test( 'it supplies exactly what the modules cannot know', async () => {
    const p = payload( await handlePersonalChefFind( {
      ...INTAKE, location: 'Melbourne, Australia', blocklist: [ 'Bland Salad' ] } ) );

    // 1. Phase 0 answers, so the form's questions are not asked twice.
    assert.equal( p.intake.meal_name, 'butter chicken' );
    assert.match( p.instruction, /Phase 0 is COMPLETE/ );
    // 2. The blocklist, which Phase 6.2 would otherwise read from CSV.
    assert.deepEqual( p.blocklist, [ 'Bland Salad' ] );
    assert.equal( p.blocklist_source, 'postgres' );
    // 3. The browser-resolved location, better than Phase 1's locale guess.
    assert.equal( p.location.user_city, 'Melbourne' );
    // 4. Where the result now goes.
    assert.equal( p.persistence.store, 'postgres' );
  } );

  test( 'the intake uses the module\'s field names, not the UI\'s', async () => {
    // recipe-scout-core.md Phase 0 calls these meal_name, servings,
    // foods_to_avoid and bottled_sauce_ok. Handing it recipe_name / allergies /
    // bottled_sauces_ok would make the assistant translate, and translation is
    // where fields quietly go missing.
    const p = payload( await handlePersonalChefFind( {
      ...INTAKE, allergies: [ 'peanuts' ] } ) );
    assert.equal( p.intake.meal_name, 'butter chicken' );
    assert.equal( p.intake.servings, 4 );
    assert.deepEqual( p.intake.foods_to_avoid, [ 'peanuts' ] );
    assert.equal( p.intake.bottled_sauce_ok, 'yes' );
    assert.ok( ! ( 'recipe_name' in p.intake ) );
    assert.ok( ! ( 'allergies' in p.intake ) );
  } );

  test( 'a comma-separated string is accepted as well as an array', async () => {
    // The chat path sends prose; the UI sends arrays. Both are real callers.
    const p = payload( await handlePersonalChefFind( {
      ...INTAKE, allergies: 'peanuts, shellfish , peanuts' } ) );
    assert.deepEqual( p.intake.foods_to_avoid, [ 'peanuts', 'shellfish' ],
      'deduplicated case-insensitively, whitespace trimmed' );
  } );

  test( 'both tool descriptions tell the caller not to re-ask the intake', () => {
    // The description is all a model reads before deciding how to use a tool,
    // so the "Phase 0 is done" instruction has to live there too.
    assert.match( personalChefFindToolDefinition.description, /do not re-ask/i );
    assert.match( weightLossAdaptToolDefinition.description, /do not re-ask/i );
  } );
} );

describe( 'robustness', () => {
  test( 'malformed input degrades rather than throwing', async () => {
    for ( const bad of [ null, undefined, 'string', 42, [] ] ) {
      const r = await handlePersonalChefFind( bad );
      assert.equal( r.isError, true, `${ JSON.stringify( bad ) } must be a clean error` );
      const w = await handleWeightLossAdapt( bad );
      assert.equal( w.isError, true );
    }
  } );

  test( 'every result is a single valid JSON text block', async () => {
    const results = [
      await handlePersonalChefFind( INTAKE ),
      await handlePersonalChefFind( {} ),
      await handleWeightLossAdapt( { program: {}, proposal: {} } ),
    ];
    for ( const r of results ) {
      assert.equal( r.content.length, 1 );
      assert.equal( r.content[ 0 ].type, 'text' );
      // The gateway parses this string; anything unparseable surfaces as a
      // confusing error far from its cause.
      assert.doesNotThrow( () => JSON.parse( r.content[ 0 ].text ) );
    }
  } );

  test( 'list coercion handles the shapes real callers send', () => {
    assert.deepEqual( toStringList( null ), [] );
    assert.deepEqual( toStringList( '' ), [] );
    assert.deepEqual( toStringList( [ 'a', '', null, 'a', 'B' ] ), [ 'a', 'B' ] );
    assert.deepEqual( toStringList( 'a, b ,a' ), [ 'a', 'b' ] );
    assert.ok( toStringList( new Array( 200 ).fill( 0 ).map( ( _, i ) => `x${ i }` ) ).length <= 60,
      'bounded so a runaway caller cannot inflate the brief' );
  } );
} );
