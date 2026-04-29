// tools/wordpressMedia.js
//
// WordPress Media Library upload tool for claude-connector.
//
// Uploads images (from local file paths or URLs) to the WordPress Media Library
// using the REST API. Can optionally set the uploaded image as the featured image
// (post thumbnail) on any post or page.
//
// AUTHENTICATION: Uses the same WordPress Application Password credentials
// as the other WordPress tools (from credentialStore or env vars).
//
// TOOLS PROVIDED:
//   wordpress_upload_media        - Uploads an image to WP Media Library
//   wordpress_set_featured_image  - Sets an existing media item as featured image on a post/page

import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { log } from "../utils/logger.js";
import { truncate } from "../utils/helpers.js";
import { getWordPressCredentials } from "../utils/credentialStore.js";
import { CONNECTOR_USER_AGENT } from "../config.js";

// -----------------------------------------------------------------------
// Config helpers
// -----------------------------------------------------------------------

function getWpConfig() {
  const creds = getWordPressCredentials();
  if (!creds) {
    throw new Error(
      "WordPress is not configured.\n\n" +
      "Call set_wordpress_credentials first, or set WP_URL, WP_USERNAME, " +
      "and WP_APP_PASSWORD environment variables."
    );
  }
  return creds;
}

// -----------------------------------------------------------------------
// MIME type helpers
// -----------------------------------------------------------------------

const MIME_MAP = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] || "image/jpeg";
}

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const wpUploadMediaToolDefinition = {
  name: "wordpress_upload_media",
  description:
    "Uploads an image to the WordPress Media Library. " +
    "Accepts either a local file path (from image_download or image_search_download) " +
    "or a direct image URL. When a URL is provided, the image is first downloaded " +
    "then uploaded to WordPress. " +
    "Optionally sets the image as the featured image (post thumbnail) on a post or page. " +
    "Returns the WordPress media ID, URL, and attachment details on success. " +
    "IMPORTANT: Call this ONLY when the user explicitly wants to upload an image to WordPress.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Local file path of the image to upload. Use the path returned by image_download " +
          "or image_search_download. Example: '/app/data/images/pexels_12345_1700000000.jpg'",
      },
      image_url: {
        type: "string",
        description:
          "Direct URL of an image to download and upload to WordPress. " +
          "If both file_path and image_url are provided, file_path takes priority.",
      },
      title: {
        type: "string",
        description:
          "Title for the media item in WordPress. Defaults to the filename without extension.",
      },
      alt_text: {
        type: "string",
        description:
          "Alt text for the image (important for SEO and accessibility). " +
          "Recommended: describe what the image shows.",
      },
      caption: {
        type: "string",
        description: "Caption to display below the image on the site.",
      },
      description: {
        type: "string",
        description: "Longer description of the image (used in the Media Library).",
      },
      post_id: {
        type: "number",
        description:
          "If provided, the uploaded image is automatically set as the featured image " +
          "(post thumbnail) on this post or page. Use wordpress_list_posts or " +
          "wordpress_list_pages to find the ID.",
      },
    },
    required: [],
  },
};

export const wpSetFeaturedImageToolDefinition = {
  name: "wordpress_set_featured_image",
  description:
    "Sets an existing WordPress media item as the featured image (post thumbnail) " +
    "on a post or page. Use wordpress_upload_media first to upload an image and get " +
    "the media ID, then use this tool to assign it as the featured image. " +
    "You can also use wordpress_list_posts to find media already attached.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "number",
        description:
          "The ID of the post or page to set the featured image on. " +
          "Use wordpress_list_posts or wordpress_list_pages to find this.",
      },
      media_id: {
        type: "number",
        description:
          "The WordPress media ID of the image to use as featured image. " +
          "This is returned by wordpress_upload_media.",
      },
      content_type: {
        type: "string",
        description: "'post' or 'page'. Determines the API endpoint. Defaults to 'post'.",
        enum: ["post", "page"],
      },
    },
    required: ["post_id", "media_id"],
  },
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Downloads an image from a URL and returns the buffer + metadata.
 */
async function downloadImageBuffer(imageUrl) {
  log("info", `Downloading image from URL for WP upload: ${imageUrl}`);
  const resp = await fetch(imageUrl, {
    headers: { "User-Agent": CONNECTOR_USER_AGENT },
  });
  if (!resp.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${resp.status} ${resp.statusText}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") || "image/jpeg";

  // Derive filename from URL
  let filename;
  try {
    const urlPath = new URL(imageUrl).pathname;
    filename = basename(urlPath) || `image_${Date.now()}.jpg`;
  } catch {
    filename = `image_${Date.now()}.jpg`;
  }

  // Ensure filename has an extension
  if (!extname(filename)) {
    if (contentType.includes("png")) filename += ".png";
    else if (contentType.includes("webp")) filename += ".webp";
    else if (contentType.includes("gif")) filename += ".gif";
    else filename += ".jpg";
  }

  return { buffer, filename, contentType };
}

/**
 * Uploads a buffer to WordPress Media Library.
 */
async function uploadToWordPress(buffer, filename, contentType, meta = {}) {
  const { url, authHeader, baseApi } = getWpConfig();

  const uploadUrl = `${baseApi}/media`;
  log("info", `Uploading ${filename} (${buffer.length} bytes) to WordPress Media Library`);

  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "User-Agent": CONNECTOR_USER_AGENT,
    },
    body: buffer,
  });

  const body = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = body?.message || body?.error || `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(`WordPress media upload error: ${msg}`);
  }

  // Update alt text, caption, description if provided
  if (meta.alt_text || meta.caption || meta.description || meta.title) {
    const updatePayload = {};
    if (meta.title) updatePayload.title = meta.title;
    if (meta.alt_text) updatePayload.alt_text = meta.alt_text;
    if (meta.caption) updatePayload.caption = meta.caption;
    if (meta.description) updatePayload.description = meta.description;

    try {
      await fetch(`${baseApi}/media/${body.id}`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "User-Agent": CONNECTOR_USER_AGENT,
        },
        body: JSON.stringify(updatePayload),
      });
      log("debug", `Updated media ${body.id} metadata`);
    } catch (err) {
      log("warn", `Failed to update media metadata (non-fatal): ${err.message}`);
    }
  }

  return body;
}

/**
 * Sets a media item as the featured image on a post or page.
 */
async function setFeaturedImage(postId, mediaId, contentType = "post") {
  const { authHeader, baseApi } = getWpConfig();
  const endpoint = contentType === "page" ? "pages" : "posts";

  const resp = await fetch(`${baseApi}/${endpoint}/${postId}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": CONNECTOR_USER_AGENT,
    },
    body: JSON.stringify({ featured_media: mediaId }),
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = body?.message || body?.error || `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(`Failed to set featured image: ${msg}`);
  }

  return body;
}

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleWpUploadMedia(args) {
  let buffer, filename, contentType;

  // Priority 1: Local file path
  if (args?.file_path) {
    const filePath = args.file_path.trim();
    if (!existsSync(filePath)) {
      throw new Error(
        `File not found: ${filePath}\n\n` +
        "Make sure the path is correct. Use image_download or image_search_download " +
        "first to download an image, then use the returned 'Path' value here."
      );
    }

    buffer = readFileSync(filePath);
    filename = basename(filePath);
    contentType = getMimeType(filename);
    log("info", `Read local file: ${filePath} (${buffer.length} bytes)`);
  }
  // Priority 2: Image URL
  else if (args?.image_url) {
    const result = await downloadImageBuffer(args.image_url.trim());
    buffer = result.buffer;
    filename = result.filename;
    contentType = result.contentType;
  }
  // Neither provided
  else {
    throw new Error(
      "Either 'file_path' or 'image_url' is required.\n\n" +
      "Options:\n" +
      "  1. Use image_download or image_search_download first, then pass the file_path\n" +
      "  2. Pass a direct image_url (e.g. from image_search results)"
    );
  }

  // Upload to WordPress
  const media = await uploadToWordPress(buffer, filename, contentType, {
    title: args?.title,
    alt_text: args?.alt_text,
    caption: args?.caption,
    description: args?.description,
  });

  // Optionally set as featured image
  let featuredOn = null;
  if (args?.post_id) {
    try {
      featuredOn = await setFeaturedImage(args.post_id, media.id);
      log("info", `Set media ${media.id} as featured image on post ${args.post_id}`);
    } catch (err) {
      log("warn", `Failed to set featured image (media uploaded OK): ${err.message}`);
    }
  }

  const mediaUrl = media.source_url || media.guid?.rendered || "";
  const lines = [
    "WordPress Media Uploaded",
    "========================",
    `Media ID:     ${media.id}`,
    `Title:        ${media.title?.rendered || filename}`,
    `Filename:     ${filename}`,
    `URL:          ${mediaUrl}`,
    `Type:         ${media.mime_type || contentType}`,
    media.media_details?.width
      ? `Dimensions:   ${media.media_details.width}x${media.media_details.height}px`
      : null,
    media.media_details?.filesize
      ? `Size:         ${(media.media_details.filesize / 1024).toFixed(0)} KB`
      : null,
    `Alt Text:     ${media.alt_text || args?.alt_text || "(none)"}`,
    ``,
    `Edit in WP:   ${getWpConfig().url}/wp-admin/upload.php?item=${media.id}`,
  ];

  if (featuredOn) {
    lines.push(``);
    lines.push(`Featured Image Set`);
    lines.push(`------------------`);
    lines.push(`Post/Page ID: ${args.post_id}`);
    lines.push(`Title:        ${featuredOn.title?.rendered || "(unknown)"}`);
    lines.push(`URL:          ${featuredOn.link || ""}`);
  } else if (args?.post_id) {
    lines.push(``);
    lines.push(`⚠️  Could not set as featured image on post ${args.post_id}.`);
    lines.push(`   The image was uploaded successfully. You can set it manually in WordPress.`);
  }

  lines.push(``);
  lines.push("Available thumbnail sizes:");
  if (media.media_details?.sizes) {
    const sizes = media.media_details.sizes;
    for (const [name, info] of Object.entries(sizes)) {
      lines.push(`  ${name}: ${info.width}x${info.height} — ${info.source_url}`);
    }
  } else {
    lines.push("  (sizes will be generated by WordPress)");
  }

  return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
}

// -----------------------------------------------------------------------

export async function handleWpSetFeaturedImage(args) {
  const postId = Number(args?.post_id);
  const mediaId = Number(args?.media_id);
  const contentType = args?.content_type || "post";

  if (!postId) throw new Error("'post_id' is required.");
  if (!mediaId) throw new Error("'media_id' is required.");

  const result = await setFeaturedImage(postId, mediaId, contentType);

  const lines = [
    "Featured Image Set",
    "==================",
    `Post/Page ID:  ${postId}`,
    `Media ID:      ${mediaId}`,
    `Content Type:  ${contentType}`,
    `Title:         ${result.title?.rendered || "(unknown)"}`,
    `URL:           ${result.link || ""}`,
    ``,
    `The featured image has been updated. Visit the page to confirm it displays correctly.`,
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}
