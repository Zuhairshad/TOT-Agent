"""Programmatic PDF fixtures. Every document is labelled FIXTURE: synthetic, not a real tender."""

from __future__ import annotations

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

BANNER = "FIXTURE - synthetic document for tests, not a real tender."
_STYLES = getSampleStyleSheet()
_GRID = TableStyle(
    [("GRID", (0, 0), (-1, -1), 0.7, colors.black), ("FONTSIZE", (0, 0), (-1, -1), 9)]
)


def _table(rows: list[list[str]]) -> Table:
    t = Table(rows)
    t.setStyle(_GRID)
    return t


def _para(text: str) -> Paragraph:
    return Paragraph(text, _STYLES["BodyText"])


def tender_pdf() -> bytes:
    """Page 1: terms text. Page 2: items table with lots, a wrapped row and a Total footer."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4)
    flow = [
        _para(BANNER),
        Spacer(1, 8),
        _para("Bid Security: ZMW 5,000 shall be submitted with the bid."),
        _para("Tender fee: ZMW 500 (non-refundable)."),
        _para("Delivery period: 60 days from contract signature."),
        _para("Place of delivery: Lusaka Central Stores."),
        _para("Bids must be submitted in sealed envelopes at the Procurement Unit."),
        Spacer(1, 8),
        _para("Eligibility criteria:"),
        _para("- Valid business registration certificate"),
        _para("- Tax clearance certificate valid for 2026"),
        _para("- Three years of relevant experience"),
        Spacer(1, 8),
        _para("Documents required:"),
        _para("1. Completed bid form"),
        _para("2. Bid security"),
        PageBreak(),
        _para(BANNER + " Schedule of requirements"),
        _table(
            [
                ["Lot 1: Motorcycles", "", "", ""],
                ["S/N", "Item Description", "Unit", "Qty"],
                ["1", "Motorcycle 150cc, black", "Nos", "10"],
                ["", "with rear carrier", "", ""],
                ["2", "Motorcycle helmet", "pcs", "20"],
                ["Lot 2: Safety", "", "", ""],
                ["1", "Safety boots", "pairs", "1,000"],
                ["2", "Reflective vest", "pcs", ""],
                ["Total", "", "", "1030"],
            ]
        ),
    ]
    doc.build(flow)
    return buf.getvalue()


def second_document_pdf() -> bytes:
    """A different file that repeats two of the items (same quantities) and adds one conflicting one."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4)
    doc.build(
        [
            _para(BANNER + " Bill of quantities (second file)"),
            _table(
                [
                    ["S/N", "Description", "UoM", "Quantity"],
                    ["1", "Safety boots", "pairs", "1,000"],
                    ["2", "Reflective vest", "pcs", "50"],
                ]
            ),
        ]
    )
    return buf.getvalue()


def scanned_pdf() -> bytes:
    """One page that is only an image (no text layer)."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (600, 200), "white")
    ImageDraw.Draw(img).text((20, 80), "FIXTURE scanned page: Bid Security USD 100", fill="black")
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawImage(ImageReader(img), 40, 500, width=450, height=150)
    c.showPage()
    c.save()
    return buf.getvalue()


def many_pages_pdf(pages: int) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for i in range(pages):
        c.drawString(72, 700, f"FIXTURE page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


def encrypted_pdf() -> bytes:
    import pypdf

    w = pypdf.PdfWriter(clone_from=io.BytesIO(many_pages_pdf(1)))
    w.encrypt("secret")
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()
