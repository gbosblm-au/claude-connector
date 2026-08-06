# v12.37.0 - Document download links and scoped script environment injection

## Objective

After `script_execute` renders a document, the chat UI needs to show a working
link of the form:

```
https://<CONNECTOR_URL>/download/<Document_name>.<ext>?token=<DOCUMENT_DOWNLOAD_TOKEN>
```

Scripts run in a constructed, minimal environment (TNX-C-004), so neither value
is visible inside the sandbox, and the model had no way to obtain them.

## What was proposed, and why it changed

The original proposal was to publish `CONNECTOR_URL`, `DOCUMENT_DOWNLOAD_TOKEN`
and `DATABASE_URL` from a new internal endpoint, cache them in the session, and
pass them back into `script_execute` as `custom_env` so the model could build
the link string itself.

That works, and it puts a long-lived shared credential into a model context,
which means the conversation store, transcript exports and gateway request logs.
`DOCUMENT_DOWNLOAD_TOKEN` has no per-file scope, so one leaked transcript grants
read access to every document on the volume. The model is also the component
most exposed to untrusted input on this connector, since prompt content arrives
from fetched web pages and uploaded documents.

The connector already holds both halves and already serves `/download`. So it
builds the URL and returns the finished string. The credential stays inside the
process, and the model receives something it can render but cannot misuse.

### Defects in the proposed patch, corrected here

| Item | Problem | Resolution |
|---|---|---|
| `{ ...process.env, PYTHONUNBUFFERED: "1" }` | Reverses TNX-C-004. This exact line was removed from five modules in v12.28.0 because it handed every spawned script the connector's full credential set. A source-level test fails the build if the idiom reappears. | Not applied. The allowlisted `buildScriptEnv()` is retained. |
| `custom_env` with `additionalProperties: true` | Sandbox escape. `PYTHONSTARTUP`, `PYTHONPATH`, `LD_PRELOAD` or `PATH` set by the caller executes code of their choosing inside the sandbox. | Name allowlist plus an expanded `PROTECTED` set. |
| `config.railway?.restoreToken` | Does not exist. | `RAILWAY_RESTORE_TOKEN` with `constantTimeEquals()`. |
| `crypto.timingSafeEqual` | `server-http.js` imports named bindings only; the global `crypto` is WebCrypto and has no such method, so this throws a `TypeError` and returns 500. It also throws on a length mismatch, which is itself an oracle for the token length. | `constantTimeEquals()`, which hashes both operands to a fixed 32 bytes first. |
| Insertion "around line 1377" | The Express app is not constructed until ~1450 and the auth gate mounts at 1635. Routes registered before the gate fail `assertAllRoutesCovered()` at boot. | Registered after the health handlers. |
| Route not allowlisted | Any handler reading `x-railway-restore-token` must appear in `SELF_AUTHENTICATED_ROUTES`, or the MCP key gate rejects it. | Added as an `exact` entry. |
| `GET` route, `POST` protocol; `DOWNLOAD_TOKEN` vs `DOCUMENT_DOWNLOAD_TOKEN` | Would have presented as a silent 404 and a missing key. | Both methods registered; canonical variable names used. |
| Gateway changes | None were needed. `callConnectorTool` in `routes/ti-chat.js` passes `tool_input` through untouched, and `formatToolResult` returns successful results verbatim. | No gateway change. |

## Changes

### `src/utils/downloadLinks.js` (new)

Builds `/download` and `/preview` URLs server-side.

- Snapshots the downloads directory before execution and diffs afterwards, so
  any file a script creates or overwrites is linked without the script needing
  to report anything. Existing scripts on the volume work unmodified.
- `CONNECTOR_URL` normalisation: trailing slashes stripped, missing scheme
  upgraded to `https`, surrounding whitespace trimmed. Falls back to
  `RAILWAY_PUBLIC_DOMAIN`.
- Embeds `DOCUMENT_DOWNLOAD_TOKEN`, never `RAILWAY_RESTORE_TOKEN`. `/download`
  accepts either, but the restore token also authenticates `/tool-call` and
  every `/restore-*` route, so a link carrying it would escalate a shared URL
  into full connector control.
- Filename and token are percent-encoded. Declared names are validated with
  `isSafeFilename()` and `resolveContained()`.
- Capped at 25 links. Missing configuration produces a warning, never a broken
  link that fails only when clicked.

### `src/tools/script-execute.js`

- New optional input `download_files` (usually unnecessary; detection is
  automatic).
- New result fields `download_links` and `download_warnings`.
- New optional input `custom_env`, validated by `sanitizeCustomEnv()`: name
  allowlist (`CONNECTOR_URL`, `DATABASE_URL` by default, configurable via
  `SCRIPT_CUSTOM_ENV_KEYS`), `^[A-Z][A-Z0-9_]{0,63}$` name pattern, string-only
  values, NUL rejection, 4096-character value cap, 16-key cap. Rejections are
  returned in `custom_env_rejected` rather than dropped silently.
- `DOCUMENT_DOWNLOAD_TOKEN` is deliberately absent from the default allowlist.
- `buildScriptEnv()` gained an optional third argument. Existing two-argument
  call sites are unchanged.
- Link construction is wrapped so it can never fail an otherwise successful run.

### `src/utils/scriptEnv.js`

`PROTECTED` extended with `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`,
`PYTHONEXECUTABLE`, `PYTHONUSERBASE`, `LD_AUDIT`, `BASH_ENV`, `ENV`, `IFS`. The
original set covered the loader and Node vectors but not the Python ones. This
is the second, independent filter behind the tool-level allowlist. Operator
`PYTHONPATH` still propagates; only caller override is blocked.

### `src/utils/internalConfig.js` (new) and `src/server-http.js`

`GET|POST /internal/config/env`, authenticated with `X-Railway-Restore-Token`,
rate limited, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

Publishable names are filtered against a frozen in-code ceiling, so
`INTERNAL_CONFIG_KEYS=ANTHROPIC_API_KEY` publishes nothing. Default published
set is `CONNECTOR_URL` alone.

### `src/middleware/mcpAuth.js`

`/internal/config/env` added to `SELF_AUTHENTICATED_ROUTES` as an `exact` entry.
Not a prefix: a prefix would exempt every future `/internal/*` route from
authentication by default.

## Recommended configuration

```
CONNECTOR_URL=https://claude-connector-production.up.railway.app
DOCUMENT_DOWNLOAD_TOKEN=<generated>
```

For Postgres recall, prefer the server-side grant over `custom_env`:

```
SCRIPT_GRANTABLE_ENV=DATABASE_URL
SCRIPT_ENV_MANIFEST={"postgres_recall.py":["DATABASE_URL"]}
```

## Skill guidance

The session-start config fetch is no longer required for download links. The
skill should instead state: read `download_links[].download_url` from the
`script_execute` result and render it directly. Never construct a download URL
and never request the download token.

## Verification

- Existing security suite: 61/61 pass.
- New suite `src/tests/internal-config-custom-env.test.js`: 31/31 pass.
- Boot assertions pass: `Auth gate: ACTIVE | 43 routes verified | public: 13 |
  self-authenticated: 23`, no duplicate-route failure, no coverage failure.
- End-to-end with a real Python script: links built with trailing-slash
  normalisation and token encoding; `PYTHONSTARTUP`, `PATH` and a lower-case
  name refused; `DATABASE_URL` delivered while `ANTHROPIC_API_KEY` stayed
  absent; `../escape.docx` refused; `RAILWAY_RESTORE_TOKEN` and credential
  sentinels absent from the result payload.

## Known limitations

- The download token is long-lived and shared across all documents. A per-file
  signed URL with an expiry is the durable fix and is not in this release.
- `DOWNLOADS_BASE` in `server-http.js` and `downloadsBase()` in
  `downloadLinks.js` both default to `/data/downloads`. They are two constants
  that must agree.
- The endpoint was verified by direct handler invocation rather than over
  loopback HTTP, because cross-process loopback was unavailable in the build
  sandbox. A smoke test against the deployed service is recommended.
