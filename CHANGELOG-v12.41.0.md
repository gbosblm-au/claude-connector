# claude-connector v12.41.0

**SPEC-GTW-DOC-001 — Hardcoded procedural document creation tools**

Registers four first-class render tools in the connector tool registry:
`document_render`, `pdf_render`, `xlsx_render`, `pptx_render`.

Purely additive. `script_execute` and every renderer script it can reach are
unchanged and remain fully available. Shipped behind `RENDER_TOOLS_ENABLED`,
**default off**, per spec section 9.

---

## Why

Document creation was previously reachable only through `script_execute`, which
carries three ceilings the calling session had to rediscover on every use:

| # | Root cause | Symptom |
|---|---|---|
| 4.1 | `input_data` silently truncates a large spec | A document that renders, exits 0, and is short. No error to notice. |
| 4.2 | `script_write` rejects over ~500 lines | The decomposed-builder workaround had to be re-derived each session. |
| 4.4 | Script name, flags, schema and output contract held only in memory | Re-derived by trial and error every session. |

All three are properties of the **caller**. This release moves them server-side.

---

## Two findings that shaped the implementation

### 1. The specification points at the wrong file

Spec section 8.1 states the connector lives under `gateway_src/` and that the
registry is `gateway_src/lib/tool-dispatch.js`. Neither is correct for this
codebase:

- `Gateway Service/lib/tool-dispatch.js` is the Deterministic Tool Dispatch
  Layer (leak recovery, intent routing). It contains no registry.
- The registry is the `TOOLS` array and the `dispatchToolCallCore` switch in
  `claude-connector/src/server-http.js`.
- There is a **second gate the spec never mentions**:
  `CONNECTOR_TOOL_CHAT_WHITELIST` in `Gateway Service/routes/ti-chat.js`.
  Connector tools absent from that set are filtered out before the model sees
  them. Registering these four without that entry would have shipped a change
  that looks complete on the connector and does nothing in chat. Handled in
  Gateway Service v2.95.0.

### 2. The `--output` defect, and what the deployed scripts actually say

`Gateway Service/lib/turn-supervisor.js` (`REMEDIATIONS` →
`argparse_unrecognised_output`) and `tests/turn-supervisor.test.js` record the
production failure:

```
usage: document_render.py [-h] [--input INPUT]
error: unrecognized arguments: --output /tmp/x
```

`script_execute` appends `--output <tmpdir>` unconditionally whenever
`input_data` is supplied. The renderers do not declare it. argparse exits 2
**before `main()` runs**, and because the output starts with `usage:` rather
than `Error:` and is not JSON, it was for a period classified as a *success*.

So the first argv form is `--input <specfile>` and nothing else.

**Confirmed against the deployed scripts.** A later connector volume snapshot
made the renderers readable. `document_render.py`, `xlsx_render.py` and
`pptx_render.py` all build the same parser:

```python
parser.add_argument("--input", default=None)
parser.add_argument("--dry-run", action="store_true")
add_output_arg(parser)          # --output, nargs="?", argparse.SUPPRESS
```

`--input` alone is correct and complete. The current builds also *absorb*
`--output` through `doc_common.add_output_arg`, so the argparse rejection
recorded in `turn-supervisor.js` came from a build that has since been patched.
`--input` alone works on both old and new builds, which is why it leads.

---

## What was added

### `src/tools/render-tools.js` (new)

Implements the spec section 7 procedural sequence, identically for all formats:

1. Validate against the tool's schema; reject with a structured error.
2. Check serialized spec size against `RENDER_SPEC_MAX_BYTES`; error explicitly.
3. Write the validated spec to a temp JSON file in the staging directory.
4. Resolve the renderer from a **gateway-side constant**, never from input.
5. Invoke via `spawnSync` with an argument array and no shell.
6. Capture the renderer's JSON contract from stdout.
7. Register the preview alongside the primary output.
8. Return the standard download contract.

**Argv fallback ladder.** The renderer scripts live on the Railway volume and
are not in this repository, and the volume is subject to snapshot reverts (spec
4.5). Each renderer therefore has a short ordered list of candidate argv forms.
A form is abandoned **only** when the process exits non-zero *and* the output
carries an argparse rejection signature — which by construction means argv was
rejected before any work was done. A runtime failure is never retried, because
the script ran and a retry could duplicate a partial effect. The form that
succeeded is reported as `argv_form` so an operator can pin it via
`RENDER_ARGV_FORMS` and remove the probe.

**Silent-success detection.** A renderer that exits 0 without writing a file
returns `no_output_produced` rather than an empty success. This is spec failure
4.1 caught at the gateway: the filesystem is checked, not the renderer's claim.

### `src/server-http.js` (modified)

- Import of the render module.
- `RENDER_TOOLS_ENABLED` startup constant, read exactly as `SKILL_ENABLED` is.
- Registration in `TOOLS`, gated on `SKILL_ENABLED && RENDER_TOOLS_ENABLED`.
- Four dispatch cases routed through one `dispatchRenderTool`, so the
  feature-flag check cannot be applied to three tools and forgotten on a fourth.
- Definitions added unconditionally to `buildEffectiveToolList()` (the Neural
  Core catalogue describes what *exists*, not what this deployment advertises).
- **Boot-time name-collision guard.** A duplicate tool name would add a second
  `case` for a name the switch already handles; JavaScript takes the first, so
  one tool would become silently unreachable with no error anywhere. The
  connector now refuses to start instead.
- `renderTools` diagnostics on the authenticated `/health` branch, reporting
  which renderers are actually present on the volume.

### `src/tests/render-tools.test.js` (new)

64 tests covering spec test cases T1–T10 plus regression cover.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_TOOLS_ENABLED` | *(off)* | Set to `true` to enable. Spec section 9 requires default-off for one release. |
| `RENDER_SPEC_MAX_BYTES` | `524288` | Serialized-spec ceiling. Clamped to 1KB–32MB. |
| `RENDER_TIMEOUT_SECONDS` | `180` | Subprocess timeout. Clamped to 10–900. |
| `RENDER_STAGING_DIR` | `/tmp/tenax_render_staging` | Where the validated spec is written. |
| `RENDER_SCRIPT_DOCX` | `document_render.py` | Operator override. Still containment-checked. |
| `RENDER_SCRIPT_XLSX` | `xlsx_render.py` | |
| `RENDER_SCRIPT_PPTX` | `pptx_render.py` | |
| `RENDER_SCRIPT_PDF` | `convert_docx_to_pdf.py` | |
| `RENDER_SCRIPT_PDF_FAITHFUL` | `docx_to_pdf_faithful.py` | Used when `options.faithful` is true. |
| `RENDER_ARGV_FORMS` | *(unset)* | JSON object pinning argv per script. Malformed values are logged and ignored. |

**To enable:** set `RENDER_TOOLS_ENABLED=true`. Nothing else is required.

---

## Security

- The renderer path is a gateway constant and is **never** read from tool input.
  No schema exposes one. Input keys such as `script_path`, `renderer`, `argv`
  and `command` are ignored and reported in `ignored_parameters` (spec T10).
- Renderer paths resolve through `resolveContained()`, so an operator override
  cannot escape the scripts directory or resolve through a symlink.
- `pdf_render` accepts a source only as a single-segment filename inside the
  downloads or uploads directory. A `source_url` is accepted **only** when it
  addresses this connector's own `/download/` route. **This module performs no
  outbound fetch, so it is not an SSRF primitive.**
- Subprocesses use `spawnSync` with an argument array and no shell, with the
  shared minimal environment from `utils/scriptEnv.js`. No credential is
  inherited; this is covered by a test that probes the child directly.
- Download URLs are built server-side by `utils/downloadLinks.js`. The download
  token never enters the model's context.

---

## Verification performed

| Check | Result |
|---|---|
| `node --test src/tests/render-tools.test.js` | **74 pass, 0 fail** |
| Pre-existing connector suites, baseline vs modified | **243 pass, 0 fail — identical** |
| Live boot, flag off / on | 142 tools / 146 tools; `script_execute` present in both |
| Live `POST /tool-call`, 138 sections incl. `subheading` | 138 sent, **138 received** |
| Live `dry_run` | `validated_by: renderer`, renderer summary returned, **0 files written** |
| Live `pdf_render` with `output_name` | `--input <abs> --pdf-name Board_Pack_Q3` → `Board_Pack_Q3.pdf` |
| Live T10 injection | `ignored_parameters: ["script_path","argv"]` |

Test stubs reproduce the real argparse parsers and the `doc_common` JSON
envelope, including the `--output`-absorbing behaviour, so the argv assertions
mean what they claim.

### Mutation testing

Every guarantee was verified by breaking it:

| Mutation | Tests failed |
|---|---|
| `--output` reinstated in the first spec argv form | 21 |
| LibreOffice converter driven by `--output` (the silent `output_name` bug) | 2 |
| Relative source path sent to the converter | 5 |
| `--dry-run` not passed to the renderer | 3 |
| `VALIDATION_FAILED` misreported as `render_failed` | 3 |
| Renderer-declared `download_files` ignored | 1 |
| Size ceiling removed | 2 |
| Injection reporting disabled | 2 |
| Silent-success detection removed | 2 |

---

## Known limitations

1. **The renderer scripts still are not part of this repository.** They live on
   the Railway volume. The contracts above were read from a volume snapshot and
   are reproduced by test stubs, but a volume revert to an older build could
   change them. `renderToolsStatus()` on `/health` reports which renderers are
   present, and `argv_form` in every result reports what was actually sent.

2. **T2 still needs one run on the volume.** The 138-section transport is proven
   end to end against a faithful stub. That `document_render.py` then *lays out*
   138 sections correctly must be confirmed once against
   `accounts-payable-end-to-end-process.docx`.

3. **`document-render.md` was not updated** (spec 8.3). That protocol file is
   not present in any supplied archive.

4. **The spec's schema tables (6.1 to 6.4) are now known to be inaccurate.**
   They are superseded by the renderers. The tool descriptions in this module
   describe the renderers' real shapes; the change specification should be
   corrected separately.
