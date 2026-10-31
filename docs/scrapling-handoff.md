# Scrapling integration: handoff

Written 2026-10-31. Read this first. Design: `docs/scrapling-architecture.md`. How to run:
`docs/scrapling-setup.md`. API: `docs/worker-api.md`. UI: `docs/web-ui.md`. Nothing is committed or
pushed (instruction from the user); everything is in the working tree.

## Bottom line

The pipeline works end to end on **real data from one source** (the World Bank open procurement API).
**TendersOnTime, the source you named, cannot be scraped by this project**: it sits behind a
Cloudflare managed challenge and the project rules forbid bypassing it. The adapter reports that
state honestly instead of guessing.

## What was verified (by running it, not by reading code)

| Check                                                                           | Result                                                                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` (all packages)                                                      | pass: shared 21, scraper 46 (+1 `it.todo`), web 72, worker 166 (workers pool) + 10 (node), root 32, **Python 522**           |
| `pnpm typecheck` (tsc + mypy), `pnpm lint` (eslint), ruff, `prettier --check .` | pass                                                                                                                         |
| `pnpm --filter @tender-monitor/web build`                                       | pass                                                                                                                         |
| **Live scan**: World Bank API, Zambia, 23 keyword terms, 2 pages each           | 23 pages, 15 relevant records stored, 0 failures, exit 0. 23 API hits were dropped as irrelevant and the report says so      |
| **Idempotent rescan** of the same data                                          | 0 new records, total stayed 15                                                                                               |
| **TendersOnTime scan**                                                          | `blocked_by_challenge`, exit 2, 1 request, no retry                                                                          |
| **Scan lock**                                                                   | second concurrent scan got HTTP 409 with the running scan id                                                                 |
| **Auth separation**                                                             | `INGEST_SECRET` on `/api/*` returns 401                                                                                      |
| **UI against the real Worker** (Chromium, desktop + 390 px)                     | list, detail, shortlist, scans, settings render; no console errors; selected-tender PDF downloaded and read with `pdftotext` |
| Scrapling honest config                                                         | verified with an echo server: defaults send a fake Windows Chrome UA + Google referer; our config sends only our own UA      |

The local Worker used for the end-to-end run was throwaway (local D1, fake secrets). It was stopped
and its `.dev.vars` / `.wrangler` state deleted.

## Bugs the end-to-end run found (and fixed)

1. **UI and Worker disagreed on response shapes** (`publishedAt`, `/api/scans`, config wrapper,
   shortlist, error codes). Both had passed their own tests because the UI's mock was written from
   the same spec. Fixed with one normaliser (`packages/web/src/api/normalize.ts`) and a contract test
   built from 12 **captured real responses** (`packages/web/test/fixtures/real-api/`).
2. **`INGEST_URL` meant different things** in `scrape.yml` (full `.../ingest`) and the Python sink
   (base URL). The sink now accepts both.
3. **Rules guard false positives** (`vite` dev proxy, GitHub's required `User-Agent`): handled with
   per-file exceptions whose exact usage is pinned by a test. I confirmed a browser-style UA makes the
   build fail again.
4. Root ESLint was walking the Python venv.

## Findings about the data

- World Bank, Zambia, your keywords: **15 notices, all closed contract awards**. There is **no open
  Zambian tender** for these keywords right now. The one Zambian PPE invitation (OP00474274) is an
  office-partitioning works contract that only mentions PPE as a contractor duty, and its deadline
  passed on 20 Oct: the relevance engine correctly dropped it.
- Without the country filter the API has open invitations (e.g. 22 "Invitation for Bids" in the 100
  newest "motorcycle" notices). Change the country list in **Search settings** to widen it.
- **This source only covers World Bank-financed procurement.** It is not "all Zambian tenders".
  Every scan report says so in `coverageLimitations`.
- Award prices land only in `awardValue`. In the sample (OP00065710), `estimatedValue`, `tenderFee`
  and `bidSecurity` are empty with a status, not 0.
- The API has no deadline field; deadlines are parsed from the notice text when it states one (for example "on or before Monday,
  23 November, 2026 at 12:00 pm (CAT)" becomes 2026-11-23T10:00Z with the quote as evidence). Notices without such
  text stay `Deadline unknown` and `status: unknown`; they are never shown as open.

## Blockers and the minimum action for each

| Blocker                                                                                                     | Minimum action                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TendersOnTime is behind a Cloudflare challenge** (HTTP 403, `cf-mitigated: challenge`, even `robots.txt`) | Ask TendersOnTime for an **official API or licensed feed / allow-listing** (preferred; your brief says to prefer one). Alternative within the rules: follow the existing human-in-the-loop route, run `scripts/explore.ts` on your laptop with the demo account, solve the challenge yourself, commit scrubbed fixtures; then the extraction rules can be written against real HTML. Do not automate the challenge. |
| TendersOnTime detail pages need an account                                                                  | Authorised access is designed for (`TOT_EMAIL`/`TOT_PASSWORD` from env, never hard-coded) but not built: it cannot be tested while the site blocks us.                                                                                                                                                                                                                                                              |
| No Cloudflare / Slack / GitHub access from this sandbox                                                     | Create D1, set secrets (`docs/secrets.md`), deploy, run `scan.yml`. None of that was done or tested here.                                                                                                                                                                                                                                                                                                           |

## Not done, or only partly done (honest list)

- **TendersOnTime extraction rules, login, search URL, detail and document retrieval**: not written
  (no real pages to base them on). `adapters/tendersontime.py` is the guarded framework only.
- **Linked tender-document retrieval and PDF processing**: built and unit-tested (size/type/SSRF
  limits, `extract_pdf`, table and requirement extraction, cross-document item merge), but **never run
  on a real tender document**: the World Bank API exposes no document links. Tested with synthetic PDFs
  labelled FIXTURE and a fake adapter.
- **OCR**: code path exists but **Tesseract is not installed here**; only tested with a monkeypatched
  function. Scanned PDFs return `needsReview` with "OCR unavailable". Install `tesseract-ocr` + the
  `ocr` extra on the runner to enable it.
- **Scrapling's MCP server was not used** (not installed in this session; its design is stealth/CAPTCHA
  bypass, outside this project's rules for real sources). Tool names are recorded in the architecture
  doc from the official docs. Scrapling's `StealthyFetcher`, `solve_cloudflare`, proxies and
  impersonation are not used anywhere; tests grep for them.
- **Browser rendering** (Scrapling `DynamicFetcher`/Playwright) is not used: the one live source is a
  plain JSON API, so lightweight fetching was enough.
- **`scan.yml` and the new CI steps have never run on GitHub** (YAML parses; actionlint unavailable).
- **Slack is not wired to v2 records** (existing Slack flow still uses the v1 `tenders` table). Only
  `blocked` scans alert Slack.
- **Free-plan CPU is unmeasured.** Zod-validating a batch may exceed 10 ms; the sink now sends batches
  of 25 (estimate, not measurement). Measure with `wrangler tail` after deploy. The earlier PDF-in-Slack
  CPU question (Workers Paid vs GitHub Action) is still open; the UI's PDF export runs in the browser
  and uses no Worker CPU.
- **Wrangler 3** can only send _all_ requests to the Worker first (`run_worker_first = true`) when
  serving the UI; Wrangler 4 would let static files skip it. Not upgraded (the workers test pool is
  paired with Wrangler 3).
- **`packages/web/dist` must be built before `wrangler dev/deploy`**; add the build step to
  `deploy-worker.yml` (not done).
- **No way to reset search settings to the packaged default** from the API (a PUT always marks them
  custom).
- Two known UI nits: the "PDF downloaded." banner may linger on the next page; `custom` config is not
  shown.
- `sanitize`/`wrapText` are duplicated in `packages/shared/src/pdf-text.ts` and the Worker's
  `pdf-builder.ts` (follow-up: have the Worker import the shared one).
- Two-digit years are read as 20xx and flagged ambiguous (kept as "published, ambiguous").
- `--max-pages` defaults to 5 per keyword for the Python scans; CLAUDE.md's 2-page rule is written for
  the Playwright scraper. Decide whether it should apply to API sources too.
- The Playwright scraper (`packages/scraper`) is unchanged and still blocked on fixtures (see
  `docs/go-live-checklist.md`).

## Requirement-by-requirement status

| Area                                                                  | Status                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Scrapling as Python component, pinned, documented                     | Done (`scrapling[fetchers]==0.5`, honest-config wrapper `PoliteClient`)                                              |
| Source adapter architecture                                           | Done; 2 adapters (World Bank live, TendersOnTime guarded)                                                            |
| Keyword groups, exclusions, PPE vs riding gear, why-matched           | Done, editable in the UI; stored in D1                                                                               |
| Structured data with evidence, `null` + status, separate money fields | Done in the contract, normalisers, API, UI and PDF; verified on real records                                         |
| Dates: parsing, ambiguity, unknown last, closing-soon sort            | Done and tested (Python, Worker, UI)                                                                                 |
| Amendments, deadline extensions, cancellations, history               | Done and tested in the Worker (append-only versions); not exercised by a real amended notice                         |
| Dedup (in-run, cross-source flagging)                                 | Done and tested; cross-source only flags, never merges                                                               |
| Security: SSRF, size/type limits, robots, untrusted content           | Done and tested; DNS-rebinding gap between resolve and connect cannot be fully closed through Scrapling (documented) |
| Jobs: manual + scheduled, progress, retries, lock, resume, idempotent | Done and tested locally; GitHub dispatch and schedule not run for real                                               |
| UI: search, filters, sorting, detail, shortlist, PDF export           | Done, driven against the real Worker                                                                                 |
| Incremental scans                                                     | Done (`since` high-water mark minus 2 days; applied client-side for World Bank because its date filter is ignored)   |
| Complete coverage                                                     | **Not claimed.** Reports list pages checked, records found, failures, limitations                                    |

## Decisions needed from you

1. **TendersOnTime route**: official API/licence/allow-list (recommended), or the human-in-the-loop
   fixture route. Until then it stays `blocked_by_challenge`.
2. **Other open sources** worth adding as adapters (candidates need a robots/terms check first; ZPPA's
   `robots.txt` allows crawling, `tenders.go.ke` allows all; UNGM returned 403 to a plain request).
3. **Countries**: Zambia only gives closed awards from the World Bank. Widen the list?
4. Private vs public repo (Actions minutes), unchanged from `docs/secrets.md`.
