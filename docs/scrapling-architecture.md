# Scrapling integration: architecture

Status of the work and blockers live in `docs/scrapling-handoff.md`. This file explains the design.

## Why this shape

- The repo is TypeScript (Worker + D1 + Slack). Scrapling is Python, so it runs as a **separate
  Python component** (`packages/sources`, package `tender_sources`) on GitHub Actions, the same place
  the Playwright scraper already runs. It never runs inside a web request and needs no Claude session.
- The only coupling is a **versioned JSON contract**: `TenderRecord` in `packages/shared/src/record.ts`.
  JSON Schemas are exported to `packages/shared/schema/*.schema.json`; Python tests validate every
  record it emits against them, so the two languages cannot drift.
- The existing Slack flow (`/ingest`, `tenders` table) is untouched. The new pipeline adds `/ingest/v2`.

```
GitHub Actions (cron / manual)            Cloudflare Worker + D1               Browser
┌────────────────────────────┐  POST /scans/start  ┌───────────────────┐
│ python -m tender_sources   │ ───────────────────▶│ lock + search cfg │
│   scan --source worldbank  │  POST /ingest/v2    │ upsert + versions │◀── GET /api/* ── web UI
│  adapters ▶ normalise ▶    │ ───────────────────▶│ scans, shortlist  │     (packages/web,
│  relevance ▶ documents     │   (Bearer secret)   └───────────────────┘      PDF export in
└────────────────────────────┘                                                 the browser)
```

## Scrapling usage (verified, not assumed)

Pinned `scrapling[fetchers]==0.5`. Verified on 2026-10-31 against a local echo server:

| Setting                                                  | What it sent                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Scrapling defaults                                       | Windows Chrome 152 User-Agent, `sec-ch-ua` client hints, `referer: https://www.google.com/` |
| `impersonate=None, stealthy_headers=False, headers={UA}` | only our own honest User-Agent                                                              |

The defaults are fingerprint spoofing (CLAUDE.md rule 2), so `PoliteClient` is the only allowed entry
point and a test asserts the headers. We use `Fetcher`/`FetcherSession` (HTTP) and Scrapling's
selector engine for parsing. We do **not** use `StealthyFetcher`, `solve_cloudflare`, proxy rotation
or the MCP server's stealth tools. The "774x faster / never blocked / no selector maintenance" claims
were not relied on: speed here is bounded by our own politeness delays, and a Cloudflare challenge
(see below) blocks it like any other client. Selectors still need maintenance; fixtures + tests catch
layout changes.

Scrapling's MCP server (docs: `scrapling.readthedocs.io/en/latest/ai/mcp-server.html`) exposes tools
such as `make_request`, `browser_fetch_once`, `open_request_session`, `session_make_request`,
`browser_open`, `list_sessions`, `close_session`. It was **not used**: it is not installed in this
session, and its design (stealth browser, CAPTCHA bypass) is outside this project's rules for real
sources. It remains usable for inspecting sources that explicitly allow automated access.

## Sources

| Source                                                                     | Access                                                                          | Status                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| World Bank procurement notices (`search.worldbank.org/api/v2/procnotices`) | Official open JSON API                                                          | Live adapter                                                                                                             |
| TendersOnTime                                                              | Cloudflare managed challenge (`cf-mitigated: challenge`, 403) on plain requests | Adapter framework + guard; `blocked_by_challenge`; extraction rules wait for fixtures a human captures (docs/runbook.md) |

Adding a source = one file in `tender_sources/adapters/` implementing `SourceAdapter` + registering it.

## Pipeline

1. `scan` asks the Worker for a lock (`POST /scans/start`; 409 if one is running) and gets the current
   search config (keyword groups + exclusions + countries, editable in the UI) and `since` date.
2. Adapter `discover()` pages through results with explicit stop conditions (max pages, empty page,
   older than `since`, already-seen), `fetch_detail()` reads the notice, linked documents are fetched
   within size/type/SSRF limits.
3. Normalisers turn text into facts: dates (UTC ISO + original text + ambiguity), money (four separate
   fields, original currency kept), quantities/units (never converted), line items (merged across
   documents, not summed). Missing = `null` + status, never 0.
4. Relevance scores each record per keyword group with context and exclusions and writes a one-line
   explanation. Broad PPE is a separate category from riding gear.
5. Records go to `/ingest/v2` in batches with a progress report. The Worker upserts idempotently on
   `(source, sourceRecordId)`, keeps every version (deadline extensions, amendments, cancellations) and
   never overwrites history.
6. The report states pages checked, records found, failures and **coverage limitations**. We never
   claim "all tenders".

## Security

Scraped content is data, never instructions (nothing is fed to an agent). URLs and redirects are
validated (http/https only, no private/loopback/link-local/metadata addresses, DNS resolved and
re-checked); downloads are size- and type-limited; robots.txt is obeyed; per-domain concurrency is 1.
