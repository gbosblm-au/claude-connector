# Changelog - v10.0.2

## Summary

Adds Serper Google Search as an automatic fallback for both web search and news
search when Brave is configured as the primary provider and fails for any reason
(missing API key, HTTP 401/429, network error, or any other exception).

## Changes

### src/config.js
- Added `serperApiKey` field reading from `SERPER_API_KEY` environment variable.
  Defaults to an empty string (fallback disabled) when not set.

### src/tools/webSearch.js
- Added `freshnessToSerperTbs()` helper that maps Brave freshness codes
  (`pd`, `pw`, `pm`, `py`) to Serper's equivalent `tbs` parameter values
  (`qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`).
- Added `serperWebSearchDetailed()` function that calls the Serper web search
  endpoint (`POST https://google.serper.dev/search`) and normalises results
  to the same shape used by Brave and Tavily.
- Modified `searchDetailed()`: when `SEARCH_PROVIDER=brave` (default), Brave is
  attempted first. If Brave throws and `SERPER_API_KEY` is configured, the same
  query is automatically retried against Serper. If no Serper key is set, the
  original Brave error is re-thrown unchanged. The Tavily path is unaffected.
- Modified `formatWebResults()`: added optional `providerUsed` parameter so the
  summary line accurately reports which provider answered the query (important
  when Serper fallback was activated). Backward-compatible: falls back to
  `config.searchProvider` when the parameter is not supplied.
- Modified `handleWebSearch()`: extracts `provider` from the search result object
  and passes it to `formatWebResults()` and the info log line.

### src/tools/newsSearch.js
- Added `serperNewsSearch()` function that calls the Serper news endpoint
  (`POST https://google.serper.dev/news`) and normalises results to the same
  shape used by Brave and NewsAPI.
- Modified `handleNewsSearch()`: when `NEWS_PROVIDER=brave` (default), Brave is
  attempted first. If Brave throws and `SERPER_API_KEY` is configured, the same
  query is automatically retried against Serper. If no Serper key is set, the
  original Brave error is re-thrown unchanged. The NewsAPI path is unaffected.
- Added `newsProviderUsed` variable that tracks which provider actually returned
  results. The summary line now reports this value instead of `config.newsProvider`
  so the fallback activation is visible in the tool output.

### .env.example
- Added `SERPER_API_KEY` section with documentation on how to obtain a key.

## No other files were modified.

## Deployment

Add `SERPER_API_KEY` to Railway Variables with your key from https://serper.dev.
No restart configuration changes are needed. The fallback activates automatically
on any Brave failure as long as the key is present.
