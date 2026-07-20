#!/usr/bin/env python3
"""
seam_detection.py  (Phase 4: Socratic Tutor Mode)

Analyses the student model to locate seams: boundaries between known and unknown
territory where productive cognitive tension can be created. A seam is not a gap.
A gap is a concept the recipient simply lacks; a seam is a place where what they
already know sits right up against what they don't, so a well-placed question can
make the edge visible to them.

Five seam-type detectors, each mapping to one Socratic question type:

  activation_seam    -> activation question    (adjacent known, target near-unknown)
  boundary_seam      -> boundary question      (partial understanding at an edge)
  contradiction_seam -> contradiction question (two confident but conflicting beliefs)
  transfer_seam      -> transfer question      (strong A that should extend to weak B)
  reflective_seam    -> reflective question    (revisited but unresolved: meta-cognitive)

Adjacency comes from explicit relational hints (adjacent_to / conflicts_with on the
student model) and from co-occurrence in the self-model's topic_clusters.

Standard library only. Importable (detect_seams) by question_generation.py, or run
directly to emit seams as JSON.
"""

import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import student_model as sm  # noqa: E402

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

# Seam type -> (question_type, complexity rank per the specification ordering).
SEAM_QUESTION_MAP = {
    "activation_seam": ("activation", 1),
    "boundary_seam": ("boundary", 2),
    "contradiction_seam": ("contradiction", 3),
    "transfer_seam": ("transfer", 4),
    "reflective_seam": ("reflective", 5),
}

MIN_OBSERVATIONS = 2  # naturalness floor: don't build a seam on a single stray mention


def build_adjacency(conn, model_by_concept):
    """Adjacency from explicit hints plus topic_clusters co-occurrence."""
    adjacency = {c: set() for c in model_by_concept}

    # Explicit hints.
    for concept, rec in model_by_concept.items():
        for adj in (rec.get("seam_scores") or {}).get("adjacent_to", []):
            adjacency.setdefault(concept, set()).add(adj)
            adjacency.setdefault(adj, set()).add(concept)

    # Co-occurrence: concepts that appear together in a session are adjacent.
    try:
        rows = conn.execute("SELECT session_id, topic_keyword FROM topic_clusters").fetchall()
    except sqlite3.Error:
        rows = []
    by_session = {}
    for r in rows:
        by_session.setdefault(r["session_id"], set()).add(r["topic_keyword"])
    for keywords in by_session.values():
        kw = [k for k in keywords if k in model_by_concept]
        for i in range(len(kw)):
            for j in range(i + 1, len(kw)):
                adjacency.setdefault(kw[i], set()).add(kw[j])
                adjacency.setdefault(kw[j], set()).add(kw[i])
    return adjacency


def _conf(rec):
    return rec.get("confidence", 0.0)


def _obs(rec):
    return rec.get("observations", 0)


def detect_seams(conn):
    model = sm.get_model(conn)
    model_by_concept = {r["concept"]: r for r in model}
    adjacency = build_adjacency(conn, model_by_concept)
    seams = []

    def eligible(rec):
        return _obs(rec) >= MIN_OBSERVATIONS

    for concept, rec in model_by_concept.items():
        if not eligible(rec):
            continue
        conf = _conf(rec)
        obs = _obs(rec)
        neighbours = [(n, model_by_concept[n]) for n in adjacency.get(concept, set())
                      if n in model_by_concept]

        # 1) activation_seam: target near-unknown, a strong adjacent exists.
        if conf < 0.25:
            strong = [(n, r) for n, r in neighbours if _conf(r) >= 0.7 and _obs(r) >= MIN_OBSERVATIONS]
            if strong:
                n, r = max(strong, key=lambda x: _conf(x[1]))
                seams.append(_seam("activation_seam", concept, adjacent=n,
                                   score=round(_conf(r) * (1.0 - conf), 3),
                                   signals={"target_conf": round(conf, 3), "adjacent_conf": round(_conf(r), 3)}))

        # 2) boundary_seam: partial understanding in the mid band.
        if 0.4 <= conf < 0.7:
            score = round(1.0 - abs(conf - 0.55) / 0.15, 3)
            seams.append(_seam("boundary_seam", concept, score=max(0.0, score),
                               signals={"conf": round(conf, 3)}))

        # 3) contradiction_seam: an explicit conflict with another confident concept.
        for other in (rec.get("seam_scores") or {}).get("conflicts_with", []):
            other_rec = model_by_concept.get(other)
            if other_rec and conf >= 0.6 and _conf(other_rec) >= 0.6 and _obs(other_rec) >= MIN_OBSERVATIONS:
                # De-dupe symmetric pairs by ordering the names.
                if concept < other:
                    seams.append(_seam("contradiction_seam", concept, concept_b=other,
                                       score=round(min(conf, _conf(other_rec)), 3),
                                       signals={"conf_a": round(conf, 3), "conf_b": round(_conf(other_rec), 3)}))

        # 4) transfer_seam: strong here, an adjacent concept that should extend but is weak.
        if conf >= 0.75:
            weak = [(n, r) for n, r in neighbours if 0.2 <= _conf(r) < 0.5 and _obs(r) >= MIN_OBSERVATIONS]
            if weak:
                n, r = min(weak, key=lambda x: _conf(x[1]))
                seams.append(_seam("transfer_seam", concept, adjacent=n,
                                   score=round(conf * (0.5 - _conf(r)), 3),
                                   signals={"source_conf": round(conf, 3), "target_conf": round(_conf(r), 3)}))

        # 5) reflective_seam: revisited many times but still unresolved.
        if obs >= 4 and conf < 0.6:
            seams.append(_seam("reflective_seam", concept,
                               score=round((min(obs, 10) / 10.0) * (0.6 - conf), 3),
                               signals={"observations": obs, "conf": round(conf, 3)}))

    # Highest signal first; break ties toward the more complex seam.
    seams.sort(key=lambda s: (s["score"], s["complexity"]), reverse=True)
    return seams


def _seam(seam_type, concept, adjacent=None, concept_b=None, score=0.0, signals=None):
    question_type, complexity = SEAM_QUESTION_MAP[seam_type]
    return {
        "seam_type": seam_type,
        "question_type": question_type,
        "complexity": complexity,
        "concept": concept,
        "adjacent": adjacent,
        "concept_b": concept_b,
        "score": score,
        "signals": signals or {},
    }


def _seam_to_payload(seam):
    return {
        "seam_type": seam.get("seam_type"),
        "source_concept": seam.get("concept"),
        "target_concept": seam.get("adjacent") or seam.get("concept_b"),
        "description": f"{seam.get('question_type')} seam (score {seam.get('score')})",
        "strength": seam.get("score", 0),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Detect seams in the student model.")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--output", default=None)  # script-execute compatibility
    args = parser.parse_args(argv)

    # Rollout routing (Stage 0 default: read from on-disk SQLite, no gateway writes).
    try:
        import self_model_gateway as smgw
        import store
        rollout = smgw.Rollout()
        gateway = smgw.SelfModelGateway()
    except Exception:  # noqa: BLE001
        rollout = None
        gateway = None

    conn = None
    try:
        if rollout and rollout.should_read_gateway_first() and gateway is not None:
            conn, ok = store.hydrate_inmemory(gateway, concepts=None, with_topics=True)
            if not ok and not rollout.allow_sqlite_read_fallback():
                print(json.dumps({"error": "gateway unreachable and SQLite fallback disabled", "seams": []}))
                return 1
            if not ok:
                conn.close()
                conn = sm.connect(args.db)
        else:
            conn = sm.connect(args.db)

        seams = detect_seams(conn)
        if rollout and rollout.should_write_gateway() and gateway is not None and seams:
            gateway.insert_seams([_seam_to_payload(s) for s in seams])
        print(json.dumps({"seams": seams}, ensure_ascii=False))
        return 0
    except FileNotFoundError as err:
        print(json.dumps({"error": str(err), "seams": []}))
        return 2
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
