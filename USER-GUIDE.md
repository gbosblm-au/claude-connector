# Claude Connector — User Guide
## Version 4.0.0

---

## What Is Claude Connector?

Claude Connector is a self-hosted MCP (Model Context Protocol) server that runs on Railway and gives your Claude conversations superpowers: live web search, news search, LinkedIn profile access, and full WordPress publishing — all without leaving the Claude chat interface.

Version 4.0.0 introduces **runtime credential management**. You can now connect your WordPress site and LinkedIn app directly from the Claude chat window, without ever logging into Railway or editing environment variables.

---

## Table of Contents

1. [What's New in v4.0.0](#whats-new-in-v400)
2. [Initial Deployment (Railway)](#initial-deployment-railway)
3. [Connecting Claude to the Connector](#connecting-claude-to-the-connector)
4. [Setting WordPress Credentials from Claude](#setting-wordpress-credentials-from-claude)
5. [Setting LinkedIn Credentials from Claude](#setting-linkedin-credentials-from-claude)
6. [Publishing Articles to WordPress](#publishing-articles-to-wordpress)
7. [Creating Pages with Menu Items](#creating-pages-with-menu-items)
8. [The TrueSource Article Writer Skill](#the-truesource-article-writer-skill)
9. [All Available Tools](#all-available-tools)
10. [Credential Persistence](#credential-persistence)
11. [Updating from v3 to v4](#updating-from-v3-to-v4)
12. [Troubleshooting](#troubleshooting)

---

## What's New in v4.0.0

### Runtime Credential Management

Previously, WordPress and LinkedIn credentials had to be set as Railway environment variables, which required:
- Logging into the Railway dashboard
- Adding or editing variables
- Waiting for a redeploy

In v4.0.0, you can set credentials directly from the Claude chat window using new MCP tools. No dashboard access required after initial deployment.

**New credential tools:**

| Tool | What it does |
|---|---|
| `set_wordpress_credentials` | Stores your WordPress site URL, username, and Application Password |
| `get_wordpress_credentials` | Shows connection status (passwords never displayed) |
| `clear_wordpress_credentials` | Removes stored credentials |
| `set_linkedin_credentials` | Stores your LinkedIn OAuth Client ID and Secret |
| `get_linkedin_credentials` | Shows LinkedIn OAuth config status |
| `clear_linkedin_credentials` | Removes stored LinkedIn credentials |

### Automatic WordPress Publish Prompt

The TrueSource Article Writer skill now automatically asks after every article whether you want to:
- Publish it as a WordPress blog post
- Create it as a standalone page with a menu item
- Keep it in the chat only

The skill handles all steps — credential check, category selection, publish vs draft, menu assignment — through natural conversation.

### Credential Priority

The server always checks in this order:
1. Runtime credentials stored via the new MCP tools (highest priority)
2. Railway environment variables (fallback)

This means your Railway variables act as a baseline, and you can override them at any time from Claude without redeploying.

---

## Initial Deployment (Railway)

If you are deploying Claude Connector for the first time:

### Step 1 — Create a Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub.

### Step 2 — Deploy from the ZIP

1. Extract the `claude-connector-v4.zip` file.
2. In Railway dashboard, click **New Project > Deploy from GitHub repo**, or use **New Project > Empty Project** then connect via the Railway CLI.
3. Alternatively, push the extracted folder to a new GitHub repo and deploy that.

### Step 3 — Set Required Environment Variables

Only search API credentials need to be in Railway. WordPress and LinkedIn can now be set from Claude.

**Required (at least one search provider):**

| Variable | Value | Where to get it |
|---|---|---|
| `SEARCH_PROVIDER` | `brave` or `tavily` | Your choice |
| `BRAVE_API_KEY` | Your Brave Search API key | [api.search.brave.com](https://api.search.brave.com) |
| `TAVILY_API_KEY` | Your Tavily API key | [app.tavily.com](https://app.tavily.com) |

**Optional (can be set from Claude instead — see sections below):**

| Variable | Notes |
|---|---|
| `WP_URL` | Your WordPress site URL — can be set from Claude |
| `WP_USERNAME` | Your WordPress username — can be set from Claude |
| `WP_APP_PASSWORD` | WordPress Application Password — can be set from Claude |
| `LINKEDIN_CLIENT_ID` | LinkedIn OAuth Client ID — can be set from Claude |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn OAuth Client Secret — can be set from Claude |
| `LINKEDIN_REDIRECT_URI` | Auto-detected from Railway domain if not set |

**Optional (upload protection):**

| Variable | Notes |
|---|---|
| `UPLOAD_API_KEY` | Any string. Protects the /upload/connections CSV endpoint. |

### Step 4 — Add a Persistent Volume (Recommended)

To make runtime credentials survive redeployments:

1. In Railway, go to your service settings.
2. Under **Volumes**, add a volume mounted at `/app/data`.
3. This makes the `credentials.json` file persist across deploys.

Without a volume, credentials survive the current container session but are cleared on redeploy. You would need to re-enter them from Claude after each deploy.

### Step 5 — Note Your Public URL

Once deployed, Railway gives you a public URL like:
`https://claude-connector-production.up.railway.app`

Your MCP endpoint is: `https://[your-url]/mcp`

---

## Connecting Claude to the Connector

1. In Claude.ai, go to **Settings > Connectors** (or use the connector icon in the chat sidebar).
2. Click **Add custom connector** (or **Add MCP server**).
3. Enter your connector URL: `https://[your-railway-url]/mcp`
4. Save. Claude will connect automatically.

To verify the connection, type in Claude:

> Call `get_wordpress_credentials` to check the connector status.

If you see a credentials status response (even "not configured"), the connector is working.

---

## Setting WordPress Credentials from Claude

You only need to do this once. Credentials are stored on the server and remembered.

### What You Need First

An **Application Password** from your WordPress site:

1. Log into your WordPress Admin (`/wp-admin`).
2. Go to **Users > Your Profile**.
3. Scroll down to **Application Passwords**.
4. In the "New Application Password Name" field, type `Claude Connector`.
5. Click **Add New Application Password**.
6. Copy the generated password immediately — it is only shown once.
   It will look like: `AbCd EfGh IjKl MnOp QrSt UvWx`

### Setting the Credentials

In Claude, say:

> "Set my WordPress credentials. The site is https://yoursite.com, username is yourusername, and the application password is AbCd EfGh IjKl MnOp QrSt UvWx"

Claude will call `set_wordpress_credentials` and confirm when stored.

Or you can ask Claude to prompt you:

> "I want to connect my WordPress site"

Claude will ask for each piece of information in turn.

### Verifying the Connection

After setting credentials, ask Claude:

> "Test my WordPress connection"

Claude will call `wordpress_site_info` and return your site title, URL, and available post types. If this returns successfully, publishing is ready.

### Switching to a Different WordPress Site

> "Clear my WordPress credentials and set up a new site"

Claude will call `clear_wordpress_credentials` then walk you through setting new ones.

---

## Setting LinkedIn Credentials from Claude

LinkedIn OAuth allows Claude to fetch your live LinkedIn profile. Connections are still accessed via CSV export (LinkedIn does not provide API access to connection lists without Partner Program status).

### Step 1 — Create a LinkedIn Developer App

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps).
2. Click **Create App**.
3. Fill in app name (e.g. "Claude Connector"), company, and a logo.
4. Under the **Auth** tab, add an Authorized Redirect URL:
   `https://[your-railway-url]/auth/linkedin/callback`
5. Save the app.
6. From the **Auth** tab, copy your **Client ID** and **Client Secret**.

### Step 2 — Set Credentials from Claude

> "Set my LinkedIn credentials. Client ID is [your-id] and client secret is [your-secret]"

Claude will call `set_linkedin_credentials` and confirm.

### Step 3 — Authorize Your LinkedIn Account

> "Start LinkedIn OAuth authorization"

Claude will call `linkedin_start_oauth` and give you a URL to open in your browser. After you log in and approve, the token is stored on the connector server. Call `linkedin_oauth_status` to confirm.

---

## Publishing Articles to WordPress

After the TrueSource Article Writer delivers an article, it automatically asks:

> "Would you like to publish this to your WordPress site?"

With three options:
- **Publish as a Blog Post**
- **Create as a Page + Menu Item**
- **Keep it here**

### Publishing as a Post

If you choose "Publish as a Blog Post":

1. Claude checks your WordPress connection.
2. Claude lists your categories and asks which to assign (optional).
3. Claude asks: "Publish immediately or save as draft?"
4. The post is created and Claude returns the live URL.

You can also trigger this manually at any time:

> "Publish the last article to WordPress as a post"

### Post HTML Formatting

Claude automatically formats the article as clean HTML when publishing:
- Paragraphs become `<p>` tags
- The article title is used as the post title
- The first two sentences become the excerpt

---

## Creating Pages with Menu Items

If you choose "Create as a Page + Menu Item":

1. Claude confirms the page title (defaults to article title).
2. Claude asks: "Publish immediately or save as draft?"
3. If published: Claude lists your navigation menus and asks which one to add a link to.
4. Claude asks for the menu label and whether it should be top-level or nested.
5. The page and menu item are created in one workflow.

### Creating a Page Manually

> "Create a WordPress page from the last article, published, and add it to the main navigation menu as a top-level item labelled 'Resources'"

Claude will handle all the tool calls automatically.

---

## The TrueSource Article Writer Skill

The TrueSource Article Writer is a separate skill file (`SKILL.md`) that works alongside Claude Connector. It:

1. Researches your topic using live web search via the connector.
2. Writes an original article in a randomised voice and structure (52 combinations).
3. Optionally sources a photorealistic image.
4. Delivers the article in the chat.
5. Always prompts for WordPress publishing after delivery.

### Trigger Phrases

- "Write an article about [topic]"
- "Article topic: [topic], with image"
- "Draft a post on [topic]"
- "Write an opinion piece about [topic]"
- "[Any business topic as freetext]"

### Parameters

| Parameter | Options | Default |
|---|---|---|
| Length | "600 words", "800 words", etc. | 600 words |
| Voice | "personal", "we/collective", "opinion", "implied" | Random |
| Structure | "myth-busting", "narrative", "contrarian", "PAS", etc. | Random |
| Image | "with image", "add an image", "+ image" | No image |

---

## All Available Tools

### Credential Management (New in v4.0.0)

| Tool | Description |
|---|---|
| `set_wordpress_credentials` | Store WordPress site URL, username, and Application Password |
| `get_wordpress_credentials` | Show current WordPress connection status |
| `clear_wordpress_credentials` | Remove stored WordPress credentials |
| `set_linkedin_credentials` | Store LinkedIn OAuth Client ID and Secret |
| `get_linkedin_credentials` | Show current LinkedIn OAuth status |
| `clear_linkedin_credentials` | Remove stored LinkedIn credentials |

### Web & News Search

| Tool | Description |
|---|---|
| `web_search` | Live web search via Brave or Tavily |
| `news_search` | News article search with date filtering |

### LinkedIn

| Tool | Description |
|---|---|
| `linkedin_load_connections` | Load connections from an uploaded CSV |
| `linkedin_search_connections` | Search loaded connections |
| `linkedin_connection_count` | Count loaded connections |
| `linkedin_get_profile` | Get stored local profile |
| `linkedin_start_oauth` | Generate LinkedIn OAuth authorization URL |
| `linkedin_oauth_status` | Check LinkedIn token status |
| `linkedin_oauth_logout` | Clear LinkedIn token |
| `linkedin_get_live_profile` | Fetch live profile via OAuth |

### WordPress

| Tool | Description |
|---|---|
| `wordpress_site_info` | Test connection, return site details |
| `wordpress_list_posts` | List recent posts |
| `wordpress_list_pages` | List all pages |
| `wordpress_list_categories` | List all categories with IDs |
| `wordpress_list_tags` | List all tags with IDs |
| `wordpress_list_menus` | List all navigation menus |
| `wordpress_list_menu_items` | List items in a specific menu |
| `wordpress_create_post` | Create a blog post (draft or publish) |
| `wordpress_create_page` | Create a page (draft or publish) |
| `wordpress_add_menu_item` | Add a page/post/URL to a navigation menu |
| `wordpress_update_content` | Update an existing post or page by ID |

### Utility

| Tool | Description |
|---|---|
| `get_current_datetime` | Returns current UTC date and time |

---

## Credential Persistence

### Without a Railway Volume

Credentials are stored in `./data/credentials.json` inside the running container. They survive process restarts within the same deployment but are cleared when Railway redeploys the container (e.g. after a code push or environment variable change).

After a redeploy, simply tell Claude your credentials again. The conversation takes about 30 seconds.

### With a Railway Volume (Recommended)

1. In Railway, go to your service.
2. Click **Settings > Volumes > Add Volume**.
3. Set mount path to `/app/data`.
4. Save and redeploy.

With a volume, `credentials.json` is stored on persistent disk and survives all redeployments. You set your credentials once and they remain indefinitely.

### Credential Priority

The server always resolves credentials in this order:

```
Runtime store (set_wordpress_credentials) → Railway env vars → Not configured
```

If both are set, the runtime store wins. This means you can override Railway env vars at any time from Claude without changing them in the dashboard.

---

## Updating from v3 to v4

### What Changed

| Area | v3 | v4 |
|---|---|---|
| WordPress credentials | Railway env vars only | Can be set from Claude or Railway |
| LinkedIn OAuth credentials | Railway env vars only | Can be set from Claude or Railway |
| Article writer publish prompt | Not present | Automatic after every article |
| Server version | 3.0.0 | 4.0.0 |
| New files | — | `src/utils/credentialStore.js`, `src/tools/credentials.js` |

### Update Steps

**Option A — Replace files only (fastest, keeps your Railway config):**

1. In your GitHub repo for the connector, replace these files with the v4 versions:
   - `src/server-http.js`
   - `src/tools/wordpress.js`
   - `src/tools/linkedinOAuth.js`
   - `src/tools/credentials.js` (new file — add it)
   - `src/utils/credentialStore.js` (new file — add it)
   - `package.json` (version bump only)
2. Push to GitHub. Railway auto-redeploys.
3. Your existing Railway environment variables continue to work as fallback credentials.

**Option B — Full redeploy from zip:**

1. Extract `claude-connector-v4.zip`.
2. Push all files to your GitHub repo (overwrite everything).
3. Railway redeploys automatically.
4. If you had WordPress and LinkedIn env vars set, they still work.
5. Optionally add a Railway Volume at `/app/data` for credential persistence.

### Skill File Update

Replace your `SKILL.md` file in the skills directory with the updated version from the zip. The updated skill adds Step 9 (the WordPress publish prompt) while leaving all existing article writing behaviour unchanged.

To update the skill file on Claude.ai:
1. Go to **Settings > Skills** (or wherever your skills are managed).
2. Find the `truesource-article-writer` skill.
3. Replace the `SKILL.md` content with the updated file.

---

## Troubleshooting

### "WordPress is not configured"

Claude Connector cannot find WordPress credentials from either the runtime store or Railway env vars.

Fix: Tell Claude — "Set my WordPress credentials" — and provide your site URL, username, and Application Password.

### "WordPress API error: 401 Unauthorized"

The credentials were accepted but WordPress rejected them. Usually means the Application Password was entered incorrectly or has been revoked.

Fix:
1. In WordPress Admin > Users > Your Profile > Application Passwords, revoke the old one.
2. Create a new Application Password named "Claude Connector".
3. Tell Claude — "Clear my WordPress credentials and set new ones".

### "WordPress API error: rest_no_route"

The WordPress REST API is disabled or blocked on your site.

Fix: Some security plugins (Wordfence, iThemes Security) block the REST API. Check your security plugin settings and whitelist `/wp-json/`.

### LinkedIn OAuth Callback Error

If the LinkedIn OAuth browser window shows an error:

1. Check that the Redirect URI in your LinkedIn Developer App exactly matches `https://[your-railway-url]/auth/linkedin/callback`.
2. Check that `set_linkedin_credentials` was called with the correct Client ID and Secret.
3. Call `linkedin_start_oauth` again to get a fresh authorization URL (they expire after 10 minutes).

### Credentials Lost After Redeploy

Without a Railway Volume, credentials are stored in-container memory and are cleared on redeploy. Add a Volume at `/app/data` to persist them, or simply re-enter them from Claude after each deploy.

### Connector Not Responding in Claude

1. Check your Railway service is running (Railway dashboard > Deployments).
2. Open `https://[your-railway-url]/health` in a browser — it should return `{"status":"ok"}`.
3. In Claude settings, remove and re-add the connector URL.
4. Ensure the URL ends in `/mcp` (not just the base URL).

### Version Confirmation

To confirm you are running v4.0.0, ask Claude:

> "What version of the connector is running?"

Claude will call `wordpress_site_info` or `get_wordpress_credentials`, and the response will be generated by the v4.0.0 server. You can also check `https://[your-url]/health` which returns the server version.

---

## Quick Reference Card

### First-time WordPress Setup
```
1. WordPress Admin > Users > Your Profile > Application Passwords
2. Create password named "Claude Connector", copy it
3. Tell Claude: "Set my WordPress credentials"
   - Site URL: https://yoursite.com
   - Username: your-wp-username
   - Password: [the Application Password you copied]
4. Ask Claude: "Test my WordPress connection"
```

### First-time LinkedIn Setup
```
1. linkedin.com/developers/apps > Create App
2. Auth tab > Add Redirect URL: https://[railway-url]/auth/linkedin/callback
3. Copy Client ID and Client Secret
4. Tell Claude: "Set my LinkedIn credentials"
   - Client ID: [your client id]
   - Client Secret: [your client secret]
5. Tell Claude: "Start LinkedIn OAuth"
6. Open the URL in your browser and approve
```

### Publish an Article
```
1. Ask Claude to write an article on any business topic
2. After delivery, choose "Publish as Blog Post" or "Create as Page + Menu Item"
3. Follow Claude's prompts for category, status, and menu placement
```

### Switch WordPress Sites
```
Tell Claude: "Clear my WordPress credentials and connect a new site"
```

---

*Claude Connector v4.0.0 — built for claude.ai*
