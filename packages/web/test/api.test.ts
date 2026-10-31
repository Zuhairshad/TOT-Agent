import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api/client';

const reply = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );

function client(fetchImpl: typeof fetch, onUnauthorized = vi.fn()) {
  return {
    api: new ApiClient({ getToken: () => 'tok', fetchImpl, onUnauthorized }),
    onUnauthorized,
  };
}

/** The ApiError a call rejects with (fails the test if it resolves). */
const failure = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to fail');
};

describe('ApiClient', () => {
  it('sends the bearer token and encodes the tender id', async () => {
    const f = reply(200, { record: { title: 'T', source: 's', items: [] } });
    await client(f as unknown as typeof fetch).api.getTender('worldbank:P 1/2');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/tenders/worldbank%3AP%201%2F2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('401 calls onUnauthorized and throws kind=unauthorized', async () => {
    const { api, onUnauthorized } = client(reply(401, { error: 'no' }) as unknown as typeof fetch);
    await expect(api.listTenders('')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('409 means a scan is already running', async () => {
    const { api } = client(reply(409, { error: 'busy' }) as unknown as typeof fetch);
    await expect(api.startScan('worldbank')).rejects.toMatchObject({
      kind: 'conflict',
      message: 'busy',
      status: 409,
    });
  });
  it('501 surfaces the server message', async () => {
    const { api } = client(
      reply(501, { message: 'Scans are not configured' }) as unknown as typeof fetch,
    );
    const e = await failure(api.startScan('x'));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ kind: 'not_configured', message: 'Scans are not configured' });
  });
  it('network failure and non-JSON bodies become ApiErrors', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('boom');
    });
    await expect(client(down as unknown as typeof fetch).api.getConfig()).rejects.toMatchObject({
      kind: 'network',
    });
    await expect(
      client(reply(200, 'not json') as unknown as typeof fetch).api.getConfig(),
    ).rejects.toMatchObject({
      kind: 'bad_response',
    });
    await expect(
      client(reply(500, 'oops') as unknown as typeof fetch).api.getConfig(),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });
  it('POST/PUT send JSON bodies', async () => {
    const f = reply(200, {});
    await client(f as unknown as typeof fetch).api.startScan('worldbank', { a: 1 });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"source":"worldbank","params":{"a":1}}');
  });
});

describe('409 / 400 messages', () => {
  it('maps Worker error codes to plain language and lists invalid fields', async () => {
    const running = await failure(
      client(
        reply(409, { error: 'scan_running', runningScanId: 'x' }) as unknown as typeof fetch,
      ).api.startScan('worldbank'),
    );
    expect(running).toMatchObject({ kind: 'conflict', code: 'scan_running' });
    expect(running.message).toContain('already running');
    const recent = await failure(
      client(reply(409, { error: 'recently_dispatched' }) as unknown as typeof fetch).api.startScan(
        'worldbank',
      ),
    );
    expect(recent.message).toContain('still starting');
    const bad = await failure(
      client(
        reply(400, {
          error: 'invalid_body',
          fields: { 'groups.1.terms': ['already in group'] },
        }) as unknown as typeof fetch,
      ).api.getConfig(),
    );
    expect(bad.message).toContain('groups.1.terms: already in group');
  });
});
