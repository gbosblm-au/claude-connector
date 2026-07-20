#!/usr/bin/env python3
"""
homework_assessment.py  (Phase 5b: Assessed Homework PDF Render)

Given a homework spec and a student's answers, assesses each answer and renders a
formal marked PDF: colour-coded markers, a per-page score badge, tone-calibrated
comments, and a footer results summary with strong / focus areas.

The three triggers in the spec (A file upload, B in-session review, C session
summary reconstruction) all converge on the same input shape: a JSON object with
the questions, each carrying the correct answer and the student's answer. This
script assesses + renders that set. A light text-answer extractor is included for
Trigger A (DOCX/PDF text); image answers need manual entry.

Assessment markers are drawn as vector shapes in the spec colours, so the PDF
renders identically without depending on an emoji font being installed.

Input JSON (via --input FILE or stdin):
{
  "homework_slug": "reading-week-3",
  "student_name": "Mila",
  "student_age": 12,
  "questions": [
    {
      "number": 1,
      "concept": "Author's tone",
      "question": "What does the author suggest by ...",
      "correct_answer": "The author is being sarcastic",
      "student_answer": "The author is mocking the committee",
      "assessment": "correct",          // optional; computed if omitted
      "comment": "..."                    // optional; generated if omitted
    }
  ]
}

Usage:
  homework_assessment.py --input answers.json --output marked.pdf
  cat answers.json | homework_assessment.py --output marked.pdf
"""

import argparse
import json
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Flowable, KeepTogether,
)

BRAND_DARK = colors.HexColor("#326E60")
CORRECT_COLOR = colors.HexColor("#2E7D32")
PARTIAL_COLOR = colors.HexColor("#E65100")
INCORRECT_COLOR = colors.HexColor("#C62828")

ASSESS_COLOR = {"correct": CORRECT_COLOR, "partial": PARTIAL_COLOR, "incorrect": INCORRECT_COLOR}
ASSESS_LABEL = {"correct": "Correct", "partial": "Partially Correct", "incorrect": "Incorrect"}

# Tone calibration by age band (spec Table 1). Comment templates per assessment.
AGE_BANDS = [
    (8, 10, "warm"),
    (11, 13, "moderate"),
    (14, 16, "formal"),
    (17, 200, "professional"),
]

TONE_COMMENTS = {
    "warm": {
        "correct": "Great job! You got this one right!",
        "partial": "Good effort! You had the right idea, just missed a little bit.",
        "incorrect": "Not quite this time, but that's okay. Let's look at it together.",
    },
    "moderate": {
        "correct": "Spot on - you nailed it.",
        "partial": "Close! You had the right idea but missed a step.",
        "incorrect": "Not quite. Have another look at the key detail.",
    },
    "formal": {
        "correct": "Correct. Well identified.",
        "partial": "Partially correct. The main idea is there but the detail is incomplete.",
        "incorrect": "Incorrect. Review the key concept and try the reasoning again.",
    },
    "professional": {
        "correct": "Correct. Well-reasoned answer.",
        "partial": "Partially correct. The reasoning is sound but incomplete.",
        "incorrect": "Incorrect. Reconsider the underlying principle.",
    },
}


def tone_for_age(age):
    if age is None:
        return "moderate"
    try:
        age = int(age)
    except (TypeError, ValueError):
        return "moderate"
    for lo, hi, band in AGE_BANDS:
        if lo <= age <= hi:
            return band
    return "moderate"


def _normalize(text):
    return re.sub(r"[^a-z0-9 ]", "", (text or "").strip().lower())


def _tokens(text):
    return set(t for t in _normalize(text).split() if len(t) > 2)


def assess_answer(correct, student):
    """Return correct | partial | incorrect from a normalized comparison."""
    c_norm, s_norm = _normalize(correct), _normalize(student)
    if not s_norm:
        return "incorrect"
    if c_norm and (c_norm == s_norm or c_norm in s_norm or s_norm in c_norm):
        return "correct"
    c_tokens, s_tokens = _tokens(correct), _tokens(student)
    if not c_tokens:
        return "partial" if s_norm else "incorrect"
    overlap = len(c_tokens & s_tokens) / len(c_tokens)
    if overlap >= 0.8:
        return "correct"
    if overlap >= 0.35:
        return "partial"
    return "incorrect"


def evaluate(questions):
    """Assess every question, returning enriched records + tallies."""
    results = []
    tally = {"correct": 0, "partial": 0, "incorrect": 0}
    for i, q in enumerate(questions, start=1):
        assessment = (q.get("assessment") or "").strip().lower()
        if assessment not in ASSESS_COLOR:
            assessment = assess_answer(q.get("correct_answer", ""), q.get("student_answer", ""))
        tally[assessment] += 1
        results.append({
            "number": q.get("number", i),
            "concept": q.get("concept", ""),
            "question": q.get("question", ""),
            "correct_answer": q.get("correct_answer", ""),
            "student_answer": q.get("student_answer", ""),
            "assessment": assessment,
            "comment": q.get("comment") or "",
        })
    return results, tally


def score_points(tally):
    """Correct = 1, partial = 0.5. Returns (points, total, percentage)."""
    total = tally["correct"] + tally["partial"] + tally["incorrect"]
    points = tally["correct"] + 0.5 * tally["partial"]
    pct = round((points / total) * 100) if total else 0
    return points, total, pct


def _fmt_points(points):
    return str(int(points)) if float(points).is_integer() else f"{points:.1f}"


def strong_and_focus(results):
    """Concepts all-correct -> strong; concepts with any partial/incorrect -> focus."""
    by_concept = {}
    for r in results:
        if not r["concept"]:
            continue
        by_concept.setdefault(r["concept"], []).append(r["assessment"])
    strong, focus = [], []
    for concept, marks in by_concept.items():
        if all(m == "correct" for m in marks):
            strong.append(concept)
        else:
            focus.append(concept)
    return strong, focus


# --------------------------------------------------------------------------- #
# Drawn vector marks (no emoji font dependency)
# --------------------------------------------------------------------------- #

class Mark(Flowable):
    """A small coloured symbol: check, cross, lightbulb, star, or book."""

    def __init__(self, kind, size=11, color=colors.black):
        super().__init__()
        self.kind = kind
        self.size = size
        self.color = color
        self.width = size
        self.height = size

    def draw(self):
        c = self.canv
        s = self.size
        c.setStrokeColor(self.color)
        c.setFillColor(self.color)
        c.setLineWidth(max(1.2, s * 0.14))
        if self.kind == "check":
            c.line(s * 0.15, s * 0.5, s * 0.42, s * 0.22)
            c.line(s * 0.42, s * 0.22, s * 0.85, s * 0.78)
        elif self.kind == "cross":
            c.line(s * 0.2, s * 0.2, s * 0.8, s * 0.8)
            c.line(s * 0.8, s * 0.2, s * 0.2, s * 0.8)
        elif self.kind == "lightbulb":
            c.circle(s * 0.5, s * 0.58, s * 0.3, stroke=1, fill=0)
            c.setLineWidth(max(1.0, s * 0.12))
            c.line(s * 0.38, s * 0.2, s * 0.62, s * 0.2)
            c.line(s * 0.4, s * 0.1, s * 0.6, s * 0.1)
        elif self.kind == "star":
            self._star(c, s * 0.5, s * 0.5, s * 0.5, s * 0.22)
        elif self.kind == "book":
            c.setLineWidth(max(1.0, s * 0.1))
            c.line(s * 0.5, s * 0.2, s * 0.5, s * 0.8)
            c.rect(s * 0.15, s * 0.2, s * 0.35, s * 0.6, stroke=1, fill=0)
            c.rect(s * 0.5, s * 0.2, s * 0.35, s * 0.6, stroke=1, fill=0)

    def _star(self, c, cx, cy, r_out, r_in):
        import math
        p = c.beginPath()
        for i in range(10):
            ang = math.pi / 2 + i * math.pi / 5
            r = r_out if i % 2 == 0 else r_in
            x, y = cx + r * math.cos(ang), cy + r * math.sin(ang)
            (p.moveTo if i == 0 else p.lineTo)(x, y)
        p.close()
        c.drawPath(p, stroke=0, fill=1)


MARK_FOR_ASSESS = {"correct": "check", "partial": "lightbulb", "incorrect": "cross"}


# --------------------------------------------------------------------------- #
# PDF rendering
# --------------------------------------------------------------------------- #

def _page_decorator(points, total, pct):
    badge_text = f"Score: {_fmt_points(points)}/{total} ({pct}%)"

    def _on_page(canvas, doc):
        canvas.saveState()
        w, h = A4
        bw, bh = 46 * mm, 9 * mm
        x, y = w - doc.rightMargin - bw, h - doc.topMargin - bh + 4 * mm
        canvas.setFillColor(BRAND_DARK)
        canvas.roundRect(x, y, bw, bh, 3, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.drawCentredString(x + bw / 2, y + bh / 2 - 3.4, badge_text)
        canvas.restoreState()

    return _on_page


def build_pdf(data, output_path):
    questions = data.get("questions", [])
    results, tally = evaluate(questions)
    points, total, pct = score_points(tally)
    band = tone_for_age(data.get("student_age"))
    strong, focus = strong_and_focus(results)

    styles = getSampleStyleSheet()
    h_style = ParagraphStyle("Head", parent=styles["Heading1"], textColor=BRAND_DARK, fontSize=16)
    q_style = ParagraphStyle("Q", parent=styles["Normal"], fontSize=10.5, leading=14, spaceAfter=2)
    meta_style = ParagraphStyle("Meta", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#555555"), leading=12)
    comment_style = ParagraphStyle("Cmt", parent=styles["Normal"], fontSize=10, leading=13)

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm, leftMargin=18 * mm, rightMargin=18 * mm,
        title="Assessed Homework",
    )

    story = []
    name = data.get("student_name", "")
    slug = data.get("homework_slug", "")
    heading = "Assessed Homework"
    if slug:
        heading += f": {slug}"
    story.append(Paragraph(heading, h_style))
    subtitle = " ".join(x for x in [f"Student: {name}" if name else "", f"Age band: {band}"] if x)
    story.append(Paragraph(subtitle, meta_style))
    story.append(Spacer(1, 8))

    for r in results:
        assessment = r["assessment"]
        color = ASSESS_COLOR[assessment]
        comment = r["comment"] or TONE_COMMENTS[band][assessment]

        block = []
        qnum = r["number"]
        concept = f'  <font color="#777777">[{r["concept"]}]</font>' if r["concept"] else ""
        block.append(Paragraph(f'<b>Q{qnum}.</b> {_esc(r["question"])}{concept}', q_style))
        if r["student_answer"]:
            block.append(Paragraph(f'Your answer: {_esc(r["student_answer"])}', meta_style))
        if r["correct_answer"] and assessment != "correct":
            block.append(Paragraph(f'Model answer: {_esc(r["correct_answer"])}', meta_style))

        mark = Mark(MARK_FOR_ASSESS[assessment], size=12, color=color)
        label = f'<font color="{_hex(color)}"><b>{ASSESS_LABEL[assessment]}.</b></font> {_esc(comment)}'
        row = Table([[mark, Paragraph(label, comment_style)]], colWidths=[8 * mm, None])
        row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
        ]))
        block.append(row)
        block.append(Spacer(1, 9))
        story.append(KeepTogether(block))

    story.append(Spacer(1, 6))
    story.append(_summary_box(tally, points, total, pct, strong, focus, styles))

    doc.build(story, onFirstPage=_page_decorator(points, total, pct),
              onLaterPages=_page_decorator(points, total, pct))

    return {"ok": True, "output": output_path, "score": f"{_fmt_points(points)}/{total}",
            "percentage": pct, "tally": tally, "band": band,
            "strong_areas": strong, "focus_areas": focus}


def _summary_box(tally, points, total, pct, strong, focus, styles):
    title_style = ParagraphStyle("SumTitle", parent=styles["Heading2"], textColor=BRAND_DARK, fontSize=12, spaceAfter=4)
    body = ParagraphStyle("SumBody", parent=styles["Normal"], fontSize=10, leading=14)

    rows = [[Paragraph("<b>Results Summary</b>", title_style), ""]]
    rows.append([Paragraph("Correct", body), Paragraph(str(tally["correct"]), body)])
    rows.append([Paragraph("Partially correct", body), Paragraph(str(tally["partial"]), body)])
    rows.append([Paragraph("Incorrect", body), Paragraph(str(tally["incorrect"]), body)])
    rows.append([Paragraph("<b>Total score</b>", body),
                 Paragraph(f"<b>{_fmt_points(points)}/{total} ({pct}%)</b>", body)])

    strong_cell = _area_cell("Strong areas", "star", CORRECT_COLOR, strong or ["-"], body)
    focus_cell = _area_cell("Focus areas", "book", PARTIAL_COLOR, focus or ["-"], body)
    rows.append([strong_cell, focus_cell])

    t = Table(rows, colWidths=[85 * mm, 85 * mm])
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 1, BRAND_DARK),
        ("INNERGRID", (0, 0), (-1, -2), 0.4, colors.HexColor("#DDDDDD")),
        ("SPAN", (0, 0), (1, 0)),
        ("SPAN", (0, len(rows) - 1), (0, len(rows) - 1)),
        ("SPAN", (1, len(rows) - 1), (1, len(rows) - 1)),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF2F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def _area_cell(title, mark_kind, color, items, body_style):
    inner = [[Mark(mark_kind, size=11, color=color), Paragraph(f"<b>{title}</b>", body_style)]]
    header = Table(inner, colWidths=[7 * mm, None])
    header.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0),
                                ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    parts = [header, Paragraph(", ".join(_esc(i) for i in items), body_style)]
    wrap = Table([[p] for p in parts], colWidths=[None])
    wrap.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 1),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
    return wrap


def _esc(text):
    return (str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _hex(color):
    """'#rrggbb' string for a reportlab Color (for inline <font color=...>)."""
    return "#{:02X}{:02X}{:02X}".format(int(color.red * 255), int(color.green * 255), int(color.blue * 255))


# --------------------------------------------------------------------------- #
# Trigger A helper: extract answers from plain text (DOCX/PDF already-extracted)
# --------------------------------------------------------------------------- #

def extract_answers_from_text(text, spec_questions):
    """Best-effort: map 'Q<n>: answer' or '<n>. answer' lines onto spec questions."""
    answers = {}
    for m in re.finditer(r"(?:^|\n)\s*(?:q|question)?\s*(\d+)[\).:]\s*(.+)", text, re.IGNORECASE):
        answers[int(m.group(1))] = m.group(2).strip()
    merged = []
    for i, q in enumerate(spec_questions, start=1):
        num = q.get("number", i)
        merged.append({**q, "student_answer": answers.get(num, q.get("student_answer", ""))})
    return merged


def main(argv=None):
    parser = argparse.ArgumentParser(description="Render an assessed homework PDF.")
    parser.add_argument("--input", default=None, help="JSON file; reads stdin if omitted.")
    parser.add_argument("--output", required=True, help="Output PDF path.")
    parser.add_argument("--extract-text", default=None,
                        help="Optional text file of student answers to merge (Trigger A).")
    args = parser.parse_args(argv)

    raw = open(args.input, "r", encoding="utf-8").read() if args.input else sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "error": f"invalid JSON input: {err}"}))
        return 1

    if args.extract_text:
        text = open(args.extract_text, "r", encoding="utf-8").read()
        data["questions"] = extract_answers_from_text(text, data.get("questions", []))

    if not data.get("questions"):
        print(json.dumps({"ok": False, "error": "no questions provided"}))
        return 1

    try:
        summary = build_pdf(data, args.output)
    except Exception as err:  # noqa: BLE001 - surface any render failure as JSON
        print(json.dumps({"ok": False, "error": f"render failed: {err}"}))
        return 1

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
