import { describe, expect, it } from 'vitest';
import { ExtractedTenderSchema } from './extracted.js';
import { FIXTURE } from '../test/fixture-tender.js';

describe('ExtractedTenderSchema', () => {
  it('accepts the fixture', () => {
    expect(ExtractedTenderSchema.parse(FIXTURE)).toEqual(FIXTURE);
  });
  it('accepts null scalars that are listed in "missing"', () => {
    const v = { ...FIXTURE, bidSecurity: null, missing: ['bidSecurity'] };
    expect(ExtractedTenderSchema.safeParse(v).success).toBe(true);
  });
  it('rejects null scalars that are not listed in "missing"', () => {
    const r = ExtractedTenderSchema.safeParse({ ...FIXTURE, bidSecurity: null, missing: [] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain('bidSecurity');
  });
  it('rejects empty eligibility / items that are not listed, and wrong types', () => {
    expect(
      ExtractedTenderSchema.safeParse({ ...FIXTURE, eligibility: [], missing: [] }).success,
    ).toBe(false);
    expect(ExtractedTenderSchema.safeParse({ ...FIXTURE, items: [], missing: [] }).success).toBe(
      false,
    );
    expect(
      ExtractedTenderSchema.safeParse({ ...FIXTURE, items: [{ description: '' }] }).success,
    ).toBe(false);
    expect(ExtractedTenderSchema.safeParse({ ...FIXTURE, missing: 'x' }).success).toBe(false);
  });
});
