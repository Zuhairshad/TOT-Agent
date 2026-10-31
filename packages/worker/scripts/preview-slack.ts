// Prints the Block Kit JSON for one sample tender. Paste it into
// https://app.slack.com/block-kit-builder to preview the message.
// Usage: pnpm --filter @tender-monitor/worker preview:slack
import { buildTenderMessage } from '../src/blocks.js';
import type { TenderRow } from '../src/types.js';

const sample: TenderRow = {
  tot_ref: 'TOT-SAMPLE-001',
  title: 'Supply of 200 motorcycles for community health workers',
  country: 'Kenya',
  purchaser: 'Ministry of Health',
  posted_at: '2026-10-28T00:00:00.000Z',
  deadline: '2026-11-20T12:00:00.000Z',
  value_text: 'USD 180,000',
  value_amount: 180000,
  currency: 'USD',
  url: 'https://www.tendersontime.com/tender/sample-001',
  matched_keywords: JSON.stringify(['motorcycle', 'bikes']),
  first_seen_at: new Date().toISOString(),
  slack_ts: null,
  status: 'new',
  shortlisted_at: null,
};

console.log(JSON.stringify(buildTenderMessage(sample, new Date()), null, 2));
