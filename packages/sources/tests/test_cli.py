"""CLI: argument handling, exit codes, dry-run output, triggered-by plumbing."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, ClassVar

import pytest
from test_http_support import fake_api, make_client, resp, rows

from tender_sources.cli import build_parser, main
from tender_sources.sink import LocalSink, ScanLocked, StartResult

PKG = Path(__file__).resolve().parents[1]


def run(tmp_path: Path, argv: list[str], handler: Any, sink: Any = None) -> int:
    client, _, _ = make_client(handler, tmp_path)
    full = [*argv, "--state-dir", str(tmp_path / "state")] if argv[0] == "scan" else argv
    return main(full, client=client, sink=sink)


def test_dry_run_scan_writes_files_and_exits_0(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "out"
    code = run(
        tmp_path,
        [
            "scan",
            "--source",
            "worldbank",
            "--dry-run",
            "--out",
            str(out),
            "--country",
            "Zambia",
            "--max-pages",
            "2",
            "--rows",
            "10",
        ],
        fake_api({"motorcycle": rows(12), "PPE": rows(2, prefix="PP")}),
    )
    assert code == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert (
        summary["status"] == "succeeded"
        and summary["source"] == "worldbank"
        and summary["recordsFound"] >= 12
    )
    assert (out / "records.jsonl").exists() and (out / "report.json").exists()


def test_triggered_by_default_and_value_reach_start_scan(tmp_path: Path) -> None:
    class Capture(LocalSink):
        params: ClassVar[dict[str, Any]] = {}

        def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult:
            Capture.params = dict(params)
            return super().start_scan(source, scan_id, params)

    api = fake_api({"motorcycle": rows(1)})
    assert run(tmp_path, ["scan", "--source", "worldbank"], api, Capture(tmp_path / "o1")) == 0
    assert Capture.params["triggeredBy"] == "manual"
    assert (
        run(
            tmp_path,
            ["scan", "--source", "worldbank", "--triggered-by", "github-actions"],
            api,
            Capture(tmp_path / "o2"),
        )
        == 0
    )
    assert Capture.params["triggeredBy"] == "github-actions"


def test_worker_body_contains_triggered_by(tmp_path: Path) -> None:
    from test_sink import FakeHttp

    from tender_sources.sink import WorkerSink

    http = FakeHttp((200, {"config": {"groups": [], "countries": []}, "since": None}))
    worker = WorkerSink("https://w.example", "tok", http=http, sleep=lambda s: None)
    code = run(
        tmp_path,
        ["scan", "--source", "worldbank", "--triggered-by", "schedule"],
        fake_api(),
        worker,
    )
    assert code == 0
    assert (
        http.calls[0][1]["triggeredBy"] == "schedule"
        and http.calls[0][1]["params"]["triggeredBy"] == "schedule"
    )


def test_unknown_source_is_exit_1(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(tmp_path, ["scan", "--source", "nope", "--dry-run"], fake_api()) == 1
    assert "unknown source" in capsys.readouterr().err


def test_without_worker_env_or_dry_run_is_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for var in ("INGEST_URL", "WORKER_URL", "INGEST_SECRET"):
        monkeypatch.delenv(var, raising=False)
    assert run(tmp_path, ["scan", "--source", "worldbank"], fake_api()) == 1
    assert "INGEST_URL" in capsys.readouterr().err


def test_bad_keywords_file_is_exit_1(tmp_path: Path) -> None:
    bad = tmp_path / "kw.json"
    bad.write_text("[1,2]")
    assert (
        run(
            tmp_path,
            ["scan", "--source", "worldbank", "--dry-run", "--keywords-file", str(bad)],
            fake_api(),
        )
        == 1
    )
    assert (
        run(
            tmp_path,
            [
                "scan",
                "--source",
                "worldbank",
                "--dry-run",
                "--keywords-file",
                str(tmp_path / "missing.json"),
            ],
            fake_api(),
        )
        == 1
    )


def test_keywords_file_replaces_config(tmp_path: Path) -> None:
    kw = tmp_path / "kw.json"
    kw.write_text(
        json.dumps(
            {
                "groups": [
                    {"id": "ppe", "label": "p", "terms": ["gumboots"], "requireContext": []}
                ],
                "exclusions": [],
                "countries": [],
            }
        )
    )
    api = fake_api({"gumboots": rows(1)})
    assert (
        run(
            tmp_path,
            [
                "scan",
                "--source",
                "worldbank",
                "--dry-run",
                "--out",
                str(tmp_path / "o"),
                "--keywords-file",
                str(kw),
            ],
            api,
        )
        == 0
    )
    assert [q["qterm"][0] for q in api.queries if "qterm" in q] == ["gumboots"]


def test_worker_lock_conflict_is_exit_1(tmp_path: Path) -> None:
    class Locked(LocalSink):
        def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult:
            raise ScanLocked("scan-x")

    assert run(tmp_path, ["scan", "--source", "worldbank"], fake_api(), Locked(tmp_path / "o")) == 1


def test_sources_command_lists_adapters(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    client, _, _ = make_client(
        lambda u, h: (
            resp("<html/>", 200) if "tendersontime" in u else fake_api({"": rows(1)})(u, {})
        ),
        tmp_path,
    )
    assert main(["sources"], client=client) == 0
    out = capsys.readouterr().out
    assert (
        "worldbank" in out
        and "access=ok" in out
        and "tendersontime" in out
        and "access=unconfigured" in out
    )
    assert main(["sources", "--no-check"], client=client) == 0


def test_parser_defaults() -> None:
    args = build_parser().parse_args(["scan", "--source", "worldbank"])
    assert (
        args.triggered_by == "manual"
        and args.max_pages == 5
        and not args.resume
        and not args.dry_run
    )


def test_python_dash_m_entry_point() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "tender_sources", "--help"],
        cwd=PKG,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0 and "scan" in proc.stdout and "sources" in proc.stdout
    bad = subprocess.run(
        [sys.executable, "-m", "tender_sources"],
        cwd=PKG,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert bad.returncode != 0
