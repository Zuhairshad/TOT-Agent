# tender-monitor: rules for Claude Code

A pnpm monorepo: `packages/shared` (Zod Tender schema), `packages/scraper` (Playwright, runs on
GitHub Actions), `packages/worker` (Cloudflare Worker + D1 + Slack).

## Rules (follow in every task)

1. **Polite scraping only.** Max one run per hour, max 2 result pages per keyword, a random 3-8 s
   wait between page loads, a normal Chromium.
2. **No bypass code.** Never add CAPTCHA solvers, stealth plugins, fingerprint spoofing or proxy
   rotation. If the site shows a CAPTCHA, a bot challenge or blocks login: stop, save a screenshot,
   report it, exit with an error (exit code 2).
   2a. **Scrapling: honest configuration only.** Scrapling ships bypass features that are OFF-LIMITS
   here: `StealthyFetcher`/`StealthySession`, `solve_cloudflare`, `ProxyRotator`/`proxy`,
   `impersonate=` (TLS fingerprint spoofing), `stealthy_headers=True` (fake browser headers and a
   fake Google referer; this is Scrapling's DEFAULT, so it must be switched off), `google_search`,
   and its MCP server's stealth tools against any real source. Build every client through
   `tender_sources.http.PoliteClient`, which sends `impersonate=None, stealthy_headers=False` and an
   honest User-Agent. A Cloudflare/bot challenge on a source means that source is `blocked`: record
   it, never work around it. Prefer official APIs and feeds.
3. **Demo account only.** Use only the demo TendersOnTime account, from env vars (`TOT_EMAIL`,
   `TOT_PASSWORD`). Never hard-code credentials. Never use the paid Yesbike account in code.
4. **Tests for every module.** No task is done until `pnpm test` passes.
5. **Secrets live only in env vars, Wrangler secrets or GitHub secrets.** Never commit `.env`,
   `.dev.vars`, `storage-state.json`, tokens or screenshots.

## Conventions

- TypeScript strict, ESM. Prettier + ESLint (`pnpm lint`, `pnpm typecheck`).
- The shared `TenderSchema` / `IngestBodySchema` in `packages/shared` is the single contract between
  scraper and worker. Change it there, not in copies.
- Do not guess selectors: parsers are written only against saved fixtures in
  `packages/scraper/fixtures/`.
- Python sources live in `packages/sources` (package `tender_sources`); the record contract is
  `packages/shared/src/record.ts` (JSON Schemas are exported to `packages/shared/schema/`).
- Never show fixtures as live results; label them `FIXTURE` in the file and in the UI.
- Never invent missing values: `null` plus a status, never 0. Keep estimated value, award value,
  tender fee and bid security in their own fields.
- Do not commit or push unless the user asks.
