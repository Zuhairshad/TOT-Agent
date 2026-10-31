"""Builders and schema validation for synthetic TenderRecord dicts used by tests (all FIXTURE data)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import jsonschema

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "shared" / "schema"
SEARCH_CONFIG = (
    Path(__file__).resolve().parents[3] / "shared" / "config" / "search-config.default.json"
)


def default_config() -> dict[str, Any]:
    return json.loads(SEARCH_CONFIG.read_text())


def _schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())  # type: ignore[no-any-return]


def validate_record(record: dict[str, Any]) -> None:
    jsonschema.validate(record, _schema("tender-record"), format_checker=jsonschema.FormatChecker())


def validate_fragment(definition: str, fragment: dict[str, Any]) -> None:
    """Validate a sub-object (e.g. a MoneyFact) by wrapping it in a record field."""
    rec = make_record()
    rec[definition] = fragment
    validate_record(rec)


def make_record(**over: Any) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "schemaVersion": 2,
        "source": "worldbank",
        "sourceRecordId": "OP00001",
        "canonicalUrl": "https://example.test/notice/OP00001",
        "title": "FIXTURE Supply of motorcycles",
        "reference": {
            "value": "ZM-MOH-001-RFB",
            "status": "published",
            "evidence": [],
            "note": None,
        },
        "buyer": {
            "value": "Ministry of Health",
            "status": "published",
            "evidence": [],
            "note": None,
        },
        "country": {"value": "Zambia", "status": "published", "evidence": [], "note": None},
        "deadline": {
            "value": "2026-11-20T10:00:00Z",
            "originalText": "20 Nov 2026 10:00",
            "timezone": None,
            "precision": "datetime",
            "ambiguous": False,
            "status": "published",
            "evidence": [],
            "note": None,
        },
        "publishedAt": {
            "value": "2026-10-01T00:00:00Z",
            "originalText": "01-Oct-2026",
            "timezone": None,
            "precision": "date",
            "ambiguous": False,
            "status": "published",
            "evidence": [],
            "note": None,
        },
        "status": "open",
        "noticeVersion": None,
        "relevance": {
            "score": 0.6,
            "groups": ["motorbikes"],
            "matches": [],
            "excluded": [],
            "explanation": "FIXTURE.",
        },
        "items": [],
        "firstSeenAt": "2026-10-31T00:00:00Z",
        "lastCheckedAt": "2026-10-31T00:00:00Z",
        "lastUpdatedAt": "2026-10-31T00:00:00Z",
        "contentHash": "0" * 64,
    }
    rec.update(copy.deepcopy(over))
    return rec


def make_item(
    desc: str, qty: float | None, unit: str | None, url: str, page: int = 1, **kw: Any
) -> dict[str, Any]:
    quote = f"{desc} | {unit} | {qty}"
    return {
        "lotNo": kw.get("lotNo"),
        "lineNo": kw.get("lineNo"),
        "description": desc,
        "specification": {"value": None, "status": "not_published", "evidence": [], "note": None},
        "quantity": {"value": qty, "originalText": None if qty is None else str(qty)},
        "unit": unit,
        "evidence": [
            {
                "sourceUrl": url,
                "quote": quote,
                "page": page,
                "documentUrl": url,
                "retrievedAt": "2026-10-31T00:00:00Z",
            }
        ],
        "needsReview": False,
    }
