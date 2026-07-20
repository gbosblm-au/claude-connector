#!/usr/bin/env python3
"""
store.py  (Phase 6: dual-write rollout support)

Lets the tested SQLite-based student-model and seam logic run unchanged while the
authoritative store moves to Postgres. The trick: when Postgres is authoritative
(Stages 3-4), hydrate an ephemeral in-memory SQLite from the gateway, run the same
pure functions against it, then push the changed rows back to the gateway. When
SQLite is authoritative (Stages 0-2), the on-disk database is used directly and
the gateway receives a mirror copy.

Standard library only. Imported by student_model.py and seam_detection.py.
"""

import sqlite3

import self_model_gateway as smgw

# Minimal DDL for the tables the student-model / seam pipeline reads. Mirrors the
# columns of the connector's self-model SQLite schema that these scripts use.
STUDENT_MODEL_DDL = """
CREATE TABLE IF NOT EXISTS student_model (
  concept          TEXT PRIMARY KEY,
  confidence       REAL NOT NULL DEFAULT 0.0,
  confidence_lower REAL NOT NULL DEFAULT 0.0,
  confidence_upper REAL NOT NULL DEFAULT 1.0,
  observations     INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'inferred',
  domain           TEXT DEFAULT NULL,
  seam_scores      TEXT DEFAULT NULL,
  first_seen       TEXT NOT NULL,
  last_updated     TEXT NOT NULL
);
"""

TOPIC_CLUSTERS_DDL = """
CREATE TABLE IF NOT EXISTS topic_clusters (
  session_id    TEXT,
  topic_keyword TEXT
);
"""


def _pg_model_row_to_sqlite(row):
    import json
    seam = row.get("seam_scores")
    if isinstance(seam, (dict, list)):
        seam = json.dumps(seam)
    lower = row.get("confidence_lower", 0.0)
    upper = row.get("confidence_upper", 1.0)
    return {
        "concept": row.get("concept_id") or row.get("concept"),
        "confidence": row.get("confidence", 0.0),
        "confidence_lower": lower if lower is not None else 0.0,
        "confidence_upper": upper if upper is not None else 1.0,
        "observations": int(row.get("observations") or 0),
        "source": row.get("source") or "inferred",
        "domain": row.get("domain"),
        "seam_scores": seam,
        "first_seen": row.get("updated_at") or "1970-01-01T00:00:00+00:00",
        "last_updated": row.get("updated_at") or "1970-01-01T00:00:00+00:00",
    }


def hydrate_inmemory(gateway, concepts=None, with_topics=False):
    """Build an in-memory SQLite hydrated from the gateway. Returns (conn, ok)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(STUDENT_MODEL_DDL + TOPIC_CLUSTERS_DDL)

    rows = gateway.read_student_model(limit=1000)
    if rows is None:
        return conn, False  # gateway unreachable; caller decides on fallback
    wanted = set(concepts) if concepts else None
    for r in rows:
        rec = _pg_model_row_to_sqlite(r)
        if wanted is not None and rec["concept"] not in wanted:
            continue
        conn.execute(
            """INSERT OR REPLACE INTO student_model
               (concept, confidence, confidence_lower, confidence_upper, observations,
                source, domain, seam_scores, first_seen, last_updated)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rec["concept"], rec["confidence"], rec["confidence_lower"], rec["confidence_upper"],
             rec["observations"], rec["source"], rec["domain"], rec["seam_scores"],
             rec["first_seen"], rec["last_updated"]),
        )

    if with_topics:
        topics = gateway.read_topic_rows(limit=2000)
        for t in (topics or []):
            conn.execute("INSERT INTO topic_clusters (session_id, topic_keyword) VALUES (?,?)",
                         (t.get("session_id"), t.get("topic_keyword")))
    conn.commit()
    return conn, True


def mirror_concepts(conn, gateway, concept_names):
    """Read the named concepts from the SQLite conn and upsert them to the gateway."""
    if not concept_names:
        return {"gateway": "skipped"}
    payloads = []
    placeholders = ",".join("?" for _ in concept_names)
    for row in conn.execute(
        f"SELECT * FROM student_model WHERE concept IN ({placeholders})", tuple(concept_names)
    ).fetchall():
        payloads.append(smgw.student_row_to_payload(row))
    if not payloads:
        return {"gateway": "no_rows"}
    return gateway.upsert_student_model(payloads)


def load_model(rollout, gateway, sqlite_conn):
    """Return the student model as a list of dicts from the preferred source."""
    if rollout.should_read_gateway_first():
        rows = gateway.read_student_model(limit=1000)
        if rows is not None:
            return [smgw.pg_row_to_model(r) for r in rows]
        if not rollout.allow_sqlite_read_fallback():
            return []
    # SQLite (either the preferred source or the fallback).
    import student_model as sm
    return sm.get_model(sqlite_conn) if sqlite_conn else []
