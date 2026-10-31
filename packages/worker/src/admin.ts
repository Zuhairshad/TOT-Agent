import { verifyBearer } from './auth.js';
import type { Env } from './types.js';

/** Only rows created by scripts/e2e.ts may be deleted through the API. */
export const TEST_REF_PREFIX = 'TEST-';

/**
 * DELETE /admin/tenders/:totRef  (Authorization: Bearer INGEST_SECRET)
 * Exists only so the end-to-end script can clean up after itself. Hard safety rule: refs that do
 * not start with "TEST-" are refused with 403, so real tenders can never be deleted here.
 * Order of checks: auth (401), prefix (403), existence (404), then delete (200).
 */
export async function handleAdminDelete(
  request: Request,
  env: Env,
  rawRef: string,
): Promise<Response> {
  if (!(await verifyBearer(request, env.INGEST_SECRET))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  let totRef: string;
  try {
    totRef = decodeURIComponent(rawRef);
  } catch {
    return Response.json({ error: 'bad_ref' }, { status: 400 });
  }
  if (!totRef.startsWith(TEST_REF_PREFIX)) {
    return Response.json({ error: 'forbidden', message: 'only TEST- refs' }, { status: 403 });
  }
  const row = await env.DB.prepare('SELECT slack_ts FROM tenders WHERE tot_ref = ?')
    .bind(totRef)
    .first<{ slack_ts: string | null }>();
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  // Children first: foreign keys are enforced.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tender_details WHERE tot_ref = ?').bind(totRef),
    env.DB.prepare('DELETE FROM tender_files WHERE tot_ref = ?').bind(totRef),
    env.DB.prepare('DELETE FROM tender_reminders WHERE tot_ref = ?').bind(totRef),
    env.DB.prepare('DELETE FROM tenders WHERE tot_ref = ?').bind(totRef),
  ]);
  // slack_ts lets the caller delete the Slack message even if it could not find it by search.
  return Response.json({ ok: true, deleted: totRef, slack_ts: row.slack_ts });
}
