// tools/imageDownloader.js
//
// MCP tool for downloading images from Pexels and Unsplash to local storage.
//
// This bridges the gap between image_search (which returns URLs) and
// wordpress_upload_media (which needs a downloaded file or buffer).
//
// TOOLS PROVIDED:
//   image_download         - Downloads a single image by provider + ID or direct URL
//   image_search_download  - Searches for an image and downloads the best match
//
// Downloaded images are saved to IMAGE_DOWNLOAD_DIR (default: ./data/images/).
// Each file is named: {provider}_{id}_{timestamp}.{ext}

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { config, requirePexelsKey, requireUnsplashKey } from "../config.js";
import { log } from "../utils/logger.js";
import { clamp, truncate } from "../utils/helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOWNLOAD_DIR = resolve(__dirname, "../../data/images");

function getDownloadDir() {
  const dir = config.imageDownloadDir || DEFAULT_DOWNLOAD_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log("info", `Created image download directory: ${dir}`);
  }
  return dir;
}

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const imageDownloadToolDefinition = {
  name: "image_download",
  description:
    "Downloads an image from Pexels or Unsplash to local storage. " +
    "You can provide either a direct image URL or a provider name and photo ID. " +
    "The downloaded file is saved locally and its path is returned for use with " +
    "wordpress_upload_media or google_drive_upload. " +
    "Supports quality selection: 'original', 'large', 'medium', 'small'.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: {
        type: "string",
        description:
          "Direct URL of the image to download. Can be any URL — " +
          "Pexels src URL, Unsplash photo URL, or any publicly accessible image URL. " +
          "If provided, 'provider' and 'photo_id' are ignored.",
      },
      provider: {
        type: "string",
        description:
          "Image provider: 'pexels' or 'unsplash'. Required if 'image_url' is not provided.",
        enum: ["pexels", "unsplash"],
      },
      photo_id: {
        type: "string",
        description:
          "The provider-specific photo ID. For Pexels this is a number (e.g. '2014422'). " +
          "For Unsplash this is an alphanumeric string (e.g. 'Dwu85P9SOIk'). " +
          "Required if 'image_url' is not provided.",
      },
      quality: {
        type: "string",
        description:
          "Image quality/size to download. " +
          "'original' — full resolution (largest file). " +
          "'large' — large size suitable for hero images (~1920px wide). " +
          "'medium' — medium size suitable for blog content (~1280px wide). " +
          "'small' — small/thumbnail size. " +
          "Defaults to 'large'.",
        enum: ["original", "large", "medium", "small"],
      },
      filename: {
        type: "string",
        description:
          "Optional custom filename (without extension). If omitted, a filename is " +
          "auto-generated from the provider and photo ID. Extension is auto-detected.",
      },
    },
    required: [],
  },
};

export const imageSearchDownloadToolDefinition = {
  name: "image_search_download",
  description:
    "Searches for an image on Pexels or Unsplash and immediately downloads the best match. " +
    "This is a convenience tool that combines image_search + image_download in one step. " +
    "Returns the local file path of the downloaded image, ready for wordpress_upload_media. " +
    "Tip: Use descriptive search queries for best results (e.g. 'modern office teamwork', 'sunset over ocean').",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query for the image. Be descriptive for best results.",
      },
      provider: {
        type: "string",
        description:
          "Which provider to search: 'pexels', 'unsplash', or 'auto' (default). " +
          "'auto' prefers Pexels if configured, else Unsplash.",
        enum: ["pexels", "unsplash", "auto"],
      },
      quality: {
        type: "string",
        description: "Image quality to download: 'original', 'large' (default), 'medium', 'small'.",
        enum: ["original", "large", "medium", "small"],
      },
      orientation: {
        type: "string",
        description: "Filter by orientation: 'landscape', 'portrait', 'square'.",
        enum: ["landscape", "portrait", "square"],
      },
      color: {
        type: "string",
        description: "Filter by dominant colour (provider-specific).",
      },
      result_index: {
        type: "number",
        description:
          "Which search result to download (0-based). Default 0 (first/best match). " +
          "Use this to pick the 2nd, 3rd, etc. result if the first isn't ideal.",
      },
      filename: {
        type: "string",
        description: "Optional custom filename (without extension).",
      },
    },
    required: ["query"],
  },
};

// -----------------------------------------------------------------------
// Pexels: fetch photo details by ID
// -----------------------------------------------------------------------

async function pexelsGetPhoto(photoId) {
  requirePexelsKey();
  const url = `https://api.pexels.com/v1/photos/${photoId}`;
  log("debug", `Pexels get photo: ${url}`);

  const resp = await fetch(url, {
    headers: { Authorization: config.pexelsApiKey, Accept: "application/json" },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Pexels API error ${resp.status}: ${resp.statusText}. ${body}`);
  }

  return resp.json();
}

function pexelsSelectUrl(photo, quality) {
  const src = photo.src || {};
  switch (quality) {
    case "original": return src.original || src.large2x || src.large;
    case "large":    return src.large2x || src.large || src.original;
    case "medium":   return src.medium || src.large || src.original;
    case "small":    return src.small || src.medium || src.large;
    default:         return src.large || src.original;
  }
}

// -----------------------------------------------------------------------
// Unsplash: fetch photo details by ID
// -----------------------------------------------------------------------

async function unsplashGetPhoto(photoId) {
  requireUnsplashKey();
  const url = `https://api.unsplash.com/photos/${photoId}`;
  log("debug", `Unsplash get photo: ${url}`);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${config.unsplashAccessKey}`,
      Accept: "application/json",
      "Accept-Version": "v1",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Unsplash API error ${resp.status}: ${resp.statusText}. ${body}`);
  }

  return resp.json();
}

/**
 * Trigger the Unsplash download endpoint (required by Unsplash API guidelines).
 * This does NOT download the image - it signals to Unsplash that a download occurred.
 */
async function unsplashTriggerDownload(downloadLocation) {
  if (!downloadLocation) return;
  try {
    await fetch(downloadLocation, {
      headers: {
        Authorization: `Client-ID ${config.unsplashAccessKey}`,
        "Accept-Version": "v1",
      },
    });
    log("debug", "Unsplash download event triggered");
  } catch (err) {
    log("warn", `Unsplash download trigger failed (non-fatal): ${err.message}`);
  }
}

function unsplashSelectUrl(photo, quality) {
  const urls = photo.urls || {};
  switch (quality) {
    case "original": return urls.raw || urls.full || urls.regular;
    case "large":    return urls.full || urls.regular || urls.raw;
    case "medium":   return urls.regular || urls.full;
    case "small":    return urls.small || urls.thumb || urls.regular;
    default:         return urls.regular || urls.full;
  }
}

// -----------------------------------------------------------------------
// Pexels: search
// -----------------------------------------------------------------------

async function pexelsSearch(query, orientation, color) {
  requirePexelsKey();
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("page", "1");
  if (orientation) url.searchParams.set("orientation", orientation);
  if (color) url.searchParams.set("color", color);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: config.pexelsApiKey, Accept: "application/json" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Pexels search error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return (data?.photos || []).map((p) => ({
    id: String(p.id),
    alt: p.alt || "",
    photographer: p.photographer || "",
    photographerUrl: p.photographer_url || "",
    src: p.src,
    width: p.width,
    height: p.height,
    provider: "pexels",
  }));
}

// -----------------------------------------------------------------------
// Unsplash: search
// -----------------------------------------------------------------------

async function unsplashSearch(query, orientation, color) {
  requireUnsplashKey();
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("page", "1");
  if (orientation) {
    url.searchParams.set("orientation", orientation === "square" ? "squarish" : orientation);
  }
  if (color) url.searchParams.set("color", color);

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Client-ID ${config.unsplashAccessKey}`,
      Accept: "application/json",
      "Accept-Version": "v1",
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Unsplash search error ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return (data?.results || []).map((r) => ({
    id: String(r.id),
    alt: r.description || r.alt_description || "",
    photographer: r.user?.name || "",
    photographerUrl: r.user?.links?.html || "",
    urls: r.urls,
    links: r.links,
    width: r.width,
    height: r.height,
    provider: "unsplash",
  }));
}

// -----------------------------------------------------------------------
// Generic image download
// -----------------------------------------------------------------------

/**
 * Downloads an image from a URL and saves it to the local download directory.
 * Returns metadata about the saved file.
 */
async function downloadImageFromUrl(imageUrl, filename) {
  log("info", `Downloading image: ${imageUrl}`);

  const resp = await fetch(imageUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download image (${resp.status}): ${resp.statusText}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") || "";

  // Determine extension from content-type or URL
  let ext = ".jpg"; // default
  if (contentType.includes("png")) ext = ".png";
  else if (contentType.includes("webp")) ext = ".webp";
  else if (contentType.includes("gif")) ext = ".gif";
  else if (contentType.includes("svg")) ext = ".svg";
  else {
    const urlExt = extname(new URL(imageUrl).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"].includes(urlExt)) {
      ext = urlExt;
    }
  }

  const safeName = (filename || `image_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const fullFilename = `${safeName}${ext}`;
  const downloadDir = getDownloadDir();
  const filePath = resolve(downloadDir, fullFilename);

  writeFileSync(filePath, buffer);
  const stats = statSync(filePath);

  log("info", `Image saved: ${filePath} (${stats.size} bytes)`);

  return {
    filePath,
    filename: fullFilename,
    size: stats.size,
    sizeHuman: stats.size > 1048576
      ? `${(stats.size / 1048576).toFixed(1)} MB`
      : `${(stats.size / 1024).toFixed(0)} KB`,
    mimeType: contentType || `image/${ext.replace(".", "")}`,
    directory: downloadDir,
  };
}

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleImageDownload(args) {
  const quality = args?.quality || "large";
  const customFilename = args?.filename || "";

  // Option A: Direct URL download
  if (args?.image_url) {
    const url = args.image_url.trim();
    const fname = customFilename || `direct_${Date.now()}`;
    const result = await downloadImageFromUrl(url, fname);

    const lines = [
      "Image Downloaded",
      "================",
      `Source:    Direct URL`,
      `File:     ${result.filename}`,
      `Path:     ${result.filePath}`,
      `Size:     ${result.sizeHuman}`,
      `Type:     ${result.mimeType}`,
      "",
      "Use wordpress_upload_media with this file_path to upload to WordPress,",
      "or google_drive_upload to save to Google Drive.",
    ].join("\n");

    return { content: [{ type: "text", text: lines }] };
  }

  // Option B: Provider + Photo ID
  const provider = (args?.provider || "").toLowerCase();
  const photoId = (args?.photo_id || "").trim();

  if (!provider || !photoId) {
    throw new Error(
      "Either 'image_url' OR both 'provider' and 'photo_id' are required. " +
      "Use image_search first to find photo IDs, or provide a direct URL."
    );
  }

  let imageUrl, photographer, photographerUrl, alt, width, height;

  if (provider === "pexels") {
    const photo = await pexelsGetPhoto(photoId);
    imageUrl = pexelsSelectUrl(photo, quality);
    photographer = photo.photographer || "";
    photographerUrl = photo.photographer_url || "";
    alt = photo.alt || "";
    width = photo.width;
    height = photo.height;
  } else if (provider === "unsplash") {
    const photo = await unsplashGetPhoto(photoId);
    imageUrl = unsplashSelectUrl(photo, quality);
    photographer = photo.user?.name || "";
    photographerUrl = photo.user?.links?.html || "";
    alt = photo.description || photo.alt_description || "";
    width = photo.width;
    height = photo.height;

    // Comply with Unsplash API guidelines: trigger download event
    await unsplashTriggerDownload(photo.links?.download_location);
  } else {
    throw new Error(`Unknown provider: '${provider}'. Use 'pexels' or 'unsplash'.`);
  }

  if (!imageUrl) {
    throw new Error(`Could not determine download URL for ${provider} photo ${photoId}.`);
  }

  const fname = customFilename || `${provider}_${photoId}_${Date.now()}`;
  const result = await downloadImageFromUrl(imageUrl, fname);

  const lines = [
    "Image Downloaded",
    "================",
    `Provider:     ${provider}`,
    `Photo ID:     ${photoId}`,
    `Quality:      ${quality}`,
    `Description:  ${truncate(alt, 150) || "(none)"}`,
    `Dimensions:   ${width}x${height}px`,
    `Photographer: ${photographer}`,
    photographerUrl ? `Profile:      ${photographerUrl}` : null,
    ``,
    `File:         ${result.filename}`,
    `Path:         ${result.filePath}`,
    `Size:         ${result.sizeHuman}`,
    `Type:         ${result.mimeType}`,
    ``,
    `Attribution: Photo by ${photographer || "Unknown"} on ${provider === "pexels" ? "Pexels" : "Unsplash"}`,
    ``,
    "Next steps:",
    "  • wordpress_upload_media — upload this image to WordPress Media Library",
    "  • google_drive_upload — save this image to Google Drive",
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------

export async function handleImageSearchDownload(args) {
  const query = (args?.query || "").trim();
  if (!query) throw new Error("'query' is required.");

  const requestedProvider = (args?.provider || "auto").toLowerCase();
  const quality = args?.quality || "large";
  const orientation = args?.orientation || "";
  const color = args?.color || "";
  const resultIndex = Number(args?.result_index) || 0;
  const customFilename = args?.filename || "";

  // Resolve provider
  let useProvider;
  if (requestedProvider === "auto") {
    if (config.pexelsApiKey) useProvider = "pexels";
    else if (config.unsplashAccessKey) useProvider = "unsplash";
    else throw new Error("No image provider configured. Set PEXELS_API_KEY or UNSPLASH_ACCESS_KEY.");
  } else {
    useProvider = requestedProvider;
  }

  // Search
  log("info", `Searching ${useProvider} for: "${query}"`);
  let results;
  if (useProvider === "pexels") {
    results = await pexelsSearch(query, orientation, color);
  } else {
    results = await unsplashSearch(query, orientation, color);
  }

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: `No images found for "${query}" on ${useProvider}.` }],
    };
  }

  const idx = clamp(resultIndex, 0, results.length - 1);
  const chosen = results[idx];

  // Get download URL
  let imageUrl, downloadLocationUrl;
  if (useProvider === "pexels") {
    imageUrl = pexelsSelectUrl(chosen, quality);
  } else {
    imageUrl = unsplashSelectUrl(chosen, quality);
    downloadLocationUrl = chosen.links?.download_location;
  }

  if (!imageUrl) {
    throw new Error(`Could not determine download URL for selected image.`);
  }

  // Trigger Unsplash download event
  if (useProvider === "unsplash" && downloadLocationUrl) {
    await unsplashTriggerDownload(downloadLocationUrl);
  }

  // Download
  const fname = customFilename || `${useProvider}_${chosen.id}_${Date.now()}`;
  const result = await downloadImageFromUrl(imageUrl, fname);

  const lines = [
    "Image Found & Downloaded",
    "========================",
    `Search:       "${query}"`,
    `Provider:     ${useProvider}`,
    `Result:       #${idx + 1} of ${results.length}`,
    `Photo ID:     ${chosen.id}`,
    `Quality:      ${quality}`,
    `Description:  ${truncate(chosen.alt, 150) || "(none)"}`,
    `Dimensions:   ${chosen.width}x${chosen.height}px`,
    `Photographer: ${chosen.photographer}`,
    chosen.photographerUrl ? `Profile:      ${chosen.photographerUrl}` : null,
    ``,
    `File:         ${result.filename}`,
    `Path:         ${result.filePath}`,
    `Size:         ${result.sizeHuman}`,
    `Type:         ${result.mimeType}`,
    ``,
    `Attribution: Photo by ${chosen.photographer || "Unknown"} on ${useProvider === "pexels" ? "Pexels" : "Unsplash"}`,
    ``,
    "Next steps:",
    "  • wordpress_upload_media — upload this image to WordPress Media Library",
    "  • google_drive_upload — save this image to Google Drive",
    results.length > 1 ? `  • Re-run with result_index: ${idx + 1} to try the next result` : null,
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
}
