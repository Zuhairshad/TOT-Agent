"""LIVE smoke test against the real World Bank API (deselect with -m 'not live')."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator, FormatChecker

from tender_sources.adapters.base import Limits
from tender_sources.adapters.worldbank import WorldBankAdapter
from tender_sources.cache import DiskCache
from tender_sources.http import PoliteClient
from tender_sources.scan import ScanEngine, ScanOptions
from tender_sources.sink import LocalSink

SCHEMAS = Path(__file__).resolve().parents[2] / "shared" / "schema"


@pytest.mark.live
def test_worldbank_zambia_dry_run_scan(tmp_path: Path) -> None:
    config = {
        "groups": [
            {
                "id": "ppe",
                "label": "PPE",
                "terms": ["personal protective equipment"],
                "requireContext": [],
            }
        ],
        "exclusions": ["insurance", "software"],
        "countries": ["Zambia"],
    }
    record_v = Draft7Validator(
        json.loads((SCHEMAS / "tender-record.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    report_v = Draft7Validator(
        json.loads((SCHEMAS / "scan-report.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    with PoliteClient(cache=DiskCache(tmp_path / "cache")) as client:
        sink = LocalSink(tmp_path / "out", config=config)
        options = ScanOptions(
            limits=Limits(max_pages=2, max_requests=10, rows_per_page=20),
            state_dir=tmp_path / "state",
        )
        outcome = ScanEngine(WorldBankAdapter(), client, sink, options).run()
    report = outcome.report
    assert report["status"] in ("succeeded", "partial") and report["accessStatus"] == "ok"
    assert report["pagesChecked"] <= 2 and report["recordsFound"] >= 1
    assert [e.message for e in report_v.iter_errors(report)] == []
    records = [
        json.loads(line) for line in (tmp_path / "out" / "records.jsonl").read_text().splitlines()
    ]
    assert len(records) == report["recordsFound"]
    for record in records:
        assert [e.message for e in record_v.iter_errors(record)] == []
        assert record["country"]["value"] == "Zambia"
    print(
        f"\nLIVE: pages={report['pagesChecked']} records={len(records)} failures={len(report['failures'])}"
    )
    for record in records[:5]:
        print(
            f"  {record['sourceRecordId']} | {record['publishedAt']['value']} | {record['noticeType']} | {record['title'][:70]}"
        )
