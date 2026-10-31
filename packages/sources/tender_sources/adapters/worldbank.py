"""World Bank procurement notices: official open JSON API, live adapter.

API: ``GET https://search.worldbank.org/api/v2/procnotices`` (verified by real requests, 2026-10-31):

  * ``qterm=<words>``                 full-text search. Multi-word terms work UNQUOTED; quoting returns 0.
  * ``project_ctry_name_exact=Zambia`` the working country filter (``countryshortname_exact``,
                                       ``countrycode_exact`` and ``countryname_exact`` are silently ignored).
                                       Regional projects ("Eastern and Southern Africa") are NOT matched.
  * ``notice_type_exact=<type>``      exact notice type filter (not used by default).
  * ``srt=noticedate&order=desc``     newest first. ``strdate`` / ``enddate`` are ignored, so the ``since``
                                       cut-off is applied client-side and paging stops at the first
                                       page whose oldest notice is older than ``since``.
  * ``rows`` / ``os``                 page size / offset; ``total`` in the response is a string.
  * there is NO structured deadline field (``submission_date`` equals the notice date); deadlines only
    exist inside the free-text ``notice_text`` of invitations, so they are extracted from the text.

Notice page URL (verified HTTP 200): ``https://projects.worldbank.org/en/projects-operations/procurement-detail/<id>``.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from tender_sources.adapters.base import (
    ACCESS_BLOCKED,
    ACCESS_OK,
    ACCESS_UNREACHABLE,
    STOP_FAILED,
    STOP_REQUEST_CAP,
    AccessStatusResult,
    DiscoverContext,
    ListingRef,
    RawNotice,
    SourceAdapter,
    evidence,
    iso_z,
    pagination_stop,
    text_fact,
)
from tender_sources.http import API_POLICY, BlockedError, FetchError, PoliteClient
from tender_sources.merge import content_hash
from tender_sources.normalize.dates import parse_date
from tender_sources.normalize.money import parse_money
from tender_sources.normalize.units import parse_quantity
from tender_sources.relevance import derive_categories, score_record
from tender_sources.safety import UnsafeURL

API_BASE = "https://search.worldbank.org/api/v2/procnotices"
NOTICE_URL = "https://projects.worldbank.org/en/projects-operations/procurement-detail/{id}"

AWARD_TYPES = {"contract award"}
INVITATION_HINTS = ("invitation", "request for expression of interest", "request for bids")


def build_api_url(term: str | None, *, country: str | None, rows: int, offset: int) -> str:
    params: list[tuple[str, str]] = [("format", "json")]
    if term:
        params.append(("qterm", term))
    if country:
        params.append(("project_ctry_name_exact", country))
    params += [("rows", str(rows)), ("os", str(offset)), ("srt", "noticedate"), ("order", "desc")]
    return f"{API_BASE}?{urlencode(params)}"


def html_to_text(fragment: str | None) -> str:
    if not fragment:
        return ""
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>|</tr>", "\n", fragment)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text).replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\s*\n\s*", "\n", text).strip()


def parse_notice_date(value: str | None) -> datetime | None:
    """'20-Oct-2026' (API format) or an ISO date/datetime -> aware UTC datetime at 00:00."""
    if not value:
        return None
    text = value.strip()
    for fmt, size in (("%d-%b-%Y", 11), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(text[:size], fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def search_terms(config: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for group in config.get("groups", []):
        for term in group.get("terms", []):
            key = term.strip().lower()
            if key and key not in seen:
                seen.add(key)
                out.append(term.strip())
    return out


_CUE = re.compile(
    r"(?:on or before|no later than|not later than|deadline[^.:\n]{0,50}?(?:is|:)|"
    r"closing date[^.:\n]{0,30}?:|submission (?:date|deadline)[^.:\n]{0,30}?:|"
    r"received (?:on or )?(?:by|before))\s*",
    re.IGNORECASE,
)
_DMY = re.compile(r"(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}),?\s+(\d{4})")
_MDY = re.compile(r"([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})")
_TIME = re.compile(r"(\d{1,2})[:.hH](\d{2})\s*(a\.?m\.?|p\.?m\.?|hours|hrs)?", re.IGNORECASE)
_TZ = re.compile(r"\b(CAT|EAT|WAT|SAST|GMT\s*[+-]\s*\d{1,2}|UTC\s*[+-]\s*\d{1,2}|GMT|UTC)\b")


def extract_deadline(plain: str, retrieved_at: str, source_url: str) -> dict[str, Any] | None:
    """Find a submission deadline sentence in free text. Returns a DateFact dict or None."""
    flat = re.sub(r"\s+", " ", plain)
    for cue in _CUE.finditer(flat):
        window = flat[cue.end() : cue.end() + 140]
        m = _DMY.search(window)
        if m:
            date_text = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        else:
            m = _MDY.search(window)
            if not m:
                continue
            date_text = f"{m.group(1)} {m.group(2)}, {m.group(3)}"
        rest = window[m.end() : m.end() + 60]
        time_match = _TIME.search(rest)
        tz_match = _TZ.search(rest)
        composed = date_text
        if time_match:
            ap = (time_match.group(3) or "").lower().replace(".", "")
            ap = ap if ap in ("am", "pm") else ""
            composed += f" {time_match.group(1)}:{time_match.group(2)} {ap}".rstrip()
            if tz_match:
                composed += " " + re.sub(r"\s+", "", tz_match.group(1))
        quote = flat[
            cue.start() : cue.end() + m.end() + (time_match.end() if time_match else 0) + 12
        ]
        ev = [evidence(source_url, quote.strip(), retrieved_at)]
        fact = parse_date(composed, evidence=ev)
        if fact.get("value") is None:
            continue
        fact["originalText"] = (
            window[: m.end() + (time_match.end() if time_match else 0)].strip()
            or fact["originalText"]
        )
        fact["note"] = (
            "Extracted from the free text of the notice; the API has no structured deadline field."
        )
        return fact
    return None


_PRICE = re.compile(
    r"Signed Contract price\s*:?\s*([A-Z]{3}\s*[\d][\d,]*(?:\.\d+)?)", re.IGNORECASE
)
_QTY = re.compile(
    r"\(?\s*(?:quantity|qty)\s*[:=\-]?\s*\d[\d,]*(?:\s*(?:pcs|pieces|units|sets|pairs|nos?\.?))?\s*\)?|"
    r"\b\d[\d,]*\s*(?:pcs|pieces|units|sets|pairs|nos?\.?)\b",
    re.IGNORECASE,
)


class WorldBankAdapter(SourceAdapter):
    id = "worldbank"
    display_name = "World Bank procurement notices (official open API)"
    access_policy = API_POLICY
    coverage_limitations = (
        (
            "World Bank-financed procurement notices only; this is not all Zambian public tenders "
            "(national, other-donor and non-published tenders are not included)."
        ),
        (
            "Keyword matching is done by the World Bank search API (full-text); notices that do not use "
            "these words are not found, and its exact matching rules are not documented."
        ),
        (
            "Country filter is an exact match on the project country name; regional projects that cover "
            "several countries are not matched."
        ),
        (
            "The API has no structured deadline field; deadlines are read from the notice text and may be "
            "missing, so status 'open' is only claimed when a future deadline was found."
        ),
    )

    # ---- access ---------------------------------------------------------------------------

    def access_check(self, client: PoliteClient) -> AccessStatusResult:
        url = build_api_url(None, country=None, rows=1, offset=0)
        try:
            result = client.get(
                url, ttl=0, headers={"Accept": "application/json"}, policy=API_POLICY
            )
            result.json()
        except BlockedError as exc:
            return AccessStatusResult(ACCESS_BLOCKED, str(exc))
        except (FetchError, UnsafeURL, ValueError) as exc:
            return AccessStatusResult(ACCESS_UNREACHABLE, str(exc))
        return AccessStatusResult(ACCESS_OK, "official JSON API answered")

    # ---- discovery --------------------------------------------------------------------------

    def discover(self, ctx: DiscoverContext) -> Iterator[ListingRef]:
        terms = search_terms(ctx.config)
        countries: list[str | None] = list(ctx.config.get("countries") or []) or [None]
        since_dt = parse_notice_date(ctx.since) if ctx.since else None
        units: dict[str, Any] = ctx.checkpoint.setdefault("units", {})
        rows = ctx.limits.rows_per_page
        yielded: set[str] = set()
        for country in countries:
            for term in terms:
                key = f"{country or '*'}|{term}"
                state = units.setdefault(key, {"pagesDone": 0, "finished": False, "stop": None})
                label = f"{term} ({country})" if country else term
                if state["finished"]:
                    ctx.keywords_searched.append(label)
                    ctx.stop_reasons[label] = str(state["stop"])
                    continue
                ctx.keywords_searched.append(label)
                while True:
                    page = int(state["pagesDone"])
                    if ctx.requests_left() <= 0:
                        ctx.stop_reasons[label] = STOP_REQUEST_CAP
                        ctx.notes.append("Total request cap reached; scan is partial.")
                        return
                    url = build_api_url(term, country=country, rows=rows, offset=page * rows)
                    try:
                        result = ctx.client.get(
                            url, ttl=0, headers={"Accept": "application/json"}, policy=API_POLICY
                        )
                        data = result.json()
                        batch = data["procnotices"]
                        total = int(data.get("total") or 0)
                        if not isinstance(batch, list):
                            raise TypeError("'procnotices' is not a list")
                    except BlockedError:
                        raise
                    except (FetchError, UnsafeURL, ValueError, KeyError, TypeError) as exc:
                        ctx.record_failure(
                            url,
                            "search",
                            str(exc),
                            retryable=bool(getattr(exc, "retryable", False)),
                        )
                        state["stop"] = STOP_FAILED
                        ctx.stop_reasons[label] = STOP_FAILED
                        break
                    ctx.pages_checked += 1
                    dates = [parse_notice_date(r.get("noticedate")) for r in batch]
                    known = [d for d in dates if d is not None]
                    for row, when in zip(batch, dates, strict=True):
                        if since_dt is not None and when is not None and when < since_dt:
                            continue
                        rid = str(row.get("id") or "")
                        if not rid or rid in yielded:
                            continue
                        yielded.add(rid)
                        row = dict(row)
                        row["_apiUrl"] = url
                        yield ListingRef(
                            id=rid,
                            url=NOTICE_URL.format(id=rid),
                            title=row.get("bid_description"),
                            published=row.get("noticedate"),
                            payload=row,
                            keyword=term,
                        )
                    state["pagesDone"] = page + 1
                    stop = pagination_stop(
                        page_index=page,
                        max_pages=ctx.limits.max_pages,
                        rows_returned=len(batch),
                        page_size=rows,
                        oldest_on_page=min(known) if known else None,
                        since=since_dt,
                        has_next_link=(page + 1) * rows < total,
                    )
                    if stop is not None:
                        state["finished"] = True
                        state["stop"] = stop
                        ctx.stop_reasons[label] = stop
                    ctx.on_page_done()
                    if stop is not None:
                        break

    def fetch_detail(self, ctx: DiscoverContext, ref: ListingRef) -> RawNotice:
        # The search API already returns the full notice (including notice_text); no extra request.
        return RawNotice(
            ref=ref,
            data=ref.payload,
            source_url=str(ref.payload.get("_apiUrl") or API_BASE),
            fetched_at=iso_z(),
        )

    # ---- mapping ----------------------------------------------------------------------------

    def to_record(self, raw: RawNotice, config: dict[str, Any], now: datetime) -> dict[str, Any]:
        d = raw.data
        now_iso = iso_z(now)
        retrieved = raw.fetched_at or now_iso
        api_url = raw.source_url
        nid = str(d["id"])
        notice_type = (d.get("notice_type") or "").strip() or None
        ntype = (notice_type or "").lower()
        plain = html_to_text(d.get("notice_text"))
        description = (d.get("bid_description") or "").strip()
        title = (
            description or (d.get("noticetitle") or "").strip() or d.get("bid_reference_no") or nid
        )

        def ev(quote: str | None) -> list[dict[str, Any]]:
            return [evidence(api_url, quote, retrieved)]

        def field_fact(name: str, value: Any) -> dict[str, Any]:
            if value in (None, ""):
                return text_fact(None, status="not_published", note=f"API field '{name}' is empty")
            return text_fact(str(value), status="published", ev=ev(f"{name}: {value}"))

        published = parse_date(
            d.get("noticedate"), evidence=ev(f"noticedate: {d.get('noticedate')}")
        )

        # deadline + status ------------------------------------------------------------------
        is_award = ntype in AWARD_TYPES
        deadline: dict[str, Any]
        if is_award:
            deadline = parse_date(None)
            deadline.update(
                status="not_published", note="Award notice: there is no bid deadline.", evidence=[]
            )
        else:
            found = extract_deadline(plain, retrieved, api_url)
            if found is not None:
                deadline = found
            else:
                deadline = parse_date(None)
                deadline.update(
                    status="could_not_verify",
                    note="No deadline phrase could be read from the notice text; the API has no "
                    "structured deadline field.",
                )
        status = "unknown"
        status_ev: list[dict[str, Any]] = []
        if "cancel" in str(d.get("notice_status") or "").lower():
            status = "cancelled"
            status_ev = ev(f"notice_status: {d.get('notice_status')}")
        elif is_award:
            status = "closed"
            status_ev = ev(f"notice_type: {notice_type} (contract already awarded)")
        elif deadline.get("value") and any(h in ntype for h in INVITATION_HINTS):
            when = datetime.fromisoformat(deadline["value"])
            status = "open" if when > now else "closed"
            status_ev = deadline.get("evidence") or ev(f"notice_type: {notice_type}")

        # values ---------------------------------------------------------------------------------
        estimated = parse_money(None)
        est_amount = str(d.get("bid_estimate_amount") or "").strip()
        currency = (d.get("bid_currency_code") or "").strip()
        if est_amount and est_amount not in ("0", "0.0") and currency:
            estimated = parse_money(
                f"{currency} {est_amount}",
                evidence=ev(f"bid_estimate_amount: {est_amount}; bid_currency_code: {currency}"),
            )
        else:
            estimated.update(status="not_published", note="No estimate in the API record.")

        award = parse_money(None)
        prices = [m.group(1) for m in _PRICE.finditer(plain)] if is_award else []
        if not is_award:
            award.update(status="not_published", note="Not an award notice.")
        elif len(prices) == 1:
            award = parse_money(prices[0], evidence=ev(f"Signed Contract price {prices[0]}"))
        elif len(prices) > 1:
            award.update(
                amount=None,
                status="could_not_verify",
                originalText="; ".join(prices),
                evidence=[
                    evidence(api_url, f"Signed Contract price {p}", retrieved) for p in prices
                ],
                note=f"{len(prices)} signed contract prices (lots or bidders); they are not summed.",
            )
        else:
            award.update(
                status="could_not_verify",
                note="No 'Signed Contract price' found in the notice text.",
            )

        # items (best effort, always needsReview) ------------------------------------------------
        items: list[dict[str, Any]] = []
        if description and d.get("procurement_group") == "GO":
            qm = _QTY.search(description)
            quantity = parse_quantity(qm.group(0).strip(" ()")) if qm else None
            items.append(
                {
                    "description": description,
                    "quantity": {
                        "value": quantity["value"] if quantity else None,
                        "originalText": quantity["originalText"] if quantity else None,
                    },
                    "unit": quantity["unit"] if quantity else None,
                    "evidence": ev(description),
                    "needsReview": True,
                }
            )

        config_for_score = {k: v for k, v in config.items() if k != "publishedSince"}
        scope = description
        if is_award:
            m = re.search(r"Scope of Contract:\s*(.+)", plain)
            if m:
                scope = f"{description}. {m.group(1).strip()}"
        relevance = score_record(
            title=title,
            description=scope or None,
            item_texts=[i["description"] for i in items],
            config=config_for_score,
        )

        record: dict[str, Any] = {
            "schemaVersion": 2,
            "source": self.id,
            "sourceRecordId": nid,
            "canonicalUrl": NOTICE_URL.format(id=nid),
            "reference": field_fact("bid_reference_no", d.get("bid_reference_no")),
            "title": title,
            "buyer": field_fact("agency_name", d.get("agency_name")),
            "country": field_fact("project_ctry_name", d.get("project_ctry_name")),
            "publishedAt": published,
            "deadline": deadline,
            "status": status,
            "statusEvidence": status_ev,
            "noticeType": notice_type,
            "noticeVersion": str(d["notice_version_no"]) if d.get("notice_version_no") else None,
            "categories": derive_categories(relevance),
            "relevance": relevance,
            "scopeOfSupply": text_fact(
                scope or None,
                status="published" if scope else "could_not_verify",
                ev=ev(description),
            ),
            "items": items,
            "estimatedValue": estimated,
            "awardValue": award,
            "documents": [],
            "accessLimitations": list(raw.access_limitations),
            "firstSeenAt": now_iso,
            "lastCheckedAt": now_iso,
            "lastUpdatedAt": str(d.get("api_modified_date") or now_iso),
        }
        record["contentHash"] = content_hash(record)
        return record
