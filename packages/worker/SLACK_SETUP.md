# Slack app setup for the tender-monitor Worker

Replace `https://tender-monitor-worker.<your-subdomain>.workers.dev` below with your deployed Worker URL.

## 1. Create the app

https://api.slack.com/apps -> Create New App -> From scratch. Install it to your workspace, then invite the bot to the tender channel (`/invite @YourApp`). With the bot in the channel, no `chat:write.public` scope is needed.

## 2. Bot token scopes (OAuth & Permissions -> Bot Token Scopes)

| Scope              | Why the Worker needs it                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `chat:write`       | `chat.postMessage` (tender cards, alerts, thread replies) and `chat.update` (shortlist / ignore edits)                            |
| `channels:history` | Required to receive `message.channels` events (file uploads in threads of a public channel)                                       |
| `groups:history`   | Same, only if the tender channel is private (`message.groups`)                                                                    |
| `files:read`       | **Required.** `files.info` (file name/type/size/`url_private`) and downloading the file from `url_private` with the bot token     |
| `files:write`      | **Required.** `files.getUploadURLExternal` and `files.completeUploadExternal` (uploading the generated summary PDF to the thread) |

Not needed: `chat:write.public`, `users:read` (we mention users with `<@U123>`), `commands`, `app_mentions:read`.
If the tender channel is public, skip `groups:history`; if private, skip `channels:history`.

After changing scopes, reinstall the app and copy the **Bot User OAuth Token** (`xoxb-...`).

Scope per call (all use the bot token):

| Call                                                 | Scope                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `chat.postMessage`, `chat.update`                    | `chat:write`                                                           |
| `files.info`                                         | `files:read`                                                           |
| `GET url_private` (download the uploaded tender PDF) | `files:read`                                                           |
| `files.getUploadURLExternal`                         | `files:write`                                                          |
| `POST upload_url` (raw bytes), no token needed       | none (the URL is pre-signed)                                           |
| `files.completeUploadExternal`                       | `files:write` (posts into the thread, so also `chat:write` is covered) |
| receiving `message.channels` / `message.groups`      | `channels:history` / `groups:history`                                  |

If `files:read` is missing, Slack answers the download with an HTML login page; the Worker detects that (the bytes are not `%PDF-`) and says so in the thread. After adding `files:write` / `files:read`, **reinstall the app** and update `SLACK_BOT_TOKEN` if it changed.

## 3. Interactivity (Interactivity & Shortcuts)

- Toggle **On**
- Request URL: `https://tender-monitor-worker.<your-subdomain>.workers.dev/slack/interactions`

This receives the Shortlist and Ignore button clicks.

## 4. Event subscriptions (Event Subscriptions)

- Toggle **On**
- Request URL: `https://tender-monitor-worker.<your-subdomain>.workers.dev/slack/events` (the Worker answers Slack's `url_verification` challenge; the Worker must be deployed with `SLACK_SIGNING_SECRET` set first)
- Subscribe to bot events:
  - `message.channels` (public channel) and/or `message.groups` (private channel)

File uploads arrive as `message` events with `files` / subtype `file_share`, so no separate `file_shared` event is needed. The Worker only reacts to uploads inside a thread whose parent message is a shortlisted tender.

## 5. Secrets

Collect these from the app (Basic Information -> Signing Secret; OAuth & Permissions -> token) and set them on the Worker:

```
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_CHANNEL_ID      # right-click the channel -> Copy link; the C... id is at the end
wrangler secret put INGEST_SECRET         # any long random string, also stored as a GitHub secret for the scraper
```

For local dev put the same names in `packages/worker/.dev.vars` (git-ignored; see `.dev.vars.example`).

## 5b. Claude API (document reading)

```
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put CLAUDE_MODEL          # a model id that accepts PDF input; keep it out of the code
```

Limits: Claude accepts PDFs up to 32 MB / 100 pages per request; the Worker refuses PDFs over 20 MB (a Worker has 128 MB of memory, and the base64 copy is 1.33x the file plus the JSON request body). Slack itself allows far bigger uploads, so very large tender documents need splitting. Only PDF is read for now: `.docx` / `.xlsx` uploads get a thread reply saying so.

### CPU budget (free plan: 10 ms CPU per request)

The limit counts **CPU time, not wall time**: waiting for the Claude API, Slack or D1 is free, so the long Claude call is not the issue. The CPU-heavy parts are base64-encoding the PDF (the Worker uses a native encoder, about 1.5 ms per MB in Node, versus about 55 ms per MB for the chunked `btoa` fallback), parsing a large JSON reply, and `pdf-lib` building the summary PDF (see `pnpm --filter @tender-monitor/worker measure:cpu` for indicative Node numbers).

Measure it on the real Worker, because Node numbers are only an indicative lower bound (workerd's V8 is the same, but Node startup/JIT state differs, and the Worker's clock is frozen during pure CPU work so `performance.now()` shows about 0):

1. `wrangler tail tender-monitor-worker --format json` while uploading a PDF to a shortlisted thread: each invocation log has `cpuTime` and `wallTime` in ms (an exceeded CPU limit shows as outcome `exceededCpu`).
2. Or Workers & Pages -> your Worker -> Observability (Workers Observability), filter on `/slack/events` and read the CPU time column / percentiles.

## 5c. Scheduled jobs (no extra Slack setup)

`wrangler.toml` has two crons, dispatched on `controller.cron` in `src/scheduled.ts`:

| Cron          | UTC / Zambia  | Job                                                                                         |
| ------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `0 */3 * * *` | every 3 hours | Watchdog: alert if the scraper has not reported in for 3 hours                              |
| `0 5 * * *`   | 05:00 / 07:00 | Daily summary ("Yesterday: X new, Y shortlisted, Z closing in 7 days") + deadline reminders |

"Yesterday" is the previous **Africa/Lusaka** calendar day (UTC+2, no DST). Reminders are posted in the
tender's thread 7 days and 2 days before the deadline (once each). They only need `chat:write`. Cloudflare
cron times are UTC.

## 5d. End-to-end check (`pnpm e2e`)

`pnpm e2e` (repo root) posts one fake tender (`TEST-<timestamp>`) to the deployed Worker, looks for its card
in the channel with `conversations.history`, then deletes the D1 row (`DELETE /admin/tenders/TEST-...`, the
Worker refuses any other ref) and the Slack message (`chat.delete`).

Extra Slack requirement: the bot must be able to **read** the channel, so it needs `channels:history`
(public channel) or `groups:history` (private channel). These are the same scopes already listed above for
events. Without them the script fails with `missing_scope` and tells you which scope to add. Deleting the card
works with `chat:write` (a bot can delete its own messages). Reinstall the app after adding scopes.

Env vars for the script (shell or `.env` at the repo root, never committed): `E2E_INGEST_URL` (or `INGEST_URL`,
ending in `/ingest`), `INGEST_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`. Point `SLACK_CHANNEL_ID` at the
**test** channel that the Worker is posting to. `pnpm e2e --dry-run` prints the plan and sends nothing.

## 6. Quick check

1. `curl https://<worker>/health` returns JSON.
2. Slack accepts the Events URL (green "Verified").
3. POST a sample body to `/ingest` with `Authorization: Bearer $INGEST_SECRET`; a card with Shortlist / Ignore appears in the channel.
