"""Content hash, duplicate detection, in-run dedupe, amendments/deadline diffs, version ordering."""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

from tender_sources.merge import (
    content_hash,
    dedupe_in_run,
    diff_records,
    possible_duplicates,
    supersedes,
)
from tender_sources.normalize.dates import parse_date

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from records_helper import make_item, make_record, validate_record


def fact(value: str | None) -> dict[str, Any]:
    return {
        "value": value,
        "status": "published" if value else "not_published",
        "evidence": [],
        "note": None,
    }


def rec(**over: Any) -> dict[str, Any]:
    return make_record(**over)


def with_deadline(r: dict[str, Any], text: str) -> dict[str, Any]:
    r = copy.deepcopy(r)
    r["deadline"] = parse_date(text)
    return r


# ---------------------------------------------------------------- content hash


def test_hash_is_64_hex_and_valid_for_the_schema() -> None:
    r = rec()
    r["contentHash"] = content_hash(r)
    assert len(r["contentHash"]) == 64
    validate_record(r)


def test_hash_ignores_timestamps_and_retrieval_times() -> None:
    ev = {
        "sourceUrl": "https://e.test/x",
        "quote": "q",
        "page": 1,
        "documentUrl": None,
        "retrievedAt": "2026-10-31T00:00:00Z",
    }
    doc = {
        "url": "https://e.test/d.pdf",
        "status": "retrieved",
        "sha256": "ab",
        "fetchedAt": "2026-10-31T01:00:00Z",
    }
    a = rec(statusEvidence=[ev], documents=[doc])
    b = copy.deepcopy(a)
    b["firstSeenAt"] = b["lastCheckedAt"] = b["lastUpdatedAt"] = "2027-01-01T00:00:00Z"
    b["contentHash"] = "f" * 64
    b["statusEvidence"][0]["retrievedAt"] = "2027-01-01T00:00:00Z"
    b["documents"][0]["fetchedAt"] = "2027-01-01T00:00:00Z"
    b["buyer"]["evidence"] = [dict(ev, retrievedAt="2027-02-02T00:00:00Z")]
    a["buyer"]["evidence"] = [dict(ev, retrievedAt="2026-10-31T00:00:00Z")]
    assert content_hash(a) == content_hash(b)


def test_hash_is_independent_of_key_order() -> None:
    a = rec()
    b = dict(reversed(list(a.items())))
    assert content_hash(a) == content_hash(b)


def test_hash_changes_when_content_changes() -> None:
    a = rec()
    base = content_hash(a)
    assert content_hash(with_deadline(a, "30-Nov-2026")) != base
    assert content_hash(rec(title="FIXTURE other")) != base
    assert (
        content_hash(rec(items=[make_item("Gloves", 4, "pairs", "https://e.test/a.pdf")])) != base
    )


def test_hash_ignores_duplicate_flags_that_depend_on_other_records() -> None:
    assert content_hash(rec()) == content_hash(rec(possibleDuplicateOf=["tendersontime:77"]))


def test_hash_is_stable_across_calls_and_does_not_mutate() -> None:
    r = rec()
    snapshot = copy.deepcopy(r)
    assert content_hash(r) == content_hash(r)
    assert r == snapshot


# ---------------------------------------------------------------- duplicate detection


def other(source: str, rid: str, **over: Any) -> dict[str, Any]:
    return rec(
        source=source, sourceRecordId=rid, canonicalUrl=f"https://{source}.test/{rid}", **over
    )


def test_same_reference_across_sources_is_flagged() -> None:
    mine = rec()
    theirs = other("tendersontime", "T9", title="Completely different wording")
    assert possible_duplicates(mine, [theirs]) == ["tendersontime:T9"]


def test_reference_comparison_normalises_punctuation_and_case() -> None:
    mine = rec(reference=fact("ZM-MOH-001/RFB"))
    theirs = other("tot", "1", reference=fact("zm moh 001 rfb"), title="Other")
    assert possible_duplicates(mine, [theirs]) == ["tot:1"]


def test_short_or_missing_references_are_not_enough() -> None:
    assert (
        possible_duplicates(
            rec(reference=fact("12")), [other("tot", "1", reference=fact("12"), title="zzz")]
        )
        == []
    )
    assert (
        possible_duplicates(
            rec(reference=fact(None)), [other("tot", "1", reference=fact(None), title="zzz")]
        )
        == []
    )


def test_similar_title_same_buyer_and_close_deadline_is_flagged() -> None:
    mine = with_deadline(rec(reference=fact(None)), "20-Nov-2026 10:00 UTC")
    theirs = with_deadline(
        other("tot", "5", reference=fact(None), title="FIXTURE Supply of Motorcycles."),
        "20-Nov-2026 18:00 UTC",
    )
    assert possible_duplicates(mine, [theirs]) == ["tot:5"]


def test_similar_title_but_deadline_far_apart_is_not_flagged() -> None:
    mine = with_deadline(rec(reference=fact(None)), "20-Nov-2026")
    theirs = with_deadline(
        other("tot", "5", reference=fact(None), title="FIXTURE Supply of motorcycles"),
        "20-Dec-2026",
    )
    assert possible_duplicates(mine, [theirs]) == []


def test_similar_title_but_different_buyer_is_not_flagged() -> None:
    mine = rec(reference=fact(None))
    theirs = other("tot", "5", reference=fact(None), buyer=fact("Ministry of Education"))
    assert possible_duplicates(mine, [theirs]) == []


def test_unknown_buyer_falls_back_to_country() -> None:
    mine = rec(reference=fact(None), buyer=fact(None))
    same_country = other("tot", "5", reference=fact(None), buyer=fact(None))
    other_country = other("tot", "6", reference=fact(None), buyer=fact(None), country=fact("Kenya"))
    assert possible_duplicates(mine, [same_country, other_country]) == ["tot:5"]


def test_unknown_deadline_never_counts_as_close() -> None:
    mine = rec(reference=fact(None))
    mine["deadline"] = parse_date("TBD")
    assert possible_duplicates(mine, [other("tot", "5", reference=fact(None))]) == []


def test_dissimilar_titles_are_not_flagged_even_with_same_buyer_and_deadline() -> None:
    mine = rec(reference=fact(None))
    theirs = other("tot", "5", reference=fact(None), title="Construction of a rural clinic")
    assert possible_duplicates(mine, [theirs]) == []


def test_same_source_is_never_flagged_and_input_is_not_modified() -> None:
    mine = rec()
    sibling = rec(sourceRecordId="OP00002")  # same source, same reference
    before = copy.deepcopy(mine)
    assert possible_duplicates(mine, [sibling, mine]) == []
    assert mine == before and "possibleDuplicateOf" not in mine


def test_duplicates_are_sorted_and_unique() -> None:
    mine = rec()
    others = [other("zzz", "2"), other("aaa", "1"), other("aaa", "1")]
    assert possible_duplicates(mine, others) == ["aaa:1", "zzz:2"]


# ---------------------------------------------------------------- dedupe in a run


def test_dedupe_same_source_id_keeps_the_richer_record() -> None:
    thin = rec()
    rich = rec(
        items=[make_item("Gloves", 4, "pairs", "https://e.test/a.pdf")],
        scopeOfSupply=fact("Gloves and boots"),
    )
    assert dedupe_in_run([thin, rich]) == [rich]
    assert dedupe_in_run([rich, thin]) == [rich]


def test_dedupe_same_canonical_url_with_different_ids() -> None:
    a = rec(sourceRecordId="A")
    b = rec(sourceRecordId="B", scopeOfSupply=fact("More detail"))
    assert dedupe_in_run([a, b]) == [b]


def test_dedupe_prefers_higher_notice_version_over_richness() -> None:
    v1 = rec(noticeVersion="1", scopeOfSupply=fact("long text " * 10))
    v2 = rec(noticeVersion="2")
    assert dedupe_in_run([v1, v2])[0]["noticeVersion"] == "2"


def test_dedupe_uses_last_updated_as_tiebreak_and_is_order_independent() -> None:
    a = rec()
    b = rec(lastUpdatedAt="2026-11-05T00:00:00Z")
    assert dedupe_in_run([a, b]) == dedupe_in_run([b, a]) == [b]


def test_dedupe_keeps_distinct_records_in_first_seen_order() -> None:
    a, b, c = rec(sourceRecordId="1"), rec(sourceRecordId="2"), rec(sourceRecordId="3")
    for r in (a, b, c):
        r["canonicalUrl"] = f"https://example.test/{r['sourceRecordId']}"
    assert dedupe_in_run([c, a, b, a]) == [c, a, b]


def test_dedupe_does_not_merge_across_sources_with_equal_ids() -> None:
    a = rec(source="worldbank", sourceRecordId="1", canonicalUrl="https://a.test/1")
    b = rec(source="tot", sourceRecordId="1", canonicalUrl="https://b.test/1")
    assert len(dedupe_in_run([a, b])) == 2


def test_dedupe_transitive_and_empty() -> None:
    a = rec(sourceRecordId="1", canonicalUrl="https://x.test/u")
    b = rec(sourceRecordId="1", canonicalUrl="https://x.test/v")
    c = rec(sourceRecordId="2", canonicalUrl="https://x.test/v")
    assert len(dedupe_in_run([a, b, c])) == 1
    assert dedupe_in_run([]) == []


def test_dedupe_returns_copies() -> None:
    a = rec()
    out = dedupe_in_run([a])
    out[0]["title"] = "changed"
    assert a["title"] != "changed"


# ---------------------------------------------------------------- amendments and deadline changes


def kinds(changes: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(c["field"], c["kind"]) for c in changes]


def test_no_changes_between_identical_records_even_if_timestamps_differ() -> None:
    a = rec()
    b = copy.deepcopy(a)
    b["lastCheckedAt"] = b["lastUpdatedAt"] = "2027-01-01T00:00:00Z"
    b["contentHash"] = "a" * 64
    assert diff_records(a, b) == []


def test_deadline_extension_is_detected_with_old_and_new_values() -> None:
    old = with_deadline(rec(), "20-Nov-2026 10:00 UTC")
    new = with_deadline(rec(), "04-Dec-2026 10:00 UTC")
    (change,) = diff_records(old, new)
    assert change == {
        "field": "deadline",
        "old": "2026-11-20T10:00:00Z",
        "new": "2026-12-04T10:00:00Z",
        "kind": "deadline_extended",
    }


def test_deadline_shortening_is_detected() -> None:
    old = with_deadline(rec(), "20-Nov-2026")
    new = with_deadline(rec(), "10-Nov-2026")
    assert kinds(diff_records(old, new)) == [("deadline", "deadline_shortened")]


def test_deadline_becoming_unknown_or_known_is_a_generic_change() -> None:
    old = with_deadline(rec(), "20-Nov-2026")
    gone = with_deadline(rec(), "TBD")
    assert kinds(diff_records(old, gone)) == [("deadline", "deadline_changed")]
    assert kinds(diff_records(gone, old)) == [("deadline", "deadline_changed")]


def test_cancellation_is_a_status_change() -> None:
    (change,) = diff_records(rec(status="open"), rec(status="cancelled"))
    assert change == {
        "field": "status",
        "old": "open",
        "new": "cancelled",
        "kind": "status_changed",
    }


def test_amendment_with_new_notice_version_extension_and_cancellation_all_reported() -> None:
    v1 = with_deadline(rec(noticeVersion="1", noticeType="Invitation for Bids"), "20-Nov-2026")
    v2 = with_deadline(rec(noticeVersion="2", noticeType="Amendment"), "27-Nov-2026")
    v3 = with_deadline(
        rec(noticeVersion="3", noticeType="Cancellation", status="cancelled"), "27-Nov-2026"
    )
    d12, d23 = diff_records(v1, v2), diff_records(v2, v3)
    assert ("deadline", "deadline_extended") in kinds(d12)
    assert ("noticeVersion", "other") in kinds(d12) and ("noticeType", "other") in kinds(d12)
    assert kinds(d23) == [
        ("status", "status_changed"),
        ("noticeVersion", "other"),
        ("noticeType", "other"),
    ]
    # history is preserved: each diff carries both the previous and the new value
    assert [c["old"] for c in d12 if c["field"] == "noticeVersion"] == ["1"]
    assert [c["new"] for c in d23 if c["field"] == "noticeVersion"] == ["3"]


def test_value_changes_are_reported_per_field_and_never_cross_fields() -> None:
    old = rec(
        tenderFee={"amount": 500.0, "currency": "ZMW"},
        bidSecurity={"amount": 5000.0, "currency": "ZMW"},
    )
    new = rec(
        tenderFee={"amount": 500.0, "currency": "ZMW"},
        bidSecurity={"amount": 7000.0, "currency": "ZMW"},
    )
    (change,) = diff_records(old, new)
    assert change["field"] == "bidSecurity" and change["kind"] == "value_changed"
    assert change["old"]["amount"] == 5000.0 and change["new"]["amount"] == 7000.0


def test_currency_change_with_same_amount_is_a_value_change() -> None:
    old = rec(estimatedValue={"amount": 100.0, "currency": "USD"})
    new = rec(estimatedValue={"amount": 100.0, "currency": "ZMW"})
    assert kinds(diff_records(old, new)) == [("estimatedValue", "value_changed")]


def test_item_and_quantity_changes() -> None:
    u = "https://e.test/a.pdf"
    old = rec(items=[make_item("Gloves", 10, "pairs", u), make_item("Boots", 5, "pairs", u)])
    qty = rec(items=[make_item("Gloves", 12, "pairs", u), make_item("Boots", 5, "pairs", u)])
    added = rec(items=[*old["items"], make_item("Vest", 3, "pcs", u)])
    assert kinds(diff_records(old, qty)) == [("items", "items_changed")]
    assert kinds(diff_records(old, added)) == [("items", "items_changed")]
    reordered = rec(items=list(reversed(old["items"])))
    assert diff_records(old, reordered) == []


def test_item_evidence_changes_alone_are_not_item_changes() -> None:
    u = "https://e.test/a.pdf"
    a = rec(items=[make_item("Gloves", 10, "pairs", u, page=1)])
    b = rec(items=[make_item("Gloves", 10, "pairs", u, page=7)])
    assert diff_records(a, b) == []


def test_document_changes_are_reported_as_other() -> None:
    d = {"url": "https://e.test/d.pdf", "status": "retrieved", "sha256": "aa"}
    old, new = rec(documents=[d]), rec(documents=[dict(d, sha256="bb")])
    assert kinds(diff_records(old, new)) == [("documents", "other")]


def test_diff_does_not_mutate_inputs() -> None:
    a, b = with_deadline(rec(), "20-Nov-2026"), with_deadline(rec(), "21-Nov-2026")
    sa, sb = copy.deepcopy(a), copy.deepcopy(b)
    diff_records(a, b)
    assert (a, b) == (sa, sb)


# ---------------------------------------------------------------- supersedes


def test_higher_notice_version_supersedes() -> None:
    assert supersedes(rec(noticeVersion="2"), rec(noticeVersion="1")) is True
    assert supersedes(rec(noticeVersion="1"), rec(noticeVersion="2")) is False


def test_version_parsing_handles_labels_and_dotted_versions() -> None:
    assert supersedes(rec(noticeVersion="Amendment 3"), rec(noticeVersion="Amendment 2")) is True
    assert supersedes(rec(noticeVersion="v1.10"), rec(noticeVersion="v1.9")) is True
    assert (
        supersedes(rec(noticeVersion="10"), rec(noticeVersion="9")) is True
    )  # numeric, not lexical


def test_later_published_date_supersedes_when_versions_unknown() -> None:
    new = rec(publishedAt=parse_date("10-Oct-2026"))
    old = rec(publishedAt=parse_date("01-Oct-2026"))
    assert supersedes(new, old) is True
    assert supersedes(old, new) is False


def test_unclear_cases_return_none() -> None:
    assert supersedes(rec(), rec()) is None
    assert supersedes(rec(noticeVersion="2"), rec(noticeVersion="2")) is None
    assert supersedes(rec(noticeVersion="2"), rec(noticeVersion=None)) is None


def test_contradicting_signals_return_none_so_the_caller_flags_a_conflict() -> None:
    new = rec(noticeVersion="3", publishedAt=parse_date("01-Oct-2026"))
    old = rec(noticeVersion="2", publishedAt=parse_date("10-Oct-2026"))
    assert supersedes(new, old) is None


def test_agreeing_version_and_date_signals() -> None:
    new = rec(noticeVersion="2", publishedAt=parse_date("10-Oct-2026"))
    old = rec(noticeVersion="1", publishedAt=parse_date("01-Oct-2026"))
    assert supersedes(new, old) is True and supersedes(old, new) is False
