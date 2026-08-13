// src/tests/render-tools.test.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-DOC-001 acceptance and regression cover for src/tools/render-tools.js.
//
// WHAT IS REAL HERE AND WHAT IS NOT
// ---------------------------------
// The renderer scripts (document_render.py, xlsx_render.py, pptx_render.py,
// convert_docx_to_pdf.py, docx_to_pdf_faithful.py) live on the Railway volume
// and are not in this repository. They cannot be imported, read or executed
// from a test run.
//
// So these tests install STUB renderers: small, real Python scripts written to
// a temporary scripts directory, which read the staged spec file, write real
// bytes into a temporary downloads directory, and print a JSON contract on
// stdout. Every layer this module owns is therefore genuinely exercised --
// validation, the size ceiling, staging to disk, containment, subprocess spawn
// with the minimal environment, argv-ladder behaviour, contract parsing, and
// download-link assembly.
//
// What is NOT proven here is the internal behaviour of the real renderers. The
// spec's T2 acceptance fixture (the 138-section AP document) is exercised
// against a stub that counts what it received, which proves the gateway
// transports 138 sections without truncation. Proving that document_render.py
// then LAYS OUT 138 sections correctly requires one run on the volume, and is
// called out in the CHANGELOG as the remaining manual step.
//
// The stubs are deliberately written in the two argparse dialects that matter:
//
//   ok_renderer.py       declares --input only, and REJECTS --output.
//                        This reproduces the exact production failure recorded
//                        in Gateway Service lib/turn-supervisor.js, and is what
//                        makes the "first argv form is --input alone" assertion
//                        meaningful rather than incidental.
//   needs_output.py      declares --input AND requires --output.
//                        Proves the ladder advances on an argparse rejection.
//
// Run:  node --test src/tests/render-tools.test.js
// ---------------------------------------------------------------------------

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateDocumentSpec,
  validateSheetsSpec,
  validateSlidesSpec,
  validatePdfInput,
  detectInjectionKeys,
  isArgvRejection,
  parseRendererContract,
  resolveRenderer,
  resolvePdfSource,
  argvFormsFor,
  specMaxBytes,
  renderToolsEnabled,
  renderToolsStatus,
  dispatchRenderTool,
  handleDocumentRender,
  handleXlsxRender,
  handlePptxRender,
  handlePdfRender,
  RENDER_TOOL_DEFINITIONS,
  RENDER_TOOL_NAMES,
  SECTION_TYPES,
  CALLOUT_STYLES,
} from '../tools/render-tools.js';

// ---------------------------------------------------------------------------
// Environment scaffolding
// ---------------------------------------------------------------------------

/** Every environment key any test in this file mutates. */
const ENV_KEYS = [
  'RENDER_TOOLS_ENABLED', 'SCRIPTS_DIR', 'DOWNLOADS_DIR', 'USER_DATA_UPLOAD_DIR',
  'RENDER_STAGING_DIR', 'RENDER_SPEC_MAX_BYTES', 'RENDER_TIMEOUT_SECONDS',
  'RENDER_ARGV_FORMS', 'RENDER_SCRIPT_DOCX', 'RENDER_SCRIPT_XLSX',
  'RENDER_SCRIPT_PPTX', 'RENDER_SCRIPT_PDF', 'RENDER_SCRIPT_PDF_FAITHFUL',
  'CONNECTOR_URL', 'RAILWAY_PUBLIC_DOMAIN', 'DOCUMENT_DOWNLOAD_TOKEN',
  'ENABLE_SIGNED_LINKS', 'SIGNED_URL_SECRET', 'SCRIPT_GRANTABLE_ENV',
  'SCRIPT_ENV_MANIFEST', 'SECRET_CANARY',
];

let saved;
let root;
let scriptsDir;
let downloadsDir;
let uploadsDir;
let stagingDir;

/**
 * A stub renderer that accepts --input only.
 *
 * Reproduces the production argparse contract: `[-h] [--input INPUT]`, with
 * --output NOT declared, so argparse exits 2 before main() runs if it is
 * supplied. That rejection is the whole reason this module does not append
 * --output.
 *
 * @param {string} ext        Output extension, e.g. ".docx".
 * @param {boolean} preview   Also write a matching .html preview.
 * @returns {string} Python source.
 */
function okRendererSource( ext, preview ) {
  return `#!/usr/bin/env python3
import argparse, json, os, re, sys

# Mirrors the deployed renderers: --input, --dry-run, and an --output that is
# accepted and discarded (doc_common.add_output_arg). Reproducing the real
# parser here is the point -- a stub that accepted a different argv would make
# the argv assertions meaningless.
parser = argparse.ArgumentParser()
parser.add_argument("--input", default=None)
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--output", nargs="?", default=None, help=argparse.SUPPRESS)
args = parser.parse_args()

with open(args.input, "r", encoding="utf-8") as fh:
    spec = json.load(fh)

units = len(spec.get("sections") or spec.get("sheets") or spec.get("slides") or [])

# The authoritative validator lives in the renderer, so the stub carries a
# stand-in for it: a section/sheet/slide whose type is "explode" is rejected
# the way spec_render_common.validate_spec rejects an unknown type.
errors = []
for i, item in enumerate(spec.get("sections") or spec.get("sheets") or spec.get("slides") or []):
    if isinstance(item, dict) and item.get("type") == "explode":
        errors.append("sections[%d]: unknown type 'explode'" % i)

if args.dry_run:
    if errors:
        print(json.dumps({"success": False, "error": "Spec validation failed with %d error(s)" % len(errors),
                          "code": "VALIDATION_FAILED", "valid": False, "errors": errors, "dry_run": True}))
        sys.exit(1)
    print(json.dumps({"success": True, "dry_run": True, "valid": True, "errors": [],
                      "summary": "%d units" % units}))
    sys.exit(0)

if errors:
    print(json.dumps({"success": False, "error": "Spec validation failed with %d error(s)" % len(errors),
                      "code": "VALIDATION_FAILED", "valid": False, "errors": errors}))
    sys.exit(1)

downloads = os.environ.get("TEST_DOWNLOADS_DIR")
if not downloads:
    print(json.dumps({"success": False, "error": "TEST_DOWNLOADS_DIR was not granted", "code": "ERROR"}))
    sys.exit(3)

slug = re.sub(r"[^A-Za-z0-9._-]+", "_", spec.get("title", "untitled")).strip("_") or "untitled"
name = slug + "${ ext }"
path = os.path.join(downloads, name)
with open(path, "wb") as fh:
    fh.write(b"STUB" + json.dumps({"units": units}).encode("utf-8"))

declared = [name]
contract = {"success": True, "slug": slug, "file": name, "filename": name,
            "size_bytes": os.path.getsize(path), "units": units,
            "sidebar_registration": {"registered": False, "reason": "No user_id in spec"}}

if spec.get("user_id") is not None:
    contract["sidebar_registration"] = {"registered": True, "user_id": spec.get("user_id"),
                                        "tenant_id": spec.get("tenant_id", "ava")}

${ preview ? `preview_name = slug + ".html"
with open(os.path.join(downloads, preview_name), "w", encoding="utf-8") as fh:
    fh.write("<html><body>" + str(units) + " units</body></html>")
contract["preview_file"] = preview_name
declared.append(preview_name)
` : '' }
contract["download_files"] = declared

# Progress chatter before the single JSON object, as a real renderer emits.
print("rendering " + str(units) + " units", file=sys.stderr)
print(json.dumps(contract))
`;
}

/**
 * A stub renderer that REQUIRES --output.
 *
 * argparse rejects the --input-only form with "the following arguments are
 * required: --output", which is the signal that must advance the ladder.
 *
 * @returns {string} Python source.
 */
function needsOutputRendererSource() {
  return `#!/usr/bin/env python3
import argparse, json, os, re

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

with open(args.input, "r", encoding="utf-8") as fh:
    spec = json.load(fh)

downloads = os.environ["TEST_DOWNLOADS_DIR"]
slug = re.sub(r"[^A-Za-z0-9._-]+", "_", spec.get("title", "untitled")).strip("_") or "untitled"
name = slug + ".docx"
with open(os.path.join(downloads, name), "wb") as fh:
    fh.write(b"STUB-NEEDS-OUTPUT")

print(json.dumps({"success": True, "file": name, "download_files": [name]}))
`;
}

/** A stub renderer that always fails at runtime, after argparse accepts argv. */
const RUNTIME_FAIL_SOURCE = `#!/usr/bin/env python3
import argparse, json, sys
parser = argparse.ArgumentParser()
parser.add_argument("--input")
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--output", nargs="?", default=None)
parser.parse_args()
print("Traceback (most recent call last):", file=sys.stderr)
print("ValueError: the renderer blew up", file=sys.stderr)
# doc_common.json_main converts an uncaught exception into this envelope.
print(json.dumps({"success": False, "error": "ValueError: the renderer blew up",
                  "code": "UNHANDLED_EXCEPTION"}))
sys.exit(1)
`;

/**
 * A renderer that publishes on first run and SKIPS the write when the artefact
 * already exists, while still declaring it in download_files.
 *
 * This is the case doc_common.declared_download_files exists for: "so the
 * connector emits a signed link even when the bytes were unchanged". Without
 * the declared list, the downloads diff sees no change and returns no link, so
 * the caller is told nothing was produced for a document that is sitting on
 * disk ready to serve.
 */
const IDEMPOTENT_SOURCE = `#!/usr/bin/env python3
import argparse, json, os, re

parser = argparse.ArgumentParser()
parser.add_argument("--input")
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--output", nargs="?", default=None)
args = parser.parse_args()

with open(args.input, encoding="utf-8") as fh:
    spec = json.load(fh)

downloads = os.environ["TEST_DOWNLOADS_DIR"]
slug = re.sub(r"[^A-Za-z0-9._-]+", "_", spec.get("title", "x")).strip("_")
name = slug + ".docx"
path = os.path.join(downloads, name)

wrote = False
if not os.path.exists(path):
    with open(path, "wb") as fh:
        fh.write(b"IDEMPOTENT")
    wrote = True

print(json.dumps({"success": True, "file": name, "wrote": wrote,
                  "download_files": [name]}))
`;

/** A stub renderer that exits 0 and writes nothing. The silent-success case. */
const SILENT_SUCCESS_SOURCE = `#!/usr/bin/env python3
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--input")
parser.parse_args()
print('{"success": true, "file": "nothing.docx", "download_files": []}')
`;

/**
 * Stub of convert_docx_to_pdf.py (the LibreOffice path).
 *
 * Reproduces the real contract exactly, which is the whole point: --pdf-name
 * decides the output filename and --output is ACCEPTED AND DISCARDED. A stub
 * that honoured --output would hide the defect this contract caused.
 */
const PDF_CONVERTER_SOURCE = `#!/usr/bin/env python3
import argparse, json, os, re

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--pdf-name", default=None)
parser.add_argument("--title", default=None)
parser.add_argument("--user_id", default=None)
parser.add_argument("--tenant_id", default="ava")
parser.add_argument("--ttl_days", type=int, default=30)
parser.add_argument("--output", nargs="?", default=None, help=argparse.SUPPRESS)
args = parser.parse_args()

if not os.path.isabs(args.input):
    print(json.dumps({"success": False, "code": "FILE_NOT_FOUND",
                      "error": "relative --input is resolved against uploads only: " + args.input}))
    raise SystemExit(1)

if not os.path.exists(args.input):
    print(json.dumps({"success": False, "code": "FILE_NOT_FOUND", "error": "not found: " + args.input}))
    raise SystemExit(1)

downloads = os.environ["TEST_DOWNLOADS_DIR"]
stem = os.path.splitext(os.path.basename(args.input))[0]
slug = re.sub(r"[^A-Za-z0-9._-]+", "_", getattr(args, "pdf_name", None) or stem).strip("_")
final = os.path.join(downloads, slug + ".pdf")
with open(final, "wb") as fh:
    fh.write(b"%PDF-1.4 stub")

print(json.dumps({"success": True, "slug": slug, "file": os.path.basename(final),
                  "size_bytes": os.path.getsize(final), "download_files": [os.path.basename(final)]}))
`;

/**
 * Stub of docx_to_pdf_faithful.py (the reportlab path).
 *
 * Here --output IS a real output path and there is no doc_common envelope --
 * it prints a bare {"success":..., "path":...}. Different from the above on
 * purpose.
 */
const PDF_FAITHFUL_SOURCE = `#!/usr/bin/env python3
import argparse, json, os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output")
args = parser.parse_args()

out = args.output or str(Path(args.input).with_suffix(".pdf"))
with open(out, "wb") as fh:
    fh.write(b"%PDF-1.4 faithful stub")

print(json.dumps({"success": True, "path": out, "size_bytes": os.path.getsize(out)}))
`;

/** A converter that fails the way a missing LibreOffice install fails. */
const PDF_PIPELINE_MISSING_SOURCE = `#!/usr/bin/env python3
import argparse, json
parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--pdf-name", default=None)
parser.add_argument("--output", nargs="?", default=None)
parser.parse_args()
# The real convert_docx_to_pdf.py emits exactly this code when find_libreoffice()
# returns None.
print(json.dumps({"success": False, "code": "LIBREOFFICE_MISSING",
                  "error": "LibreOffice is not installed in this runtime, so no faithful PDF "
                           "conversion is possible. Install the 'libreoffice-writer' package."}))
raise SystemExit(1)
`;

/**
 * Install a stub script into the temporary scripts directory.
 *
 * @param {string} name
 * @param {string} source
 * @returns {void}
 */
function installScript( name, source ) {
  const path = join( scriptsDir, name );
  writeFileSync( path, source, 'utf8' );
  chmodSync( path, 0o755 );
}

/** @returns {string[]} Filenames currently in the temporary downloads directory. */
function downloadsListing() {
  return existsSync( downloadsDir ) ? readdirSync( downloadsDir ).sort() : [];
}

/** @returns {string[]} Filenames currently in the temporary staging directory. */
function stagingListing() {
  return existsSync( stagingDir ) ? readdirSync( stagingDir ).sort() : [];
}

/**
 * Parse the single text block out of an MCP tool result.
 *
 * @param {object} result
 * @returns {object}
 */
function payload( result ) {
  assert.ok( Array.isArray( result?.content ), 'a tool result must carry a content array' );
  assert.equal( result.content[ 0 ].type, 'text' );
  return JSON.parse( result.content[ 0 ].text );
}

/**
 * Build a document spec with N heading/text section pairs.
 *
 * @param {string} title
 * @param {number} sectionCount
 * @returns {object}
 */
function docSpec( title, sectionCount ) {
  const sections = [];
  for ( let i = 0; i < sectionCount; i += 1 ) {
    sections.push( i % 2 === 0
      ? { type: 'heading', level: ( i % 4 ) + 1, text: `Heading ${ i }` }
      : { type: 'text', text: `Body paragraph ${ i }.` } );
  }
  return { title, sections };
}

before( () => {
  saved = {};
  for ( const k of ENV_KEYS ) saved[ k ] = process.env[ k ];

  root = mkdtempSync( join( tmpdir(), 'render-tools-' ) );
  scriptsDir = join( root, 'scripts' );
  downloadsDir = join( root, 'downloads' );
  uploadsDir = join( root, 'uploads' );
  stagingDir = join( root, 'staging' );

  for ( const d of [ scriptsDir, downloadsDir, uploadsDir, stagingDir ] ) {
    mkdirSync( d, { recursive: true } );
  }

  installScript( 'document_render.py', okRendererSource( '.docx', true ) );
  installScript( 'xlsx_render.py', okRendererSource( '.xlsx', false ) );
  installScript( 'pptx_render.py', okRendererSource( '.pptx', false ) );
  installScript( 'needs_output.py', needsOutputRendererSource() );
  installScript( 'runtime_fail.py', RUNTIME_FAIL_SOURCE );
  installScript( 'silent_success.py', SILENT_SUCCESS_SOURCE );
  installScript( 'idempotent.py', IDEMPOTENT_SOURCE );
  installScript( 'convert_docx_to_pdf.py', PDF_CONVERTER_SOURCE );
  installScript( 'docx_to_pdf_faithful.py', PDF_FAITHFUL_SOURCE );
  installScript( 'pipeline_missing.py', PDF_PIPELINE_MISSING_SOURCE );

  // A file that is not a renderer, used by the containment tests.
  writeFileSync( join( root, 'outside.py' ), '#!/usr/bin/env python3\n', 'utf8' );
} );

after( () => {
  for ( const k of ENV_KEYS ) {
    if ( saved[ k ] === undefined ) delete process.env[ k ];
    else process.env[ k ] = saved[ k ];
  }
  try { rmSync( root, { recursive: true, force: true } ); } catch { /* best effort */ }
} );

beforeEach( () => {
  process.env.RENDER_TOOLS_ENABLED = 'true';
  process.env.SCRIPTS_DIR = scriptsDir;
  process.env.DOWNLOADS_DIR = downloadsDir;
  process.env.USER_DATA_UPLOAD_DIR = uploadsDir;
  process.env.RENDER_STAGING_DIR = stagingDir;
  process.env.CONNECTOR_URL = 'https://connector.example.test';
  process.env.ENABLE_SIGNED_LINKS = 'false';
  process.env.DOCUMENT_DOWNLOAD_TOKEN = 'test-download-token';

  delete process.env.RENDER_SPEC_MAX_BYTES;
  delete process.env.RENDER_TIMEOUT_SECONDS;
  delete process.env.RENDER_ARGV_FORMS;
  delete process.env.RENDER_SCRIPT_DOCX;
  delete process.env.RENDER_SCRIPT_XLSX;
  delete process.env.RENDER_SCRIPT_PPTX;
  delete process.env.RENDER_SCRIPT_PDF;
  delete process.env.RENDER_SCRIPT_PDF_FAITHFUL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.SCRIPT_GRANTABLE_ENV;
  delete process.env.SCRIPT_ENV_MANIFEST;
  delete process.env.SECRET_CANARY;

  // The stubs need to know where to write. buildScriptEnv() builds the child
  // environment from scratch, so this must be granted explicitly -- which is
  // itself worth having in the test path, because it proves the grant
  // mechanism is the only way anything reaches the child.
  process.env.SCRIPT_GRANTABLE_ENV = 'TEST_DOWNLOADS_DIR';
  process.env.TEST_DOWNLOADS_DIR = downloadsDir;
  process.env.SCRIPT_ENV_MANIFEST = JSON.stringify( {
    'document_render.py':      [ 'TEST_DOWNLOADS_DIR' ],
    'xlsx_render.py':          [ 'TEST_DOWNLOADS_DIR' ],
    'pptx_render.py':          [ 'TEST_DOWNLOADS_DIR' ],
    'needs_output.py':         [ 'TEST_DOWNLOADS_DIR' ],
    'silent_success.py':       [ 'TEST_DOWNLOADS_DIR' ],
    'idempotent.py':           [ 'TEST_DOWNLOADS_DIR' ],
    'runtime_fail.py':         [ 'TEST_DOWNLOADS_DIR' ],
    'convert_docx_to_pdf.py':  [ 'TEST_DOWNLOADS_DIR' ],
    'docx_to_pdf_faithful.py': [ 'TEST_DOWNLOADS_DIR' ],
    'pipeline_missing.py':     [ 'TEST_DOWNLOADS_DIR' ],
  } );

  // A clean downloads directory per test, so the link diff is unambiguous.
  for ( const f of downloadsListing() ) rmSync( join( downloadsDir, f ), { force: true } );
  for ( const f of stagingListing() ) rmSync( join( stagingDir, f ), { force: true } );
} );

// ---------------------------------------------------------------------------
// Tool registration surface
// ---------------------------------------------------------------------------

describe( 'tool registration (spec section 11: discoverable, self-describing)', () => {

  test( 'exactly the four specified tools are defined', () => {
    assert.deepEqual(
      [ ...RENDER_TOOL_NAMES ].sort(),
      [ 'document_render', 'pdf_render', 'pptx_render', 'xlsx_render' ]
    );
  } );

  test( 'every definition carries a name, a description and an object schema', () => {
    for ( const def of RENDER_TOOL_DEFINITIONS ) {
      assert.ok( def.name, 'a definition must have a name' );
      assert.ok( def.description && def.description.length > 60,
        `${ def.name }: the description is the only thing a fresh session reads before calling it` );
      assert.equal( def.inputSchema.type, 'object' );
      assert.ok( Array.isArray( def.inputSchema.required ) && def.inputSchema.required.length > 0,
        `${ def.name }: a schema with no required field cannot reject an empty call` );
    }
  } );

  test( 'schemas use inputSchema, not input_schema', () => {
    // GET /tools normalises `t.inputSchema || t.input_schema`, so both survive
    // that path. MCP ListTools does not normalise, and sends the object as-is.
    // script-execute.js uses the snake_case spelling and is therefore
    // non-conformant on the MCP transport; these four must not copy it.
    for ( const def of RENDER_TOOL_DEFINITIONS ) {
      assert.ok( def.inputSchema, `${ def.name } must expose inputSchema` );
      assert.equal( def.input_schema, undefined, `${ def.name } must not use the snake_case spelling` );
    }
  } );

  test( 'no schema exposes a script or renderer path (spec T10, by construction)', () => {
    for ( const def of RENDER_TOOL_DEFINITIONS ) {
      const keys = Object.keys( def.inputSchema.properties || {} );
      for ( const forbidden of [ 'script_path', 'script', 'renderer', 'command', 'argv', 'args' ] ) {
        assert.ok( ! keys.includes( forbidden ),
          `${ def.name } must not accept ${ forbidden }; the renderer path is a gateway constant` );
      }
    }
  } );

  test( 'the documented section types match the DEPLOYED renderer, not the spec table', () => {
    // Mirrors VALID_SECTION_TYPES in spec_render_common.py. Two entries differ
    // from the change specification's table: "subheading" exists and the table
    // omits it. Pinning the renderer's set here means a spec-table-derived
    // edit that reintroduced the divergence would fail immediately.
    assert.deepEqual( [ ...SECTION_TYPES ].sort(), [
      'bullet_list', 'callout', 'divider', 'heading', 'image', 'key_stats',
      'numbered_list', 'page_break', 'paragraph', 'quote', 'subheading', 'svg',
      'table', 'text',
    ] );
    assert.ok( SECTION_TYPES.has( 'subheading' ),
      'subheading is accepted by the renderer; rejecting it would break working specs' );
  } );

  test( 'the documented callout styles include "success"', () => {
    // VALID_CALLOUT_STYLES in spec_render_common.py. The spec table lists only
    // info/warning/tip/error, so a validator written from it rejects a style
    // the renderer accepts.
    assert.deepEqual( [ ...CALLOUT_STYLES ].sort(),
      [ 'error', 'info', 'success', 'tip', 'warning' ] );
  } );

} );

// ---------------------------------------------------------------------------
// Feature flag (spec section 9)
// ---------------------------------------------------------------------------

describe( 'feature flag (spec section 9: additive, default off)', () => {

  test( 'the flag is off unless explicitly set to true', () => {
    delete process.env.RENDER_TOOLS_ENABLED;
    assert.equal( renderToolsEnabled(), false );

    process.env.RENDER_TOOLS_ENABLED = '1';
    assert.equal( renderToolsEnabled(), false, 'only the literal string "true" enables the family' );

    process.env.RENDER_TOOLS_ENABLED = 'TRUE';
    assert.equal( renderToolsEnabled(), true, 'case is not significant' );
  } );

  test( 'a disabled call is refused with an explicit, actionable reason', async () => {
    process.env.RENDER_TOOLS_ENABLED = 'false';
    const result = await dispatchRenderTool( 'document_render', { spec: docSpec( 'X', 2 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'feature_disabled' );
    assert.match( body.error, /RENDER_TOOLS_ENABLED/ );
    assert.match( body.error, /script_execute/, 'the caller must be told what still works' );
    assert.deepEqual( downloadsListing(), [], 'a disabled call must not touch the filesystem' );
  } );

  test( 'the dispatcher returns null for a name it does not own', async () => {
    assert.equal( await dispatchRenderTool( 'script_execute', {} ), null );
    assert.equal( await dispatchRenderTool( 'web_search', {} ), null );
  } );

} );

// ---------------------------------------------------------------------------
// T1  small docx
// ---------------------------------------------------------------------------

describe( 'T1  small docx', () => {

  test( 'a five-section spec renders and returns a URL plus a preview', async () => {
    const result = await handleDocumentRender( { spec: docSpec( 'Quarterly Review', 5 ) } );
    const body = payload( result );

    assert.equal( result.isError, false );
    assert.equal( body.ok, true );
    assert.equal( body.format, 'docx' );
    assert.equal( body.section_count, 5 );
    assert.equal( body.renderer, 'document_render.py' );

    assert.match( body.file, /\.docx$/ );
    assert.match( body.download_url, /^https:\/\/connector\.example\.test\/download\// );
    assert.ok( body.preview_url, 'spec section 6.1 requires a matching HTML preview' );
    assert.ok( body.size_bytes > 0 );

    const names = downloadsListing();
    assert.ok( names.some( ( n ) => n.endsWith( '.docx' ) ), 'a .docx must exist on disk' );
    assert.ok( names.some( ( n ) => n.endsWith( '.html' ) ), 'the preview must exist on disk' );
  } );

  test( 'the renderer receives --input alone, never --output', async () => {
    // The load-bearing assertion of this whole change. The stub declares only
    // --input, exactly as document_render.py does, and argparse exits 2 if
    // --output is supplied. A pass here means the ladder never even tried the
    // form that broke production.
    const result = await handleDocumentRender( { spec: docSpec( 'Argv Shape', 3 ) } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.argv_form.length, 2, 'the first form must be exactly two tokens' );
    assert.equal( body.argv_form[ 0 ], '--input' );
    assert.ok( ! body.argv_form.includes( '--output' ) );
    assert.equal( body.argv_note, undefined, 'no fallback should have been needed' );
  } );

  test( 'the renderer JSON contract is captured from a noisy stdout stream', async () => {
    const result = await handleDocumentRender( { spec: docSpec( 'Contract', 4 ) } );
    const body = payload( result );

    assert.ok( body.renderer_contract, 'spec section 7 step 6 requires the contract be captured' );
    assert.equal( body.renderer_contract.units, 4 );
    assert.match( body.renderer_contract.file, /\.docx$/ );
  } );

  test( 'the staged spec file is removed after the run', async () => {
    await handleDocumentRender( { spec: docSpec( 'Cleanup', 3 ) } );
    assert.deepEqual( stagingListing(), [],
      'a staged spec left behind would accumulate on the volume indefinitely' );
  } );

} );

// ---------------------------------------------------------------------------
// T2  large docx -- the failure this specification exists to remove
// ---------------------------------------------------------------------------

describe( 'T2  large docx (138 sections, no truncation)', () => {

  test( 'all 138 sections reach the renderer intact', async () => {
    const spec = docSpec( 'Accounts Payable End To End Process', 138 );
    // Body text sized to approximate the real fixture (~2500 words) so the
    // payload is representative rather than a token-sized stand-in.
    for ( const s of spec.sections ) {
      if ( s.type === 'text' ) s.text = `${ s.text } ${ 'lorem ipsum dolor sit amet '.repeat( 8 ) }`;
    }

    const result = await handleDocumentRender( { spec } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.section_count, 138, 'the gateway must report what it sent' );
    assert.equal( body.renderer_contract.units, 138,
      'and the RENDERER must report having received all 138 -- this is the truncation check' );
    assert.equal( body.download_links.length >= 1, true );
  } );

  test( 'one call yields one deliverable, not a fragmented set (spec 4.3)', async () => {
    const result = await handleDocumentRender( { spec: docSpec( 'Single Deliverable', 60 ) } );
    const body = payload( result );

    const docs = body.download_links.filter( ( l ) => l.filename.endsWith( '.docx' ) );
    assert.equal( docs.length, 1, 'six scattered links was the reported symptom; one call means one document' );
    assert.equal( body.file, docs[ 0 ].filename );
  } );

} );

// ---------------------------------------------------------------------------
// T3  dry run
// ---------------------------------------------------------------------------

describe( 'T3  dry run', () => {

  test( 'a structurally malformed spec is caught by the gateway without spawning', async () => {
    const result = await handleDocumentRender( { dry_run: true, spec: { sections: [] } } );
    const body = payload( result );

    assert.equal( result.isError, false, 'a validation verdict is a result, not a tool failure' );
    assert.equal( body.dry_run, true );
    assert.equal( body.valid, false );
    assert.equal( body.validated_by, 'gateway_precheck' );
    assert.ok( body.errors.some( ( e ) => /title/.test( e ) ) );
    assert.ok( body.errors.some( ( e ) => /sections/.test( e ) ) );

    assert.deepEqual( downloadsListing(), [], 'a dry run must not write a document' );
    assert.deepEqual( stagingListing(), [], 'a dry run must not stage a spec file either' );
  } );

  test( 'a spec the gateway cannot judge is validated BY THE RENDERER', async () => {
    // The whole point of the delegation. The gateway pre-check passes this
    // spec; the renderer rejects it and its errors are surfaced verbatim.
    const spec = docSpec( 'Renderer Judged', 2 );
    spec.sections.push( { type: 'explode' } );

    const result = await handleDocumentRender( { dry_run: true, spec } );
    const body = payload( result );

    assert.equal( result.isError, false );
    assert.equal( body.valid, false );
    assert.equal( body.validated_by, 'renderer',
      'the verdict must come from the renderer, so a dry-run pass cannot be followed by a render that fails validation' );
    assert.ok( body.errors.some( ( e ) => /explode/.test( e ) ) );
    assert.deepEqual( downloadsListing(), [], '--dry-run must not write a file' );
  } );

  test( 'a valid spec is confirmed by the renderer and --dry-run is actually passed', async () => {
    const result = await handleDocumentRender( { dry_run: true, spec: docSpec( 'Delegated', 4 ) } );
    const body = payload( result );

    assert.equal( body.valid, true );
    assert.equal( body.validated_by, 'renderer' );
    assert.ok( /units/.test( body.summary || '' ),
      'the renderer summary proves --dry-run reached the script rather than being simulated' );
    assert.deepEqual( downloadsListing(), [] );
  } );

  test( 'a valid spec returns valid:true and still writes nothing', async () => {
    const result = await handleDocumentRender( { dry_run: true, spec: docSpec( 'Fine', 5 ) } );
    const body = payload( result );

    assert.equal( body.valid, true );
    assert.deepEqual( body.errors, [] );
    assert.equal( body.section_count, 5 );
    assert.ok( body.spec_bytes > 0 );
    assert.deepEqual( downloadsListing(), [] );
  } );

  test( 'dry_run is available on all four tools', async () => {
    const results = await Promise.all( [
      handleDocumentRender( { dry_run: true, spec: docSpec( 'D', 1 ) } ),
      handleXlsxRender( { dry_run: true, spec: { title: 'S', sheets: [ { name: 'A', headers: [ 'h' ], rows: [ [ 'v' ] ] } ] } } ),
      handlePptxRender( { dry_run: true, spec: { title: 'P', slides: [ { title: 'One' } ] } } ),
      handlePdfRender( { dry_run: true, mode: 'from_docx', source_path: 'x.docx' } ),
    ] );

    for ( const r of results ) {
      const b = payload( r );
      assert.equal( b.dry_run, true );
      assert.equal( b.valid, true, `${ b.tool } should have validated cleanly` );
    }
    assert.deepEqual( downloadsListing(), [] );
  } );

} );

// ---------------------------------------------------------------------------
// T4  size overflow -- explicit error, never silent truncation
// ---------------------------------------------------------------------------

describe( 'T4  size overflow', () => {

  test( 'an oversized spec is refused loudly and nothing is written', async () => {
    process.env.RENDER_SPEC_MAX_BYTES = '2048';

    const result = await handleDocumentRender( { spec: docSpec( 'Too Big', 400 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'spec_too_large' );
    assert.ok( body.spec_bytes > 2048 );
    assert.equal( body.spec_max_bytes, 2048 );
    assert.match( body.error, /nothing was truncated/i,
      'the message must say so explicitly; silent truncation is the defect being removed' );
    assert.deepEqual( downloadsListing(), [], 'no partial document may be produced' );
    assert.deepEqual( stagingListing(), [], 'the size check must precede staging' );
  } );

  test( 'the ceiling is applied to serialized bytes, as the spec states', () => {
    delete process.env.RENDER_SPEC_MAX_BYTES;
    assert.equal( specMaxBytes(), 512 * 1024, 'the documented default is 512KB' );

    process.env.RENDER_SPEC_MAX_BYTES = '0';
    assert.equal( specMaxBytes(), 512 * 1024, 'a zero limit would reject everything; it is not honoured' );

    process.env.RENDER_SPEC_MAX_BYTES = 'not-a-number';
    assert.equal( specMaxBytes(), 512 * 1024 );

    process.env.RENDER_SPEC_MAX_BYTES = '999999999999';
    assert.equal( specMaxBytes(), 32 * 1024 * 1024, 'an absurd limit is clamped, not honoured' );
  } );

  test( 'dry_run reports the overflow rather than hiding it behind validity', async () => {
    process.env.RENDER_SPEC_MAX_BYTES = '2048';
    const result = await handleDocumentRender( { dry_run: true, spec: docSpec( 'Too Big', 400 ) } );
    const body = payload( result );

    assert.equal( body.valid, false );
    assert.ok( body.errors.some( ( e ) => /exceeds/.test( e ) ),
      'dry_run must be usable to pre-check size, or callers will discover the ceiling at render time' );
  } );

} );

// ---------------------------------------------------------------------------
// T5  xlsx
// ---------------------------------------------------------------------------

describe( 'T5  xlsx', () => {

  test( 'a three-sheet spec renders', async () => {
    const spec = {
      title: 'R2R Controls',
      sheets: [
        { name: 'Summary',  headers: [ 'Metric', 'Value' ], rows: [ [ 'Cycle time', 4.2 ], [ 'Exceptions', 17 ] ], freeze_header: true },
        { name: 'Detail',   headers: [ 'Id', 'Owner', 'Status' ], rows: [ [ 1, 'AP', 'Open' ], [ 2, 'AR', 'Closed' ] ], column_widths: [ 8, 24, 12 ] },
        { name: 'Glossary', headers: [ 'Term', 'Definition' ], rows: [ [ 'R2R', 'Record to Report' ] ], tab_colour: '1F3530' },
      ],
    };

    const result = await handleXlsxRender( { spec } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.format, 'xlsx' );
    assert.equal( body.sheet_count, 3 );
    assert.equal( body.renderer_contract.units, 3 );
    assert.match( body.file, /\.xlsx$/ );
  } );

  test( 'numeric and boolean cells are accepted', () => {
    // The spec types rows as string[][]. Enforcing that literally would make
    // xlsx_render unable to carry numbers, which is most spreadsheet content.
    // The widening is deliberate and is documented in the tool description.
    const errors = validateSheetsSpec( {
      title: 'Mixed',
      sheets: [ { name: 'S', headers: [ 'a', 'b', 'c' ], rows: [ [ 'text', 42, true ], [ null, 0, 'x' ] ] } ],
    } );
    assert.deepEqual( errors, [] );
  } );

  test( 'the gateway does NOT reject sheet shapes the real renderer accepts', () => {
    // xlsx_render.validate_spec accepts a sheet with no "name" (it generates
    // Sheet1, Sheet2...), a sheet with headers OR rows rather than both, and
    // "col_widths" as an object. An earlier gateway validator, written from the
    // spec table, required name + headers + rows and typed column_widths as an
    // array -- so it rejected all three of these working shapes.
    assert.deepEqual( validateSheetsSpec( {
      title: 'Real Shapes',
      sheets: [
        { headers: [ 'a', 'b' ] },
        { name: 'RowsOnly', rows: [ [ 1, 2 ] ] },
        { name: 'Widths', headers: [ 'a' ], rows: [ [ 1 ] ], col_widths: { A: 18 } },
      ],
    } ), [] );
  } );

  test( 'metadata.title is accepted in place of title', () => {
    // xlsx_render.validate_spec checks `title` OR `metadata.title`.
    assert.deepEqual( validateSheetsSpec( {
      metadata: { title: 'From Metadata' },
      sheets: [ { name: 'S', headers: [ 'h' ], rows: [ [ 'v' ] ] } ],
    } ), [] );
  } );

} );

// ---------------------------------------------------------------------------
// T6  pptx
// ---------------------------------------------------------------------------

describe( 'T6  pptx', () => {

  test( 'a five-slide 16x9 spec renders', async () => {
    const spec = {
      title: 'AP Walkthrough',
      aspect: '16x9',
      slides: [
        { title: 'Overview',   layout: 'title_only' },
        { title: 'Scope',      layout: 'title_plus_bullets', bullets: [ 'Invoices', 'Payments' ] },
        { title: 'Controls',   layout: 'title_plus_content', table: { headers: [ 'Control', 'Owner' ], rows: [ [ 'Three-way match', 'AP' ] ] } },
        { title: 'Metrics',    layout: 'title_plus_bullets', bullets: [ 'Cycle time' ], notes: 'Mention the exceptions backlog.' },
        { title: 'Next steps', layout: 'blank' },
      ],
    };

    const result = await handlePptxRender( { spec } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.format, 'pptx' );
    assert.equal( body.slide_count, 5 );
    assert.equal( body.renderer_contract.units, 5 );
    assert.match( body.file, /\.pptx$/ );
  } );

  test( 'the gateway accepts the renderer\'s real elements model', () => {
    // pptx_render models a slide as {elements: [...]}, not the
    // layout/bullets/table/notes shape in the change specification's table. A
    // slide also needs no title. A gateway validator written from the table
    // rejected every deck built the way the renderer actually expects.
    assert.deepEqual( validateSlidesSpec( {
      title: 'Elements Model',
      slides: [
        { elements: [ { type: 'text', text: 'Body' } ] },
        { title: 'Mixed', elements: [ { type: 'table', rows: [ [ 'a' ] ] } ] },
        {},
      ],
    } ), [] );
  } );

} );

// ---------------------------------------------------------------------------
// T7 / T8  pdf
// ---------------------------------------------------------------------------

describe( 'T7  pdf from an existing docx', () => {

  test( 'a docx in the downloads directory converts', async () => {
    const docx = await handleDocumentRender( { spec: docSpec( 'Convert Me', 4 ) } );
    const docxBody = payload( docx );
    assert.equal( docxBody.ok, true );

    const result = await handlePdfRender( { mode: 'from_docx', source_path: docxBody.file } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.format, 'pdf' );
    assert.equal( body.mode, 'from_docx' );
    assert.equal( body.renderer, 'convert_docx_to_pdf.py' );
    assert.equal( body.faithful, false );
    assert.match( body.file, /\.pdf$/ );
    assert.ok( downloadsListing().some( ( n ) => n.endsWith( '.pdf' ) ) );
  } );

  test( 'options.faithful selects the styling-preserving converter', async () => {
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Faithful', 3 ) } ) );
    const body = payload( await handlePdfRender( {
      mode: 'from_docx', source_path: docx.file, options: { faithful: true },
    } ) );

    assert.equal( body.ok, true );
    assert.equal( body.renderer, 'docx_to_pdf_faithful.py' );
    assert.equal( body.faithful, true );
  } );

  test( 'output_name overrides the filename', async () => {
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Renamed', 2 ) } ) );
    const body = payload( await handlePdfRender( {
      mode: 'from_docx', source_path: docx.file, output_name: 'Board_Pack_2026',
    } ) );

    assert.equal( body.ok, true );
    assert.equal( body.file, 'Board_Pack_2026.pdf' );
  } );

  test( 'a missing conversion pipeline is reported as such, not as a generic failure', async () => {
    process.env.RENDER_SCRIPT_PDF = 'pipeline_missing.py';
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'No Pipeline', 2 ) } ) );

    const result = await handlePdfRender( { mode: 'from_docx', source_path: docx.file } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'pdf_pipeline_unavailable' );
    assert.match( body.error, /LibreOffice/i,
      'spec section 6.2 requires a clear error when the pipeline is unavailable' );
    assert.equal( body.renderer_code, 'LIBREOFFICE_MISSING',
      'the renderer\'s own error code is surfaced, not just an exit status' );
  } );

  test( 'an absent converter script is reported before any docx is produced', async () => {
    process.env.RENDER_SCRIPT_PDF = 'no_such_converter.py';
    const result = await handlePdfRender( { mode: 'from_spec', spec: docSpec( 'Wasted', 3 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'pdf_pipeline_unavailable' );
    assert.deepEqual( downloadsListing(), [],
      'resolving the converter first means a doomed call leaves no orphan docx behind' );
  } );

} );

describe( 'T8  pdf from a spec', () => {

  test( 'a spec is rendered to docx and then converted, in one call', async () => {
    const result = await handlePdfRender( { mode: 'from_spec', spec: docSpec( 'End To End', 12 ) } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.equal( body.mode, 'from_spec' );
    assert.match( body.file, /\.pdf$/ );
    assert.ok( body.docx_stage, 'the intermediate stage must be reported for traceability' );
    assert.equal( body.docx_stage.section_count, 12 );
    assert.ok( downloadsListing().some( ( n ) => n.endsWith( '.pdf' ) ) );
  } );

  test( 'from_spec inherits the document validator', async () => {
    const result = await handlePdfRender( { mode: 'from_spec', spec: { title: 'No sections' } } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'invalid_spec' );
    assert.ok( body.errors.some( ( e ) => /sections/.test( e ) ) );
  } );

  test( 'from_spec inherits the size ceiling', async () => {
    process.env.RENDER_SPEC_MAX_BYTES = '2048';
    const result = await handlePdfRender( { mode: 'from_spec', spec: docSpec( 'Huge', 400 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'source_render_failed' );
    assert.equal( body.docx_stage.error_kind, 'spec_too_large',
      'the ceiling must not be bypassable by routing through pdf_render' );
  } );

} );

// ---------------------------------------------------------------------------
// T9  unknown / unsupported target
// ---------------------------------------------------------------------------

describe( 'T9  unsupported target', () => {

  test( 'an unsupported pdf mode is a clear validation error', async () => {
    const result = await handlePdfRender( { mode: 'from_markdown', spec: docSpec( 'X', 2 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'invalid_spec' );
    assert.ok( body.errors.some( ( e ) => /from_docx, from_spec/.test( e ) ),
      'the error must enumerate what IS supported, not just reject' );
  } );

  test( 'an unsupported section type is reported as invalid_spec, with the renderer errors', async () => {
    const spec = docSpec( 'Unsupported', 2 );
    spec.sections.push( { type: 'explode' } );

    const result = await handleDocumentRender( { spec } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'invalid_spec',
      'a bad spec is a caller problem with a fixable error list, not an infrastructure failure' );
    assert.equal( body.renderer_code, 'VALIDATION_FAILED' );
    assert.equal( body.validated_by, 'renderer' );
    assert.ok( body.errors.some( ( e ) => /explode/.test( e ) ) );
    assert.deepEqual( downloadsListing(), [], 'a rejected spec must leave nothing behind' );
  } );

  test( 'a missing renderer script is distinguished from a missing volume', () => {
    process.env.RENDER_SCRIPT_DOCX = 'not_deployed.py';
    const missing = resolveRenderer( 'not_deployed.py' );
    assert.equal( missing.ok, false );
    assert.equal( missing.kind, 'renderer_missing' );
    assert.match( missing.message, /script_list/, 'the message must name the tool that lists what IS present' );

    process.env.SCRIPTS_DIR = join( root, 'no-such-volume' );
    const gone = resolveRenderer( 'document_render.py' );
    assert.equal( gone.ok, false );
    assert.equal( gone.kind, 'scripts_dir_missing',
      'spec failure mode 4.5: a snapshot revert must not present as a missing script' );
  } );

} );

// ---------------------------------------------------------------------------
// T10  script path injection
// ---------------------------------------------------------------------------

describe( 'T10  script path injection', () => {

  test( 'a renderer path in tool input is ignored and the gateway constant is used', async () => {
    const result = await handleDocumentRender( {
      spec: docSpec( 'Injection', 3 ),
      script_path: '../../../etc/passwd',
      renderer: '/tmp/evil.py',
      command: 'rm -rf /',
      argv: [ '--output', '/tmp' ],
    } );
    const body = payload( result );

    assert.equal( body.ok, true, 'the legitimate part of the call still succeeds' );
    assert.equal( body.renderer, 'document_render.py', 'the gateway used its own path constant' );
    assert.deepEqual(
      body.ignored_parameters.sort(),
      [ 'argv', 'command', 'renderer', 'script_path' ],
      'the caller is told what was dropped rather than it being silently cleaned'
    );
    assert.ok( ! body.argv_form.includes( '--output' ),
      'an argv key in tool input must not reach the child process' );
  } );

  test( 'detectInjectionKeys covers the obvious aliases', () => {
    assert.deepEqual(
      detectInjectionKeys( { spec: {}, scriptPath: 'x', python_bin: 'y', interpreter: 'z' } ).sort(),
      [ 'interpreter', 'python_bin', 'scriptPath' ]
    );
    assert.deepEqual( detectInjectionKeys( { spec: {}, dry_run: true } ), [] );
    assert.deepEqual( detectInjectionKeys( null ), [] );
  } );

  test( 'an operator override cannot escape the scripts directory', () => {
    // The RENDER_SCRIPT_* variables are operator-controlled, not caller
    // controlled, but a typo must still fail closed rather than execute
    // something outside the renderer directory.
    const escaped = resolveRenderer( '../outside.py' );
    assert.equal( escaped.ok, false );
    assert.equal( escaped.kind, 'renderer_rejected' );

    const notPython = resolveRenderer( 'document_render.sh' );
    assert.equal( notPython.ok, false );
    assert.equal( notPython.kind, 'renderer_rejected' );
  } );

  test( 'a pdf source cannot traverse out of the downloads or uploads directory', () => {
    for ( const bad of [ '../../etc/passwd.docx', '/etc/passwd.docx', 'a/b.docx', 'x`whoami`.docx' ] ) {
      const r = resolvePdfSource( { source_path: bad } );
      assert.equal( r.ok, false, `${ bad } must be refused` );
    }
  } );

  test( 'a pdf source_url pointing off this connector is refused, not fetched', () => {
    const r = resolvePdfSource( { source_url: 'https://evil.example.com/payload.docx' } );
    assert.equal( r.ok, false );
    assert.equal( r.kind, 'invalid_source' );
    assert.match( r.message, /Arbitrary URLs are not fetched/ );
  } );

  test( 'a pdf source_url on this connector resolves to the local file', async () => {
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Via Url', 2 ) } ) );
    const r = resolvePdfSource( {
      source_url: `https://connector.example.test/download/${ encodeURIComponent( docx.file ) }?exp=1&sig=ab`,
    } );

    assert.equal( r.ok, true );
    assert.equal( r.filename, docx.file );
    assert.match( r.from, /downloads/ );
  } );

  test( 'a non-docx source is refused before any conversion is attempted', () => {
    const r = resolvePdfSource( { source_path: 'notes.txt' } );
    assert.equal( r.ok, false );
    assert.match( r.message, /converts DOCX files/ );
  } );

} );

// ---------------------------------------------------------------------------
// Verified renderer contracts
//
// These are the assertions that only became possible once the deployed scripts
// were available. Each pins a contract detail that, if got wrong, fails
// SILENTLY -- a successful-looking result carrying the wrong file.
// ---------------------------------------------------------------------------

describe( 'verified renderer contracts', () => {

  test( 'the LibreOffice converter is driven by --pdf-name, never --output', async () => {
    // THE DEFECT THIS PREVENTS: convert_docx_to_pdf.py names its output from
    // --pdf-name and ACCEPTS AND DISCARDS --output via doc_common.add_output_arg.
    // Sending --output (as a single shared PDF argv ladder would) is accepted by
    // argparse, silently ignored, and the PDF is published under the source stem
    // instead of the requested name. Exit 0, plausible result, wrong filename.
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Source Doc', 2 ) } ) );

    const body = payload( await handlePdfRender( {
      mode: 'from_docx', source_path: docx.file, output_name: 'Board_Pack_Q3',
    } ) );

    assert.equal( body.ok, true );
    assert.ok( body.argv_form.includes( '--pdf-name' ), 'the slug must be passed as --pdf-name' );
    assert.ok( ! body.argv_form.includes( '--output' ),
      '--output is discarded by this converter, so sending it would silently lose output_name' );
    assert.equal( body.file, 'Board_Pack_Q3.pdf', 'the requested name actually took effect' );
  } );

  test( 'the faithful converter IS driven by --output', async () => {
    // docx_to_pdf_faithful.py does not use add_output_arg: --output is a real
    // output path. The two converters are not interchangeable.
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Faithful Source', 2 ) } ) );

    const body = payload( await handlePdfRender( {
      mode: 'from_docx', source_path: docx.file, output_name: 'Styled_Report',
      options: { faithful: true },
    } ) );

    assert.equal( body.ok, true );
    assert.equal( body.renderer, 'docx_to_pdf_faithful.py' );
    assert.ok( body.argv_form.includes( '--output' ), 'this converter takes a real --output path' );
    assert.ok( ! body.argv_form.includes( '--pdf-name' ), 'and does not know --pdf-name' );
    assert.equal( body.file, 'Styled_Report.pdf' );
  } );

  test( 'the converter receives an ABSOLUTE source path', async () => {
    // doc_common.resolve_upload_path prepends UPLOADS_DIR to a RELATIVE value,
    // so a bare filename for a file in the downloads directory resolves to a
    // path that does not exist and the convert fails with FILE_NOT_FOUND. The
    // stub enforces the same rule.
    const docx = payload( await handleDocumentRender( { spec: docSpec( 'Abs Path', 2 ) } ) );
    const body = payload( await handlePdfRender( { mode: 'from_docx', source_path: docx.file } ) );

    assert.equal( body.ok, true );
    const inputIdx = body.argv_form.indexOf( '--input' );
    assert.ok( inputIdx >= 0 );
    assert.ok( body.argv_form[ inputIdx + 1 ].startsWith( '/' ),
      'a relative path would be resolved against uploads and would not be found' );
  } );

  test( 'renderer-declared download_files drive the link set', async () => {
    // buildDownloadLinks reports only files whose BYTES CHANGED since the
    // snapshot, unless the caller declares them. The second render below
    // publishes nothing at all, so the diff is empty and the ONLY thing that
    // can produce a link is the renderer's declared download_files list.
    process.env.RENDER_SCRIPT_DOCX = 'idempotent.py';
    const spec = docSpec( 'Idempotent Artefact', 3 );

    const first = payload( await handleDocumentRender( { spec } ) );
    assert.equal( first.ok, true );
    assert.equal( first.renderer_contract.wrote, true, 'the first run publishes' );

    const second = payload( await handleDocumentRender( { spec } ) );
    assert.equal( second.renderer_contract.wrote, false,
      'the second run must write nothing, or this test proves nothing' );
    assert.equal( second.ok, true,
      'an unchanged artefact must still be delivered, not reported as no_output_produced' );
    assert.ok( second.download_links.length > 0 );
    assert.equal( second.file, first.file );
  } );

  test( 'sidebar registration is surfaced rather than swallowed', async () => {
    // document_render registers the document against the user when the spec
    // carries user_id (doc_common.register_document). Reporting the outcome
    // means a skipped registration is visible now, not discovered later when a
    // document is missing from someone's sidebar.
    const withUser = docSpec( 'Registered', 2 );
    withUser.user_id = 42;
    withUser.tenant_id = 'truesource';

    const body = payload( await handleDocumentRender( { spec: withUser } ) );
    assert.equal( body.ok, true );
    assert.equal( body.sidebar_registration.registered, true );
    assert.equal( body.sidebar_registration.user_id, 42 );

    const without = payload( await handleDocumentRender( { spec: docSpec( 'Unregistered', 2 ) } ) );
    assert.equal( without.sidebar_registration.registered, false,
      'the absence of a registration is reported, not omitted' );
  } );

  test( 'a renderer VALIDATION_FAILED is not misreported as an infrastructure failure', async () => {
    const spec = docSpec( 'Bad Spec', 1 );
    spec.sections.push( { type: 'explode' } );

    const body = payload( await handleXlsxRender( {
      spec: { title: 'Bad Sheet', sheets: [ { type: 'explode' } ] },
    } ) );

    assert.equal( body.error_kind, 'invalid_spec' );
    assert.equal( body.renderer_code, 'VALIDATION_FAILED' );
    void spec;
  } );

} );

// ---------------------------------------------------------------------------
// Argv ladder behaviour
// ---------------------------------------------------------------------------

describe( 'argv ladder', () => {

  test( 'an argparse rejection advances the ladder; the renderer that needs --output works', async () => {
    process.env.RENDER_SCRIPT_DOCX = 'needs_output.py';
    const result = await handleDocumentRender( { spec: docSpec( 'Needs Output', 3 ) } );
    const body = payload( result );

    assert.equal( body.ok, true );
    assert.ok( body.argv_form.includes( '--output' ), 'the second form supplies it' );
    assert.match( body.argv_note, /Pin it with RENDER_ARGV_FORMS/,
      'the operator must be told how to remove the probe' );
  } );

  test( 'a RUNTIME failure does not advance the ladder', async () => {
    process.env.RENDER_SCRIPT_DOCX = 'runtime_fail.py';
    const result = await handleDocumentRender( { spec: docSpec( 'Boom', 2 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'render_failed' );
    assert.equal( body.argv_attempts.length, 1,
      'the script RAN; retrying with other flags could duplicate a partial effect' );
    assert.equal( body.argv_attempts[ 0 ].argv_rejected, false );
    assert.match( body.stderr_tail, /ValueError/ );
  } );

  test( 'isArgvRejection recognises the production signature and not a runtime error', () => {
    assert.equal( isArgvRejection( '',
      'usage: document_render.py [-h] [--input INPUT]\nerror: unrecognized arguments: --output /tmp/x' ), true );
    assert.equal( isArgvRejection( '', 'error: the following arguments are required: --output' ), true );
    assert.equal( isArgvRejection( '', 'Traceback (most recent call last):\nValueError: nope' ), false );
    assert.equal( isArgvRejection( '', 'ModuleNotFoundError: No module named docx' ), false );
  } );

  test( 'an operator can pin an argv form, and a malformed pin falls back safely', () => {
    process.env.RENDER_ARGV_FORMS = JSON.stringify( { 'document_render.py': [ [ '--input', '{spec}' ] ] } );
    assert.deepEqual( argvFormsFor( 'document_render.py', [ [ 'fallback' ] ] ), [ [ '--input', '{spec}' ] ] );
    assert.deepEqual( argvFormsFor( 'other.py', [ [ 'fallback' ] ] ), [ [ 'fallback' ] ],
      'a pin for one script must not affect another' );

    process.env.RENDER_ARGV_FORMS = '{ not json';
    assert.deepEqual( argvFormsFor( 'document_render.py', [ [ 'fallback' ] ] ), [ [ 'fallback' ] ],
      'a typo in an optimisation must not take document rendering down' );

    process.env.RENDER_ARGV_FORMS = JSON.stringify( { 'document_render.py': [ 'not-an-array' ] } );
    assert.deepEqual( argvFormsFor( 'document_render.py', [ [ 'fallback' ] ] ), [ [ 'fallback' ] ] );
  } );

} );

// ---------------------------------------------------------------------------
// Silent-success detection
// ---------------------------------------------------------------------------

describe( 'silent success (spec 4.1: a successful-looking result that delivered nothing)', () => {

  test( 'exit 0 with no file written is reported as an error, not an empty success', async () => {
    process.env.RENDER_SCRIPT_DOCX = 'silent_success.py';
    const result = await handleDocumentRender( { spec: docSpec( 'Nothing', 3 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'no_output_produced' );
    assert.match( body.error, /reported success but wrote no file/ );
    assert.equal( body.renderer_contract.file, 'nothing.docx',
      'the renderer CLAIMED a file; the gateway checks the filesystem rather than the claim' );
  } );

} );

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

describe( 'subprocess environment isolation', () => {

  test( 'a connector secret is not inherited by the renderer', async () => {
    process.env.SECRET_CANARY = 'must-not-reach-the-child';

    // The stub exits 3 if TEST_DOWNLOADS_DIR is absent, which proves the
    // manifest grant is the ONLY route into the child environment: the canary
    // is set the same way but is not granted, so it cannot be present.
    const result = await handleDocumentRender( { spec: docSpec( 'Env', 2 ) } );
    const body = payload( result );

    assert.equal( body.ok, true, 'the granted variable arrived' );

    // Now prove the ungranted one did not, by asking the child directly.
    installScript( 'env_probe.py', `#!/usr/bin/env python3
import argparse, json, os, sys
parser = argparse.ArgumentParser()
parser.add_argument("--input")
parser.parse_args()
print("SECRET_CANARY" in os.environ, file=sys.stderr)
sys.exit(7)
` );
    process.env.RENDER_SCRIPT_DOCX = 'env_probe.py';

    const probe = payload( await handleDocumentRender( { spec: docSpec( 'Probe', 1 ) } ) );
    assert.match( probe.stderr_tail, /False/,
      'buildScriptEnv builds the child environment from scratch; an ungranted variable must be absent' );
  } );

} );

// ---------------------------------------------------------------------------
// Validation detail
// ---------------------------------------------------------------------------

describe( 'validation detail', () => {

  test( 'every documented section type validates when correctly formed', () => {
    const errors = validateDocumentSpec( {
      title: 'All Types',
      author: 'Brian Le Mon',
      date: '2026-08-13',
      toc: true,
      theme: { heading: '#1F3530' },
      cover: { subtitle: 'Reference' },
      logo_svg: '<svg/>',
      user_id: 42,
      tenant_id: 'truesource',
      sections: [
        { type: 'heading', level: 1, text: 'One' },
        { type: 'text', text: 'Body' },
        { type: 'paragraph', text: 'Also body' },
        { type: 'bullet_list', items: [ 'a', 'b' ] },
        { type: 'numbered_list', items: [ 'a' ] },
        { type: 'table', headers: [ 'h' ], rows: [ [ 'v' ], [ 1 ] ] },
        { type: 'callout', style: 'warning', title: 'Careful', text: 'Detail' },
        { type: 'quote', text: 'Quoted', attribution: 'Someone' },
        { type: 'key_stats', items: [ { value: 42, label: 'Invoices' } ] },
        { type: 'divider' },
        { type: 'page_break' },
        { type: 'svg', content: '<svg/>', caption: 'Fig 1' },
        { type: 'image', src: 'chart.png', caption: 'Fig 2', width: 400 },
      ],
    } );
    assert.deepEqual( errors, [] );
  } );

  test( 'unknown extra properties are tolerated', () => {
    // Closed on the enumerated types, open on unknown keys: a renderer that
    // gains a field must not start failing here before this module knows it.
    const errors = validateDocumentSpec( {
      title: 'Forward Compatible',
      sections: [ { type: 'heading', level: 1, text: 'One', future_field: true } ],
      some_future_option: 'x',
    } );
    assert.deepEqual( errors, [] );
  } );

  test( 'a non-object spec is rejected without throwing', () => {
    for ( const bad of [ null, undefined, 'a string', 42, [ 1, 2 ] ] ) {
      assert.equal( validateDocumentSpec( bad ).length, 1 );
      assert.equal( validateSheetsSpec( bad ).length, 1 );
      assert.equal( validateSlidesSpec( bad ).length, 1 );
    }
  } );

  test( 'an empty sections array is rejected', () => {
    const errors = validateDocumentSpec( { title: 'Empty', sections: [] } );
    assert.ok( errors.some( ( e ) => /non-empty array/.test( e ) ) );
  } );

  test( 'pdf from_docx requires a source', () => {
    const errors = validatePdfInput( { mode: 'from_docx' } );
    assert.ok( errors.some( ( e ) => /source_path or source_url/.test( e ) ) );
  } );

  test( 'an unsafe output_name is rejected', () => {
    assert.ok( validatePdfInput( { mode: 'from_docx', source_path: 'a.docx', output_name: '../x' } ).length > 0 );
    assert.deepEqual( validatePdfInput( { mode: 'from_docx', source_path: 'a.docx', output_name: 'Fine-1.pdf' } ), [] );
  } );

} );

// ---------------------------------------------------------------------------
// Contract parsing
// ---------------------------------------------------------------------------

describe( 'renderer contract parsing', () => {

  test( 'the contract is found after arbitrary progress output', () => {
    const parsed = parseRendererContract(
      'loading spec\nrendering 138 sections\n{"file":"x.docx","size_bytes":47700}\n'
    );
    assert.equal( parsed.file, 'x.docx' );
    assert.equal( parsed.size_bytes, 47700 );
  } );

  test( 'a brace inside a string value does not unbalance the scan', () => {
    const parsed = parseRendererContract( 'note: {unclosed\n{"file":"a{b}.docx","note":"has } brace"}' );
    assert.equal( parsed.file, 'a{b}.docx' );
  } );

  test( 'no contract returns null rather than throwing', () => {
    assert.equal( parseRendererContract( 'just some text' ), null );
    assert.equal( parseRendererContract( '' ), null );
    assert.equal( parseRendererContract( undefined ), null );
    assert.equal( parseRendererContract( '{ not json }' ), null );
  } );

} );

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe( 'renderToolsStatus', () => {

  test( 'reports which renderers are actually present on the volume', () => {
    const status = renderToolsStatus();

    assert.equal( status.enabled, true );
    assert.equal( status.scripts_dir, scriptsDir );
    assert.equal( status.scripts_dir_present, true );
    assert.equal( status.renderers[ 'document_render.py' ], 'present' );
    assert.equal( status.spec_max_bytes, 512 * 1024 );
    assert.deepEqual( status.tools.sort(), [ 'document_render', 'pdf_render', 'pptx_render', 'xlsx_render' ] );
  } );

  test( 'a missing renderer is reported by kind, not merely as absent', () => {
    process.env.RENDER_SCRIPT_PPTX = 'never_deployed.py';
    const status = renderToolsStatus();
    assert.equal( status.renderers[ 'never_deployed.py' ], 'renderer_missing' );
  } );

  test( 'it never throws when the volume is gone', () => {
    process.env.SCRIPTS_DIR = join( root, 'absent' );
    const status = renderToolsStatus();
    assert.equal( status.scripts_dir_present, false );
    assert.equal( status.renderers[ 'document_render.py' ], 'scripts_dir_missing' );
  } );

} );

// ---------------------------------------------------------------------------
// Download contract
// ---------------------------------------------------------------------------

describe( 'download contract', () => {

  test( 'the URL is complete and carries the credential the connector holds', async () => {
    const body = payload( await handleDocumentRender( { spec: docSpec( 'Links', 3 ) } ) );

    assert.match( body.download_url, /\?token=test-download-token$/,
      'the connector builds the finished URL; the caller is never asked for a token' );
    for ( const link of body.download_links ) {
      assert.ok( link.download_url.startsWith( 'https://connector.example.test/download/' ) );
      assert.ok( typeof link.size_bytes === 'number' && link.size_bytes > 0 );
    }
  } );

  test( 'signed links are produced when they are enabled', async () => {
    process.env.ENABLE_SIGNED_LINKS = 'true';
    process.env.SIGNED_URL_SECRET = 'a'.repeat( 64 );

    const body = payload( await handleDocumentRender( { spec: docSpec( 'Signed', 3 ) } ) );

    assert.match( body.download_url, /[?&]sig=[a-f0-9]{64}/ );
    assert.ok( ! body.download_url.includes( 'test-download-token' ),
      'the global token must not appear once per-file signatures are active' );
    assert.ok( body.download_warnings.some( ( w ) => /time limited/.test( w ) ) );
  } );

  test( 'a missing CONNECTOR_URL is reported rather than producing a broken link', async () => {
    delete process.env.CONNECTOR_URL;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;

    const result = await handleDocumentRender( { spec: docSpec( 'No Base', 2 ) } );
    const body = payload( result );

    assert.equal( result.isError, true );
    assert.equal( body.error_kind, 'no_output_produced' );
    assert.ok( body.download_warnings.some( ( w ) => /CONNECTOR_URL/.test( w ) ),
      'the operator must be told which variable is missing' );
  } );

} );
