import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tender } from '@tender-monitor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type Deps } from '../src/run.js';
import type { PageLike } from '../src/types.js';

const mk = (ref: string, keyword: string): Tender => ({
  totRef: ref,
  title: `t ${ref}`,
  country: 'Zambia',
  postedAt: '2026-10-01T00:00:00.000Z',
  deadline: null,
  url: `https://x.test/${ref}`,
  matchedKeyword: keyword,
  scrapedAt: '2026-10-30T00:00:00.000Z',
});

const BASE = 'http://127.0.0.1:9';
const baseEnv = {
  TOT_BASE_URL: BASE,
  TOT_EMAIL: 'demo@example.com',
  TOT_PASSWORD: 'pw',
  INGEST_URL: 'https://w.test/ingest',
  INGEST_SECRET: 's',
};

interface Setup {
  deps: Deps;
  gotos: string[];
  logs: string[];
  sleeps: number[];
  fetchFn: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  saved: string[];
  shots: string[];
  parse: ReturnType<typeof vi.fn>;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'run-'));
});

/** pages: map URL substring -> {status, html}; default is a normal 200 page. */
function setup(opts: {
  hasSession?: boolean;
  keywords?: string[];
  pageSize?: number | null;
  respond?: (url: string, n: number) => { status: number; html: string };
  parse?: (html: string, kw: string) => Tender[];
  ingestStatus?: number;
}): Setup {
  const gotos: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const saved: string[] = [];
  const shots: string[] = [];
  let current = '';
  let last = { status: 200, html: '<html>ok</html>' };
  const page: PageLike = {
    async goto(url) {
      gotos.push(url);
      current = url;
      last = opts.respond?.(url, gotos.length) ?? { status: 200, html: '<html>ok</html>' };
      return { status: last.status };
    },
    content: async () => last.html,
    url: () => current,
    screenshot: async (f) => void shots.push(f),
    raw: {},
  };
  const login = vi.fn(async () => {
    last = { status: 200, html: '<html>home</html>' };
  });
  const fetchFn = vi.fn(async () => new Response('', { status: opts.ingestStatus ?? 200 }));
  const parse = vi.fn(opts.parse ?? ((_h: string, kw: string) => [mk(`${kw}-1`, kw)]));
  const keywordsFile = path.join(dir, 'k.json');
  const kw = opts.keywords ?? ['a', 'b'];
  // write synchronously-ish via fs in tests below
  const deps: Deps = {
    launch: async () => ({
      newPage: async () => page,
      saveState: async (f) => void saved.push(f),
      close: async () => undefined,
    }),
    sleep: async (ms) => void sleeps.push(ms),
    rand: () => 0,
    fetch: fetchFn as unknown as typeof fetch,
    parse,
    login,
    now: () => 1000,
    hasSession: () => opts.hasSession ?? true,
    keywordsPath: keywordsFile,
    storageStatePath: path.join(dir, 'state.json'),
    screenshotDir: path.join(dir, 'shots'),
    pageSize: opts.pageSize === undefined ? 2 : opts.pageSize,
    log: (l) => void logs.push(l),
    table: vi.fn(),
  };
  // tests call writeKeywords before main
  (deps as Deps & { _kw: string[] })._kw = kw;
  return { deps, gotos, logs, sleeps, fetchFn, login, saved, shots, parse };
}

async function run(s: Setup, argv: string[] = [], env: NodeJS.ProcessEnv = baseEnv) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(s.deps.keywordsPath, JSON.stringify((s.deps as Deps & { _kw: string[] })._kw));
  return main(s.deps, argv, env);
}

describe('main', () => {
  it('searches every keyword, de-duplicates by totRef and posts once', async () => {
    const s = setup({
      pageSize: null,
      parse: (_h, kw) => [mk('SAME', kw), mk(`${kw}-only`, kw)],
    });
    expect(await run(s)).toBe(0);
    expect(s.gotos).toHaveLength(2);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    const init = (s.fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('ok');
    expect(body.tenders.map((t: Tender) => t.totRef).sort()).toEqual(['SAME', 'a-only', 'b-only']);
    expect(s.logs.at(-1)).toMatch(/keywords=2 pages=2 tenders=3/);
  });

  it('opens page 2 only after a full page 1, and never a 3rd page', async () => {
    const s = setup({
      keywords: ['a'],
      pageSize: 2,
      parse: (_h, kw) => [mk(`${kw}-${Math.random()}`, kw), mk(`${kw}-${Math.random()}`, kw)],
    });
    expect(await run(s)).toBe(0);
    expect(s.gotos).toHaveLength(2);
    expect(s.gotos[1]).toContain('page=2');
  });

  it('does not open page 2 after a short page', async () => {
    const s = setup({ keywords: ['a'], pageSize: 5 });
    await run(s);
    expect(s.gotos).toHaveLength(1);
  });

  it('sleeps between page loads (not before the first)', async () => {
    const s = setup({ pageSize: null });
    await run(s);
    expect(s.sleeps).toEqual([3000]);
  });

  it('--dry-run prints a table and does not POST', async () => {
    const s = setup({ pageSize: null });
    expect(await run(s, ['--dry-run'], { TOT_BASE_URL: BASE })).toBe(0);
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.deps.table).toHaveBeenCalledTimes(1);
  });

  it('exits 2 on a CAPTCHA, screenshots, reports blocked, and does not retry', async () => {
    const s = setup({
      keywords: ['a'],
      respond: () => ({ status: 200, html: '<div class="g-recaptcha"></div>' }),
    });
    expect(await run(s)).toBe(2);
    expect(s.gotos).toHaveLength(1);
    expect(s.shots).toHaveLength(1);
    const init = (s.fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ status: 'blocked', tenders: [] });
  });

  it('exits 2 on HTTP 429 and skips the report in --dry-run', async () => {
    const s = setup({ respond: () => ({ status: 429, html: '' }) });
    expect(await run(s, ['--dry-run'], { TOT_BASE_URL: BASE })).toBe(2);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it('logs in when the stored session has expired, saves state, and retries once', async () => {
    const s = setup({
      keywords: ['a'],
      pageSize: null,
      respond: (_u, n) =>
        n === 1
          ? { status: 200, html: '<input type="password">' }
          : { status: 200, html: '<html>results</html>' },
    });
    expect(await run(s)).toBe(0);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect(s.saved).toHaveLength(1);
    expect(s.gotos).toHaveLength(2);
  });

  it('logs in up front when there is no stored session', async () => {
    const s = setup({ hasSession: false, keywords: ['a'], pageSize: null });
    expect(await run(s)).toBe(0);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect(s.saved).toHaveLength(1);
  });

  it('treats the login form reappearing after login as a block (exit 2)', async () => {
    const s = setup({
      keywords: ['a'],
      respond: () => ({ status: 200, html: '<input type="password">' }),
    });
    expect(await run(s)).toBe(2);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect(s.gotos).toHaveLength(2);
  });

  it('exits 1 with a screenshot on an ordinary failure (parser stub)', async () => {
    const s = setup({
      parse: () => {
        throw new Error('parseResults not implemented');
      },
    });
    expect(await run(s)).toBe(1);
    expect(s.shots).toHaveLength(1);
    expect(s.logs.join('\n')).toMatch(/RUN FAILED/);
  });

  it('exits 1 when INGEST_* are missing and not a dry run', async () => {
    const s = setup({});
    expect(await run(s, [], { TOT_BASE_URL: BASE })).toBe(1);
    expect(s.gotos).toHaveLength(0);
  });

  it('refuses the real site while site.ts is unconfigured', async () => {
    const s = setup({});
    expect(await run(s, [], { ...baseEnv, TOT_BASE_URL: '' })).toBe(1);
    expect(s.gotos).toHaveLength(0);
  });

  it('refuses fast delays against the real site before touching it (delay floor)', async () => {
    const s = setup({});
    const env = {
      ...baseEnv,
      TOT_BASE_URL: '',
      TOT_ALLOW_FAST_DELAYS: '1',
      TOT_MIN_DELAY_MS: '0',
      TOT_MAX_DELAY_MS: '1',
    };
    expect(await run(s, [], env)).toBe(1);
    expect(s.logs.join('\n')).toMatch(/below the 3000 ms floor/);
    expect(s.gotos).toHaveLength(0);
  });

  it('hard-caps page loads at 2 per keyword even when every page is full', async () => {
    const s = setup({
      keywords: ['a', 'b', 'c'],
      pageSize: 2,
      parse: (_h, kw) => [mk(`${kw}-${Math.random()}`, kw), mk(`${kw}-${Math.random()}`, kw)],
    });
    expect(await run(s)).toBe(0);
    expect(s.gotos).toHaveLength(6); // 3 keywords x 2 pages, never a 3rd page
  });
});
