import { describe, expect, it } from 'vitest';
import {
  adminDeleteUrl,
  assertTestRef,
  describePlan,
  findMessage,
  loadConfig,
  makeFakeTender,
  makeTestRef,
  runE2E,
  validateIngestUrl,
  type Deps,
  type E2EConfig,
} from './e2e-lib.js';
import { main } from './e2e.js';
import { IngestBodySchema } from '../packages/shared/src/tender.js';

const config: E2EConfig = {
  ingestUrl: 'https://worker.example.workers.dev/ingest',
  ingestSecret: 'ingest-secret-value',
  slackToken: 'xoxb-secret-token',
  channelId: 'C0TEST',
};
const REF = 'TEST-1700000000000';

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

interface WorldOpts {
  ingestStatus?: number;
  ingestNew?: number;
  historyError?: string;
  /** number of history polls that return nothing before the card shows up (Infinity = never) */
  cardAfterPolls?: number;
  deleteStatus?: number;
  slackDeleteOk?: boolean;
  rowSlackTs?: string | null;
  networkErrorOn?: string;
}

function world(o: WorldOpts = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const log: string[] = [];
  const deps: Deps = {
    now: () => 1_700_000_000_000,
    sleep: async () => undefined,
    log: (l) => log.push(l),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.get('authorization'),
      });
      if (o.networkErrorOn && url.includes(o.networkErrorOn)) throw new Error('boom');
      if (url.endsWith('/ingest')) {
        const status = o.ingestStatus ?? 200;
        return Response.json(
          status === 200
            ? { ok: true, received: 1, new: o.ingestNew ?? 1 }
            : { error: 'unauthorized' },
          { status },
        );
      }
      if (url.startsWith('https://slack.com/api/conversations.history')) {
        if (o.historyError) return Response.json({ ok: false, error: o.historyError });
        polls++;
        const appear = polls > (o.cardAfterPolls ?? 0);
        return Response.json({
          ok: true,
          messages: appear
            ? [
                { ts: '1.1', text: 'unrelated' },
                { ts: '1700000000.000500', text: `New tender: E2E smoke test ${REF}` },
              ]
            : [{ ts: '1.1', text: 'unrelated' }],
        });
      }
      if (url.includes('/admin/tenders/')) {
        const status = o.deleteStatus ?? 200;
        return Response.json(
          status === 200 ? { ok: true, slack_ts: o.rowSlackTs ?? null } : { error: 'x' },
          { status },
        );
      }
      if (url.endsWith('chat.delete')) {
        return Response.json(
          o.slackDeleteOk === false ? { ok: false, error: 'cant_delete_message' } : { ok: true },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch,
  };
  return { deps, calls, log };
}

const step = (r: Awaited<ReturnType<typeof runE2E>>, name: string) =>
  r.steps.find((s) => s.name === name);

describe('happy path', () => {
  it('ingests, finds the card, then cleans up row and message', async () => {
    const w = world({ cardAfterPolls: 2 });
    const r = await runE2E(config, w.deps, REF, { pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.name)).toEqual([
      'safety guard',
      'POST /ingest',
      'Slack card appeared',
      'cleanup: delete D1 row',
      'cleanup: delete Slack message',
    ]);
    const del = w.calls.find((c) => c.url.endsWith('chat.delete'))!;
    expect(del.body).toEqual({ channel: 'C0TEST', ts: '1700000000.000500' });
    const row = w.calls.find((c) => c.method === 'DELETE')!;
    expect(row.url).toBe(`https://worker.example.workers.dev/admin/tenders/${REF}`);
    expect(row.auth).toBe('Bearer ingest-secret-value');
    expect(w.calls.filter((c) => c.url.includes('conversations.history'))).toHaveLength(3);
    expect(w.log.every((l) => /^(PASS|FAIL)/.test(l))).toBe(true);
  });

  it('sends a body the real ingest schema accepts, for a TEST- ref', async () => {
    const w = world();
    await runE2E(config, w.deps, REF);
    const ingest = w.calls.find((c) => c.url.endsWith('/ingest'))!;
    const parsed = IngestBodySchema.parse(ingest.body);
    expect(parsed.tenders).toHaveLength(1);
    expect(parsed.tenders[0]?.totRef).toBe(REF);
    expect(ingest.auth).toBe('Bearer ingest-secret-value');
  });

  it('never prints a secret', async () => {
    const w = world({ historyError: 'missing_scope' });
    await runE2E(config, w.deps, REF);
    const out = w.log.join('\n');
    expect(out).not.toContain('ingest-secret-value');
    expect(out).not.toContain('xoxb-secret-token');
  });
});

describe('failures still clean up', () => {
  it('card never appears -> FAIL, but row and (known) message are cleaned up', async () => {
    const w = world({ cardAfterPolls: Infinity, rowSlackTs: '1700000000.000900' });
    const r = await runE2E(config, w.deps, REF, { pollAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(step(r, 'Slack card appeared')?.ok).toBe(false);
    expect(step(r, 'cleanup: delete D1 row')?.ok).toBe(true);
    // The row's slack_ts is used to remove a card the search missed.
    expect(w.calls.find((c) => c.url.endsWith('chat.delete'))?.body).toMatchObject({
      ts: '1700000000.000900',
    });
  });

  it('missing history scope is reported with a hint and not retried', async () => {
    const w = world({ historyError: 'missing_scope' });
    const r = await runE2E(config, w.deps, REF);
    expect(r.ok).toBe(false);
    expect(step(r, 'Slack card appeared')?.detail).toContain('channels:history');
    expect(w.calls.filter((c) => c.url.includes('conversations.history'))).toHaveLength(1);
    expect(step(r, 'cleanup: delete D1 row')).toBeDefined();
  });

  it('ingest 401 -> FAIL, nothing to clean up is not an error, Slack search skipped', async () => {
    const w = world({ ingestStatus: 401, deleteStatus: 404 });
    const r = await runE2E(config, w.deps, REF);
    expect(r.ok).toBe(false);
    expect(step(r, 'POST /ingest')?.ok).toBe(false);
    expect(step(r, 'Slack card appeared')?.detail).toMatch(/skipped/);
    expect(step(r, 'cleanup: delete D1 row')?.ok).toBe(true);
    expect(w.calls.some((c) => c.url.includes('conversations.history'))).toBe(false);
    expect(w.calls.some((c) => c.url.endsWith('chat.delete'))).toBe(false);
  });

  it('ingest network error -> FAIL and cleanup is still attempted', async () => {
    const w = world({ networkErrorOn: '/ingest', deleteStatus: 404 });
    const r = await runE2E(config, w.deps, REF);
    expect(r.ok).toBe(false);
    expect(w.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('a row that cannot be deleted after a successful ingest is a FAIL with the ref in the hint', async () => {
    const w = world({ deleteStatus: 500 });
    const r = await runE2E(config, w.deps, REF);
    expect(r.ok).toBe(false);
    expect(step(r, 'cleanup: delete D1 row')?.detail).toContain(REF);
    // Slack cleanup is still attempted with the ts found earlier.
    expect(w.calls.some((c) => c.url.endsWith('chat.delete'))).toBe(true);
  });

  it('a 404 on delete after a successful ingest is a FAIL (the row should exist)', async () => {
    const r = await runE2E(config, world({ deleteStatus: 404 }).deps, REF);
    expect(step(r, 'cleanup: delete D1 row')?.ok).toBe(false);
  });

  it('chat.delete failure is a FAIL naming the ts', async () => {
    const r = await runE2E(config, world({ slackDeleteOk: false }).deps, REF);
    expect(r.ok).toBe(false);
    expect(step(r, 'cleanup: delete Slack message')?.detail).toContain('1700000000.000500');
  });

  it('a delete network error does not throw', async () => {
    const r = await runE2E(config, world({ networkErrorOn: '/admin/' }).deps, REF);
    expect(r.ok).toBe(false);
  });
});

describe('safety', () => {
  it.each(['TOT-1001', 'test-1', 'XTEST-1', 'TEST-', ''])(
    'refuses ref %j before sending anything',
    async (ref) => {
      const w = world();
      const r = await runE2E(config, w.deps, ref);
      expect(r.ok).toBe(false);
      expect(w.calls).toHaveLength(0);
      expect(() => assertTestRef(ref)).toThrow(/refusing/);
      expect(() => makeFakeTender(ref, 0)).toThrow();
    },
  );

  it('refuses a plain-http, non-local or wrong-path ingest URL', async () => {
    for (const ingestUrl of [
      'http://worker.example.com/ingest',
      'https://w.example.com/health',
      'nope',
    ]) {
      const w = world();
      const r = await runE2E({ ...config, ingestUrl }, w.deps, REF);
      expect(r.ok).toBe(false);
      expect(w.calls).toHaveLength(0);
    }
    expect(validateIngestUrl('http://localhost:8787/ingest')).toBeNull();
    expect(validateIngestUrl('https://w.example.com/ingest')).toBeNull();
  });
});

describe('helpers', () => {
  it('makeTestRef + adminDeleteUrl', () => {
    expect(makeTestRef(5)).toBe('TEST-5');
    expect(adminDeleteUrl('https://w.dev/ingest?x=1', 'TEST-5')).toBe(
      'https://w.dev/admin/tenders/TEST-5',
    );
  });
  it('findMessage matches by ref in text or blocks', () => {
    expect(findMessage([{ ts: '1', blocks: [{ value: REF }] }], REF)?.ts).toBe('1');
    expect(findMessage([{ ts: '1', text: 'other' }], REF)).toBeUndefined();
  });
  it('loadConfig reports missing names, never values', () => {
    const bad = loadConfig({ INGEST_SECRET: 's' });
    expect(bad).toEqual({
      ok: false,
      missing: ['E2E_INGEST_URL (or INGEST_URL)', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'],
    });
    const good = loadConfig({
      INGEST_URL: 'https://a/ingest',
      E2E_INGEST_URL: 'https://b/ingest',
      INGEST_SECRET: 's',
      SLACK_BOT_TOKEN: 't',
      SLACK_CHANNEL_ID: 'C1',
    });
    expect(good.ok && good.config.ingestUrl).toBe('https://b/ingest'); // E2E_INGEST_URL wins
  });
});

describe('--dry-run and CLI exit codes', () => {
  const env = {
    INGEST_URL: 'https://w.example.dev/ingest',
    INGEST_SECRET: 'sekrit-1',
    SLACK_BOT_TOKEN: 'xoxb-sekrit-2',
    SLACK_CHANNEL_ID: 'C0TEST',
  };

  it('describePlan lists the steps and prints no secret', () => {
    const plan = describePlan(env, REF);
    const text = plan.lines.join('\n');
    expect(plan.configOk).toBe(true);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('/admin/tenders/TEST-1700000000000');
    expect(text).toContain('conversations.history');
    expect(text).not.toContain('sekrit');
  });

  it('describePlan names missing variables', () => {
    const plan = describePlan({}, REF);
    expect(plan.configOk).toBe(false);
    expect(plan.lines.join('\n')).toContain('SLACK_BOT_TOKEN');
  });

  it('main --dry-run exits 0 and never calls fetch', async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response('{}');
    }) as typeof fetch;
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      expect(await main(['--dry-run'], env)).toBe(0);
      expect(await main(['--dry-run'], {})).toBe(0);
    } finally {
      console.log = log;
      globalThis.fetch = original;
    }
    expect(called).toBe(0);
    expect(out.join('\n')).not.toContain('sekrit');
  });

  it('main without configuration exits 2 and sends nothing', async () => {
    const err = console.error;
    console.error = () => undefined;
    try {
      expect(await main([], {})).toBe(2);
      expect(await main([], { ...env, INGEST_URL: 'http://evil.example/ingest' })).toBe(2);
    } finally {
      console.error = err;
    }
  });
});
