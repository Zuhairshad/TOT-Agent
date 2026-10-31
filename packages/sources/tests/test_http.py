"""PoliteClient behaviour over a fake transport; honest headers over a real local server."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path

import pytest
from test_http_support import EchoServer, make_client, resolver, resp

from tender_sources.cache import DiskCache
from tender_sources.http import (
    API_POLICY,
    HTML_POLICY,
    AccessPolicy,
    BlockedError,
    DocumentRejected,
    FetchResult,
    HttpStatusError,
    NetworkError,
    PoliteClient,
    RawResponse,
    TransportError,
    detect_challenge,
    honest_user_agent,
)
from tender_sources.safety import UnsafeURL

FIXTURES = Path(__file__).parent / "fixtures"
NO_DELAY = AccessPolicy(0.0, 0.0)


# ----------------------------------------------------------------------- retries / backoff


def test_503_then_success_is_retried_with_backoff(tmp_path: Path) -> None:
    answers = iter([resp("busy", 503), resp("busy", 503), resp("fine")])
    client, transport, sleeps = make_client(lambda u, h: next(answers), tmp_path)
    assert client.get("https://example.test/a", policy=NO_DELAY).text == "fine"
    assert len(transport.calls) == 3
    assert len(sleeps) == 2 and sleeps[1] > sleeps[0]  # exponential: ~2 s then ~4 s
    assert 2 <= sleeps[0] <= 3 and 4 <= sleeps[1] <= 5


def test_retry_gives_up_after_three_retries(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: resp("x", 502), tmp_path)
    with pytest.raises(HttpStatusError) as err:
        client.get("https://example.test/a", policy=NO_DELAY)
    assert err.value.status == 502 and err.value.retryable
    assert len(transport.calls) == 4  # first try + 3 retries


def test_network_errors_are_retried_then_raise(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: TransportError("reset"), tmp_path)
    with pytest.raises(NetworkError):
        client.get("https://example.test/a", policy=NO_DELAY)
    assert len(transport.calls) == 4


def test_429_honours_retry_after_with_cap(tmp_path: Path) -> None:
    answers = iter(
        [
            resp("slow", 429, {"Retry-After": "7"}),
            resp("slow", 429, {"Retry-After": "9999"}),
            resp("ok"),
        ]
    )
    client, _, sleeps = make_client(lambda u, h: next(answers), tmp_path)
    assert client.get("https://example.test/a", policy=NO_DELAY).text == "ok"
    assert max(sleeps) <= 61 and any(s >= 7 for s in sleeps)


def test_plain_404_is_not_retried(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: resp("gone", 404), tmp_path)
    with pytest.raises(HttpStatusError) as err:
        client.get("https://example.test/a")
    assert err.value.status == 404 and not err.value.retryable
    assert len(transport.calls) == 1


# ----------------------------------------------------------------------- challenges


def _challenge() -> RawResponse:
    data = json.loads((FIXTURES / "tendersontime" / "challenge_response.json").read_text())
    return RawResponse(status=data["status"], headers=data["headers"], body=data["body"].encode())


def test_403_challenge_raises_blocked_and_is_never_retried(tmp_path: Path) -> None:
    client, transport, sleeps = make_client(lambda u, h: _challenge(), tmp_path)
    with pytest.raises(BlockedError) as err:
        client.get("https://example.test/")
    assert err.value.status == 403
    assert (
        "challenge" in err.value.evidence.lower() or "just a moment" in err.value.evidence.lower()
    )
    assert len(transport.calls) == 1
    assert sleeps == []


def test_plain_403_is_an_error_not_retried(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: resp("Forbidden", 403), tmp_path)
    with pytest.raises(HttpStatusError) as err:
        client.get("https://example.test/")
    assert err.value.status == 403 and not err.value.retryable
    assert len(transport.calls) == 1


@pytest.mark.parametrize(
    ("status", "headers", "body", "expected"),
    [
        (403, {"cf-mitigated": "challenge"}, b"", True),
        (429, {"cf-mitigated": "challenge"}, b"", True),
        (200, {}, b"<html><title>Just a moment...</title></html>", True),
        (403, {}, b"Please verify you are human", True),
        (403, {}, b"<h1>Complete the CAPTCHA</h1>", True),
        (503, {}, b"Checking your browser before accessing", True),
        (200, {}, b"<p>Our tender mentions a captcha-free portal</p>", False),
        (404, {}, b"not found", False),
        (200, {}, b'{"procnotices": []}', False),
    ],
)
def test_challenge_detection(
    status: int, headers: Mapping[str, str], body: bytes, expected: bool
) -> None:
    assert (detect_challenge(status, headers, body) is not None) is expected


# ----------------------------------------------------------------------- politeness


def test_delay_between_requests_to_same_host_is_random_3_to_8(tmp_path: Path) -> None:
    client, _, sleeps = make_client(lambda u, h: resp("x"), tmp_path)
    client._clock = lambda: 100.0  # time never advances: the whole delay must be slept
    for i in range(8):
        client.get(f"https://example.test/p{i}", ttl=0)
    assert len(sleeps) == 7  # none before the first request
    assert all(3.0 <= s <= 8.0 for s in sleeps)
    assert len(set(sleeps)) > 1  # random, not constant


def test_elapsed_time_counts_towards_the_delay(tmp_path: Path) -> None:
    now = [0.0]
    client, _, sleeps = make_client(lambda u, h: resp("x"), tmp_path)
    client._clock = lambda: now[0]
    client.get("https://example.test/a", ttl=0)
    now[0] += 100  # a long gap: no extra wait needed
    client.get("https://example.test/b", ttl=0)
    assert sleeps == []


def test_floor_cannot_be_lowered_for_real_hosts(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path / "c")
    sleeps: list[float] = []
    from tender_sources.http import FakeTransport

    client = PoliteClient(
        transport=FakeTransport(lambda u, h: resp("x")), cache=cache, sleep=sleeps.append,
        resolver=resolver, respect_robots=False,
    )  # fmt: skip
    client._clock = lambda: 0.0
    assert client.effective_delay_bounds("example.test", AccessPolicy(0.0, 0.1)) == (3.0, 3.0)
    assert client.effective_delay_bounds("example.test", AccessPolicy(0.0, 0.1, "api")) == (
        1.0,
        1.0,
    )
    assert client.effective_delay_bounds("example.test", HTML_POLICY) == (3.0, 8.0)
    assert client.effective_delay_bounds("example.test", API_POLICY) == (1.0, 2.0)
    client.get("https://example.test/a", ttl=0, policy=AccessPolicy(0.0, 0.1))
    client.get("https://example.test/b", ttl=0, policy=AccessPolicy(0.0, 0.1))
    assert sleeps and sleeps[0] >= 3.0


def test_allow_fast_needs_env_and_local_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tender_sources.http import FakeTransport

    client = PoliteClient(
        transport=FakeTransport(lambda u, h: resp("x")), cache=DiskCache(tmp_path)
    )
    fast = AccessPolicy(0.0, 0.0)
    monkeypatch.delenv("TENDER_SOURCES_ALLOW_FAST", raising=False)
    assert client.effective_delay_bounds("127.0.0.1", fast) == (3.0, 3.0)
    monkeypatch.setenv("TENDER_SOURCES_ALLOW_FAST", "1")
    assert client.effective_delay_bounds("127.0.0.1", fast) == (0.0, 0.0)
    assert client.effective_delay_bounds("example.test", fast) == (3.0, 3.0)  # not local


def test_api_policy_uses_one_to_two_seconds(tmp_path: Path) -> None:
    client, _, sleeps = make_client(lambda u, h: resp("{}"), tmp_path)
    client._clock = lambda: 0.0
    for i in range(5):
        client.get(f"https://example.test/p{i}", ttl=0, policy=API_POLICY)
    assert sleeps and all(1.0 <= s <= 2.0 for s in sleeps)


# ----------------------------------------------------------------------- safety integration


def test_unsafe_url_never_reaches_transport(tmp_path: Path) -> None:
    client, transport, _ = make_client(lambda u, h: resp("x"), tmp_path)
    for bad in (
        "http://127.0.0.1/",
        "http://169.254.169.254/latest",
        "file:///etc/passwd",
        "http://2130706433/",
    ):
        with pytest.raises(UnsafeURL):
            client.get(bad)
    assert transport.calls == []


def test_every_redirect_hop_is_validated(tmp_path: Path) -> None:
    def handler(url: str, headers: object) -> RawResponse:
        if url.endswith("/start"):
            return resp("", 302, {"Location": "https://example.test/second"})
        if url.endswith("/second"):
            return resp("", 301, {"Location": "http://169.254.169.254/latest/meta-data"})
        return resp("SECRET")

    client, transport, _ = make_client(handler, tmp_path)
    with pytest.raises(UnsafeURL):
        client.get("https://example.test/start")
    assert [c[0] for c in transport.calls] == [
        "https://example.test/start",
        "https://example.test/second",
    ]


def test_dns_rebinding_hop_is_blocked(tmp_path: Path) -> None:
    table = {"example.test": ["93.184.216.34"], "evil.example.test": ["10.0.0.7"]}
    client, transport, _ = make_client(
        lambda u, h: resp("", 302, {"Location": "https://evil.example.test/x"}), tmp_path,
        resolver=lambda host: table[host],
    )  # fmt: skip
    with pytest.raises(UnsafeURL, match="non-public"):
        client.get("https://example.test/a")
    assert len(transport.calls) == 1


def test_relative_redirect_is_followed_and_loop_stops(tmp_path: Path) -> None:
    def handler(url: str, headers: object) -> RawResponse:
        return resp("", 302, {"Location": "/loop"})

    client, _, _ = make_client(handler, tmp_path)
    with pytest.raises(HttpStatusError):
        client.get("https://example.test/a")


# ----------------------------------------------------------------------- headers


def test_forbidden_request_headers_are_refused(tmp_path: Path) -> None:
    client, _, _ = make_client(lambda u, h: resp("x"), tmp_path)
    for name in ("Referer", "User-Agent", "sec-ch-ua", "Cookie"):
        with pytest.raises(ValueError, match="not allowed"):
            client.get("https://example.test/a", headers={name: "x"})


def test_user_agent_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TENDER_SOURCES_UA", raising=False)
    monkeypatch.delenv("TENDER_SOURCES_CONTACT", raising=False)
    assert honest_user_agent().startswith("tender-monitor/0.1 (+research; contact:")
    monkeypatch.setenv("TENDER_SOURCES_CONTACT", "ops@example.org")
    assert "ops@example.org" in honest_user_agent()
    monkeypatch.setenv("TENDER_SOURCES_UA", "my-bot/9")
    assert honest_user_agent() == "my-bot/9"


def test_honest_headers_over_a_real_local_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spin up a real http.server and assert what Scrapling actually puts on the wire."""
    monkeypatch.setenv("TENDER_SOURCES_ALLOW_FAST", "1")
    monkeypatch.setenv("TENDER_SOURCES_UA", "tender-monitor/0.1 (+research; contact: test)")
    with (
        EchoServer() as server,
        PoliteClient(
            cache=DiskCache(tmp_path / "c"), allow_hosts=["127.0.0.1"], respect_robots=False
        ) as client,
    ):
        result = client.get(f"{server.base}/echo", ttl=0)
    echoed = result.json()
    assert echoed["user-agent"] == "tender-monitor/0.1 (+research; contact: test)"
    assert not any(k.startswith("sec-ch-") for k in echoed)
    assert "referer" not in echoed
    assert "chrome" not in json.dumps(echoed).lower()
    assert "google" not in json.dumps(echoed).lower()
    assert set(echoed) <= {"host", "user-agent", "accept", "accept-encoding"}


def test_real_server_robots_and_redirect_to_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TENDER_SOURCES_ALLOW_FAST", "1")
    with (
        EchoServer(robots="User-agent: *\nDisallow: /private\n") as server,
        PoliteClient(cache=DiskCache(tmp_path / "c"), allow_hosts=["127.0.0.1"]) as client,
    ):
        assert client.get(f"{server.base}/public", ttl=0, policy=NO_DELAY).status == 200
        from tender_sources.http import RobotsDisallowed

        with pytest.raises(RobotsDisallowed):
            client.get(f"{server.base}/private/x", ttl=0, policy=NO_DELAY)
        with pytest.raises(UnsafeURL):  # real 302 to the metadata address is refused
            client.get(f"{server.base}/redir", ttl=0, policy=NO_DELAY)


def test_loopback_is_refused_unless_explicitly_allowed(tmp_path: Path) -> None:
    with (
        EchoServer() as server,
        PoliteClient(cache=DiskCache(tmp_path / "c")) as client,
        pytest.raises(UnsafeURL),
    ):
        client.get(f"{server.base}/echo", ttl=0)


# ----------------------------------------------------------------------- documents


def test_get_document_limits_and_hash(tmp_path: Path) -> None:
    pdf = b"%PDF-1.4 hello"
    client, _, _ = make_client(
        lambda u, h: resp(pdf, headers={"Content-Type": "application/pdf"}), tmp_path
    )
    doc = client.get_document("https://example.test/a.pdf")
    import hashlib

    assert (
        doc.data == pdf and doc.sha256 == hashlib.sha256(pdf).hexdigest() and doc.size == len(pdf)
    )

    with pytest.raises(DocumentRejected) as err:
        client.get_document("https://example.test/a.pdf", max_bytes=5)
    assert err.value.reason == "too_large"

    html_client, _, _ = make_client(lambda u, h: resp("<html/>"), tmp_path)
    with pytest.raises(DocumentRejected) as err2:
        html_client.get_document("https://example.test/a.pdf")
    assert err2.value.reason == "wrong_type"


def test_get_document_rejects_declared_oversize_and_sniffs_pdf(tmp_path: Path) -> None:
    client, _, _ = make_client(
        lambda u, h: resp(
            b"%PDF-x", headers={"Content-Type": "application/pdf", "Content-Length": "99999999"}
        ),
        tmp_path,
    )
    with pytest.raises(DocumentRejected, match="Content-Length"):
        client.get_document("https://example.test/a.pdf", max_bytes=1000)
    octet, _, _ = make_client(
        lambda u, h: resp(b"%PDF-1.7 ok", headers={"Content-Type": "application/octet-stream"}),
        tmp_path,
    )
    assert octet.get_document("https://example.test/b").content_type == "application/pdf"
    fake, _, _ = make_client(
        lambda u, h: resp(b"MZ exe", headers={"Content-Type": "application/octet-stream"}), tmp_path
    )
    with pytest.raises(DocumentRejected):
        fake.get_document("https://example.test/c")


def test_get_document_real_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TENDER_SOURCES_ALLOW_FAST", "1")
    with (
        EchoServer() as server,
        PoliteClient(
            cache=DiskCache(tmp_path / "c"), allow_hosts=["127.0.0.1"], respect_robots=False
        ) as c,
    ):
        assert (
            c.get_document(f"{server.base}/pdf", policy=NO_DELAY).content_type == "application/pdf"
        )
        with pytest.raises(DocumentRejected):
            c.get_document(f"{server.base}/big", max_bytes=1000, policy=NO_DELAY)
        with pytest.raises(DocumentRejected):
            c.get_document(f"{server.base}/html-doc", policy=NO_DELAY)


# ----------------------------------------------------------------------- misc


def test_fetch_result_text_and_page(tmp_path: Path) -> None:
    result = FetchResult(
        "https://example.test/", 200, {"content-type": "text/html; charset=utf-8"},
        "<html><body><p class='a'>Zambia é</p></body></html>".encode(), False, "2026-10-31T00:00:00Z",
    )  # fmt: skip
    assert "Zambia é" in result.text
    assert result.page.css("p.a::text").get() == "Zambia é"


def test_forbidden_identifiers_are_absent_from_the_package() -> None:
    root = Path(__file__).resolve().parents[1] / "tender_sources"
    forbidden = [
        r"Stealthy(?:Fetcher|Session)",
        r"solve_cloudflare",
        r"ProxyRotator",
        r"proxy_rotator",
        r"impersonate\s*=\s*(?!None)",
        r"stealthy_headers\s*=\s*True",
        r"google_search",
        r"\bproxies?\s*=\s*(?!None)\S",
        r"playwright|patchright|camoufox",
    ]
    offenders = []
    for path in root.rglob("*.py"):
        text = path.read_text("utf-8")
        for pattern in forbidden:
            for m in re.finditer(pattern, text):
                offenders.append(f"{path.name}: {m.group(0)}")
    assert offenders == []


def test_only_http_module_constructs_a_fetcher() -> None:
    root = Path(__file__).resolve().parents[1] / "tender_sources"
    users = [
        p.name
        for p in root.rglob("*.py")
        if re.search(r"FetcherSession|Fetcher\(|scrapling\.fetchers", p.read_text("utf-8"))
    ]
    assert users == ["http.py"]
