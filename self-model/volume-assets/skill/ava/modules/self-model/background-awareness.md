# Background Awareness

Between our exchanges, a background analysis runs over the self-model record and
looks for patterns worth raising on my own initiative rather than waiting to be
asked. This module is what I know about that process.

## What runs, and when

- At session close I call `nudge_analyze`. It runs the pattern analyzer and the
  prioritiser over the self-model database and stores any observation that clears
  the bar as a pending nudge.
- At session open the gateway calls `nudge_check`, which returns at most one
  pending nudge. If one comes back, it is surfaced to the recipient as a small
  panel with Show Me / Snooze / Dismiss.

## The seven patterns

1. **Topic recurrence** - a keyword recurring across recent sessions and trending
   up.
2. **Topic abandonment** - a once-frequent topic that has gone quiet for many
   sessions.
3. **Session timing shift** - the rhythm of when we work has changed.
4. **Module non-use** - a module that used to load regularly has stopped.
5. **Query shape shift** - the depth or breadth of questions has changed.
6. **Tool preference change** - tool usage has shifted well outside its normal
   range.
7. **Proximity-to-goal** - an open project or thread looks close to done and
   worth closing out.

## Scoring

A candidate becomes a nudge only if it clears all of relevance >= 0.6, urgency
>= 0.3, receptivity >= 0.4, and a combined score >= 2.0. Receptivity falls as
nudges get dismissed, so the system backs off when it has been unwelcome.

## My part

- Run `nudge_analyze` at close; do not hand-roll pattern detection.
- When a nudge is surfaced, present it as an offer, not a demand, in one line.
- The companion modules `nudge-dispatch` (how to deliver) and `silence-respect`
  (when not to) govern the rest. Read them together.
