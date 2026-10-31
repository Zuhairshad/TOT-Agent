import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  call,
  clearV2,
  machine,
  makeRecord,
  makeReport,
  NOW,
  postV2,
} from '../../test/helpers.js';
import { setClock } from './http.js';

afterEach(async () => {
  setClock(null);
  await clearV2();
});

const ID = 'worldbank:FIX-1';
const one = async <T>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>())!;
const versions = async (id = ID) =>
  (
    await env.DB.prepare('SELECT * FROM record_versions WHERE record_id = ? ORDER BY version')
      .bind(id)
      .all<{
        version: number;
        flag: string | null;
        changes_json: string;
        record_json: string;
      }>()
  ).results;

const extended = {
  deadline: { value: '2026-12-15T00:00:00Z', originalText: '15 Dec 2026', status: 'published' },
};

describe('POST /ingest/v2: auth and validation', () => {
  it('rejects wrong, missing and UI secrets with 401', async () => {
    const body = { report: makeReport(), records: [] };
    expect((await call(machine('/ingest/v2', body, 'wrong'))).status).toBe(401);
    expect((await call(machine('/ingest/v2', body, null))).status).toBe(401);
    expect((await call(machine('/ingest/v2', body, env.APP_TOKEN))).status).toBe(401);
  });

  it('answers 400 with field errors for an invalid body and stores nothing', async () => {
    const res = await postV2([{ ...makeRecord(1), title: '', contentHash: 'nope' }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: Record<string, string[]> };
    expect(body.error).toBe('invalid_body');
    expect(Object.keys(body.fields)).toEqual(
      expect.arrayContaining(['records.0.title', 'records.0.contentHash']),
    );
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM records')).n).toBe(0);
  });

  it('rejects a record whose source differs from the report source', async () => {
    const res = await postV2([makeRecord(1, { source: 'other' })]);
    expect(res.status).toBe(400);
  });
});

describe('POST /ingest/v2: upsert', () => {
  it('inserts a new record as version 1 with items and a search text', async () => {
    const res = await postV2([makeRecord(1)]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new: number; results: Array<{ result: string }> };
    expect(body.new).toBe(1);
    const row = await one<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', ID);
    expect(row).toMatchObject({
      version: 1,
      status: 'open',
      country: 'Zambia',
      deadline_at: '2026-11-30T00:00:00.000Z',
      estimated_amount: 5000,
      estimated_currency: 'USD',
    });
    expect(String(row.search_text)).toContain('fixture (synthetic) motorcycle helmets 1');
    expect(String(row.search_text)).toContain('helmet, full face');
    expect((await versions()).length).toBe(1);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM record_items')).n).toBe(1);
  });

  it('same content hash: no new version, only last_checked_at moves', async () => {
    setClock(() => new Date('2026-10-31T10:00:00Z'));
    await postV2([makeRecord(1)]);
    setClock(() => new Date('2026-10-31T11:00:00Z'));
    const res = await postV2([makeRecord(1)]);
    expect(((await res.json()) as { unchanged: number }).unchanged).toBe(1);
    expect((await versions()).length).toBe(1);
    const row = await one<{ last_checked_at: string; last_updated_at: string }>(
      'SELECT last_checked_at, last_updated_at FROM records WHERE id = ?',
      ID,
    );
    expect(row.last_checked_at).toBe('2026-10-31T11:00:00.000Z');
    expect(row.last_updated_at).toBe('2026-10-31T10:00:00.000Z');
  });

  it('deadline extension creates version 2 with old and new deadline, keeping version 1', async () => {
    await postV2([makeRecord(1)]);
    const res = await postV2([makeRecord(1, extended, 2)]);
    const body = (await res.json()) as { updated: number; results: Array<{ changes: string[] }> };
    expect(body.updated).toBe(1);
    expect(body.results[0]?.changes).toEqual(['deadline_extended']);
    const vs = await versions();
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    const change = (JSON.parse(vs[1]!.changes_json) as Array<Record<string, unknown>>)[0];
    expect(change).toMatchObject({
      type: 'deadline_extended',
      old: '2026-11-30T00:00:00.000Z',
      new: '2026-12-15T00:00:00.000Z',
    });
    // history keeps the original deadline
    expect(JSON.parse(vs[0]!.record_json).deadline.value).toBe('2026-11-30T00:00:00Z');
    const live = await one<{ deadline_at: string; version: number }>(
      'SELECT deadline_at, version FROM records WHERE id = ?',
      ID,
    );
    expect(live).toEqual({ deadline_at: '2026-12-15T00:00:00.000Z', version: 2 });
  });

  it('preserves the open -> cancelled transition', async () => {
    await postV2([makeRecord(1)]);
    await postV2([makeRecord(1, { status: 'cancelled' }, 2)]);
    const vs = await versions();
    expect(JSON.parse(vs[0]!.record_json).status).toBe('open');
    expect(JSON.parse(vs[1]!.changes_json)).toEqual([
      expect.objectContaining({ type: 'status_changed', old: 'open', new: 'cancelled' }),
    ]);
    expect(
      (await one<{ status: string }>('SELECT status FROM records WHERE id = ?', ID)).status,
    ).toBe('cancelled');
  });

  it('an older notice version does not replace the newer one but is kept, flagged', async () => {
    await postV2([makeRecord(1, { noticeVersion: '2', title: 'FIXTURE newer' }, 2)]);
    const res = await postV2([makeRecord(1, { noticeVersion: '1', title: 'FIXTURE older' }, 1)]);
    expect(((await res.json()) as { olderNotice: number }).olderNotice).toBe(1);
    const live = await one<{ title: string; version: number }>(
      'SELECT title, version FROM records WHERE id = ?',
      ID,
    );
    expect(live).toEqual({ title: 'FIXTURE newer', version: 1 });
    const vs = await versions();
    expect(vs.map((v) => v.flag)).toEqual([null, 'older_notice']);
    // re-posting the same stale notice does not pile up more snapshots
    await postV2([makeRecord(1, { noticeVersion: '1', title: 'FIXTURE older' }, 1)]);
    expect((await versions()).length).toBe(2);
    // a later genuine update still gets the next free version number
    await postV2([makeRecord(1, { noticeVersion: '3', title: 'FIXTURE newest' }, 3)]);
    expect((await versions()).map((v) => v.version)).toEqual([1, 2, 3]);
    expect(
      (await one<{ version: number }>('SELECT version FROM records WHERE id = ?', ID)).version,
    ).toBe(3);
  });

  it('flags a conflict and keeps the live row when ordering cannot be decided', async () => {
    await postV2([makeRecord(1, { noticeVersion: 'A' }, 1)]);
    await postV2([makeRecord(1, { noticeVersion: 'B', title: 'FIXTURE other' }, 2)]);
    expect((await versions()).map((v) => v.flag)).toEqual([null, 'conflict']);
    expect(
      (await one<{ title: string }>('SELECT title FROM records WHERE id = ?', ID)).title,
    ).not.toBe('FIXTURE other');
  });

  it('re-posting a whole batch is idempotent', async () => {
    const batch = [makeRecord(1), makeRecord(2), makeRecord(3, extended, 9)];
    const first = (await (await postV2(batch)).json()) as { new: number };
    const second = (await (await postV2(batch)).json()) as { new: number; unchanged: number };
    expect(first.new).toBe(3);
    expect(second).toMatchObject({ new: 0, unchanged: 3 });
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM records')).n).toBe(3);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM record_versions')).n).toBe(3);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM record_items')).n).toBe(3);
  });

  it('handles the same record twice inside one batch', async () => {
    const res = await postV2([makeRecord(1), makeRecord(1, extended, 2)]);
    expect(res.status).toBe(200);
    expect((await versions()).map((v) => v.version)).toEqual([1, 2]);
  });
});

describe('POST /ingest/v2: missing data stays missing', () => {
  it('never copies awardValue into the estimated columns', async () => {
    await postV2([
      makeRecord(1, {
        estimatedValue: { amount: null, currency: null, status: 'not_published' },
        awardValue: { amount: 900, currency: 'EUR', status: 'published' },
        noticeType: 'Contract Award',
      }),
    ]);
    const row = await one<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', ID);
    expect(row).toMatchObject({
      estimated_amount: null,
      estimated_currency: null,
      award_amount: 900,
      award_currency: 'EUR',
    });
  });

  it('stores an unpublished quantity as NULL, never 0', async () => {
    await postV2([
      makeRecord(1, {
        items: [
          { description: 'Gloves', quantity: { value: null, originalText: null }, unit: null },
          { description: 'Boots', quantity: { value: 0, originalText: '0' }, unit: 'pairs' },
        ],
      }),
    ]);
    const items = (
      await env.DB.prepare('SELECT description, quantity FROM record_items ORDER BY idx').all<{
        description: string;
        quantity: number | null;
      }>()
    ).results;
    expect(items).toEqual([
      { description: 'Gloves', quantity: null },
      { description: 'Boots', quantity: 0 }, // a published zero is kept; only "unknown" is NULL
    ]);
  });

  it('stores an unknown deadline as NULL', async () => {
    await postV2([
      makeRecord(1, {
        deadline: { value: null, originalText: null, status: 'not_published' },
        status: 'unknown',
        publishedAt: { value: null, status: 'could_not_verify' },
      }),
    ]);
    const row = await one<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', ID);
    expect(row).toMatchObject({ deadline_at: null, published_at: null, status: 'unknown' });
  });

  it('normalises offsets to UTC', async () => {
    await postV2([
      makeRecord(1, { deadline: { value: '2026-11-30T23:00:00+02:00', status: 'published' } }),
    ]);
    expect(
      (await one<{ deadline_at: string }>('SELECT deadline_at FROM records WHERE id = ?', ID))
        .deadline_at,
    ).toBe('2026-11-30T21:00:00.000Z');
  });
});

describe('POST /ingest/v2: scan report', () => {
  it('computes new/updated counts server-side and finishes the scan', async () => {
    await postV2([makeRecord(1), makeRecord(2)], { recordsFound: 99, pagesChecked: 3 });
    await postV2([makeRecord(1, extended, 2)], {
      status: 'succeeded',
      finishedAt: NOW,
      recordsFound: 99,
      pagesChecked: 4,
      coverageLimitations: ['Only keyword matches were visited'],
      failures: [{ stage: 'detail', error: 'timeout', url: null }],
    });
    const scan = await one<Record<string, unknown>>(
      'SELECT * FROM scans WHERE id = ?',
      'scan-test-0001',
    );
    expect(scan).toMatchObject({
      status: 'succeeded',
      records_new: 2,
      records_updated: 1,
      records_found: 99,
      pages_checked: 4,
    });
    expect(scan.finished_at).toBe(NOW);
    expect(JSON.parse(String(scan.coverage_limitations_json))).toEqual([
      'Only keyword matches were visited',
    ]);
  });

  it('a late "running" report cannot reopen a finished scan', async () => {
    await postV2([], { status: 'failed', finishedAt: NOW });
    await postV2([], { status: 'running' });
    expect(
      (await one<{ status: string }>('SELECT status FROM scans WHERE id = ?', 'scan-test-0001'))
        .status,
    ).toBe('failed');
  });

  it('rejects a scanId that belongs to another source', async () => {
    await postV2([]);
    const res = await postV2([], { source: 'other' });
    expect(res.status).toBe(409);
  });

  it('GET /api/tenders sees what was ingested (smoke)', async () => {
    await postV2([makeRecord(1)]);
    const res = await call(api('/api/tenders'));
    expect(((await res.json()) as { total: number }).total).toBe(1);
  });
});
