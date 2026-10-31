import { postAlert } from './notify.js';
import type { Env } from './types.js';

export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/** Cron watchdog: alert when no run was logged in the last 3 hours. */
export async function checkScraperHeartbeat(env: Env, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?')
    .bind(since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return false;
  await postAlert(env, "Scraper hasn't reported in 3 hours");
  return true;
}
