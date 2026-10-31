# Secrets

Every secret the project needs, where it comes from, and where to paste it.
Never commit any of these (see `CLAUDE.md`). Never put them in `.env` files that are tracked.

## Scraper (GitHub secrets)

Repo: Settings > Secrets and variables > Actions > New repository secret.

| Name            | Where it comes from                                           | Where to paste it |
| --------------- | ------------------------------------------------------------- | ----------------- |
| `TOT_EMAIL`     | Login email of the **demo** TendersOnTime account             | GitHub secret     |
| `TOT_PASSWORD`  | Password of the same demo account (never the paid account)    | GitHub secret     |
| `INGEST_URL`    | Full URL of the deployed worker endpoint, ending in `/ingest` | GitHub secret     |
| `INGEST_SECRET` | You generate it (see below); same value as the worker's       | GitHub secret     |

## Worker (Wrangler secrets)

Run from `packages/worker`: `pnpm exec wrangler secret put NAME` (it prompts for the value).
For local dev put them in `packages/worker/.dev.vars` (git-ignored).

| Name                   | Where it comes from                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `INGEST_SECRET`        | Same value as the GitHub secret of the same name                                     |
| `SLACK_BOT_TOKEN`      | Slack app > OAuth & Permissions > Bot User OAuth Token (`xoxb-...`)                  |
| `SLACK_SIGNING_SECRET` | Slack app > Basic Information > Signing Secret                                       |
| `SLACK_CHANNEL_ID`     | Slack: channel details > bottom of the About tab (`C...`)                            |
| `ANTHROPIC_API_KEY`    | console.anthropic.com > API keys                                                     |
| `CLAUDE_MODEL`         | Model id to use, e.g. a current Claude model id from the Anthropic docs (not secret) |

## End-to-end script (your shell only)

`pnpm e2e` (see `packages/worker/SLACK_SETUP.md` section 5d) reads, from your shell environment:
`E2E_INGEST_URL` (or `INGEST_URL`), `INGEST_SECRET`, `SLACK_BOT_TOKEN` (needs `channels:history` or
`groups:history`), `SLACK_CHANNEL_ID`. Same values as the Worker secrets. Do not put them in a tracked file.

## Deploys (GitHub secrets)

Used by `.github/workflows/deploy-worker.yml`.

| Name                    | Where it comes from                                                       |
| ----------------------- | ------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare dashboard > My Profile > API Tokens > Create Token (see below) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard > Workers & Pages > right sidebar "Account ID"       |

### Minimum Cloudflare token permissions

Create a custom token with:

- Account > Workers Scripts > Edit
- Account > D1 > Edit
- User > User Details > Read (lets wrangler identify the user)

Scope it to your single account. Use the "Edit Cloudflare Workers" template as a starting point
and remove what you do not need (zones, routes, KV, etc.) if you only use a `workers.dev` URL.

## INGEST_SECRET must match

The scraper sends `Authorization: Bearer <INGEST_SECRET>` and the worker compares it with its own
copy. The GitHub secret and the Wrangler secret **must be the identical string**, otherwise every
ingest (and every blocked/error alert) is rejected with 401. When you rotate it, update both.

Generate one:

```sh
openssl rand -hex 32
```

## Public vs private repo (Actions minutes)

- **Private repo, Free plan:** 2,000 Linux minutes/month. The scraper runs hourly, about
  24 x 30 = 720 runs/month, and each job is billed rounded **up** to whole minutes. So each run
  must stay under about 2.5 min of real time on average, and any run over 2:00 bills as 3 minutes
  (720 x 3 = 2,160 > 2,000). Aim for under 2:00 (720 x 2 = 1,440).
- **Public repo:** standard GitHub-hosted runners are free and unlimited. If the repo is public,
  never commit secrets, storage state or screenshots (they are git-ignored, keep it that way), and
  note that artifacts of public repos are readable by anyone: screenshots from blocked runs may
  show the demo account page.

## Added for the Scrapling sources and the web UI

| Secret / var                                                | Where it lives                                    | What for                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_TOKEN`                                                 | Wrangler secret (`wrangler secret put APP_TOKEN`) | The token you type into the web UI once. It authorises `/api/*` (read, shortlist, edit search settings). It is **different** from `INGEST_SECRET` so a leaked browser token can never write data. Generate with `openssl rand -hex 32`. |
| `INGEST_URL`, `INGEST_SECRET` (existing)                    | GitHub secrets                                    | Also used by `scan.yml`. `INGEST_URL` may be the Worker base URL or the full `.../ingest` URL the Playwright scraper uses: the Python sink strips a trailing `/ingest`, so one secret serves both workflows.                            |
| `GITHUB_DISPATCH_TOKEN`                                     | Wrangler secret                                   | Lets the UI's "Run scan" button dispatch `scan.yml`. Fine-grained token, this repo only, permission **Actions: Read and write**. Optional: without it the button returns a clear "not configured" message.                              |
| `GITHUB_REPOSITORY`, optional `GITHUB_REF`, `SCAN_WORKFLOW` | Worker vars (`wrangler.toml [vars]`)              | `owner/repo`, branch (default `main`), workflow file (default `scan.yml`).                                                                                                                                                              |
| `TENDER_SOURCES_CONTACT`, `TENDER_SOURCES_UA`               | env (set automatically in `scan.yml`)             | Identify the scraper honestly to the sites it contacts. Never set a browser-like User-Agent.                                                                                                                                            |
| `TOT_EMAIL`, `TOT_PASSWORD` (existing)                      | GitHub secrets                                    | Only for an authorised, logged-in TendersOnTime adapter (not built yet; see the handoff). Demo account only.                                                                                                                            |
