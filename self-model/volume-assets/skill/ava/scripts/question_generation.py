#!/usr/bin/env python3
"""
question_generation.py  (Phase 4: Socratic Tutor Mode)

Turns a detected seam into a question designed to create productive cognitive
dissonance. Seam questions target seams, not gaps: a gap question asks "what is
X"; a seam question asks "how does what you know about Y sit against what you just
assumed about X?"

Each seam type maps to one question type (activation, boundary, contradiction,
transfer, reflective). A naturalness filter rejects questions that would feel
forced or reference concepts that aren't really established; if nothing passes,
no question is produced (the tutor stays silent rather than force one).

Standard library only. Run --next to execute the whole pipeline
(student_model -> seam_detection -> best question) and emit a single question.

CLI:
  question_generation.py --next --db /data/self-model.db
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import student_model as sm       # noqa: E402
import seam_detection as sd      # noqa: E402

DEFAULT_DB_PATH = os.environ.get("SELF_MODEL_DB_PATH", "/data/self-model.db")

# One or more templates per question type. Selection is deterministic (stable
# index from the concept name) so output is reproducible.
TEMPLATES = {
    "activation": [
        "You've got a solid handle on {adjacent}. How do you think that connects to {concept}?",
        "You clearly understand {adjacent}. Where does {concept} sit in relation to it?",
    ],
    "boundary": [
        "That holds for {concept} in the straightforward case. Where does it start to break down at the edges?",
        "Your read on {concept} works cleanly so far. What's the case that would stress it?",
    ],
    "contradiction": [
        "You've treated {concept} and {concept_b} as both central. Can both be primary at once?",
        "You hold {concept} and {concept_b} firmly. Is there a case where they can't both be true?",
    ],
    "transfer": [
        "You know how {concept} works. Could the same pattern apply to {adjacent}?",
        "The way you reason about {concept} is strong. Does that reasoning carry over to {adjacent}?",
    ],
    "reflective": [
        "You keep circling back to {concept} from different angles. What about it still feels unresolved?",
        "{concept} has come up for you more than once. What is it about it that hasn't settled yet?",
    ],
}


def _stable_index(text, n):
    if n <= 1:
        return 0
    return sum(ord(ch) for ch in (text or "")) % n


def passes_naturalness(seam):
    """Reject questions that would feel forced or reference thin concepts."""
    qt = seam.get("question_type")
    concept = (seam.get("concept") or "").strip()
    if not concept or seam.get("score", 0) <= 0:
        return False
    if qt in ("activation", "transfer") and not (seam.get("adjacent") or "").strip():
        return False
    if qt == "contradiction" and not (seam.get("concept_b") or "").strip():
        return False
    # A concept name that is a single character or absurdly long reads as noise.
    if len(concept) < 2 or len(concept) > 80:
        return False
    return True


def render(seam):
    qt = seam["question_type"]
    templates = TEMPLATES.get(qt)
    if not templates:
        return None
    idx = _stable_index(seam.get("concept", ""), len(templates))
    template = templates[idx]
    try:
        text = template.format(
            concept=seam.get("concept", ""),
            adjacent=seam.get("adjacent") or "",
            concept_b=seam.get("concept_b") or "",
        )
    except (KeyError, IndexError):
        return None
    return text


def generate_from_seams(seams):
    """Return the best natural question from a ranked seam list, or None."""
    for seam in seams:
        if not passes_naturalness(seam):
            continue
        text = render(seam)
        if not text:
            continue
        return {
            "question": text,
            "question_type": seam["question_type"],
            "seam_type": seam["seam_type"],
            "concept": seam["concept"],
            "adjacent": seam.get("adjacent"),
            "concept_b": seam.get("concept_b"),
            "score": seam["score"],
        }
    return None


def next_question(conn):
    seams = sd.detect_seams(conn)
    result = generate_from_seams(seams)
    return {"question": result, "seams_considered": len(seams)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate a Socratic seam question.")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--next", action="store_true", help="Run the full pipeline and emit one question.")
    parser.add_argument("--output", default=None)  # script-execute compatibility
    args = parser.parse_args(argv)

    # Rollout routing: read from Postgres (hydrated) when the read switch is on.
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
                print(json.dumps({"error": "gateway unreachable and SQLite fallback disabled", "question": None}))
                return 1
            if not ok:
                conn.close()
                conn = sm.connect(args.db)
        else:
            conn = sm.connect(args.db)

        out = next_question(conn)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except FileNotFoundError as err:
        print(json.dumps({"error": str(err), "question": None}))
        return 2
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
