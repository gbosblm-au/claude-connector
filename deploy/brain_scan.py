#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
brain_scan.py - Ava Neural Core scanner (v2.0.0)
================================================

Reads the Ava modular skill volume and emits ``ava_brain_data.json``, the static
data bridge consumed by the Neural Core 3D visualiser in the Tenax Intelligence
client gateway.

Specification
-------------
Implements "Ava Brain Visualisation v2 - Jarvis-Inspired Living Architecture"
(Brian Le Mon, 2026-07-15), sections 3.1, 5 (Phase 1), 7 and 8.1.

Inputs (all optional; absent inputs degrade gracefully)
-------------------------------------------------------
  {ava_dir}/MANIFEST.json            Static module registry.
  {ava_dir}/MANIFEST_APPEND.json     Supplement: adds modules or overrides fields.
  {ava_dir}/DISPATCH_RULES.json      Learned routing linkages / session profiles.
  {ava_dir}/CORE.md                  Core protocol (line count only).
  {ava_dir}/modules/**/*.md          Module bodies (real line counts, tool mentions).
  {ava_dir}/references/**            Reference files (Railway content ring).
  {ava_dir}/scripts/**               Scripts (Railway content ring).
  {ava_dir}/archive/**               Archive files (Railway content ring).
  {ava_dir}/downloads/last_compile.json
                                     Written by the connector after skill_compile.
                                     Supplies isLoaded + last_compile_timestamp.
  {ava_dir}/scripts/brain_tools_catalog.json
                                     Tool registry. Written to the volume by the
                                     connector at boot from its own live tool
                                     list, so it cannot disagree with the
                                     connector that produced it.

Outputs
-------
  {ava_dir}/downloads/ava_brain_data.json   (canonical, served by the connector)
  /data/downloads/ava_brain_data.json       (mirror, served by GET /download/:filename)
  {--output dir}/ava_brain_data.json        (script_execute return_files support)

Usage
-----
  python3 brain_scan.py
  python3 brain_scan.py --force
  python3 brain_scan.py --ava-dir /data/skill/ava --out-file /tmp/brain.json
  python3 brain_scan.py --tools-catalog /path/to/brain_tools_catalog.json
  python3 brain_scan.py --input job.json --output /tmp/outdir     (script_execute)

Exit codes
----------
  0  Success, or a documented no-op skip (output already fresh).
  1  Fatal error (ava_dir missing, output not writable, manifest unparseable).

The scanner makes no network calls. It reads the volume and writes a file: an
HTTP fetch at scan time would be a dependency that can fail for reasons that
have nothing to do with the volume's state.

Style: PEP 8. Python 3.8+. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

SCANNER_VERSION = "2.1.0"
SCHEMA_VERSION = "2.0"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_AVA_DIR = "/data/skill/ava"
DEFAULT_MIRROR_DIR = "/data/downloads"
OUTPUT_BASENAME = "ava_brain_data.json"
LAST_COMPILE_BASENAME = "last_compile.json"

# Ellipsoid semi-axes (spec section 8.1).
ELLIPSOID_A = 20.0  # x radius
ELLIPSOID_B = 12.0  # y radius
ELLIPSOID_C = 15.0  # z radius

# Minimum separation enforced between node centres (world units).
MIN_NODE_DISTANCE = 1.15
RELAX_ITERATIONS = 60

# Keyword handling (spec section 8.4: limit label count to 8 per module).
MAX_KEYWORDS_PER_MODULE = 8
# A keyword shared by more than this many modules is a stop-word for link
# purposes: it would produce a hairball rather than a semantic bridge.
KEYWORD_LINK_MAX_MODULES = 8
MAX_KEYWORD_LINKS = 160

# Railway content ring sampling caps (spec section 8.4: ~200 dots budget).
MAX_RAILWAY_NODES_PER_KIND = 80

# Tool -> module filament caps (spec section 4.3).
MAX_TOOL_USED_BY = 6

# Tool registry, written to the volume by the connector at boot. Overridable
# with --tools-catalog or BRAIN_TOOLS_CATALOG; otherwise it sits next to this
# script.
TOOL_CATALOG_BASENAME = "brain_tools_catalog.json"


# ---------------------------------------------------------------------------
# Category model
# ---------------------------------------------------------------------------

# Raw category / directory name -> spec category key (spec sections 5 and 7).
# Values on the right are the keys used by LOBES and PALETTE below.
CATEGORY_ALIASES = {
    # Spec categories, canonical names as they appear in MANIFEST.json.
    "meta": "meta",
    "anti-patterns": "anti",
    "anti": "anti",
    "pipeline": "pipeline",
    "alignment": "align",
    "align": "align",
    "self-governance": "selfgov",
    "selfgov": "selfgov",
    "philosophy": "phil",
    "phil": "phil",
    "existential": "exist",
    "exist": "exist",
    "frontiers-emotional": "frontier",
    "frontier": "frontier",
    "ifa-arc": "ifa",
    "ifa": "ifa",
    "humour": "humour",
    "writing": "writing",
    "voice": "voice",
    "tutor": "tutor",
    "erp": "erp",
    "career-coach": "career",
    "career": "career",
    "reading": "reading",
    "toolkit": "toolkit",
    "recipe-scout": "recipe",
    "recipe": "recipe",
    "music-analysis": "music",
    "music": "music",
    "infra": "infra",
    "ava": "infra",
    # Documented extensions: real categories present on the volume that the v2
    # spec lobe table does not enumerate. Each gets its own band rather than
    # being silently folded into an unrelated lobe.
    "code-integrity": "code",
    "code-syntax": "code",
    "code": "code",
    "aml-ctf": "compliance",
    "compliance": "compliance",
    "design-ux": "design",
    "design": "design",
    "tenax": "platform",
    "platform": "platform",
    "reference": "toolkit",
    "emotion": "frontier",
}

# Lobe definitions.
#   phi_deg:   longitudinal band, in the spec's own -50..+50 coordinate space
#              (spec section 5, "Category-to-Lobe Mapping"). Scaled to the full
#              360 degrees of the ellipsoid at runtime -- see phi_scale below.
#   theta_deg: latitudinal band (0 = north pole, 180 = south pole).
#   depth:     radial factor range. 0.0 = ellipsoid centre, 1.0 = surface
#              (spec section 8.1).
#   region:    human-readable region label (spec section 7).
LOBES = {
    "infra":      {"phi_deg": (-5, 5),    "theta_deg": (72, 108),  "depth": (0.00, 0.30), "region": "Brainstem / Core"},
    "meta":       {"phi_deg": (-30, -15), "theta_deg": (45, 90),   "depth": (0.30, 0.60), "region": "Prefrontal"},
    "anti":       {"phi_deg": (-30, -15), "theta_deg": (90, 130),  "depth": (0.30, 0.60), "region": "Prefrontal"},
    "pipeline":   {"phi_deg": (-30, -15), "theta_deg": (30, 65),   "depth": (0.30, 0.60), "region": "Prefrontal"},
    "align":      {"phi_deg": (-30, -15), "theta_deg": (120, 155), "depth": (0.30, 0.60), "region": "Prefrontal"},
    "selfgov":    {"phi_deg": (-20, -10), "theta_deg": (60, 120),  "depth": (0.20, 0.50), "region": "Prefrontal (medial)"},
    "phil":       {"phi_deg": (15, 35),   "theta_deg": (35, 145),  "depth": (0.60, 0.90), "region": "Temporal L"},
    "exist":      {"phi_deg": (-35, -15), "theta_deg": (35, 145),  "depth": (0.30, 0.60), "region": "Temporal R"},
    "frontier":   {"phi_deg": (-15, 5),   "theta_deg": (55, 125),  "depth": (0.60, 0.90), "region": "Limbic / Medial temporal"},
    "ifa":        {"phi_deg": (10, 25),   "theta_deg": (20, 70),   "depth": (0.50, 0.80), "region": "Parietal (top)"},
    "humour":     {"phi_deg": (20, 40),   "theta_deg": (30, 75),   "depth": (0.60, 0.90), "region": "Frontal R"},
    "writing":    {"phi_deg": (20, 40),   "theta_deg": (75, 115),  "depth": (0.60, 0.90), "region": "Frontal R"},
    "voice":      {"phi_deg": (20, 40),   "theta_deg": (115, 155), "depth": (0.60, 0.90), "region": "Frontal R"},
    "tutor":      {"phi_deg": (-25, -10), "theta_deg": (110, 160), "depth": (0.60, 0.90), "region": "Parietal (bottom)"},
    "erp":        {"phi_deg": (-25, -10), "theta_deg": (95, 130),  "depth": (0.60, 0.90), "region": "Parietal (bottom)"},
    "career":     {"phi_deg": (-25, -10), "theta_deg": (140, 170), "depth": (0.60, 0.90), "region": "Parietal (bottom)"},
    "reading":    {"phi_deg": (35, 50),   "theta_deg": (50, 130),  "depth": (0.30, 0.60), "region": "Occipital"},
    "toolkit":    {"phi_deg": (-50, -35), "theta_deg": (100, 155), "depth": (0.60, 0.90), "region": "Cerebellum"},
    "recipe":     {"phi_deg": (-50, -35), "theta_deg": (60, 100),  "depth": (0.60, 0.90), "region": "Cerebellum"},
    "music":      {"phi_deg": (-50, -35), "theta_deg": (25, 60),   "depth": (0.60, 0.90), "region": "Cerebellum"},
    # Extensions (documented in README-brain-scan.md).
    "code":       {"phi_deg": (-65, -52), "theta_deg": (50, 140),  "depth": (0.45, 0.75), "region": "Cerebellum (lateral, extension)"},
    "compliance": {"phi_deg": (52, 62),   "theta_deg": (60, 120),  "depth": (0.45, 0.75), "region": "Occipital (lateral, extension)"},
    "design":     {"phi_deg": (64, 74),   "theta_deg": (55, 125),  "depth": (0.55, 0.85), "region": "Occipital (dorsal, extension)"},
    "platform":   {"phi_deg": (76, 88),   "theta_deg": (55, 125),  "depth": (0.40, 0.70), "region": "Occipital (ventral, extension)"},
    "other":      {"phi_deg": (90, 104),  "theta_deg": (40, 140),  "depth": (0.50, 0.85), "region": "Unassigned (extension)"},
}

# Node colours (spec section 2.2 v2 palette). Kept in the scanner so the JSON is
# self-describing; the visualiser carries an identical fallback table.
PALETTE = {
    "infra":      "#e8c36a",
    "meta":       "#c8943a",
    "anti":       "#c8943a",
    "pipeline":   "#c8943a",
    "align":      "#c8943a",
    "selfgov":    "#2d8a5e",
    "phil":       "#7f5ab5",
    "exist":      "#7f5ab5",
    "frontier":   "#c9607a",
    "ifa":        "#d85a30",
    "humour":     "#ba7517",
    "writing":    "#ba7517",
    "voice":      "#ba7517",
    "tutor":      "#4a7a9a",
    "erp":        "#4a7a9a",
    "career":     "#4a7a9a",
    "reading":    "#c8943a",
    "toolkit":    "#3a7a7a",
    "recipe":     "#3a7a7a",
    "music":      "#3a7a7a",
    "code":       "#2d8a5e",
    "compliance": "#4a7a9a",
    "design":     "#ba7517",
    "platform":   "#3a7a7a",
    "other":      "#8878cc",
    "railway":    "#3a7a7a",
    "internet":   "#00d4ff",
}

# Tool type colours (spec section 4.3).
TOOL_TYPE_COLOURS = {
    "storage": "#3a9a9a",
    "search":  "#4a7abd",
    "fetch":   "#4a9a5a",
    "write":   "#c8943a",
    "execute": "#d85a30",
    "gateway": "#00d4ff",
}

# Node radius bands (spec section 4.1).
SIZE_BANDS = {
    "infra":    (2.5, 4.0),
    "phil":     (1.2, 2.0),
    "exist":    (1.2, 2.0),
    "standard": (0.6, 1.0),
    "tool":     (0.5, 0.8),
    "railway":  (0.2, 0.4),
}

# Infrastructure nodes. These are not modules: they are the fixed anatomy of the
# architecture. Adjacency here reflects real data flow in the connector.
INFRA_NODES = [
    {
        "id": "CORE",
        "label": "Core Protocol",
        "description": "Base session rules, protocol, identity triggers, mandatory sequence.",
        "source": "CORE.md",
        "keywords": ["rules", "protocol", "triggers", "mandatory", "session", "identity"],
        "adjacency": ["MEMORY", "PROFILES", "DISPATCH"],
    },
    {
        "id": "MEMORY",
        "label": "Memory",
        "description": "Persistent memory store: session context, decisions, preferences.",
        "source": "connector memory_* tools",
        "keywords": ["memory", "recall", "session", "context", "persistence"],
        "adjacency": ["CORE", "PROFILES", "ARCHIVE"],
    },
    {
        "id": "PROFILES",
        "label": "Profiles",
        "description": "Person records and module frequency priors used by the dispatcher.",
        "source": "PROFILES.md",
        "keywords": ["person", "profile", "prior", "frequency", "relationship"],
        "adjacency": ["CORE", "MEMORY", "DISPATCH"],
    },
    {
        "id": "DISPATCH",
        "label": "Dispatch",
        "description": "Learned routing rules, layer scoring, session type profiles.",
        "source": "DISPATCH_RULES.json",
        "keywords": ["routing", "dispatch", "linkage", "scoring", "layer"],
        "adjacency": ["CORE", "PROFILES"],
    },
    {
        "id": "ARCHIVE",
        "label": "Archive",
        "description": "IFA session records, installation files, long-form conversation archives.",
        "source": "archive/",
        "keywords": ["archive", "installation", "record", "IFA", "history"],
        "adjacency": ["MEMORY"],
    },
    {
        "id": "REFERENCES",
        "label": "References",
        "description": "Reference documents loaded on demand by consuming modules.",
        "source": "references/",
        "keywords": ["reference", "spec", "guide", "document"],
        "adjacency": [],
    },
    {
        "id": "SCRIPTS",
        "label": "Scripts",
        "description": "Executable Python and shell tooling on the Railway volume.",
        "source": "scripts/",
        "keywords": ["script", "python", "execute", "render", "generate"],
        "adjacency": [],
    },
    {
        "id": "INTERNET",
        "label": "Internet",
        "description": "Real-time external access: web search, news, page fetch.",
        "source": "connector search / fetch tools",
        "keywords": ["web", "search", "news", "real-time", "external"],
        "adjacency": ["DISPATCH"],
    },
]

INFRA_IDS = {n["id"] for n in INFRA_NODES}

# Tool name classification (spec section 4.3). Ordered: first match wins.
# Rules are matched against the tool name; they encode the connector's own
# naming conventions rather than guessing at capability.
TOOL_TYPE_RULES = [
    (re.compile(r"^memory_|^ava_memory_"), "storage"),
    (re.compile(r"_search$|^search_|_search_"), "search"),
    (re.compile(r"_execute$|_compile$|_recompile$|_merge_|_rollback$|_restore$|_backup$|_sync_|^script_execute$"), "execute"),
    (re.compile(r"_read$|_list$|_get$|^get_|_get_|_poll_|_fetch_|_fetch$|_status$|_info$|_count$|_metadata$|_health$"), "fetch"),
    (re.compile(r"_write$|_create$|_create_|_upload$|_upload_|_append_|_update$|_update_|_send$|_send_|_add$|_add_|_set$|^set_|_delete$|_cancel$|_clear$|^clear_|_flag$|_download$|_rename$|_logout$|_consent_|_validate_"), "write"),
]

# Domain split: gateway tools act on the Ava / Tenax platform itself. Connector
# tools reach an external provider. Prefixes taken from the connector's live
# tool registry (src/tools/*.js, src/tools-memory/*.js).
GATEWAY_TOOL_PREFIXES = (
    "memory_", "ava_memory_", "skill_", "module_", "script_", "archive_",
    "reference_", "personality_", "dispatch_", "profile_", "books_",
    "health_log_", "psychology_", "peer_review_", "escalation_", "issue_",
    "client_", "ts_gateway_",
)

# Structural anchor for each tool: the infrastructure node the tool actually
# operates on. Used to drop a filament for tools that no module names directly,
# so the belt is never orphaned. First matching prefix wins.
TOOL_ANCHORS = [
    ("memory_", "MEMORY"),
    ("ava_memory_", "MEMORY"),
    ("profile_", "PROFILES"),
    ("dispatch_", "DISPATCH"),
    ("archive_", "ARCHIVE"),
    ("reference_", "REFERENCES"),
    ("script_", "SCRIPTS"),
    ("skill_", "CORE"),
    ("module_", "CORE"),
    ("personality_", "CORE"),
    ("books_", "ARCHIVE"),
    ("web_", "INTERNET"),
    ("news_", "INTERNET"),
    ("image_", "INTERNET"),
    ("wordpress_", "INTERNET"),
    ("linkedin_", "INTERNET"),
    ("google_drive_", "INTERNET"),
    ("sheets_", "INTERNET"),
    ("calendar_", "INTERNET"),
    ("email_", "INTERNET"),
    ("slack_", "INTERNET"),
    ("teams_", "INTERNET"),
    ("webhook_", "INTERNET"),
]
DEFAULT_TOOL_ANCHOR = "CORE"

# Provider attribution for connector tools, keyed by prefix. Values name the
# integration surface, not a vendor SKU, so they stay accurate if the
# underlying provider is swapped via env config.
CONNECTOR_PROVIDERS = [
    ("web_search", "web"),
    ("news_search", "news"),
    ("image_search", "image"),
    ("image_download", "image"),
    ("web_fetch_page", "web"),
    ("wordpress_", "wordpress"),
    ("linkedin_", "linkedin"),
    ("google_drive_", "google"),
    ("sheets_", "google"),
    ("calendar_", "google"),
    ("email_", "email"),
    ("slack_", "messaging"),
    ("teams_", "messaging"),
    ("webhook_", "webhook"),
    ("set_", "credentials"),
    ("get_", "credentials"),
    ("clear_", "credentials"),
]


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def log(message):
    """Write a progress line to stderr so stdout stays a clean JSON summary."""
    sys.stderr.write("[brain_scan] %s\n" % message)
    sys.stderr.flush()


def utc_now_iso():
    """Current UTC time, ISO 8601, second precision, Z-suffixed."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def stable_unit(seed_text, salt=""):
    """Deterministic float in [0, 1) derived from a string.

    Used instead of random.random() so that repeated scans of an unchanged
    volume produce byte-identical coordinates. Layout stability matters: the
    visualiser is a mental map, and nodes that jump on every scan destroy it.
    """
    digest = hashlib.sha256((salt + "|" + seed_text).encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(0x1000000000000)


def read_json(path, fallback=None):
    """Read and parse a JSON file. Returns fallback on absence or parse error."""
    if not os.path.isfile(path):
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        log("WARN cannot parse %s: %s" % (path, exc))
        return fallback


def count_lines(path):
    """Count lines in a text file. Returns 0 when unreadable."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return sum(1 for _ in handle)
    except OSError as exc:
        log("WARN cannot read %s: %s" % (path, exc))
        return 0


def read_text(path, limit_bytes=400000):
    """Read a text file, capped. Returns an empty string when unreadable."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit_bytes)
    except OSError:
        return ""


def _coerce_scalar(raw):
    """Convert a frontmatter scalar string into bool / int / list / str."""
    value = raw.strip().strip('"').strip("'")
    lowered = value.lower()
    if lowered in ("true", "yes"):
        return True
    if lowered in ("false", "no"):
        return False
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1]
        return [item.strip().strip('"').strip("'") for item in inner.split(",") if item.strip()]
    if "," in value:
        # Ava's frontmatter uses bare comma-separated lists, e.g.
        #   provides: psychological_continuity, session_gap_framing
        parts = [item.strip().strip('"').strip("'") for item in value.split(",") if item.strip()]
        if len(parts) > 1:
            return parts
    return value


def parse_frontmatter(text):
    """Parse a leading YAML frontmatter block.

    PyYAML is used when present (the connector image does not guarantee it), and
    a conservative stdlib parser handles the subset Ava's modules actually use:
    scalars, inline lists, bare comma-separated lists, block lists, and one
    level of nested mapping.

    Returns:
        dict (empty when there is no frontmatter or it cannot be parsed).
    """
    if not text:
        return {}
    normalised = text.replace("\r\n", "\n").replace("\r", "\n")
    if not normalised.startswith("---\n"):
        return {}
    end = normalised.find("\n---", 4)
    if end < 0:
        return {}
    block = normalised[4:end]

    try:
        import yaml  # type: ignore
        parsed = yaml.safe_load(block)
        if isinstance(parsed, dict):
            return parsed
    except Exception:  # noqa: BLE001 - any yaml failure falls through to the parser below
        pass

    result = {}
    current_key = None
    current_list = None
    current_map = None

    for line in block.split("\n"):
        if not line.strip() or line.strip().startswith("#"):
            continue

        list_item = re.match(r"^\s+-\s+(.*)$", line)
        if list_item and current_key:
            if current_list is None:
                current_list = []
                result[current_key] = current_list
            current_list.append(_coerce_scalar(list_item.group(1)))
            continue

        nested = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if nested and current_key:
            if current_map is None:
                current_map = {}
                result[current_key] = current_map
            current_map[nested.group(1)] = _coerce_scalar(nested.group(2))
            continue

        top = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if top:
            current_key = top.group(1)
            current_list = None
            current_map = None
            value = top.group(2).strip()
            if value == "":
                result[current_key] = ""
            else:
                result[current_key] = _coerce_scalar(value)

    return result


def newest_mtime(paths):
    """Return the newest mtime across the given paths (files or directories)."""
    newest = 0.0
    for path in paths:
        if not os.path.exists(path):
            continue
        if os.path.isfile(path):
            try:
                newest = max(newest, os.path.getmtime(path))
            except OSError:
                continue
            continue
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            try:
                newest = max(newest, os.path.getmtime(root))
            except OSError:
                pass
            for name in files:
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(root, name)))
                except OSError:
                    continue
    return newest


def normalise_category(raw):
    """Map a manifest / directory category onto a spec lobe key."""
    if not raw:
        return "other"
    key = str(raw).strip().lower()
    if key in CATEGORY_ALIASES:
        return CATEGORY_ALIASES[key]
    if key in LOBES:
        return key
    return "other"


def clamp(value, low, high):
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# Phase 1a: manifests
# ---------------------------------------------------------------------------

def scan_manifests(ava_dir):
    """Read MANIFEST.json, MANIFEST_APPEND.json, and references/manifest/*.json
    fragments, and merge them.

    Merge logic (spec section 3.1):
      (a) start with every module in MANIFEST.json;
      (b) a MANIFEST_APPEND module whose id already exists merges field-by-field,
          with MANIFEST_APPEND values taking priority;
      (c) a MANIFEST_APPEND module with a new id is added;
      (d) v2.1.0: every references/manifest/*.json fragment is read in filename
          order; a fragment module with a NEW id is added (first-definition-wins,
          matching the connector's loadMergedManifest), tagged with
          _source_fragment provenance, and given an existence-checked inferred
          path when the fragment omits one. Fragments with existing ids are
          skipped so MANIFEST / MANIFEST_APPEND always take priority.

    Returns:
        dict with keys: modules (list), mandatory_for_triggers (dict),
        tag_web (dict), manifest_version (str), manifest_append_version (str|None),
        core (dict).
    """
    manifest_path = os.path.join(ava_dir, "MANIFEST.json")
    append_path = os.path.join(ava_dir, "MANIFEST_APPEND.json")

    manifest = read_json(manifest_path, None)
    if manifest is None:
        raise RuntimeError("MANIFEST.json not found or unparseable at %s" % manifest_path)
    if not isinstance(manifest, dict):
        raise RuntimeError("MANIFEST.json must contain a JSON object, got %s" % type(manifest).__name__)

    modules = [m for m in manifest.get("modules") or [] if isinstance(m, dict) and m.get("id")]
    by_id = {}
    order = []
    for module in modules:
        module_id = str(module["id"])
        if module_id in by_id:
            # Duplicate ids in MANIFEST.json: last definition wins, matching the
            # connector's own dict-building behaviour.
            by_id[module_id] = dict(by_id[module_id])
            by_id[module_id].update(module)
            continue
        by_id[module_id] = dict(module)
        order.append(module_id)

    mandatory_for_triggers = dict(manifest.get("mandatory_for_triggers") or {})
    tag_web = dict(manifest.get("tag_web") or {})

    append = read_json(append_path, None)
    append_version = None
    added, overridden = 0, 0

    if isinstance(append, dict):
        append_version = str(append.get("manifest_append_version") or append.get("version") or "unknown")
        for module in append.get("modules") or []:
            if not isinstance(module, dict) or not module.get("id"):
                continue
            module_id = str(module["id"])
            if module_id in by_id:
                merged = dict(by_id[module_id])
                merged.update(module)  # append fields take priority
                by_id[module_id] = merged
                overridden += 1
            else:
                by_id[module_id] = dict(module)
                order.append(module_id)
                added += 1

        for trigger, module_ids in (append.get("mandatory_for_triggers") or {}).items():
            if not isinstance(module_ids, list):
                continue
            existing = list(mandatory_for_triggers.get(trigger) or [])
            for module_id in module_ids:
                if module_id not in existing:
                    existing.append(module_id)
            mandatory_for_triggers[trigger] = existing

        for tag, keywords in (append.get("tag_web") or {}).items():
            if tag not in tag_web and isinstance(keywords, list):
                tag_web[tag] = keywords

        log("MANIFEST_APPEND merged: %d added, %d overridden" % (added, overridden))
    else:
        log("MANIFEST_APPEND.json absent - using MANIFEST.json only")

    # -- v2.1.0: references/manifest/*.json fragment merge --------------------
    # Modules registered by module_write land here (MANIFEST_DIRECTORY_PROTOCOL
    # Layer 1). The scan catalogs them directly so the visualisation reflects
    # every registered module without a manifest_rebuild.py run.
    fragments_dir = os.path.join(ava_dir, "references", "manifest")
    fragment_files_read = []
    fragment_added = 0
    fragment_skipped_existing = 0
    if os.path.isdir(fragments_dir):
        try:
            fragment_names = sorted(
                n for n in os.listdir(fragments_dir) if n.lower().endswith(".json")
            )
        except OSError as err:
            log("references/manifest unreadable: %s" % err)
            fragment_names = []
        for name in fragment_names:
            fragment = read_json(os.path.join(fragments_dir, name), None)
            if not isinstance(fragment, dict):
                log("fragment %s skipped: unparseable or not an object" % name)
                continue
            frag_modules = [
                m for m in (fragment.get("modules") or [])
                if isinstance(m, dict) and m.get("id")
            ]
            if not frag_modules:
                # Placeholder / deprecated fragments carry no modules; ignore
                # quietly (e.g. deprecated travel-manifest-append.json stubs).
                continue
            fragment_files_read.append(name)
            for module in frag_modules:
                module_id = str(module["id"])
                if module_id in by_id:
                    fragment_skipped_existing += 1
                    continue
                entry = dict(module)
                entry["_source_fragment"] = name
                if not entry.get("path"):
                    # Existence-checked inference only; never a guess. The
                    # shipped 70-travel.json omits path, and this is what makes
                    # its module loadable and drawable.
                    candidates = []
                    if entry.get("category"):
                        candidates.append("modules/%s/%s.md" % (entry["category"], module_id))
                    candidates.append("modules/%s.md" % module_id)
                    for rel in candidates:
                        if os.path.isfile(os.path.join(ava_dir, rel)):
                            entry["path"] = rel
                            break
                by_id[module_id] = entry
                order.append(module_id)
                fragment_added += 1
            for trigger, module_ids in (fragment.get("mandatory_for_triggers") or {}).items():
                if not isinstance(module_ids, list):
                    continue
                existing = list(mandatory_for_triggers.get(trigger) or [])
                for module_id in module_ids:
                    if module_id not in existing:
                        existing.append(module_id)
                mandatory_for_triggers[trigger] = existing
            for tag, keywords in (fragment.get("tag_web") or {}).items():
                if tag not in tag_web and isinstance(keywords, list):
                    tag_web[tag] = keywords
        log("references/manifest fragments merged: %d file(s), %d module(s) added, %d skipped (already registered)"
            % (len(fragment_files_read), fragment_added, fragment_skipped_existing))
    else:
        log("references/manifest absent - no fragment registrations to catalog")
    # -- End fragment merge ---------------------------------------------------

    return {
        "modules": [by_id[module_id] for module_id in order],
        "mandatory_for_triggers": mandatory_for_triggers,
        "tag_web": tag_web,
        "manifest_version": str(manifest.get("manifest_version") or "unknown"),
        "manifest_append_version": append_version,
        "manifest_fragments": {
            "files": fragment_files_read,
            "modules_added": fragment_added,
            "skipped_existing": fragment_skipped_existing,
        },
        "core": manifest.get("core") or {},
    }


# ---------------------------------------------------------------------------
# Phase 1b: directories
# ---------------------------------------------------------------------------

def _walk_files(base_dir, extensions=None):
    """Yield (absolute_path, path_relative_to_base) for files under base_dir."""
    if not os.path.isdir(base_dir):
        return
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if name.startswith("."):
                continue
            if extensions and os.path.splitext(name)[1].lower() not in extensions:
                continue
            absolute = os.path.join(root, name)
            yield absolute, os.path.relpath(absolute, base_dir)


def scan_directories(ava_dir):
    """Walk modules/, references/, scripts/ and archive/.

    Returns:
        dict with keys:
          module_files: { module_id: {path, rel_path, line_count, category, text} }
          references:   [ {id, name, rel_path, line_count, category} ]
          scripts:      [ {id, name, rel_path, line_count, kind} ]
          archive:      [ {id, name, rel_path, line_count, ifa_cycle} ]
          counts:       { modules, references, scripts, archive }
    """
    modules_dir = os.path.join(ava_dir, "modules")
    references_dir = os.path.join(ava_dir, "references")
    scripts_dir = os.path.join(ava_dir, "scripts")
    archive_dir = os.path.join(ava_dir, "archive")

    module_files = {}
    for absolute, relative in _walk_files(modules_dir, {".md"}):
        text = read_text(absolute)
        frontmatter = parse_frontmatter(text)
        # Spec section 3.1: ids come from the filename; frontmatter supplies the
        # declared line_count_estimate. A frontmatter id that disagrees with the
        # filename is recorded but never overrides it, because the manifest and
        # the dispatcher both address modules by filename stem.
        module_id = os.path.splitext(os.path.basename(relative))[0]
        parent = os.path.dirname(relative).split(os.sep)[0] if os.path.dirname(relative) else ""
        category = frontmatter.get("category") or parent
        module_files[module_id] = {
            "path": absolute,
            "rel_path": "modules/" + relative.replace(os.sep, "/"),
            "line_count": count_lines(absolute),
            "line_count_estimate": frontmatter.get("line_count_estimate"),
            "category": normalise_category(category) if category else "other",
            "frontmatter": frontmatter,
            "text": text,
        }

    references = []
    for absolute, relative in _walk_files(references_dir):
        parent = os.path.dirname(relative).split(os.sep)[0] if os.path.dirname(relative) else "root"
        references.append({
            "id": "ref:" + relative.replace(os.sep, "/"),
            "name": os.path.basename(relative),
            "rel_path": "references/" + relative.replace(os.sep, "/"),
            "line_count": count_lines(absolute),
            "category": parent or "root",
        })

    scripts = []
    for absolute, relative in _walk_files(scripts_dir):
        extension = os.path.splitext(relative)[1].lower()
        if extension == ".py":
            kind = "python"
        elif extension in (".sh", ".bash"):
            kind = "shell"
        elif extension == ".js":
            kind = "javascript"
        else:
            kind = "data"
        parent = os.path.dirname(relative).split(os.sep)[0] if os.path.dirname(relative) else "root"
        scripts.append({
            "id": "script:" + relative.replace(os.sep, "/"),
            "name": os.path.basename(relative),
            "rel_path": "scripts/" + relative.replace(os.sep, "/"),
            "line_count": count_lines(absolute) if kind != "data" else 0,
            "kind": kind,
            "category": parent or "root",
        })

    ifa_pattern = re.compile(r"(?:^|[_-])((?:PF|EF|IFA)[-_]?\d+[A-Za-z]?)", re.IGNORECASE)
    archive = []
    for absolute, relative in _walk_files(archive_dir):
        match = ifa_pattern.search(os.path.basename(relative))
        archive.append({
            "id": "archive:" + relative.replace(os.sep, "/"),
            "name": os.path.basename(relative),
            "rel_path": "archive/" + relative.replace(os.sep, "/"),
            "line_count": count_lines(absolute),
            "ifa_cycle": match.group(1).upper().replace("_", "-") if match else None,
        })

    return {
        "module_files": module_files,
        "references": references,
        "scripts": scripts,
        "archive": archive,
        "counts": {
            "modules": len(module_files),
            "references": len(references),
            "scripts": len(scripts),
            "archive": len(archive),
        },
    }


# ---------------------------------------------------------------------------
# Phase 1c: keywords
# ---------------------------------------------------------------------------

def _module_keywords(module):
    """Extract a module's keyword list across both manifest schema generations.

    Newer entries carry triggers.keywords; older entries carry trigger_keywords.
    Tags are used as a last resort so that every module gets a semantic halo.
    """
    keywords = []

    triggers = module.get("triggers")
    if isinstance(triggers, dict):
        for value in triggers.get("keywords") or []:
            if isinstance(value, str):
                keywords.append(value)
    elif isinstance(triggers, list):
        for value in triggers:
            if isinstance(value, str):
                keywords.append(value)

    for value in module.get("trigger_keywords") or []:
        if isinstance(value, str):
            keywords.append(value)

    if not keywords:
        for value in module.get("tags") or []:
            if isinstance(value, str):
                keywords.append(value)

    cleaned = []
    seen = set()
    for keyword in keywords:
        token = keyword.strip().lower()
        # Single word per label (spec section 4.2). Multi-word triggers collapse
        # to their most specific token rather than being dropped.
        if " " in token:
            parts = [p for p in re.split(r"[\s/]+", token) if len(p) > 3]
            token = parts[-1] if parts else ""
        token = token.strip(".,:;\"'()[]")
        if len(token) < 3 or token in seen:
            continue
        seen.add(token)
        cleaned.append(token)
        if len(cleaned) >= MAX_KEYWORDS_PER_MODULE:
            break
    return cleaned


def extract_keywords(modules):
    """Build the keyword index and the keyword overlap link set.

    Returns:
        (keywords_by_module, keyword_links)
        keywords_by_module: { module_id: [keyword, ...] }
        keyword_links:      [ {keyword, modules, count}, ... ]
    """
    keywords_by_module = {}
    index = {}

    for module in modules:
        module_id = str(module["id"])
        keywords = _module_keywords(module)
        keywords_by_module[module_id] = keywords
        for keyword in keywords:
            index.setdefault(keyword, []).append(module_id)

    links = []
    for keyword, module_ids in index.items():
        unique_ids = sorted(set(module_ids))
        if len(unique_ids) < 2:
            continue
        if len(unique_ids) > KEYWORD_LINK_MAX_MODULES:
            # Ubiquitous keyword: a bridge that connects everything is not a
            # bridge. Kept in the index for labels, excluded from link drawing.
            continue
        links.append({
            "keyword": keyword,
            "modules": unique_ids,
            "count": len(unique_ids),
        })

    links.sort(key=lambda item: (-item["count"], item["keyword"]))
    return keywords_by_module, links[:MAX_KEYWORD_LINKS]


# ---------------------------------------------------------------------------
# Phase 1d: coordinates
# ---------------------------------------------------------------------------

def _phi_scale(lobes):
    """Compute the factor mapping the spec's phi space onto a full ellipsoid.

    The spec's category table (section 5) spans roughly -65..+104 degrees once
    the extension lobes are included. Applied literally, every node would land
    on one flank of the ellipsoid: cos(phi) never goes negative across that
    span, so the entire rear hemisphere stays empty and the clusters overlap in
    x. The bands are therefore treated as a relative ordering and scaled onto
    the full 360 degrees, which preserves every adjacency and separation the
    spec asks for while producing a genuine ellipsoid distribution.

    Pass --phi-scale 1.0 to use the spec's degrees literally.
    """
    lows = [lobe["phi_deg"][0] for lobe in lobes.values()]
    highs = [lobe["phi_deg"][1] for lobe in lobes.values()]
    span = max(highs) - min(lows)
    if span <= 0:
        return 1.0, 0.0
    scale = 360.0 / span
    centre = (max(highs) + min(lows)) / 2.0
    return scale, centre


def _importance(module, line_count):
    """Return a 0..1 importance score. 1.0 = central to the architecture."""
    score = 0.0
    if module.get("always_load"):
        score += 0.5
    if module.get("mandatory"):
        score += 0.3
    if module.get("mandatory_for"):
        score += 0.25
    if module.get("dispatch_priority"):
        score += 0.15
    if module.get("requires"):
        score += 0.05
    # Long modules carry more of the architecture's weight.
    score += clamp(line_count / 800.0, 0.0, 0.25)
    return clamp(score, 0.0, 1.0)


def _node_size(category, importance, line_count, is_infra):
    """Map category, importance and line count onto a node radius (section 4.1)."""
    if is_infra:
        low, high = SIZE_BANDS["infra"]
    elif category in ("phil", "exist"):
        low, high = SIZE_BANDS["phil"]
    else:
        low, high = SIZE_BANDS["standard"]
    weight = clamp(0.6 * importance + 0.4 * clamp(line_count / 500.0, 0.0, 1.0), 0.0, 1.0)
    return round(low + (high - low) * weight, 3)


def compute_ellipsoid_coordinates(modules, categories, phi_scale_override=None):
    """Assign each module an XYZ position on or within the ellipsoid.

    Spec section 8.1:
        x = a * sin(theta) * cos(phi)
        y = b * cos(theta)
        z = c * sin(theta) * sin(phi)
        final = (x, y, z) * depth

    Category determines the longitudinal band, subcategory position within the
    band determines latitude, and importance determines depth. Jitter is derived
    from a hash of the module id, so it is stable across runs but never lands on
    a grid.

    Args:
        modules: list of merged manifest module dicts.
        categories: { module_id: spec category key }.
        phi_scale_override: use the spec's phi degrees literally when 1.0.

    Returns:
        { module_id: {"xyz": [x, y, z], "depth": float, "region": str} }
    """
    auto_scale, phi_centre = _phi_scale(LOBES)
    scale = auto_scale if phi_scale_override is None else float(phi_scale_override)

    by_id = {str(m["id"]): m for m in modules if m.get("id")}

    # Group by category so nodes can be spread across their band by index.
    grouped = {}
    for module in modules:
        module_id = str(module["id"])
        grouped.setdefault(categories.get(module_id, "other"), []).append(module_id)

    positions = {}
    for category, module_ids in grouped.items():
        lobe = LOBES.get(category, LOBES["other"])
        phi_low, phi_high = lobe["phi_deg"]
        theta_low, theta_high = lobe["theta_deg"]
        depth_low, depth_high = lobe["depth"]

        # Scale the band around the shared centre so relative order survives.
        phi_low_s = (phi_low - phi_centre) * scale
        phi_high_s = (phi_high - phi_centre) * scale

        module_ids = sorted(module_ids)
        count = len(module_ids)

        for index, module_id in enumerate(module_ids):
            # Latitude: spread deterministically across the band, then jitter.
            if count == 1:
                theta_t = 0.5
            else:
                theta_t = index / float(count - 1)
            theta_t = clamp(theta_t + (stable_unit(module_id, "theta") - 0.5) * 0.14, 0.0, 1.0)
            theta_deg = theta_low + (theta_high - theta_low) * theta_t

            # Longitude: jitter within the band, weighted by a second hash so
            # that neighbours in the sorted order do not form a visible arc.
            phi_t = stable_unit(module_id, "phi")
            phi_deg = phi_low_s + (phi_high_s - phi_low_s) * phi_t

            theta = math.radians(clamp(theta_deg, 3.0, 177.0))
            phi = math.radians(phi_deg)

            surface_x = ELLIPSOID_A * math.sin(theta) * math.cos(phi)
            surface_y = ELLIPSOID_B * math.cos(theta)
            surface_z = ELLIPSOID_C * math.sin(theta) * math.sin(phi)

            module = by_id.get(module_id, {})
            line_count = int(module.get("_line_count") or 0)
            importance = _importance(module, line_count)
            # High importance sits deeper, i.e. toward the low end of the band.
            depth = depth_high - (depth_high - depth_low) * importance
            depth += (stable_unit(module_id, "depth") - 0.5) * 0.06
            depth = clamp(depth, 0.05, 0.98)

            positions[module_id] = {
                "xyz": [round(surface_x * depth, 3), round(surface_y * depth, 3), round(surface_z * depth, 3)],
                "depth": round(depth, 3),
                "region": lobe["region"],
            }

    return positions


def _relax_positions(positions, sizes, pinned=None):
    """Push overlapping nodes apart (minimum distance enforcement, section 5).

    A short iterative relaxation. Nodes are nudged along their separation
    vector, then clamped back inside the ellipsoid so nothing escapes the skull.

    Args:
        positions: { node_id: {"xyz": [...], ...} }, mutated in place.
        sizes:     { node_id: radius }.
        pinned:    node ids that must not move (CORE anchors the centre).
    """
    pinned = pinned or set()
    ids = sorted(positions.keys())
    if len(ids) < 2:
        return

    points = {node_id: list(positions[node_id]["xyz"]) for node_id in ids}

    for _ in range(RELAX_ITERATIONS):
        moved = False
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a_id, b_id = ids[i], ids[j]
                a_pinned, b_pinned = a_id in pinned, b_id in pinned
                if a_pinned and b_pinned:
                    continue
                ax, ay, az = points[a_id]
                bx, by, bz = points[b_id]
                dx, dy, dz = bx - ax, by - ay, bz - az
                distance = math.sqrt(dx * dx + dy * dy + dz * dz)
                minimum = MIN_NODE_DISTANCE + (sizes.get(a_id, 1.0) + sizes.get(b_id, 1.0)) * 0.5
                if distance >= minimum:
                    continue
                if distance < 1e-6:
                    # Coincident: deterministic separation along x.
                    dx, dy, dz, distance = 1.0, 0.0, 0.0, 1.0
                overlap = minimum - distance
                ux, uy, uz = dx / distance, dy / distance, dz / distance
                # A pinned node absorbs none of the push: its partner takes it all.
                a_share = 0.0 if a_pinned else (1.0 if b_pinned else 0.5)
                b_share = 0.0 if b_pinned else (1.0 if a_pinned else 0.5)
                if a_share:
                    points[a_id] = [ax - ux * overlap * a_share,
                                    ay - uy * overlap * a_share,
                                    az - uz * overlap * a_share]
                if b_share:
                    points[b_id] = [bx + ux * overlap * b_share,
                                    by + uy * overlap * b_share,
                                    bz + uz * overlap * b_share]
                moved = True
        if not moved:
            break

    for node_id in ids:
        if node_id in pinned:
            continue
        x, y, z = points[node_id]
        # Clamp inside the ellipsoid surface.
        radial = math.sqrt((x / ELLIPSOID_A) ** 2 + (y / ELLIPSOID_B) ** 2 + (z / ELLIPSOID_C) ** 2)
        if radial > 0.98:
            factor = 0.98 / radial
            x, y, z = x * factor, y * factor, z * factor
        positions[node_id]["xyz"] = [round(x, 3), round(y, 3), round(z, 3)]


# ---------------------------------------------------------------------------
# Phase 1e: links
# ---------------------------------------------------------------------------

def _add_link(links, source, target, strength, link_type, valid_ids):
    """Insert or strengthen an undirected link between two known nodes."""
    if source == target:
        return
    if source not in valid_ids or target not in valid_ids:
        return
    key = (source, target) if source < target else (target, source)
    existing = links.get(key)
    if existing is None or strength > existing["strength"]:
        links[key] = {
            "source": key[0],
            "target": key[1],
            "strength": strength,
            "type": link_type,
        }


def build_links(modules, categories, dispatch_rules, mandatory_for_triggers,
                tag_web, module_files, keywords_by_module):
    """Derive the filament network from real manifest and dispatch data.

    Link types emitted (spec section 4.4 and Appendix A):
      manifest_co_load      strength 3  adjacency.co_load
      manifest_weak_co_load strength 1  adjacency.weak_co_load
      dependency            strength 3  requires
      trigger_co_load       strength 2  shared entry in mandatory_for_triggers
      session_profile       strength 2  shared session_type_profiles bonus set
      learned_linkage       2 or 3      DISPATCH_RULES.learned_linkages
      tag_web               strength 1  shared manifest tag
      data_flow             strength 3  module -> infrastructure node
    """
    valid_ids = {str(m["id"]) for m in modules} | INFRA_IDS
    links = {}

    # adjacency.co_load / weak_co_load / co_load (legacy flat list) / requires
    for module in modules:
        module_id = str(module["id"])
        adjacency = module.get("adjacency")
        if isinstance(adjacency, dict):
            for target in adjacency.get("co_load") or []:
                _add_link(links, module_id, str(target), 3, "manifest_co_load", valid_ids)
            for target in adjacency.get("weak_co_load") or []:
                _add_link(links, module_id, str(target), 1, "manifest_weak_co_load", valid_ids)
        elif isinstance(adjacency, list):
            for target in adjacency:
                _add_link(links, module_id, str(target), 3, "manifest_co_load", valid_ids)

        for target in module.get("co_load") or []:
            _add_link(links, module_id, str(target), 3, "manifest_co_load", valid_ids)
        for target in module.get("requires") or []:
            _add_link(links, module_id, str(target), 3, "dependency", valid_ids)

    # mandatory_for_triggers: modules that always load together.
    for trigger, module_ids in (mandatory_for_triggers or {}).items():
        group = [str(m) for m in module_ids if str(m) in valid_ids]
        if len(group) < 2 or len(group) > 12:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                _add_link(links, group[i], group[j], 2, "trigger_co_load", valid_ids)

    # session_type_profiles bonus sets.
    for key, profile in (dispatch_rules or {}).items():
        if not isinstance(profile, dict):
            continue
        if key != "session_type_profiles":
            continue
        for profile_name, definition in profile.items():
            if not isinstance(definition, dict):
                continue
            group = [str(m) for m in definition.get("bonus_modules") or [] if str(m) in valid_ids]
            if len(group) < 2 or len(group) > 12:
                continue
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    _add_link(links, group[i], group[j], 2, "session_profile", valid_ids)

    # layer0_mandatory rules.
    layer0 = (dispatch_rules or {}).get("layer0_mandatory") or {}
    for rule in layer0.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        group = [str(m) for m in rule.get("mandatory_modules") or [] if str(m) in valid_ids]
        if len(group) < 2 or len(group) > 12:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                _add_link(links, group[i], group[j], 3, "trigger_co_load", valid_ids)

    # learned_linkages: the dispatcher routes to the module, so the edge runs
    # from DISPATCH. Confidence drives strength.
    learned = (dispatch_rules or {}).get("learned_linkages") or {}
    for rule in learned.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        target = str(rule.get("module_to_add") or "")
        if target not in valid_ids:
            continue
        try:
            confidence = float(rule.get("confidence") or 0.7)
        except (TypeError, ValueError):
            confidence = 0.7
        _add_link(links, "DISPATCH", target, 3 if confidence >= 0.85 else 2, "learned_linkage", valid_ids)

    # tag_web: modules sharing a manifest tag.
    tags_by_module = {}
    for module in modules:
        module_id = str(module["id"])
        tags = [str(t).lower() for t in module.get("tags") or [] if isinstance(t, str)]
        if tags:
            tags_by_module[module_id] = set(tags)
    tag_index = {}
    for module_id, tags in tags_by_module.items():
        for tag in tags:
            tag_index.setdefault(tag, []).append(module_id)
    for tag, module_ids in tag_index.items():
        group = sorted(set(module_ids))
        if len(group) < 2 or len(group) > 6:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                _add_link(links, group[i], group[j], 1, "tag_web", valid_ids)

    # Infrastructure adjacency.
    for node in INFRA_NODES:
        for target in node["adjacency"]:
            _add_link(links, node["id"], target, 3, "data_flow", valid_ids)

    # Module -> infrastructure data flow, inferred from the module body. A module
    # that names a reference/script/archive path or a memory tool really does
    # consume that store, so this is evidence rather than decoration.
    flow_markers = {
        "REFERENCES": (re.compile(r"reference_read|references/|reference_list", re.IGNORECASE), 3),
        "SCRIPTS": (re.compile(r"script_execute|scripts/|script_read", re.IGNORECASE), 3),
        "ARCHIVE": (re.compile(r"archive_read|archive_write|archive/", re.IGNORECASE), 3),
        "MEMORY": (re.compile(r"memory_write|memory_read|memory_search", re.IGNORECASE), 2),
        "PROFILES": (re.compile(r"profile_read|profile_write_person|PROFILES\.md", re.IGNORECASE), 2),
        "INTERNET": (re.compile(r"web_search|news_search|web_fetch_page", re.IGNORECASE), 2),
        "DISPATCH": (re.compile(r"dispatch_rule_add|DISPATCH_RULES", re.IGNORECASE), 2),
    }
    for module in modules:
        module_id = str(module["id"])
        body = (module_files.get(module_id) or {}).get("text") or ""
        if not body:
            continue
        for infra_id, (pattern, strength) in flow_markers.items():
            if pattern.search(body):
                _add_link(links, module_id, infra_id, strength, "data_flow", valid_ids)

    # CORE anchors the always-load set.
    for module in modules:
        if module.get("always_load") or (module.get("mandatory") and module.get("mandatory_for")):
            _add_link(links, "CORE", str(module["id"]), 3, "manifest_co_load", valid_ids)

    return sorted(links.values(), key=lambda item: (-item["strength"], item["source"], item["target"]))


# ---------------------------------------------------------------------------
# Phase 1f: tools
# ---------------------------------------------------------------------------

def classify_tool_type(name):
    """Classify a tool by the connector's naming conventions (spec section 4.3)."""
    lowered = name.lower()
    for pattern, tool_type in TOOL_TYPE_RULES:
        if pattern.search(lowered):
            return tool_type
    return "gateway"


def classify_tool_domain(name):
    """Return 'gateway' when the tool acts on the platform, else 'connector'."""
    lowered = name.lower()
    for prefix in GATEWAY_TOOL_PREFIXES:
        if lowered.startswith(prefix):
            return "gateway"
    return "connector"


def tool_provider(name):
    """Best-effort provider label for a connector tool. None when unknown."""
    lowered = name.lower()
    for prefix, provider in CONNECTOR_PROVIDERS:
        if lowered.startswith(prefix):
            return provider
    return None


def tool_anchor(name):
    """Return the infrastructure node a tool structurally operates on."""
    lowered = name.lower()
    for prefix, anchor in TOOL_ANCHORS:
        if lowered.startswith(prefix):
            return anchor
    return DEFAULT_TOOL_ANCHOR


def short_tool_label(name):
    """Compact belt label, e.g. memory_write -> mem_w, script_execute -> scr_ex."""
    parts = [p for p in name.split("_") if p]
    if not parts:
        return name[:6]
    if len(parts) == 1:
        return parts[0][:6]
    head = parts[0][:3]
    tail = parts[-1][:2]
    return "%s_%s" % (head, tail)


def resolve_tool_catalog(explicit_path):
    """Find the tool catalogue on disk.

    Order: --tools-catalog, then BRAIN_TOOLS_CATALOG, then next to this script,
    which is where the connector writes it at boot.

    Returns:
        str|None: the first path that exists.
    """
    candidates = []
    if explicit_path:
        candidates.append(explicit_path)
    env_path = os.environ.get("BRAIN_TOOLS_CATALOG")
    if env_path:
        candidates.append(env_path)
    candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   TOOL_CATALOG_BASENAME))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def read_tool_catalog(explicit_path):
    """Read the tool registry from disk.

    The connector writes this file at boot from its own live tool list, so it
    cannot disagree with the connector that produced it. The scanner makes no
    network call: the tool list is volume state like everything else it reads.

    Returns:
        (tools, source): tools is a list of {name, description}; source is
        "catalogue" or "none".
    """
    path = resolve_tool_catalog(explicit_path)
    if not path:
        log("WARN no tool catalogue found - the tool belt will be empty")
        return [], "none"

    catalogue = read_json(path, None)
    if not isinstance(catalogue, dict) or not isinstance(catalogue.get("tools"), list):
        log("WARN tool catalogue at %s is unusable - the tool belt will be empty" % path)
        return [], "none"

    tools = catalogue["tools"]
    log("tool catalogue: %d tools from %s (connector %s)" % (
        len(tools), path, catalogue.get("connector_version") or "unknown"))
    return tools, "catalogue"


def scan_tools(catalogue_path, module_files):
    """Build the gateway_tools and connector_tools arrays.

    used_by is inferred by searching each module body for the tool name. A
    module that names the tool genuinely calls it; nothing is invented.

    Returns:
        (gateway_tools, connector_tools, source)
    """
    raw_tools, source = read_tool_catalog(catalogue_path)

    gateway_tools = []
    connector_tools = []

    for raw in raw_tools:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        description = str(raw.get("description") or "").strip()
        if len(description) > 220:
            description = description[:217].rstrip() + "..."

        tool_type = classify_tool_type(name)
        pattern = re.compile(r"\b%s\b" % re.escape(name), re.IGNORECASE)
        mentions = []
        for module_id, meta in module_files.items():
            body = meta.get("text") or ""
            if not body:
                continue
            hits = len(pattern.findall(body))
            if hits:
                mentions.append((hits, module_id))
        mentions.sort(key=lambda item: (-item[0], item[1]))
        used_by = [module_id for _, module_id in mentions[:MAX_TOOL_USED_BY]]

        entry = {
            "name": name,
            "label": short_tool_label(name),
            "type": tool_type,
            "color": TOOL_TYPE_COLOURS.get(tool_type, TOOL_TYPE_COLOURS["gateway"]),
            "description": description,
            "used_by": used_by,
            "anchor": tool_anchor(name),
            "size": round(SIZE_BANDS["tool"][0] + (SIZE_BANDS["tool"][1] - SIZE_BANDS["tool"][0])
                          * clamp(len(used_by) / float(MAX_TOOL_USED_BY), 0.0, 1.0), 3),
        }

        if classify_tool_domain(name) == "gateway":
            gateway_tools.append(entry)
        else:
            provider = tool_provider(name)
            if provider:
                entry["provider"] = provider
            connector_tools.append(entry)

    gateway_tools.sort(key=lambda item: item["name"])
    connector_tools.sort(key=lambda item: item["name"])
    return gateway_tools, connector_tools, source


# ---------------------------------------------------------------------------
# Phase 1g: session state
# ---------------------------------------------------------------------------

def read_last_compile(ava_dir):
    """Read the compile record written by the connector after skill_compile.

    Returns:
        (loaded_module_ids: set, timestamp: str|None, session_id: str|None)
    """
    path = os.path.join(ava_dir, "downloads", LAST_COMPILE_BASENAME)
    payload = read_json(path, None)
    if not isinstance(payload, dict):
        return set(), None, None
    modules = payload.get("modules_loaded") or []
    loaded = {str(m) for m in modules if isinstance(m, (str, int))}
    timestamp = payload.get("timestamp")
    session_id = payload.get("session_id")
    return loaded, (str(timestamp) if timestamp else None), (str(session_id) if session_id else None)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def build_railway_content(directories):
    """Build the Railway content ring entries (spec section 2.3, R * 2.1).

    Files are sampled deterministically when a kind exceeds the render budget
    (spec section 8.4), so the ring stays inside the object budget while the
    meta counts still report the true totals.
    """
    entries = []

    def sample(items, kind):
        if len(items) <= MAX_RAILWAY_NODES_PER_KIND:
            return items
        step = len(items) / float(MAX_RAILWAY_NODES_PER_KIND)
        return [items[int(i * step)] for i in range(MAX_RAILWAY_NODES_PER_KIND)]

    for item in sample(directories["archive"], "archive"):
        entries.append({
            "id": item["id"],
            "label": item["name"],
            "kind": "archive",
            "parent": "ARCHIVE",
            "line_count": item["line_count"],
            "ifa_cycle": item["ifa_cycle"],
            "size": round(SIZE_BANDS["railway"][0] + (SIZE_BANDS["railway"][1] - SIZE_BANDS["railway"][0])
                          * clamp(item["line_count"] / 400.0, 0.0, 1.0), 3),
        })

    for item in sample(directories["references"], "reference"):
        entries.append({
            "id": item["id"],
            "label": item["name"],
            "kind": "reference",
            "parent": "REFERENCES",
            "line_count": item["line_count"],
            "category": item["category"],
            "size": round(SIZE_BANDS["railway"][0] + (SIZE_BANDS["railway"][1] - SIZE_BANDS["railway"][0])
                          * clamp(item["line_count"] / 400.0, 0.0, 1.0), 3),
        })

    for item in sample(directories["scripts"], "script"):
        entries.append({
            "id": item["id"],
            "label": item["name"],
            "kind": "script",
            "parent": "SCRIPTS",
            "line_count": item["line_count"],
            "script_kind": item["kind"],
            "size": round(SIZE_BANDS["railway"][0] + (SIZE_BANDS["railway"][1] - SIZE_BANDS["railway"][0])
                          * clamp(item["line_count"] / 400.0, 0.0, 1.0), 3),
        })

    return entries


def build_payload(ava_dir, catalogue_path, phi_scale):
    """Run the full scan and return the ava_brain_data.json payload."""
    warnings = []

    manifest = scan_manifests(ava_dir)
    directories = scan_directories(ava_dir)
    module_files = directories["module_files"]

    modules = manifest["modules"]

    # Resolve real line counts and categories before positioning. The manifest
    # stays authoritative; frontmatter only fills fields the manifest omits.
    ENRICHABLE = ("summary", "description", "version", "category", "tags",
                  "trigger_keywords", "triggers", "adjacency", "co_load",
                  "mandatory", "always_load", "requires", "mandatory_for")
    for module in modules:
        module_id = str(module["id"])
        file_meta = module_files.get(module_id)
        if file_meta:
            module["_line_count"] = file_meta["line_count"]
            module["_file_category"] = file_meta["category"]
            declared = file_meta.get("line_count_estimate")
            if isinstance(declared, int):
                module["_line_count_estimate"] = declared
            frontmatter = file_meta.get("frontmatter") or {}
            for field in ENRICHABLE:
                if field not in module and field in frontmatter and frontmatter[field] not in ("", None):
                    module[field] = frontmatter[field]
        else:
            # Registered in the manifest but absent from the volume.
            module["_line_count"] = int(module.get("line_count_estimate") or 0)
            module["_file_category"] = None
            module["_missing_file"] = True

    categories = {}
    for module in modules:
        module_id = str(module["id"])
        raw_category = module.get("category")
        category = normalise_category(raw_category) if raw_category else None
        if category in (None, "other") and module.get("_file_category"):
            category = module["_file_category"]
        if not category:
            # Fall back to the manifest path's parent directory.
            path = str(module.get("path") or "")
            parts = path.split("/")
            category = normalise_category(parts[1]) if len(parts) > 2 else "other"
        categories[module_id] = category or "other"

    # Modules present on disk but absent from the manifest still exist in the
    # architecture; surface them rather than silently dropping them.
    manifest_ids = {str(m["id"]) for m in modules}
    orphans = 0
    for module_id, file_meta in sorted(module_files.items()):
        if module_id in manifest_ids:
            continue
        frontmatter = file_meta.get("frontmatter") or {}
        entry = {
            "id": module_id,
            "path": file_meta["rel_path"],
            "category": file_meta["category"],
            "summary": str(
                frontmatter.get("summary")
                or frontmatter.get("description")
                or "Present on the volume, not registered in MANIFEST.json."
            ),
            "_line_count": file_meta["line_count"],
            "_file_category": file_meta["category"],
            "_unregistered": True,
        }
        for field in ("version", "tags", "trigger_keywords", "triggers", "adjacency",
                      "co_load", "mandatory", "always_load"):
            if field in frontmatter and frontmatter[field] not in ("", None):
                entry[field] = frontmatter[field]
        if isinstance(file_meta.get("line_count_estimate"), int):
            entry["_line_count_estimate"] = file_meta["line_count_estimate"]
        modules.append(entry)
        categories[module_id] = file_meta["category"]
        orphans += 1
    if orphans:
        warnings.append("%d module file(s) on the volume are not registered in MANIFEST.json" % orphans)

    keywords_by_module, keyword_links = extract_keywords(modules)
    loaded_ids, last_compile_ts, session_id = read_last_compile(ava_dir)

    if not loaded_ids:
        warnings.append(
            "No downloads/last_compile.json found; isLoaded falls back to the always-load set."
        )

    # Sizes first: the relaxation pass needs them.
    sizes = {}
    for module in modules:
        module_id = str(module["id"])
        sizes[module_id] = _node_size(
            categories[module_id],
            _importance(module, module["_line_count"]),
            module["_line_count"],
            False,
        )
    for node in INFRA_NODES:
        sizes[node["id"]] = _node_size("infra", 1.0, 0, True)

    positions = compute_ellipsoid_coordinates(modules, categories, phi_scale)

    # Infrastructure sits on the core axis: CORE at the centre, the rest on a
    # small deep ring around it (spec section 7, Brainstem / Core).
    infra_count = len(INFRA_NODES)
    for index, node in enumerate(INFRA_NODES):
        if node["id"] == "CORE":
            positions[node["id"]] = {"xyz": [0.0, 0.0, 0.0], "depth": 0.0, "region": "Brainstem / Core"}
            continue
        angle = 2.0 * math.pi * (index / float(max(infra_count - 1, 1)))
        radius = 4.2
        positions[node["id"]] = {
            "xyz": [
                round(math.cos(angle) * radius, 3),
                round(math.sin(angle * 0.5) * 1.8, 3),
                round(math.sin(angle) * radius * 0.8, 3),
            ],
            "depth": 0.22,
            "region": "Brainstem / Core",
        }

    # CORE is the anatomical origin (spec section 7): it anchors, never drifts.
    _relax_positions(positions, sizes, pinned={"CORE"})

    nodes = []
    for node in INFRA_NODES:
        node_id = node["id"]
        nodes.append({
            "id": node_id,
            "label": node["label"],
            "category": "infra",
            "region": positions[node_id]["region"],
            "color": PALETTE["infra"],
            "size": sizes[node_id],
            "isMandatory": True,
            "isLoaded": True,
            "isInfrastructure": True,
            "description": node["description"],
            "source": node["source"],
            "keywords": node["keywords"][:MAX_KEYWORDS_PER_MODULE],
            "xyz": positions[node_id]["xyz"],
            "depth": positions[node_id]["depth"],
            "line_count": count_lines(os.path.join(ava_dir, "CORE.md")) if node_id == "CORE" else 0,
        })

    for module in modules:
        module_id = str(module["id"])
        category = categories[module_id]
        is_mandatory = bool(module.get("mandatory") or module.get("always_load") or module.get("mandatory_for"))
        is_loaded = module_id in loaded_ids if loaded_ids else bool(module.get("always_load") or module.get("mandatory"))
        description = str(
            module.get("summary")
            or module.get("description")
            or "No summary registered in the manifest."
        )
        if len(description) > 400:
            description = description[:397].rstrip() + "..."

        node = {
            "id": module_id,
            "label": module_id.replace("-", " ").title(),
            "category": category,
            "region": positions[module_id]["region"],
            "color": PALETTE.get(category, PALETTE["other"]),
            "size": sizes[module_id],
            "isMandatory": is_mandatory,
            "isLoaded": is_loaded,
            "isInfrastructure": False,
            "isUnregistered": bool(module.get("_unregistered")),
            "isMissingFile": bool(module.get("_missing_file")),
            "description": description,
            "path": str(module.get("path") or ""),
            "version": str(module.get("version") or ""),
            "keywords": keywords_by_module.get(module_id, []),
            "xyz": positions[module_id]["xyz"],
            "depth": positions[module_id]["depth"],
            "line_count": module["_line_count"],
            "adjacency": sorted({
                str(t) for t in (
                    (module.get("adjacency", {}).get("co_load", [])
                     if isinstance(module.get("adjacency"), dict)
                     else (module.get("adjacency") or []))
                    + (module.get("co_load") or [])
                )
            }),
        }
        if "_line_count_estimate" in module:
            node["line_count_estimate"] = module["_line_count_estimate"]
        nodes.append(node)

    dispatch_rules = read_json(os.path.join(ava_dir, "DISPATCH_RULES.json"), {}) or {}
    links = build_links(
        modules,
        categories,
        dispatch_rules,
        manifest["mandatory_for_triggers"],
        manifest["tag_web"],
        module_files,
        keywords_by_module,
    )

    gateway_tools, connector_tools, tools_source = scan_tools(catalogue_path, module_files)
    if tools_source == "none":
        warnings.append(
            "No tool catalogue on the volume: gateway_tools and connector_tools are empty. "
            "The connector writes %s at boot." % TOOL_CATALOG_BASENAME
        )

    railway_content = build_railway_content(directories)

    node_ids = {node["id"] for node in nodes}
    dropped = [link for link in links if link["source"] not in node_ids or link["target"] not in node_ids]
    if dropped:
        links = [link for link in links if link["source"] in node_ids and link["target"] in node_ids]
        warnings.append("%d link(s) referenced unknown module ids and were dropped." % len(dropped))

    # Keyword links may reference modules that were dropped: filter them too.
    keyword_links = [
        link for link in keyword_links
        if all(module_id in node_ids for module_id in link["modules"])
    ]

    loaded_count = sum(1 for node in nodes if node["isLoaded"])

    payload = {
        "timestamp": utc_now_iso(),
        "schema_version": SCHEMA_VERSION,
        "manifest_version": manifest["manifest_version"],
        "manifest_append_version": manifest["manifest_append_version"],
        "manifest_fragments": manifest.get("manifest_fragments") or {"files": [], "modules_added": 0, "skipped_existing": 0},
        "meta": {
            "total_modules": len([n for n in nodes if not n["isInfrastructure"]]),
            "total_scripts": directories["counts"]["scripts"],
            "total_references": directories["counts"]["references"],
            "total_archive_files": directories["counts"]["archive"],
            "total_gateway_tools": len(gateway_tools),
            "total_connector_tools": len(connector_tools),
            "total_links": len(links),
            "total_keyword_links": len(keyword_links),
            "total_railway_nodes": len(railway_content),
            "session_loaded_modules": loaded_count,
            "session_id": session_id,
            "last_compile_timestamp": last_compile_ts,
            "tools_source": tools_source,
            "scanner_version": SCANNER_VERSION,
            "ellipsoid": {"a": ELLIPSOID_A, "b": ELLIPSOID_B, "c": ELLIPSOID_C},
            "warnings": warnings,
        },
        "palette": PALETTE,
        "tool_type_colors": TOOL_TYPE_COLOURS,
        "regions": {key: lobe["region"] for key, lobe in LOBES.items()},
        "nodes": nodes,
        "links": links,
        "keyword_links": keyword_links,
        "gateway_tools": gateway_tools,
        "connector_tools": connector_tools,
        "railway_content": railway_content,
    }
    return payload


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_json_atomic(path, payload):
    """Write JSON via a temp file + rename so readers never see a partial file."""
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    temp_path = "%s.tmp.%d" % (path, os.getpid())
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.replace(temp_path, path)


def source_paths(ava_dir):
    """Inputs whose mtimes decide whether a rescan is needed (spec section 8.2)."""
    return [
        os.path.join(ava_dir, "MANIFEST.json"),
        os.path.join(ava_dir, "MANIFEST_APPEND.json"),
        os.path.join(ava_dir, "DISPATCH_RULES.json"),
        os.path.join(ava_dir, "CORE.md"),
        os.path.join(ava_dir, "modules"),
        os.path.join(ava_dir, "references"),
        os.path.join(ava_dir, "scripts"),
        os.path.join(ava_dir, "archive"),
        os.path.join(ava_dir, "downloads", LAST_COMPILE_BASENAME),
    ]


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="brain_scan.py",
        description="Scan the Ava skill volume and emit ava_brain_data.json for the Neural Core visualiser.",
    )
    parser.add_argument("--ava-dir", default=os.environ.get("AVA_DIR", DEFAULT_AVA_DIR),
                        help="Skill volume root (default: %s)" % DEFAULT_AVA_DIR)
    parser.add_argument("--out-file", default=None,
                        help="Canonical output path (default: {ava-dir}/downloads/%s)" % OUTPUT_BASENAME)
    parser.add_argument("--mirror-dir", default=os.environ.get("BRAIN_MIRROR_DIR", DEFAULT_MIRROR_DIR),
                        help="Directory to mirror the JSON into for GET /download (default: %s). "
                             "Pass an empty string to disable." % DEFAULT_MIRROR_DIR)
    parser.add_argument("--output", default=None,
                        help="Extra output directory. Populated for script_execute return_files.")
    parser.add_argument("--input", default=None,
                        help="JSON job file (script_execute compatibility). "
                             "Recognised keys: ava_dir, out_file, force, phi_scale, "
                             "tools_catalog.")
    parser.add_argument("--tools-catalog", default=None,
                        help="Path to brain_tools_catalog.json "
                             "(default: $BRAIN_TOOLS_CATALOG, else next to this script).")
    parser.add_argument("--phi-scale", type=float, default=None,
                        help="Override the longitudinal scale factor. 1.0 uses the spec's degrees literally.")
    parser.add_argument("--force", action="store_true",
                        help="Rescan even when the existing output is newer than every input.")
    parser.add_argument("--print", dest="print_payload", action="store_true",
                        help="Print the full payload to stdout instead of a summary.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])

    ava_dir = args.ava_dir
    force = args.force
    out_file = args.out_file
    phi_scale = args.phi_scale

    # script_execute passes --input <tempfile>. Honour it as an override source.
    if args.input:
        job = read_json(args.input, None)
        if isinstance(job, dict):
            ava_dir = str(job.get("ava_dir") or ava_dir)
            out_file = job.get("out_file") or out_file
            force = bool(job.get("force")) or force
            if job.get("phi_scale") is not None:
                phi_scale = float(job["phi_scale"])
            if job.get("tools_catalog"):
                args.tools_catalog = str(job["tools_catalog"])
        elif job is not None:
            log("WARN --input file is not a JSON object; ignoring")

    ava_dir = os.path.abspath(ava_dir)
    if not os.path.isdir(ava_dir):
        log("FATAL ava dir not found: %s" % ava_dir)
        print(json.dumps({"ok": False, "error": "ava_dir not found: %s" % ava_dir}))
        return 1

    if not out_file:
        out_file = os.path.join(ava_dir, "downloads", OUTPUT_BASENAME)
    out_file = os.path.abspath(out_file)

    # Early exit when nothing changed (spec section 8.2).
    if not force and os.path.isfile(out_file):
        try:
            output_mtime = os.path.getmtime(out_file)
        except OSError:
            output_mtime = 0.0
        newest_input = newest_mtime(source_paths(ava_dir))
        if newest_input and output_mtime >= newest_input:
            log("no changes since last scan - skipping (use --force to override)")
            print(json.dumps({
                "ok": True,
                "skipped": True,
                "reason": "output newer than all inputs",
                "output": out_file,
                "output_age_seconds": int(time.time() - output_mtime),
            }))
            return 0

    started = time.time()
    try:
        payload = build_payload(ava_dir, args.tools_catalog, phi_scale)
    except RuntimeError as exc:
        log("FATAL %s" % exc)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    except Exception as exc:  # noqa: BLE001 - the scanner must never crash the caller
        log("FATAL unexpected error: %s" % exc)
        print(json.dumps({"ok": False, "error": "unexpected error: %s" % exc}))
        return 1

    payload["meta"]["scan_duration_ms"] = int((time.time() - started) * 1000)

    written = []
    try:
        write_json_atomic(out_file, payload)
        written.append(out_file)
    except OSError as exc:
        log("FATAL cannot write %s: %s" % (out_file, exc))
        print(json.dumps({"ok": False, "error": "cannot write %s: %s" % (out_file, exc)}))
        return 1

    if args.mirror_dir:
        mirror_path = os.path.join(args.mirror_dir, OUTPUT_BASENAME)
        if os.path.abspath(mirror_path) != out_file:
            try:
                write_json_atomic(mirror_path, payload)
                written.append(mirror_path)
            except OSError as exc:
                # A missing mirror is not fatal: the canonical file is the source
                # of truth and the gateway falls back to it.
                log("WARN cannot write mirror %s: %s" % (mirror_path, exc))

    if args.output:
        extra_path = os.path.join(args.output, OUTPUT_BASENAME)
        if os.path.abspath(extra_path) not in (os.path.abspath(p) for p in written):
            try:
                write_json_atomic(extra_path, payload)
                written.append(extra_path)
            except OSError as exc:
                log("WARN cannot write %s: %s" % (extra_path, exc))

    meta = payload["meta"]
    log("scan complete in %dms: %d nodes, %d links, %d keyword links, %d tools" % (
        meta["scan_duration_ms"],
        len(payload["nodes"]),
        len(payload["links"]),
        len(payload["keyword_links"]),
        meta["total_gateway_tools"] + meta["total_connector_tools"],
    ))
    for warning in meta["warnings"]:
        log("WARN %s" % warning)

    if args.print_payload:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(json.dumps({
            "ok": True,
            "skipped": False,
            "written": written,
            "timestamp": payload["timestamp"],
            "nodes": len(payload["nodes"]),
            "links": len(payload["links"]),
            "keyword_links": len(payload["keyword_links"]),
            "railway_content": len(payload["railway_content"]),
            "gateway_tools": meta["total_gateway_tools"],
            "connector_tools": meta["total_connector_tools"],
            "session_loaded_modules": meta["session_loaded_modules"],
            "tools_source": meta["tools_source"],
            "warnings": meta["warnings"],
            "scan_duration_ms": meta["scan_duration_ms"],
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
