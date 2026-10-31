import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../src/index.js';

export interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

/** Stubs global fetch as a fake Slack API; returns the recorded calls. */
export function stubSlack(): SlackCall[] {
  const calls: SlackCall[] = [];
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.replace('https://slack.com/api/', '');
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Response.json({ ok: true, ts: `1700000000.${String(++n).padStart(6, '0')}` });
    }),
  );
  return calls;
}

/** Sends a request through the worker and waits for ctx.waitUntil work. */
export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function makeTender(i: number, overrides: Record<string, unknown> = {}) {
  return {
    totRef: `TOT-${i}`,
    title: `Tender number ${i}`,
    country: 'Kenya',
    purchaser: 'Ministry of Works',
    postedAt: '2026-10-01T00:00:00.000Z',
    deadline: `2026-12-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    valueText: 'USD 100,000',
    url: `https://example.com/tender/${i}`,
    matchedKeyword: 'bikes',
    scrapedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

export function ingestRequest(body: unknown, secret: string | null = env.INGEST_SECRET): Request {
  return new Request('https://worker.test/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export interface InsertTenderOpts {
  totRef: string;
  title?: string;
  status?: 'new' | 'shortlisted' | 'ignored';
  deadline?: string | null;
  firstSeenAt?: string;
  shortlistedAt?: string | null;
  slackTs?: string | null;
}

/** Inserts a tender row directly (tests of the cron jobs do not go through /ingest). */
export async function insertTender(o: InsertTenderOpts): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenders (tot_ref, title, country, posted_at, deadline, url, first_seen_at,
                          slack_ts, status, shortlisted_at)
     VALUES (?, ?, 'Zambia', '2026-10-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      o.totRef,
      o.title ?? `Title ${o.totRef}`,
      o.deadline === undefined ? null : o.deadline,
      `https://example.com/${o.totRef}`,
      o.firstSeenAt ?? '2026-10-01T00:00:00.000Z',
      o.slackTs === undefined
        ? `1700000000.${o.totRef.replace(/\D/g, '').padStart(6, '0')}`
        : o.slackTs,
      o.status ?? 'new',
      o.shortlistedAt ?? null,
    )
    .run();
}

/** Deletes everything the cron/admin tests create (children first: foreign keys are on). */
export async function clearTenders(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tender_reminders'),
    env.DB.prepare('DELETE FROM tender_details'),
    env.DB.prepare('DELETE FROM tender_files'),
    env.DB.prepare('DELETE FROM tenders'),
    env.DB.prepare('DELETE FROM runs'),
  ]);
}

/* ------------------------------------------------------------------ v2 */

export const NOW = '2026-10-31T12:00:00.000Z';

export const fact = <T>(value: T | null, status = 'published') => ({ value, status });
const evidence = { sourceUrl: 'https://example.org/n/1', retrievedAt: NOW };

/** A valid TenderRecord input. Every title says FIXTURE: this is synthetic test data. */
export function makeRecord(n: number, o: Record<string, unknown> = {}, hash = n) {
  return {
    schemaVersion: 2,
    source: 'worldbank',
    sourceRecordId: `FIX-${n}`,
    canonicalUrl: `https://example.org/notice/${n}`,
    reference: fact(`REF-${n}`),
    title: `FIXTURE (synthetic) motorcycle helmets ${n}`,
    buyer: fact('Fixture Ministry of Roads'),
    country: fact('Zambia'),
    publishedAt: { value: '2026-10-01T00:00:00Z', originalText: '1 Oct 2026', status: 'published' },
    deadline: {
      value: '2026-11-30T00:00:00Z',
      originalText: '30 Nov 2026',
      status: 'published',
    },
    status: 'open',
    noticeType: 'Invitation for Bids',
    noticeVersion: null,
    categories: ['riding_gear'],
    relevance: { score: 0.8, groups: ['riding_gear'], matches: [], explanation: 'FIXTURE match' },
    scopeOfSupply: fact('Supply of helmets'),
    items: [
      {
        description: 'Helmet, full face',
        quantity: { value: 100, originalText: '100' },
        unit: 'pcs',
        evidence: [evidence],
      },
    ],
    estimatedValue: { amount: 5000, currency: 'USD', status: 'published' },
    firstSeenAt: NOW,
    lastCheckedAt: NOW,
    lastUpdatedAt: NOW,
    contentHash: hash.toString(16).padStart(64, '0'),
    ...o,
  };
}

export function makeReport(o: Record<string, unknown> = {}) {
  return {
    scanId: 'scan-test-0001',
    source: 'worldbank',
    status: 'running',
    accessStatus: 'ok',
    startedAt: NOW,
    ...o,
  };
}

const jsonHeaders = (token: string | null) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** Request with the UI token by default (pass null for none, or another secret). */
export function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Request {
  const token = init.token === undefined ? env.APP_TOKEN! : init.token;
  return new Request(`https://worker.test${path}`, {
    method: init.method ?? 'GET',
    headers: jsonHeaders(token),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Request with the machine secret by default. */
export const machine = (
  path: string,
  body: unknown,
  token: string | null = env.INGEST_SECRET,
): Request => api(path, { method: 'POST', body, token });

export const postV2 = (records: unknown[], report: Record<string, unknown> = {}) =>
  call(machine('/ingest/v2', { report: makeReport(report), records }));

export async function clearV2(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shortlist'),
    env.DB.prepare('DELETE FROM record_items'),
    env.DB.prepare('DELETE FROM record_versions'),
    env.DB.prepare('DELETE FROM records'),
    env.DB.prepare('DELETE FROM scans'),
    env.DB.prepare('DELETE FROM settings'),
  ]);
}
