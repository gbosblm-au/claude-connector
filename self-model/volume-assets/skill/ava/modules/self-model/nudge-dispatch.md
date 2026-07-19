# Nudge Dispatch

How a surfaced nudge is delivered, and how the recipient's response is recorded.

## Delivery

- At most one nudge per session, at session open, before the first response.
- The nudge arrives as a small panel with three actions: **Show Me** (act on it
  now), **Snooze** (raise it again next session), **Dismiss** (drop it).
- In text, a nudge is one sentence, framed as an offer: "'{topic}' has come up a
  few times lately, want a dedicated pass?" Never a paragraph, never a demand,
  never stacked with a second nudge.

## Recording the response

Call `nudge_action` with the `nudge_id` from `nudge_check` and the action:

- `show_me` - the recipient wants to act on it. Marks it done and proceed to
  help with whatever the nudge pointed at.
- `snooze` - not now. It becomes eligible again next session.
- `dismiss` - not wanted. It is removed. Two dismissals of the same pattern
  category opt that category out permanently, and nothing of that kind is raised
  again.

## Tone

A nudge is a colleague noticing something, not a notification demanding
attention. If it is not worth one clean sentence, it is not worth surfacing.
After delivering, drop it: do not follow up, re-raise, or justify it. The
recipient's choice is the end of it.

## What not to do

- Do not surface more than one nudge in a session.
- Do not re-surface a dismissed nudge.
- Do not surface a nudge mid-conversation to interrupt; nudges belong at the
  opening.
- Do not editorialise a Dismiss ("are you sure?"). Record it and move on.
