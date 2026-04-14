// tools/imageSearch.js
// Supports two image search backends: Pexels and Unsplash.
// Configured via IMAGE_PROVIDER env var ("pexels", "unsplash", or "auto").
//
// "auto" mode selects Pexels when PEXELS_API_KEY is set, otherwise falls
// back to Unsplash when UNSPLASH_ACCESS_KEY is set.
//
// "both" mode queries both providers and interleaves the results.

import { config, requirePexelsKey, requireUnsplashKey } from "../config.js";
import { clamp, truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";

// -----------------------------------------------------------------------
// Tool definition (MCP schema)
// -----------------------------------------------------------------------

export const imageSearchToolDefinition = {
  name: "image_search",
  description:
    "Searches for high-quality stock photos and images. " +
    "Returns image URLs, thumbnail URLs, photographer credits, and source page links. " +
    "Supports Pexels and Unsplash as providers. " +
    "Use this to find images for articles, blog posts, presentations, or any visual content need. " +
    "Supports filtering by orientation, size, and colour.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The image search query. Be descriptive for best results (e.g. 'modern office team collaboration', 'Australian outback sunset').",
      },
      num_results: {
        type: "number",
        description: `Number of images to return (default ${config.defaultImageResults}, max ${config.maxImageResults}).`,
        minimum: 1,
        maximum: config.maxImageResults,
      },
      provider: {
        type: "string",
        description:
          "Image provider to use. 'pexels' uses Pexels API, 'unsplash' uses Unsplash API, " +
          "'both' queries both and interleaves results, 'auto' selects whichever provider is configured (prefers Pexels). " +
          "Defaults to 'auto'.",
        enum: ["pexels", "unsplash", "both", "auto"],
      },
      orientation: {
        type: "string",
        description:
          "Filter images by orientation. 'landscape' (wider than tall), 'portrait' (taller than wide), 'square' (equal dimensions). " +
          "Note: Unsplash uses 'squarish' but this tool normalises the value automatically. Optional.",
        enum: ["landscape", "portrait", "square"],
      },
      size: {
        type: "string",
        description:
          "Minimum image size filter (Pexels only). 'small' (at least 720x480), 'medium' (at least 1920x1280), 'large' (at least 3840x2160). Optional.",
        enum: ["small", "medium", "large"],
      },
      color: {
        type: "string",
        description:
          "Filter by dominant colour. " +
          "For Pexels: red, orange, yellow, green, turquoise, blue, violet, pink, brown, black, gray, white. " +
          "For Unsplash: black_and_white, black, white, yellow, orange, red, purple, magenta, green, teal, blue, or a hex value (e.g. #FF5733). " +
          "Optional.",
      },
    },
    required: ["query"],
  },
};

// -----------------------------------------------------------------------
// Normalised image result shape
// -----------------------------------------------------------------------

/**
 * @typedef {Object} ImageResult
 * @property {string} id          - Provider-specific image ID
 * @property {string} title       - Alt text / description
 * @property {string} imageUrl    - Full-size or large image URL (suitable for embedding)
 * @property {string} thumbnailUrl - Small preview URL
 * @property {string} photographer - Photographer or author name
 * @property {string} photographerUrl - Photographer profile URL
 * @property {string} pageUrl     - Source page URL on the provider's site
 * @property {number} width       - Image width in pixels
 * @property {number} height      - Image height in pixels
 * @property {string} provider    - "pexels" or "unsplash"
 */

// -----------------------------------------------------------------------
// Pexels implementation
// -----------------------------------------------------------------------

/**
 * Search Pexels for images.
 * @param {string} query
 * @param {number} numResults
 * @param {string} orientation - "landscape" | "portrait" | "square"
 * @param {string} size        - "small" | "medium" | "large"
 * @param {string} color       - colour name
 * @returns {Promise<ImageResult[]>}
 */
async function pexelsSearch(query, numResults, orientation, size, color) {
  requirePexelsKey();

  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(Math.min(numResults, 80))); // Pexels max per_page is 80
  url.searchParams.set("page", "1");

  if (orientation) {
    url.searchParams.set("orientation", orientation); // Pexels uses: landscape, portrait, square
  }
  if (size) {
    url.searchParams.set("size", size); // Pexels uses: small, medium, large
  }
  if (color) {
    url.searchParams.set("color", color);
  }

  log("debug", `Pexels image search: ${url.toString()}`);

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: config.pexelsApiKey,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Pexels API error ${resp.status}: ${resp.statusText}. ${body}`
    );
  }

  const data = await resp.json();
  const photos = data?.photos || [];

  return photos.map((p) => ({
    id: String(p.id),
    title: truncate(p.alt || "", 200),
    imageUrl: p.src?.large || p.src?.original || "",
    thumbnailUrl: p.src?.medium || p.src?.small || "",
    photographer: p.photographer || "",
    photographerUrl: p.photographer_url || "",
    pageUrl: p.url || "",
    width: p.width || 0,
    height: p.height || 0,
    provider: "pexels",
  }));
}

// -----------------------------------------------------------------------
// Unsplash implementation
// -----------------------------------------------------------------------

/**
 * Normalise orientation value for Unsplash.
 * Unsplash uses "squarish" instead of "square".
 * @param {string} orientation
 * @returns {string}
 */
function normaliseOrientationForUnsplash(orientation) {
  if (orientation === "square") return "squarish";
  return orientation; // "landscape" and "portrait" are identical
}

/**
 * Search Unsplash for images.
 * @param {string} query
 * @param {number} numResults
 * @param {string} orientation - "landscape" | "portrait" | "square"
 * @param {string} color       - colour name or hex
 * @returns {Promise<ImageResult[]>}
 */
async function unsplashSearch(query, numResults, orientation, color) {
  requireUnsplashKey();

  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(Math.min(numResults, 30))); // Unsplash max per_page is 30
  url.searchParams.set("page", "1");

  if (orientation) {
    url.searchParams.set("orientation", normaliseOrientationForUnsplash(orientation));
  }
  if (color) {
    url.searchParams.set("color", color);
  }

  log("debug", `Unsplash image search: ${url.toString()}`);

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Client-ID ${config.unsplashAccessKey}`,
      Accept: "application/json",
      "Accept-Version": "v1",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Unsplash API error ${resp.status}: ${resp.statusText}. ${body}`
    );
  }

  const data = await resp.json();
  const results = data?.results || [];

  return results.map((r) => ({
    id: String(r.id),
    title: truncate(r.description || r.alt_description || "", 200),
    imageUrl: r.urls?.regular || r.urls?.full || "",
    thumbnailUrl: r.urls?.small || r.urls?.thumb || "",
    photographer: r.user?.name || "",
    photographerUrl: r.user?.links?.html
      ? `${r.user.links.html}?utm_source=claude_connector&utm_medium=referral`
      : "",
    pageUrl: r.links?.html
      ? `${r.links.html}?utm_source=claude_connector&utm_medium=referral`
      : "",
    width: r.width || 0,
    height: r.height || 0,
    provider: "unsplash",
  }));
}

// -----------------------------------------------------------------------
// Provider resolution
// -----------------------------------------------------------------------

/**
 * Resolve which provider(s) to use based on the requested provider string
 * and which API keys are configured.
 * @param {string} requestedProvider - "pexels" | "unsplash" | "both" | "auto"
 * @returns {{ usePexels: boolean, useUnsplash: boolean }}
 */
function resolveProviders(requestedProvider) {
  const hasPexels = Boolean(config.pexelsApiKey);
  const hasUnsplash = Boolean(config.unsplashAccessKey);

  switch (requestedProvider) {
    case "pexels":
      return { usePexels: true, useUnsplash: false };
    case "unsplash":
      return { usePexels: false, useUnsplash: true };
    case "both":
      return { usePexels: true, useUnsplash: true };
    case "auto":
    default:
      if (hasPexels) return { usePexels: true, useUnsplash: false };
      if (hasUnsplash) return { usePexels: false, useUnsplash: true };
      throw new Error(
        "No image provider is configured. " +
        "Set PEXELS_API_KEY and/or UNSPLASH_ACCESS_KEY in your environment variables."
      );
  }
}

// -----------------------------------------------------------------------
// Result formatting
// -----------------------------------------------------------------------

/**
 * Format a list of ImageResult objects into a human-readable text block.
 * @param {ImageResult[]} images
 * @param {string} query
 * @param {number} elapsed
 * @param {string} providerLabel
 * @returns {string}
 */
function formatResults(images, query, elapsed, providerLabel) {
  if (images.length === 0) {
    return `No images found for query: "${query}"`;
  }

  const formatted = images
    .map((img, i) => {
      const lines = [`[${i + 1}] ${img.title || "(no description)"}`];
      lines.push(`Provider: ${img.provider}`);
      lines.push(`Dimensions: ${img.width}x${img.height}px`);
      if (img.photographer) {
        lines.push(`Photographer: ${img.photographer}`);
        if (img.photographerUrl) lines.push(`Photographer URL: ${img.photographerUrl}`);
      }
      lines.push(`Image URL: ${img.imageUrl}`);
      lines.push(`Thumbnail URL: ${img.thumbnailUrl}`);
      if (img.pageUrl) lines.push(`Source Page: ${img.pageUrl}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  return (
    `Image search results for "${query}" ` +
    `(${images.length} results, provider: ${providerLabel}, elapsed: ${elapsed}ms)\n\n` +
    formatted
  );
}

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------

export async function handleImageSearch(args) {
  const query = (args?.query || "").trim();
  if (!query) throw new Error("The 'query' parameter is required.");

  const numResults = clamp(
    Number(args?.num_results) || config.defaultImageResults,
    1,
    config.maxImageResults
  );
  const requestedProvider = (args?.provider || config.imageProvider || "auto").toLowerCase();
  const orientation = args?.orientation || "";
  const size = args?.size || "";
  const color = args?.color || "";

  const { usePexels, useUnsplash } = resolveProviders(requestedProvider);

  const start = Date.now();
  let images = [];
  const providersUsed = [];

  // When both providers are requested, split the quota between them and
  // interleave the results so each provider contributes equally.
  if (usePexels && useUnsplash) {
    const halfResults = Math.ceil(numResults / 2);

    const [pexelsResults, unsplashResults] = await Promise.allSettled([
      pexelsSearch(query, halfResults, orientation, size, color),
      unsplashSearch(query, halfResults, orientation, color),
    ]);

    const pexelsList = pexelsResults.status === "fulfilled" ? pexelsResults.value : [];
    const unsplashList = unsplashResults.status === "fulfilled" ? unsplashResults.value : [];

    if (pexelsResults.status === "rejected") {
      log("warn", `Pexels error (continuing with Unsplash only): ${pexelsResults.reason?.message}`);
    }
    if (unsplashResults.status === "rejected") {
      log("warn", `Unsplash error (continuing with Pexels only): ${unsplashResults.reason?.message}`);
    }

    // Interleave: pexels[0], unsplash[0], pexels[1], unsplash[1], ...
    const maxLen = Math.max(pexelsList.length, unsplashList.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < pexelsList.length) images.push(pexelsList[i]);
      if (i < unsplashList.length) images.push(unsplashList[i]);
    }
    images = images.slice(0, numResults);

    if (pexelsList.length > 0) providersUsed.push("pexels");
    if (unsplashList.length > 0) providersUsed.push("unsplash");

    if (images.length === 0) {
      throw new Error(
        "Both Pexels and Unsplash returned errors. " +
        `Pexels: ${pexelsResults.reason?.message || "unknown"}. ` +
        `Unsplash: ${unsplashResults.reason?.message || "unknown"}.`
      );
    }
  } else if (usePexels) {
    images = await pexelsSearch(query, numResults, orientation, size, color);
    providersUsed.push("pexels");
  } else {
    images = await unsplashSearch(query, numResults, orientation, color);
    providersUsed.push("unsplash");
  }

  const elapsed = Date.now() - start;
  const providerLabel = providersUsed.join("+");
  log("info", `Image search completed in ${elapsed}ms, ${images.length} results from ${providerLabel}`);

  const text = formatResults(images, query, elapsed, providerLabel);

  return { content: [{ type: "text", text }] };
}
