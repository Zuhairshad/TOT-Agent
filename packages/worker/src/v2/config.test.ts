import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, call, clearV2 } from '../../test/helpers.js';
import worker from '../index.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  delete (env as { ASSETS?: unknown }).ASSETS;
  await clearV2();
});

const put = (body: unknown) => call(api('/api/config', { method: 'PUT', body }));
const group = (id: string, terms: string[]) => ({ id, label: id, terms });

describe('GET/PUT /api/config', () => {
  it('serves the packaged default until something is saved', async () => {
    const body = (await (await call(api('/api/config'))).json()) as {
      custom: boolean;
      config: { groups: Array<{ id: string }> };
    };
    expect(body.custom).toBe(false);
    expect(body.config.groups.map((g) => g.id)).toEqual(['motorbikes', 'riding_gear', 'ppe']);
  });

  it('saves a valid config and returns it on the next GET', async () => {
    const config = {
      groups: [group('motorbikes', ['boda boda']), group('ppe', ['hard hat'])],
      exclusions: ['insurance'],
      countries: ['Zambia'],
    };
    const res = await put(config);
    expect(res.status).toBe(200);
    const got = (await (await call(api('/api/config'))).json()) as {
      custom: boolean;
      config: Record<string, unknown>;
    };
    expect(got.custom).toBe(true);
    expect(got.config).toMatchObject({ ...config, publishedSince: null });
    // also accepts the {config: ...} envelope that GET returns
    expect((await put({ config })).status).toBe(200);
  });

  it('rejects schema violations with field errors', async () => {
    const res = await put({ groups: [group('cars', ['x'])], exclusions: 'no' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: Record<string, string[]> };
    expect(Object.keys(body.fields)).toEqual(expect.arrayContaining(['groups.0.id', 'exclusions']));
  });

  it('keeps broad PPE separate: the same term cannot sit in two groups', async () => {
    const res = await put({
      groups: [group('riding_gear', ['safety helmet']), group('ppe', ['Safety Helmet'])],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('keep broad PPE separate');
  });

  it('enforces size limits', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `term ${i}`);
    expect((await put({ groups: [group('ppe', many)] })).status).toBe(400);
    expect((await put({ groups: [group('ppe', ['x'.repeat(81)])] })).status).toBe(400);
    expect(
      (await put({ groups: [group('ppe', ['a'])], exclusions: Array(201).fill('e') })).status,
    ).toBe(400);
    const huge = { groups: [group('ppe', ['a'])], exclusions: ['y'.repeat(70_000)] };
    expect((await put(huge)).status).toBe(413);
    expect((await call(api('/api/config', { method: 'PUT', body: undefined }))).status).toBe(400);
  });

  it('rejects a bad publishedSince', async () => {
    expect((await put({ groups: [], publishedSince: 'soon' })).status).toBe(400);
  });
});

describe('static UI fallthrough', () => {
  const withAssets = () => {
    const fetchAsset = vi.fn(
      async (req: Request) => new Response(`<html>asset ${new URL(req.url).pathname}`),
    );
    env.ASSETS = { fetch: fetchAsset } as unknown as Fetcher;
    return fetchAsset;
  };
  const send = (path: string, method = 'GET') =>
    worker.fetch(new Request(`https://w.test${path}`, { method }), env, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);

  it('serves non-API GET paths from ASSETS', async () => {
    const asset = withAssets();
    expect(await (await send('/tender/worldbank%3AFIX-1')).text()).toContain('asset /tender/');
    expect(asset).toHaveBeenCalledTimes(1);
  });

  it('keeps API, Slack, health and admin paths on the Worker', async () => {
    const asset = withAssets();
    expect((await send('/api/unknown')).status).toBe(404);
    expect((await send('/scans/unknown')).status).toBe(404);
    expect((await send('/ingest/v2')).status).toBe(405);
    expect((await send('/slack/unknown')).status).toBe(404);
    expect((await send('/admin/unknown')).status).toBe(404);
    expect((await send('/health')).status).toBe(200);
    expect((await send('/api/tenders')).status).toBe(401);
    expect(asset).not.toHaveBeenCalled();
  });

  it('does not forward non-GET requests to ASSETS', async () => {
    const asset = withAssets();
    expect((await send('/whatever', 'POST')).status).toBe(404);
    expect(asset).not.toHaveBeenCalled();
  });
});
