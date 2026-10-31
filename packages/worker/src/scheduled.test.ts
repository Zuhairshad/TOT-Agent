import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { clearTenders, stubSlack, type SlackCall } from '../test/helpers.js';
import { DAILY_CRON, handleScheduled, WATCHDOG_CRON } from './scheduled.js';

let calls: SlackCall[];

/** Runs worker.scheduled like Cloudflare does and waits for everything in waitUntil. */
async function fire(cron: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  await worker.scheduled?.(
    { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
    env,
    ctx,
  );
  await Promise.all(pending);
}

beforeEach(() => {
  calls = stubSlack();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearTenders();
});

describe('scheduled() dispatch', () => {
  it('"0 */3 * * *" runs only the watchdog', async () => {
    await fire(WATCHDOG_CRON);
    expect(calls.map((c) => c.body.text)).toEqual(["Scraper hasn't reported in 3 hours"]);
  });

  it('"0 5 * * *" runs only the daily job', async () => {
    await fire(DAILY_CRON);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.body.text)).toMatch(/^Yesterday: 0 new tenders, 0 shortlisted/);
  });

  it('the cron strings are the documented ones (wrangler.toml is checked in node-tests)', () => {
    expect([WATCHDOG_CRON, DAILY_CRON]).toEqual(['0 */3 * * *', '0 5 * * *']);
  });

  it('an unknown cron runs nothing and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fire('*/5 * * * *');
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('*/5 * * * *'));
  });

  it('handleScheduled routes through the injected ctx', async () => {
    const waited: Promise<unknown>[] = [];
    await handleScheduled({ cron: DAILY_CRON }, env, { waitUntil: (p) => void waited.push(p) });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });
});
