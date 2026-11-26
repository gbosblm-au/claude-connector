# claude-connector 13.45.0

Work order: WORK-ORDER-2026-11-26-01, image-aware ingestion.
Companion: Gateway Service 2.383.0, which reads the new `images` block. Either can be deployed first. A gateway that predates 2.383.0 never passes `--images`, so this extractor behaves exactly as 13.44.0 for it.

## Deploying

`scripts/book_extract.py` is the only runtime file changed. **Copy it to the connector volume** (`SCRIPTS_DIR`, `/data/skill/ava/scripts` by default), the same way earlier versions of the script got there. script_execute runs the copy on the volume, not the one in the repository. No new dependency: Pillow and PyMuPDF are already in the image (Dockerfile).

## What changed in `scripts/book_extract.py`

**Without `--images`, the payload is byte-identical to 13.44.0.** This was verified on every fixture by diffing the 13.44.0 script's output against this one's. With `--images`, every key except the new `images` is identical too. The text is never changed by the image pass.

New arguments:

| Argument | Default | What it does |
|---|---|---|
| `--images count` | none | Adds the `images` block: every image in reading order, with positions, alt text, captions, sizes and hashes. |
| `--images describe` | none | The same, plus the deduplicated image bytes the gateway sends to the vision model. |
| `--image-max-bytes N` | 3000000 | The largest single image sent, after downscaling. |
| `--image-payload-budget N` | 30000000 | The total image bytes one payload may carry. |

The `images` block:

- **Placements, in reading order (R1).** Each placement carries:
  - `chapter_ordinal`, `offset` and `raw_offset`: the exact character position the image occupies in the stored chapter text and in `raw_text`;
  - `precision`;
  - `alt` and `caption`;
  - the content-hash `asset` key.
- **How EPUB positions are exact.** The position is computed by running `strip_html`'s own steps with a sentinel where each image tag stood. The positions are carried through the whitespace steps, and the resulting text is compared with `strip_html`'s. If they ever differ, the positions are reported as unknown rather than guessed.
- **Images in a document with no text** (a cover or a plate page) are placed at the start of the next document with text (`precision: adjacent`).
- **PDF placement.** A PDF figure is placed after the text block that ends above it (`precision: block`), or at the end of its page when that block cannot be found (`precision: page`).
- **Alt text (R3).** Kept only when it describes something. Empty alt text, a filename, an asset id ("fig_0012", "Image00045") or a generic word ("image", "cover") is never passed on as a description.
- **Captions (R6).** A `<figcaption>` in the same `<figure>` is attributed (`caption_source: figcaption`). In a PDF, exactly one "Figure N." / "Table N." block within 72 pt above or below the figure is attributed (`pdf_adjacent`). Two or more nearby are reported as `ambiguous` and none is attributed.
- **Assets, deduplicated by content hash (R9).** Each asset has its size, pixel dimensions and number of occurrences.
  - In `describe` mode the bytes are included. Images larger than 1600 px on a side, or than `--image-max-bytes`, are downscaled through Pillow first.
  - SVG is reported as `unsupported_format`.
  - An image past the payload budget is reported as `payload_budget`, never silently dropped.
- **Scanned books (R11).** When at least 60% of the PDF pages read carry a page-sized image (85% or more of the page), the block refuses by name: `routing.refused: scanned_pdf_page_images`, `route: ocr_correction`. Those pages are counted in `page_images_excluded`, not as figures, and none of their bytes are read.
  - In a born-digital PDF, a single page-sized image on a page with real text is the scan under an OCR layer and is excluded.
  - One on a page with little text is a full-page plate and is kept as a figure.
- **The stdout summary carries `images_summary` (counts only), never the block.** The block can hold tens of megabytes, and stdout is capped at 50 KB.

## Tests

- New: `src/tests/book-extract-images.test.js` (10 cases), driving the shipped script on books built from nothing by `src/tests/fixtures/make_image_books.py`: an illustrated EPUB, the same EPUB stripped, a text-only EPUB, a born-digital PDF with a captioned figure, and a scanned PDF. It skips loudly if Pillow or PyMuPDF is missing.
- Each pin was shown to fail under its mutation (see DELIVERY-v13.45.0.json).
