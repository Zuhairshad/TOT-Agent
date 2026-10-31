"""TendersOnTime: HONEST, GUARDED adapter. No extraction rules exist yet.

Live finding (2026-10-31): plain requests to https://www.tendersontime.com/ are answered with HTTP 403,
``cf-mitigated: challenge`` and a Cloudflare "Just a moment..." page. CLAUDE.md rule 2/2a forbids
working around that, so this adapter:

  * ``access_check()`` makes ONE polite request to the home page and reports ``blocked_by_challenge``
    when a challenge answers (and ``unconfigured`` while ``SITE_CONFIGURED`` is False);
  * ``discover`` / ``fetch_detail`` / ``to_record`` raise :class:`AdapterNotReady`: selectors are only
    ever written against saved fixtures that a human captured (docs/runbook.md), never guessed;
  * authorised access is supported ONLY through the demo-account env vars ``TOT_EMAIL`` /
    ``TOT_PASSWORD``; nothing here is hard-coded and the framework never needs them to run.

The structure below is what future fixture-driven code plugs into: ``build_search_url``,
``parse_listing``, ``parse_detail`` and ``mark_login_required``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from tender_sources.adapters.base import (
    ACCESS_BLOCKED,
    ACCESS_OK,
    ACCESS_UNCONFIGURED,
    ACCESS_UNREACHABLE,
    AccessStatusResult,
    AdapterNotReady,
    DiscoverContext,
    ListingRef,
    RawNotice,
    SourceAdapter,
)
from tender_sources.http import HTML_POLICY, BlockedError, FetchError, PoliteClient
from tender_sources.safety import UnsafeURL

BASE_URL = "https://www.tendersontime.com/"

#: Flip to True only after a human has captured fixtures and the notes in docs/runbook.md exist.
SITE_CONFIGURED = False

LOGIN_LIMITATION = (
    "Details of this notice need a TendersOnTime login; only the public listing text was read."
)


def credentials_from_env() -> tuple[str, str] | None:
    """Demo-account credentials, from env only. Returns None when not provided (never an error)."""
    email, password = os.environ.get("TOT_EMAIL"), os.environ.get("TOT_PASSWORD")
    return (email, password) if email and password else None


class TendersOnTimeAdapter(SourceAdapter):
    id = "tendersontime"
    display_name = "TendersOnTime (guarded: Cloudflare challenge on plain requests)"
    access_policy = HTML_POLICY
    coverage_limitations = (
        (
            "TendersOnTime answers plain automated requests with a Cloudflare challenge; this source "
            "is not scanned and no tenders from it are included."
        ),
    )

    # ---- access ---------------------------------------------------------------------------

    def access_check(self, client: PoliteClient) -> AccessStatusResult:
        try:
            result = client.get(BASE_URL, ttl=0, policy=self.access_policy)
        except BlockedError as exc:
            return AccessStatusResult(ACCESS_BLOCKED, f"{exc.status}: {exc.evidence}")
        except (FetchError, UnsafeURL) as exc:
            return AccessStatusResult(ACCESS_UNREACHABLE, str(exc))
        if not SITE_CONFIGURED:
            return AccessStatusResult(
                ACCESS_UNCONFIGURED,
                f"home page answered HTTP {result.status} but extraction rules are not written yet "
                "(waiting for saved fixtures)",
            )
        return AccessStatusResult(ACCESS_OK, f"home page answered HTTP {result.status}")

    # ---- structure future code plugs into --------------------------------------------------

    def build_search_url(self, keyword: str, page: int) -> str:
        # TODO(site-notes): the real search URL pattern is unknown. Fill it in from docs/runbook.md
        # once a human has captured the search page; do not guess it.
        raise AdapterNotReady("search URL pattern unknown: waiting for site notes and fixtures")

    def parse_listing(self, page: Any) -> list[ListingRef]:
        """Hook driven by a saved listing fixture (Scrapling Selector in, ListingRef list out)."""
        raise AdapterNotReady("no listing selectors: waiting for a saved fixture")

    def parse_detail(self, page: Any, ref: ListingRef) -> dict[str, Any]:
        """Hook driven by a saved detail fixture."""
        raise AdapterNotReady("no detail selectors: waiting for a saved fixture")

    @staticmethod
    def mark_login_required(record: dict[str, Any]) -> dict[str, Any]:
        """Detail pages that need a login: say so and never present a guess as a fact."""
        limits = list(record.get("accessLimitations") or [])
        if LOGIN_LIMITATION not in limits:
            limits.append(LOGIN_LIMITATION)
        record["accessLimitations"] = limits
        for name in ("deadline", "estimatedValue", "awardValue", "tenderFee", "bidSecurity"):
            fact = record.get(name)
            if isinstance(fact, dict) and fact.get("status") != "published":
                fact["status"] = "could_not_verify"
                fact["note"] = LOGIN_LIMITATION
        return record

    # ---- not ready ------------------------------------------------------------------------

    def discover(self, ctx: DiscoverContext) -> Iterator[ListingRef]:
        raise AdapterNotReady("tendersontime has no extraction rules yet (no fixtures)")

    def fetch_detail(self, ctx: DiscoverContext, ref: ListingRef) -> RawNotice:
        raise AdapterNotReady("tendersontime has no extraction rules yet (no fixtures)")

    def to_record(self, raw: RawNotice, config: dict[str, Any], now: datetime) -> dict[str, Any]:
        raise AdapterNotReady("tendersontime has no extraction rules yet (no fixtures)")
