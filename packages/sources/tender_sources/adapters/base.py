"""SourceAdapter contract + shared helpers (pagination stop rules, evidence/fact builders)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from tender_sources.http import HTML_POLICY, AccessPolicy, PoliteClient

# AccessStatus values (mirror packages/shared/src/record.ts)
ACCESS_OK = "ok"
ACCESS_LOGIN_REQUIRED = "login_required"
ACCESS_BLOCKED = "blocked_by_challenge"
ACCESS_UNCONFIGURED = "unconfigured"
ACCESS_UNREACHABLE = "unreachable"
ACCESS_STATUSES = (
    ACCESS_OK,
    ACCESS_LOGIN_REQUIRED,
    ACCESS_BLOCKED,
    ACCESS_UNCONFIGURED,
    ACCESS_UNREACHABLE,
)

# Pagination stop reasons (reported per keyword in the scan report)
STOP_MAX_PAGES = "max_pages"
STOP_EMPTY_PAGE = "empty_page"
STOP_SHORT_PAGE = "short_page"
STOP_OLDER_THAN_SINCE = "older_than_since"
STOP_NO_NEXT_LINK = "no_next_link"
STOP_REQUEST_CAP = "request_cap"
STOP_FAILED = "failed"


class AdapterNotReady(RuntimeError):
    """The adapter has no extraction rules yet (waiting for saved fixtures). Never guess selectors."""


@dataclass
class AccessStatusResult:
    status: str
    detail: str = ""


@dataclass
class ListingRef:
    id: str
    url: str
    title: str | None = None
    published: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)  # raw listing row from the source
    keyword: str | None = None


@dataclass
class RawNotice:
    ref: ListingRef
    data: dict[str, Any]
    source_url: str
    fetched_at: str
    access_limitations: list[str] = field(default_factory=list)


@dataclass
class DocLink:
    url: str
    title: str | None = None


@dataclass
class Limits:
    max_pages: int = 5  # per keyword (hard cap; CLAUDE.md rule 1 default for HTML sites is 2)
    max_requests: int = 400  # total network requests per scan
    rows_per_page: int = 50


@dataclass
class DiscoverContext:
    client: PoliteClient
    config: dict[str, Any]
    since: str | None = None
    checkpoint: dict[str, Any] = field(default_factory=dict)
    limits: Limits = field(default_factory=Limits)
    # filled in by adapters, read by the scan engine
    pages_checked: int = 0
    keywords_searched: list[str] = field(default_factory=list)
    stop_reasons: dict[str, str] = field(default_factory=dict)
    failures: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # called by the adapter after each fully processed page (engine persists the checkpoint)
    on_page_done: Callable[[], None] = lambda: None

    def requests_left(self) -> int:
        return self.limits.max_requests - self.client.request_count

    def record_failure(
        self, url: str | None, stage: str, error: str, *, retryable: bool = False
    ) -> None:
        self.failures.append({"url": url, "stage": stage, "error": error, "retryable": retryable})


class SourceAdapter(ABC):
    id: str
    display_name: str
    access_policy: AccessPolicy = HTML_POLICY
    #: Plain-language limits that go into every report from this adapter.
    coverage_limitations: tuple[str, ...] = ()

    @abstractmethod
    def access_check(self, client: PoliteClient) -> AccessStatusResult: ...

    @abstractmethod
    def discover(self, ctx: DiscoverContext) -> Iterator[ListingRef]: ...

    @abstractmethod
    def fetch_detail(self, ctx: DiscoverContext, ref: ListingRef) -> RawNotice: ...

    @abstractmethod
    def to_record(
        self, raw: RawNotice, config: dict[str, Any], now: datetime
    ) -> dict[str, Any]: ...

    def document_links(self, raw: RawNotice) -> list[DocLink]:
        """Links to tender documents worth fetching (default: none)."""
        return []


# --------------------------------------------------------------------------- helpers


def iso_z(moment: datetime | None = None) -> str:
    return (moment or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def pagination_stop(
    *,
    page_index: int,
    max_pages: int,
    rows_returned: int,
    page_size: int,
    oldest_on_page: datetime | None = None,
    since: datetime | None = None,
    has_next_link: bool | None = None,
) -> str | None:
    """Decide whether to stop paging AFTER processing page ``page_index`` (0-based).

    Returns the stop reason or ``None`` to continue. Order matters: the most informative reason wins.
    """
    if rows_returned == 0:
        return STOP_EMPTY_PAGE
    if since is not None and oldest_on_page is not None and oldest_on_page < since:
        return STOP_OLDER_THAN_SINCE
    if has_next_link is False:
        return STOP_NO_NEXT_LINK
    if rows_returned < page_size:
        return STOP_SHORT_PAGE
    if page_index + 1 >= max_pages:
        return STOP_MAX_PAGES
    return None


def evidence(source_url: str, quote: str | None, retrieved_at: str, **extra: Any) -> dict[str, Any]:
    ev: dict[str, Any] = {
        "sourceUrl": source_url,
        "quote": quote[:600] if quote else None,
        "page": extra.get("page"),
        "documentUrl": extra.get("documentUrl"),
        "retrievedAt": retrieved_at,
    }
    return ev


def text_fact(
    value: str | None,
    *,
    status: str | None = None,
    ev: list[dict[str, Any]] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    if status is None:
        status = "published" if value else "could_not_verify"
    return {"value": value or None, "status": status, "evidence": ev or [], "note": note}
