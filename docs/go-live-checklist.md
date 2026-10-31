> **Scrapling sources, API and web UI**: see `docs/scrapling-handoff.md` for status, blockers and
> decisions. This checklist covers the original Playwright/Slack pipeline.

# Go-live checklist

Honest status as of 2026-10-30. Nothing here has run against the real TendersOnTime site, a real
Cloudflare account or a real Slack workspace: the sandbox has no access to any of them, and no
production test was faked. Read `CLAUDE.md` first.

## Done and verified in the sandbox

Verified by `pnpm test` (177 tests pass, 1 `it.todo`), `pnpm typecheck`, `pnpm lint`, `pnpm exec prettier --check .`.

- [x] Shared contract: `TenderSchema` / `IngestBodySchema` (`packages/shared`).
- [x] Worker `POST /ingest`: auth, validation, dedupe, keyword merge, Slack cards (max 15 per run + "+N more"), blocked alert.
- [x] Slack buttons (Shortlist / Ignore) with signature check and replay protection; `shortlisted_at` stored (migration 0004).
- [x] Document reading in shortlisted threads (Claude JSON extraction, retry, PDF build, upload) against faked Slack/Anthropic.
- [x] Daily summary at 05:00 UTC = 07:00 Zambia, with "yesterday" defined as the Africa/Lusaka calendar day; closing-soon list capped at 10 + "+N more".
- [x] Deadline reminders (7 days / 2 days, in the tender thread, once each, only the most urgent when shortlisted late).
- [x] `scheduled()` dispatches on `controller.cron` (watchdog vs daily); `wrangler.toml` crons are pinned to the code by a test.
- [x] Free-plan limits designed for: daily job is at most about 45 subrequests (reminders capped at 10 per run, summary 2).
- [x] Scraper runner: block detection (exit 2, screenshot, never retry), max 2 pages per keyword, 3-8 s waits, delay floor for the real site, session reuse, dry run.
- [x] Scrape workflow: hourly cron, no overlap, session cache, screenshot artifact on failure, blocked/error notification.
- [x] `scripts/e2e.ts` + `pnpm e2e --dry-run`, and the `TEST-`-only admin delete endpoint: logic tested with injected fetch.
- [x] Rules review (`docs/rules-review.md`) and runbook (`docs/runbook.md`).

## Needs you (cannot be done in this sandbox)

Do these in order. Stop at the first thing that does not work and read the runbook.

### Phase 1: teach the scraper about the real site (laptop)

1. [ ] Create or confirm the **demo** TendersOnTime account (never the paid Yesbike one).
2. [ ] Copy `packages/scraper/.env.example` to `packages/scraper/.env`, fill `TOT_EMAIL` / `TOT_PASSWORD` (demo only).
3. [ ] `pnpm --filter @tender-monitor/scraper exec playwright install chromium`, then run
       `pnpm --filter @tender-monitor/scraper explore` and follow the prompts (you finish login/search by hand).
       Decide how to treat a CAPTCHA there: today `explore.ts` pauses so **you** solve it by hand (see `docs/rules-review.md`).
4. [ ] Scrub your email, name and tokens from `packages/scraper/fixtures/`. Check `git status`: no `.env`, `storage-state.json`, screenshots.
5. [ ] Generate `docs/site-notes.md` from the fixtures (prompt in `packages/scraper/README.md` section 3). Nothing guessed: "unknown" where the fixtures do not say.
6. [ ] Write `packages/scraper/src/parse.ts` (with tests against the fixtures) and the `site.ts` login / search constants, `RESULTS_PAGE_SIZE`.
       Replace the `it.todo` in `packages/scraper/test/e2e.test.ts`.
7. [ ] Flip `SITE_CONFIGURED = true` in `packages/scraper/src/site.ts` only after steps 5-6.
       Until then keep the Scrape workflow **disabled** (it would fail every hour).

### Phase 2: Cloudflare

8. [ ] `cd packages/worker && pnpm exec wrangler d1 create tender-monitor`; put the printed id into `wrangler.toml` (`database_id`).
9. [ ] Apply migrations: `pnpm exec wrangler d1 migrations apply tender-monitor --remote` (0001 to 0004).
10. [ ] Worker secrets (`pnpm exec wrangler secret put NAME`): `INGEST_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`
        (the **test** channel for now), `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`. See `docs/secrets.md`.

### Phase 3: Slack

11. [ ] Create the Slack app per `packages/worker/SLACK_SETUP.md`: scopes (`chat:write`, `channels:history` or `groups:history`,
        `files:read`, `files:write`), Interactivity URL, Event Subscriptions URL, invite the bot to the test channel (`#tenders-test`).
        `*:history` is also what `pnpm e2e` needs to read the channel.

### Phase 4: deploy and prove it

12. [ ] Add GitHub secrets: `TOT_EMAIL`, `TOT_PASSWORD`, `INGEST_URL` (ending `/ingest`), `INGEST_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
13. [ ] Deploy: `cd packages/worker && pnpm exec wrangler deploy` (or push to `main` after step 8: the deploy workflow runs the tests, migrations, deploy).
        Confirm `curl https://<worker>/health` works and Slack shows "Verified" for the Events URL.
14. [ ] **e2e against production**: from the repo root
        `E2E_INGEST_URL=https://<worker>/ingest INGEST_SECRET=... SLACK_BOT_TOKEN=... SLACK_CHANNEL_ID=<test channel id> pnpm e2e`.
        First try `pnpm e2e --dry-run`. Expect PASS on every step and an empty test channel afterwards.
        This script has **not** been run against anything real yet.
15. [ ] Check by hand that Shortlist and Ignore buttons work on a real card, and upload a small PDF in a shortlisted thread.
16. [ ] **PDF CPU decision (yours)**: the summary-PDF step is expected to exceed the free plan's 10 ms CPU limit (indicative Node numbers: about
        20-45 ms warm, about 100 ms cold; not measured on Workers). Measure with `wrangler tail` (`cpuTime`) after step 15, then choose:
        Workers Paid plan, move only the PDF step to a GitHub Action, or post the summary as Slack text instead of a PDF.
        Details: `docs/runbook.md` section E. Everything else in the Worker is designed for the free plan.

### Phase 5: first scrape, still on the test channel

17. [ ] Enable the Scrape workflow, then Actions > Scrape > Run workflow with **`dry_run` ticked**. Read the printed table.
18. [ ] Run it once with `dry_run` off while `SLACK_CHANNEL_ID` still points at `#tenders-test`. Check cards, links, deadlines.
19. [ ] Check Actions minutes after a day (Settings > Billing). Target under 2:00 per run (`docs/secrets.md`, "Public vs private repo").
20. [ ] Let it run a few hours. Confirm the watchdog stays quiet and `/health` shows fresh runs.
21. [ ] Wait for 07:00 Zambia time once: the daily summary should arrive in the test channel. Shortlist a tender with a near deadline to see a reminder.

### Phase 6: switch to the real channel

22. [ ] Only now: `wrangler secret put SLACK_CHANNEL_ID` with the `#tenders` channel id, invite the bot there.
23. [ ] Watch the first 24 hours: runs every hour in Actions, a summary at 07:00, no "BLOCKED" alerts.
24. [ ] Read `docs/runbook.md` once, and decide the open points in `docs/rules-review.md` (manual dispatch, explore CAPTCHA pause,
        public vs private repo, keeping the `/admin/tenders` route).
25. [ ] Optional: delete leftover test rows (`TEST-*`) if a failed e2e left any (the script tells you).

## Known limits

- Zero tenders for days is not alerted automatically; the daily summary showing "0 new tenders" is the signal (runbook B).
- Tenders shortlisted before migration 0004 have no `shortlisted_at` and are not counted in any daily summary.
- The e2e fake tender writes a `runs` row, which counts as a watchdog heartbeat for up to 3 hours.
