import { describe, expect, it } from 'vitest';
import {
  SORT_OPTIONS,
  buildTenderQuery,
  defaultFilters,
  normalizeSort,
  parseTenderQuery,
} from '../src/api/query';

describe('buildTenderQuery', () => {
  it('is empty for default filters', () => {
    expect(buildTenderQuery(defaultFilters())).toBe('');
  });
  it('writes every filter with the API parameter names', () => {
    const q = new URLSearchParams(
      buildTenderQuery({
        ...defaultFilters(),
        q: ' helmet ',
        categories: ['motorbikes', 'ppe'],
        country: 'Zambia',
        status: 'open',
        publishedFrom: '2026-01-01',
        publishedTo: '2026-02-01',
        deadlineFrom: '2026-03-01',
        deadlineTo: '2026-04-01',
        noticeType: 'Contract Award',
        shortlisted: true,
        sort: 'closing_soon',
        page: 3,
        pageSize: 50,
      }),
    );
    expect(Object.fromEntries(q)).toEqual({
      q: 'helmet',
      category: 'motorbikes,ppe',
      country: 'Zambia',
      status: 'open',
      publishedFrom: '2026-01-01',
      publishedTo: '2026-02-01',
      deadlineFrom: '2026-03-01',
      deadlineTo: '2026-04-01',
      notice_type: 'Contract Award',
      shortlisted: '1',
      sort: 'closing_soon',
      page: '3',
      pageSize: '50',
    });
  });
  it('round-trips through parseTenderQuery and encodes special characters', () => {
    const f = { ...defaultFilters(), q: 'a&b=c d', categories: ['riding_gear' as const], page: 2 };
    expect(parseTenderQuery(buildTenderQuery(f))).toEqual(f);
  });
  it('ignores invalid categories, sorts, pages', () => {
    const f = parseTenderQuery('category=ppe,bogus&sort=nope&page=-4&pageSize=9999');
    expect(f.categories).toEqual(['ppe']);
    expect(f.sort).toBe('published_desc');
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(20);
  });
});

describe('sort options', () => {
  it('maps the four labels to the four API values', () => {
    expect(SORT_OPTIONS.map((o) => [o.label, o.value])).toEqual([
      ['Newest first', 'published_desc'],
      ['Oldest first', 'published_asc'],
      ['Closing soon', 'closing_soon'],
      ['Most relevant', 'relevance_desc'],
    ]);
    expect(normalizeSort('relevance_desc')).toBe('relevance_desc');
    expect(normalizeSort(null)).toBe('published_desc');
  });
});
