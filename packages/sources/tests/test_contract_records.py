"""Contract: everything the sources package emits validates against the shared JSON Schemas."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft7Validator, FormatChecker
from test_adapter_worldbank import NOW, ifb_row, load, raw_for
from test_http_support import fake_api, make_client, rows

from tender_sources.adapters.worldbank import WorldBankAdapter
from tender_sources.scan import ScanEngine, ScanOptions
from tender_sources.sink import LocalSink, load_default_config

SCHEMAS = Path(__file__).resolve().parents[2] / "shared" / "schema"


def validator(name: str) -> Draft7Validator:
    return Draft7Validator(
        json.loads((SCHEMAS / f"{name}.schema.json").read_text()), format_checker=FormatChecker()
    )


RECORD, REPORT, INGEST = (
    validator("tender-record"),
    validator("scan-report"),
    validator("ingest-v2"),
)


def assert_datetimes_parse(node: Any, key: str = "") -> None:
    """jsonschema's 'date-time' format is not enforced without extra packages: check it here."""
    if isinstance(node, dict):
        for k, v in node.items():
            assert_datetimes_parse(v, k)
    elif isinstance(node, list):
        for v in node:
            assert_datetimes_parse(v, key)
    elif isinstance(node, str) and (key.endswith("At") or key in ("value", "finishedAt")):
        if key == "value" and not node[:4].isdigit():
            return
        datetime.fromisoformat(node)  # raises ValueError when malformed


def test_every_fixture_derived_record_validates() -> None:
    config = load_default_config()
    adapter = WorldBankAdapter()
    produced = [
        adapter.to_record(raw_for(r), config, NOW)
        for r in load("motorcycle_page.json")["procnotices"]
    ]
    produced.append(adapter.to_record(raw_for(ifb_row()), config, NOW))
    produced.append(adapter.to_record(raw_for(ifb_row(notice_text="")), config, NOW))
    produced.append(
        adapter.to_record(
            raw_for({"id": "OP1", "notice_type": None, "bid_description": ""}), config, NOW
        )
    )
    assert len(produced) == 5
    for record in produced:
        assert [e.message for e in RECORD.iter_errors(record)] == []
        assert_datetimes_parse(record)
        assert record["relevance"]["explanation"]


def test_scan_output_validates_as_ingest_body(tmp_path: Path) -> None:
    client, _, _ = make_client(fake_api({"motorcycle": rows(7)}), tmp_path)
    sink = LocalSink(
        tmp_path / "out",
        config={
            "groups": load_default_config()["groups"],
            "exclusions": [],
            "countries": ["Zambia"],
        },
    )
    outcome = ScanEngine(
        WorldBankAdapter(),
        client,
        sink,
        ScanOptions(state_dir=tmp_path / "s"),
        now_fn=lambda: datetime(2026, 10, 31, tzinfo=UTC),
    ).run()
    records = [json.loads(x) for x in (tmp_path / "out" / "records.jsonl").read_text().splitlines()]
    assert len(records) == 7
    body = {"report": outcome.report, "records": records}
    assert [e.message for e in INGEST.iter_errors(body)] == []
    assert [e.message for e in REPORT.iter_errors(outcome.report)] == []
    assert_datetimes_parse(outcome.report)
    for record in records:
        assert_datetimes_parse(record)


def test_validator_is_not_vacuous() -> None:
    record = WorldBankAdapter().to_record(
        raw_for(load("motorcycle_page.json")["procnotices"][0]), load_default_config(), NOW
    )
    broken = copy.deepcopy(record)
    del broken["contentHash"]
    assert not RECORD.is_valid(broken)
    broken = copy.deepcopy(record)
    broken["awardValue"]["amount"] = -5
    assert not RECORD.is_valid(broken)
    broken = copy.deepcopy(record)
    broken["status"] = "awarded"
    assert not RECORD.is_valid(broken)
    with pytest.raises(
        ValueError
    ):  # the installed jsonschema has no date-time checker; we parse ourselves
        assert_datetimes_parse({"firstSeenAt": "yesterday"})


@pytest.mark.parametrize("field", ["estimatedValue", "awardValue", "tenderFee", "bidSecurity"])
def test_money_fields_are_never_zero_by_default(field: str) -> None:
    record = WorldBankAdapter().to_record(raw_for(ifb_row()), load_default_config(), NOW)
    fact: Any = record.get(field)
    if fact is not None:
        assert fact["amount"] != 0
