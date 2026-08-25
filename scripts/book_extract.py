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

Usage:
    book_extract.py --path FILE [--format pdf|epub|txt] [--max-pages N]
    book_extract.py --stdin --format txt
"""

import argparse
import contextlib
import json
import os
import re
import sys
import zipfile
from html import unescape

# Section 5.2 step 5. Ordered most specific first: 'CHAPTER ONE' should be read
# as a chapter heading rather than as a bare roman/word numeral line.
CHAPTER_PATTERNS = [
    re.compile(r"^\s*(?:CHAPTER|Chapter)\s+([0-9]+|[IVXLCDM]+|[A-Za-z]+)\b\s*(.*)$"),
    re.compile(r"^\s*(?:PART|Part|BOOK|Book)\s+([0-9]+|[IVXLCDM]+|[A-Za-z]+)\b\s*(.*)$"),
    # A bare number alone on a line. Common in fiction, and the loosest rule
    # here -- guarded by the plausibility check in choose_chapters().
    re.compile(r"^\s*([0-9]{1,3})\s*$"),
    re.compile(r"^\s*([IVXLCDM]{1,7})\s*$"),
]

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


def extract_pdf(path, max_pages=None):
    """Extract a PDF via PyMuPDF, preserving reading order. Section 5.2 step 2."""
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

    total_pages = len(doc)
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

    return body, {"pages": total_pages, "pages_read": limit}


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


def extract_epub(path):
    """Unpack an EPUB and extract its HTML in spine order. Section 5.2 step 3."""
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
            chunk = strip_html(archive.read(name).decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001
            continue
        if chunk.strip():
            parts.append(chunk)

    archive.close()
    body = "\n\n".join(parts)

    if len(body.strip()) < MIN_BOOK_CHARS:
        fail("no_extractable_text",
             "No readable text was found in this EPUB.",
             documents=len(ordered))

    return body, {"documents": len(ordered)}


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

    return body, {"bytes": len(raw)}


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
    marks = []

    for index, line in enumerate(lines):
        if len(line) > 90:
            continue  # A heading is short. This is a paragraph.
        for pattern in CHAPTER_PATTERNS:
            match = pattern.match(line)
            if match:
                marks.append((index, line.strip()))
                break

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
    parser.add_argument("--title", default=None)
    parser.add_argument("--author", default=None)
    args = parser.parse_args()

    with protected_stdout() as out_stream:
        run(args, out_stream)


def run(args, out_stream):
    """Extract and emit. Separated so protected_stdout() wraps the whole run."""
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

        if fmt == "pdf":
            body, meta = extract_pdf(args.path, args.max_pages)
        elif fmt == "epub":
            body, meta = extract_epub(args.path)
        else:
            body, meta = extract_txt(args.path)

    chapters, status = choose_chapters(body)

    result = {
        "ok": True,
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

    # ensure_ascii=False is load-bearing, not cosmetic. The default would emit
    # \\u escapes, and while json.loads reverses them exactly, Section 5.2 asks
    # for UTF-8 end to end -- and an escaped stream is one careless consumer
    # away from being stored as literal backslash-u.
    json.dump(result, out_stream, ensure_ascii=False)
    out_stream.write("\n")
    out_stream.flush()


if __name__ == "__main__":
    main()
