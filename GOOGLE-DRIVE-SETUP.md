# Google Drive Setup Guide

The claude-connector ships with a full Google Drive toolkit:

| MCP tool                              | Purpose                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| `google_drive_check_connection`       | Diagnostic: verify credentials + reachability            |
| `google_drive_search_files`           | Find files by name, full-text content or metadata        |
| `google_drive_read_file_content`      | Pull text of a file (auto-exports Google Docs/Sheets)    |
| `google_drive_download_file_content`  | Pull binary of a file (base64 and/or save to disk)       |
| `google_drive_create_file`            | Create OR overwrite a file (text or base64)              |
| `google_drive_get_file_metadata`      | Rich metadata (owners, MIME, links, capabilities)        |
| `google_drive_list_recent_files`      | Recently modified files                                  |
| `google_drive_get_file_permissions`   | Inspect who can read/edit a file                         |
| `google_drive_upload` (original)      | Upload a local file                                      |
| `google_drive_list`   (original)      | List files in a folder                                   |

All of these are registered on both the stdio transport (`src/index.js`) and the Streamable HTTP transport (`src/server-http.js`), so they are available in Claude Desktop and claude.ai custom connectors.

-----------------------------------------------------------------

## Choose an authentication method

You need **one** of the two options below. Both use OAuth 2.0 under the hood. The module generates and signs tokens directly with Node.js crypto, so no extra dependencies are required.

### Option A -- Service Account (recommended for servers)

Use this when running the connector on Railway, Render, a VPS, Docker or any headless environment.

1. Open the [Google Cloud Console](https://console.cloud.google.com/), pick or create a project.
2. **APIs & Services > Library**, enable **Google Drive API**.
3. **IAM & Admin > Service Accounts > Create service account**.
4. After creating it, go to **Keys > Add Key > Create new key > JSON**. Download the JSON file and store it on your server.
5. Note the service account email, it looks like
   `my-bot@my-project-123456.iam.gserviceaccount.com`.
6. In Google Drive (as your own user), right-click the folders or files you want the bot to access and **Share** them with that service account email. The service account only sees what is explicitly shared with it.
7. Set the environment variables:

   ```bash
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/absolute/path/to/keyfile.json
   # Optional:
   GOOGLE_DRIVE_FOLDER_ID=1AbCDeFg...          # default folder for uploads
   GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive
   ```

#### Google Workspace domain-wide delegation (optional)

If you are on Google Workspace and want the service account to act as a named user (so it can see all of that user's files), enable domain-wide delegation in the admin console, then add:

```bash
GOOGLE_IMPERSONATE_SUBJECT=alice@yourcompany.com
```

### Option B -- OAuth 2.0 Refresh Token (personal Google account)

Use this when running on your own machine with a personal `@gmail.com` account.

1. Google Cloud Console > **APIs & Services > OAuth consent screen**. Pick **External**, fill in basic info, add your Gmail address as a test user.
2. **APIs & Services > Credentials > Create Credentials > OAuth client ID**. Choose **Web application**. Add `https://developers.google.com/oauthplayground` as an authorised redirect URI.
3. Copy the **Client ID** and **Client Secret**.
4. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground). Click the gear icon, check **Use your own OAuth credentials**, paste the client id + secret.
5. In the left pane, scroll to **Drive API v3**, tick `https://www.googleapis.com/auth/drive` (or the narrower scope you want), click **Authorize APIs**, approve the consent screen.
6. Click **Exchange authorization code for tokens**. Copy the **refresh token**.
7. Set the environment variables:

   ```bash
   GOOGLE_CLIENT_ID=xxxxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxx
   GOOGLE_REFRESH_TOKEN=1//0gxxxxxxxxxxxxxxx
   # Optional:
   GOOGLE_DRIVE_FOLDER_ID=1AbCDeFg...
   GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive
   ```

-----------------------------------------------------------------

## Verify the connection

After setting the environment variables, restart the connector and call `google_drive_check_connection` from Claude. A healthy response looks like:

```
Google Drive Connection Check
=============================
Service account configured : yes
OAuth2 refresh configured  : no
Requested scopes           : https://www.googleapis.com/auth/drive
Auth method used           : service_account
Service account email      : my-bot@my-project-123456.iam.gserviceaccount.com
Access token acquired      : yes (length 164)

Drive account info:
  Principal  : My Bot <my-bot@...gserviceaccount.com>
  Quota used : 12 KB of 15.0 GB
  Default folder 'Claude Uploads' (1AbCDeFg...) is reachable.

Connection is functional. All Google Drive tools should work.
```

If it fails it will print the exact reason (invalid key file, 401 from Google, unshared folder etc.) so you can correct it.

-----------------------------------------------------------------

## Scope cheatsheet

The default scope is `https://www.googleapis.com/auth/drive` (full access). Override with `GOOGLE_DRIVE_SCOPES` if you want tighter control:

| Scope                                                  | What it allows                                             |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `https://www.googleapis.com/auth/drive`                | Full read + write + delete on every file the user can see  |
| `https://www.googleapis.com/auth/drive.readonly`       | Read-only (search / metadata / download work; writes fail) |
| `https://www.googleapis.com/auth/drive.file`           | Only files this app creates or has been granted via picker |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | Metadata only, no content                               |

> **Important for search-all-files use cases:** the narrower `drive.file` scope that the original connector used can only "see" files that this app itself created. The new `google_drive_search_files`, `google_drive_read_file_content`, `google_drive_list_recent_files` etc. need at least `drive.readonly` to discover pre-existing files.

-----------------------------------------------------------------

## Typical flows

### Find a document by content and read it

```
1. google_drive_search_files   { "full_text_contains": "Q3 forecast" }
2. google_drive_read_file_content { "file_id": "<id from step 1>" }
```

### Upload a fresh file, then make it public

```
google_drive_create_file {
  "filename": "meeting-notes.md",
  "folder_id": "1AbCDeFg...",
  "text_content": "# Monday sync\n\n...",
  "make_public": true
}
```

### Overwrite an existing file in place

```
google_drive_create_file {
  "file_id": "1XyzFileId...",
  "text_content": "# Monday sync (updated)\n\n..."
}
```

or, by filename:

```
google_drive_create_file {
  "filename": "meeting-notes.md",
  "folder_id": "1AbCDeFg...",
  "overwrite_by_name": true,
  "text_content": "# Monday sync (updated)\n\n..."
}
```

### Download a binary file to the server disk

```
google_drive_download_file_content {
  "file_id": "1XyzFileId...",
  "save_path": "/srv/app/cache/attachment.pdf",
  "include_base64": false
}
```

### Audit who can see a file

```
google_drive_get_file_permissions { "file_id": "1XyzFileId..." }
```

-----------------------------------------------------------------

## Troubleshooting

| Symptom                                                | Fix                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `Google Drive is not configured`                       | No credentials loaded. Set the env vars listed above and restart.                           |
| `401 Invalid Credentials`                              | Service-account key revoked, or refresh token expired. Regenerate.                          |
| `403 insufficientFilePermissions` / `File not found`   | Service account has not been shared on that file / folder. Share it from the Drive UI.      |
| `403 Request had insufficient authentication scopes`   | Your `GOOGLE_DRIVE_SCOPES` is too narrow for the operation. Use `.../auth/drive`.           |
| `storageQuotaExceeded`                                 | Service accounts have zero personal quota. Upload into a folder owned by a real user, or a Shared Drive where the SA is a member. |
| Search returns empty for files you can see manually    | You are likely on the `drive.file` scope. Upgrade scope and regenerate the refresh token.   |
