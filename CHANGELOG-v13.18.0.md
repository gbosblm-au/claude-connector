# claude-connector v13.18.0

Fix 2 — Compile Budget Code Guard.

---

## What it defends

The module-selection budget reads:

```js
module?.line_count_estimate || module?.line_count || 20
```

That default is reasonable for one unmeasured module. It is a disaster when
**every** module falls through, because the budget then believes a 4,000-line
skill is 20 lines per entry and admits far more than it can carry.

A manifest that was regenerated, hand-edited, or written by a tool that did not
know about the field produces exactly that state — and produces it **silently**.
Nothing in the compile looks wrong. The skill is simply too big, and the cause is
a field nobody noticed had gone.

The data repair fixes today's manifests. This measures anything that arrives
unmeasured tomorrow.

## Where it runs

`hydrateLineCounts(manifest, paths)`, called from `compileSkill` immediately
after `loadMergedManifest` and before any budget arithmetic.

A no-op the moment a manifest carries counts — the normal state after repair.
The loop short-circuits on its first condition and touches no disk, so the
healthy case costs nothing. Only entries actually missing data are read, once
each per compile.

## Two decisions beyond the specified minimum

**A missing file is left untouched, not zeroed.** Writing `0` would make the
module *free*, and a free module is always selectable — the budget would admit
it ahead of modules that honestly declared their size. Left alone, the existing
default-20 fallthrough applies, so the module stays selectable at a conservative
estimate and a `warn` line names it for repair.

**An empty file is treated the same way.** `countLines('')` returns 0, so the
first implementation wrote `line_count: 0` and reintroduced the free-module
problem by a different route. Caught by a test asserting the reasoning the
comment already claimed. A measured zero is now reported as unmeasured rather
than stored.

A read failure is handled like a missing file. The guard must never be the
reason a compile fails: one unreadable module would cost the session its entire
skill, which is far worse than a mis-sized budget.

## One deviation from the patch as written

The specified patch is inline in `compileSkill`. `compileSkill` is not exported,
so an inline guard can only be exercised through a full compile with a live
volume — and the acceptance criteria call for a mutation test on exactly this
behaviour.

Extracted to an exported function instead. Same placement, same logic, and the
guard's regressions can now be found in CI rather than in production.

## Not implemented: the byte-size extension

§4.3's `max(line_count, byte_size)` suggestion is deliberately not built. It is
described as a judgement call for the operator, and it changes the meaning of
the budget for every module rather than only the unmeasured ones — a dense
module that currently fits would start being excluded.

The observed regression is fully addressed by the minimum guard. If the
philosophical frontier modules (85 KB in 59 lines) prove to flood the budget in
practice, that is a separate change with its own before-and-after measurement,
not a rider on this one.

---

## Tests

`npm run test:budget-guard` — **8 passed, 0 failed, 1 skipped**.

The skip is the unreadable-file case, which cannot be exercised as root because
permissions are not enforced. It skips rather than passes, so it never reports
success for something it did not test.

All four acceptance criteria are covered, and the assertions are on the number
the **budget** would use rather than on whether a field was populated — a guard
that writes `line_count` somewhere the budget does not read would be no guard.

Mutation-tested: removing the guard fails 5, overwriting a declared estimate
fails 1, zeroing a missing file fails 1, and disconnecting the call from
`compileSkill` fails 1.

### Regression

`test:homework` 105, `test:voice-all` 286, `manifest-fragments` all pass.
