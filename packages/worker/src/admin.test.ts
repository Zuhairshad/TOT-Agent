import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { call, clearTenders, insertTender } from '../test/helpers.js';

afterEach(clearTenders);

const del = (ref: string, secret: string | null = env.INGEST_SECRET) =>
  call(
    new Request(`https://w.test/admin/tenders/${encodeURIComponent(ref)}`, {
      method: 'DELETE',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    }),
  );
const count = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM tenders').first<{ n: number }>())!.n;

describe('DELETE /admin/tenders/:totRef', () => {
  it('401 without or with a wrong secret, and deletes nothing', async () => {
    await insertTender({ totRef: 'TEST-1' });
    expect((await del('TEST-1', null)).status).toBe(401);
    expect((await del('TEST-1', 'wrong')).status).toBe(401);
    expect(await count()).toBe(1);
  });

  it('403 for any ref that does not start with TEST-, and the row survives', async () => {
    await insertTender({ totRef: 'TOT-1001' });
    await insertTender({ totRef: 'test-lower' });
    await insertTender({ totRef: 'XTEST-1' });
    expect((await del('TOT-1001')).status).toBe(403);
    expect((await del('test-lower')).status).toBe(403);
    expect((await del('XTEST-1')).status).toBe(403);
    expect(await count()).toBe(3);
  });

  it('checks auth before the prefix (an unauthenticated caller learns nothing)', async () => {
    expect((await del('TOT-1001', 'wrong')).status).toBe(401);
  });

  it('404 for an unknown TEST- ref', async () => {
    expect((await del('TEST-nope')).status).toBe(404);
  });

  it('deletes the row and its children, and returns slack_ts', async () => {
    await insertTender({ totRef: 'TEST-1', slackTs: '1700000000.000777' });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO tender_files (file_id, tot_ref, uploaded_at) VALUES ('F1', 'TEST-1', 'x')",
      ),
      env.DB.prepare(
        "INSERT INTO tender_details (file_id, tot_ref, details_json, created_at) VALUES ('F1', 'TEST-1', '{}', 'x')",
      ),
      env.DB.prepare(
        "INSERT INTO tender_reminders (tot_ref, kind, sent_at) VALUES ('TEST-1', '7d', 'x')",
      ),
    ]);
    const res = await del('TEST-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 'TEST-1', slack_ts: '1700000000.000777' });
    expect(await count()).toBe(0);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM tender_reminders').first<{ n: number }>())!
        .n,
    ).toBe(0);
  });

  it('only DELETE is routed', async () => {
    await insertTender({ totRef: 'TEST-1' });
    const res = await call(
      new Request('https://w.test/admin/tenders/TEST-1', {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.INGEST_SECRET}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(await count()).toBe(1);
  });
});
