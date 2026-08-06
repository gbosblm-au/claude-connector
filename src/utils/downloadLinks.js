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
// TNX-FEAT-SIGNEDURLS: per-file HMAC signatures replace the global token in
// generated links. See src/utils/signedUrls.js.
import { signedLinksEnabled, buildSignedQuery, linkExpirySeconds } from './signedUrls.js';

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
 * Two link shapes exist:
 *
 *   signed  ?exp=<unix_seconds>&sig=<hex>   (default)
 *   legacy  ?token=<DOCUMENT_DOWNLOAD_TOKEN> (ENABLE_SIGNED_LINKS=false)
 *
 * The legacy shape is retained only as the rollout escape hatch. It has
 * unlimited lifetime and global blast radius, which is what the signed shape
 * exists to remove.
 *
 * @param {string} filename Single path segment, already validated.
 * @param {string} base     Normalised connector base URL.
 * @param {string} query    Pre-built query string, including the leading '?'.
 * @param {number} sizeBytes
 * @param {number|undefined} expiresAt Unix seconds, for signed links only.
 * @returns {{ filename: string, download_url: string, preview_url?: string,
 *             size_bytes: number, expires_at?: string, expires_in_seconds?: number }}
 */
function buildLink( filename, base, query, sizeBytes, expiresAt ) {
  const segment = encodeURIComponent( filename );

  /** @type {any} */
  const link = {
    filename,
    download_url: `${ base }/download/${ segment }${ query }`,
    size_bytes:   sizeBytes,
  };

  if ( PREVIEWABLE.has( extname( filename ).toLowerCase() ) ) {
    link.preview_url = `${ base }/preview/${ segment }${ query }`;
  }

  if ( Number.isFinite( expiresAt ) ) {
    // Surfaced so the caller can tell the user the link is time limited rather
    // than letting them discover it as an unexplained 403 an hour later.
    link.expires_at         = new Date( expiresAt * 1000 ).toISOString();
    link.expires_in_seconds = Math.max( 0, expiresAt - Math.floor( Date.now() / 1000 ) );
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

  // TNX-FEAT-SIGNEDURLS: the legacy global token is only consulted when signed
  // links are switched off. When they are on, DOCUMENT_DOWNLOAD_TOKEN is not
  // required for link generation at all.
  const signed = signedLinksEnabled();

  if ( ! signed && ! token ) {
    warnings.push(
      'ENABLE_SIGNED_LINKS is false and DOCUMENT_DOWNLOAD_TOKEN is not set, so no download ' +
      'URL could be built. Either set the token or leave signed links enabled.' );
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

    if ( signed ) {
      try {
        const { exp, query } = buildSignedQuery( { filename: name } );
        links.push( buildLink( name, base, query, size, exp ) );
      } catch ( err ) {
        // A signing failure must not silently degrade to an unsigned or
        // token-bearing link. Report it and produce nothing for this file.
        warnings.push( `${ name }: could not be signed (${ err.message }); no link produced.` );
      }
      continue;
    }

    links.push( buildLink( name, base, `?token=${ encodeURIComponent( token ) }`, size, undefined ) );
  }

  if ( signed && links.length > 0 ) {
    warnings.push(
      `Links expire after ${ linkExpirySeconds() } seconds. Tell the user the link is time limited.` );
  }

  return { links, warnings };
}

export default { buildDownloadLinks, snapshotDownloads, connectorBaseUrl, downloadsBase };
