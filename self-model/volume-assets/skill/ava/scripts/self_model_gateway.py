#!/usr/bin/env python3
"""
self_model_gateway.py  (Phase 6: Self-Model DB Migration - connector client)

A thin HTTP client the connector scripts use to read/write the self-model store on
the gateway Postgres API instead of (or alongside) local SQLite. Designed for the
dual-write rollout:

  - Writes go to the gateway. If the gateway is unreachable, the payload is
    appended to a local JSON queue file so nothing is lost; flush_queue() replays
    it later. The caller can still write SQLite in parallel (dual-write).
  - Reads return the parsed body on success, or None on failure, so the caller can
    fall back to SQLite.

Configuration (env, with constructor overrides):
  GATEWAY_URL             base URL, e.g. https://gateway.example.com
  GATEWAY_API_KEY         bearer token sent as Authorization: Bearer <token>
                          (a service JWT for JWT routes, or the admin key for
                          admin routes)
  SELF_MODEL_DUAL_WRITE   "1" to enable gateway writes; anything else disables
                          them (SQLite-only, the pre-migration default)
  SELF_MODEL_QUEUE_PATH   queue file path (default /data/self-model-queue.jsonl)

Standard library only (urllib).
"""

import json
import os
import time
import urllib.error
import urllib.request


class Rollout:
    """Reads the dual-write rollout flags and answers routing questions.

    Stage 1 (schema + dual-write):  SQLITE_WRITE=1 DUAL_WRITE=1 READ_POSTGRES=0
    Stage 2 (read switch):          SQLITE_WRITE=1 DUAL_WRITE=1 READ_POSTGRES=1
    Stage 3 (remove sqlite write):  SQLITE_WRITE=0 DUAL_WRITE=1 READ_POSTGRES=1
    Stage 4 (cutover/cleanup):      SQLITE_WRITE=0 DUAL_WRITE=1 READ_POSTGRES=1
                                    SQLITE_READ_FALLBACK=0
    """

    def __init__(self, env=None):
        e = env if env is not None else os.environ
        self.dual_write = e.get("SELF_MODEL_DUAL_WRITE", "") == "1"
        self.read_postgres = e.get("SELF_MODEL_READ_POSTGRES", "") == "1"
        # SQLite write/read default ON (pre-migration); explicitly "0" turns off.
        self.sqlite_write = e.get("SELF_MODEL_SQLITE_WRITE", "1") != "0"
        self.sqlite_read_fallback = e.get("SELF_MODEL_SQLITE_READ_FALLBACK", "1") != "0"

    def should_write_sqlite(self):
        return self.sqlite_write

    def should_write_gateway(self):
        return self.dual_write

    def should_read_gateway_first(self):
        return self.read_postgres

    def allow_sqlite_read_fallback(self):
        return self.sqlite_read_fallback

    def stage(self):
        if not self.dual_write and self.sqlite_write and not self.read_postgres:
            return 0  # pre-migration
        if self.sqlite_write and self.dual_write and not self.read_postgres:
            return 1
        if self.sqlite_write and self.dual_write and self.read_postgres:
            return 2
        if not self.sqlite_write and self.read_postgres and self.sqlite_read_fallback:
            return 3
        if not self.sqlite_write and self.read_postgres and not self.sqlite_read_fallback:
            return 4
        return -1  # non-standard combination

    def as_dict(self):
        return {
            "stage": self.stage(),
            "dual_write": self.dual_write,
            "read_postgres": self.read_postgres,
            "sqlite_write": self.sqlite_write,
            "sqlite_read_fallback": self.sqlite_read_fallback,
        }


class SelfModelGateway:
    def __init__(self, base_url=None, api_key=None, queue_path=None,
                 dual_write=None, timeout=8.0):
        self.base_url = (base_url or os.environ.get("GATEWAY_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("GATEWAY_API_KEY", "")
        self.queue_path = queue_path or os.environ.get(
            "SELF_MODEL_QUEUE_PATH", "/data/self-model-queue.jsonl")
        if dual_write is None:
            dual_write = os.environ.get("SELF_MODEL_DUAL_WRITE", "") == "1"
        self.dual_write = bool(dual_write)
        self.timeout = timeout

    # -- low-level request ---------------------------------------------------

    def enabled(self):
        return self.dual_write and bool(self.base_url)

    def _request(self, method, path, body=None):
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}

    # -- queue for failed writes --------------------------------------------

    def _enqueue(self, method, path, body):
        record = {"ts": time.time(), "method": method, "path": path, "body": body}
        try:
            os.makedirs(os.path.dirname(self.queue_path) or ".", exist_ok=True)
            with open(self.queue_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
            return True
        except OSError:
            return False

    def flush_queue(self):
        """Replay queued writes. Returns {sent, remaining}."""
        if not os.path.exists(self.queue_path):
            return {"sent": 0, "remaining": 0}
        try:
            with open(self.queue_path, "r", encoding="utf-8") as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        except OSError:
            return {"sent": 0, "remaining": 0}

        remaining = []
        sent = 0
        for ln in lines:
            try:
                rec = json.loads(ln)
            except ValueError:
                continue  # drop corrupt line
            try:
                self._request(rec["method"], rec["path"], rec.get("body"))
                sent += 1
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
                remaining.append(ln)
        try:
            if remaining:
                with open(self.queue_path, "w", encoding="utf-8") as fh:
                    fh.write("\n".join(remaining) + "\n")
            else:
                os.remove(self.queue_path)
        except OSError:
            pass
        return {"sent": sent, "remaining": len(remaining)}

    # -- write helpers (dual-write aware) -----------------------------------

    def _write(self, method, path, body):
        """Attempt a gateway write; queue on failure. Returns a status dict."""
        if not self.enabled():
            return {"gateway": "disabled"}
        try:
            resp = self._request(method, path, body)
            return {"gateway": "ok", "response": resp}
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
            queued = self._enqueue(method, path, body)
            return {"gateway": "queued" if queued else "lost", "error": str(err)}

    def write_state(self, vector_json, curiosity_count=0, resolved_question_count=0,
                    session_count=0, trust_level=0.0, session_id=None):
        return self._write("POST", "/ti-self-model/state", {
            "vector_json": vector_json,
            "curiosity_count": curiosity_count,
            "resolved_question_count": resolved_question_count,
            "session_count": session_count,
            "trust_level": trust_level,
            "session_id": session_id,
        })

    def write_nudge_status(self, nudge_id, action):
        return self._write("POST", "/ti-self-model/nudge", {"id": nudge_id, "action": action})

    def write_compile(self, session_id, compile_time_ms, modules_loaded_count, manifest_version):
        return self._write("POST", "/ti-self-model/compile", {
            "session_id": session_id, "compile_time_ms": compile_time_ms,
            "modules_loaded_count": modules_loaded_count, "manifest_version": manifest_version,
        })

    def upsert_student_model(self, concepts):
        """concepts: list of {concept_id, concept_label, domain, confidence, uncertainty, seam_score}."""
        payload = concepts if isinstance(concepts, dict) else {"concepts": list(concepts)}
        return self._write("POST", "/ti-self-model/student-model", payload)

    def insert_seams(self, seams):
        """seams: list of {seam_type, source_concept, target_concept, description, strength}."""
        payload = seams if isinstance(seams, dict) else {"seams": list(seams)}
        return self._write("POST", "/ti-self-model/seam", payload)

    def create_nudge(self, pattern_type, score=0.0, title=None, body=None):
        return self._write("POST", "/ti-self-model/nudge", {
            "pattern_type": pattern_type, "score": score, "title": title, "body": body,
        })

    def ingest_session(self, session_id, log=None, module_activations=None,
                       tool_usage=None, topic_clusters=None, insights=None):
        payload = {"session_id": session_id}
        if log is not None:
            payload["log"] = log
        if module_activations:
            payload["module_activations"] = module_activations
        if tool_usage:
            payload["tool_usage"] = tool_usage
        if topic_clusters:
            payload["topic_clusters"] = topic_clusters
        if insights:
            payload["insights"] = insights
        return self._write("POST", "/ti-self-model/ingest", payload)

    # -- read helpers (None on failure so caller falls back to SQLite) ------

    def _read(self, method, path, body=None):
        if not self.base_url:
            return None
        try:
            return self._request(method, path, body)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
            return None

    def read_state(self):
        resp = self._read("GET", "/ti-self-model/state")
        return resp.get("state") if isinstance(resp, dict) else None

    def read_pending_nudges(self):
        resp = self._read("GET", "/ti-self-model/nudge")
        return resp.get("nudges") if isinstance(resp, dict) else None

    def query(self, intent, params=None, text=None, limit=20):
        body = {"limit": limit}
        if intent:
            body["intent"] = intent
        if params:
            body["params"] = params
        if text:
            body["text"] = text
        resp = self._read("POST", "/ti-self-model/query", body)
        return resp.get("rows") if isinstance(resp, dict) else None

    def read_insights(self, category=None, limit=20):
        path = f"/ti-self-model/insights?limit={int(limit)}"
        if category:
            path += f"&category={urllib.request.quote(str(category))}"
        resp = self._read("GET", path)
        return resp.get("insights") if isinstance(resp, dict) else None

    def read_student_model(self, limit=200):
        """Return student-model concepts (list) or None on failure."""
        return self.query("student_model_summary", limit=limit)

    def read_topic_rows(self, limit=1000):
        """Raw (session_id, topic_keyword) rows for adjacency, or None."""
        return self.query("topic_rows", limit=limit)

    def read_seams(self, limit=100):
        resp = self._read("GET", f"/ti-self-model/seam?limit={int(limit)}")
        return resp.get("seams") if isinstance(resp, dict) else None


# --------------------------------------------------------------------------- #
# Mapping between the connector SQLite student_model and the gateway projection
# --------------------------------------------------------------------------- #

def student_row_to_payload(row):
    """SQLite student_model row (dict-like) -> gateway upsert payload."""
    lower = _num(row["confidence_lower"], 0.0)
    upper = _num(row["confidence_upper"], 1.0)
    seam_scores = row["seam_scores"]
    if isinstance(seam_scores, str):
        try:
            seam_scores = json.loads(seam_scores)
        except (ValueError, TypeError):
            seam_scores = None
    return {
        "concept_id": row["concept"],
        "concept_label": row["concept"],
        "domain": row["domain"],
        "confidence": _num(row["confidence"], 0.0),
        "uncertainty": round((upper - lower) / 2.0, 4),
        "seam_score": 0.0,
        "observations": int(_num(row["observations"], 0)),
        "source": row["source"] or "inferred",
        "confidence_lower": lower,
        "confidence_upper": upper,
        "seam_scores": seam_scores,
    }


def pg_row_to_model(row):
    """Gateway student_model_summary row -> the dict shape seam_detection expects."""
    seam_scores = row.get("seam_scores")
    if isinstance(seam_scores, str):
        try:
            seam_scores = json.loads(seam_scores)
        except (ValueError, TypeError):
            seam_scores = {}
    return {
        "concept": row.get("concept_id"),
        "confidence": _num(row.get("confidence"), 0.0),
        "confidence_lower": _num(row.get("confidence_lower"), 0.0),
        "confidence_upper": _num(row.get("confidence_upper"), 1.0),
        "observations": int(_num(row.get("observations"), 0)),
        "source": row.get("source") or "inferred",
        "domain": row.get("domain"),
        "seam_scores": seam_scores or {},
    }


def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _self_test():
    """Offline sanity: with the gateway disabled, writes queue and reads are None."""
    import tempfile
    q = os.path.join(tempfile.mkdtemp(), "queue.jsonl")
    gw = SelfModelGateway(base_url="http://127.0.0.1:9", api_key="x",
                          queue_path=q, dual_write=True, timeout=0.5)
    r = gw.write_state({"a": 1}, session_count=3)
    assert r["gateway"] == "queued", r
    assert os.path.exists(q)
    assert gw.read_state() is None
    print(json.dumps({"ok": True, "write": r, "queued_file": os.path.exists(q)}))


if __name__ == "__main__":
    _self_test()
