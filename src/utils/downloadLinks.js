// src/utils/downloadLinks.js  v1.0.0
// ---------------------------------------------------------------------------
// Server-side construction of document download and preview URLs.
//
// WHY THIS EXISTS
// ---------------
// The end objective is a link of the form
//
//     https://<connector>/download/<Name>.<ext>?token=<DOCUMENT_DOWNLOAD_TOKEN>
//
// rendered in the chat UI after a script produces a document. The obvious route
// to that is to hand CONNECTOR_URL and DOCUMENT_DOWNLOAD_TOKEN to the model so
// it can assemble the string itself. That works, and it is the wrong shape:
//
//   - The token enters the model's context, so it is written to the
//     conversation store, to any transcript export, to the gateway's request
//     logs, and to whatever observability the platform runs. It is a
//     long-lived shared credential with no per-file scope, so a single leaked
//     transcript grants read access to every document on the volume.
//   - A model that holds a credential can be induced to emit it. Prompt content
//     on this connector arrives from fetched web pages and uploaded documents,
//     which is the same untrusted channel the SSRF and path-containment
//     controls already assume is hostile.
//   - The model has to reconstruct the URL correctly every time. Percent
//     encoding, a trailing slash on CONNECTOR_URL, or a missing scheme each
//     produce a broken link that looks plausible.
//
// The connector already knows both values. It is the process that reads them
// from the environment, and it is the process that serves /download. So it
// builds the URL and returns the finished string. The model receives a link it
// can render and never receives the credential.
//
// This module is deliberately separate from server-http.js so that
// script-execute.js can use it without importing the HTTP server.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveContained, isSafeFilename } from './pathContainment.js';

/**
 * Directory served by GET /download/:filename.
 *
 * Kept overridable so tests do not need a /data mount. The default matches
 * DOWNLOADS_BASE in server-http.js; if one changes the other must change with
 * it, which is why both read the same variable name.
 *
 * @returns {string} Absolute path to the downloads directory.
 */
export function downloadsBase() {
  return process.env.DOWNLOADS_DIR || '/data/downloads';
}

/**
 * Extensions that GET /preview/:filename can render.
 * Anything else gets a download link only.
 */
const PREVIEWABLE = new Set( [ '.html', '.docx' ] );

/**
 * Maximum number of links returned from a single execution. A runaway script
 * that writes a thousand files must not produce a thousand-entry tool result.
 */
const MAX_LINKS = 25;

/**
 * Normalise the configured connector base URL.
 *
 * CONNECTOR_URL is set as a Railway variable on the connector service. Three
 * things are corrected here, each of which has produced a broken link in
 * practice:
 *
 *   - a missing scheme  ("connector.example.com")
 *   - a trailing slash  ("https://x/" -> "https://x//download/...")
 *   - surrounding whitespace from a copy-pasted variable value
 *
 * Returns an empty string when nothing usable is configured, so the caller can
 * report the misconfiguration rather than emitting "undefined/download/x.docx".
 *
 * @returns {string} Base URL with no trailing slash, or an empty string.
 */
export function connectorBaseUrl() {
  let raw = String( process.env.CONNECTOR_URL || '' ).trim();

  // Fall back to the platform-provided hostname so a deployment that has not
  // set CONNECTOR_URL still produces working links rather than none. This
  // matches the derivation used by GET /api/config.js.
  if ( ! raw && process.env.RAILWAY_PUBLIC_DOMAIN ) {
    raw = `https://${ String( process.env.RAILWAY_PUBLIC_DOMAIN ).trim() }`;
  }

  if ( ! raw ) return '';

  if ( ! /^https?:\/\//i.test( raw ) ) raw = `https://${ raw }`;

  return raw.replace( /\/+$/, '' );
}

/**
 * The token GET /download accepts.
 *
 * documentTokenValid() in server-http.js accepts either DOCUMENT_DOWNLOAD_TOKEN
 * or RAILWAY_RESTORE_TOKEN. The link must carry the former where it exists:
 * RAILWAY_RESTORE_TOKEN also authenticates the restore and tool-dispatch
 * endpoints, so putting it in a URL that reaches a browser address bar would
 * escalate a link leak into full connector control.
 *
 * @returns {string} The download token, or an empty string when unconfigured.
 */
function downloadToken() {
  return String( process.env.DOCUMENT_DOWNLOAD_TOKEN || '' ).trim();
}

/**
 * Snapshot the downloads directory.
 *
 * Used to identify which files an execution produced without requiring the
 * script to cooperate. Keyed by filename, valued by "size:mtimeMs" so that a
 * script overwriting an existing document is detected as a change, not skipped
 * because the name already existed.
 *
 * A missing or unreadable directory yields an empty map rather than throwing.
 * Link generation is a convenience layered on top of script execution and must
 * never be able to fail the execution itself.
 *
 * @returns {Map<string, string>} filename -> fingerprint
 */
export function snapshotDownloads() {
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  const base = downloadsBase();

  if ( ! existsSync( base ) ) return snapshot;

  try {
    for ( const name of readdirSync( base ) ) {
      if ( ! isSafeFilename( name ) ) continue;
      const full = resolveContained( base, name );
      if ( ! full ) continue;
      try {
        const st = statSync( full );
        if ( ! st.isFile() ) continue;
        snapshot.set( name, `${ st.size }:${ st.mtimeMs }` );
      } catch { /* raced with a delete; not our file */ }
    }
  } catch ( err ) {
    console.error( `[downloadLinks] Could not read ${ base }: ${ err.message }` );
  }

  return snapshot;
}

/**
 * Build a single link record.
 *
 * @param {string} filename Single path segment, already validated.
 * @param {string} base     Normalised connector base URL.
 * @param {string} token    Download token.
 * @param {number} sizeBytes
 * @returns {{ filename: string, download_url: string, preview_url?: string, size_bytes: number }}
 */
function buildLink( filename, base, token, sizeBytes ) {
  // encodeURIComponent on the segment and on the token. isSafeFilename already
  // restricts the name to [A-Za-z0-9._-], so this is belt and braces there, but
  // the token is operator-supplied and may legitimately contain characters that
  // are not query-safe.
  const segment = encodeURIComponent( filename );
  const qs      = `?token=${ encodeURIComponent( token ) }`;

  /** @type {{ filename: string, download_url: string, preview_url?: string, size_bytes: number }} */
  const link = {
    filename,
    download_url: `${ base }/download/${ segment }${ qs }`,
    size_bytes:   sizeBytes,
  };

  if ( PREVIEWABLE.has( extname( filename ).toLowerCase() ) ) {
    link.preview_url = `${ base }/preview/${ segment }${ qs }`;
  }

  return link;
}

/**
 * Produce download links for files an execution created or modified.
 *
 * @param {object}  opts
 * @param {Map<string,string>} opts.before  Result of snapshotDownloads() taken
 *                                          before the script ran.
 * @param {string[]} [opts.declared=[]]     Filenames the caller explicitly
 *                                          asked to link. Included even when
 *                                          the file predates the run, so a
 *                                          script that regenerates identical
 *                                          bytes still yields a link.
 * @returns {{ links: Array<object>, warnings: string[] }}
 */
export function buildDownloadLinks( opts = {} ) {
  const { before = new Map(), declared = [] } = opts;

  /** @type {string[]} */
  const warnings = [];
  const base  = connectorBaseUrl();
  const token = downloadToken();

  // Names first, so a misconfiguration is reported once rather than per file.
  const after   = snapshotDownloads();
  const changed = [];

  for ( const [ name, fingerprint ] of after ) {
    if ( before.get( name ) !== fingerprint ) changed.push( name );
  }

  const wanted = new Set( changed );

  for ( const raw of Array.isArray( declared ) ? declared : [] ) {
    const name = String( raw || '' ).trim();
    if ( ! name ) continue;
    if ( ! isSafeFilename( name ) ) {
      warnings.push( `${ name }: not a valid single-segment filename; no link produced.` );
      continue;
    }
    if ( ! after.has( name ) ) {
      warnings.push( `${ name }: not present in the downloads directory after execution; no link produced.` );
      continue;
    }
    wanted.add( name );
  }

  if ( wanted.size === 0 ) return { links: [], warnings };

  if ( ! base ) {
    warnings.push( 'CONNECTOR_URL is not set on the connector service, so no download URL could be built.' );
    return { links: [], warnings };
  }

  if ( ! token ) {
    warnings.push( 'DOCUMENT_DOWNLOAD_TOKEN is not set on the connector service, so no download URL could be built.' );
    return { links: [], warnings };
  }

  const names = [ ...wanted ].sort();

  if ( names.length > MAX_LINKS ) {
    warnings.push( `${ names.length } files changed; returning the first ${ MAX_LINKS }.` );
    names.length = MAX_LINKS;
  }

  const links = [];

  for ( const name of names ) {
    const full = resolveContained( downloadsBase(), name );
    if ( ! full ) continue;
    let size = 0;
    try { size = statSync( full ).size; } catch { continue; }
    links.push( buildLink( name, base, token, size ) );
  }

  return { links, warnings };
}

export default { buildDownloadLinks, snapshotDownloads, connectorBaseUrl, downloadsBase };
