// tools/googleDrive.js
//
// Google Drive upload tool for claude-connector.
//
// Uploads images (or any file) from local storage to Google Drive.
// Supports both Service Account auth and OAuth2 refresh token auth.
//
// AUTHENTICATION OPTIONS:
//   Option A — Service Account (recommended for servers):
//     Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE to the path of your JSON key file.
//     Share the target folder with the service account's email address.
//
//   Option B — OAuth2 Refresh Token (for personal accounts):
//     Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.
//     Generate these via the Google Cloud Console OAuth consent screen.
//
// TOOLS PROVIDED:
//   google_drive_upload     - Uploads a local file to Google Drive
//   google_drive_list       - Lists files in a Google Drive folder

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { config } from "../config.js";
import { log } from "../utils/logger.js";
import { truncate } from "../utils/helpers.js";

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
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

// -----------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------

/**
 * Get an access token using Service Account credentials.
 * Implements JWT-based authentication without external dependencies.
 */
async function getServiceAccountToken() {
  const keyFilePath = config.googleServiceAccountKeyFile;
  if (!keyFilePath || !existsSync(keyFilePath)) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set or file not found.\n\n" +
      "To set up Google Drive:\n" +
      "  1. Go to Google Cloud Console > IAM & Admin > Service Accounts\n" +
      "  2. Create a service account and download the JSON key file\n" +
      "  3. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/keyfile.json\n" +
      "  4. Share your Google Drive folder with the service account email"
    );
  }

  const keyData = JSON.parse(readFileSync(keyFilePath, "utf-8"));
  const { client_email, private_key } = keyData;

  if (!client_email || !private_key) {
    throw new Error("Invalid service account key file: missing client_email or private_key.");
  }

  // Create JWT
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: client_email,
      scope: "https://www.googleapis.com/auth/drive.file",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");

  const signInput = `${header}.${payload}`;

  // Sign with RSA-SHA256 using Node.js crypto
  const { createSign } = await import("node:crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(private_key, "base64url");

  const jwt = `${signInput}.${signature}`;

  // Exchange JWT for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text().catch(() => "");
    throw new Error(`Google OAuth token exchange failed (${tokenResp.status}): ${body}`);
  }

  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

/**
 * Get an access token using OAuth2 refresh token.
 */
async function getOAuth2Token() {
  const { googleClientId, googleClientSecret, googleRefreshToken } = config;

  if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
    throw new Error(
      "Google Drive OAuth2 credentials are incomplete.\n\n" +
      "Set these environment variables:\n" +
      "  GOOGLE_CLIENT_ID       — from Google Cloud Console\n" +
      "  GOOGLE_CLIENT_SECRET   — from Google Cloud Console\n" +
      "  GOOGLE_REFRESH_TOKEN   — obtained via OAuth2 consent flow\n\n" +
      "Alternatively, use a service account (GOOGLE_SERVICE_ACCOUNT_KEY_FILE)."
    );
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: googleRefreshToken,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text().catch(() => "");
    throw new Error(`Google OAuth2 token refresh failed (${tokenResp.status}): ${body}`);
  }

  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

/**
 * Get an access token using whichever method is configured.
 */
async function getAccessToken() {
  // Prefer service account
  if (config.googleServiceAccountKeyFile) {
    return getServiceAccountToken();
  }
  // Fallback to OAuth2 refresh token
  if (config.googleRefreshToken) {
    return getOAuth2Token();
  }

  throw new Error(
    "Google Drive is not configured.\n\n" +
    "Option A — Service Account (recommended):\n" +
    "  Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/service-account-key.json\n\n" +
    "Option B — OAuth2:\n" +
    "  Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN"
  );
}

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const googleDriveUploadToolDefinition = {
  name: "google_drive_upload",
  description:
    "Uploads a file from local storage to Google Drive. " +
    "Typically used after image_download or image_search_download to save images to the cloud. " +
    "The file becomes shareable and accessible from any device. " +
    "Returns the Google Drive file ID and a shareable link. " +
    "Requires Google Drive API credentials (service account or OAuth2).",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Local file path to upload. Use the path returned by image_download " +
          "or image_search_download.",
      },
      folder_id: {
        type: "string",
        description:
          "Google Drive folder ID to upload into. This is the alphanumeric string in the " +
          "folder URL: https://drive.google.com/drive/folders/{FOLDER_ID}. " +
          "If not provided, uploads to the root of the drive (or default configured folder).",
      },
      filename: {
        type: "string",
        description:
          "Optional custom filename for the file in Google Drive. " +
          "If omitted, uses the original filename.",
      },
      make_public: {
        type: "boolean",
        description:
          "If true, makes the file publicly accessible via link (anyone with the link can view). " +
          "Defaults to false (private).",
      },
    },
    required: ["file_path"],
  },
};

export const googleDriveListToolDefinition = {
  name: "google_drive_list",
  description:
    "Lists files in a Google Drive folder. Useful for finding previously uploaded images " +
    "and their file IDs for use with wordpress_upload_media (via URL). " +
    "Returns file name, ID, URL, and size for each file.",
  inputSchema: {
    type: "object",
    properties: {
      folder_id: {
        type: "string",
        description:
          "Google Drive folder ID to list. If omitted, lists recent files in the root.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of files to list (1-50, default 20).",
      },
      search_name: {
        type: "string",
        description: "Optional: filter files by name (partial match).",
      },
    },
    required: [],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleGoogleDriveUpload(args) {
  const filePath = (args?.file_path || "").trim();
  if (!filePath) throw new Error("'file_path' is required.");
  if (!existsSync(filePath)) {
    throw new Error(
      `File not found: ${filePath}\n\n` +
      "Use image_download or image_search_download first to download an image."
    );
  }

  const accessToken = await getAccessToken();
  const fileBuffer = readFileSync(filePath);
  const originalFilename = basename(filePath);
  const uploadFilename = args?.filename || originalFilename;
  const mimeType = getMimeType(uploadFilename);
  const folderId = args?.folder_id || config.googleDriveFolderId || "";
  const makePublic = args?.make_public === true;

  log("info", `Uploading to Google Drive: ${uploadFilename} (${fileBuffer.length} bytes)`);

  // Step 1: Create file metadata
  const metadata = { name: uploadFilename, mimeType };
  if (folderId) {
    metadata.parents = [folderId];
  }

  // Step 2: Multipart upload (metadata + content)
  const boundary = `---boundary_${Date.now()}`;
  const metadataStr = JSON.stringify(metadata);

  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadataStr}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadResp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!uploadResp.ok) {
    const body = await uploadResp.text().catch(() => "");
    throw new Error(`Google Drive upload failed (${uploadResp.status}): ${body}`);
  }

  const file = await uploadResp.json();

  // Step 3: Optionally make the file publicly accessible
  let publicUrl = "";
  if (makePublic) {
    try {
      const permResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}/permissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "reader", type: "anyone" }),
        }
      );
      if (permResp.ok) {
        publicUrl = `https://drive.google.com/uc?id=${file.id}&export=download`;
        log("info", `File made public: ${publicUrl}`);
      }
    } catch (err) {
      log("warn", `Failed to set public permission (non-fatal): ${err.message}`);
    }
  }

  const fileStats = statSync(filePath);
  const sizeHuman = fileStats.size > 1048576
    ? `${(fileStats.size / 1048576).toFixed(1)} MB`
    : `${(fileStats.size / 1024).toFixed(0)} KB`;

  const lines = [
    "Google Drive Upload Complete",
    "============================",
    `File ID:      ${file.id}`,
    `Filename:     ${file.name}`,
    `Type:         ${file.mimeType}`,
    `Size:         ${sizeHuman}`,
    folderId ? `Folder ID:    ${folderId}` : `Location:     My Drive (root)`,
    ``,
    `View Link:    ${file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`}`,
    file.webContentLink ? `Download:     ${file.webContentLink}` : null,
    publicUrl ? `Public URL:   ${publicUrl}` : null,
    ``,
    makePublic
      ? "This file is publicly accessible (anyone with the link can view/download)."
      : "This file is private. Set make_public: true to create a shareable link.",
    ``,
    "Next steps:",
    publicUrl
      ? `  • wordpress_upload_media — use image_url: "${publicUrl}" to upload to WordPress`
      : `  • wordpress_upload_media — use the original file_path to upload to WordPress`,
  ];

  return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
}

// -----------------------------------------------------------------------

export async function handleGoogleDriveList(args) {
  const accessToken = await getAccessToken();
  const folderId = args?.folder_id || "";
  const maxResults = Math.min(Math.max(Number(args?.max_results) || 20, 1), 50);
  const searchName = args?.search_name || "";

  // Build query
  const queryParts = ["trashed = false"];
  if (folderId) queryParts.push(`'${folderId}' in parents`);
  if (searchName) queryParts.push(`name contains '${searchName.replace(/'/g, "\\'")}'`);

  const params = new URLSearchParams({
    q: queryParts.join(" and "),
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: String(maxResults),
  });

  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google Drive list failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  const files = data.files || [];

  if (files.length === 0) {
    return {
      content: [{
        type: "text",
        text: folderId
          ? `No files found in folder ${folderId}.`
          : "No files found in Google Drive.",
      }],
    };
  }

  const lines = files.map((f, i) => {
    const size = f.size
      ? Number(f.size) > 1048576
        ? `${(Number(f.size) / 1048576).toFixed(1)} MB`
        : `${(Number(f.size) / 1024).toFixed(0)} KB`
      : "unknown";

    const parts = [`[${i + 1}] ${f.name}`];
    parts.push(`  ID:       ${f.id}`);
    parts.push(`  Type:     ${f.mimeType}`);
    parts.push(`  Size:     ${size}`);
    parts.push(`  Modified: ${f.modifiedTime?.slice(0, 16) || ""}`);
    if (f.webViewLink) parts.push(`  View:     ${f.webViewLink}`);
    return parts.join("\n");
  });

  return {
    content: [{
      type: "text",
      text: `Google Drive Files (${files.length})${folderId ? ` in folder ${folderId}` : ""}\n\n${lines.join("\n\n")}`,
    }],
  };
}
