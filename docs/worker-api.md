# Worker v2 API

The v2 data plane lives next to the Slack flow in `packages/worker`. `/ingest` (v1), the `tenders`
table, Slack interactions and the PDF flow are unchanged. All v2 responses are JSON.

## Auth

| Who                             | Header                                  | Secret          | Used for                               |
| ------------------------------- | --------------------------------------- | --------------- | -------------------------------------- |
| Scan component (GitHub Actions) | `Authorization: Bearer <INGEST_SECRET>` | `INGEST_SECRET` | `POST /scans/start`, `POST /ingest/v2` |
| Web UI                          | `Authorization: Bearer <APP_TOKEN>`     | `APP_TOKEN`     | every `/api/*` route                   |

Both are checked in constant time (`src/auth.ts`). They are **not interchangeable**: the UI token
cannot write records, the ingest secret cannot read the API. An unset secret refuses everything
(401), so a forgotten `APP_TOKEN` fails closed. A Cloudflare Access policy can replace `APP_TOKEN`:
protect the Worker route with Access and swap the one function `requireApp` in `src/v2/http.ts`
for a check of the `Cf-Access-Jwt-Assertion` JWT (not implemented, nothing else needs to change).

Secrets: `wrangler secret put APP_TOKEN`, `wrangler secret put GITHUB_DISPATCH_TOKEN` (and the
existing `INGEST_SECRET`, Slack secrets). Local: `packages/worker/.dev.vars` (git-ignored).
Vars (`wrangler.toml [vars]`): `GITHUB_REPOSITORY` (`owner/repo`), `SCAN_WORKFLOW` (default
`scan.yml`), `GITHUB_REF` (default `main`).

Errors: `{"error": "<code>"}`; validation errors add `"fields": {"path": ["message"]}`.

## Machine endpoints

### `POST /scans/start`

Body `{source, scanId, params?, triggeredBy?}` (`source` is `[a-z0-9_-]{1,40}`, `scanId` 8-100
chars). Creates a `running` scan and returns
`{scanId, resumed, status, config, since, checkpoint}`.

- `config`: the saved `SearchConfig` (table `settings`, key `search_config`), else
  `packages/shared/config/search-config.default.json`.
- `since`: `params.since` if given, else **start time of the last `succeeded`/`partial` scan of the
  source minus 2 days** (`SINCE_OVERLAP_MS`; covers late-listed notices, date-only publish dates and
  timezone skew; re-reading is harmless because ingest is idempotent), else `null`.
- Lock: `409 {error: "scan_running", runningScanId}` while another scan of the same source is
  `running` and its `last_heartbeat_at` is newer than 45 minutes. Older ones are marked `failed`
  (with a "stale lock" failure) and replaced. A partial unique index
  (`idx_scans_one_running`) makes the database itself enforce one running scan per source.
- Same `scanId` again: `200` with `resumed: true`, the same row and its last `checkpoint`; a running
  scan gets a fresh heartbeat. A scanId that belongs to another source is `409`.

### `POST /ingest/v2`

Body = `IngestV2BodySchema` (`{report, records[<=200]}`, shared package). `400` with field errors
if invalid; a record whose `source` differs from `report.source` is `400`.

Per record, keyed on `(source, sourceRecordId)` (`id = source:sourceRecordId`):

| Case                  | Result                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| unseen                | insert, version 1                                                                  |
| same `contentHash`    | only `last_checked_at` moves                                                       |
| different hash, wins  | new `record_versions` row with `changes`, main row updated, old versions untouched |
| different hash, loses | stored as a version with `flag` `older_notice` or `conflict`; live row kept        |

Supersede rule (`decideSupersede`): a record without a stored `noticeVersion` is replaced; comparable
versions (digit groups, so `Amendment 10 > Amendment 2`): higher or equal wins, lower is
`older_notice`; incomparable (`A` vs `B`, or the new one lost its version): a clearly later
`publishedAt` wins, an earlier one is `older_notice`, no date evidence is a `conflict` (live row
kept, a human decides). Re-posting the same stale snapshot does not add another version.

`changes` is a list of `{type, field, old, new, oldText?, newText?}`; types: `deadline_extended`,
`deadline_shortened`, `deadline_changed`, `published_changed`, `status_changed` (e.g. `open` ->
`cancelled`), `title_changed`, `notice_version_changed`, `estimated_value_changed`,
`award_value_changed`, `tender_fee_changed`, `bid_security_changed`, `scope_changed`, `item_added`,
`item_removed`, `item_quantity_changed`, `item_unit_changed`, `documents_changed`,
`content_changed` (hash differs but nothing tracked moved), `older_notice`, `conflict`.

Storage rules: unknown stays `NULL` (`deadline_at`, `published_at`, `record_items.quantity`, money
columns), never `0`/`''`. `estimated_*` and `award_*` are separate columns filled only from
`estimatedValue` / `awardValue`. Timestamps are normalised to UTC `toISOString()`.

The `report` updates the scan: heartbeat, `pagesChecked`/`recordsFound`/`documentsFetched` (max of
old and new), failures, coverage limitations, keywords, access status, checkpoint, and the
`running` -> terminal transition. `records_new` / `records_updated` are computed by the Worker and
accumulated. A scan that is already terminal keeps its status (a late `running` report cannot
reopen it; a scan failed by the stale-lock rule stays failed but its records are kept). A report
for an unknown `scanId` creates the scan (as if `/scans/start` had run; `409` if the source has a
live running scan).

A `blocked` report (first transition into `blocked`) posts one Slack alert if `SLACK_BOT_TOKEN` and
`SLACK_CHANNEL_ID` are set; best-effort, after the response, failures only logged. New v2 records
are **not** posted to Slack.

Response: `{ok, received, new, updated, unchanged, olderNotice, conflicts, results[{id, result,
version, changes[]}], scan}`.

Free-plan note: CPU is 10 ms per request; Zod validation of a large batch is the main cost. Send
smaller batches (e.g. 20-50) on the free plan; the paid plan handles 200. Per request: 1 read of the live rows, 1 read of the JSON of changed rows only, then writes in D1
`batch()` calls of about 100 statements (a record's statements stay together), never per-record round trips;
slow steps
are logged as `[slow] ...` like in `/ingest`.

## UI endpoints (`APP_TOKEN`)

### `GET /api/tenders`

Query: `q` (every word must appear in title/buyer/reference/scope/item text, substring,
case-insensitive), `category` (`motorbikes|riding_gear|ppe`, repeatable or comma list, OR),
`country`, `source`, `status` (`open|closed|cancelled|unknown`), `notice_type` (case-insensitive,
repeatable/comma), `publishedFrom|publishedTo|deadlineFrom|deadlineTo` (`YYYY-MM-DD`, or a full ISO
datetime; `To` dates include the whole day; records with an unknown date never match a range),
`shortlisted=1`, `minRelevance` (0..1), `sort`, `page` (from 1), `pageSize` (1..100, default 25).
Bad values give `400 {error: "invalid_query", fields}`.

Sorting (tested): `published_desc` / `published_asc`: unknown `publishedAt` **always last**;
`closing_soon`: deadlines `>= now` ascending, then past deadlines most recent first, then unknown;
`relevance_desc`: unscored last. Ties break on `id`. `now` comes from `now()` in `src/v2/http.ts`
(tests pin it with `setClock`).

Response `{items, total, page, pageSize}`. Item:
`{id, source, sourceRecordId, canonicalUrl, reference, title, buyer, country, noticeType,
noticeVersion, publishedAt, deadline: {value, originalText, status}, deadlineKnown,
deadlinePassed, status, categories, relevance: {score, explanation, groups}, estimatedValue:
{label: "Estimated value", amount, currency, status}, awardValue: {label: "Award value", ...},
shortlisted, firstSeenAt, lastCheckedAt, lastUpdatedAt, version}`. `status` is whatever the record
says: an unknown deadline has `deadline.value: null`, `deadlineKnown: false`, `deadlinePassed: null`
and is never turned into `open`.

### `GET /api/tenders/:id`

`:id` is URL-encoded `source:sourceRecordId` (`worldbank%3AOP00123`). Returns
`{id, summary, record (full TenderRecord), versions[{version, seenAt, contentHash, flag, isCurrent,
changes}] (newest first), shortlisted, shortlistNote, missingData, missingDetails,
conflictingData}`. `missingData` lists facts whose value is null (`reference`, `buyer`, `country`,
`publishedAt`, `deadline`, `estimatedValue`, `awardValue` (award notices only), `scopeOfSupply`,
`items`, `items.quantity`, `documents`); `missingDetails` maps each to `not_published` /
`could_not_verify`; `conflictingData` lists facts with status `conflicting`.

### Shortlist

`PUT /api/shortlist/:id` body `{note?}` (absent keeps the note, `null`/`""` clears it, max 2000
chars; `404` for an unknown record), `DELETE /api/shortlist/:id` (idempotent, returns `removed`),
`GET /api/shortlist` -> `{ids, items}` (summary rows plus `note`, `addedAt`).

### Scans and sources

`GET /api/scans?limit=` -> `{scans[], sources[]}`; `GET /api/scans/:id` -> `{scan}`; `GET /api/sources`
-> `{sources[]}` with, per source: `recordCount`, `running`, `lastScan`, `lastSuccessfulScan`,
`accessStatus` (of the latest scan), `lastFailure {scanId, at, status, accessStatus, message}`.
Known sources (`worldbank`, `tendersontime`) are listed even before their first scan.

`POST /api/scans` body `{source, params?}` dispatches the GitHub Actions workflow
(`POST /repos/{GITHUB_REPOSITORY}/actions/workflows/{SCAN_WORKFLOW}/dispatches`, inputs `source`,
`since`, `triggered_by: "ui"`) and returns `202`. It never scrapes. `501 {error: "not_configured",
message, missing[]}` names exactly what is unset; `409 scan_running` if a scan of that source runs;
`409 recently_dispatched` within 3 minutes of the previous dispatch (the workflow has not yet called
`/scans/start`); `502 dispatch_failed` if GitHub refuses (token never echoed). The token needs
"Actions: Read and write" on the repository. The workflow must accept the inputs `source`, `since`
and `triggered_by` under `on: workflow_dispatch`.

### Config

`GET /api/config` -> `{config, custom}` (`custom: false` = packaged default). `PUT /api/config` with a
`SearchConfig` (or `{config}`) validates with the shared `SearchConfigSchema` plus: group ids unique,
at most 100 terms per group and 200 exclusions, terms at most 80 chars, at most 100 countries, body
at most 64 KB (`413`), and **a term may not appear in two groups** (broad PPE stays separate from
riding gear). No history is kept.

## `/health`

Existing fields unchanged, plus `v2: {records, lastScan: {id, source, status, accessStatus,
startedAt, finishedAt, lastHeartbeatAt, found, new, updated} | null}`.

## Database (migration `0005_v2_records.sql`)

`records` (+ `record_items`, `record_versions`, `shortlist`), `scans`, `settings`. Indexes on
`published_at`, `deadline_at`, `status`, `country`, `source`, `relevance_score`.

**Search: indexed `LIKE` on `search_text`, not FTS5.** FTS5 does work under the local test D1 (checked),
but this dataset is small (hundreds to a few thousand notices), substring matching suits mixed word
forms ("helmet" finds "helmets", "motor" finds "motorcycle") without stemming rules, every FTS
insert/update costs extra D1 row writes against the free-plan daily write quota, and virtual tables
break `wrangler d1 export` backups. Revisit if the table grows past tens of thousands of rows
(a `LIKE '%x%'` scan cannot use an index; the other filters narrow first only when selective).

## Static UI and routing

`wrangler.toml` has `[assets] directory = "../web/dist"`, `binding = "ASSETS"`,
`not_found_handling = "single-page-application"`, `run_worker_first = true`. Installed Wrangler is
**3.114.17**, where `run_worker_first` is only a boolean (verified in its type definitions); with
`true` every request reaches the Worker, which handles `/health`, `/ingest*`, `/scans/*`, `/api/*`,
`/slack/*`, `/admin/*` itself and forwards any other GET/HEAD to `env.ASSETS.fetch()` (SPA fallback).
Unknown `/api/*` paths return a JSON 404, never `index.html`. Consequence: static files also count as
Worker requests (free plan: 100k/day, plenty for one team). Upgrading to Wrangler 4.x allows listing
the API paths in `run_worker_first` so static files skip the Worker; not done here because it is a
major upgrade (and `@cloudflare/vitest-pool-workers` 0.5 is paired with Wrangler 3). `wrangler dev` and
`wrangler deploy` need `packages/web/dist` to exist (build the UI first). Tests run without the
binding. Verified: `wrangler deploy --dry-run` parses the config and bundles the Worker (with a stand-in
assets directory).
