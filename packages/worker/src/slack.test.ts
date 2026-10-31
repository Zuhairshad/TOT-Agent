import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postInterval, postMessage, slackApi, SlackError, slackFormApi } from './slack.js';

afterEach(() => vi.unstubAllGlobals());

describe('slackApi', () => {
  it('sends the bot token as a Bearer header and returns the data', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, ts: '1.2' }));
    vi.stubGlobal('fetch', fetchMock);
    const ts = await postMessage(env, { text: 'hi' }, { threadTs: '9.9' });
    expect(ts).toBe('1.2');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
    expect(JSON.parse(String(init.body))).toEqual({
      channel: 'C123',
      text: 'hi',
      thread_ts: '9.9',
    });
  });

  it('throws SlackError with the Slack error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, error: 'not_in_channel' })),
    );
    await expect(slackApi(env, 'chat.postMessage', {})).rejects.toMatchObject({
      code: 'not_in_channel',
      method: 'chat.postMessage',
    });
    await expect(slackApi(env, 'x', {})).rejects.toBeInstanceOf(SlackError);
  });

  it('retries once after HTTP 429 and then succeeds', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      n++ === 0
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true, ts: '5.5' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const t0 = Date.now();
    await expect(slackApi(env, 'chat.postMessage', {})).resolves.toMatchObject({ ts: '5.5' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeLessThan(3000); // Retry-After 0 falls back to 1 s, never more
  });
});

describe('slackFormApi', () => {
  it('posts form-encoded params', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, file: { id: 'F1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await slackFormApi(env, 'files.info', { file: 'F1' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('file=F1');
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('x-www-form');
  });
});

describe('postInterval', () => {
  it('defaults to 1100 ms and honours a valid override', () => {
    expect(postInterval({ ...env, SLACK_POST_INTERVAL_MS: undefined })).toBe(1100);
    expect(postInterval({ ...env, SLACK_POST_INTERVAL_MS: '0' })).toBe(0);
    expect(postInterval({ ...env, SLACK_POST_INTERVAL_MS: '250' })).toBe(250);
    expect(postInterval({ ...env, SLACK_POST_INTERVAL_MS: 'abc' })).toBe(1100);
    expect(postInterval({ ...env, SLACK_POST_INTERVAL_MS: '-5' })).toBe(1100);
  });
});
