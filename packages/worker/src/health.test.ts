import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { checkScraperHeartbeat } from './cron.js';
import {
  call,
  clearV2,
  ingestRequest,
  machine,
  makeRecord,
  makeReport,
  makeTender,
  NOW,
  stubSlack,
} from '../test/helpers.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([env.DB.prepare('DELETE FROM tenders'), env.DB.prepare('DELETE FROM runs')]);
});

describe('GET /health', () => {
  it('reports no runs initially, then last run and counts', async () => {
    stubSlack();
    let body = (await (await call(new Request('https://w.test/health'))).json()) as Record<
      string,
      unknown
    >;
    expect(body.lastRun).toBeNull();
    await call(ingestRequest({ tenders: [makeTender(1), makeTender(2)] }));
    body = (await (await call(new Request('https://w.test/health'))).json()) as Record<
      string,
      unknown
    >;
    expect(body.lastRun).toMatchObject({ status: 'ok', found: 2, new: 2 });
    expect(body.tenders).toEqual({ total: 2, new: 2, shortlisted: 0, ignored: 0 });
  });
  it('includes the latest v2 scan and record count', async () => {
    let body = (await (await call(new Request('https://w.test/health'))).json()) as {
      v2: { records: number; lastScan: Record<string, unknown> | null };
    };
    expect(body.v2).toEqual({ records: 0, lastScan: null });
    await call(
      machine('/ingest/v2', {
        report: makeReport({ status: 'succeeded', finishedAt: NOW }),
        records: [makeRecord(1)],
      }),
    );
    body = (await (await call(new Request('https://w.test/health'))).json()) as typeof body;
    expect(body.v2.records).toBe(1);
    expect(body.v2.lastScan).toMatchObject({ source: 'worldbank', status: 'succeeded', new: 1 });
    await clearV2();
  });
  it('404s unknown routes', async () => {
    expect(
      (await worker.fetch(new Request('https://w.test/nope'), env, {} as ExecutionContext)).status,
    ).toBe(404);
  });
});

describe('cron watchdog', () => {
  it('alerts when no run in 3 hours, stays quiet after a recent run', async () => {
    const calls = stubSlack();
    expect(await checkScraperHeartbeat(env)).toBe(true);
    expect(calls[0]?.body.text).toBe("Scraper hasn't reported in 3 hours");
    await env.DB.prepare("INSERT INTO runs (started_at, source, status) VALUES (?, 'x', 'ok')")
      .bind(new Date(Date.now() - 2 * 3600_000).toISOString())
      .run();
    expect(await checkScraperHeartbeat(env)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await checkScraperHeartbeat(env, new Date(Date.now() + 2 * 3600_000))).toBe(true);
  });
});
