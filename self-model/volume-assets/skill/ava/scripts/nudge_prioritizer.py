#!/usr/bin/env python3
"""
nudge_prioritizer.py  (Phase 3: Initiative and Background Awareness)

Consumes candidate patterns (from pattern_analyzer.py) and decides which, if any,
deserve to become a nudge. Scoring:

    score = w_rel * relevance + w_urg * urgency + w_rec * receptivity

A candidate becomes a stored nudge only if it clears ALL of:
    relevance   >= 0.6
    urgency     >= 0.3
    receptivity >= 0.4
    combined    >= 2.0

and its category has not been opted out (two dismissals of a category opts it out
permanently). Quiet is the default: nothing that fails these thresholds is stored.

Survivors are upserted into the `nudges` table with status='pending'. Nudges the
user already dismissed or actioned are never resurfaced.

Standard library only. Run the full pipeline with --analyze (imports
pattern_analyzer), or pipe candidates in on stdin.

Usage:
  python3 nudge_prioritizer.py --analyze --db /data/self-model.db
  python3 pattern_analyzer.py --db X | python3 nudge_prioritizer.py --db X
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

# Thresholds (from the specification).
THR_RELEVANCE = 0.6
THR_URGENCY = 0.3
THR_RECEPTIVITY = 0.4
THR_COMBINED = 2.0

# Scoring weights (documented defaults; overridable via CLI).
W_RELEVANCE = 1.0
W_URGENCY = 1.0
W_RECEPTIVITY = 1.0

# Per-category base urgency.
CATEGORY_URGENCY = {
    "topic_recurrence": 0.5,
    "topic_abandonment": 0.4,
    "session_timing_shift": 0.3,
    "module_nonuse": 0.3,
    "query_shape_shift": 0.35,
    "tool_preference_change": 0.35,
    "proximity_to_goal": 0.7,
}

# Two dismissals of a category opts it out permanently.
OPTOUT_DISMISS_THRESHOLD = 2


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def connect(db_path):
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"self-model database not found at {db_path}")
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000;")
    return conn


def clamp01(x):
    try:
        return max(0.0, min(1.0, float(x)))
    except (TypeError, ValueError):
        return 0.0


def relevance_for(category, signals):
    s = signals or {}
    if category == "topic_recurrence":
        return clamp01(s.get("present_count", 0) / max(1, s.get("window", 5)))
    if category == "topic_abandonment":
        appeared = s.get("appeared_in_sessions", 0)
        return clamp01(0.4 + 0.1 * appeared)  # 4 sessions -> 0.8
    if category == "session_timing_shift":
        both = s.get("dow_shift") and s.get("hour_shift")
        return 0.75 if both else 0.6
    if category == "module_nonuse":
        return clamp01(0.4 + 0.07 * s.get("lifetime_sessions", 0))  # 3 -> 0.61
    if category == "query_shape_shift":
        return clamp01(0.6 + 0.1 * len(s.get("changed_fields", [])))
    if category == "tool_preference_change":
        return clamp01(abs(s.get("z_score", 0)) / 3.0)  # z=2 -> 0.67
    if category == "proximity_to_goal":
        if s.get("near_completion"):
            return 0.85
        if isinstance(s.get("relevance_score"), (int, float)):
            return clamp01(s["relevance_score"])
        return 0.7
    return 0.5


def urgency_for(category, signals):
    base = CATEGORY_URGENCY.get(category, 0.3)
    s = signals or {}
    if category == "proximity_to_goal" and s.get("near_completion"):
        base = min(1.0, base + 0.15)
    if category == "topic_abandonment":
        base = min(1.0, base + 0.02 * s.get("sessions_since_last", 0))
    return clamp01(base)


def receptivity_score(conn):
    """
    Global receptivity: how open the recipient is to a nudge right now. Starts
    high and decays with recent dismissals, so the system backs off when it has
    been unwelcome. Derived from total dismissals recorded across categories.
    """
    row = conn.execute(
        "SELECT COALESCE(SUM(dismiss_count), 0) AS total FROM nudge_optouts"
    ).fetchone()
    total_dismissals = row["total"] if row else 0
    return clamp01(0.7 - 0.1 * total_dismissals)


def opted_out_categories(conn):
    rows = conn.execute(
        "SELECT pattern_category FROM nudge_optouts WHERE opted_out = 1"
    ).fetchall()
    return {r["pattern_category"] for r in rows}


def existing_nudge(conn, pattern_id):
    return conn.execute(
        "SELECT pattern_id, status, first_detected FROM nudges WHERE pattern_id = ?",
        (pattern_id,),
    ).fetchone()


def upsert_nudge(conn, candidate, scores):
    pattern_id = candidate["pattern_id"]
    existing = existing_nudge(conn, pattern_id)
    ts = now_iso()

    if existing is not None:
        # Never resurface something the user has closed out.
        if existing["status"] in ("dismissed", "actioned"):
            return "skipped_closed"
        conn.execute(
            """
            UPDATE nudges SET
              message = ?, score = ?, relevance_score = ?, urgency_score = ?,
              receptivity_score = ?, status = 'pending', session_id = ?, updated_at = ?
            WHERE pattern_id = ?
            """,
            (candidate["message"], scores["combined"], scores["relevance"],
             scores["urgency"], scores["receptivity"], candidate.get("session_id"),
             ts, pattern_id),
        )
        return "updated"

    conn.execute(
        """
        INSERT INTO nudges
          (pattern_id, pattern_category, message, score, relevance_score,
           urgency_score, receptivity_score, status, first_detected, last_surfaced,
           dismiss_count, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, ?, ?)
        """,
        (pattern_id, candidate["category"], candidate["message"], scores["combined"],
         scores["relevance"], scores["urgency"], scores["receptivity"],
         ts, candidate.get("session_id"), ts),
    )
    return "inserted"


def prioritize(conn, candidates, weights):
    w_rel, w_urg, w_rec = weights
    opted_out = opted_out_categories(conn)
    receptivity = receptivity_score(conn)

    result = {"evaluated": len(candidates), "inserted": 0, "updated": 0,
              "skipped_threshold": 0, "skipped_optout": 0, "skipped_closed": 0,
              "receptivity": round(receptivity, 3)}

    for cand in candidates:
        category = cand.get("category")
        if category in opted_out:
            result["skipped_optout"] += 1
            continue

        relevance = relevance_for(category, cand.get("signals"))
        urgency = urgency_for(category, cand.get("signals"))
        combined = w_rel * relevance + w_urg * urgency + w_rec * receptivity

        passes = (relevance >= THR_RELEVANCE and urgency >= THR_URGENCY
                  and receptivity >= THR_RECEPTIVITY and combined >= THR_COMBINED)
        if not passes:
            result["skipped_threshold"] += 1
            continue

        scores = {"relevance": round(relevance, 3), "urgency": round(urgency, 3),
                  "receptivity": round(receptivity, 3), "combined": round(combined, 3)}
        action = upsert_nudge(conn, cand, scores)
        if action == "inserted":
            result["inserted"] += 1
        elif action == "updated":
            result["updated"] += 1
        elif action == "skipped_closed":
            result["skipped_closed"] += 1

    return result


def load_candidates(conn, use_analyzer):
    if use_analyzer:
        import pattern_analyzer
        return pattern_analyzer.detect_all(conn)
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return []
    return data.get("candidates", []) if isinstance(data, dict) else (data or [])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Score candidate patterns and store qualifying nudges.")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to self-model.db")
    parser.add_argument("--analyze", action="store_true",
                        help="Run pattern_analyzer directly instead of reading stdin.")
    parser.add_argument("--w-relevance", type=float, default=W_RELEVANCE)
    parser.add_argument("--w-urgency", type=float, default=W_URGENCY)
    parser.add_argument("--w-receptivity", type=float, default=W_RECEPTIVITY)
    parser.add_argument("--output", default=None, help="Output dir (unused; script-execute compatibility).")
    args = parser.parse_args(argv)

    try:
        conn = connect(args.db)
    except FileNotFoundError as err:
        print(json.dumps({"error": str(err)}))
        return 2

    try:
        candidates = load_candidates(conn, args.analyze)
        weights = (args.w_relevance, args.w_urgency, args.w_receptivity)
        with conn:
            summary = prioritize(conn, candidates, weights)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except sqlite3.Error as err:
        print(json.dumps({"error": f"prioritization failed: {err}"}))
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
