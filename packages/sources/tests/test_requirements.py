"""Requirement extraction from PDF pages: only facts that exist, with page + exact quote."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from tender_sources.documents import extract_pdf
from tender_sources.extract.requirements import extract_requirements

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
import pdf_builders
from records_helper import make_record, validate_record

URL = "https://example.test/tender.pdf"
NOW = "2026-10-31T00:00:00Z"


def run(pages: list[dict[str, Any]]) -> dict[str, Any]:
    return extract_requirements(pages, source_url=URL, retrieved_at=NOW)


def page(n: int, text: str, tables: list | None = None) -> dict[str, Any]:
    return {"page": n, "text": text, "tables": tables or []}


@pytest.fixture(scope="module")
def pdf_result() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    pages = extract_pdf(pdf_builders.tender_pdf(), source_url=URL)["pages"]
    return run(pages), pages


def test_full_pdf_extracts_every_field_and_validates(pdf_result: tuple) -> None:
    out, _ = pdf_result
    assert {"bidSecurity", "tenderFee", "eligibility", "requiredDocuments", "deliverySchedule",
            "deliveryLocation", "submissionMethod", "items", "lots"} <= set(out)  # fmt: skip
    validate_record(make_record(**out))


def test_amounts_are_routed_by_label_and_never_swapped(pdf_result: tuple) -> None:
    out, _ = pdf_result
    assert (out["bidSecurity"]["amount"], out["bidSecurity"]["currency"]) == (5000.0, "ZMW")
    assert (out["tenderFee"]["amount"], out["tenderFee"]["currency"]) == (500.0, "ZMW")
    assert "estimatedValue" not in out and "awardValue" not in out


def test_evidence_has_page_and_an_exact_quote_from_the_page(pdf_result: tuple) -> None:
    out, pages = pdf_result
    for field in (
        "bidSecurity",
        "tenderFee",
        "deliverySchedule",
        "deliveryLocation",
        "submissionMethod",
    ):
        for ev in out[field]["evidence"]:
            assert ev["page"] == 1
            assert ev["quote"] in pages[0]["text"]
            assert ev["sourceUrl"] == URL
    assert out["bidSecurity"]["evidence"][0]["quote"].startswith("Bid Security: ZMW 5,000")


def test_lists_and_text_facts(pdf_result: tuple) -> None:
    out, _ = pdf_result
    assert out["eligibility"]["value"] == [
        "Valid business registration certificate",
        "Tax clearance certificate valid for 2026",
        "Three years of relevant experience",
    ]
    assert out["requiredDocuments"]["value"] == ["Completed bid form", "Bid security"]
    assert out["deliverySchedule"]["value"].startswith("60 days")
    assert "Lusaka Central Stores" in out["deliveryLocation"]["value"]
    assert "sealed envelopes" in out["submissionMethod"]["value"]


def test_items_and_lots_from_the_table_with_footer_excluded(pdf_result: tuple) -> None:
    out, _ = pdf_result
    items = out["items"]
    assert [(i["lotNo"], i["lineNo"], i["description"]) for i in items] == [
        ("1", "1", "Motorcycle 150cc, black with rear carrier"),
        ("1", "2", "Motorcycle helmet"),
        ("2", "1", "Safety boots"),
        ("2", "2", "Reflective vest"),
    ]
    assert items[3]["quantity"]["value"] is None and items[3]["needsReview"] is True
    assert all(i["evidence"][0]["page"] == 2 for i in items)
    assert [(lot["lotNo"], lot["title"]) for lot in out["lots"]] == [
        ("1", "Motorcycles"),
        ("2", "Safety"),
    ]
    # eligibility bullets on page 1 must not be mistaken for items
    assert not any("certificate" in i["description"].lower() for i in items)


def test_absent_facts_are_omitted_not_invented() -> None:
    out = run([page(1, "This page says nothing useful. Thank you.")])
    assert out == {}
    assert run([]) == {}


def test_tender_fee_is_not_mistaken_for_bid_security_on_one_line() -> None:
    out = run([page(1, "Tender fee: ZMW 500; Bid security: ZMW 5,000.")])
    assert out["tenderFee"]["amount"] == 500.0
    assert out["bidSecurity"]["amount"] == 5000.0


def test_estimated_and_award_values_are_routed_separately() -> None:
    out = run([page(1, "Engineer's estimate: USD 120,000\nContract price: USD 118,500")])
    assert out["estimatedValue"]["amount"] == 120000.0
    assert out["awardValue"]["amount"] == 118500.0
    assert "bidSecurity" not in out and "tenderFee" not in out


def test_bid_security_as_percentage_has_no_amount() -> None:
    out = run([page(1, "Bid security: 2% of the bid price")])
    fact = out["bidSecurity"]
    assert fact["amount"] is None and fact["status"] == "published"
    assert fact["originalText"].startswith("2%")
    assert "percentage" in fact["note"]


def test_amount_without_a_known_label_is_not_assigned() -> None:
    assert run([page(1, "Registration costs ZMW 100 at the office.")]) == {}


def test_same_value_repeated_on_two_pages_merges_evidence() -> None:
    out = run(
        [page(1, "Bid security: ZMW 5,000"), page(4, "A bid security of ZMW 5,000 is required.")]
    )
    fact = out["bidSecurity"]
    assert fact["status"] == "published" and fact["amount"] == 5000.0
    assert [e["page"] for e in fact["evidence"]] == [1, 4]


def test_conflicting_values_across_pages_list_both_evidences() -> None:
    out = run([page(1, "Bid security: ZMW 5,000"), page(6, "Bid security: ZMW 7,500")])
    fact = out["bidSecurity"]
    assert fact["status"] == "conflicting"
    assert fact["amount"] is None
    assert {e["page"] for e in fact["evidence"]} == {1, 6}
    assert "5,000" in fact["note"] and "7,500" in fact["note"]
    validate_record(make_record(bidSecurity=fact))


def test_conflicting_delivery_schedule_is_reported() -> None:
    out = run([page(1, "Delivery period: 60 days"), page(3, "Delivery period: 90 days")])
    fact = out["deliverySchedule"]
    assert fact["status"] == "conflicting" and fact["value"] is None
    assert len(fact["evidence"]) == 2


def test_inline_list_after_heading_and_wrapped_bullets() -> None:
    text = "Eligibility: Registered companies in Zambia\n\nDocuments required:\n- Bid form signed by the\n  authorised signatory\n- Tax certificate\n\nOther text."
    out = run([page(1, text)])
    assert out["eligibility"]["value"] == ["Registered companies in Zambia"]
    assert out["requiredDocuments"]["value"] == [
        "Bid form signed by the authorised signatory",
        "Tax certificate",
    ]


def test_amounts_inside_tables_are_found() -> None:
    out = run([page(2, "", tables=[[["Tender fee", "ZMW 250"], ["Bid security", "ZMW 3,000"]]])])
    assert out["tenderFee"]["amount"] == 250.0
    assert out["bidSecurity"]["evidence"][0]["quote"] == "Bid security | ZMW 3,000"


def test_text_items_need_an_explicit_quantity() -> None:
    out = run([page(1, "Requirements:\n1. Motorcycle 150cc - 10 units\n2. Valid tax certificate")])
    assert [i["description"] for i in out["items"]] == ["Motorcycle 150cc"]


def test_garbage_pages_never_raise() -> None:
    assert isinstance(run([{"page": "x", "text": None, "tables": [[None, 1]]}]), dict)  # type: ignore[list-item]
    assert extract_requirements(None, source_url=URL, retrieved_at=NOW) == {}  # type: ignore[arg-type]
