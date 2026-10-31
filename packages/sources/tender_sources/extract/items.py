"""Line-item extraction from PDF tables and plain text, plus cross-document merging.

Rules: header synonyms decide columns (never positions); lot heading rows set ``lotNo``; footer
total rows are not items; wrapped/merged continuation rows are glued to the item above (only when
the table has an item-number column, otherwise a description-only row is a new item flagged for
review); a blank quantity is ``None`` + ``needsReview``; quantities are NEVER summed and units
are NEVER converted (units compare by case/punctuation only).
"""

from __future__ import annotations

import copy
import re
from typing import Any

from tender_sources.normalize.units import parse_quantity

_HEADER_SYNONYMS: dict[str, set[str]] = {
    "lineNo": {"s n", "sn", "s no", "sno", "no", "sl no", "sl", "serial", "serial no", "serial number",
               "item no", "item number", "item", "line", "line no", "ref", "#", "nr", "sr no"},
    "description": {"description", "item description", "description of goods", "description of items",
                    "item", "items", "particulars", "name of item", "goods", "goods description",
                    "name", "product", "article", "description of work", "description of item"},
    "specification": {"specification", "specifications", "spec", "specs", "technical specification",
                      "technical specifications", "details", "remarks"},
    "unit": {"unit", "units", "uom", "u o m", "unit of measure", "unit of measurement", "measure"},
    "qty": {"qty", "quantity", "quantities", "qnty", "no of units", "number of units", "total qty",
            "total quantity", "required quantity", "qty required"},
}  # fmt: skip
_LOT_RE = re.compile(
    r"^\s*(?:lot|package|schedule|section)\s*(?:no\.?|number|#)?\s*([A-Za-z0-9][A-Za-z0-9.\-]*)\s*[:\-–.)]?\s*(.*)$",
    re.IGNORECASE,
)
_FOOTER_RE = re.compile(
    r"^(?:grand\s+|sub[\s-]*)?total(?:\s+(?:amount|price|cost|quantity|qty|value|bid|tender))?"
    r"\s*(?:\([^)]*\))?\s*:?\s*$",
    re.IGNORECASE,
)
_LUMP_UNITS = {"ls", "l s", "lot", "lump sum", "lumpsum"}


def _norm_header(cell: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9# ]+", " ", cell.lower())).strip()


def _clean(cell: Any) -> str:
    return " ".join(str(cell).split()) if cell is not None else ""


def _evidence(source_url: str, page: int | None, quote: str, retrieved_at: str) -> dict[str, Any]:
    return {
        "sourceUrl": source_url,
        "quote": quote[:600] or None,
        "page": page,
        "documentUrl": source_url if page is not None else None,
        "retrievedAt": retrieved_at,
    }


def _spec_fact(text: str) -> dict[str, Any]:
    if text:
        return {"value": text, "status": "published", "evidence": [], "note": None}
    return {"value": None, "status": "not_published", "evidence": [], "note": None}


def _find_header(rows: list[list[str]]) -> tuple[int, dict[str, int]] | None:
    for r_idx, row in enumerate(rows[:6]):
        cols: dict[str, int] = {}
        norm = [_norm_header(c) for c in row]
        has_desc_col = any(n in _HEADER_SYNONYMS["description"] - {"item", "items"} for n in norm)
        for c_idx, n in enumerate(norm):
            if not n:
                continue
            for field in ("qty", "unit", "specification", "description", "lineNo"):
                syn = _HEADER_SYNONYMS[field]
                if n in syn:
                    if n in {"item", "items"} and has_desc_col:
                        field = "lineNo" if n == "item" else field
                    elif n == "item" or n == "items":
                        field = "description"
                    if field not in cols:
                        cols[field] = c_idx
                    break
        if "description" in cols and len(cols) >= 2 and ("qty" in cols or "unit" in cols):
            return r_idx, cols
    return None


def _is_unit_lump(unit: str | None) -> bool:
    return bool(unit) and re.sub(r"[.\s]+", " ", unit.lower()).strip() in _LUMP_UNITS  # type: ignore[union-attr]


def extract_items_from_table(
    rows: list[list[str]], *, source_url: str, page: int | None, retrieved_at: str
) -> list[dict[str, Any]]:
    """Turn one table (list of rows of cell strings) into LineItem dicts. Never raises."""
    try:
        return _table(rows, source_url, page, retrieved_at)
    except Exception:  # noqa: BLE001
        return []


def _table(
    raw_rows: list[list[str]], source_url: str, page: int | None, retrieved_at: str
) -> list[dict[str, Any]]:
    rows = [[_clean(c) for c in r] for r in raw_rows if isinstance(r, list)]
    found = _find_header(rows)
    if found is None:
        return []
    h_idx, cols = found
    header_norm = [_norm_header(c) for c in rows[h_idx]]
    items: list[dict[str, Any]] = []
    lot: str | None = None
    last: dict[str, Any] | None = None
    for pre in rows[:h_idx]:  # a lot heading may sit above the header row
        distinct = {c for c in pre if c}
        if len(distinct) == 1 and (m := _LOT_RE.match(next(iter(distinct)))):
            lot = m.group(1).rstrip(".")

    def cell(row: list[str], field: str) -> str:
        i = cols.get(field)
        return row[i] if i is not None and i < len(row) else ""

    for row in rows[h_idx + 1 :]:
        non_empty = [c for c in row if c]
        if not non_empty:
            continue
        if [_norm_header(c) for c in row] == header_norm:  # repeated header on a new page
            continue
        # lot heading: a single distinct text spanning the row
        if len(set(non_empty)) == 1 and (m := _LOT_RE.match(non_empty[0])):
            lot = m.group(1).rstrip(".")
            last = None
            continue
        first = non_empty[0]
        desc_cell = cell(row, "description")
        if _FOOTER_RE.match(first) or _FOOTER_RE.match(desc_cell):
            last = None
            continue
        line_no = cell(row, "lineNo").rstrip(".") or None
        spec = cell(row, "specification")
        qty_txt = cell(row, "qty")
        unit_txt = cell(row, "unit")
        quote = " | ".join(non_empty)

        only_text = not line_no and not qty_txt and not unit_txt and (desc_cell or spec)
        if only_text and last is not None and "lineNo" in cols:
            # wrapped / merged continuation of the item above
            if desc_cell:
                last["description"] = f"{last['description']} {desc_cell}".strip()
            if spec:
                prev = last["specification"]["value"]
                last["specification"] = _spec_fact(f"{prev} {spec}".strip() if prev else spec)
            ev = last["evidence"][0]
            ev["quote"] = f"{ev['quote'] or ''} / {quote}"[:600]
            continue

        qty = parse_quantity(qty_txt)
        unit = unit_txt or qty["unit"]
        review = False
        if not desc_cell:
            review = True
            desc = spec or "(description not readable)"
        else:
            desc = desc_cell
        if re.fullmatch(r"[\d\s.,/-]+", desc):
            review = True
        if qty["value"] is None and not _is_unit_lump(unit):
            review = True  # blank, unreadable, range or ambiguous quantity
        item = {
            "lotNo": lot,
            "lineNo": line_no,
            "description": desc,
            "specification": _spec_fact(spec if desc_cell else ""),
            "quantity": {"value": qty["value"], "originalText": qty_txt or None},
            "unit": unit or None,
            "evidence": [_evidence(source_url, page, quote, retrieved_at)],
            "needsReview": review,
        }
        items.append(item)
        last = item
    # a mostly-unreadable table is flagged as a whole
    if items and sum(i["needsReview"] for i in items) * 2 > len(items):
        for i in items:
            i["needsReview"] = True
    return items


_TEXT_ITEM = re.compile(r"^\s*(?:(?P<num>\d{1,3})\s*[.)]\s+|[-•*●▪]\s+)(?P<body>\S.*)$")
_TEXT_LOT = re.compile(
    r"^\s*(?:lot|package)\s*(?:no\.?|number|#)?\s*([A-Za-z0-9][A-Za-z0-9.\-]*)\s*[:\-–]\s*(.*)$",
    re.IGNORECASE,
)
_QTY_SEP = re.compile(
    r"^(?P<d>.+?)\s*(?:[-–—:,;]|\(|\bqty\.?:?|\bquantity:?|\bx\b|×)\s*"
    r"(?P<q>\d[\d,]*(?:\.\d+)?)\s*(?P<u>[A-Za-z]{1,15})?\s*\)?\.?$",
    re.IGNORECASE,
)
_QTY_UNIT = re.compile(
    r"^(?P<d>.+?)\s+(?P<q>\d[\d,]*)\s*(?P<u>pcs?|pieces?|units?|nos?\.?|sets?|pairs?|each|ea|boxes|box|"
    r"packs?|rolls?|bags?|kits?|dozen|litres?|liters?|kg|tonnes?|tons?|cartons?)\.?$",
    re.IGNORECASE,
)
_QTY_LEAD = re.compile(r"^(?P<q>\d[\d,]*)\s*(?:x|×)\s+(?P<d>.+)$", re.IGNORECASE)
_SENTENCE = re.compile(
    r"\b(shall|must|should|will|may|bidder|tenderer|applicant|shall not)\b", re.IGNORECASE
)


def extract_items_from_text(
    text: str, *, source_url: str, page: int | None, retrieved_at: str
) -> list[dict[str, Any]]:
    """Find numbered/bulleted item lines such as ``1. Motorcycle 150cc - 10 units``."""
    try:
        return _text(text, source_url, page, retrieved_at)
    except Exception:  # noqa: BLE001
        return []


def _text(text: str, source_url: str, page: int | None, retrieved_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    lot: str | None = None
    for raw in (text or "").splitlines():
        line = " ".join(raw.split())
        if not line:
            continue
        if m := _TEXT_LOT.match(line):
            lot = m.group(1).rstrip(".")
            continue
        m = _TEXT_ITEM.match(line)
        if not m:
            continue
        body = m["body"].strip()
        desc, qty_txt, unit_txt = body, "", ""
        if mm := _QTY_LEAD.match(body):
            desc, qty_txt = mm["d"], mm["q"]
        elif mm := (_QTY_UNIT.match(body) or _QTY_SEP.match(body)):
            desc, qty_txt, unit_txt = mm["d"], mm["q"], mm["u"] or ""
        desc = desc.strip(" -–:,;(")
        if not desc or _SENTENCE.search(body):
            continue
        if not qty_txt and len(body.split()) > 10:
            continue  # prose, not an item line
        qty = parse_quantity(f"{qty_txt} {unit_txt}".strip()) if qty_txt else parse_quantity(None)
        unit = qty["unit"]
        items.append(
            {
                "lotNo": lot,
                "lineNo": m["num"],
                "description": desc,
                "specification": _spec_fact(""),
                "quantity": {
                    "value": qty["value"],
                    "originalText": f"{qty_txt} {unit_txt}".strip() or None,
                },
                "unit": unit,
                "evidence": [_evidence(source_url, page, line, retrieved_at)],
                # free text is always lower confidence than a table; trusted only with qty AND unit
                "needsReview": not (qty["value"] is not None and unit),
            }
        )
    return items


def _norm_desc(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s.lower())).strip()


def _norm_unit(u: str | None) -> str | None:
    if not u:
        return None
    return re.sub(r"[.\s]+", "", u.lower()) or None


def _ev_key(e: dict[str, Any]) -> tuple[Any, ...]:
    return (e.get("sourceUrl"), e.get("page"), e.get("quote"))


def merge_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse the same item seen in several documents into one, merging evidence.

    Never sums quantities. Same description with different quantity/unit stays separate and is
    flagged ``needsReview``. Two rows of the same document are never merged with each other.
    """
    groups: list[dict[str, Any]] = []
    for original in items:
        item = copy.deepcopy(original)
        nd = _norm_desc(item.get("description", ""))
        qv = item.get("quantity", {}).get("value")
        nu = _norm_unit(item.get("unit"))
        target = None
        for g in groups:
            if (
                g["_nd"] == nd
                and g["_qv"] == qv
                and g["_nu"] == nu
                and _compatible(g["item"].get("lotNo"), item.get("lotNo"))
                and _compatible(g["item"].get("lineNo"), item.get("lineNo"))
                and _cross_document(g["item"], item)
            ):
                target = g
                break
        if target is None:
            groups.append({"item": item, "_nd": nd, "_qv": qv, "_nu": nu})
            continue
        base = target["item"]
        seen = {_ev_key(e) for e in base["evidence"]}
        for e in item["evidence"]:
            if _ev_key(e) not in seen:
                base["evidence"].append(e)
                seen.add(_ev_key(e))
        for f in ("lotNo", "lineNo"):
            base[f] = base.get(f) or item.get(f)
        if not base["specification"].get("value") and item["specification"].get("value"):
            base["specification"] = item["specification"]
        base["needsReview"] = bool(base.get("needsReview") or item.get("needsReview"))
    # same description, different quantity/unit: keep apart but flag
    by_desc: dict[str, list[dict[str, Any]]] = {}
    for g in groups:
        by_desc.setdefault(g["_nd"], []).append(g)
    for same in by_desc.values():
        variants = {(g["_qv"], g["_nu"]) for g in same}
        if len(same) > 1 and len(variants) > 1:
            for g in same:
                g["item"]["needsReview"] = True
    return [g["item"] for g in groups]


def _compatible(a: Any, b: Any) -> bool:
    return a is None or b is None or a == b


def _cross_document(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """True if b comes from a different document than every evidence of a (or is the identical row)."""
    docs_a = {e.get("sourceUrl") for e in a["evidence"]}
    keys_a = {_ev_key(e) for e in a["evidence"]}
    for e in b["evidence"]:
        if _ev_key(e) in keys_a:
            return True
        if e.get("sourceUrl") in docs_a:
            return False
    return True
