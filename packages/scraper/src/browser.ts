import { chromium } from 'playwright';
import type { BrowserSession, Launcher } from './types.js';

/** Normal headless Chromium. CHROMIUM_PATH lets a sandbox point at a preinstalled binary. */
export function launchOptions(env: NodeJS.ProcessEnv) {
  const executablePath = env.CHROMIUM_PATH?.trim();
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

export function playwrightLauncher(env: NodeJS.ProcessEnv): Launcher {
  return async ({ storageStatePath }): Promise<BrowserSession> => {
    const browser = await chromium.launch(launchOptions(env));
    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {},
    );
    return {
      async newPage() {
        const page = await context.newPage();
        return {
          async goto(url) {
            const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
            return { status: res?.status() ?? 0 };
          },
          content: () => page.content(),
          url: () => page.url(),
          async screenshot(file) {
            await page.screenshot({ path: file, fullPage: true });
          },
          raw: page,
        };
      },
      async saveState(file) {
        await context.storageState({ path: file });
      },
      close: () => browser.close(),
    };
  };
}
