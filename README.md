# claude-connector

A fully functional **MCP (Model Context Protocol) server** that gives Claude real-time capabilities, similar to TinyFish:

| Tool | What it does |
|---|---|
| `web_search` | Real-time web search via Brave Search or Tavily |
| `news_search` | Real-time news articles via Brave News or NewsAPI |
| `linkedin_load_connections` | Loads your LinkedIn connections CSV export |
| `linkedin_search_connections` | Searches connections by name, company, position, date, etc. |
| `linkedin_connection_count` | Summary statistics of your loaded connections |
| `linkedin_get_profile` | Returns your own LinkedIn profile data |
| `google_drive_check_connection` | Verifies Google Drive credentials, scopes, quota, and reachability |
| `google_drive_search_files` | Searches Drive by name, content, or metadata |
| `google_drive_read_file_content` | Reads text content from Drive files and Google Docs exports |
| `google_drive_download_file_content` | Downloads binary content from Drive files |
| `google_drive_create_file` | Creates new files or overwrites existing files in Drive |
| `google_drive_get_file_metadata` | Returns rich file metadata |
| `google_drive_list_recent_files` | Lists recently modified Drive files |
| `google_drive_get_file_permissions` | Returns Drive sharing and permission details |
| `google_drive_upload` | Uploads local files to Google Drive |
| `google_drive_list` | Lists files in a Drive folder |
| `get_current_datetime` | Returns the current UTC date/time |

---


## What's New in v6.1.0

- **Full Google Drive toolkit** with search, read, binary download, create, overwrite, metadata, recent files, permissions, upload, and list support.
- **Bundled Google service account support**. If `./data/google-service-account.json` exists, the connector auto-loads it without needing an environment variable.
- **Config path fix** for default LinkedIn data files, preventing broken relative paths when `LINKEDIN_CSV_PATH` or `LINKEDIN_PROFILE_PATH` are not set.
- **Backward compatible**. Existing Google Drive upload/list, WordPress, LinkedIn, search, and publishing functionality remain intact.

See `GOOGLE-DRIVE-SETUP.md` for the Drive setup and usage guide.

## What's New in v5.0.0

- **`wordpress_set_seo_meta`** — Sets Yoast SEO and RankMath meta title and description on any page or post directly from Claude. Validates character length and provides feedback.
- **`wordpress_create_service_page`** — Creates a fully structured, brand-consistent TrueSource service page with hero, intro section, outcomes list, capabilities grid, FAQs, and CTA. Output is Elementor-compatible HTML. Accepts `custom_css_overrides` for page-specific style adjustments.
- **Market Intelligence and Service Page Publisher skill** — See `SKILL-market-intelligence-publisher.md`. Orchestrates the full workflow: website analysis, competitor research, gap identification, service page drafting, publishing, SEO meta tagging, and navigation menu update.
- **Backward compatible** — All v4 tools continue to work unchanged.

## What's New in v4.0.0

- **Runtime credential management** — Set WordPress and LinkedIn credentials directly from the Claude chat window using new MCP tools. No Railway dashboard required after initial deployment.
- **Auto WordPress publish prompt** — The TrueSource Article Writer skill now asks after every article whether to publish to WordPress as a post or page with menu item.
- **Credential persistence** — Credentials are stored to `./data/credentials.json`. Add a Railway Volume at `/app/data` for persistence across redeployments.
- **Backward compatible** — Existing Railway environment variables continue to work as fallback credentials.

See `USER-GUIDE.md` for full setup and usage instructions.


## Requirements

- **Node.js 18+** (for built-in `fetch` support)
- A **Brave Search API key** (free tier: 2,000 queries/month) OR **Tavily API key** (free tier: 1,000 searches/month)
- **Claude Desktop** (macOS or Windows)

---

## Quick Start

### 1. Install

```bash
git clone <this-repo-url>
cd claude-connector
bash install.sh
```

Or manually:

```bash
npm install
cp .env.example .env
```

### 2. Get API keys

**Option A - Brave Search (recommended):**
- Go to https://brave.com/search/api/
- Sign up for the free Data for AI plan (2,000 queries/month)
- Copy your API key

**Option B - Tavily:**
- Go to https://app.tavily.com
- Sign up for the free tier (1,000 searches/month)
- Copy your API key

For news via NewsAPI (optional, alternative to Brave News):
- Go to https://newsapi.org/register
- Free tier: 100 requests/day

### 3. Configure environment

Edit `.env` (or provide keys in Claude Desktop config - see step 5):

```env
SEARCH_PROVIDER=brave
BRAVE_API_KEY=your_brave_api_key_here
NEWS_PROVIDER=brave
```

### 4. Export your LinkedIn connections

LinkedIn does NOT provide a public API for reading your connections list.
The only supported method is their official data export:

1. Log into LinkedIn
2. Click **Me** (top right) > **Settings & Privacy**
3. Click **Data Privacy** in the left sidebar
4. Click **Get a copy of your data**
5. Select **Connections** (tick the checkbox)
6. Click **Request archive**
7. LinkedIn will email you a download link (usually within a few minutes, sometimes up to 24 hours)
8. Download the ZIP file and extract it
9. Find `Connections.csv` inside
10. Copy it to `./data/connections.csv` in this project

> **Note:** The export only includes connections who have agreed to share their email address with you. Connections who haven't shared their email will still appear but without the email field.

### 5. Configure Claude Desktop

Open (or create) the Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `claude-connector` entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "claude-connector": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/claude-connector/src/index.js"],
      "env": {
        "SEARCH_PROVIDER": "brave",
        "BRAVE_API_KEY": "your_brave_api_key_here",
        "NEWS_PROVIDER": "brave",
        "LINKEDIN_CSV_PATH": "/ABSOLUTE/PATH/TO/claude-connector/data/connections.csv",
        "LINKEDIN_PROFILE_PATH": "/ABSOLUTE/PATH/TO/claude-connector/data/profile.json",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

> **Replace** `/ABSOLUTE/PATH/TO/claude-connector` with the actual full path on your system.
> On macOS you can find this by running `pwd` in the claude-connector directory.

### 6. Restart Claude Desktop

Fully quit and reopen Claude Desktop. You should see the connector listed in the tools panel.

---

## Usage Examples

Once connected, you can ask Claude things like:

**Web Search:**
- *"Search the web for the latest news about Australian interest rates"*
- *"Find recent research papers on transformer attention mechanisms from the past month"*
- *"Search for reviews of the Sony WH-1000XM5 headphones"*

**News:**
- *"What are today's top technology news stories?"*
- *"Find news about the Reserve Bank of Australia from the past week"*
- *"Search for AI news from the past 24 hours"*

**LinkedIn Connections:**
- *"Load my LinkedIn connections, then find everyone who works at Atlassian"*
- *"Search my LinkedIn connections for senior engineers in Melbourne"*
- *"Who in my LinkedIn network works in venture capital?"*
- *"Find my LinkedIn connections who are founders or CEOs"*
- *"Show me connections I made in 2024 who work in finance"*
- *"How many of my LinkedIn connections work at banks?"*

**Combined:**
- *"Search the web for openings at Canva, then check if I know anyone there from my LinkedIn connections"*

---

## Architecture

```
claude-connector/
├── src/
│   ├── index.js              Main MCP server (stdio transport)
│   ├── config.js             Environment config & validation
│   ├── tools/
│   │   ├── webSearch.js      Brave Search + Tavily backends
│   │   ├── newsSearch.js     Brave News + NewsAPI backends
│   │   └── linkedin.js       CSV load, search, count, profile tools
│   └── utils/
│       ├── logger.js         stderr-based logger (safe for MCP stdio)
│       ├── helpers.js        Utility functions
│       └── csvParser.js      LinkedIn CSV parser (multi-format)
└── data/
    ├── connections.csv       (you add this from LinkedIn export)
    └── profile.json          (edit with your LinkedIn profile details)
```

The server communicates with Claude Desktop over **stdio** using the Model Context Protocol, exactly like TinyFish and other MCP connectors.

---

## LinkedIn API Limitations

LinkedIn's official API has very restricted access for third parties:

- `r_network` scope (connections list) requires **LinkedIn Partner Program** approval
- Approval requires a formal application, business justification, and review process
- It is not available to individual developers or small apps

The CSV export approach used here is the officially sanctioned alternative that LinkedIn themselves recommend for personal data access. It is fully compliant with LinkedIn's Terms of Service.

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `SEARCH_PROVIDER` | `brave` | `brave` or `tavily` |
| `BRAVE_API_KEY` | (required for brave) | Brave Search API key |
| `TAVILY_API_KEY` | (required for tavily) | Tavily API key |
| `NEWS_PROVIDER` | `brave` | `brave` or `newsapi` |
| `NEWS_API_KEY` | (required for newsapi) | NewsAPI.org key |
| `LINKEDIN_CSV_PATH` | `./data/connections.csv` | Absolute path to connections CSV |
| `LINKEDIN_PROFILE_PATH` | `./data/profile.json` | Absolute path to profile JSON |
| `DEFAULT_WEB_RESULTS` | `10` | Default number of web results |
| `DEFAULT_NEWS_RESULTS` | `10` | Default number of news results |
| `MAX_WEB_RESULTS` | `20` | Maximum allowed web results |
| `MAX_NEWS_RESULTS` | `20` | Maximum allowed news results |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

---

## Troubleshooting

**Claude Desktop does not show the connector:**
- Ensure the path in `claude_desktop_config.json` is an **absolute** path
- Ensure Node.js 18+ is installed and `node` is on your system PATH
- Check `~/Library/Logs/Claude/` (macOS) for error logs

**Web search returns errors:**
- Verify your `BRAVE_API_KEY` or `TAVILY_API_KEY` is correct
- Check your API usage quota on the respective dashboard

**LinkedIn connections not loading:**
- Confirm `Connections.csv` is in `./data/` or that `LINKEDIN_CSV_PATH` is set to the correct absolute path
- The file must be the raw export from LinkedIn, not manually created

**Connections found but no email addresses:**
- This is normal. LinkedIn only includes email addresses for connections who have opted to share their email with connections.

---

## License

MIT
