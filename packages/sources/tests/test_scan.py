"""Scan engine: end to end with the World Bank adapter over a FIXTURE API, resume, locks, exit codes."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft7Validator, FormatChecker
from test_http_support import fake_api, make_client, resp, rows

from tender_sources.adapters.base import DiscoverContext, DocLink, Limits, ListingRef, RawNotice
from tender_sources.adapters.worldbank import WorldBankAdapter
from tender_sources.http import PoliteClient, RawResponse
from tender_sources.scan import (
    EXIT_BLOCKED,
    EXIT_ERROR,
    EXIT_OK,
    FileLock,
    LocalScanLocked,
    ScanEngine,
    ScanOptions,
)
from tender_sources.sink import LocalSink, ScanLocked, SinkError, StartResult

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
import pdf_builders

SCHEMAS = Path(__file__).resolve().parents[2] / "shared" / "schema"
REPORT_V = Draft7Validator(
    json.loads((SCHEMAS / "scan-report.schema.json").read_text()), format_checker=FormatChecker()
)
RECORD_V = Draft7Validator(
    json.loads((SCHEMAS / "tender-record.schema.json").read_text()), format_checker=FormatChecker()
)
CONFIG: dict[str, Any] = {
    "groups": [
        {"id": "motorbikes", "label": "Motorbikes", "terms": ["motorcycle"], "requireContext": []}
    ],
    "exclusions": [],
    "countries": ["Zambia"],
}


class Killed(BaseException):
    """Simulates the process being killed (not an Exception, so nothing may swallow it)."""


class RecordingSink(LocalSink):
    def __init__(
        self, directory: Path, *, die_on_call: int | None = None, fail_calls: tuple[int, ...] = ()
    ) -> None:
        super().__init__(directory, config=CONFIG)
        self.calls = 0
        self.die_on_call = die_on_call
        self.fail_calls = fail_calls
        self.reports: list[dict[str, Any]] = []

    def post_batch(self, report: dict[str, Any], records: list[dict[str, Any]]) -> None:
        self.calls += 1
        if self.die_on_call == self.calls:
            raise Killed
        if self.calls in self.fail_calls:
            raise SinkError("worker down", retryable=True)
        self.reports.append(json.loads(json.dumps(report)))
        super().post_batch(report, records)

    def posted_ids(self) -> list[str]:
        path = self.directory / "records.jsonl"
        if not path.exists():
            return []
        return [json.loads(line)["sourceRecordId"] for line in path.read_text().splitlines()]


def build(
    tmp_path: Path,
    handler: Callable[[str, Mapping[str, str]], RawResponse | Exception],
    sink: LocalSink | None = None,
    *,
    adapter: WorldBankAdapter | None = None,
    **opts: Any,
) -> tuple[ScanEngine, RecordingSink, Any]:
    client, transport, _ = make_client(handler, tmp_path)
    sink = sink or RecordingSink(tmp_path / "out")
    options = ScanOptions(
        limits=opts.pop("limits", Limits(max_pages=5, max_requests=100, rows_per_page=10)),
        state_dir=tmp_path / "state",
        **opts,
    )
    return (
        ScanEngine(
            adapter or WorldBankAdapter(),
            client,
            sink,
            options,
            now_fn=lambda: datetime(2026, 10, 31, 12, tzinfo=UTC),
        ),
        sink,
        transport,
    )  # type: ignore[return-value]


def offsets(api: Any) -> list[str]:
    return [q["os"][0] for q in api.queries if "qterm" in q]


def check_contract(sink: LocalSink) -> None:
    report = json.loads((sink.directory / "report.json").read_text())
    assert [e.message for e in REPORT_V.iter_errors(report)] == []
    path = sink.directory / "records.jsonl"
    for line in path.read_text().splitlines() if path.exists() else []:
        assert [e.message for e in RECORD_V.iter_errors(json.loads(line))] == []


# ----------------------------------------------------------------------- happy path


def test_end_to_end_scan_succeeds_and_validates(tmp_path: Path) -> None:
    pool = rows(14) + [
        {
            "id": "OPx1",
            "notice_type": "Contract Award",
            "noticedate": "01-Oct-2026",
            "bid_description": "Road rehabilitation works",
        }
    ]
    engine, sink, _ = build(tmp_path, fake_api({"motorcycle": pool}))
    outcome = engine.run()
    assert outcome.exit_code == EXIT_OK and outcome.report["status"] == "succeeded"
    report = outcome.report
    assert report["accessStatus"] == "ok" and report["pagesChecked"] == 2
    assert report["recordsFound"] == 14 and len(sink.posted_ids()) == 14
    assert report["keywordsSearched"] == ["motorcycle (Zambia)"]
    assert report["finishedAt"] and report["failures"] == []
    text = " ".join(report["coverageLimitations"])
    assert "not all Zambian" in text and "1 notice(s)" in text and "Paging stopped" in text
    assert report["checkpoint"]["adapter"]["units"]["Zambia|motorcycle"]["finished"] is True
    check_contract(sink)
    assert not (
        tmp_path / "state" / "worldbank.json"
    ).exists()  # completed scans leave no resume state


def test_progress_reports_carry_the_checkpoint(tmp_path: Path) -> None:
    engine, sink, _ = build(tmp_path, fake_api({"motorcycle": rows(25)}))
    engine.run()
    running = [r for r in sink.reports if r["status"] == "running"]
    assert len(running) >= 3
    pages = [r["checkpoint"]["adapter"]["units"]["Zambia|motorcycle"]["pagesDone"] for r in running]
    assert pages == sorted(pages) and pages[0] == 1
    assert all(REPORT_V.is_valid(r) for r in sink.reports)
    assert sink.reports[-1]["status"] == "succeeded"


def test_rerun_posts_the_same_ids_and_hashes(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(12)})
    e1, s1, _ = build(tmp_path / "a", api)
    e2, s2, _ = build(tmp_path / "b", api)
    e1.run()
    e2.run()
    assert s1.posted_ids() == s2.posted_ids()
    h1 = [
        json.loads(x)["contentHash"]
        for x in (s1.directory / "records.jsonl").read_text().splitlines()
    ]
    h2 = [
        json.loads(x)["contentHash"]
        for x in (s2.directory / "records.jsonl").read_text().splitlines()
    ]
    assert h1 == h2


def test_params_and_triggered_by_are_recorded(tmp_path: Path) -> None:
    engine, _, _ = build(
        tmp_path, fake_api({"motorcycle": rows(3)}), triggered_by="schedule", since="2026-01-01"
    )
    report = engine.run().report
    assert (
        report["params"]["triggeredBy"] == "schedule" and report["params"]["since"] == "2026-01-01"
    )


def test_config_override_and_country(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(3)})
    engine, _, _ = build(tmp_path, api, country=["Kenya"])
    engine.run()
    assert {q["project_ctry_name_exact"][0] for q in api.queries if "qterm" in q} == {"Kenya"}


# ----------------------------------------------------------------------- resume


def test_kill_mid_scan_then_resume_without_refetch_or_duplicates(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(25)})
    engine, sink, _transport = build(tmp_path, api, RecordingSink(tmp_path / "out", die_on_call=2))
    with pytest.raises(Killed):
        engine.run()
    assert not (tmp_path / "state" / "worldbank.lock").exists()  # lock released even when killed
    first_offsets = offsets(api)
    assert first_offsets == ["0", "10"]  # died while posting page 2
    state = json.loads((tmp_path / "state" / "worldbank.json").read_text())
    assert state["checkpoint"]["units"]["Zambia|motorcycle"]["pagesDone"] == 1
    assert len(state["processedIds"]) == 10
    assert sink.posted_ids().__len__() == 10

    api.queries.clear()
    engine2, sink2, _ = build(tmp_path, api, RecordingSink(tmp_path / "out"), resume=True)
    outcome = engine2.run()
    assert offsets(api) == ["10", "20"]  # page 1 was NOT fetched again
    ids = sink2.posted_ids()
    assert len(ids) == len(set(ids)) == 25
    assert outcome.report["status"] == "succeeded" and outcome.report["recordsFound"] == 25
    assert outcome.report["scanId"] == json.loads(json.dumps(state["scanId"]))
    assert outcome.report["pagesChecked"] == 3


def test_without_resume_flag_state_is_ignored(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(25)})
    engine, _, _ = build(tmp_path, api, RecordingSink(tmp_path / "out", die_on_call=2))
    with pytest.raises(Killed):
        engine.run()
    api.queries.clear()
    engine2, _, _ = build(tmp_path, api, RecordingSink(tmp_path / "out2"))
    engine2.run()
    assert offsets(api) == ["0", "10", "20"]


# ----------------------------------------------------------------------- locks


def test_local_lock_blocks_overlap(tmp_path: Path) -> None:
    api = fake_api({"motorcycle": rows(3)})
    engine, _sink, _ = build(tmp_path, api)
    holder = FileLock(tmp_path / "state" / "worldbank.lock")
    holder.acquire()
    outcome = engine.run()
    assert outcome.exit_code == EXIT_ERROR and outcome.report["status"] == "failed"
    assert "another scan holds" in outcome.report["failures"][0]["error"]
    assert offsets(api) == []
    holder.release()
    assert build(tmp_path, api)[0].run().exit_code == EXIT_OK


def test_stale_lock_is_taken_over_and_released(tmp_path: Path) -> None:
    lock_path = tmp_path / "state" / "worldbank.lock"
    FileLock(lock_path).acquire()
    real = lock_path.stat().st_mtime
    fresh = FileLock(lock_path, now_fn=lambda: real + 44 * 60)
    with pytest.raises(LocalScanLocked):
        fresh.acquire()
    stale = FileLock(lock_path, now_fn=lambda: real + 46 * 60)
    stale.acquire()
    assert stale.held
    stale.release()
    assert not lock_path.exists()


def test_worker_lock_409_is_reported(tmp_path: Path) -> None:
    class LockedSink(RecordingSink):
        def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult:
            raise ScanLocked("scan-other-1")

    api = fake_api({"motorcycle": rows(3)})
    engine, _sink, _ = build(tmp_path, api, LockedSink(tmp_path / "out"))
    outcome = engine.run()
    assert outcome.exit_code == EXIT_ERROR and outcome.report["status"] == "failed"
    assert "scan-other-1" in outcome.report["failures"][0]["error"]
    assert offsets(api) == []
    assert (tmp_path / "state" / "worldbank.last-report.json").exists()


# ----------------------------------------------------------------------- failures never lose the report


def test_blocked_mid_scan_stops_without_retry(tmp_path: Path) -> None:
    good = fake_api({"motorcycle": rows(25)})
    state = {"n": 0}

    def handler(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        state["n"] += 1
        if state["n"] >= 3:  # access check + page 1 fine, page 2 challenged
            return resp("<title>Just a moment...</title>", 403, {"cf-mitigated": "challenge"})
        return good(url, headers)

    engine, sink, transport = build(tmp_path, handler)
    outcome = engine.run()
    assert outcome.exit_code == EXIT_BLOCKED and outcome.report["status"] == "blocked"
    assert outcome.report["accessStatus"] == "blocked_by_challenge"
    assert len(transport.calls) == 3  # no retry loop
    assert len(sink.posted_ids()) == 10  # what was read before the block is kept
    check_contract(sink)


def test_unexpected_adapter_exception_still_produces_a_report(tmp_path: Path) -> None:
    class Exploding(WorldBankAdapter):
        def discover(self, ctx: DiscoverContext) -> Iterator[ListingRef]:
            raise RuntimeError("boom")
            yield  # pragma: no cover

    engine, sink, _ = build(tmp_path, fake_api({"motorcycle": rows(3)}), adapter=Exploding())
    outcome = engine.run()
    assert outcome.report["status"] == "failed" and outcome.exit_code == EXIT_ERROR
    assert "boom" in outcome.report["failures"][0]["error"]
    check_contract(sink)


def test_detail_and_parse_failures_are_recorded_and_scan_continues(tmp_path: Path) -> None:
    class Picky(WorldBankAdapter):
        def fetch_detail(self, ctx: DiscoverContext, ref: ListingRef) -> RawNotice:
            if ref.id.endswith("1"):
                raise ValueError("detail failed")
            return super().fetch_detail(ctx, ref)

        def to_record(
            self, raw: RawNotice, config: dict[str, Any], now: datetime
        ) -> dict[str, Any]:
            if raw.ref.id.endswith("2"):
                raise KeyError("parse failed")
            return super().to_record(raw, config, now)

    engine, sink, _ = build(tmp_path, fake_api({"motorcycle": rows(5)}), adapter=Picky())
    report = engine.run().report
    assert report["status"] == "partial"
    assert {f["stage"] for f in report["failures"]} == {"detail", "parse"}
    assert len(sink.posted_ids()) == 3 and report["recordsFound"] == 3


def test_sink_failure_keeps_records_and_retries_on_next_flush(tmp_path: Path) -> None:
    sink = RecordingSink(tmp_path / "out", fail_calls=(1,))
    engine, _, _ = build(tmp_path, fake_api({"motorcycle": rows(25)}), sink)
    report = engine.run().report
    assert report["status"] == "partial"
    assert any(f["stage"] == "ingest" and f["retryable"] for f in report["failures"])
    ids = sink.posted_ids()
    assert len(ids) == len(set(ids)) == 25  # nothing lost, nothing duplicated


def test_request_cap_makes_the_scan_partial(tmp_path: Path) -> None:
    engine, _, _ = build(
        tmp_path,
        fake_api({"motorcycle": rows(100)}),
        limits=Limits(max_pages=9, max_requests=3, rows_per_page=10),
    )
    report = engine.run().report
    assert report["status"] == "partial" and report["pagesChecked"] == 2
    assert "request_cap" in " ".join(report["coverageLimitations"])


def test_search_failure_everywhere_is_failed(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        calls["n"] += 1
        return resp("{}") if calls["n"] == 1 else resp("oops", 404)

    engine, _, _ = build(tmp_path, handler)
    outcome = engine.run()
    assert outcome.report["status"] == "failed" and outcome.exit_code == EXIT_ERROR


def test_unreachable_source_fails_without_scanning(tmp_path: Path) -> None:
    engine, sink, _ = build(tmp_path, lambda u, h: resp("down", 404))
    outcome = engine.run()
    assert outcome.report["accessStatus"] == "unreachable" and outcome.exit_code == EXIT_ERROR
    assert outcome.report["pagesChecked"] == 0
    check_contract(sink)


# ----------------------------------------------------------------------- documents


class DocAdapter(WorldBankAdapter):
    def __init__(self, urls: list[str]) -> None:
        self.urls = urls

    def document_links(self, raw: RawNotice) -> list[DocLink]:
        return [DocLink(u, "Bidding document") for u in self.urls]


def doc_handler(
    api: Any, docs: Mapping[str, RawResponse]
) -> Callable[[str, Mapping[str, str]], RawResponse | Exception]:
    def handler(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        return docs[url] if url in docs else api(url, headers)

    return handler


def test_documents_are_fetched_extracted_and_attached(tmp_path: Path) -> None:
    pdf = pdf_builders.tender_pdf()
    docs = {"https://example.test/bid.pdf": resp(pdf, headers={"content-type": "application/pdf"})}
    adapter = DocAdapter(["https://example.test/bid.pdf"])
    engine, sink, _ = build(
        tmp_path, doc_handler(fake_api({"motorcycle": rows(2)}), docs), adapter=adapter
    )
    report = engine.run().report
    assert report["documentsFetched"] == 2 and report["status"] == "succeeded"
    record = json.loads((sink.directory / "records.jsonl").read_text().splitlines()[0])
    doc = record["documents"][0]
    assert doc["status"] == "retrieved" and doc["mimeType"] == "application/pdf"
    assert len(doc["sha256"]) == 64 and doc["pageCount"] >= 1 and doc["textExtracted"] is True
    assert RECORD_V.is_valid(record)


def test_unsafe_oversize_and_wrong_type_documents_are_skipped(tmp_path: Path) -> None:
    docs = {
        "https://example.test/huge.pdf": resp(
            b"%PDF-1", headers={"content-type": "application/pdf", "content-length": str(10**9)}
        ),
        "https://example.test/page.html": resp("<html/>"),
    }
    urls = [
        "http://127.0.0.1/secret.pdf",
        "https://example.test/huge.pdf",
        "https://example.test/page.html",
        "http://169.254.169.254/x.pdf",
    ]
    engine, sink, transport = build(
        tmp_path, doc_handler(fake_api({"motorcycle": rows(1)}), docs), adapter=DocAdapter(urls)
    )
    report = engine.run().report
    record = json.loads((sink.directory / "records.jsonl").read_text().splitlines()[0])
    statuses = [d["status"] for d in record["documents"]]
    assert statuses == ["skipped_unsafe", "too_large", "failed"]  # max 3 documents per notice
    assert report["documentsFetched"] == 0 and report["status"] == "succeeded"
    assert not any("127.0.0.1" in c[0] or "169.254" in c[0] for c in transport.calls)
    assert RECORD_V.is_valid(record)


def test_documents_can_be_disabled(tmp_path: Path) -> None:
    adapter = DocAdapter(["https://example.test/bid.pdf"])
    engine, _, transport = build(
        tmp_path, fake_api({"motorcycle": rows(1)}), adapter=adapter, fetch_documents=False
    )
    engine.run()
    assert not any(c[0].endswith(".pdf") for c in transport.calls)


def test_polite_client_is_the_engines_only_network_path(tmp_path: Path) -> None:
    engine, _, _ = build(tmp_path, fake_api({"motorcycle": rows(1)}))
    assert isinstance(engine.client, PoliteClient)
