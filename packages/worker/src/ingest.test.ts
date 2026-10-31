import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, ingestRequest, makeTender, stubSlack } from '../test/helpers.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tender_files'),
    env.DB.prepare('DELETE FROM tenders'),
    env.DB.prepare('DELETE FROM runs'),
  ]);
});

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe('POST /ingest', () => {
  it('rejects a wrong or missing secret with 401 and logs nothing', async () => {
    const calls = stubSlack();
    expect((await call(ingestRequest({ tenders: [] }, 'wrong'))).status).toBe(401);
    expect((await call(ingestRequest({ tenders: [] }, null))).status).toBe(401);
    expect(await count('runs')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid body with 400 and field errors', async () => {
    stubSlack();
    const res = await call(ingestRequest({ tenders: [{ totRef: '', title: 'x' }] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: Record<string, string[]> };
    expect(body.error).toBe('invalid_body');
    expect(body.fields['tenders.0.totRef']).toBeDefined();
    expect(body.fields['tenders.0.country']).toEqual(['Required']);
    expect(await count('tenders')).toBe(0);
    expect(await count('runs')).toBe(1);
  });

  it('stores a tender sent twice once and posts to Slack once', async () => {
    const calls = stubSlack();
    const body = { tenders: [makeTender(1)] };
    expect(await (await call(ingestRequest(body))).json()).toMatchObject({ received: 1, new: 1 });
    expect(await (await call(ingestRequest(body))).json()).toMatchObject({ received: 1, new: 0 });
    expect(await count('tenders')).toBe(1);
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(calls[0]?.body.channel).toBe('C123');
    const row = await env.DB.prepare('SELECT slack_ts, status FROM tenders').first<{
      slack_ts: string;
      status: string;
    }>();
    expect(row?.slack_ts).toMatch(/^1700000000\./);
    expect(row?.status).toBe('new');
    expect(await count('runs')).toBe(2);
  });

  it('merges matched_keywords when a known tender arrives for another keyword', async () => {
    const calls = stubSlack();
    await call(ingestRequest({ tenders: [makeTender(1, { matchedKeyword: 'bikes' })] }));
    await call(
      ingestRequest({
        tenders: [
          makeTender(1, { matchedKeyword: 'motorcycle' }),
          makeTender(1, { matchedKeyword: 'bikes' }),
        ],
      }),
    );
    const row = await env.DB.prepare('SELECT matched_keywords FROM tenders').first<{
      matched_keywords: string;
    }>();
    expect(JSON.parse(row!.matched_keywords)).toEqual(['bikes', 'motorcycle']);
    expect(calls).toHaveLength(1);
  });

  it('posts 15 messages plus one "+N more" summary for 20 new tenders, soonest deadline first', async () => {
    const calls = stubSlack();
    const tenders = Array.from({ length: 20 }, (_, i) => makeTender(i + 1));
    await call(ingestRequest({ tenders }));
    expect(await count('tenders')).toBe(20);
    expect(calls).toHaveLength(16);
    expect(calls[15]?.body.text).toContain('+5 more');
    const posted = calls.slice(0, 15).map((c) => String(c.body.text));
    const deadlines = posted.map((t) => Number(/number (\d+)/.exec(t)![1]) % 28);
    expect([...deadlines].sort((a, b) => a - b)).toEqual(deadlines);
  });

  it('alerts Slack straight away for a blocked run and logs it', async () => {
    const calls = stubSlack();
    const res = await call(
      ingestRequest({ status: 'blocked', note: 'CAPTCHA shown', tenders: [] }),
    );
    expect(res.status).toBe(200);
    expect(String(calls[0]?.body.text)).toContain('BLOCKED');
    expect(String(calls[0]?.body.text)).toContain('CAPTCHA shown');
    const run = await env.DB.prepare('SELECT status, note FROM runs').first<{
      status: string;
      note: string;
    }>();
    expect(run).toEqual({ status: 'blocked', note: 'CAPTCHA shown' });
  });
});
