import { verifySlackSignature } from './auth.js';
import { buildIgnoredMessage, buildShortlistedBlocks, escapeMrkdwn } from './blocks.js';
import { postMessage, updateMessage } from './slack.js';
import type { Env } from './types.js';

type Block = Record<string, unknown>;

interface BlockActionsPayload {
  type: string;
  user?: { id: string };
  channel?: { id: string };
  message?: { ts: string; blocks?: Block[] };
  actions?: Array<{ action_id: string; value?: string }>;
}

export const SHORTLIST_THREAD_TEXT =
  "Download the tender document from TendersOnTime with the Yesbike account and upload it here. I'll read it and make the PDF.";

/** Does the real work for one button click. Runs in ctx.waitUntil. */
export async function processAction(env: Env, payload: BlockActionsPayload): Promise<void> {
  const action = payload.actions?.[0];
  const totRef = action?.value;
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  const userId = payload.user?.id;
  if (!action || !totRef || !channel || !ts || !userId) return;

  if (action.action_id === 'shortlist') {
    // Only act on the first click: Slack can redeliver, and people double-click.
    const res = await env.DB.prepare(
      "UPDATE tenders SET status = 'shortlisted', shortlisted_at = ? WHERE tot_ref = ? AND status != 'shortlisted'",
    )
      .bind(new Date().toISOString(), totRef)
      .run();
    if (res.meta.changes === 0) return;
    const original = payload.message?.blocks ?? [];
    const blocks = buildShortlistedBlocks(original, userId);
    await updateMessage(env, channel, ts, { text: `Shortlisted by <@${userId}>`, blocks });
    await postMessage(env, { text: SHORTLIST_THREAD_TEXT }, { channel, threadTs: ts });
  } else if (action.action_id === 'ignore') {
    await env.DB.prepare("UPDATE tenders SET status = 'ignored' WHERE tot_ref = ?")
      .bind(totRef)
      .run();
    const row = await env.DB.prepare('SELECT title, url FROM tenders WHERE tot_ref = ?')
      .bind(totRef)
      .first<{ title: string; url: string }>();
    const msg = buildIgnoredMessage(row?.title ?? escapeMrkdwn(totRef), row?.url ?? '', userId);
    await updateMessage(env, channel, ts, msg);
  }
}

export async function handleInteractions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET))) {
    return new Response('invalid signature', { status: 401 });
  }
  // Slack sends application/x-www-form-urlencoded with a JSON `payload` field.
  const payloadText = new URLSearchParams(rawBody).get('payload');
  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(payloadText ?? '') as BlockActionsPayload;
  } catch {
    return new Response('bad payload', { status: 400 });
  }
  if (payload.type === 'block_actions') {
    ctx.waitUntil(
      processAction(env, payload).catch((err) => console.error('interaction failed', err)),
    );
  }
  return new Response(null, { status: 200 });
}
