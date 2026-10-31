/**
 * Drive the built UI against a REAL running Worker (not the mock) and save screenshots.
 *   TOT_E2E_TOKEN=<APP_TOKEN> BASE_URL=http://127.0.0.1:8799 CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     pnpm --filter @tender-monitor/web e2e:real
 * Files go to test-results/real-*.png (git-ignored). Prints console/page errors and failed calls.
 * It shortlists one tender, exports it as PDF, then un-shortlists it again.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8799';
const TOKEN = process.env.TOT_E2E_TOKEN;
if (!TOKEN) throw new Error('Set TOT_E2E_TOKEN to the Worker APP_TOKEN');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems: string[] = [];
const sizes = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } };

for (const [name, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e}`));
  page.on(
    'console',
    (m) => m.type() === 'error' && problems.push(`[${name}] console: ${m.text()}`),
  );
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400)
      problems.push(`[${name}] ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  const shot = (id: string, fullPage = true) =>
    page.screenshot({ path: path.join(OUT, `real-${id}-${name}.png`), fullPage });

  await page.goto(BASE);
  if (name === 'desktop') await shot('token', false);
  await page.fill('input[type=password]', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.card');
  await shot('list');

  // sort + filter
  await page.goto(`${BASE}/#/?sort=relevance_desc&category=motorbikes`);
  await page.waitForSelector('.card');
  if (name === 'desktop') await shot('list-filtered', false);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.card');

  // detail
  const id = 'worldbank:OP00282200';
  await page.goto(`${BASE}/#/tender/${encodeURIComponent(id)}`);
  await page.waitForSelector('.detail');
  await shot('detail');

  // shortlist: add from the detail page, export, remove
  await page.click('button.star');
  await page.waitForFunction(() =>
    document.querySelector('button.star')?.textContent?.includes('★'),
  );
  await page.goto(`${BASE}/#/shortlist`);
  await page.waitForSelector('.card');
  await shot('shortlist');
  if (name === 'desktop') {
    await page.check('#select-all');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text=Export selected as PDF'),
    ]);
    await dl.saveAs(path.join(OUT, 'real-export-selected.pdf'));
    console.log('downloaded', dl.suggestedFilename());
  }
  await page.click('button.star');
  await page.waitForTimeout(500);

  await page.goto(`${BASE}/#/scans`);
  await page.waitForSelector('.source');
  await shot('scans');

  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector('.settings');
  await shot('settings');
  if (name === 'desktop') {
    await page.click('text=Save settings');
    await page.waitForSelector('text=Settings saved.');
    await shot('settings-saved', false);
  }
  await ctx.close();
}
await browser.close();
console.log('problems:', problems.length ? problems : 'none');
