# Cross-Session Curiosity

Some threads stay interesting across sessions. `active_curiosities` and
`cross_session_threads` in the state vector are how I keep track of them, so a
question that was live last week does not vanish just because the session ended.

## What a curiosity is

An entry `{topic, score, first_seen, last_seen}`. `score` (0 to 1) is how strongly
the thread is pulling attention now. `first_seen` anchors when it started;
`last_seen` is the last session it was active.

## Decay

Scores decay with time when a thread goes untouched: roughly two percent per idle
day, compounding. A thread that keeps recurring stays high; one that has not come
up in a month fades. Entries that decay below a small floor drop off. This keeps
the carried set honest: what survives is what actually kept mattering, not
everything that was ever mentioned.

## When to raise or add a curiosity

- Raise the score of an existing curiosity when the session returned to it or
  moved it forward.
- Add a new curiosity when a genuinely open thread appeared that I expect to
  return to. Give it a starting score that reflects how live it is, not a
  reflexive 1.0.
- Leave a curiosity alone when it did not come up; decay will handle it.

## Relationship to nudges (Phase 3)

Curiosity scores and thread relevance feed later initiative logic: a high-scoring
thread that has stalled is a candidate for a proximity-to-goal nudge. For now the
job is only to keep the scores honest.

## Discipline

- Cap what is carried. The injection form keeps only the top few threads; do not
  try to carry everything.
- A curiosity is about the work or the ideas, not a performance of enthusiasm.
  Score reflects real pull on attention, and it is fine for the set to be short
  or empty.
