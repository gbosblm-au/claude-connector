#!/usr/bin/env python3
"""Fixture books for src/tests/book-extract-images.test.js (connector v13.45.0).

Writes into the directory named by argv[1]. Every book is built here, from
nothing, so the image tests never depend on a file that is not in the repo:

    text_only.epub        no image anywhere (WORK-ORDER-2026-11-26-01 test 1)
    illustrated.epub      a cover document holding only an image, a figure
                          with a figcaption, a photo with publisher alt text, an
                          image whose alt text is a filename, an inline image in
                          a sentence, a plate page with no text whose alt text is
                          a bare filename, and one ornament repeated on every
                          chapter opener (tests 2 and 6)
    stripped.epub         illustrated.epub with every <img> removed (test 3)
    born_digital.pdf      text pages with one figure and a "Figure 1." caption
                          under it (R11, the ordinary case)
    scanned.pdf           every page one page-sized image, with a text layer
                          over it (test 9)

Pillow and PyMuPDF are required (both are in the connector image); a missing
one exits 3 with its name, so the caller can skip loudly rather than silently.
"""

import io
import os
import sys
import zipfile

try:
    from PIL import Image, ImageDraw
except Exception:  # noqa: BLE001
    print("missing: Pillow", file=sys.stderr)
    sys.exit(3)

PARA = ("The garden was laid out so that the path turned before the visitor "
        "could see what lay beyond it, and each turn revealed one more stone, "
        "one more lantern, one more patch of moss that had been tended for a "
        "century by people who did not expect to see it finished. ")


def png(width, height, colour, mark=None):
    """A PNG of one colour, optionally with a dark rectangle so two images of
    the same size and colour can still differ in content."""
    im = Image.new("RGB", (width, height), colour)
    if mark:
        ImageDraw.Draw(im).rectangle(mark, fill=(20, 20, 20))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def epub(path, documents, assets):
    """Write an EPUB: documents is [(name, xhtml)], assets {name: bytes}."""
    manifest = "".join(
        '<item id="d%d" href="%s" media-type="application/xhtml+xml"/>' % (i, n)
        for i, (n, _) in enumerate(documents))
    manifest += "".join(
        '<item id="a%d" href="%s" media-type="image/png"/>' % (i, n)
        for i, n in enumerate(assets))
    spine = "".join('<itemref idref="d%d"/>' % i for i in range(len(documents)))
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" '
           'version="3.0"><metadata/><manifest>%s</manifest><spine>%s</spine>'
           '</package>' % (manifest, spine))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container><rootfiles><rootfile '
                   'full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", opf)
        for name, body in documents:
            z.writestr("OEBPS/" + name, body)
        for name, data in assets.items():
            z.writestr("OEBPS/" + name, data)


def xhtml(body):
    return ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
            '<head><title>t</title></head><body>%s</body></html>' % body)


def chapter(n, extra_before="", extra_after=""):
    ornament = '<p class="opener"><img src="images/ornament.png" alt=""/></p>'
    return xhtml(
        "<h1>Chapter %d</h1>%s%s<p>%s</p><p>%s</p><p>%s</p>%s"
        % (n, ornament, extra_before, PARA * 3, PARA * 3, PARA * 3, extra_after))


def build_epubs(out):
    assets = {
        "images/cover.png": png(600, 900, (180, 40, 40)),
        "images/ornament.png": png(40, 40, (90, 90, 90)),
        "images/lantern.png": png(800, 600, (40, 120, 40), (300, 200, 500, 400)),
        "images/plan.png": png(900, 700, (230, 230, 230), (100, 100, 800, 600)),
        "images/fig_0012.png": png(500, 500, (40, 40, 160), (10, 10, 60, 60)),
        "images/glyph.png": png(700, 500, (200, 180, 40), (50, 50, 100, 100)),
        "images/plate.png": png(600, 800, (60, 90, 60), (100, 100, 500, 700)),
    }
    figure = ('<figure><img src="images/plan.png" alt=""/>'
              '<figcaption>Figure 1. Plan of the moss garden.</figcaption></figure>')
    photo = '<p><img src="images/lantern.png" alt="A stone lantern half hidden by maple leaves"/></p>'
    filename_alt = '<p><img src="images/fig_0012.png" alt="fig_0012.png"/></p>'
    inline = '<p>The mark <img src="images/glyph.png"/> appears on every stone.</p>'
    documents = [
        ("cover.xhtml", xhtml('<div><img src="images/cover.png" alt="cover"/></div>')),
        ("ch1.xhtml", chapter(1, figure)),
        ("ch2.xhtml", chapter(2, photo, filename_alt)),
        ("ch3.xhtml", chapter(3, inline)),
        # A plate page with no text at all, not even a <title>: its image is
        # placed at the start of the next document with text.
        ("plate.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><div>'
                        '<img src="images/plate.png" alt="plate.png"/></div></body></html>'),
        ("ch4.xhtml", chapter(4)),
    ]
    epub(os.path.join(out, "illustrated.epub"), documents, assets)

    import re
    stripped = [(n, re.sub(r"<img\b[^>]*>", "", b)) for n, b in documents]
    epub(os.path.join(out, "stripped.epub"), stripped, {})

    plain = [("ch%d.xhtml" % i, xhtml("<h1>Chapter %d</h1><p>%s</p><p>%s</p>" % (i, PARA * 4, PARA * 4)))
             for i in range(1, 4)]
    epub(os.path.join(out, "text_only.epub"), plain, {})


def build_pdfs(out):
    try:
        import pymupdf as fitz
    except Exception:  # noqa: BLE001
        try:
            import fitz  # noqa: F401
        except Exception:  # noqa: BLE001
            print("missing: PyMuPDF", file=sys.stderr)
            sys.exit(3)

    doc = fitz.open()
    figure = png(400, 300, (40, 120, 160), (100, 80, 300, 220))
    for n in range(1, 5):
        page = doc.new_page(width=595, height=842)
        page.insert_textbox(fitz.Rect(56, 56, 540, 300),
                            "CHAPTER %d\n\n%s" % (n, PARA * 4), fontsize=10)
        if n == 2:
            page.insert_image(fitz.Rect(150, 320, 450, 545), stream=figure)
            page.insert_textbox(fitz.Rect(56, 552, 540, 580),
                                "Figure 1. The approach to the tea house.", fontsize=9)
            page.insert_textbox(fitz.Rect(56, 600, 540, 800), PARA * 2, fontsize=10)
    doc.save(os.path.join(out, "born_digital.pdf"))
    doc.close()

    scan = fitz.open()
    for n in range(1, 7):
        page = scan.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=png(595, 842, (250, 248, 240), (40 + n, 40, 500, 60 + n)))
        page.insert_textbox(fitz.Rect(56, 56, 540, 800), PARA * 5, fontsize=10)
    scan.save(os.path.join(out, "scanned.pdf"))
    scan.close()


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    build_epubs(out)
    build_pdfs(out)
    print("ok")


if __name__ == "__main__":
    main()
