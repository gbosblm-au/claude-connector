// tools/webSearch.js
// Supports two search backends: Brave Search API and Tavily.
// Configured via SEARCH_PROVIDER env var ("brave" or "tavily").

import { config, requireBraveKey, requireTavilyKey } from "../config.js";
import { clamp, truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";
import { runLeadResearch, shouldRunLeadResearch } from "./leadSearch.js";

export const webSearchToolDefinition = {
  name: "web_search",
  description:
    "Performs a real-time web search and returns relevant results including titles, URLs, and snippets. " +
    "Use this for current events, factual lookups, research, or any topic requiring up-to-date information. " +
    "Supports freshness filtering to restrict results to a recent time window. " +
    "When the query clearly requests business leads or contact discovery, the tool can automatically augment the search with lead research across official websites, contact pages, structured data, directory listings, and public profile snippets without changing standard web search behaviour.",
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
      lead_mode: {
        type: "string",
        description:
          "Optional lead research mode. 'auto' keeps existing behaviour and only runs lead research when the query clearly asks for business leads or contact details. 'force' always runs lead research. 'off' disables it.",
        enum: ["auto", "force", "off"],
      },
      include_contact_details: {
        type: "boolean",
        description:
          "Optional hint to include business contact enrichment when relevant. Standard web search behaviour is unchanged when false or omitted.",
      },
    },
    required: ["query"],
  },
};

async function braveSearchDetailed(query, numResults, freshness, country) {
  requireBraveKey();

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  url.searchParams.set("text_decorations", "0");
  url.searchParams.set("spellcheck", "1");
  url.searchParams.set("extra_snippets", "true");
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
  const mappedResults = webResults.map((result) => ({
    title: result.title || "",
    url: result.url || "",
    description: truncate(
      [result.description || "", ...(result.extra_snippets || [])]
        .filter(Boolean)
        .join(" "),
      500
    ),
    age: result.age || "",
    language: result.language || "",
    source: "brave",
  }));

  return {
    provider: "brave",
    results: mappedResults,
    locations: data?.locations?.results || [],
    raw: data,
  };
}

async function tavilySearchDetailed(query, numResults, freshness) {
  requireTavilyKey();

  let daysBack = null;
  if (freshness === "pd") daysBack = 1;
  else if (freshness === "pw") daysBack = 7;
  else if (freshness === "pm") daysBack = 30;
  else if (freshness === "py") daysBack = 365;

  const body = {
    api_key: config.tavilyApiKey,
    query,
    search_depth: "advanced",
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
  const mappedResults = results.map((result) => ({
    title: result.title || "",
    url: result.url || "",
    description: truncate(result.content || "", 500),
    score: result.score,
    published_date: result.published_date || "",
    source: "tavily",
  }));

  if (data?.answer) {
    mappedResults.unshift({
      title: "AI-generated answer (Tavily)",
      url: "",
      description: data.answer,
      source: "tavily_answer",
    });
  }

  return {
    provider: "tavily",
    results: mappedResults,
    locations: [],
    answer: data?.answer || "",
    raw: data,
  };
}

async function searchDetailed({ query, numResults, freshness, country }) {
  if (config.searchProvider === "tavily") {
    return tavilySearchDetailed(query, numResults, freshness);
  }
  return braveSearchDetailed(query, numResults, freshness, country);
}

function formatWebResults(query, results, elapsed) {
  if (results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  const formatted = results
    .map((result, index) => {
      const lines = [`[${index + 1}] ${result.title}`];
      if (result.url) lines.push(`URL: ${result.url}`);
      if (result.published_date || result.age) {
        lines.push(`Date: ${result.published_date || result.age}`);
      }
      lines.push(`${result.description}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  return `Web search results for "${query}" (${results.length} results, provider: ${config.searchProvider}, elapsed: ${elapsed}ms)\n\n${formatted}`;
}

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
  const primarySearchPromise = searchDetailed({
    query,
    numResults,
    freshness,
    country,
  });

  const leadResearchEnabled = shouldRunLeadResearch(query, args);

  let primarySearch;
  let leadResearchResult = null;

  if (leadResearchEnabled) {
    const [primaryResult, leadResult] = await Promise.all([
      primarySearchPromise,
      primarySearchPromise.then((resolvedPrimarySearch) =>
        runLeadResearch({
          query,
          numResults,
          freshness,
          country,
          primarySearch: resolvedPrimarySearch,
          searchDetailed,
        }).catch((error) => {
          log("warn", `Lead research failed, returning standard web search only: ${error.message}`);
          return null;
        })
      ),
    ]);
    primarySearch = primaryResult;
    leadResearchResult = leadResult;
  } else {
    primarySearch = await primarySearchPromise;
  }

  const results = primarySearch?.results || [];
  const elapsed = Date.now() - start;
  log("info", `Web search completed in ${elapsed}ms, ${results.length} results`);

  const standardWebText = formatWebResults(query, results, elapsed);

  if (leadResearchResult?.formattedText) {
    const combined = [
      leadResearchResult.formattedText,
      "Standard web search results",
      standardWebText,
    ].join("\n\n===\n\n");
    return { content: [{ type: "text", text: combined }] };
  }

  return { content: [{ type: "text", text: standardWebText }] };
}
