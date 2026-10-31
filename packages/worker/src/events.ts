import { verifySlackSignature } from './auth.js';
import { onTenderDocumentUploaded } from './document-hook.js';
import { postMessage } from './slack.js';
import type { Env, TenderRow } from './types.js';

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  files?: Array<{ id: string }>;
}

interface EventBody {
  type: string;
  challenge?: string;
  event?: SlackEvent;
}

export const ACK_TEXT = 'Got it, reading the document...';

/** Handles a file uploaded in a thread; ignores anything that is not a shortlisted tender's thread. */
export async function processEvent(env: Env, event: SlackEvent): Promise<void> {
  if (event.type !== 'message' || event.bot_id || event.subtype === 'bot_message') return;
  const files = event.files ?? [];
  if (files.length === 0 && event.subtype !== 'file_share') return;
  if (!event.thread_ts || !event.channel || event.channel !== env.SLACK_CHANNEL_ID) return;

  const tender = await env.DB.prepare(
    "SELECT * FROM tenders WHERE slack_ts = ? AND status = 'shortlisted'",
  )
    .bind(event.thread_ts)
    .first<TenderRow>();
  if (!tender) return;

  // INSERT OR IGNORE makes Slack's event retries harmless.
  const uploadedAt = new Date().toISOString();
  const fresh: string[] = [];
  for (const f of files) {
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO tender_files (file_id, tot_ref, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?)',
    )
      .bind(f.id, tender.tot_ref, event.user ?? null, uploadedAt)
      .run();
    if (res.meta.changes > 0) fresh.push(f.id);
  }
  if (fresh.length === 0) return;

  await postMessage(env, { text: ACK_TEXT }, { channel: event.channel, threadTs: event.thread_ts });
  for (const fileId of fresh) {
    try {
      await onTenderDocumentUploaded(env, tender, fileId);
    } catch (err) {
      console.error(`onTenderDocumentUploaded failed for ${fileId}`, err);
    }
  }
}

export async function handleEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET))) {
    return new Response('invalid signature', { status: 401 });
  }
  let body: EventBody;
  try {
    body = JSON.parse(rawBody) as EventBody;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (body.type === 'url_verification') {
    return Response.json({ challenge: body.challenge });
  }
  if (body.type === 'event_callback' && body.event) {
    const event = body.event;
    ctx.waitUntil(processEvent(env, event).catch((err) => console.error('event failed', err)));
  }
  return new Response(null, { status: 200 });
}
