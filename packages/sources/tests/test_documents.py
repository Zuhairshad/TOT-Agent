"""PDF extraction, including the OCR-unavailable path (tesseract is not installed in this sandbox)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from tender_sources import documents
from tender_sources.documents import extract_pdf

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
import pdf_builders

URL = "https://example.test/doc.pdf"


def test_text_pdf_pages_text_and_tables() -> None:
    res = extract_pdf(pdf_builders.tender_pdf(), source_url=URL)
    assert res["error"] is None and res["pageCount"] == 2
    assert res["ocrUsed"] is False and res["needsReview"] is False
    p1, p2 = res["pages"]
    assert p1["page"] == 1 and "Bid Security: ZMW 5,000" in p1["text"]
    assert p2["page"] == 2 and p2["tables"]
    rows = p2["tables"][0]
    assert ["1", "Safety boots", "pairs", "1,000"] in rows
    assert all(isinstance(c, str) for row in rows for c in row)  # None cells normalised to ""


def test_page_numbers_are_one_based_and_contiguous() -> None:
    res = extract_pdf(pdf_builders.many_pages_pdf(5), source_url=URL)
    assert [p["page"] for p in res["pages"]] == [1, 2, 3, 4, 5]
    assert "FIXTURE page 3" in res["pages"][2]["text"]


def test_scanned_pdf_without_ocr_is_flagged_honestly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "_ocr_available", lambda: False)
    res = extract_pdf(pdf_builders.scanned_pdf(), source_url=URL)
    assert res["pageCount"] == 1
    assert res["pages"][0]["text"] == ""
    assert res["needsReview"] is True
    assert res["ocrUsed"] is False
    assert res["error"] and "no text layer; OCR unavailable" in res["error"]


def test_ocr_unavailable_in_this_sandbox_by_default() -> None:
    # The sandbox has no tesseract binary: the real availability check must say so, not crash.
    import shutil

    if shutil.which("tesseract"):
        pytest.skip("tesseract is installed here")
    assert documents._ocr_available() is False


def test_scanned_pdf_with_ocr_available_uses_it_and_marks_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(documents, "_ocr_available", lambda: True)
    calls: list[int] = []

    def fake_ocr(data: bytes, page: int) -> str:
        calls.append(page)
        return "FIXTURE ocr text: Bid Security USD 100"

    monkeypatch.setattr(documents, "_ocr_page", fake_ocr)
    res = extract_pdf(pdf_builders.scanned_pdf(), source_url=URL)
    assert calls == [1]
    assert res["ocrUsed"] is True and res["needsReview"] is True
    assert res["error"] is None
    assert "Bid Security USD 100" in res["pages"][0]["text"]
    assert any("OCR" in n for n in res["limitations"])


def test_ocr_failure_is_reported_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "_ocr_available", lambda: True)

    def boom(data: bytes, page: int) -> str:
        raise RuntimeError("tesseract crashed")

    monkeypatch.setattr(documents, "_ocr_page", boom)
    res = extract_pdf(pdf_builders.scanned_pdf(), source_url=URL)
    assert res["ocrUsed"] is False and res["needsReview"] is True
    assert res["error"] and "OCR" in res["error"]


def test_text_pdf_never_triggers_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "_ocr_available", lambda: True)

    def must_not_run(data: bytes, page: int) -> str:  # pragma: no cover
        raise AssertionError("OCR must only run for pages without a text layer")

    monkeypatch.setattr(documents, "_ocr_page", must_not_run)
    assert extract_pdf(pdf_builders.tender_pdf(), source_url=URL)["ocrUsed"] is False


def test_too_many_pages_is_refused_with_an_error() -> None:
    res = extract_pdf(pdf_builders.many_pages_pdf(documents.MAX_PAGES + 1), source_url=URL)
    assert res["error"] and "too many pages" in res["error"]
    assert res["pages"] == [] and res["pageCount"] == documents.MAX_PAGES + 1


def test_oversized_file_is_refused_before_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "MAX_BYTES", 100)
    res = extract_pdf(pdf_builders.tender_pdf(), source_url=URL)
    assert res["error"] and "too large" in res["error"]
    assert res["pages"] == []


def test_encrypted_pdf_is_an_error_not_a_crash() -> None:
    res = extract_pdf(pdf_builders.encrypted_pdf(), source_url=URL)
    assert res["error"] and "encrypted" in res["error"]
    assert res["pages"] == [] and res["needsReview"] is True


@pytest.mark.parametrize(
    "data", [b"", b"not a pdf at all", b"%PDF-1.4\ngarbage garbage", b"%PDF-1.7\n" + b"\x00" * 500]
)
def test_corrupt_bytes_are_an_error_not_a_crash(data: bytes) -> None:
    res = extract_pdf(data, source_url=URL)
    assert res["error"]
    assert res["pages"] == []
    assert set(res) >= {"pages", "pageCount", "ocrUsed", "needsReview", "error"}


def test_truncated_pdf_does_not_raise() -> None:
    data = pdf_builders.tender_pdf()
    res = extract_pdf(data[: len(data) // 2], source_url=URL)
    assert isinstance(res["pages"], list)


def test_non_bytes_input_does_not_raise() -> None:
    assert extract_pdf(None, source_url=URL)["error"]  # type: ignore[arg-type]
