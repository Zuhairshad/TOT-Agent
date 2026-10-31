/**
 * Drive the built UI against the mock API and save screenshots to test-results/.
 *   pnpm --filter @tender-monitor/web build && pnpm dev:mock &   (then)
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @tender-monitor/web screenshots
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const sizes = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } };
const detailHash = '#/tender/' + encodeURIComponent('fixture:FIXTURE-001');

for (const [name, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE);
  if (name === 'desktop') await page.screenshot({ path: path.join(OUT, `ui-token.png`) });
  await page.fill('input[type=password]', 'dev-token');
  await page.click('button[type=submit]');
  await page.waitForSelector('.card');
  const shot = async (id: string, fullPage = true) =>
    page.screenshot({ path: path.join(OUT, `ui-${id}-${name}.png`), fullPage });
  await shot('list', false);
  await page.goto(`${BASE}/${detailHash}`);
  await page.waitForSelector('.detail');
  await shot('detail');
  await page.locator('table.items').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, `ui-items-${name}.png`) });
  await page.goto(`${BASE}/#/shortlist`);
  await page.waitForSelector('.card');
  await shot('shortlist');
  if (name === 'desktop') {
    await page.check('#select-all');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text=Export selected as PDF'),
    ]);
    await dl.saveAs(path.join(OUT, 'ui-export-selected.pdf'));
    console.log('downloaded', dl.suggestedFilename());
  }
  await page.goto(`${BASE}/#/scans`);
  await page.waitForSelector('.source');
  await shot('scans');
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector('.settings');
  await shot('settings');
  console.log(name, 'errors:', errors);
  await ctx.close();
}
await browser.close();
