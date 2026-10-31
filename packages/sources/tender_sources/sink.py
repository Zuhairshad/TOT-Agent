"""Where scan output goes: the Cloudflare Worker (``WorkerSink``) or local files (``LocalSink``).

Env (Worker): ``INGEST_URL`` (alias ``WORKER_URL``) = base URL, ``INGEST_SECRET`` = bearer token.
The secret is only ever placed in the Authorization header; it is never logged or put in errors.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from tender_sources.cache import PACKAGE_ROOT

# Worker free plan: 10 ms CPU per request. Zod-validating 200 records likely exceeds that (estimated,
# not measured), so send small batches. The contract allows up to 200.
BATCH_SIZE = 25
DEFAULT_CONFIG_PATH = PACKAGE_ROOT.parent / "shared" / "config" / "search-config.default.json"
RETRIES = 3


def normalise_base_url(raw: str) -> str:
    """Accept either the Worker base URL or the full ``.../ingest`` URL the Playwright scraper uses.

    scrape.yml posts to ``INGEST_URL`` as-is (so it ends in ``/ingest``); the scans need the base.
    Stripping a trailing ``/ingest`` lets both workflows share one secret.
    """
    url = raw.strip().rstrip("/")
    for suffix in ("/ingest/v2", "/ingest"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url


class ScanLocked(Exception):
    """The Worker already has a scan running for this source (HTTP 409)."""

    def __init__(self, running_scan_id: str | None) -> None:
        super().__init__(f"a scan is already running (runningScanId={running_scan_id})")
        self.running_scan_id = running_scan_id


class SinkError(Exception):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class StartResult:
    config: dict[str, Any]
    since: str | None


class Sink(Protocol):
    def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult: ...

    def post_batch(self, report: dict[str, Any], records: list[dict[str, Any]]) -> None: ...


def load_default_config() -> dict[str, Any]:
    data = json.loads(DEFAULT_CONFIG_PATH.read_text("utf-8"))
    assert isinstance(data, dict)
    return data


# --------------------------------------------------------------------------- Worker

HttpFn = Callable[[str, bytes, Mapping[str, str]], tuple[int, bytes]]


def _urllib_post(url: str, body: bytes, headers: Mapping[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return int(resp.status), bytes(resp.read())
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SinkError(f"network error: {type(exc).__name__}", retryable=True) from None


class WorkerSink:
    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        *,
        http: HttpFn = _urllib_post,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        raw = base_url or os.environ.get("INGEST_URL") or os.environ.get("WORKER_URL") or ""
        self.base_url = normalise_base_url(raw)
        self._secret = secret or os.environ.get("INGEST_SECRET") or ""
        self._http = http
        self._sleep = sleep

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self._secret)

    def __repr__(self) -> str:  # never show the secret
        return f"WorkerSink(base_url={self.base_url!r})"

    def _post(self, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.configured:
            raise SinkError("INGEST_URL and INGEST_SECRET must be set")
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._secret}",
        }
        last: SinkError | None = None
        for attempt in range(RETRIES + 1):
            try:
                status, raw = self._http(f"{self.base_url}{path}", body, headers)
            except SinkError as exc:
                last = exc
            else:
                if status < 500:
                    try:
                        parsed = json.loads(raw.decode("utf-8")) if raw else {}
                    except ValueError:
                        parsed = {}
                    return status, parsed if isinstance(parsed, dict) else {}
                last = SinkError(f"HTTP {status} from {path}", retryable=True)
            if attempt < RETRIES:
                self._sleep(min(30.0, 2.0 * (2**attempt)))
        assert last is not None
        raise last

    def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult:
        payload = {
            "source": source,
            "scanId": scan_id,
            "params": params,
            "triggeredBy": params.get("triggeredBy", "manual"),
        }
        status, data = self._post("/scans/start", payload)
        if status == 409:
            raise ScanLocked(data.get("runningScanId"))
        if status >= 400:
            raise SinkError(f"POST /scans/start failed with HTTP {status}")
        config = data.get("config")
        if not isinstance(config, dict):
            raise SinkError("POST /scans/start returned no config")
        since = data.get("since")
        return StartResult(config=config, since=since if isinstance(since, str) else None)

    def post_batch(self, report: dict[str, Any], records: list[dict[str, Any]]) -> None:
        chunks = [records[i : i + BATCH_SIZE] for i in range(0, len(records), BATCH_SIZE)] or [[]]
        for index, chunk in enumerate(chunks):
            last = index == len(chunks) - 1
            # the report rides on the last chunk; earlier chunks carry a 'running' copy
            body_report = report if last else {**report, "status": "running", "finishedAt": None}
            status, _ = self._post("/ingest/v2", {"report": body_report, "records": chunk})
            if status >= 400:
                raise SinkError(f"POST /ingest/v2 failed with HTTP {status}")


# --------------------------------------------------------------------------- local files


class LocalSink:
    """Dry-run sink: ``records.jsonl`` (append) + ``report.json`` (latest) in ``directory``."""

    def __init__(self, directory: Path | str, config: dict[str, Any] | None = None) -> None:
        self.directory = Path(directory)
        self.config = config
        self.batches = 0

    def start_scan(self, source: str, scan_id: str, params: dict[str, Any]) -> StartResult:
        self.directory.mkdir(parents=True, exist_ok=True)
        return StartResult(config=self.config or load_default_config(), since=None)

    def post_batch(self, report: dict[str, Any], records: list[dict[str, Any]]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        self.batches += 1
        if records:
            with (self.directory / "records.jsonl").open("a", encoding="utf-8") as fh:
                for record in records:
                    fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        (self.directory / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
        )
