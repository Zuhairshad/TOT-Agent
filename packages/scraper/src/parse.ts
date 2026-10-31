import type { Tender } from '@tender-monitor/shared';

/**
 * Honest stub. The real parser must be written ONLY against real saved fixtures
 * (packages/scraper/fixtures/), produced by scripts/explore.ts. See CLAUDE.md: do not guess selectors.
 */
export function parseResults(html: string, keyword: string): Tender[] {
  void html;
  void keyword;
  throw new Error(
    'parseResults not implemented: run scripts/explore.ts and write the parser against real fixtures',
  );
}
