// src/tools/coding-delivery.js  v1.0.0   (claude-connector v13.37.0)
// ---------------------------------------------------------------------------
// coding_deliverable_publish: fetch a delivered tree from the frame runner as
// one archive, check it is whole, place it in the downloads directory, and
// return the connector's own signed link for it.
//
// TENAX-2026-10-09-01, Track A, route A1 ("assistant-side fetch, on demand").
//
// WHY THE CONNECTOR FETCHES
// -------------------------
// A coding project ran to final approval and no file reached anyone: the
// deliverables existed as trees addressed by hash in the frame's store, and
// the connector mints links only for files in its own downloads directory.
// Route A1 closes that join with what already exists at both ends. The frame
// serves the tree as a deterministic archive (GET /v1/artefacts/:hash/archive,
// tenax-frame 1.10.0) to a credential of its read-only `reader` role, and this
// tool writes it into /data/downloads and hands it to buildDownloadLinks(), the
// same signed-link path every other produced file uses.
//
// No new route. The tool is reached through the tool layer only: POST
// /tool-call (X-Railway-Restore-Token) from the Gateway Service at final
// approval, or an MCP tool call. There is no HTTP path by which an
// unauthenticated caller can place a file in the downloads directory
// (C-NO-NEW-PUBLIC-WRITE, pinned by src/tests/route-inventory.test.js).
//
// WHAT IT CHECKS BEFORE ANYTHING IS PUBLISHED
// -------------------------------------------
//   - the archive's sha256 is the one the frame declared, and its tree hash is
//     the one asked for;
//   - the archive is COMPLETE: its members, below the root, are exactly the
//     tree's listing plus the manifest, each at the listed size. A subset is
//     refused (C2, C-NEG-SUBSET-ZIP);
//   - the manifest inside it names the tree, the predecessor and the
//     superseded archive the caller asked for (C1, C-FRAME-PREDECESSOR).
//
// Then it is written whole under a temporary name and renamed, so the
// downloads directory never holds half an archive under the published name,
// and only once the file is present at its single-segment name is the link
// built (C-DOWNLOADS-CONTENTS). The URL comes from buildDownloadLinks(); this
// module never assembles one (C-NO-BUILT-URL).
//
// CREDENTIALS
// -----------
// TENAX_FRAME_URL and TENAX_FRAME_READ_TOKEN are read from the environment
// here and never appear in a tool result, a log line or an error message.
// The token should be a FRAME_AUTH_TOKENS entry of role `reader`, which can
// read every tree and write nothing.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { buildDownloadLinks, snapshotDownloads, downloadsBase } from '../utils/downloadLinks.js';
import { isSafeFilename, resolveContained } from '../utils/pathContainment.js';
import { listZipMembers, readZipMember } from '../utils/zipCentralDirectory.js';

/** The tool's name. */
export const CODING_DELIVERY_TOOL = 'coding_deliverable_publish';

/** The manifest the frame writes into every delivery archive, below the root. */
export const DELIVERY_MANIFEST_PATH = '.tenax/delivery.json';

/** The manifest schema this tool reads. */
export const DELIVERY_SCHEMA = 'tenax-delivery-v1';

/** Default bound on a fetched archive: the frame's own upload bound. */
const DEFAULT_MAX_BYTES = 209715200;

/** Default bound on each frame request, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120000;

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An archive root is ONE PATH SEGMENT: 1 to 200 UTF-16 units, no / or \, no
 * control character, not "." or "..". The same rule as tenax-frame 1.10.0's
 * validRoot and the gateway's usableRoot, so a folder the person named "My
 * App" is delivered as "My App/" (TENAX-2026-10-09-01 C3) rather than refused.
 *
 * @param {*} root
 * @returns {boolean}
 */
export function validArchiveRoot( root ) {
  return typeof root === 'string' && root.length > 0 && root.length <= 200
    && root !== '.' && root !== '..' && ! /[\/\\\u0000-\u001f\u007f]/.test( root );
}

/**
 * The frame connection this tool uses, or null when it is not configured.
 *
 * @param {object} [env]
 * @returns {{ url: string, token: string, maxBytes: number, timeoutMs: number }|null}
 */
export function frameDeliveryConfig( env = process.env ) {
  const url = String( env.TENAX_FRAME_URL || '' ).trim().replace( /\/+$/, '' );
  const token = String( env.TENAX_FRAME_READ_TOKEN || '' ).trim();
  if ( ! url || ! token || ! /^https?:\/\//i.test( url ) ) return null;
  const maxBytes = parseInt( env.CODING_DELIVERY_MAX_BYTES || '', 10 );
  const timeoutMs = parseInt( env.CODING_DELIVERY_TIMEOUT_MS || '', 10 );
  return {
    url,
    token,
    maxBytes: Number.isInteger( maxBytes ) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    timeoutMs: Number.isInteger( timeoutMs ) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Is the tool usable on this deployment? It is advertised only when it is.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function frameDeliveryConfigured( env = process.env ) {
  return frameDeliveryConfig( env ) !== null;
}

/** The tool definition advertised to MCP clients and the gateway. */
export const codingDeliverablePublishToolDefinition = {
  name: CODING_DELIVERY_TOOL,
  description:
    'Publish a delivered coding-platform tree as a downloadable ZIP. Fetches the tree from the frame runner as '
    + 'one complete archive (every file of the tree, under its original top-level folder when one is given, with '
    + 'a .tenax/delivery.json manifest listing the changed files and the archive it supersedes), checks it is '
    + 'whole, saves it to the downloads directory and returns a signed download link that expires after 3 days. '
    + 'Present the returned download_url and its expiry to the user exactly as given; never construct a download '
    + 'URL yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      tree_hash: { type: 'string', description: 'The delivered tree\'s hash on the frame runner (64 lowercase hex characters).' },
      filename: { type: 'string', description: 'The file name to publish under: one path segment of letters, digits, dot, dash and underscore, ending -<first 12 characters of tree_hash>.zip.' },
      root: { type: 'string', description: 'Optional top-level folder for every member, as the original upload had it (spaces allowed). One path segment: no / or \\, no control character.' },
      predecessor: { type: 'string', description: 'Optional tree hash the changed-file list is computed against.' },
      supersedes: { type: 'string', description: 'Optional sha256 of the archive this one replaces, recorded in the manifest.' },
      run: { type: 'string', description: 'Optional frame run id whose evidence the manifest carries; it must have run this tree.' },
    },
    required: [ 'tree_hash', 'filename' ],
  },
};

/**
 * Wrap a payload in the MCP content shape.
 *
 * @param {object} payload
 * @param {boolean} [isError]
 * @returns {{ content: Array<{ type: string, text: string }>, isError: boolean }}
 */
function mcp( payload, isError = false ) {
  return { content: [ { type: 'text', text: JSON.stringify( payload, null, 2 ) } ], isError };
}

/**
 * A refusal, by name.
 *
 * @param {string} kind
 * @param {string} message
 * @param {object} [extra]
 * @returns {object}
 */
function refuse( kind, message, extra = {} ) {
  return mcp( { ok: false, tool: CODING_DELIVERY_TOOL, error_kind: kind, message, ...extra }, true );
}

/**
 * Validate the tool input.
 *
 * @param {object} args
 * @returns {{ ok: true, value: object }|{ ok: false, message: string }}
 */
export function validatePublishInput( args ) {
  const a = args && typeof args === 'object' ? args : {};
  const treeHash = typeof a.tree_hash === 'string' ? a.tree_hash.trim() : '';
  if ( ! HEX64.test( treeHash ) ) return { ok: false, message: 'tree_hash must be 64 lowercase hex characters.' };
  const filename = typeof a.filename === 'string' ? a.filename.trim() : '';
  if ( ! isSafeFilename( filename ) || ! filename.toLowerCase().endsWith( '.zip' ) || filename.startsWith( '.' ) ) {
    return { ok: false, message: 'filename must be one path segment of letters, digits, dot, dash and underscore, not starting with a dot, ending .zip.' };
  }
  // The name is bound to the tree it carries: it must end -<first 12 of the
  // tree hash>.zip, as the gateway's deliveryFilename always does. This tool
  // writes into the shared downloads directory and replaces a file of the
  // same name; binding the name to the tree means it can only ever replace
  // an archive named for the same tree, never another tool's output or an
  // unrelated delivery, whoever calls it.
  if ( ! filename.toLowerCase().endsWith( `-${ treeHash.slice( 0, 12 ) }.zip` ) ) {
    return { ok: false, message: `filename must end -${ treeHash.slice( 0, 12 ) }.zip: the first 12 characters of the tree hash it carries.` };
  }
  const opt = ( v ) => ( v === undefined || v === null || v === '' ? null : v );
  const root = opt( a.root );
  if ( root !== null && ! validArchiveRoot( root ) ) {
    return { ok: false, message: 'root must be one path segment: 1 to 200 characters, no / or \\, no control character, not "." or "..".' };
  }
  const predecessor = opt( a.predecessor );
  if ( predecessor !== null && ( typeof predecessor !== 'string' || ! HEX64.test( predecessor ) ) ) {
    return { ok: false, message: 'predecessor must be a tree hash (64 lowercase hex characters).' };
  }
  const supersedes = opt( a.supersedes );
  if ( supersedes !== null && ( typeof supersedes !== 'string' || ! HEX64.test( supersedes ) ) ) {
    return { ok: false, message: 'supersedes must be a sha256 (64 lowercase hex characters).' };
  }
  const run = opt( a.run );
  if ( run !== null && ( typeof run !== 'string' || ! RUN_ID.test( run ) ) ) {
    return { ok: false, message: 'run must be a frame run id.' };
  }
  return { ok: true, value: { treeHash, filename, root, predecessor, supersedes, run } };
}

/**
 * Read a response body with a byte bound, refusing as soon as it is passed.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function boundedBody( res, maxBytes ) {
  const declared = parseInt( res.headers.get( 'content-length' ) || '', 10 );
  if ( Number.isInteger( declared ) && declared > maxBytes ) {
    const err = new Error( `The archive is ${ declared } bytes, above the ${ maxBytes }-byte bound.` );
    err.code = 'archive_too_large';
    throw err;
  }
  if ( ! res.body || typeof res.body.getReader !== 'function' ) {
    const buf = Buffer.from( await res.arrayBuffer() );
    if ( buf.length > maxBytes ) {
      const err = new Error( `The archive is ${ buf.length } bytes, above the ${ maxBytes }-byte bound.` );
      err.code = 'archive_too_large';
      throw err;
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for ( ;; ) {
    const { done, value } = await reader.read();
    if ( done ) break;
    total += value.length;
    if ( total > maxBytes ) {
      try { await reader.cancel(); } catch { /* already closed */ }
      const err = new Error( `The archive passed the ${ maxBytes }-byte bound while it was being read.` );
      err.code = 'archive_too_large';
      throw err;
    }
    chunks.push( Buffer.from( value ) );
  }
  return Buffer.concat( chunks );
}

/**
 * Check that an archive holds the whole tree and nothing else, and read its
 * manifest.
 *
 * @param {Buffer} archive
 * @param {Array<{ path: string, bytes: number }>} entries The tree's listing.
 * @param {string|null} root
 * @returns {{ ok: true, manifest: object, members: number }|{ ok: false, kind: string, message: string, detail?: object }}
 */
export function checkArchiveComplete( archive, entries, root ) {
  let members;
  try {
    members = listZipMembers( archive );
  } catch ( err ) {
    return { ok: false, kind: 'archive_unreadable', message: err.message };
  }
  const prefix = root ? `${ root }/` : '';
  const expected = new Map( entries.map( ( e ) => [ e.path, e.bytes ] ) );
  const missing = new Set( expected.keys() );
  const unexpected = [];
  const wrongSize = [];
  let manifestMember = null;
  for ( const m of members ) {
    if ( m.directory ) continue;
    if ( m.encrypted ) return { ok: false, kind: 'archive_unreadable', message: `${ m.name } is encrypted.` };
    if ( ! m.name.startsWith( prefix ) ) { unexpected.push( m.name ); continue; }
    const rel = m.name.slice( prefix.length );
    if ( rel === DELIVERY_MANIFEST_PATH ) { manifestMember = m; continue; }
    if ( ! expected.has( rel ) ) { unexpected.push( m.name ); continue; }
    if ( ! missing.has( rel ) ) { unexpected.push( `${ m.name } (twice)` ); continue; }
    missing.delete( rel );
    if ( m.size !== expected.get( rel ) ) wrongSize.push( `${ rel }: ${ m.size } bytes, listed ${ expected.get( rel ) }` );
  }
  if ( missing.size || unexpected.length || wrongSize.length ) {
    return {
      ok: false,
      kind: 'archive_incomplete',
      message: `The archive is not the whole tree: ${ missing.size } listed file(s) missing, `
        + `${ unexpected.length } member(s) not in the listing, ${ wrongSize.length } at the wrong size. `
        + 'A subset of a tree is not a deliverable.',
      detail: {
        missing: [ ...missing ].slice( 0, 20 ),
        unexpected: unexpected.slice( 0, 20 ),
        wrong_size: wrongSize.slice( 0, 20 ),
      },
    };
  }
  if ( ! manifestMember ) {
    return { ok: false, kind: 'archive_manifest_missing', message: `The archive has no ${ prefix }${ DELIVERY_MANIFEST_PATH }.` };
  }
  let manifest;
  try {
    manifest = JSON.parse( readZipMember( archive, manifestMember ).toString( 'utf8' ) );
  } catch ( err ) {
    return { ok: false, kind: 'archive_manifest_unreadable', message: err.message };
  }
  if ( ! manifest || manifest.schema !== DELIVERY_SCHEMA ) {
    return { ok: false, kind: 'archive_manifest_unreadable', message: `The manifest is not ${ DELIVERY_SCHEMA }.` };
  }
  return { ok: true, manifest, members: members.length };
}

/**
 * Fetch, check, place and link one delivered tree.
 *
 * @param {object} args The tool input.
 * @param {object} [deps]
 * @param {Function} [deps.fetch] Replaces the global fetch, for tests.
 * @param {object} [deps.env] Replaces process.env, for tests.
 * @returns {Promise<{ content: Array<object>, isError: boolean }>}
 */
export async function handleCodingDeliverablePublish( args, deps = {} ) {
  const doFetch = deps.fetch || globalThis.fetch;
  const env = deps.env || process.env;
  const cfg = frameDeliveryConfig( env );
  if ( ! cfg ) {
    return refuse( 'frame_not_configured',
      'This connector cannot reach the frame runner: set TENAX_FRAME_URL and TENAX_FRAME_READ_TOKEN '
      + '(a FRAME_AUTH_TOKENS entry of role reader) on the connector service.' );
  }
  const v = validatePublishInput( args );
  if ( ! v.ok ) return refuse( 'invalid_input', v.message );
  const { treeHash, filename, root, predecessor, supersedes, run } = v.value;
  const auth = { Authorization: `Bearer ${ cfg.token }` };

  // 1. The tree's listing, which the archive must match member for member.
  let listing;
  try {
    const r = await doFetch( `${ cfg.url }/v1/tree/${ treeHash }`, { headers: auth, signal: AbortSignal.timeout( cfg.timeoutMs ) } );
    if ( r.status === 404 ) return refuse( 'tree_not_found', `The frame runner has no tree ${ treeHash }.` );
    if ( r.status === 401 || r.status === 403 ) {
      return refuse( 'frame_refused', `The frame runner refused the connector's read credential (HTTP ${ r.status }).` );
    }
    if ( ! r.ok ) return refuse( 'frame_error', `The frame runner answered HTTP ${ r.status } for the tree listing.` );
    listing = await r.json();
  } catch ( err ) {
    return refuse( 'frame_unreachable', `The frame runner could not be reached for the tree listing: ${ err.name === 'TimeoutError' ? 'timed out' : err.message }.` );
  }
  if ( ! listing || listing.tree_hash !== treeHash || ! Array.isArray( listing.entries ) ) {
    return refuse( 'frame_error', 'The frame runner\'s listing does not describe the tree that was asked for.' );
  }

  // 2. The archive.
  const q = new URLSearchParams();
  if ( root ) q.set( 'root', root );
  if ( predecessor ) q.set( 'predecessor', predecessor );
  if ( supersedes ) q.set( 'supersedes', supersedes );
  if ( run ) q.set( 'run', run );
  const qs = q.toString();
  let archive;
  let declaredSha;
  try {
    const r = await doFetch( `${ cfg.url }/v1/artefacts/${ treeHash }/archive${ qs ? `?${ qs }` : '' }`,
      { headers: auth, signal: AbortSignal.timeout( cfg.timeoutMs ) } );
    if ( ! r.ok ) {
      let body = {};
      try { body = await r.json(); } catch { body = {}; }
      return refuse( 'frame_refused_archive', `The frame runner refused the archive (HTTP ${ r.status }`
        + `${ body.error ? `, ${ body.error }` : '' })${ body.message ? `: ${ body.message }` : '.' }`,
      { frame_status: r.status, frame_error: body.error || null } );
    }
    if ( r.headers.get( 'x-frame-tree-hash' ) !== treeHash ) {
      return refuse( 'archive_mismatch', 'The archive the frame runner returned is of a different tree.' );
    }
    declaredSha = String( r.headers.get( 'x-frame-archive-sha256' ) || '' );
    archive = await boundedBody( r, cfg.maxBytes );
  } catch ( err ) {
    if ( err.code === 'archive_too_large' ) return refuse( 'archive_too_large', err.message, { limit_bytes: cfg.maxBytes } );
    return refuse( 'frame_unreachable', `The archive could not be fetched: ${ err.name === 'TimeoutError' ? 'timed out' : err.message }.` );
  }
  const sha256 = createHash( 'sha256' ).update( archive ).digest( 'hex' );
  if ( ! HEX64.test( declaredSha ) || declaredSha !== sha256 ) {
    return refuse( 'archive_mismatch', 'The archive\'s sha256 is not the one the frame runner declared; it was altered or cut short in transit.' );
  }

  // 3. Whole, and the manifest says what was asked.
  const checked = checkArchiveComplete( archive, listing.entries, root );
  if ( ! checked.ok ) return refuse( checked.kind, checked.message, checked.detail ? { detail: checked.detail } : {} );
  const m = checked.manifest;
  if ( m.tree_hash !== treeHash || ( m.predecessor_tree_hash || null ) !== predecessor
    || ( m.supersedes_archive_sha256 || null ) !== supersedes || ( m.archive_root || null ) !== root ) {
    return refuse( 'archive_manifest_mismatch',
      'The archive\'s manifest does not record the tree, predecessor, superseded archive or root that was asked for.' );
  }

  // 4. Placed whole under its published name, then linked.
  const dir = downloadsBase();
  const target = resolveContained( dir, filename );
  if ( ! target ) return refuse( 'invalid_input', 'The filename does not resolve inside the downloads directory.' );
  const temp = joinPath( dir, `.${ filename }.${ process.pid }.${ randomBytes( 6 ).toString( 'hex' ) }.partial` );
  const before = snapshotDownloads();
  try {
    if ( ! existsSync( dir ) ) mkdirSync( dir, { recursive: true } );
    writeFileSync( temp, archive );
    renameSync( temp, target );
  } catch ( err ) {
    try { if ( existsSync( temp ) ) unlinkSync( temp ); } catch { /* best effort */ }
    return refuse( 'write_failed', `The archive could not be written to the downloads directory: ${ err.code || err.message }.` );
  }
  let onDisk;
  try { onDisk = statSync( target ); } catch { onDisk = null; }
  if ( ! onDisk || ! onDisk.isFile() || onDisk.size !== archive.length ) {
    return refuse( 'write_failed', 'The archive is not present in the downloads directory at its full size after writing.' );
  }

  const built = buildDownloadLinks( { before, declared: [ filename ] } );
  const link = built.links.find( ( l ) => l.filename === filename );
  if ( ! link ) {
    return refuse( 'link_unavailable', 'The archive was saved but no download link could be built.',
      { filename, warnings: built.warnings } );
  }
  return mcp( {
    ok: true,
    tool: CODING_DELIVERY_TOOL,
    filename,
    download_url: link.download_url,
    expires_at: link.expires_at || null,
    expires_in_seconds: Number.isFinite( link.expires_in_seconds ) ? link.expires_in_seconds : null,
    size_bytes: archive.length,
    archive_sha256: sha256,
    tree_hash: treeHash,
    members: checked.members,
    manifest: {
      archive_root: m.archive_root || null,
      entry_count: m.entry_count,
      total_bytes: m.total_bytes,
      predecessor_tree_hash: m.predecessor_tree_hash || null,
      supersedes_archive_sha256: m.supersedes_archive_sha256 || null,
      changed_files: m.changed_files || null,
      excluded: Array.isArray( m.excluded ) ? m.excluded : [],
      run: m.run || null,
      generated_by: m.generated_by || null,
    },
    // Only this file's link: other files that changed in the directory at the
    // same moment belong to other calls.
    warnings: built.warnings.filter( ( w ) => ! /^\S+: / .test( w ) || w.startsWith( `${ filename }:` ) ),
  } );
}

export default {
  CODING_DELIVERY_TOOL, DELIVERY_MANIFEST_PATH, DELIVERY_SCHEMA, codingDeliverablePublishToolDefinition,
  frameDeliveryConfig, frameDeliveryConfigured, validatePublishInput, checkArchiveComplete, handleCodingDeliverablePublish,
};
