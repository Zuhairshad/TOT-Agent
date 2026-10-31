import { escapeMrkdwn, formatDeadline } from './blocks.js';
import { DAY_MS } from './days.js';
import { postMessage, postInterval, sleep } from './slack.js';
import type { Env } from './types.js';

export type ReminderKind = '7d' | '2d';

/**
 * Hard cap of reminders per daily run. Free plan = 50 subrequests per invocation. Each reminder
 * costs 2 (claim row + Slack post), 3 when the claim is released after a failed post, and a
 * Slack 429 retry can add 1 more: 10 x 4 = 40, plus the summary (2) and the candidate query (1).
 * Reminders over the cap stay unsent and are picked up by the next run while they are still
 * inside their window.
 */
export const MAX_REMINDERS_PER_RUN = 10;

/**
 * Windows are on the exact time left (deadline - now), and DISJOINT, so a tender shortlisted
 * late only ever gets the most urgent reminder:
 *   2d: 0 < left <= 2 days          7d: 2 days < left <= 7 days
 * With a daily cron each tender passes through the 7d window on exactly one run (6-7 days
 * before the deadline) and the 2d window on one or two runs; the tender_reminders primary key
 * makes the send at-most-once.
 */
export function dueReminderKind(deadline: string | null, now: Date): ReminderKind | null {
  if (!deadline) return null;
  const left = Date.parse(deadline) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return null;
  if (left <= 2 * DAY_MS) return '2d';
  if (left <= 7 * DAY_MS) return '7d';
  return null;
}

interface Candidate {
  tot_ref: string;
  title: string;
  url: string;
  deadline: string;
  slack_ts: string;
  sent: string | null; // comma-separated kinds already sent
}

export function buildReminderText(
  kind: ReminderKind,
  c: Pick<Candidate, 'title' | 'url' | 'deadline'>,
  now: Date,
): string {
  const lead = kind === '2d' ? 'Deadline in 2 days or less' : 'Deadline within 7 days';
  return `Reminder: ${lead}. <${c.url}|${escapeMrkdwn(c.title)}> closes ${formatDeadline(c.deadline, now)}.`;
}

/**
 * Posts "7 days" / "2 days" reminders in the thread of shortlisted tenders. Idempotent: a row
 * is claimed in tender_reminders (INSERT OR IGNORE) BEFORE posting, so repeated or concurrent
 * runs cannot double-send; if the post fails the claim is released so the next run retries.
 * Returns how many reminders were posted.
 */
export async function sendDeadlineReminders(env: Env, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const horizonIso = new Date(now.getTime() + 8 * DAY_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT t.tot_ref, t.title, t.url, t.deadline, t.slack_ts,
            (SELECT group_concat(kind) FROM tender_reminders r WHERE r.tot_ref = t.tot_ref) AS sent
     FROM tenders t
     WHERE t.status = 'shortlisted' AND t.slack_ts IS NOT NULL AND t.deadline IS NOT NULL
       AND julianday(t.deadline) > julianday(?) - 1 AND julianday(t.deadline) < julianday(?)
     ORDER BY julianday(t.deadline)`,
  )
    .bind(nowIso, horizonIso)
    .all<Candidate>();

  const interval = postInterval(env);
  let posted = 0;
  for (const c of rows.results) {
    if (posted >= MAX_REMINDERS_PER_RUN) break;
    const kind = dueReminderKind(c.deadline, now);
    if (!kind || (c.sent ?? '').split(',').includes(kind)) continue;

    const claim = await env.DB.prepare(
      'INSERT OR IGNORE INTO tender_reminders (tot_ref, kind, sent_at) VALUES (?, ?, ?)',
    )
      .bind(c.tot_ref, kind, nowIso)
      .run();
    if (claim.meta.changes === 0) continue; // someone else sent it meanwhile

    if (posted > 0 && interval > 0) await sleep(interval);
    try {
      await postMessage(
        env,
        { text: buildReminderText(kind, c, now) },
        { channel: env.SLACK_CHANNEL_ID, threadTs: c.slack_ts },
      );
      posted++;
    } catch (err) {
      console.error(`reminder ${kind} for ${c.tot_ref} failed`, err);
      await env.DB.prepare('DELETE FROM tender_reminders WHERE tot_ref = ? AND kind = ?')
        .bind(c.tot_ref, kind)
        .run();
      posted++; // a failed attempt still used subrequests: count it against the cap
    }
  }
  return posted;
}
