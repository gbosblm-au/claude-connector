#!/usr/bin/env python3
"""
self_model_aggregator.py  (Phase 1: Self-Model Interrogation)

Reads the raw session records written by the connector and populates the derived
tables of the self-model database:

  - session_timing : day_of_week / hour_of_day / duration_minutes per session,
                     derived from session_log start_time and end_time.
  - topic_clusters : topic keyword weights per session, derived from
                     session_log.topic_summary.

Optionally archives (prunes) raw per-turn detail older than a retention window,
so session-open query performance does not degrade over time. Archival is a
dry-run by default; pass --apply to actually delete.

Standard library only (sqlite3, argparse, datetime, logging, re). Safe to run
concurrently with the Node connector: opens in WAL mode with a busy timeout.

Usage:
  python3 self_model_aggregator.py                     # aggregate, no archival
  python3 self_model_aggregator.py --archive-days 90 --apply
  python3 self_model_aggregator.py --db /data/self-model.db
"""

import argparse
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

# Minimal English stopword set for topic keyword extraction. Deliberately small
# and self-contained; no external NLP dependency.
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "at", "by", "from", "up", "about", "into", "over", "after", "is", "are",
    "was", "were", "be", "been", "being", "it", "its", "this", "that", "these",
    "those", "we", "i", "you", "he", "she", "they", "them", "his", "her", "our",
    "your", "as", "so", "if", "then", "than", "too", "very", "can", "will",
    "just", "not", "no", "do", "did", "done", "have", "has", "had", "session",
    "sessions", "worked", "work", "update", "updated", "using", "used", "use",
}

KEYWORD_RE = re.compile(r"[a-z0-9][a-z0-9\-_]{2,}")


def parse_iso(ts):
    """Parse an ISO-8601 timestamp (with or without trailing Z) to aware UTC."""
    if not ts:
        return None
    try:
        s = ts.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def connect(db_path):
    if not os.path.exists(db_path):
        raise FileNotFoundError(
            f"self-model database not found at {db_path}. "
            f"It is created by the connector on first boot; run this after the "
            f"connector has started at least once, or pass --db."
        )
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 10000;")
    return conn


def aggregate_session_timing(conn):
    """Derive session_timing rows from session_log. Returns count updated."""
    rows = conn.execute(
        "SELECT id, start_time, end_time FROM session_log"
    ).fetchall()
    updated = 0
    for row in rows:
        start = parse_iso(row["start_time"])
        if start is None:
            continue
        end = parse_iso(row["end_time"]) or start
        duration_minutes = max(0, int(round((end - start).total_seconds() / 60.0)))
        # Sunday=0 .. Saturday=6, matching the Node writer's getUTCDay().
        day_of_week = start.isoweekday() % 7
        hour_of_day = start.hour
        conn.execute(
            """
            INSERT INTO session_timing (session_id, day_of_week, hour_of_day, duration_minutes)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              day_of_week = excluded.day_of_week,
              hour_of_day = excluded.hour_of_day,
              duration_minutes = excluded.duration_minutes
            """,
            (row["id"], day_of_week, hour_of_day, duration_minutes),
        )
        updated += 1
    return updated


def extract_keywords(text):
    """Return {keyword: count} from a free-text summary."""
    counts = {}
    for match in KEYWORD_RE.findall((text or "").lower()):
        if match in STOPWORDS:
            continue
        counts[match] = counts.get(match, 0) + 1
    return counts


def aggregate_topic_clusters(conn):
    """Derive topic_clusters rows from session_log.topic_summary. Returns count."""
    rows = conn.execute(
        "SELECT id, topic_summary FROM session_log WHERE topic_summary IS NOT NULL AND topic_summary != ''"
    ).fetchall()
    written = 0
    for row in rows:
        keywords = extract_keywords(row["topic_summary"])
        for keyword, weight in keywords.items():
            conn.execute(
                """
                INSERT INTO topic_clusters (session_id, topic_keyword, weight)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id, topic_keyword) DO UPDATE SET
                  weight = excluded.weight
                """,
                (row["id"], keyword, float(weight)),
            )
            written += 1
    return written


def archive_old_detail(conn, archive_days, apply_changes):
    """
    Prune raw per-turn detail (module_activations, tool_usage) for sessions whose
    start_time is older than the retention window. session_log, session_timing,
    topic_clusters and self_insights are retained as the compressed record.
    Returns a dict describing what was (or would be) removed.
    """
    if archive_days is None or archive_days <= 0:
        return {"enabled": False}

    cutoff = datetime.now(timezone.utc).timestamp() - archive_days * 86400
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()

    old_sessions = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM session_log WHERE start_time < ?", (cutoff_iso,)
        ).fetchall()
    ]
    if not old_sessions:
        return {"enabled": True, "cutoff": cutoff_iso, "sessions": 0, "applied": apply_changes}

    placeholders = ",".join("?" for _ in old_sessions)
    ma_count = conn.execute(
        f"SELECT COUNT(*) AS c FROM module_activations WHERE session_id IN ({placeholders})",
        old_sessions,
    ).fetchone()["c"]
    tu_count = conn.execute(
        f"SELECT COUNT(*) AS c FROM tool_usage WHERE session_id IN ({placeholders})",
        old_sessions,
    ).fetchone()["c"]

    if apply_changes:
        conn.execute(
            f"DELETE FROM module_activations WHERE session_id IN ({placeholders})", old_sessions
        )
        conn.execute(
            f"DELETE FROM tool_usage WHERE session_id IN ({placeholders})", old_sessions
        )

    return {
        "enabled": True,
        "cutoff": cutoff_iso,
        "sessions": len(old_sessions),
        "module_activation_rows": ma_count,
        "tool_usage_rows": tu_count,
        "applied": apply_changes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Aggregate self-model raw records into derived tables."
    )
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to self-model.db")
    parser.add_argument(
        "--archive-days",
        type=int,
        default=0,
        help="Prune raw per-turn detail older than N days (0 disables archival).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete archived rows (default is a dry-run).",
    )
    parser.add_argument("--verbose", action="store_true", help="Debug logging.")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] self_model_aggregator: %(message)s",
    )

    try:
        conn = connect(args.db)
    except FileNotFoundError as err:
        logging.error(str(err))
        return 2
    except sqlite3.Error as err:
        logging.error("failed to open database: %s", err)
        return 2

    try:
        with conn:  # single transaction; commits on success, rolls back on error
            timing_updated = aggregate_session_timing(conn)
            topics_written = aggregate_topic_clusters(conn)
            archive_result = archive_old_detail(conn, args.archive_days, args.apply)
        logging.info("session_timing rows updated: %d", timing_updated)
        logging.info("topic_clusters rows written: %d", topics_written)
        if archive_result.get("enabled"):
            logging.info(
                "archival (%s): %d old sessions, %s module_activation rows, %s tool_usage rows, cutoff=%s",
                "applied" if archive_result.get("applied") else "dry-run",
                archive_result.get("sessions", 0),
                archive_result.get("module_activation_rows", 0),
                archive_result.get("tool_usage_rows", 0),
                archive_result.get("cutoff"),
            )
        else:
            logging.info("archival disabled (use --archive-days N)")
        return 0
    except sqlite3.Error as err:
        logging.error("aggregation failed, changes rolled back: %s", err)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
