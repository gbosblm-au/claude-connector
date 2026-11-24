# claude-connector 13.44.0

Work order: WO-2026-11-24-03, trigger-phrase validation: the rule, and making a drop impossible to miss.
Companions: Gateway Service 2.376.0 and ts-client-gateway 5.290.0, both unchanged by this release.

## Version note

The attached tree's package.json said 13.40.0, but CHANGELOG and DELIVERY files for 13.41.0, 13.42.0 and 13.43.0 are already in it. This release is numbered 13.44.0 so it sorts after every release recorded in the tree. If the deployed connector is already past 13.43.0, renumber before deploying.

## R1: the phrase rule (as shipped)

A trigger phrase is kept only if:

1. it has two or more words (unchanged);
2. it is at least twelve characters long (unchanged);
3. it is not made only of stopwords (new; replaces "no stopword at either end");
4. it is not a substring of another phrase on the same module (unchanged).

The stopword list (144 words) is unchanged.

R1 also proposed a condition (b): refuse a phrase with fewer than two non-stopword tokens. It was run against R2 before shipping and refused four of the six phrases R2 requires kept: "where should I stay in", "what are you curious about", "for their own good" and "held against my will". Each has exactly one non-stopword token under the unchanged list, because "should", "about", "own" and "will" are on it. Brian chose condition (a) alone on 2026-11-24. A test pins that (b) stays out.

A token with no letter or digit, such as a dash, counts as carrying no content. So "into the -" is refused like "into the".

## R2: the thirteen rows

All 13 rows pass, both through the lint and through a real module_write:

- **Refused:** "into the", "and the", "with the", "not the", "the past", "go", "kpi".
- **Kept:** "plan a trip to", "where should I stay in", "what are you curious about", "for their own good", "held against my will", "nobody asked me".

"into the" is refused under condition 3, not only by the length floor. "into the very same" (18 characters) is refused too.

## R3: drops are recorded (option b)

- **Persisted block.** Every registration module_write writes now carries a `trigger_dropped` block beside `triggers`, holding `[{ phrase, reason }]`. Refused keywords are recorded as `{ keyword, reason }` and refused task classes as `{ task_class, reason }`. `reason` lists every failed condition. The compile scores `module.triggers` only, and the block is never inside `triggers`.
- **Write rules for the block.**
  - It is a managed key: a `manifest_entry` cannot supply it.
  - An update with no triggers supplied keeps the triggers and the block they came with.
  - A registration from before this release gets no invented block.
- **C-L reads the block.**
  - `stopword_phrase` findings now carry `state`. `refused_on_write` means the refusal is recorded in `trigger_dropped`, so it is a live loss (`live_loss: true`). `would_be_refused_on_next_write` means a stored phrase made only of stopwords.
  - Other recorded refusals are reported as `trigger_dropped` findings.
  - `by_state` counts both states.
- **C-L reconciles frontmatter and registration.**
  - A module whose frontmatter declares phrases its registration does not hold gets a `frontmatter_phrases_unregistered` finding. It names the module and gives `count`, `declared`, `registered`, `recorded_in_trigger_dropped`, `unrecorded`, and the missing phrases. Case is ignored.
- **Repair report.**
  - A refusal recorded in `trigger_dropped` does not count as a defect of the stored entry.
  - A proposal includes the `trigger_dropped` block a re-write would persist.

## R4: six constructed inputs (all run through module_write; all pass)

1. **No triggers block:** registered, `triggers_source "none"`, `registered_without_triggers` warning, `trigger_dropped []`.
2. **Three phrases made only of stopwords, each at least 12 characters:** all three refused as "consists only of stopwords". The module still registers, with `triggers_source "none"`.
3. **"book a flight home" and "book a flight home today":** the shorter is refused by condition 4 alone and the longer is kept.
4. **"spring break" (12 characters):** kept.
5. **"summer camp" (11 characters):** refused, reason "shorter than 12 characters".
6. **Re-write with an unchanged triggers block:**
   - the stored set, the block and the whole entry are identical;
   - there is still one registration;
   - every file outside the append-only `.ledger/` is byte-identical.

## R5: unchanged

The following are unchanged, and tests pin it:

- keyword validation (P4 path segments and forbidden words);
- provides;
- version carry-through;
- `line_count_estimate`;
- fragment selection, naming and update in place.

MANIFEST.json, MANIFEST_APPEND.json and DISPATCH_RULES.json are not written; a test hashes them before and after a write.

## R6: re-derivation

C-L now returns `phrase_rederivation`. It covers every phrase a module's frontmatter declares that the registration does not hold, re-derived from that frontmatter under the current rule. It is reported as three separate lists with counts:

- `newly_kept`;
- `still_refused` (with reasons);
- `refused_as_substring` (cleared of every other condition, refused by condition 4).

It is read-only: a module's registration changes only when the module is written again.

## Files

**Modified:**

- `src/tools/manifest-fragments.js`
- `src/tools/module-consistency.js`
- `src/tools/skill-content.js` (the module_write contract text only)
- `package.json` (version, two scripts)
- `src/tests/module-registration-wo-2026-11-21-02.test.js`
  - S-1: "attunement the" is no longer a stopword phrase.
  - P9: the damaged fixture phrase is now one the lint still drops, so the supplied-string check stays the only thing that can refuse it.
- `scripts/verify-wo-2026-11-21-02-mutations.mjs` (two pins re-pointed at the new function)

**New:**

- `src/tests/trigger-phrases-wo-2026-11-24-03.test.js`
- `scripts/verify-wo-2026-11-24-03-mutations.mjs`
- this file
- `DELIVERY-v13.44.0.json`
