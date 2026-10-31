# Web UI (`packages/web`)

A small Vite + TypeScript app with no UI framework: plain DOM and small modules. It is built to
`packages/web/dist`, which the Worker serves as static assets next to the JSON API, so the app only
ever calls same-origin `/api/*`.

## Run it

```bash
pnpm --filter @tender-monitor/web dev:mock   # FIXTURE mock API on :8787 (token: dev-token)
pnpm --filter @tender-monitor/web dev        # Vite on :5173, proxies /api to :8787
pnpm --filter @tender-monitor/web build      # -> packages/web/dist
pnpm --filter @tender-monitor/web test       # vitest (DOM tests use happy-dom)
pnpm --filter @tender-monitor/web typecheck
```

After a build, `dev:mock` also serves `dist/`, so http://localhost:8787 is the whole app.
`dev/mock-api.ts` and `dev/fixtures.ts` hold synthetic data only (every title says FIXTURE).
`pnpm --filter @tender-monitor/web screenshots` drives the built app with Chromium
(`CHROMIUM_PATH=/opt/pw-browsers/chromium`) and writes PNGs to `packages/web/test-results/`
(git-ignored).

## Pages

| Route           | What it shows                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#/`            | Search, filters (category checkboxes, country, status, published/deadline ranges, notice type), sort, result cards, pagination. Filters live in the URL hash, so links and the back button work.                               |
| `#/tender/<id>` | Detail: dates with original text, timezone and ambiguity warning; four separate money fields; items table; eligibility; documents with status; expandable evidence; version history; missing-data summary; access limitations. |
| `#/shortlist`   | Shortlisted tenders with checkboxes, "Export selected as PDF" and per-tender "Export PDF".                                                                                                                                     |
| `#/scans`       | Per source: access status in plain language, last successful scan, latest scan progress, failures, coverage limitations, "Run scan" (409 = already running, 501 = message shown).                                              |
| `#/settings`    | Edit keyword groups, context words, exclusions, countries, "published since" as chips, then `PUT /api/config`.                                                                                                                 |

## How it talks to the API

- Same-origin JSON. `src/api/client.ts` is the only place that calls `fetch`.
- On first use the app asks for the access token (`APP_TOKEN`), stores it in `localStorage`
  (every access is wrapped in try/catch, with an in-memory fallback) and sends
  `Authorization: Bearer <token>`. Any 401 shows the token prompt again.
- Errors become `ApiError` with a `kind`: `unauthorized`, `conflict` (409), `not_configured` (501),
  `not_found`, `http`, `network`, `bad_response`.
- Filters become the query string in `src/api/query.ts` (`category=motorbikes,ppe`, `notice_type`,
  `shortlisted=1`, `sort=published_desc|published_asc|closing_soon|relevance_desc`, `page`,
  `pageSize`). Only non-default values are written.
- The shortlist page loads `GET /api/tenders?shortlisted=1`; `GET /api/shortlist` (`{ids, items}`)
  is only used to learn the ids.
- **All wire-to-view conversion lives in `src/api/normalize.ts`** (list items, detail, scans and
  sources, config `{config, custom}`, shortlist). Views and PDF code only see the view types in
  `src/api/types.ts`. The list endpoint gives `publishedAt` as a plain ISO string (no original text,
  no ambiguity flag) and money as `{label, amount, currency, status}`; the detail record has the
  full facts. A response of the wrong shape becomes an `ApiError` of kind `bad_response`.
- Error bodies are `{error: "<code>"}` (+ `fields`, `message`); `ApiError.code` keeps the code and the
  text is plain language (`scan_running`, `recently_dispatched`, `invalid_body` ...).

## Contract tests

`test/fixtures/real-api/*.json` are **real** Worker responses (see its README). `test/contract.test.ts`
runs them through `ApiClient` and the views. `dev/mock-api.ts` must keep the same shapes. To drive the
built UI against a real Worker: `TOT_E2E_TOKEN=... BASE_URL=http://127.0.0.1:8799
CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @tender-monitor/web e2e:real`.

## Display rules (src/format.ts, shared by UI and PDF)

- Missing is `Not published` (source read, value absent) or `Could not verify` (could not read),
  never `0` or blank. A real `0` is shown as `0`.
- Unknown deadline reads `Deadline unknown` and never changes the status badge; unknown status
  reads `Status unknown`.
- Estimated value, contract award value, tender fee and bid security are always separate, labelled
  fields.
- All dates are shown in UTC next to the original text and stated timezone; ambiguous dates carry
  a warning.
- Record URLs come from scraped pages, so only `http(s)` links are clickable (`safeHref`), and no
  `innerHTML` is used anywhere.

## PDF export

`src/pdf/export.ts` exports `buildTenderPdf(records | record, { generatedAt }) -> Promise<Uint8Array>`
(pdf-lib; async because pdf-lib saves asynchronously). It is pure: no DOM, no network, no clock.

- One tender: sections only. Two or more: a cover/index page first (title, reference, country,
  deadline, page number), then each tender starts on a new page.
- Every tender: title, status, reference, buyer, country, dates (value, original text, timezone,
  ambiguity), relevance explanation, scope, lots, the full items table (repeating header, long
  cells wrap, rows break across pages, no clipping), delivery schedule, four money blocks, eligibility,
  required documents, submission/contact, source links with document status, access limitations,
  evidence quotes, and a **Not published / Could not verify** box listing every gap
  (`listGaps`, the same function as the UI summary).
- Footer on every page: retrieval time (`lastCheckedAt`), generation time, page `n of N`.
- Text is sanitised for Helvetica (WinAnsi): unsupported characters become `?` and the gap box
  records a notice with the count. Helpers live in `packages/shared/src/pdf-text.ts`
  (copied from the Worker's `pdf-builder.ts`; follow-up: make the Worker import them).
- In the app, `src/pdf/download.ts` fetches `GET /api/tenders/:id` for each selected id, builds one
  PDF and downloads it. Tenders that fail to load are named in the message.
- Tests render pages to PNG with `pdftoppm` and assert text with `pdftotext` (both skipped with a
  warning if absent); output goes to `packages/web/test-results/`.
