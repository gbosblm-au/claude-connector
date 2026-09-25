// src/tools/bundle-tools.js  v13.29.0
//
// MCP surface for source bundles. SPEC-SOURCE-BUNDLE-001 s10, s11.
//
//   bundle_ingest    an uploaded archive (by its /data/uploads path) into a bundle
//   bundle_list      entries: path, size, class, sha256
//   bundle_manifest  the whole manifest, with counts, exclusions and refusals
//   bundle_read      one entry by path, line-numbered, paged by line range
//   bundle_search    across every text entry: path, line number, matching line
//
// These tools sit behind MCP authentication, and they are the ONLY way to
// ingest, read, list or search a bundle. The browser's upload route
// (POST /data/upload) is unauthenticated: it stores the file and classifies its
// bytes, and it does NOT ingest. It did in v13.29.0, which let an
// unauthenticated request replace the contents of a bundle by name; that branch
// was removed in v13.30.0 and `bundle: true` is now accepted and ignored.

import { resolve } from 'node:path';
import {
  ingestBundleFromFile, listEntries, getManifest, readEntry, searchBundle, BundleError,
} from '../bundles/bundle-store.js';

function uploadRoot() {
  return process.env.USER_DATA_UPLOAD_DIR || '/data/uploads/';
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  const payload = err instanceof BundleError
    ? { error: err.message, code: err.code, ...(err.detail ? { detail: err.detail } : {}) }
    : { error: `Bundle operation failed: ${err.message}`, code: 'internal_error' };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

const ID = { type: 'string', description: 'The bundle_id returned by bundle_ingest (bnd_ followed by 20 hex characters).' };

export const bundleIngestToolDefinition = {
  name: 'bundle_ingest',
  description:
    'Ingest an uploaded archive (a zip of a codebase, for example) as a source bundle: every file becomes '
    + 'readable by path, including .js, .mjs and files with no extension such as Dockerfile. Classification is '
    + 'by content, not name. Returns bundle_id, tree_hash, counts that reconcile (total = included + excluded + '
    + 'refused), every entry, the exclusions applied (.git/, node_modules/, dist/, build/ and others) and every '
    + 'refusal with its code. Re-ingesting the same file name updates the bundle and reports added, removed and '
    + 'changed paths. Bundles expire like uploads. A bundle is not a book and never enters the reading vault.',
  inputSchema: {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'The filepath returned by the upload, under the uploads directory.' },
      name: { type: 'string', description: 'Optional bundle name. Defaults to the uploaded file name; the same name updates the same bundle.' },
      ttl_hours: { type: 'number', description: 'Optional lifetime in hours, clamped to the uploads ceiling.' },
    },
    required: ['filepath'],
  },
};

export const bundleListToolDefinition = {
  name: 'bundle_list',
  description: 'List a bundle\'s readable entries (path, size, class, sha256), optionally filtered by class or path prefix. Paged.',
  inputSchema: {
    type: 'object',
    properties: {
      bundle_id: ID,
      class: { type: 'string', enum: ['text', 'text-uncertain', 'binary', 'archive', 'unsupported'] },
      path_prefix: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'At most 1000. Default 500.' },
    },
    required: ['bundle_id'],
  },
};

export const bundleManifestToolDefinition = {
  name: 'bundle_manifest',
  description: 'The full manifest of a bundle: tree hash, reconciled counts, every entry, every exclusion with its rule, every refusal with its code, and whether the ingest was complete.',
  inputSchema: { type: 'object', properties: { bundle_id: ID }, required: ['bundle_id'] },
};

export const bundleReadToolDefinition = {
  name: 'bundle_read',
  description:
    'Read one bundle entry by path, with line numbers. Source files up to 256 KB are returned whole; longer ones are '
    + 'paged with start_line and max_lines. Bytes are verified against the manifest hash on every read. Binary entries '
    + 'return metadata only (code binary_body_not_returned); pass preview "hex" or "ascii" to get the first bytes. '
    + 'A read of a path the ingest excluded answers entry_excluded with the rule, and a path the ingest refused answers '
    + 'with that refusal\'s own code (entry_symlink_refused, for example), so the answer says why, not just that it is absent.',
  inputSchema: {
    type: 'object',
    properties: {
      bundle_id: ID,
      path: { type: 'string', description: 'Entry path exactly as listed. Entries inside a nested archive use "outer.zip!/inner/path".' },
      start_line: { type: 'number', description: '1-based. Default 1.' },
      max_lines: { type: 'number', description: 'Default 2000, at most 5000.' },
      preview: { type: 'string', enum: ['hex', 'ascii'], description: 'Binary entries only.' },
      preview_bytes: { type: 'number', description: 'Preview length, at most 4096. Default 256.' },
    },
    required: ['bundle_id', 'path'],
  },
};

export const bundleSearchToolDefinition = {
  name: 'bundle_search',
  description: 'Search every text entry of a bundle. Returns entry path, line number and the matching line, with entries_searched. Literal by default; set regex true for a regular expression, which runs under a time budget: if it runs out the result carries truncated: true and truncated_by: time_budget, and a scan that finished having found nothing carries neither, so an empty result is distinguishable from an abandoned one. Any entry whose stored bytes fail their hash is skipped and named in integrity_failures.',
  inputSchema: {
    type: 'object',
    properties: {
      bundle_id: ID,
      query: { type: 'string' },
      regex: { type: 'boolean' },
      case_sensitive: { type: 'boolean' },
      path_prefix: { type: 'string' },
      max_results: { type: 'number', description: 'Default 200, at most 1000.' },
    },
    required: ['bundle_id', 'query'],
  },
};

export const bundleToolDefinitions = [
  bundleIngestToolDefinition, bundleListToolDefinition, bundleManifestToolDefinition,
  bundleReadToolDefinition, bundleSearchToolDefinition,
];

export async function handleBundleIngest(args) {
  try {
    const a = args || {};
    if (!a.filepath) throw new BundleError('bundle_source_not_found', 'filepath is required.');
    return ok(ingestBundleFromFile(resolve(String(a.filepath)), uploadRoot(), { name: a.name, ttl_hours: a.ttl_hours }));
  } catch (err) { return fail(err); }
}

export async function handleBundleList(args) {
  try { return ok(listEntries(args?.bundle_id, args || {})); } catch (err) { return fail(err); }
}

export async function handleBundleManifest(args) {
  try { return ok(getManifest(args?.bundle_id)); } catch (err) { return fail(err); }
}

export async function handleBundleRead(args) {
  try { return ok(readEntry(args?.bundle_id, args?.path, args || {})); } catch (err) { return fail(err); }
}

export async function handleBundleSearch(args) {
  // v13.30.0: a regex scan runs in a worker thread with a hard kill at the
  // time budget, so this awaits.
  try { return ok(await searchBundle(args?.bundle_id, args || {})); } catch (err) { return fail(err); }
}
