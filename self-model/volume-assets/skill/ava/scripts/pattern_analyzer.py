#!/usr/bin/env python3
"""
pattern_analyzer.py  (Phase 3: Initiative and Background Awareness)

Runs at session close (or on a schedule). Reads the self-model database and runs
seven pattern detectors over the recorded history. Each detector returns zero or
more candidate patterns; a candidate carries a stable pattern_id, a category, a
human-readable message, and a `signals` object of raw numbers that the
prioritiser uses to score relevance / urgency / receptivity.

This script only DETECTS. It does not score, store, or surface anything. The
prioritiser (nudge_prioritizer.py) consumes these candidates.

Standard library only. Emits a JSON array of candidates to stdout when run
directly; importable as a module (detect_all) by the prioritiser.

Usage:
  python3 pattern_analyzer.py --db /data/self-model.db
  python3 pattern_analyzer.py            # uses SELF_MODEL_DB_PATH or default
"""

import argparse
import json
import os
import sqlite3
import statistics
import sys
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

# Detector category names (must match nudge_prioritizer.py and the nudges table).
CAT_TOPIC_RECURRENCE = "topic_recurrence"
CAT_TOPIC_ABANDONMENT = "topic_abandonment"
CAT_SESSION_TIMING = "session_timing_shift"
CAT_MODULE_NONUSE = "module_nonuse"
CAT_QUERY_SHAPE = "query_shape_shift"
CAT_TOOL_PREFERENCE = "tool_preference_change"
CAT_PROXIMITY_GOAL = "proximity_to_goal"


def connect(db_path):
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"self-model database not found at {db_path}")
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000;")
    return conn


def _recent_session_ids(conn, limit):
    rows = conn.execute(
        "SELECT id FROM session_log ORDER BY start_time DESC LIMIT ?", (limit,)
    ).fetchall()
    return [r["id"] for r in rows]


def _all_session_ids_ordered(conn):
    rows = conn.execute("SELECT id FROM session_log ORDER BY start_time DESC").fetchall()
    return [r["id"] for r in rows]


# ---------------------------------------------------------------------------
# Detector 1: Topic recurrence
#   Same topic keyword appears in >= 3 of the last 5 sessions with an increasing
#   frequency trend.
# ---------------------------------------------------------------------------
def detect_topic_recurrence(conn):
    out = []
    recent = _recent_session_ids(conn, 5)
    if len(recent) < 3:
        return out
    # oldest-first for trend
    ordered = list(reversed(recent))
    placeholders = ",".join("?" for _ in ordered)
    rows = conn.execute(
        f"SELECT session_id, topic_keyword, weight FROM topic_clusters "
        f"WHERE session_id IN ({placeholders})",
        ordered,
    ).fetchall()
    by_keyword = {}
    for r in rows:
        by_keyword.setdefault(r["topic_keyword"], {})[r["session_id"]] = r["weight"] or 0

    for keyword, per_session in by_keyword.items():
        present_count = sum(1 for sid in ordered if sid in per_session)
        if present_count < 3:
            continue
        weights = [per_session.get(sid, 0) for sid in ordered]
        # increasing trend: last present weight > first present weight
        present_weights = [w for w in weights if w > 0]
        increasing = len(present_weights) >= 2 and present_weights[-1] > present_weights[0]
        if not increasing:
            continue
        out.append({
            "pattern_id": f"{CAT_TOPIC_RECURRENCE}:{keyword}",
            "category": CAT_TOPIC_RECURRENCE,
            "message": f"'{keyword}' has come up in {present_count} of the last 5 sessions and is trending up. Worth a dedicated pass?",
            "signals": {
                "present_count": present_count,
                "window": 5,
                "first_weight": present_weights[0],
                "last_weight": present_weights[-1],
            },
        })
    return out


# ---------------------------------------------------------------------------
# Detector 2: Topic abandonment
#   A topic that appeared in >= 4 sessions is now absent for >= 8 sessions.
# ---------------------------------------------------------------------------
def detect_topic_abandonment(conn):
    out = []
    ordered_desc = _all_session_ids_ordered(conn)  # newest first
    if len(ordered_desc) < 8:
        return out
    index_of = {sid: i for i, sid in enumerate(ordered_desc)}  # 0 = newest

    rows = conn.execute(
        "SELECT session_id, topic_keyword FROM topic_clusters"
    ).fetchall()
    sessions_by_keyword = {}
    for r in rows:
        if r["session_id"] in index_of:
            sessions_by_keyword.setdefault(r["topic_keyword"], set()).add(r["session_id"])

    for keyword, sids in sessions_by_keyword.items():
        if len(sids) < 4:
            continue
        # most recent appearance index (0 = newest)
        most_recent_idx = min(index_of[s] for s in sids)
        if most_recent_idx >= 8:
            out.append({
                "pattern_id": f"{CAT_TOPIC_ABANDONMENT}:{keyword}",
                "category": CAT_TOPIC_ABANDONMENT,
                "message": f"'{keyword}' was active across {len(sids)} sessions but hasn't come up in the last {most_recent_idx}. Dropped on purpose, or fell through?",
                "signals": {
                    "appeared_in_sessions": len(sids),
                    "sessions_since_last": most_recent_idx,
                },
            })
    return out


# ---------------------------------------------------------------------------
# Detector 3: Session timing shift
#   The modal day-of-week or hour-of-day of recent sessions differs from the
#   older baseline.
# ---------------------------------------------------------------------------
def _mode_or_none(values):
    if not values:
        return None
    try:
        return statistics.mode(values)
    except statistics.StatisticsError:
        return values[0]


def detect_session_timing_shift(conn):
    out = []
    rows = conn.execute(
        "SELECT st.day_of_week AS dow, st.hour_of_day AS hour "
        "FROM session_timing st JOIN session_log sl ON sl.id = st.session_id "
        "ORDER BY sl.start_time DESC"
    ).fetchall()
    if len(rows) < 8:
        return out
    recent = rows[:4]
    baseline = rows[4:]
    r_dow = _mode_or_none([r["dow"] for r in recent if r["dow"] is not None])
    b_dow = _mode_or_none([r["dow"] for r in baseline if r["dow"] is not None])
    r_hour = _mode_or_none([r["hour"] for r in recent if r["hour"] is not None])
    b_hour = _mode_or_none([r["hour"] for r in baseline if r["hour"] is not None])

    dow_shift = r_dow is not None and b_dow is not None and r_dow != b_dow
    hour_shift = r_hour is not None and b_hour is not None and abs(r_hour - b_hour) >= 3

    if dow_shift or hour_shift:
        out.append({
            "pattern_id": f"{CAT_SESSION_TIMING}:current",
            "category": CAT_SESSION_TIMING,
            "message": "The rhythm of when we work has shifted recently compared with before.",
            "signals": {
                "recent_dow": r_dow, "baseline_dow": b_dow,
                "recent_hour": r_hour, "baseline_hour": b_hour,
                "dow_shift": dow_shift, "hour_shift": hour_shift,
            },
        })
    return out


# ---------------------------------------------------------------------------
# Detector 4: Module non-use
#   A module loaded in >= 3 sessions historically has 0 activations in the last
#   10 sessions.
# ---------------------------------------------------------------------------
def detect_module_nonuse(conn):
    out = []
    ordered_desc = _all_session_ids_ordered(conn)
    if len(ordered_desc) < 10:
        return out
    recent10 = set(ordered_desc[:10])

    rows = conn.execute(
        "SELECT module_id, session_id FROM module_activations"
    ).fetchall()
    sessions_by_module = {}
    for r in rows:
        sessions_by_module.setdefault(r["module_id"], set()).add(r["session_id"])

    for module_id, sids in sessions_by_module.items():
        if len(sids) < 3:
            continue
        if sids.isdisjoint(recent10):
            out.append({
                "pattern_id": f"{CAT_MODULE_NONUSE}:{module_id}",
                "category": CAT_MODULE_NONUSE,
                "message": f"The '{module_id}' module used to load regularly but hasn't in the last 10 sessions. Still needed?",
                "signals": {
                    "lifetime_sessions": len(sids),
                    "recent_window": 10,
                },
            })
    return out


# ---------------------------------------------------------------------------
# Detector 5: Query shape shift
#   Preferred depth or register (from the two most recent state vectors' derived
#   query_shape_observations) changed beyond a delta.
# ---------------------------------------------------------------------------
def _load_recent_state_vectors(conn, limit=2):
    rows = conn.execute(
        "SELECT insight_text FROM self_insights WHERE category = 'state_vector' "
        "ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    vectors = []
    for r in rows:
        try:
            vectors.append(json.loads(r["insight_text"]))
        except (ValueError, TypeError):
            continue
    return vectors


def detect_query_shape_shift(conn):
    out = []
    vectors = _load_recent_state_vectors(conn, 2)
    if len(vectors) < 2:
        return out
    newest, prev = vectors[0], vectors[1]
    nqs = newest.get("query_shape_observations") or {}
    pqs = prev.get("query_shape_observations") or {}

    changed_fields = []
    for field in ("preferred_depth", "preferred_register"):
        if field in nqs and field in pqs and nqs[field] != pqs[field]:
            changed_fields.append(field)
    # numeric shift in topic_shift_rate
    rate_shift = None
    if isinstance(nqs.get("topic_shift_rate"), (int, float)) and isinstance(pqs.get("topic_shift_rate"), (int, float)):
        rate_shift = abs(nqs["topic_shift_rate"] - pqs["topic_shift_rate"])
        if rate_shift >= 0.2:
            changed_fields.append("topic_shift_rate")

    if changed_fields:
        out.append({
            "pattern_id": f"{CAT_QUERY_SHAPE}:current",
            "category": CAT_QUERY_SHAPE,
            "message": "How you're asking has shifted lately (depth or breadth of questions). I can adjust how I pitch answers.",
            "signals": {
                "changed_fields": changed_fields,
                "topic_shift_delta": rate_shift,
            },
        })
    return out


# ---------------------------------------------------------------------------
# Detector 6: Tool preference change
#   A tool's recent call share deviates beyond 2 standard deviations from its
#   historical per-session mean.
# ---------------------------------------------------------------------------
def detect_tool_preference_change(conn):
    out = []
    ordered_desc = _all_session_ids_ordered(conn)
    if len(ordered_desc) < 6:
        return out
    recent = set(ordered_desc[:3])
    baseline = ordered_desc[3:]
    if len(baseline) < 3:
        return out

    rows = conn.execute("SELECT session_id, tool_name, call_count FROM tool_usage").fetchall()
    # per-session per-tool counts
    per_session = {}
    tools = set()
    for r in rows:
        per_session.setdefault(r["session_id"], {})[r["tool_name"]] = r["call_count"]
        tools.add(r["tool_name"])

    for tool in tools:
        baseline_counts = [per_session.get(s, {}).get(tool, 0) for s in baseline]
        recent_counts = [per_session.get(s, {}).get(tool, 0) for s in recent]
        if len(baseline_counts) < 3:
            continue
        mean = statistics.fmean(baseline_counts)
        stdev = statistics.pstdev(baseline_counts)
        if stdev == 0:
            continue
        recent_mean = statistics.fmean(recent_counts) if recent_counts else 0
        z = (recent_mean - mean) / stdev
        if abs(z) >= 2.0:
            direction = "more" if z > 0 else "less"
            out.append({
                "pattern_id": f"{CAT_TOOL_PREFERENCE}:{tool}",
                "category": CAT_TOOL_PREFERENCE,
                "message": f"You're leaning on '{tool}' notably {direction} than usual lately.",
                "signals": {
                    "tool": tool, "z_score": round(z, 2),
                    "baseline_mean": round(mean, 2), "recent_mean": round(recent_mean, 2),
                },
            })
    return out


# ---------------------------------------------------------------------------
# Detector 7: Proximity-to-goal
#   An open project has persisted across sessions with a concrete next action:
#   a candidate to close it out.
# ---------------------------------------------------------------------------
def detect_proximity_to_goal(conn):
    out = []
    vectors = _load_recent_state_vectors(conn, 1)
    if not vectors:
        return out
    vector = vectors[0]
    projects = vector.get("open_projects") or []
    threads = vector.get("cross_session_threads") or []

    for p in projects:
        if not isinstance(p, dict):
            continue
        next_action = p.get("next_action")
        title = p.get("title") or p.get("project_id") or "an open project"
        phase = (p.get("phase") or "").lower()
        near = any(k in phase for k in ("final", "review", "implementation", "closing", "last"))
        if next_action and (near or True):
            out.append({
                "pattern_id": f"{CAT_PROXIMITY_GOAL}:{p.get('project_id') or title}",
                "category": CAT_PROXIMITY_GOAL,
                "message": f"'{title}' looks close to done. Next step noted: {next_action}. Want to push it over the line?",
                "signals": {
                    "phase": p.get("phase"),
                    "near_completion": near,
                    "has_next_action": True,
                },
            })

    for th in threads:
        if not isinstance(th, dict):
            continue
        rel = th.get("relevance_score")
        if isinstance(rel, (int, float)) and rel >= 0.7:
            title = th.get("title") or th.get("thread_id") or "an open thread"
            out.append({
                "pattern_id": f"{CAT_PROXIMITY_GOAL}:thread:{th.get('thread_id') or title}",
                "category": CAT_PROXIMITY_GOAL,
                "message": f"The thread '{title}' is still live and high-relevance but hasn't been closed.",
                "signals": {"relevance_score": rel, "near_completion": False, "has_next_action": False},
            })
    return out


DETECTORS = [
    detect_topic_recurrence,
    detect_topic_abandonment,
    detect_session_timing_shift,
    detect_module_nonuse,
    detect_query_shape_shift,
    detect_tool_preference_change,
    detect_proximity_to_goal,
]


def detect_all(conn):
    """Run all detectors and return a flat list of candidate patterns."""
    candidates = []
    for detector in DETECTORS:
        try:
            candidates.extend(detector(conn) or [])
        except sqlite3.Error as err:
            # A single detector failing must not sink the whole analysis.
            print(f"[pattern_analyzer] detector {detector.__name__} failed: {err}", file=sys.stderr)
    for c in candidates:
        c.setdefault("detected_at", datetime.now(timezone.utc).isoformat())
    return candidates


def main(argv=None):
    parser = argparse.ArgumentParser(description="Detect self-model patterns (candidates only).")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to self-model.db")
    parser.add_argument("--output", default=None, help="Output dir (unused; for script-execute compatibility).")
    args = parser.parse_args(argv)

    try:
        conn = connect(args.db)
    except FileNotFoundError as err:
        print(json.dumps({"error": str(err), "candidates": []}))
        return 2

    try:
        candidates = detect_all(conn)
        print(json.dumps({"candidates": candidates}, ensure_ascii=False))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
