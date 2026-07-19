#!/usr/bin/env python3
"""
student_model.py  (Phase 4: Socratic Tutor Mode)

Builds and maintains a cross-session map of what the recipient understands. Each
concept carries a confidence point estimate with an uncertainty interval, an
evidence count, and optional relational hints (adjacent_to, conflicts_with) used
by seam detection.

Confidence updates are Bayesian-style: each observation nudges the estimate
toward the observed signal, weighted by evidence count and source (an explicit
confirmation counts for more than an inferred read). Uncertainty shrinks as
evidence accumulates. Time decay pulls stale, low-confidence estimates back
toward a neutral prior faster than well-established ones, per the Phase 4 risk
mitigation.

Standard library only. Usable as a library (imported by seam_detection.py) or via
CLI.

CLI:
  student_model.py --observe --concept "recursion" --signal partial --source inferred
  student_model.py --observe --concept "recursion" --signal 0.9 --source explicit
  student_model.py --relate --concept "recursion" --adjacent-to "induction"
  student_model.py --decay
  student_model.py --dump
  student_model.py --export-confidence
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

PRIOR_CONFIDENCE = 0.3          # neutral prior stale estimates decay toward
DECAY_BASE_PER_DAY = 0.005      # baseline daily pull toward prior
SOURCE_WEIGHT = {"explicit": 3.0, "inferred": 1.0}

SIGNAL_VALUES = {
    "mastered": 0.9,
    "confident": 0.85,
    "partial": 0.55,
    "unsure": 0.35,
    "struggled": 0.2,
    "incorrect": 0.1,
}


def now_dt():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat()


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


def signal_to_value(signal):
    """Map a qualitative signal or a numeric string to a target confidence 0..1."""
    if signal is None:
        return None
    if isinstance(signal, (int, float)):
        return clamp01(signal)
    s = str(signal).strip().lower()
    if s in SIGNAL_VALUES:
        return SIGNAL_VALUES[s]
    try:
        return clamp01(float(s))
    except ValueError:
        return None


def _interval(confidence, observations):
    """Uncertainty half-width shrinks with evidence."""
    hw = 0.5 / math.sqrt(observations + 1.0)
    return max(0.0, confidence - hw), min(1.0, confidence + hw)


def _load_seam_scores(row):
    if not row or row["seam_scores"] is None:
        return {}
    try:
        return json.loads(row["seam_scores"]) or {}
    except (ValueError, TypeError):
        return {}


def get_concept(conn, concept):
    return conn.execute("SELECT * FROM student_model WHERE concept = ?", (concept,)).fetchone()


def observe(conn, concept, signal, source="inferred", domain=None):
    """Apply a single observation to a concept using a weighted Bayesian update."""
    concept = (concept or "").strip()
    if not concept:
        raise ValueError("concept is required")
    target = signal_to_value(signal)
    if target is None:
        raise ValueError(f"unrecognised signal: {signal!r}")

    weight = SOURCE_WEIGHT.get((source or "inferred").lower(), 1.0)
    ts = iso(now_dt())
    existing = get_concept(conn, concept)

    if existing is None:
        confidence = target
        observations = weight
        lower, upper = _interval(confidence, observations)
        conn.execute(
            """
            INSERT INTO student_model
              (concept, confidence, confidence_lower, confidence_upper, observations,
               source, domain, seam_scores, first_seen, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (concept, confidence, lower, upper, observations,
             (source or "inferred").lower(), domain, ts, ts),
        )
    else:
        prior_conf = existing["confidence"]
        prior_obs = existing["observations"]
        # Weighted running mean: evidence-count Bayesian blend.
        confidence = (prior_conf * prior_obs + target * weight) / (prior_obs + weight)
        observations = prior_obs + weight
        lower, upper = _interval(confidence, observations)
        new_domain = domain if domain is not None else existing["domain"]
        conn.execute(
            """
            UPDATE student_model SET
              confidence = ?, confidence_lower = ?, confidence_upper = ?,
              observations = ?, source = CASE WHEN ? = 'explicit' THEN 'explicit' ELSE source END,
              domain = ?, last_updated = ?
            WHERE concept = ?
            """,
            (confidence, lower, upper, observations,
             (source or "inferred").lower(), new_domain, ts, concept),
        )
    return {"concept": concept, "confidence": round(confidence, 3),
            "observations": observations, "interval": [round(lower, 3), round(upper, 3)]}


def _apply_relation(conn, concept, adjacent_to, conflicts_with, ts):
    """Add relational hints to a single concept, creating it if needed."""
    concept = (concept or "").strip()
    if not concept:
        return None
    existing = get_concept(conn, concept)
    if existing is None:
        lower, upper = _interval(PRIOR_CONFIDENCE, 0)
        conn.execute(
            """
            INSERT INTO student_model
              (concept, confidence, confidence_lower, confidence_upper, observations,
               source, domain, seam_scores, first_seen, last_updated)
            VALUES (?, ?, ?, ?, 0, 'inferred', NULL, NULL, ?, ?)
            """,
            (concept, PRIOR_CONFIDENCE, lower, upper, ts, ts),
        )
        existing = get_concept(conn, concept)

    scores = _load_seam_scores(existing)
    if adjacent_to:
        adj = set(scores.get("adjacent_to", []))
        adj.add(adjacent_to.strip())
        scores["adjacent_to"] = sorted(adj)
    if conflicts_with:
        con = set(scores.get("conflicts_with", []))
        con.add(conflicts_with.strip())
        scores["conflicts_with"] = sorted(con)
    conn.execute("UPDATE student_model SET seam_scores = ?, last_updated = ? WHERE concept = ?",
                 (json.dumps(scores), ts, concept))
    return scores


def relate(conn, concept, adjacent_to=None, conflicts_with=None):
    """Record relational hints. adjacency and conflict are mutual, so the reverse
    relation is written to the other concept as well."""
    concept = (concept or "").strip()
    if not concept:
        raise ValueError("concept is required")
    ts = iso(now_dt())

    scores = _apply_relation(conn, concept, adjacent_to, conflicts_with, ts)
    # Symmetric back-links.
    if adjacent_to:
        _apply_relation(conn, adjacent_to.strip(), concept, None, ts)
    if conflicts_with:
        _apply_relation(conn, conflicts_with.strip(), None, concept, ts)
    return {"concept": concept, "seam_scores": scores}


def decay(conn, now=None):
    """Pull stale estimates toward the prior; low-confidence decays faster."""
    now = now or now_dt()
    updated = 0
    for row in conn.execute("SELECT * FROM student_model").fetchall():
        try:
            last = datetime.fromisoformat(row["last_updated"])
        except (ValueError, TypeError):
            continue
        days = max(0.0, (now - last).total_seconds() / 86400.0)
        if days < 1.0:
            continue
        conf = row["confidence"]
        # Low confidence estimates decay faster: rate scales with (1 - conf).
        rate = DECAY_BASE_PER_DAY * (1.0 + (1.0 - conf))
        factor = max(0.0, 1.0 - rate * days)
        decayed = PRIOR_CONFIDENCE + (conf - PRIOR_CONFIDENCE) * factor
        # Uncertainty widens with staleness.
        base_lower, base_upper = _interval(decayed, row["observations"])
        widen = min(0.25, 0.002 * days)
        lower = max(0.0, base_lower - widen)
        upper = min(1.0, base_upper + widen)
        conn.execute(
            "UPDATE student_model SET confidence = ?, confidence_lower = ?, confidence_upper = ? WHERE concept = ?",
            (decayed, lower, upper, row["concept"]),
        )
        updated += 1
    return {"decayed": updated}


def get_model(conn):
    """Return the full student model as a list of dicts (for seam detection)."""
    out = []
    for row in conn.execute("SELECT * FROM student_model").fetchall():
        rec = dict(row)
        rec["seam_scores"] = _load_seam_scores(row)
        out.append(rec)
    return out


def export_confidence_by_domain(conn):
    """Aggregate mean confidence per domain for state-vector carryover (Phase 2)."""
    agg = {}
    for row in conn.execute(
        "SELECT domain, confidence FROM student_model WHERE domain IS NOT NULL"
    ).fetchall():
        agg.setdefault(row["domain"], []).append(row["confidence"])
    return {d: round(sum(v) / len(v), 3) for d, v in agg.items() if v}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build and maintain the student model.")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--relate", action="store_true")
    parser.add_argument("--decay", action="store_true")
    parser.add_argument("--dump", action="store_true")
    parser.add_argument("--export-confidence", action="store_true")
    parser.add_argument("--concept")
    parser.add_argument("--signal")
    parser.add_argument("--source", default="inferred", choices=["inferred", "explicit"])
    parser.add_argument("--domain", default=None)
    parser.add_argument("--adjacent-to", default=None)
    parser.add_argument("--conflicts-with", default=None)
    parser.add_argument("--output", default=None)  # script-execute compatibility
    args = parser.parse_args(argv)

    try:
        conn = connect(args.db)
    except FileNotFoundError as err:
        print(json.dumps({"error": str(err)}))
        return 2

    try:
        with conn:
            if args.observe:
                result = observe(conn, args.concept, args.signal, args.source, args.domain)
                print(json.dumps({"ok": True, "observed": result}, ensure_ascii=False))
            elif args.relate:
                result = relate(conn, args.concept, args.adjacent_to, args.conflicts_with)
                print(json.dumps({"ok": True, "related": result}, ensure_ascii=False))
            elif args.decay:
                print(json.dumps({"ok": True, **decay(conn)}, ensure_ascii=False))
            elif args.export_confidence:
                print(json.dumps({"ok": True, "confidence_by_domain": export_confidence_by_domain(conn)}, ensure_ascii=False))
            else:  # dump
                print(json.dumps({"ok": True, "student_model": get_model(conn)}, ensure_ascii=False))
        return 0
    except (ValueError, sqlite3.Error) as err:
        print(json.dumps({"ok": False, "error": str(err)}))
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
