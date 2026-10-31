"""On-disk cache: key, round trip, TTL, ETag revalidation, politeness skip on hits."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

from test_http_support import make_client, resp

from tender_sources.cache import DiskCache, cache_key
from tender_sources.http import RawResponse


def test_key_is_sha256_of_url() -> None:
    assert cache_key("https://a.test/x") == hashlib.sha256(b"https://a.test/x").hexdigest()


def test_round_trip_and_missing(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    assert cache.get("https://a.test/") is None
    cache.put("https://a.test/", status=200, headers={"etag": '"1"'}, body=b"\x00body")
    entry = cache.get("https://a.test/")
    assert entry is not None
    assert (entry.status, entry.body, entry.headers["etag"]) == (200, b"\x00body", '"1"')
    assert entry.validators == {"If-None-Match": '"1"'}
    cache.delete("https://a.test/")
    assert cache.get("https://a.test/") is None


def test_corrupt_entry_is_a_miss(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.put("https://a.test/", status=200, headers={}, body=b"x")
    (tmp_path / f"{cache_key('https://a.test/')}.json").write_text("{not json")
    assert cache.get("https://a.test/") is None


def test_freshness_window(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    old = (datetime.now(UTC) - timedelta(seconds=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = cache.put("https://a.test/", status=200, headers={}, body=b"x", fetched_at=old)
    assert entry.is_fresh(1000)
    assert not entry.is_fresh(10)
    assert not entry.is_fresh(0)


def test_cache_hit_skips_network_and_delay(tmp_path: Path) -> None:
    client, transport, sleeps = make_client(lambda u, h: resp("page"), tmp_path)
    first = client.get("https://example.test/a", ttl=3600)
    second = client.get("https://example.test/a", ttl=3600)
    assert not first.from_cache and second.from_cache
    assert second.text == "page"
    assert len(transport.calls) == 1
    assert sleeps == []  # no delay was needed for the hit (and none for the first request)


def test_expired_entry_is_revalidated_with_etag(tmp_path: Path) -> None:
    def handler(url: str, headers: object) -> RawResponse:
        sent = dict(headers)  # type: ignore[call-overload]
        if sent.get("If-None-Match") == '"v1"':
            return resp(b"", 304)
        return resp(
            "fresh body", headers={"ETag": '"v1"', "Last-Modified": "Mon, 01 Jan 2026 00:00:00 GMT"}
        )

    client, transport, _ = make_client(handler, tmp_path)
    first = client.get("https://example.test/etag", ttl=0)
    assert first.text == "fresh body"
    second = client.get("https://example.test/etag", ttl=0)  # ttl 0: always revalidate
    assert second.from_cache and second.text == "fresh body" and second.status == 200
    assert len(transport.calls) == 2
    sent = transport.calls[1][1]
    assert sent["If-None-Match"] == '"v1"'
    assert sent["If-Modified-Since"] == "Mon, 01 Jan 2026 00:00:00 GMT"


def test_changed_content_replaces_cache(tmp_path: Path) -> None:
    bodies = iter(["one", "two"])
    client, _, _ = make_client(lambda u, h: resp(next(bodies), headers={"ETag": '"x"'}), tmp_path)
    assert client.get("https://example.test/c", ttl=0).text == "one"
    assert client.get("https://example.test/c", ttl=0).text == "two"
    assert client.get("https://example.test/c", ttl=3600).text == "two"


def test_errors_and_no_store_are_not_cached(tmp_path: Path) -> None:
    client, transport, _ = make_client(
        lambda u, h: resp("x", headers={"Cache-Control": "no-store"}), tmp_path
    )
    client.get("https://example.test/ns", ttl=3600)
    client.get("https://example.test/ns", ttl=3600)
    assert len(transport.calls) == 2
