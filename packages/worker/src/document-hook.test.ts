import { env } from 'cloudflare:test';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processEvent } from './events.js';
import { ONLY_PDF_TEXT } from './document-hook.js';
import { stubWorld, type WorldCall } from '../test/world.js';

const TS = '1700000000.000001';
const event = (id: string) => ({
  type: 'message',
  subtype: 'file_share',
  user: 'U42',
  channel: 'C123',
  thread_ts: TS,
  files: [{ id }],
});

async function tinyPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  return d.save();
}

const GOOD = {
  tenderTitle: 'Supply of 200 motorcycles',
  purchaser: 'Ministry of Health',
  referenceNo: 'MOH/2026/17',
  submissionDeadline: '2026-12-01',
  bidSecurity: 'USD 5,000',
  deliveryLocation: 'Nairobi',
  deliveryPeriod: '90 days',
  eligibility: ['Registered company'],
  items: [
    { lineNo: 1, description: 'Motorcycle 150cc', specification: null, unit: 'pcs', quantity: 200 },
  ],
  estimatedValue: 'USD 180,000',
  notes: null,
  missing: ['notes', 'items[0].specification'],
};

let calls: WorldCall[];
const posts = () => calls.filter((c) => c.url.endsWith('chat.postMessage')).map((c) => c.body.text);

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO tenders (tot_ref, title, country, posted_at, url, first_seen_at, slack_ts, status, deadline)
     VALUES ('TOT-1001', 'Sample', 'Kenya', '2026-10-20T00:00:00.000Z', 'https://example.com/1', '2026-10-30T00:00:00.000Z', ?, 'shortlisted', '2026-12-01T00:00:00.000Z')`,
  )
    .bind(TS)
    .run();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tender_details'),
    env.DB.prepare('DELETE FROM tender_files'),
    env.DB.prepare('DELETE FROM tenders'),
  ]);
});

describe('document step', () => {
  it('extracts, saves JSON in tender_details and uploads a PDF to the thread', async () => {
    calls = stubWorld({
      files: { F1: { name: 'tender.pdf', filetype: 'pdf', bytes: await tinyPdf() } },
      claude: ['```json\n' + JSON.stringify(GOOD) + '\n```'],
    });
    await processEvent(env, event('F1'));

    const claude = calls.filter((c) => c.url.includes('anthropic.com'));
    expect(claude).toHaveLength(1);
    expect(claude[0]?.headers['x-api-key']).toBe('test-anthropic-key');
    const sent = claude[0]?.body as {
      model: string;
      messages: Array<{
        content: Array<{
          type: string;
          source?: { media_type: string; data: string };
          text?: string;
        }>;
      }>;
    };
    expect(sent.model).toBe('test-model');
    const doc = sent.messages[0]?.content[0];
    expect(doc?.type).toBe('document');
    expect(doc?.source?.media_type).toBe('application/pdf');
    expect(atob(doc?.source?.data ?? '').startsWith('%PDF-')).toBe(true);
    expect(sent.messages[0]?.content[1]?.text).toContain('Never estimate');

    const row = await env.DB.prepare('SELECT * FROM tender_details').first<{
      file_id: string;
      tot_ref: string;
      details_json: string;
    }>();
    expect(row?.tot_ref).toBe('TOT-1001');
    expect(JSON.parse(row?.details_json ?? '{}')).toEqual(GOOD);

    // Slack download used the bot token; upload flow ran in order into the thread.
    expect(
      calls.find((c) => c.url.startsWith('https://files.slack.com/'))?.headers.authorization,
    ).toBe('Bearer xoxb-test');
    const order = calls.map((c) => c.url.split('/').pop());
    expect(order.indexOf('files.getUploadURLExternal')).toBeLessThan(
      order.indexOf('files.completeUploadExternal'),
    );
    const complete = calls.find((c) => c.url.endsWith('files.completeUploadExternal'));
    expect(complete?.body).toMatchObject({ channel_id: 'C123', thread_ts: TS });
    expect(JSON.parse(String(complete?.body.files))).toEqual([
      { id: 'FOUT', title: 'TOT-1001-summary.pdf' },
    ]);
    const upload = calls.find((c) => c.url.startsWith('https://upload.slack.test/'));
    expect(upload?.bytes).toBeGreaterThan(500);
    const getUrl = calls.find((c) => c.url.endsWith('files.getUploadURLExternal'));
    expect(Number(getUrl?.body.length)).toBe(upload?.bytes);
    expect(posts()).toEqual(['Got it, reading the document...']);
  });

  it('retries once on invalid JSON and then succeeds', async () => {
    calls = stubWorld({
      files: { F1: { name: 'tender.pdf', filetype: 'pdf', bytes: await tinyPdf() } },
      claude: ['sorry, here is some prose', JSON.stringify(GOOD)],
    });
    await processEvent(env, event('F1'));
    const claude = calls.filter((c) => c.url.includes('anthropic.com'));
    expect(claude).toHaveLength(2);
    expect(JSON.stringify(claude[1]?.body)).toContain('previous reply was rejected');
    expect((await env.DB.prepare('SELECT * FROM tender_details').all()).results).toHaveLength(1);
  });

  it('retries once, then posts the error in the thread (no row saved, no upload)', async () => {
    // Valid JSON but breaks the schema: a null field not listed in "missing".
    const bad = JSON.stringify({ ...GOOD, purchaser: null });
    calls = stubWorld({
      files: { F1: { name: 'tender.pdf', filetype: 'pdf', bytes: await tinyPdf() } },
      claude: [bad],
    });
    await processEvent(env, event('F1'));
    expect(calls.filter((c) => c.url.includes('anthropic.com'))).toHaveLength(2);
    const last = String(posts().at(-1));
    expect(last).toContain('Could not process the document');
    expect(last).toContain('not valid after 2 attempts');
    expect(last).toContain('purchaser');
    expect((await env.DB.prepare('SELECT * FROM tender_details').all()).results).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith('files.getUploadURLExternal'))).toBe(false);
  });

  it.each([
    ['proposal.docx', 'docx'],
    ['prices.xlsx', 'xlsx'],
  ])('%s -> replies that only PDF works for now', async (name, filetype) => {
    calls = stubWorld({
      files: { F2: { name, filetype, bytes: new Uint8Array([80, 75, 3, 4]) } },
    });
    await processEvent(env, event('F2'));
    expect(posts()).toEqual(['Got it, reading the document...', ONLY_PDF_TEXT]);
    expect(ONLY_PDF_TEXT).toContain('Only PDF works for now');
    expect(calls.some((c) => c.url.includes('anthropic.com'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('https://files.slack.com/'))).toBe(false);
  });

  it('reports a Slack download that is not a PDF (missing files:read)', async () => {
    calls = stubWorld({
      files: {
        F3: { name: 'x.pdf', filetype: 'pdf', bytes: new TextEncoder().encode('<html>login') },
      },
    });
    await processEvent(env, event('F3'));
    expect(String(posts().at(-1))).toContain('not a PDF');
  });
});
