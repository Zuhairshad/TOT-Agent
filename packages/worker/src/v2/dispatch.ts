import type { Env } from '../types.js';
import { json, normIso, now, parseJson, readJson, fieldErrors } from './http.js';
import { SourceNameSchema, highWaterSince, liveRunningScan } from './scans.js';
import { z } from 'zod';

/** A second dispatch for the same source within this window is refused (double-click guard). */
export const DISPATCH_COOLDOWN_MS = 3 * 60 * 1000;

const BodySchema = z.object({
  source: SourceNameSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});

/** Exact list of what is missing, or [] when dispatch is fully configured. */
export function missingDispatchConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GITHUB_DISPATCH_TOKEN) {
    missing.push(
      'secret GITHUB_DISPATCH_TOKEN (fine-grained token, repository permission "Actions: Read and write"): wrangler secret put GITHUB_DISPATCH_TOKEN',
    );
  }
  if (!env.GITHUB_REPOSITORY || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) {
    missing.push('var GITHUB_REPOSITORY = "owner/repo" in wrangler.toml [vars]');
  }
  return missing;
}

/**
 * POST /api/scans: asks GitHub Actions to start the scan workflow. Scraping never runs inside
 * this request; the workflow later calls POST /scans/start itself (and gets the lock there).
 */
export async function handleTriggerScan(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 100_000);
  if (!body.ok) return body.response;
  const parsed = BodySchema.safeParse(body.value);
  if (!parsed.success)
    return json({ error: 'invalid_body', fields: fieldErrors(parsed.error) }, 400);
  const { source, params } = parsed.data;

  const missing = missingDispatchConfig(env);
  if (missing.length) {
    return json(
      {
        error: 'not_configured',
        message:
          'Triggering scans from the UI is not configured. Set: ' +
          missing.join('; ') +
          `. Optional vars: SCAN_WORKFLOW (default "scan.yml"), GITHUB_REF (default "main").`,
        missing,
      },
      501,
    );
  }

  const running = await liveRunningScan(env, source);
  if (running) return json({ error: 'scan_running', runningScanId: running }, 409);

  const key = `last_dispatch:${source}`;
  const last = await env.DB.prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value_json: string }>();
  const lastAt = parseJson<{ at?: string }>(last?.value_json, {}).at;
  if (lastAt && now().getTime() - Date.parse(lastAt) < DISPATCH_COOLDOWN_MS) {
    return json({ error: 'recently_dispatched', since: lastAt }, 409);
  }

  const explicit = typeof params.since === 'string' ? normIso(params.since) : null;
  const since = explicit ?? (await highWaterSince(env, source));
  const workflow = env.SCAN_WORKFLOW || 'scan.yml';
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tender-monitor-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF || 'main',
        inputs: { source, since: since ?? '', triggered_by: 'ui' },
      }),
    },
  );
  if (res.status !== 204) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`github dispatch failed: ${res.status} ${detail}`);
    return json({ error: 'dispatch_failed', githubStatus: res.status, detail }, 502);
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(key, JSON.stringify({ at: now().toISOString() }))
    .run();
  return json({ ok: true, dispatched: true, source, since, workflow }, 202);
}
