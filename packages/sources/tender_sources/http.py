"""PoliteClient: the ONLY place a Scrapling fetcher is constructed (CLAUDE.md rule 2a).

Honest configuration, always: ``impersonate=None``, ``stealthy_headers=False`` and our own
User-Agent (Scrapling's defaults would send a fake Windows-Chrome UA and a fake Google referer).
No stealth fetchers, no CAPTCHA/Cloudflare solving, and no proxies.

Behaviour
  * per-domain policy: one request at a time, random min..max delay between requests
    (HTML sites 3-8 s, official APIs may use >= 1 s); the floor cannot be lowered for non-local hosts;
  * timeout 30 s, up to 3 retries with exponential backoff + jitter on network errors / 5xx / 429
    (``Retry-After`` honoured, capped); a 403 or a Cloudflare/bot challenge is NEVER retried and raises
    :class:`BlockedError` (a plain 403 raises :class:`HttpStatusError`);
  * robots.txt is obeyed (cached per host);
  * every URL and every redirect hop is validated by :mod:`tender_sources.safety`;
  * on-disk cache with TTL and ETag / Last-Modified revalidation (cache hits skip network + delay).
"""

from __future__ import annotations

import hashlib
import os
import random
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Protocol, Self
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from tender_sources.cache import CacheEntry, DiskCache
from tender_sources.safety import Resolver, UnsafeURL, validate_url

DEFAULT_UA = "tender-monitor/0.1 (+research; contact: set TENDER_SOURCES_CONTACT)"
TIMEOUT_SECONDS = 30.0
MAX_RETRIES = 3
MAX_REDIRECTS = 5
RETRY_AFTER_CAP = 60.0
BACKOFF_BASE = 2.0
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
DEFAULT_DOCUMENT_TYPES = ("application/pdf",)
ROBOTS_TTL = 24 * 3600.0
DEFAULT_CACHE_TTL = 600.0

_FORBIDDEN_HEADERS = ("user-agent", "referer", "origin", "cookie")
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


# --------------------------------------------------------------------------- errors


class FetchError(Exception):
    """Base class for fetch failures. ``retryable`` tells the scan report whether a rerun may help."""

    retryable = False

    def __init__(self, url: str, message: str) -> None:
        super().__init__(message)
        self.url = url


class BlockedError(FetchError):
    """A bot challenge / block. Never retried, never worked around: the source is 'blocked'."""

    def __init__(self, url: str, status: int, evidence: str) -> None:
        super().__init__(url, f"blocked by bot challenge (HTTP {status}): {evidence}")
        self.status = status
        self.evidence = evidence


class RobotsDisallowed(FetchError):
    pass


class HttpStatusError(FetchError):
    def __init__(self, url: str, status: int, *, retryable: bool = False) -> None:
        super().__init__(url, f"HTTP {status} for {url}")
        self.status = status
        self.retryable = retryable


class NetworkError(FetchError):
    retryable = True


class DocumentRejected(FetchError):
    """A linked document violated a limit (type, size) and was not kept."""

    def __init__(self, url: str, reason: str, message: str) -> None:
        super().__init__(url, message)
        self.reason = reason  # 'too_large' | 'wrong_type'


class TransportError(Exception):
    """Raised by a Transport for connection-level failures (DNS, TLS, timeout, reset)."""


# --------------------------------------------------------------------------- policy


@dataclass(frozen=True)
class AccessPolicy:
    """Delay policy for a domain. Concurrency is always 1."""

    min_delay: float = 3.0
    max_delay: float = 8.0
    kind: str = "html"  # 'html' (floor 3 s) or 'api' (floor 1 s)

    @property
    def floor(self) -> float:
        return 1.0 if self.kind == "api" else 3.0


HTML_POLICY = AccessPolicy(3.0, 8.0, "html")
API_POLICY = AccessPolicy(1.0, 2.0, "api")


def honest_user_agent() -> str:
    ua = os.environ.get("TENDER_SOURCES_UA") or DEFAULT_UA
    contact = os.environ.get("TENDER_SOURCES_CONTACT")
    if contact:
        ua = ua.replace("set TENDER_SOURCES_CONTACT", contact)
    return ua


# --------------------------------------------------------------------------- results


@dataclass
class RawResponse:
    status: int
    headers: dict[str, str]  # lower-case names
    body: bytes
    url: str = ""


@dataclass
class FetchResult:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    from_cache: bool
    fetched_at: str
    _page: Any = field(default=None, repr=False, compare=False)

    @property
    def text(self) -> str:
        charset = "utf-8"
        m = re.search(r"charset=([\w\-]+)", self.headers.get("content-type", ""), re.IGNORECASE)
        if m:
            charset = m.group(1)
        try:
            return self.body.decode(charset, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")

    @property
    def page(self) -> Any:
        """Scrapling ``Selector`` over the body (parsing only; no fetching)."""
        if self._page is None:
            from scrapling.parser import Selector

            self._page = Selector(content=self.text, url=self.url)
        return self._page

    def json(self) -> Any:
        import json

        return json.loads(self.body.decode("utf-8", errors="replace"))


@dataclass
class DocumentResult:
    url: str
    content_type: str
    data: bytes
    sha256: str
    size: int
    fetched_at: str


# --------------------------------------------------------------------------- transport


class Transport(Protocol):
    def get(
        self, url: str, *, headers: Mapping[str, str], timeout: float, max_bytes: int | None = None
    ) -> RawResponse: ...

    def close(self) -> None: ...


class ScraplingTransport:
    """The single place that constructs a Scrapling fetcher session. Honest settings only."""

    def __init__(self, user_agent: str) -> None:
        self.user_agent = user_agent
        self._session_cm: Any = None
        self._session: Any = None

    def _open(self) -> Any:
        if self._session is None:
            import logging

            from scrapling.fetchers import FetcherSession

            logging.getLogger("scrapling").setLevel(logging.WARNING)

            self._session_cm = FetcherSession(
                impersonate=None,
                stealthy_headers=False,
                headers={"User-Agent": self.user_agent},
                timeout=TIMEOUT_SECONDS,
                retries=1,  # our own retry loop does the retrying (and never retries 403)
                follow_redirects=False,  # we follow redirects ourselves and validate every hop
            )
            self._session = self._session_cm.__enter__()
        return self._session

    def get(
        self, url: str, *, headers: Mapping[str, str], timeout: float, max_bytes: int | None = None
    ) -> RawResponse:
        # max_bytes: Scrapling buffers the whole body and offers no size cap, so the limit is enforced
        # by get_document() after the read (Content-Length first, then the real length).
        try:
            resp = self._open().get(
                url, headers=dict(headers), timeout=timeout, follow_redirects=False
            )
        except Exception as exc:  # curl errors, timeouts, TLS...
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        hdrs = {str(k).lower(): str(v) for k, v in dict(resp.headers).items()}
        return RawResponse(status=int(resp.status), headers=hdrs, body=bytes(resp.body), url=url)

    def close(self) -> None:
        if self._session_cm is not None:
            try:
                self._session_cm.__exit__(None, None, None)
            finally:
                self._session_cm = None
                self._session = None


class FakeTransport:
    """Test transport: ``handler(url, headers) -> RawResponse`` (or an Exception to raise)."""

    def __init__(
        self, handler: Callable[[str, Mapping[str, str]], RawResponse | Exception]
    ) -> None:
        self.handler = handler
        self.calls: list[tuple[str, dict[str, str]]] = []

    def get(
        self, url: str, *, headers: Mapping[str, str], timeout: float, max_bytes: int | None = None
    ) -> RawResponse:
        self.calls.append((url, dict(headers)))
        out = self.handler(url, headers)
        if isinstance(out, Exception):
            raise out
        return out

    def close(self) -> None:
        return None


# --------------------------------------------------------------------------- challenge detection

_CHALLENGE_BODY = re.compile(
    r"just a moment\.\.\.|verify (?:that )?you are (?:a )?human|are you a robot|captcha|"
    r"cf-chl|challenge-platform|attention required|checking your browser|access denied",
    re.IGNORECASE,
)
_CHALLENGE_TITLE = re.compile(
    r"<title>\s*(just a moment\.\.\.|attention required[^<]*)\s*</title>", re.IGNORECASE
)


def detect_challenge(status: int, headers: Mapping[str, str], body: bytes) -> str | None:
    """Return an evidence snippet if the response is a bot challenge / block, else None."""
    mitigated = headers.get("cf-mitigated", "")
    if "challenge" in mitigated.lower():
        return f"cf-mitigated: {mitigated}"
    text = body[:200_000].decode("utf-8", errors="replace")
    title = _CHALLENGE_TITLE.search(text)
    if title:
        return f"page title: {title.group(1)}"
    if status in (403, 429, 503):
        m = _CHALLENGE_BODY.search(text)
        if m:
            start = max(0, m.start() - 60)
            return re.sub(r"\s+", " ", text[start : m.end() + 60]).strip()[:200]
    return None


def _parse_retry_after(value: str | None, now: datetime | None = None) -> float | None:
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - (now or datetime.now(UTC))).total_seconds())


# --------------------------------------------------------------------------- client


class PoliteClient:
    def __init__(
        self,
        *,
        transport: Transport | None = None,
        cache: DiskCache | None = None,
        user_agent: str | None = None,
        allow_hosts: Iterable[str] = (),
        resolver: Resolver | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
        default_ttl: float = DEFAULT_CACHE_TTL,
        respect_robots: bool = True,
        test_mode: bool = False,
    ) -> None:
        self.user_agent = user_agent or honest_user_agent()
        self.transport: Transport = transport or ScraplingTransport(self.user_agent)
        self.cache = cache if cache is not None else DiskCache()
        self.allow_hosts = tuple(h.lower() for h in allow_hosts)
        self.resolver = resolver
        self._sleep = sleep
        self._clock = clock
        self._rng = rng or random.Random()
        self.default_ttl = default_ttl
        self.respect_robots = respect_robots
        self.test_mode = test_mode  # fake transport: delay floors are not enforced
        self.request_count = 0
        self._last_request: dict[str, float] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._robots: dict[str, tuple[RobotFileParser | None, str | None]] = {}

    @classmethod
    def for_testing(
        cls, transport: Transport, *, cache: DiskCache | None = None, **kwargs: Any
    ) -> PoliteClient:
        """Client over a fake transport; no network, floors off, sleeps injectable."""
        kwargs.setdefault("sleep", lambda _s: None)
        kwargs.setdefault("respect_robots", False)
        return cls(transport=transport, cache=cache, test_mode=True, **kwargs)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self.transport.close()

    # ---- politeness -------------------------------------------------------------------------

    def _lock_for(self, host: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(host, threading.Lock())

    def effective_delay_bounds(self, host: str, policy: AccessPolicy) -> tuple[float, float]:
        """Apply the non-lowerable floor. Only loopback hosts may go faster, and only with
        ``TENDER_SOURCES_ALLOW_FAST=1`` (or inside tests that use a fake transport)."""
        lo, hi = policy.min_delay, policy.max_delay
        fast_ok = self.test_mode or (
            os.environ.get("TENDER_SOURCES_ALLOW_FAST") == "1" and host in _LOCAL_HOSTS
        )
        if not fast_ok:
            lo = max(lo, policy.floor)
        return lo, max(hi, lo)

    def _wait_turn(self, host: str, policy: AccessPolicy) -> None:
        last = self._last_request.get(host)
        if last is None:
            return
        lo, hi = self.effective_delay_bounds(host, policy)
        wanted = self._rng.uniform(lo, hi)
        remaining = wanted - (self._clock() - last)
        if remaining > 0:
            self._sleep(remaining)

    # ---- low level request -------------------------------------------------------------------

    def _headers(self, extra: Mapping[str, str] | None) -> dict[str, str]:
        headers = {"User-Agent": self.user_agent}
        for name, value in (extra or {}).items():
            lname = name.lower()
            if lname in _FORBIDDEN_HEADERS or lname.startswith("sec-"):
                raise ValueError(f"header {name!r} is not allowed (honest requests only)")
            headers[name] = value
        return headers

    def _validate(self, url: str) -> None:
        validate_url(url, allow_hosts=self.allow_hosts, resolver=self.resolver)

    def _request_hops(
        self,
        url: str,
        headers: dict[str, str],
        policy: AccessPolicy,
        check_robots: bool,
        max_bytes: int | None,
    ) -> RawResponse:
        current = url
        for hop in range(MAX_REDIRECTS + 1):
            self._validate(current)
            if check_robots and hop > 0:
                self._enforce_robots(current)
            host = (urlsplit(current).hostname or "").lower()
            with self._lock_for(host):
                self._wait_turn(host, policy)
                self.request_count += 1
                try:
                    raw = self.transport.get(
                        current,
                        headers=headers if hop == 0 else {"User-Agent": self.user_agent},
                        timeout=TIMEOUT_SECONDS,
                        max_bytes=max_bytes,
                    )
                finally:
                    self._last_request[host] = self._clock()
            location = raw.headers.get("location")
            if raw.status in (301, 302, 303, 307, 308) and location:
                current = urljoin(current, location)
                continue
            raw.url = current
            return raw
        raise HttpStatusError(url, 310, retryable=False)  # too many redirects

    def _network_get(
        self,
        url: str,
        headers: dict[str, str],
        policy: AccessPolicy,
        check_robots: bool,
        max_bytes: int | None = None,
    ) -> RawResponse:
        """One logical request with retries. Raises BlockedError / FetchError subclasses."""
        attempt = 0
        while True:
            attempt += 1
            last_try = attempt > MAX_RETRIES
            try:
                raw = self._request_hops(url, headers, policy, check_robots, max_bytes)
            except (UnsafeURL, RobotsDisallowed, BlockedError):
                raise
            except TransportError as exc:
                if last_try:
                    raise NetworkError(
                        url, f"network error after {attempt} attempts: {exc}"
                    ) from exc
                self._backoff(attempt, None)
                continue
            evidence = detect_challenge(raw.status, raw.headers, raw.body)
            if evidence is not None:
                raise BlockedError(url, raw.status, evidence)  # never retried
            if raw.status == 429 or raw.status >= 500:
                if last_try:
                    raise HttpStatusError(url, raw.status, retryable=True)
                self._backoff(attempt, raw.headers.get("retry-after"))
                continue
            return raw

    def _backoff(self, attempt: int, retry_after: str | None) -> None:
        wait = min(RETRY_AFTER_CAP, BACKOFF_BASE * (2 ** (attempt - 1))) + self._rng.uniform(0, 1)
        hinted = _parse_retry_after(retry_after)
        if hinted is not None:
            wait = max(wait, min(hinted, RETRY_AFTER_CAP))
        self._sleep(wait)

    # ---- robots -------------------------------------------------------------------------------

    def _enforce_robots(self, url: str) -> None:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            self._robots[origin] = self._load_robots(origin)
        parser, problem = self._robots[origin]
        if problem is not None:
            raise RobotsDisallowed(url, f"robots.txt: {problem}")
        assert parser is not None
        token = self.user_agent.split("/", 1)[0].split()[0]
        if not parser.can_fetch(token, url):
            raise RobotsDisallowed(url, f"robots.txt of {origin} disallows {parts.path or '/'}")

    def _load_robots(self, origin: str) -> tuple[RobotFileParser | None, str | None]:
        robots_url = f"{origin}/robots.txt"
        parser = RobotFileParser()
        try:
            result = self._get(
                robots_url, ttl=ROBOTS_TTL, extra_headers=None, policy=HTML_POLICY,
                check_robots=False, raise_for_status=False,
            )  # fmt: skip
        except BlockedError:
            raise
        except (FetchError, UnsafeURL) as exc:
            return None, f"could not be fetched ({exc}); treating as disallowed"
        if result.status == 200:
            parser.parse(result.text.splitlines())
            return parser, None
        if result.status in (401, 403):
            return None, f"HTTP {result.status}; treating as disallow-all"
        parser.parse([])  # 404 and other 4xx: no restrictions published
        return parser, None

    # ---- public API ---------------------------------------------------------------------------

    def get(
        self,
        url: str,
        *,
        ttl: float | None = None,
        headers: Mapping[str, str] | None = None,
        policy: AccessPolicy = HTML_POLICY,
    ) -> FetchResult:
        """GET with politeness, robots, SSRF checks, caching. Raises on HTTP status >= 400."""
        return self._get(
            url, ttl=self.default_ttl if ttl is None else ttl, extra_headers=headers,
            policy=policy, check_robots=self.respect_robots, raise_for_status=True,
        )  # fmt: skip

    def _get(
        self,
        url: str,
        *,
        ttl: float,
        extra_headers: Mapping[str, str] | None,
        policy: AccessPolicy,
        check_robots: bool,
        raise_for_status: bool,
        use_cache: bool = True,
    ) -> FetchResult:
        self._validate(url)
        headers = self._headers(extra_headers)
        entry: CacheEntry | None = self.cache.get(url) if use_cache else None
        if entry is not None and entry.status == 200 and entry.is_fresh(ttl):
            return FetchResult(url, entry.status, entry.headers, entry.body, True, entry.fetched_at)
        if check_robots:
            self._enforce_robots(url)
        if entry is not None and entry.status == 200:
            headers = {**headers, **entry.validators}
        raw = self._network_get(url, headers, policy, check_robots)
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        if raw.status == 304 and entry is not None:
            refreshed = self.cache.touch(entry, now)
            return FetchResult(url, 200, refreshed.headers, refreshed.body, True, now)
        if (
            raw.status == 200
            and use_cache
            and "no-store" not in raw.headers.get("cache-control", "")
        ):
            self.cache.put(url, status=200, headers=raw.headers, body=raw.body, fetched_at=now)
        result = FetchResult(url, raw.status, raw.headers, raw.body, False, now)
        if raise_for_status and raw.status >= 400:
            raise HttpStatusError(url, raw.status, retryable=False)
        return result

    def get_document(
        self,
        url: str,
        *,
        max_bytes: int = MAX_DOCUMENT_BYTES,
        allowed_types: tuple[str, ...] = DEFAULT_DOCUMENT_TYPES,
        policy: AccessPolicy = HTML_POLICY,
    ) -> DocumentResult:
        """Download a linked document within size/type limits. Not cached on disk."""
        self._validate(url)
        headers = self._headers(None)
        if self.respect_robots:
            self._enforce_robots(url)
        raw = self._network_get(url, headers, policy, self.respect_robots, max_bytes=max_bytes)
        if raw.status >= 400:
            raise HttpStatusError(url, raw.status, retryable=False)
        declared = raw.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > max_bytes:
            raise DocumentRejected(url, "too_large", f"Content-Length {declared} > {max_bytes}")
        if len(raw.body) > max_bytes:
            raise DocumentRejected(url, "too_large", f"body {len(raw.body)} bytes > {max_bytes}")
        ctype = raw.headers.get("content-type", "").split(";")[0].strip().lower()
        allowed = tuple(t.lower() for t in allowed_types)
        pdf_sniffed = (
            ctype in ("application/octet-stream", "binary/octet-stream", "")
            and "application/pdf" in allowed
            and raw.body[:5] == b"%PDF-"
        )
        if ctype not in allowed and not pdf_sniffed:
            raise DocumentRejected(url, "wrong_type", f"content type {ctype!r} not in {allowed}")
        if pdf_sniffed:
            ctype = "application/pdf"
        return DocumentResult(
            url=raw.url or url,
            content_type=ctype,
            data=raw.body,
            sha256=hashlib.sha256(raw.body).hexdigest(),
            size=len(raw.body),
            fetched_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
