# Setup and run: Scrapling sources, API and web UI

Architecture: `docs/scrapling-architecture.md`. Status and blockers: `docs/scrapling-handoff.md`.

## Requirements

Node 20+, pnpm 10, Python 3.11+ (CI uses 3.12). Chromium is **not** needed for the World Bank source
(plain HTTP). Tesseract is optional (OCR for scanned PDFs; `pip install -e 'packages/sources[ocr]'`
plus the `tesseract-ocr` system package).

## Install

```sh
pnpm install
pnpm --filter @tender-monitor/sources run venv      # creates packages/sources/.venv, installs Scrapling 0.5 pinned
```

Scrapling is pinned in `packages/sources/pyproject.toml` as `scrapling[fetchers]==0.5`. The base
`scrapling` package only contains the parser; fetchers are an extra, so the extra is required.

## Run everything locally

```sh
cd packages/worker
cp .dev.vars.example .dev.vars                   # then set INGEST_SECRET and APP_TOKEN (any strings)
pnpm --filter @tender-monitor/web build          # the Worker serves packages/web/dist
pnpm exec wrangler d1 migrations apply tender-monitor --local
pnpm exec wrangler dev --local --port 8799       # UI at http://127.0.0.1:8799/ (enter APP_TOKEN)

# in another shell: a real scan of the World Bank open API into the local Worker
cd packages/sources
export INGEST_URL=http://127.0.0.1:8799 INGEST_SECRET=<same as .dev.vars>
.venv/bin/python -m tender_sources scan --source worldbank --country Zambia --max-pages 2
.venv/bin/python -m tender_sources sources       # list adapters and their access status
```

No Worker? Use `--dry-run --out DIR` to write JSONL and the scan report to a folder.
Exit codes: `0` ok, `1` error, `2` blocked by the source (never retried, never bypassed).

## Production

1. Create the D1 database, set `database_id` in `packages/worker/wrangler.toml`, set secrets from
   `docs/secrets.md` (new: `APP_TOKEN`, optional `GITHUB_DISPATCH_TOKEN`).
2. Build the UI, then deploy the Worker (`deploy-worker.yml` does migrations + deploy on push to main;
   add `pnpm --filter @tender-monitor/web build` before the deploy step if you rely on CI).
3. `scan.yml` runs daily and on demand ("Run scan" in the UI or the Actions tab). It needs the
   `INGEST_URL` (base URL) and `INGEST_SECRET` secrets.

## Tests and checks

```sh
pnpm test            # all packages: shared, scraper, worker (workers pool + node), web, sources (pytest)
pnpm typecheck       # tsc everywhere + mypy for Python
pnpm lint            # eslint
pnpm --filter @tender-monitor/sources lint     # ruff
pnpm exec prettier --check .
pnpm --filter @tender-monitor/sources test:live   # LIVE: hits the real World Bank API (off by default)
```

## Adding a source

Create `packages/sources/tender_sources/adapters/<name>.py` implementing `SourceAdapter`
(`access_check`, `discover`, `fetch_detail`, `to_record`), register it in `registry.py`, add a
fixture captured from the real source (label it), and tests including a contract test against
`packages/shared/schema/tender-record.schema.json`. Check the source's robots.txt and terms first,
and prefer an official API. If it shows a challenge, mark it `blocked_by_challenge`; do not work
around it.
