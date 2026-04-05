# Using claude-connector with Browser-Based Claude (claude.ai)

## The Key Difference from Claude Desktop

Claude Desktop runs MCP servers as local processes on your machine using stdio (standard input/output).
Browser-based Claude is different in a critical way:

> **Claude.ai connects to MCP servers from Anthropic's cloud infrastructure, not from your local machine.**

This means your MCP server must be reachable over the **public internet** via HTTPS, even if you run it locally. The connection path looks like this:

```
claude.ai  -->  Anthropic's cloud  -->  YOUR PUBLIC HTTPS ENDPOINT  -->  claude-connector
```

The connector in this package includes a full HTTP server (`src/server-http.js`) that supports the Streamable HTTP transport protocol required by claude.ai.

---

## Requirements

- Node.js 18+ installed on your machine (or a cloud host)
- A Brave Search API key or Tavily API key (for web/news search)
- A way to expose the server publicly (see options below)
- A claude.ai account (Free, Pro, Max, Team, or Enterprise - all supported)

---

## Step 1: Configure Your Environment

If you haven't already, copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```env
SEARCH_PROVIDER=brave
BRAVE_API_KEY=your_brave_api_key_here

# STRONGLY RECOMMENDED - protects your server from unauthorised use:
MCP_API_KEY=choose_a_long_random_secret_string_here

# Required if you want to push your LinkedIn CSV to a remote server:
UPLOAD_API_KEY=choose_another_long_random_secret_here
```

**Generating a secure random key (run in terminal):**
```bash
# macOS / Linux:
openssl rand -hex 32

# Node.js (any platform):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Step 2: Choose Your Deployment Method

There are three ways to make the server publicly accessible. Choose based on your needs:

| Method | Best for | Cost | Stability | LinkedIn CSV |
|---|---|---|---|---|
| ngrok tunnel | Quick testing, daily use | Free tier | URL changes each restart (unless paid) | Local file works |
| Cloudflare Tunnel | Daily use, no bandwidth limits | Free | URL changes each restart (quick tunnel) | Local file works |
| Cloud hosting | Permanent, always-on | Free tiers available | Permanent URL | Must upload CSV |

---

## Option A: ngrok Tunnel (Recommended for Personal Use)

This runs the server on your machine and creates a secure public tunnel. Your LinkedIn CSV stays local.

### A1. Install ngrok

**macOS (Homebrew):**
```bash
brew install ngrok/ngrok/ngrok
```

**Windows (winget):**
```powershell
winget install ngrok
```

**Linux:**
```bash
# Download from https://ngrok.com/download and move to /usr/local/bin
# Or via snap: snap install ngrok
```

### A2. Create a free ngrok account and authenticate

1. Go to https://dashboard.ngrok.com/signup and create a free account
2. Copy your auth token from https://dashboard.ngrok.com/get-started/your-authtoken
3. Run:
   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN_HERE
   ```

### A3. Start the server with the tunnel

```bash
cd claude-connector
bash start-tunnel.sh
```

The script will:
1. Start the HTTP server on port 3000
2. Start an ngrok tunnel
3. Print your public MCP URL

You will see output like:
```
TUNNEL ACTIVE
  Your public MCP URL:
    https://abc123.ngrok-free.app/mcp

  Copy this URL and add it to Claude.ai:
    1. Go to https://claude.ai
    2. Click your profile icon > Settings
    3. Click 'Connectors' in the left sidebar
    4. Click 'Add custom connector'
    5. Paste: https://abc123.ngrok-free.app/mcp
```

### A4. Important notes about the free ngrok tier

- The public URL changes every time you restart the tunnel
- You must update the connector URL in Claude.ai settings each time (remove old, add new)
- The free tier gives you 1 agent, which is all you need
- For a stable URL, upgrade to ngrok's paid plan (~$10/month) which gives you a fixed domain

---

## Option B: Cloudflare Tunnel (Free Alternative to ngrok)

No account required for a quick tunnel. No bandwidth limits.

### B1. Install cloudflared

**macOS:**
```bash
brew install cloudflare/cloudflare/cloudflared
```

**Windows:**
```powershell
winget install --id Cloudflare.cloudflared
```

**Linux (Debian/Ubuntu):**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### B2. Start the server with tunnel

```bash
cd claude-connector
bash start-cloudflare-tunnel.sh
```

Watch the terminal output for a line like:
```
Your quick Tunnel has been created! Visit it at:
https://rough-darkness-xxxx.trycloudflare.com
```

Your MCP endpoint is: `https://rough-darkness-xxxx.trycloudflare.com/mcp`

### B3. Notes

- Like ngrok, the URL changes every restart
- For a permanent URL, sign up for a free Cloudflare account and create a named tunnel

---

## Option C: Cloud Hosting (Permanent URL)

Deploy once, use permanently from any device. No tunnel needed. LinkedIn CSV must be uploaded after deployment.

### Option C1: Railway (Easiest)

Railway is the simplest option. It has a free hobby tier ($5 credit/month).

**Steps:**

1. Create a free account at https://railway.app

2. Install the Railway CLI:
   ```bash
   # macOS/Linux:
   npm install -g @railway/cli
   # Windows: https://docs.railway.app/guides/cli
   ```

3. From the claude-connector directory:
   ```bash
   cd claude-connector
   railway login
   railway init
   railway up
   ```

4. Set environment variables in the Railway dashboard or via CLI:
   ```bash
   railway variables set BRAVE_API_KEY=your_key_here
   railway variables set MCP_API_KEY=your_long_random_secret
   railway variables set UPLOAD_API_KEY=another_long_random_secret
   railway variables set SEARCH_PROVIDER=brave
   railway variables set NEWS_PROVIDER=brave
   ```

5. Get your public URL:
   ```bash
   railway open
   ```
   It will look like: `https://claude-connector-production.up.railway.app`

6. Your MCP endpoint: `https://claude-connector-production.up.railway.app/mcp`

---

### Option C2: Render (Free Tier Available)

Render has a generous free tier (note: free services spin down after 15 minutes of inactivity, causing a cold start on first use).

**Steps:**

1. Create a free account at https://render.com

2. Click "New" > "Web Service"

3. Connect your GitHub repository (push this project to GitHub first), or use the "Deploy from existing repo" option

4. Configure:
   - **Name:** claude-connector
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server-http.js`
   - **Plan:** Free

5. Add environment variables in the Render dashboard:
   - `BRAVE_API_KEY` = your key
   - `MCP_API_KEY` = your secret
   - `UPLOAD_API_KEY` = your upload secret
   - `SEARCH_PROVIDER` = brave

6. Click "Create Web Service". Render will build and deploy automatically.

7. Your URL: `https://claude-connector.onrender.com`
   MCP endpoint: `https://claude-connector.onrender.com/mcp`

---

### Option C3: Fly.io

Good free tier with always-on instances.

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# From the claude-connector directory:
cd claude-connector
fly launch --name claude-connector --no-deploy

# Set secrets (environment variables):
fly secrets set BRAVE_API_KEY=your_key_here
fly secrets set MCP_API_KEY=your_long_random_secret
fly secrets set UPLOAD_API_KEY=another_secret
fly secrets set SEARCH_PROVIDER=brave

# Deploy:
fly deploy
```

Your URL: `https://claude-connector.fly.dev`
MCP endpoint: `https://claude-connector.fly.dev/mcp`

---

## Step 3: Upload Your LinkedIn Connections to a Remote Server

**If you are using a tunnel (Options A or B), skip this step.** Your connections.csv is read locally.

**If you deployed to Railway, Render, or Fly.io**, the server cannot access your local files. You need to push your LinkedIn CSV to it using the upload script:

```bash
bash upload-connections.sh https://your-server-url.railway.app YOUR_UPLOAD_API_KEY
```

Example:
```bash
bash upload-connections.sh \
  https://claude-connector-production.up.railway.app \
  mysupersecretuploadkey123 \
  ~/Downloads/Connections.csv
```

You only need to do this once, or whenever you want to refresh your connections data. The file is stored on the server's disk.

**Note for Render free tier:** The disk is ephemeral - your CSV will be lost when the service redeploys. Upgrade to a paid Render plan with a persistent disk, or re-upload after each deployment.

---

## Step 4: Add the Connector to Claude.ai

1. Open https://claude.ai in your browser
2. Click your **profile icon** in the top-right corner
3. Click **Settings**
4. Click **Connectors** in the left sidebar
5. Click **Add custom connector**
6. Paste your MCP endpoint URL (e.g. `https://abc123.ngrok-free.app/mcp`)
7. If you set `MCP_API_KEY`, Claude.ai will prompt you to authenticate - enter your key as a Bearer token
8. Click **Add**

The connector will appear in your list with a status indicator.

---

## Step 5: Use the Connector in Conversations

Enable the connector for a conversation by clicking the **+** button in the chat input area, then selecting **Connectors** and toggling your claude-connector on.

You can now ask Claude things like:

**Web Search:**
- "Search the web for the latest Reserve Bank of Australia interest rate decision"
- "Find news about AI regulation from the past 48 hours"
- "What are the most recent reviews of [product]?"

**News:**
- "What are today's top technology stories?"
- "Search for news about the ASX 200 from this week"
- "Find any recent news about [company name]"

**LinkedIn Connections:**
- "Load my LinkedIn connections then find everyone who works at Atlassian"
- "Who in my network is a venture capitalist or angel investor?"
- "Find connections who are CTOs or engineering leaders in Melbourne"
- "Search for connections at Big 4 consulting firms"
- "Show me connections I added in 2023 who work in fintech"
- "How many of my connections work in healthcare?"

**Combined workflows:**
- "Search the web for job openings at Canva, then check if any of my LinkedIn connections work there"
- "Find the latest news about [company], then see if I know anyone who works there"

---

## Keeping Your Connections Data Fresh

Your LinkedIn connections export is a snapshot. To update it:

1. Re-export from LinkedIn (Settings > Data Privacy > Get a copy of your data)
2. If using a tunnel: replace `data/connections.csv` and tell Claude "reload my LinkedIn connections"
3. If using cloud hosting: run `upload-connections.sh` again with the new file

---

## Security Recommendations

1. **Always set `MCP_API_KEY`** - This prevents anyone who finds your URL from using your server and consuming your API quota.

2. **Set `UPLOAD_API_KEY`** if deploying to cloud - This prevents unauthorised CSV uploads.

3. **Do not commit `.env` to git** - The `.gitignore` already excludes it, but double-check before pushing.

4. **The ngrok/Cloudflare tunnel URL is security-by-obscurity only** - The URL is long and random but technically guessable by a determined attacker. Always use `MCP_API_KEY`.

5. **Your LinkedIn CSV contains personal data** - Treat it with appropriate care. The file is excluded from Docker builds via `.dockerignore`.

---

## Troubleshooting

### "Connection refused" or connector shows as offline

- Check that the HTTP server is running: `curl http://localhost:3000/health`
- Check that the tunnel is running: visit your ngrok/cloudflare URL in a browser
- Verify the URL in Claude.ai settings does not have a trailing slash

### "Unauthorized" when adding connector

- Verify `MCP_API_KEY` is set correctly on the server
- If using ngrok/cloudflare, check that you're not sending the wrong key

### LinkedIn tools error "No connections loaded"

- You must call `linkedin_load_connections` first in your conversation
- Ask Claude: "Load my LinkedIn connections" before searching
- If on cloud hosting, verify the CSV was uploaded successfully

### Web search returns API errors

- Check your `BRAVE_API_KEY` or `TAVILY_API_KEY` is correct
- Check your quota at https://brave.com/search/api/ or https://app.tavily.com

### URL changes every time I restart (ngrok free tier)

- This is expected on the free tier
- Remove the old connector in Claude.ai and add the new URL each time
- Upgrade to ngrok's paid plan for a stable domain, or use a cloud host

### Server works locally but not from Claude.ai

- Claude.ai connects from Anthropic's cloud, so the server must be publicly reachable
- Check your firewall/router is not blocking the tunnel port
- If self-hosting, ensure port 443/80 is open and your SSL certificate is valid

---

## Environment Variables Quick Reference

| Variable | Required | Description |
|---|---|---|
| `BRAVE_API_KEY` | Yes (if using Brave) | From https://brave.com/search/api/ |
| `TAVILY_API_KEY` | Yes (if using Tavily) | From https://app.tavily.com |
| `SEARCH_PROVIDER` | No (default: brave) | `brave` or `tavily` |
| `NEWS_PROVIDER` | No (default: brave) | `brave` or `newsapi` |
| `NEWS_API_KEY` | Only with newsapi | From https://newsapi.org |
| `MCP_API_KEY` | Strongly recommended | Protects your server |
| `UPLOAD_API_KEY` | Recommended for cloud | Protects CSV upload endpoint |
| `PORT` | No (default: 3000) | HTTP server port |
| `HOST` | No (default: 0.0.0.0) | HTTP server bind address |
| `LINKEDIN_CSV_PATH` | No | Path to connections.csv |
| `LINKEDIN_PROFILE_PATH` | No | Path to profile.json |
