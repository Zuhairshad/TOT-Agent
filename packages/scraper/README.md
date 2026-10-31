# @tender-monitor/scraper

Playwright scraper for TendersOnTime (demo account only). Read `/CLAUDE.md` first: polite scraping,
no bypass code, secrets only in env vars.

## Status

- `src/run.ts` (runner), `src/block.ts`, `src/ingest.ts`, `src/delay.ts`, `src/keywords.ts` are done and tested.
- `src/site.ts` (URLs, login) and `src/parse.ts` (parser) are **deliberate stubs**. They are written
  only after you run the explore script and `docs/site-notes.md` exists.

## 1. Run the explore script (on your laptop)

It needs a real browser window and you, so it cannot run in CI or in the Claude sandbox.

```bash
git clone <repo> && cd TOT-Agent
pnpm install
pnpm --filter @tender-monitor/scraper exec playwright install chromium   # on your laptop only
cp packages/scraper/.env.example packages/scraper/.env
# edit packages/scraper/.env: set TOT_EMAIL and TOT_PASSWORD (demo account ONLY, never the paid one)
pnpm --filter @tender-monitor/scraper explore
```

A Chromium window opens. The script logs in, saves `storage-state.json`, tries the search
(`motorcycle`, Zambia, newest first) and then **pauses** with the Playwright inspector so you can
check or fix the search by hand; click **Resume** (the play button) to continue. It does the same
if it hits a CAPTCHA/OTP: complete it yourself, then Resume. It stops on HTTP 403/429.

Options (env vars): `TOT_BASE_URL` (default `https://www.tendersontime.com`), `TOT_MANUAL_SEARCH=1`
(skip the automatic search attempt, do it by hand), `CHROMIUM_PATH` (use a specific Chromium).

Output:

| Path                                  | Content                                          | Committed?           |
| ------------------------------------- | ------------------------------------------------ | -------------------- |
| `packages/scraper/storage-state.json` | logged-in session                                | never (git-ignored)  |
| `packages/scraper/screenshots/*.png`  | full-page screenshots                            | never (git-ignored)  |
| `packages/scraper/fixtures/*.html`    | results page + one tender detail page            | yes, after scrubbing |
| `packages/scraper/fixtures/network/*` | JSON/XHR responses + `index.json` (urls, status) | yes, after scrubbing |

The script also prints the controls it finds (inputs, selects and their options) and the search URL;
keep that terminal output, it helps with the notes.

## 2. Scrub the fixtures before committing

The saved HTML is a logged-in page and probably contains **your email and name** (header, profile menu,
hidden inputs, tokens). Search `fixtures/` for your email, your name, `csrf`/`token`/`session` values and
replace them with placeholders (for example `demo@example.com`). Do not commit `storage-state.json`,
`.env` or screenshots. Check with `git status` and `git diff` before you commit.

## 3. Ask Claude Code to write the site notes

Paste this into Claude Code from the repo root:

> Read CLAUDE.md. Using ONLY the files in `packages/scraper/fixtures/` (HTML and `network/`) and the
> explore-script terminal output below, write `docs/site-notes.md` replacing the "TO BE GENERATED"
> placeholder. Cover: (1) login URL and form fields (names, submit, any CAPTCHA/OTP), (2) search URL
> pattern and every query param (keyword, country, sort newest first, page), (3) the CSS selector for each
> Tender field in `packages/shared/src/tender.ts` (totRef, title, country, purchaser, postedAt, deadline,
> value text/amount/currency, detail url) with an example value from the fixture, (4) pagination (results
> per page, how page 2 is requested), (5) what the demo account cannot see (locked or blurred fields,
> truncated lists), (6) whether `fixtures/network/` shows a JSON endpoint that returns the results; if so
> say so clearly because we will use it instead of HTML. Do not invent anything the fixtures do not show;
> write "unknown" instead. Then (separate step) update `src/site.ts` (constants, `login`,
> `RESULTS_PAGE_SIZE`, `SITE_CONFIGURED = true`), write `src/parse.ts` with tests against the fixtures, and
> replace the `it.todo` in `test/e2e.test.ts` with a real run against a local static server.

## Running the scraper

```bash
pnpm --filter @tender-monitor/scraper start -- --dry-run   # prints a table, sends nothing
```

Env: `TOT_EMAIL`, `TOT_PASSWORD`, `INGEST_URL`, `INGEST_SECRET`, optional `TOT_BASE_URL`, `CHROMIUM_PATH`.
Exit codes: `0` ok, `1` failure, `2` blocked (CAPTCHA/challenge/403/429/login form again). A block is
never retried; a screenshot goes to `screenshots/` and `{status:"blocked"}` is posted (unless `--dry-run`).
Page 2 of a keyword is opened only if page 1 was a full page (the scraper cannot know what is new);
the hard cap is 2 pages per keyword with a random 3-8 s wait between page loads. The test-only
`TOT_ALLOW_FAST_DELAYS` switch is refused for the real site (`site.assertPoliteDelays`).

## Tests

```bash
pnpm --filter @tender-monitor/scraper test
```

`test/e2e.test.ts` is an `it.todo` until real fixtures and the parser exist; the static-server harness
it will use is `test/helpers/staticServer.ts` (already tested).
