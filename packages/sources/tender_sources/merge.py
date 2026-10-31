"""Hashing, duplicate flagging, in-run dedupe, diffs and version ordering for TenderRecord dicts.

Pure functions over plain dicts. Cross-source duplicates are only ever FLAGGED
(``possibleDuplicateOf``); records from different sources are never merged here.
"""

from __future__ import annotations

import copy
import difflib
import hashlib
import json
import re
from datetime import datetime
from typing import Any

_VOLATILE_TOP = {
    "firstSeenAt",
    "lastCheckedAt",
    "lastUpdatedAt",
    "contentHash",
    "possibleDuplicateOf",
}
_VALUE_FIELDS = ("estimatedValue", "awardValue", "tenderFee", "bidSecurity")
_TEXT_FACTS = (
    "reference", "buyer", "country", "deliveryLocation", "scopeOfSupply", "deliverySchedule",
    "submissionMethod",
)  # fmt: skip


def _strip_volatile(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            k: _strip_volatile(v) for k, v in node.items() if k not in {"retrievedAt", "fetchedAt"}
        }
    if isinstance(node, list):
        return [_strip_volatile(v) for v in node]
    return node


def content_hash(record: dict[str, Any]) -> str:
    """sha256 over canonical JSON of the record minus timestamps and volatile bookkeeping.

    Excluded: firstSeenAt, lastCheckedAt, lastUpdatedAt, contentHash, every ``retrievedAt`` (evidence),
    every ``fetchedAt`` (documents) and ``possibleDuplicateOf`` (depends on OTHER records, not on this
    notice's content). Keys are sorted, so key order never matters.
    """
    body = _strip_volatile({k: v for k, v in record.items() if k not in _VOLATILE_TOP})
    blob = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _fact_value(record: dict[str, Any], field: str) -> Any:
    f = record.get(field)
    return f.get("value") if isinstance(f, dict) else None


def _norm_ref(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(s or "").lower())


def _norm_text(s: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(s or "").lower())).strip()


def _ts(date_fact: Any) -> float | None:
    v = date_fact.get("value") if isinstance(date_fact, dict) else None
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v).timestamp()
    except ValueError:
        return None


def _rid(r: dict[str, Any]) -> str:
    return f"{r.get('source')}:{r.get('sourceRecordId')}"


def possible_duplicates(record: dict[str, Any], others: list[dict[str, Any]]) -> list[str]:
    """Ids ("source:sourceRecordId") of other-source records that MIGHT be the same notice.

    Cautious: same normalised reference (>= 5 chars), OR (title similarity >= 0.9 AND same buyer --
    or same country when a buyer is unknown on either side -- AND deadlines within 1 day).
    """
    ref = _norm_ref(_fact_value(record, "reference"))
    title = _norm_text(record.get("title"))
    buyer = _norm_text(_fact_value(record, "buyer"))
    country = _norm_text(_fact_value(record, "country"))
    dl = _ts(record.get("deadline"))
    out: set[str] = set()
    for o in others:
        if o.get("source") == record.get("source"):
            continue
        o_ref = _norm_ref(_fact_value(o, "reference"))
        if len(ref) >= 5 and ref == o_ref:
            out.add(_rid(o))
            continue
        o_title = _norm_text(o.get("title"))
        if not title or not o_title:
            continue
        if difflib.SequenceMatcher(None, title, o_title).ratio() < 0.9:
            continue
        o_buyer = _norm_text(_fact_value(o, "buyer"))
        o_country = _norm_text(_fact_value(o, "country"))
        if buyer and o_buyer:
            same_party = buyer == o_buyer
        else:
            same_party = bool(country) and country == o_country
        o_dl = _ts(o.get("deadline"))
        if same_party and dl is not None and o_dl is not None and abs(dl - o_dl) <= 86400:
            out.add(_rid(o))
    return sorted(out)


def _version_tuple(v: Any) -> tuple[int, ...] | None:
    nums = re.findall(r"\d+", str(v)) if v is not None else []
    return tuple(int(n) for n in nums) if nums else None


def supersedes(new: dict[str, Any], new_old: dict[str, Any]) -> bool | None:
    """True if ``new`` clearly supersedes the second record, False if clearly older, else None.

    Signals: higher/lower ``noticeVersion``, later/earlier ``publishedAt``. Equal or missing signals
    give None; contradicting signals (higher version but earlier date) also give None so the caller
    flags a conflict instead of silently picking one.
    """
    old = new_old
    signals: list[bool] = []
    vn, vo = _version_tuple(new.get("noticeVersion")), _version_tuple(old.get("noticeVersion"))
    if vn is not None and vo is not None and vn != vo:
        signals.append(vn > vo)
    pn, po = _ts(new.get("publishedAt")), _ts(old.get("publishedAt"))
    if pn is not None and po is not None and pn != po:
        signals.append(pn > po)
    if not signals:
        return None
    if all(signals):
        return True
    if not any(signals):
        return False
    return None


def _richness(node: Any) -> int:
    if isinstance(node, dict):
        return sum(
            _richness(v)
            for k, v in node.items()
            if k not in _VOLATILE_TOP | {"retrievedAt", "fetchedAt"}
        )
    if isinstance(node, list):
        return sum(_richness(v) for v in node)
    return 0 if node in (None, "", False) else 1


def _winner_key(r: dict[str, Any]) -> tuple[Any, ...]:
    ver = _version_tuple(r.get("noticeVersion")) or ()
    return (
        ver,
        _richness(r),
        str(r.get("lastUpdatedAt") or ""),
        str(r.get("lastCheckedAt") or ""),
        json.dumps(r, sort_keys=True, default=str),
    )


def dedupe_in_run(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse records with the same (source, sourceRecordId) or the same canonicalUrl.

    The kept one is chosen deterministically: higher noticeVersion, then richer, then later
    lastUpdatedAt/lastCheckedAt, then canonical JSON. Order = first appearance of each group.
    """
    parent = list(range(len(records)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    seen: dict[tuple[str, str], int] = {}
    for i, r in enumerate(records):
        keys = [("id", _rid(r))]
        if r.get("canonicalUrl"):
            keys.append(("url", str(r["canonicalUrl"]).rstrip("/")))
        for k in keys:
            if k in seen:
                parent[find(i)] = find(seen[k])
            else:
                seen[k] = i
    groups: dict[int, list[int]] = {}
    for i in range(len(records)):
        groups.setdefault(find(i), []).append(i)
    out: list[tuple[int, dict[str, Any]]] = []
    for members in groups.values():
        best = max(members, key=lambda i: _winner_key(records[i]))
        out.append((min(members), copy.deepcopy(records[best])))
    return [r for _, r in sorted(out, key=lambda t: t[0])]


def _money_sig(rec: dict[str, Any], field: str) -> dict[str, Any]:
    f = rec.get(field) or {}
    return {"amount": f.get("amount"), "currency": f.get("currency")}


def _items_sig(rec: dict[str, Any]) -> list[list[Any]]:
    out = []
    for it in rec.get("items") or []:
        q = it.get("quantity") or {}
        out.append(
            [
                it.get("lotNo"),
                it.get("lineNo"),
                _norm_text(it.get("description")),
                q.get("value"),
                it.get("unit"),
            ]
        )
    return sorted(out, key=lambda x: json.dumps(x, default=str))


def diff_records(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    """Meaningful changes between two versions of a record (timestamps/evidence ignored)."""
    changes: list[dict[str, Any]] = []

    def add(field: str, o: Any, n: Any, kind: str) -> None:
        changes.append({"field": field, "old": o, "new": n, "kind": kind})

    od, nd = (old.get("deadline") or {}).get("value"), (new.get("deadline") or {}).get("value")
    if od != nd:
        ot, nt = _ts(old.get("deadline")), _ts(new.get("deadline"))
        kind = "deadline_changed"
        if ot is not None and nt is not None:
            kind = "deadline_extended" if nt > ot else "deadline_shortened"
        add("deadline", od, nd, kind)
    if old.get("status") != new.get("status"):
        add("status", old.get("status"), new.get("status"), "status_changed")
    for f in _VALUE_FIELDS:
        if _money_sig(old, f) != _money_sig(new, f):
            add(f, _money_sig(old, f), _money_sig(new, f), "value_changed")
    if _items_sig(old) != _items_sig(new):
        add("items", _items_sig(old), _items_sig(new), "items_changed")
    if old.get("noticeVersion") != new.get("noticeVersion"):
        add("noticeVersion", old.get("noticeVersion"), new.get("noticeVersion"), "other")
    for f in ("title", "noticeType"):
        if old.get(f) != new.get(f):
            add(f, old.get(f), new.get(f), "other")
    for f in _TEXT_FACTS:
        if _fact_value(old, f) != _fact_value(new, f):
            add(f, _fact_value(old, f), _fact_value(new, f), "other")
    if (old.get("publishedAt") or {}).get("value") != (new.get("publishedAt") or {}).get("value"):
        add(
            "publishedAt",
            (old.get("publishedAt") or {}).get("value"),
            (new.get("publishedAt") or {}).get("value"),
            "other",
        )
    for f in ("eligibility", "requiredDocuments"):
        if _fact_value(old, f) != _fact_value(new, f):
            add(f, _fact_value(old, f), _fact_value(new, f), "other")
    od_docs = sorted(str(d.get("sha256") or d.get("url")) for d in old.get("documents") or [])
    nd_docs = sorted(str(d.get("sha256") or d.get("url")) for d in new.get("documents") or [])
    if od_docs != nd_docs:
        add("documents", od_docs, nd_docs, "other")
    return changes
