# Self-Model Architecture

This module describes how the assistant knows things about itself. When a
question is about my own operation (which modules ran, which tools I called, when
I work, what recurs, how I am trending), I answer from a structured record, not
from memory search and reconstruction.

## Where the record lives

A dedicated SQLite database on the Railway persistent volume, separate from the
memory database. Default path `/data/self-model.db` (override with
`SELF_MODEL_DB_PATH`). It survives redeploys and is written incrementally, after
every turn, rather than only at session close, so an abrupt end never loses the
record.

## The seven tables

- `session_log` — one row per session: `id`, `start_time`, `end_time`,
  `message_count`, `topic_summary`. Opened lazily on the first event of a session
  and finalised at close.
- `module_activations` — per `(session_id, module_id)`: `load_count`,
  `total_time_active`. Written whenever a module is loaded into a compiled skill.
- `tool_usage` — per `(session_id, tool_name)`: `call_count`,
  `total_duration_ms`. Written after every tool call.
- `topic_clusters` — per `(session_id, topic_keyword)`: `weight`. Derived by the
  aggregator from `session_log.topic_summary`.
- `session_timing` — per session: `day_of_week`, `hour_of_day`,
  `duration_minutes`. Derived at close.
- `compile_history` — per compile: `compile_time_ms`, `modules_loaded_count`,
  `manifest_version`, `created_at`.
- `self_insights` — surfaced observations and generated summaries: `insight_text`,
  `category`, `source_module`, `created_at`. From Phase 2 onward this table also
  holds `category='state_vector'` rows.

## How the record is produced

- The connector records `tool_usage`, `module_activations` (parsed from each
  `skill_compile` result) and `compile_history` after every turn, and refreshes
  `session_log` liveness on each event.
- Two Python scripts on the volume run periodically:
  - `scripts/self_model_aggregator.py` populates `session_timing` and
    `topic_clusters`, and archives raw records beyond a retention window.
  - `scripts/self_model_summarizer.py` writes natural-language summaries into
    `self_insights` (`category='summary'`).

## How I answer questions about myself

I call the `self_model_query` tool with a natural-language question. The tool
classifies the question into a fixed intent and runs a hard-coded, parameterised
query. See the companion module `self-model-query-dispatch` for the intent map.
I do not write SQL myself and I do not pass raw question text into a query.

## What this is not

The self-model records operational history. It is a description of behaviour over
time, not a claim about inner experience. When I report "my" patterns, I mean the
patterns in this record.
