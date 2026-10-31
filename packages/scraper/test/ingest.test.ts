import { describe, expect, it, vi } from 'vitest';
import { IngestError, postIngest, reportBlocked } from '../src/ingest.js';

const env = { INGEST_URL: 'https://w.test/ingest', INGEST_SECRET: 's3cret' };
const tender = {
  totRef: 'T1',
  title: 't',
  country: 'Zambia',
  postedAt: '2026-10-01T00:00:00.000Z',
  deadline: null,
  url: 'https://x.test/1',
  matchedKeyword: 'helmet',
  scrapedAt: '2026-10-30T00:00:00.000Z',
};
const body = { source: 'github-actions', status: 'ok' as const, tenders: [tender] };
const res = (status: number) => new Response('', { status });

function deps(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchFn = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  return { fetch: fetchFn as unknown as typeof fetch, sleep, fetchFn };
}

describe('postIngest', () => {
  it('sends JSON with a bearer token', async () => {
    const d = deps(res(200));
    await postIngest(env, body, d);
    const [url, init] = d.fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.INGEST_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    expect(JSON.parse(init.body as string).tenders).toHaveLength(1);
  });
  it('retries on 503 and then succeeds', async () => {
    const d = deps(res(503), res(503), res(200));
    await postIngest(env, body, d);
    expect(d.fetchFn).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });
  it('retries on network errors', async () => {
    const d = deps(new Error('ECONNRESET'), res(200));
    await postIngest(env, body, d);
    expect(d.fetchFn).toHaveBeenCalledTimes(2);
  });
  it('gives up after 3 retries', async () => {
    const d = deps(res(500), res(500), res(500), res(500));
    await expect(postIngest(env, body, d)).rejects.toBeInstanceOf(IngestError);
    expect(d.fetchFn).toHaveBeenCalledTimes(4);
  });
  it('does not retry on 401', async () => {
    const d = deps(res(401), res(200));
    await expect(postIngest(env, body, d)).rejects.toMatchObject({ status: 401 });
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });
  it('requires INGEST_URL and INGEST_SECRET', async () => {
    await expect(postIngest({}, body, deps())).rejects.toBeInstanceOf(IngestError);
  });
});

describe('reportBlocked', () => {
  it('posts a blocked status with no tenders', async () => {
    const d = deps(res(200));
    await reportBlocked(env, 'captcha', d);
    const init = (d.fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({
      status: 'blocked',
      tenders: [],
      note: 'captcha',
    });
  });
});
