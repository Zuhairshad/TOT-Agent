"""Missing values never become zero; currency and value-type separation."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from records_helper import validate_fragment

from tender_sources.normalize.money import classify_value_label, parse_money


@pytest.mark.parametrize(
    ("text", "amount", "currency"),
    [
        ("1,200,000.50", 1200000.5, None),
        ("1.200.000,50", 1200000.5, None),
        ("USD 1.2 million", 1200000.0, "USD"),
        ("ETB 219000.00", 219000.0, "ETB"),
        ("ZMW 5,000", 5000.0, "ZMW"),
        ("5,000 ZMW", 5000.0, "ZMW"),
        ("US$ 250", 250.0, "USD"),
        ("€1,000", 1000.0, "EUR"),
        ("2,5", 2.5, None),
    ],
)
def test_money_amounts_and_unambiguous_currency(
    text: str, amount: float, currency: str | None
) -> None:
    fact = parse_money(text)
    assert fact["amount"] == amount
    assert fact["currency"] == currency
    assert fact["status"] == "published"
    assert fact["originalText"] == text
    validate_fragment("tenderFee", fact)


@pytest.mark.parametrize(
    "text",
    [
        "Refer Document",
        "As per tender document",
        "Free",
        "N/A",
        "",
        "   ",
        None,
        "TBD",
        "Not stated",
        "-",
        "See tender documents",
    ],
)
def test_missing_values_are_never_zero(text: str | None) -> None:
    fact = parse_money(text)
    assert fact["amount"] is None
    assert fact["amount"] != 0
    assert fact["currency"] is None
    assert fact["status"] == "not_published"


def test_free_is_not_converted_to_zero_and_says_so() -> None:
    fact = parse_money("Free")
    assert fact["amount"] is None
    assert "NOT as 0" in fact["note"]


def test_literal_zero_is_kept_and_the_note_says_so() -> None:
    fact = parse_money("ZMW 0.00")
    assert fact["amount"] == 0.0
    assert "zero amount" in fact["note"]


@pytest.mark.parametrize("text", ["$ 100", "K 5,000", "ZK 5000", "Rs. 400", "kr 20"])
def test_ambiguous_symbols_do_not_set_currency(text: str) -> None:
    fact = parse_money(text)
    assert fact["currency"] is None
    assert fact["originalText"] == text  # the symbol is preserved in the original text


def test_ambiguous_symbol_note_is_explicit() -> None:
    assert "ambiguous" in parse_money("$ 100")["note"]


def test_currency_hint_used_only_when_text_names_none() -> None:
    assert parse_money("500", currency_hint="zmw")["currency"] == "ZMW"
    assert "separate source field" in parse_money("500", currency_hint="zmw")["note"]
    assert parse_money("USD 500", currency_hint="ZMW")["currency"] == "USD"


@pytest.mark.parametrize("text", ["USD 100-200", "USD 100 to 200", "100 – 200 ZMW"])
def test_ranges_have_no_amount(text: str) -> None:
    fact = parse_money(text)
    assert fact["amount"] is None
    assert "range" in fact["note"]
    assert fact["status"] == "could_not_verify"


@pytest.mark.parametrize("text", ["-500", "USD -500", "(500)"])
def test_negative_amounts_are_rejected(text: str) -> None:
    fact = parse_money(text)
    assert fact["amount"] is None and fact["status"] == "could_not_verify"


def test_ambiguous_single_dot_thousands_is_not_guessed() -> None:
    fact = parse_money("1.200")
    assert fact["amount"] is None and "ambiguous" in fact["note"]


def test_two_currencies_in_one_text_not_chosen() -> None:
    fact = parse_money("ZMW 500 or USD 20")
    assert fact["amount"] is None and fact["currency"] is None


@pytest.mark.parametrize("garbage", ["abc", "\x00", "12..3..4", "1,2,3,4", 7, [], "ZMW"])
def test_garbage_never_raises_and_never_invents_an_amount(garbage: object) -> None:
    fact = parse_money(garbage)  # type: ignore[arg-type]
    assert fact["amount"] is None


@pytest.mark.parametrize(
    ("label", "kind"),
    [
        ("Estimated cost", "estimated"),
        ("Engineer's estimate", "estimated"),
        ("Engineer’s Estimate", "estimated"),
        ("Budget", "estimated"),
        ("Contract price", "award"),
        ("Signed Contract price", "award"),
        ("Awarded value", "award"),
        ("Evaluated Bid Price", "award"),
        ("Tender fee", "tender_fee"),
        ("Document fee", "tender_fee"),
        ("Cost of bidding documents", "tender_fee"),
        ("Bid security", "bid_security"),
        ("Tender security", "bid_security"),
        ("EMD", "bid_security"),
        ("Earnest money", "bid_security"),
        ("Bid bond", "bid_security"),
        ("Colour of the building", None),
        ("", None),
    ],
)
def test_value_label_classification(label: str, kind: str | None) -> None:
    assert classify_value_label(label) == kind


def test_the_four_value_categories_never_collapse() -> None:
    labels = {
        "estimated": "Estimated cost",
        "award": "Contract price",
        "tender_fee": "Tender fee",
        "bid_security": "Bid security",
    }
    got = {k: classify_value_label(v) for k, v in labels.items()}
    assert got == {k: k for k in labels}
    assert len(set(got.values())) == 4


@pytest.mark.parametrize(
    ("label", "wrong"),
    [
        ("Tender security", "tender_fee"),  # contains "tender" but is a security, not a fee
        ("Cost of bidding documents", "estimated"),  # contains "cost" but is a fee
        ("Evaluated Bid Price", "bid_security"),  # contains "bid" but is award-side
        ("Bid bond", "tender_fee"),
        ("Document fee", "estimated"),
    ],
)
def test_lookalike_labels_do_not_cross_categories(label: str, wrong: str) -> None:
    assert classify_value_label(label) not in {wrong, None}
