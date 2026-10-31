import type { Env } from './types.js';

export async function handleHealth(env: Env): Promise<Response> {
  const [lastRun, counts, lastScan, recordCount] = await env.DB.batch([
    env.DB.prepare(
      'SELECT started_at, source, status, found, new_count, note FROM runs ORDER BY id DESC LIMIT 1',
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'new'), 0) AS new,
              COALESCE(SUM(status = 'shortlisted'), 0) AS shortlisted,
              COALESCE(SUM(status = 'ignored'), 0) AS ignored
       FROM tenders`,
    ),
    // v2 pipeline: newest scan of any source + how many normalised records are stored.
    env.DB.prepare(
      `SELECT id, source, status, access_status, started_at, finished_at, last_heartbeat_at,
              records_found, records_new, records_updated FROM scans ORDER BY started_at DESC LIMIT 1`,
    ),
    env.DB.prepare('SELECT COUNT(*) AS n FROM records'),
  ]);
  const scan = lastScan?.results[0] as
    | {
        id: string;
        source: string;
        status: string;
        access_status: string | null;
        started_at: string;
        finished_at: string | null;
        last_heartbeat_at: string;
        records_found: number;
        records_new: number;
        records_updated: number;
      }
    | undefined;
  const last = lastRun?.results[0] as
    | {
        started_at: string;
        source: string;
        status: string;
        found: number;
        new_count: number;
        note: string | null;
      }
    | undefined;
  return Response.json({
    ok: true,
    lastRun: last
      ? {
          at: last.started_at,
          source: last.source,
          status: last.status,
          found: last.found,
          new: last.new_count,
        }
      : null,
    tenders: counts?.results[0] ?? { total: 0, new: 0, shortlisted: 0, ignored: 0 },
    v2: {
      records: (recordCount?.results[0] as { n: number } | undefined)?.n ?? 0,
      lastScan: scan
        ? {
            id: scan.id,
            source: scan.source,
            status: scan.status,
            accessStatus: scan.access_status,
            startedAt: scan.started_at,
            finishedAt: scan.finished_at,
            lastHeartbeatAt: scan.last_heartbeat_at,
            found: scan.records_found,
            new: scan.records_new,
            updated: scan.records_updated,
          }
        : null,
    },
  });
}
