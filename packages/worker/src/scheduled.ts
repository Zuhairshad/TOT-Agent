import { checkScraperHeartbeat } from './cron.js';
import { DAILY_CRON, WATCHDOG_CRON } from './crons.js';
import { runDailyJob } from './daily.js';
import type { Env } from './types.js';

export { DAILY_CRON, WATCHDOG_CRON };

/**
 * One handler, two schedules. Dispatches on controller.cron so each invocation does one job and
 * stays inside the free-plan limits. An unknown cron string does nothing (and says so in the
 * logs) rather than guessing: a stray extra trigger must not spam Slack.
 */
export async function handleScheduled(
  controller: Pick<ScheduledController, 'cron'>,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  switch (controller.cron) {
    case WATCHDOG_CRON:
      ctx.waitUntil(checkScraperHeartbeat(env));
      return;
    case DAILY_CRON:
      ctx.waitUntil(runDailyJob(env));
      return;
    default:
      console.warn(`scheduled: unknown cron "${controller.cron}", nothing run`);
  }
}
