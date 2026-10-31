import { describe, it } from 'vitest';

// Full run against a local static server (test/helpers/staticServer.ts + TOT_BASE_URL).
// NOT implemented on purpose: it needs real saved fixtures (from scripts/explore.ts), a real
// parseResults, and a real site.login/buildSearchUrl. Faking any of those would be misleading.
describe('end-to-end run against a local static server', () => {
  it.todo(
    'BLOCKED on real fixtures + parser: serve packages/scraper/fixtures via startStaticServer, run main() with TOT_BASE_URL and --dry-run, assert tenders',
  );
});
