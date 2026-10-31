"""Pull tender requirements out of extracted PDF pages. Only facts that are actually found are returned.

Everything returned carries evidence (page + exact quote). Absent facts are simply omitted from the
result dict (the caller leaves the record default: null + status). Amounts are routed to
bidSecurity / tenderFee / estimatedValue / awardValue by ``classify_value_label`` on the words
immediately before the number, so a tender fee can never land in bidSecurity. Two different values
for the same field on different pages give ``status='conflicting'`` listing both evidences and
leave the amount ``None`` (we do not pick a winner).
"""

from __future__ import annotations

import re
from typing import Any

from tender_sources.extract.items import (
    _LOT_RE,
    _TEXT_LOT,
    extract_items_from_table,
    extract_items_from_text,
    merge_items,
)
from tender_sources.normalize.money import classify_value_label, parse_money

_KIND_FIELD = {
    "bid_security": "bidSecurity",
    "tender_fee": "tenderFee",
    "estimated": "estimatedValue",
    "award": "awardValue",
}
_CUR = r"(?:[A-Z]{3}|US\$|[$€£])"
_AMOUNT = re.compile(
    rf"(?P<m>(?:{_CUR}\s?\d[\d,.]*(?:\s?(?:million|mn|billion|bn))?)"
    rf"|(?:\d[\d,.]*(?:\s?(?:million|mn|billion|bn))?\s?[A-Z]{{3}}\b)"
    rf"|(?:(?<=[:\s])(?:of\s+)?\d[\d,]*(?:\.\d+)?(?=\s*(?:$|[.;)])))"
    rf"|(?P<pct>\d{{1,3}}(?:\.\d+)?\s?%(?:\s+of\s+[^.;,\n]{{3,60}})?))",
    re.IGNORECASE,
)
_MARK = r"(?:\(?[a-z0-9]{1,3}[.)]|[-•*●▪–])"
_MARKER_RE = re.compile(rf"^\s*{_MARK}\s+\S")
_HEADINGS: dict[str, re.Pattern[str]] = {
    "eligibility": re.compile(
        r"^\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(eligibility(?:\s+(?:criteria|requirements|conditions))?|"
        r"qualification(?:s)?(?:\s+(?:criteria|requirements))?|eligible\s+bidders|who\s+can\s+bid)\s*[:\-]?\s*(?P<rest>.*)$",
        re.IGNORECASE,
    ),
    "requiredDocuments": re.compile(
        r"^\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(documents?\s+(?:required|to\s+be\s+(?:submitted|attached|provided))|"
        r"required\s+documents?|documents?\s+comprising\s+the\s+bid|bid\s+documents?\s+(?:shall|must)\s+include|"
        r"submission\s+requirements|mandatory\s+documents)\s*[:\-]?\s*(?P<rest>.*)$",
        re.IGNORECASE,
    ),
}
_SCHEDULE_RE = re.compile(
    r"(delivery\s+(?:schedule|period|time|date)|time\s+(?:for|of)\s+delivery|period\s+of\s+delivery|"
    r"delivery\s+within|delivered\s+within|completion\s+period)\s*[:\-]?\s*(?P<v>.*)",
    re.IGNORECASE,
)
_LOCATION_RE = re.compile(
    r"(delivery\s+(?:location|point|address|place)|place\s+of\s+delivery|delivered\s+to|"
    r"delivery\s+destination)\s*[:\-]?\s*(?P<v>.*)",
    re.IGNORECASE,
)
_SUBMISSION_RE = re.compile(
    r"(bids?|tenders?|proposals?|quotations?)\s+(?:shall|must|should|are\s+to|have\s+to|can|may)\s+be\s+"
    r"(?:submitted|delivered|sent|uploaded)|method\s+of\s+submission|submission\s+(?:method|of\s+bids)|"
    r"(?:submit|submitted)\s+(?:electronically|online|by\s+email|in\s+person|by\s+hand)",
    re.IGNORECASE,
)


def _ev(source_url: str, page: int, quote: str, retrieved_at: str) -> dict[str, Any]:
    return {
        "sourceUrl": source_url,
        "quote": quote.strip()[:600] or None,
        "page": page,
        "documentUrl": source_url,
        "retrievedAt": retrieved_at,
    }


def _lines(page: dict[str, Any]) -> list[tuple[str, str]]:
    """(text used for matching, exact quote) for every text line and table row of a page."""
    out: list[tuple[str, str]] = []
    for ln in str(page.get("text") or "").splitlines():
        if ln.strip():
            out.append((ln.strip(), ln.strip()))
    for table in page.get("tables") or []:
        for row in table:
            cells = [" ".join(str(c).split()) for c in row if c and str(c).strip()]
            if len(cells) >= 2:
                out.append((f"{cells[0]}: {' '.join(cells[1:])}", " | ".join(cells)))
            elif cells:
                out.append((cells[0], cells[0]))
    return out


def _money_candidates(
    pages: list[dict[str, Any]], source_url: str, retrieved_at: str
) -> dict[str, list[dict[str, Any]]]:
    found: dict[str, list[dict[str, Any]]] = {}
    for page in pages:
        pno = int(page.get("page") or 1)
        for text, quote in _lines(page):
            for m in _AMOUNT.finditer(text):
                before = text[max(0, m.start() - 70) : m.start()]
                label = re.split(r"[;.]\s", before)[-1]
                kind = classify_value_label(label)
                if kind is None or not label.strip(" :-"):
                    continue
                ev = _ev(source_url, pno, quote, retrieved_at)
                if m.group("pct"):
                    fact = {
                        "amount": None,
                        "currency": None,
                        "originalText": m.group("pct").strip(),
                        "status": "published",
                        "evidence": [ev],
                        "note": "Stated as a percentage, not a fixed amount.",
                    }
                    fact["_key"] = ("pct", re.sub(r"\s+", "", m.group("pct").lower()))
                else:
                    fact = parse_money(m.group("m").strip(), evidence=[ev])
                    if fact["amount"] is None:
                        continue
                    fact["_key"] = (fact["amount"], fact["currency"])
                found.setdefault(_KIND_FIELD[kind], []).append(fact)
    return found


def _resolve_money(cands: list[dict[str, Any]]) -> dict[str, Any]:
    distinct: dict[Any, dict[str, Any]] = {}
    for c in cands:
        key = c["_key"]
        if key in distinct:
            seen = {(e["page"], e["quote"]) for e in distinct[key]["evidence"]}
            distinct[key]["evidence"] += [
                e for e in c["evidence"] if (e["page"], e["quote"]) not in seen
            ]
        else:
            distinct[key] = {k: v for k, v in c.items()}
    facts = list(distinct.values())
    if len(facts) == 1:
        facts[0].pop("_key", None)
        return facts[0]
    evidence = [e for f in facts for e in f["evidence"]]
    desc = " vs ".join(f"{f['originalText']} (p.{f['evidence'][0]['page']})" for f in facts)
    return {
        "amount": None,
        "currency": None,
        "originalText": " | ".join(str(f["originalText"]) for f in facts),
        "status": "conflicting",
        "evidence": evidence,
        "note": f"Conflicting values across pages: {desc}.",
    }


def _collect_list(
    pages: list[dict[str, Any]], field: str, source_url: str, retrieved_at: str
) -> dict[str, Any] | None:
    pat = _HEADINGS[field]
    values: list[str] = []
    evidence: list[dict[str, Any]] = []
    for page in pages:
        pno = int(page.get("page") or 1)
        lines = str(page.get("text") or "").splitlines()
        i = 0
        while i < len(lines):
            m = pat.match(lines[i])
            if not m or len(lines[i]) > 120:
                i += 1
                continue
            got: list[str] = []
            quote_lines = [lines[i].strip()]
            rest = (m.group("rest") or "").strip()
            if rest:
                got.append(rest)
            j = i + 1
            while j < len(lines):
                ln = lines[j]
                if not ln.strip():
                    if got:
                        break
                    j += 1
                    continue
                if _MARKER_RE.match(ln):
                    got.append(re.sub(rf"^\s*{_MARK}\s+", "", ln).strip())
                elif (
                    got
                    and not ln.rstrip().endswith(":")
                    and not ln.isupper()
                    and _MARKER_RE.match(lines[j - 1])
                ):
                    got[-1] = f"{got[-1]} {ln.strip()}"  # wrapped bullet
                else:
                    break
                quote_lines.append(ln.strip())
                j += 1
            if got:
                values += [g for g in got if g not in values]
                evidence.append(_ev(source_url, pno, "\n".join(quote_lines), retrieved_at))
            i = max(j, i + 1)
    if not values:
        return None
    return {"value": values, "status": "published", "evidence": evidence, "note": None}


def _collect_text(
    pages: list[dict[str, Any]],
    pattern: re.Pattern[str],
    source_url: str,
    retrieved_at: str,
    *,
    whole_line: bool,
    detect_conflict: bool,
) -> dict[str, Any] | None:
    hits: list[tuple[str, dict[str, Any]]] = []
    for page in pages:
        pno = int(page.get("page") or 1)
        for text, quote in _lines(page):
            m = pattern.search(text)
            if not m:
                continue
            value = text.strip() if whole_line else (m.groupdict().get("v") or "").strip(" :-")
            if not value:
                value = text.strip()
            elif (
                not whole_line
                and m.group(1)
                and re.match(r"(?i)delivery\s+within|delivered\s+within", m.group(1))
            ):
                value = text[m.start() :].strip()
            hits.append((value, _ev(source_url, pno, quote, retrieved_at)))
    if not hits:
        return None
    norm = {re.sub(r"\W+", "", v.lower()) for v, _ in hits}
    if detect_conflict and len(norm) > 1:
        uniq = list(dict.fromkeys(v for v, _ in hits))
        return {
            "value": None,
            "status": "conflicting",
            "evidence": [e for _, e in hits],
            "note": "Conflicting values: " + " vs ".join(f"'{u}'" for u in uniq[:4]) + ".",
        }
    return {
        "value": hits[0][0],
        "status": "published",
        "evidence": [e for _, e in hits],
        "note": None,
    }


def extract_requirements(
    pages: list[dict[str, Any]], *, source_url: str, retrieved_at: str
) -> dict[str, Any]:
    """Return partial TenderRecord fields found in ``pages`` (documents.extract_pdf()['pages'])."""
    try:
        return _extract(pages or [], source_url, retrieved_at)
    except Exception:  # noqa: BLE001
        return {}


def _extract(pages: list[dict[str, Any]], source_url: str, retrieved_at: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field, cands in _money_candidates(pages, source_url, retrieved_at).items():
        out[field] = _resolve_money(cands)
    for field in ("eligibility", "requiredDocuments"):
        fact = _collect_list(pages, field, source_url, retrieved_at)
        if fact:
            out[field] = fact
    sched = _collect_text(
        pages, _SCHEDULE_RE, source_url, retrieved_at, whole_line=False, detect_conflict=True
    )
    if sched:
        out["deliverySchedule"] = sched
    loc = _collect_text(
        pages, _LOCATION_RE, source_url, retrieved_at, whole_line=False, detect_conflict=True
    )
    if loc:
        out["deliveryLocation"] = loc
    sub = _collect_text(
        pages, _SUBMISSION_RE, source_url, retrieved_at, whole_line=True, detect_conflict=False
    )
    if sub:
        out["submissionMethod"] = sub

    items: list[dict[str, Any]] = []
    lots: dict[str, dict[str, Any]] = {}
    for page in pages:
        pno = int(page.get("page") or 1)
        page_items: list[dict[str, Any]] = []
        for table in page.get("tables") or []:
            page_items += extract_items_from_table(
                table, source_url=source_url, page=pno, retrieved_at=retrieved_at
            )
            for row in table:
                distinct = {" ".join(str(c).split()) for c in row if c and str(c).strip()}
                if len(distinct) == 1 and (m := _LOT_RE.match(next(iter(distinct)))):
                    lots.setdefault(
                        m.group(1).rstrip("."),
                        _lot(
                            m.group(1),
                            m.group(2),
                            source_url,
                            pno,
                            next(iter(distinct)),
                            retrieved_at,
                        ),
                    )
        if not page_items:
            # Free text is noisy (eligibility bullets look like items): keep only lines that carry
            # an explicit quantity.
            page_items = [
                it
                for it in extract_items_from_text(
                    str(page.get("text") or ""),
                    source_url=source_url,
                    page=pno,
                    retrieved_at=retrieved_at,
                )
                if it["quantity"]["value"] is not None
            ]
        for ln in str(page.get("text") or "").splitlines():
            if m := _TEXT_LOT.match(ln):
                lots.setdefault(
                    m.group(1).rstrip("."),
                    _lot(m.group(1), m.group(2), source_url, pno, ln.strip(), retrieved_at),
                )
        items += page_items
    if items:
        out["items"] = merge_items(items)
        for it in out["items"]:
            if it.get("lotNo") and it["lotNo"] not in lots:
                lots[it["lotNo"]] = {
                    "lotNo": it["lotNo"], "title": None, "description": None, "evidence": it["evidence"][:1],
                }  # fmt: skip
    if lots:
        out["lots"] = list(lots.values())
    return out


def _lot(
    no: str, title: str, source_url: str, page: int, quote: str, retrieved_at: str
) -> dict[str, Any]:
    no = no.rstrip(".")
    return {
        "lotNo": no,
        "title": title.strip() or None,
        "description": None,
        "evidence": [_ev(source_url, page, quote, retrieved_at)],
    }
