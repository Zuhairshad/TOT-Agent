import type { ScanReport } from '@tender-monitor/shared';
import { z } from 'zod';
import { postAlert } from '../notify.js';
import type { Env } from '../types.js';
import { loadSearchConfig } from './config.js';
import { fieldErrors, json, normIso, now, parseJson, readJson } from './http.js';
import type { UpsertOutcome } from './records.js';

/** A running scan whose last heartbeat is older than this is a dead lock. */
export const STALE_LOCK_MS = 45 * 60 * 1000;
/**
 * `since` = start time of the last succeeded/partial scan MINUS this overlap. Overlap covers
 * notices published late, listing delays, date-only publish dates (no time of day) and clock/timezone
 * skew; the upsert is idempotent so re-reading a few days costs nothing but requests.
 */
export const SINCE_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;

/** Sources the project ships adapters for, listed even before their first scan. */
export const KNOWN_SOURCES = ['worldbank', 'tendersontime'] as const;

export interface ScanRow {
  id: string;
  source: string;
  status: string;
  access_status: string | null;
  started_at: string;
  finished_at: string | null;
  last_heartbeat_at: string;
  params_json: string;
  keywords_json: string;
  pages_checked: number;
  records_found: number;
  records_new: number;
  records_updated: number;
  documents_fetched: number;
  failures_json: string;
  coverage_limitations_json: string;
  checkpoint_json: string | null;
  triggered_by: string | null;
}

export function scanToJson(r: ScanRow) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    accessStatus: r.access_status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    params: parseJson<Record<string, unknown>>(r.params_json, {}),
    keywordsSearched: parseJson<string[]>(r.keywords_json, []),
    pagesChecked: r.pages_checked,
    recordsFound: r.records_found,
    recordsNew: r.records_new,
    recordsUpdated: r.records_updated,
    documentsFetched: r.documents_fetched,
    failures: parseJson<unknown[]>(r.failures_json, []),
    coverageLimitations: parseJson<string[]>(r.coverage_limitations_json, []),
    checkpoint: parseJson<Record<string, unknown> | null>(r.checkpoint_json, null),
    triggeredBy: r.triggered_by,
  };
}

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SourceNameSchema = z.string().regex(SOURCE_RE, 'lowercase letters, digits, - and _');

const StartBodySchema = z.object({
  source: SourceNameSchema,
  scanId: z.string().min(8).max(100),
  params: z.record(z.string(), z.unknown()).default({}),
  triggeredBy: z.string().max(60).optional(),
});

/** High-water mark minus overlap, or null when the source never completed a scan. */
export async function highWaterSince(env: Env, source: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT started_at FROM scans WHERE source = ? AND status IN ('succeeded', 'partial')
     ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(source)
    .first<{ started_at: string }>();
  if (!row) return null;
  return new Date(Date.parse(row.started_at) - SINCE_OVERLAP_MS).toISOString();
}

/** Marks dead locks failed. Returns the id of a live running scan, if one exists. */
export async function liveRunningScan(env: Env, source: string): Promise<string | null> {
  const cutoff = new Date(now().getTime() - STALE_LOCK_MS).toISOString();
  const stale = await env.DB.prepare(
    "SELECT id, failures_json FROM scans WHERE source = ? AND status = 'running' AND last_heartbeat_at < ?",
  )
    .bind(source, cutoff)
    .all<{ id: string; failures_json: string }>();
  if (stale.results.length) {
    const nowIso = now().toISOString();
    await env.DB.batch(
      stale.results.map((s) =>
        env.DB.prepare(
          "UPDATE scans SET status = 'failed', finished_at = ?, failures_json = ? WHERE id = ? AND status = 'running'",
        ).bind(
          nowIso,
          JSON.stringify([
            ...parseJson<unknown[]>(s.failures_json, []),
            {
              url: null,
              stage: 'other',
              retryable: true,
              error: 'stale lock: no heartbeat for 45 minutes, scan marked failed',
            },
          ]),
          s.id,
        ),
      ),
    );
  }
  const row = await env.DB.prepare("SELECT id FROM scans WHERE source = ? AND status = 'running'")
    .bind(source)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function handleScanStart(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 100_000);
  if (!body.ok) return body.response;
  const parsed = StartBodySchema.safeParse(body.value);
  if (!parsed.success)
    return json({ error: 'invalid_body', fields: fieldErrors(parsed.error) }, 400);
  const { source, scanId, params, triggeredBy } = parsed.data;
  const { config } = await loadSearchConfig(env);

  // Resume: the same scanId always gets the same row back (never a second lock).
  const same = await env.DB.prepare('SELECT * FROM scans WHERE id = ?')
    .bind(scanId)
    .first<ScanRow>();
  if (same) {
    if (same.source !== source) return json({ error: 'scan_id_belongs_to_other_source' }, 409);
    if (same.status === 'running') {
      await env.DB.prepare('UPDATE scans SET last_heartbeat_at = ? WHERE id = ?')
        .bind(now().toISOString(), scanId)
        .run();
    }
    const stored = parseJson<{ since?: string | null }>(same.params_json, {});
    return json({
      scanId,
      resumed: true,
      status: same.status,
      config,
      since: stored.since ?? null,
      checkpoint: parseJson<Record<string, unknown> | null>(same.checkpoint_json, null),
    });
  }

  const running = await liveRunningScan(env, source);
  if (running) return json({ error: 'scan_running', runningScanId: running }, 409);

  const explicit = typeof params.since === 'string' ? normIso(params.since) : null;
  if (typeof params.since === 'string' && !explicit) {
    return json({ error: 'invalid_body', fields: { 'params.since': ['not an ISO date'] } }, 400);
  }
  const since = explicit ?? (await highWaterSince(env, source));
  const nowIso = now().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO scans (id, source, status, started_at, last_heartbeat_at, params_json, triggered_by)
       VALUES (?, ?, 'running', ?, ?, ?, ?)`,
    )
      .bind(
        scanId,
        source,
        nowIso,
        nowIso,
        JSON.stringify({ ...params, since }),
        triggeredBy ?? null,
      )
      .run();
  } catch (err) {
    // The partial unique index lost a race with a concurrent start.
    const other = await env.DB.prepare(
      "SELECT id FROM scans WHERE source = ? AND status = 'running'",
    )
      .bind(source)
      .first<{ id: string }>();
    if (other) return json({ error: 'scan_running', runningScanId: other.id }, 409);
    throw err;
  }
  return json({ scanId, resumed: false, status: 'running', config, since, checkpoint: null });
}

/* ------------------------------------------------------------------ report */

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'blocked']);

/**
 * Makes sure a scans row exists for the report (creating one for runs that skipped /scans/start).
 * Returns a Response to send on error, or the row.
 */
export async function ensureScan(env: Env, report: ScanReport): Promise<ScanRow | Response> {
  const row = await env.DB.prepare('SELECT * FROM scans WHERE id = ?')
    .bind(report.scanId)
    .first<ScanRow>();
  if (row) {
    if (row.source !== report.source) {
      return json({ error: 'scan_id_belongs_to_other_source', scanSource: row.source }, 409);
    }
    return row;
  }
  // Always created as 'running'; applyReport then moves it to the report's status, so a
  // terminal report (e.g. blocked) goes through the same transition (and Slack alert) as usual.
  const nowIso = now().toISOString();
  const insert = () =>
    env.DB.prepare(
      `INSERT INTO scans (id, source, status, started_at, last_heartbeat_at, params_json, triggered_by)
       VALUES (?, ?, 'running', ?, ?, ?, 'ingest')`,
    )
      .bind(
        report.scanId,
        report.source,
        normIso(report.startedAt) ?? nowIso,
        nowIso,
        JSON.stringify(report.params),
      )
      .run();
  try {
    await insert();
  } catch {
    const other = await liveRunningScan(env, report.source); // also clears stale locks
    if (other) return json({ error: 'scan_running', runningScanId: other }, 409);
    await insert();
  }
  return (await env.DB.prepare('SELECT * FROM scans WHERE id = ?')
    .bind(report.scanId)
    .first<ScanRow>())!;
}

/** Applies a progress/final report. new/updated counts come from the Worker, not the client. */
export async function applyReport(
  env: Env,
  ec: Pick<ExecutionContext, 'waitUntil'>,
  row: ScanRow,
  report: ScanReport,
  outcome: UpsertOutcome,
): Promise<ScanRow> {
  const nowIso = now().toISOString();
  const wasRunning = row.status === 'running';
  // Only a running scan can change state; a stale-failed scan keeps its status (records still count).
  const nextStatus: string = wasRunning ? report.status : row.status;
  const terminal = wasRunning && TERMINAL.has(nextStatus);
  await env.DB.prepare(
    `UPDATE scans SET
       status = ?, access_status = ?,
       finished_at = CASE WHEN ? THEN COALESCE(?, ?) ELSE finished_at END,
       last_heartbeat_at = ?,
       keywords_json = ?, failures_json = ?, coverage_limitations_json = ?, checkpoint_json = ?,
       pages_checked = MAX(pages_checked, ?), records_found = MAX(records_found, ?),
       documents_fetched = MAX(documents_fetched, ?),
       records_new = records_new + ?, records_updated = records_updated + ?
     WHERE id = ?`,
  )
    .bind(
      nextStatus,
      report.accessStatus,
      terminal ? 1 : 0,
      normIso(report.finishedAt),
      nowIso,
      nowIso,
      JSON.stringify(report.keywordsSearched),
      JSON.stringify(report.failures),
      JSON.stringify(report.coverageLimitations),
      report.checkpoint ? JSON.stringify(report.checkpoint) : null,
      report.pagesChecked,
      report.recordsFound,
      report.documentsFetched,
      outcome.new,
      outcome.updated,
      row.id,
    )
    .run();

  if (nextStatus === 'blocked' && row.status !== 'blocked') {
    // Best-effort, after the response; postAlert never throws.
    if (env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) {
      const why = report.failures[0]?.error ?? report.accessStatus;
      ec.waitUntil(
        postAlert(
          env,
          `Scan BLOCKED (${report.source}, access: ${report.accessStatus}): ${why}. ` +
            'Check the site; no bypass is attempted.',
        ),
      );
    }
  }
  return (await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(row.id).first<ScanRow>())!;
}

/* ------------------------------------------------------------------ reads */

export async function sourceStatuses(env: Env) {
  const latestPer = (where: string) =>
    env.DB.prepare(
      `SELECT * FROM scans WHERE id IN (
         SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
                         FROM scans ${where}) WHERE rn = 1)`,
    );
  const [latest, success, failed, counts] = await env.DB.batch([
    latestPer(''),
    latestPer("WHERE status IN ('succeeded', 'partial')"),
    latestPer("WHERE status IN ('failed', 'blocked') OR failures_json != '[]'"),
    env.DB.prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source'),
  ]);
  const bySource = (res: D1Result | undefined) =>
    new Map(((res?.results ?? []) as unknown as ScanRow[]).map((r) => [r.source, r]));
  const L = bySource(latest);
  const S = bySource(success);
  const F = bySource(failed);
  const C = new Map(
    ((counts?.results ?? []) as unknown as Array<{ source: string; n: number }>).map((r) => [
      r.source,
      r.n,
    ]),
  );
  const names = [...new Set([...KNOWN_SOURCES, ...L.keys(), ...C.keys()])].sort();
  return names.map((source) => {
    const last = L.get(source);
    const fail = F.get(source);
    const failures = fail ? parseJson<Array<{ error?: string }>>(fail.failures_json, []) : [];
    return {
      source,
      recordCount: C.get(source) ?? 0,
      running: last?.status === 'running',
      lastScan: last ? scanToJson(last) : null,
      lastSuccessfulScan: S.has(source) ? scanToJson(S.get(source)!) : null,
      accessStatus: last?.access_status ?? null,
      lastFailure: fail
        ? {
            scanId: fail.id,
            at: fail.finished_at ?? fail.last_heartbeat_at,
            status: fail.status,
            accessStatus: fail.access_status,
            message: failures[0]?.error ?? null,
          }
        : null,
    };
  });
}

export async function handleListScans(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
  const [rows, sources] = await Promise.all([
    env.DB.prepare('SELECT * FROM scans ORDER BY started_at DESC LIMIT ?')
      .bind(limit)
      .all<ScanRow>(),
    sourceStatuses(env),
  ]);
  return json({ scans: rows.results.map(scanToJson), sources });
}

export async function handleGetScan(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first<ScanRow>();
  return row ? json({ scan: scanToJson(row) }) : json({ error: 'not_found' }, 404);
}

export async function handleListSources(env: Env): Promise<Response> {
  return json({ sources: await sourceStatuses(env) });
}
