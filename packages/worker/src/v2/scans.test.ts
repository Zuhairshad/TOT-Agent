import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  call,
  clearV2,
  machine,
  makeRecord,
  NOW,
  postV2,
  stubSlack,
} from '../../test/helpers.js';
import { setClock } from './http.js';
import { SINCE_OVERLAP_MS, STALE_LOCK_MS } from './scans.js';

afterEach(async () => {
  setClock(null);
  vi.unstubAllGlobals();
  delete (env as { GITHUB_DISPATCH_TOKEN?: string }).GITHUB_DISPATCH_TOKEN;
  delete (env as { GITHUB_REPOSITORY?: string }).GITHUB_REPOSITORY;
  await clearV2();
});

const start = async (scanId: string, source = 'worldbank', extra: Record<string, unknown> = {}) => {
  const res = await call(machine('/scans/start', { source, scanId, ...extra }));
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const at = (iso: string) => setClock(() => new Date(iso));

describe('POST /scans/start', () => {
  it('requires the ingest secret and a valid body', async () => {
    const body = { source: 'worldbank', scanId: 'scan-aaaa-0001' };
    expect((await call(machine('/scans/start', body, 'wrong'))).status).toBe(401);
    expect((await call(machine('/scans/start', body, env.APP_TOKEN))).status).toBe(401);
    const bad = await call(machine('/scans/start', { source: 'Bad Source', scanId: 'x' }));
    expect(bad.status).toBe(400);
    expect(Object.keys(((await bad.json()) as { fields: object }).fields).sort()).toEqual([
      'scanId',
      'source',
    ]);
  });

  it('creates a running scan and returns the default config and since=null', async () => {
    at(NOW);
    const { status, body } = await start('scan-aaaa-0001', 'worldbank', {
      triggeredBy: 'schedule',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      scanId: 'scan-aaaa-0001',
      resumed: false,
      since: null,
      status: 'running',
    });
    expect(body.config.groups.map((g: { id: string }) => g.id)).toEqual([
      'motorbikes',
      'riding_gear',
      'ppe',
    ]);
    const row = await env.DB.prepare('SELECT status, triggered_by FROM scans WHERE id = ?')
      .bind('scan-aaaa-0001')
      .first();
    expect(row).toEqual({ status: 'running', triggered_by: 'schedule' });
  });

  it('since = start of the last succeeded/partial scan minus the overlap; failed scans do not count', async () => {
    at('2026-10-20T08:00:00Z');
    await start('scan-ok-000001');
    await postV2([], {
      scanId: 'scan-ok-000001',
      status: 'partial',
      finishedAt: '2026-10-20T08:30:00Z',
    });
    at('2026-10-25T08:00:00Z');
    await start('scan-bad-00001');
    await postV2([], {
      scanId: 'scan-bad-00001',
      status: 'failed',
      finishedAt: '2026-10-25T08:05:00Z',
    });
    at(NOW);
    const { body } = await start('scan-new-00001');
    expect(body.since).toBe(
      new Date(Date.parse('2026-10-20T08:00:00Z') - SINCE_OVERLAP_MS).toISOString(),
    );
  });

  it('params.since overrides the high-water mark; a bad value is a 400', async () => {
    const ok = await start('scan-aaaa-0001', 'worldbank', { params: { since: '2026-01-01' } });
    expect(ok.body.since).toBe('2026-01-01T00:00:00.000Z');
    const bad = await start('scan-aaaa-0002', 'tendersontime', { params: { since: 'yesterday' } });
    expect(bad.status).toBe(400);
  });

  it('answers 409 with runningScanId while a scan of the same source runs; other sources are free', async () => {
    at(NOW);
    await start('scan-aaaa-0001');
    const second = await start('scan-aaaa-0002');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'scan_running', runningScanId: 'scan-aaaa-0001' });
    expect((await start('scan-aaaa-0003', 'tendersontime')).status).toBe(200);
  });

  it('replaces a stale lock (no heartbeat for 45 min) and marks the old scan failed', async () => {
    at(NOW);
    await start('scan-aaaa-0001');
    at(new Date(Date.parse(NOW) + STALE_LOCK_MS - 60_000).toISOString());
    expect((await start('scan-aaaa-0002')).status).toBe(409); // still alive
    at(new Date(Date.parse(NOW) + STALE_LOCK_MS + 60_000).toISOString());
    const fresh = await start('scan-aaaa-0002');
    expect(fresh.status).toBe(200);
    const old = await env.DB.prepare('SELECT status, failures_json FROM scans WHERE id = ?')
      .bind('scan-aaaa-0001')
      .first<{
        status: string;
        failures_json: string;
      }>();
    expect(old?.status).toBe('failed');
    expect(old?.failures_json).toContain('stale lock');
  });

  it('a heartbeat (ingest report) keeps the lock alive', async () => {
    at(NOW);
    await start('scan-aaaa-0001');
    at(new Date(Date.parse(NOW) + 40 * 60_000).toISOString());
    await postV2([], { scanId: 'scan-aaaa-0001' });
    at(new Date(Date.parse(NOW) + 80 * 60_000).toISOString());
    expect((await start('scan-aaaa-0002')).status).toBe(409);
  });

  it('is idempotent for the same scanId (resume) and returns the checkpoint', async () => {
    at(NOW);
    const first = await start('scan-aaaa-0001');
    await postV2([makeRecord(1)], {
      scanId: 'scan-aaaa-0001',
      checkpoint: { keyword: 'helmet', page: 2 },
    });
    const again = await start('scan-aaaa-0001');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      resumed: true,
      scanId: 'scan-aaaa-0001',
      status: 'running',
      since: first.body.since,
    });
    expect(again.body.checkpoint).toEqual({ keyword: 'helmet', page: 2 });
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM scans').first<{ n: number }>())?.n,
    ).toBe(1);
  });

  it('uses the saved config when one exists', async () => {
    const cfg = {
      groups: [{ id: 'motorbikes', label: 'Bikes', terms: ['boda boda'] }],
      exclusions: [],
      countries: ['Kenya'],
    };
    expect((await call(api('/api/config', { method: 'PUT', body: cfg }))).status).toBe(200);
    expect((await start('scan-aaaa-0001')).body.config.countries).toEqual(['Kenya']);
  });
});

describe('blocked scans', () => {
  it('stores status blocked and posts the Slack alert', async () => {
    const slack = stubSlack();
    const res = await postV2([], {
      status: 'blocked',
      accessStatus: 'blocked_by_challenge',
      finishedAt: NOW,
      failures: [{ stage: 'search', error: 'Cloudflare challenge page', url: null }],
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT status, access_status FROM scans').first();
    expect(row).toEqual({ status: 'blocked', access_status: 'blocked_by_challenge' });
    expect(slack).toHaveLength(1);
    expect(slack[0]?.method).toBe('chat.postMessage');
    expect(String(slack[0]?.body.text)).toContain('BLOCKED');
    expect(String(slack[0]?.body.text)).toContain('Cloudflare challenge page');
  });

  it('alerts once, not on every repeated blocked report', async () => {
    const slack = stubSlack();
    await postV2([], { status: 'blocked', accessStatus: 'blocked_by_challenge' });
    await postV2([], { status: 'blocked', accessStatus: 'blocked_by_challenge' });
    expect(slack).toHaveLength(1);
  });

  it('does not alert for other statuses and survives a failing Slack', async () => {
    const slack = stubSlack();
    await postV2([], { status: 'failed', finishedAt: NOW });
    expect(slack).toHaveLength(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const res = await postV2([], {
      scanId: 'scan-blk-00002',
      status: 'blocked',
      accessStatus: 'blocked_by_challenge',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/scans (trigger via GitHub Actions)', () => {
  const trigger = (
    body: unknown = { source: 'worldbank' },
    token: string | null = env.APP_TOKEN!,
  ) => call(api('/api/scans', { method: 'POST', body, token }));
  const configure = () => {
    env.GITHUB_DISPATCH_TOKEN = 'ghp_fake_for_tests';
    env.GITHUB_REPOSITORY = 'acme/tender-monitor';
  };

  it('needs the UI token', async () => {
    expect((await trigger({ source: 'worldbank' }, null)).status).toBe(401);
    expect((await trigger({ source: 'worldbank' }, env.INGEST_SECRET)).status).toBe(401);
  });

  it('answers 501 naming exactly what to configure', async () => {
    const res = await trigger();
    expect(res.status).toBe(501);
    const body = (await res.json()) as { message: string; missing: string[] };
    expect(body.missing).toHaveLength(2);
    expect(body.message).toContain('GITHUB_DISPATCH_TOKEN');
    expect(body.message).toContain('GITHUB_REPOSITORY');
    env.GITHUB_REPOSITORY = 'acme/tender-monitor';
    expect(((await (await trigger()).json()) as { missing: string[] }).missing).toHaveLength(1);
  });

  it('answers 409 while a scan of that source is running (and never calls GitHub)', async () => {
    configure();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await start('scan-aaaa-0001');
    const res = await trigger();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'scan_running', runningScanId: 'scan-aaaa-0001' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches the workflow with source, since and triggered_by, then blocks double clicks', async () => {
    configure();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );
    const res = await trigger({ source: 'worldbank', params: { since: '2026-10-01' } });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/tender-monitor/actions/workflows/scan.yml/dispatches',
    );
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghp_fake_for_tests',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      ref: 'main',
      inputs: { source: 'worldbank', since: '2026-10-01T00:00:00.000Z', triggered_by: 'ui' },
    });
    const again = await trigger();
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('recently_dispatched');
    expect(calls).toHaveLength(1);
  });

  it('reports a GitHub failure as 502 without leaking the token', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })),
    );
    const res = await trigger();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('ghp_fake');
  });

  it('validates the source name', async () => {
    expect((await trigger({ source: '../x' })).status).toBe(400);
  });
});
