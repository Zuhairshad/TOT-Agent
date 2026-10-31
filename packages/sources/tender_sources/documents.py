"""PDF text/table extraction with honest limits. Pure: bytes in, dict out, no network.

``extract_pdf`` never raises. Problems become ``error`` (nothing usable) or ``needsReview`` plus a
``limitations`` list (something usable but uncertain).

OCR is optional: it runs only if ``pytesseract`` imports AND a ``tesseract`` binary is on PATH.
If it is missing, scanned pages are returned with empty text, ``needsReview=True`` and
``error='no text layer; OCR unavailable (pages ...)'``: we say what we could not read.
"""

from __future__ import annotations

import io
import logging
import shutil
from typing import Any

MAX_PAGES = 300
MAX_BYTES = 25 * 1024 * 1024
NO_TEXT_LAYER = "no text layer; OCR unavailable"

logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("pdfplumber").setLevel(logging.ERROR)


def _result(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "pages": [],
        "pageCount": 0,
        "ocrUsed": False,
        "needsReview": False,
        "error": None,
        "limitations": [],
    }
    base.update(kw)
    return base


def _ocr_available() -> bool:
    try:
        import pytesseract  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return shutil.which("tesseract") is not None


def _ocr_page(data: bytes, page_number: int) -> str | None:
    """OCR one 1-based page. Separate function so tests can monkeypatch it."""
    import pdfplumber
    import pytesseract

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        image = pdf.pages[page_number - 1].to_image(resolution=200).original
    return str(pytesseract.image_to_string(image))


def _clean_table(table: list[list[Any]]) -> list[list[str]]:
    return [[("" if c is None else " ".join(str(c).split())) for c in row] for row in table]


def extract_pdf(data: bytes, *, source_url: str) -> dict[str, Any]:
    """Extract ``{pages:[{page,text,tables}], pageCount, ocrUsed, needsReview, error}``."""
    try:
        return _extract(data, source_url)
    except Exception as exc:  # noqa: BLE001
        return _result(error=f"PDF extraction failed: {type(exc).__name__}", needsReview=True)


def _extract(data: bytes, source_url: str) -> dict[str, Any]:
    if not isinstance(data, bytes | bytearray) or not data:
        return _result(error="empty document", needsReview=True)
    if len(data) > MAX_BYTES:
        return _result(error=f"file too large ({len(data)} bytes > {MAX_BYTES})")
    if b"%PDF" not in bytes(data[:1024]):
        return _result(error="not a PDF (missing %PDF header)", needsReview=True)
    data = bytes(data)

    import pypdf

    page_count: int | None = None
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return _result(error="encrypted PDF (not read by design)", needsReview=True)
        page_count = len(reader.pages)
    except Exception as exc:  # noqa: BLE001
        return _result(error=f"corrupt or unreadable PDF ({type(exc).__name__})", needsReview=True)
    if page_count > MAX_PAGES:
        return _result(error=f"too many pages ({page_count} > {MAX_PAGES})", pageCount=page_count)

    texts: list[str] = []
    tables: list[list[list[list[str]]]] = []
    limitations: list[str] = []
    plumber_ok = True
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for pg in pdf.pages:
                try:
                    texts.append(pg.extract_text() or "")
                except Exception:  # noqa: BLE001
                    texts.append("")
                    limitations.append(f"text extraction failed on page {len(texts)}")
                try:
                    tables.append([_clean_table(t) for t in pg.extract_tables()])
                except Exception:  # noqa: BLE001
                    tables.append([])
    except Exception:  # noqa: BLE001
        plumber_ok = False
    if not plumber_ok or len(texts) != page_count:
        limitations.append("pdfplumber failed; fell back to pypdf text only (no tables)")
        texts, tables = [], []
        for p in reader.pages:
            try:
                texts.append(p.extract_text() or "")
            except Exception:  # noqa: BLE001
                texts.append("")
            tables.append([])

    scanned = [i + 1 for i, t in enumerate(texts) if not t.strip() and not tables[i]]
    ocr_used = False
    needs_review = False
    error: str | None = None
    if scanned:
        needs_review = True
        if _ocr_available():
            done: list[int] = []
            for n in scanned:
                try:
                    out = _ocr_page(data, n)
                except Exception:  # noqa: BLE001
                    out = None
                if out and out.strip():
                    texts[n - 1] = out
                    done.append(n)
            ocr_used = bool(done)
            missed = [n for n in scanned if n not in done]
            if done:
                limitations.append(
                    f"OCR text on pages {done}: may contain errors, check against the PDF"
                )
            if missed:
                error = f"{NO_TEXT_LAYER} (OCR returned nothing for pages {missed})"
        else:
            error = f"{NO_TEXT_LAYER} (pages {scanned})"
            limitations.append(error)
    pages = [{"page": i + 1, "text": texts[i], "tables": tables[i]} for i in range(page_count)]
    return _result(
        pages=pages,
        pageCount=page_count,
        ocrUsed=ocr_used,
        needsReview=needs_review,
        error=error,
        limitations=limitations,
    )
