// tools/webSearch.js
// Supports two search backends: Brave Search API and Tavily.
// Configured via SEARCH_PROVIDER env var ("brave" or "tavily").
//
// Brave fallback: when SEARCH_PROVIDER=brave (the default) and Brave fails for
// any reason (missing key, 401, 429, network error), the connector will
// automatically retry the same query against the Serper Google Search API
// provided SERPER_API_KEY is set in the environment. If SERPER_API_KEY is not
// set, the original Brave error is re-thrown unchanged. The Tavily path is
// completely unaffected by this change.

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

// ---------------------------------------------------------------------------
// Brave Search implementation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tavily Search implementation (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Serper Google Search fallback implementation
//
// Called automatically when Brave fails and SERPER_API_KEY is configured.
// Serper API docs: https://serper.dev/api-reference
// Endpoint: POST https://google.serper.dev/search
// Auth: X-API-KEY header
// Freshness maps to Serper's tbs (time-based search) parameter.
// ---------------------------------------------------------------------------

/**
 * Maps a Brave-style freshness code to the equivalent Serper tbs value.
 * Returns an empty string when no freshness is requested.
 * @param {string} freshness - "pd" | "pw" | "pm" | "py" | ""
 * @returns {string}
 */
function freshnessToSerperTbs(freshness) {
  switch (freshness) {
    case "pd": return "qdr:d";
    case "pw": return "qdr:w";
    case "pm": return "qdr:m";
    case "py": return "qdr:y";
    default:   return "";
  }
}

async function serperWebSearchDetailed(query, numResults, freshness, country) {
  const body = {
    q: query,
    num: numResults,
  };

  // Serper accepts gl (geo-location) as a lowercase two-letter country code.
  if (country) body.gl = country.toLowerCase();

  const tbs = freshnessToSerperTbs(freshness);
  if (tbs) body.tbs = tbs;

  log("debug", "Serper web search (Brave fallback)", { query, numResults, country, tbs });

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": config.serperApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(
      `Serper Search API error ${resp.status}: ${resp.statusText}. ${errBody}`
    );
  }

  const data = await resp.json();
  const organic = data?.organic || [];

  const mappedResults = organic.map((result) => ({
    title: result.title || "",
    url: result.link || "",
    description: truncate(result.snippet || "", 500),
    age: result.date || "",
    language: "",
    source: "serper",
  }));

  return {
    provider: "serper",
    results: mappedResults,
    locations: [],
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Provider dispatcher
//
// Brave is the default. If Brave throws for any reason and SERPER_API_KEY is
// configured, the same query is retried against Serper. The Tavily path is
// completely unaffected.
// ---------------------------------------------------------------------------

async function searchDetailed({ query, numResults, freshness, country }) {
  if (config.searchProvider === "tavily") {
    return tavilySearchDetailed(query, numResults, freshness);
  }

  // Brave path with automatic Serper fallback.
  try {
    return await braveSearchDetailed(query, numResults, freshness, country);
  } catch (braveErr) {
    if (config.serperApiKey) {
      log(
        "warn",
        `Brave web search failed - falling back to Serper. Brave error: ${braveErr.message}`
      );
      return await serperWebSearchDetailed(query, numResults, freshness, country);
    }
    // No Serper key configured - re-throw original Brave error.
    throw braveErr;
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Formats web search results into a human-readable string.
 * @param {string} query       - The original search query.
 * @param {Array}  results     - Normalised result objects.
 * @param {number} elapsed     - Milliseconds taken for the search.
 * @param {string} providerUsed - The provider that actually returned results
 *   ("brave", "serper", or "tavily"). Falls back to config.searchProvider when
 *   not supplied so the function remains backward-compatible.
 * @returns {string}
 */
function formatWebResults(query, results, elapsed, providerUsed) {
  const displayProvider = providerUsed || config.searchProvider;

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

  return `Web search results for "${query}" (${results.length} results, provider: ${displayProvider}, elapsed: ${elapsed}ms)\n\n${formatted}`;
}

// ---------------------------------------------------------------------------
// Main handler (exported)
// ---------------------------------------------------------------------------

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
  // Use the provider that actually answered the query (may differ from
  // config.searchProvider when Serper fallback was activated).
  const providerUsed = primarySearch?.provider || config.searchProvider;
  const elapsed = Date.now() - start;
  log("info", `Web search completed in ${elapsed}ms, ${results.length} results (provider: ${providerUsed})`);

  const standardWebText = formatWebResults(query, results, elapsed, providerUsed);

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
