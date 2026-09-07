// src/tools/webSourceForward.js
//
// Fetch-triggered passive ingestion: the connector side. v13.26.0
//
// PURPOSE
//   After a successful web_fetch_page, forward the FULL extracted page text to
//   the gateway so it can be stored. The model separately receives a view of
//   that text clipped to max_chars. Storage and reading are decoupled: the
//   store holds the whole page, the clip governs only what is read.
//
// WHY THE FULL TEXT IS NOT IN THE TOOL RESULT
//   The gateway returns the web_fetch_page result verbatim to the model.
//   Putting the full body there would defeat max_chars and flood the context
//   window, which is the opposite of what full-text storage is for. So the
//   body travels on this separate path and never touches the model's context.
//
// THIS MODULE MAKES NO AUTHORITY DECISION
//   It does not know what a high-authority domain is, does not import an
//   authority model, and must never grow one. The gateway's ingestionDecision
//   is the single source of truth for store-or-refuse. Every fetched page is
//   forwarded and the gateway decides.
//
//   That costs one small POST per fetch for pages that will be refused. It buys
//   drift-freedom: with the gate in exactly one place there is no second copy
//   to fall out of step with the first. A medium-authority or news page is
//   answered with a 200 and `ingested: false`, not an error, precisely so this
//   module is never tempted to start pre-filtering.
//
// FAILURE POLICY
//   Never throws, never blocks, never retries. The caller has already got the
//   page and the user is waiting on an answer, not on a cache write. Every
//   failure is logged at debug or warn and dropped.

import { log } from "../utils/logger.js";
import { webSourceIngestRemote, gatewayConfigured } from "./ti-tools-client.js";

/**
 * Forward one fetched page to the gateway's web-source store.
 *
 * Fire-and-forget: returns immediately and settles in the background. The
 * returned promise is exposed only so tests can await the settle; production
 * callers ignore it deliberately.
 *
 * @param {{url: string, title?: string|null, text: string,
 *          streamTruncated?: boolean}} page
 * @returns {Promise<{forwarded: boolean, reason?: string, result?: object}>}
 */
export async function forwardFetchedPage( page ) {
  try {
    const p = page || {};

    const url = typeof p.url === "string" ? p.url.trim() : "";
    if (!url) return { forwarded: false, reason: "no_url" };

    const text = typeof p.text === "string" ? p.text : "";
    if (!text.trim()) return { forwarded: false, reason: "no_text" };

    // No gateway configured means the connector is running standalone, e.g.
    // over stdio against a local client. There is nowhere to store to, and that
    // is a normal configuration rather than an error.
    if (!gatewayConfigured()) {
      log("debug", "web_source_forward: no gateway configured, skipping ingestion");
      return { forwarded: false, reason: "no_gateway" };
    }

    // The body is the PAGE AND NOTHING ELSE. No tenant, no user, no session, no
    // query, no tool arguments. The gateway rejects nothing here on those
    // grounds because there is nothing to reject: the fields are the four
    // below, and a whitelist test on the connector side asserts it stays that
    // way.
    //
    // streamTruncated is forwarded rather than acted on. This module does not
    // decide that a cut page is unstorable; it reports what the fetch layer
    // observed and lets the gateway refuse. Same principle as authority.
    const result = await webSourceIngestRemote( {
      url,
      text,
      title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : null,
      stream_truncated: p.streamTruncated === true,
    } );

    if (result && result.ingested) {
      log("info",
        `web_source_forward: stored ${url} (${result.char_count} chars` +
        `${result.oversize ? ", OVERSIZE" : ""}, ` +
        `${result.created ? "created" : "updated"})`);
    } else {
      log("debug",
        `web_source_forward: not stored (${result && result.reason}): ${url}`);
    }

    return { forwarded: true, result };
  } catch (err) {
    // Includes the network failure, the non-2xx and the timeout. All are
    // survivable: the page was still fetched and returned to the caller.
    log("warn", `web_source_forward failed: ${err.message}`);
    return { forwarded: false, reason: "error", error: err.message };
  }
}

export default { forwardFetchedPage };
