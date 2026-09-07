// src/tools/webFetch.js
//
// Full-page web fetch and text extraction for claude-connector v8.0.0
//
// TOOLS PROVIDED:
//   web_fetch_page  -- Fetch a URL and return extracted plain text, metadata,
//                      and structured sections (title, description, headings, links)
//
// PURPOSE:
//   web_search returns brief snippets (150-400 chars per result). When Claude
//   needs to read the full content of a specific URL, web_fetch_page fetches
//   the raw HTML, strips boilerplate (scripts, styles, nav, footer), and returns
//   clean readable text - up to max_chars characters.
//
// DEPENDENCIES:
//   Uses the cheerio library already present in package.json (installed for
//   leadSearch.js). No new dependencies required.

import { CONNECTOR_USER_AGENT } from "../config.js";
import { log } from "../utils/logger.js";
import { truncate } from "../utils/helpers.js";
import * as cheerio from "cheerio";
import { safeFetch } from "../utils/safeFetch.js";
import { forwardFetchedPage } from "./webSourceForward.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CHARS = 50000;
const ABSOLUTE_MAX_CHARS = 200000;

// v13.26.0 -- response byte cap for the underlying fetch.
//
// This WAS `ABSOLUTE_MAX_CHARS * 4` (800 KB), derived from a UTF-8 worst case
// for the MODEL-FACING char cap. That derivation was wrong in kind: the cap
// applies to the raw HTML, and HTML is far larger than the text extracted from
// it. Measured against real high-authority pages the HTML-to-text ratio ran
// 2.2 to 8.2 for text-rich documents (postgresql.org 2.2, docs.python.org 4.1,
// nodejs.org 4.5, developer.mozilla.org 6.2, en.wikipedia.org 8.2).
//
// At 800 KB the cap was ALREADY being hit by ordinary documentation:
// nodejs.org/api/fs.html is ~1.1 MB of HTML. safeFetch does not throw on it --
// it stops reading and returns the partial body (`truncated = true;
// res.destroy()`) -- so that page was being cut mid-stream, parsed by cheerio
// as though complete, and reported as complete.
//
// Derivation of 8 MB: the binding case is a text-rich page at the worst
// observed ratio, 8.2. To fetch whole any page extracting to ABSOLUTE_MAX_CHARS
// needs 200,000 * 8.2 = 1.63 MB; a 4x headroom multiple gives ~6.5 MB, rounded
// to 8 MB. That is 40x the text ceiling in bytes, so for any ratio below 40 the
// TEXT ceiling is reached before the byte cap and the page is extracted whole.
// Above ratio 40 a page is text-poor and nothing meaningful is lost.
//
// 8 MB also sits BELOW safeFetch's own DEFAULT_MAX_BYTES of 10 MB, so this is
// not an escalation past what that module already treats as safe to buffer.
const FETCH_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// v12.28.0 (TNX-C-009) -- SSRF guard.
//
// This function fetched a caller-supplied URL with `redirect: "follow"` and no
// address validation of any kind. Combined with the previously unauthenticated
// MCP surface (TNX-C-001), it let an anonymous caller use the connector as a
// proxy into the private network: cloud instance metadata at 169.254.169.254,
// the connector's own routes on localhost, and the Gateway Service and Postgres
// on the internal network.
//
// safeFetch resolves the hostname, refuses every non-public address range for
// both IPv4 and IPv6, pins the validated IP for the actual connection so DNS
// rebinding cannot swap it at connect time, and revalidates every redirect hop
// rather than only the initial URL. See src/utils/safeFetch.js.
async function fetchWithTimeout(url, timeoutMs) {
  return safeFetch(url, {
    method: "GET",
    headers: {
      "User-Agent": CONNECTOR_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "Accept-Language": "en-AU,en;q=0.9",
    },
    // The total budget covers every redirect hop, not just the first request,
    // so a redirect chain cannot be used to exceed the caller's timeout.
    timeoutMs,
    maxBytes: FETCH_MAX_BYTES,   // see the derivation at FETCH_MAX_BYTES
  });
}

function isAllowedScheme(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeWs(str) {
  return String(str || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLinks($, baseUrl, maxLinks = 30) {
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = normalizeWs($(el).text()).slice(0, 80);
    try {
      const abs = new URL(href, baseUrl).toString();
      if (abs.startsWith("http") && !abs.startsWith("mailto") && text.length >= 2) {
        links.push({ text, url: abs });
      }
    } catch {
      // skip malformed
    }
    return links.length < maxLinks;
  });
  return links.slice(0, maxLinks);
}

function extractHeadings($) {
  const headings = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const tag = el.name;
    const text = normalizeWs($(el).text());
    if (text) headings.push({ tag, text });
  });
  return headings;
}

function extractMainText($) {
  // Remove non-content elements
  $(
    "script, style, noscript, nav, footer, header, aside, " +
      ".nav, .navigation, .menu, .sidebar, .footer, .header, " +
      ".cookie-notice, .cookie-banner, .ad, .advertisement, " +
      "[role='navigation'], [role='banner'], [role='complementary']"
  ).remove();

  // Replace block elements with newlines to preserve paragraph structure
  $("br").replaceWith("\n");
  $("p, div, section, article, li, h1, h2, h3, h4, h5, h6, blockquote").each(
    (_, el) => {
      const node = $(el);
      node.prepend("\n");
      node.append("\n");
    }
  );

  return normalizeWs($("body").text() || $("*").text());
}

// ---------------------------------------------------------------------------
// Tool: web_fetch_page
// ---------------------------------------------------------------------------

export const webFetchPageToolDefinition = {
  name: "web_fetch_page",
  description:
    "Fetch a web page at a specific URL and return its full readable text content. " +
    "Strips scripts, styles, navigation, and ads to return clean article/page text. " +
    "Also returns the page title, meta description, headings structure, and outbound links. " +
    "Use this when you need to read the full content of a specific URL rather than a snippet " +
    "from web_search. Supports HTTP and HTTPS. Respects redirects.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL to fetch (must start with http:// or https://).",
      },
      max_chars: {
        type: "number",
        description: `Maximum characters of extracted text to return (default ${DEFAULT_MAX_CHARS}, max ${ABSOLUTE_MAX_CHARS}).`,
      },
      include_links: {
        type: "boolean",
        description: "If true, include a list of outbound links found on the page. Default false.",
      },
      include_headings: {
        type: "boolean",
        description:
          "If true, include the heading structure (h1-h4) of the page. Default true.",
      },
      timeout_ms: {
        type: "number",
        description: `Request timeout in milliseconds (500-30000, default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ["url"],
  },
};

export async function handleWebFetchPage(args) {
  const url = (args?.url || "").trim();
  if (!url) throw new Error("'url' is required.");
  if (!isAllowedScheme(url)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  const maxChars = Math.min(
    Math.max(Number(args?.max_chars) || DEFAULT_MAX_CHARS, 1),
    ABSOLUTE_MAX_CHARS
  );
  const includeLinks = args?.include_links === true;
  const includeHeadings = args?.include_headings !== false;
  const timeoutMs = Math.min(
    Math.max(Number(args?.timeout_ms) || DEFAULT_TIMEOUT_MS, 500),
    30000
  );

  log("info", `web_fetch_page: ${url} (maxChars=${maxChars}, timeout=${timeoutMs}ms)`);

  const start = Date.now();
  let resp;
  try {
    resp = await fetchWithTimeout(url, timeoutMs);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`Failed to fetch ${url}: ${err.message}`);
  }

  const elapsed = Date.now() - start;
  const finalUrl = resp.url || url;
  const contentType = resp.headers.get("content-type") || "";
  const statusCode = resp.status;

  if (!resp.ok) {
    throw new Error(
      `HTTP ${statusCode} from ${finalUrl}. Content-Type: ${contentType}`
    );
  }

  // Handle non-HTML content types
  if (
    contentType.includes("application/pdf") ||
    contentType.includes("application/octet") ||
    contentType.includes("image/")
  ) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              url: finalUrl,
              status_code: statusCode,
              content_type: contentType,
              note:
                "This URL returned a binary or non-HTML content type. " +
                "Use google_drive_download_file_content for binary files, " +
                "or try a different URL.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const html = await resp.text();
  const $ = cheerio.load(html, { decodeEntities: true });

  // Extract metadata
  const pageTitle = normalizeWs($("title").first().text()) ||
    normalizeWs($("h1").first().text()) ||
    "(no title)";
  const metaDescription =
    normalizeWs($("meta[name='description']").attr("content") || "") ||
    normalizeWs($("meta[property='og:description']").attr("content") || "");
  const canonicalUrl =
    $("link[rel='canonical']").attr("href") ||
    $("meta[property='og:url']").attr("content") ||
    finalUrl;

  const headings = includeHeadings ? extractHeadings($) : [];
  const links = includeLinks ? extractLinks($, finalUrl) : [];

  // Extract main text AFTER cheerio has been manipulated for headings/links.
  //
  // v13.26.0 -- the FULL extraction is retained. It used to be destroyed by
  // reassignment on the next line, so the complete body existed for one
  // statement and was then unrecoverable. It is now kept, because storage and
  // reading are decoupled: the store holds the whole page, the model reads a
  // clipped view. THE CLIP GOVERNS ONLY WHAT IS READ, NEVER WHAT IS REMEMBERED.
  const fullText = extractMainText($);

  // v13.26.0 -- safeFetch's stream cut, surfaced at last.
  //
  // safeFetch stops reading at its maxBytes cap and returns the PARTIAL body
  // rather than throwing (safeFetch.js: `truncated = true; res.destroy()`). It
  // reports this on the response object, and this file never read it. The
  // consequence was that an oversized page was parsed by cheerio as though
  // complete and handed to the model as complete, with `truncated: false`
  // whenever the extracted fragment happened to fit under max_chars.
  //
  // This is a DIFFERENT failure from the char clip below and the two must not
  // be conflated. The clip means "the page was fetched whole, your view is
  // short". The stream cut means "the HTML itself is incomplete, what you are
  // reading is a prefix of the page and the rest is missing".
  const streamTruncated = resp.truncated === true;

  // The model-facing view. Clipped for reading only.
  let mainText = fullText;
  let truncated = false;
  if (mainText.length > maxChars) {
    mainText = mainText.slice(0, maxChars);
    truncated = true;
  }

  log(
    "info",
    `web_fetch_page: ${statusCode} ${finalUrl} - ${mainText.length} chars, ${elapsed}ms`
  );

  const out = {
    url: finalUrl,
    canonical_url: canonicalUrl !== finalUrl ? canonicalUrl : undefined,
    status_code: statusCode,
    content_type: contentType.split(";")[0].trim(),
    fetch_elapsed_ms: elapsed,
    title: pageTitle,
    meta_description: metaDescription || null,
    headings: includeHeadings ? headings : undefined,
    text_length: mainText.length,
    // v13.26.0: how much text the page actually yielded, so a clipped read is
    // legible as "you got 50,000 of 244,000" rather than just "clipped".
    full_text_length: fullText.length,
    truncated,
    // v13.26.0: the stream cut. See streamTruncated above. Always present so
    // its ABSENCE can never be read as "complete" by a consumer that predates
    // the field -- a false value is an assertion, a missing key is not.
    stream_truncated: streamTruncated,
    // Stated in prose as well as a flag, because a boolean in a JSON blob is
    // easy to skim past and reading a prefix as though it were the page is
    // exactly the error this is here to prevent.
    note: streamTruncated
      ? "INCOMPLETE PAGE. The HTTP response exceeded the fetch byte cap and was " +
        "cut mid-body, so the HTML parsed here is a fragment and the text below " +
        "is a prefix of the page, not the whole of it. Do not treat absence of " +
        "content as evidence the page does not contain it."
      : undefined,
    max_chars: maxChars,
    links: includeLinks ? links : undefined,
    text: mainText,
  };

  // Remove undefined keys for clean JSON
  const clean = Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined)
  );

  // v13.26.0 -- fetch-triggered passive ingestion.
  //
  // Forwards the FULL extracted text to the gateway, which gates it on
  // authority and stores it. Deliberately NOT part of `clean`: this result is
  // returned verbatim to the model, and putting the full body in it would
  // defeat max_chars and flood the context window. Storage and reading are
  // decoupled, and this is the line where they part.
  //
  // Fire-and-forget and never throws: a store that is down must not cost the
  // caller the page it asked for. NO authority decision is made here -- the
  // connector has no authority model and must not grow one. It forwards
  // unconditionally and the gateway's ingestionDecision remains sole
  // authority, so there is exactly one gate to keep correct.
  forwardFetchedPage({
    url: finalUrl,
    title: pageTitle,
    text: fullText,
    streamTruncated,
  });

  return { content: [{ type: "text", text: JSON.stringify(clean, null, 2) }] };
}
