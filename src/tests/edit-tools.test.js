// src/tests/edit-tools.test.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-TOOL-001 acceptance and regression cover for src/tools/edit-tools.js.
//
// WHAT IS REAL HERE AND WHAT IS NOT
// ---------------------------------
// The editor scripts (document-processingedit_xlsx.py, ...edit_docx.py,
// ...edit_pptx.py, homework_render.py) live on the Railway volume and are not
// in this repository, so they cannot be imported or executed from a test run.
//
// These tests therefore install STUB editors: small, real Python scripts
// written to a temporary scripts directory, which echo the argv they received,
// write real bytes into a temporary downloads directory, and print the JSON
// contract on stdout. Every layer this module owns is genuinely exercised --
// source containment, per-action argv mapping, parameter validation, staging,
// subprocess spawn with the minimal environment, contract parsing and download
// link assembly.
//
// What is NOT proven here is the behaviour of the real editors. That was
// verified separately against the volume scripts: an .xlsx round trip preserved
// an untouched =LEN(B2) formula, a 42-character column width and an unrelated
// Georgia 14pt bold-italic-underlined header cell while applying an AEC9F6 fill
// and a work-item hyperlink; a .docx replace_text reached body, table and
// footer in one call; and a homework render produced a DOCX and an HTML preview
// with no answer string surviving anywhere in the DOCX BYTES.
//
// THE ARGV MAPPING IS THE POINT OF THIS FILE
// ------------------------------------------
// The three editors disagree about flag spelling for the same concept
// (--font-size vs --font_size), and `--bold` is argparse store_true on the xlsx
// editor but a string on the docx one. Passing "--bold false" to the xlsx
// editor sets bold ON and leaves a stray positional. The stubs echo argv so
// those mappings are asserted directly rather than inferred.
//
// Run:  node --test src/tests/edit-tools.test.js
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDIT_TOOL_DEFINITIONS,
  EDIT_TOOL_NAMES,
  dispatchEditTool,
  editToolsEnabled,
  editToolsStatus,
  editedOutputName,
  resolveSourceFile,
  validateEditArgs,
  precheckHomeworkSpec,
} from '../tools/edit-tools.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root, scriptsDir, uploadsDir, downloadsDir, stagingDir, savedEnv;

/**
 * A stub editor that echoes argv and writes an output file.
 *
 * Reads --output from argv, writes bytes there, and prints the doc_common
 * success contract with the argv it saw under `argv_seen`.
 */
const STUB_EDITOR = `#!/usr/bin/env python3
import json, sys, os
argv = sys.argv[1:]
out = None
for i, a in enumerate(argv):
    if a == "--output" and i + 1 < len(argv):
        out = argv[i + 1]
name = os.path.basename(out) if out else ""
if out:
    with open(out, "wb") as fh:
        fh.write(b"STUB-EDITED-BYTES")
print(json.dumps({
    "success": True,
    "message": "Stub edit complete.",
    "file": name,
    "filename": name,
    "size_bytes": 17,
    "download_files": [name] if name else [],
    "argv_seen": argv,
}))
`;

/** A stub that fails with the house error contract. */
const STUB_FAILS = `#!/usr/bin/env python3
import json, sys
print(json.dumps({"success": False, "error": "Worksheet not found: Ghost", "code": "SHEET_NOT_FOUND"}))
sys.exit(1)
`;

/** A stub that claims success and writes nothing at all. */
const STUB_SILENT = `#!/usr/bin/env python3
import json
print(json.dumps({"success": True, "message": "Done."}))
`;

/** A homework stub honouring --dry-run. */
const STUB_HOMEWORK = `#!/usr/bin/env python3
import json, sys, os
argv = sys.argv[1:]
spec_path = None
for i, a in enumerate(argv):
    if a == "--input" and i + 1 < len(argv):
        spec_path = argv[i + 1]
spec = json.load(open(spec_path)) if spec_path else {}
if "--dry-run" in argv:
    print(json.dumps({"success": True, "valid": False, "errors": ["stub says section 2 has no questions"],
                      "question_count": 0}))
    sys.exit(0)
downloads = os.environ["TEST_DOWNLOADS_DIR"]
names = []
for ext in ("docx", "html"):
    n = "homework." + ext
    with open(os.path.join(downloads, n), "wb") as fh:
        fh.write(b"HOMEWORK-BYTES-" + ext.encode())
    names.append(n)
print(json.dumps({
    "success": True, "file": names[0], "filename": names[0], "preview_file": names[1],
    "size_bytes": 20, "download_files": names,
    "question_count": sum(len(s.get("questions", [])) for s in spec.get("sections", [])),
    "ttl_days_seen": spec.get("ttl_days"),
    "answers_present": any("answer" in q for s in spec.get("sections", []) for q in s.get("questions", [])),
    "sidebar_registration": {"registered": False, "reason": "stub"},
}))
`;

function writeScript(name, body) {
  const path = join(scriptsDir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/** Parse an MCP tool result back into its payload. */
function payload(result) {
  return JSON.parse(result.content[0].text);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-tools-test-'));
  scriptsDir = join(root, 'scripts');
  uploadsDir = join(root, 'uploads');
  downloadsDir = join(root, 'downloads');
  stagingDir = join(root, 'staging');
  for (const d of [scriptsDir, uploadsDir, downloadsDir, stagingDir]) mkdirSync(d, { recursive: true });

  savedEnv = { ...process.env };

  process.env.SCRIPTS_DIR = scriptsDir;
  process.env.USER_DATA_UPLOAD_DIR = uploadsDir;
  process.env.DOWNLOADS_DIR = downloadsDir;
  process.env.RENDER_STAGING_DIR = stagingDir;
  process.env.EDIT_TOOLS_ENABLED = 'true';
  process.env.CONNECTOR_URL = 'https://connector.test';

  // The homework stub needs to know where the downloads directory is.
  // buildScriptEnv() constructs the child environment FROM SCRATCH, so nothing
  // reaches a subprocess unless it is granted explicitly -- and routing the
  // stub's one variable through the grant manifest proves that, rather than
  // assuming it. The editor stubs need no grant: they learn their destination
  // from the --output path the gateway maps for them.
  process.env.SCRIPT_GRANTABLE_ENV = 'TEST_DOWNLOADS_DIR';
  process.env.TEST_DOWNLOADS_DIR = downloadsDir;
  process.env.SCRIPT_ENV_MANIFEST = JSON.stringify({
    'stub_homework.py': ['TEST_DOWNLOADS_DIR'],
  });

  // The gateway constants point at the stubs.
  process.env.EDIT_SCRIPT_XLSX = 'stub_xlsx.py';
  process.env.EDIT_SCRIPT_DOCX = 'stub_docx.py';
  process.env.EDIT_SCRIPT_PPTX = 'stub_pptx.py';
  process.env.EDIT_SCRIPT_HOMEWORK = 'stub_homework.py';

  writeScript('stub_xlsx.py', STUB_EDITOR);
  writeScript('stub_docx.py', STUB_EDITOR);
  writeScript('stub_pptx.py', STUB_EDITOR);
  writeScript('stub_homework.py', STUB_HOMEWORK);
  writeScript('stub_fails.py', STUB_FAILS);
  writeScript('stub_silent.py', STUB_SILENT);

  // Source fixtures. Contents are irrelevant to the stubs; existence is not.
  writeFileSync(join(uploadsDir, 'journey-map.xlsx'), 'x');
  writeFileSync(join(uploadsDir, 'report.docx'), 'x');
  writeFileSync(join(uploadsDir, 'deck.pptx'), 'x');
  writeFileSync(join(uploadsDir, 'diagram.png'), 'x');
  writeFileSync(join(uploadsDir, 'notes.txt'), 'x');
});

after(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of readdirSync(downloadsDir)) rmSync(join(downloadsDir, f), { force: true });
});

/** argv the stub reported for the last call. */
function argvOf(p) {
  return (p.editor_contract && p.editor_contract.argv_seen) || [];
}

/** The value following `flag` in an argv array, or undefined. */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// ===========================================================================

describe('tool definitions', () => {
  test('registers exactly the four tools the spec names', () => {
    assert.deepEqual(
      EDIT_TOOL_DEFINITIONS.map((t) => t.name),
      ['xlsx_edit', 'docx_edit', 'pptx_edit', 'homework_render']
    );
    assert.equal(EDIT_TOOL_NAMES.size, 4);
  });

  test('every definition carries a schema with required fields', () => {
    for (const def of EDIT_TOOL_DEFINITIONS) {
      assert.ok(def.description.length > 80, `${def.name} needs a description that guides selection`);
      assert.equal(def.inputSchema.type, 'object');
      assert.ok(Array.isArray(def.inputSchema.required) && def.inputSchema.required.length > 0);
    }
  });

  test('no schema exposes a script path, which is what makes injection inert', () => {
    for (const def of EDIT_TOOL_DEFINITIONS) {
      const keys = Object.keys(def.inputSchema.properties);
      for (const forbidden of ['script', 'script_path', 'command', 'interpreter', 'python']) {
        assert.ok(!keys.includes(forbidden), `${def.name} must not expose ${forbidden}`);
      }
    }
  });

  test('the editors steer the caller away from the render tools', () => {
    // A model choosing xlsx_render for an existing workbook loses every
    // formula and style in it. The description is the only thing preventing
    // that, so its content is asserted rather than assumed.
    const xlsx = EDIT_TOOL_DEFINITIONS.find((t) => t.name === 'xlsx_edit');
    assert.match(xlsx.description, /instead of xlsx_render/i);
    assert.match(xlsx.description, /existing/i);
  });

  test('the homework schema requires an answer on every question', () => {
    const hw = EDIT_TOOL_DEFINITIONS.find((t) => t.name === 'homework_render');
    const q = hw.inputSchema.properties.spec.properties.sections.items.properties.questions.items;
    assert.ok(q.required.includes('answer'));
    assert.match(q.properties.answer.description, /never written to the output|stripped/i);
  });
});

describe('feature flag', () => {
  test('reads the current environment rather than a captured value', () => {
    process.env.EDIT_TOOLS_ENABLED = 'false';
    assert.equal(editToolsEnabled(), false);
    process.env.EDIT_TOOLS_ENABLED = 'TRUE';
    assert.equal(editToolsEnabled(), true);
    process.env.EDIT_TOOLS_ENABLED = 'true';
  });

  test('a disabled connector refuses and names the flag', async () => {
    process.env.EDIT_TOOLS_ENABLED = 'false';
    const p = payload(await dispatchEditTool('xlsx_edit', { source_file: 'journey-map.xlsx', action: 'list' }));
    process.env.EDIT_TOOLS_ENABLED = 'true';
    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'feature_disabled');
    assert.match(p.error, /EDIT_TOOLS_ENABLED/);
    // The fallback must be named, or a disabled flag reads as "impossible".
    assert.match(p.error, /script_execute/);
  });

  test('a name this module does not own returns null so the caller can fall through', async () => {
    assert.equal(await dispatchEditTool('document_render', {}), null);
    assert.equal(await dispatchEditTool('code_syntax', {}), null);
  });
});

describe('source containment', () => {
  test('a bare filename resolves against uploads', () => {
    const r = resolveSourceFile('journey-map.xlsx', new Set(['.xlsx']));
    assert.equal(r.ok, true);
    assert.equal(r.from, 'uploads');
  });

  test('downloads is searched after uploads, so an edited file can be edited again', () => {
    writeFileSync(join(downloadsDir, 'edited-journey-map.xlsx'), 'x');
    const r = resolveSourceFile('edited-journey-map.xlsx', new Set(['.xlsx']));
    assert.equal(r.ok, true);
    assert.equal(r.from, 'downloads');
  });

  test('traversal is refused', () => {
    for (const evil of ['../../etc/passwd.xlsx', '/etc/passwd.xlsx', 'a/../../../../etc/shadow.xlsx']) {
      const r = resolveSourceFile(evil, new Set(['.xlsx']));
      assert.equal(r.ok, false, `${evil} must not resolve`);
      assert.equal(r.kind, 'source_not_found');
    }
  });

  test('the wrong extension is rejected before a subprocess is spawned', () => {
    const r = resolveSourceFile('notes.txt', new Set(['.xlsx', '.xlsm']));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'wrong_extension');
    // The message must say what IS accepted, or the caller guesses.
    assert.match(r.message, /\.xlsx/);
  });

  test('a missing file names both directories it looked in', () => {
    const r = resolveSourceFile('nope.xlsx', new Set(['.xlsx']));
    assert.equal(r.kind, 'source_not_found');
    assert.match(r.message, /uploads/);
    assert.match(r.message, /downloads/);
  });
});

describe('output naming', () => {
  test('derives from the source stem so two edits do not collide', () => {
    assert.equal(editedOutputName('journey-map.xlsx', '.xlsx'), 'edited-journey-map.xlsx');
    assert.equal(editedOutputName('Q3 Report.docx', '.docx'), 'edited-Q3 Report.docx');
  });

  test('an override is honoured but stripped to a bare filename', () => {
    assert.equal(editedOutputName('a.xlsx', '.xlsx', 'custom'), 'custom.xlsx');
    assert.equal(editedOutputName('a.xlsx', '.xlsx', 'custom.xlsx'), 'custom.xlsx');
    // An override is caller-controlled, so it must not be able to escape.
    assert.equal(editedOutputName('a.xlsx', '.xlsx', '/etc/passwd'), 'passwd.xlsx');
    assert.equal(editedOutputName('a.xlsx', '.xlsx', '../../evil'), 'evil.xlsx');
  });
});

describe('parameter validation', () => {
  test('T11: an unknown action is rejected and the alternatives are listed', () => {
    const errors = validateEditArgs('docx_edit', { action: 'transmogrify' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Unknown action/);
    assert.match(errors[0], /replace_text/);
  });

  test('a required parameter missing for the chosen action is named', () => {
    assert.match(validateEditArgs('docx_edit', { action: 'replace_text' })[0], /old is required/);
    assert.match(validateEditArgs('pptx_edit', { action: 'add_slide' })[0], /title is required/);
    assert.match(validateEditArgs('xlsx_edit', { action: 'set_cell' })[0], /cell is required/);
    assert.match(validateEditArgs('xlsx_edit', { action: 'rename_sheet', old: 'a' })[0], /new is required/);
  });

  test('an empty old on replace_text is refused rather than silently doing nothing', () => {
    // The editors treat an empty --old as "replace nothing" and exit 0, which
    // would report a successful edit that changed not one character.
    assert.ok(validateEditArgs('docx_edit', { action: 'replace_text', old: '' }).length > 0);
    assert.ok(validateEditArgs('docx_edit', { action: 'replace_text', old: '   ' }).length > 0);
  });

  test('add_row requires a non-empty array, not a string', () => {
    assert.ok(validateEditArgs('xlsx_edit', { action: 'add_row', values: [] }).length > 0);
    assert.ok(validateEditArgs('xlsx_edit', { action: 'add_row', values: 'a,b' }).length > 0);
    assert.equal(validateEditArgs('xlsx_edit', { action: 'add_row', values: ['a', 'b'] }).length, 0);
  });

  test('hex colours are validated with or without a leading hash', () => {
    assert.equal(validateEditArgs('xlsx_edit', { action: 'set_cell', cell: 'A1', bg_color: '#AEC9F6' }).length, 0);
    assert.equal(validateEditArgs('xlsx_edit', { action: 'set_cell', cell: 'A1', bg_color: 'AEC9F6' }).length, 0);
    assert.equal(validateEditArgs('xlsx_edit', { action: 'set_cell', cell: 'A1', bg_color: 'blue' }).length, 1);
    assert.equal(validateEditArgs('xlsx_edit', { action: 'set_cell', cell: 'A1', bg_color: '#ABC' }).length, 1);
  });

  test('a hyperlink target must be http(s) or mailto', () => {
    const ok = (t) => validateEditArgs('xlsx_edit', { action: 'set_cell', cell: 'A1', hyperlink_target: t }).length === 0;
    assert.ok(ok('https://dev.azure.com/org/proj/_workitems/edit/48213'));
    assert.ok(ok('mailto:someone@example.com'));
    // A javascript: URL in a spreadsheet cell is a live payload on click.
    assert.ok(!ok('javascript:alert(1)'));
    assert.ok(!ok('file:///etc/passwd'));
  });
});

describe('argv mapping, where the three editors disagree', () => {
  test('xlsx --bold is a store_true flag and is never emitted as a value', async () => {
    // "--bold false" on the xlsx editor sets bold ON and leaves "false" as a
    // stray positional. This is the single sharpest reason this module exists.
    const on = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'set_cell', cell: 'A1', value: 'x', bold: true,
    }));
    const argv = argvOf(on);
    assert.ok(argv.includes('--bold'));
    assert.equal(flagValue(argv, '--bold'), undefined, '--bold must be the last flag or followed by another flag');

    const off = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'set_cell', cell: 'A1', value: 'x', bold: false,
    }));
    assert.ok(!argvOf(off).includes('--bold'), 'bold:false must omit the flag entirely');
  });

  test('docx --bold IS a value, and false means false', async () => {
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_paragraph', text: 'Hello', bold: false,
    }));
    assert.equal(flagValue(argvOf(p), '--bold'), 'false');
  });

  test('font size is hyphenated for xlsx and underscored for docx', async () => {
    const x = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'set_cell', cell: 'A1', value: 'x', font_size: 14,
    }));
    assert.equal(flagValue(argvOf(x), '--font-size'), '14');

    const d = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_paragraph', text: 'Hello', font_size: 14,
    }));
    assert.equal(flagValue(argvOf(d), '--font_size'), '14');
  });

  test('add_row values are serialised to a JSON array string', async () => {
    const p = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'add_row', values: ['J1', 48213, null],
    }));
    // The script parses this with json.loads; a bare comma-joined string fails.
    assert.deepEqual(JSON.parse(flagValue(argvOf(p), '--values')), ['J1', 48213, '']);
  });

  test('the accent hash is stripped, because the docx editor wants it bare', async () => {
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'recolour', accent: '#1F4E79',
    }));
    assert.equal(flagValue(argvOf(p), '--accent'), '1F4E79');
  });

  test('a hyperlink target reaches the script as --hyperlink-target', async () => {
    const url = 'https://dev.azure.com/org/proj/_workitems/edit/48213';
    const p = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'set_cell', cell: 'D2', value: '48213', hyperlink_target: url,
    }));
    assert.equal(flagValue(argvOf(p), '--hyperlink-target'), url);
    // The display value survives alongside the link: that is the whole feature.
    assert.equal(flagValue(argvOf(p), '--value'), '48213');
  });

  test('parameters irrelevant to the action are not forwarded', async () => {
    // A stray slide_index on a docx call would otherwise become an argparse
    // rejection from a script that never declared it.
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_paragraph', text: 'Hello', slide_index: 3, cell: 'A1',
    }));
    const argv = argvOf(p);
    assert.ok(!argv.includes('--slide-index'));
    assert.ok(!argv.includes('--cell'));
  });

  test('pptx slide_index is forwarded only for the actions that read it', async () => {
    const img = payload(await dispatchEditTool('pptx_edit', {
      source_file: 'deck.pptx', action: 'add_image', image: 'diagram.png', slide_index: 2,
    }));
    assert.equal(flagValue(argvOf(img), '--slide-index'), '2');

    const rep = payload(await dispatchEditTool('pptx_edit', {
      source_file: 'deck.pptx', action: 'replace_text', old: 'a', new: 'b', slide_index: 2,
    }));
    assert.ok(!argvOf(rep).includes('--slide-index'));
  });

  test('the source is passed as an absolute contained path, never as the raw input', async () => {
    const p = payload(await dispatchEditTool('xlsx_edit', { source_file: 'journey-map.xlsx', action: 'list' }));
    assert.equal(flagValue(argvOf(p), '--input'), join(uploadsDir, 'journey-map.xlsx'));
  });
});

describe('images are contained like any other file input', () => {
  test('an image outside the allowed directories is refused', async () => {
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_image', image: '/etc/passwd',
    }));
    assert.equal(p.ok, false);
    // Refused on the extension first, which is the earliest possible refusal.
    assert.ok(['wrong_extension', 'source_not_found'].includes(p.error_kind));
  });

  test('a contained image is passed as an absolute path', async () => {
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_image', image: 'diagram.png',
    }));
    assert.equal(p.ok, true);
    assert.equal(flagValue(argvOf(p), '--image'), join(uploadsDir, 'diagram.png'));
  });

  test('a traversal image path is refused', async () => {
    const p = payload(await dispatchEditTool('pptx_edit', {
      source_file: 'deck.pptx', action: 'add_image', image: '../../../../etc/hosts.png',
    }));
    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'source_not_found');
  });
});

describe('injection', () => {
  test('T13: a caller-supplied script path is ignored and reported', async () => {
    const p = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'list',
      script_path: '/tmp/evil.py', command: 'rm -rf /', interpreter: '/tmp/py',
    }));
    assert.ok(Array.isArray(p.ignored_parameters));
    assert.ok(p.ignored_parameters.includes('script_path'));
    // Ignored means ignored: the stub still ran.
    assert.equal(p.ok, true);
    assert.equal(p.editor, 'stub_xlsx.py');
  });
});

describe('failure handling', () => {
  test('an editor error contract is surfaced with its code, not swallowed', async () => {
    process.env.EDIT_SCRIPT_XLSX = 'stub_fails.py';
    const p = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'delete_sheet', name: 'Ghost',
    }));
    process.env.EDIT_SCRIPT_XLSX = 'stub_xlsx.py';
    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'edit_failed');
    assert.match(p.error, /Worksheet not found/);
    assert.equal(p.editor_code, 'SHEET_NOT_FOUND');
  });

  test('success with no file written is reported as a failure, not an empty success', async () => {
    process.env.EDIT_SCRIPT_DOCX = 'stub_silent.py';
    const p = payload(await dispatchEditTool('docx_edit', {
      source_file: 'report.docx', action: 'add_page_break',
    }));
    process.env.EDIT_SCRIPT_DOCX = 'stub_docx.py';
    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'no_output_produced');
  });

  test('a missing editor script is reported as missing, with the directory', async () => {
    process.env.EDIT_SCRIPT_PPTX = 'not_here.py';
    const p = payload(await dispatchEditTool('pptx_edit', { source_file: 'deck.pptx', action: 'list' }));
    process.env.EDIT_SCRIPT_PPTX = 'stub_pptx.py';
    assert.equal(p.ok, false);
    assert.ok(p.scripts_dir);
  });

  test('a written file with no buildable URL is a success, not no_output_produced', async () => {
    // buildDownloadLinks returns nothing when CONNECTOR_URL is unset. Treating
    // that as "no file produced" told the operator the edit failed while the
    // finished document sat in the downloads directory.
    const saved = process.env.CONNECTOR_URL;
    delete process.env.CONNECTOR_URL;
    const p = payload(await dispatchEditTool('xlsx_edit', {
      source_file: 'journey-map.xlsx', action: 'set_cell', cell: 'A1', value: 'x',
    }));
    process.env.CONNECTOR_URL = saved;

    assert.equal(p.ok, true, 'the edit completed, so it must not be reported as a failure');
    assert.equal(p.output_file, 'edited-journey-map.xlsx');
    assert.match(p.download_url_unavailable, /CONNECTOR_URL/);
    assert.ok(existsSync(join(downloadsDir, 'edited-journey-map.xlsx')));
  });
});

describe('read-only actions', () => {
  test('list reports no output file and is not failed for producing none', async () => {
    process.env.EDIT_SCRIPT_XLSX = 'stub_silent.py';
    const p = payload(await dispatchEditTool('xlsx_edit', { source_file: 'journey-map.xlsx', action: 'list' }));
    process.env.EDIT_SCRIPT_XLSX = 'stub_xlsx.py';
    assert.equal(p.ok, true);
    assert.equal(p.output_file, undefined);
  });
});

describe('homework_render', () => {
  const goodSpec = () => ({
    title: 'Algebra Practice',
    student_name: 'Sam',
    subject: 'Mathematics',
    session_date: '2026-08-14',
    due_date: '2026-08-21',
    instructions: 'Show all working.',
    sections: [{ topic: 'Linear', difficulty: 'Core', questions: [
      { number: 1, text: 'Solve 2x = 12', answer: '6' },
      { number: 2, text: 'Solve 3x = 9', answer: '3' },
    ] }],
  });

  test('the gateway pre-check catches an empty spec without a subprocess', () => {
    assert.ok(precheckHomeworkSpec({}).length >= 6);
    assert.ok(precheckHomeworkSpec({ ...goodSpec(), sections: [] }).some((e) => /sections/.test(e)));
    assert.equal(precheckHomeworkSpec(goodSpec()).length, 0);
  });

  test('a dry run returns a verdict rather than an error, with the errors whole', async () => {
    const p = payload(await dispatchEditTool('homework_render', { spec: goodSpec(), dry_run: true }));
    assert.equal(p.ok, true, 'an invalid spec is an answer, not a tool malfunction');
    assert.equal(p.dry_run, true);
    assert.equal(p.valid, false);
    // Passed through verbatim: a trimmed error list is how a broken spec
    // reaches a student.
    assert.deepEqual(p.errors, ['stub says section 2 has no questions']);
    assert.equal(readdirSync(downloadsDir).length, 0, 'a dry run writes nothing');
  });

  test('dry_run inside the spec is honoured as well as the tool parameter', async () => {
    const spec = { ...goodSpec(), dry_run: true };
    const p = payload(await dispatchEditTool('homework_render', { spec }));
    assert.equal(p.dry_run, true);
    assert.equal(readdirSync(downloadsDir).length, 0);
  });

  test('a spec failing the pre-check in dry-run mode reports a verdict too', async () => {
    const p = payload(await dispatchEditTool('homework_render', { spec: { title: 'x' }, dry_run: true }));
    assert.equal(p.ok, true);
    assert.equal(p.valid, false);
    assert.equal(p.validated_by, 'gateway_precheck');
  });

  test('a full render returns both artefacts and the question count', async () => {
    const p = payload(await dispatchEditTool('homework_render', { spec: goodSpec() }));
    assert.equal(p.ok, true);
    assert.equal(p.file, 'homework.docx');
    // Both artefacts must reach the caller: the DOCX is what the student
    // works on, the HTML is what the tutor previews before sending it.
    assert.ok(p.download_links.some((l) => l.filename === 'homework.docx'));
    assert.ok(p.download_links.some((l) => l.filename === 'homework.html'));
    assert.equal(p.question_count, 2);
  });

  test('answers are passed to the renderer, which is what lets it strip them', async () => {
    // The gateway must NOT strip answers itself: homework_common.strip_answers
    // is the single implementation, and a second one here could drift from it.
    const p = payload(await dispatchEditTool('homework_render', { spec: goodSpec() }));
    assert.equal(p.renderer_contract.answers_present, true);
  });

  test('ttl_days defaults to 3 and an explicit value is left alone', async () => {
    const a = payload(await dispatchEditTool('homework_render', { spec: goodSpec() }));
    assert.equal(a.renderer_contract.ttl_days_seen, 3);

    const b = payload(await dispatchEditTool('homework_render', { spec: { ...goodSpec(), ttl_days: 14 } }));
    assert.equal(b.renderer_contract.ttl_days_seen, 14);
  });

  test('the staged spec file is removed afterwards', async () => {
    await dispatchEditTool('homework_render', { spec: goodSpec() });
    const leftovers = readdirSync(stagingDir).filter((f) => f.startsWith('homework_render_'));
    assert.equal(leftovers.length, 0, 'staging must not accumulate spec files');
  });

  test('an oversized spec is refused without truncating anything', async () => {
    // specMaxBytes() clamps to a 1 KiB floor, so a smaller configured value is
    // raised to 1024 rather than honoured. The spec is padded past that floor
    // instead of setting an unreachable limit.
    const saved = process.env.RENDER_SPEC_MAX_BYTES;
    process.env.RENDER_SPEC_MAX_BYTES = '1024';
    const big = goodSpec();
    big.instructions = 'x'.repeat(2000);
    const p = payload(await dispatchEditTool('homework_render', { spec: big }));
    if (saved === undefined) delete process.env.RENDER_SPEC_MAX_BYTES;
    else process.env.RENDER_SPEC_MAX_BYTES = saved;

    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'spec_too_large');
    assert.match(p.error, /nothing was truncated/i);
  });
});

describe('status reporting', () => {
  test('reports which editors are actually present on the volume', () => {
    const s = editToolsStatus();
    assert.equal(s.enabled, true);
    assert.equal(s.scripts_dir, scriptsDir);
    assert.equal(s.editors['stub_xlsx.py'], 'present');
    assert.deepEqual([...s.tools].sort(), ['docx_edit', 'homework_render', 'pptx_edit', 'xlsx_edit']);
  });

  test('a missing editor is reported by its failure kind, not as present', () => {
    process.env.EDIT_SCRIPT_DOCX = 'absent.py';
    const s = editToolsStatus();
    process.env.EDIT_SCRIPT_DOCX = 'stub_docx.py';
    assert.notEqual(s.editors['absent.py'], 'present');
  });
});
