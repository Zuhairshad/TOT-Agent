import { describe, expect, it } from 'vitest';
import { constantTimeEqual, signSlackBody, verifyBearer, verifySlackSignature } from './auth.js';

const SECRET = 'shh';
const now = 1_700_000_000;
const slackReq = (headers: Record<string, string>) =>
  new Request('https://x.test/', { method: 'POST', headers });

describe('constantTimeEqual / verifyBearer', () => {
  it('compares strings', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
  });
  it('requires a matching Bearer token and a configured secret', async () => {
    const req = (h?: string) =>
      new Request('https://x.test/', { headers: h ? { Authorization: h } : {} });
    expect(await verifyBearer(req('Bearer s3'), 's3')).toBe(true);
    expect(await verifyBearer(req('Bearer nope'), 's3')).toBe(false);
    expect(await verifyBearer(req('s3'), 's3')).toBe(false);
    expect(await verifyBearer(req(), 's3')).toBe(false);
    expect(await verifyBearer(req('Bearer '), '')).toBe(false);
  });
});

describe('verifySlackSignature', () => {
  it('accepts a valid signature', async () => {
    const sig = await signSlackBody(SECRET, now, 'body');
    const req = slackReq({ 'X-Slack-Signature': sig, 'X-Slack-Request-Timestamp': String(now) });
    expect(await verifySlackSignature(req, 'body', SECRET, now)).toBe(true);
  });
  it('rejects a wrong signature, a tampered body and malformed headers', async () => {
    const sig = await signSlackBody(SECRET, now, 'body');
    const good = { 'X-Slack-Signature': sig, 'X-Slack-Request-Timestamp': String(now) };
    expect(await verifySlackSignature(slackReq(good), 'other', SECRET, now)).toBe(false);
    expect(
      await verifySlackSignature(
        slackReq({ ...good, 'X-Slack-Signature': 'v0=' + '0'.repeat(64) }),
        'body',
        SECRET,
        now,
      ),
    ).toBe(false);
    expect(
      await verifySlackSignature(
        slackReq({ ...good, 'X-Slack-Signature': 'v0=zz' }),
        'body',
        SECRET,
        now,
      ),
    ).toBe(false);
    expect(await verifySlackSignature(slackReq({}), 'body', SECRET, now)).toBe(false);
  });
  it('rejects timestamps older than 5 minutes (and far-future ones)', async () => {
    const old = now - 301;
    const sig = await signSlackBody(SECRET, old, 'body');
    const req = slackReq({ 'X-Slack-Signature': sig, 'X-Slack-Request-Timestamp': String(old) });
    expect(await verifySlackSignature(req, 'body', SECRET, now)).toBe(false);
    const fresh = now - 299;
    const sig2 = await signSlackBody(SECRET, fresh, 'body');
    const req2 = slackReq({
      'X-Slack-Signature': sig2,
      'X-Slack-Request-Timestamp': String(fresh),
    });
    expect(await verifySlackSignature(req2, 'body', SECRET, now)).toBe(true);
  });
});
