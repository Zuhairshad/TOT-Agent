"""Line-item extraction: tables, text, lots, footers, wrapped rows, cross-document merging."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import jsonschema

from tender_sources.extract.items import (
    extract_items_from_table,
    extract_items_from_text,
    merge_items,
)

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from records_helper import make_item, make_record, validate_record

URL_A = "https://example.test/a.pdf"
URL_B = "https://example.test/b.pdf"
NOW = "2026-10-31T00:00:00Z"


def table(rows: list[list[str]], url: str = URL_A, page: int | None = 2) -> list[dict]:
    return extract_items_from_table(rows, source_url=url, page=page, retrieved_at=NOW)


BASIC = [
    ["S/N", "Item Description", "Unit", "Qty"],
    ["1", "Motorcycle 150cc", "Nos", "10"],
    ["2", "Motorcycle helmet", "pcs", "20"],
]


def test_table_basic_rows_with_evidence_page_and_quote() -> None:
    items = table(BASIC)
    assert [i["description"] for i in items] == ["Motorcycle 150cc", "Motorcycle helmet"]
    first = items[0]
    assert first["quantity"] == {"value": 10.0, "originalText": "10"}
    assert first["unit"] == "Nos"
    assert first["lineNo"] == "1"
    assert first["needsReview"] is False
    ev = first["evidence"][0]
    assert ev["page"] == 2 and ev["sourceUrl"] == URL_A
    assert ev["quote"] == "1 | Motorcycle 150cc | Nos | 10"
    validate_record(make_record(items=items))


def test_header_synonyms_and_column_order_do_not_matter() -> None:
    items = table(
        [
            ["Quantity", "UoM", "Specification", "Description", "Item No."],
            ["5", "sets", "Black, 2026 model", "Riding gloves", "A1"],
        ]
    )
    assert len(items) == 1
    it = items[0]
    assert (it["description"], it["unit"], it["lineNo"]) == ("Riding gloves", "sets", "A1")
    assert it["quantity"]["value"] == 5.0
    assert it["specification"]["value"] == "Black, 2026 model"


def test_item_header_means_line_number_when_description_column_exists() -> None:
    items = table([["Item", "Description", "Qty", "Unit"], ["1", "Gloves", "4", "pairs"]])
    assert items[0]["lineNo"] == "1" and items[0]["description"] == "Gloves"


def test_lot_headings_set_lot_number_even_above_the_header() -> None:
    rows = [
        ["Lot 1: Motorcycles", "", "", ""],
        *BASIC,
        ["Lot 2: Safety gear", "", "", ""],
        ["1", "Safety boots", "pairs", "1,000"],
    ]
    items = table(rows)
    assert [(i["lotNo"], i["lineNo"], i["description"]) for i in items] == [
        ("1", "1", "Motorcycle 150cc"),
        ("1", "2", "Motorcycle helmet"),
        ("2", "1", "Safety boots"),
    ]
    assert items[2]["quantity"]["value"] == 1000.0


def test_footer_total_rows_are_not_items() -> None:
    rows = [*BASIC, ["Total", "", "", "30"], ["Grand Total (ZMW)", "", "", "1000"]]
    items = table(rows)
    assert len(items) == 2
    assert all("total" not in i["description"].lower() for i in items)


def test_item_named_total_station_is_still_an_item() -> None:
    items = table([*BASIC, ["3", "Total station theodolite", "pcs", "1"]])
    assert items[-1]["description"] == "Total station theodolite"


def test_wrapped_continuation_rows_are_glued_to_the_item_above() -> None:
    rows = [
        ["S/N", "Description", "Unit", "Qty"],
        ["1", "Motorcycle 150cc, black", "Nos", "10"],
        ["", "with rear carrier", "", ""],
        ["2", "Helmet", "pcs", "5"],
    ]
    items = table(rows)
    assert len(items) == 2
    assert items[0]["description"] == "Motorcycle 150cc, black with rear carrier"
    assert "with rear carrier" in items[0]["evidence"][0]["quote"]


def test_description_only_row_without_item_number_column_is_a_new_flagged_item() -> None:
    items = table([["Description", "Unit", "Qty"], ["Gloves", "pairs", "4"], ["Boots", "", ""]])
    assert [i["description"] for i in items] == ["Gloves", "Boots"]
    assert items[1]["needsReview"] is True


def test_blank_quantity_is_none_and_needs_review_never_zero() -> None:
    items = table([*BASIC, ["3", "Reflective vest", "pcs", ""]])
    vest = items[-1]
    assert vest["quantity"]["value"] is None
    assert vest["quantity"]["originalText"] is None
    assert vest["needsReview"] is True
    assert items[0]["needsReview"] is False


def test_lump_sum_item_has_no_quantity_and_is_not_flagged() -> None:
    items = table([*BASIC, ["3", "Installation works", "LS", ""]])
    assert items[-1]["quantity"]["value"] is None
    assert items[-1]["needsReview"] is False


def test_repeated_header_row_on_next_page_is_skipped() -> None:
    items = table([*BASIC, BASIC[0], ["3", "Gloves", "pairs", "7"]])
    assert [i["description"] for i in items] == ["Motorcycle 150cc", "Motorcycle helmet", "Gloves"]


def test_garbled_table_is_flagged_for_review() -> None:
    items = table(
        [
            ["S/N", "Description", "Unit", "Qty"],
            ["1", "", "", "x?#"],
            ["2", "12 34", "", "??"],
            ["3", "Gloves", "pairs", "4"],
        ]
    )
    assert items and all(i["needsReview"] for i in items)


def test_table_without_recognisable_header_yields_nothing_rather_than_guesses() -> None:
    assert table([["a", "b"], ["c", "d"]]) == []
    assert table([]) == []
    assert table([["only one cell"]]) == []


def test_non_string_cells_never_raise() -> None:
    assert table([["S/N", "Description", "Qty"], [1, None, 3]])  # type: ignore[list-item]


def test_item_dict_validates_against_the_record_schema_even_with_page_none() -> None:
    items = extract_items_from_table(BASIC, source_url=URL_A, page=None, retrieved_at=NOW)
    assert items[0]["evidence"][0]["page"] is None
    validate_record(make_record(items=items))


# ---------------------------------------------------------------- text


def text_items(text: str) -> list[dict]:
    return extract_items_from_text(text, source_url=URL_A, page=1, retrieved_at=NOW)


def test_text_numbered_line_with_quantity_and_unit() -> None:
    (item,) = text_items("1. Motorcycle 150cc - 10 units")
    assert item["description"] == "Motorcycle 150cc"
    assert item["quantity"]["value"] == 10.0 and item["unit"] == "units"
    assert item["lineNo"] == "1"
    assert item["needsReview"] is False
    assert item["evidence"][0]["quote"] == "1. Motorcycle 150cc - 10 units"


def test_text_bullet_variants() -> None:
    items = text_items(
        "- Safety helmets 200 pcs\n• Riding gloves: 50 pairs\n* 5 x Reflective vests"
    )
    assert [(i["description"], i["quantity"]["value"]) for i in items] == [
        ("Safety helmets", 200.0),
        ("Riding gloves", 50.0),
        ("Reflective vests", 5.0),
    ]


def test_text_items_without_quantity_are_low_confidence() -> None:
    (item,) = text_items("4. Scooter")
    assert item["quantity"]["value"] is None
    assert item["needsReview"] is True


def test_text_items_without_unit_are_flagged() -> None:
    (item,) = text_items("1. Gloves - 12")
    assert item["quantity"]["value"] == 12.0 and item["needsReview"] is True


def test_text_prose_clauses_are_not_items() -> None:
    text = "1. The bidder shall submit a valid tax certificate\n2. Bids must be sealed\nplain sentence 10 pcs"
    assert text_items(text) == []


def test_text_lot_headings() -> None:
    items = text_items("Lot 2: Safety gear\n1. Boots - 4 pairs")
    assert items[0]["lotNo"] == "2"


# ---------------------------------------------------------------- merge


def test_same_item_in_two_documents_becomes_one_item_with_both_evidences() -> None:
    a = make_item("Safety boots", 1000, "pairs", URL_A, page=2, lineNo="1")
    b = make_item("safety  BOOTS", 1000, "Pairs", URL_B, page=1, lineNo="1")
    merged = merge_items([a, b])
    assert len(merged) == 1
    assert merged[0]["quantity"]["value"] == 1000  # NOT 2000
    assert {e["sourceUrl"] for e in merged[0]["evidence"]} == {URL_A, URL_B}
    assert merged[0]["needsReview"] is False


def test_merge_never_sums_quantities_and_does_not_mutate_input() -> None:
    a = make_item("Gloves", 10, "pairs", URL_A)
    b = make_item("Gloves", 10, "pairs", URL_B)
    before = copy.deepcopy([a, b])
    out = merge_items([a, b])
    assert out[0]["quantity"]["value"] == 10
    assert [a, b] == before


def test_same_description_different_quantity_stays_separate_and_flagged() -> None:
    out = merge_items(
        [
            make_item("Reflective vest", None, "pcs", URL_A),
            make_item("Reflective vest", 50, "pcs", URL_B),
        ]
    )
    assert len(out) == 2
    assert all(i["needsReview"] for i in out)


def test_incompatible_units_are_never_combined() -> None:
    out = merge_items(
        [make_item("Gloves", 10, "pairs", URL_A), make_item("Gloves", 10, "pcs", URL_B)]
    )
    assert len(out) == 2
    assert {i["unit"] for i in out} == {"pairs", "pcs"}
    assert all(i["needsReview"] for i in out)


def test_rows_of_the_same_document_are_not_merged_with_each_other() -> None:
    a = make_item("Gloves", 10, "pairs", URL_A, page=1, lineNo="1")
    b = make_item("Gloves", 10, "pairs", URL_A, page=3, lineNo="9")
    assert len(merge_items([a, b])) == 2


def test_same_lot_and_line_required_when_both_present() -> None:
    a = make_item("Gloves", 10, "pairs", URL_A, lotNo="1")
    b = make_item("Gloves", 10, "pairs", URL_B, lotNo="2")
    assert len(merge_items([a, b])) == 2


def test_merge_fills_missing_line_number_and_is_idempotent() -> None:
    a = make_item("Gloves", 10, "pairs", URL_A)
    b = make_item("Gloves", 10, "pairs", URL_B, lineNo="3")
    once = merge_items([a, b])
    assert once[0]["lineNo"] == "3"
    assert merge_items(once) == once


def test_merge_keeps_review_flag_if_either_side_had_it() -> None:
    a = make_item("Gloves", 10, "pairs", URL_A)
    b = make_item("Gloves", 10, "pairs", URL_B)
    b["needsReview"] = True
    assert merge_items([a, b])[0]["needsReview"] is True


def test_merge_empty_and_schema_validity() -> None:
    assert merge_items([]) == []
    out = merge_items(
        [make_item("Gloves", 10, "pairs", URL_A), make_item("Gloves", 10, "pairs", URL_B)]
    )
    validate_record(make_record(items=out))
    bad = copy.deepcopy(out[0])
    bad["description"] = ""
    try:
        validate_record(make_record(items=[bad]))
    except jsonschema.ValidationError:
        pass
    else:  # pragma: no cover
        raise AssertionError("schema should reject an empty description")
