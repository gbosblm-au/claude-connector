#!/usr/bin/env python3
"""book_extract.py -- text extraction for the Tenax Reading Vault.

TIP-BOOK-001 Sections 5 and 6. Connector v13.21.0.

===========================================================================
WHAT THIS DOES, AND THE ONE THING IT MUST NEVER DO
===========================================================================

Turns a PDF, EPUB or text file into chapters plus the unsplit raw text, as
JSON on stdout. The gateway stores it; the model never sees it.

Section 5.2's closing paragraph is the governing rule, and it is worth
restating because every shortcut in text extraction violates it:

    no OCR-only fallback that drops non-body text, no stripping of paragraph
    breaks (breaks are meaning in fiction and poetry), preserve accented and
    non-Latin characters as UTF-8 (never convert to ASCII), preserve
    punctuation. Text is the first-class object; anything that discards
    characters to save space is a defect.

So there is no cleanup pass here. No unicode normalisation -- NFC would fold
composed and decomposed accents, which changes bytes an author chose. No
smart-quote folding, no dehyphenation, no whitespace collapsing beyond joining
the lines PDF layout invents mid-sentence. Where this script is unsure, it
keeps the characters.

===========================================================================
WHY CHAPTER DETECTION IS ALLOWED TO FAIL
===========================================================================

Section 6.1 accepts that heuristics mis-split poorly structured PDFs, and
requires the raw full text be preserved alongside the chapters so nothing is
lost to a bad split. That is what makes an aggressive heuristic safe: the worst
case costs boundaries, never content.

When nothing reliable is found, the whole text becomes chapter 1 with
is_fallback set (Section 6.2) rather than a guess dressed up as chapters.

===========================================================================
IMAGES (v13.45.0, WORK-ORDER-2026-11-26-01)
===========================================================================

With --images the payload also carries an `images` block: every image found
in the book, in reading order, with the exact character position it occupies
in the stored text (chapter-relative and raw_text-relative), its publisher alt
text, any figcaption attributed to it, its size and a content hash. With
--images describe the deduplicated image bytes travel too, so the gateway can
describe them. The TEXT is never changed by either mode: positions are
computed beside the unchanged extraction, and without --images the output is
byte-identical to v13.44.0.

A scanned PDF whose pages are single page-sized images is not an illustrated
book: the block says so by name (routing.refused) and the image pass leaves
it to the OCR correction layer.

Usage:
    book_extract.py --path FILE [--format pdf|epub|txt] [--max-pages N]
                    [--images count|describe] [--image-max-bytes N]
                    [--image-payload-budget N]
    book_extract.py --stdin --format txt
"""

import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter
from html import unescape
from urllib.parse import unquote

# Section 5.2 step 5. Ordered most specific first: 'CHAPTER ONE' should be read
# as a chapter heading rather than as a bare roman/word numeral line.
CHAPTER_PATTERNS = [
    re.compile(r"^\s*(?:CHAPTER|Chapter)\s+([0-9]+|[IVXLCDM]+|[A-Za-z]+)\b\s*(.*)$"),
    # v13.40.0 (WO-2026-11-21-01 B.5): DIVISION and SECTION beside PART and
    # BOOK (Heidegger, Arendt, Buber).
    re.compile(r"^\s*(?:PART|Part|BOOK|Book|DIVISION|Division|SECTION|Section)\s+([0-9]+|[IVXLCDM]+|[A-Za-z]+)\b\s*(.*)$"),
    # v13.21.3. "1. A Parade in Erhenrang" -- a number, a separator, and a
    # title on the same line. The commonest chapter style in modern fiction,
    # and the one that made the pilot book extract as a single chapter: it uses
    # neither the word CHAPTER nor a number alone on a line, so nothing here
    # matched and the fallback fired on a book with twenty real chapters.
    #
    # The title is required. Without it this collapses into the bare-number
    # rule below and would match every page number in the book.
    re.compile(r"^\s*([0-9]{1,3})\s*[.:\u2014-]\s+(\S.*)$"),
    re.compile(r"^\s*([IVXLCDM]{1,7})\s*[.:\u2014-]\s+(\S.*)$"),
    # v13.40.0 (B.5). A section sign and a number at line start (Wittgenstein's
    # remarks; Kant's "\u00a7 1."), and a standalone ALL-CAPS line (Hegel's
    # PREFACE, CONTENTS, FOREWORD). Both explicit. An all-caps line that
    # repeats is a running header, which the rejection rule removes.
    re.compile(r"^\s*\u00A7\s*(\d+)\.?(?:\s+(.*))?$"),
    re.compile(r"^\s*(?=[A-Z][A-Z0-9 ,'\u2019&\-]{2,59}$)(?=.*[A-Z]{3})([^a-z]+)$"),
    # A bare number alone on a line. Common in fiction, and the loosest rule
    # here -- guarded by the plausibility check in choose_chapters().
    re.compile(r"^\s*([0-9]{1,3})\s*$"),
    re.compile(r"^\s*([IVXLCDM]{1,7})\s*$"),
]

# Patterns 0-5 name a chapter EXPLICITLY: the word CHAPTER, PART, BOOK,
# DIVISION or SECTION, a numeral followed by a title, a section sign and a
# number, or a standalone ALL-CAPS line (v13.40.0 widened 0-3 to 0-5). Patterns
# 6-7 match a bare numeral, which in a printed book is far more often a page
# number than a chapter; the title-case rule ranks with them.
#
# v13.21.3. The two are ranked rather than pooled, and the pilot book is why.
# The Left Hand of Darkness has nine headings of the form "1. A Parade in
# Erhenrang" and a page number every few paragraphs. Pooled, that is nine real
# marks against eighty-one spurious ones: the median section drops to about
# 900 characters, the plausibility check refuses the split, and a book with
# twenty chapters is stored as one.
#
# So when the explicit patterns find a book's worth of headings, the bare
# numerals are ignored entirely. They remain as a last resort for books that
# genuinely number chapters and nothing else -- which exist, and for which the
# plausibility check is still the guard.
STRONG_PATTERNS = 6

# v13.40.0 (WO-2026-11-21-01 B.5). Widening the patterns mints false chapters
# unless something refuses the fragments that look like headings. The fixture is
# Being and Time, where "Part Two likewise has three divisions:1" -- a footnote
# fragment -- was detected as a chapter title. A candidate is refused when it:
#   ends with a colon followed by a numeral or a superscript marker;
#   carries a footnote-like numeric run (digits glued to a word);
#   continues a sentence (the previous line ends open and this one opens lower case);
#   repeats more than three times in the body (a running header or footer);
#   is text that also appears in the endnotes.
SUPERSCRIPTS = "\u00B9\u00B2\u00B3\u2070\u2071\u2074\u2075\u2076\u2077\u2078\u2079"
NOTES_HEADING = re.compile(r"^\s*(?:NOTES|Notes|ENDNOTES|Endnotes)\s*$")
TITLE_SMALL_WORDS = {"a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
                     "of", "on", "or", "the", "to", "with"}


def heading_rejection(line, previous):
    """Why a heading candidate is refused (the B.5 rejection rule), or None."""
    t = line.strip()
    if re.search(r":\s*[0-9%s]+\s*$" % SUPERSCRIPTS, t):
        return "colon_then_numeral"
    if re.search(r"[A-Za-z][.,;:]?[%s]" % SUPERSCRIPTS, t) or re.search(r"[a-z]{2}[0-9]{1,3}\b", t):
        return "footnote_marker"
    prev = (previous or "").strip()
    if prev and re.search(r"[A-Za-z,;\u2014-]$", prev) and re.match(r"[a-z]", t):
        return "sentence_continuation"
    return None


def title_case_heading(lines, index):
    """B.5's last rule: a short line in title case, not ending in terminal
    punctuation, followed by a blank line and a body paragraph. Weak: ranked
    with the bare numerals, so explicit headings win where a book has them."""
    t = lines[index].strip()
    if not t or len(t) > 60 or re.search(r"[.!?:;,]$", t):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'\u2019-]*", t)
    if not words or len(words) > 10:
        return False
    if not all(w[0].isupper() or w.lower() in TITLE_SMALL_WORDS for w in words):
        return False
    if not words[0][0].isupper():
        return False
    following = lines[index + 1:index + 3]
    return (len(following) == 2 and not following[0].strip()
            and len(following[1].strip()) >= 300)


def candidate_marks(lines):
    """Every heading candidate, as (line_no, text, pattern_no, rejection).

    pattern_no is the CHAPTER_PATTERNS index, or len(CHAPTER_PATTERNS) for the
    title-case rule (weak). rejection is None for a kept candidate."""
    counts = Counter(l.strip() for l in lines if l.strip() and len(l.strip()) <= 60)
    notes_at = None
    for i, line in enumerate(lines):
        if NOTES_HEADING.match(line):
            notes_at = i
    endnotes = "\n".join(lines[notes_at + 1:]) if notes_at is not None else ""

    marks = []
    previous = ""
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        number = None
        if len(line) <= 90:
            for n, pattern in enumerate(CHAPTER_PATTERNS):
                if pattern.match(line):
                    number = n
                    break
            if number is None and title_case_heading(lines, index):
                number = len(CHAPTER_PATTERNS)
        if number is not None:
            rejection = heading_rejection(stripped, previous)
            if rejection is None and counts.get(stripped, 0) > 3:
                rejection = "running_header"
            if (rejection is None and notes_at is not None and index < notes_at
                    and len(stripped) >= 20 and stripped in endnotes):
                rejection = "in_endnotes"
            marks.append((index, stripped, number, rejection))
        previous = stripped
    return marks


def is_strong(pattern_no):
    """An explicit heading: patterns 0 to STRONG_PATTERNS-1."""
    return pattern_no < STRONG_PATTERNS


# Below this, a "chapter" is a heading page, a dedication or a section break
# caught by the bare-number rule -- not a chapter. Deliberately generous: a
# genuinely short chapter exists, and merging one into its neighbour loses a
# boundary, which the raw text can repair.
MIN_CHAPTER_CHARS = 500

# Under this, an extraction that returned SOMETHING has still effectively
# failed. Section 6.1 wants image-only PDFs to surface a clear error rather
# than produce empty chapters; a scanned book often yields a few characters of
# stray metadata rather than exactly zero.
MIN_BOOK_CHARS = 200


@contextlib.contextmanager
def protected_stdout():
    """Keep library chatter out of the JSON on stdout.

    ── Why this is necessary rather than tidy ───────────────────────────────

    This script's entire contract is one JSON object on stdout. A single line
    printed by a dependency destroys it, and the caller sees a parse error
    rather than a book -- which points at this script rather than at the
    library that spoke.

    It is not hypothetical. PyMuPDF's legacy `fitz` import emits a deprecation
    notice, and on some builds that notice goes to stdout: the first PDF run of
    this script returned unparseable output for exactly that reason.

    So stdout is pointed at stderr for the whole extraction, and the real
    stream is handed back only to write the result. Diagnostics are not lost;
    they land in the log where they belong.
    """
    real = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield real
    finally:
        sys.stdout = real


def fail(code, message, **detail):
    """Emit a typed error and stop. Section 9.

    Typed because the responses differ: no_text_layer means find another copy,
    unreadable_file means try the upload again. A single generic failure would
    make those indistinguishable to the caller.
    """
    out = {"ok": False, "error": code, "message": message}
    if detail:
        out["detail"] = detail
    # __stdout__, not sys.stdout: fail() is called from inside
    # protected_stdout(), where sys.stdout points at stderr. Writing there
    # would send the error into the log and leave the caller with nothing.
    json.dump(out, sys.__stdout__, ensure_ascii=False)
    sys.__stdout__.write("\n")
    sys.__stdout__.flush()
    sys.exit(0)  # A described failure is a successful run of this script.


def strip_nul(text):
    """Remove U+0000, and nothing else.

    v13.21.6. The single exception to Section 5.2's rule that nothing may
    discard characters, and it is narrow enough to state exactly.

    PostgreSQL cannot store a NUL in a text or jsonb column. jsonb answers
    "unsupported Unicode escape sequence" and text answers "invalid byte
    sequence"; neither is a size limit or an encoding mismatch, and no retry
    changes it. So a NUL anywhere in a book makes that book unstorable, and
    makes any conversation quoting it unstorable too -- which is how one turned
    up: a session snapshot that could never be persisted, failing on every
    flush forever.

    NUL is not a character anyone wrote. It arrives from malformed embedded
    fonts and from padding in PDF and EPUB containers, nothing renders it, and
    removing it changes no word, no punctuation mark and no accent.

    Every other byte is left exactly as found.
    """
    return text.replace("\x00", "") if text else text


def words_in(text):
    """Approximate word count. Section 6.1: a sanity flag, not a hard gate."""
    return len(text.split()) if text and text.strip() else 0


def join_pdf_lines(page_text):
    """Repair the line breaks PDF layout inserts mid-sentence.

    ── Why this is not "stripping paragraph breaks" ─────────────────────────

    A PDF has no paragraphs. It has lines placed on a page, and a sentence
    running across a column becomes several lines with no marker saying they
    are one. Storing those breaks verbatim would make every chapter a column of
    fragments, unreadable and wrong for a screen reader.

    So single newlines inside a paragraph are joined and BLANK lines -- the one
    signal a PDF does give for a paragraph boundary -- are preserved exactly.
    Section 5.3 requires paragraph and stanza structure to survive, and this is
    what surviving means for this format.

    A hyphen at a line end is left alone. Dehyphenating would have to guess
    whether 'well-\\nbeing' is one word or two, and Section 5.2 says preserve
    punctuation rather than guess.
    """
    paragraphs = re.split(r"\n[ \t]*\n", page_text)
    joined = []
    for para in paragraphs:
        lines = [ln.strip() for ln in para.split("\n")]
        joined.append(" ".join(ln for ln in lines if ln))
    return "\n\n".join(p for p in joined if p)


def extract_pdf(path, max_pages=None, images=None):
    """Extract a PDF via PyMuPDF, preserving reading order. Section 5.2 step 2.

    `images` (v13.45.0) is an ImageCollector, or None. When given, each page's
    images are recorded against that page's text; the text is unchanged."""
    # `pymupdf` first: importing the legacy `fitz` alias prints a deprecation
    # notice, and on some builds it prints it to STDOUT -- which lands in the
    # middle of the JSON this script exists to produce. Guarded generally by
    # protected_stdout() below; preferring the modern name avoids the noise at
    # source as well.
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz  # PyMuPDF, legacy import name
        except ImportError:
            fail("extractor_unavailable",
                 "PyMuPDF is not installed on this connector.")

    try:
        doc = fitz.open(path)
    except Exception as exc:  # noqa: BLE001 - any open failure is the same answer
        fail("unreadable_file", "The PDF could not be opened: %s" % exc)

    pages = []
    limit = len(doc) if max_pages is None else min(len(doc), max_pages)
    for index in range(limit):
        # sort=True asks PyMuPDF for reading order rather than the order shapes
        # happen to appear in the file. Section 5.3 requires logical reading
        # order for screen-reader compatibility, and a two-column page in file
        # order interleaves the columns line by line.
        raw = doc[index].get_text("text", sort=True)
        pages.append(join_pdf_lines(raw))
        if images is not None:
            images.pdf_page(fitz, doc, index, pages[-1])

    total_pages = len(doc)
    if images is not None:
        images.pdf_finish(fitz, doc, pages, limit)
    doc.close()

    body = "\n\n".join(p for p in pages if p.strip())

    # Section 6.1. A scanned book reaches here with a handful of characters
    # from an embedded label, not with zero, so the threshold is on content
    # rather than on emptiness.
    if len(body.strip()) < MIN_BOOK_CHARS:
        fail("no_text_layer",
             "This PDF has no extractable text layer -- it is almost certainly "
             "a scan. OCR is deliberately out of scope for v1.",
             pages=total_pages, extracted_chars=len(body.strip()))

    return strip_nul(body), {"pages": total_pages, "pages_read": limit}


def strip_html(markup):
    """HTML to text, keeping block boundaries. Section 5.2 step 3.

    Block-level tags become blank lines BEFORE tags are removed, so paragraph
    and stanza structure survives the strip. Removing tags first and then
    trying to infer paragraphs is the mistake that turns a poem into prose.
    """
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", markup)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|blockquote|tr)\s*>", "\n\n", text)
    text = re.sub(r"(?i)<(p|div|h[1-6]|li|blockquote|tr)[^>]*>", "", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = unescape(text)

    # Runs of blank lines collapse to one boundary. Trailing spaces on a line
    # go. Nothing else is touched: no normalisation, no quote folding.
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_epub(path, images=None):
    """Unpack an EPUB and extract its HTML in spine order. Section 5.2 step 3.

    `images` (v13.45.0) is an ImageCollector, or None. When given, each
    document's images are recorded with their position in that document's
    text; the text is computed exactly as without it."""
    try:
        archive = zipfile.ZipFile(path)
    except Exception as exc:  # noqa: BLE001
        fail("unreadable_file", "The EPUB could not be opened: %s" % exc)

    names = archive.namelist()

    # Spine order where the OPF gives it. An EPUB's files are frequently named
    # in an order that is not reading order, and Section 5.3 requires logical
    # reading order -- sorting by filename would silently shuffle the book.
    opf = next((n for n in names if n.lower().endswith(".opf")), None)
    ordered = []
    if opf:
        try:
            manifest = archive.read(opf).decode("utf-8", errors="replace")
            ids = dict(re.findall(r'id="([^"]+)"[^>]*href="([^"]+)"', manifest))
            base = os.path.dirname(opf)
            for ref in re.findall(r'<itemref[^>]*idref="([^"]+)"', manifest):
                href = ids.get(ref)
                if not href:
                    continue
                full = os.path.normpath(os.path.join(base, href)) if base else href
                if full in names:
                    ordered.append(full)
        except Exception:  # noqa: BLE001 - a malformed OPF falls back below
            ordered = []

    if not ordered:
        ordered = sorted(n for n in names
                         if n.lower().endswith((".xhtml", ".html", ".htm")))

    parts = []
    for name in ordered:
        try:
            # errors="replace" rather than "ignore": a replacement character is
            # visible damage that can be found later, where a silently dropped
            # byte is the "discards characters" defect Section 5.2 names.
            markup = archive.read(name).decode("utf-8", errors="replace")
            chunk = strip_html(markup)
        except Exception:  # noqa: BLE001
            continue
        if images is not None:
            # Recorded for every document, including one with no text (a
            # cover page): its images are placed beside the nearest text.
            images.epub_document(archive, name, markup, chunk,
                                 bool(chunk.strip()))
        if chunk.strip():
            parts.append(chunk)

    if images is not None:
        images.epub_finish()
    archive.close()
    body = "\n\n".join(parts)

    if len(body.strip()) < MIN_BOOK_CHARS:
        fail("no_extractable_text",
             "No readable text was found in this EPUB.",
             documents=len(ordered))

    # v13.21.5. The spine IS the chapter structure, declared by the publisher.
    #
    # Running the text heuristic over a concatenated EPUB throws that away and
    # then tries to guess it back from headings -- which fails badly on books
    # that have no headings to find. Discworld novels are the clearest case:
    # most have no chapters at all, only scene breaks, so a heading search
    # returns nothing and the whole novel becomes one chapter. The spine still
    # knows where the sections are.
    #
    # Documents shorter than MIN_CHAPTER_CHARS are folded into the previous
    # one, because a spine is full of cover pages, title pages, copyright
    # notices and dedications, and each is its own document.
    sections = []
    for name, text in zip(ordered, parts):
        if sections and len(text) < MIN_CHAPTER_CHARS:
            sections[-1]["content"] += "\n\n" + text
        else:
            sections.append({"title": epub_title(text), "content": text})

    for section in sections:
        section["content"] = strip_nul(section["content"])
    return strip_nul(body), {"documents": len(ordered), "spine_sections": sections}


def epub_title(text):
    """The first short line of a section, if it looks like a heading.

    Not a guess at structure -- the spine already settled that. This only names
    a section the reader can already see, and returns None rather than inventing
    a title from the first sentence of prose.
    """
    for line in text.split("\n")[:5]:
        stripped = line.strip()
        if stripped and len(stripped) <= 80:
            return stripped
    return None


def extract_txt(path):
    """Plain text, as-is. Section 5.2 step 4."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except Exception as exc:  # noqa: BLE001
        fail("unreadable_file", "The file could not be read: %s" % exc)

    # UTF-8 first, then Latin-1, which cannot fail and preserves every byte as
    # SOME character. Section 5.2: never convert to ASCII, never drop bytes.
    try:
        body = raw.decode("utf-8")
    except UnicodeDecodeError:
        body = raw.decode("latin-1")

    if len(body.strip()) < MIN_BOOK_CHARS:
        fail("no_extractable_text", "The file is empty or too short to be a book.",
             extracted_chars=len(body.strip()))

    return strip_nul(body), {"bytes": len(raw)}


# ===========================================================================
# IMAGES (v13.45.0, WORK-ORDER-2026-11-26-01)
# ===========================================================================
#
# The collector never changes text. It records, beside the unchanged
# extraction, where each image sits in that text, so the gateway can insert
# the image's description at exactly that point (R1) and can remove it again
# exactly (the interleave, sequence and readability measures are computed on
# the text without descriptions, so they cannot move).

IMAGE_MODES = ("count", "describe")
IMAGE_SCHEMA = 1

IMAGE_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
}
# Sent to the vision model as they are, when small enough. Anything else is
# re-encoded through Pillow, or reported as an unsupported format.
VISION_READY_TYPES = ("image/png", "image/jpeg", "image/webp")
VISION_MAX_SIDE = 1600
DEFAULT_IMAGE_MAX_BYTES = 3000000
DEFAULT_IMAGE_PAYLOAD_BUDGET = 30000000

# R11. An image covering this share of its page is a page image, not a figure.
FULL_PAGE_SHARE = 0.85
# A PDF where at least this share of the pages read carry a page image is a
# scan with a text layer: refused by the image pass, by name, for OCR.
SCANNED_PAGE_SHARE = 0.6
# A page image on a page with at least this much text is the scan under an
# OCR text layer; on a page with less, it is a full-page plate (a figure).
PAGE_IMAGE_TEXT_CHARS = 200
# R6. A PDF caption: a text block this close to the image that opens like one.
CAPTION_GAP_PT = 72
PDF_CAPTION = re.compile(
    r"^\s*(?:figure|fig\.|table|plate|illustration|chart|map|diagram|exhibit)"
    r"\s*[0-9ivxlc]", re.I)

IMG_TAG = re.compile(r"(?is)<(?:img|(?:svg:)?image)\b[^>]*>")
TAG_ATTR = re.compile(r"""([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
FIGURE = re.compile(r"(?is)<figure\b[^>]*>(.*?)</figure\s*>")
FIGCAPTION = re.compile(r"(?is)<figcaption\b[^>]*>(.*?)</figcaption\s*>")


def tag_attributes(tag):
    """An HTML tag's attributes as a lower-cased dict, values unescaped."""
    out = {}
    for name, dq, sq, bare in TAG_ATTR.findall(tag):
        value = dq if dq or (not sq and not bare) else (sq or bare)
        out[name.lower()] = unescape(value)
    return out


def sentinel_pair(markup):
    """Two private-use characters that occur nowhere in the markup or its
    unescaped text, used to mark image positions while the text is computed."""
    decoded = unescape(markup)
    for code in range(0xE000, 0xF8FF, 2):
        a, b = chr(code), chr(code + 1)
        if a not in markup and b not in markup and a not in decoded and b not in decoded:
            return a, b
    return None


def sub_tracked(pattern, repl, text, positions):
    """re.sub(pattern, repl, text) with every position carried through.

    A position inside a replaced run lands inside the replacement, clamped to
    its length; a position after it moves by the change in length."""
    pieces, spans, cursor, out_len = [], [], 0, 0
    for m in pattern.finditer(text):
        pieces.append(text[cursor:m.start()])
        out_len += m.start() - cursor
        spans.append((m.start(), m.end(), out_len, len(repl)))
        pieces.append(repl)
        out_len += len(repl)
        cursor = m.end()
    pieces.append(text[cursor:])
    moved = []
    for p in positions:
        new, delta = None, 0
        for start, end, new_start, rlen in spans:
            if p < start:
                break
            if p < end:
                new = new_start + min(p - start, rlen)
                break
            delta = (new_start + rlen) - end
        moved.append(new if new is not None else p + delta)
    return "".join(pieces), moved


TRAILING_SPACE = re.compile(r"[ \t]+\n")
BLANK_RUN = re.compile(r"\n{3,}")


def html_image_positions(markup):
    """The images of one HTML document and where each sits in strip_html(markup).

    Runs strip_html's own steps with a sentinel in place of each image tag,
    lifts the sentinels out, and carries their positions through the same
    whitespace normalisation. The text it arrives at is compared with
    strip_html(markup), the text actually stored; where they differ (which
    would mean a step here has drifted from strip_html) every position is
    None rather than a guess.

    Returns (images, exact): images is a list of dicts with attrs, caption
    and position (an index into strip_html(markup), or None)."""
    pair = sentinel_pair(markup)
    if pair is None:
        found = [{"attrs": tag_attributes(m.group(0)), "caption": None,
                  "caption_source": None, "position": None}
                 for m in IMG_TAG.finditer(markup)]
        return found, False
    open_s, close_s = pair
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", markup)
    found = []

    def mark(m):
        found.append({"attrs": tag_attributes(m.group(0)), "caption": None,
                      "caption_source": None, "position": None})
        return "%s%d%s" % (open_s, len(found) - 1, close_s)

    text = IMG_TAG.sub(mark, text)
    if not found:
        return [], True
    token = re.compile(re.escape(open_s) + r"(\d+)" + re.escape(close_s))

    # R6: a figcaption inside the same <figure> as the image is the caption
    # the publisher attached to it, attributable with confidence.
    for fig in FIGURE.finditer(text):
        inner = fig.group(1)
        ids = [int(i) for i in token.findall(inner)]
        cap = FIGCAPTION.search(inner)
        if not ids or not cap:
            continue
        caption = token.sub("", strip_html(cap.group(1))).strip()
        if caption:
            for i in ids:
                found[i]["caption"] = caption[:600]
                found[i]["caption_source"] = "figcaption"

    # strip_html's steps 2 to 6, unchanged.
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|blockquote|tr)\s*>", "\n\n", text)
    text = re.sub(r"(?i)<(p|div|h[1-6]|li|blockquote|tr)[^>]*>", "", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = unescape(text)

    # Lift the sentinels out, recording where each stood.
    plain, positions, cursor = [], [None] * len(found), 0
    length = 0
    for m in token.finditer(text):
        plain.append(text[cursor:m.start()])
        length += m.start() - cursor
        positions[int(m.group(1))] = length
        cursor = m.end()
    plain.append(text[cursor:])
    text = "".join(plain)

    # strip_html's whitespace steps, with the positions carried through.
    known = [i for i, p in enumerate(positions) if p is not None]
    carried = [positions[i] for i in known]
    text, carried = sub_tracked(TRAILING_SPACE, "\n", text, carried)
    text, carried = sub_tracked(BLANK_RUN, "\n\n", text, carried)
    lead = len(text) - len(text.lstrip())
    stripped = text.strip()
    carried = [min(max(p - lead, 0), len(stripped)) for p in carried]

    exact = stripped == strip_html(markup)
    for i, p in zip(known, carried):
        found[i]["position"] = p if exact else None
    return found, exact


def substantive_alt(alt):
    """R3: the alt text if it describes anything, else None.

    Empty or whitespace alt text, and alt text that is a filename or an asset
    id, is not a description: a filename is never stored as one."""
    if alt is None:
        return None
    text = re.sub(r"\s+", " ", alt).strip()
    if len(text) < 3:
        return None
    if re.fullmatch(r"[\w\-./\\]+\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?)", text, re.I):
        return None
    # An asset id: one token of letters, digits, separators, with a digit and
    # no space ("fig_0012", "img-3f9a2c", "Image00045").
    if " " not in text and re.fullmatch(r"[\w\-.:#]+", text) and re.search(r"\d", text):
        return None
    if text.lower() in ("image", "picture", "photo", "figure", "illustration",
                        "graphic", "img", "cover", "cover image", "untitled"):
        return None
    return text[:1500]


def image_dimensions(data):
    """(width, height) through Pillow, or (None, None)."""
    try:
        from PIL import Image  # Pillow: in the connector image (Dockerfile)
        with Image.open(io.BytesIO(data)) as im:
            return int(im.size[0]), int(im.size[1])
    except Exception:  # noqa: BLE001 - unknown size is reported as unknown
        return None, None


def vision_copy(data, media_type, max_bytes):
    """The bytes to send to the vision model, or the reason there are none.

    Small PNG, JPEG and WebP go as they are. Anything larger than
    VISION_MAX_SIDE on a side, or than max_bytes, or in another raster format,
    is re-encoded through Pillow (PNG where there is transparency, JPEG
    otherwise). SVG is not a raster and is reported as unsupported.

    Returns (bytes, media_type, None) or (None, None, reason)."""
    if media_type == "image/svg+xml":
        return None, None, "unsupported_format"
    width, height = image_dimensions(data)
    small = (width is not None and max(width, height) <= VISION_MAX_SIDE)
    if media_type in VISION_READY_TYPES and small and len(data) <= max_bytes:
        return data, media_type, None
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001
        if media_type in VISION_READY_TYPES and len(data) <= max_bytes:
            return data, media_type, None
        return None, None, "unsupported_format"
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            frame = im.copy()
        frame.thumbnail((VISION_MAX_SIDE, VISION_MAX_SIDE))
        alpha = frame.mode in ("RGBA", "LA") or (
            frame.mode == "P" and "transparency" in frame.info)
        buf = io.BytesIO()
        if alpha:
            frame.convert("RGBA").save(buf, format="PNG", optimize=True)
            out_type = "image/png"
        else:
            frame.convert("RGB").save(buf, format="JPEG", quality=85)
            out_type = "image/jpeg"
        out = buf.getvalue()
    except Exception:  # noqa: BLE001 - a corrupt image is reported, never guessed
        return None, None, "corrupt_image"
    if len(out) > max_bytes:
        return None, None, "too_large"
    return out, out_type, None


class ImageCollector:
    """Every image in a book, in reading order, beside the unchanged text."""

    def __init__(self, mode, fmt, max_bytes, payload_budget):
        self.mode = mode
        self.format = fmt
        self.max_bytes = max(1, int(max_bytes or DEFAULT_IMAGE_MAX_BYTES))
        self.payload_budget = max(0, int(payload_budget or 0))
        self.payload_used = 0
        self.placements = []          # dicts, reading order
        self.assets = {}              # key -> asset dict
        self.notes = []
        self.routing = None
        self.page_images_excluded = 0
        # EPUB: one entry per spine document, in order.
        self.documents = []
        # PDF: one entry per page read.
        self.pages = []

    # ── assets ──────────────────────────────────────────────────────────

    def add_asset(self, key, data, media_type, origin):
        """Register an image's bytes once per content hash (R9 dedupe)."""
        asset = self.assets.get(key)
        if asset is not None:
            asset["occurrences"] += 1
            return key
        width, height = image_dimensions(data) if data is not None else (None, None)
        asset = {"key": key, "media_type": media_type,
                 "bytes": len(data) if data is not None else None,
                 "width": width, "height": height, "occurrences": 1,
                 "origin": origin}
        if self.mode == "describe":
            if data is None:
                asset["data_omitted"] = "no_bytes"
            else:
                payload, out_type, reason = vision_copy(data, media_type, self.max_bytes)
                if reason:
                    asset["data_omitted"] = reason
                elif self.payload_used + len(payload) > self.payload_budget:
                    asset["data_omitted"] = "payload_budget"
                else:
                    self.payload_used += len(payload)
                    asset["data_base64"] = base64.b64encode(payload).decode("ascii")
                    asset["data_media_type"] = out_type
                    asset["data_bytes"] = len(payload)
        self.assets[key] = asset
        return key

    # ── EPUB ────────────────────────────────────────────────────────────

    def epub_document(self, archive, name, markup, chunk, has_text):
        """Record one spine document's images against its text."""
        try:
            found, exact = html_image_positions(markup)
        except Exception as exc:  # noqa: BLE001 - never fail the extraction
            self.notes.append("images in %s could not be located: %s" % (name, exc))
            found, exact = [], False
        names = set(archive.namelist())
        base = os.path.dirname(name)
        entries = []
        for img in found:
            attrs = img["attrs"]
            href = attrs.get("src") or attrs.get("xlink:href") or attrs.get("href") or ""
            key, missing = None, None
            if href.startswith("data:"):
                head, _, payload = href.partition(",")
                mtype = head[5:].split(";")[0] or "application/octet-stream"
                try:
                    data = base64.b64decode(payload) if ";base64" in head else unquote(payload).encode("utf-8")
                    key = self.add_asset("sha256:" + hashlib.sha256(data).hexdigest(), data, mtype, "data_uri")
                except Exception:  # noqa: BLE001
                    missing = "unreadable_data_uri"
            elif href:
                target = os.path.normpath(os.path.join(base, unquote(href.split("#")[0])))
                target = target.replace("\\", "/")
                if target in names:
                    try:
                        data = archive.read(target)
                        mtype = IMAGE_MEDIA_TYPES.get(os.path.splitext(target)[1].lower(),
                                                      "application/octet-stream")
                        key = self.add_asset("sha256:" + hashlib.sha256(data).hexdigest(),
                                             data, mtype, target)
                    except Exception:  # noqa: BLE001
                        missing = "unreadable_asset"
                else:
                    missing = "asset_missing"
            else:
                missing = "no_source"
            entries.append({
                "asset": key, "asset_problem": missing,
                "alt": substantive_alt(attrs.get("alt")),
                "alt_present": "alt" in attrs,
                "caption": img["caption"], "caption_source": img["caption_source"],
                "position": img["position"] if exact else None,
                "href": href[:300] if not href.startswith("data:") else "data:",
                "document": name,
            })
        self.documents.append({"name": name, "chunk": chunk, "has_text": has_text,
                               "images": entries})

    def epub_finish(self):
        """Body offsets for every EPUB image.

        The body is the non-empty documents joined by a blank line, with NUL
        removed (extract_epub, strip_nul), so a position in a document's text
        moves by the documents before it and by the NULs before it in its own
        text. An image in a document with no text (a cover page) is placed at
        the start of the next document with text, or at the end of the last."""
        offset = 0
        pending = []
        last_end = None
        for doc in self.documents:
            if not doc["has_text"]:
                pending.extend(doc["images"])
                continue
            clean = strip_nul(doc["chunk"])
            for img in pending:
                self.place(img, offset, "adjacent")
            pending = []
            for img in doc["images"]:
                p = img.pop("position")
                if p is None:
                    self.place(img, offset, "document")
                else:
                    p -= doc["chunk"][:p].count("\x00")
                    self.place(img, offset + p, "exact")
            last_end = offset + len(clean)
            offset += len(clean) + 2
        for img in pending:
            self.place(img, last_end if last_end is not None else 0, "adjacent")

    # ── PDF ─────────────────────────────────────────────────────────────

    def pdf_page(self, fitz, doc, index, page_text):
        """Record one page's images against its text (join_pdf_lines output)."""
        entry = {"index": index, "text": page_text, "images": []}
        self.pages.append(entry)
        try:
            page = doc[index]
            rect = page.rect
            area = max(1.0, rect.width * rect.height)
            infos = page.get_image_info(hashes=True, xrefs=True)
            if not infos:
                return
            blocks = [b for b in page.get_text("blocks", sort=True) if len(b) > 6 and b[6] == 0]
        except Exception as exc:  # noqa: BLE001 - never fail the extraction
            self.notes.append("images on page %d could not be read: %s" % (index + 1, exc))
            return
        search_from = 0
        for info in infos:
            try:
                box = fitz.Rect(info["bbox"]) & rect
            except Exception:  # noqa: BLE001
                continue
            if box.is_empty or box.width <= 0 or box.height <= 0:
                continue
            share = (box.width * box.height) / area
            full_page = share >= FULL_PAGE_SHARE
            # A page-sized image's bytes are read only once it is known to be
            # a figure (pdf_finish): a scan's pages must not fill the payload.
            source = {"xref": int(info.get("xref") or 0), "box": tuple(box),
                      "digest": info.get("digest"), "page": index}
            key, problem = (None, None) if full_page else self.pdf_asset(fitz, doc, source)

            # Position: after the text block that ends above the image. Its
            # last line is the anchor, and the anchor is taken at the same
            # occurrence count it has in the blocks up to that one, because a
            # repeated sentence would otherwise pull the image to its first
            # appearance on the page.
            before = [b for b in blocks if b[3] <= box.y0 + 2]
            offset, precision = 0, "block"
            if before:
                lines = [ln.strip() for ln in before[-1][4].split("\n") if ln.strip()]
                anchor = lines[-1][-50:] if lines else ""
                prefix = join_pdf_lines("\n\n".join(b[4] for b in before))
                wanted = prefix.count(anchor) if anchor else 0
                at, seen = -1, 0
                while anchor and wanted:
                    at = page_text.find(anchor, at + 1)
                    if at < 0:
                        break
                    seen += 1
                    if seen == wanted:
                        break
                if anchor and wanted and at >= 0 and seen == wanted:
                    offset = max(at + len(anchor), search_from)
                    search_from = offset
                else:
                    offset, precision = len(page_text), "page"

            # R6: one caption-shaped block just below or above, or none.
            near = []
            for b in blocks:
                text = join_pdf_lines(b[4]).strip()
                if not PDF_CAPTION.match(text):
                    continue
                below = 0 <= b[1] - box.y1 <= CAPTION_GAP_PT
                above = 0 <= box.y0 - b[3] <= CAPTION_GAP_PT
                if below or above:
                    near.append(text)
            caption = near[0][:600] if len(near) == 1 else None
            entry["images"].append({
                "asset": key, "asset_problem": problem, "alt": None, "alt_present": False,
                "caption": caption,
                "caption_source": "pdf_adjacent" if caption else ("ambiguous" if near else None),
                "page": index + 1, "page_share": round(share, 3),
                "full_page": full_page, "source": source if full_page else None,
                "position": offset, "precision": precision,
            })

    def pdf_asset(self, fitz, doc, source):
        """Register one PDF image's bytes. Returns (key, problem).

        An image with an xref is read as stored; an inline image (xref 0) is
        keyed by PyMuPDF's digest and, when its bytes are needed, rendered
        from its rectangle on the page."""
        try:
            if source["xref"] > 0:
                got = doc.extract_image(source["xref"])
                data = got.get("image") if got else None
                if not data:
                    return None, "unreadable_asset"
                mtype = IMAGE_MEDIA_TYPES.get("." + str(got.get("ext", "")).lower(),
                                              "application/octet-stream")
                return self.add_asset("sha256:" + hashlib.sha256(data).hexdigest(),
                                      data, mtype, "xref:%d" % source["xref"]), None
            digest = source["digest"]
            marker = digest.hex() if isinstance(digest, (bytes, bytearray)) else str(digest)
            data = None
            if self.mode == "describe" and ("inline:" + marker) not in self.assets:
                page = doc[source["page"]]
                data = page.get_pixmap(clip=fitz.Rect(source["box"]), dpi=150).tobytes("png")
            return self.add_asset("inline:" + marker, data, "image/png", "inline"), None
        except Exception:  # noqa: BLE001 - reported, never fatal to the extraction
            return None, "unreadable_asset"

    def pdf_finish(self, fitz, doc, pages, pages_read):
        """Body offsets for every PDF image, and the scanned-book refusal.

        The body is the non-empty pages joined by a blank line, then NUL
        removed (extract_pdf), so a page's offset is the length of the pages
        with text before it. An image on a page with no text is placed at the
        start of the next page with text, or at the end of the last."""
        with_full = sum(1 for e in self.pages if any(i["full_page"] for i in e["images"]))
        if pages_read and with_full / float(pages_read) >= SCANNED_PAGE_SHARE:
            self.routing = {
                "refused": "scanned_pdf_page_images",
                "route": "ocr_correction",
                "pages_read": pages_read, "pages_with_page_image": with_full,
                "reason": ("%d of %d pages read are a single page-sized image: this is a "
                           "scanned book with a text layer, not an illustrated one. Its page "
                           "images are not figures and are not described; the text belongs "
                           "to the OCR correction layer." % (with_full, pages_read)),
            }
        offset, pending, last_end = 0, [], None
        for e in self.pages:
            imgs = []
            for img in e["images"]:
                source = img.pop("source", None)
                if img["full_page"] and self.routing:
                    # A scanned book's pages are not its figures (R11, test 9).
                    self.page_images_excluded += 1
                    continue
                if img["full_page"]:
                    if len(e["text"].strip()) >= PAGE_IMAGE_TEXT_CHARS:
                        # The scan under an OCR layer on one page: not a figure.
                        self.page_images_excluded += 1
                        continue
                    # A full-page plate in a born-digital book: a figure.
                    img["asset"], img["asset_problem"] = self.pdf_asset(fitz, doc, source)
                imgs.append(img)
            if not e["text"].strip():
                pending.extend(imgs)
                continue
            clean = strip_nul(e["text"])
            for img in pending:
                img.pop("position", None)
                img.pop("precision", None)
                self.place(img, offset, "adjacent")
            pending = []
            for img in imgs:
                p = img.pop("position")
                precision = img.pop("precision")
                p -= e["text"][:p].count("\x00")
                self.place(img, offset + p, precision)
            last_end = offset + len(clean)
            offset += len(clean) + 2
        for img in pending:
            img.pop("position", None)
            img.pop("precision", None)
            self.place(img, last_end if last_end is not None else 0, "adjacent")

    # ── placement and the report ────────────────────────────────────────

    def place(self, img, raw_offset, precision):
        img = dict(img)
        img.pop("full_page", None)
        img["raw_offset"] = raw_offset
        img["precision"] = precision
        img["index"] = len(self.placements)
        self.placements.append(img)

    def report(self, body, chapters):
        """The images block: placements mapped onto the chapters, and assets.

        Each chapter's content is a verbatim slice of the body (the EPUB spine
        sections and choose_chapters both cut the body), so its start is found
        in order and an image's chapter offset is its body offset minus that
        start. An image in a gap between chapters (a heading line, or front
        matter before the first) goes to the start of the next chapter, or the
        end of the last."""
        starts, cursor = [], 0
        for c in chapters:
            content = c.get("content", "")
            at = body.find(content, cursor) if content else -1
            if at < 0 and content:
                at = body.find(content)
            starts.append(at)
            if at >= 0:
                cursor = at + len(content)
        mapped = []
        for img in self.placements:
            raw = img["raw_offset"]
            target = None
            for c, start in zip(chapters, starts):
                if start >= 0 and start <= raw <= start + len(c.get("content", "")):
                    target = (c.get("ordinal"), raw - start, img["precision"])
                    break
            if target is None:
                later = [(start, c) for c, start in zip(chapters, starts) if start > raw]
                if later:
                    target = (later[0][1].get("ordinal"), 0, "adjacent")
                elif chapters:
                    last = chapters[-1]
                    target = (last.get("ordinal"), len(last.get("content", "")), "adjacent")
            out = dict(img)
            if target is None:
                out.update({"chapter_ordinal": None, "offset": None, "precision": "unplaced"})
            else:
                out.update({"chapter_ordinal": target[0], "offset": target[1], "precision": target[2]})
            mapped.append(out)
        assets = {}
        for key, a in self.assets.items():
            assets[key] = dict(a)
        return {
            "schema": IMAGE_SCHEMA,
            "mode": self.mode,
            "format": self.format,
            "image_count": len(mapped),
            "unique_count": len({m["asset"] for m in mapped if m["asset"]}),
            "page_images_excluded": self.page_images_excluded,
            "routing": self.routing,
            "payload_bytes": self.payload_used,
            "payload_budget": self.payload_budget,
            "max_bytes": self.max_bytes,
            "placements": mapped,
            "assets": assets,
            "notes": self.notes[:20],
        }


def images_summary(block):
    """The images block without placements or bytes, for the stdout summary."""
    return {
        "mode": block.get("mode"),
        "image_count": block.get("image_count"),
        "unique_count": block.get("unique_count"),
        "page_images_excluded": block.get("page_images_excluded"),
        "routing": (block.get("routing") or {}).get("refused"),
        "payload_bytes": block.get("payload_bytes"),
        "assets_without_data": sum(1 for a in (block.get("assets") or {}).values()
                                   if a.get("data_omitted")),
    }


def heading_report(body):
    """Every candidate heading, and why the split was accepted or refused.

    v13.21.3. Chapter detection is heuristic (Section 6.1), which means the
    only way to tune it for a particular book is to see what it saw. Guessing
    at a PDF's heading style from the outside is how the pilot book came back
    as one chapter.

    Prints to stderr, so it never disturbs the JSON contract on stdout.
    """
    lines = body.split("\n")
    every = candidate_marks(lines)
    rejected = [m for m in every if m[3] is not None]
    marks = [(i, t, n) for i, t, n, r in every if r is None]
    if rejected:
        print("rejected candidates: %d (B.5 rejection rule)" % len(rejected), file=sys.stderr)
        for index, text, _, why in rejected[:20]:
            print("  line %-7d %-20s %s" % (index, why, text[:60]), file=sys.stderr)

    strong_count = sum(1 for _, _, n in marks if is_strong(n))
    print("candidate headings: %d (%d explicit, %d bare numerals)"
          % (len(marks), strong_count, len(marks) - strong_count), file=sys.stderr)
    if strong_count >= 2:
        print("  -> explicit headings win; bare numerals ignored", file=sys.stderr)
        marks = [m for m in marks if is_strong(m[2])]
    for index, text, pattern_no in marks[:60]:
        print("  line %-7d pattern %d  %s" % (index, pattern_no, text[:70]),
              file=sys.stderr)
    if len(marks) > 60:
        print("  ... and %d more" % (len(marks) - 60), file=sys.stderr)

    kept = []
    for position, (line_no, heading, _) in enumerate(marks):
        end = marks[position + 1][0] if position + 1 < len(marks) else len(lines)
        content = "\n".join(lines[line_no + 1:end]).strip()
        if len(content) >= MIN_CHAPTER_CHARS:
            kept.append(len(content))

    if kept:
        lengths = sorted(kept)
        median = lengths[len(lengths) // 2]
        covered = sum(kept)
        print("kept %d of %d (>= %d chars); median %d (need >= 2000); "
              "coverage %.0f%% of %d (need >= 60%%)"
              % (len(kept), len(marks), MIN_CHAPTER_CHARS, median,
                 100.0 * covered / max(1, len(body)), len(body)),
              file=sys.stderr)
    else:
        print("no candidate produced a section of at least %d chars"
              % MIN_CHAPTER_CHARS, file=sys.stderr)

    # The first 40 short lines, for a book whose headings match nothing at all.
    # Seeing the actual lines is the only way to write a pattern for them.
    if len(marks) < 2:
        print("\nshort lines that matched NOTHING (first 40):", file=sys.stderr)
        shown = 0
        for line in lines:
            stripped = line.strip()
            if stripped and len(stripped) <= 60 and shown < 40:
                print("  %s" % stripped[:70], file=sys.stderr)
                shown += 1


def choose_chapters(body):
    """Split into chapters, or say honestly that it could not. Section 5.2 step 5.

    ── The plausibility check, and why it is the important part ─────────────

    The bare-number pattern matches page numbers, footnote markers and years.
    Applied naively to a novel it produces four hundred "chapters" of one line
    each, which is worse than not splitting at all: it looks structured.

    So a split is ACCEPTED only if it looks like a book -- at least two
    chapters, and a median chapter long enough to be one. Otherwise the whole
    text becomes chapter 1 with is_fallback set, which Section 6.2 explicitly
    permits and which is honest about what happened.
    """
    lines = body.split("\n")
    strong = []
    weak = []

    # v13.40.0 (B.5): one candidate scan, shared with heading_report, with the
    # rejection rule applied. A rejected candidate is not a mark at all.
    for index, text, number, rejection in candidate_marks(lines):
        if rejection is not None:
            continue
        (strong if is_strong(number) else weak).append((index, text))

    # Explicit headings win outright when there are enough of them to be a
    # book's structure rather than a stray numbered line in the front matter.
    marks = strong if len(strong) >= 2 else sorted(strong + weak)

    chapters = []
    for position, (line_no, heading) in enumerate(marks):
        end = marks[position + 1][0] if position + 1 < len(marks) else len(lines)
        content = "\n".join(lines[line_no + 1:end]).strip()
        if len(content) >= MIN_CHAPTER_CHARS:
            chapters.append({"title": heading, "content": content})

    if len(chapters) >= 2:
        lengths = sorted(len(c["content"]) for c in chapters)
        median = lengths[len(lengths) // 2]
        covered = sum(len(c["content"]) for c in chapters)

        # Median length rules out a page-number split. Coverage rules out a
        # split that found a handful of real headings and dropped most of the
        # book into the gaps between them.
        if median >= 2000 and covered >= 0.6 * len(body):
            for ordinal, chapter in enumerate(chapters, start=1):
                chapter["ordinal"] = ordinal
                chapter["is_fallback"] = False
            return chapters, "ok"

    return ([{"ordinal": 1, "title": None, "content": body.strip(),
              "is_fallback": True}],
            "single_chapter_fallback")


def main():
    parser = argparse.ArgumentParser(description="Extract book text for the Reading Vault.")
    parser.add_argument("--path", help="File to extract.")
    parser.add_argument("--stdin", action="store_true", help="Read text from stdin.")
    parser.add_argument("--format", choices=["pdf", "epub", "txt", "paste"])
    parser.add_argument("--max-pages", type=int, default=None)

    # ── The two arguments script_execute always supplies ─────────────────
    #
    # v13.21.2. script_execute builds every command as
    #     <script> [--input FILE] --output DIR [caller args...]
    # unconditionally. A script that does not accept them exits 2 on argparse
    # before running, which surfaces as "the extractor ran but returned no
    # payload" -- the extractor had not run at all.
    #
    # This is the convention every script on the volume already follows. The
    # first version of this one read SCRIPT_OUTPUT_DIR from the environment
    # instead, which is also set, and never got far enough to use it.
    parser.add_argument("--output", default=None,
                        help="Directory for the result payload. Supplied by script_execute.")
    parser.add_argument("--input", default=None,
                        help="Input file. Supplied by script_execute when input_data is given.")
    parser.add_argument("--headings", action="store_true",
                        help="Report candidate chapter headings on stderr and exit. "
                             "Use this to tune detection for a specific book.")
    parser.add_argument("--title", default=None)
    parser.add_argument("--author", default=None)
    # v13.45.0 (WORK-ORDER-2026-11-26-01). Absent: no images block and output
    # byte-identical to v13.44.0. count: placements, positions, alt text,
    # captions, sizes and hashes. describe: the same, plus the deduplicated
    # image bytes (downscaled where large) within the two byte ceilings.
    parser.add_argument("--images", choices=IMAGE_MODES, default=None)
    parser.add_argument("--image-max-bytes", type=int, default=DEFAULT_IMAGE_MAX_BYTES,
                        help="Largest single image sent, after downscaling.")
    parser.add_argument("--image-payload-budget", type=int,
                        default=DEFAULT_IMAGE_PAYLOAD_BUDGET,
                        help="Total image bytes one payload may carry.")
    args = parser.parse_args()

    with protected_stdout() as out_stream:
        run(args, out_stream)


def run(args, out_stream):
    """Extract and emit. Separated so protected_stdout() wraps the whole run."""
    # --input is script_execute's channel for an uploaded file. Treated as the
    # path when no --path was given, so both invocation styles work.
    if not args.path and args.input:
        args.path = args.input

    # v13.45.0: getattr, so a caller building its own namespace without the
    # image arguments runs exactly as before.
    image_mode = getattr(args, "images", None)
    images = None
    if args.stdin:
        body = sys.stdin.read()
        fmt, meta = "paste", {"bytes": len(body.encode("utf-8"))}
        if len(body.strip()) < MIN_BOOK_CHARS:
            fail("no_extractable_text", "The pasted text is empty or too short.")
    else:
        if not args.path or not os.path.exists(args.path):
            fail("malformed_upload", "No such file: %s" % args.path)

        # Extension, then content signature. Section 5.2 step 1: a .txt that is
        # actually a PDF is a real upload, and trusting the name alone would
        # store its binary header as prose.
        fmt = args.format
        if not fmt:
            ext = os.path.splitext(args.path)[1].lower()
            fmt = {".pdf": "pdf", ".epub": "epub"}.get(ext, "txt")

        with open(args.path, "rb") as handle:
            signature = handle.read(4)
        if signature[:4] == b"%PDF":
            fmt = "pdf"
        elif signature[:2] == b"PK" and fmt != "epub":
            fmt = "epub"

        if image_mode and not args.headings:
            images = ImageCollector(
                image_mode, fmt,
                getattr(args, "image_max_bytes", DEFAULT_IMAGE_MAX_BYTES),
                getattr(args, "image_payload_budget", DEFAULT_IMAGE_PAYLOAD_BUDGET))
        if fmt == "pdf":
            body, meta = extract_pdf(args.path, args.max_pages, images)
        elif fmt == "epub":
            body, meta = extract_epub(args.path, images)
        else:
            body, meta = extract_txt(args.path)

    # An EPUB's spine is authoritative, so it is used in preference to the text
    # heuristic. The heuristic remains for PDFs and plain text, which carry no
    # structure at all.
    spine = meta.pop("spine_sections", None) if isinstance(meta, dict) else None

    if args.headings:
        heading_report(body)
        json.dump({"ok": True, "mode": "headings", "char_count": len(body),
                   "word_count": words_in(body)}, out_stream, ensure_ascii=False)
        out_stream.write("\n")
        out_stream.flush()
        return

    if spine and len(spine) >= 2:
        chapters = []
        for ordinal, section in enumerate(spine, start=1):
            chapters.append({"ordinal": ordinal,
                             "title": section["title"],
                             "content": section["content"].strip(),
                             "is_fallback": False})
        status = "ok"
    else:
        chapters, status = choose_chapters(body)

    # v13.21.4. What the chapters do NOT contain.
    #
    # Splitting drops the heading lines themselves and everything before the
    # first heading -- a title page, a copyright notice, sometimes an author's
    # introduction. On the pilot book that is about 2,100 words, and the
    # difference between the raw word count and the chapter word count is
    # exactly it.
    #
    # Nothing is lost: raw_text holds all of it and §6.1 requires that it does.
    # But an unexplained 2,000-word gap between two counts in the same summary
    # invites the reader to assume truncation, so it is stated rather than left
    # to be noticed.
    chapter_words = sum(words_in(c.get("content", "")) for c in chapters)
    unassigned = words_in(body) - chapter_words

    # v13.45.0: plain text and pasted text hold no images, and still answer
    # with a zero rather than with silence when images were asked about.
    if image_mode and images is None:
        images = ImageCollector(
            image_mode, fmt,
            getattr(args, "image_max_bytes", DEFAULT_IMAGE_MAX_BYTES),
            getattr(args, "image_payload_budget", DEFAULT_IMAGE_PAYLOAD_BUDGET))

    result = {
        "ok": True,
        "chapter_word_count": chapter_words,
        "unassigned_word_count": unassigned,
        "unassigned_note": (
            "Words in the raw text but not inside any chapter: the heading "
            "lines, and any front matter before the first chapter. Preserved "
            "in raw_text, which is stored in full."
            if unassigned else None
        ),
        "source_format": fmt,
        "title": args.title,
        "author": args.author,
        "ingest_status": status,
        "ingest_notes": (
            "Chapter detection found no reliable structure; the whole text is "
            "stored as one chapter. The raw text is preserved either way."
            if status == "single_chapter_fallback" else None
        ),
        # Section 6.1 and Section 9: the raw text always travels with the
        # chapters, so a bad split costs boundaries and never content.
        "raw_text": body,
        "chapters": chapters,
        # Section 9: log extraction word counts so the completeness flag is
        # auditable rather than a claim made once at ingest time.
        "word_count": words_in(body),
        "char_count": len(body),
        "chapter_count": len(chapters),
        "source_meta": meta,
    }
    # v13.45.0: added only when asked for, so a run without --images writes
    # exactly the v13.44.0 payload.
    if images is not None:
        result["images"] = images.report(body, chapters)

    # ensure_ascii=False is load-bearing, not cosmetic. The default would emit
    # \\u escapes, and while json.loads reverses them exactly, Section 5.2 asks
    # for UTF-8 end to end -- and an escaped stream is one careless consumer
    # away from being stored as literal backslash-u.
    # ── Why the payload goes to a FILE and not to stdout ─────────────────
    #
    # script_execute caps stdout at 50 KB. A novel's raw text alone is several
    # hundred, so the JSON arrived truncated mid-string and parsed as nothing --
    # which the gateway then reported as "no extractable text", pointing at the
    # book when the book was fine.
    #
    # return_files carries content_base64 with no such cap, so the full payload
    # travels there and stdout carries only the summary. Anything that must
    # survive a 50 KB ceiling does not belong on stdout.
    # --output first, environment second. Both are set by script_execute; the
    # flag is the documented channel and the one a script run by hand can also
    # use, so it wins.
    out_dir = args.output or os.environ.get("SCRIPT_OUTPUT_DIR", "")
    if out_dir and os.path.isdir(out_dir):
        payload_name = "book_extract.json"
        with open(os.path.join(out_dir, payload_name), "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False)

        # The summary, deliberately without raw_text or chapter content: it is
        # what a human reads in the log and what proves the run happened.
        summary = {k: v for k, v in result.items()
                   if k not in ("raw_text", "chapters", "images")}
        summary["payload_file"] = payload_name
        summary["chapter_titles"] = [c.get("title") for c in chapters][:40]
        # v13.45.0: the image counts only. The block itself can carry tens of
        # megabytes of image data, which must never reach the 50 KB stdout.
        if "images" in result:
            summary["images_summary"] = images_summary(result["images"])
        json.dump(summary, out_stream, ensure_ascii=False)
    else:
        # No output directory: run directly from a shell rather than through
        # script_execute. The whole payload goes to stdout, which is what a
        # person invoking this by hand wants.
        json.dump(result, out_stream, ensure_ascii=False)

    out_stream.write("\n")
    out_stream.flush()


if __name__ == "__main__":
    main()
