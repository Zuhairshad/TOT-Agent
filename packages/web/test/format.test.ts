import { describe, expect, it } from 'vitest';
import { AWARD, RICH, SPARSE } from '../dev/fixtures';
import {
  accessInfo,
  factText,
  formatChangeValue,
  formatDate,
  formatDeadline,
  formatMoney,
  formatQuantity,
  listGaps,
} from '../src/format';

describe('formatMoney', () => {
  it('shows amount with currency', () => {
    expect(formatMoney({ amount: 250000, currency: 'USD' }).text).toBe('250,000 USD');
  });
  it('never turns unknown into 0', () => {
    const m = formatMoney({ amount: null, currency: null, status: 'not_published' });
    expect(m).toMatchObject({ text: 'Not published', missing: true });
    expect(formatMoney({ amount: null, status: 'could_not_verify' }).text).toBe('Could not verify');
    expect(formatMoney(null).text).not.toBe('0');
  });
  it('keeps a real zero and flags a missing currency', () => {
    expect(formatMoney({ amount: 0, currency: 'USD' }).text).toBe('0 USD');
    expect(formatMoney({ amount: 5 }).note).toBe('Currency not published');
  });
  it('shows original text when the amount could not be parsed', () => {
    expect(formatMoney({ amount: null, originalText: 'approx. two million' })).toMatchObject({
      text: 'approx. two million',
      missing: false,
    });
  });
  it('award and estimated values come from different fields (not merged)', () => {
    expect(formatMoney(AWARD.estimatedValue).missing).toBe(true);
    expect(formatMoney(AWARD.awardValue).text).toBe('120,000 KES');
  });
});

describe('formatDate / formatDeadline', () => {
  it('formats date-only and date-time in UTC', () => {
    expect(formatDate({ value: '2026-10-01T00:00:00Z' }).text).toBe('2026-10-01');
    expect(formatDate({ value: '2026-11-20T10:00:00Z', precision: 'datetime' }).text).toBe(
      '2026-11-20 10:00 UTC',
    );
  });
  it('carries ambiguity, original text and timezone', () => {
    const d = formatDate(RICH.deadline);
    expect(d.original).toBe('20 November 2026, 12:00');
    expect(d.timezone).toBe('CAT (UTC+2)');
    expect(formatDate({ value: '2026-03-04T00:00:00Z', ambiguous: true }).ambiguous).toBe(true);
  });
  it('unparsed text is shown as published and flagged ambiguous', () => {
    expect(formatDate(SPARSE.publishedAt)).toMatchObject({ text: '03/04/2026', ambiguous: true });
  });
  it('missing date uses the right wording', () => {
    expect(formatDate({ value: null, status: 'not_published' }).text).toBe('Not published');
    expect(formatDate({ value: null, status: 'could_not_verify' }).text).toBe('Could not verify');
  });
  it('unknown deadline says "Deadline unknown" and never implies open', () => {
    const d = formatDeadline({ value: null, status: 'not_published' });
    expect(d.unknown).toBe(true);
    expect(d.headline).toBe('Deadline unknown');
    expect(d.reason).toBe('Deadline not published');
    expect(formatDeadline({ value: null, status: 'could_not_verify' }).reason).toBe(
      'Could not verify',
    );
    expect(formatDeadline({ value: '2026-11-01T00:00:00Z' }, false).unknown).toBe(true);
    expect(formatDeadline({ value: '2026-11-01T00:00:00Z' }, true).unknown).toBe(false);
  });
});

describe('quantities, facts, gaps', () => {
  it('missing quantity is Not published, zero stays zero', () => {
    expect(formatQuantity({ value: null })).toEqual({ text: 'Not published', missing: true });
    expect(formatQuantity({ value: 0 }).text).toBe('0');
    expect(formatQuantity({ value: null, originalText: 'as required' }).text).toBe('as required');
  });
  it('factText joins lists and labels gaps', () => {
    expect(factText({ value: ['a', 'b'] }).text).toBe('a; b');
    expect(factText({ value: [], status: 'not_published' }).text).toBe('Not published');
    expect(factText({ value: null }).text).toBe('Could not verify');
  });
  it('listGaps names every gap with the right label', () => {
    const gaps = Object.fromEntries(listGaps(RICH).map((g) => [g.field, g.label]));
    expect(gaps['Contract award value']).toBe('Not published');
    expect(gaps['Contact address']).toBe('Could not verify');
    expect(gaps['Reference']).toBeUndefined();
    const sparse = listGaps(SPARSE).map((g) => g.field);
    expect(sparse).toEqual(expect.arrayContaining(['Deadline', 'Items', 'Estimated value']));
  });
  it('formatChangeValue renders null/dates/money', () => {
    expect(formatChangeValue(null)).toBe('Not published');
    expect(formatChangeValue('2026-11-20T10:00:00Z')).toBe('2026-11-20 10:00 UTC');
    expect(formatChangeValue({ amount: 5, currency: 'EUR' })).toBe('5 EUR');
  });
  it('explains access statuses in plain language', () => {
    expect(accessInfo('blocked_by_challenge').text).toMatch(/do not try to get around/);
    expect(accessInfo('login_required').label).toBe('Login required');
    expect(accessInfo('unconfigured').label).toBe('Not set up');
    expect(accessInfo('weird').label).toBe('weird');
  });
});
