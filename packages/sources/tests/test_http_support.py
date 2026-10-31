"""Shared helpers for the HTTP/scan tests (no tests here). All sites are FIXTURE stubs."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Self
from urllib.parse import parse_qs, urlsplit

from tender_sources.cache import DiskCache
from tender_sources.http import FakeTransport, PoliteClient, RawResponse

PUBLIC = {"example.test": ["93.184.216.34"], "search.worldbank.org": ["93.184.216.34"]}


def resolver(host: str) -> list[str]:
    return PUBLIC.get(host, ["93.184.216.34"])


def resp(
    body: bytes | str = b"ok", status: int = 200, headers: Mapping[str, str] | None = None
) -> RawResponse:
    data = body.encode() if isinstance(body, str) else body
    hdrs = {
        "content-type": "text/html; charset=utf-8",
        **{k.lower(): v for k, v in (headers or {}).items()},
    }
    return RawResponse(status=status, headers=hdrs, body=data)


def make_client(
    handler: Callable[[str, Mapping[str, str]], RawResponse | Exception],
    tmp_path: Path,
    **kwargs: Any,
) -> tuple[PoliteClient, FakeTransport, list[float]]:
    sleeps: list[float] = []
    transport = FakeTransport(handler)
    kwargs.setdefault("resolver", resolver)
    client = PoliteClient.for_testing(
        transport, cache=DiskCache(tmp_path / "cache"), sleep=sleeps.append, **kwargs
    )
    return client, transport, sleeps


class EchoServer:
    """A real local http.server. Echoes request headers as JSON; /robots.txt, /big, /pdf, /redir."""

    def __init__(self, robots: str | None = None) -> None:
        outer = self
        self.robots = robots
        self.seen: list[dict[str, str]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                outer.seen.append({k.lower(): v for k, v in self.headers.items()})
                status, ctype, body, extra = 200, "application/json", b"", {}
                if self.path == "/robots.txt":
                    if outer.robots is None:
                        status, ctype, body = 404, "text/plain", b"nope"
                    else:
                        ctype, body = "text/plain", outer.robots.encode()
                elif self.path == "/big":
                    ctype, body = "application/pdf", b"%PDF-" + b"x" * 5000
                elif self.path == "/pdf":
                    ctype, body = "application/pdf", b"%PDF-1.4 tiny"
                elif self.path == "/html-doc":
                    ctype, body = "text/html", b"<html></html>"
                elif self.path == "/redir":
                    status, extra = 302, {"Location": "http://169.254.169.254/latest"}
                else:
                    body = json.dumps({k.lower(): v for k, v in self.headers.items()}).encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in extra.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                return None

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


def fake_api(
    data: dict[str, list[dict[str, Any]]] | None = None,
    *,
    default: list[dict[str, Any]] | None = None,
) -> Any:
    """Serves rows per qterm, honouring rows/os, and records each request's query."""
    queries: list[dict[str, list[str]]] = []

    def handler(url: str, headers: Mapping[str, str]) -> RawResponse | Exception:
        q = parse_qs(urlsplit(url).query)
        queries.append(q)
        pool = (data or {}).get(q.get("qterm", [""])[0], default or [])
        rows, off = int(q["rows"][0]), int(q["os"][0])
        body = {
            "rows": rows,
            "os": str(off),
            "total": str(len(pool)),
            "procnotices": pool[off : off + rows],
        }
        return resp(json.dumps(body), headers={"content-type": "application/json"})

    handler.queries = queries  # type: ignore[attr-defined]
    return handler


def rows(n: int, *, prefix: str = "OP", start_date: str = "20-Oct-2026") -> list[dict[str, Any]]:
    return [
        {"id": f"{prefix}{i:05d}", "notice_type": "Contract Award", "noticedate": start_date,
         "bid_description": f"Motorcycle {i}", "project_ctry_name": "Zambia"}
        for i in range(n)
    ]  # fmt: skip
