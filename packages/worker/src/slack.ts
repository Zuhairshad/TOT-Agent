import type { SlackMessage } from './blocks.js';
import type { Env } from './types.js';

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls a Slack Web API method with a JSON body. Retries once on HTTP 429,
 * honouring Retry-After (capped at 10 s so we stay inside waitUntil's budget).
 */
export async function slackApi<T extends Record<string, unknown>>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '1') || 1, 10);
      await sleep(wait * 1000);
      continue;
    }
    const data = (await res.json()) as T & { ok: boolean; error?: string };
    if (!data.ok) throw new SlackError(method, data.error ?? `http_${res.status}`);
    return data;
  }
}

/** Same as slackApi but form-encoded: files.getUploadURLExternal and files.info need this. */
export async function slackFormApi<T extends Record<string, unknown>>(
  env: Env,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) throw new SlackError(method, data.error ?? `http_${res.status}`);
  return data;
}

/** chat.postMessage into the configured channel (or a thread). Returns the message ts. */
export async function postMessage(
  env: Env,
  message: SlackMessage | { text: string },
  opts: { channel?: string; threadTs?: string } = {},
): Promise<string> {
  const data = await slackApi<{ ts: string }>(env, 'chat.postMessage', {
    channel: opts.channel ?? env.SLACK_CHANNEL_ID,
    ...message,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  });
  return data.ts;
}

export async function updateMessage(
  env: Env,
  channel: string,
  ts: string,
  message: SlackMessage,
): Promise<void> {
  await slackApi(env, 'chat.update', { channel, ts, ...message });
}

/** Pause between posts to respect Slack's ~1 message/second/channel limit. */
export function postInterval(env: Env): number {
  const n = Number(env.SLACK_POST_INTERVAL_MS);
  return env.SLACK_POST_INTERVAL_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : 1100;
}
