import { IngestV2BodySchema } from '@tender-monitor/shared';
import { timed } from '../timing.js';
import type { Env } from '../types.js';
import { fieldErrors, json, now, readJson } from './http.js';
import { upsertRecords } from './records.js';
import { applyReport, ensureScan, scanToJson } from './scans.js';

/**
 * POST /ingest/v2. Order matters: (1) validate, (2) make sure the scan row exists / belongs to
 * this source, (3) upsert records, (4) fold the report + server-computed counts into the scan.
 * A crash between 3 and 4 only loses counters; re-posting the same batch is a safe no-op.
 */
export async function handleIngestV2(
  request: Request,
  env: Env,
  ec: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = await timed('ingest2.validate', () => IngestV2BodySchema.safeParse(body.value));
  if (!parsed.success)
    return json({ error: 'invalid_body', fields: fieldErrors(parsed.error) }, 400);
  const { report, records } = parsed.data;

  const mismatch = records.find((r) => r.source !== report.source);
  if (mismatch) {
    return json(
      {
        error: 'invalid_body',
        fields: { records: [`record ${mismatch.sourceRecordId} has source "${mismatch.source}"`] },
      },
      400,
    );
  }

  const scan = await ensureScan(env, report);
  if (scan instanceof Response) return scan;

  const outcome = await upsertRecords(env, records, now().toISOString());
  const updated = await applyReport(env, ec, scan, report, outcome);

  return json({
    ok: true,
    received: outcome.received,
    new: outcome.new,
    updated: outcome.updated,
    unchanged: outcome.unchanged,
    olderNotice: outcome.olderNotice,
    conflicts: outcome.conflicts,
    results: outcome.results,
    scan: scanToJson(updated),
  });
}
