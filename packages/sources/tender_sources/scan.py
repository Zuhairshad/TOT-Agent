"""Scan engine: runs ONE adapter end to end and ALWAYS produces a report.

    access_check -> discover (paged, checkpointed) -> detail -> documents -> to_record
                 -> in-run dedupe -> batches to the sink, with progress reports

Resumability: after every fully processed page the engine posts the buffered records, and only if
that succeeded does it persist ``.scan-state/<source>.json`` (adapter checkpoint + ids already
posted). A killed scan resumed with ``resume=True`` skips finished pages and already-posted ids.

Locking: a local lock file (stale after 45 minutes) complements the Worker's own lock.
"""

from __future__ import annotations

import contextlib
import copy
import json
import os
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tender_sources.adapters.base import (
    ACCESS_BLOCKED,
    ACCESS_LOGIN_REQUIRED,
    ACCESS_OK,
    AdapterNotReady,
    DiscoverContext,
    DocLink,
    Limits,
    RawNotice,
    SourceAdapter,
    iso_z,
)
from tender_sources.cache import PACKAGE_ROOT
from tender_sources.documents import extract_pdf
from tender_sources.extract.requirements import extract_requirements
from tender_sources.http import (
    BlockedError,
    DocumentRejected,
    FetchError,
    HttpStatusError,
    PoliteClient,
    RobotsDisallowed,
)
from tender_sources.merge import dedupe_in_run
from tender_sources.safety import UnsafeURL
from tender_sources.sink import BATCH_SIZE, ScanLocked, Sink, SinkError

LOCK_STALE_SECONDS = 45 * 60
EXIT_OK, EXIT_ERROR, EXIT_BLOCKED = 0, 1, 2
MAX_DOCS_PER_NOTICE = 3


def default_state_dir() -> Path:
    env = os.environ.get("TENDER_SOURCES_STATE")
    return Path(env) if env else PACKAGE_ROOT / ".scan-state"


class LocalScanLocked(Exception):
    pass


class FileLock:
    """``<state>/<source>.lock``; a lock older than ``stale_after`` seconds is taken over."""

    def __init__(
        self,
        path: Path,
        *,
        stale_after: float = LOCK_STALE_SECONDS,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.stale_after = stale_after
        self._now = now_fn
        self.held = False

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    age = self._now() - self.path.stat().st_mtime
                except FileNotFoundError:
                    continue
                if age < self.stale_after:
                    raise LocalScanLocked(
                        f"another scan holds {self.path.name} (age {int(age)} s)"
                    ) from None
                self.path.unlink(missing_ok=True)  # stale: previous run died
                continue
            with os.fdopen(fd, "w") as fh:
                fh.write(json.dumps({"pid": os.getpid(), "at": iso_z()}))
            self.held = True
            return
        raise LocalScanLocked(f"could not acquire {self.path.name}")

    def heartbeat(self) -> None:
        if self.held:
            with contextlib.suppress(OSError):
                os.utime(self.path)

    def release(self) -> None:
        if self.held:
            self.path.unlink(missing_ok=True)
            self.held = False


@dataclass
class ScanOptions:
    limits: Limits = field(default_factory=Limits)
    since: str | None = None  # explicit override; else the Worker's value
    country: list[str] | None = None
    config_override: dict[str, Any] | None = None
    resume: bool = False
    triggered_by: str = "manual"
    keep_irrelevant: bool = False
    fetch_documents: bool = True
    max_docs_per_notice: int = MAX_DOCS_PER_NOTICE
    state_dir: Path | None = None
    batch_size: int = BATCH_SIZE


@dataclass
class ScanOutcome:
    report: dict[str, Any]
    exit_code: int
    records: list[dict[str, Any]] = field(default_factory=list)


class ScanEngine:
    def __init__(
        self,
        adapter: SourceAdapter,
        client: PoliteClient,
        sink: Sink,
        options: ScanOptions | None = None,
        *,
        now_fn: Callable[[], datetime] = lambda: datetime.now(UTC),
        lock_now: Callable[[], float] = time.time,
    ) -> None:
        self.adapter = adapter
        self.client = client
        self.sink = sink
        self.opt = options or ScanOptions()
        self._now = now_fn
        self.state_dir = self.opt.state_dir or default_state_dir()
        self.state_path = self.state_dir / f"{adapter.id}.json"
        self.lock = FileLock(self.state_dir / f"{adapter.id}.lock", now_fn=lock_now)
        # run state
        self.scan_id = ""
        self.started_at = ""
        self.params: dict[str, Any] = {}
        self.config: dict[str, Any] = {}
        self.ctx: DiscoverContext | None = None
        self.access_status = ACCESS_OK
        self.failures: list[dict[str, Any]] = []
        self.buffer: list[dict[str, Any]] = []
        self.buffer_ids: list[str] = []
        self.processed: set[str] = set()
        self.base_pages = 0
        self.base_records = 0
        self.base_docs = 0
        self.records_found = 0
        self.docs_fetched = 0
        self.dropped_irrelevant = 0
        self.keywords: list[str] = []
        self._good_checkpoint: dict[str, Any] = {}
        self._flush_failed = False
        self.status = "running"
        self.blocked = False
        self.notes: list[str] = []
        self.all_records: list[dict[str, Any]] = []

    # ---- state ------------------------------------------------------------------------------

    def _load_state(self) -> dict[str, Any] | None:
        try:
            data = json.loads(self.state_path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or data.get("status") in ("succeeded", "blocked"):
            return None
        return data

    def _save_state(self, status: str) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        state = {
            "scanId": self.scan_id,
            "source": self.adapter.id,
            "status": status,
            "startedAt": self.started_at,
            "checkpoint": self._good_checkpoint,
            "processedIds": sorted(self.processed),
            "pagesChecked": self.base_pages + (self.ctx.pages_checked if self.ctx else 0),
            "recordsFound": self.records_found,
            "documentsFetched": self.docs_fetched,
            "droppedIrrelevant": self.dropped_irrelevant,
            "params": self.params,
        }
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.state_path)

    # ---- report -------------------------------------------------------------------------------

    def build_report(self, status: str, *, final: bool) -> dict[str, Any]:
        ctx = self.ctx
        keywords = list(ctx.keywords_searched) if ctx else list(self.keywords)
        stop_reasons = dict(ctx.stop_reasons) if ctx else {}
        failures = [*self.failures, *(ctx.failures if ctx else [])]
        limitations = [*self.adapter.coverage_limitations, *self.notes]
        if ctx:
            limitations += ctx.notes
        if self.dropped_irrelevant:
            limitations.append(
                f"{self.dropped_irrelevant} notice(s) returned by the source search had no keyword "
                "match in their title, description or items and were not stored."
            )
        if stop_reasons:
            limitations.append(
                "Paging stopped per keyword: "
                + "; ".join(f"{k}: {v}" for k, v in sorted(stop_reasons.items()))
                + "."
            )
        checkpoint: dict[str, Any] = {
            "adapter": copy.deepcopy(ctx.checkpoint if ctx else self._good_checkpoint),
            "processedCount": len(self.processed),
            "stopReasons": stop_reasons,
        }
        return {
            "scanId": self.scan_id,
            "source": self.adapter.id,
            "status": status,
            "accessStatus": self.access_status,
            "startedAt": self.started_at,
            "finishedAt": iso_z(self._now()) if final else None,
            "params": self.params,
            "keywordsSearched": keywords,
            "pagesChecked": self.base_pages + (ctx.pages_checked if ctx else 0),
            "recordsFound": self.records_found,
            "documentsFetched": self.docs_fetched,
            "failures": failures,
            "coverageLimitations": limitations,
            "checkpoint": checkpoint,
        }

    # ---- flushing ---------------------------------------------------------------------------

    def _flush(self, status: str, *, final: bool) -> bool:
        """Post buffered records + a report. Returns True on success."""
        report = self.build_report(status, final=final)
        try:
            self.sink.post_batch(report, list(self.buffer))
        except SinkError as exc:
            self._flush_failed = True
            self.failures.append(
                {"url": None, "stage": "ingest", "error": str(exc), "retryable": exc.retryable}
            )
            return False
        self.processed.update(self.buffer_ids)
        self.buffer.clear()
        self.buffer_ids.clear()
        if self.ctx is not None:
            self._good_checkpoint = copy.deepcopy(self.ctx.checkpoint)
        return True

    def _page_done(self) -> None:
        self.lock.heartbeat()
        if self._flush("running", final=False):
            self._save_state("running")

    # ---- documents ----------------------------------------------------------------------------

    def _fetch_documents(self, raw: RawNotice) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        merged: dict[str, Any] = {}
        if not self.opt.fetch_documents:
            return entries, merged
        try:
            links: list[DocLink] = self.adapter.document_links(raw)[: self.opt.max_docs_per_notice]
        except Exception as exc:  # noqa: BLE001
            self.failures.append(
                {
                    "url": raw.ref.url,
                    "stage": "document",
                    "error": f"document_links: {exc}",
                    "retryable": False,
                }
            )
            return entries, merged
        for link in links:
            entry: dict[str, Any] = {
                "url": link.url, "title": link.title, "mimeType": None, "sizeBytes": None,
                "sha256": None, "fetchedAt": None, "status": "not_attempted", "pageCount": None,
                "textExtracted": False, "ocrUsed": False, "needsReview": False, "error": None,
            }  # fmt: skip
            entries.append(entry)
            try:
                doc = self.client.get_document(link.url, policy=self.adapter.access_policy)
            except UnsafeURL as exc:
                entry.update(status="skipped_unsafe", error=str(exc))
                continue
            except RobotsDisallowed as exc:
                entry.update(status="skipped_unsafe", error=str(exc))
                continue
            except BlockedError as exc:
                entry.update(status="blocked", error=str(exc))
                self._doc_failure(link.url, exc)
                continue
            except DocumentRejected as exc:
                entry.update(
                    status="too_large" if exc.reason == "too_large" else "failed", error=str(exc)
                )
                continue
            except HttpStatusError as exc:
                entry.update(
                    status="requires_login" if exc.status in (401, 403) else "failed",
                    error=str(exc),
                )
                self._doc_failure(link.url, exc)
                continue
            except FetchError as exc:
                entry.update(status="failed", error=str(exc))
                self._doc_failure(link.url, exc)
                continue
            self.docs_fetched += 1
            entry.update(
                status="retrieved", mimeType=doc.content_type, sizeBytes=doc.size,
                sha256=doc.sha256, fetchedAt=doc.fetched_at,
            )  # fmt: skip
            extracted = extract_pdf(doc.data, source_url=doc.url)
            pages = extracted.get("pages") or []
            entry.update(
                pageCount=extracted.get("pageCount"),
                textExtracted=any((p.get("text") or "").strip() for p in pages),
                ocrUsed=bool(extracted.get("ocrUsed")),
                needsReview=bool(extracted.get("needsReview")),
                error=extracted.get("error"),
            )
            if pages:
                found = extract_requirements(pages, source_url=doc.url, retrieved_at=doc.fetched_at)
                for key, value in found.items():
                    merged.setdefault(key, value)
        return entries, merged

    def _doc_failure(self, url: str, exc: Exception) -> None:
        self.failures.append(
            {
                "url": url,
                "stage": "document",
                "error": str(exc),
                "retryable": bool(getattr(exc, "retryable", False)),
            }
        )

    @staticmethod
    def _merge_requirements(record: dict[str, Any], found: dict[str, Any]) -> None:
        """Document facts fill gaps only; they never overwrite a published value."""
        for key, value in found.items():
            current = record.get(key)
            if isinstance(value, list):
                if not current:
                    record[key] = value
            elif isinstance(value, dict) and (
                not isinstance(current, dict) or current.get("status") != "published"
            ):
                record[key] = value

    # ---- main --------------------------------------------------------------------------------

    def run(self) -> ScanOutcome:
        self.started_at = iso_z(self._now())
        try:
            self.lock.acquire()
        except LocalScanLocked as exc:
            self.scan_id = self.scan_id or f"scan-{uuid.uuid4().hex[:12]}"
            self.failures.append(
                {"url": None, "stage": "other", "error": str(exc), "retryable": True}
            )
            self.access_status = ACCESS_OK
            report = self.build_report("failed", final=True)
            self._report_always(report)
            return ScanOutcome(report, EXIT_ERROR)
        try:
            return self._run_locked()
        finally:
            self.lock.release()

    def _report_always(self, report: dict[str, Any]) -> None:
        try:
            self.sink.post_batch(report, [])
        except Exception as exc:  # noqa: BLE001  never lose the report
            print(f"warning: could not deliver final report: {exc}", file=sys.stderr)
        with contextlib.suppress(OSError):
            self.state_dir.mkdir(parents=True, exist_ok=True)
            (self.state_dir / f"{self.adapter.id}.last-report.json").write_text(
                json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
            )

    def _run_locked(self) -> ScanOutcome:
        resumed = self._load_state() if self.opt.resume else None
        if resumed:
            self.scan_id = str(resumed["scanId"])
            self.started_at = str(resumed.get("startedAt") or self.started_at)
            self.processed = set(resumed.get("processedIds") or [])
            self._good_checkpoint = dict(resumed.get("checkpoint") or {})
            self.base_pages = int(resumed.get("pagesChecked") or 0)
            self.records_found = int(resumed.get("recordsFound") or 0)
            self.docs_fetched = int(resumed.get("documentsFetched") or 0)
            self.dropped_irrelevant = int(resumed.get("droppedIrrelevant") or 0)
            self.params = dict(resumed.get("params") or {})
        else:
            self.scan_id = f"scan-{self._now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:8]}"
            self.params = {
                "triggeredBy": self.opt.triggered_by,
                "since": self.opt.since,
                "countries": self.opt.country,
                "maxPages": self.opt.limits.max_pages,
                "maxRequests": self.opt.limits.max_requests,
                "resume": self.opt.resume,
            }
        self.params["triggeredBy"] = self.opt.triggered_by

        # 1. lock + config from the sink
        try:
            started = self.sink.start_scan(self.adapter.id, self.scan_id, self.params)
        except ScanLocked as exc:
            self.failures.append(
                {"url": None, "stage": "other", "error": str(exc), "retryable": True}
            )
            report = self.build_report("failed", final=True)
            self._report_always(report)
            return ScanOutcome(report, EXIT_ERROR)
        except (SinkError, OSError, ValueError) as exc:
            self.failures.append(
                {
                    "url": None,
                    "stage": "other",
                    "error": f"could not start scan: {exc}",
                    "retryable": True,
                }
            )
            report = self.build_report("failed", final=True)
            self._report_always(report)
            return ScanOutcome(report, EXIT_ERROR)

        self.config = copy.deepcopy(self.opt.config_override or started.config)
        if self.opt.country:
            self.config["countries"] = list(self.opt.country)
        since = self.opt.since or started.since
        self.params["since"] = since

        # 2. access check
        try:
            access = self.adapter.access_check(self.client)
            self.access_status = access.status
            if access.status != ACCESS_OK:
                self.notes.append(f"Access check: {access.status}. {access.detail}".strip())
        except BlockedError as exc:  # defensive: adapters should map this themselves
            self.access_status = ACCESS_BLOCKED
            self.notes.append(f"Access check: blocked. {exc.evidence}")
        except Exception as exc:  # noqa: BLE001
            self.access_status = "unreachable"
            self.failures.append(
                {"url": None, "stage": "other", "error": f"access_check: {exc}", "retryable": True}
            )

        if self.access_status == ACCESS_BLOCKED:
            self.blocked = True
            self.failures.append({
                "url": None, "stage": "other",
                "error": "Bot challenge / block detected; not retried and not worked around.",
                "retryable": False,
            })  # fmt: skip
            self.notes.append(
                "The source blocked automated access with a bot challenge. Nothing was scanned; "
                "a human must provide authorised access (see docs/runbook.md)."
            )
            return self._finish("blocked", EXIT_BLOCKED)
        if self.access_status not in (ACCESS_OK, ACCESS_LOGIN_REQUIRED):
            return self._finish("failed", EXIT_ERROR)

        # 3. discover -> detail -> documents -> record
        ctx = DiscoverContext(
            client=self.client,
            config=self.config,
            since=since,
            checkpoint=copy.deepcopy(self._good_checkpoint),
            limits=self.opt.limits,
        )
        ctx.on_page_done = self._page_done
        self.ctx = ctx
        self._good_checkpoint = copy.deepcopy(ctx.checkpoint)
        try:
            for ref in self.adapter.discover(ctx):
                if ref.id in self.processed or ref.id in self.buffer_ids:
                    continue
                self._process_ref(ctx, ref)
        except BlockedError as exc:
            self.blocked = True
            self.access_status = ACCESS_BLOCKED
            self.failures.append(
                {"url": exc.url, "stage": "listing", "error": str(exc), "retryable": False}
            )
        except AdapterNotReady as exc:
            self.failures.append(
                {
                    "url": None,
                    "stage": "other",
                    "error": f"adapter not ready: {exc}",
                    "retryable": False,
                }
            )
        except Exception as exc:  # noqa: BLE001  one bad source must not lose the report
            self.failures.append(
                {
                    "url": None,
                    "stage": "listing",
                    "error": f"{type(exc).__name__}: {exc}",
                    "retryable": False,
                }
            )

        if self.blocked:
            self.notes.append(
                "A bot challenge appeared during the scan; it was stopped and not retried."
            )
            self._flush_buffer_best_effort()
            return self._finish("blocked", EXIT_BLOCKED)

        # 4. final flush
        self.buffer = self._dedupe(self.buffer)
        ok = self._flush("running", final=False) if self.buffer else True
        if ok:
            self._save_state("running")
        return self._finish(self._final_status(), None)

    def _flush_buffer_best_effort(self) -> None:
        if self.buffer and self._flush("running", final=False):
            self._save_state("running")

    def _dedupe(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return dedupe_in_run(records) if len(records) > 1 else records

    def _process_ref(self, ctx: DiscoverContext, ref: Any) -> None:
        try:
            raw = self.adapter.fetch_detail(ctx, ref)
        except BlockedError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.failures.append({
                "url": ref.url, "stage": "detail", "error": f"{type(exc).__name__}: {exc}",
                "retryable": bool(getattr(exc, "retryable", False)),
            })  # fmt: skip
            return
        docs, found = self._fetch_documents(raw)
        try:
            record = self.adapter.to_record(raw, self.config, self._now())
        except Exception as exc:  # noqa: BLE001
            self.failures.append(
                {
                    "url": ref.url,
                    "stage": "parse",
                    "error": f"{type(exc).__name__}: {exc}",
                    "retryable": False,
                }
            )
            return
        if docs:
            record["documents"] = docs
            self._merge_requirements(record, found)
        rel = record.get("relevance") or {}
        if not self.opt.keep_irrelevant and not rel.get("groups") and not rel.get("score"):
            self.dropped_irrelevant += 1
            self.processed.add(ref.id)  # decided; do not re-evaluate on resume
            return
        self.buffer.append(record)
        self.buffer_ids.append(ref.id)
        self.all_records.append(record)
        self.records_found += 1
        if len(self.buffer) >= self.opt.batch_size:
            self.buffer = self._dedupe(self.buffer)
            if self._flush("running", final=False):
                self._save_state("running")

    def _final_status(self) -> str:
        ctx = self.ctx
        degrading = [
            f for f in [*self.failures, *(ctx.failures if ctx else [])] if f["stage"] != "document"
        ]
        capped = bool(ctx and "request_cap" in ctx.stop_reasons.values())
        searched = bool(ctx and ctx.pages_checked + self.base_pages > 0)
        if not searched and degrading:
            return "failed"
        if self._flush_failed and self.buffer:
            return "failed" if not self.records_found else "partial"
        if degrading or capped:
            return "partial"
        return "succeeded"

    def _finish(self, status: str, exit_code: int | None) -> ScanOutcome:
        if exit_code is None:
            exit_code = EXIT_ERROR if status == "failed" else EXIT_OK
        self.status = status
        report = self.build_report(status, final=True)
        delivered = True
        try:
            self.sink.post_batch(report, list(self.buffer))
            self.buffer.clear()
        except Exception as exc:  # noqa: BLE001
            delivered = False
            print(f"warning: could not deliver final report: {exc}", file=sys.stderr)
        with contextlib.suppress(OSError):
            self.state_dir.mkdir(parents=True, exist_ok=True)
            (self.state_dir / f"{self.adapter.id}.last-report.json").write_text(
                json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
            )
        if status in ("succeeded", "blocked") and delivered:
            if status == "succeeded":
                self.state_path.unlink(missing_ok=True)
            else:
                self._save_state("blocked")
        elif status in ("partial", "failed"):
            with contextlib.suppress(OSError):
                self._save_state(status)
        return ScanOutcome(report, exit_code, list(self.all_records))
