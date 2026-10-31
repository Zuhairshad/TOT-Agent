import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenders, insertTender, stubSlack, type SlackCall } from '../test/helpers.js';
import { DAY_MS } from './days.js';
import { dueReminderKind, MAX_REMINDERS_PER_RUN, sendDeadlineReminders } from './reminders.js';

const NOW = new Date('2026-10-30T05:00:00.000Z');
const inDays = (d: number, from = NOW) => new Date(from.getTime() + d * DAY_MS).toISOString();
let calls: SlackCall[];
const posts = () => calls.filter((c) => c.method === 'chat.postMessage');
const rows = async () =>
  (await env.DB.prepare('SELECT tot_ref, kind FROM tender_reminders ORDER BY tot_ref, kind').all())
    .results;

beforeEach(() => {
  calls = stubSlack();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTenders();
});

describe('dueReminderKind (window boundaries)', () => {
  it.each([
    [8, null],
    [7.0001, null],
    [7, '7d'],
    [3, '7d'],
    [2.0001, '7d'],
    [2, '2d'],
    [0.5, '2d'],
    [0, null],
    [-1, null],
  ])('%s days left -> %s', (days, kind) => {
    expect(dueReminderKind(inDays(days), NOW)).toBe(kind);
  });
  it('is null without a deadline or with garbage', () => {
    expect(dueReminderKind(null, NOW)).toBeNull();
    expect(dueReminderKind('not a date', NOW)).toBeNull();
  });
});

describe('sendDeadlineReminders', () => {
  it('sends the 7-day reminder once, in the tender thread', async () => {
    await insertTender({
      totRef: 'T-1',
      status: 'shortlisted',
      deadline: inDays(6.5),
      slackTs: '1700000000.000042',
    });
    expect(await sendDeadlineReminders(env, NOW)).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({ channel: 'C123', thread_ts: '1700000000.000042' });
    expect(String(posts()[0]?.body.text)).toContain('Reminder');
    expect(String(posts()[0]?.body.text)).toContain('https://example.com/T-1');
    expect(await rows()).toEqual([{ tot_ref: 'T-1', kind: '7d' }]);
  });

  it('does not resend when the cron runs again (even many times, or concurrently)', async () => {
    await insertTender({ totRef: 'T-1', status: 'shortlisted', deadline: inDays(5) });
    await sendDeadlineReminders(env, NOW);
    await sendDeadlineReminders(env, new Date(NOW.getTime() + 3600_000));
    await Promise.all([
      sendDeadlineReminders(env, new Date(NOW.getTime() + 7200_000)),
      sendDeadlineReminders(env, new Date(NOW.getTime() + 7200_000)),
    ]);
    expect(posts()).toHaveLength(1);
  });

  it('sends the 2-day reminder later, once, after the 7-day one', async () => {
    await insertTender({ totRef: 'T-1', status: 'shortlisted', deadline: inDays(6.5) });
    await sendDeadlineReminders(env, NOW);
    const later = new Date(NOW.getTime() + 5 * DAY_MS); // 1.5 days left
    await sendDeadlineReminders(env, later);
    await sendDeadlineReminders(env, new Date(later.getTime() + DAY_MS * 0.4));
    expect(posts()).toHaveLength(2);
    expect(await rows()).toEqual([
      { tot_ref: 'T-1', kind: '2d' },
      { tot_ref: 'T-1', kind: '7d' },
    ]);
  });

  it('skips tenders that are not shortlisted', async () => {
    await insertTender({ totRef: 'T-1', status: 'new', deadline: inDays(5) });
    await insertTender({ totRef: 'T-2', status: 'ignored', deadline: inDays(5) });
    expect(await sendDeadlineReminders(env, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('skips past deadlines, missing deadlines, far deadlines and tenders without a thread', async () => {
    await insertTender({ totRef: 'T-1', status: 'shortlisted', deadline: inDays(-1) });
    await insertTender({ totRef: 'T-2', status: 'shortlisted', deadline: null });
    await insertTender({ totRef: 'T-3', status: 'shortlisted', deadline: inDays(20) });
    await insertTender({
      totRef: 'T-4',
      status: 'shortlisted',
      deadline: inDays(5),
      slackTs: null,
    });
    expect(await sendDeadlineReminders(env, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('late shortlist: with both windows open only the most urgent reminder is sent', async () => {
    // Shortlisted with 1.5 days left: inside the 7-day AND the 2-day horizon.
    await insertTender({
      totRef: 'T-1',
      status: 'shortlisted',
      deadline: inDays(1.5),
      shortlistedAt: NOW.toISOString(),
    });
    await sendDeadlineReminders(env, NOW);
    await sendDeadlineReminders(env, new Date(NOW.getTime() + DAY_MS * 0.5));
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0]?.body.text)).toContain('2 days or less');
    expect(await rows()).toEqual([{ tot_ref: 'T-1', kind: '2d' }]);
  });

  it('releases the claim when Slack fails so the next run retries', async () => {
    await insertTender({ totRef: 'T-1', status: 'shortlisted', deadline: inDays(5) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, error: 'channel_not_found' })),
    );
    expect(await sendDeadlineReminders(env, NOW)).toBe(1); // attempted (counts toward the cap)
    expect(await rows()).toEqual([]);
    const ok = stubSlack();
    await sendDeadlineReminders(env, NOW);
    expect(ok.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(await rows()).toEqual([{ tot_ref: 'T-1', kind: '7d' }]);
  });

  it('caps the number of reminders per run (free-plan subrequest limit), soonest first', async () => {
    const n = MAX_REMINDERS_PER_RUN + 5;
    for (let i = 1; i <= n; i++) {
      await insertTender({
        totRef: `T-${i}`,
        status: 'shortlisted',
        deadline: inDays(3 + i / 100),
      });
    }
    expect(await sendDeadlineReminders(env, NOW)).toBe(MAX_REMINDERS_PER_RUN);
    expect(posts()).toHaveLength(MAX_REMINDERS_PER_RUN);
    // The next run picks up the rest, without repeating the first ones.
    expect(await sendDeadlineReminders(env, NOW)).toBe(5);
    expect((await rows()).length).toBe(n);
    expect(posts()).toHaveLength(n);
  });
});
