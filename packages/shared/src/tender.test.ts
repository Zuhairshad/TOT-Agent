import { describe, expect, it } from 'vitest';
import { IngestBodySchema, TenderSchema } from './tender.js';

const valid = {
  totRef: 'TOT-1',
  title: 'Supply of helmets',
  country: 'Zambia',
  postedAt: '2026-10-01T00:00:00.000Z',
  deadline: null,
  url: 'https://example.com/t/1',
  matchedKeyword: 'helmet',
  scrapedAt: '2026-10-30T00:00:00.000Z',
};

describe('TenderSchema', () => {
  it('accepts a minimal valid tender', () => {
    expect(TenderSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects a missing totRef', () => {
    const rest: Partial<typeof valid> = { ...valid };
    delete rest.totRef;
    expect(TenderSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects non-ISO dates', () => {
    expect(TenderSchema.safeParse({ ...valid, postedAt: '01/10/2026' }).success).toBe(false);
  });
  it('allows optional value fields', () => {
    const r = TenderSchema.safeParse({
      ...valid,
      valueText: 'Refer Document',
      valueAmount: 5,
      currency: 'ZMW',
    });
    expect(r.success).toBe(true);
  });
});

describe('IngestBodySchema', () => {
  it('defaults status to ok', () => {
    const r = IngestBodySchema.parse({ tenders: [valid] });
    expect(r.status).toBe('ok');
  });
  it('accepts a blocked run with no tenders', () => {
    expect(IngestBodySchema.safeParse({ status: 'blocked', tenders: [] }).success).toBe(true);
  });
});
