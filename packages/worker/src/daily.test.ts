import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenders, insertTender, stubSlack, type SlackCall } from '../test/helpers.js';
import {
  buildDailySummary,
  collectDailyStats,
  lusakaYesterday,
  MAX_LISTED_CLOSING,
  runDailyJob,
  type DailyStats,
} from './daily.js';
import { DAY_MS } from './days.js';

// 05:00 UTC = 07:00 in Lusaka, Friday 30 Oct 2026. "Yesterday" = Thu 29 Oct, Lusaka time.
const NOW = new Date('2026-10-30T05:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS).toISOString();
let calls: SlackCall[];

beforeEach(() => {
  calls = stubSlack();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTenders();
});

describe('lusakaYesterday', () => {
  it('is the previous Africa/Lusaka calendar day (UTC+2) at the 07:00 run', () => {
    expect(lusakaYesterday(NOW)).toEqual({
      startIso: '2026-10-28T22:00:00.000Z',
      endIso: '2026-10-29T22:00:00.000Z',
      lusakaDate: '2026-10-29',
    });
  });
  it('rolls the window at Lusaka midnight (22:00 UTC), not at UTC midnight', () => {
    expect(lusakaYesterday(new Date('2026-10-29T21:59:59.999Z')).lusakaDate).toBe('2026-10-28');
    expect(lusakaYesterday(new Date('2026-10-29T22:00:00.000Z')).lusakaDate).toBe('2026-10-29');
  });
  it('works across a month and year boundary', () => {
    expect(lusakaYesterday(new Date('2027-01-01T05:00:00.000Z'))).toMatchObject({
      startIso: '2026-12-30T22:00:00.000Z',
      lusakaDate: '2026-12-31',
    });
  });
});

describe('collectDailyStats', () => {
  it('counts new tenders by first_seen_at in the Lusaka day, boundaries [start, end)', async () => {
    await insertTender({ totRef: 'A-1', firstSeenAt: '2026-10-28T21:59:59.999Z' }); // day before
    await insertTender({ totRef: 'A-2', firstSeenAt: '2026-10-28T22:00:00.000Z' }); // start: in
    await insertTender({ totRef: 'A-3', firstSeenAt: '2026-10-29T21:59:59.999Z' }); // in
    await insertTender({ totRef: 'A-4', firstSeenAt: '2026-10-29T22:00:00.000Z' }); // end: out
    expect((await collectDailyStats(env, NOW)).newCount).toBe(2);
  });

  it('counts shortlisted by shortlisted_at, ignoring NULL and other days', async () => {
    await insertTender({
      totRef: 'S-1',
      status: 'shortlisted',
      shortlistedAt: '2026-10-29T10:00:00.000Z',
    });
    await insertTender({
      totRef: 'S-2',
      status: 'shortlisted',
      shortlistedAt: '2026-10-30T01:00:00.000Z',
    });
    await insertTender({ totRef: 'S-3', status: 'shortlisted', shortlistedAt: null });
    await insertTender({ totRef: 'S-4', status: 'new' });
    expect((await collectDailyStats(env, NOW)).shortlistedCount).toBe(1);
  });

  it('lists tenders closing within 7 days, soonest first; not ignored, past or later ones', async () => {
    await insertTender({ totRef: 'C-3', status: 'shortlisted', deadline: inDays(6.9) });
    await insertTender({ totRef: 'C-1', status: 'new', deadline: inDays(1) });
    await insertTender({ totRef: 'C-2', status: 'new', deadline: inDays(2) });
    await insertTender({ totRef: 'X-ignored', status: 'ignored', deadline: inDays(1) });
    await insertTender({ totRef: 'X-past', deadline: inDays(-0.1) });
    await insertTender({ totRef: 'X-far', deadline: inDays(7.1) });
    await insertTender({ totRef: 'X-none', deadline: null });
    const stats = await collectDailyStats(env, NOW);
    expect(stats.closing.map((t) => t.tot_ref)).toEqual(['C-1', 'C-2', 'C-3']);
    expect(stats.closingCount).toBe(3);
  });

  it('handles deadlines stored without milliseconds', async () => {
    await insertTender({ totRef: 'C-1', deadline: '2026-11-02T10:00:00Z' });
    expect((await collectDailyStats(env, NOW)).closingCount).toBe(1);
  });
});

describe('buildDailySummary', () => {
  const stats = (over: Partial<DailyStats> = {}): DailyStats => ({
    window: lusakaYesterday(NOW),
    newCount: 4,
    shortlistedCount: 1,
    closingCount: 0,
    closing: [],
    ...over,
  });
  const closing = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      tot_ref: `C-${i}`,
      title: `Tender <${i}> & co`,
      url: `https://example.com/${i}`,
      deadline: '2026-11-02T10:00:00.000Z',
    }));

  it('has the headline with X / Y / Z', () => {
    const msg = buildDailySummary(stats({ closingCount: 2, closing: closing(2) }));
    expect(msg.text).toBe('Yesterday: 4 new tenders, 1 shortlisted, 2 closing in the next 7 days');
  });
  it('uses the singular for one new tender and omits the list when nothing closes', () => {
    const msg = buildDailySummary(stats({ newCount: 1 }));
    expect(msg.text).toContain('1 new tender,');
    expect(msg.blocks).toHaveLength(1);
  });
  it('lists linked titles with the deadline, escaped, capped with "+N more"', () => {
    const msg = buildDailySummary(stats({ closingCount: 14, closing: closing(14) }));
    const list = JSON.stringify(msg.blocks[1]);
    expect(list).toContain('<https://example.com/0|Tender &lt;0&gt; &amp; co>');
    expect(list).toContain('deadline 2026-11-02');
    expect(list.match(/https:\/\/example\.com\//g)).toHaveLength(MAX_LISTED_CLOSING);
    expect(list).toContain('+4 more');
  });
  it('shows no "+N more" when the list fits', () => {
    const msg = buildDailySummary(stats({ closingCount: 10, closing: closing(10) }));
    expect(JSON.stringify(msg.blocks)).not.toContain('more');
  });
});

describe('runDailyJob', () => {
  it('posts the summary, then the reminders, in the right places', async () => {
    await insertTender({
      totRef: 'T-1',
      status: 'shortlisted',
      deadline: inDays(5),
      firstSeenAt: '2026-10-29T08:00:00.000Z',
      shortlistedAt: '2026-10-29T09:00:00.000Z',
      slackTs: '1700000000.000009',
    });
    await runDailyJob(env, NOW);
    const posts = calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body.text).toBe(
      'Yesterday: 1 new tender, 1 shortlisted, 1 closing in the next 7 days',
    );
    expect(posts[0]?.body.thread_ts).toBeUndefined();
    expect(posts[1]?.body.thread_ts).toBe('1700000000.000009');
    // Running the job again re-posts the summary (it is a daily message) but not the reminder.
    await runDailyJob(env, NOW);
    expect(calls.filter((c) => c.body.thread_ts)).toHaveLength(1);
  });

  it('still sends reminders when the summary cannot be posted, and never throws', async () => {
    await insertTender({ totRef: 'T-1', status: 'shortlisted', deadline: inDays(5) });
    let n = 0;
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return n++ === 0
          ? Response.json({ ok: false, error: 'internal_error' })
          : Response.json({ ok: true, ts: '1.2' });
      }),
    );
    await expect(runDailyJob(env, NOW)).resolves.toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.thread_ts).toBeDefined();
  });
});
