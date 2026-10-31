/**
 * One-off, HUMAN-ATTENDED exploration of TendersOnTime. Run it on your own laptop (see README.md).
 * It assumes NO site-specific selectors: it uses generic HTML heuristics (a password input, a
 * link that says "log in", ...) and falls back to page.pause() so you can finish a step by hand.
 * It saves what it sees so the parser and site.ts can be written against real fixtures.
 *
 * Politeness (CLAUDE.md): random 3-8 s between page loads; stops on 403/429; on a CAPTCHA it
 * saves a screenshot and hands control to YOU (you solve it, nothing automated).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Response } from 'playwright';
import { checkBlock } from '../src/block.js';
import { delayRangeFromEnv, randomDelayMs, realSleep } from '../src/delay.js';
import { FIXTURES_DIR, SCREENSHOT_DIR, STORAGE_STATE_PATH } from '../src/paths.js';
import { assertPoliteDelays, DEFAULT_BASE_URL } from '../src/site.js';

const KEYWORD = 'motorcycle';
const COUNTRY = 'Zambia';
const baseUrl = (process.env.TOT_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
const email = process.env.TOT_EMAIL;
const password = process.env.TOT_PASSWORD;
const range = delayRangeFromEnv(process.env);
assertPoliteDelays(baseUrl, range);
const networkDir = path.join(FIXTURES_DIR, 'network');

let loads = 0;
const say = (msg: string) => console.log(`[explore] ${msg}`);

async function polite(): Promise<void> {
  if (loads > 0) {
    const ms = randomDelayMs(range);
    say(`waiting ${(ms / 1000).toFixed(1)} s before next page load`);
    await realSleep(ms);
  }
  loads++;
}

async function shot(page: Page, name: string): Promise<string> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  say(`screenshot: ${file}`);
  return file;
}

async function saveHtml(page: Page, name: string): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const file = path.join(FIXTURES_DIR, name);
  await writeFile(file, await page.content(), 'utf8');
  say(`html saved: ${file}  (url: ${page.url()})`);
}

/** Block check after a navigation or an action. CAPTCHA -> screenshot + YOU solve it; hard block -> stop. */
async function guard(page: Page, status: number, label: string): Promise<void> {
  const verdict = checkBlock({ status, url: page.url(), html: await page.content() });
  if (verdict.status === 'ok') return;
  await shot(page, `blocked-${label}`);
  if (verdict.reason === 'captcha' || verdict.reason === 'challenge') {
    say(`A ${verdict.reason} is showing. Solve it yourself in the browser, then click Resume.`);
    await page.pause();
    return;
  }
  say(`BLOCKED (${verdict.reason}). Stopping; do not retry. Screenshot saved.`);
  process.exit(2);
}

async function go(page: Page, url: string, label: string): Promise<void> {
  await polite();
  say(`GET ${url}`);
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await guard(page, res?.status() ?? 0, label);
}

/** Print form controls and selects so the user/Claude can see what the page offers. */
async function describeControls(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(`(() => {
    const attr = (e, n) => e.getAttribute(n) || '';
    return {
      title: document.title,
      inputs: [...document.querySelectorAll('input,select,textarea,button')].slice(0, 60).map((e) => ({
        tag: e.tagName.toLowerCase(), type: attr(e, 'type'), name: attr(e, 'name'), id: e.id,
        placeholder: attr(e, 'placeholder'), text: (e.textContent || '').trim().slice(0, 40),
      })),
      selects: [...document.querySelectorAll('select')].map((s) => ({
        name: attr(s, 'name') || s.id,
        options: [...s.options].slice(0, 400).map((o) => o.text.trim()),
      })),
    };
  })()`);
  say(`--- controls on ${label} ---`);
  console.dir(info, { depth: 4, maxArrayLength: 80 });
}

async function login(page: Page): Promise<void> {
  if (!email || !password)
    throw new Error('Set TOT_EMAIL and TOT_PASSWORD in packages/scraper/.env');
  await go(page, baseUrl, 'home');
  await describeControls(page, 'home page');
  const pw = page.locator('input[type="password"]:visible').first();
  if (!(await pw.count())) {
    const link = page.getByRole('link', { name: /log\s?in|sign\s?in/i }).first();
    if (await link.count()) {
      await polite();
      say('clicking the login link');
      const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await link.click();
      await nav;
      await guard(page, 200, 'login-page');
    }
  }
  say(`login page url: ${page.url()}`);
  await describeControls(page, 'login page');
  if (!(await pw.count())) {
    say('Could not find a password field. Open the login form by hand, then click Resume.');
    await page.pause();
  }
  const form = page.locator('form:has(input[type="password"])').first();
  const user = form.locator('input[type="email"], input[type="text"]:visible').first();
  if ((await user.count()) && (await pw.count())) {
    await user.fill(email);
    await pw.fill(password);
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => undefined),
      pw.press('Enter'),
    ]);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await guard(page, 200, 'after-login');
  }
  if (await page.locator('input[type="password"]:visible').count()) {
    say('Still on a login form (CAPTCHA, OTP, or wrong form?). Log in by hand, then click Resume.');
    await page.pause();
  }
  say(`logged in (as far as we can tell). url: ${page.url()}`);
}

/** Best effort: fill keyword, pick Zambia / newest-first if such options exist, else ask the human. */
async function search(page: Page): Promise<void> {
  await describeControls(page, 'page before search');
  const box = page
    .locator(
      'input[type="search"]:visible, input[name*="search" i]:visible, input[placeholder*="search" i]:visible, input[name*="keyword" i]:visible',
    )
    .first();
  let auto = false;
  if (process.env.TOT_MANUAL_SEARCH !== '1' && (await box.count())) {
    await box.fill(KEYWORD);
    const selects = await page.locator('select:visible').all();
    for (const sel of selects) {
      const options = await sel.locator('option').allTextContents();
      const zambia = options.find((o) => new RegExp(`^\\s*${COUNTRY}\\b`, 'i').test(o));
      const newest = options.find((o) => /newest|latest|recent|date.*(desc|new)/i.test(o));
      if (zambia) await sel.selectOption({ label: zambia.trim() });
      else if (newest) await sel.selectOption({ label: newest.trim() });
    }
    await polite();
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => undefined),
      box.press('Enter'),
    ]);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await guard(page, 200, 'search');
    auto = true;
  }
  say(
    auto
      ? `Automatic attempt done. In the browser, CHECK that keyword="${KEYWORD}", country=${COUNTRY}, newest first are applied; fix them by hand if not, wait for results, then click Resume.`
      : `In the browser: search "${KEYWORD}", country ${COUNTRY}, sort newest first, wait for results, then click Resume.`,
  );
  await page.pause();
  say(`SEARCH URL (note this for site-notes): ${page.url()}`);
}

async function findDetailLink(page: Page): Promise<string | null> {
  const links = (await page.evaluate(`[...document.querySelectorAll('a[href]')]
    .map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 80) }))
    .filter((l) => /tender|notice|detail|view/i.test(l.href + ' ' + l.text))
    .slice(0, 40)`)) as { href: string; text: string }[];
  say('candidate detail links (first 15):');
  links.slice(0, 15).forEach((l, i) => console.log(`  ${i}. ${l.text}  ->  ${l.href}`));
  const here = page.url();
  const pick = links.find((l) => l.href !== here && !l.href.endsWith('#') && l.text.length > 8);
  return pick?.href ?? null;
}

async function main(): Promise<void> {
  await mkdir(networkDir, { recursive: true });
  const browser = await chromium.launch({
    headless: false, // headed so you can watch
    executablePath: process.env.CHROMIUM_PATH?.trim() || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  try {
    await login(page);
    await context.storageState({ path: STORAGE_STATE_PATH });
    say(`session saved: ${STORAGE_STATE_PATH} (git-ignored; never commit)`);

    // Record XHR/fetch/JSON responses from here on (after login, so no credentials are captured).
    const index: unknown[] = [];
    let n = 0;
    page.on('response', (res: Response) => {
      void (async () => {
        try {
          const req = res.request();
          const type = res.headers()['content-type'] ?? '';
          const isApi = ['xhr', 'fetch'].includes(req.resourceType()) || type.includes('json');
          if (!isApi) return;
          const id = String(++n).padStart(3, '0');
          const u = new URL(res.url());
          const slug = (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
          const ext = type.includes('json') ? 'json' : 'txt';
          index.push({
            id,
            method: req.method(),
            url: res.url(),
            status: res.status(),
            type,
            postData: req.postData() ?? undefined,
            file: `${id}-${slug}.${ext}`,
          });
          await writeFile(path.join(networkDir, `${id}-${slug}.${ext}`), await res.body());
        } catch {
          /* body not available (redirect etc.) */
        }
      })();
    });

    await search(page);
    await saveHtml(page, 'results-page-1.html');
    await shot(page, 'results-page-1');

    const detail = await findDetailLink(page);
    if (detail) {
      await go(page, detail, 'detail');
    } else {
      say(
        'No obvious detail link. Open ONE tender detail page by hand in this tab, then click Resume.',
      );
      await page.pause();
    }
    await saveHtml(page, 'tender-detail.html');
    await shot(page, 'tender-detail');
    say(
      `If this is not a tender detail page, re-run with TOT_MANUAL_SEARCH=1 and open one by hand.`,
    );

    await writeFile(path.join(networkDir, 'index.json'), JSON.stringify(index, null, 2));
    say(`network log: ${index.length} JSON/XHR responses in ${networkDir}`);
    say('Done. NOW scrub your email/name from fixtures/ before committing (see README.md).');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[explore] failed:', err);
  process.exit(1);
});
