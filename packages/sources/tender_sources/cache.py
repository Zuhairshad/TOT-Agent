"""On-disk HTTP response cache. key = sha256(url); stores body, status, headers, fetched_at.

A cache hit inside its TTL skips the network AND the politeness delay. An expired entry that has an
``ETag`` / ``Last-Modified`` is revalidated with a conditional request by the caller.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]  # packages/sources


def default_cache_dir() -> Path:
    env = os.environ.get("TENDER_SOURCES_CACHE")
    return Path(env) if env else PACKAGE_ROOT / ".cache"


def cache_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


@dataclass
class CacheEntry:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    fetched_at: str  # ISO-8601 UTC

    def age_seconds(self, now: datetime | None = None) -> float:
        fetched = datetime.fromisoformat(self.fetched_at)
        return ((now or datetime.now(UTC)) - fetched).total_seconds()

    def is_fresh(self, ttl: float, now: datetime | None = None) -> bool:
        return ttl > 0 and self.age_seconds(now) < ttl

    @property
    def validators(self) -> dict[str, str]:
        out: dict[str, str] = {}
        if self.headers.get("etag"):
            out["If-None-Match"] = self.headers["etag"]
        if self.headers.get("last-modified"):
            out["If-Modified-Since"] = self.headers["last-modified"]
        return out


class DiskCache:
    def __init__(self, directory: Path | str | None = None) -> None:
        self.directory = Path(directory) if directory else default_cache_dir()

    def _paths(self, url: str) -> tuple[Path, Path]:
        key = cache_key(url)
        return self.directory / f"{key}.json", self.directory / f"{key}.body"

    def get(self, url: str) -> CacheEntry | None:
        meta_path, body_path = self._paths(url)
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
            body = body_path.read_bytes()
            return CacheEntry(
                url=meta["url"],
                status=int(meta["status"]),
                headers={str(k): str(v) for k, v in meta["headers"].items()},
                body=body,
                fetched_at=str(meta["fetched_at"]),
            )
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def put(
        self,
        url: str,
        *,
        status: int,
        headers: dict[str, str],
        body: bytes,
        fetched_at: str | None = None,
    ) -> CacheEntry:
        self.directory.mkdir(parents=True, exist_ok=True)
        meta_path, body_path = self._paths(url)
        stamp = fetched_at or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        entry = CacheEntry(url, status, dict(headers), body, stamp)
        _atomic_write(body_path, body)
        _atomic_write(
            meta_path,
            json.dumps(
                {"url": url, "status": status, "headers": headers, "fetched_at": stamp},
                sort_keys=True,
            ).encode("utf-8"),
        )
        return entry

    def touch(self, entry: CacheEntry, fetched_at: str | None = None) -> CacheEntry:
        """Mark a revalidated (304) entry as freshly fetched."""
        return self.put(
            entry.url,
            status=entry.status,
            headers=entry.headers,
            body=entry.body,
            fetched_at=fetched_at,
        )

    def delete(self, url: str) -> None:
        for path in self._paths(url):
            path.unlink(missing_ok=True)


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)
