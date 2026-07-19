#!/usr/bin/env python3
"""
self_model_summarizer.py  (Phase 1: Self-Model Interrogation)

Generates a natural-language summary of the assistant's recent operation from the
aggregated self-model tables and writes it into self_insights with
category='summary'. This gives the self_trend intent something to report and
gives a human a readable digest.

Standard library only. Safe to run alongside the connector (WAL + busy timeout).
Run after self_model_aggregator.py so session_timing / topic_clusters are current.

Usage:
  python3 self_model_summarizer.py                      # 30-day window
  python3 self_model_summarizer.py --window-days 7
  python3 self_model_summarizer.py --db /data/self-model.db --dedup
  python3 self_model_summarizer.py --print-only         # do not write, just print
"""

import argparse
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def connect(db_path):
    if not os.path.exists(db_path):
        raise FileNotFoundError(
            f"self-model database not found at {db_path}. Run the connector (and "
            f"the aggregator) first, or pass --db."
        )
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 10000;")
    return conn


def cutoff_iso(window_days):
    ts = datetime.now(timezone.utc).timestamp() - window_days * 86400
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def top_modules(conn, cutoff, limit=3):
    return conn.execute(
        """
        SELECT ma.module_id AS module_id, SUM(ma.load_count) AS loads
        FROM module_activations ma
        JOIN session_log sl ON sl.id = ma.session_id
        WHERE sl.start_time >= ?
        GROUP BY ma.module_id
        ORDER BY loads DESC
        LIMIT ?
        """,
        (cutoff, limit),
    ).fetchall()


def top_tools(conn, cutoff, limit=3):
    return conn.execute(
        """
        SELECT tu.tool_name AS tool_name, SUM(tu.call_count) AS calls
        FROM tool_usage tu
        JOIN session_log sl ON sl.id = tu.session_id
        WHERE sl.start_time >= ?
        GROUP BY tu.tool_name
        ORDER BY calls DESC
        LIMIT ?
        """,
        (cutoff, limit),
    ).fetchall()


def top_topics(conn, cutoff, limit=3):
    return conn.execute(
        """
        SELECT tc.topic_keyword AS keyword, SUM(tc.weight) AS weight
        FROM topic_clusters tc
        JOIN session_log sl ON sl.id = tc.session_id
        WHERE sl.start_time >= ?
        GROUP BY tc.topic_keyword
        ORDER BY weight DESC
        LIMIT ?
        """,
        (cutoff, limit),
    ).fetchall()


def busiest_slot(conn, cutoff):
    row = conn.execute(
        """
        SELECT st.day_of_week AS dow, st.hour_of_day AS hour, COUNT(*) AS n
        FROM session_timing st
        JOIN session_log sl ON sl.id = st.session_id
        WHERE sl.start_time >= ?
        GROUP BY st.day_of_week, st.hour_of_day
        ORDER BY n DESC
        LIMIT 1
        """,
        (cutoff,),
    ).fetchone()
    return row


def session_count(conn, cutoff):
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM session_log WHERE start_time >= ?", (cutoff,)
    ).fetchone()
    return row["n"] if row else 0


def build_summary(conn, window_days):
    cutoff = cutoff_iso(window_days)
    sessions = session_count(conn, cutoff)
    modules = top_modules(conn, cutoff)
    tools = top_tools(conn, cutoff)
    topics = top_topics(conn, cutoff)
    slot = busiest_slot(conn, cutoff)

    parts = [f"Over the last {window_days} days there were {sessions} session(s)."]

    if modules:
        mod_str = ", ".join(f"{r['module_id']} ({r['loads']})" for r in modules)
        parts.append(f"Most active modules: {mod_str}.")
    if tools:
        tool_str = ", ".join(f"{r['tool_name']} ({r['calls']})" for r in tools)
        parts.append(f"Most used tools: {tool_str}.")
    if topics:
        topic_str = ", ".join(r["keyword"] for r in topics)
        parts.append(f"Recurring topics: {topic_str}.")
    if slot is not None and slot["dow"] is not None:
        dow_name = DOW_NAMES[slot["dow"]] if 0 <= slot["dow"] < 7 else str(slot["dow"])
        parts.append(f"Busiest slot: {dow_name} around {slot['hour']:02d}:00 UTC.")

    if len(parts) == 1:
        parts.append("No module, tool or topic activity recorded in the window yet.")

    return " ".join(parts)


def recent_identical_summary(conn, text, hours=24):
    ts = datetime.now(timezone.utc).timestamp() - hours * 3600
    since = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    row = conn.execute(
        """
        SELECT 1 FROM self_insights
        WHERE category = 'summary' AND insight_text = ? AND created_at >= ?
        LIMIT 1
        """,
        (text, since),
    ).fetchone()
    return row is not None


def write_summary(conn, text):
    conn.execute(
        """
        INSERT INTO self_insights (session_id, insight_text, category, source_module, created_at)
        VALUES (NULL, ?, 'summary', 'self_model_summarizer', ?)
        """,
        (text, datetime.now(timezone.utc).isoformat()),
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Generate a natural-language self-model summary into self_insights."
    )
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to self-model.db")
    parser.add_argument("--window-days", type=int, default=30, help="Look-back window in days.")
    parser.add_argument(
        "--dedup",
        action="store_true",
        help="Skip writing if an identical summary was written in the last 24h.",
    )
    parser.add_argument(
        "--print-only", action="store_true", help="Print the summary without writing it."
    )
    parser.add_argument("--verbose", action="store_true", help="Debug logging.")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] self_model_summarizer: %(message)s",
    )

    if args.window_days < 1:
        logging.error("--window-days must be >= 1")
        return 2

    try:
        conn = connect(args.db)
    except FileNotFoundError as err:
        logging.error(str(err))
        return 2
    except sqlite3.Error as err:
        logging.error("failed to open database: %s", err)
        return 2

    try:
        summary = build_summary(conn, args.window_days)
        logging.info("summary: %s", summary)

        if args.print_only:
            print(summary)
            return 0

        with conn:
            if args.dedup and recent_identical_summary(conn, summary):
                logging.info("identical summary already written in last 24h; skipping (--dedup).")
                return 0
            write_summary(conn, summary)
        logging.info("summary written to self_insights (category=summary).")
        return 0
    except sqlite3.Error as err:
        logging.error("summarisation failed, changes rolled back: %s", err)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
