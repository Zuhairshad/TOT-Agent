import { describe, expect, it } from 'vitest';
import {
  assertPoliteDelays,
  assertSiteConfigured,
  buildSearchUrl,
  getBaseUrl,
  DEFAULT_BASE_URL,
} from '../src/site.js';

describe('site', () => {
  it('uses TOT_BASE_URL and strips trailing slashes', () => {
    expect(getBaseUrl({ TOT_BASE_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });
  it('falls back to the default base URL', () => {
    expect(getBaseUrl({})).toBe(DEFAULT_BASE_URL);
  });
  it('builds a search URL carrying keyword, country, sort and page', () => {
    const u = new URL(buildSearchUrl('http://127.0.0.1:9', 'motor cycle', 2));
    expect(u.origin).toBe('http://127.0.0.1:9');
    expect([...u.searchParams.values()]).toEqual(
      expect.arrayContaining(['motor cycle', 'Zambia', '2']),
    );
  });
  it('refuses the real site until site.ts is configured, allows local hosts', () => {
    expect(() => assertSiteConfigured(DEFAULT_BASE_URL)).toThrow(/not configured/);
    expect(() => assertSiteConfigured('http://127.0.0.1:8080')).not.toThrow();
  });

  it('delay floor: fast delays are refused for the real site, allowed for a local server', () => {
    expect(() => assertPoliteDelays(DEFAULT_BASE_URL, { min: 0, max: 1 })).toThrow(/floor/);
    expect(() => assertPoliteDelays(DEFAULT_BASE_URL, { min: 3000, max: 2000 + 500 })).toThrow();
    expect(() => assertPoliteDelays(DEFAULT_BASE_URL, { min: 3000, max: 8000 })).not.toThrow();
    expect(() => assertPoliteDelays('http://127.0.0.1:8080', { min: 0, max: 1 })).not.toThrow();
  });
});
