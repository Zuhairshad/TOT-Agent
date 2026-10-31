import { escapeMrkdwn, type SlackMessage } from './blocks.js';
import { DAY_MS } from './days.js';
import { sendDeadlineReminders } from './reminders.js';
import { postMessage } from './slack.js';
import type { Env } from './types.js';

/** Africa/Lusaka is UTC+2 all year (Zambia has no daylight saving time). */
export const LUSAKA_OFFSET_MS = 2 * 3_600_000;

/** How many closing-soon tenders the daily summary lists before "+N more". */
export const MAX_LISTED_CLOSING = 10;
/** "Closing soon" means a deadline in the next 7 days (from the moment the job runs). */
export const CLOSING_WINDOW_DAYS = 7;

export interface DayWindow {
  /** Inclusive, ISO 8601 UTC. */
  startIso: string;
  /** Exclusive, ISO 8601 UTC. */
  endIso: string;
  /** The Lusaka calendar date being summarised, YYYY-MM-DD. */
  lusakaDate: string;
}

/**
 * "Yesterday" = the previous Africa/Lusaka calendar day: [00:00, 24:00) Lusaka time, which is
 * [22:00 UTC two days ago, 22:00 UTC yesterday). The job runs at 07:00 Lusaka (05:00 UTC), so
 * "today so far" is never mixed in. Not the UTC day: a tender seen at 23:30 Lusaka time belongs
 * to the Lusaka day the team experienced.
 */
export function lusakaYesterday(now: Date): DayWindow {
  const lusakaNow = now.getTime() + LUSAKA_OFFSET_MS;
  const todayStartLusaka = Math.floor(lusakaNow / DAY_MS) * DAY_MS; // in "Lusaka-shifted" ms
  const start = todayStartLusaka - DAY_MS - LUSAKA_OFFSET_MS;
  const end = todayStartLusaka - LUSAKA_OFFSET_MS;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    lusakaDate: new Date(start + LUSAKA_OFFSET_MS).toISOString().slice(0, 10),
  };
}

export interface ClosingTender {
  tot_ref: string;
  title: string;
  url: string;
  deadline: string;
}

export interface DailyStats {
  window: DayWindow;
  newCount: number;
  shortlistedCount: number;
  closingCount: number;
  closing: ClosingTender[];
}

/**
 * Collects the numbers. Counts use ISO strings written by this Worker (first_seen_at,
 * shortlisted_at), so string comparison is exact. Deadlines come from the scraper in whatever
 * ISO form it sent, so they are range-filtered coarsely in SQL and exactly in JS.
 * Ignored tenders are not "closing soon" (nobody wants a reminder about them).
 * All three reads go out as ONE D1 batch (one subrequest).
 */
export async function collectDailyStats(env: Env, now: Date): Promise<DailyStats> {
  const window = lusakaYesterday(now);
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + CLOSING_WINDOW_DAYS * DAY_MS).toISOString();
  const [newRes, shortRes, closingRes] = await env.DB.batch([
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM tenders WHERE first_seen_at >= ? AND first_seen_at < ?',
    ).bind(window.startIso, window.endIso),
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM tenders WHERE shortlisted_at >= ? AND shortlisted_at < ?',
    ).bind(window.startIso, window.endIso),
    env.DB.prepare(
      `SELECT tot_ref, title, url, deadline FROM tenders
       WHERE status != 'ignored' AND deadline IS NOT NULL
         AND julianday(deadline) > julianday(?) - 1 AND julianday(deadline) < julianday(?) + 1
       ORDER BY julianday(deadline)`,
    ).bind(nowIso, horizon),
  ]);
  const nowMs = now.getTime();
  const horizonMs = nowMs + CLOSING_WINDOW_DAYS * DAY_MS;
  const closing = ((closingRes?.results ?? []) as unknown as ClosingTender[]).filter((t) => {
    const ms = Date.parse(t.deadline);
    return ms > nowMs && ms <= horizonMs;
  });
  return {
    window,
    newCount: (newRes?.results[0] as { n: number } | undefined)?.n ?? 0,
    shortlistedCount: (shortRes?.results[0] as { n: number } | undefined)?.n ?? 0,
    closingCount: closing.length,
    closing,
  };
}

export function buildDailySummary(stats: DailyStats): SlackMessage {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const headline =
    `Yesterday: ${plural(stats.newCount, 'new tender', 'new tenders')}, ` +
    `${stats.shortlistedCount} shortlisted, ` +
    `${stats.closingCount} closing in the next ${CLOSING_WINDOW_DAYS} days`;
  const blocks: SlackMessage['blocks'] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${headline}*` } },
  ];
  if (stats.closing.length > 0) {
    const shown = stats.closing.slice(0, MAX_LISTED_CLOSING);
    const lines = shown.map(
      (t) => `• <${t.url}|${escapeMrkdwn(t.title)}> (deadline ${t.deadline.slice(0, 10)})`,
    );
    const extra = stats.closing.length - shown.length;
    if (extra > 0) lines.push(`+${extra} more`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }
  return { text: headline, blocks };
}

/**
 * The 07:00 Zambia-time job: one summary post, then the deadline reminders. Each part is
 * isolated, so a Slack or D1 failure in one does not stop the other. Never throws.
 *
 * Subrequest budget (free plan: 50 per invocation): summary = 1 D1 batch + 1 Slack post;
 * reminders are capped (see MAX_REMINDERS_PER_RUN), so the whole job stays well below 50.
 */
export async function runDailyJob(env: Env, now = new Date()): Promise<void> {
  try {
    const stats = await collectDailyStats(env, now);
    await postMessage(env, buildDailySummary(stats));
  } catch (err) {
    console.error('daily summary failed', err);
  }
  try {
    await sendDeadlineReminders(env, now);
  } catch (err) {
    console.error('deadline reminders failed', err);
  }
}
