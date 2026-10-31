"""Command line: ``python -m tender_sources scan --source worldbank ...`` and ``sources``.

Exit codes (same convention as the existing Playwright scraper): 0 ok, 1 error, 2 blocked.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from tender_sources.adapters.base import Limits
from tender_sources.http import PoliteClient
from tender_sources.registry import UnknownSource, adapter_ids, get_adapter
from tender_sources.scan import EXIT_ERROR, EXIT_OK, ScanEngine, ScanOptions, default_state_dir
from tender_sources.sink import LocalSink, Sink, WorkerSink


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tender_sources", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="run one source adapter")
    scan.add_argument("--source", required=True, help=f"one of: {', '.join(adapter_ids())}")
    scan.add_argument(
        "--country", action="append", help="override the config countries (repeatable)"
    )
    scan.add_argument("--since", help="only notices published on/after this ISO date")
    scan.add_argument("--max-pages", type=int, default=5, help="hard cap of pages per keyword")
    scan.add_argument("--max-requests", type=int, default=400, help="hard cap of network requests")
    scan.add_argument("--rows", type=int, default=50, help="results per page (API sources)")
    scan.add_argument("--keywords-file", help="JSON SearchConfig that replaces the Worker's config")
    scan.add_argument(
        "--dry-run", action="store_true", help="write JSONL + report to --out, no Worker"
    )
    scan.add_argument("--out", help="directory for --dry-run output")
    scan.add_argument("--resume", action="store_true", help="continue an interrupted scan")
    scan.add_argument(
        "--triggered-by", default="manual", help="free text, e.g. 'schedule' or a login"
    )
    scan.add_argument(
        "--no-documents", action="store_true", help="do not download linked documents"
    )
    scan.add_argument(
        "--keep-irrelevant", action="store_true", help="also store notices with no keyword match"
    )
    scan.add_argument("--state-dir", help="override .scan-state directory")

    src = sub.add_parser("sources", help="list adapters and check access (one request each)")
    src.add_argument(
        "--no-check", action="store_true", help="only list, do not contact the sources"
    )
    return parser


def _load_keywords(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("groups"), list):
        raise TypeError("keywords file must be a JSON SearchConfig with a 'groups' list")
    return data


def _cmd_scan(args: argparse.Namespace, client: PoliteClient | None, sink: Sink | None) -> int:
    try:
        adapter = get_adapter(args.source)
    except UnknownSource as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    config_override = None
    if args.keywords_file:
        try:
            config_override = _load_keywords(args.keywords_file)
        except (OSError, ValueError, TypeError) as exc:
            print(f"error: cannot read --keywords-file: {exc}", file=sys.stderr)
            return EXIT_ERROR
    state_dir = Path(args.state_dir) if args.state_dir else default_state_dir()
    if sink is None:
        if args.dry_run:
            sink = LocalSink(args.out or state_dir / "out")
        else:
            worker = WorkerSink()
            if not worker.configured:
                print(
                    "error: INGEST_URL and INGEST_SECRET are not set; use --dry-run --out DIR to write locally",
                    file=sys.stderr,
                )
                return EXIT_ERROR
            sink = worker
    own_client = client is None
    polite = client or PoliteClient()
    options = ScanOptions(
        limits=Limits(
            max_pages=args.max_pages, max_requests=args.max_requests, rows_per_page=args.rows
        ),
        since=args.since,
        country=args.country,
        config_override=config_override,
        resume=args.resume,
        triggered_by=args.triggered_by,
        keep_irrelevant=args.keep_irrelevant,
        fetch_documents=not args.no_documents,
        state_dir=state_dir,
    )
    try:
        outcome = ScanEngine(adapter, polite, sink, options).run()
    finally:
        if own_client:
            polite.close()
    report = outcome.report
    summary = {
        "source": report["source"],
        "status": report["status"],
        "accessStatus": report["accessStatus"],
        "pagesChecked": report["pagesChecked"],
        "recordsFound": report["recordsFound"],
        "documentsFetched": report["documentsFetched"],
        "failures": len(report["failures"]),
        "scanId": report["scanId"],
    }
    print(json.dumps(summary))
    for failure in report["failures"][:5]:
        print(f"  failure [{failure['stage']}] {failure['error']}", file=sys.stderr)
    return outcome.exit_code


def _cmd_sources(args: argparse.Namespace, client: PoliteClient | None) -> int:
    own_client = client is None
    polite = client or PoliteClient()
    try:
        for source_id in adapter_ids():
            adapter = get_adapter(source_id)
            line = f"{source_id}\t{adapter.display_name}"
            if not args.no_check:
                result = adapter.access_check(polite)
                line += f"\taccess={result.status}"
                if result.detail:
                    line += f" ({result.detail[:120]})"
            print(line)
    finally:
        if own_client:
            polite.close()
    return EXIT_OK


def main(
    argv: list[str] | None = None,
    *,
    client: PoliteClient | None = None,
    sink: Sink | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "scan":
            return _cmd_scan(args, client, sink)
        return _cmd_sources(args, client)
    except KeyboardInterrupt:
        print("interrupted; use --resume to continue", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
