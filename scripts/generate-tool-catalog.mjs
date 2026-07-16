#!/usr/bin/env node
/**
 * generate-tool-catalog.mjs  (connector v12.11.0)
 *
 * Generates brain_tools_catalog.json - the tool registry the Neural Core
 * scanner reads to build its tool belt.
 *
 * You usually do not need this. The running connector writes the same file to
 * the volume at every boot from its own live registry (see
 * src/tools/brain-scan-trigger.js -> writeToolCatalog), which is what keeps the
 * catalogue and the connector in lockstep without anyone remembering a step.
 *
 * This script exists for the cases where no connector is running:
 *
 *   · seeding a volume before the connector is deployed
 *   · shipping a catalogue alongside a standalone copy of brain_scan.py
 *   · inspecting what the tool surface looks like in a diff or a review
 *
 * It imports every tool definition module directly rather than booting the
 * server, so it needs no port, no token and no environment.
 *
 * Scope note: this produces the SUPERSET - every tool defined anywhere in the
 * codebase. The connector's boot-time write produces what that deployment
 * actually exposes, which is narrower: the TOOLS registry is assembled
 * conditionally on isTenantMode(), MEMORY_ENABLED, SKILL_ENABLED and friends.
 * The two are meant to differ. The boot write is authoritative and overwrites
 * this file within seconds of a deployment; this script is for seeding a volume
 * before a connector exists to do that.
 *
 * Usage:
 *   node scripts/generate-tool-catalog.mjs                    # -> stdout
 *   node scripts/generate-tool-catalog.mjs -o catalog.json    # -> file
 *   npm run generate-tool-catalog -- -o /tmp/catalog.json
 *
 * Exit codes: 0 wrote a catalogue, 1 found no tools (something is wrong).
 */

import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// Every directory holding tool definitions. src/tools-stats was missed on the
// first pass, which silently cost the catalogue 33 tools - the whole
// stats_*/ml_*/data_*/ts_* family. If a new tools-* directory appears, it goes
// here.
const TOOL_DIRS = ['src/tools', 'src/tools-memory', 'src/tools-stats'];
const MAX_DESCRIPTION = 200;

/** @returns {{out: string|null, quiet: boolean}} */
function parseArgs(argv) {
  const out = { out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-o' || argv[i] === '--out') && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === '-q' || argv[i] === '--quiet') out.quiet = true;
  }
  return out;
}

/**
 * A tool definition is any exported object carrying a name, a description and
 * an input schema. Matching on shape rather than on an export-name convention
 * means a tool cannot be missed for being exported under an unexpected alias.
 */
function isToolDefinition(value) {
  return value
    && typeof value === 'object'
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.description === 'string'
    && (value.inputSchema || value.input_schema);
}

async function collectTools(log) {
  const byName = new Map();
  const skipped = [];

  for (const dir of TOOL_DIRS) {
    const absoluteDir = join(ROOT, dir);
    if (!existsSync(absoluteDir)) {
      log(`  ${dir}: not present, skipping`);
      continue;
    }

    for (const file of readdirSync(absoluteDir).sort()) {
      if (!file.endsWith('.js') || file.includes('.test.')) continue;

      let module;
      try {
        module = await import(pathToFileURL(join(absoluteDir, file)).href);
      } catch (err) {
        // A module that will not import is usually a missing optional
        // dependency. Report it rather than silently shipping a short list.
        skipped.push(`${dir}/${file}: ${err.message.split('\n')[0]}`);
        continue;
      }

      for (const exported of Object.values(module)) {
        const candidates = Array.isArray(exported) ? exported : [exported];
        for (const candidate of candidates) {
          if (!isToolDefinition(candidate) || byName.has(candidate.name)) continue;
          let description = String(candidate.description).replace(/\s+/g, ' ').trim();
          if (description.length > MAX_DESCRIPTION) {
            description = `${description.slice(0, MAX_DESCRIPTION - 3).trimEnd()}...`;
          }
          byName.set(candidate.name, { name: candidate.name, description });
        }
      }
    }
  }

  return { tools: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

  let version = 'unknown';
  try {
    const pkg = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8'));
    version = String(pkg.version || 'unknown');
  } catch (_) {
    log('! could not read package.json; recording version "unknown"');
  }

  log(`Scanning tool definitions in ${TOOL_DIRS.join(', ')} ...`);
  const { tools, skipped } = await collectTools(log);

  for (const note of skipped) log(`! skipped ${note}`);

  if (!tools.length) {
    process.stderr.write(
      'No tool definitions found. Run this from the connector repo with dependencies installed (npm install).\n'
    );
    process.exit(1);
  }

  const payload = {
    _comment: 'Tool catalogue for brain_scan.py. Generated by scripts/generate-tool-catalog.mjs. The running connector overwrites this on the volume at every boot.',
    connector_version: version,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tool_count: tools.length,
    tools,
  };

  const json = `${JSON.stringify(payload, null, 1)}\n`;

  if (args.out) {
    writeFileSync(args.out, json, 'utf8');
    log(`Wrote ${tools.length} tools (connector ${version}) -> ${args.out}`);
  } else {
    process.stdout.write(json);
    log(`Wrote ${tools.length} tools (connector ${version}) -> stdout`);
  }

  if (skipped.length) {
    log(`\n${skipped.length} module(s) could not be imported. The catalogue may be incomplete.`);
    log('Run npm install and try again if that was not expected.');
  }
}

main().catch((err) => {
  process.stderr.write(`generate-tool-catalog failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
