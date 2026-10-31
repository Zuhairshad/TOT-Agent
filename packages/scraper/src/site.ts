import type { Page } from 'playwright';
import { POLITE_DELAY, type DelayRange } from './delay.js';

/**
 * ALL site-specific knowledge lives in this one file. Nothing here has been verified against the
 * real site: it is filled in from docs/site-notes.md once scripts/explore.ts has been run.
 */

export const DEFAULT_BASE_URL = 'https://www.tendersontime.com';

/** TODO(site-notes): flip to true once the constants and login() below match docs/site-notes.md. */
export const SITE_CONFIGURED = false;

/** TODO(site-notes): results per page. null = unknown, so page 2 is never opened. */
export const RESULTS_PAGE_SIZE: number | null = null;

/** TODO(site-notes): PLACEHOLDER search path and query param names, NOT verified. */
export const SEARCH_PATH = '/search';
export const PARAM_KEYWORD = 'keyword';
export const PARAM_COUNTRY = 'country';
export const PARAM_SORT = 'sort';
export const PARAM_PAGE = 'page';
export const COUNTRY = 'Zambia';
export const SORT_NEWEST = 'newest';

export function getBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.TOT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

export function buildSearchUrl(baseUrl: string, keyword: string, page: number): string {
  const url = new URL(SEARCH_PATH, baseUrl + '/');
  url.searchParams.set(PARAM_KEYWORD, keyword);
  url.searchParams.set(PARAM_COUNTRY, COUNTRY);
  url.searchParams.set(PARAM_SORT, SORT_NEWEST);
  url.searchParams.set(PARAM_PAGE, String(page));
  return url.toString();
}

/**
 * Refuse to hit the real site with unverified URLs. A different TOT_BASE_URL (e.g. a local
 * static server in tests) is allowed.
 */
export function isRealSite(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  return host === 'tendersontime.com' || host.endsWith('.tendersontime.com');
}

/**
 * Delay floor (CLAUDE.md rule 1). delayRangeFromEnv already ignores TOT_*_DELAY_MS unless the
 * test-only TOT_ALLOW_FAST_DELAYS=1 is set; this makes sure that switch can never speed up
 * requests to the REAL site (only to a local test server).
 */
export function assertPoliteDelays(baseUrl: string, range: DelayRange): void {
  if (isRealSite(baseUrl) && (range.min < POLITE_DELAY.min || range.max < POLITE_DELAY.min)) {
    throw new Error(
      `refusing to run: delays ${range.min}-${range.max} ms are below the ${POLITE_DELAY.min} ms floor for the real site (CLAUDE.md rule 1)`,
    );
  }
}

export function assertSiteConfigured(baseUrl: string): void {
  if (SITE_CONFIGURED) return;
  if (isRealSite(baseUrl)) {
    throw new Error(
      'site.ts is not configured for the real site yet (TODO(site-notes)). Run scripts/explore.ts, generate docs/site-notes.md, then update src/site.ts.',
    );
  }
}

export interface Credentials {
  email: string;
  password: string;
}

/** TODO(site-notes): implement against the real login form. Intentionally not guessed. */
export async function login(page: Page, creds: Credentials, baseUrl: string): Promise<void> {
  void page;
  void creds;
  void baseUrl;
  throw new Error('login not implemented: fill in src/site.ts from docs/site-notes.md');
}
