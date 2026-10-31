import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSlackBody } from './auth.js';
import { buildTenderMessage } from './blocks.js';
import { SHORTLIST_THREAD_TEXT } from './interactions.js';
import { call, stubSlack, type SlackCall } from '../test/helpers.js';
import { sampleRow } from '../test/fixtures.js';

const TS = '1700000000.000001';
let calls: SlackCall[];

beforeEach(async () => {
  calls = stubSlack();
  await env.DB.prepare(
    `INSERT INTO tenders (tot_ref, title, country, posted_at, url, first_seen_at, slack_ts)
     VALUES ('TOT-1001', 'Sample', 'Kenya', '2026-10-20T00:00:00.000Z', 'https://example.com/1', '2026-10-30T00:00:00.000Z', ?)`,
  )
    .bind(TS)
    .run();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tender_files'),
    env.DB.prepare('DELETE FROM tenders'),
  ]);
});

async function signed(
  path: string,
  body: string,
  opts: { secret?: string; ts?: number; contentType: string },
) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = await signSlackBody(opts.secret ?? env.SLACK_SIGNING_SECRET, ts, body);
  return new Request(`https://w.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': opts.contentType,
      'X-Slack-Signature': sig,
      'X-Slack-Request-Timestamp': String(ts),
    },
    body,
  });
}

const form = (action: 'shortlist' | 'ignore') =>
  'payload=' +
  encodeURIComponent(
    JSON.stringify({
      type: 'block_actions',
      user: { id: 'U42' },
      channel: { id: 'C123' },
      message: { ts: TS, blocks: buildTenderMessage(sampleRow, new Date()).blocks },
      actions: [{ action_id: action, value: 'TOT-1001' }],
    }),
  );
const status = async () =>
  (await env.DB.prepare("SELECT status FROM tenders WHERE tot_ref = 'TOT-1001'").first<{
    status: string;
  }>())!.status;

describe('POST /slack/interactions', () => {
  const ct = 'application/x-www-form-urlencoded';

  it('401 for a wrong signature and for an old timestamp', async () => {
    expect(
      (
        await call(
          await signed('/slack/interactions', form('shortlist'), {
            secret: 'bad',
            contentType: ct,
          }),
        )
      ).status,
    ).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 400;
    expect(
      (
        await call(
          await signed('/slack/interactions', form('shortlist'), { ts: old, contentType: ct }),
        )
      ).status,
    ).toBe(401);
    expect(await status()).toBe('new');
    expect(calls).toHaveLength(0);
  });

  it('Shortlist updates D1, edits the message and posts in its thread', async () => {
    const res = await call(
      await signed('/slack/interactions', form('shortlist'), { contentType: ct }),
    );
    expect(res.status).toBe(200);
    expect(await status()).toBe('shortlisted');
    const stamp = await env.DB.prepare(
      "SELECT shortlisted_at FROM tenders WHERE tot_ref = 'TOT-1001'",
    ).first<{ shortlisted_at: string }>();
    expect(Date.now() - Date.parse(stamp!.shortlisted_at)).toBeLessThan(60_000);
    const update = calls.find((c) => c.method === 'chat.update')!;
    expect(update.body).toMatchObject({ channel: 'C123', ts: TS });
    expect(JSON.stringify(update.body.blocks)).toContain('Shortlisted by <@U42>');
    expect(JSON.stringify(update.body.blocks)).not.toContain('"actions"');
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.body).toMatchObject({
      channel: 'C123',
      thread_ts: TS,
      text: SHORTLIST_THREAD_TEXT,
    });
  });

  it('a repeated Shortlist click does not post twice', async () => {
    await call(await signed('/slack/interactions', form('shortlist'), { contentType: ct }));
    const stampOf = async () =>
      (await env.DB.prepare("SELECT shortlisted_at FROM tenders WHERE tot_ref = 'TOT-1001'").first<{
        shortlisted_at: string;
      }>())!.shortlisted_at;
    const first = await stampOf();
    await new Promise((r) => setTimeout(r, 5));
    await call(await signed('/slack/interactions', form('shortlist'), { contentType: ct }));
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(await stampOf()).toBe(first); // the first click's timestamp is kept
  });

  it('Ignore updates D1 and shrinks the message to one line', async () => {
    await call(await signed('/slack/interactions', form('ignore'), { contentType: ct }));
    expect(await status()).toBe('ignored');
    const stamp = await env.DB.prepare(
      "SELECT shortlisted_at FROM tenders WHERE tot_ref = 'TOT-1001'",
    ).first<{ shortlisted_at: string | null }>();
    expect(stamp?.shortlisted_at).toBeNull();
    expect(calls).toHaveLength(1);
    const update = calls[0]!;
    expect(update.method).toBe('chat.update');
    expect(update.body.blocks).toHaveLength(1);
    expect(JSON.stringify(update.body.blocks)).toContain('ignored by <@U42>');
  });
});

describe('POST /slack/events', () => {
  const ct = 'application/json';
  const fileEvent = (threadTs: string | undefined, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U42',
        channel: 'C123',
        ts: '1700000001.000000',
        thread_ts: threadTs,
        files: [{ id: 'F001' }],
        ...extra,
      },
    });
  const files = async () =>
    (await env.DB.prepare('SELECT file_id, tot_ref FROM tender_files').all()).results;

  it('answers url_verification (signed) and rejects bad signatures', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const res = await call(await signed('/slack/events', body, { contentType: ct }));
    expect(await res.json()).toEqual({ challenge: 'abc' });
    expect(
      (await call(await signed('/slack/events', body, { secret: 'bad', contentType: ct }))).status,
    ).toBe(401);
  });

  it('saves the file and replies in the thread for a shortlisted tender', async () => {
    await env.DB.prepare("UPDATE tenders SET status = 'shortlisted'").run();
    const res = await call(await signed('/slack/events', fileEvent(TS), { contentType: ct }));
    expect(res.status).toBe(200);
    expect(await files()).toEqual([{ file_id: 'F001', tot_ref: 'TOT-1001' }]);
    // (The generic stub has no file info, so the document step then reports an error; ignore that.)
    const acks = () => calls.filter((c) => c.body.text === 'Got it, reading the document...');
    expect(acks()).toHaveLength(1);
    expect(acks()[0]?.body).toMatchObject({ channel: 'C123', thread_ts: TS });
    // Slack retry of the same event: no second reply.
    const before = calls.length;
    await call(await signed('/slack/events', fileEvent(TS), { contentType: ct }));
    expect(calls).toHaveLength(before);
  });

  it('ignores a file uploaded in a thread that is not a tender', async () => {
    await call(await signed('/slack/events', fileEvent('1699999999.999999'), { contentType: ct }));
    expect(await files()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('ignores files in a tender thread that is not shortlisted, top-level files and bot messages', async () => {
    await call(await signed('/slack/events', fileEvent(TS), { contentType: ct })); // status new
    await env.DB.prepare("UPDATE tenders SET status = 'shortlisted'").run();
    await call(await signed('/slack/events', fileEvent(undefined), { contentType: ct }));
    await call(await signed('/slack/events', fileEvent(TS, { bot_id: 'B1' }), { contentType: ct }));
    expect(await files()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
