import type { TenderRow } from '../src/types.js';

export const sampleRow: TenderRow = {
  tot_ref: 'TOT-1001',
  title: 'Supply of 500 motorcycles & spare parts <lot 1>',
  country: 'Kenya',
  purchaser: 'Ministry of Health',
  posted_at: '2026-10-20T00:00:00.000Z',
  deadline: '2026-11-15T12:00:00.000Z',
  value_text: 'USD 250,000',
  value_amount: 250000,
  currency: 'USD',
  url: 'https://www.tendersontime.com/tender/1001',
  matched_keywords: '["motorcycle","spare parts"]',
  first_seen_at: '2026-10-30T00:00:00.000Z',
  slack_ts: null,
  status: 'new',
  shortlisted_at: null,
};
