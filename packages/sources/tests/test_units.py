"""Quantity parsing: units kept as published, nothing invented."""

from __future__ import annotations

import pytest

from tender_sources.normalize.units import parse_quantity


@pytest.mark.parametrize(
    ("text", "value", "unit"),
    [
        ("12 pcs", 12.0, "pcs"),
        ("Twelve (12) Nos", 12.0, "Nos"),
        ("1,000 pairs", 1000.0, "pairs"),
        ("qty: 5", 5.0, None),
        ("Qty 5 sets", 5.0, "sets"),
        ("2 sets", 2.0, "sets"),
        ("3 x", 3.0, None),
        ("quantity 1", 1.0, None),
        ("twelve", 12.0, None),
        ("2.5 kg", 2.5, "kg"),
        ("0", 0.0, None),
    ],
)
def test_quantity_values_and_units(text: str, value: float, unit: str | None) -> None:
    q = parse_quantity(text)
    assert q == {"value": value, "originalText": text, "unit": unit}


@pytest.mark.parametrize("text", ["LS", "ls", "lot", "Lump sum", "L.S."])
def test_lump_sum_is_not_a_quantity(text: str) -> None:
    q = parse_quantity(text)
    assert q["value"] is None
    assert q["unit"] == text.strip()


def test_pairs_stay_pairs_and_are_never_converted() -> None:
    assert parse_quantity("1,000 pairs")["unit"] == "pairs"
    assert parse_quantity("6 pairs")["value"] == 6.0  # not 12 pieces
    assert parse_quantity("2 dozen")["value"] == 2.0  # not 24


@pytest.mark.parametrize("text", ["", "   ", None])
def test_blank_quantity_is_none_not_zero(text: str | None) -> None:
    q = parse_quantity(text)
    assert q["value"] is None and q["unit"] is None


@pytest.mark.parametrize(
    "text", ["10-20", "10 to 20 pcs", "-5 pcs", "1.000 pairs", "many", "TBD 12 or 15"]
)
def test_ranges_negative_and_ambiguous_have_no_value_but_keep_text(text: str) -> None:
    q = parse_quantity(text)
    assert q["value"] is None
    assert q["originalText"] == text.strip()


def test_bare_unit_without_number_has_no_value() -> None:
    assert parse_quantity("pcs") == {"value": None, "originalText": "pcs", "unit": "pcs"}


def test_words_and_digits_that_disagree_are_not_trusted() -> None:
    assert parse_quantity("Twelve (15) Nos")["value"] is None


@pytest.mark.parametrize("garbage", [object(), 5, [], "\x00", "!!!"])
def test_garbage_never_raises(garbage: object) -> None:
    assert parse_quantity(garbage)["value"] is None  # type: ignore[arg-type]
