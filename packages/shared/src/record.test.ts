import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IngestV2BodySchema,
  MoneyFactSchema,
  SearchConfigSchema,
  TenderRecordSchema,
  type TenderRecordInput,
} from './record.js';

const now = '2026-10-31T12:00:00.000Z';
const hash = 'a'.repeat(64);

/** FIXTURE (synthetic): used only to exercise the schema, never shown as a real tender. */
export const minimalRecord: TenderRecordInput = {
  source: 'fixture',
  sourceRecordId: 'F-1',
  canonicalUrl: 'https://example.test/notice/F-1',
  title: 'Supply of motorcycles',
  relevance: {
    score: 0.8,
    groups: ['motorbikes'],
    matches: [
      { term: 'motorcycle', group: 'motorbikes', field: 'title', context: 'Supply of motorcycles' },
    ],
    excluded: [],
    explanation: 'Title mentions "motorcycle".',
  },
  firstSeenAt: now,
  lastCheckedAt: now,
  lastUpdatedAt: now,
  contentHash: hash,
};

describe('TenderRecordSchema', () => {
  it('fills every optional fact with null + could_not_verify, never zero', () => {
    const r = TenderRecordSchema.parse(minimalRecord);
    expect(r.estimatedValue.amount).toBeNull();
    expect(r.estimatedValue.status).toBe('could_not_verify');
    expect(r.deadline.value).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.status).toBe('unknown');
  });

  it('keeps estimated value, award value, tender fee and bid security as separate fields', () => {
    const r = TenderRecordSchema.parse({
      ...minimalRecord,
      awardValue: {
        amount: 219000,
        currency: 'ETB',
        originalText: 'ETB 219000.00',
        status: 'published',
      },
    });
    expect(r.awardValue.amount).toBe(219000);
    expect(r.estimatedValue.amount).toBeNull();
    expect(r.tenderFee.amount).toBeNull();
    expect(r.bidSecurity.amount).toBeNull();
  });

  it('rejects negative amounts and malformed hashes', () => {
    expect(MoneyFactSchema.safeParse({ amount: -1 }).success).toBe(false);
    expect(TenderRecordSchema.safeParse({ ...minimalRecord, contentHash: 'xyz' }).success).toBe(
      false,
    );
  });

  it('requires evidence-shaped objects to carry a valid source URL', () => {
    const bad = TenderRecordSchema.safeParse({
      ...minimalRecord,
      reference: {
        value: 'X',
        status: 'published',
        evidence: [{ sourceUrl: 'not a url', retrievedAt: now }],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('keeps original quantity text and unit without converting', () => {
    const r = TenderRecordSchema.parse({
      ...minimalRecord,
      items: [
        {
          description: 'Helmet',
          quantity: { value: 12, originalText: 'Twelve (12)' },
          unit: 'pairs',
        },
      ],
    });
    expect(r.items[0]?.unit).toBe('pairs');
    expect(r.items[0]?.quantity.originalText).toBe('Twelve (12)');
  });
});

describe('IngestV2BodySchema', () => {
  it('caps a batch at 200 records and requires a scan report', () => {
    const report = {
      scanId: 'scan-0001',
      source: 'fixture',
      status: 'running',
      accessStatus: 'ok',
      startedAt: now,
    };
    expect(IngestV2BodySchema.safeParse({ report, records: [minimalRecord] }).success).toBe(true);
    expect(IngestV2BodySchema.safeParse({ records: [minimalRecord] }).success).toBe(false);
    expect(
      IngestV2BodySchema.safeParse({ report, records: Array(201).fill(minimalRecord) }).success,
    ).toBe(false);
  });
});

describe('default search config', () => {
  it('is valid and keeps broad PPE separate from motorcycle riding gear', () => {
    const cfg = SearchConfigSchema.parse(
      JSON.parse(
        readFileSync(new URL('../config/search-config.default.json', import.meta.url), 'utf8'),
      ),
    );
    expect(cfg.groups.map((g) => g.id)).toEqual(['motorbikes', 'riding_gear', 'ppe']);
    const gear = cfg.groups.find((g) => g.id === 'riding_gear')!.terms;
    const ppe = cfg.groups.find((g) => g.id === 'ppe')!.terms;
    expect(gear.some((t) => ppe.includes(t))).toBe(false);
    expect(ppe).toContain('reflective vest');
  });
});
