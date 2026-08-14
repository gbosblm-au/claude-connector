// src/tests/validation-tools.test.js  v1.0.0
// ---------------------------------------------------------------------------
// SPEC-GTW-TOOL-003 acceptance and regression cover for
// src/tools/validation-tools.js.
//
// WHAT IS REAL HERE AND WHAT IS NOT
// ---------------------------------
// code-syntax-check.py, code-integrity-check.py and erp-config-validator.py
// live on the Railway volume and are not in this repository, so these tests
// install STUB validators: real Python scripts that read the staged JSON spec
// and echo back what they were given, plus a canned report. Everything this
// module owns is genuinely exercised -- the spec-file convention, target
// containment, platform resolution, staging, subprocess spawn, contract
// parsing, and the verdict-versus-exit-code distinction.
//
// What is NOT proven here is the validators' own detection logic. That was
// verified separately against the volume scripts: broken Python reported
// class_a, class_c and class_d findings with line numbers; insecure PHP
// reported exactly three class_c security errors (project-scoped API key, raw
// $_GET access, SQL string concatenation); and an S/4HANA Cloud guide
// containing MB01, IMG and SPRO was caught by platform_forbidden with the
// platform read from the document's own header.
//
// THE TWO THINGS MOST LIKELY TO REGRESS
// -------------------------------------
//   1. THE SPEC-FILE CONVENTION. --input is NOT the file to check; it is a temp
//      file containing a JSON spec that NAMES the file to check. Appendix A of
//      the spec records that the first build got this backwards, so the stubs
//      assert the spec's content rather than the argv alone.
//   2. THE VERDICT IS `status`, NOT THE EXIT CODE. All three validators print a
//      report and exit 0 whether the verdict is pass, warnings or fail. Reading
//      the exit code would report every failing file as a broken tool.
//
// Run:  node --test src/tests/validation-tools.test.js
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VALIDATION_TOOL_DEFINITIONS,
  VALIDATION_TOOL_NAMES,
  dispatchValidationTool,
  validationToolsEnabled,
  validationToolsStatus,
  resolvePlatform,
  resolveTargetFile,
} from '../tools/validation-tools.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root, scriptsDir, nestedDir, uploadsDir, downloadsDir, stagingDir, savedEnv;

/**
 * A stub validator: echoes the spec it was handed and returns a canned report.
 *
 * `spec_seen` is what makes the spec-file convention assertable. A stub that
 * only echoed argv would pass even if the gateway went back to passing the
 * target path directly as --input.
 */
const STUB_VALIDATOR = `#!/usr/bin/env python3
import json, sys
argv = sys.argv[1:]
spec_path = None
for i, a in enumerate(argv):
    if a == "--input" and i + 1 < len(argv):
        spec_path = argv[i + 1]
spec = {}
if spec_path:
    try:
        spec = json.load(open(spec_path))
    except Exception as exc:
        print(json.dumps({"error": "spec unreadable: %s" % exc}))
        sys.exit(1)
issues = [
    {"type": "class_a", "severity": "error", "message": "Unclosed bracket", "line": 3, "source": "stub"},
    {"type": "class_d", "severity": "style", "message": "Incomplete placeholder comment", "line": 4, "source": "stub"},
]
print(json.dumps({
    "status": "fail",
    "language": spec.get("language", "python"),
    "file_path": spec.get("filename", "<inline>"),
    "errors": [issues[0]],
    "warnings": [issues[1]],
    "issues": issues,
    "checks_run": ["native:ast_parse", "native:ast_authoritative"],
    "summary": {"files_checked": 1, "languages_detected": ["python"], "class_a_errors": 1,
                "class_b_errors": 0, "class_c_security": 0, "class_d_style": 1, "class_e_compat": 0},
    "spec_seen": spec,
    "argv_seen": argv,
}))
`;

/** A stub returning a clean pass, for the style-never-fails assertions. */
const STUB_CLEAN = `#!/usr/bin/env python3
import json, sys
argv = sys.argv[1:]
spec = json.load(open(argv[argv.index("--input") + 1]))
print(json.dumps({
    "status": "warnings",
    "language": spec.get("language", "python"),
    "file_path": spec.get("filename", "<inline>"),
    "errors": [],
    "warnings": [{"type": "class_d", "severity": "style", "message": "TODO found", "line": 2, "source": "stub"}],
    "issues": [{"type": "class_d", "severity": "style", "message": "TODO found", "line": 2, "source": "stub"}],
    "checks_run": ["native:placeholder_scan"],
    "summary": {"files_checked": 1, "languages_detected": ["python"], "class_a_errors": 0,
                "class_b_errors": 0, "class_c_security": 0, "class_d_style": 1, "class_e_compat": 0},
    "spec_seen": spec,
}))
`;

/** An ERP stub echoing the platform it was handed. */
const STUB_ERP = `#!/usr/bin/env python3
import json, sys
argv = sys.argv[1:]
spec = json.load(open(argv[argv.index("--input") + 1]))
platform = spec.get("platform")
checks = [{"check": "completeness", "passed": False, "severity": "error",
           "message": "8 of 18 required template sections present.", "line": None}]
if platform and "SAP" in platform:
    checks.append({"check": "platform_forbidden", "passed": False, "severity": "error",
                   "message": "SAP S/4HANA Cloud hallucination risk: Transaction code referenced (found \\"MB01\\")",
                   "line": None})
else:
    checks.append({"check": "platform_patterns", "passed": True, "severity": "pass",
                   "message": "No platform-specific pattern set; general checks only.", "line": None})
print(json.dumps({
    "status": "fail",
    "platform": platform,
    "file_path": spec.get("filename", "<inline>"),
    "checks": checks,
    "errors": [c for c in checks if c["severity"] == "error"],
    "warnings": [],
    "passed_checks": [c for c in checks if c["passed"]],
    "summary": {"total_checks": len(checks)},
    "spec_seen": spec,
}))
`;

/** A validator that cannot run at all. */
const STUB_BROKEN = `#!/usr/bin/env python3
import sys
sys.stderr.write("Traceback: ImportError: cannot import name 'artifact'\\n")
sys.exit(1)
`;

function payload(result) {
  return JSON.parse(result.content[0].text);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'validation-tools-test-'));
  scriptsDir = join(root, 'scripts');
  // The validators live in a NESTED scripts/ subdirectory on the volume. The
  // layout is reproduced here because a bare filename would resolve to a path
  // that does not exist, and that is a real deployment trap.
  nestedDir = join(scriptsDir, 'scripts');
  uploadsDir = join(root, 'uploads');
  downloadsDir = join(root, 'downloads');
  stagingDir = join(root, 'staging');
  for (const d of [nestedDir, uploadsDir, downloadsDir, stagingDir]) mkdirSync(d, { recursive: true });

  savedEnv = { ...process.env };

  process.env.SCRIPTS_DIR = scriptsDir;
  process.env.USER_DATA_UPLOAD_DIR = uploadsDir;
  process.env.DOWNLOADS_DIR = downloadsDir;
  process.env.RENDER_STAGING_DIR = stagingDir;
  process.env.VALIDATION_TOOLS_ENABLED = 'true';

  process.env.VALIDATE_SCRIPT_SYNTAX = 'scripts/stub_syntax.py';
  process.env.VALIDATE_SCRIPT_INTEGRITY = 'scripts/stub_integrity.py';
  process.env.VALIDATE_SCRIPT_ERP = 'scripts/stub_erp.py';

  writeFileSync(join(nestedDir, 'stub_syntax.py'), STUB_VALIDATOR, { mode: 0o755 });
  writeFileSync(join(nestedDir, 'stub_integrity.py'), STUB_VALIDATOR, { mode: 0o755 });
  writeFileSync(join(nestedDir, 'stub_erp.py'), STUB_ERP, { mode: 0o755 });
  writeFileSync(join(nestedDir, 'stub_clean.py'), STUB_CLEAN, { mode: 0o755 });
  writeFileSync(join(nestedDir, 'stub_broken.py'), STUB_BROKEN, { mode: 0o755 });

  writeFileSync(join(uploadsDir, 'handler.php'), '<?php echo 1;');
  writeFileSync(join(downloadsDir, 'generated.py'), 'x = 1\n');
  writeFileSync(join(scriptsDir, 'library.py'), 'def f():\n    return 1\n');
  writeFileSync(join(uploadsDir, 'guide.md'),
    'Platform Version: SAP S/4HANA Cloud 2025\n\nRun MB01 via SPRO in the IMG.\n');
});

after(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================

describe('tool definitions', () => {
  test('registers exactly the three tools the spec names', () => {
    assert.deepEqual(
      VALIDATION_TOOL_DEFINITIONS.map((t) => t.name),
      ['code_syntax', 'code_integrity', 'erp_config_validator']
    );
    assert.equal(VALIDATION_TOOL_NAMES.size, 3);
  });

  test('the two code tools are described so a model can tell them apart', () => {
    // They overlap enough that a vague description would have the model pick
    // whichever it saw first. Each must state the question it answers.
    const syntax = VALIDATION_TOOL_DEFINITIONS.find((t) => t.name === 'code_syntax');
    const integrity = VALIDATION_TOOL_DEFINITIONS.find((t) => t.name === 'code_integrity');
    assert.match(syntax.description, /parse/i);
    assert.match(integrity.description, /does it parse|safe and finished/i);
    assert.match(integrity.description, /complements code_syntax/i);
  });

  test('no schema exposes a script path', () => {
    for (const def of VALIDATION_TOOL_DEFINITIONS) {
      const keys = Object.keys(def.inputSchema.properties);
      for (const forbidden of ['script', 'script_path', 'command', 'interpreter']) {
        assert.ok(!keys.includes(forbidden), `${def.name} must not expose ${forbidden}`);
      }
    }
  });

  test('neither filename nor content is schema-required, since either will do', () => {
    for (const def of VALIDATION_TOOL_DEFINITIONS) {
      assert.equal(def.inputSchema.required, undefined);
      assert.ok(def.inputSchema.properties.filename);
      assert.ok(def.inputSchema.properties.content);
    }
  });
});

describe('feature flag', () => {
  test('reads the current environment', () => {
    process.env.VALIDATION_TOOLS_ENABLED = 'false';
    assert.equal(validationToolsEnabled(), false);
    process.env.VALIDATION_TOOLS_ENABLED = 'true';
    assert.equal(validationToolsEnabled(), true);
  });

  test('a disabled connector refuses, names the flag and names the fallback', async () => {
    process.env.VALIDATION_TOOLS_ENABLED = 'false';
    const p = payload(await dispatchValidationTool('code_syntax', { content: 'x = 1' }));
    process.env.VALIDATION_TOOLS_ENABLED = 'true';
    assert.equal(p.error_kind, 'feature_disabled');
    assert.match(p.error, /VALIDATION_TOOLS_ENABLED/);
    assert.match(p.error, /script_execute/);
  });

  test('an unowned name returns null', async () => {
    assert.equal(await dispatchValidationTool('xlsx_edit', {}), null);
  });
});

describe('the spec-file convention (Appendix A)', () => {
  test('--input names a STAGED SPEC, not the target file', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', { filename: 'library.py' }));
    const argv = p.report.argv_seen;
    assert.deepEqual(argv.slice(0, 1), ['--input']);
    // The path handed over must be the staged spec in the staging directory,
    // never the target itself. This is the exact inversion Appendix A records.
    assert.ok(argv[1].startsWith(stagingDir), `--input must point into staging, got ${argv[1]}`);
    assert.ok(!argv[1].endsWith('library.py'));
    assert.equal(p.report.spec_seen.filename, join(scriptsDir, 'library.py'));
  });

  test('exactly one argv form is used: there is no ladder to walk', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', { content: 'x = 1' }));
    assert.equal(p.report.argv_seen.length, 2, 'only --input and its value');
  });

  test('inline content travels in the spec, not on the command line', async () => {
    const code = 'def f(:\n    pass\n';
    const p = payload(await dispatchValidationTool('code_syntax', { content: code, language: 'python' }));
    assert.equal(p.report.spec_seen.content, code);
    assert.equal(p.report.spec_seen.language, 'python');
    assert.ok(!p.report.argv_seen.some((a) => a.includes('def f')), 'code must never appear in argv');
  });

  test('the staged spec is removed after the run', async () => {
    await dispatchValidationTool('code_syntax', { content: 'x = 1' });
    const leftovers = readdirSync(stagingDir).filter((f) => f.startsWith('code_syntax_'));
    assert.equal(leftovers.length, 0);
  });

  test('language is passed only when supplied, so detection stays authoritative', async () => {
    const a = payload(await dispatchValidationTool('code_syntax', { content: 'x = 1' }));
    assert.equal('language' in a.report.spec_seen, false);
    const b = payload(await dispatchValidationTool('code_syntax', { content: 'x = 1', language: 'PHP' }));
    assert.equal(b.report.spec_seen.language, 'php', 'normalised to lower case');
  });
});

describe('target containment', () => {
  test('uploads, downloads and the scripts directory are all searched', () => {
    assert.equal(resolveTargetFile('handler.php').from, 'uploads');
    assert.equal(resolveTargetFile('generated.py').from, 'downloads');
    // The scripts directory is included because reviewing a script before
    // running it is the point of a syntax checker (spec test T1).
    assert.equal(resolveTargetFile('library.py').from, 'scripts');
  });

  test('a nested path inside the scripts directory resolves', () => {
    const r = resolveTargetFile('scripts/stub_syntax.py');
    assert.equal(r.ok, true);
    assert.equal(r.path, join(nestedDir, 'stub_syntax.py'));
  });

  test('anything outside those directories is refused', () => {
    for (const evil of ['/etc/passwd', '../../../../etc/shadow', '/proc/self/environ']) {
      const r = resolveTargetFile(evil);
      assert.equal(r.ok, false, `${evil} must not resolve`);
      assert.equal(r.kind, 'target_not_found');
    }
  });

  test('the refusal message points at the inline alternative', () => {
    // A caller refused a path needs to know the way through, or it will retry
    // the same call.
    assert.match(resolveTargetFile('/etc/passwd').message, /content/);
  });

  test('neither filename nor content is a parameter error, not a crash', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', {}));
    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'invalid_parameters');
  });
});

describe('the verdict is `status`, never the exit code', () => {
  test('a fail verdict is a successful tool call', async () => {
    const r = await dispatchValidationTool('code_syntax', { content: 'def f(:' });
    assert.notEqual(r.isError, true, 'a validator that found problems has done its job');
    const p = payload(r);
    assert.equal(p.ok, true);
    assert.equal(p.status, 'fail');
  });

  test('a validator that cannot run IS a tool error', async () => {
    process.env.VALIDATE_SCRIPT_SYNTAX = 'scripts/stub_broken.py';
    const r = await dispatchValidationTool('code_syntax', { content: 'x = 1' });
    process.env.VALIDATE_SCRIPT_SYNTAX = 'scripts/stub_syntax.py';
    assert.equal(r.isError, true);
    const p = payload(r);
    assert.equal(p.error_kind, 'validation_failed');
    assert.match(p.stderr_tail, /ImportError/);
  });

  test('a missing validator is reported with the directory it looked in', async () => {
    process.env.VALIDATE_SCRIPT_INTEGRITY = 'scripts/absent.py';
    const p = payload(await dispatchValidationTool('code_integrity', { content: 'x' }));
    process.env.VALIDATE_SCRIPT_INTEGRITY = 'scripts/stub_integrity.py';
    assert.equal(p.ok, false);
    assert.equal(p.scripts_dir, scriptsDir);
  });
});

describe('report surfacing', () => {
  test('the full report is returned, never trimmed', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', { content: 'def f(:' }));
    assert.equal(p.report.issues.length, 2);
    // Line numbers are what make a finding actionable.
    assert.equal(p.report.issues[0].line, 3);
    assert.deepEqual(p.report.checks_run, ['native:ast_parse', 'native:ast_authoritative']);
  });

  test('class counts are surfaced so style can be told from structure', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', { content: 'def f(:' }));
    assert.equal(p.class_counts.class_a_structure, 1);
    assert.equal(p.class_counts.class_d_style, 1);
    assert.equal(p.class_counts.class_c_security, 0);
    assert.equal(p.error_count, 1);
    assert.equal(p.warning_count, 1);
  });

  test('style findings alone do not produce a fail verdict', async () => {
    process.env.VALIDATE_SCRIPT_SYNTAX = 'scripts/stub_clean.py';
    const p = payload(await dispatchValidationTool('code_syntax', { content: '# TODO' }));
    process.env.VALIDATE_SCRIPT_SYNTAX = 'scripts/stub_syntax.py';
    assert.equal(p.status, 'warnings');
    assert.equal(p.class_counts.class_d_style, 1);
    assert.equal(p.class_counts.class_a_structure, 0);
  });

  test('the target and its source directory are attributed', async () => {
    const a = payload(await dispatchValidationTool('code_syntax', { filename: 'handler.php' }));
    assert.equal(a.target, 'handler.php');
    assert.equal(a.target_from, 'uploads');

    const b = payload(await dispatchValidationTool('code_syntax', { content: 'x = 1' }));
    assert.equal(b.target, '<inline>');
    assert.equal(b.target_from, 'inline');
  });
});

describe('platform resolution for erp_config_validator', () => {
  test('an alias resolves to the exact key the pattern table uses', () => {
    // The script matches with `key.lower() in platform.lower()`, so "sap"
    // alone silently disables every platform check.
    assert.equal(resolvePlatform('sap').platform, 'SAP S/4HANA Cloud');
    assert.equal(resolvePlatform('S/4HANA').platform, 'SAP S/4HANA Cloud');
    assert.equal(resolvePlatform('s4hana cloud').platform, 'SAP S/4HANA Cloud');
    assert.equal(resolvePlatform('dynamics 365').platform, 'D365 F&O');
    assert.equal(resolvePlatform('finance and operations').platform, 'D365 F&O');
    assert.equal(resolvePlatform('oracle fusion').platform, 'Oracle');
    assert.equal(resolvePlatform('workday').platform, 'Workday');
  });

  test('an exact key passes through unchanged', () => {
    for (const k of ['SAP S/4HANA Cloud', 'D365 F&O', 'Oracle', 'Workday']) {
      assert.equal(resolvePlatform(k).platform, k);
    }
  });

  test('an unrecognised platform is passed through verbatim, not overridden', () => {
    // The script may gain a pattern set this module has never heard of.
    const r = resolvePlatform('Infor M3');
    assert.equal(r.platform, 'Infor M3');
    assert.equal(r.source, 'caller_verbatim');
  });

  test('the document header is used when the caller says nothing', () => {
    const r = resolvePlatform('', 'Platform Version: SAP S/4HANA Cloud 2025\nDeployment: Public Cloud\n');
    assert.equal(r.platform, 'SAP S/4HANA Cloud');
    assert.equal(r.source, 'document_header');
  });

  test('the caller wins over the document', () => {
    const r = resolvePlatform('Workday', 'Platform Version: SAP S/4HANA Cloud 2025\n');
    assert.equal(r.platform, 'Workday');
    assert.equal(r.source, 'caller');
  });

  test('nothing resolvable resolves to nothing, rather than to a guess', () => {
    assert.equal(resolvePlatform('', 'A document about nothing in particular.').platform, null);
    assert.equal(resolvePlatform('').platform, null);
  });
});

describe('erp_config_validator', () => {
  test('the platform reaches the script, so forbidden patterns actually run', async () => {
    const p = payload(await dispatchValidationTool('erp_config_validator', {
      content: 'Platform Version: SAP S/4HANA Cloud 2025\nRun MB01 via SPRO.\n',
    }));
    assert.equal(p.platform_resolved, 'SAP S/4HANA Cloud');
    assert.equal(p.platform_source, 'document_header');
    assert.equal(p.report.spec_seen.platform, 'SAP S/4HANA Cloud');
    const forbidden = p.report.checks.find((c) => c.check === 'platform_forbidden');
    assert.ok(forbidden, 'the platform check must have run');
    assert.match(forbidden.message, /MB01/);
  });

  test('a named file is sniffed for its platform header too', async () => {
    const p = payload(await dispatchValidationTool('erp_config_validator', { filename: 'guide.md' }));
    assert.equal(p.platform_resolved, 'SAP S/4HANA Cloud');
    assert.equal(p.target_from, 'uploads');
  });

  test('an unresolvable platform is declared rather than silently skipped', async () => {
    // Skipping the most important check while returning a clean-looking report
    // is worse than not running: the caller reads the pass as evidence.
    const p = payload(await dispatchValidationTool('erp_config_validator', {
      content: '# Some document\nStep 1: do a thing.\n',
    }));
    assert.equal(p.platform_resolved, null);
    assert.match(p.platform_note, /NOT applied/);
    assert.match(p.platform_note, /Pass platform explicitly/);
  });

  test('a caller-supplied alias is normalised before it reaches the script', async () => {
    const p = payload(await dispatchValidationTool('erp_config_validator', {
      content: 'Run MB01.\n', platform: 'sap',
    }));
    assert.equal(p.report.spec_seen.platform, 'SAP S/4HANA Cloud');
    assert.equal(p.platform_source, 'caller');
  });
});

describe('injection', () => {
  test('a caller-supplied script path is ignored and reported', async () => {
    const p = payload(await dispatchValidationTool('code_syntax', {
      content: 'x = 1', script_path: '/tmp/evil.py', command: 'curl evil.test',
    }));
    assert.ok(p.ignored_parameters.includes('script_path'));
    assert.equal(p.ok, true, 'ignored means ignored: the real validator still ran');
    assert.equal(p.validator, 'scripts/stub_syntax.py');
  });
});

describe('size ceiling', () => {
  test('oversized inline content is refused without truncation', async () => {
    const saved = process.env.RENDER_SPEC_MAX_BYTES;
    process.env.RENDER_SPEC_MAX_BYTES = '1024';
    const p = payload(await dispatchValidationTool('code_syntax', { content: 'x'.repeat(4000) }));
    if (saved === undefined) delete process.env.RENDER_SPEC_MAX_BYTES;
    else process.env.RENDER_SPEC_MAX_BYTES = saved;

    assert.equal(p.ok, false);
    assert.equal(p.error_kind, 'content_too_large');
    assert.match(p.error, /nothing was truncated/i);
    // Truncating code before validating it would produce findings about
    // damage the gateway caused, which is worse than refusing.
    assert.match(p.error, /by name/);
  });
});

describe('status reporting', () => {
  test('reports which validators are present, including the nested path', () => {
    const s = validationToolsStatus();
    assert.equal(s.enabled, true);
    assert.equal(s.scripts_dir, scriptsDir);
    assert.equal(s.validators['scripts/stub_syntax.py'], 'present');
    assert.deepEqual([...s.tools].sort(), ['code_integrity', 'code_syntax', 'erp_config_validator']);
  });

  test('a validator at the wrong path is not reported as present', () => {
    process.env.VALIDATE_SCRIPT_ERP = 'stub_erp.py';   // missing the nested dir
    const s = validationToolsStatus();
    process.env.VALIDATE_SCRIPT_ERP = 'scripts/stub_erp.py';
    assert.notEqual(s.validators['stub_erp.py'], 'present');
  });
});
