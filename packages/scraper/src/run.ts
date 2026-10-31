import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tender } from '@tender-monitor/shared';
import { playwrightLauncher } from './browser.js';
import { checkBlock, type BlockReason } from './block.js';
import { delayRangeFromEnv, randomDelayMs, realSleep, type Sleep } from './delay.js';
import { postIngest, reportBlocked, type IngestDeps } from './ingest.js';
import { loadKeywords } from './keywords.js';
import { parseResults } from './parse.js';
import { KEYWORDS_PATH, SCREENSHOT_DIR, STORAGE_STATE_PATH } from './paths.js';
import * as site from './site.js';
import type { Launcher, PageLike } from './types.js';

export { reportBlocked };

/** Hard cap from CLAUDE.md rule 1. */
export const MAX_PAGES_PER_KEYWORD = 2;

export class BlockedError extends Error {
  constructor(readonly reason: BlockReason | 'login-failed') {
    super(`blocked: ${reason}`);
    this.name = 'BlockedError';
  }
}

export interface Deps {
  launch: Launcher;
  sleep: Sleep;
  rand: () => number;
  fetch: typeof fetch;
  parse: (html: string, keyword: string) => Tender[];
  login: (page: PageLike, creds: site.Credentials, baseUrl: string) => Promise<void>;
  now: () => number;
  hasSession: () => boolean;
  keywordsPath: string;
  storageStatePath: string;
  screenshotDir: string;
  /** Results per full page; null = unknown (then page 2 is never opened). */
  pageSize: number | null;
  log: (line: string) => void;
  table: (rows: unknown[]) => void;
}

export function defaultDeps(env: NodeJS.ProcessEnv): Deps {
  return {
    launch: playwrightLauncher(env),
    sleep: realSleep,
    rand: Math.random,
    fetch: (...a) => fetch(...a),
    parse: parseResults,
    login: (page, creds, baseUrl) => site.login(page.raw as never, creds, baseUrl),
    now: () => Date.now(),
    hasSession: () => existsSync(STORAGE_STATE_PATH),
    keywordsPath: KEYWORDS_PATH,
    storageStatePath: STORAGE_STATE_PATH,
    screenshotDir: SCREENSHOT_DIR,
    pageSize: site.RESULTS_PAGE_SIZE,
    log: (l) => console.log(l),
    table: (rows) => console.table(rows),
  };
}

/**
 * Returns the process exit code: 0 ok, 1 failure, 2 blocked.
 *
 * DEVIATION (documented on purpose): the spec says "open page 2 only if every tender on page 1
 * was new". The scraper has no idea what is new (the worker/D1 decides that), so instead page 2
 * is opened only when page 1 returned a FULL page (tenders.length >= deps.pageSize), i.e. there
 * may be more recent results behind it. Hard cap: MAX_PAGES_PER_KEYWORD.
 */
export async function main(deps: Deps, argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const started = deps.now();
  const range = delayRangeFromEnv(env);
  const ingestDeps: IngestDeps = { fetch: deps.fetch, sleep: deps.sleep };
  let pagesLoaded = 0;
  let keywordsSearched = 0;
  let page: PageLike | undefined;
  let session: Awaited<ReturnType<Launcher>> | undefined;

  const screenshot = async (label: string): Promise<void> => {
    if (!page) return;
    try {
      await mkdir(deps.screenshotDir, { recursive: true });
      const file = path.join(deps.screenshotDir, `${label}-${deps.now()}.png`);
      await page.screenshot(file);
      deps.log(`screenshot saved: ${file}`);
    } catch (err) {
      deps.log(`could not take screenshot: ${(err as Error).message}`);
    }
  };

  try {
    if (!dryRun && (!env.INGEST_URL || !env.INGEST_SECRET)) {
      deps.log('INGEST_URL and INGEST_SECRET are required (or use --dry-run)');
      return 1;
    }
    const baseUrl = site.getBaseUrl(env);
    site.assertPoliteDelays(baseUrl, range);
    site.assertSiteConfigured(baseUrl);
    const keywords = await loadKeywords(deps.keywordsPath);

    const hadSession = deps.hasSession();
    session = await deps.launch(hadSession ? { storageStatePath: deps.storageStatePath } : {});
    page = await session.newPage();
    let loggedInThisRun = false;

    const doLogin = async (): Promise<void> => {
      if (!env.TOT_EMAIL || !env.TOT_PASSWORD) {
        throw new Error('TOT_EMAIL and TOT_PASSWORD are required to log in');
      }
      await deps.login(
        page as PageLike,
        { email: env.TOT_EMAIL, password: env.TOT_PASSWORD },
        baseUrl,
      );
      loggedInThisRun = true;
      const after = checkBlock(
        { status: 200, url: (page as PageLike).url(), html: await (page as PageLike).content() },
        { expectLoggedIn: true },
      );
      if (after.status === 'blocked') throw new BlockedError(after.reason);
      await session?.saveState(deps.storageStatePath);
    };

    /** Polite navigation + block check. Every page load goes through here. */
    const load = async (url: string): Promise<string> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (pagesLoaded > 0 || loggedInThisRun) {
          await deps.sleep(randomDelayMs(range, deps.rand));
        }
        const res = await (page as PageLike).goto(url);
        pagesLoaded++;
        const html = await (page as PageLike).content();
        const verdict = checkBlock(
          { status: res.status, url: (page as PageLike).url(), html },
          { expectLoggedIn: true },
        );
        if (verdict.status === 'ok') return html;
        // Expired stored session: log in ONCE and retry this URL. Anything else, or the login
        // form appearing again after we logged in, is a block: stop, never retry around it.
        if (verdict.reason === 'login-form-shown' && !loggedInThisRun) {
          deps.log('stored session expired, logging in');
          await doLogin();
          continue;
        }
        throw new BlockedError(verdict.reason);
      }
      throw new BlockedError('login-form-shown');
    };

    if (!hadSession) {
      deps.log('no stored session, logging in');
      await doLogin();
    }

    const byRef = new Map<string, Tender>();
    for (const keyword of keywords) {
      keywordsSearched++;
      for (let pageNo = 1; pageNo <= MAX_PAGES_PER_KEYWORD; pageNo++) {
        const html = await load(site.buildSearchUrl(baseUrl, keyword, pageNo));
        const tenders = deps.parse(html, keyword);
        for (const t of tenders) if (!byRef.has(t.totRef)) byRef.set(t.totRef, t);
        const full = deps.pageSize !== null && tenders.length >= deps.pageSize;
        if (!full) break;
      }
    }

    const all = [...byRef.values()];
    if (dryRun) {
      deps.table(all);
    } else {
      await postIngest(env, { source: 'github-actions', status: 'ok', tenders: all }, ingestDeps);
    }
    const secs = ((deps.now() - started) / 1000).toFixed(1);
    deps.log(
      `done: keywords=${keywordsSearched} pages=${pagesLoaded} tenders=${all.length} time=${secs}s${dryRun ? ' (dry run, nothing sent)' : ''}`,
    );
    return 0;
  } catch (err) {
    await screenshot(err instanceof BlockedError ? 'blocked' : 'error');
    if (err instanceof BlockedError) {
      deps.log(`RUN STOPPED: ${err.message}. Not retrying (see CLAUDE.md rule 2).`);
      if (!dryRun) {
        try {
          await reportBlocked(env, err.message, ingestDeps);
        } catch (reportErr) {
          deps.log(`could not report block: ${(reportErr as Error).message}`);
        }
      }
      return 2;
    }
    deps.log(
      `RUN FAILED after ${keywordsSearched} keyword(s), ${pagesLoaded} page(s): ${(err as Error).message}`,
    );
    return 1;
  } finally {
    await session?.close().catch(() => undefined);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(defaultDeps(process.env), process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
