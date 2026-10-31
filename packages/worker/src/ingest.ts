import { IngestBodySchema, type Tender } from '@tender-monitor/shared';
import { verifyBearer } from './auth.js';
import { parseKeywords } from './blocks.js';
import { postAlert, postNewTenders } from './notify.js';
import { timed } from './timing.js';
import type { Env, TenderRow } from './types.js';

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function logRun(
  env: Env,
  run: { source: string; found: number; newCount: number; status: string; note?: string | null },
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO runs (started_at, source, found, new_count, status, note) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      new Date().toISOString(),
      run.source,
      run.found,
      run.newCount,
      run.status,
      run.note ?? null,
    )
    .run();
}

/** Collapse repeated tot_refs inside one request, merging their keywords. */
function dedupe(tenders: Tender[]): Array<{ tender: Tender; keywords: string[] }> {
  const map = new Map<string, { tender: Tender; keywords: string[] }>();
  for (const t of tenders) {
    const hit = map.get(t.totRef);
    if (!hit) map.set(t.totRef, { tender: t, keywords: [t.matchedKeyword] });
    else if (!hit.keywords.includes(t.matchedKeyword)) hit.keywords.push(t.matchedKeyword);
  }
  return [...map.values()];
}

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!(await verifyBearer(request, env.INGEST_SECRET))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    await logRun(env, {
      source: 'unknown',
      found: 0,
      newCount: 0,
      status: 'invalid_body',
      note: 'invalid JSON',
    });
    return json({ error: 'invalid_json' }, 400);
  }

  const parsed = IngestBodySchema.safeParse(raw);
  if (!parsed.success) {
    await logRun(env, {
      source: 'unknown',
      found: 0,
      newCount: 0,
      status: 'invalid_body',
      note: 'schema validation failed',
    });
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (fields[issue.path.join('.') || '_'] ??= []).push(issue.message);
    }
    return json({ error: 'invalid_body', fields }, 400);
  }
  const body = parsed.data;
  const items = dedupe(body.tenders);
  const now = new Date().toISOString();

  // 1. Insert everything; ON CONFLICT DO NOTHING tells us (meta.changes) which rows are new.
  const insertSql = `INSERT INTO tenders (tot_ref, title, country, purchaser, posted_at, deadline,
      value_text, value_amount, currency, url, matched_keywords, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tot_ref) DO NOTHING`;
  const results = items.length
    ? await timed('d1.insert', () =>
        env.DB.batch(
          items.map(({ tender: t, keywords }) =>
            env.DB.prepare(insertSql).bind(
              t.totRef,
              t.title,
              t.country,
              t.purchaser ?? null,
              t.postedAt,
              t.deadline,
              t.valueText ?? null,
              t.valueAmount ?? null,
              t.currency ?? null,
              t.url,
              JSON.stringify(keywords),
              now,
            ),
          ),
        ),
      )
    : [];
  const isNew = items.map((_, i) => (results[i]?.meta.changes ?? 0) > 0);
  const known = items.filter((_, i) => !isNew[i]);

  // 2. Known tenders: merge in any keyword we have not stored yet.
  if (known.length) {
    await timed('d1.merge-keywords', async () => {
      const existing = await env.DB.batch<Pick<TenderRow, 'tot_ref' | 'matched_keywords'>>(
        known.map(({ tender }) =>
          env.DB.prepare('SELECT tot_ref, matched_keywords FROM tenders WHERE tot_ref = ?').bind(
            tender.totRef,
          ),
        ),
      );
      const updates: D1PreparedStatement[] = [];
      known.forEach(({ tender, keywords }, i) => {
        const stored = parseKeywords(existing[i]?.results[0]?.matched_keywords ?? '[]');
        const merged = [...stored, ...keywords.filter((k) => !stored.includes(k))];
        if (merged.length !== stored.length) {
          updates.push(
            env.DB.prepare('UPDATE tenders SET matched_keywords = ? WHERE tot_ref = ?').bind(
              JSON.stringify(merged),
              tender.totRef,
            ),
          );
        }
      });
      if (updates.length) await env.DB.batch(updates);
    });
  }

  // 3. Log the run (also for blocked runs).
  const newItems = items.filter((_, i) => isNew[i]);
  await logRun(env, {
    source: body.source,
    found: body.tenders.length,
    newCount: newItems.length,
    status: body.status,
    note: body.note,
  });

  // 4. Slack work happens after the response so /ingest stays fast.
  const newRows: TenderRow[] = newItems.map(({ tender: t, keywords }) => ({
    tot_ref: t.totRef,
    title: t.title,
    country: t.country,
    purchaser: t.purchaser ?? null,
    posted_at: t.postedAt,
    deadline: t.deadline,
    value_text: t.valueText ?? null,
    value_amount: t.valueAmount ?? null,
    currency: t.currency ?? null,
    url: t.url,
    matched_keywords: JSON.stringify(keywords),
    first_seen_at: now,
    slack_ts: null,
    status: 'new',
    shortlisted_at: null,
  }));
  ctx.waitUntil(
    (async () => {
      if (body.status === 'blocked') {
        await postAlert(
          env,
          `Scraper run BLOCKED (${body.source})${body.note ? `: ${body.note}` : ''}. Check the site and the run screenshot.`,
        );
      }
      if (newRows.length) await postNewTenders(env, newRows);
    })(),
  );

  return json({ ok: true, received: body.tenders.length, new: newRows.length });
}
