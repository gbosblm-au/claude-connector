# Claude Connector v12.0.0 Deployment Instructions

## What is new in v12.0.0

Multi-tenant client gateway support. The connector now operates in two modes:

**Owner mode (default):** Your personal deployment. Behaviour is identical
to v11.5.0. No changes to Railway Variables required.

**Tenant mode:** A client's connector session. Every MCP request is validated
against the TrueSource Client Gateway WordPress plugin before any tool executes.
Client memory and skill files are namespaced by tenant ID. Modules are shared
from the owner pool.

---

## Owner Deployment (truesourceconsulting.com.au Railway instance)

### Upgrade steps

1. Deploy v12.0.0 to your existing Railway service.
2. No new Railway Variables required for owner mode.
3. Optional: set `TS_CLIENT_MODE=owner` explicitly, but this is the default.

### Verify

After deployment, the startup log should include:

```
[tenantAuth] MODE=owner | tenant gateway bypass active
```

Your sessions continue exactly as before.

---

## Provisioning a New Client

### Step 1: Create the tenant in WordPress

Go to **Client Gateway > Add Client** in your WordPress admin panel:

- Firm name: the firm's trading name
- Tenant ID: auto-generated slug (e.g. `smith-partners`). Cannot be changed.
- Tier: Foundation / Operational / Strategic

Click **Create Client and Generate API Key**.

The plugin displays:
- The plain API key (shown once, copy it now)
- The generated system prompt (copy this too)

### Step 2: Provision the client directory on Railway

SSH into your Railway volume or use the Railway CLI:

```bash
mkdir -p /data/clients/{tenant_id}
```

Copy the base client files (stripped of IFA content):

```bash
cp /data/skill/ava/CORE.md           /data/clients/{tenant_id}/CORE.md
cp /data/skill/ava/MANIFEST.json     /data/clients/{tenant_id}/MANIFEST.json
cp /data/skill/ava/DISPATCH_RULES.json /data/clients/{tenant_id}/DISPATCH_RULES.json
```

Create a minimal client PERSONALITY.md:

```bash
cat > /data/clients/{tenant_id}/PERSONALITY.md << 'EOF'
# Assistant Identity

## Status: first-session pending

No name established yet. The assistant will ask for a name on first session.

## Section A: Observed Texture

(No sessions recorded yet.)
EOF
```

Create an empty PROFILES.md:

```bash
cat > /data/clients/{tenant_id}/PROFILES.md << 'EOF'
# User Profiles

No profiles recorded yet. Profiles are built automatically from sessions.

---
EOF
```

### Step 3: Deliver the system prompt to the client

The client pastes the generated system prompt into their Claude.ai settings:

**Settings > Profile > User Preferences**

The prompt text is generated automatically by the WordPress plugin. It looks like:

```
At the start of each session, before responding to the first message,
please complete these steps in order:

1. Call ts_gateway_session_init with:
   - api_key: tscg_[their key]
   - tenant_id: [their tenant_id]
   - gateway_url: https://truesourceconsulting.com.au/wp-json/ts-gateway/v1
   This authenticates the session with TrueSource infrastructure and loads
   your operating context for this tenant.

2. If this is the first session (no name established yet):
   a. Greet the user warmly and introduce yourself as an AI assistant
      provided by TrueSource Consulting.
   b. Ask: "Before we get started, what would you like to call me? I can
      suggest a name if you prefer."
   c. If the user requests a suggestion, offer: Aria, Nova, or Lex.
      Confirm their choice.
   d. Write the chosen name to memory: category "identity", key "assistant_name".
   e. Acknowledge the name and begin the session naturally.

3. If a name is already established in memory, use it throughout the session
   without re-introducing it.

4. Operate under the loaded guidelines for the full session.
   [TrueSource Consulting | Tenant: {tenant_id}]
```

### Step 4: Add the CLIENT-SKILL-STUB.md to the client's Claude project

The client creates a Claude Project (or uses User Preferences) and adds
the `CLIENT-SKILL-STUB.md` file content as a project document. This tells
Claude how to connect to TrueSource infrastructure at session start.

Alternatively, the system prompt above alone is sufficient for basic sessions.
The skill stub provides richer routing and fallback behaviour.

---

## Suspending a Client

From **Client Gateway** in the WordPress admin panel:

- Click **Suspend** next to the client's row.
- Effect is immediate. Their next Claude session returns a 403 error.
- No action required on the client side.

To reactivate, click **Reactivate**.

---

## Rotating a Client API Key

From the Client Gateway dashboard, click **Rotate Key**.

- The old key is invalidated immediately.
- The new key and updated system prompt are displayed in a modal.
- Deliver the updated system prompt to the client.
- The client updates their Claude.ai User Preferences.

---

## Railway Variables for Tenant Connector (if running separate service)

If you deploy a separate Railway service for a client (optional architecture):

```
TS_CLIENT_MODE=tenant
TS_TENANT_GATEWAY_URL=https://truesourceconsulting.com.au/wp-json/ts-gateway/v1
TS_CLIENT_API_KEY=tscg_[the plain key generated for this tenant]
TS_TENANT_ID=smith-partners
SKILL_FILE_PATH=/data/skill/SKILL.md
SKILL_MODULAR_ENABLED=true
```

All memory and skill file reads will be routed to the tenant's namespace.
The shared module pool at `/data/skill/ava/modules/` is used for all clients.

---

## Client Claude Account Requirements

The client needs a Claude.ai **Pro** or **Team** account to connect MCP
servers. They connect the TrueSource connector URL under:

**Settings > Integrations > Add more**

URL: `https://[your-railway-domain].up.railway.app/mcp`

They do not need to know any technical details beyond this URL.

---

## File Layout Summary

```
/data/
  skill/
    ava/                        Your personal Ava files (unchanged)
      CORE.md
      PERSONALITY.md
      MANIFEST.json
      DISPATCH_RULES.json
      PROFILES.md
      modules/                  SHARED - all clients use this module pool
        aml-ctf/
        toolkit/
        erp/
        ...
  clients/
    smith-partners/             One directory per tenant
      CORE.md                   Copy of base CORE.md at provisioning
      PERSONALITY.md            Grows from sessions (name, observed texture)
      PROFILES.md               Firm staff profiles
      MANIFEST.json             Same as ava/ (shared content)
      DISPATCH_RULES.json       Tenant-specific dispatch additions
      archive/                  Session archives (optional)
```

Memory in MySQL:
  `wp_ts_ava_memory` with `tenant_id` column
  - Your rows: `tenant_id = 'brian'`
  - Client rows: `tenant_id = 'smith-partners'`

---

## Changelog

### v12.0.0 (2026-06-06)

- Added `src/middleware/tenantAuth.js` - gateway authentication middleware
- `getModularPaths()` in `skill-modular.js` now resolves to `/data/clients/{tenant_id}/`
  for personal files when `TS_CLIENT_MODE=tenant`. Module pool always from shared `ava/modules/`.
- `wp-memory.js` - tenant mode routes all memory calls through `ts-gateway/v1/memory/*`
  with `api_key` in POST body instead of `X-Ava-Memory-Key` header.
- `server-http.js` - `tenantAuthMiddleware` inserted on `/mcp` route.
- `config.js` - four new tenant config vars: `tsClientMode`, `tsTenantGatewayUrl`,
  `tsClientApiKey`, `tsTenantId`.
- New files: `CLIENT-SKILL-STUB.md`, `DEPLOYMENT_INSTRUCTIONS_v12.0.0.md`.
- Owner mode: zero breaking changes. All existing Railway Variables and behaviour
  unchanged.
