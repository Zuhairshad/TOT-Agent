# Runbook

What to do when something goes wrong. Read `CLAUDE.md` first: the rules there (polite scraping, no
bypass code, demo account only, secrets only in env) apply while you fix anything.

Handy values (replace `<worker>` with your Worker URL):

```sh
curl -s https://<worker>/health        # last run (time, status, found, new) and tender counts
```

Where things are: scrape runs = GitHub > Actions > "Scrape". Worker logs = Cloudflare dashboard >
Workers & Pages > tender-monitor-worker > Logs, or `pnpm --filter @tender-monitor/worker exec wrangler tail`.

---

## A. Slack says "Scraper run BLOCKED"

This means the site showed a CAPTCHA or bot check, answered 403/429, or bounced the login. The
scraper already stopped, saved a screenshot and exited with code 2. **Never bypass it** (no solver,
no proxy, no stealth, no retry loop) and do not re-run the workflow over and over.

1. Open the failed run in GitHub > Actions > Scrape. Download the artifact `screenshots-<run id>`
   (kept 7 days). Look at what the page showed (CAPTCHA? "unusual traffic"? login form? error page?).
   The log line says the reason: `http-403`, `http-429`, `captcha`, `challenge` or `login-form-shown`.
2. Open the site by hand in your normal browser, logged in with the **demo** account. Does it work?
   If you see a CAPTCHA yourself, solve it there as a normal user; that is fine, the scraper is not involved.
3. Wait. Do nothing for at least a few hours (a day for 403/429). The hourly schedule keeps going on its
   own; each hourly attempt is one polite visit, not a loop. If you want it quiet while you investigate,
   disable the workflow (Actions > Scrape > "..." > Disable workflow).
4. If it keeps happening, lower the frequency: edit the cron in `.github/workflows/scrape.yml` (for
   example `7 */3 * * *`, every 3 hours) and update `packages/worker/src/cron.ts` (`STALE_AFTER_MS`) so the
   watchdog does not complain. Fewer keywords in `packages/scraper/keywords.json` also means fewer page loads.
5. If it is still blocked after a few days at a lower frequency, stop scraping. Switch to the email
   plan: TendersOnTime's alert emails to a mailbox, parsed or forwarded to the same `/ingest` contract
   (`packages/shared`). That is a design decision for you; the scraper is not the only way to feed the Worker.
6. `login-form-shown` right after a successful login can also mean the demo account expired or was
   logged out elsewhere: see section D.

Do not: add a user agent, delay tricks, extra retries, or "just try once more" scripts.

---

## B. The scraper finds 0 tenders for 2 days

Nothing alerts on this automatically (the watchdog only alerts when there are no runs). The signal is
the daily summary saying "Yesterday: 0 new tenders" twice, or `/health` showing `lastRun.found = 0`.

1. **Actions log**: open the latest Scrape runs. Is the run green? Read the final line
   `done: keywords=... pages=... tenders=...`. `tenders=0` with `pages>0` means the pages loaded but the
   parser found nothing. A red run is a different problem (see A or the error text).
2. **Look at the site by hand** (normal browser, demo account): search one keyword, country Zambia,
   newest first. Are there results at all? Zero results on the site means this is not a bug.
3. **Session / login**: the stored session is cached per ISO week. If the site silently logged the
   scraper out the pages may be the public version with no results. Bump the cache key (section D, step 5)
   and re-run with `dry_run`.
4. **Keywords**: `packages/scraper/keywords.json`. Typos, or keywords that stopped matching, give 0.
5. **Parser vs fresh fixtures**: if the site works by hand and the log shows pages loaded, the layout
   probably changed: follow section C.
6. Dry run to see what the scraper sees without sending anything: Actions > Scrape > Run workflow >
   tick `dry_run`. The log prints a table of what it parsed.

---

## C. The site layout changed (parser returns nothing or wrong fields)

Rule: the parser is only ever written against saved real fixtures (`CLAUDE.md`). The tests must go red
on the new fixtures first (proving they test the page), then green after the fix. Run on your laptop.

```sh
git switch -c fix/site-layout
# 1. Re-capture. Opens a headed browser; you finish steps by hand and click Resume.
pnpm --filter @tender-monitor/scraper explore
#    writes packages/scraper/fixtures/results-page-1.html, tender-detail.html, network/*, screenshots/
# 2. Scrub your email/name/tokens from fixtures/ (see packages/scraper/README.md section 2).
#    Never commit storage-state.json, .env or screenshots.
git diff --stat packages/scraper/fixtures     # review what changed
# 3. RED: the parser tests must fail against the new fixtures.
pnpm --filter @tender-monitor/scraper test
```

Read the failures. Two cases:

- Selectors no longer match (fields empty or wrong): this is the layout change. Continue.
- Selectors still match and only the sample values differ (new tenders in the fixture): the layout did
  not change; update the expected values in `packages/scraper/test/parse.test.ts` deliberately, then go to step 6.

```sh
# 4. Regenerate docs/site-notes.md from the new fixtures (ask Claude Code with the prompt in
#    packages/scraper/README.md section 3), then fix selectors in packages/scraper/src/parse.ts
#    and URL/login constants in packages/scraper/src/site.ts.
# 5. GREEN
pnpm --filter @tender-monitor/scraper test
# 6. Everything
pnpm test && pnpm typecheck && pnpm lint && pnpm exec prettier --check .
# 7. Prove it on the real site without sending anything: Actions > Scrape > Run workflow, dry_run = true.
```

Do not edit a test just to make it pass without understanding why it failed. Commit fixtures, parser
and notes together.

---

## D. The demo account stops working

Signs: `login-form-shown` / login failures in the run log, blocked alerts right after login, the site
telling you the account expired.

1. Check by hand in a normal browser that the demo credentials still log in.
2. If not, sign up for a **new demo account** on TendersOnTime with a new email. Use only the demo
   account, never the paid Yesbike one.
3. GitHub > Settings > Secrets and variables > Actions: update `TOT_EMAIL` and `TOT_PASSWORD`.
4. Update your laptop `packages/scraper/.env` too if you use `explore`.
5. Clear the cached login session so the old one is not reused. Either bump the key in
   `.github/workflows/scrape.yml` (both `key: storage-state-...` lines, e.g. `storage-state-v2-...`), or
   delete the cache: GitHub > Actions > Caches > delete the `storage-state-*` entries.
6. Re-run the workflow manually: Actions > Scrape > Run workflow with `dry_run` ticked. It logs in once,
   saves the session and prints the table. Only if that looks right, let the hourly schedule continue.
7. If the site layout of the new demo account differs (different columns or locked fields), see C.

---

## E. "PDF step exceeds the 10 ms CPU limit"

Symptom: a file uploaded in a shortlisted tender's thread gets "Got it, reading the document..." and
then no PDF, or Cloudflare shows outcome `exceededCpu` / error 1102 for `/slack/events` invocations.

Background (`packages/worker/scripts/measure-cpu.ts`, `packages/worker/SLACK_SETUP.md` "CPU budget"):
the free plan allows 10 ms of **CPU** per invocation; waiting for Claude, Slack or D1 is free. The
heavy steps are building the summary PDF with `pdf-lib` and base64-encoding the upload. Indicative
Node numbers from `pnpm --filter @tender-monitor/worker measure:cpu` (a lower bound, not Workers numbers):

| Step                                | Node CPU (indicative) |
| ----------------------------------- | --------------------- |
| `buildTenderPdf`, 10 items (warm)   | about 20 ms           |
| `buildTenderPdf`, 60 items (warm)   | about 45 ms           |
| `buildTenderPdf`, first call (cold) | about 100 ms          |
| native base64, 5 MB                 | about 12 ms           |
| `JSON.parse` of a 344 KB reply      | about 1 ms            |

So the PDF build alone is expected to exceed 10 ms on the free plan. **This has not been measured on a
real Worker** (the sandbox cannot): measure it first with `wrangler tail` (`cpuTime` per invocation) or
Workers Observability, as described in SLACK_SETUP.md.

Options, cheapest first:

1. **Workers Paid plan** (about USD 5 per month): CPU limit becomes 30 s per request by default. No code
   change. Simplest and the recommended route if the PDF is wanted.
2. **Move only the PDF step out of the Worker.** `src/document-hook.ts` was written so that `buildTenderPdf`
   is the only CPU-heavy function: store the validated JSON in `tender_details` (already done before the
   PDF step), then have a GitHub Action or other small job build the PDF from that JSON and upload it to
   the thread. Free, but it adds a moving part and a delay.
3. **Drop the PDF and post the summary as a Slack message.** Claude's extracted JSON is already stored;
   format it as Block Kit text in the thread. No `pdf-lib`, almost no CPU. Loses the printable file.
4. **Shrink the work**: limit items per PDF, simpler layout, no repeated header per page. Helps a little;
   unlikely to get under 10 ms on its own.

Whatever you choose, keep the JSON-before-PDF order so a failed PDF never loses the extraction.

---

## F. Quick reference

| Symptom                                            | Go to                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Slack: "Scraper run BLOCKED"                       | A                                                                                                                                    |
| Slack: "Scraper hasn't reported in 3 hours"        | Actions tab: is the workflow disabled, failing, or the Worker URL/secret wrong (401 in the log)?                                     |
| Daily summary: "0 new tenders" two days running    | B                                                                                                                                    |
| Run fails right after login                        | D (then A)                                                                                                                           |
| No daily summary at 07:00                          | Worker logs for the `0 5 * * *` cron; check the Worker is deployed and `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` are set                  |
| PDF never arrives                                  | E                                                                                                                                    |
| Wrong test row/card left in Slack after `pnpm e2e` | The script prints `delete ... by hand`; `DELETE /admin/tenders/<TEST-ref>` with the Bearer secret, delete the Slack message manually |
