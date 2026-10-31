"""Sinks: Worker client (auth, 409, batching, retries, secrecy) and the local dry-run sink."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from tender_sources.sink import (
    BATCH_SIZE,
    LocalSink,
    ScanLocked,
    SinkError,
    WorkerSink,
    load_default_config,
    normalise_base_url,
)

SECRET = "s3cr3t-token-value"


class FakeHttp:
    def __init__(self, *answers: tuple[int, dict[str, Any]] | Exception) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, dict[str, Any], Mapping[str, str]]] = []

    def __call__(self, url: str, body: bytes, headers: Mapping[str, str]) -> tuple[int, bytes]:
        self.calls.append((url, json.loads(body), headers))
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer[0], json.dumps(answer[1]).encode()


def sink(http: FakeHttp, sleeps: list[float] | None = None) -> WorkerSink:
    return WorkerSink(
        "https://worker.example/",
        SECRET,
        http=http,
        sleep=(sleeps if sleeps is not None else []).append,
    )


def test_start_scan_sends_bearer_and_returns_config() -> None:
    http = FakeHttp((200, {"config": {"groups": []}, "since": "2026-09-01"}))
    out = sink(http).start_scan(
        "worldbank", "scan-abc12345", {"triggeredBy": "schedule", "maxPages": 3}
    )
    assert out.config == {"groups": []} and out.since == "2026-09-01"
    url, body, headers = http.calls[0]
    assert url == "https://worker.example/scans/start"
    assert headers["Authorization"] == f"Bearer {SECRET}"
    assert body["source"] == "worldbank" and body["scanId"] == "scan-abc12345"
    assert body["triggeredBy"] == "schedule" and body["params"]["maxPages"] == 3


def test_start_scan_null_since() -> None:
    assert (
        sink(FakeHttp((200, {"config": {}, "since": None})))
        .start_scan("s", "scan-12345678", {})
        .since
        is None
    )


def test_409_raises_scan_locked_with_running_id() -> None:
    with pytest.raises(ScanLocked) as err:
        sink(FakeHttp((409, {"runningScanId": "scan-other"}))).start_scan("s", "scan-12345678", {})
    assert err.value.running_scan_id == "scan-other"


def test_missing_config_and_4xx_are_errors_not_retried() -> None:
    http = FakeHttp((200, {"nope": 1}))
    with pytest.raises(SinkError, match="no config"):
        sink(http).start_scan("s", "scan-12345678", {})
    http401 = FakeHttp((401, {"error": "unauthorized"}))
    with pytest.raises(SinkError, match="401"):
        sink(http401).start_scan("s", "scan-12345678", {})
    assert len(http401.calls) == 1


def test_post_batch_splits_into_chunks_of_at_most_batch_size() -> None:
    http = FakeHttp((200, {}))
    records = [{"sourceRecordId": str(i)} for i in range(2 * BATCH_SIZE + 10)]
    sink(http).post_batch(
        {"scanId": "scan-12345678", "status": "succeeded", "finishedAt": "x"}, records
    )
    sizes = [len(c[1]["records"]) for c in http.calls]
    assert sizes == [BATCH_SIZE, BATCH_SIZE, 10] and all(
        c[0].endswith("/ingest/v2") for c in http.calls
    )
    assert [c[1]["report"]["status"] for c in http.calls] == ["running", "running", "succeeded"]


def test_post_batch_with_no_records_still_sends_the_report() -> None:
    http = FakeHttp((200, {}))
    sink(http).post_batch({"scanId": "scan-12345678", "status": "failed"}, [])
    assert len(http.calls) == 1 and http.calls[0][1]["records"] == []


def test_5xx_is_retried_with_backoff_then_succeeds() -> None:
    http = FakeHttp((503, {}), (500, {}), (200, {}))
    sleeps: list[float] = []
    sink(http, sleeps).post_batch({"status": "running"}, [])
    assert len(http.calls) == 3 and sleeps == [2.0, 4.0]


def test_network_errors_retry_up_to_three_times_then_raise() -> None:
    http = FakeHttp(SinkError("network error: URLError", retryable=True))
    with pytest.raises(SinkError) as err:
        sink(http).post_batch({"status": "running"}, [])
    assert len(http.calls) == 4 and err.value.retryable


def test_4xx_on_ingest_is_not_retried() -> None:
    http = FakeHttp((400, {"error": "bad body"}))
    with pytest.raises(SinkError, match="400"):
        sink(http).post_batch({"status": "running"}, [{"a": 1}])
    assert len(http.calls) == 1


def test_secret_never_appears_in_repr_or_errors() -> None:
    http = FakeHttp((500, {}))
    s = sink(http)
    assert SECRET not in repr(s) and SECRET not in str(s)
    with pytest.raises(SinkError) as err:
        s.post_batch({"status": "running"}, [])
    assert SECRET not in str(err.value)


def test_env_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INGEST_URL", raising=False)
    monkeypatch.delenv("WORKER_URL", raising=False)
    monkeypatch.delenv("INGEST_SECRET", raising=False)
    assert not WorkerSink().configured
    with pytest.raises(SinkError, match="INGEST_URL"):
        WorkerSink().post_batch({}, [])
    monkeypatch.setenv("WORKER_URL", "https://w.example")
    monkeypatch.setenv("INGEST_SECRET", SECRET)
    assert WorkerSink().configured and WorkerSink().base_url == "https://w.example"


def test_local_sink_writes_jsonl_and_report_and_default_config(tmp_path: Path) -> None:
    sink_ = LocalSink(tmp_path / "out")
    started = sink_.start_scan("worldbank", "scan-12345678", {})
    assert started.config == load_default_config() and started.since is None
    assert [g["id"] for g in started.config["groups"]] == ["motorbikes", "riding_gear", "ppe"]
    sink_.post_batch(
        {"status": "running", "n": 1}, [{"sourceRecordId": "a"}, {"sourceRecordId": "b"}]
    )
    sink_.post_batch({"status": "succeeded", "n": 2}, [{"sourceRecordId": "c"}])
    lines = (tmp_path / "out" / "records.jsonl").read_text().splitlines()
    assert [json.loads(x)["sourceRecordId"] for x in lines] == ["a", "b", "c"]
    assert json.loads((tmp_path / "out" / "report.json").read_text())["status"] == "succeeded"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://w.example.dev", "https://w.example.dev"),
        ("https://w.example.dev/", "https://w.example.dev"),
        ("https://w.example.dev/ingest", "https://w.example.dev"),
        ("https://w.example.dev/ingest/", "https://w.example.dev"),
        ("https://w.example.dev/ingest/v2", "https://w.example.dev"),
        ("  https://w.example.dev/ingest  ", "https://w.example.dev"),
        ("", ""),
    ],
)
def test_ingest_url_may_be_the_base_url_or_the_playwright_scrapers_ingest_url(
    raw: str, expected: str
) -> None:
    assert normalise_base_url(raw) == expected
