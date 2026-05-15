# Memory MCP - Setup Guide (Claude Connector v10.0.0)

The integrated Memory MCP is enabled by default whenever `MEMORY_AUTH_TOKEN` is set on the running connector. This guide walks through Railway deployment, environment variables, and the Claude.ai connector configuration end-to-end.

## 1. What the integration adds

When enabled, the connector advertises six additional tools alongside its existing surface area:

| Tool | Purpose |
| --- | --- |
| `memory_write` | Create or update an entry. Upsert by `(category, key)`. |
| `memory_read` | Filter by category, key, or tags. |
| `memory_search` | Full-text search ranked by BM25. |
| `memory_delete` | Hard delete by `(category, key)`. |
| `memory_list` | Summary list with per-category counts. |
| `memory_get_session_context` | Curated session bundle for skill preambles. |

Storage is SQLite (`/data/memory.db`) with FTS5 in WAL mode. Behaviour mirrors the standalone TrueSource Memory MCP package byte-for-byte: same Zod schemas, same upsert semantics, same response envelopes, same TTL expiry worker.

## 2. Prerequisites

* An existing or new Railway service running this connector image.
* Node 20 LTS (the image already targets this; `package.json` engines field reflects it).
* A persistent volume mounted at `/data`. `railway.toml` in this repository declares the volume automatically; if you are migrating an existing Railway service, ensure the volume is attached before redeploying.

## 3. Generate the auth token

The auth token is a single shared bearer secret for all `memory_*` calls. Generate one locally and store it as a Railway environment variable.

```bash
npm run gen-memory-token
# or:
node -e "console.log(require('crypto').randomBytes(36).toString('hex'))"
```

Both commands print a 72-character hex string (36 bytes of entropy). Treat it like a password: copy it once, paste it into Railway, then discard the local copy.

## 4. Configure Railway

### 4.1 Attach the persistent volume

1. Service Settings → **Volumes → New Volume**.
2. Name: `claude-connector-data` (matches `railway.toml`).
3. Mount path: `/data`.
4. Size: 1 GB is more than sufficient for the projected ~1-2 MB/year growth.
5. Save and let Railway redeploy.

### 4.2 Set environment variables

Service Settings → **Variables → New Variable**. Add the following entries (existing variables for email, search, Drive, etc. are unaffected):

| Variable | Value | Notes |
| --- | --- | --- |
| `MEMORY_AUTH_TOKEN` | Paste your generated token | Required. Without it, memory tools are not advertised. |
| `MEMORY_DB_PATH` | `/data/memory.db` | Optional. Default is `/data/memory.db`. |
| `TTL_WORKER_INTERVAL_MS` | `3600000` | Optional. Default is one hour. |
| `NODE_ENV` | `production` | Recommended for any production deploy. |

Click **Deploy** so the new variables take effect.

### 4.3 Verify the deployment

```bash
HOST=<your-railway-domain>           # e.g. claude-connector-production.up.railway.app
TOKEN=<your-MEMORY_AUTH_TOKEN>

# Public health check - should report memory.enabled=true and an entry_count.
curl -s https://$HOST/health | jq '.version, .memory'
# Expected:
#   "10.0.0"
#   { "enabled": true, "entry_count": 0, "by_category": {} }

# Authenticated admin export - should return total: 0 on a fresh deploy.
curl -s -H "Authorization: Bearer $TOKEN" https://$HOST/memory/admin/dump | jq '.total'
```

If both probes succeed, the integration is live.

## 5. Connect Claude.ai

The connector still exposes a single `/mcp` endpoint, so the Claude.ai side of the configuration is unchanged from earlier versions. There is **no separate connector to register for the memory tools** - they appear in the existing claude-connector tool list automatically.

If you are wiring claude-connector v10.0.0 to Claude.ai for the first time:

1. Claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `Claude Connector`.
3. URL: `https://<your-host>/mcp`.
4. Authentication: choose the auth mode required by your existing connector deployment (the existing /mcp endpoint runs without bearer auth by design - the memory tools enforce their own validation server-side via Zod and the bearer token applies only to `/memory/admin/dump`).
5. Save and toggle the connector on.

Ask Claude to list the available tools. You should see all v9.x tools plus the six `memory_*` tools.

## 6. First write - end-to-end check

In a Claude conversation:

> Call `memory_write` with category `facts`, key `installation_test`, and value `"v10 integration ok"`.

Claude returns a JSON success response with `operation: "created"`. Then:

> Call `memory_get_session_context`.

The response must now include `facts.installation_test = "v10 integration ok"`.

## 7. Skill integration (preamble pattern)

Existing memory-dependent skills work without modification. The standard preamble in each `SKILL.md`:

```markdown
## Memory Preamble

Before beginning this skill, call memory_get_session_context to load prior
session state. Apply the returned context as follows:

  - skills.[this_skill_state_key]:  Resume from last known state
  - projects.*:                     Use as current active project state
  - preferences.*:                  Apply as default configuration
  - facts.*:                        Use as ground-truth operational facts

## Memory Close Protocol

At the end of this session, call memory_write for each state item that
changed during this session, using:
  - category: skills or projects (as appropriate)
  - source_session: current date in YYYY-MM-DD format

Also write a session summary:
  - category: session
  - key: last_session_summary
  - ttl_days: 30
```

## 8. Backups

Until the Phase 3 nightly Drive export worker is built, take manual snapshots from any cron-capable host:

```bash
curl -s -H "Authorization: Bearer $MEMORY_AUTH_TOKEN" \
  https://$HOST/memory/admin/dump > "memory_backup_$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
```

A GitHub Actions scheduled workflow with `schedule: cron: '0 16 * * *'` (03:00 AEST) is a clean way to automate this.

## 9. Disabling the memory subsystem

Remove `MEMORY_AUTH_TOKEN` from Railway Variables and redeploy. The connector will log `[memory] MEMORY_AUTH_TOKEN not set` on boot, omit the six tools from `tools/list`, and return HTTP 404 for `/memory/admin/dump`. Existing data on the volume is preserved and reappears the moment the variable is restored.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Connector boots but memory tools missing from Claude | `MEMORY_AUTH_TOKEN` not set | Set the variable in Railway Variables and redeploy. |
| Memory writes succeed but vanish after redeploy | Persistent volume not attached | Attach a volume mounted at `/data` (see step 4.1). |
| `/memory/admin/dump` returns 401 | Token mismatch | Re-copy the token from Railway to your local shell variable. |
| `429` errors from Claude | Tight loop or test traffic | The memory tools inherit the connector's existing transport-level limits; investigate the calling pattern. |
| Tests fail locally with `better-sqlite3` build error | Missing native build toolchain | `npm install` rebuilds the binding; on Linux you may need `apt-get install -y build-essential python3`. |

## 11. Running the test suite

```bash
npm run test:memory
```

Executes 13 unit tests against an in-memory SQLite instance: upsert semantics, validation, FTS5, TTL expiry, and the category-cap logic of `memory_get_session_context`.
