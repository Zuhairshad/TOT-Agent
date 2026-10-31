import { TenderRecordSchema } from '@tender-monitor/shared';
import { describe, expect, it } from 'vitest';
import { makeRecord } from '../../test/helpers.js';
import { compareNoticeVersion, decideSupersede, diffRecords } from './diff.js';

const rec = (o: Record<string, unknown> = {}, hash = 1) =>
  TenderRecordSchema.parse(makeRecord(1, o, hash));

describe('compareNoticeVersion', () => {
  it('compares digit groups numerically', () => {
    expect(compareNoticeVersion('Amendment 10', 'Amendment 2')).toBe(1);
    expect(compareNoticeVersion('v2', 'v2.1')).toBe(-1);
    expect(compareNoticeVersion('3', '3')).toBe(0);
  });
  it('is undecided for null or non-numeric versions', () => {
    expect(compareNoticeVersion(null, '1')).toBeNull();
    expect(compareNoticeVersion('final', 'draft')).toBeNull();
  });
});

describe('decideSupersede', () => {
  const at = (noticeVersion: string | null, publishedAt: string | null = null) => ({
    noticeVersion,
    publishedAt,
  });
  it('replaces when the live row has no notice version', () => {
    expect(decideSupersede(at(null), at(null))).toBe('replace');
    expect(decideSupersede(at(null), at('1'))).toBe('replace');
  });
  it('higher or equal wins, lower is an older notice', () => {
    expect(decideSupersede(at('1'), at('2'))).toBe('replace');
    expect(decideSupersede(at('2'), at('2'))).toBe('replace');
    expect(decideSupersede(at('2'), at('1'))).toBe('older_notice');
  });
  it('falls back to a clearly later publishedAt, else flags a conflict', () => {
    expect(
      decideSupersede(at('A', '2026-10-01T00:00:00.000Z'), at('B', '2026-10-05T00:00:00.000Z')),
    ).toBe('replace');
    expect(
      decideSupersede(at('A', '2026-10-05T00:00:00.000Z'), at('B', '2026-10-01T00:00:00.000Z')),
    ).toBe('older_notice');
    expect(decideSupersede(at('A'), at('B'))).toBe('conflict');
    expect(decideSupersede(at('2'), at(null))).toBe('conflict');
  });
});

describe('diffRecords', () => {
  it('detects deadline extension and shortening with both values', () => {
    const ext = diffRecords(
      rec(),
      rec(
        {
          deadline: {
            value: '2026-12-15T00:00:00Z',
            originalText: '15 Dec 2026',
            status: 'published',
          },
        },
        2,
      ),
    );
    expect(ext).toEqual([
      expect.objectContaining({
        type: 'deadline_extended',
        old: '2026-11-30T00:00:00.000Z',
        new: '2026-12-15T00:00:00.000Z',
        oldText: '30 Nov 2026',
        newText: '15 Dec 2026',
      }),
    ]);
    const short = diffRecords(
      rec(),
      rec(
        { deadline: { value: '2026-11-01T00:00:00Z', originalText: '1 Nov', status: 'published' } },
        2,
      ),
    );
    expect(short[0]?.type).toBe('deadline_shortened');
  });
  it('detects status, value and item quantity changes', () => {
    const next = rec(
      {
        status: 'cancelled',
        estimatedValue: { amount: 7000, currency: 'USD', status: 'published' },
        items: [{ description: 'Helmet, full face', quantity: { value: 150 }, unit: 'pcs' }],
      },
      2,
    );
    const types = diffRecords(rec(), next).map((c) => c.type);
    expect(types).toEqual(['status_changed', 'estimated_value_changed', 'item_quantity_changed']);
  });
  it('admits when only untracked content moved', () => {
    expect(diffRecords(rec(), rec({}, 2)).map((c) => c.type)).toEqual(['content_changed']);
  });
});
