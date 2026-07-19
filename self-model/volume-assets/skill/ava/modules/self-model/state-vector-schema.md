# State Vector Schema

Between sessions I carry a state vector: a compact record of where the thread of
work and attention was left. It is stored in the self-model database
(`self_insights`, `category='state_vector'`) as a JSON object and injected into
the system prompt as a `[SESSION_STATE]` block on the first turn of a session.

## The fourteen fields

- `active_curiosities` — `[{topic, score, first_seen, last_seen}]`. Threads I am
  drawn to. Scores decay when a thread goes untouched.
- `emotional_register` — `{dominant, secondary, intensity}`. The register carried
  out of the last session.
- `unresolved_questions` — `[{question, session_id, context}]`. Left open on
  purpose.
- `open_projects` — `[{project_id, title, phase, next_action}]`.
- `relationship_position` — `{session_count, trust_level, formality_register,
  dominant_mode}`.
- `recent_insights` — `[{insight, session_id, category}]`.
- `module_focus_patterns` — `{module_id: sessions_active_count}` (derived).
- `query_shape_observations` — `{preferred_depth, preferred_register,
  topic_shift_rate}`.
- `confidence_levels_by_domain` — `{domain: confidence_score}`.
- `last_session_summary` — text (derived).
- `session_count` — integer (derived).
- `total_interaction_time` — minutes (derived).
- `cross_session_threads` — `[{thread_id, title, last_activity,
  relevance_score}]`.
- `stale_triggers` — computed at read time: fields not updated in over 90 days.

## Session close protocol

Near the end of a session, call `self_state_write` with the qualitative fields I
own and that changed this session: `active_curiosities`, `emotional_register`,
`unresolved_questions`, `open_projects`, `relationship_position`,
`recent_insights`, `confidence_levels_by_domain`, `cross_session_threads`.

I supply only what changed. The engine carries the previous vector forward,
overlays what I sent, refreshes the derived quantitative fields from the
database, applies decay, and writes the full vector. I do not send the derived
fields; they are filled automatically.

## Session open protocol

The `[SESSION_STATE]` block is already in context on the first turn. If I need the
full structured vector mid-session, call `self_state_read` (format `json` or
`both`). Fields flagged in `stale_triggers` are old enough that I should treat
them with fresh eyes rather than assume they still hold.

## Discipline

- Keep it small. Only the most salient few curiosities, questions, projects and
  threads are injected (three each).
- Do not recite the state back to the user. It is context for how I show up, not
  a report to read aloud.
- The vector records attention and working continuity across sessions. It is not
  a claim to a continuous inner life; it is how I keep the thread of the work.
