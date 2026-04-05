// tools/newsSearch.js
// Supports two news backends: Brave News Search API and NewsAPI.org.
// Configured via NEWS_PROVIDER env var ("brave" or "newsapi").

import { config, requireBraveKey, requireNewsApiKey } from "../config.js";
import { clamp, truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";

// -----------------------------------------------------------------------
// Tool definition (MCP schema)
// -----------------------------------------------------------------------

export const newsSearchToolDefinition = {
  name: "news_search",
  description:
    "Searches real-time news articles from across the web. " +
    "Use this for breaking news, current events, recent developments, or any topic where recency matters. " +
    "Supports date filtering, language selection, and sorting by relevance or recency.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The news search query.",
      },
      num_results: {
        type: "number",
        description: `Number of articles to return (default ${config.defaultNewsResults}, max ${config.maxNewsResults}).`,
        minimum: 1,
        maximum: config.maxNewsResults,
      },
      from_date: {
        type: "string",
        description:
          "Only return articles published on or after this date. Format: YYYY-MM-DD. Optional.",
      },
      to_date: {
        type: "string",
        description:
          "Only return articles published on or before this date. Format: YYYY-MM-DD. Optional.",
      },
      language: {
        type: "string",
        description:
          "Two-letter language code to filter articles (e.g. 'en', 'es', 'fr'). Defaults to 'en'. Optional.",
      },
      sort_by: {
        type: "string",
        description:
          "Sort order for results. 'relevancy' (best match) or 'publishedAt' (most recent first). Defaults to 'publishedAt'.",
        enum: ["relevancy", "publishedAt"],
      },
      freshness: {
        type: "string",
        description:
          "Shortcut for date filtering (Brave provider only). 'pd' = past day, 'pw' = past week, 'pm' = past month.",
        enum: ["pd", "pw", "pm"],
      },
    },
    required: ["query"],
  },
};

// -----------------------------------------------------------------------
// Brave News implementation
// -----------------------------------------------------------------------

async function braveNewsSearch(query, numResults, freshness, language, fromDate, toDate) {
  requireBraveKey();

  const url = new URL("https://api.search.brave.com/res/v1/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  url.searchParams.set("text_decorations", "0");
  if (freshness) {
    url.searchParams.set("freshness", freshness);
  }
  if (language) {
    url.searchParams.set("search_lang", language.toLowerCase());
  }

  log("debug", `Brave news search: ${url.toString()}`);

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": config.braveApiKey,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Brave News API error ${resp.status}: ${resp.statusText}. ${body}`
    );
  }

  const data = await resp.json();
  const newsResults = data?.results || [];

  // Optionally filter by date range client-side when Brave freshness isn't precise enough
  let filtered = newsResults;
  if (fromDate || toDate) {
    const from = fromDate ? new Date(fromDate).getTime() : 0;
    const to = toDate ? new Date(toDate + "T23:59:59Z").getTime() : Infinity;
    filtered = newsResults.filter((r) => {
      if (!r.age && !r.page_age) return true;
      // Brave sometimes gives "X hours ago" style; skip client filtering in that case
      const dateStr = r.page_age || r.age || "";
      if (!dateStr.match(/^\d{4}-\d{2}-\d{2}/)) return true;
      const ts = new Date(dateStr).getTime();
      return ts >= from && ts <= to;
    });
  }

  return filtered.map((r) => ({
    title: r.title || "",
    url: r.url || "",
    description: truncate(r.description || r.extra_snippets?.[0] || "", 400),
    publishedAt: r.page_age || r.age || "",
    source: r.meta_url?.hostname || "",
    thumbnail: r.thumbnail?.src || "",
    provider: "brave",
  }));
}

// -----------------------------------------------------------------------
// NewsAPI implementation
// -----------------------------------------------------------------------

async function newsApiSearch(query, numResults, language, fromDate, toDate, sortBy) {
  requireNewsApiKey();

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("pageSize", String(numResults));
  url.searchParams.set("language", language || "en");
  url.searchParams.set("sortBy", sortBy || "publishedAt");
  if (fromDate) url.searchParams.set("from", fromDate);
  if (toDate) url.searchParams.set("to", toDate);

  log("debug", `NewsAPI search: ${url.toString()}`);

  const resp = await fetch(url.toString(), {
    headers: {
      "X-Api-Key": config.newsApiKey,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `NewsAPI error ${resp.status}: ${resp.statusText}. ${body}`
    );
  }

  const data = await resp.json();

  if (data.status !== "ok") {
    throw new Error(`NewsAPI returned status "${data.status}": ${data.message || "Unknown error"}`);
  }

  const articles = data?.articles || [];

  return articles.map((a) => ({
    title: a.title || "",
    url: a.url || "",
    description: truncate(a.description || a.content || "", 400),
    publishedAt: a.publishedAt || "",
    source: a.source?.name || "",
    author: a.author || "",
    thumbnail: a.urlToImage || "",
    provider: "newsapi",
  }));
}

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------

export async function handleNewsSearch(args) {
  const query = (args?.query || "").trim();
  if (!query) throw new Error("The 'query' parameter is required.");

  const numResults = clamp(
    Number(args?.num_results) || config.defaultNewsResults,
    1,
    config.maxNewsResults
  );
  const language  = args?.language || "en";
  const fromDate  = args?.from_date || "";
  const toDate    = args?.to_date || "";
  const sortBy    = args?.sort_by || "publishedAt";
  const freshness = args?.freshness || "";

  const start = Date.now();
  let articles;

  if (config.newsProvider === "newsapi") {
    articles = await newsApiSearch(query, numResults, language, fromDate, toDate, sortBy);
  } else {
    articles = await braveNewsSearch(query, numResults, freshness, language, fromDate, toDate);
  }

  const elapsed = Date.now() - start;
  log("info", `News search completed in ${elapsed}ms, ${articles.length} articles`);

  if (articles.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No news articles found for query: "${query}"`,
        },
      ],
    };
  }

  const formatted = articles
    .map((a, i) => {
      const lines = [`[${i + 1}] ${a.title}`];
      if (a.source) lines.push(`Source: ${a.source}`);
      if (a.author) lines.push(`Author: ${a.author}`);
      if (a.publishedAt) lines.push(`Published: ${a.publishedAt}`);
      if (a.url) lines.push(`URL: ${a.url}`);
      lines.push(`${a.description}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  const dateRange = fromDate || toDate
    ? ` | Date range: ${fromDate || "any"} to ${toDate || "any"}`
    : freshness
    ? ` | Freshness: ${freshness}`
    : "";

  const summary =
    `News results for "${query}" (${articles.length} articles, provider: ${config.newsProvider}${dateRange}, elapsed: ${elapsed}ms)\n\n${formatted}`;

  return { content: [{ type: "text", text: summary }] };
}
