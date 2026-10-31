"""Date parsing and deadline ordering."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from records_helper import validate_fragment

from tender_sources.normalize.dates import parse_date, sort_key


@pytest.mark.parametrize(
    ("text", "value", "tz", "precision"),
    [
        ("20-Oct-2026", "2026-10-20T00:00:00Z", None, "date"),
        ("2026-10-16T00:00:00Z", "2026-10-16T00:00:00Z", "Z", "datetime"),
        ("31/10/2026 17:00 CAT", "2026-10-31T15:00:00Z", "CAT", "datetime"),
        ("31 October 2026, 5:00 PM (GMT+2)", "2026-10-31T15:00:00Z", "GMT+2", "datetime"),
        ("31 October 2026 17:00 UTC+02:00", "2026-10-31T15:00:00Z", "UTC+02:00", "datetime"),
        ("2026-10-16T10:00:00+02:00", "2026-10-16T08:00:00Z", "+02:00", "datetime"),
        ("Friday, 31st October 2026 at 17:00 hrs UTC", "2026-10-31T17:00:00Z", "UTC", "datetime"),
        ("Oct 31, 2026 5pm CAT", "2026-10-31T15:00:00Z", "CAT", "datetime"),
        ("31/10/2026", "2026-10-31T00:00:00Z", None, "date"),  # 31 cannot be a month: unambiguous
    ],
)
def test_date_parsing_formats_convert_to_utc(
    text: str, value: str, tz: str | None, precision: str
) -> None:
    fact = parse_date(text)
    assert fact["value"] == value
    assert fact["timezone"] == tz
    assert fact["precision"] == precision
    assert fact["status"] == "published"
    assert fact["originalText"] == text
    validate_fragment("deadline", fact)


def test_date_only_uses_stated_timezone_midnight_then_default_then_utc() -> None:
    assert parse_date("20-Oct-2026 CAT")["value"] == "2026-10-19T22:00:00Z"
    assert parse_date("20-Oct-2026", default_tz="Africa/Lusaka")["value"] == "2026-10-19T22:00:00Z"
    assert parse_date("20-Oct-2026")["value"] == "2026-10-20T00:00:00Z"


def test_default_tz_is_not_reported_as_stated_timezone() -> None:
    fact = parse_date("31/10/2026 17:00", default_tz="Africa/Lusaka")
    assert fact["value"] == "2026-10-31T15:00:00Z"
    assert fact["timezone"] is None
    assert "assumed Africa/Lusaka" in fact["note"]


def test_ambiguous_numeric_date_is_not_guessed_without_dayfirst() -> None:
    fact = parse_date("03/04/2026")
    assert fact["value"] is None
    assert fact["ambiguous"] is True
    assert fact["status"] == "could_not_verify"
    assert "D/M" in fact["note"] and "M/D" in fact["note"]
    validate_fragment("deadline", fact)


def test_dayfirst_hint_resolves_ambiguity_both_ways() -> None:
    assert parse_date("03/04/2026", dayfirst=True)["value"] == "2026-04-03T00:00:00Z"
    assert parse_date("03/04/2026", dayfirst=False)["value"] == "2026-03-04T00:00:00Z"
    assert parse_date("03/04/2026", dayfirst=True)["status"] == "published"


def test_equal_day_and_month_is_not_ambiguous() -> None:
    assert parse_date("05/05/2026")["value"] == "2026-05-05T00:00:00Z"


def test_two_digit_year_is_flagged_ambiguous() -> None:
    fact = parse_date("20-Oct-26")
    assert fact["ambiguous"] is True
    assert fact["value"] == "2026-10-20T00:00:00Z"
    assert "Two-digit year" in fact["note"]


@pytest.mark.parametrize(
    "text", ["Refer Document", "N/A", "TBD", "", "   ", "As per tender document", None, "-"]
)
def test_placeholders_are_not_published_and_have_no_value(text: str | None) -> None:
    fact = parse_date(text)
    assert fact["value"] is None
    assert fact["status"] == "not_published"
    assert fact["precision"] is None


@pytest.mark.parametrize(
    "text", ["31/02/2026", "30 February 2026", "2026-13-01", "31/10/2026 25:00", "29 Feb 2027"]
)
def test_impossible_dates_are_could_not_verify(text: str) -> None:
    fact = parse_date(text)
    assert fact["value"] is None
    assert fact["status"] == "could_not_verify"
    assert fact["note"]


def test_year_missing_is_not_guessed() -> None:
    fact = parse_date("31 October")
    assert fact["value"] is None and fact["status"] == "could_not_verify"


@pytest.mark.parametrize(
    "garbage", ["¯\\_(ツ)_/¯", "99999999999", "\x00\x01", "31/10", "Oct 99 2026 99:99", 42, [], {}]
)
def test_garbage_never_raises(garbage: object) -> None:
    fact = parse_date(garbage)  # type: ignore[arg-type]
    assert fact["value"] is None
    assert fact["status"] in {"not_published", "could_not_verify"}


def test_unknown_default_timezone_does_not_raise() -> None:
    fact = parse_date("20-Oct-2026", default_tz="Mars/Olympus")
    assert fact["value"] is None and fact["status"] == "could_not_verify"


def test_evidence_is_passed_through_and_copied() -> None:
    ev = [
        {
            "sourceUrl": "https://example.test/x",
            "quote": "q",
            "page": None,
            "documentUrl": None,
            "retrievedAt": "2026-10-31T00:00:00Z",
        }
    ]
    fact = parse_date("20-Oct-2026", evidence=ev)
    assert fact["evidence"] == ev and fact["evidence"] is not ev


def test_deadline_ordering_ascending_puts_unknown_last() -> None:
    facts = [
        parse_date(t) for t in ["20-Nov-2026", "N/A", "01-Oct-2026", "03/04/2026", "15-Oct-2026"]
    ]
    ordered = sorted(facts, key=lambda f: sort_key(f))
    assert [f["originalText"] for f in ordered] == [
        "01-Oct-2026",
        "15-Oct-2026",
        "20-Nov-2026",
        "N/A",
        "03/04/2026",
    ]


def test_deadline_ordering_descending_still_puts_unknown_last() -> None:
    facts = [parse_date(t) for t in ["20-Nov-2026", "N/A", "01-Oct-2026", "garbage", "15-Oct-2026"]]
    ordered = sorted(facts, key=lambda f: sort_key(f, descending=True))
    assert [f["originalText"] for f in ordered] == [
        "20-Nov-2026",
        "15-Oct-2026",
        "01-Oct-2026",
        "N/A",
        "garbage",
    ]


def test_sort_key_compares_across_timezones_in_utc() -> None:
    late_utc = parse_date("31/10/2026 23:00 CAT")  # 21:00Z
    early_utc = parse_date("31/10/2026 22:00 UTC")  # 22:00Z
    assert sort_key(late_utc) < sort_key(early_utc)


def test_sort_key_handles_missing_or_malformed_facts() -> None:
    assert sort_key({}) == (1, 0.0)
    assert sort_key({"value": "not-a-date"}) == (1, 0.0)
