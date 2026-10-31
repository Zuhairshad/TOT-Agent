import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  call,
  clearV2,
  fact,
  makeRecord,
  NOW,
  postV2,
  stubSlack,
} from '../../test/helpers.js';
import { setClock } from './http.js';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface List {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
}

const get = async <T = List>(path: string, token?: string | null) => {
  const res = await call(api(path, { token }));
  return { status: res.status, body: (await res.json()) as T };
};
const ids = (l: List) => l.items.map((i) => String(i.sourceRecordId));

const date = (value: string | null, status = 'published') => ({
  value,
  originalText: value,
  status,
});

/*
 * Synthetic data (every title says FIXTURE). "now" is 2026-10-31T12:00Z.
 *  1 published 10-01  deadline 12-01 (upcoming, later)  motorbikes  Zambia     relevance .9
 *  2 published 10-10  deadline 11-05 (upcoming, sooner) riding_gear Zambia     relevance .5
 *  3 published ?      deadline 10-20 (past)             ppe         Kenya      relevance .2 closed
 *  4 published 09-01  deadline 10-25 (past, newer)      motorbikes  Zambia     relevance .7 cancelled
 *  5 published ?      deadline ?                        ppe         Zambia     relevance .1 unknown
 */
beforeEach(async () => {
  setClock(() => new Date(NOW));
  await postV2([
    makeRecord(1, {
      title: 'FIXTURE (synthetic) Electric motorcycles for field staff',
      categories: ['motorbikes'],
      publishedAt: date('2026-10-01T00:00:00Z'),
      deadline: date('2026-12-01T00:00:00Z'),
      relevance: {
        score: 0.9,
        groups: ['motorbikes'],
        matches: [],
        explanation: 'FIXTURE motorbike',
      },
    }),
    makeRecord(2, {
      publishedAt: date('2026-10-10T00:00:00Z'),
      deadline: date('2026-11-05T00:00:00Z'),
      relevance: {
        score: 0.5,
        groups: ['riding_gear'],
        matches: [],
        explanation: 'FIXTURE helmet',
      },
    }),
    makeRecord(3, {
      title: 'FIXTURE (synthetic) Safety boots 100% leather',
      categories: ['ppe'],
      country: fact('Kenya'),
      status: 'closed',
      publishedAt: date(null, 'not_published'),
      deadline: date('2026-10-20T00:00:00Z'),
      relevance: { score: 0.2, groups: ['ppe'], matches: [], explanation: 'FIXTURE ppe' },
      noticeType: 'Request for Quotation',
    }),
    makeRecord(4, {
      categories: ['motorbikes'],
      status: 'cancelled',
      publishedAt: date('2026-09-01T00:00:00Z'),
      deadline: date('2026-10-25T00:00:00Z'),
      relevance: { score: 0.7, groups: ['motorbikes'], matches: [], explanation: 'FIXTURE' },
    }),
    makeRecord(5, {
      title: 'FIXTURE (synthetic) Coveralls, deadline unknown',
      categories: ['ppe'],
      status: 'unknown',
      publishedAt: date(null, 'could_not_verify'),
      deadline: date(null, 'could_not_verify'),
      relevance: { score: 0.1, groups: ['ppe'], matches: [], explanation: 'FIXTURE' },
      items: [{ description: 'Coverall', quantity: { value: null }, unit: null }],
      estimatedValue: { amount: null, currency: null, status: 'not_published' },
    }),
  ]);
});

afterEach(async () => {
  setClock(null);
  await clearV2();
});

describe('auth', () => {
  const paths = ['/api/tenders', '/api/shortlist', '/api/scans', '/api/sources', '/api/config'];
  it('refuses missing tokens and the ingest secret on every /api route', async () => {
    for (const p of paths) {
      expect((await get(p, null)).status, p).toBe(401);
      expect((await get(p, env.INGEST_SECRET)).status, p).toBe(401);
      expect((await get(p, 'wrong')).status, p).toBe(401);
      expect((await get(p)).status, p).toBe(200);
    }
  });
  it('refuses the UI token on machine endpoints', async () => {
    const start = api('/scans/start', {
      method: 'POST',
      token: env.APP_TOKEN,
      body: { source: 'worldbank', scanId: 'scan-xyz-0001' },
    });
    expect((await call(start)).status).toBe(401);
  });
  it('is closed when APP_TOKEN is not configured', async () => {
    const saved = env.APP_TOKEN;
    delete (env as { APP_TOKEN?: string }).APP_TOKEN;
    try {
      expect((await get('/api/tenders', '')).status).toBe(401);
    } finally {
      env.APP_TOKEN = saved;
    }
  });
  it('gives unknown /api paths a JSON 404 and wrong methods a 405', async () => {
    expect((await get('/api/nope')).status).toBe(404);
    expect((await call(api('/api/tenders', { method: 'DELETE' }))).status).toBe(405);
  });
});

describe('GET /api/tenders: filters', () => {
  it('returns summary rows with the documented shape', async () => {
    const { body } = await get('/api/tenders?q=electric');
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: 'worldbank:FIX-1',
      status: 'open',
      publishedAt: '2026-10-01T00:00:00.000Z',
      deadline: {
        value: '2026-12-01T00:00:00.000Z',
        originalText: '2026-12-01T00:00:00Z',
        status: 'published',
      },
      deadlineKnown: true,
      deadlinePassed: false,
      categories: ['motorbikes'],
      relevance: { score: 0.9, groups: ['motorbikes'], explanation: 'FIXTURE motorbike' },
      estimatedValue: { label: 'Estimated value', amount: 5000, currency: 'USD' },
      awardValue: { label: 'Award value', amount: null },
      shortlisted: false,
    });
  });
  it('q matches every word, across title and item text, and escapes % and _', async () => {
    expect(ids((await get('/api/tenders?q=motorcycle+field')).body)).toEqual(['FIX-1']);
    expect(ids((await get('/api/tenders?q=coverall')).body)).toEqual(['FIX-5']);
    expect((await get('/api/tenders?q=100%25')).body.total).toBe(1);
    expect((await get('/api/tenders?q=100_')).body.total).toBe(0);
  });
  it('filters by category (repeatable and comma separated)', async () => {
    expect((await get('/api/tenders?category=motorbikes')).body.total).toBe(2);
    expect((await get('/api/tenders?category=motorbikes&category=riding_gear')).body.total).toBe(3);
    expect((await get('/api/tenders?category=ppe,riding_gear')).body.total).toBe(3);
  });
  it('filters by country, source, status and notice type', async () => {
    expect(ids((await get('/api/tenders?country=kenya')).body)).toEqual(['FIX-3']);
    expect((await get('/api/tenders?source=worldbank')).body.total).toBe(5);
    expect((await get('/api/tenders?source=nothing')).body.total).toBe(0);
    expect((await get('/api/tenders?status=open')).body.total).toBe(2);
    expect((await get('/api/tenders?status=closed,cancelled')).body.total).toBe(2);
    expect(ids((await get('/api/tenders?notice_type=request+for+quotation')).body)).toEqual([
      'FIX-3',
    ]);
  });
  it('filters by published and deadline date ranges (unknown dates never match a range)', async () => {
    expect(
      ids((await get('/api/tenders?publishedFrom=2026-10-01&publishedTo=2026-10-01')).body),
    ).toEqual(['FIX-1']);
    expect((await get('/api/tenders?publishedFrom=2026-10-02')).body.total).toBe(1);
    expect((await get('/api/tenders?publishedTo=2026-12-31')).body.total).toBe(3);
    expect(
      ids((await get('/api/tenders?deadlineFrom=2026-11-01&deadlineTo=2026-11-30')).body),
    ).toEqual(['FIX-2']);
    expect((await get('/api/tenders?deadlineTo=2026-10-31')).body.total).toBe(2);
  });
  it('filters by minRelevance and shortlisted', async () => {
    expect((await get('/api/tenders?minRelevance=0.6')).body.total).toBe(2);
    await call(api('/api/shortlist/worldbank%3AFIX-2', { method: 'PUT' }));
    expect(ids((await get('/api/tenders?shortlisted=1')).body)).toEqual(['FIX-2']);
  });
  it('rejects invalid query values with field errors', async () => {
    const { status, body } = await get<{ fields: Record<string, string[]> }>(
      '/api/tenders?category=cars&sort=random&publishedFrom=2026-02-31&pageSize=500&minRelevance=2',
    );
    expect(status).toBe(400);
    expect(Object.keys(body.fields).sort()).toEqual([
      'category',
      'minRelevance',
      'pageSize',
      'publishedFrom',
      'sort',
    ]);
  });
});

describe('GET /api/tenders: sorting and paging', () => {
  it('published_desc: newest first, unknown dates last', async () => {
    expect(ids((await get('/api/tenders?sort=published_desc')).body)).toEqual([
      'FIX-2',
      'FIX-1',
      'FIX-4',
      'FIX-3',
      'FIX-5',
    ]);
  });
  it('published_asc: oldest first, unknown dates STILL last', async () => {
    expect(ids((await get('/api/tenders?sort=published_asc')).body)).toEqual([
      'FIX-4',
      'FIX-1',
      'FIX-2',
      'FIX-3',
      'FIX-5',
    ]);
  });
  it('closing_soon: upcoming ascending, then past most recent first, then unknown', async () => {
    expect(ids((await get('/api/tenders?sort=closing_soon')).body)).toEqual([
      'FIX-2',
      'FIX-1',
      'FIX-4',
      'FIX-3',
      'FIX-5',
    ]);
  });
  it('closing_soon follows the injected clock', async () => {
    setClock(() => new Date('2026-11-10T00:00:00Z')); // FIX-2 is now past, FIX-1 still upcoming
    const { body } = await get('/api/tenders?sort=closing_soon');
    expect(ids(body)).toEqual(['FIX-1', 'FIX-2', 'FIX-4', 'FIX-3', 'FIX-5']);
    expect(body.items[1]?.deadlinePassed).toBe(true);
  });
  it('relevance_desc puts unscored rows last', async () => {
    expect(ids((await get('/api/tenders?sort=relevance_desc')).body)).toEqual([
      'FIX-1',
      'FIX-4',
      'FIX-2',
      'FIX-3',
      'FIX-5',
    ]);
  });
  it('never reports an unknown deadline as open', async () => {
    const { body } = await get('/api/tenders?q=deadline+unknown');
    expect(body.items[0]).toMatchObject({
      status: 'unknown',
      deadlineKnown: false,
      deadlinePassed: null,
      deadline: { value: null, status: 'could_not_verify' },
    });
  });
  it('paginates with a stable total', async () => {
    const p1 = (await get('/api/tenders?sort=published_desc&pageSize=2&page=1')).body;
    const p3 = (await get('/api/tenders?sort=published_desc&pageSize=2&page=3')).body;
    expect(ids(p1)).toEqual(['FIX-2', 'FIX-1']);
    expect(ids(p3)).toEqual(['FIX-5']);
    expect([p1.total, p1.page, p1.pageSize]).toEqual([5, 1, 2]);
    expect((await get('/api/tenders?page=9')).body.items).toEqual([]);
  });
});

describe('GET /api/tenders/:id', () => {
  it('returns the full record, versions and missingData', async () => {
    const { status, body } = await get<Item>('/api/tenders/worldbank%3AFIX-5');
    expect(status).toBe(200);
    expect(body.record.title).toContain('Coveralls');
    expect(body.missingData).toEqual(
      expect.arrayContaining(['publishedAt', 'deadline', 'estimatedValue', 'items.quantity']),
    );
    expect(body.missingData).not.toContain('awardValue'); // not an award notice
    expect(body.missingDetails.deadline).toBe('could_not_verify');
    expect(body.missingDetails.estimatedValue).toBe('not_published');
    expect(body.versions).toEqual([
      expect.objectContaining({ version: 1, isCurrent: true, flag: null, changes: [] }),
    ]);
  });
  it('lists a complete record as having nothing missing and exposes version history', async () => {
    await postV2([
      makeRecord(1, { deadline: date('2026-12-20T00:00:00Z'), categories: ['motorbikes'] }, 77),
    ]);
    const { body } = await get<Item>('/api/tenders/worldbank%3AFIX-1');
    expect(body.missingData).toEqual([]);
    expect(body.versions.map((v: Item) => v.version)).toEqual([2, 1]);
    expect(body.versions[0].changes[0]).toMatchObject({ type: 'deadline_extended' });
  });
  it('404s unknown ids', async () => {
    expect((await get('/api/tenders/worldbank%3Anope')).status).toBe(404);
  });
});

describe('shortlist', () => {
  it('adds, notes, lists and removes', async () => {
    const id = 'worldbank%3AFIX-1';
    expect(
      (await call(api(`/api/shortlist/${id}`, { method: 'PUT', body: { note: 'call buyer' } })))
        .status,
    ).toBe(200);
    await call(api('/api/shortlist/worldbank%3AFIX-3', { method: 'PUT' }));
    // a second PUT without a note keeps the note; with null it clears it
    await call(api(`/api/shortlist/${id}`, { method: 'PUT' }));
    let list = (await get<Item>('/api/shortlist')).body;
    expect(list.ids.sort()).toEqual(['worldbank:FIX-1', 'worldbank:FIX-3']);
    expect(list.items.find((i: Item) => i.id === 'worldbank:FIX-1')).toMatchObject({
      note: 'call buyer',
      shortlisted: true,
    });
    expect((await get<Item>(`/api/tenders/${id}`)).body.shortlisted).toBe(true);
    await call(api(`/api/shortlist/${id}`, { method: 'PUT', body: { note: null } }));
    list = (await get<Item>('/api/shortlist')).body;
    expect(list.items.find((i: Item) => i.id === 'worldbank:FIX-1').note).toBeNull();

    const del = await call(api(`/api/shortlist/${id}`, { method: 'DELETE' }));
    expect(((await del.json()) as Item).removed).toBe(true);
    expect(
      ((await (await call(api(`/api/shortlist/${id}`, { method: 'DELETE' }))).json()) as Item)
        .removed,
    ).toBe(false);
    expect((await get<Item>('/api/shortlist')).body.ids).toEqual(['worldbank:FIX-3']);
  });
  it('404s for an unknown record and 400s for a bad note', async () => {
    expect((await call(api('/api/shortlist/worldbank%3Anope', { method: 'PUT' }))).status).toBe(
      404,
    );
    const bad = await call(
      api('/api/shortlist/worldbank%3AFIX-1', { method: 'PUT', body: { note: 5 } }),
    );
    expect(bad.status).toBe(400);
  });
  it('survives a record update', async () => {
    await call(api('/api/shortlist/worldbank%3AFIX-1', { method: 'PUT' }));
    await postV2([makeRecord(1, { status: 'cancelled' }, 55)]);
    expect((await get<Item>('/api/shortlist')).body.items[0].status).toBe('cancelled');
  });
});

describe('GET /api/scans, /api/sources', () => {
  it('lists scans, per-source status and the last failure', async () => {
    await postV2([], { status: 'succeeded', finishedAt: NOW }); // finishes scan-test-0001
    stubSlack(); // the blocked report posts a (fake) Slack alert
    await postV2([], {
      scanId: 'scan-bad-00001',
      source: 'tendersontime',
      status: 'blocked',
      accessStatus: 'blocked_by_challenge',
      failures: [{ stage: 'search', error: 'Cloudflare challenge', url: null }],
    });
    const { body } = await get<Item>('/api/scans');
    expect(body.scans.map((s: Item) => s.id).sort()).toEqual(['scan-bad-00001', 'scan-test-0001']);
    const sources = Object.fromEntries(body.sources.map((s: Item) => [s.source, s]));
    expect(sources.worldbank.lastSuccessfulScan.id).toBe('scan-test-0001');
    expect(sources.worldbank.recordCount).toBe(5);
    expect(sources.tendersontime).toMatchObject({
      accessStatus: 'blocked_by_challenge',
      lastSuccessfulScan: null,
      lastFailure: { status: 'blocked', message: 'Cloudflare challenge' },
    });
    expect((await get<Item>('/api/sources')).body.sources).toHaveLength(2);
    const one = await get<Item>('/api/scans/scan-bad-00001');
    expect(one.body.scan.failures).toHaveLength(1);
    expect((await get('/api/scans/missing')).status).toBe(404);
  });
});
