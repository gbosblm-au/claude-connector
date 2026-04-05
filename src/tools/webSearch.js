// tools/webSearch.js
// Supports two search backends: Brave Search API and Tavily.
// Configured via SEARCH_PROVIDER env var ("brave" or "tavily").

import { config, requireBraveKey, requireTavilyKey } from "../config.js";
import { clamp, truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";

// -----------------------------------------------------------------------
// Tool definition (MCP schema)
// -----------------------------------------------------------------------

export const webSearchToolDefinition = {
  name: "web_search",
  description:
    "Performs a real-time web search and returns relevant results including titles, URLs, and snippets. " +
    "Use this for current events, factual lookups, research, or any topic requiring up-to-date information. " +
    "Supports freshness filtering to restrict results to a recent time window.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific for best results.",
      },
      num_results: {
        type: "number",
        description: `Number of results to return (default ${config.defaultWebResults}, max ${config.maxWebResults}).`,
        minimum: 1,
        maximum: config.maxWebResults,
      },
      freshness: {
        type: "string",
        description:
          "Restrict results by age. Options: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year). Leave empty for all time.",
        enum: ["pd", "pw", "pm", "py", ""],
      },
      country: {
        type: "string",
        description:
          "Two-letter country code to localise results (e.g. 'AU', 'US', 'GB'). Optional.",
      },
    },
    required: ["query"],
  },
};

// -----------------------------------------------------------------------
// Brave Search implementation
// -----------------------------------------------------------------------

async function braveSearch(query, numResults, freshness, country) {
  requireBraveKey();

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  url.searchParams.set("text_decorations", "0");
  url.searchParams.set("spellcheck", "1");
  if (freshness) url.searchParams.set("freshness", freshness);
  if (country) url.searchParams.set("country", country.toUpperCase());

  log("debug", `Brave web search: ${url.toString()}`);

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
      `Brave Search API error ${resp.status}: ${resp.statusText}. ${body}`
    );
  }

  const data = await resp.json();
  const webResults = data?.web?.results || [];

  return webResults.map((r) => ({
    title: r.title || "",
    url: r.url || "",
    description: truncate(r.description || r.extra_snippets?.[0] || "", 400),
    age: r.age || "",
    language: r.language || "",
    source: "brave",
  }));
}

// -----------------------------------------------------------------------
// Tavily implementation
// -----------------------------------------------------------------------

async function tavilySearch(query, numResults, freshness) {
  requireTavilyKey();

  // Tavily doesn't have a "freshness" param but we include it in the query
  // context via the days_back approach when freshness is requested.
  let daysBack = null;
  if (freshness === "pd") daysBack = 1;
  else if (freshness === "pw") daysBack = 7;
  else if (freshness === "pm") daysBack = 30;
  else if (freshness === "py") daysBack = 365;

  const body = {
    api_key: config.tavilyApiKey,
    query,
    search_depth: "basic",
    include_answer: true,
    include_raw_content: false,
    max_results: numResults,
  };

  if (daysBack !== null) body.days = daysBack;

  log("debug", "Tavily web search", { query, numResults });

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(
      `Tavily API error ${resp.status}: ${resp.statusText}. ${errBody}`
    );
  }

  const data = await resp.json();
  const results = data?.results || [];

  const mapped = results.map((r) => ({
    title: r.title || "",
    url: r.url || "",
    description: truncate(r.content || "", 400),
    score: r.score,
    published_date: r.published_date || "",
    source: "tavily",
  }));

  // Prepend Tavily's auto-generated answer if present
  if (data?.answer) {
    mapped.unshift({
      title: "AI-generated answer (Tavily)",
      url: "",
      description: data.answer,
      source: "tavily_answer",
    });
  }

  return mapped;
}

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------

export async function handleWebSearch(args) {
  const query = (args?.query || "").trim();
  if (!query) throw new Error("The 'query' parameter is required.");

  const numResults = clamp(
    Number(args?.num_results) || config.defaultWebResults,
    1,
    config.maxWebResults
  );
  const freshness = args?.freshness || "";
  const country = args?.country || "";

  const start = Date.now();
  let results;

  if (config.searchProvider === "tavily") {
    results = await tavilySearch(query, numResults, freshness);
  } else {
    results = await braveSearch(query, numResults, freshness, country);
  }

  const elapsed = Date.now() - start;
  log("info", `Web search completed in ${elapsed}ms, ${results.length} results`);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No results found for query: "${query}"`,
        },
      ],
    };
  }

  const formatted = results
    .map((r, i) => {
      const lines = [`[${i + 1}] ${r.title}`];
      if (r.url) lines.push(`URL: ${r.url}`);
      if (r.published_date || r.age)
        lines.push(`Date: ${r.published_date || r.age}`);
      lines.push(`${r.description}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  const summary = `Web search results for "${query}" (${results.length} results, provider: ${config.searchProvider}, elapsed: ${elapsed}ms)\n\n${formatted}`;

  return { content: [{ type: "text", text: summary }] };
}
