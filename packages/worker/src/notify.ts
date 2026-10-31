import { buildSummaryMessage, buildTenderMessage } from './blocks.js';
import { postMessage, postInterval, sleep } from './slack.js';
import { timed } from './timing.js';
import type { Env, TenderRow } from './types.js';

/** Max tender messages per run; the rest are summarised as "+N more". */
export const MAX_MESSAGES_PER_RUN = 15;

/** Soonest deadline first; tenders without a deadline go last. */
export function sortByDeadline<T extends { deadline: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.deadline === b.deadline) return 0;
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  });
}

/**
 * Posts new tenders to Slack, one per ~second, soonest deadline first, and
 * stores each message ts. Slack failures for one tender are logged and skipped
 * so one bad post does not lose the rest.
 */
export async function postNewTenders(env: Env, rows: TenderRow[], now = new Date()): Promise<void> {
  const sorted = sortByDeadline(rows);
  const toPost = sorted.slice(0, MAX_MESSAGES_PER_RUN);
  const interval = postInterval(env);
  let first = true;
  for (const row of toPost) {
    if (!first && interval > 0) await sleep(interval);
    first = false;
    try {
      const ts = await timed('slack.postMessage', () =>
        postMessage(env, buildTenderMessage(row, now)),
      );
      await env.DB.prepare('UPDATE tenders SET slack_ts = ? WHERE tot_ref = ?')
        .bind(ts, row.tot_ref)
        .run();
    } catch (err) {
      console.error(`Failed to post tender ${row.tot_ref}`, err);
    }
  }
  const extra = sorted.length - toPost.length;
  if (extra > 0) {
    if (interval > 0) await sleep(interval);
    try {
      await postMessage(env, buildSummaryMessage(extra, toPost.length));
    } catch (err) {
      console.error('Failed to post summary', err);
    }
  }
}

/** Plain-text alert to the tender channel. Never throws. */
export async function postAlert(env: Env, text: string): Promise<void> {
  try {
    await postMessage(env, { text });
  } catch (err) {
    console.error('Failed to post alert', err);
  }
}
