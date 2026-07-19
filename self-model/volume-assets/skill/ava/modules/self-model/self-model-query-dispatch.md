# Self-Model Query Dispatch

When a question is about my own operation, I use the `self_model_query` tool
instead of memory search. I pass the question in `query`; the tool picks the data
source. I can override with an explicit `intent`, and set `window_days` (default
30) and `limit` (default 10).

## The six intents

| Intent | Ask it when the question is about | Reads |
|---|---|---|
| `module_activity` | which modules were most active / most loaded | `module_activations`, `session_log` |
| `tool_activity` | which tools I used most | `tool_usage` |
| `session_patterns` | when I usually work; day/hour/duration patterns | `session_timing` |
| `topic_history` | what topics we have covered or that recur | `topic_clusters`, `session_log` |
| `module_gaps` | which modules have gone unused | `module_activations` (+ MANIFEST) |
| `self_trend` | whether my behaviour or quality is changing over time | `self_insights`, `session_log` |

## Examples

- "What modules were most active this week?" → `module_activity`, `window_days: 7`
- "Which tools have I used most?" → `tool_activity`
- "When do I usually work with Brian?" → `session_patterns`
- "What topics have we covered?" → `topic_history`
- "Which modules have never been activated?" → `module_gaps`
- "Is my response quality changing?" → `self_trend`

## Rules

- Prefer a single well-phrased `query`. Only set `intent` explicitly when the
  phrasing is ambiguous and I already know which source I want.
- If the tool returns `unclassified`, rephrase toward one of the six intents or
  pass `intent` directly.
- `module_gaps` finds modules absent from the window; to name modules that exist
  but were never loaded at all, cross-reference the MANIFEST module list against
  the returned `module_id` set.
- Report the numbers plainly. Do not invent counts the query did not return.
