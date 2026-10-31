"""robots.txt is obeyed, cached per host, fetched with the same honest client."""

from __future__ import annotations

from pathlib import Path

import pytest
from test_http_support import make_client, resp

from tender_sources.http import AccessPolicy, BlockedError, RobotsDisallowed

NO_DELAY = AccessPolicy(0.0, 0.0)
ROBOTS = "User-agent: *\nDisallow: /private/\nAllow: /\n"


def site(robots: object = ROBOTS):  # type: ignore[no-untyped-def]
    def handler(url: str, headers: object):  # type: ignore[no-untyped-def]
        if url.endswith("/robots.txt"):
            return (
                robots
                if not isinstance(robots, str)
                else resp(robots, headers={"content-type": "text/plain"})
            )
        return resp("page " + url)

    return handler


def test_disallowed_path_raises_and_is_not_requested(tmp_path: Path) -> None:
    client, transport, _ = make_client(site(), tmp_path, respect_robots=True)
    assert client.get("https://example.test/public", policy=NO_DELAY).text.startswith("page")
    with pytest.raises(RobotsDisallowed, match="disallows"):
        client.get("https://example.test/private/secret", policy=NO_DELAY)
    assert [c[0] for c in transport.calls] == [
        "https://example.test/robots.txt",
        "https://example.test/public",
    ]


def test_robots_fetched_once_per_host_with_same_honest_ua(tmp_path: Path) -> None:
    client, transport, _ = make_client(site(), tmp_path, respect_robots=True)
    for path in ("a", "b", "c"):
        client.get(f"https://example.test/{path}", policy=NO_DELAY, ttl=0)
    robots_calls = [c for c in transport.calls if c[0].endswith("/robots.txt")]
    assert len(robots_calls) == 1
    assert robots_calls[0][1]["User-Agent"] == client.user_agent
    assert "Referer" not in robots_calls[0][1]


def test_each_host_has_its_own_robots(tmp_path: Path) -> None:
    client, transport, _ = make_client(site(), tmp_path, respect_robots=True)
    client.get("https://example.test/a", policy=NO_DELAY)
    client.get("https://other.test/a", policy=NO_DELAY)
    assert sum(c[0].endswith("/robots.txt") for c in transport.calls) == 2


def test_missing_robots_means_allowed(tmp_path: Path) -> None:
    client, _, _ = make_client(site(resp("nope", 404)), tmp_path, respect_robots=True)
    assert client.get("https://example.test/private/x", policy=NO_DELAY).status == 200


@pytest.mark.parametrize("status", [401, 403])
def test_forbidden_robots_means_disallow_all(tmp_path: Path, status: int) -> None:
    client, _, _ = make_client(site(resp("no", status)), tmp_path, respect_robots=True)
    with pytest.raises(RobotsDisallowed):
        client.get("https://example.test/anything", policy=NO_DELAY)


def test_unreachable_robots_is_treated_as_disallowed(tmp_path: Path) -> None:
    client, _, _ = make_client(site(resp("err", 500)), tmp_path, respect_robots=True)
    with pytest.raises(RobotsDisallowed, match="could not be fetched"):
        client.get("https://example.test/anything", policy=NO_DELAY)


def test_challenge_on_robots_is_reported_as_blocked(tmp_path: Path) -> None:
    client, transport, _ = make_client(
        site(resp("<title>Just a moment...</title>", 403, {"cf-mitigated": "challenge"})),
        tmp_path,
        respect_robots=True,
    )
    with pytest.raises(BlockedError):
        client.get("https://example.test/", policy=NO_DELAY)
    assert len(transport.calls) == 1  # stopped at once, no retry


def test_redirect_target_is_checked_against_its_own_robots(tmp_path: Path) -> None:
    def handler(url: str, headers: object):  # type: ignore[no-untyped-def]
        if url == "https://example.test/robots.txt":
            return resp("User-agent: *\nAllow: /")
        if url == "https://other.test/robots.txt":
            return resp("User-agent: *\nDisallow: /")
        if url == "https://example.test/go":
            return resp("", 302, {"Location": "https://other.test/page"})
        return resp("page")

    client, _, _ = make_client(handler, tmp_path, respect_robots=True)
    with pytest.raises(RobotsDisallowed):
        client.get("https://example.test/go", policy=NO_DELAY)
