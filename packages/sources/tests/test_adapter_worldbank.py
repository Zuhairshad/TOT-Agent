"""World Bank adapter: mapping honesty, pagination stop reasons, filters. Uses FIXTURE API pages."""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from jsonschema import Draft7Validator, FormatChecker
from test_http_support import fake_api, make_client, resp, rows

from tender_sources.adapters import worldbank
from tender_sources.adapters.base import (
    ACCESS_BLOCKED,
    ACCESS_OK,
    ACCESS_UNREACHABLE,
    DiscoverContext,
    Limits,
    RawNotice,
    pagination_stop,
)
from tender_sources.adapters.worldbank import (
    WorldBankAdapter,
    build_api_url,
    extract_deadline,
    html_to_text,
)
from tender_sources.http import PoliteClient, RawResponse
from tender_sources.sink import load_default_config

FIX = Path(__file__).parent / "fixtures" / "worldbank"
SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema" / "tender-record.schema.json"
VALIDATOR = Draft7Validator(json.loads(SCHEMA.read_text()), format_checker=FormatChecker())
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
CONFIG = load_default_config()


def load(name: str) -> dict[str, Any]:
    data = json.loads((FIX / name).read_text("utf-8"))
    assert data["_fixture"].startswith("FIXTURE")
    return data


def valid(record: dict[str, Any]) -> None:
    errors = [f"{list(e.path)}: {e.message}" for e in VALIDATOR.iter_errors(record)]
    assert errors == []


def raw_for(row: dict[str, Any]) -> RawNotice:
    from tender_sources.adapters.base import ListingRef

    row = {**row, "_apiUrl": "https://search.worldbank.org/api/v2/procnotices?format=json&qterm=x"}
    ref = ListingRef(id=row["id"], url=worldbank.NOTICE_URL.format(id=row["id"]), payload=row)
    return RawNotice(
        ref=ref, data=row, source_url=row["_apiUrl"], fetched_at="2026-10-31T12:00:00Z"
    )


def ifb_row(**over: Any) -> dict[str, Any]:
    row = load("zambia_ifb.json")["procnotices"][0]
    row.update(notice_type="Invitation for Bids", noticedate="20-Oct-2026", project_ctry_name="Zambia",
               notice_status="Published", procurement_group="CW")  # fmt: skip
    row.update(over)
    return row


# ----------------------------------------------------------------------- mapping


def test_contract_award_fixture_maps_honestly() -> None:
    row = load("motorcycle_page.json")["procnotices"][0]
    record = WorldBankAdapter().to_record(raw_for(row), CONFIG, NOW)
    valid(record)
    assert record["source"] == "worldbank" and record["sourceRecordId"] == "OP00476269"
    assert record["canonicalUrl"].endswith("/procurement-detail/OP00476269")
    # award price goes ONLY into awardValue, with its quote
    assert record["awardValue"]["amount"] == 219000.0 and record["awardValue"]["currency"] == "ETB"
    assert "Signed Contract price ETB 219000.00" in record["awardValue"]["evidence"][0]["quote"]
    # the API's own estimate is a different field
    assert (
        record["estimatedValue"]["amount"] == 3600.0
        and record["estimatedValue"]["currency"] == "USD"
    )
    assert record["status"] == "closed" and record["statusEvidence"]
    assert record["deadline"]["value"] is None and record["deadline"]["status"] == "not_published"
    assert record["publishedAt"]["value"] == "2026-10-20T00:00:00Z"
    assert record["publishedAt"]["originalText"] == "20-Oct-2026"
    item = record["items"][0]
    assert item["quantity"]["value"] == 1.0 and "quantity 1" in item["quantity"]["originalText"]
    assert item["needsReview"] is True
    assert "motorbikes" in record["categories"]


def test_multiple_award_prices_are_not_summed() -> None:
    row = load("motorcycle_page.json")["procnotices"][0]
    row["notice_text"] += "<div>Signed Contract price<br/>ETB 1000.00</div>"
    record = WorldBankAdapter().to_record(raw_for(row), CONFIG, NOW)
    valid(record)
    assert record["awardValue"]["amount"] is None
    assert len(record["awardValue"]["evidence"]) == 2
    assert "not summed" in record["awardValue"]["note"]


def test_missing_estimate_is_null_not_zero() -> None:
    row = load("motorcycle_page.json")["procnotices"][0]
    for bad in ("0", "", None):
        row["bid_estimate_amount"] = bad
        record = WorldBankAdapter().to_record(raw_for(row), CONFIG, NOW)
        assert record["estimatedValue"]["amount"] is None
        assert record["estimatedValue"]["status"] == "not_published"


def test_invitation_with_future_deadline_is_open() -> None:
    record = WorldBankAdapter().to_record(raw_for(ifb_row()), CONFIG, NOW)
    valid(record)
    assert record["deadline"]["value"] == "2026-11-23T10:00:00Z"  # 12:00 CAT
    assert record["deadline"]["status"] == "published"
    assert "on or before" in record["deadline"]["evidence"][0]["quote"]
    assert record["status"] == "open"
    assert record["awardValue"]["status"] == "not_published"
    assert record["buyer"]["value"] == "Ministry of Commerce Trade and Industry"
    assert record["reference"]["value"] == "ZM-MCTI-573248-CW-RFB"


def test_invitation_with_past_deadline_is_closed_and_unknown_without_deadline() -> None:
    later = datetime(2027, 1, 5, tzinfo=UTC)
    assert WorldBankAdapter().to_record(raw_for(ifb_row()), CONFIG, later)["status"] == "closed"
    no_deadline = ifb_row(
        notice_text="<p>The Ministry invites bids. Details in the bidding document.</p>"
    )
    record = WorldBankAdapter().to_record(raw_for(no_deadline), CONFIG, NOW)
    valid(record)
    assert record["status"] == "unknown"  # never 'open' without evidence
    assert (
        record["deadline"]["value"] is None and record["deadline"]["status"] == "could_not_verify"
    )


def test_cancelled_and_unknown_types() -> None:
    cancelled = ifb_row(notice_status="Cancelled")
    assert WorldBankAdapter().to_record(raw_for(cancelled), CONFIG, NOW)["status"] == "cancelled"
    gpn = ifb_row(notice_type="General Procurement Notice")
    assert WorldBankAdapter().to_record(raw_for(gpn), CONFIG, NOW)["status"] in (
        "unknown",
        "open",
        "closed",
    )


def test_record_is_stable_for_the_same_input() -> None:
    row = load("motorcycle_page.json")["procnotices"][0]
    a = WorldBankAdapter().to_record(raw_for(row), CONFIG, NOW)
    b = WorldBankAdapter().to_record(
        raw_for(copy.deepcopy(row)), CONFIG, datetime(2026, 11, 2, tzinfo=UTC)
    )
    assert a["sourceRecordId"] == b["sourceRecordId"] and a["contentHash"] == b["contentHash"]


def test_extract_deadline_variants() -> None:
    src = "https://x.test/"
    f = extract_deadline(
        "Bids must be submitted no later than 5 December 2026 at 10:00 hours (GMT+2).",
        "2026-10-31T00:00:00Z",
        src,
    )
    assert f and f["value"].startswith("2026-12-05")
    g = extract_deadline("Deadline for submission is November 9, 2026", "2026-10-31T00:00:00Z", src)
    assert g and g["value"] == "2026-11-09T00:00:00Z"
    assert (
        extract_deadline("No dates here. Issued on 12 October 2026.", "2026-10-31T00:00:00Z", src)
        is None
    )


def test_html_to_text_handles_entities_and_breaks() -> None:
    assert html_to_text("<p>A&nbsp;&amp; B</p><p>C<br/>D</p>") == "A & B\nC\nD"


# ----------------------------------------------------------------------- URL / API shape


def test_url_builder_uses_the_verified_parameters() -> None:
    url = build_api_url("motor cycle", country="Zambia", rows=20, offset=40)
    q = parse_qs(urlsplit(url).query)
    assert q["qterm"] == ["motor cycle"]  # unquoted phrase
    assert q["project_ctry_name_exact"] == ["Zambia"]
    assert q["os"] == ["40"] and q["rows"] == ["20"]
    assert q["srt"] == ["noticedate"] and q["order"] == ["desc"]
    assert "countrycode_exact" not in q


# ----------------------------------------------------------------------- discovery


def one_term_config(term: str = "motorcycle", countries: list[str] | None = None) -> dict[str, Any]:
    return {"groups": [{"id": "motorbikes", "label": "m", "terms": [term], "requireContext": []}],
            "exclusions": [], "countries": countries if countries is not None else ["Zambia"]}  # fmt: skip


def run_discover(
    handler: Any, tmp_path: Path, config: dict[str, Any], **kw: Any
) -> tuple[DiscoverContext, list[str]]:
    client, _, _ = make_client(handler, tmp_path)
    limits = Limits(
        max_pages=kw.pop("max_pages", 5),
        max_requests=kw.pop("max_requests", 400),
        rows_per_page=kw.pop("rows", 10),
    )
    ctx = DiscoverContext(client=client, config=config, limits=limits, **kw)
    ids = [r.id for r in WorldBankAdapter().discover(ctx)]
    return ctx, ids


def test_stop_reason_max_pages(tmp_path: Path) -> None:
    ctx, ids = run_discover(
        fake_api({"motorcycle": rows(100)}), tmp_path, one_term_config(), max_pages=2
    )
    assert len(ids) == 20 and ctx.pages_checked == 2
    assert ctx.stop_reasons == {"motorcycle (Zambia)": "max_pages"}


def test_stop_reason_empty_page(tmp_path: Path) -> None:
    ctx, ids = run_discover(fake_api({"motorcycle": []}), tmp_path, one_term_config())
    assert ids == [] and ctx.pages_checked == 1
    assert list(ctx.stop_reasons.values()) == ["empty_page"]


def test_stop_reason_short_page(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(7)})

    def lying(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        out = api(url, headers)
        assert isinstance(out, RawResponse)
        body = json.loads(out.body)
        body["total"] = "999"
        return resp(json.dumps(body))

    ctx, ids = run_discover(lying, tmp_path, one_term_config())
    assert len(ids) == 7 and ctx.pages_checked == 1
    assert list(ctx.stop_reasons.values()) == ["short_page"]


def test_stop_reason_no_next_link(tmp_path: Path) -> None:
    ctx, ids = run_discover(fake_api({"motorcycle": rows(20)}), tmp_path, one_term_config())
    assert len(ids) == 20 and ctx.pages_checked == 2  # full second page, but total reached
    assert list(ctx.stop_reasons.values()) == ["no_next_link"]


def test_stop_reason_older_than_since(tmp_path: Path) -> None:
    new = rows(6, prefix="NEW", start_date="20-Oct-2026")
    old = rows(14, prefix="OLD", start_date="01-Jan-2020")
    ctx, ids = run_discover(
        fake_api({"motorcycle": new + old}), tmp_path, one_term_config(), since="2026-01-01"
    )
    assert ids == [r["id"] for r in new]  # old rows are not yielded
    assert ctx.pages_checked == 1  # page 1 already reached older notices -> stop
    assert list(ctx.stop_reasons.values()) == ["older_than_since"]


def test_stop_reason_request_cap(tmp_path: Path) -> None:
    ctx, ids = run_discover(
        fake_api({"motorcycle": rows(100)}),
        tmp_path,
        one_term_config(),
        max_requests=2,
        max_pages=9,
    )
    assert ctx.pages_checked == 2 and len(ids) == 20
    assert list(ctx.stop_reasons.values()) == ["request_cap"]
    assert any("cap" in n for n in ctx.notes)


def test_pagination_stop_function_priorities() -> None:
    kw = {"page_index": 0, "max_pages": 3, "page_size": 10}
    assert pagination_stop(rows_returned=0, **kw) == "empty_page"  # type: ignore[arg-type]
    assert pagination_stop(rows_returned=5, **kw) == "short_page"  # type: ignore[arg-type]
    assert pagination_stop(rows_returned=10, **kw) is None  # type: ignore[arg-type]
    assert pagination_stop(rows_returned=10, has_next_link=False, **kw) == "no_next_link"  # type: ignore[arg-type]
    assert pagination_stop(rows_returned=10, page_index=2, max_pages=3, page_size=10) == "max_pages"
    d = datetime(2026, 1, 1, tzinfo=UTC)
    older = datetime(2025, 1, 1, tzinfo=UTC)
    assert (
        pagination_stop(rows_returned=10, oldest_on_page=older, since=d, **kw) == "older_than_since"
    )  # type: ignore[arg-type]


def test_dedupes_across_keywords_and_applies_country(tmp_path: Path) -> None:
    shared = rows(3)
    handler = fake_api({"motorcycle": shared, "Scooter": shared + rows(2, prefix="SC")})
    config = {"groups": [{"id": "motorbikes", "label": "m", "terms": ["motorcycle", "Scooter", "scooter"], "requireContext": []}],
              "exclusions": [], "countries": ["Zambia", "Kenya"]}  # fmt: skip
    _ctx, ids = run_discover(handler, tmp_path, config)
    assert len(ids) == len(set(ids)) == 5
    countries = {q["project_ctry_name_exact"][0] for q in handler.queries}
    assert countries == {"Zambia", "Kenya"}
    assert (
        len({(q["qterm"][0], q["project_ctry_name_exact"][0]) for q in handler.queries}) == 4
    )  # dup term removed


def test_failure_is_recorded_and_other_keywords_continue(tmp_path: Path) -> None:
    good = fake_api({"scooter": rows(2)})

    def handler(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        if "qterm=motorcycle" in url:
            return resp("<html>not json</html>")
        return good(url, headers)

    config = {"groups": [{"id": "motorbikes", "label": "m", "terms": ["motorcycle", "scooter"], "requireContext": []}],
              "exclusions": [], "countries": []}  # fmt: skip
    ctx, ids = run_discover(handler, tmp_path, config)
    assert len(ids) == 2
    assert len(ctx.failures) == 1 and ctx.failures[0]["stage"] == "search"
    assert (
        ctx.stop_reasons["motorcycle"] == "failed" and ctx.stop_reasons["scooter"] == "no_next_link"
    )


def test_checkpoint_skips_finished_units(tmp_path: Path) -> None:
    handler = fake_api({"motorcycle": rows(5), "scooter": rows(5, prefix="SC")})
    config = {"groups": [{"id": "motorbikes", "label": "m", "terms": ["motorcycle", "scooter"], "requireContext": []}],
              "exclusions": [], "countries": []}  # fmt: skip
    checkpoint = {
        "units": {"*|motorcycle": {"pagesDone": 1, "finished": True, "stop": "short_page"}}
    }
    ctx, ids = run_discover(handler, tmp_path, config, checkpoint=checkpoint)
    assert all(i.startswith("SC") for i in ids)
    assert [q["qterm"][0] for q in handler.queries] == ["scooter"]
    assert ctx.keywords_searched == ["motorcycle", "scooter"]


# ----------------------------------------------------------------------- access check


def test_access_check_statuses(tmp_path: Path) -> None:
    ok, _, _ = make_client(fake_api({"": rows(1)}), tmp_path)
    assert WorldBankAdapter().access_check(ok).status == ACCESS_OK
    down, _, _ = make_client(lambda u, h: resp("x", 404), tmp_path / "d")
    assert WorldBankAdapter().access_check(down).status == ACCESS_UNREACHABLE
    blocked, _, _ = make_client(
        lambda u, h: resp("<title>Just a moment...</title>", 403, {"cf-mitigated": "challenge"}),
        tmp_path / "b",
    )
    assert WorldBankAdapter().access_check(blocked).status == ACCESS_BLOCKED


def test_adapter_uses_api_policy_and_states_limitations() -> None:
    adapter = WorldBankAdapter()
    assert adapter.access_policy.kind == "api" and adapter.access_policy.min_delay >= 1.0
    text = " ".join(adapter.coverage_limitations).lower()
    assert "not all zambian" in text and "keyword" in text


def test_client_type_is_polite_client(tmp_path: Path) -> None:
    client, _, _ = make_client(fake_api(), tmp_path)
    assert isinstance(client, PoliteClient)
