# claude-connector

**Version 9.0.0** — A fully functional **MCP (Model Context Protocol) server** that gives Claude real-time web/news search, LinkedIn lookup, TrueSource outreach email send / tracking / scheduling, Google Drive / Calendar / Sheets, Slack / Teams messaging, inbound webhooks, WordPress publishing, image search / download, psychology assessment, **plus a complete in-memory statistical analysis & machine-learning toolkit** (descriptive stats, hypothesis tests, regression, time-series, clustering, PCA, KNN, anomaly detection — 99 tools total).

| Category | Sample tools |
|---|---|
| **Search & web** | `web_search`, `news_search`, `image_search`, `web_fetch_page` |
| **LinkedIn** | `linkedin_load_connections`, `linkedin_search_connections`, `linkedin_connection_count`, `linkedin_get_profile`, `linkedin_start_oauth`, `linkedin_get_live_profile` |
| **WordPress** | `wordpress_site_info`, `wordpress_create_post`, `wordpress_create_page`, `wordpress_upload_media`, `wordpress_set_featured_image`, `wordpress_get_content` |
| **Google Drive** | `google_drive_search_files`, `google_drive_read_file_content`, `google_drive_create_file`, `google_drive_overwrite_file`, `google_drive_list_recent_files` |
| **Google Calendar** | `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event` |
| **Google Sheets** | `sheets_get_metadata`, `sheets_read_range`, `sheets_write_range`, `sheets_append_rows` |
| **TrueSource email** | `email_send`, `email_validate_address`, `email_get_tracking`, `email_tracking_summary`, `email_schedule`, `email_schedule_cancel` |
| **Messaging** | `slack_send_message`, `teams_send_message` |
| **Webhooks** | `webhook_poll_events`, `webhook_clear_events`, `webhook_queue_status` |
| **Psychology** | `psychology_emotion_taxonomy`, `psychology_sentiment_analyze`, `psychology_alignment_assess` |
| **Data management** *(v9.0.0)* | `data_load`, `data_info`, `data_preview`, `data_filter`, `data_select`, `data_sample`, `data_drop`, `data_list` |
| **Descriptive stats** *(v9.0.0)* | `stats_describe`, `stats_frequency`, `stats_histogram`, `stats_crosstab`, `stats_normality` |
| **Hypothesis tests** *(v9.0.0)* | `stats_ttest`, `stats_anova`, `stats_chi_square`, `stats_confidence_interval`, `stats_mann_whitney`, `stats_proportion_test` |
| **Regression / correlation** *(v9.0.0)* | `stats_correlation`, `stats_regression`, `stats_partial_correlation` |
| **Time series** *(v9.0.0)* | `ts_analyze`, `ts_moving_average`, `ts_forecast` |
| **Machine learning** *(v9.0.0)* | `ml_kmeans`, `ml_pca`, `ml_knn`, `ml_naive_bayes`, `ml_anomaly_detection`, `ml_feature_importance` |
| **Help & utilities** | `stats_help`, `get_current_datetime` |

> Call `stats_help` for a categorised list of all statistical / ML tools with usage hints.

---

## What's New in v9.0.0 (Major Release)

v9.0.0 consolidates the former **stats-connector / data-analysis** MCP into claude-connector with **zero loss of functionality** from either side. All 67 v8.0.0 tools, transports, and HTTP endpoints are preserved verbatim — 32 statistical & ML tools (plus `stats_help`) are added on top.

- New `src/tools-stats/` directory with 6 modules covering data management, descriptive stats, hypothesis testing, regression / correlation, time series, and machine learning.
- New `src/store/dataStore.js` providing an in-memory dataset registry (max 20 datasets, up to 2 M rows each, automatic column-type inference).
- New `src/utils/format.js` for stats output formatting (significance stars, fixed-width tables, CI / Cohen's d / r² interpretation).
- HTTP body limit raised to **50 MB** to allow large inline-data dataset loading via `data_load`.
- All logs unified under the `[claude-connector]` tag.
- Full end-to-end smoke test (`test-merge.js`) verifies all 99 tools register, all 32 stats tools execute correctly, and HTTP MCP transport works.

See [CHANGELOG.md](./CHANGELOG.md) for the complete release notes.

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
