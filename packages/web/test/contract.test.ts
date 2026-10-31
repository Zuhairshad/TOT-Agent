// @vitest-environment happy-dom
/**
 * Contract test: REAL Worker responses (captured from a local Worker run, see
 * test/fixtures/real-api/README.md) go through the real ApiClient and the real views.
 * The other tests use dev/fixtures.ts, which is the UI's own idea of the API; only this file can
 * notice that the Worker says something different.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderRecordSchema } from '@tender-monitor/shared';
import { ApiClient, ApiError } from '../src/api/client';
import { formatDate, formatDeadline, formatMoney } from '../src/format';
import { ShortlistStore } from '../src/state';
import { tenderCard } from '../src/ui/components';
import { renderDetailBody } from '../src/views/detail';
import { sourceCard } from '../src/views/scans';
import type { AppContext } from '../src/context';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-api');
const real = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), 'utf8'));

/** An ApiClient whose "server" answers with the given captured response. */
const clientFor = (body: unknown, status = 200) =>
  new ApiClient({
    getToken: () => 'tok',
    fetchImpl: (async () =>
      new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
  });

const store = () =>
  new ShortlistStore({
    getShortlist: async () => [],
    addShortlist: async () => undefined,
    removeShortlist: async () => undefined,
  });
const card = (item: Parameters<typeof tenderCard>[0]) =>
  tenderCard(item, { href: '#/x', store: store(), onError: () => undefined });
const ctx = (): AppContext =>
  ({
    store: store(),
    flash: () => undefined,
    exportPdf: async () => undefined,
  }) as unknown as AppContext;

/** The ApiError a call rejects with (fails the test if it resolves). */
const failure = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to fail');
};

describe('real Worker: GET /api/tenders', () => {
  it('normalises every captured item without throwing', async () => {
    const list = await clientFor(real('list.json')).listTenders('');
    expect(list.items).toHaveLength(15);
    expect(list.total).toBe(15);
    for (const it of list.items) {
      expect(typeof it.publishedAt.value === 'string' || it.publishedAt.value === null).toBe(true);
      expect(() => card(it)).not.toThrow();
    }
  });

  it('shows the publication date, an unpublished deadline and the award value (not estimated)', async () => {
    const list = await clientFor(real('list.json')).listTenders('');
    const ppe = list.items.find((i) => i.id === 'worldbank:OP00282200');
    expect(ppe).toBeDefined();
    if (!ppe) return;
    expect(formatDate(ppe.publishedAt).text).toBe('2024-04-02');
    const dl = formatDeadline(ppe.deadline, ppe.deadlineKnown);
    expect(dl.headline).toBe('Deadline unknown');
    expect(dl.reason).toBe('Deadline not published');
    expect(formatMoney(ppe.awardValue).text).toBe('109,620 ZMW');
    expect(formatMoney(ppe.estimatedValue).missing).toBe(true);

    const text = card(ppe).textContent ?? '';
    expect(text).toContain('2024-04-02');
    expect(text).toContain('Deadline not published');
    expect(text).toContain('Contract award value');
    expect(text).toContain('109,620 ZMW');
    expect(text).not.toContain('Estimated value'); // an award is never shown as an estimate
    expect(text).toContain('Buyer: Not published'); // real buyer is null
    expect(text).toContain('Closed');
  });
});

describe('real Worker: GET /api/tenders/:id', () => {
  for (const file of ['detail-award-ppe.json', 'detail-motorcycle-helmets.json']) {
    it(`${file}: record satisfies the shared schema and the page renders`, async () => {
      const raw = real(file) as { record: unknown };
      expect(TenderRecordSchema.safeParse(raw.record).success).toBe(true);
      const data = await clientFor(raw).getTender('worldbank:x');
      expect(data.versions[0]?.version).toBe(1);
      expect(data.versions[0]?.isCurrent).toBe(true);
      const text = renderDetailBody(data, ctx()).textContent ?? '';
      expect(text).toContain('Not published');
      expect(text).toContain('Contract award value');
      expect(text).toContain('Version 1');
      expect(text).toContain('Procurement'); // title
    });
  }

  it('award notice: value is in the award field, estimate is missing', async () => {
    const data = await clientFor(real('detail-award-ppe.json')).getTender('x');
    const r = data.record;
    expect(formatMoney(r.awardValue).text).toBe('109,620 ZMW');
    expect(formatMoney(r.awardValue).original).toBe('ZMW 109620.00');
    expect(formatMoney(r.estimatedValue).text).toBe('Not published');
    expect(formatDate(r.publishedAt).original).toBe('02-Apr-2024');
    expect(data.missingData).toContain('deadline');
    expect(data.missingDetails?.deadline).toBe('not_published');
  });
});

describe('real Worker: GET /api/scans', () => {
  it('uses source (not id) and accessStatus per source, in plain language', async () => {
    const data = await clientFor(real('scans.json')).getScans();
    const wb = data.sources.find((s) => s.id === 'worldbank');
    const tot = data.sources.find((s) => s.id === 'tendersontime');
    expect(wb?.accessStatus).toBe('ok');
    expect(wb?.recordCount).toBe(15);
    expect(wb?.lastSuccessfulScan).toBe('2026-10-31T14:07:45.000Z');
    expect(tot?.accessStatus).toBe('blocked_by_challenge');
    expect(tot?.lastSuccessfulScan).toBeNull();
    expect(data.scans.length).toBeGreaterThanOrEqual(3);

    const wbText = sourceCard(wb as NonNullable<typeof wb>, () => undefined).textContent ?? '';
    expect(wbText).toContain('worldbank');
    expect(wbText).toContain('Reachable');
    const totText = sourceCard(tot as NonNullable<typeof tot>, () => undefined).textContent ?? '';
    expect(totText).toContain('Blocked by a bot challenge');
    expect(totText).toContain('do not try to get around it');
    expect(totText).toContain('not retried and not worked around'); // the real failure message
    expect(totText).toContain('Never'); // last successful scan
  });
});

describe('real Worker: shortlist, config, errors', () => {
  it('shortlist ids come from {ids, items}', async () => {
    expect(await clientFor(real('shortlist.json')).getShortlist()).toEqual([
      'worldbank:OP00282200',
    ]);
    await expect(clientFor(real('shortlist-put.json')).addShortlist('a')).resolves.toBeUndefined();
    await expect(
      clientFor(real('shortlist-delete.json')).removeShortlist('a'),
    ).resolves.toBeUndefined();
  });

  it('config is unwrapped from {config, custom}', async () => {
    const cfg = await clientFor(real('config.json')).getConfig();
    expect(cfg.groups.map((g) => g.id)).toEqual(['motorbikes', 'riding_gear', 'ppe']);
    expect(cfg.countries).toEqual(['Zambia']);
    expect(cfg.publishedSince).toBeNull();
    const saved = await clientFor(real('config.json')).putConfig(cfg);
    expect(saved.groups).toHaveLength(3);
  });

  it('error bodies become readable ApiErrors', async () => {
    const e400 = await failure(clientFor(real('error-400.json'), 400).listTenders('sort=bogus'));
    expect(e400).toBeInstanceOf(ApiError);
    expect(e400).toMatchObject({ kind: 'http', status: 400, code: 'invalid_query' });
    expect(e400.message).toContain('sort');
    const e401 = await failure(clientFor(real('error-401.json'), 401).listTenders(''));
    expect(e401).toMatchObject({ kind: 'unauthorized', status: 401 });
    const e501 = await failure(clientFor(real('scan-start-501.json'), 501).startScan('worldbank'));
    expect(e501).toMatchObject({ kind: 'not_configured', code: 'not_configured' });
    expect(e501.message).toContain('GITHUB_DISPATCH_TOKEN');
  });

  it('a response of the wrong shape is a clean bad_response, not a crash', async () => {
    const e = await failure(clientFor({ items: 'nope' }).listTenders(''));
    expect(e).toMatchObject({ kind: 'bad_response' });
    const e2 = await failure(clientFor({ groups: [] }).getConfig());
    expect(e2).toMatchObject({ kind: 'bad_response' });
  });
});

describe('fixtures folder', () => {
  it('contains no e-mail addresses', () => {
    for (const f of readdirSync(DIR)) {
      expect(readFileSync(path.join(DIR, f), 'utf8')).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});
