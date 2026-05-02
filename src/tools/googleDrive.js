// tools/googleDrive.js
//
// Google Drive integration for claude-connector.
//
// ORIGINAL (preserved, unchanged behaviour):
//   google_drive_upload              -- Uploads a local file to Google Drive
//   google_drive_list                -- Lists files in a Google Drive folder
//
// NEW (full Drive CRUD surface):
//   google_drive_check_connection    -- Verify auth + reachability (diagnostics)
//   google_drive_search_files        -- Search by name / fullText / mimeType / parent / modifiedTime
//   google_drive_read_file_content   -- Read text content of a file (exports Google Docs/Sheets/Slides)
//   google_drive_download_file_content -- Download binary content (base64 + optional local save)
//   google_drive_create_file         -- Create OR overwrite files from text or base64 data
//   google_drive_get_file_metadata   -- Retrieve full metadata for a file
//   google_drive_list_recent_files   -- List most-recently modified files
//   google_drive_get_file_permissions -- List permissions on a file
//
// AUTHENTICATION OPTIONS:
//   Option A -- Service Account (recommended for servers):
//     Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE to the JSON key file path.
//     Share target folders/files with the service account email so the
//     account can read/modify them.
//
//   Option B -- OAuth2 Refresh Token (personal Google accounts):
//     Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
//     The refresh token must have been granted the scope configured via
//     GOOGLE_DRIVE_SCOPES (default: full Drive access).
//
// SCOPE NOTE:
//   The original implementation used "drive.file" which restricts access to
//   files the app itself created or was explicitly given. The new tools need
//   broader access to discover and read pre-existing files, so the default
//   scope is now "https://www.googleapis.com/auth/drive". Override via
//   GOOGLE_DRIVE_SCOPES if you want to stay restricted.

import {
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { basename, extname, dirname, resolve as pathResolve } from "node:path";
import { config } from "../config.js";
import { log } from "../utils/logger.js";

// -----------------------------------------------------------------------
// Constants / defaults
// -----------------------------------------------------------------------

const DEFAULT_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// Drive API endpoints
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Google Workspace MIME types that must be exported rather than downloaded
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
const GOOGLE_DRAWING_MIME = "application/vnd.google-apps.drawing";
const GOOGLE_SCRIPT_MIME = "application/vnd.google-apps.script";

// Default export formats for Google-native files
const DEFAULT_EXPORT_TEXT = {
  [GOOGLE_DOC_MIME]: "text/plain",
  [GOOGLE_SHEET_MIME]: "text/csv",
  [GOOGLE_SLIDES_MIME]: "text/plain",
  [GOOGLE_DRAWING_MIME]: "image/png",
  [GOOGLE_SCRIPT_MIME]: "application/vnd.google-apps.script+json",
};

const DEFAULT_EXPORT_BINARY = {
  [GOOGLE_DOC_MIME]:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  [GOOGLE_SHEET_MIME]:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  [GOOGLE_SLIDES_MIME]:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  [GOOGLE_DRAWING_MIME]: "image/png",
  [GOOGLE_SCRIPT_MIME]: "application/vnd.google-apps.script+json",
};

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
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// -----------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------

function resolveScopes() {
  // Allow overrides like "https://www.googleapis.com/auth/drive.readonly"
  // or a space / comma separated list.
  const raw = (config.googleDriveScopes || DEFAULT_DRIVE_SCOPE).trim();
  return raw.replace(/,/g, " ").replace(/\s+/g, " ");
}

/**
 * Get an access token using Service Account credentials.
 * Implements JWT-based authentication without external dependencies.
 */
async function getServiceAccountToken() {
  const keyFilePath = config.googleServiceAccountKeyFile;
  if (!keyFilePath || !existsSync(keyFilePath)) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set or the file was not found.\n\n" +
        "To set up Google Drive with a Service Account:\n" +
        "  1. Google Cloud Console > IAM & Admin > Service Accounts\n" +
        "  2. Create a service account and download the JSON key file\n" +
        "  3. Enable the Google Drive API for the project\n" +
        "  4. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/keyfile.json\n" +
        "  5. Share the target folders/files with the service account email\n" +
        "     (e.g. name@project-id.iam.gserviceaccount.com)"
    );
  }

  let keyData;
  try {
    keyData = JSON.parse(readFileSync(keyFilePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse service account key at ${keyFilePath}: ${err.message}`
    );
  }

  const { client_email, private_key } = keyData;
  if (!client_email || !private_key) {
    throw new Error(
      "Invalid service account key file: missing client_email or private_key."
    );
  }

  const scopes = resolveScopes();

  // Optional impersonation for Workspace domain-wide delegation
  const subject = (config.googleImpersonateSubject || "").trim();

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");

  const claim = {
    iss: client_email,
    scope: scopes,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  if (subject) claim.sub = subject;

  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");

  const signInput = `${header}.${payload}`;

  const { createSign } = await import("node:crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(private_key, "base64url");

  const jwt = `${signInput}.${signature}`;

  const tokenResp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text().catch(() => "");
    throw new Error(
      `Google OAuth token exchange failed (${tokenResp.status}): ${body}`
    );
  }

  const tokenData = await tokenResp.json();
  return {
    accessToken: tokenData.access_token,
    authMethod: "service_account",
    clientEmail: client_email,
    scope: scopes,
    impersonating: subject || null,
  };
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
        "  GOOGLE_CLIENT_ID       -- from Google Cloud Console\n" +
        "  GOOGLE_CLIENT_SECRET   -- from Google Cloud Console\n" +
        "  GOOGLE_REFRESH_TOKEN   -- obtained via OAuth2 consent flow\n\n" +
        "Alternatively, use a service account via GOOGLE_SERVICE_ACCOUNT_KEY_FILE."
    );
  }

  const tokenResp = await fetch(OAUTH_TOKEN_URL, {
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
    throw new Error(
      `Google OAuth2 token refresh failed (${tokenResp.status}): ${body}`
    );
  }

  const tokenData = await tokenResp.json();
  return {
    accessToken: tokenData.access_token,
    authMethod: "oauth2_refresh_token",
    clientEmail: null,
    scope: tokenData.scope || resolveScopes(),
    impersonating: null,
  };
}

/**
 * Return access token + auth metadata using whichever method is configured.
 * The original `getAccessToken()` function (returning just the string) is
 * preserved below for backward-compatibility with the existing upload/list
 * handlers.
 */
async function getAccessInfo() {
  if (config.googleServiceAccountKeyFile) {
    return getServiceAccountToken();
  }
  if (config.googleRefreshToken) {
    return getOAuth2Token();
  }
  throw new Error(
    "Google Drive is not configured.\n\n" +
      "Option A -- Service Account (recommended):\n" +
      "  Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/service-account-key.json\n\n" +
      "Option B -- OAuth2 Refresh Token:\n" +
      "  Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN\n\n" +
      "Optional:\n" +
      "  GOOGLE_DRIVE_SCOPES        -- override scopes (default: full Drive access)\n" +
      "  GOOGLE_IMPERSONATE_SUBJECT -- for domain-wide delegation (Workspace only)"
  );
}

/**
 * Backward-compatible helper used by the existing upload + list handlers,
 * and exported so googleCalendar.js and googleSheets.js can reuse the same
 * auth infrastructure without duplicating credential logic.
 * Returns just the access token string.
 */
export async function getAccessToken() {
  const info = await getAccessInfo();
  return info.accessToken;
}

/**
 * Small wrapper around fetch that attaches the auth header and turns
 * non-2xx Drive responses into descriptive errors.
 */
async function driveFetch(accessToken, url, init = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(init.headers || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(
      `Google Drive API ${init.method || "GET"} ${url} failed (${resp.status}): ${body}`
    );
    err.status = resp.status;
    throw err;
  }
  return resp;
}

// -----------------------------------------------------------------------
// Shared query helpers
// -----------------------------------------------------------------------

function escapeDriveQueryValue(value) {
  // Google Drive query strings use single-quoted values. Escape embedded
  // single quotes and backslashes per the API spec.
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const DRIVE_FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "size",
  "modifiedTime",
  "createdTime",
  "parents",
  "owners(emailAddress,displayName)",
  "webViewLink",
  "webContentLink",
  "thumbnailLink",
  "iconLink",
  "trashed",
  "starred",
  "shared",
  "description",
  "md5Checksum",
  "fileExtension",
  "capabilities(canEdit,canDownload,canDelete,canShare)",
].join(",");

const DRIVE_FILES_FIELDS = `nextPageToken,files(${DRIVE_FILE_FIELDS})`;

function formatFileLine(f, index) {
  const parts = [`[${index}] ${f.name}`];
  parts.push(`  ID:       ${f.id}`);
  parts.push(`  Type:     ${f.mimeType}`);
  parts.push(`  Size:     ${humanSize(f.size)}`);
  if (f.modifiedTime)
    parts.push(`  Modified: ${f.modifiedTime.slice(0, 19).replace("T", " ")} UTC`);
  if (f.owners && f.owners.length) {
    const ownerStr = f.owners
      .map((o) => o.emailAddress || o.displayName)
      .filter(Boolean)
      .join(", ");
    if (ownerStr) parts.push(`  Owner:    ${ownerStr}`);
  }
  if (f.webViewLink) parts.push(`  View:     ${f.webViewLink}`);
  return parts.join("\n");
}

// =======================================================================
// ORIGINAL TOOL DEFINITIONS (preserved)
// =======================================================================

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

// =======================================================================
// ORIGINAL HANDLERS (preserved unchanged)
// =======================================================================

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
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink`,
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
        `${DRIVE_API}/files/${file.id}/permissions`,
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
  const sizeHuman = humanSize(fileStats.size);

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
      ? `  - wordpress_upload_media -- use image_url: "${publicUrl}" to upload to WordPress`
      : `  - wordpress_upload_media -- use the original file_path to upload to WordPress`,
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
  if (folderId) queryParts.push(`'${escapeDriveQueryValue(folderId)}' in parents`);
  if (searchName)
    queryParts.push(`name contains '${escapeDriveQueryValue(searchName)}'`);

  const params = new URLSearchParams({
    q: queryParts.join(" and "),
    fields:
      "files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: String(maxResults),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const resp = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google Drive list failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  const files = data.files || [];

  if (files.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: folderId
            ? `No files found in folder ${folderId}.`
            : "No files found in Google Drive.",
        },
      ],
    };
  }

  const lines = files.map((f, i) => {
    const parts = [`[${i + 1}] ${f.name}`];
    parts.push(`  ID:       ${f.id}`);
    parts.push(`  Type:     ${f.mimeType}`);
    parts.push(`  Size:     ${humanSize(f.size)}`);
    parts.push(`  Modified: ${f.modifiedTime?.slice(0, 16) || ""}`);
    if (f.webViewLink) parts.push(`  View:     ${f.webViewLink}`);
    return parts.join("\n");
  });

  return {
    content: [
      {
        type: "text",
        text: `Google Drive Files (${files.length})${folderId ? ` in folder ${folderId}` : ""}\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// =======================================================================
// NEW: Connection diagnostic
// =======================================================================

export const googleDriveCheckConnectionToolDefinition = {
  name: "google_drive_check_connection",
  description:
    "Diagnostic tool that verifies Google Drive connectivity end to end. " +
    "Obtains an access token, calls the Drive 'about' endpoint, and reports " +
    "auth method, principal email, scopes, storage quota and whether a " +
    "default folder (if configured) is reachable. Run this first if any " +
    "other Google Drive tool fails so you can confirm credentials are valid.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export async function handleGoogleDriveCheckConnection() {
  const lines = [];
  lines.push("Google Drive Connection Check");
  lines.push("=============================");

  // 1. Which auth method is configured
  const hasSA = !!config.googleServiceAccountKeyFile;
  const hasOAuth =
    !!config.googleClientId &&
    !!config.googleClientSecret &&
    !!config.googleRefreshToken;

  lines.push(`Service account configured : ${hasSA ? "yes" : "no"}`);
  lines.push(`OAuth2 refresh configured  : ${hasOAuth ? "yes" : "no"}`);
  lines.push(`Requested scopes           : ${resolveScopes()}`);

  let info;
  try {
    info = await getAccessInfo();
  } catch (err) {
    lines.push("");
    lines.push("TOKEN FETCH FAILED:");
    lines.push(err.message);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }

  lines.push(`Auth method used           : ${info.authMethod}`);
  if (info.clientEmail) lines.push(`Service account email      : ${info.clientEmail}`);
  if (info.impersonating)
    lines.push(`Impersonating subject      : ${info.impersonating}`);
  lines.push(`Access token acquired      : yes (length ${info.accessToken.length})`);

  // 2. Call drive.about
  let about;
  try {
    const resp = await driveFetch(
      info.accessToken,
      `${DRIVE_API}/about?fields=user(displayName,emailAddress),storageQuota,canCreateDrives`
    );
    about = await resp.json();
  } catch (err) {
    lines.push("");
    lines.push("drive.about call FAILED:");
    lines.push(err.message);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }

  lines.push("");
  lines.push("Drive account info:");
  if (about.user) {
    lines.push(`  Principal  : ${about.user.displayName || ""} <${about.user.emailAddress || ""}>`);
  }
  if (about.storageQuota) {
    const q = about.storageQuota;
    lines.push(`  Quota used : ${humanSize(q.usage)} of ${q.limit ? humanSize(q.limit) : "unlimited"}`);
  }

  // 3. Verify default folder (if configured)
  const defaultFolder = (config.googleDriveFolderId || "").trim();
  if (defaultFolder) {
    try {
      const resp = await driveFetch(
        info.accessToken,
        `${DRIVE_API}/files/${encodeURIComponent(defaultFolder)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`
      );
      const f = await resp.json();
      lines.push(`  Default folder '${f.name}' (${f.id}) is reachable.`);
    } catch (err) {
      lines.push(
        `  WARNING: configured default folder ${defaultFolder} could not be read. ${err.message}`
      );
    }
  }

  lines.push("");
  lines.push("Connection is functional. All Google Drive tools should work.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// =======================================================================
// NEW: Search files
// =======================================================================

export const googleDriveSearchFilesToolDefinition = {
  name: "google_drive_search_files",
  description:
    "Search Google Drive files by name, full-text content or metadata. " +
    "Supports partial name match, exact name, full-text (content) search, " +
    "MIME type filter, parent folder filter, trashed filter, owner filter " +
    "and modified-time window. Returns matching files with IDs, MIME types, " +
    "sizes, modified times and view links.",
  inputSchema: {
    type: "object",
    properties: {
      name_contains: {
        type: "string",
        description: "Case-insensitive substring match on file name.",
      },
      name_equals: {
        type: "string",
        description: "Exact file name match (case sensitive).",
      },
      full_text_contains: {
        type: "string",
        description:
          "Free-text content search -- matches against the indexed text content, " +
          "description and some metadata of Drive files.",
      },
      mime_type: {
        type: "string",
        description:
          "Filter by MIME type (e.g. 'application/pdf', 'application/vnd.google-apps.document', 'image/jpeg').",
      },
      parent_folder_id: {
        type: "string",
        description: "Only return direct children of this folder ID.",
      },
      owner_email: {
        type: "string",
        description: "Only return files owned by this email address.",
      },
      modified_after: {
        type: "string",
        description:
          "RFC 3339 timestamp (e.g. '2025-01-01T00:00:00Z'). Only return files modified after this time.",
      },
      modified_before: {
        type: "string",
        description:
          "RFC 3339 timestamp (e.g. '2025-12-31T23:59:59Z'). Only return files modified before this time.",
      },
      include_trashed: {
        type: "boolean",
        description: "If true, also return trashed files. Defaults to false.",
      },
      only_folders: {
        type: "boolean",
        description:
          "If true, only return folders (mimeType = application/vnd.google-apps.folder).",
      },
      order_by: {
        type: "string",
        description:
          "Sort order (Drive API syntax). Examples: 'modifiedTime desc' (default), 'name', 'createdTime desc', 'folder,name'.",
      },
      page_size: {
        type: "number",
        description: "Maximum number of results (1-100, default 25).",
      },
      page_token: {
        type: "string",
        description:
          "Continuation token from a previous response's 'next_page_token' to fetch the next page.",
      },
      raw_query: {
        type: "string",
        description:
          "Advanced: raw Drive API 'q' string. If set, overrides the other filters entirely. " +
          "See https://developers.google.com/drive/api/guides/search-files",
      },
    },
    required: [],
  },
};

function buildSearchQuery(args) {
  if (args?.raw_query) return String(args.raw_query);

  const parts = [];
  if (!args?.include_trashed) parts.push("trashed = false");

  if (args?.name_contains)
    parts.push(`name contains '${escapeDriveQueryValue(args.name_contains)}'`);
  if (args?.name_equals)
    parts.push(`name = '${escapeDriveQueryValue(args.name_equals)}'`);
  if (args?.full_text_contains)
    parts.push(
      `fullText contains '${escapeDriveQueryValue(args.full_text_contains)}'`
    );
  if (args?.mime_type)
    parts.push(`mimeType = '${escapeDriveQueryValue(args.mime_type)}'`);
  if (args?.only_folders)
    parts.push("mimeType = 'application/vnd.google-apps.folder'");
  if (args?.parent_folder_id)
    parts.push(`'${escapeDriveQueryValue(args.parent_folder_id)}' in parents`);
  if (args?.owner_email)
    parts.push(`'${escapeDriveQueryValue(args.owner_email)}' in owners`);
  if (args?.modified_after)
    parts.push(`modifiedTime > '${escapeDriveQueryValue(args.modified_after)}'`);
  if (args?.modified_before)
    parts.push(`modifiedTime < '${escapeDriveQueryValue(args.modified_before)}'`);

  return parts.length ? parts.join(" and ") : "trashed = false";
}

export async function handleGoogleDriveSearchFiles(args) {
  const accessToken = await getAccessToken();
  const pageSize = Math.min(Math.max(Number(args?.page_size) || 25, 1), 100);
  const orderBy = args?.order_by || "modifiedTime desc";

  const params = new URLSearchParams({
    q: buildSearchQuery(args || {}),
    fields: DRIVE_FILES_FIELDS,
    orderBy,
    pageSize: String(pageSize),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (args?.page_token) params.set("pageToken", String(args.page_token));

  const resp = await driveFetch(
    accessToken,
    `${DRIVE_API}/files?${params.toString()}`
  );
  const data = await resp.json();
  const files = data.files || [];

  if (!files.length) {
    return {
      content: [
        {
          type: "text",
          text: `No files matched. Query: ${params.get("q")}`,
        },
      ],
    };
  }

  const header = `Google Drive Search -- ${files.length} result(s)\nQuery: ${params.get("q")}`;
  const body = files.map((f, i) => formatFileLine(f, i + 1)).join("\n\n");
  const footer = data.nextPageToken
    ? `\n\nNext page token: ${data.nextPageToken}`
    : "";

  return {
    content: [{ type: "text", text: `${header}\n\n${body}${footer}` }],
  };
}

// =======================================================================
// NEW: Read file content (text)
// =======================================================================

export const googleDriveReadFileContentToolDefinition = {
  name: "google_drive_read_file_content",
  description:
    "Read the textual content of a Google Drive file. Google-native files " +
    "(Docs, Sheets, Slides, Drawings) are exported automatically (Docs -> text/plain, " +
    "Sheets -> text/csv, Slides -> text/plain, Drawings -> image/png). " +
    "Plain text, JSON, CSV, Markdown, HTML, XML and similar text files are " +
    "returned as-is. Binary files can be read but should typically use " +
    "google_drive_download_file_content instead. Output is truncated to " +
    "'max_chars' characters (default 100000).",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "Google Drive file ID to read.",
      },
      export_mime_type: {
        type: "string",
        description:
          "For Google-native files, override the export format (e.g. 'text/plain', 'text/csv', 'application/pdf').",
      },
      max_chars: {
        type: "number",
        description:
          "Maximum characters of content to return (1-500000, default 100000). Content beyond is truncated.",
      },
    },
    required: ["file_id"],
  },
};

async function fetchFileMetadata(accessToken, fileId) {
  const resp = await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}&supportsAllDrives=true`
  );
  return resp.json();
}

async function fetchFileBinary(accessToken, fileId, exportMimeType) {
  const meta = await fetchFileMetadata(accessToken, fileId);

  let url;
  let isExport = false;
  if (meta.mimeType && meta.mimeType.startsWith("application/vnd.google-apps.")) {
    const mime =
      exportMimeType ||
      DEFAULT_EXPORT_BINARY[meta.mimeType] ||
      "application/pdf";
    url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mime)}`;
    isExport = true;
    meta.exportedAs = mime;
  } else {
    url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  }

  const resp = await driveFetch(accessToken, url);
  const arrayBuf = await resp.arrayBuffer();
  return { meta, buffer: Buffer.from(arrayBuf), isExport };
}

export async function handleGoogleDriveReadFileContent(args) {
  const fileId = (args?.file_id || "").trim();
  if (!fileId) throw new Error("'file_id' is required.");

  const maxChars = Math.min(
    Math.max(Number(args?.max_chars) || 100000, 1),
    500000
  );

  const accessToken = await getAccessToken();
  const meta = await fetchFileMetadata(accessToken, fileId);

  let contentBuffer;
  let sourceMime = meta.mimeType;
  let usedExportMime = null;

  if (meta.mimeType && meta.mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime =
      args?.export_mime_type ||
      DEFAULT_EXPORT_TEXT[meta.mimeType] ||
      "application/pdf";
    usedExportMime = exportMime;
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const resp = await driveFetch(accessToken, url);
    contentBuffer = Buffer.from(await resp.arrayBuffer());
    sourceMime = exportMime;
  } else {
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const resp = await driveFetch(accessToken, url);
    contentBuffer = Buffer.from(await resp.arrayBuffer());
  }

  let text;
  let truncated = false;
  const looksText =
    /^(text\/|application\/(json|xml|javascript|ld\+json|x-yaml|sql))/.test(
      sourceMime || ""
    ) || (sourceMime || "").includes("+xml");

  if (looksText || sourceMime === "application/vnd.google-apps.script+json") {
    text = contentBuffer.toString("utf-8");
  } else {
    // Best-effort UTF-8 decode with a warning for binary content
    text = contentBuffer.toString("utf-8");
    if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 4000))) {
      text =
        `(Binary file -- MIME ${sourceMime}, ${humanSize(contentBuffer.length)}. ` +
        `Use google_drive_download_file_content for binary access. ` +
        `Showing best-effort text decode below.)\n\n` +
        text;
    }
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  const header = [
    `Google Drive Read: ${meta.name}`,
    `File ID:       ${meta.id}`,
    `Source MIME:   ${meta.mimeType}`,
    usedExportMime ? `Exported as:   ${usedExportMime}` : null,
    `Total bytes:   ${humanSize(contentBuffer.length)}`,
    truncated ? `(Truncated to first ${maxChars} chars)` : null,
    `----`,
  ]
    .filter(Boolean)
    .join("\n");

  return { content: [{ type: "text", text: `${header}\n${text}` }] };
}

// =======================================================================
// NEW: Download file content (binary)
// =======================================================================

export const googleDriveDownloadFileContentToolDefinition = {
  name: "google_drive_download_file_content",
  description:
    "Download the binary content of a Google Drive file. Returns base64 " +
    "data (up to max_base64_bytes) and, if 'save_path' is provided, also " +
    "writes the bytes to the local filesystem. Google-native files (Docs, " +
    "Sheets, Slides, Drawings) are exported using 'export_mime_type' or a " +
    "sensible default (docx/xlsx/pptx/png).",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "Google Drive file ID to download.",
      },
      save_path: {
        type: "string",
        description:
          "Optional local absolute path to write the file to. Parent directories are created if missing.",
      },
      export_mime_type: {
        type: "string",
        description:
          "For Google-native files, override the export format (e.g. 'application/pdf', 'image/png').",
      },
      include_base64: {
        type: "boolean",
        description:
          "If true (default), return the file content inline as base64 in the response. Set false to suppress base64 (useful for large files when save_path is provided).",
      },
      max_base64_bytes: {
        type: "number",
        description:
          "Maximum number of bytes to return inline as base64 (default 5242880 = 5 MB). Larger files are truncated in the base64 response but fully written to save_path if provided.",
      },
    },
    required: ["file_id"],
  },
};

export async function handleGoogleDriveDownloadFileContent(args) {
  const fileId = (args?.file_id || "").trim();
  if (!fileId) throw new Error("'file_id' is required.");

  const includeBase64 = args?.include_base64 !== false;
  const maxBase64 = Math.max(
    0,
    Number(args?.max_base64_bytes) || 5 * 1024 * 1024
  );

  const accessToken = await getAccessToken();
  const { meta, buffer, isExport } = await fetchFileBinary(
    accessToken,
    fileId,
    args?.export_mime_type
  );

  let savedPath = null;
  if (args?.save_path) {
    const abs = pathResolve(String(args.save_path));
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, buffer);
    savedPath = abs;
  }

  const lines = [
    `Google Drive Download: ${meta.name}`,
    `File ID:       ${meta.id}`,
    `Source MIME:   ${meta.mimeType}`,
    isExport ? `Exported as:   ${meta.exportedAs}` : null,
    `Bytes:         ${humanSize(buffer.length)} (${buffer.length})`,
    savedPath ? `Saved to:      ${savedPath}` : null,
  ].filter(Boolean);

  if (includeBase64) {
    const slice =
      buffer.length > maxBase64 ? buffer.subarray(0, maxBase64) : buffer;
    const b64 = slice.toString("base64");
    lines.push(
      `Base64 bytes:  ${slice.length}${buffer.length > maxBase64 ? " (TRUNCATED for inline response)" : ""}`
    );
    lines.push("----");
    lines.push(b64);
  } else {
    lines.push("Base64 suppressed (include_base64=false).");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// =======================================================================
// NEW: Create / overwrite file
// =======================================================================

export const googleDriveCreateFileToolDefinition = {
  name: "google_drive_create_file",
  description:
    "Create a new file or overwrite an existing one in Google Drive. " +
    "Provide content as either 'text_content' (UTF-8 string) or 'base64_content' " +
    "(arbitrary binary). If 'file_id' is supplied, that file's content is " +
    "overwritten (new revision). If 'overwrite_by_name' is true and a file " +
    "with the same 'filename' exists in the target folder, it is overwritten " +
    "instead of duplicated. If no target is found, a new file is created. " +
    "MIME type is inferred from the filename unless 'mime_type' is given.",
  inputSchema: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          "Target filename in Google Drive (required unless file_id is supplied for pure content overwrite).",
      },
      folder_id: {
        type: "string",
        description:
          "Target folder ID. Defaults to GOOGLE_DRIVE_FOLDER_ID env var, or My Drive root if unset. Ignored when file_id is set.",
      },
      file_id: {
        type: "string",
        description:
          "If provided, overwrite the content (and optionally filename) of this existing file.",
      },
      text_content: {
        type: "string",
        description: "UTF-8 text content to upload.",
      },
      base64_content: {
        type: "string",
        description: "Binary content encoded as base64. Mutually exclusive with text_content.",
      },
      mime_type: {
        type: "string",
        description:
          "Explicit MIME type. If omitted, it is inferred from the filename extension (default application/octet-stream).",
      },
      description: {
        type: "string",
        description: "Optional description stored on the file.",
      },
      overwrite_by_name: {
        type: "boolean",
        description:
          "If true and file_id is not supplied: look for an existing file with the same filename in the target folder and overwrite it. Defaults to false.",
      },
      make_public: {
        type: "boolean",
        description:
          "If true, grant 'anyone with the link' reader access to the resulting file. Defaults to false.",
      },
    },
    required: [],
  },
};

async function findFileByNameInFolder(accessToken, filename, folderId) {
  const parts = [
    "trashed = false",
    `name = '${escapeDriveQueryValue(filename)}'`,
  ];
  if (folderId) parts.push(`'${escapeDriveQueryValue(folderId)}' in parents`);
  const params = new URLSearchParams({
    q: parts.join(" and "),
    fields: "files(id,name,mimeType,parents)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const resp = await driveFetch(
    accessToken,
    `${DRIVE_API}/files?${params.toString()}`
  );
  const data = await resp.json();
  return data.files && data.files.length ? data.files[0] : null;
}

async function setAnyoneReader(accessToken, fileId) {
  try {
    await driveFetch(accessToken, `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    return `https://drive.google.com/uc?id=${fileId}&export=download`;
  } catch (err) {
    log("warn", `Failed to set public permission: ${err.message}`);
    return null;
  }
}

export async function handleGoogleDriveCreateFile(args) {
  const hasText = typeof args?.text_content === "string";
  const hasB64 = typeof args?.base64_content === "string" && args.base64_content.length > 0;

  if (hasText && hasB64) {
    throw new Error("Provide either text_content OR base64_content, not both.");
  }
  if (!hasText && !hasB64) {
    throw new Error("Provide either text_content or base64_content.");
  }

  const contentBuffer = hasText
    ? Buffer.from(args.text_content, "utf-8")
    : Buffer.from(args.base64_content, "base64");

  const providedFileId = (args?.file_id || "").trim();
  const providedFilename = (args?.filename || "").trim();
  const folderId = (args?.folder_id || config.googleDriveFolderId || "").trim();
  const overwriteByName = args?.overwrite_by_name === true;
  const makePublic = args?.make_public === true;

  if (!providedFileId && !providedFilename) {
    throw new Error(
      "Either 'file_id' or 'filename' is required. Use 'filename' (with optional 'folder_id') to create a new file."
    );
  }

  const accessToken = await getAccessToken();

  let existingFile = null;
  if (providedFileId) {
    existingFile = await fetchFileMetadata(accessToken, providedFileId);
  } else if (overwriteByName) {
    existingFile = await findFileByNameInFolder(accessToken, providedFilename, folderId);
  }

  const effectiveFilename = providedFilename || (existingFile && existingFile.name) || "";
  const mimeType =
    (args?.mime_type || "").trim() ||
    (effectiveFilename ? getMimeType(effectiveFilename) : "application/octet-stream");

  // ------- Path 1: Overwrite existing file (PATCH upload) -------
  if (existingFile) {
    const boundary = `---boundary_${Date.now()}`;
    const metadata = {};
    if (providedFilename && providedFilename !== existingFile.name) {
      metadata.name = providedFilename;
    }
    if (typeof args?.description === "string") {
      metadata.description = args.description;
    }
    if (args?.mime_type) metadata.mimeType = mimeType;

    const hasMetadata = Object.keys(metadata).length > 0;

    let body;
    let contentType;
    let url;

    if (hasMetadata) {
      const metadataStr = JSON.stringify(metadata);
      body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
        ),
        contentBuffer,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      contentType = `multipart/related; boundary=${boundary}`;
      url = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFile.id)}?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink,modifiedTime&supportsAllDrives=true`;
    } else {
      body = contentBuffer;
      contentType = mimeType;
      url = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFile.id)}?uploadType=media&fields=id,name,mimeType,size,webViewLink,webContentLink,modifiedTime&supportsAllDrives=true`;
    }

    const resp = await driveFetch(accessToken, url, {
      method: "PATCH",
      headers: { "Content-Type": contentType },
      body,
    });
    const file = await resp.json();

    let publicUrl = null;
    if (makePublic) publicUrl = await setAnyoneReader(accessToken, file.id);

    const lines = [
      "Google Drive File Overwritten",
      "=============================",
      `File ID:      ${file.id}`,
      `Filename:     ${file.name}`,
      `Type:         ${file.mimeType}`,
      `Size:         ${humanSize(file.size || contentBuffer.length)}`,
      `Modified:     ${file.modifiedTime || ""}`,
      `View Link:    ${file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`}`,
      publicUrl ? `Public URL:   ${publicUrl}` : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ------- Path 2: Create new file (multipart POST) -------
  if (!effectiveFilename) {
    throw new Error("'filename' is required when creating a new file.");
  }

  const metadata = { name: effectiveFilename, mimeType };
  if (folderId) metadata.parents = [folderId];
  if (typeof args?.description === "string") metadata.description = args.description;

  const boundary = `---boundary_${Date.now()}`;
  const metadataStr = JSON.stringify(metadata);
  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    contentBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const resp = await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink,modifiedTime&supportsAllDrives=true`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    }
  );
  const file = await resp.json();

  let publicUrl = null;
  if (makePublic) publicUrl = await setAnyoneReader(accessToken, file.id);

  const lines = [
    "Google Drive File Created",
    "=========================",
    `File ID:      ${file.id}`,
    `Filename:     ${file.name}`,
    `Type:         ${file.mimeType}`,
    `Size:         ${humanSize(file.size || contentBuffer.length)}`,
    folderId ? `Folder ID:    ${folderId}` : `Location:     My Drive (root)`,
    `View Link:    ${file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`}`,
    publicUrl ? `Public URL:   ${publicUrl}` : null,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// =======================================================================
// NEW: Get file metadata
// =======================================================================

export const googleDriveGetFileMetadataToolDefinition = {
  name: "google_drive_get_file_metadata",
  description:
    "Retrieve rich metadata for a single Google Drive file, including " +
    "IDs, MIME type, size, owners, parents, timestamps, sharing state, " +
    "thumbnail / view links and edit/download/delete capabilities.",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "Google Drive file ID.",
      },
    },
    required: ["file_id"],
  },
};

export async function handleGoogleDriveGetFileMetadata(args) {
  const fileId = (args?.file_id || "").trim();
  if (!fileId) throw new Error("'file_id' is required.");
  const accessToken = await getAccessToken();
  const meta = await fetchFileMetadata(accessToken, fileId);

  const lines = [
    `Google Drive File Metadata`,
    `==========================`,
    `Name:          ${meta.name}`,
    `ID:            ${meta.id}`,
    `MIME Type:     ${meta.mimeType}`,
    `Size:          ${humanSize(meta.size)}`,
    `Created:       ${meta.createdTime || ""}`,
    `Modified:      ${meta.modifiedTime || ""}`,
    meta.description ? `Description:   ${meta.description}` : null,
    meta.fileExtension ? `Extension:     .${meta.fileExtension}` : null,
    meta.md5Checksum ? `MD5:           ${meta.md5Checksum}` : null,
    meta.parents ? `Parents:       ${meta.parents.join(", ")}` : null,
    meta.owners
      ? `Owners:        ${meta.owners.map((o) => `${o.displayName || ""} <${o.emailAddress || ""}>`).join(", ")}`
      : null,
    `Trashed:       ${meta.trashed ? "yes" : "no"}`,
    `Starred:       ${meta.starred ? "yes" : "no"}`,
    `Shared:        ${meta.shared ? "yes" : "no"}`,
    meta.capabilities
      ? `Capabilities:  edit=${!!meta.capabilities.canEdit} download=${!!meta.capabilities.canDownload} delete=${!!meta.capabilities.canDelete} share=${!!meta.capabilities.canShare}`
      : null,
    meta.webViewLink ? `View Link:     ${meta.webViewLink}` : null,
    meta.webContentLink ? `Download Link: ${meta.webContentLink}` : null,
    meta.thumbnailLink ? `Thumbnail:     ${meta.thumbnailLink}` : null,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// =======================================================================
// NEW: List recent files
// =======================================================================

export const googleDriveListRecentFilesToolDefinition = {
  name: "google_drive_list_recent_files",
  description:
    "List the most recently modified files in Google Drive, optionally " +
    "restricted to a folder and/or a MIME type. Sorted by modifiedTime desc.",
  inputSchema: {
    type: "object",
    properties: {
      max_results: {
        type: "number",
        description: "Maximum number of files to return (1-100, default 20).",
      },
      folder_id: {
        type: "string",
        description: "Optional folder ID to restrict the listing.",
      },
      mime_type: {
        type: "string",
        description: "Optional MIME type filter (e.g. 'application/pdf').",
      },
      include_trashed: {
        type: "boolean",
        description: "If true, also include trashed files. Defaults to false.",
      },
    },
    required: [],
  },
};

export async function handleGoogleDriveListRecentFiles(args) {
  const accessToken = await getAccessToken();
  const maxResults = Math.min(Math.max(Number(args?.max_results) || 20, 1), 100);

  const qParts = [];
  if (!args?.include_trashed) qParts.push("trashed = false");
  if (args?.folder_id)
    qParts.push(`'${escapeDriveQueryValue(args.folder_id)}' in parents`);
  if (args?.mime_type)
    qParts.push(`mimeType = '${escapeDriveQueryValue(args.mime_type)}'`);

  const params = new URLSearchParams({
    q: qParts.length ? qParts.join(" and ") : "trashed = false",
    fields: DRIVE_FILES_FIELDS,
    orderBy: "modifiedTime desc",
    pageSize: String(maxResults),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const resp = await driveFetch(
    accessToken,
    `${DRIVE_API}/files?${params.toString()}`
  );
  const data = await resp.json();
  const files = data.files || [];

  if (!files.length) {
    return {
      content: [{ type: "text", text: "No recent files found." }],
    };
  }

  const body = files.map((f, i) => formatFileLine(f, i + 1)).join("\n\n");
  return {
    content: [
      {
        type: "text",
        text: `Recent Google Drive Files (${files.length})\n\n${body}`,
      },
    ],
  };
}

// =======================================================================
// NEW: Get file permissions
// =======================================================================

export const googleDriveGetFilePermissionsToolDefinition = {
  name: "google_drive_get_file_permissions",
  description:
    "List every permission entry attached to a Google Drive file. " +
    "Includes role (owner/organizer/fileOrganizer/writer/commenter/reader), " +
    "type (user/group/domain/anyone), email/domain and whether the file is " +
    "shared publicly via 'anyone with the link'.",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "Google Drive file ID.",
      },
    },
    required: ["file_id"],
  },
};

export async function handleGoogleDriveGetFilePermissions(args) {
  const fileId = (args?.file_id || "").trim();
  if (!fileId) throw new Error("'file_id' is required.");
  const accessToken = await getAccessToken();

  const params = new URLSearchParams({
    fields:
      "permissions(id,type,role,emailAddress,domain,displayName,deleted,expirationTime,allowFileDiscovery)",
    supportsAllDrives: "true",
  });
  const resp = await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?${params.toString()}`
  );
  const data = await resp.json();
  const perms = data.permissions || [];

  if (!perms.length) {
    return {
      content: [
        { type: "text", text: `No permissions returned for file ${fileId}.` },
      ],
    };
  }

  const lines = [`Permissions for file ${fileId}`, "==============================="];
  let anyonePublic = false;
  perms.forEach((p, i) => {
    const parts = [`[${i + 1}] ${p.role} (${p.type})`];
    if (p.emailAddress) parts.push(`  Email:      ${p.emailAddress}`);
    if (p.displayName) parts.push(`  Name:       ${p.displayName}`);
    if (p.domain) parts.push(`  Domain:     ${p.domain}`);
    if (p.expirationTime) parts.push(`  Expires:    ${p.expirationTime}`);
    if (p.deleted) parts.push(`  Deleted:    yes`);
    if (typeof p.allowFileDiscovery === "boolean")
      parts.push(`  Discoverable: ${p.allowFileDiscovery}`);
    if (p.id) parts.push(`  Perm ID:    ${p.id}`);
    if (p.type === "anyone") anyonePublic = true;
    lines.push(parts.join("\n"));
  });

  lines.push("");
  lines.push(
    anyonePublic
      ? "This file is shared with 'anyone with the link'."
      : "This file is NOT publicly shared via link."
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// =======================================================================
// NEW: Overwrite file by name (name -> ID lookup then PATCH)
// =======================================================================
//
// This replaces the old overwrite_by_name flag approach with a dedicated
// tool that:
//   1. Searches the target folder for a file matching `filename` exactly.
//   2. Resolves the file ID from the search result.
//   3. Streams the new content to that file ID via PATCH (multipart upload).
//   4. If no match is found in the folder, creates a new file.
//
// This avoids the character-limit and reliability issues that came with
// embedding a search + conditional create inside google_drive_create_file
// and allows Claude to call this tool unambiguously when the intent is
// "update the existing file, not create a duplicate".

export const googleDriveOverwriteFileToolDefinition = {
  name: "google_drive_overwrite_file",
  description:
    "Overwrite an existing Google Drive file by filename and folder. " +
    "Searches the target folder for a file matching 'filename' exactly, " +
    "resolves its file ID, and PATCHes the content as a new revision. " +
    "If no match is found, a new file is created in the folder. " +
    "Provide content as 'text_content' (UTF-8 string) or 'base64_content' (binary). " +
    "MIME type is inferred from the filename unless 'mime_type' is given. " +
    "Use this tool whenever the intent is to update an existing named file, " +
    "NOT to create a duplicate alongside it.",
  inputSchema: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: "Exact filename to find and overwrite (case-sensitive).",
      },
      folder_id: {
        type: "string",
        description:
          "Google Drive folder ID to search in. Defaults to GOOGLE_DRIVE_FOLDER_ID env var, " +
          "or My Drive root if unset.",
      },
      text_content: {
        type: "string",
        description: "UTF-8 text content to write. Mutually exclusive with base64_content.",
      },
      base64_content: {
        type: "string",
        description: "Binary content encoded as base64. Mutually exclusive with text_content.",
      },
      mime_type: {
        type: "string",
        description:
          "Explicit MIME type. If omitted, inferred from filename extension.",
      },
      description: {
        type: "string",
        description: "Optional description to store on the file.",
      },
      make_public: {
        type: "boolean",
        description:
          "If true, grant 'anyone with the link' reader access to the resulting file.",
      },
    },
    required: ["filename"],
  },
};

export async function handleGoogleDriveOverwriteFile(args) {
  const filename = (args?.filename || "").trim();
  if (!filename) throw new Error("'filename' is required.");

  const hasText = typeof args?.text_content === "string";
  const hasB64 =
    typeof args?.base64_content === "string" && args.base64_content.length > 0;

  if (hasText && hasB64) {
    throw new Error("Provide either text_content OR base64_content, not both.");
  }
  if (!hasText && !hasB64) {
    throw new Error("Provide either text_content or base64_content.");
  }

  const contentBuffer = hasText
    ? Buffer.from(args.text_content, "utf-8")
    : Buffer.from(args.base64_content, "base64");

  const folderId = (args?.folder_id || config.googleDriveFolderId || "").trim();
  const mimeType =
    (args?.mime_type || "").trim() || getMimeType(filename);
  const makePublic = args?.make_public === true;

  const accessToken = await getAccessToken();

  // Step 1: Search for existing file by exact name in the target folder.
  const existingFile = await findFileByNameInFolder(
    accessToken,
    filename,
    folderId
  );

  // Step 2a: Overwrite existing file via PATCH.
  if (existingFile) {
    log(
      "info",
      `google_drive_overwrite_file: found existing file ID ${existingFile.id}, PATCHing content`
    );

    const boundary = `---boundary_${Date.now()}`;
    const metadata = {};
    if (typeof args?.description === "string") {
      metadata.description = args.description;
    }

    const hasMetadata = Object.keys(metadata).length > 0;
    let body;
    let contentType;
    let url;

    if (hasMetadata) {
      const metadataStr = JSON.stringify(metadata);
      body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
        ),
        contentBuffer,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      contentType = `multipart/related; boundary=${boundary}`;
      url = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFile.id)}?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,modifiedTime&supportsAllDrives=true`;
    } else {
      body = contentBuffer;
      contentType = mimeType;
      url = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFile.id)}?uploadType=media&fields=id,name,mimeType,size,webViewLink,modifiedTime&supportsAllDrives=true`;
    }

    const resp = await driveFetch(accessToken, url, {
      method: "PATCH",
      headers: { "Content-Type": contentType },
      body,
    });
    const file = await resp.json();

    let publicUrl = null;
    if (makePublic) publicUrl = await setAnyoneReader(accessToken, file.id);

    const lines = [
      "Google Drive File Overwritten",
      "=============================",
      `File ID:      ${file.id}`,
      `Filename:     ${file.name}`,
      `Type:         ${file.mimeType}`,
      `Size:         ${humanSize(file.size || contentBuffer.length)}`,
      `Modified:     ${file.modifiedTime || ""}`,
      `View Link:    ${file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`}`,
      publicUrl ? `Public URL:   ${publicUrl}` : null,
      ``,
      `Action: Overwrote existing file (ID ${existingFile.id}) - no duplicate created.`,
    ].filter(Boolean);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Step 2b: No existing file found - create new file.
  log(
    "info",
    `google_drive_overwrite_file: no existing file named "${filename}" in folder "${folderId}", creating new file`
  );

  const metadata = { name: filename, mimeType };
  if (folderId) metadata.parents = [folderId];
  if (typeof args?.description === "string") metadata.description = args.description;

  const boundary = `---boundary_${Date.now()}`;
  const metadataStr = JSON.stringify(metadata);
  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    contentBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const resp = await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,modifiedTime&supportsAllDrives=true`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    }
  );
  const file = await resp.json();

  let publicUrl = null;
  if (makePublic) publicUrl = await setAnyoneReader(accessToken, file.id);

  const lines = [
    "Google Drive File Created (no existing file found to overwrite)",
    "===============================================================",
    `File ID:      ${file.id}`,
    `Filename:     ${file.name}`,
    `Type:         ${file.mimeType}`,
    `Size:         ${humanSize(file.size || contentBuffer.length)}`,
    folderId ? `Folder ID:    ${folderId}` : `Location:     My Drive (root)`,
    `View Link:    ${file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`}`,
    publicUrl ? `Public URL:   ${publicUrl}` : null,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
