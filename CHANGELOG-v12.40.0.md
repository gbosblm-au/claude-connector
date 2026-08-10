# claude-connector v12.40.0

**Feature: Tenax UI Tools bridge — `personal_chef_find` and `weight_loss_adapt`.**

Minor release. Purely additive: one new tool module, one new test file. The only
changes to existing files are two imports, two registry entries and two dispatch
cases in each of `src/server-http.js` and `src/index.js`.

---

## What was added

| File | Purpose |
| --- | --- |
| `src/tools/personalChef.js` | Two MCP tools bridging the Tenax UI to the deployed recipe-scout modules |
| `src/tests/personal-chef.test.js` | 29 tests |

Both tools are advertised unconditionally. They are plain request/response
transforms with no gateway credentials, no filesystem writes and no tenant
coupling, so there is nothing for a mode guard to protect — and spec 8 requires
them to work from chat with no UI at all.

---

## These tools are deliberately thin, and that is the whole design

The recipe-scout engine is **already deployed** on the Railway volume as two
dispatcher modules:

```
/data/skill/ava/modules/recipe-scout/recipe-scout-core.md    Phases 0-6
/data/skill/ava/modules/recipe-scout/recipe-scout-output.md  Phase 7
```

`MANIFEST.json` marks `recipe-scout-output` as `mandatory_for: ["recipe_request"]`
with `co_load: ["recipe-scout-core"]`, so **both are already in context** whenever
the dispatcher classifies a turn as a recipe request.

### What the first draft got wrong

The first implementation of this file was a large "research brief" that restated:

- the Phase 3 ranking weights (authenticity 40%, rating 25%, …)
- the Phase 4.1 specialist-equipment list
- the `recipe_card.py` output schema
- the Phase 6.2 blocklist rule
- the contents of four reference files, read from the volume and inlined

**Every one of those already exists in the deployed modules.** A second copy
cannot be better than the original, and it goes stale silently the moment a
module is edited — the kind of divergence nobody notices until the printed card
and the on-screen card disagree.

It also had a concrete bug: it read reference files from
`/data/skill/ava/references/recipe-scout/`, whereas `recipe-scout-output.md`
indexes them at `/mnt/skills/user/ava/references/recipe-scout/`. The rewrite
reads no reference files at all, so the discrepancy is moot rather than latent.

### What these tools supply instead

Only the four things the modules **cannot** know, because they live outside the
model's context:

1. **The UI intake.** The Tenax form has already asked Phase 0's questions, so
   the payload says `Phase 0 is COMPLETE` and the assistant must not re-ask.
   Fields are handed over in the **module's own vocabulary** — `meal_name`,
   `servings`, `foods_to_avoid`, `bottled_sauce_ok` — not the UI's, because
   translation is where fields quietly go missing.
2. **The blocklist from Postgres.** Module Phase 6.2 says to build this by
   reading `recipe_history.csv`; spec 8 makes Postgres authoritative, and the
   gateway has already computed it across both cookbook and meal ratings.
3. **The browser-resolved location**, which beats the locale guess Phase 1 would
   otherwise fall back to. An unresolvable location is reported as
   `unresolved` rather than defaulted, so the module's own Phase 1 fallback
   takes over instead of proceeding on a guessed country.
4. **Where the result is persisted**, which has moved from CSV to Postgres.
   Google Drive and CSV export remain available as explicit user-invoked
   exports.

Everything else is a pointer: `load_modules: ["recipe-scout-core",
"recipe-scout-output"]` and `task_class: "recipe_request"`.

A test asserts the payload contains **none** of the duplicated content, so the
first draft's mistake cannot quietly return.

---

## Why the connector does not perform the research itself

Spec 3.3 reads as though `personal_chef_find` should execute Phases 1-5 end to
end. It cannot, for two reasons found by reading the code and testing rather
than by assumption:

- **There is no model here.** `ANTHROPIC_API_KEY` appears in `src/` only in
  tests asserting it must never reach a spawned script. Phase 3's rubric is 40%
  "authenticity: cultural expertise of the author, traditional techniques,
  correct cuts, spices and ferments" — a judgement, not a computation. An MCP
  tool is invoked *by* a model; it is not one.
- **The pages cannot be fetched.** A deterministic alternative — search, then
  parse `schema.org/Recipe` JSON-LD from each candidate — was tested against
  five major recipe sites (BBC Good Food, AllRecipes, Serious Eats, Simply
  Recipes, NYT Cooking). **All five returned HTTP 403** to a datacentre IP while
  general egress worked normally. Railway meets the same bot protection, so that
  design would fail on precisely the reputable sources Phase 3 asks for.

The research is therefore performed by the assistant in the Tenax conversation,
with the modules loaded — which is what spec 3.4 asks for anyway: *"the selected
recipe is rendered as a rich card in the conversation stream."*

---

## Gateway pairing

Requires **Gateway Service v2.74.0**, which calls these tools through
`POST /tool-call`. `GET /ti-chef/find` returns `mode: "brief"` carrying this
payload, or `mode: "recipe"` if a future connector ever returns a finished
recipe — the client switches on `mode` rather than sniffing the shape.

`weight_loss_adapt` marks the gateway's recalculated targets **authoritative**
and instructs the assistant not to run `weight_loss_calculator.py` again. The
gateway's calculator is a port verified field-for-field against that script
across 120 randomly generated profiles; recomputing would reintroduce exactly
the divergence that verification exists to prevent.

---

## Test results

| Suite | Result |
| --- | --- |
| `personal-chef.test.js` | 29 / 29 pass |
| Full connector suite | 195 / 195 pass |

The pre-existing 166 tests pass unchanged — no regressions.

`src/tools/webSearch.js` was briefly modified during development to export
`searchDetailed` for the deterministic-research design. That design was dropped
and **the file was reverted; it is byte-identical to v12.39.0**, verified by
diff against the original archive.

---

## Notes for the plugin work

`weight_loss_tracker.py` v3.0 (indexed in `recipe-scout-output.md`) already
implements the entire weight-loss coach interface as a standalone HTML
dashboard: Log Today form, Cheat Log, Chart.js charts accumulating full
programme history, Tracking History table, Activities table with Done and effort
ratings, ingredients modal, per-meal eaten flag and 1-10 rating, and five
exports.

Spec section 4 is therefore a **port of that dashboard into the Tenax UI**, with
Postgres replacing `localStorage`. The gateway's `/ti-wl/*` endpoints already
map onto it one-for-one. It also confirms the specification's claim that
Chart.js is "already used by the existing tracker" — it is, in that generated
HTML file, which is why vendoring Chart.js into the plugin is consistent with
the existing tool rather than a new dependency choice.
