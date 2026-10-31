"""TendersOnTime: guarded adapter. A real (trimmed) Cloudflare challenge must end the scan as blocked."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from test_http_support import make_client, resp

from tender_sources.adapters import tendersontime
from tender_sources.adapters.base import (
    ACCESS_BLOCKED,
    ACCESS_UNCONFIGURED,
    ACCESS_UNREACHABLE,
    AdapterNotReady,
    DiscoverContext,
    ListingRef,
)
from tender_sources.adapters.tendersontime import (
    LOGIN_LIMITATION,
    TendersOnTimeAdapter,
    credentials_from_env,
)
from tender_sources.cli import main
from tender_sources.http import RawResponse
from tender_sources.registry import adapter_ids, get_adapter
from tender_sources.scan import EXIT_BLOCKED, ScanEngine, ScanOptions
from tender_sources.sink import LocalSink

FIXTURE = Path(__file__).parent / "fixtures" / "tendersontime" / "challenge_response.json"


def challenge() -> RawResponse:
    data = json.loads(FIXTURE.read_text("utf-8"))
    assert data["_fixture"].startswith(
        "FIXTURE: captured 2026-10-31 real Cloudflare challenge response"
    )
    return RawResponse(status=data["status"], headers=data["headers"], body=data["body"].encode())


def test_fixture_is_the_real_challenge_shape() -> None:
    r = challenge()
    assert r.status == 403 and r.headers["cf-mitigated"] == "challenge"
    assert b"Just a moment..." in r.body
    assert "password" not in r.body.decode().lower() and "TOT_" not in r.body.decode()


def test_access_check_reports_blocked_after_exactly_one_request(tmp_path: Path) -> None:
    client, transport, sleeps = make_client(lambda u, h: challenge(), tmp_path, respect_robots=True)
    result = TendersOnTimeAdapter().access_check(client)
    assert result.status == ACCESS_BLOCKED and "challenge" in result.detail
    assert len(transport.calls) == 1 and sleeps == []  # no retry loop, no waiting


def test_access_check_home_page_blocked_without_robots(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: challenge(), tmp_path, respect_robots=False)
    assert TendersOnTimeAdapter().access_check(client).status == ACCESS_BLOCKED
    assert [c[0] for c in transport.calls] == ["https://www.tendersontime.com/"]


def test_unconfigured_while_site_notes_are_missing(tmp_path: Path) -> None:
    assert tendersontime.SITE_CONFIGURED is False
    client, _, _ = make_client(lambda u, h: resp("<html>hello</html>"), tmp_path)
    assert TendersOnTimeAdapter().access_check(client).status == ACCESS_UNCONFIGURED


def test_unreachable(tmp_path: Path) -> None:
    client, _, _ = make_client(lambda u, h: resp("nope", 404), tmp_path)
    assert TendersOnTimeAdapter().access_check(client).status == ACCESS_UNREACHABLE


def test_extraction_is_not_ready_and_never_guesses(tmp_path: Path) -> None:
    adapter = TendersOnTimeAdapter()
    client, transport, _ = make_client(lambda u, h: resp("x"), tmp_path)
    ctx = DiscoverContext(client=client, config={})
    ref = ListingRef(id="1", url="https://www.tendersontime.com/x")
    with pytest.raises(AdapterNotReady):
        next(iter(adapter.discover(ctx)))
    with pytest.raises(AdapterNotReady):
        adapter.fetch_detail(ctx, ref)
    with pytest.raises(AdapterNotReady):
        adapter.to_record(None, {}, None)  # type: ignore[arg-type]
    with pytest.raises(AdapterNotReady):
        adapter.build_search_url("motorcycle", 1)
    with pytest.raises(AdapterNotReady):
        adapter.parse_listing(None)
    assert transport.calls == []


def test_scan_ends_blocked_with_exit_2_and_limitation_text(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: challenge(), tmp_path, respect_robots=True)
    sink = LocalSink(tmp_path / "out")
    engine = ScanEngine(
        TendersOnTimeAdapter(), client, sink, ScanOptions(state_dir=tmp_path / "state")
    )
    outcome = engine.run()
    report = outcome.report
    assert outcome.exit_code == EXIT_BLOCKED == 2
    assert report["status"] == "blocked" and report["accessStatus"] == "blocked_by_challenge"
    assert report["pagesChecked"] == 0 and report["recordsFound"] == 0
    text = " ".join(report["coverageLimitations"]).lower()
    assert (
        "cloudflare challenge" in text
        and "not scanned" in text
        and "blocked automated access" in text
    )
    assert len(transport.calls) == 1  # NO retry loop
    assert not (tmp_path / "out" / "records.jsonl").exists()
    assert json.loads((tmp_path / "out" / "report.json").read_text())["status"] == "blocked"
    assert not (tmp_path / "state" / "tendersontime.lock").exists()


def test_cli_exit_code_is_2_when_blocked(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: challenge(), tmp_path, respect_robots=True)
    code = main(
        [
            "scan",
            "--source",
            "tendersontime",
            "--dry-run",
            "--out",
            str(tmp_path / "o"),
            "--state-dir",
            str(tmp_path / "s"),
        ],
        client=client,
    )
    assert code == 2 and len(transport.calls) == 1


def test_login_wall_marks_facts_could_not_verify() -> None:
    record: dict[str, Any] = {
        "deadline": {"value": None, "status": "not_published"},
        "estimatedValue": {"amount": None, "status": "not_published"},
        "awardValue": {"amount": 5.0, "status": "published"},
        "accessLimitations": [],
    }
    out = TendersOnTimeAdapter.mark_login_required(record)
    assert LOGIN_LIMITATION in out["accessLimitations"]
    assert (
        out["deadline"]["status"] == "could_not_verify"
        and out["estimatedValue"]["status"] == "could_not_verify"
    )
    assert out["awardValue"]["status"] == "published"  # a published fact stays published
    assert (
        TendersOnTimeAdapter.mark_login_required(out)["accessLimitations"].count(LOGIN_LIMITATION)
        == 1
    )


def test_credentials_only_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TOT_EMAIL", raising=False)
    monkeypatch.delenv("TOT_PASSWORD", raising=False)
    assert credentials_from_env() is None  # the framework never needs them
    monkeypatch.setenv("TOT_EMAIL", "demo@example.test")
    assert credentials_from_env() is None  # both are required
    monkeypatch.setenv("TOT_PASSWORD", "pw")
    assert credentials_from_env() == ("demo@example.test", "pw")
    source = Path(tendersontime.__file__).read_text()
    assert "@" not in source.replace("@staticmethod", "")  # no hard-coded e-mail


def test_registry_lists_both_adapters() -> None:
    assert adapter_ids() == ["tendersontime", "worldbank"]
    assert get_adapter("tendersontime").id == "tendersontime"
