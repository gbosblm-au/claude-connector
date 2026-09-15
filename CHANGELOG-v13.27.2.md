# claude-connector v13.27.2

Round A of SPEC-SOCIAL-003 v1.1 (Response Studio). This release contains no
Response Studio feature code. It supplies the one capability the gateway needs
before that feature can be built: a path-addressed read for `modules/`.

> **Changed in 13.27.2.** This paragraph originally ended "plus the file the
> spec says is already there and is not." That was wrong. The file is there, it
> is 52 lines, and the seed has been withdrawn. See WITHDRAWN below.

## Why this release exists

SPEC-SOCIAL-003 §3 requires that the Response Studio module bundle name
**resolved paths, not bare module ids**, and §14 requires a test asserting that
every bundle entry resolves to exactly one file on disk.

Neither was achievable. Two findings from the pre-build audit:

1. **The gateway cannot read modules.** The Railway volume is mounted on this
   connector at `/data/skill/ava` (`SNAPSHOT_MANIFEST.json`, `ava_dir`). The
   gateway has no filesystem access to it: there is no `SKILL_FILE_PATH`, no
   skill directory constant and no read of that tree anywhere in `gateway/lib`,
   `gateway/routes` or `gateway/server.js`. It reaches skill material only over
   HTTP, through `POST /tool-call`.

2. **No tool read a module by path.** This connector exposed `module_write`
   (write by path) and `reference_read` (read by path, `references/` only). The
   only reader for `modules/` was `skill_load_specialist`, which takes a bare
   `module_id` and resolves it through `MANIFEST.json`. That is correct for
   session dispatch and wrong for a closed allowlist, for exactly the reason
   §3 gives: a bare id resolves through whatever the loader finds first, and the
   failure is silent.

The second is reason enough on its own: it is a property of id dispatch, not a
claim about any particular file.

> **Corrected in 13.27.2.** This section originally argued the risk was "not
> theoretical on this volume", citing
> `modules/modules/philosophy/phil-identity-parfit.md` and
> `modules/modules/meta/meta-deflection-watch.md` as **divergent** shadows of
> modules the Response Studio bundle names. The 2026-09-15 audit reports them
> byte-identical: parfit 39 lines and 4,328 bytes in both locations,
> deflection-watch 60 lines and 9,560 bytes in all three. Every path that bundle
> names exists exactly once at the intended location.
>
> The genuinely divergent duplicates on this volume are real but all sit
> OUTSIDE that bundle: `grief-session-close` at three sizes,
> `exist-angst-kierkegaard-heidegger` at 9,264, 6,480 and 2,278 bytes, the two
> `DISPATCH_RULES.json` at 754 and 869 lines, and the `ref/` against
> `reference/` pairs. Those are still residue from the `module_write`
> double-nesting bug that SPEC-FIX-MODULE-WRITE-001 fixed, which stopped new
> ones being created and did not remove the ones already on disk.
>
> So `module_resolve` is hygiene for the Response Studio bundle and a live
> diagnostic for the rest of the tree.

## Added

### `module_read`

Reads one or more module files **by path** relative to the modules root. Batched,
because the Response Studio bundle is about twenty entries and twenty sequential
HTTP round trips against the gateway's per-call ceiling is not a viable shape.

- Accepts `file` (one) or `files` (several); both spellings are unioned and
  de-duplicated on the normalised path, so `voice/x.md` and `modules/voice/x.md`
  are recognised as one request and the file is read once.
- Reuses `normaliseModulePath`, `validateContentPath` and `resolveContained`, so
  containment behaviour is identical to `module_write`. Traversal is refused by
  the validator; symlinks are refused physically by `resolveContained`, which is
  the layer a lexical check cannot replace.
- Returns `line_count`, `size_bytes`, `sha256` and `resolved_path` per file.
- A per-entry failure is reported in `errors` and does **not** fail the call, so
  a caller reading a twenty-entry bundle learns about all its bad entries in one
  round trip rather than one per redeploy. The call is `isError` only when the
  arguments are unusable or nothing at all could be read.
- A caller requiring every entry must check `errors.length === 0`, or the
  `complete` boolean provided for that purpose. The absence of `isError` is not
  sufficient and is documented as not sufficient.
- Two independent ceilings: `MODULE_READ_MAX_FILES` (default 40) and
  `MODULE_READ_MAX_TOTAL_CHARS` (default 1048576). The file cap alone does not
  bound the response, because file sizes on this tree vary by two orders of
  magnitude and the consumer is a model context window.

### `module_resolve`

Reports resolution and shadowing for module paths. Metadata only, never content.

- `match_count` is 0 or 1 by construction, because the path is exact. The field
  exists so a caller can assert the property rather than assume it, which is
  what §14's resolution test needs.
- `shadows` lists every other file in the modules tree carrying the same
  basename, with size, line count, hash and an `identical` flag. This is what
  makes the duplicate tree visible without reading the server, and it satisfies
  the diagnostic half of §10's `GET /social/bundle`.
- A shadow is reported, not treated as an error. Which copy is correct is a
  judgement about content, not about paths. §16 tracks the underlying
  duplication as its own item.
- The index walk uses `lstatSync`, not `statSync`, so a symlinked directory
  inside `modules/` is skipped rather than descended into. `statSync` follows
  the link, which would both defeat containment and risk a cycle.
  `MODULE_INDEX_MAX_FILES` (default 5000) bounds the walk.

Both tools are **read-only** and are deliberately absent from
`SYSTEM_WRITE_TOOLS`, so a non-owner tenant may read the modules shaping its own
session without being able to modify them.

### WITHDRAWN: the constraint protocol seed

An earlier cut of this release shipped `deploy/volume-seed/` and
`scripts/seed-volume-references.mjs` to place
`references/social/social-reply-constraints.md` on the volume, on the finding
that the file was absent. **That finding was wrong and the seed has been
removed.** Running it would have overwritten a better file with a worse one.

The file is present: 4,800 bytes, 52 lines, last modified 2026-09-14 at
11:23:18 UTC. The evidence offered for its absence was the volume snapshot taken
at 02:37:40 the same day. The file postdates that snapshot by eight hours and
forty-six minutes, so the snapshot could not have contained it and could never
have supported the conclusion drawn from it.

The live file is materially richer than the copy that would have replaced it. It
carries two rules the seeded copy did not have at all: measure the count rather
than estimate it, and never let a recalled limit replace a test-confirmed one.
It carries a fourth table column marking each limit confirmed-by-test or
recalled, so only the 1,250 row has authority. It records both rejections, 156
over and 180 over, as independent evidence resolving to the same figure. And it
has a section on tone revisions growing a draft, which came out of live use.
Four things learned the hard way, all of which the seed would have destroyed.

**The reasoning error, recorded because it generalises.** A snapshot can
establish that a file was present at a point in time. It can never establish
that a file is absent now. When the conclusion is absence, the check has to be
live. The premise was correctly attributed to a named artifact, which was the
lesson of an earlier round; the new failure was drawing a conclusion of a kind
that artifact is structurally incapable of supporting.

The irony is that Rule 2 of the file in question says nearly this: if a recall
and a test disagree, the test wins and the recall is discarded. The same applies
to a snapshot and a live read.

Section 17's dependency row should read **52 lines, as last revised
2026-09-14**, not 42.

## Changed

- `src/tools/skill-content.js`: added `lstatSync` and `node:crypto` `createHash`
  imports, both used by the new code.
- `src/server-http.js`: registered both tools in `dispatchToolCallCore`, in
  `buildEffectiveToolList`, and in both modular tool manifests (the MCP
  `ListTools` handler and `GET /tools`), including both `MODULAR_TOOL_NAMES`
  sets. Registering in one manifest and forgetting the other would make a tool
  callable but undiscoverable, which is the failure this enumeration avoids.

## Verification

`npm run test:module-read` — 17 assertions, all passing.

The suite drives the real handlers against a real temporary volume rather than
asserting on source text, because the defect class it protects against is not
visible in the shape of the code: only which physical file comes back
distinguishes a correct resolve from a shadowed one. The fixture reproduces the
live duplication, with a divergent copy of `phil-identity-parfit.md` under
`modules/modules/philosophy/`.

A fixture guard runs first and hard-exits if `SKILL_FILE_PATH` redirection did
not take effect, because every assertion below it is meaningless if the tools
are pointed at the real volume, and a suite silently reading `/data` would still
print passes.

Every pin ships with the mutation that reddens it. All seven were run:

| Mutation | Result |
|---|---|
| Shadow reporting removed (`shadows` always empty) | 16 passed, 1 failed |
| Containment check removed from `resolveModulePath` | 16 passed, 1 failed |
| Index walk follows symlinks (`lstatSync` to `statSync`) | 16 passed, 1 failed |
| `module_resolve` leaks content into the entry | 16 passed, 1 failed |
| `complete` flag hardcoded true | 16 passed, 1 failed |
| De-duplication of spellings removed | 16 passed, 1 failed |
| Shadow `identical` flag inverted | 16 passed, 1 failed |

Each mutation reddens exactly one test, so the pins are granular rather than
aggregate: one mutation is not being used to prove several code paths.

Note on the containment mutation: it reddens only the symlink case, because
`validateContentPath` rejects `..` independently. That is the correct reading.
`resolveContained` is defence in depth over the validator, and the symlink case
is what it uniquely protects, since `resolve()` is lexical and never touches the
filesystem.

## Compatibility

No existing tool, signature, response shape or route changed. Two tools were
added and two import lists extended. Existing callers of `module_write`,
`reference_read` and `skill_load_specialist` are unaffected.

## Deployment

1. Deploy this connector release. There is no seeding step: the constraint
   protocol is already on the volume and must not be overwritten.
2. Confirm the bundle resolves before deploying the gateway side:

   ```
   curl -sX POST https://<connector-host>/tool-call \
     -H 'Content-Type: application/json' \
     -H 'X-Railway-Restore-Token: <token>' \
     -d '{"tool_name":"module_resolve","tool_input":{"files":["writing/writing-brian-voice.md","voice/voice-natural-conversation.md","philosophy/phil-identity-parfit.md"]}}'
   ```

   Expect `all_resolved: true`. The `phil-identity-parfit.md` entry is expected
   to report one shadow; that is the known duplication, not a failure.
