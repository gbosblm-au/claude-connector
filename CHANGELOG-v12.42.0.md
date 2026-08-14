# claude-connector v12.42.0

Two additive specs, one release, because they touch the same three wiring
points in `server-http.js`:

- **SPEC-GTW-TOOL-001** — first-class document edit and homework render tools
  (`xlsx_edit`, `docx_edit`, `pptx_edit`, `homework_render`)
- **SPEC-GTW-TOOL-003** — first-class code and ERP config validation tools
  (`code_syntax`, `code_integrity`, `erp_config_validator`)

Both default **off**. Nothing changes for an existing deployment until the
flags are set. `script_execute` and every script it can reach are untouched and
remain available.

---

## Deployment, in order

1. **Copy `volume-scripts/doc_common.py` to `/data/skill/ava/scripts/`.**
   Without this, `xlsx_edit`, `docx_edit` and `pptx_edit` fail at import. See
   "Volume repairs" below.
2. **Copy `volume-scripts/code_integrity_lib.py` to
   `/data/skill/ava/scripts/scripts/`.** Without this, `code_integrity`'s
   WordPress and SQL-injection checks report clean on insecure code.
3. Deploy the connector.
4. Set `EDIT_TOOLS_ENABLED=true` and/or `VALIDATION_TOOLS_ENABLED=true`.
   `SKILL_FILE_PATH` must also be set — the scripts live on that volume, and a
   tool that can only return `scripts_dir_missing` is worse than no tool.
5. Confirm on the authenticated diagnostics endpoint: `editTools` and
   `validationTools` now report which scripts are actually present.

---

## Volume repairs, and why they were unavoidable

Both specs state the scripts are ready and only gateway wiring is needed. That
was not true of the volume snapshot supplied. Both repairs are additive: no
existing function changes behaviour for any existing caller.

### `doc_common.py` → v2.0.1

**Three of the four edit scripts could not start.** Not "failed on bad input" —
`ImportError` at module load, before argparse:

| Script | Missing from `doc_common` |
|---|---|
| `document-processingedit_xlsx.py` | `artifact`, `parse_json` |
| `document-processingedit_pptx.py` | `artifact` |
| `document-processingedit_docx.py` | `fail_if_missing` |

Each restoration is evidenced, not invented:

- **`parse_json`** — the file already contains `parse_json_arg` with the exact
  signature the caller uses, and `parse_hex_color` sits three functions below
  carrying the comment *"Retained under its original name and return format for
  compatibility"*. A v2.0.0 rename kept one alias and missed this one. Restored
  as an alias.
- **`emit()`** — widened to accept a payload dict. **Every `emit()` call site on
  the entire volume passes a dict; not one passes a string**, so the v2.0.0
  signature `emit(msg: str, payload)` had zero matching callers. Under it,
  `edit_pptx`'s `list` action returned `{"success": true, "message": {"slides":
  [...]}}` — the data nested unreachably under `message`. A silent contract
  break, not a crash. The string path is byte-for-byte unchanged.
- **`artifact()`** — reconstructed from its two call sites and the house
  contract. Returns `download_files`, because the connector otherwise reports
  only files whose *bytes changed*, so a re-run producing identical output
  would return no link at all.
- **`fail_if_missing()`** — a labelled existence check. `require_existing_file`
  does the same test but says only "File not found"; this names the field.

### `code_integrity_lib.py` → v1.0.1

Three detection defects, each proven against a fixture before and after:

- **PHP superglobals are `$_GET`, not `$GET`.** The regex was
  `\$(GET|POST|REQUEST|SERVER)\[` — missing the underscore, so it could not
  match any real PHP file. The headline "raw superglobal access" check had
  never fired once.
- **Modern OpenAI keys were invisible.** `['\"]sk-[a-zA-Z0-9]{20,}['\"]` stops
  at the first hyphen, so project-scoped `sk-proj-…` keys failed the `{20,}`
  run before the closing quote. Character class widened; the legacy form still
  matches.
- **PHP concatenates with `.`, not `+`.** Every SQL-injection pattern was
  `+`-based, so the one language the spec names as a target (WordPress is PHP)
  was the one language uncovered. Three `.`-based patterns added, anchored on a
  quote so a qualified name is not misread.

**Before the fixes**, the spec's own T5 fixture — a PHP file with a hardcoded
key, raw `$_GET` and a concatenated `SELECT` — returned `status: pass`, **0
security errors**. After: `status: fail`, **exactly 3 class C errors**, matching
the spec's stated expectation.

---

## What was added

### `src/tools/edit-tools.js` (new, ~1,150 lines)

Four tools. The module imports `render-tools.js`'s already-exported primitives
(`resolveRenderer`, `runRenderer`, `parseRendererContract`, `detectInjectionKeys`,
the path and limit helpers) and **does not modify that file** — adding `export`
keywords to a 2,070-line module four shipped tools depend on is a change to the
render path, and this spec is additive. The small private helpers are duplicated
instead, with the reason recorded in the header.

**The argv mapping is the point.** The three editors disagree about spelling for
the same concept, and `--bold` is the sharpest case: argparse `store_true` on
the xlsx editor, a `true|false` string on the docx one. Passing `--bold false`
to the xlsx script sets bold **on** and leaves `false` as a stray positional.
One table gets this right once.

Also: source files are contained to uploads/downloads via `resolveContained`
(an edit tool accepting an arbitrary path is an arbitrary-file-write
primitive); `add_image` paths are contained identically; output names derive
from the source stem so two edits in a session cannot overwrite each other; and
the homework path stages a spec, honours `dry_run` from either the tool
parameter or the spec, and defaults `ttl_days` to 3.

### `src/tools/validation-tools.js` (new, ~800 lines)

Three tools sharing one contract. Two things it gets right that a hand-built
`script_execute` call routinely does not:

- **`--input` names a staged JSON spec, not the target file.** Appendix A of the
  spec records the first build getting this inverted.
- **The verdict is `status`, never the exit code.** All three validators print a
  report and exit 0 whether the verdict is pass, warnings or fail. Reading the
  exit code reports every failing file as a broken tool.

**Platform resolution is done gateway-side**, and it is not cosmetic. The ERP
validator matches with `key.lower() in platform.lower()`, so `platform: "sap"`
yields *"No platform-specific pattern set"* and **passes** — a document full of
T-codes, IMG and SPRO paths comes back clean. A validator that silently skips
its most important check is worse than none, because the caller reads the pass
as evidence. Aliases are normalised to the exact key, the document's own
`Platform Version:` header is sniffed when the caller says nothing, and when
neither is available the response says so explicitly rather than implying the
checks ran.

The validators also live in a **nested** `scripts/scripts/` directory, unlike
every renderer. The constants reflect that.

### `src/server-http.js` — five additive insertion points

Imports, startup flags, the advertised `TOOLS` array, the dispatcher, and the
diagnostics endpoint. **70 lines added, 1 line removed** — that one line being
the duplicate-name guard, rewritten to include the new definitions so a future
collision is caught at startup rather than by whichever `case` the switch
reaches first. No existing function was modified.

---

## Verification

| Check | Result |
|---|---|
| `npm run test:edit-tools` | **50/50** |
| `npm run test:validation-tools` | **38/38** |
| `npm run test:render-tools` (regression) | **74/74**, unchanged |
| `npm run test:gateway-tools` (all three) | **162/162** |
| Live edit tools vs the **real volume scripts** | **33/33** |
| Live validation tools vs the **real volume scripts** | **49/49** |
| Wiring under every flag combination | **17/17** |
| Syntax check, every changed and added file | pass |

The live runs are not stub theatre. The journey-map acceptance test from
SPEC-GTW-TOOL-001 §6 is proven by reading the output workbook: fill `FFAEC9F6`
applied, cell displays `48213` and links to the work item — and the untouched
cells survive, `=LEN(B2)` intact, column width 42 intact, an unrelated header
still Georgia 14pt bold-italic-underlined. Homework answer leakage is checked
against the raw DOCX **bytes**, not just extracted text.

The unit tests use stubs because the volume scripts are not in this repository;
each test file states plainly what that does and does not prove.

---

## A defect found by running it, not by reading it

The first implementation treated an empty download-links array as "no file
produced". But `buildDownloadLinks` also returns empty when `CONNECTOR_URL` is
unset — so the tool reported *"nothing can be delivered to the user"* while the
finished document sat in the downloads directory, sending an operator to debug
the editor instead of the configuration. Now the filesystem is consulted and
the two states are reported separately, with `download_url_unavailable` naming
the actual cause.

**`render-tools.js` has the same shape at its `no_output_produced` branch and
likely the same latent behaviour.** It was not touched, per the instruction not
to modify unaffected code. Worth a follow-up.

---

## Two further findings, unowned by these specs

- **`buildScriptEnv` forwards neither `DOCUMENT_DOWNLOADS_DIR` nor
  `DOCUMENT_UPLOADS_DIR`.** Production works only because both sides
  independently default to `/data/downloads`. Set `DOWNLOADS_DIR` on the
  connector and the scripts keep writing to the default while the connector
  diffs an empty directory. Pre-existing; affects the render tools equally.
- **`homework_render.py` also imports `spec_render_common.py`**, which is not in
  the four-file list SPEC-GTW-TOOL-001 §3 gives. Both must be present.
