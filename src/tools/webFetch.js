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

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CHARS = 50000;
const ABSOLUTE_MAX_CHARS = 200000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": CONNECTOR_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-AU,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

  // Extract main text AFTER cheerio has been manipulated for headings/links
  let mainText = extractMainText($);
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
    truncated,
    max_chars: maxChars,
    links: includeLinks ? links : undefined,
    text: mainText,
  };

  // Remove undefined keys for clean JSON
  const clean = Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined)
  );

  return { content: [{ type: "text", text: JSON.stringify(clean, null, 2) }] };
}
