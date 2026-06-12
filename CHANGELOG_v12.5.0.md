# Claude Connector v12.6.0 - Peer Review Category Fix

## Release date: 2026-06-12

### Bug fixes

#### src/tools-memory/schemas/index.js

Added three peer review categories to `CATEGORY_ENUM`:
- `peer_review_registry` - client registry entries for the peer review system
- `peer_review_logs` - check-in result records per client per date
- `peer_review_escalations` - escalation queue for amber/red signals

Without these entries, any `memory_write` call with these categories failed Zod
validation, silently blocking the peer review workflow. The `client_registry_update`
tool returns memory_write instructions using `peer_review_registry`, and
`client_checkin` uses `peer_review_logs` and `peer_review_escalations`. All three
were unreachable from the memory system.

#### src/middleware/tenantAuth.js

Removed a trailing backslash on line 159 in `logTenantModeStatus()` that caused a
`SyntaxError: Invalid or unexpected token` at module load time. This crashed the
server before it could start listening, causing all Railway healthchecks to fail.

#### src/tools-memory/definitions.js

Updated all five tool definition `enum` arrays
(`memory_write`, `memory_read`, `memory_search`, `memory_delete`, `memory_list`)
to include the three new categories. This ensures Claude sees the valid category
list in the tool schema and can use them without a validation mismatch.

---

# Claude Connector v12.5.0 - Peer Review System

## Release date: 2026-06-12

---

### Overview

Adds the Peer Review system: a fortnightly check-in mechanism where Brian's Ava
reads health logs from client Ava deployments, runs a structured peer exchange via
the Anthropic API, and surfaces only what warrants attention.

Client Ava writes a brief health log at session close. Brian's Ava reads those logs,
runs an honest AI assessment, and escalates to Brian only on amber or red signals.

---

### New files

#### src/tools/healthLog.js (tenant mode only)

Three new MCP tools available only when TS_CLIENT_MODE=tenant:

**health_log_write**
- Called by client Ava at session close (after memory_write in session close sequence)
- Parameters: signal (green/amber/red), summary (max 500 chars), issues[] (optional)
- POSTs to {TS_TENANT_GATEWAY_URL}/health/log with TS_CLIENT_API_KEY
- Gateway upserts one record per day: worst signal wins, issues append, session_count increments
- Non-blocking on error: logs warning, returns gracefully so session close continues

**issue_flag**
- Called mid-session when a persistent or unresolved issue emerges
- Parameters: severity (low/medium/high), topic (max 100 chars), description (max 500 chars)
- POSTs to {TS_TENANT_GATEWAY_URL}/health/flag-issue
- Creates today's health log if none exists yet

**peer_review_consent_set**
- Called at first session after the onboarding consent dialogue
- Parameters: consent (boolean)
- POSTs to {TS_TENANT_GATEWAY_URL}/health/consent
- Once consent=true, Brian's connector can read this tenant's health logs

#### src/tools/clientCheckin.js (owner mode only)

Three new MCP tools available only when TS_CLIENT_MODE=owner (default):

**client_registry_update**
- Manages the peer review client registry stored in Brian's memory
- Parameters: action (add/update/remove), tenant_id, client_name, gateway_url, peer_review_key, notes
- Returns memory_write instructions for Ava to execute (does not write directly)
- Registry stored in memory: category=peer_review_registry, key=client_{tenant_id}

**client_checkin**
- Runs a full peer review check-in for one client
- Parameters: client_name, gateway_url, tenant_id, peer_review_key
- Fetches GET {gateway_url}/health/peer-review/{tenant_id} with X-Peer-Review-Key header
- Calls Anthropic API (ANTHROPIC_API_KEY, model=PEER_REVIEW_MODEL) for peer exchange
- Parses SIGNAL / SUMMARY / ESCALATE / ESCALATION_REASON from AI response
- Returns result with memory_write instructions for Ava to log and escalate
- If no consent or no data: returns early with explanation (no AI call)

**escalation_queue_read**
- Returns instructions to read pending escalations from memory
- Parameters: clear_after_read (boolean, default false)
- Memory location: category=peer_review_escalations, key=queue

---

### config.js changes

Added two new config values (read from Railway env vars):

- `anthropicApiKey`: ANTHROPIC_API_KEY - Required in owner-mode for client_checkin
- `peerReviewModel`: PEER_REVIEW_MODEL - Default: claude-haiku-4-5-20251001

---

### server-http.js changes

- Imports for healthLog.js and clientCheckin.js
- TOOLS array: tenant mode gets health_log_write, issue_flag, peer_review_consent_set
- TOOLS array: owner mode gets client_registry_update, client_checkin, escalation_queue_read
- Switch cases for all six new tool names
- MCP server version string updated to 12.5.0

---

### Deployment notes

**Client connector (tenant mode) - no new env vars required.**
Health log tools automatically use existing TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY.

**Owner connector (Brian's) - one new env var required:**
- ANTHROPIC_API_KEY: Get from console.anthropic.com. Used only for client_checkin AI call.
- PEER_REVIEW_MODEL (optional): Override model. Default: claude-haiku-4-5-20251001.

**Gateway must be updated to v1.4.0 before deploying connectors.**
The health_log_write, issue_flag, and peer_review_consent_set tools call new gateway
endpoints that do not exist in v1.3.1. Deploy gateway first.

**Session close protocol (add to client Ava CORE.md):**
Add health_log_write to the session close sequence, after memory_write:
  1. Write memory_write (conversation summary, preferences, etc.)
  2. Call health_log_write with signal, summary, and any issues

**Peer review key setup:**
1. Call POST /admin/peer-review/{tenant_id}/generate-key on the gateway
2. Copy the plain_key (shown once only)
3. In Brian's connector: call client_registry_update (action=add) with the key
4. Follow the returned memory_write instruction to store the registry entry

---

### Privacy design

Brian reads: structured signal (green/amber/red), session summaries (max 500 chars), flagged issues.
Brian does NOT read: conversation content, client data, preferences, anything personal.
Client knows: told at first session that a brief operational log is kept and reviewed.
Client controls: can revoke consent at any time via peer_review_consent_set(consent=false).
